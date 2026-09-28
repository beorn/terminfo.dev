/**
 * Mux probe mechanism — test feature pass-through of terminal multiplexers.
 *
 * Launches tmux/screen in detached mode with a serve daemon inside,
 * probes via HTTP, saves results to content/probes-mux/, then kills the session.
 *
 * This reveals how features degrade through an intermediary — the same probes
 * that run directly on a terminal now run through the multiplexer's PTY layer.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { execSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  createProbeRun,
  findOwnedDaemon,
  readDaemonProbeResponse,
  removeProbeRun,
  requestDaemonProbe,
  shellQuote,
  stopOwnedDaemon,
  type DaemonRegistration,
  type OwnedDaemon,
  type ProbeRun,
} from "terminfo.dev/src/daemon-client.ts"
import { homedir } from "node:os"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..", "..", "..")
const RESULTS_DIR = join(ROOT, "content", "probes-mux")
const DAEMON_DIR = join(homedir(), ".terminfo-dev", "daemons")
const CLI_ENTRY = join(ROOT, "packages", "admin", "src", "index.ts")

// ── Multiplexer definitions ──

interface MuxDef {
  name: string
  id: string
  binary: string
  version: () => string
  start: (sessionName: string, scriptPath: string) => void
  kill: (sessionName: string) => void
}

const BUN = process.execPath

const MUXES: MuxDef[] = [
  {
    name: "tmux",
    id: "tmux",
    binary: "tmux",
    version: () => {
      try {
        // "tmux 3.6a" → "3.6a"
        return execSync("tmux -V", { encoding: "utf-8", timeout: 3000 })
          .trim()
          .replace(/^tmux\s+/, "")
      } catch {
        return "unknown"
      }
    },
    start: (session, scriptPath) => {
      execSync(`tmux new-session -d -s ${session} -x 120 -y 40 "${scriptPath}"`, { timeout: 10_000 })
    },
    kill: (session) => {
      execSync(`tmux kill-session -t ${session}`, { timeout: 5000, stdio: "ignore" })
    },
  },
  {
    name: "GNU Screen",
    id: "screen",
    binary: "screen",
    version: () => {
      try {
        // screen -v exits with code 1 but still prints version
        const out = execSync("screen -v 2>&1 || true", { encoding: "utf-8", timeout: 3000 }).trim()
        return out.match(/version\s+([\d.]+)/)?.[1] ?? "unknown"
      } catch {
        return "unknown"
      }
    },
    start: (session, scriptPath) => {
      execSync(`screen -dmS ${session} ${scriptPath}`, { timeout: 10_000 })
    },
    kill: (session) => {
      execSync(`screen -S ${session} -X quit`, { timeout: 5000, stdio: "ignore" })
    },
  },
]

// ── Helpers ──

function whichBinary(name: string): string | null {
  try {
    return execSync(`which ${name}`, { encoding: "utf-8", timeout: 3000 }).trim() || null
  } catch {
    return null
  }
}

/**
 * Write a wrapper script that clears outer terminal identity env vars
 * so the daemon inside the mux detects the mux as the terminal.
 */
function writeServeScript(run: ProbeRun): void {
  const serveCmd = `TERMINFO_RUN_ID=${run.id} exec ${shellQuote(BUN)} ${shellQuote(CLI_ENTRY)} probe server --start`
  writeFileSync(
    run.scriptPath,
    [
      "#!/bin/bash",
      "unset __CFBundleIdentifier TERM_PROGRAM TERM_PROGRAM_VERSION",
      "unset GHOSTTY_RESOURCES_DIR KITTY_WINDOW_ID WEZTERM_EXECUTABLE ALACRITTY_WINDOW_ID TERMINAL_EMULATOR",
      serveCmd,
    ].join("\n") + "\n",
    { flag: "wx", mode: 0o700 },
  )
}

/** Probe a daemon and save results to probes-mux/ */
async function probeDaemon(
  daemon: DaemonRegistration,
  muxId: string,
  version: string,
): Promise<{ total: number; passed: number } | null> {
  try {
    const res = await requestDaemonProbe(daemon)

    const data = await readDaemonProbeResponse(res)
    const results = data.results
    const total = Object.keys(results).length
    const passed = Object.values(results).filter(Boolean).length

    const result = {
      terminal: muxId,
      terminalVersion: version,
      os: data.os ?? detectOS(),
      osVersion: data.osVersion ?? "",
      source: "mux",
      generated: new Date().toISOString(),
      results,
      ...(data.notes ? { notes: data.notes } : {}),
      ...(data.responses ? { responses: data.responses } : {}),
    }

    mkdirSync(RESULTS_DIR, { recursive: true })
    const filename = `${muxId}-${version}-${result.os}.json`
    writeFileSync(join(RESULTS_DIR, filename), JSON.stringify(result, null, 2))

    return { total, passed }
  } catch (err) {
    console.log(`  Probe failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

function detectOS(): string {
  switch (process.platform) {
    case "darwin":
      return "macos"
    case "linux":
      return "linux"
    case "win32":
      return "windows"
    default:
      return process.platform
  }
}

// ── Run one multiplexer ──

async function runMux(
  mux: MuxDef,
  opts: { force?: boolean },
): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  if (!whichBinary(mux.binary)) return { success: false, error: "not installed" }
  const version = mux.version()
  if (!opts.force) {
    const resultPath = join(RESULTS_DIR, `${mux.id}-${version}-${detectOS()}.json`)
    if (existsSync(resultPath)) {
      const existing = JSON.parse(readFileSync(resultPath, "utf8")) as { results?: Record<string, unknown> }
      if (Object.keys(existing.results ?? {}).length >= 120) return { success: true, skipped: true }
    }
  }

  const run = createProbeRun()
  const sessionName = `terminfo-${run.id.slice(0, 16)}`
  let sessionStarted = false
  let daemon: OwnedDaemon | null = null
  let outcome: { success: boolean; error?: string } = { success: false, error: "probe did not complete" }
  try {
    writeServeScript(run)
    console.log(`  Launching ${mux.name} v${version}...`)
    mux.start(sessionName, run.scriptPath)
    sessionStarted = true
    console.log(`  Waiting for owned daemon inside ${mux.name}...`)
    daemon = await findOwnedDaemon(run.id, DAEMON_DIR)
    if (!daemon) throw new Error("Owned daemon did not register within 30s")
    console.log(`  Probing on port ${daemon.registration.port}...`)
    const result = await probeDaemon(daemon.registration, mux.id, version)
    if (!result) throw new Error("Probe failed")
    console.log(`  ${result.passed}/${result.total} probes passed`)
    outcome = { success: true }
  } catch (err) {
    outcome = { success: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    const cleanupErrors: string[] = []
    if (daemon) {
      try {
        await stopOwnedDaemon(daemon)
      } catch (err) {
        cleanupErrors.push(`daemon: ${String(err)}`)
      }
    }
    if (sessionStarted) {
      try {
        mux.kill(sessionName)
      } catch (err) {
        cleanupErrors.push(`session: ${String(err)}`)
      }
    }
    try {
      removeProbeRun(run)
    } catch (err) {
      cleanupErrors.push(`script: ${String(err)}`)
    }
    if (cleanupErrors.length > 0) {
      outcome = {
        success: false,
        error: [outcome.success ? undefined : outcome.error, ...cleanupErrors].filter(Boolean).join("; "),
      }
    }
  }
  return outcome
}

// ── Main handler ──

export async function handleMux(muxName: string | undefined, opts: { all?: boolean; force?: boolean }): Promise<void> {
  if (!muxName && !opts.all) {
    console.log("\nAvailable multiplexers:\n")
    for (const mux of MUXES) {
      const installed = !!whichBinary(mux.binary)
      const version = installed ? mux.version() : ""
      console.log(`  ${installed ? "+" : "-"} ${mux.name.padEnd(16)} ${version}`)
    }
    console.log("\nProbe all:  terminfo probe mux --all")
    console.log("Probe one:  terminfo probe mux tmux")
    console.log(`\nApproach: launches mux → starts serve daemon inside → probes via HTTP → kills session`)
    return
  }

  let muxesToRun = MUXES
  if (muxName) {
    const name = muxName.toLowerCase()
    muxesToRun = MUXES.filter((m) => m.id === name || m.name.toLowerCase() === name)
    if (muxesToRun.length === 0) {
      throw new Error(`Unknown multiplexer. Available: ${MUXES.map((m) => m.id).join(", ")}`)
    }
  }

  muxesToRun = muxesToRun.filter((m) => !!whichBinary(m.binary))
  if (muxesToRun.length === 0) {
    throw new Error("No multiplexers available to test.")
  }

  console.log(`\nProbing through ${muxesToRun.length} multiplexer(s)\n`)

  const outcomes: Array<{ mux: MuxDef; result: Awaited<ReturnType<typeof runMux>> }> = []

  for (const mux of muxesToRun) {
    console.log(`--- ${mux.name} ---`)
    const result = await runMux(mux, { force: opts.force })
    outcomes.push({ mux, result })

    if (result.skipped) {
      console.log(`  Cached (120+ probes). Use --force to re-run.`)
    } else if (!result.success) {
      console.log(`  FAILED: ${result.error}`)
    }

    // Pause between launches
    if (muxesToRun.indexOf(mux) < muxesToRun.length - 1) {
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 2000)
      })
    }
  }

  console.log("\n=== Summary ===\n")
  for (const { mux, result } of outcomes) {
    const status = result.skipped ? "cached" : result.success ? "OK" : `FAIL: ${result.error}`
    console.log(`  ${mux.name.padEnd(16)} ${status}`)
  }

  const failures = outcomes.filter(({ result }) => !result.success)
  if (failures.length > 0) {
    throw new Error(
      `Mux collection failed: ${failures.map(({ mux, result }) => `${mux.id}: ${result.error}`).join("; ")}`,
    )
  }
  console.log(`\nResults saved to content/probes-mux/`)
}
