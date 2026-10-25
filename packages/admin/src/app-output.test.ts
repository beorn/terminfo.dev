/**
 * @failure probe app --output admits a run it was told to retain, or reports the wrong mode in its
 * success line, so a private development run is silently promoted or mislabeled.
 * @level l1
 * @consumer The private development route the collection pass runs for an owned macOS app.
 * @testonly none
 */
import { beforeEach, describe, expect, test, vi } from "vitest"
import { ENVIRONMENT_GROUP_IDS, type AppLaunchReceipt, type CapabilityResult } from "@terminfo/probe-defs"
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

vi.mock("node:fs", () => ({
  closeSync: vi.fn(),
  existsSync: vi.fn(() => true),
  openSync: vi.fn(() => 100),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => ""),
}))
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
vi.mock("../../terminfo.dev/src/terminal-app-window.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../terminfo.dev/src/terminal-app-window.ts")>()),
  assertOwnedTerminalWindow: vi.fn(),
  closeOwnedTerminalWindow: vi.fn(),
  parseKittyIdentity: vi.fn(),
}))
vi.mock("./admit-collected-run.ts", () => ({
  admitCollectedRun: vi.fn(() => "/private/content/terminal-app.json"),
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

let results: CapabilityResult[]

beforeEach(() => {
  vi.resetAllMocks()
  results = [
    {
      featureId: "sgr.bold",
      status: "test-todo",
      attempt: { scope: "none" },
      checks: [],
      reason: "Required test missing",
    },
  ]
  vi.mocked(createProbeRun).mockReturnValue({
    id: "private-run",
    directory: "/private/run",
    scriptPath: "/private/run/serve-private-run.sh",
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
      results,
    },
  })
  vi.mocked(captureTerminalAppReceipt).mockReturnValue({ receipt, trace: { daemonTty: "/dev/ttys003" } })
  vi.mocked(stopOwnedDaemon).mockResolvedValue()
})

describe("probe app --output", () => {
  test.each([false, true])("retains the run without admitting it, environment catalogue: %s", async (environment) => {
    if (environment) {
      results.push(
        ...ENVIRONMENT_GROUP_IDS.map((featureId) => ({
          ...results[0]!,
          featureId,
        })),
      )
    }
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
    const clause = environment ? " · 9 environment groups manual by design (catalogue), ungraded" : ""
    expect(lines).toContain(
      `  Not measured yet · 0 Supported · 0 Unsupported · 0 Untestable · 1 TEST TODO · 0 TEST FAILURE${clause} (retained)`,
    )
    expect(assertOwnedTerminalWindow).toHaveBeenCalledWith(window, 555)
  })

  test("without --output the same run still admits and says so", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    await handleApp("terminal-app", {})
    expect(admitCollectedRun).toHaveBeenCalledOnce()
    expect(retainCollectedRun).not.toHaveBeenCalled()
    const lines = log.mock.calls.map((call) => String(call[0]))
    log.mockRestore()
    expect(lines).toContain(
      "  Not measured yet · 0 Supported · 0 Unsupported · 0 Untestable · 1 TEST TODO · 0 TEST FAILURE (admitted)",
    )
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

  test("launches detached, sends the shared process claim instead of a Terminal.app one, and records the owned pid", async () => {
    const spawn = vi.mocked(await import("node:child_process")).spawnSync
    spawn.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never)
    await handleApp("kitty", { output: "/private/out" })
    expect(spawn).toHaveBeenCalledWith(
      "/Applications/kitty.app/Contents/MacOS/kitty",
      [
        "--detach",
        "--instance-group",
        "terminfo-private-run",
        "-1",
        "--",
        "/bin/bash",
        "/private/run/serve-private-run.sh",
      ],
      expect.anything(),
    )
    const request = vi.mocked(requestDaemonProbe).mock.calls[0]?.[1]
    expect(request).toEqual({
      process: expect.objectContaining({
        asserter: "terminfo-admin",
        launchRunId: "private-run",
        workerPid: 555,
        provider: "kitty",
        ownerPid: 900,
        executablePath: "/Applications/kitty.app/Contents/MacOS/kitty",
        marker: { flag: "--instance-group", value: "terminfo-private-run" },
        tty: "/dev/ttys004",
      }),
    })
    expect(typeof (request as { process: { intendedVersion: unknown } }).process.intendedVersion).toBe("string")
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
  test("an app whose launched window cannot be proven owned is refused by name before any probe", async () => {
    const child = { unref: vi.fn(), kill: vi.fn() }
    vi.mocked((await import("node:child_process")).spawn).mockReturnValueOnce(child as never)
    // Ghostty now launches with a run-scoped marker, but this harness records no
    // owner TTY for it, so ownership can never be proven and collection refuses.
    await expect(handleApp("ghostty", {})).rejects.toThrow(
      /ghostty: cli-process launch recorded no TTY in its launched window; refusing to guess the owner's TTY/,
    )
    expect(requestDaemonProbe).not.toHaveBeenCalled()
    expect(retainCollectedRun).not.toHaveBeenCalled()
  })
})
