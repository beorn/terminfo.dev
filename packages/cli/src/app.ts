/**
 * App probe mechanism — launch macOS terminal apps with serve daemon, probe via HTTP.
 *
 * Approach: launch terminal binary directly with `serve --start` command,
 * wait for daemon to register, probe it via HTTP, save results, kill the terminal.
 *
 * This avoids AppleScript keystrokes (which many terminals block) and uses
 * the full 128-probe set from the serve daemon.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs"
import { execSync, spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..", "..", "..")
const RESULTS_DIR = join(ROOT, "content", "probes-apps")
const DAEMON_DIR = join(homedir(), ".terminfo-dev", "daemons")
const CLI_ENTRY = join(ROOT, "cli", "src", "index.ts")

// ── App definitions ──

interface AppDef {
  name: string
  id: string // used in result filenames
  appPath: string
  binaryPath: string // direct path to the executable
  launchArgs: (cmd: string) => string[] // args to run a command inside the terminal
  bundleId: string
}

const BUN = process.execPath // use the same bun that's running us

const APPS: AppDef[] = [
  {
    name: "Ghostty",
    id: "ghostty",
    appPath: "/Applications/Ghostty.app",
    binaryPath: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
    launchArgs: (script) => ["-e", script],
    bundleId: "com.mitchellh.ghostty",
  },
  {
    name: "iTerm2",
    id: "iterm2",
    appPath: "/Applications/iTerm.app",
    binaryPath: "", // iTerm2 uses AppleScript (its own API, not System Events)
    launchArgs: () => [],
    bundleId: "com.googlecode.iterm2",
  },
  {
    name: "Terminal.app",
    id: "terminal-app",
    appPath: "/System/Applications/Utilities/Terminal.app",
    binaryPath: "", // Terminal.app uses AppleScript (its own API)
    launchArgs: () => [],
    bundleId: "com.apple.Terminal",
  },
  {
    name: "kitty",
    id: "kitty",
    appPath: "/Applications/kitty.app",
    binaryPath: "/Applications/kitty.app/Contents/MacOS/kitty",
    launchArgs: (script) => ["--hold", script],
    bundleId: "net.kovidgoyal.kitty",
  },
  {
    name: "Warp",
    id: "warp",
    appPath: "/Applications/Warp.app",
    binaryPath: "", // Warp doesn't support direct command launch
    launchArgs: () => [],
    bundleId: "dev.warp.Warp-Stable",
  },
]

// ── Version detection ──

function getAppVersion(app: AppDef): string {
  try {
    const plistPath = join(app.appPath, "Contents", "Info.plist")
    return execSync(
      `/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "${plistPath}" 2>/dev/null`,
      { encoding: "utf8" },
    ).trim() || "unknown"
  } catch {
    return "unknown"
  }
}

// ── Launch terminal with serve daemon ──

function launchWithServe(app: AppDef): ChildProcess | null {
  const serveCmd = `${BUN} "${CLI_ENTRY}" probe server --start`

  // Direct binary launch (Ghostty, Kitty)
  if (app.binaryPath && existsSync(app.binaryPath)) {
    // Write serve command to a script to avoid quoting/escaping issues
    const scriptPath = "/tmp/terminfo-serve.sh"
    writeFileSync(scriptPath, `#!/bin/bash\n${serveCmd}\nsleep 999999\n`)
    execSync(`chmod +x ${scriptPath}`)

    const args = app.launchArgs(scriptPath)
    const child = spawn(app.binaryPath, args, {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    })
    child.unref()
    return child
  }

  // AppleScript launch (iTerm2, Terminal.app) — uses their own scripting APIs, not System Events
  // Write serve command to a temp script to avoid quoting issues in AppleScript
  const scriptPath = "/tmp/terminfo-serve.sh"
  writeFileSync(scriptPath, `#!/bin/bash\n${serveCmd}\nsleep 999999\n`)
  execSync(`chmod +x ${scriptPath}`)

  if (app.id === "iterm2") {
    try {
      execSync(`osascript -e 'tell application "iTerm"
  activate
  create window with default profile command "/tmp/terminfo-serve.sh"
end tell'`, { timeout: 15000 })
      return null // process managed by iTerm2
    } catch {
      return null
    }
  }

  if (app.id === "terminal-app") {
    try {
      execSync(`osascript -e 'tell application "Terminal"
  activate
  do script "/tmp/terminfo-serve.sh"
end tell'`, { timeout: 15000 })
      return null // process managed by Terminal.app
    } catch {
      return null
    }
  }

  // Warp — can only be tested if user runs serve manually
  console.log(`  ${app.name}: Run \`terminfo probe server --start\` manually in ${app.name}`)
  return null
}

// ── Wait for daemon to register ──

async function waitForDaemon(appId: string, timeoutMs: number = 30_000): Promise<{ port: number; terminal: string } | null> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const files = readdirSync(DAEMON_DIR).filter((f) => f.endsWith(".json"))
      for (const file of files) {
        const data = JSON.parse(readFileSync(join(DAEMON_DIR, file), "utf-8")) as any
        // Check if this daemon was just started (within last 60s)
        const started = new Date(data.started).getTime()
        if (Date.now() - started < 60_000) {
          // Verify it's alive
          try {
            const res = await fetch(`http://127.0.0.1:${data.port}/health`, { signal: AbortSignal.timeout(2000) })
            if (res.ok) {
              return { port: data.port, terminal: data.terminal }
            }
          } catch {}
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }

  return null
}

// ── Probe a daemon ──

async function probeDaemon(port: number, appId: string, version: string): Promise<{ total: number; passed: number } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/probe`, { signal: AbortSignal.timeout(120_000) })
    if (!res.ok) return null

    const data = (await res.json()) as any
    const results = data.results ?? {}
    const total = Object.keys(results).length
    const passed = Object.values(results).filter(Boolean).length

    // Save result with the correct terminal name (not what detect.ts guessed)
    const result: Record<string, any> = {
      terminal: appId,
      terminalVersion: version,
      os: "macos",
      osVersion: data.osVersion ?? "",
      source: "daemon",
      generated: new Date().toISOString(),
      results,
    }
    if (data.notes && Object.keys(data.notes).length > 0) result.notes = data.notes
    if (data.responses && Object.keys(data.responses).length > 0) result.responses = data.responses

    mkdirSync(RESULTS_DIR, { recursive: true })
    const filename = `${appId}-${version}-macos.json`
    writeFileSync(join(RESULTS_DIR, filename), JSON.stringify(result, null, 2))

    return { total, passed }
  } catch (e: any) {
    console.log(`  Probe failed: ${e.message}`)
    return null
  }
}

// ── Kill terminal process ──

function killTerminal(proc: ChildProcess | null, app: AppDef): void {
  if (proc) {
    try {
      proc.kill("SIGTERM")
    } catch {}
    return
  }

  // For AppleScript-launched terminals, close the window via AppleScript
  if (app.id === "iterm2") {
    try {
      execSync(`osascript -e 'tell application "iTerm" to close current window'`, { timeout: 5000 })
    } catch {}
  }
  // Don't close Terminal.app — user might have other windows open
}

// ── Run one app ──

async function runApp(app: AppDef, opts: { force?: boolean }): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  if (!existsSync(app.appPath)) {
    return { success: false, error: "not installed" }
  }

  const version = getAppVersion(app)

  // Cache check
  if (!opts.force) {
    const resultPath = join(RESULTS_DIR, `${app.id}-${version}-macos.json`)
    if (existsSync(resultPath)) {
      try {
        const existing = JSON.parse(readFileSync(resultPath, "utf-8")) as any
        const probeCount = Object.keys(existing.results ?? {}).length
        if (probeCount >= 120) { // recent enough probe set
          return { success: true, skipped: true }
        }
      } catch {}
    }
  }

  // Warp needs manual serve
  if (app.id === "warp" && !app.binaryPath) {
    return { success: false, error: "Run `terminfo probe server --start` in Warp manually, then use `probe server`" }
  }

  console.log(`  Launching ${app.name} v${version}...`)
  const proc = launchWithServe(app)

  console.log(`  Waiting for daemon...`)
  const daemon = await waitForDaemon(app.id)

  if (!daemon) {
    killTerminal(proc, app)
    return { success: false, error: "Daemon didn't register within 30s" }
  }

  console.log(`  Probing on port ${daemon.port}...`)
  const result = await probeDaemon(daemon.port, app.id, version)

  // Clean up — kill the terminal
  killTerminal(proc, app)

  if (!result) {
    return { success: false, error: "Probe failed" }
  }

  console.log(`  ${result.passed}/${result.total} probes passed`)
  return { success: true }
}

// ── Main ──

export async function handleApp(
  terminal: string | undefined,
  opts: { all?: boolean; force?: boolean },
): Promise<void> {
  if (!terminal && !opts.all) {
    console.log("\nAvailable terminal apps:\n")
    for (const app of APPS) {
      const installed = existsSync(app.appPath)
      const version = installed ? getAppVersion(app) : ""
      const method = app.binaryPath ? "binary" : app.id === "warp" ? "manual" : "applescript"
      console.log(
        `  ${installed ? "+" : "-"} ${app.name.padEnd(16)} ${version.padEnd(10)} (${method})`,
      )
    }
    console.log(`\nProbe all:  \x1b[1mterminfo probe app --all\x1b[0m`)
    console.log(`Probe one:  \x1b[1mterminfo probe app ghostty\x1b[0m`)
    console.log(`\nApproach: launches terminal → starts serve daemon → probes via HTTP → kills terminal`)
    return
  }

  let appsToRun = APPS
  if (terminal) {
    const name = terminal.toLowerCase()
    appsToRun = APPS.filter(
      (app) => app.id === name || app.name.toLowerCase() === name,
    )
    if (appsToRun.length === 0) {
      console.error(`Unknown terminal. Available: ${APPS.map((a) => a.id).join(", ")}`)
      process.exit(1)
    }
  }

  appsToRun = appsToRun.filter((app) => existsSync(app.appPath))
  if (appsToRun.length === 0) {
    console.error("No terminal apps available to test.")
    process.exit(1)
  }

  console.log(`\nProbing ${appsToRun.length} terminal(s)\n`)

  const results: Array<{ app: AppDef; result: Awaited<ReturnType<typeof runApp>> }> = []

  for (const app of appsToRun) {
    console.log(`--- ${app.name} ---`)
    const result = await runApp(app, { force: opts.force })
    results.push({ app, result })

    if (result.skipped) {
      console.log(`  Cached (128+ probes). Use --force to re-run.`)
    } else if (!result.success) {
      console.log(`  FAILED: ${result.error}`)
    }

    // Brief pause between launches
    if (appsToRun.indexOf(app) < appsToRun.length - 1) {
      await new Promise((r) => setTimeout(r, 2000))
    }
  }

  console.log("\n=== Summary ===\n")
  for (const { app, result } of results) {
    const status = result.skipped ? "cached" : result.success ? "OK" : `FAIL: ${result.error}`
    console.log(`  ${app.name.padEnd(16)} ${status}`)
  }
}
