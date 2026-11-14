/**
 * @failure Terminal.app collector can persist an unreviewed run without its owned launch receipt or can close an unowned window on failure.
 * @level l1
 * @consumer App collector's private daemon and exclusive raw-run write.
 * @testonly none
 */
import { beforeEach, describe, expect, test, vi } from "vitest"
import { execFileSync, execSync, spawn, spawnSync } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import type { AppLaunchReceipt } from "@terminfo/probe-defs"
import {
  assertOwnedWindowAssertion,
  handleApp,
  launchPreparedCli,
  prepareCliLaunch,
  stopLaunchedApp,
  type AppLaunch,
} from "./app.ts"
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
import { launchIterm2Window, resolveIterm2Window } from "./iterm2-launch.ts"
import {
  assertOwnedTerminalWindow,
  closeOwnedTerminalWindow,
  parseKittyIdentity,
  recordedOwnerTty,
  resolveOwnedProcessByMarker,
} from "../../terminfo.dev/src/terminal-app-window.ts"
import { runScopedMarker } from "../../terminfo.dev/src/owned-process.ts"
import { CURSOR_APPLICATION_USER_STORAGE_KEY, CURSOR_BUNDLE_PINS } from "./cursor-onboarding.ts"
import { DatabaseSync } from "node:sqlite"
import { verifyTerminalIdentity } from "../../terminfo.dev/src/identity-guard.ts"
import { placeCollectedRun } from "../corpus-placement.ts"
import * as collectedRun from "./collected-run.ts"

vi.mock("../corpus-placement.ts", () => ({ placeCollectedRun: vi.fn() }))
vi.mock("../../terminfo.dev/src/serve.ts", () => ({ getTrustedSuiteReceipt: () => ({ manifest: {} }) }))

vi.mock("node:fs", () => ({
  closeSync: vi.fn(),
  existsSync: vi.fn(() => true),
  lstatSync: vi.fn(() => ({})),
  realpathSync: vi.fn((path: string) => path),
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
  execFileSync: vi.fn((file, args) => {
    const binary = String(file)
    // D3/D4.6 measurements the owner launch record reads on a Darwin host.
    if (binary === "/bin/ps") return "Thu Oct 22 14:20:06 2026\n"
    if (binary === "/usr/sbin/sysctl") return "a1b2c3d4-1111-2222-3333-444455556666\n"
    if (binary === "/usr/bin/defaults") return "0\n"
    return binary.endsWith("/wezterm") && args[0] === "--version" ? "wezterm 2.15\n" : "2.15\n"
  }),
  execSync: vi.fn(() => "2.15\n"),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
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
vi.mock("./iterm2-launch.ts", () => ({ launchIterm2Window: vi.fn(), resolveIterm2Window: vi.fn() }))
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
  // Default collection requires authoring-checkout replies before retention.
  vi.mocked(spawnSync).mockImplementation((file, args = []) => {
    const replies: Record<string, string> = {
      "git rev-parse HEAD": "a".repeat(40),
      "git symbolic-ref --quiet --short HEAD": "task/fixture",
      "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main",
    }
    const command = [file, ...args].join(" ")
    const stdout = replies[command]
    if (stdout === undefined) throw new Error(`Unexpected fixture command: ${command}`)
    return { pid: 1, status: 0, signal: null, stdout, stderr: "", output: [null, stdout, ""] }
  })
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
    kind: "captured",
    path: "/private/http-responses/digest",
    sha256: "d".repeat(64),
    run: {
      source: { kind: "live" },
      schemaVersion: 4,
      intendedSubject: { kind: "term", id: "terminal-app", version: "2.15" },
      runId: "private-run",
      origin: { kind: "collector" },
      subject: {
        kind: "term",
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
          status: "probe-todo",
          attempt: { scope: "none" },
          tests: [],
          reason: "Required test missing",
        },
      ],
    },
  })
  vi.mocked(captureTerminalAppReceipt).mockReturnValue({ receipt, trace: { daemonTty: "/dev/ttys003" } })
  vi.mocked(saveDaemonProbeRun).mockReturnValue("/raw/terminal-app.json")
  vi.mocked(placeCollectedRun).mockReturnValue("/corpus/terminal-app.json")
  vi.mocked(stopOwnedDaemon).mockResolvedValue()
  vi.mocked(closeOwnedTerminalWindow).mockReturnValue(
    JSON.stringify({ windowId: 14, tty: "/dev/ttys003", status: 0, stdout: "0\n", stderr: "", remaining: 0 }),
  )
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

test("the owned-window admission passes an iTerm2 sole-instance launch, with no live app", () => {
  expect(() =>
    assertOwnedWindowAssertion({ name: "iTerm2", id: "iterm2" }, {
      proc: null,
      identityPath: "/private/run/owner-tty.txt",
      iterm2: { tty: "/dev/ttys009", beforeWindowIds: [1] },
    } as AppLaunch),
  ).not.toThrow()
})

test("the owned-window admission refuses a launch carrying no proof, by the same sentence", () => {
  expect(() => assertOwnedWindowAssertion({ name: "iTerm2", id: "iterm2" }, { proc: null } as AppLaunch)).toThrow(
    "iTerm2 has no owned-window assertion; refusing to collect a run this probe cannot prove it launched",
  )
})

test("Kitty text collection owns a run-local socket and removes it with its one window", async () => {
  vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stderr: "" } as ReturnType<typeof spawnSync>)
  vi.mocked(parseKittyIdentity).mockReturnValue({
    windowId: 7,
    kittyPid: 777,
    tty: "/dev/ttys009",
    term: "xterm-kitty",
  })
  await handleApp("kitty", {})
  const [binary, args] = vi.mocked(spawnSync).mock.calls[0]!
  expect(captureTerminalAppReceipt).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "kitty", kittyPid: 777 }),
    555,
    "2.15",
    [binary, ...args!],
  )
  expect(spawnSync).toHaveBeenCalledWith(
    "/Applications/kitty.app/Contents/MacOS/kitty",
    [
      "--detach",
      "--instance-group",
      "terminfo-private-run",
      "-1",
      "-o",
      "allow_remote_control=socket-only",
      "--listen-on",
      "unix:/private/run/kitty-private-run.sock",
      "--",
      "/bin/bash",
      "/private/run/serve.sh",
    ],
    { encoding: "utf8", timeout: 15_000 },
  )
  expect(vi.mocked(writeFileSync).mock.calls.find(([path]) => path === "/private/run/serve.sh")?.[1]).toContain(
    "TERMINFO_CAPTURE_DIRECTORY='/private/run/artifacts'",
  )
  expect(requestDaemonProbe).toHaveBeenCalledWith(
    registration,
    expect.objectContaining({ process: expect.objectContaining({ provider: "kitty", ownerPid: 777 }) }),
    undefined,
  )
  expect(closeOwnedTerminalWindow).toHaveBeenCalledWith(expect.objectContaining({ provider: "kitty", windowId: 7 }))
  expect(removeProbeRun).toHaveBeenCalledWith({
    id: "private-run",
    directory: "/private/run",
    scriptPath: "/private/run/serve.sh",
  })
})

test("a selected probe list reaches the daemon as its exact ids", async () => {
  vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stderr: "" } as ReturnType<typeof spawnSync>)
  vi.mocked(parseKittyIdentity).mockReturnValue({
    windowId: 7,
    kittyPid: 777,
    tty: "/dev/ttys009",
    term: "xterm-kitty",
  })
  await handleApp("kitty", { probeIds: ["cursor.mode", "kitty.graphics-protocol"] })
  expect(requestDaemonProbe).toHaveBeenCalledWith(
    registration,
    expect.objectContaining({ process: expect.objectContaining({ provider: "kitty" }) }),
    ["cursor.mode", "kitty.graphics-protocol"],
  )
})

test("an omitted selection sends no ids to the daemon", async () => {
  vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stderr: "" } as ReturnType<typeof spawnSync>)
  vi.mocked(parseKittyIdentity).mockReturnValue({
    windowId: 7,
    kittyPid: 777,
    tty: "/dev/ttys009",
    term: "xterm-kitty",
  })
  await handleApp("kitty", {})
  expect(requestDaemonProbe).toHaveBeenCalledWith(
    registration,
    expect.objectContaining({ process: expect.objectContaining({ provider: "kitty" }) }),
    undefined,
  )
})

test("an owned iTerm2 launch is collected on its sole-instance proof, then closed by its recorded pid", async () => {
  const launch = {
    executablePath: "/Applications/iTerm.app/Contents/MacOS/iTerm2",
    preflightAtEpochSeconds: 1794489720,
    beforeWindowIds: [10],
    appleScriptWindowId: 3,
    tty: "/dev/ttys009",
  }
  const owned = {
    provider: "iterm2" as const,
    windowId: 41,
    tty: "/dev/ttys009",
    ownerPid: 900,
    executablePath: launch.executablePath,
    startedAtEpochSeconds: 1794489721,
  }
  vi.mocked(launchIterm2Window).mockReturnValue(launch)
  vi.mocked(resolveIterm2Window).mockReturnValue(owned)
  vi.mocked(closeOwnedTerminalWindow).mockReturnValue(undefined)
  await handleApp("iterm2", {})
  expect(launchIterm2Window).toHaveBeenCalledWith("/private/run/serve.sh", launch.executablePath)
  const script = String(vi.mocked(writeFileSync).mock.calls.find(([path]) => path === "/private/run/serve.sh")?.[1])
  expect(script).toContain(`printf '%s\\n' "$(tty)" > '/private/run/owner-tty.txt'`)
  expect(script).toContain("TERMINFO_CAPTURE_DIRECTORY='/private/run/artifacts'")
  expect(resolveIterm2Window).toHaveBeenCalledWith(launch, "/dev/ttys009")
  expect(assertOwnedTerminalWindow).toHaveBeenCalledWith(owned, 555)
  expect(requestDaemonProbe).toHaveBeenCalledWith(
    registration,
    {
      process: {
        asserter: "terminfo-admin",
        launchRunId: "private-run",
        workerPid: 555,
        provider: "iterm2",
        ownerPid: 900,
        executablePath: launch.executablePath,
        basis: { kind: "sole-instance", preflightAbsent: true },
        tty: "/dev/ttys009",
        windowId: 41,
        intendedVersion: "2.15",
      },
    },
    undefined,
  )
  expect(closeOwnedTerminalWindow).toHaveBeenCalledWith(owned)
  // The one Apple event is the launch; no osascript close follows it.
  expect(vi.mocked(execFileSync).mock.calls.some(([file]) => file === "osascript")).toBe(false)
  expect(removeProbeRun).toHaveBeenCalled()
})

describe("WezTerm cli-process arm", () => {
  const ownedWindow = {
    provider: "cli-process" as const,
    ownerPid: 777,
    tty: "/dev/ttys009",
    executablePath: "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui",
    marker: { flag: "--config-file", value: "/private/run/wezterm-private-run.lua" },
  }

  // 34076: the hand operation must use the real app lifetime without entering collection.
  // Existing tests exercise collection, so none detects a diagnostic accidentally grading a run.
  test("hand-read retains one own-pane snapshot and closes its fresh fixture without collecting", async () => {
    vi.mocked(realpathSync).mockImplementation((path) =>
      String(path).replace("/Applications/WezTerm.app", "/private/VerifiedWezTerm.app"),
    )
    vi.mocked(existsSync).mockImplementation((path) => !String(path).endsWith("hand-read.json"))
    vi.mocked(resolveOwnedProcessByMarker).mockReturnValue(ownedWindow)
    vi.mocked(readFileSync).mockImplementation((path) =>
      String(path).endsWith("wezterm-hand-binding.txt")
        ? "private-run\n/private/run/wezterm.sock\n4\n"
        : "/dev/ttys009\n",
    )
    const stdout = '[{"pane_id":4,"cwd":"file:///private/app-reported"}]\n'
    const previous = vi.mocked(spawnSync).getMockImplementation()!
    vi.mocked(spawnSync).mockImplementation((file, args, options) => {
      if (String(file).endsWith("/wezterm") && args?.includes("list")) {
        return { pid: 8, status: 0, signal: null, stdout, stderr: "", output: [null, stdout, ""] }
      }
      return previous(file, args, options)
    })

    const retain = vi.spyOn(collectedRun, "retainCollectedRun").mockReturnValue("/private/unwanted-collection.json")
    try {
      await handleApp("wezterm", { handRead: true, output: "/private/hand" })

      expect(spawn).toHaveBeenCalledTimes(1)
      expect(requestDaemonProbe).not.toHaveBeenCalled()
      expect(retain).not.toHaveBeenCalled()
      expect(readRetainedDaemonProbeResponse).not.toHaveBeenCalled()
      expect(placeCollectedRun).not.toHaveBeenCalled()
      const reads = vi.mocked(spawnSync).mock.calls.filter((call) => call[1]?.includes("list"))
      expect(reads).toHaveLength(1)
      expect(reads[0]?.[0]).toBe("/private/VerifiedWezTerm.app/Contents/MacOS/wezterm")
      expect(reads[0]?.[1]).toEqual([
        "--config-file",
        "/private/run/wezterm-private-run.lua",
        "cli",
        "--no-auto-start",
        "list",
        "--format",
        "json",
      ])
      expect(reads[0]?.[2]?.env?.WEZTERM_UNIX_SOCKET).toBe("/private/run/wezterm.sock")
      expect(reads[0]?.[2]?.env?.WEZTERM_PANE).toBe("4")
      expect(stopOwnedDaemon).toHaveBeenCalledTimes(1)
      expect(closeOwnedTerminalWindow).toHaveBeenCalledExactlyOnceWith(ownedWindow)
      const saved = vi.mocked(writeFileSync).mock.calls.find((call) => String(call[0]).endsWith("hand-read.json"))
      expect(saved).toBeDefined()
      const diagnostic = JSON.parse(String(saved![1]))
      expect(diagnostic).toHaveProperty("bundle.cliPath", reads[0]?.[0])
      expect(diagnostic).toMatchObject({
        primaryFailure: null,
        read: { stdout, pane: { pane_id: 4, cwd: "file:///private/app-reported" } },
        cleanup: { errors: [] },
      })
      expect(diagnostic).not.toHaveProperty("results")
      expect(JSON.stringify(diagnostic)).not.toContain('"featureId"')
      expect(JSON.stringify(diagnostic)).not.toContain('"grade"')
    } finally {
      retain.mockRestore()
    }
  })

  test("hand-read refuses another app before creating a fixture", async () => {
    await expect(handleApp("ghostty", { handRead: true, output: "/private/hand" })).rejects.toThrow(/WezTerm/)
    expect(createProbeRun).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  // Each row breaks a different boundary of the one hand operation. The old collection
  // journeys cannot detect a wrong socket/pane or a lost primary error in this mode.
  test.each<{
    name: string
    binding?: string
    stdout?: string
    status?: number
    cleanupFailure?: boolean
    ownerFailure?: boolean
    message: RegExp
  }>([
    { name: "missing socket", binding: "private-run\n\n4\n", message: /launch binding/ },
    { name: "stale run", binding: "other-run\n/private/run/wezterm.sock\n4\n", message: /launch binding/ },
    { name: "foreign pane", stdout: '[{"pane_id":9,"cwd":"file:///foreign"}]', message: /0 candidates/ },
    { name: "ambiguous pane", stdout: '[{"pane_id":4,"cwd":"a"},{"pane_id":4,"cwd":"b"}]', message: /2 candidates/ },
    { name: "malformed JSON", stdout: "not-json", message: /invalid JSON/ },
    { name: "CLI failure", status: 2, message: /exit 2/ },
    { name: "read and close failure", status: 2, cleanupFailure: true, message: /exit 2/ },
    // 34076: a cleanup-only failure must not be mislabeled as a primary read failure in CLI JSON.
    { name: "close failure only", cleanupFailure: true, message: /close failed/ },
    { name: "unresolved owner", ownerFailure: true, message: /ambiguous owner/ },
  ])("hand-read preserves $name and only closes an acquired owner", async (fault) => {
    vi.mocked(existsSync).mockImplementation((path) => !String(path).endsWith("hand-read.json"))
    vi.mocked(readFileSync).mockImplementation((path) =>
      String(path).endsWith("wezterm-hand-binding.txt")
        ? (fault.binding ?? "private-run\n/private/run/wezterm.sock\n4\n")
        : "/dev/ttys009\n",
    )
    if (fault.ownerFailure) {
      vi.mocked(resolveOwnedProcessByMarker).mockImplementation(() => {
        throw new Error("ambiguous owner")
      })
    } else vi.mocked(resolveOwnedProcessByMarker).mockReturnValue(ownedWindow)
    if (fault.cleanupFailure) {
      vi.mocked(closeOwnedTerminalWindow).mockImplementation(() => {
        throw new Error("close failed")
      })
    }
    const previous = vi.mocked(spawnSync).getMockImplementation()!
    vi.mocked(spawnSync).mockImplementation((file, args, options) => {
      if (String(file).endsWith("/wezterm") && args?.includes("list")) {
        const stdout = fault.stdout ?? '[{"pane_id":4,"cwd":"file:///private/own"}]'
        return {
          pid: 8,
          status: fault.status ?? 0,
          signal: null,
          stdout,
          stderr: "diagnostic stderr",
          output: [null, stdout, "diagnostic stderr"],
        }
      }
      return previous(file, args, options)
    })
    const summaryLog =
      fault.name === "close failure only" ? vi.spyOn(console, "log").mockImplementation(() => {}) : undefined
    try {
      await expect(handleApp("wezterm", { handRead: true, output: "/private/hand" })).rejects.toThrow(fault.message)
      expect(requestDaemonProbe).not.toHaveBeenCalled()
      expect(placeCollectedRun).not.toHaveBeenCalled()
      expect(stopOwnedDaemon).toHaveBeenCalledTimes(1)
      expect(closeOwnedTerminalWindow).toHaveBeenCalledTimes(fault.ownerFailure ? 0 : 1)
      const saved = vi.mocked(writeFileSync).mock.calls.find((call) => String(call[0]).endsWith("hand-read.json"))
      expect(saved).toBeDefined()
      const diagnostic: unknown = JSON.parse(String(saved![1]))
      expect(diagnostic).toMatchObject({ primaryFailure: summaryLog ? null : expect.stringMatching(fault.message) })
      if (summaryLog) {
        expect(summaryLog).toHaveBeenCalledExactlyOnceWith(expect.any(String))
        const summary: unknown = JSON.parse(String(summaryLog.mock.calls[0]?.[0]))
        expect(summary).toEqual({
          kind: "app-hand-read",
          receipt: "/private/hand/hand-read.json",
          error: expect.stringMatching(/close failed/),
        })
        expect(summary).not.toHaveProperty("primaryFailure")
      }
      expect(diagnostic).toMatchObject({
        cleanup: {
          errors: fault.cleanupFailure || fault.ownerFailure ? expect.arrayContaining([expect.any(String)]) : [],
        },
      })
    } finally {
      summaryLog?.mockRestore()
    }
  })

  test("launches through the CLI with the run-scoped config marker and owns the GUI process", async () => {
    vi.mocked(resolveOwnedProcessByMarker).mockReturnValue(ownedWindow)
    await handleApp("wezterm", {})
    const [binary, args] = vi.mocked(spawn).mock.calls[0]!
    expect(captureTerminalAppReceipt).toHaveBeenCalledWith(ownedWindow, 555, "2.15", [binary, ...args!])
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
    // Compare argv separately: a mismatch must never dump the inherited spawn environment.
    const call = vi.mocked(spawn).mock.calls[0]
    expect(call?.[0]).toBe("/Applications/WezTerm.app/Contents/MacOS/wezterm")
    expect(call?.[1]).toEqual([
      "--config-file",
      "/private/run/wezterm-private-run.lua",
      "start",
      "--always-new-process",
      "--",
      "/bin/bash",
      "-p",
      "/private/run/serve.sh",
    ])
    expect(call?.[2]?.detached).toBe(true)
    expect(call?.[2]?.stdio).toBe("ignore")
    expect(call?.[2]?.env !== undefined).toBe(true)
    expect(findOwnedDaemon).toHaveBeenCalledWith("private-run", expect.any(String), "wezterm")
    expect(resolveOwnedProcessByMarker).toHaveBeenCalledWith({
      executablePath: "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui",
      marker: { flag: "--config-file", value: "/private/run/wezterm-private-run.lua" },
      tty: "/dev/ttys009",
    })
    expect(recordedOwnerTty).toHaveBeenCalledWith("/dev/ttys009\n")
    expect(requestDaemonProbe).toHaveBeenCalledWith(
      registration,
      {
        process: {
          asserter: "terminfo-admin",
          launchRunId: "private-run",
          workerPid: 555,
          provider: "cli-process",
          ownerPid: 777,
          executablePath: "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui",
          basis: { kind: "marker", marker: { flag: "--config-file", value: "/private/run/wezterm-private-run.lua" } },
          tty: "/dev/ttys009",
          intendedVersion: "2.15",
        },
      },
      undefined,
    )
    expect(closeOwnedTerminalWindow).toHaveBeenCalledWith(ownedWindow)
  })

  test("retains a measured unsupported-signature reason without inventing a receipt", async () => {
    vi.mocked(resolveOwnedProcessByMarker).mockReturnValue(ownedWindow)
    vi.mocked(captureTerminalAppReceipt).mockReturnValueOnce({
      trace: { argvAbsentReason: "not Developer ID", codesignDetailsRaw: "Identifier=fixture" },
    })
    await handleApp("wezterm", {})
    const saved = vi.mocked(saveDaemonProbeRun).mock.calls[0]![0]
    expect(saved.origin).toEqual({ kind: "collector" })
    expect(saved.rawReplies["collector.appLaunchTrace"]).toBe(
      JSON.stringify({ argvAbsentReason: "not Developer ID", codesignDetailsRaw: "Identifier=fixture" }),
    )
  })

  // #34018 R2 (@dev/17 peer REVISE): the handoff and collision boundary, on the App owner's own
  // suite. A handed identity is one run's name, so it is checked for a live registration first and
  // then reaches the run construction unchanged; a selection that would have to reuse it, or a run
  // already registered under it, refuses before anything is launched or written.
  test("a handed run id is checked for a live daemon and reaches the run construction unchanged", async () => {
    const handed = "0123456789abcdef0123456789abcdef"
    vi.mocked(resolveOwnedProcessByMarker).mockReturnValue(ownedWindow)
    // A handed id is free (the single no-wait check passes) and the later launch wait still finds
    // the daemon it started, which is the only difference a handed id makes before launch.
    vi.mocked(findOwnedDaemon).mockImplementation(async (_id, _dir, _app, timeout) =>
      timeout === 0 ? null : ({ filepath: "/private/registration", registration } as never),
    )
    vi.mocked(createProbeRun).mockReturnValueOnce({
      id: handed,
      directory: "/private/run",
      scriptPath: "/private/run/serve.sh",
    })
    await handleApp("wezterm", { runId: handed })
    expect(findOwnedDaemon).toHaveBeenNthCalledWith(1, handed, expect.any(String), "wezterm", 0)
    expect(createProbeRun).toHaveBeenCalledWith(handed)
    // Direct local use keeps minting: no id handed in means no collision check and no id passed on.
    vi.mocked(createProbeRun).mockClear()
    vi.mocked(findOwnedDaemon).mockClear()
    await handleApp("wezterm", {})
    expect(createProbeRun).toHaveBeenCalledWith(undefined)
    expect(findOwnedDaemon).toHaveBeenCalledWith("private-run", expect.any(String), "wezterm")
    expect(vi.mocked(findOwnedDaemon).mock.calls.some((call) => call[3] === 0)).toBe(false)
  })

  test("refuses a handed id already registered by a live daemon, before any launch or write", async () => {
    const handed = "fedcba9876543210fedcba9876543210"
    vi.mocked(findOwnedDaemon).mockResolvedValueOnce({ filepath: "/private/registration", registration })
    await expect(handleApp("wezterm", { runId: handed })).rejects.toThrow(
      `run id ${handed} is already registered by a live daemon`,
    )
    expect(findOwnedDaemon).toHaveBeenCalledWith(handed, expect.any(String), "wezterm", 0)
    expect(createProbeRun).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(writeFileSync).not.toHaveBeenCalled()
  })

  test("refuses a handed id across a multi-app selection before any run starts", async () => {
    const handed = "00112233445566778899aabbccddeeff"
    await expect(handleApp(undefined, { all: true, runId: handed })).rejects.toThrow(
      /--run-id names one run and \d+ apps would run/,
    )
    expect(createProbeRun).not.toHaveBeenCalled()
    expect(findOwnedDaemon).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
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
    const [binary, args] = vi.mocked(spawn).mock.calls[0]!
    expect(captureTerminalAppReceipt).toHaveBeenCalledWith(ownedWindow, 555, "2.15", [binary, ...args!])
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
    expect(requestDaemonProbe).toHaveBeenCalledWith(
      registration,
      {
        process: {
          asserter: "terminfo-admin",
          launchRunId: "private-run",
          workerPid: 555,
          provider: "cli-process",
          ownerPid: 777,
          executablePath: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
          basis: { kind: "marker", marker: { flag: "--config-file", value: "/private/run/ghostty-private-run" } },
          tty: "/dev/ttys009",
          intendedVersion: "2.15",
        },
      },
      undefined,
    )
    expect(closeOwnedTerminalWindow).toHaveBeenCalledWith(ownedWindow)
    // D4.6: the owner launch record is measured once and retained as the reply a mux proof cites.
    const retained = vi.mocked(saveDaemonProbeRun).mock.calls[0]?.[0] as { rawReplies?: Record<string, string> }
    const record = retained.rawReplies?.["collector.outerLaunch"]
    expect(record).toBeDefined()
    expect(JSON.parse(String(record))).toMatchObject({
      launchRunId: "private-run",
      executablePath: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
      marker: { flag: "--config-file", value: "/private/run/ghostty-private-run" },
      outerTerminal: { pid: 777, startedAtEpochSeconds: 1792678806 },
      bootId: "a1b2c3d4-1111-2222-3333-444455556666",
      autoUpdate: { key: "SUEnableAutomaticChecks", value: "0", plistSha256: expect.any(String) },
    })
    expect(record).toBe(JSON.stringify(JSON.parse(String(record))))
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
    expect(captureTerminalAppReceipt).toHaveBeenCalledWith(ownedWindow, 555, "2.15", [spawnPath, ...args!])
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
        "update.mode": "none",
        "chat.disableAIFeatures": true,
        "workbench.startupEditor": "none",
        "workbench.welcomePage.experimentalOnboarding": false,
        "workbench.panel.opensMaximized": "always",
      })
      expect(DatabaseSync).not.toHaveBeenCalled()
    } else {
      // Cursor's updater is Disabled before any check under update.mode "none", so no update toast.
      expect(settings?.[2]).toEqual({ flag: "wx", mode: 0o600 })
      expect(JSON.parse(String(settings?.[1]))).toEqual({
        "update.mode": "none",
        "workbench.panel.opensMaximized": "always",
      })
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
    const terminalJson =
      '{"name":"terminfo-private-run","shellPath":"/bin/bash","shellArgs":["-p","/private/run/serve.sh"],"cwd":"/private/run"}'
    const vscodeFixture = `const vscode = require("vscode");
exports.activate = (context) => {
  const terminal = vscode.window.createTerminal(${terminalJson});
  context.subscriptions.push(terminal);
  terminal.show();
};
`
    const cursorFixture = `const vscode = require("vscode");
exports.activate = async (context) => {
  await vscode.commands.executeCommand("workbench.action.closePanel");
  await vscode.commands.executeCommand("workbench.action.toggleMaximizedPanel");
  const terminal = vscode.window.createTerminal(${terminalJson});
  context.subscriptions.push(terminal);
  terminal.show();
};
`
    expect(script?.[1]).toBe(prefix === "cursor" ? cursorFixture : vscodeFixture)
    const terminal = { show: vi.fn(), dispose: vi.fn() }
    const createTerminal = vi.fn(() => terminal)
    const commands: string[] = []
    const executeCommand = vi.fn(async (command: string) => {
      commands.push(command)
    })
    const exported: { activate?: (context: { subscriptions: unknown[] }) => void | Promise<void> } = {}
    runInNewContext(String(script?.[1]), {
      exports: exported,
      require: (id: string) => {
        if (id !== "vscode") throw new Error(`Unexpected fixture import: ${id}`)
        return { commands: { executeCommand }, window: { createTerminal } }
      },
    })
    const subscriptions: unknown[] = []
    expect(typeof exported.activate).toBe("function")
    await exported.activate!({ subscriptions })
    if (prefix === "cursor") {
      expect(commands).toEqual(["workbench.action.closePanel", "workbench.action.toggleMaximizedPanel"])
      expect(executeCommand.mock.invocationCallOrder[1]).toBeLessThan(createTerminal.mock.invocationCallOrder[0]!)
      const rejectedCreate = vi.fn(() => terminal)
      const rejected: { activate?: (context: { subscriptions: unknown[] }) => Promise<void> } = {}
      runInNewContext(String(script?.[1]), {
        exports: rejected,
        require: (id: string) => {
          if (id !== "vscode") throw new Error(`Unexpected fixture import: ${id}`)
          return {
            commands: {
              executeCommand: async () => {
                throw new Error("panel command failed")
              },
            },
            window: { createTerminal: rejectedCreate },
          }
        },
      })
      await expect(rejected.activate!({ subscriptions: [] })).rejects.toThrow("panel command failed")
      expect(rejectedCreate).not.toHaveBeenCalled()
    }
    expect(createTerminal).toHaveBeenCalledWith({
      name: "terminfo-private-run",
      shellPath: "/bin/bash",
      shellArgs: ["-p", "/private/run/serve.sh"],
      cwd: "/private/run",
    })
    expect(terminal.show).toHaveBeenCalledOnce()
    expect(subscriptions).toEqual([terminal])
    expect(requestDaemonProbe).toHaveBeenCalledWith(
      registration,
      {
        process: expect.objectContaining({
          ownerPid: 778,
          executablePath: ownedWindow.executablePath,
          basis: { kind: "marker", marker: ownedWindow.marker },
        }),
      },
      undefined,
    )
    expect(closeOwnedTerminalWindow).toHaveBeenCalledWith(ownedWindow)
  },
)

describe("Terminal.app app collection", () => {
  test("attaches measured receipt and trace before the single exclusive raw write", async () => {
    await handleApp("terminal-app", {})
    expect(findOwnedDaemon).toHaveBeenCalledWith("private-run", expect.any(String), "terminal-app")
    expect(captureTerminalAppReceipt).toHaveBeenCalledWith(window, 555, "2.15")
    expect(assertOwnedTerminalWindow).toHaveBeenCalledWith(window, 555)
    expect(requestDaemonProbe).toHaveBeenCalledWith(
      registration,
      {
        terminalApp: {
          asserter: "terminfo-admin",
          launchRunId: "private-run",
          workerPid: 555,
          windowId: 14,
          tabTty: "/dev/ttys003",
          intendedVersion: "2.15",
        },
      },
      undefined,
    )
    const requestOrder = vi.mocked(requestDaemonProbe).mock.invocationCallOrder[0]!
    expect(vi.mocked(captureTerminalAppReceipt).mock.invocationCallOrder[0]).toBeLessThan(requestOrder)
    expect(vi.mocked(assertOwnedTerminalWindow).mock.invocationCallOrder[0]).toBeLessThan(requestOrder)
    expect(vi.mocked(readRetainedDaemonProbeResponse).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(saveDaemonProbeRun).mock.invocationCallOrder[0]!,
    )
    expect(saveDaemonProbeRun).toHaveBeenCalledOnce()
    expect(vi.mocked(saveDaemonProbeRun).mock.calls[0]?.[1]).toBe("/private/http-responses")
    expect(placeCollectedRun).toHaveBeenCalledWith("/raw/terminal-app.json", {})
    expect(vi.mocked(saveDaemonProbeRun).mock.calls[0]?.[0]).toMatchObject({
      origin: { kind: "collector", appLaunch: receipt },
      rawReplies: {
        "collector.httpResponseSha256": "d".repeat(64),
        "collector.appLaunchTrace": JSON.stringify({ daemonTty: "/dev/ttys003" }),
      },
    })
    expect(stopOwnedDaemon).toHaveBeenCalledOnce()
    expect(closeOwnedTerminalWindow).toHaveBeenCalledWith(window)
    expect(vi.mocked(readRetainedDaemonProbeResponse).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(stopOwnedDaemon).mock.invocationCallOrder[0]!,
    )
    expect(vi.mocked(stopOwnedDaemon).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(closeOwnedTerminalWindow).mock.invocationCallOrder[0]!,
    )
    expect(vi.mocked(closeOwnedTerminalWindow).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(saveDaemonProbeRun).mock.invocationCallOrder[0]!,
    )
    expect(closeOwnedTerminalWindow).toHaveBeenCalledOnce()
    expect(vi.mocked(saveDaemonProbeRun).mock.calls[0]?.[0].rawReplies["collector.windowDisposal"]).toContain(
      '"remaining":0',
    )
    const script = vi.mocked(writeFileSync).mock.calls.find(([path]) => path === "/private/run/serve.sh")?.[1]
    expect(script).toContain("TERMINFO_CAPTURE_DIRECTORY='/private/run/artifacts'")
    expect(script).toContain("2> '/private/run/worker.stderr.log'")
    expect(removeProbeRun).toHaveBeenCalledOnce()
  })

  test.each(["daemon startup", "daemon stop", "owned close"])(
    "retains the private launch directory after %s failure",
    async (failure) => {
      if (failure === "daemon startup") vi.mocked(findOwnedDaemon).mockResolvedValueOnce(null)
      else if (failure === "daemon stop") {
        vi.mocked(stopOwnedDaemon).mockRejectedValueOnce(new Error("daemon stop failed"))
      } else {
        vi.mocked(closeOwnedTerminalWindow).mockImplementationOnce(() => {
          throw new Error("owned close failed")
        })
      }
      const error = vi.spyOn(console, "error").mockImplementation(() => {})
      try {
        await expect(handleApp("terminal-app", {})).rejects.toThrow(
          failure === "daemon startup"
            ? /Owned daemon did not register/
            : failure === "daemon stop"
              ? /daemon stop failed/
              : /owned close failed/,
        )
        expect(saveDaemonProbeRun).not.toHaveBeenCalled()
        expect(closeOwnedTerminalWindow).toHaveBeenCalledOnce()
        expect(stopOwnedDaemon).toHaveBeenCalledTimes(failure === "daemon startup" ? 0 : 1)
        expect(writeFileSync).toHaveBeenCalledWith("/private/run/collection-error.json", expect.any(String), {
          flag: "wx",
          mode: 0o600,
        })
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

  test("a placement refusal retains the negative identity trace privately and still cleans up", async () => {
    vi.mocked(verifyTerminalIdentity).mockReturnValueOnce({
      checked: true,
      ok: false,
      reason: "measured reply differs",
    })
    vi.mocked(placeCollectedRun).mockImplementationOnce(() => {
      throw new Error("/raw/terminal-app.json: identity-replies-mismatch")
    })
    await expect(handleApp("terminal-app", {})).rejects.toThrow(/identity-replies-mismatch/)
    expect(vi.mocked(saveDaemonProbeRun).mock.calls[0]?.[0].rawReplies["collector.identityCheck"]).toBe(
      JSON.stringify({ checked: true, ok: false, reason: "measured reply differs" }),
    )
    expect(saveDaemonProbeRun).toHaveBeenCalledOnce()
    expect(vi.mocked(saveDaemonProbeRun).mock.calls[0]?.[1]).toBe("/private/http-responses")
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
