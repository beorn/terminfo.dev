/**
 * @failure Terminal.app collector can persist an unreviewed run without its owned launch receipt or can close an unowned window on failure.
 * @level l1
 * @consumer App collector's private daemon and exclusive raw-run write.
 * @testonly none
 */
import { beforeEach, describe, expect, test, vi } from "vitest"
import { execFileSync, execSync } from "node:child_process"
import type { AppLaunchReceipt } from "@terminfo/probe-defs"
import { handleApp } from "./app.ts"
import {
  createProbeRun,
  findOwnedDaemon,
  readRetainedDaemonProbeResponse,
  removeProbeRun,
  requestDaemonProbe,
  saveDaemonProbeRun,
  stopOwnedDaemon,
} from "terminfo.dev/src/daemon-client.ts"
import { captureTerminalAppReceipt, launchTerminalWindow } from "./terminal-app-receipt.ts"
import { assertOwnedTerminalWindow, closeOwnedTerminalWindow } from "terminfo.dev/src/terminal-app-window.ts"
import { verifyTerminalIdentity } from "terminfo.dev/src/identity-guard.ts"
import { planAdmission, admitRun } from "../../../scripts/admit-run.ts"

vi.mock("../../../scripts/admit-run.ts", () => ({ planAdmission: vi.fn(), admitRun: vi.fn() }))

vi.mock("node:fs", () => ({ existsSync: vi.fn(() => true), writeFileSync: vi.fn() }))
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => "2.15\n"),
  execSync: vi.fn(() => "2.15\n"),
  spawn: vi.fn(),
}))
vi.mock("../versions.ts", () => ({
  sourceSuiteEnvironment: vi.fn(() => ({ TERMINFO_PROBE_HASH: "suite", TERMINFO_SOURCE_REVISION: "source" })),
}))
vi.mock("terminfo.dev/src/identity-guard.ts", () => ({
  verifyTerminalIdentity: vi.fn(() => ({ checked: true, ok: true })),
}))
vi.mock("terminfo.dev/src/daemon-client.ts", () => ({
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
vi.mock("terminfo.dev/src/terminal-app-window.ts", () => ({
  assertOwnedTerminalWindow: vi.fn(),
  closeOwnedTerminalWindow: vi.fn(),
}))

const window = { windowId: 14, tty: "/dev/ttys003" }
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
  vi.mocked(saveDaemonProbeRun).mockReturnValue("/raw/terminal-app.json")
  vi.mocked(planAdmission).mockImplementation((source) => ({
    source,
    destination: "/admitted/terminal-app.json",
    probeHash: "hash",
    target: { kind: "app", id: "terminal-app", version: "2.15", os: "macos" },
    runId: "private-run",
  }))
  vi.mocked(stopOwnedDaemon).mockResolvedValue()
})

describe("Terminal.app app collection", () => {
  test("attaches measured receipt and trace before the single exclusive raw write", async () => {
    await handleApp("terminal-app", {})
    expect(findOwnedDaemon).toHaveBeenCalledWith("private-run", expect.any(String), "terminal-app")
    expect(captureTerminalAppReceipt).toHaveBeenCalledWith(window, 555, "2.15")
    expect(assertOwnedTerminalWindow).toHaveBeenCalledWith(window)
    expect(requestDaemonProbe).toHaveBeenCalledWith(registration, {
      asserter: "terminfo-admin",
      launchRunId: "private-run",
      workerPid: 555,
      windowId: 14,
      tabTty: "/dev/ttys003",
      intendedVersion: "2.15",
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

// The real app caller must keep local iTerm windows and preferences separate from hosted startup.
describe("iTerm app launch ownership", () => {
  test("closes only the returned local window and writes no startup preference", async () => {
    vi.mocked(execFileSync).mockReturnValueOnce("3.6.11\n").mockReturnValueOnce("27\n")
    await handleApp("iterm2", {})
    const calls = vi.mocked(execFileSync).mock.calls
    expect(calls.map(([file]) => file)).toEqual(["/usr/libexec/PlistBuddy", "osascript", "osascript"])
    expect(calls[1]?.[1]).toEqual([
      "-e",
      expect.stringContaining('create window with default profile command "/private/run/serve.sh"'),
    ])
    expect(calls[2]?.[1]).toEqual(["-e", 'tell application "iTerm" to close (first window whose id is 27)'])
    expect(stopOwnedDaemon).toHaveBeenCalledOnce()
  })

  test("an invalid launch id aborts without closing another window", async () => {
    vi.mocked(execFileSync).mockReturnValueOnce("3.6.11\n").mockReturnValueOnce("not-a-window\n")
    await expect(handleApp("iterm2", {})).rejects.toThrow("iTerm did not return the launched window ID")
    expect(vi.mocked(execFileSync).mock.calls.map(([file]) => file)).toEqual(["/usr/libexec/PlistBuddy", "osascript"])
    expect(findOwnedDaemon).not.toHaveBeenCalled()
  })
})
