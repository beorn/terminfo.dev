/**
 * Mux probe mechanism — test feature pass-through of terminal multiplexers.
 *
 * Launches tmux/screen/etc. in detached mode with a serve daemon inside,
 * probes via HTTP, saves results to content/probes-mux/, then kills the session.
 *
 * This tests how features degrade when going through an intermediary —
 * the same probes that run directly on a terminal now run through the mux.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs"
import { execSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..", "..", "..")
const RESULTS_DIR = join(ROOT, "content", "probes-mux")
const DAEMON_DIR = join(homedir(), ".terminfo-dev", "daemons")
const CLI_ENTRY = join(ROOT, "cli", "src", "index.ts")

// ── Multiplexer definitions ──

interface MuxDef {
  name: string
  id: string
  /** Check if the binary is available */
  binary: string
  /** Get the version string */
  version: () => string
  /** Start a detached session running the given command */
  start: (sessionName: string, cmd: string, env: Record<string, string>) => void
  /** Kill the detached session */
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
        const out = execSync("tmux -V", { encoding: "utf-8", timeout: 3000 }).trim()
        // "tmux 3.6a" → "3.6a"
        return out.replace(/^tmux\s+/, "")
      } catch {
        return "unknown"
      }
    },
    start: (session, cmd, env) => {
      const envStr = Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")
      // tmux new-session with clean env — unset terminal-specific vars so the daemon
      // detects the mux as the terminal, not the outer terminal app
      execSync(`tmux new-session -d -s ${session} -x 120 -y 40 "env ${envStr} ${cmd}"`, {
        timeout: 10_000,
        env: { ...process.env },
      })
    },
    kill: (session) => {
      try {
        execSync(`tmux kill-session -t ${session}`, { timeout: 5000 })
      } catch {}
    },
  },
  {
    name: "GNU Screen",
    id: "screen",
    binary: "screen",
    version: () => {
      try {
        const out = execSync("screen -v 2>&1", { encoding: "utf-8", timeout: 3000 }).trim()
        // "Screen version 4.00.03 (FAU) 23-Oct-06" → "4.00.03"
        const match = out.match(/version\s+([\d.]+)/)
        return match?.[1] ?? "unknown"
      } catch {
        return "unknown"
      }
    },
    start: (session, cmd, env) => {
      // Write a script that sets env and runs the command — screen doesn't support inline env
      const scriptPath = "/tmp/terminfo-mux-serve.sh"
      const envLines = Object.entries(env)
        .map(([k, v]) => `export ${k}="${v}"`)
        .join("\n")
      writeFileSync(scriptPath, `#!/bin/bash\n${envLines}\n${cmd}\n`)
      execSync(`chmod +x ${scriptPath}`)
      execSync(`screen -dmS ${session} ${scriptPath}`, { timeout: 10_000 })
    },
    kill: (session) => {
      try {
        execSync(`screen -S ${session} -X quit`, { timeout: 5000 })
      } catch {}
    },
  },
]

// ── Helpers ──

function whichBinary(name: string): string | null {
  try {
    return execSync(`which ${name}`, { encoding: "utf-8", timeout: 3000 }).trim()
  } catch {
    return null
  }
}

/**
 * Build a clean env for the daemon inside the mux — strip outer terminal identity
 * so detect.ts detects the mux as the terminal.
 */
function cleanEnv(): Record<string, string> {
  return {
    __CFBundleIdentifier: "",
    TERM_PROGRAM: "",
    TERM_PROGRAM_VERSION: "",
    GHOSTTY_RESOURCES_DIR: "",
    KITTY_WINDOW_ID: "",
    WEZTERM_EXECUTABLE: "",
    ALACRITTY_WINDOW_ID: "",
    TERMINAL_EMULATOR: "",
  }
}

/** Wait for a newly-registered daemon (started within last 60s) */
async function waitForDaemon(timeoutMs: number = 30_000): Promise<{ port: number; terminal: string } | null> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      mkdirSync(DAEMON_DIR, { recursive: true })
      const files = readdirSync(DAEMON_DIR).filter((f) => f.endsWith(".json"))
      for (const file of files) {
        const data = JSON.parse(readFileSync(join(DAEMON_DIR, file), "utf-8")) as any
        const started = new Date(data.started).getTime()
        if (Date.now() - started < 60_000) {
          // Verify it's alive
          try {
            const res = await fetch(`http://127.0.0.1:${data.port}/health`, { signal: AbortSignal.timeout(2000) })
            if (res.ok) return { port: data.port, terminal: data.terminal }
          } catch {
            // /health might not exist — try /info instead
            try {
              const res = await fetch(`http://127.0.0.1:${data.port}/info`, { signal: AbortSignal.timeout(2000) })
              if (res.ok) return { port: data.port, terminal: data.terminal }
            } catch {}
          }
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }

  return null
}

/** Clear stale daemon files to avoid false matches */
function clearStaleDaemons(): void {
  try {
    const files = readdirSync(DAEMON_DIR).filter((f) => f.endsWith(".json"))
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(DAEMON_DIR, file), "utf-8")) as any
        // Check if daemon is alive
        const res = await_not_async_check(data.port)
        if (!res) {
          try {
            const { unlinkSync } = require("node:fs")
            unlinkSync(join(DAEMON_DIR, file))
          } catch {}
        }
      } catch {}
    }
  } catch {}
}

/** Synchronous check if a daemon port is reachable (best-effort cleanup) */
function await_not_async_check(_port: number): boolean {
  // We can't do sync HTTP in Node — just skip stale cleanup for now.
  // waitForDaemon already checks health.
  return true
}

/** Probe a daemon and save results */
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

    // Save with the mux name (not the daemon's self-detected terminal)
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
  const binPath = whichBinary(mux.binary)
  if (!binPath) {
    return { success: false, error: "not installed" }
  }

  const version = mux.version()

  // Cache check
  if (!opts.force) {
    const resultPath = join(RESULTS_DIR, `${mux.id}-${version}-${detectOS()}.json`)
    if (existsSync(resultPath)) {
      try {
        const existing = JSON.parse(readFileSync(resultPath, "utf-8")) as any
        const probeCount = Object.keys(existing.results ?? {}).length
        if (probeCount >= 120) {
          return { success: true, skipped: true }
        }
      } catch {}
    }
  }

  // Kill any leftover session from a previous run
  mux.kill(SESSION_NAME)
  await new Promise((r) => setTimeout(r, 500))

  const serveCmd = `${BUN} "${CLI_ENTRY}" probe server --start`

  console.log(`  Launching ${mux.name} v${version}...`)
  try {
    mux.start(SESSION_NAME, serveCmd, cleanEnv())
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

  // Clean up
  mux.kill(SESSION_NAME)

  if (!result) {
    return { success: false, error: "Probe failed" }
  }

  console.log(`  ${result.passed}/${result.total} probes passed`)
  return { success: true }
}

// ── Main handler ──

export async function handleMux(
  muxName: string | undefined,
  opts: { all?: boolean; force?: boolean },
): Promise<void> {
  if (!muxName && !opts.all) {
    console.log("\nAvailable multiplexers:\n")
    for (const mux of MUXES) {
      const installed = !!whichBinary(mux.binary)
      const version = installed ? mux.version() : ""
      console.log(`  ${installed ? "+" : "-"} ${mux.name.padEnd(16)} ${version}`)
    }
    console.log(`\nProbe all:  \x1b[1mterminfo probe mux --all\x1b[0m`)
    console.log(`Probe one:  \x1b[1mterminfo probe mux tmux\x1b[0m`)
    console.log(
      `\nApproach: launches multiplexer → starts serve daemon inside → probes via HTTP → kills session`,
    )
    return
  }

  let muxesToRun = MUXES
  if (muxName) {
    const name = muxName.toLowerCase()
    muxesToRun = MUXES.filter((m) => m.id === name || m.name.toLowerCase() === name)
    if (muxesToRun.length === 0) {
      console.error(`Unknown multiplexer. Available: ${MUXES.map((m) => m.id).join(", ")}`)
      process.exit(1)
    }
  }

  // Filter to installed only
  muxesToRun = muxesToRun.filter((m) => !!whichBinary(m.binary))
  if (muxesToRun.length === 0) {
    console.error("No multiplexers available to test.")
    process.exit(1)
  }

  console.log(`\nProbing through ${muxesToRun.length} multiplexer(s)\n`)

  const results: Array<{ mux: MuxDef; result: Awaited<ReturnType<typeof runMux>> }> = []

  for (const mux of muxesToRun) {
    console.log(`--- ${mux.name} ---`)
    const result = await runMux(mux, { force: opts.force })
    results.push({ mux, result })

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
  for (const { mux, result } of results) {
    const status = result.skipped ? "cached" : result.success ? "OK" : `FAIL: ${result.error}`
    console.log(`  ${mux.name.padEnd(16)} ${status}`)
  }

  console.log(`\nResults saved to content/probes-mux/`)
}
