/**
 * App probe mechanism — launch macOS terminal apps with serve daemon, probe via HTTP.
 *
 * Approach: launch terminal binary directly with `serve --start` command,
 * wait for daemon to register, probe it via HTTP, save results, kill the terminal.
 *
 * This avoids AppleScript keystrokes (which many terminals block) and uses
 * the full 128-probe set from the serve daemon.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  createProbeRun,
  findOwnedDaemon,
  readRetainedDaemonProbeResponse,
  removeProbeRun,
  requestDaemonProbe,
  shellQuote,
  stopOwnedDaemon,
  type DaemonRegistration,
  type OwnedDaemon,
  type ProbeRun,
} from "../../terminfo.dev/src/daemon-client.ts"
import { homedir } from "node:os"
import { verifyTerminalIdentity } from "../../terminfo.dev/src/identity-guard.ts"
import { sourceSuiteEnvironment } from "../versions.ts"
import { captureTerminalAppReceipt, launchTerminalWindow } from "./terminal-app-receipt.ts"
import { admitCollectedRun, retainCollectedRun } from "./admit-collected-run.ts"
import {
  assertOwnedTerminalWindow,
  closeOwnedTerminalWindow,
  parseKittyIdentity,
  type OwnedTerminalWindow,
  type KittyWindow,
} from "../../terminfo.dev/src/terminal-app-window.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..", "..", "..")
const DAEMON_DIR = join(homedir(), ".terminfo-dev", "daemons")
const CLI_ENTRY = join(ROOT, "packages", "admin", "src", "index.ts")

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
  const plistPath = join(app.appPath, "Contents", "Info.plist")
  try {
    const version = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", plistPath], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 262144,
    }).trim()
    if (!version) throw new Error("CFBundleShortVersionString is empty")
    return version
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`Cannot read ${app.name} version from ${plistPath}: ${detail}`, { cause })
  }
}

// ── Launch terminal with serve daemon ──

interface AppLaunch {
  proc: ChildProcess | null
  windowId?: number
  terminalWindow?: OwnedTerminalWindow
  identityPath?: string
  /** The run-scoped kitty instance group, and the detached launcher's retained stderr. */
  instanceGroup?: string
  launcherStderr?: string
}

function launchWithServe(app: AppDef, run: ProbeRun): AppLaunch {
  const suite = sourceSuiteEnvironment()
  const serveCmd = `TERMINFO_RUN_ID=${run.id} TERMINFO_PROBE_HASH=${suite.TERMINFO_PROBE_HASH} TERMINFO_SOURCE_REVISION=${suite.TERMINFO_SOURCE_REVISION} exec ${shellQuote(BUN)} ${shellQuote(CLI_ENTRY)} probe server --start`
  const identityPath = app.id === "kitty" ? join(run.directory, "owner-identity.txt") : undefined
  const identityWrite =
    identityPath === undefined
      ? ""
      : `printf '%s\\n' "\${KITTY_WINDOW_ID:-}" "\${KITTY_PID:-}" "$(tty)" "\${TERM:-}" > ${shellQuote(identityPath)}\n`
  writeFileSync(run.scriptPath, `#!/bin/bash\n${identityWrite}${serveCmd}\n`, { flag: "wx", mode: 0o700 })

  if (app.binaryPath && existsSync(app.binaryPath)) {
    if (app.id === "kitty") {
      // A run-unique instance group, no single-instance reuse, and a detached launch: measured 0-byte
      // stderr and a window that outlives the launcher, which the recorded kitty pid closes.
      const instanceGroup = `terminfo-${run.id}`
      const launched = spawnSync(
        app.binaryPath,
        ["--detach", "--instance-group", instanceGroup, "-1", "--", "/bin/bash", run.scriptPath],
        { encoding: "utf8", timeout: 15_000 },
      )
      if (launched.error || launched.status !== 0) {
        throw new Error(
          `kitty launch failed: ${launched.error?.message ?? launched.stderr?.trim() ?? `exit ${String(launched.status)}`}`,
        )
      }
      return { proc: null, identityPath, instanceGroup, launcherStderr: String(launched.stderr ?? "") }
    }
    // Any other runnable binary still spawns its own launcher and keeps the child handle for close.
    const child = spawn(app.binaryPath, app.launchArgs(run.scriptPath), {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    })
    child.unref()
    return { proc: child }
  }

  if (app.id === "iterm2") {
    const output = execFileSync(
      "osascript",
      [
        "-e",
        `tell application "iTerm"
  set w to create window with default profile command ${JSON.stringify(run.scriptPath)}
  return id of w
end tell`,
      ],
      { encoding: "utf8", timeout: 15_000 },
    ).trim()
    const windowId = Number(output)
    if (!Number.isInteger(windowId)) throw new Error(`iTerm did not return the launched window ID: ${output}`)
    return { proc: null, windowId }
  }

  if (app.id === "terminal-app") {
    return { proc: null, terminalWindow: launchTerminalWindow(run.scriptPath) }
  }

  throw new Error(`${app.name} requires manually starting the probe server`)
}

function stopLaunchedApp(app: AppDef, launch: AppLaunch): void {
  if (launch.terminalWindow) {
    closeOwnedTerminalWindow(launch.terminalWindow)
    return
  }
  if (launch.proc) {
    launch.proc.kill("SIGTERM")
    return
  }
  if (launch.windowId === undefined) return
  const application = app.id === "iterm2" ? "iTerm" : "Terminal"
  execFileSync(
    "osascript",
    ["-e", `tell application "${application}" to close (first window whose id is ${launch.windowId})`],
    { timeout: 5000 },
  )
}

// ── Probe a daemon ──

interface ProbeOptions {
  appId: string
  version: string
  /** The window this run launched and must still own. An app the probe launched never runs without one. */
  ownedWindow: OwnedTerminalWindow
  outputDirectory?: string
  /** The detached kitty launcher's stderr, retained with the run whether or not it is empty. */
  launcherStderr?: string
}

async function probeDaemon(
  daemon: DaemonRegistration,
  options: ProbeOptions,
): Promise<{ total: number; observed: number; mode: "retained" | "admitted" }> {
  const { appId, version, ownedWindow, outputDirectory, launcherStderr } = options
  const appLaunch =
    ownedWindow.provider === "terminal-app" ? captureTerminalAppReceipt(ownedWindow, daemon.pid, version) : null
  assertOwnedTerminalWindow(ownedWindow, daemon.pid)
  // The daemon's owner-request field is Terminal.app's own assertion and refuses any other terminal;
  // kitty's ownership is proved here, in the run trace, and never sent as a Terminal.app claim.
  const res = await requestDaemonProbe(
    daemon,
    ownedWindow.provider === "terminal-app"
      ? {
          asserter: "terminfo-admin",
          launchRunId: daemon.runId,
          workerPid: daemon.pid,
          windowId: ownedWindow.windowId,
          tabTty: ownedWindow.tty,
          intendedVersion: version,
        }
      : undefined,
  )
  const retained = await readRetainedDaemonProbeResponse(res)
  console.log(`  Retained private HTTP response ${retained.path}; SHA256 ${retained.sha256}`)
  const data = retained.run
  const identityCheck = verifyTerminalIdentity(appId, data.rawReplies)
  const run = {
    ...data,
    ...(appLaunch && { origin: { ...data.origin, appLaunch: appLaunch.receipt } }),
    rawReplies: {
      ...data.rawReplies,
      "collector.identityCheck": JSON.stringify(identityCheck),
      ...(appLaunch && { "collector.appLaunchTrace": JSON.stringify(appLaunch.trace) }),
      ...(launcherStderr !== undefined && {
        "collector.kittyLauncher": JSON.stringify({ exitStatus: 0, stderr: launcherStderr }),
      }),
      ...(ownedWindow.provider === "kitty" && {
        "collector.kittyOwner": JSON.stringify({
          windowId: ownedWindow.windowId,
          kittyPid: ownedWindow.kittyPid,
          tty: ownedWindow.tty,
          executablePath: ownedWindow.executablePath,
          instanceGroup: ownedWindow.instanceGroup,
        }),
      }),
    },
  }
  const mode = outputDirectory === undefined ? "admitted" : "retained"
  if (outputDirectory !== undefined) {
    const source = retainCollectedRun(run, retained.path, { kind: "app", id: appId, version }, outputDirectory)
    console.log(`  Retained private development run ${source}`)
  } else {
    admitCollectedRun(run, retained.path, { kind: "app", id: appId, version })
  }
  const observed = run.observations.length
  const total = observed + Object.keys(run.ungradedDiagnostics ?? {}).length
  return { total, observed, mode }
}

// ── Run one app ──

/** Build the kitty owner from the record the serve script wrote; the assertions live in the owner authority. */
function ownedKittyWindow(app: AppDef, launch: AppLaunch): KittyWindow {
  if (launch.identityPath === undefined) throw new Error("kitty launch recorded no owner identity path")
  if (launch.instanceGroup === undefined) throw new Error("kitty launch recorded no instance group")
  if (app.binaryPath === undefined || app.binaryPath.length === 0) {
    throw new Error("kitty launch has no binary path to compare the live process against")
  }
  const identity = parseKittyIdentity(readFileSync(launch.identityPath, "utf8"))
  return {
    provider: "kitty",
    windowId: identity.windowId,
    tty: identity.tty,
    kittyPid: identity.kittyPid,
    executablePath: app.binaryPath,
    instanceGroup: launch.instanceGroup,
  }
}

async function runApp(
  app: AppDef,
  opts: { force?: boolean; output?: string },
): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  if (!existsSync(app.appPath)) return { success: false, error: "not installed" }
  const version = getAppVersion(app)
  if (app.id === "warp" && !app.binaryPath) {
    return { success: false, error: "Run `terminfo probe server --start` in Warp manually, then use `probe server`" }
  }

  const run = createProbeRun()
  let launch: AppLaunch | undefined
  let daemon: OwnedDaemon | null = null
  let outcome: { success: boolean; error?: string } = { success: false, error: "probe did not complete" }
  try {
    console.log(`  Launching ${app.name} v${version}...`)
    launch = launchWithServe(app, run)
    if (launch.terminalWindow === undefined && app.id !== "kitty") {
      throw new Error(
        `${app.name} has no owned-window assertion; refusing to collect a run this probe cannot prove it launched`,
      )
    }
    console.log(`  Waiting for owned daemon...`)
    daemon = await findOwnedDaemon(run.id, DAEMON_DIR, app.id)
    if (!daemon) throw new Error("Owned daemon did not register within 30s")
    const ownedWindow = app.id === "kitty" ? ownedKittyWindow(app, launch) : launch.terminalWindow
    if (ownedWindow === undefined) throw new Error(`${app.name} produced no owned window for this run`)
    launch.terminalWindow = ownedWindow
    console.log(`  Probing on port ${daemon.registration.port}...`)
    const result = await probeDaemon(daemon.registration, {
      appId: app.id,
      version,
      ownedWindow,
      outputDirectory: opts.output,
      launcherStderr: launch.launcherStderr,
    })
    console.log(`  ${result.observed}/${result.total} explicit observations (${result.mode})`)
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
    if (launch) {
      if (app.id === "kitty" && launch.terminalWindow === undefined) {
        try {
          if (launch.identityPath === undefined || !existsSync(launch.identityPath)) {
            throw new Error("the launch recorded no identity file")
          }
          launch.terminalWindow = ownedKittyWindow(app, launch)
        } catch (err) {
          cleanupErrors.push(`window: could not adopt the launched kitty window for close: ${String(err)}`)
        }
      }
      try {
        stopLaunchedApp(app, launch)
      } catch (err) {
        cleanupErrors.push(`window: ${String(err)}`)
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

// ── Main ──

export async function handleApp(
  terminal: string | undefined,
  opts: { all?: boolean; force?: boolean; output?: string },
): Promise<void> {
  if (!terminal && !opts.all) {
    console.log("\nAvailable terminal apps:\n")
    for (const app of APPS) {
      const installed = existsSync(app.appPath)
      const version = installed ? getAppVersion(app) : ""
      const method = app.binaryPath ? "binary" : app.id === "warp" ? "manual" : "applescript"
      console.log(`  ${installed ? "+" : "-"} ${app.name.padEnd(16)} ${version.padEnd(10)} (${method})`)
    }
    console.log("\nProbe all:  terminfo probe app --all")
    console.log("Probe one:  terminfo probe app ghostty")
    console.log(`\nApproach: launches terminal → starts serve daemon → probes via HTTP → kills terminal`)
    return
  }

  let appsToRun = APPS
  if (terminal) {
    const name = terminal.toLowerCase()
    appsToRun = APPS.filter((app) => app.id === name || app.name.toLowerCase() === name)
    if (appsToRun.length === 0) {
      throw new Error(`Unknown terminal. Available: ${APPS.map((a) => a.id).join(", ")}`)
    }
  }

  appsToRun = appsToRun.filter((app) => existsSync(app.appPath))
  if (appsToRun.length === 0) {
    throw new Error("No terminal apps available to test.")
  }

  console.log(`\nProbing ${appsToRun.length} terminal(s)\n`)

  const results: Array<{ app: AppDef; result: Awaited<ReturnType<typeof runApp>> }> = []

  for (const app of appsToRun) {
    console.log(`--- ${app.name} ---`)
    const result = await runApp(app, { force: opts.force, output: opts.output })
    results.push({ app, result })

    if (result.skipped) {
      console.log(`  Cached (128+ probes). Use --force to re-run.`)
    } else if (!result.success) {
      console.log(`  FAILED: ${result.error}`)
    }

    // Brief pause between launches
    if (appsToRun.indexOf(app) < appsToRun.length - 1) {
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 2000)
      })
    }
  }

  console.log("\n=== Summary ===\n")
  for (const { app, result } of results) {
    const status = result.skipped ? "cached" : result.success ? "OK" : `FAIL: ${result.error}`
    console.log(`  ${app.name.padEnd(16)} ${status}`)
  }

  const failures = results.filter(({ result }) => !result.success)
  if (failures.length > 0) {
    throw new Error(
      `App collection failed: ${failures.map(({ app, result }) => `${app.id}: ${result.error}`).join("; ")}`,
    )
  }
}
