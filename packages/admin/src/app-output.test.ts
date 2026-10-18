/**
 * @failure probe app --output admits a run it was told to retain, or reports the wrong mode in its
 * success line, so a private development run is silently promoted or mislabeled.
 * @level l1
 * @consumer The private development route the collection pass runs for an owned macOS app.
 * @testonly none
 */
import { beforeEach, describe, expect, test, vi } from "vitest"
import type { AppLaunchReceipt } from "@terminfo/probe-defs"
import { handleApp } from "./app.ts"
import { admitCollectedRun, retainCollectedRun } from "./admit-collected-run.ts"
import { captureTerminalAppReceipt, launchTerminalWindow } from "./terminal-app-receipt.ts"
import {
  createProbeRun,
  findOwnedDaemon,
  readRetainedDaemonProbeResponse,
  removeProbeRun,
  requestDaemonProbe,
  stopOwnedDaemon,
} from "../../terminfo.dev/src/daemon-client.ts"
import {
  assertOwnedTerminalWindow,
  closeOwnedTerminalWindow,
  parseKittyIdentity,
} from "../../terminfo.dev/src/terminal-app-window.ts"
import { verifyTerminalIdentity } from "../../terminfo.dev/src/identity-guard.ts"

vi.mock("node:fs", () => ({ existsSync: vi.fn(() => true), writeFileSync: vi.fn(), readFileSync: vi.fn(() => "") }))
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => "2.15\n"),
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
vi.mock("./terminal-app-receipt.ts", () => ({
  captureTerminalAppReceipt: vi.fn(),
  launchTerminalWindow: vi.fn(),
}))
vi.mock("../../terminfo.dev/src/terminal-app-window.ts", () => ({
  assertOwnedTerminalWindow: vi.fn(),
  closeOwnedTerminalWindow: vi.fn(),
  parseKittyIdentity: vi.fn(),
}))
vi.mock("./admit-collected-run.ts", () => ({
  admitCollectedRun: vi.fn(),
  retainCollectedRun: vi.fn(() => "/private/out/terminal-app.json"),
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
      schemaVersion: 2,
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
      suiteComplete: false,
      sourceRevision: "source",
      measuredAt: "2026-09-28T00:00:00.000Z",
      rawReplies: { "collector.httpResponseSha256": "d".repeat(64) },
      assertions: [],
      screenshotRefs: [],
      observations: [],
      ungradedDiagnostics: {},
    },
  })
  vi.mocked(captureTerminalAppReceipt).mockReturnValue({ receipt, trace: { daemonTty: "/dev/ttys003" } })
  vi.mocked(stopOwnedDaemon).mockResolvedValue()
})

describe("probe app --output", () => {
  test("retains the run and says so, without admitting it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    await handleApp("terminal-app", { output: "/private/out" })
    expect(retainCollectedRun).toHaveBeenCalledOnce()
    expect(retainCollectedRun).toHaveBeenCalledWith(
      expect.anything(),
      "/private/http-responses/digest",
      expect.anything(),
      "/private/out",
    )
    expect(admitCollectedRun).not.toHaveBeenCalled()
    const lines = log.mock.calls.map((call) => String(call[0]))
    log.mockRestore()
    expect(lines).toContain("  0/0 explicit observations (retained)")
    expect(assertOwnedTerminalWindow).toHaveBeenCalledWith(window, 555)
  })

  test("without --output the same run still admits and says so", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    await handleApp("terminal-app", {})
    expect(admitCollectedRun).toHaveBeenCalledOnce()
    expect(retainCollectedRun).not.toHaveBeenCalled()
    const lines = log.mock.calls.map((call) => String(call[0]))
    log.mockRestore()
    expect(lines).toContain("  0/0 explicit observations (admitted)")
  })
})

describe("kitty owned launch", () => {
  beforeEach(() => {
    vi.mocked(parseKittyIdentity).mockReturnValue({
      windowId: 1,
      kittyPid: 900,
      tty: "/dev/ttys004",
      term: "xterm-kitty",
    })
    vi.mocked(findOwnedDaemon).mockResolvedValue({
      filepath: "/private/registration",
      registration: { ...registration, terminal: "kitty" },
    })
  })

  test("launches detached, sends no Terminal.app owner claim, and records the owned pid", async () => {
    const spawn = vi.mocked(await import("node:child_process")).spawnSync
    spawn.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never)
    await handleApp("kitty", { output: "/private/out" })
    expect(spawn).toHaveBeenCalledWith(
      "/Applications/kitty.app/Contents/MacOS/kitty",
      ["--detach", "--instance-group", "terminfo-private-run", "-1", "--", "/bin/bash", "/private/run/serve.sh"],
      expect.anything(),
    )
    expect(requestDaemonProbe).toHaveBeenCalledWith(expect.anything(), undefined)
    expect(assertOwnedTerminalWindow).toHaveBeenCalledWith(
      {
        provider: "kitty",
        windowId: 1,
        tty: "/dev/ttys004",
        kittyPid: 900,
        executablePath: "/Applications/kitty.app/Contents/MacOS/kitty",
        instanceGroup: "terminfo-private-run",
      },
      555,
    )
    const saved = vi.mocked(retainCollectedRun).mock.calls[0]?.[0] as unknown as {
      rawReplies: Record<string, string>
      origin: Record<string, unknown>
    }
    expect(saved.origin.appLaunch).toBeUndefined()
    expect(JSON.parse(saved.rawReplies["collector.kittyOwner"]!)).toEqual({
      windowId: 1,
      kittyPid: 900,
      tty: "/dev/ttys004",
      executablePath: "/Applications/kitty.app/Contents/MacOS/kitty",
      instanceGroup: "terminfo-private-run",
    })
    expect(JSON.parse(saved.rawReplies["collector.kittyLauncher"]!)).toEqual({ exitStatus: 0, stderr: "" })
    expect(closeOwnedTerminalWindow).toHaveBeenCalledWith(expect.objectContaining({ provider: "kitty" }))
  })
})

describe("unowned launch refusal", () => {
  test("an app the probe launched without an owned window is refused by name before any probe", async () => {
    const child = { unref: vi.fn(), kill: vi.fn() }
    vi.mocked((await import("node:child_process")).spawn).mockReturnValueOnce(child as never)
    await expect(handleApp("ghostty", {})).rejects.toThrow(
      /Ghostty has no owned-window assertion; refusing to collect a run this probe cannot prove it launched/,
    )
    expect(findOwnedDaemon).not.toHaveBeenCalled()
    expect(requestDaemonProbe).not.toHaveBeenCalled()
    expect(retainCollectedRun).not.toHaveBeenCalled()
  })
})
