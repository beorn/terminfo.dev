/**
 * @failure Terminal.app collector can persist an unreviewed run without its owned launch receipt or can close an unowned window on failure.
 * @level l1
 * @consumer App collector's private daemon and exclusive raw-run write.
 * @testonly none
 */
import { beforeEach, describe, expect, test, vi } from "vitest"
import { execFileSync, execSync, spawn } from "node:child_process"
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import type { AppLaunchReceipt } from "@terminfo/probe-defs"
import { handleApp, launchPreparedCli, prepareCliLaunch, stopLaunchedApp, type AppLaunch } from "./app.ts"
import {
  createProbeRun,
  findOwnedDaemon,
  readRetainedDaemonProbeResponse,
  removeProbeRun,
  requestDaemonProbe,
  saveDaemonProbeRun,
  stopOwnedDaemon,
} from "../../terminfo.dev/src/daemon-client.ts"
import { captureTerminalAppReceipt, launchTerminalWindow } from "./terminal-app-receipt.ts"
import {
  assertOwnedTerminalWindow,
  closeOwnedTerminalWindow,
  recordedOwnerTty,
  resolveOwnedProcessByMarker,
} from "../../terminfo.dev/src/terminal-app-window.ts"
import { runScopedMarker } from "../../terminfo.dev/src/owned-process.ts"
import { CURSOR_APPLICATION_USER_STORAGE_KEY, CURSOR_BUNDLE_PINS } from "./cursor-onboarding.ts"
import { DatabaseSync } from "node:sqlite"
import { verifyTerminalIdentity } from "../../terminfo.dev/src/identity-guard.ts"
import { planAdmission, admitRun } from "../../../scripts/admit-run.ts"

vi.mock("../../../scripts/admit-run.ts", () => ({ planAdmission: vi.fn(), admitRun: vi.fn() }))

vi.mock("node:fs", () => ({
  closeSync: vi.fn(),
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  openSync: vi.fn(),
  readFileSync: vi.fn(() => "/dev/ttys009\n"),
  writeFileSync: vi.fn(),
}))
// Cursor's prepare seeds application storage; the real round trip lives in cursor-onboarding.test.ts.
const sqlite = vi.hoisted(() => ({ exec: vi.fn(), run: vi.fn(), close: vi.fn() }))
vi.mock("node:sqlite", () => ({
  DatabaseSync: vi.fn(function () {
    return { exec: sqlite.exec, prepare: () => ({ run: sqlite.run }), close: sqlite.close }
  }),
}))
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn((file, args) =>
    String(file).endsWith("/wezterm") && args[0] === "--version" ? "wezterm 2.15\n" : "2.15\n",
  ),
  execSync: vi.fn(() => "2.15\n"),
  spawn: vi.fn(),
}))
vi.mock("../versions.ts", () => ({
  sourceSuiteEnvironment: vi.fn(() => ({ TERMINFO_PROBE_HASH: "suite", TERMINFO_SOURCE_REVISION: "source" })),
}))
vi.mock("../../terminfo.dev/src/identity-guard.ts", () => ({
  verifyTerminalIdentity: vi.fn(() => ({ checked: true, ok: true })),
}))
vi.mock("../../terminfo.dev/src/daemon-client.ts", () => ({
  createProbeRun: vi.fn(),
  findOwnedDaemon: vi.fn(),
  readRetainedDaemonProbeResponse: vi.fn(),
  removeProbeRun: vi.fn(),
  requestDaemonProbe: vi.fn(),
  saveDaemonProbeRun: vi.fn(),
  stopOwnedDaemon: vi.fn(),
  shellQuote: vi.fn((text: string) => `'${text}'`),
}))
vi.mock("./terminal-app-receipt.ts", () => ({
  captureTerminalAppReceipt: vi.fn(),
  launchTerminalWindow: vi.fn(),
}))
vi.mock("../../terminfo.dev/src/terminal-app-window.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../terminfo.dev/src/terminal-app-window.ts")>()),
  assertOwnedTerminalWindow: vi.fn(),
  closeOwnedTerminalWindow: vi.fn(),
  parseKittyIdentity: vi.fn(),
  recordedOwnerTty: vi.fn((text: string) => text.trim()),
  resolveOwnedProcessByMarker: vi.fn(),
}))
vi.mock("../../terminfo.dev/src/owned-process.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../terminfo.dev/src/owned-process.ts")>()),
  runScopedMarker: vi.fn(({ flag, value }: { flag: string; value: string }) => ({ flag, value })),
}))

const window = { provider: "terminal-app" as const, windowId: 14, tty: "/dev/ttys003" }
const registration = {
  pid: 555,
  port: 1234,
  runId: "private-run",
  token: "secret",
  terminal: "terminal-app",
  terminalVersion: "2.15",
}
const receipt: AppLaunchReceipt = {
  bundlePath: "/System/Applications/Utilities/Terminal.app",
  executablePath: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
  executableSha256: "a".repeat(64),
  cfBundleShortVersionString: "2.15",
  cfBundleVersion: "470.2",
  sourceArtifact: {
    kind: "sealed-macos-system-volume",
    macOSBuild: "25G83",
    snapshotUUID: "C1602FFF-7F1F-48FE-B3AC-3A74675B4416",
    snapshotName: "com.apple.os.update-example",
    sealed: true,
    codeSignature: { identifier: "com.apple.Terminal", cdHash: "f".repeat(40), strictVerified: true },
  },
}

beforeEach(() => {
  vi.resetAllMocks()
  let nextDiagnosticFd = 100
  vi.mocked(openSync).mockImplementation(() => nextDiagnosticFd++)
  vi.mocked(createProbeRun).mockReturnValue({
    id: "private-run",
    directory: "/private/run",
    scriptPath: "/private/run/serve.sh",
  })
  vi.mocked(launchTerminalWindow).mockReturnValue(window)
  vi.mocked(findOwnedDaemon).mockResolvedValue({ filepath: "/private/registration", registration })
  vi.mocked(requestDaemonProbe).mockResolvedValue(new Response("{}"))
  vi.mocked(readRetainedDaemonProbeResponse).mockResolvedValue({
    path: "/private/http-responses/digest",
    sha256: "d".repeat(64),
    run: {
      schemaVersion: 3,
      intendedContext: { kind: "app", id: "terminal-app", version: "2.15" },
      runId: "private-run",
      origin: { kind: "collector" },
      target: {
        kind: "app",
        id: "terminal-app",
        version: "2.15",
        os: "macos",
        osVersion: "26.6.2",
        outerTerminal: null,
        mux: null,
        config: null,
        permissions: null,
      },
      identity: "unverified",
      suiteId: "suite",
      probeHash: "hash",
      sourceRevision: "source",
      measuredAt: "2026-09-28T00:00:00.000Z",
      rawReplies: { "collector.httpResponseSha256": "d".repeat(64) },
      assertions: [],
      screenshotRefs: [],
      results: [
        {
          featureId: "sgr.bold",
          status: "test-todo",
          attempt: { scope: "none" },
          checks: [],
          reason: "Required test missing",
        },
      ],
    },
  })
  vi.mocked(captureTerminalAppReceipt).mockReturnValue({ receipt, trace: { daemonTty: "/dev/ttys003" } })
  vi.mocked(saveDaemonProbeRun).mockReturnValue("/raw/terminal-app.json")
  vi.mocked(planAdmission).mockImplementation((source) => ({
    source,
    destination: "/admitted/terminal-app.json",
    probeHash: "hash",
    target: { kind: "app", id: "terminal-app", version: "2.15", os: "macos" },
    runId: "private-run",
  }))
  vi.mocked(stopOwnedDaemon).mockResolvedValue()
  vi.mocked(spawn).mockReturnValue({ unref: vi.fn() } as unknown as ReturnType<typeof spawn>)
  // Cursor's launch reads its installed bundle to prove its pinned launch quirks are still honoured.
  const shippedCursorBundle = CURSOR_BUNDLE_PINS.map((pin) => pin.substring).join(";")
  vi.mocked(readFileSync).mockImplementation((path) =>
    String(path).startsWith("/Applications/Cursor.app/Contents/Resources/") ? shippedCursorBundle : "/dev/ttys009\n",
  )
})

// The hosted caller needs recipe preparation without the local daemon. Existing handleApp
// journeys cannot detect a hosted implementation leaking inherited environment into fixtures.
test("hosted preparation keeps inherited secrets in spawn memory and leaves the command caller-owned", () => {
  const secret = "hosted-inherited-secret-sentinel"
  vi.stubEnv("TERMINFO_TEST_INHERITED_SECRET", secret)
  const log = vi.spyOn(console, "log").mockImplementation(() => {})
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const error = vi.spyOn(console, "error").mockImplementation(() => {})
  try {
    const run = { id: "private-run", directory: "/private/run", scriptPath: "/private/run/serve.sh" }
    const prepared = prepareCliLaunch("cursor", run)
    expect(spawn).not.toHaveBeenCalled()
    expect(vi.mocked(writeFileSync).mock.calls.some(([path]) => path === run.scriptPath)).toBe(false)
    const launched = launchPreparedCli(prepared)
    expect(launched.identityPath).toBe("/private/run/owner-tty.txt")
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(vi.mocked(spawn).mock.calls[0]?.[2]?.env?.TERMINFO_TEST_INHERITED_SECRET).toBe(secret)
    expect(findOwnedDaemon).not.toHaveBeenCalled()
    expect(requestDaemonProbe).not.toHaveBeenCalled()
    const retained = JSON.stringify({
      writes: vi.mocked(writeFileSync).mock.calls,
      log: log.mock.calls,
      warn: warn.mock.calls,
      error: error.mock.calls,
    })
    expect(retained).not.toContain(secret)
  } finally {
    vi.unstubAllEnvs()
    log.mockRestore()
    warn.mockRestore()
    error.mockRestore()
  }
})

describe("WezTerm cli-process arm", () => {
  const ownedWindow = {
    provider: "cli-process" as const,
    ownerPid: 777,
    tty: "/dev/ttys009",
    executablePath: "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui",
    marker: { flag: "--config-file", value: "/private/run/wezterm-private-run.lua" },
  }

  test("launches through the CLI with the run-scoped config marker and owns the GUI process", async () => {
    vi.mocked(resolveOwnedProcessByMarker).mockReturnValue(ownedWindow)
    await handleApp("wezterm", {})
    expect(writeFileSync).toHaveBeenCalledWith("/private/run/wezterm-private-run.lua", "return {}\n", {
      flag: "wx",
      mode: 0o600,
    })
    expect(runScopedMarker).toHaveBeenCalledWith({
      appName: "WezTerm",
      runId: "private-run",
      flag: "--config-file",
      value: "/private/run/wezterm-private-run.lua",
    })
    expect(spawn).toHaveBeenCalledWith(
      "/Applications/WezTerm.app/Contents/MacOS/wezterm",
      [
        "--config-file",
        "/private/run/wezterm-private-run.lua",
        "start",
        "--always-new-process",
        "--",
        "/bin/bash",
        "/private/run/serve.sh",
      ],
      { detached: true, stdio: "ignore", env: expect.any(Object) },
    )
    expect(findOwnedDaemon).toHaveBeenCalledWith("private-run", expect.any(String), "wezterm")
    expect(resolveOwnedProcessByMarker).toHaveBeenCalledWith({
      executablePath: "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui",
      marker: { flag: "--config-file", value: "/private/run/wezterm-private-run.lua" },
      tty: "/dev/ttys009",
    })
    expect(recordedOwnerTty).toHaveBeenCalledWith("/dev/ttys009\n")
    expect(requestDaemonProbe).toHaveBeenCalledWith(registration, {
      process: {
        asserter: "terminfo-admin",
        launchRunId: "private-run",
        workerPid: 555,
        provider: "cli-process",
        ownerPid: 777,
        executablePath: "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui",
        marker: { flag: "--config-file", value: "/private/run/wezterm-private-run.lua" },
        tty: "/dev/ttys009",
        intendedVersion: "2.15",
      },
    })
    expect(closeOwnedTerminalWindow).toHaveBeenCalledWith(ownedWindow)
  })
})

describe("Ghostty cli-process arm", () => {
  const ownedWindow = {
    provider: "cli-process" as const,
    ownerPid: 777,
    tty: "/dev/ttys009",
    executablePath: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
    marker: { flag: "--config-file", value: "/private/run/ghostty-private-run" },
  }

  test("launches through the binary with the run-scoped config marker and owns the GUI process", async () => {
    vi.mocked(resolveOwnedProcessByMarker).mockReturnValue(ownedWindow)
    // D2: the script carries the run id, as createProbeRun names it.
    vi.mocked(createProbeRun).mockReturnValue({
      id: "private-run",
      directory: "/private/run",
      scriptPath: "/private/run/serve-private-run.sh",
    })
    await handleApp("ghostty", {})
    expect(writeFileSync).toHaveBeenCalledWith(
      "/private/run/ghostty-private-run",
      "command = /private/run/serve-private-run.sh\nconfirm-close-surface = false\nquit-after-last-window-closed = true\nwindow-save-state = never\n",
      { flag: "wx", mode: 0o600 },
    )
    // D5: Ghostty's recipe is the one ruled capture route, so its collector gets the artifact directory.
    expect(writeFileSync).toHaveBeenCalledWith(
      "/private/run/serve-private-run.sh",
      expect.stringContaining("TERMINFO_CAPTURE_DIRECTORY='/private/run/artifacts'"),
      { flag: "wx", mode: 0o700 },
    )
    expect(runScopedMarker).toHaveBeenCalledWith({
      appName: "Ghostty",
      runId: "private-run",
      flag: "--config-file",
      value: "/private/run/ghostty-private-run",
    })
    expect(spawn).toHaveBeenCalledWith(
      "/Applications/Ghostty.app/Contents/MacOS/ghostty",
      ["--config-default-files=false", "--config-file=/private/run/ghostty-private-run"],
      { detached: true, stdio: "ignore", env: expect.any(Object) },
    )
    expect(openSync).not.toHaveBeenCalled()
    expect(closeSync).not.toHaveBeenCalled()
    expect(findOwnedDaemon).toHaveBeenCalledWith("private-run", expect.any(String), "ghostty")
    expect(resolveOwnedProcessByMarker).toHaveBeenCalledWith({
      executablePath: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
      marker: { flag: "--config-file", value: "/private/run/ghostty-private-run" },
      tty: "/dev/ttys009",
    })
    expect(requestDaemonProbe).toHaveBeenCalledWith(registration, {
      process: {
        asserter: "terminfo-admin",
        launchRunId: "private-run",
        workerPid: 555,
        provider: "cli-process",
        ownerPid: 777,
        executablePath: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
        marker: { flag: "--config-file", value: "/private/run/ghostty-private-run" },
        tty: "/dev/ttys009",
        intendedVersion: "2.15",
      },
    })
    expect(closeOwnedTerminalWindow).toHaveBeenCalledWith(ownedWindow)
  })

  // D2: the script reaches Ghostty only through the run file's unquoted `command` line, so a path that
  // is relative, belongs to another run or holds anything outside [A-Za-z0-9/._-] refuses by name.
  test.each([
    { name: "a relative path", scriptPath: "private-run/serve.sh" },
    { name: "another run's script", scriptPath: "/private/run/serve-other-run.sh" },
    { name: "a space", scriptPath: "/private/run/serve private-run.sh" },
  ])("refuses $name before writing the run file", ({ scriptPath }) => {
    expect(() => prepareCliLaunch("ghostty", { id: "private-run", directory: "/private/run", scriptPath })).toThrow(
      /^Ghostty script path .*; no launch$/,
    )
    expect(writeFileSync).not.toHaveBeenCalled()
  })

  test("returns the spawned child and records a failed first descriptor close while attempting both closes", () => {
    const child = { unref: vi.fn() }
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
    vi.mocked(openSync).mockReturnValueOnce(101).mockReturnValueOnce(102)
    vi.mocked(closeSync)
      .mockImplementationOnce(() => {
        throw new Error("stdout parent close failed")
      })
      .mockImplementationOnce(() => {})

    const prepared = prepareCliLaunch("ghostty", {
      id: "private-run",
      directory: "/private/run",
      scriptPath: "/private/run/serve-private-run.sh",
    })
    const launched = launchPreparedCli(prepared, "/private/run")

    expect(openSync).toHaveBeenNthCalledWith(1, "/private/run/app.stdout.log", "wx", 0o600)
    expect(openSync).toHaveBeenNthCalledWith(2, "/private/run/app.stderr.log", "wx", 0o600)
    expect(spawn).toHaveBeenCalledWith(prepared.spawnPath, prepared.args, {
      detached: true,
      stdio: ["ignore", 101, 102],
      env: prepared.env,
    })
    expect(closeSync).toHaveBeenNthCalledWith(1, 101)
    expect(closeSync).toHaveBeenNthCalledWith(2, 102)
    expect(launched).toMatchObject({
      proc: child,
      identityPath: prepared.identityPath,
      executablePath: prepared.executablePath,
      marker: prepared.marker,
      diagnosticOutput: {
        stdoutPath: "/private/run/app.stdout.log",
        stderrPath: "/private/run/app.stderr.log",
        parentCloseErrors: ["stdout parent close failed"],
      },
    })
  })

  test("does not spawn after a partial diagnostic-file open and preserves both open and close errors", () => {
    const openError = new Error("stderr open failed")
    const closeError = new Error("stdout parent close failed")
    vi.mocked(openSync)
      .mockReturnValueOnce(201)
      .mockImplementationOnce(() => {
        throw openError
      })
    vi.mocked(closeSync).mockImplementationOnce(() => {
      throw closeError
    })
    const prepared = prepareCliLaunch("ghostty", {
      id: "private-run",
      directory: "/private/run",
      scriptPath: "/private/run/serve-private-run.sh",
    })

    let failure: unknown
    try {
      launchPreparedCli(prepared, "/private/run")
    } catch (cause) {
      failure = cause
    }

    expect(spawn).not.toHaveBeenCalled()
    expect(closeSync).toHaveBeenCalledExactlyOnceWith(201)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors[0]).toBe(openError)
    expect((failure as AggregateError).errors[1]).toMatchObject({ message: closeError.message })
    expect((failure as Error & { cause?: unknown }).cause).toBe(openError)
  })

  test("preserves a synchronous spawn error and both descriptor-close outcomes", () => {
    const spawnError = new Error("spawn failed")
    const closeError = new Error("stdout parent close failed")
    vi.mocked(openSync).mockReturnValueOnce(301).mockReturnValueOnce(302)
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw spawnError
    })
    vi.mocked(closeSync)
      .mockImplementationOnce(() => {
        throw closeError
      })
      .mockImplementationOnce(() => {})
    const prepared = prepareCliLaunch("ghostty", {
      id: "private-run",
      directory: "/private/run",
      scriptPath: "/private/run/serve-private-run.sh",
    })

    let failure: unknown
    try {
      launchPreparedCli(prepared, "/private/run")
    } catch (cause) {
      failure = cause
    }

    expect(closeSync).toHaveBeenNthCalledWith(1, 301)
    expect(closeSync).toHaveBeenNthCalledWith(2, 302)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors[0]).toBe(spawnError)
    expect((failure as AggregateError).errors[1]).toMatchObject({ message: closeError.message })
    expect((failure as Error & { cause?: unknown }).cause).toBe(spawnError)
  })
})

// Editor recipes deliver a terminal through the extension API without workspace
// tasks or input synthesis. The canonical mixed-case VS Code id also exercises selection.
test.each([
  { input: "cursor", prefix: "cursor", appPath: "/Applications/Cursor.app", executable: "Cursor", helper: "cursor" },
  {
    input: "com.microsoft.VSCode",
    prefix: "vscode",
    appPath: "/Applications/Visual Studio Code.app",
    executable: "Code",
    helper: "code",
  },
])(
  "$input prepares a private editor fixture and forwards the GUI owner assertion",
  async ({ input, prefix, appPath, executable, helper }) => {
    const ownedWindow = {
      provider: "cli-process" as const,
      ownerPid: 778,
      tty: "/dev/ttys009",
      executablePath: `${appPath}/Contents/MacOS/${executable}`,
      marker: { flag: "--user-data-dir", value: `/private/run/${prefix}-private-run` },
    }
    vi.mocked(resolveOwnedProcessByMarker).mockReturnValue(ownedWindow)
    await handleApp(input, {})
    expect(spawn).toHaveBeenCalledTimes(1)
    const [spawnPath, args, options] = vi.mocked(spawn).mock.calls[0]!
    const bundleReads = vi
      .mocked(readFileSync)
      .mock.calls.flatMap(([path], index) =>
        String(path).startsWith(`${appPath}/Contents/Resources/`)
          ? [{ path: String(path), order: vi.mocked(readFileSync).mock.invocationCallOrder[index]! }]
          : [],
      )
    if (prefix === "cursor") {
      expect([...new Set(bundleReads.map(({ path }) => path))].sort()).toEqual(
        [...new Set(CURSOR_BUNDLE_PINS.map((pin) => `${appPath}/${pin.file}`))].sort(),
      )
      expect(bundleReads.every(({ order }) => order < vi.mocked(spawn).mock.invocationCallOrder[0]!)).toBe(true)
    } else {
      expect(bundleReads).toEqual([])
    }
    expect(spawnPath).toBe(`${appPath}/Contents/Resources/app/bin/${helper}`)
    expect(args).toEqual([
      "--new-window",
      ...(prefix === "cursor" ? ["--classic", "--skip-onboarding"] : []),
      "--user-data-dir",
      ownedWindow.marker.value,
      "--extensions-dir",
      `/private/run/${prefix}-extensions`,
      ...(prefix === "vscode"
        ? [
            "--shared-data-dir",
            "/private/run/vscode-shared",
            "--agent-plugins-dir",
            "/private/run/vscode-agent-plugins",
            "--agents-user-data-dir",
            "/private/run/vscode-agents-data",
            "--agents-extensions-dir",
            "/private/run/vscode-agents-extensions",
            "--crash-reporter-directory",
            "/private/run/vscode-crash",
          ]
        : []),
      "--extensionDevelopmentPath",
      `/private/run/${prefix}-fixture`,
    ])
    expect(options?.detached).toBe(true)
    expect(options?.stdio).toBe("ignore")
    const env = options?.env
    expect(env?.HOME).toBe(process.env.HOME)
    if (prefix === "cursor") expect(env?.CURSOR_CLI_BLOCK_CURSOR_AGENT).toBe("true")
    if (prefix === "vscode") {
      const cursorKeys = Object.keys(env ?? {})
        .filter((key) => key.startsWith("CURSOR_"))
        .sort()
      expect(cursorKeys).toEqual(
        Object.keys(process.env)
          .filter((key) => key.startsWith("CURSOR_"))
          .sort(),
      )
      expect(cursorKeys.filter((key) => env?.[key] !== process.env[key])).toEqual([])
    }
    const privateDirectories = [
      `${prefix}-private-run`,
      `${prefix}-extensions`,
      `${prefix}-fixture`,
      ...(prefix === "cursor" ? ["cursor-private-run/User", "cursor-private-run/User/globalStorage"] : []),
      ...(prefix === "vscode"
        ? [
            "vscode-private-run/User",
            "vscode-shared",
            "vscode-agent-plugins",
            "vscode-agents-data",
            "vscode-agents-extensions",
            "vscode-crash",
          ]
        : []),
    ]
    expect(vi.mocked(mkdirSync).mock.calls).toEqual(
      privateDirectories.map((directory) => [`/private/run/${directory}`, { mode: 0o700 }]),
    )
    expect(resolveOwnedProcessByMarker).toHaveBeenCalledWith({
      executablePath: ownedWindow.executablePath,
      marker: ownedWindow.marker,
      tty: ownedWindow.tty,
    })
    const writes = vi.mocked(writeFileSync).mock.calls
    expect(writes.every(([path]) => String(path).startsWith("/private/run/"))).toBe(true)
    const manifest = writes.find(([path]) => String(path).endsWith(`${prefix}-fixture/package.json`))
    expect(manifest?.[2]).toEqual({ flag: "wx", mode: 0o600 })
    expect(manifest?.[1]).toBe(
      JSON.stringify({
        name: `terminfo-${prefix}-private-run`,
        publisher: "terminfo",
        version: "0.0.0",
        engines: { vscode: "^1.74.0" },
        main: "./extension.cjs",
        activationEvents: ["onStartupFinished"],
      }),
    )
    const settings = writes.find(([path]) => String(path).endsWith(`${prefix}-private-run/User/settings.json`))
    if (prefix === "vscode") {
      expect(settings?.[2]).toEqual({ flag: "wx", mode: 0o600 })
      expect(JSON.parse(String(settings?.[1]))).toEqual({
        "chat.disableAIFeatures": true,
        "workbench.startupEditor": "none",
        "workbench.welcomePage.experimentalOnboarding": false,
      })
      expect(DatabaseSync).not.toHaveBeenCalled()
    } else {
      // Cursor's updater is Disabled before any check under update.mode "none", so no update toast.
      expect(settings?.[2]).toEqual({ flag: "wx", mode: 0o600 })
      expect(JSON.parse(String(settings?.[1]))).toEqual({ "update.mode": "none" })
      // Application storage records the command-line prompt as dismissed, so it never schedules.
      expect(DatabaseSync).toHaveBeenCalledWith("/private/run/cursor-private-run/User/globalStorage/state.vscdb")
      expect(sqlite.run).toHaveBeenCalledWith(
        CURSOR_APPLICATION_USER_STORAGE_KEY,
        JSON.stringify({ cmdLineHookState: { ignored: true, timesShown: 0 } }),
      )
      expect(sqlite.close).toHaveBeenCalledTimes(1)
      expect(sqlite.close.mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(spawn).mock.invocationCallOrder[0]!)
    }
    const script = writes.find(([path]) => String(path).endsWith(`${prefix}-fixture/extension.cjs`))
    expect(script?.[2]).toEqual({ flag: "wx", mode: 0o600 })
    expect(script?.[1]).toBe(`const vscode = require("vscode");
exports.activate = (context) => {
  const terminal = vscode.window.createTerminal({"name":"terminfo-private-run","shellPath":"/bin/bash","shellArgs":["/private/run/serve.sh"],"cwd":"/private/run"});
  context.subscriptions.push(terminal);
  terminal.show();
};
`)
    const terminal = { show: vi.fn(), dispose: vi.fn() }
    const createTerminal = vi.fn(() => terminal)
    const exported: { activate?: (context: { subscriptions: unknown[] }) => void } = {}
    runInNewContext(String(script?.[1]), {
      exports: exported,
      require: (id: string) => {
        if (id !== "vscode") throw new Error(`Unexpected fixture import: ${id}`)
        return { window: { createTerminal } }
      },
    })
    const subscriptions: unknown[] = []
    expect(typeof exported.activate).toBe("function")
    exported.activate!({ subscriptions })
    expect(createTerminal).toHaveBeenCalledWith({
      name: "terminfo-private-run",
      shellPath: "/bin/bash",
      shellArgs: ["/private/run/serve.sh"],
      cwd: "/private/run",
    })
    expect(terminal.show).toHaveBeenCalledOnce()
    expect(subscriptions).toEqual([terminal])
    expect(requestDaemonProbe).toHaveBeenCalledWith(registration, {
      process: expect.objectContaining({
        ownerPid: 778,
        executablePath: ownedWindow.executablePath,
        marker: ownedWindow.marker,
      }),
    })
    expect(closeOwnedTerminalWindow).toHaveBeenCalledWith(ownedWindow)
  },
)

describe("Terminal.app app collection", () => {
  test("attaches measured receipt and trace before the single exclusive raw write", async () => {
    await handleApp("terminal-app", {})
    expect(findOwnedDaemon).toHaveBeenCalledWith("private-run", expect.any(String), "terminal-app")
    expect(captureTerminalAppReceipt).toHaveBeenCalledWith(window, 555, "2.15")
    expect(assertOwnedTerminalWindow).toHaveBeenCalledWith(window, 555)
    expect(requestDaemonProbe).toHaveBeenCalledWith(registration, {
      terminalApp: {
        asserter: "terminfo-admin",
        launchRunId: "private-run",
        workerPid: 555,
        windowId: 14,
        tabTty: "/dev/ttys003",
        intendedVersion: "2.15",
      },
    })
    const requestOrder = vi.mocked(requestDaemonProbe).mock.invocationCallOrder[0]!
    expect(vi.mocked(captureTerminalAppReceipt).mock.invocationCallOrder[0]).toBeLessThan(requestOrder)
    expect(vi.mocked(assertOwnedTerminalWindow).mock.invocationCallOrder[0]).toBeLessThan(requestOrder)
    expect(vi.mocked(readRetainedDaemonProbeResponse).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(saveDaemonProbeRun).mock.invocationCallOrder[0]!,
    )
    expect(saveDaemonProbeRun).toHaveBeenCalledOnce()
    expect(vi.mocked(saveDaemonProbeRun).mock.calls[0]?.[1]).toBe("/private/http-responses")
    expect(planAdmission).toHaveBeenCalledWith("/raw/terminal-app.json")
    expect(admitRun).toHaveBeenCalledWith(vi.mocked(planAdmission).mock.results[0]!.value)
    expect(vi.mocked(saveDaemonProbeRun).mock.calls[0]?.[0]).toMatchObject({
      origin: { kind: "collector", appLaunch: receipt },
      rawReplies: {
        "collector.httpResponseSha256": "d".repeat(64),
        "collector.appLaunchTrace": JSON.stringify({ daemonTty: "/dev/ttys003" }),
      },
    })
    expect(stopOwnedDaemon).toHaveBeenCalledOnce()
    expect(closeOwnedTerminalWindow).toHaveBeenCalledWith(window)
    expect(removeProbeRun).toHaveBeenCalledOnce()
  })

  test.each(["daemon startup", "owned close"])(
    "retains the private launch directory after %s failure",
    async (failure) => {
      if (failure === "daemon startup") vi.mocked(findOwnedDaemon).mockResolvedValueOnce(null)
      else {
        vi.mocked(closeOwnedTerminalWindow).mockImplementationOnce(() => {
          throw new Error("owned close failed")
        })
      }
      const error = vi.spyOn(console, "error").mockImplementation(() => {})
      try {
        await expect(handleApp("terminal-app", {})).rejects.toThrow(
          failure === "daemon startup" ? /Owned daemon did not register/ : /owned close failed/,
        )
        expect(removeProbeRun).not.toHaveBeenCalled()
        expect(error.mock.calls.flat().join("\n")).toContain("/private/run")
      } finally {
        error.mockRestore()
      }
    },
  )

  test("a failed receipt refuses raw write and closes only the newly owned window", async () => {
    vi.mocked(captureTerminalAppReceipt).mockImplementationOnce(() => {
      throw new Error("unsealed snapshot")
    })
    await expect(handleApp("terminal-app", {})).rejects.toThrow(/unsealed snapshot/)
    expect(requestDaemonProbe).not.toHaveBeenCalled()
    expect(saveDaemonProbeRun).not.toHaveBeenCalled()
    expect(closeOwnedTerminalWindow).toHaveBeenCalledWith(window)
  })

  test("a refused window assertion prevents the probe request and raw write", async () => {
    vi.mocked(assertOwnedTerminalWindow).mockImplementationOnce(() => {
      throw new Error("owned Terminal tab TTY changed")
    })
    await expect(handleApp("terminal-app", {})).rejects.toThrow(/tab TTY changed/)
    expect(requestDaemonProbe).not.toHaveBeenCalled()
    expect(saveDaemonProbeRun).not.toHaveBeenCalled()
    expect(stopOwnedDaemon).toHaveBeenCalledOnce()
    expect(closeOwnedTerminalWindow).toHaveBeenCalledWith(window)
  })

  test("retention failure blocks the enriched save", async () => {
    vi.mocked(readRetainedDaemonProbeResponse).mockRejectedValueOnce(
      new Error("private response directory is permissive"),
    )
    await expect(handleApp("terminal-app", {})).rejects.toThrow(/private response directory/)
    expect(saveDaemonProbeRun).not.toHaveBeenCalled()
    expect(stopOwnedDaemon).toHaveBeenCalledOnce()
  })

  test("an admission refusal retains the negative identity trace privately and still cleans up", async () => {
    vi.mocked(verifyTerminalIdentity).mockReturnValueOnce({
      checked: true,
      ok: false,
      reason: "measured reply differs",
    })
    vi.mocked(planAdmission).mockImplementationOnce(() => {
      throw new Error("/raw/terminal-app.json: identity-replies-mismatch")
    })
    await expect(handleApp("terminal-app", {})).rejects.toThrow(/identity-replies-mismatch/)
    expect(vi.mocked(saveDaemonProbeRun).mock.calls[0]?.[0].rawReplies["collector.identityCheck"]).toBe(
      JSON.stringify({ checked: true, ok: false, reason: "measured reply differs" }),
    )
    expect(saveDaemonProbeRun).toHaveBeenCalledOnce()
    expect(vi.mocked(saveDaemonProbeRun).mock.calls[0]?.[1]).toBe("/private/http-responses")
    expect(admitRun).not.toHaveBeenCalled()
    expect(stopOwnedDaemon).toHaveBeenCalledOnce()
    expect(closeOwnedTerminalWindow).toHaveBeenCalledWith(window)
  })
})

describe("App version diagnostics", () => {
  // The native WezTerm plist is 0.1.0; its executable reports this build tag instead.
  // Listing and collection use the same private version producer.
  test.each(["wezterm 20240203-110809-5046fc22\n", "", "unexpected version text"])(
    "WezTerm version comes from its executable: %j",
    async (reply) => {
      const output = vi.spyOn(console, "log").mockImplementation(() => {})
      vi.mocked(execFileSync).mockImplementation((file, args = []) => {
        if (String(file).endsWith("/wezterm") && args[0] === "--version") return reply
        return String(args.at(-1)).includes("WezTerm.app") ? "0.1.0\n" : "2.15\n"
      })
      try {
        if (reply.startsWith("wezterm ")) {
          await handleApp(undefined, {})
          expect(output.mock.calls.map(([line]) => String(line)).find((line) => line.includes("WezTerm"))).toContain(
            "20240203-110809-5046fc22",
          )
        } else {
          await expect(handleApp(undefined, {})).rejects.toThrow(/WezTerm.*wezterm.*--version/)
        }
        expect(createProbeRun).not.toHaveBeenCalled()
      } finally {
        output.mockRestore()
      }
    },
  )

  test.each(["missing plist", "permission denied"])(
    "listing refuses %s instead of printing unknown",
    async (reason) => {
      const cause = new Error(reason)
      vi.mocked(execSync).mockImplementationOnce(() => {
        throw cause
      })
      vi.mocked(execFileSync).mockImplementationOnce(() => {
        throw cause
      })
      await expect(handleApp(undefined, {})).rejects.toMatchObject({
        message: expect.stringMatching(new RegExp(`Ghostty.*Info\\.plist.*${reason}`)),
        cause,
      })
    },
  )

  test("listing refuses an empty version instead of printing unknown", async () => {
    vi.mocked(execSync).mockReturnValueOnce(" \n")
    vi.mocked(execFileSync).mockReturnValueOnce(" \n")
    await expect(handleApp(undefined, {})).rejects.toThrow(/Ghostty.*Info\.plist.*empty/)
  })
})

describe("cli-process stop when the owner was never resolved", () => {
  test("keeps the shim unsignaled and names the marker that may still own a window", () => {
    const kill = vi.fn()
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      stopLaunchedApp(
        { name: "WezTerm", id: "wezterm" },
        {
          proc: { kill } as unknown as AppLaunch["proc"],
          marker: { flag: "--config-file", value: "/tmp/terminfo-0f3c9a7d/wezterm.lua" },
        },
      )
      expect(kill).not.toHaveBeenCalled()
      expect(error).toHaveBeenCalledTimes(1)
      const warning = String(error.mock.calls[0]?.[0])
      expect(warning).toContain("WezTerm")
      expect(warning).toContain("--config-file /tmp/terminfo-0f3c9a7d/wezterm.lua")
      expect(warning).toContain("never resolved")
    } finally {
      error.mockRestore()
    }
  })
})
