import {
  aggregateCurrentResults,
  currentCoverageSentence,
  currentSupportedShare,
} from "../../../docs/data/release-scope.ts"
/**
 * App probe mechanism — launch macOS terminal apps with serve daemon, probe via HTTP.
 *
 * Approach: launch terminal binary directly with `serve --start` command,
 * wait for daemon to register, probe it via HTTP, save results, kill the terminal.
 *
 * This avoids AppleScript keystrokes (which many terminals block) and uses
 * the full 128-probe set from the serve daemon.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process"
import { dirname, isAbsolute, join } from "node:path"
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
import { parseLstart } from "../../terminfo.dev/src/disposable-receipt.ts"
import { captureTerminalAppReceipt, launchTerminalWindow } from "./terminal-app-receipt.ts"
import { admitCollectedRun, retainCollectedRun } from "./admit-collected-run.ts"
import { serveCommand } from "./serve-command.ts"
import { serializeOuterLaunchRecord } from "./outer-launch.ts"
import { KITTY_BINARY_PATH } from "./kitty-binary.ts"
import { assertCursorBundlePinsShipped, dismissCursorCommandLinePrompt } from "./cursor-onboarding.ts"
import {
  assertOwnedTerminalWindow,
  closeOwnedTerminalWindow,
  kittyOwnedProcess,
  parseKittyIdentity,
  recordedOwnerTty,
  resolveOwnedProcessByMarker,
  type OwnedTerminalWindow,
  type KittyWindow,
} from "../../terminfo.dev/src/terminal-app-window.ts"
import type { ProcessOwnerAssertion } from "../../terminfo.dev/src/owned-terminal.ts"
import { runScopedMarker, type ProcessMarker } from "../../terminfo.dev/src/owned-process.ts"

const DAEMON_DIR = join(homedir(), ".terminfo-dev", "daemons")

// ── App definitions ──

interface AppDef {
  name: string
  id: string // used in result filenames
  appPath: string
  binaryPath: string // direct path to the executable
  bundleId: string
  /** A GUI app whose CLI hands the window to an already-resolved owner process. The owner is proven by
   * the run-scoped marker in its argv, never by the CLI shim's pid, which may exit after the handoff.
   * No recipe lands until its marker is measured on that reviewed head on a real host (28018). */
  cliLaunch?: {
    /** The binary the launch spawns. A CLI that hands off and then execs into the GUI belongs here
     * (`wezterm` execs into `wezterm-gui`), so the spawn path and the owner path are separate. */
    spawnPath: string
    /** The GUI owner binary the marker must be found on; never the CLI shim. */
    executablePath: string
    /** The argv flag whose value carries the run id. */
    markerFlag: string
    /** The marker value, derived from the run. It must contain the run id and no whitespace; both are
     * refused at launch rather than surfacing later as a misleading "no live process". */
    markerValue: (run: ProbeRun) => string
    /** The launch arguments, given the serve script and the run-scoped marker value. */
    args: (script: string, markerValue: string) => string[]
    /** App CLI configuration scoped to this launch, never the operator's profile. */
    env?: Record<string, string>
    /** Run-scoped files the marker refers to, written once the marker is validated and before the
     * launch. A marker that names a config file needs that file to exist; no other app needs this. */
    prepare?: (run: ProbeRun, markerValue: string) => void
    /** The capture route this recipe is ruled for (#30518 D5). Declared only where a frame route is
     * ruled — today Ghostty's owned process arm. It hands the collector
     * TERMINFO_CAPTURE_DIRECTORY=<run>/artifacts; an app that declares nothing keeps no capture. */
    capture?: "artifact-directory"
  }
}

/** Ghostty's disposable config file, named with the run id so the marker satisfies runScopedMarker. */
const ghosttyConfigPath = (run: ProbeRun): string => join(run.directory, `ghostty-${run.id}`)

/**
 * The ONE argv every owned Ghostty launch uses (@cto D2, #30518). Ghostty's args.zig reads only
 * `--key=value`, so the two-token `--config-file <path>` this replaces was never read, and `-e` on a
 * direct spawn raised Ghostty's "Allow Ghostty to execute" alert. The run file's `command` runs the script.
 */
const ghosttyLaunchArgv = (runFile: string): string[] => ["--config-default-files=false", `--config-file=${runFile}`]

/** D2: the run file is exactly four lines. Its `command` line is unquoted, so the script path must be
 * absolute, carry this run's id and hold only [A-Za-z0-9/._-]; anything else refuses by name. */
function ghosttyRunFile(run: ProbeRun): string {
  const script = run.scriptPath
  const outside = [...new Set([...script].filter((char) => !/[A-Za-z0-9/._-]/.test(char)))]
  if (!isAbsolute(script) || !script.includes(run.id) || outside.length > 0) {
    throw new Error(
      `Ghostty script path ${JSON.stringify(script)} must be absolute, carry run id ${run.id} and hold only [A-Za-z0-9/._-] (outside: ${JSON.stringify(outside)}); no launch`,
    )
  }
  const lines = [
    `command = ${script}`,
    "confirm-close-surface = false",
    "quit-after-last-window-closed = true",
    "window-save-state = never",
  ]
  return `${lines.join("\n")}\n`
}

/** WezTerm's disposable config file, named with the run id so the marker satisfies runScopedMarker. */
const weztermConfigPath = (run: ProbeRun): string => join(run.directory, `wezterm-${run.id}.lua`)

function prepareEditorFixture(run: ProbeRun, markerValue: string, prefix: "cursor" | "vscode"): void {
  const fixture = join(run.directory, `${prefix}-fixture`)
  for (const directory of [markerValue, join(run.directory, `${prefix}-extensions`), fixture]) {
    mkdirSync(directory, { mode: 0o700 })
  }
  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify({
      name: `terminfo-${prefix}-${run.id}`,
      publisher: "terminfo",
      version: "0.0.0",
      engines: { vscode: "^1.74.0" },
      main: "./extension.cjs",
      activationEvents: ["onStartupFinished"],
    }),
    { flag: "wx", mode: 0o600 },
  )
  const terminal = {
    name: `terminfo-${run.id}`,
    shellPath: "/bin/bash",
    shellArgs: [run.scriptPath],
    cwd: run.directory,
  }
  writeFileSync(
    join(fixture, "extension.cjs"),
    `const vscode = require("vscode");
exports.activate = (context) => {
  const terminal = vscode.window.createTerminal(${JSON.stringify(terminal)});
  context.subscriptions.push(terminal);
  terminal.show();
};
`,
    { flag: "wx", mode: 0o600 },
  )
}

const vscodeAdditionalStatePaths = [
  ["--shared-data-dir", "vscode-shared"],
  ["--agent-plugins-dir", "vscode-agent-plugins"],
  ["--agents-user-data-dir", "vscode-agents-data"],
  ["--agents-extensions-dir", "vscode-agents-extensions"],
  ["--crash-reporter-directory", "vscode-crash"],
] as const

const APPS: AppDef[] = [
  {
    name: "Ghostty",
    id: "ghostty",
    appPath: "/Applications/Ghostty.app",
    binaryPath: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
    bundleId: "com.mitchellh.ghostty",
    // The binary is the GUI process itself; the run-scoped config file in its argv is the marker the
    // owner is resolved from, never the spawned handle, which a running instance can absorb.
    cliLaunch: {
      capture: "artifact-directory",
      spawnPath: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
      executablePath: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
      markerFlag: "--config-file",
      markerValue: ghosttyConfigPath,
      prepare: (run, markerValue) => {
        writeFileSync(markerValue, ghosttyRunFile(run), { flag: "wx", mode: 0o600 })
      },
      args: (_script, markerValue) => ghosttyLaunchArgv(markerValue),
    },
  },
  {
    name: "iTerm2",
    id: "iterm2",
    appPath: "/Applications/iTerm.app",
    binaryPath: "", // iTerm2 uses AppleScript (its own API, not System Events)
    bundleId: "com.googlecode.iterm2",
  },
  {
    name: "Terminal.app",
    id: "terminal-app",
    appPath: "/System/Applications/Utilities/Terminal.app",
    binaryPath: "", // Terminal.app uses AppleScript (its own API)
    bundleId: "com.apple.Terminal",
  },
  {
    name: "kitty",
    id: "kitty",
    appPath: "/Applications/kitty.app",
    binaryPath: KITTY_BINARY_PATH,
    bundleId: "net.kovidgoyal.kitty",
  },
  {
    name: "WezTerm",
    id: "wezterm",
    appPath: "/Applications/WezTerm.app",
    binaryPath: "/Applications/WezTerm.app/Contents/MacOS/wezterm",
    bundleId: "com.github.wez.wezterm",
    // The CLI execs into this GUI binary, which is the process that carries the marker in its argv.
    cliLaunch: {
      spawnPath: "/Applications/WezTerm.app/Contents/MacOS/wezterm",
      executablePath: "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui",
      markerFlag: "--config-file",
      markerValue: weztermConfigPath,
      prepare: (_run, markerValue) => {
        writeFileSync(markerValue, "return {}\n", { flag: "wx", mode: 0o600 })
      },
      args: (script, markerValue) => [
        "--config-file",
        markerValue,
        "start",
        "--always-new-process",
        "--",
        "/bin/bash",
        script,
      ],
    },
  },
  {
    name: "Cursor",
    id: "cursor",
    appPath: "/Applications/Cursor.app",
    binaryPath: "/Applications/Cursor.app/Contents/MacOS/Cursor",
    bundleId: "com.todesktop.230313mzl4w4u92",
    cliLaunch: {
      spawnPath: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
      executablePath: "/Applications/Cursor.app/Contents/MacOS/Cursor",
      markerFlag: "--user-data-dir",
      markerValue: (run) => join(run.directory, `cursor-${run.id}`),
      env: { CURSOR_CLI_BLOCK_CURSOR_AGENT: "true" },
      prepare: (run, markerValue) => {
        assertCursorBundlePinsShipped("/Applications/Cursor.app")
        prepareEditorFixture(run, markerValue, "cursor")
        const user = join(markerValue, "User")
        mkdirSync(user, { mode: 0o700 })
        // Without it the updater reaches "ready" and "New update available" covers the terminal.
        writeFileSync(join(user, "settings.json"), JSON.stringify({ "update.mode": "none" }), {
          flag: "wx",
          mode: 0o600,
        })
        // "Want to launch Cursor from the command line?" has no setting; pinned in ./cursor-onboarding.ts.
        dismissCursorCommandLinePrompt(markerValue)
      },
      args: (_script, markerValue) => {
        const directory = dirname(markerValue)
        return [
          "--new-window",
          "--classic",
          // Hidden flag: Cursor 3.25.9 out/vs/workbench/workbench.desktop.main.js maybeOnboard() returns when
          // environmentService.skipOnboarding (args["skip-onboarding"]) is set; pinned in ./cursor-onboarding.ts.
          "--skip-onboarding",
          "--user-data-dir",
          markerValue,
          "--extensions-dir",
          join(directory, "cursor-extensions"),
          "--extensionDevelopmentPath",
          join(directory, "cursor-fixture"),
        ]
      },
    },
  },
  {
    name: "VS Code",
    id: "com.microsoft.VSCode",
    appPath: "/Applications/Visual Studio Code.app",
    binaryPath: "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
    bundleId: "com.microsoft.VSCode",
    cliLaunch: {
      spawnPath: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      executablePath: "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
      markerFlag: "--user-data-dir",
      markerValue: (run) => join(run.directory, `vscode-${run.id}`),
      prepare: (run, markerValue) => {
        prepareEditorFixture(run, markerValue, "vscode")
        const user = join(markerValue, "User")
        mkdirSync(user, { mode: 0o700 })
        writeFileSync(
          join(user, "settings.json"),
          JSON.stringify({
            // Documented since 1.104: https://code.visualstudio.com/docs/copilot/setup
            "chat.disableAIFeatures": true,
            "workbench.startupEditor": "none",
            "workbench.welcomePage.experimentalOnboarding": false,
          }),
          { flag: "wx", mode: 0o600 },
        )
        for (const [, directory] of vscodeAdditionalStatePaths) {
          mkdirSync(join(run.directory, directory), { mode: 0o700 })
        }
      },
      args: (_script, markerValue) => {
        const directory = dirname(markerValue)
        return [
          "--new-window",
          "--user-data-dir",
          markerValue,
          "--extensions-dir",
          join(directory, "vscode-extensions"),
          ...vscodeAdditionalStatePaths.flatMap(([flag, path]) => [flag, join(directory, path)]),
          "--extensionDevelopmentPath",
          join(directory, "vscode-fixture"),
        ]
      },
    },
  },
  {
    name: "Warp",
    id: "warp",
    appPath: "/Applications/Warp.app",
    binaryPath: "", // Warp doesn't support direct command launch
    bundleId: "dev.warp.Warp-Stable",
  },
]

// ── Version detection ──

function getAppVersion(app: AppDef): string {
  const plistPath = join(app.appPath, "Contents", "Info.plist")
  // WezTerm's plist uses a placeholder; the same installed CLI supplies its measured build tag.
  const cliVersion = app.id === "wezterm"
  const source = cliVersion ? `${app.binaryPath} --version` : plistPath
  try {
    const raw = execFileSync(
      cliVersion ? app.binaryPath : "/usr/libexec/PlistBuddy",
      cliVersion ? ["--version"] : ["-c", "Print :CFBundleShortVersionString", plistPath],
      {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 262144,
      },
    ).trim()
    const version = cliVersion ? /^wezterm (\S+)$/.exec(raw)?.[1] : raw
    if (!version) {
      throw new Error(
        cliVersion
          ? `Expected "wezterm <version>", received ${JSON.stringify(raw)}`
          : "CFBundleShortVersionString is empty",
      )
    }
    return version
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`Cannot read ${app.name} version from ${source}: ${detail}`, { cause })
  }
}

// ── Launch terminal with serve daemon ──

export interface AppLaunch {
  proc: ChildProcess | null
  windowId?: number
  terminalWindow?: OwnedTerminalWindow
  identityPath?: string
  /** The run-scoped kitty instance group, and the detached launcher's retained stderr. */
  instanceGroup?: string
  launcherStderr?: string
  /** The cli-process launch record: the owner binary and the marker its live argv must still carry. */
  executablePath?: string
  marker?: ProcessMarker
  diagnosticOutput?: {
    stdoutPath: string
    stderrPath: string
    parentCloseErrors: string[]
  }
}

/** In-memory spawn input only: inherited environment must never be retained or logged. */
export interface PreparedCliLaunch {
  spawnPath: string
  args: string[]
  env: NodeJS.ProcessEnv
  recipeEnvKeys: string[]
  identityPath: string
  executablePath: string
  marker: ProcessMarker
}

/** Prepare the existing CLI recipe without writing the caller's command or starting a daemon. */
export function prepareCliLaunch(appId: string, run: ProbeRun): PreparedCliLaunch {
  const app = APPS.find((candidate) => candidate.id === appId)
  if (!app?.cliLaunch) {
    throw new Error(
      `No CLI launch recipe for ${appId}; known CLI app ids: ${APPS.filter((candidate) => candidate.cliLaunch)
        .map((candidate) => candidate.id)
        .join(", ")}`,
    )
  }
  const recipe = app.cliLaunch
  const marker = runScopedMarker({
    appName: app.name,
    runId: run.id,
    flag: recipe.markerFlag,
    value: recipe.markerValue(run),
  })
  recipe.prepare?.(run, marker.value)
  return {
    spawnPath: recipe.spawnPath,
    args: recipe.args(run.scriptPath, marker.value),
    env: { ...process.env, ...recipe.env },
    recipeEnvKeys: Object.keys(recipe.env ?? {}),
    identityPath: join(run.directory, "owner-tty.txt"),
    executablePath: recipe.executablePath,
    marker,
  }
}

/** Spawn once; GUI ownership is resolved separately after the caller's readiness handshake. */
export function launchPreparedCli(prepared: PreparedCliLaunch, diagnosticDirectory?: string): AppLaunch {
  const parentCloseErrors: string[] = []
  const closeParentFd = (fd: number): void => {
    try {
      closeSync(fd)
    } catch (cause) {
      parentCloseErrors.push(cause instanceof Error ? cause.message : String(cause))
    }
  }
  function throwWithCleanupErrors(primary: unknown): never {
    if (parentCloseErrors.length === 0) throw primary
    const cleanupErrors = parentCloseErrors.map((message) => new Error(message))
    throw new AggregateError(
      [primary, ...cleanupErrors],
      `CLI launch failed: ${primary instanceof Error ? primary.message : String(primary)}; parent descriptor close failed: ${parentCloseErrors.join("; ")}`,
      { cause: primary },
    )
  }

  const stdoutPath = diagnosticDirectory === undefined ? undefined : join(diagnosticDirectory, "app.stdout.log")
  const stderrPath = diagnosticDirectory === undefined ? undefined : join(diagnosticDirectory, "app.stderr.log")
  let stdoutFd: number | undefined
  let stderrFd: number | undefined
  if (stdoutPath !== undefined && stderrPath !== undefined) {
    try {
      stdoutFd = openSync(stdoutPath, "wx", 0o600)
      stderrFd = openSync(stderrPath, "wx", 0o600)
    } catch (primary) {
      if (stdoutFd !== undefined) closeParentFd(stdoutFd)
      throwWithCleanupErrors(primary)
    }
  }

  let child: ChildProcess
  try {
    child = spawn(
      prepared.spawnPath,
      prepared.args,
      stdoutFd === undefined || stderrFd === undefined
        ? { detached: true, stdio: "ignore", env: prepared.env }
        : { detached: true, stdio: ["ignore", stdoutFd, stderrFd], env: prepared.env },
    )
  } catch (primary) {
    if (stdoutFd !== undefined) closeParentFd(stdoutFd)
    if (stderrFd !== undefined) closeParentFd(stderrFd)
    throwWithCleanupErrors(primary)
  }
  child.unref()
  if (stdoutFd !== undefined) closeParentFd(stdoutFd)
  if (stderrFd !== undefined) closeParentFd(stderrFd)
  return {
    proc: child,
    identityPath: prepared.identityPath,
    executablePath: prepared.executablePath,
    marker: prepared.marker,
    ...(stdoutPath === undefined || stderrPath === undefined
      ? {}
      : { diagnosticOutput: { stdoutPath, stderrPath, parentCloseErrors } }),
  }
}

function launchWithServe(app: AppDef, run: ProbeRun): AppLaunch {
  const captureDirectory =
    app.cliLaunch?.capture === "artifact-directory" ? join(run.directory, "artifacts") : undefined
  const serveCmd = serveCommand(run, captureDirectory)
  const identityPath =
    app.id === "kitty"
      ? join(run.directory, "owner-identity.txt")
      : app.cliLaunch
        ? join(run.directory, "owner-tty.txt")
        : undefined
  const identityWrite =
    identityPath === undefined
      ? ""
      : app.cliLaunch
        ? `printf '%s\\n' "$(tty)" > ${shellQuote(identityPath)}\n`
        : `printf '%s\\n' "\${KITTY_WINDOW_ID:-}" "\${KITTY_PID:-}" "$(tty)" "\${TERM:-}" > ${shellQuote(identityPath)}\n`
  writeFileSync(run.scriptPath, `#!/bin/bash\n${identityWrite}${serveCmd}\n`, { flag: "wx", mode: 0o700 })

  if (app.cliLaunch) {
    // A CLI-launched GUI app owns its window, not the CLI shim: the shim may exit after handing the
    // launch to an already-running instance. The marker is what survives, so the owner is resolved
    // from it once the daemon has registered, never from this child handle.
    return launchPreparedCli(prepareCliLaunch(app.id, run))
  }

  if (app.id === "kitty" && existsSync(app.binaryPath)) {
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

export function stopLaunchedApp(app: Pick<AppDef, "name" | "id">, launch: AppLaunch): void {
  if (launch.terminalWindow) {
    closeOwnedTerminalWindow(launch.terminalWindow)
    return
  }
  // A cli-process launch whose owner was never resolved leaves only the CLI shim in hand. That shim is
  // not the window we launched, so there is nothing here we may signal — but a window may still be open
  // under that marker, so say which one rather than returning silently.
  if (launch.marker !== undefined) {
    console.error(
      `  WARNING: ${app.name} launched with the run-scoped marker ${launch.marker.flag} ${launch.marker.value} but its owner was never resolved; no process was signaled. A window may still be open — find the live process carrying that marker and close it.`,
    )
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
  /** The Darwin owner launch record's exact text, retained as collector.outerLaunch (#30518 D4.6). */
  outerLaunch?: string
}

async function probeDaemon(
  daemon: DaemonRegistration,
  options: ProbeOptions,
): Promise<{ summary: string; mode: "retained" | "admitted" | "pending-review" }> {
  const { appId, version, ownedWindow, outputDirectory, launcherStderr, outerLaunch } = options
  const appLaunch =
    ownedWindow.provider === "terminal-app" ? captureTerminalAppReceipt(ownedWindow, daemon.pid, version) : null
  assertOwnedTerminalWindow(ownedWindow, daemon.pid)
  // One owner claim per request, never two: Terminal.app sends its window assertion, while kitty and
  // cli-process send the shared process proof's own observables so the worker can re-verify them.
  const res = await requestDaemonProbe(
    daemon,
    ownedWindow.provider === "terminal-app"
      ? {
          terminalApp: {
            asserter: "terminfo-admin",
            launchRunId: daemon.runId,
            workerPid: daemon.pid,
            windowId: ownedWindow.windowId,
            tabTty: ownedWindow.tty,
            intendedVersion: version,
          },
        }
      : {
          process: processOwnerAssertion(ownedWindow, daemon.runId, daemon.pid, version),
        },
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
      ...(outerLaunch !== undefined && { "collector.outerLaunch": outerLaunch }),
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
  let mode: "retained" | "admitted" | "pending-review" = outputDirectory === undefined ? "admitted" : "retained"
  if (outputDirectory !== undefined) {
    const source = retainCollectedRun(run, retained.path, { kind: "app", id: appId, version }, outputDirectory)
    console.log(`  Retained private development run ${source}`)
  } else {
    const source = admitCollectedRun(run, retained.path, { kind: "app", id: appId, version })
    if (source.endsWith(".draft.json")) mode = "pending-review"
  }
  const aggregate = aggregateCurrentResults(
    run.results,
    run.results.map((result) => result.featureId),
  )
  return { summary: `${currentSupportedShare(aggregate)} · ${currentCoverageSentence(aggregate)}`, mode }
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

/**
 * Build the cli-process window record once, after the daemon registers. The owner is resolved from the
 * run-scoped marker at this single moment and recorded as the arm's pid; assert and close then read only
 * that pid, so a later handoff or a reused pid can never move the owner underneath the run.
 */
export function ownedCliProcessWindow(launch: AppLaunch): OwnedTerminalWindow | undefined {
  if (launch.marker === undefined || launch.executablePath === undefined || launch.identityPath === undefined) {
    return undefined
  }
  return resolveOwnedProcessByMarker({
    executablePath: launch.executablePath,
    marker: launch.marker,
    tty: recordedOwnerTty(readFileSync(launch.identityPath, "utf8")),
  })
}

/** A process-backed window's claim: the shared proof's observables, with kitty's instance group as its
 * marker. Terminal.app's window id is not part of it — the worker cannot check one. */
function processOwnerAssertion(
  window: Exclude<OwnedTerminalWindow, { provider: "terminal-app" }>,
  launchRunId: string,
  workerPid: number,
  intendedVersion: string,
): ProcessOwnerAssertion {
  const owned = window.provider === "kitty" ? kittyOwnedProcess(window) : window
  return {
    asserter: "terminfo-admin",
    launchRunId,
    workerPid,
    provider: window.provider,
    ownerPid: owned.ownerPid,
    executablePath: owned.executablePath,
    marker: owned.marker,
    tty: owned.tty,
    intendedVersion,
  }
}

/** sha256 of a file's exact bytes; an unreadable file is loud, never an empty digest. */
function fileSha256(path: string, what: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex")
  } catch (cause) {
    throw new Error(`${what} ${path} is unreadable: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/** D3: the owner's birth is one C-locale UTC `ps -o lstart=` line, read from the process the marker resolved. */
function processBirthSeconds(pid: number): number {
  return parseLstart(
    String(
      execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      }),
    ),
  )
}

/** Ghostty's update-check setting, read once and never written (D4.6). An absent key is a value. */
function ghosttyAutoUpdate(): {
  key: "SUEnableAutomaticChecks"
  value: "0" | "1" | "absent"
  plistPath: string
  plistSha256: string | null
} {
  const plistPath = join(homedir(), "Library", "Preferences", "com.mitchellh.ghostty.plist")
  const plistSha256 = existsSync(plistPath) ? fileSha256(plistPath, "Ghostty preferences") : null
  let value: "0" | "1" | "absent" = "absent"
  try {
    const read = String(
      execFileSync("/usr/bin/defaults", ["read", "com.mitchellh.ghostty", "SUEnableAutomaticChecks"], {
        encoding: "utf8",
      }),
    ).trim()
    if (read !== "0" && read !== "1") {
      throw new Error(`SUEnableAutomaticChecks read ${JSON.stringify(read)}, not 0 or 1`)
    }
    value = read
  } catch (cause) {
    // `defaults read` exits 1 with "does not exist" for an unset key; that exact refusal is the measured
    // absence. Any other exit 1 (unreadable plist, bad domain) is loud, never recorded as "absent"
    // (@cto 72e4b60b).
    const status = typeof cause === "object" && cause !== null ? (cause as { status?: unknown }).status : undefined
    const stderr = typeof cause === "object" && cause !== null ? (cause as { stderr?: unknown }).stderr : undefined
    if (status !== 1) throw cause
    if (typeof stderr !== "string" || !stderr.includes("does not exist")) throw cause
  }
  return { key: "SUEnableAutomaticChecks", value, plistPath, plistSha256 }
}

/**
 * The Darwin owner launch record (#30518 D4.6): measured here, by the side that resolved the owner
 * and wrote the run file, then serialised once as strict JSON. It is retained as
 * `collector.outerLaunch` and its source text is what a mux proof cites as receiptSha256.
 */
function measureOuterLaunchRecord(run: ProbeRun, launch: AppLaunch, ownerPid: number): string {
  if (launch.identityPath === undefined || launch.marker === undefined || launch.executablePath === undefined) {
    throw new Error("Darwin capture launch has no cli-process launch record (identity path, marker or owner binary)")
  }
  return serializeOuterLaunchRecord({
    launchRunId: run.id,
    executablePath: launch.executablePath,
    marker: launch.marker,
    identityFile: { path: launch.identityPath, sha256: fileSha256(launch.identityPath, "owner identity record") },
    outerTerminal: { pid: ownerPid, startedAtEpochSeconds: processBirthSeconds(ownerPid) },
    bootId: String(execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8" })).trim(),
    runFileSha256: fileSha256(launch.marker.value, "run file"),
    autoUpdate: ghosttyAutoUpdate(),
  })
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
    if (launch.terminalWindow === undefined && app.id !== "kitty" && launch.marker === undefined) {
      throw new Error(
        `${app.name} has no owned-window assertion; refusing to collect a run this probe cannot prove it launched`,
      )
    }
    console.log(`  Waiting for owned daemon...`)
    daemon = await findOwnedDaemon(run.id, DAEMON_DIR, app.id)
    if (!daemon) throw new Error("Owned daemon did not register within 30s")
    const ownedWindow =
      app.id === "kitty" ? ownedKittyWindow(app, launch) : (launch.terminalWindow ?? ownedCliProcessWindow(launch))
    if (ownedWindow === undefined) throw new Error(`${app.name} produced no owned window for this run`)
    launch.terminalWindow = ownedWindow
    const outerLaunch =
      app.cliLaunch?.capture === "artifact-directory"
        ? measureOuterLaunchRecord(
            run,
            launch,
            ownedWindow.provider === "cli-process" || ownedWindow.provider === "kitty"
              ? ownedWindow.provider === "kitty"
                ? ownedWindow.kittyPid
                : ownedWindow.ownerPid
              : (() => {
                  throw new Error(`${app.name} declares a capture route but its owned window has no process owner`)
                })(),
          )
        : undefined
    console.log(`  Probing on port ${daemon.registration.port}...`)
    const result = await probeDaemon(daemon.registration, {
      appId: app.id,
      version,
      ownedWindow,
      outputDirectory: opts.output,
      launcherStderr: launch.launcherStderr,
      outerLaunch,
    })
    console.log(`  ${result.summary} (${result.mode})`)
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
    if (outcome.success && cleanupErrors.length === 0) {
      try {
        removeProbeRun(run)
      } catch (err) {
        cleanupErrors.push(`script: ${String(err)}`)
      }
    } else {
      console.error(`  Retained private failed ${app.name} launch directory: ${run.directory}`)
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
    appsToRun = APPS.filter((app) => app.id.toLowerCase() === name || app.name.toLowerCase() === name)
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
