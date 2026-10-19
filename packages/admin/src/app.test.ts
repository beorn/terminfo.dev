/**
 * @failure Terminal.app collector can persist an unreviewed run without its owned launch receipt or can close an unowned window on failure.
 * @level l1
 * @consumer App collector's private daemon and exclusive raw-run write.
 * @testonly none
 */
import { beforeEach, describe, expect, test, vi } from "vitest"
import { execFileSync, execSync, spawn } from "node:child_process"
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import type { AppLaunchReceipt } from "@terminfo/probe-defs"
import { handleApp, stopLaunchedApp, type AppLaunch } from "./app.ts"
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
import { verifyTerminalIdentity } from "../../terminfo.dev/src/identity-guard.ts"
import { planAdmission, admitRun } from "../../../scripts/admit-run.ts"

vi.mock("../../../scripts/admit-run.ts", () => ({ planAdmission: vi.fn(), admitRun: vi.fn() }))

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
  openSync: vi.fn((path: unknown) => (String(path).endsWith("launch.stdout.log") ? 71 : 72)),
  closeSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => "/dev/ttys009\n"),
  writeFileSync: vi.fn(),
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
  vi.mocked(spawn).mockReturnValue({ unref: vi.fn() } as unknown as ReturnType<typeof spawn>)
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
      { detached: true, stdio: ["ignore", 71, 72], env: expect.any(Object) },
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

// Cursor's recipe must deliver a terminal through the extension API without
// workspace tasks or input synthesis. The WezTerm case cannot exercise that fixture.
test("Cursor prepares a private editor fixture and forwards the existing GUI owner assertion", async () => {
  const ownedWindow = {
    provider: "cli-process" as const,
    ownerPid: 778,
    tty: "/dev/ttys009",
    executablePath: "/Applications/Cursor.app/Contents/MacOS/Cursor",
    marker: { flag: "--user-data-dir", value: "/private/run/cursor-private-run" },
  }
  vi.mocked(resolveOwnedProcessByMarker).mockReturnValue(ownedWindow)
  await handleApp("cursor", {})
  expect(spawn).toHaveBeenCalledWith(
    "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
    [
      "--new-window",
      "--verbose",
      "--user-data-dir",
      ownedWindow.marker.value,
      "--extensions-dir",
      "/private/run/cursor-extensions",
      "--extensionDevelopmentPath",
      "/private/run/cursor-fixture",
    ],
    {
      detached: true,
      stdio: ["ignore", 71, 72],
      env: expect.objectContaining({ CURSOR_CLI_BLOCK_CURSOR_AGENT: "true" }),
    },
  )
  expect(openSync).toHaveBeenCalledWith("/private/run/launch.stdout.log", "wx", 0o600)
  expect(openSync).toHaveBeenCalledWith("/private/run/launch.stderr.log", "wx", 0o600)
  expect(closeSync).toHaveBeenCalledWith(71)
  expect(closeSync).toHaveBeenCalledWith(72)
  expect(mkdirSync).toHaveBeenCalledWith("/private/run/cursor-fixture", { mode: 0o700 })
  expect(resolveOwnedProcessByMarker).toHaveBeenCalledWith({
    executablePath: ownedWindow.executablePath,
    marker: ownedWindow.marker,
    tty: ownedWindow.tty,
  })
  const writes = vi.mocked(writeFileSync).mock.calls
  expect(writes.every(([path]) => String(path).startsWith("/private/run/"))).toBe(true)
  const manifest = writes.find(([path]) => String(path).endsWith("cursor-fixture/package.json"))
  expect(JSON.parse(String(manifest?.[1]))).toMatchObject({
    main: "./extension.cjs",
    activationEvents: ["onStartupFinished"],
  })
  const script = writes.find(([path]) => String(path).endsWith("cursor-fixture/extension.cjs"))
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
})

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

  test.each(["daemon startup", "owned close", "CLI launch"])(
    "retains the private launch directory after %s failure",
    async (failure) => {
      if (failure === "daemon startup") vi.mocked(findOwnedDaemon).mockResolvedValueOnce(null)
      else if (failure === "CLI launch") {
        vi.mocked(spawn).mockImplementationOnce(() => {
          throw new Error("CLI launch failed")
        })
      } else {
        vi.mocked(closeOwnedTerminalWindow).mockImplementationOnce(() => {
          throw new Error("owned close failed")
        })
      }
      const error = vi.spyOn(console, "error").mockImplementation(() => {})
      try {
        await expect(handleApp(failure === "CLI launch" ? "cursor" : "terminal-app", {})).rejects.toThrow(
          failure === "daemon startup" ? /Owned daemon did not register/ : new RegExp(`${failure} failed`),
        )
        if (failure === "CLI launch") {
          expect(closeSync).toHaveBeenCalledWith(71)
          expect(closeSync).toHaveBeenCalledWith(72)
        }
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
