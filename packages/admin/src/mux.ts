/**
 * Mux probe mechanism — test feature pass-through of terminal multiplexers.
 *
 * Launches tmux/screen in detached mode with a serve daemon inside,
 * probes via HTTP, saves results to content/probes-mux/, then kills the session.
 *
 * This reveals how features degrade through an intermediary — the same probes
 * that run directly on a terminal now run through the multiplexer's PTY layer.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs"
import { execSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
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

const SESSION_NAME = "terminfo-probe"
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
      try {
        execSync(`tmux kill-session -t ${session}`, { timeout: 5000, stdio: "ignore" })
      } catch {}
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
      try {
        execSync(`screen -S ${session} -X quit`, { timeout: 5000, stdio: "ignore" })
      } catch {}
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
function writeServeScript(): string {
  const scriptPath = "/tmp/terminfo-mux-serve.sh"
  const serveCmd = `${BUN} "${CLI_ENTRY}" probe server --start`
  writeFileSync(
    scriptPath,
    [
      "#!/bin/bash",
      "# Clear outer terminal identity so daemon detects the mux",
      "unset __CFBundleIdentifier",
      "unset TERM_PROGRAM",
      "unset TERM_PROGRAM_VERSION",
      "unset GHOSTTY_RESOURCES_DIR",
      "unset KITTY_WINDOW_ID",
      "unset WEZTERM_EXECUTABLE",
      "unset ALACRITTY_WINDOW_ID",
      "unset TERMINAL_EMULATOR",
      serveCmd,
      "sleep 999999", // Keep session alive after daemon starts
    ].join("\n") + "\n",
  )
  execSync(`chmod +x ${scriptPath}`)
  return scriptPath
}

/** Wait for a daemon that started within the last 60s */
async function waitForDaemon(timeoutMs: number = 30_000): Promise<{ port: number; terminal: string } | null> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      mkdirSync(DAEMON_DIR, { recursive: true })
      const files = readdirSync(DAEMON_DIR).filter((f) => f.endsWith(".json"))
      for (const file of files) {
        try {
          const data = JSON.parse(readFileSync(join(DAEMON_DIR, file), "utf-8")) as any
          const started = new Date(data.started).getTime()
          if (Date.now() - started < 60_000) {
            // Verify daemon is alive via /info
            try {
              const res = await fetch(`http://127.0.0.1:${data.port}/info`, { signal: AbortSignal.timeout(2000) })
              if (res.ok) return { port: data.port, terminal: data.terminal }
            } catch {}
          }
        } catch {}
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }

  return null
}

/** Kill daemon processes registered in ~/.terminfo-dev/daemons/ */
async function killDaemonProcesses(): Promise<void> {
  try {
    mkdirSync(DAEMON_DIR, { recursive: true })
    const files = readdirSync(DAEMON_DIR).filter((f) => f.endsWith(".json"))
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(DAEMON_DIR, file), "utf-8")) as any
        if (data.pid) {
          try {
            process.kill(data.pid, "SIGTERM")
          } catch {}
        }
        // Also kill the serve script wrapper if it's still running
        try {
          execSync(`pkill -f "terminfo-mux-serve.sh" 2>/dev/null || true`, { timeout: 3000 })
        } catch {}
        unlinkSync(join(DAEMON_DIR, file))
      } catch {}
    }
  } catch {}
}

/** Remove stale daemon files (daemons that are no longer running) */
async function cleanStaleDaemons(): Promise<void> {
  try {
    mkdirSync(DAEMON_DIR, { recursive: true })
    const files = readdirSync(DAEMON_DIR).filter((f) => f.endsWith(".json"))
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(DAEMON_DIR, file), "utf-8")) as any
        const res = await fetch(`http://127.0.0.1:${data.port}/info`, { signal: AbortSignal.timeout(1000) })
        if (!res.ok) throw new Error("not ok")
      } catch {
        try {
          unlinkSync(join(DAEMON_DIR, file))
        } catch {}
      }
    }
  } catch {}
}

/** Probe a daemon and save results to probes-mux/ */
async function probeDaemon(
  port: number,
  muxId: string,
  version: string,
): Promise<{ total: number; passed: number } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/probe`, { signal: AbortSignal.timeout(120_000) })
    if (!res.ok) return null

    const data = (await res.json()) as any
    const results = data.results ?? {}
    const total = Object.keys(results).length
    const passed = Object.values(results).filter(Boolean).length

    const result: Record<string, any> = {
      terminal: muxId,
      terminalVersion: version,
      os: data.os ?? detectOS(),
      osVersion: data.osVersion ?? "",
      source: "mux",
      generated: new Date().toISOString(),
      results,
    }
    if (data.notes && Object.keys(data.notes).length > 0) result.notes = data.notes
    if (data.responses && Object.keys(data.responses).length > 0) result.responses = data.responses

    mkdirSync(RESULTS_DIR, { recursive: true })
    const filename = `${muxId}-${version}-${result.os}.json`
    writeFileSync(join(RESULTS_DIR, filename), JSON.stringify(result, null, 2))

    return { total, passed }
  } catch (e: any) {
    console.log(`  Probe failed: ${e.message}`)
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
  if (!whichBinary(mux.binary)) {
    return { success: false, error: "not installed" }
  }

  const version = mux.version()

  // Cache check
  if (!opts.force) {
    const resultPath = join(RESULTS_DIR, `${mux.id}-${version}-${detectOS()}.json`)
    if (existsSync(resultPath)) {
      try {
        const existing = JSON.parse(readFileSync(resultPath, "utf-8")) as any
        if (Object.keys(existing.results ?? {}).length >= 120) {
          return { success: true, skipped: true }
        }
      } catch {}
    }
  }

  // Kill leftover session from a previous run
  mux.kill(SESSION_NAME)
  await new Promise((r) => setTimeout(r, 500))

  // Clean stale daemon registrations so we detect the new one
  await cleanStaleDaemons()

  const scriptPath = writeServeScript()

  console.log(`  Launching ${mux.name} v${version}...`)
  try {
    mux.start(SESSION_NAME, scriptPath)
  } catch (e: any) {
    return { success: false, error: `Failed to start ${mux.name}: ${e.message}` }
  }

  console.log(`  Waiting for daemon inside ${mux.name}...`)
  const daemon = await waitForDaemon()

  if (!daemon) {
    mux.kill(SESSION_NAME)
    return { success: false, error: "Daemon didn't register within 30s" }
  }

  console.log(`  Probing on port ${daemon.port}...`)
  const result = await probeDaemon(daemon.port, mux.id, version)

  // Thorough cleanup: kill session, daemon processes, and stale registrations
  mux.kill(SESSION_NAME)
  await killDaemonProcesses()
  await cleanStaleDaemons()

  if (!result) {
    return { success: false, error: "Probe failed" }
  }

  console.log(`  ${result.passed}/${result.total} probes passed`)
  return { success: true }
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
      await new Promise((r) => setTimeout(r, 2000))
    }
  }

  console.log("\n=== Summary ===\n")
  for (const { mux, result } of outcomes) {
    const status = result.skipped ? "cached" : result.success ? "OK" : `FAIL: ${result.error}`
    console.log(`  ${mux.name.padEnd(16)} ${status}`)
  }

  // Final cleanup — ensure no orphaned processes or sessions
  for (const mux of MUXES) {
    mux.kill(SESSION_NAME)
  }
  await killDaemonProcesses()

  console.log(`\nResults saved to content/probes-mux/`)
}
