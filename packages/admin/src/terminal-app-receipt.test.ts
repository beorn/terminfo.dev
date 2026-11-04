/**
 * @failure A Terminal.app capture can borrow a preexisting window, wrong TTY, or unsealed OS receipt and appear verified.
 * @level l1
 * @consumer App collector's owned Terminal.app launch and immutable raw run.
 * @testonly none
 */
import { beforeEach, describe, expect, test, vi } from "vitest"
import { spawnSync } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"
import { createHash } from "node:crypto"
import { captureTerminalAppReceipt, launchTerminalWindow } from "./terminal-app-receipt.ts"
import { closeOwnedTerminalWindow } from "../../terminfo.dev/src/terminal-app-window.ts"

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }))
vi.mock("node:fs", () => ({ readFileSync: vi.fn(), realpathSync: vi.fn() }))

const bundlePath = "/System/Applications/Utilities/Terminal.app"
const executablePath = `${bundlePath}/Contents/MacOS/Terminal`
const executableBytes = Buffer.from("owned Terminal executable fixture")

function commandOutput(
  command: string,
  args: readonly string[],
  options: { snapshotSealed?: boolean; apps?: number; daemonTty?: string; bundlePath?: string; pid?: number } = {},
): string {
  if (command === "ps" && args.includes("tty=")) return `${options.daemonTty ?? "ttys003"}\n`
  if (command === "ps" && args.includes("comm=")) return `${executablePath}\n`
  if (command === "osascript" && args.includes("JavaScript")) {
    const appBundlePath = options.bundlePath ?? bundlePath
    const app = {
      pid: options.pid ?? 77,
      bundlePath: appBundlePath,
      executablePath: `${appBundlePath}/Contents/MacOS/Terminal`,
    }
    return JSON.stringify(Array.from({ length: options.apps ?? 1 }, () => app))
  }
  if (command === "/usr/libexec/PlistBuddy") {
    const key = args.join(" ")
    if (key.includes("CFBundleIdentifier")) return "com.apple.Terminal\n"
    if (key.includes("CFBundleShortVersionString")) return "2.15\n"
    if (key.includes("CFBundleVersion")) return "470.2\n"
  }
  if (command === "codesign" && args.includes("-dv")) {
    return "Identifier=com.apple.Terminal\nCDHash=df446fa448104498f44f6cbce28099ed286eecc2\n"
  }
  if (command === "codesign" && args.includes("--verify")) return ""
  if (command === "sw_vers") return "25G83\n"
  if (command === "diskutil") {
    return `APFS Snapshot Name: com.apple.os.update-example\nAPFS Snapshot UUID: C1602FFF-7F1F-48FE-B3AC-3A74675B4416\nSealed: ${options.snapshotSealed === false ? "No" : "Yes"}\n`
  }
  throw new Error(`unexpected command: ${command} ${args.join(" ")}`)
}

function mockCommands(options: Parameters<typeof commandOutput>[2] = {}) {
  let jxaCalls = 0
  vi.mocked(spawnSync).mockImplementation((command, args) => {
    const effective =
      command === "osascript" && (args ?? []).includes("JavaScript") && options?.pid === 78
        ? { ...options, pid: ++jxaCalls === 1 ? 77 : 78 }
        : options
    const output = commandOutput(String(command), (args ?? []).map(String), effective)
    return { status: 0, stdout: output, stderr: command === "codesign" ? output : "", error: undefined } as ReturnType<
      typeof spawnSync
    >
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(realpathSync).mockImplementation((path) => String(path))
  vi.mocked(readFileSync).mockImplementation(() => executableBytes)
})

describe("owned Terminal.app receipt", () => {
  test("shared window module import does not run a process", async () => {
    vi.resetModules()
    await import("../../terminfo.dev/src/terminal-app-window.ts")
    expect(spawnSync).not.toHaveBeenCalled()
  })

  test("launch selects the one new single-tab window with the returned tab TTY", () => {
    // The OS reply lists the before IDs, do-script tab TTY, then only new
    // windows' ID, tab count, and sole-tab TTY. Retained closed IDs can vanish
    // between censuses, so old windows do not appear in the post inventory.
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      stdout: "12,13\n/dev/ttys003\n14|1|/dev/ttys003\n15|1|/dev/ttys004\n",
      stderr: "",
    } as ReturnType<typeof spawnSync>)
    expect(launchTerminalWindow("/private/run/serve.sh")).toEqual({
      provider: "terminal-app",
      windowId: 14,
      tty: "/dev/ttys003",
    })
  })

  test.each([
    ["preexisting matching tab", "12,13\n/dev/ttys003\n12|1|/dev/ttys003\n14|1|/dev/ttys004\n"],
    ["new multi-tab window", "12\n/dev/ttys003\n12|1|/dev/ttys001\n14|2|/dev/ttys003\n"],
    ["new wrong TTY", "12\n/dev/ttys003\n12|1|/dev/ttys001\n14|1|/dev/ttys004\n"],
    ["two new matching windows", "12\n/dev/ttys003\n12|1|/dev/ttys001\n14|1|/dev/ttys003\n15|1|/dev/ttys003\n"],
    ["duplicate inventory ID", "12\n/dev/ttys003\n14|1|/dev/ttys003\n14|1|/dev/ttys003\n"],
  ] as const)("launch refuses %s before claiming window ownership", (_case, stdout) => {
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout, stderr: "" } as ReturnType<typeof spawnSync>)
    expect(() => launchTerminalWindow("/private/run/serve.sh")).toThrow()
  })

  test("launch refuses an absent or malformed returned tab TTY", () => {
    for (const stdout of ["12\n\n14|1|/dev/ttys003\n", "12\n/dev/pts/3\n14|1|/dev/ttys003\n"]) {
      vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout, stderr: "" } as ReturnType<typeof spawnSync>)
      expect(() => launchTerminalWindow("/private/run/serve.sh")).toThrow(/TTY/)
    }
  })

  test("cleanup addresses only the launched window and its unchanged sole tab", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as ReturnType<typeof spawnSync>)
    closeOwnedTerminalWindow({ provider: "terminal-app", windowId: 14, tty: "/dev/ttys003" })
    const script = vi.mocked(spawnSync).mock.calls[0]?.[1]?.[1]
    expect(script).toContain("every window whose id is 14")
    expect(script).toContain("count of tabs of w) is not 1")
    expect(script).toContain('tty of tab 1 of w) is not "/dev/ttys003"')
  })

  test("binds daemon TTY to one live signed process and a sealed OS snapshot", () => {
    mockCommands()
    const capture = captureTerminalAppReceipt(
      { provider: "terminal-app", windowId: 14, tty: "/dev/ttys003" },
      555,
      "2.15",
    )
    expect(capture.receipt).toMatchObject({
      bundlePath,
      executablePath,
      cfBundleShortVersionString: "2.15",
      cfBundleVersion: "470.2",
      executableSha256: createHash("sha256").update(executableBytes).digest("hex"),
      sourceArtifact: {
        kind: "sealed-macos-system-volume",
        macOSBuild: "25G83",
        snapshotUUID: "C1602FFF-7F1F-48FE-B3AC-3A74675B4416",
        snapshotName: "com.apple.os.update-example",
        sealed: true,
        codeSignature: {
          identifier: "com.apple.Terminal",
          cdHash: "df446fa448104498f44f6cbce28099ed286eecc2",
          strictVerified: true,
        },
      },
    })
    expect(capture.trace.daemonTty).toBe("/dev/ttys003")
    expect(capture.trace.argvAbsentReason).toMatch(/AppleScript wrapper/)
    expect(spawnSync).toHaveBeenCalledWith("codesign", ["--verify", "--strict", executablePath], expect.any(Object))
  })

  test("refuses wrong TTY, ambiguous process, unsealed snapshot, or mismatched version", () => {
    for (const [options, version, diagnostic] of [
      [{ daemonTty: "ttys004" }, "2.15", /TTY/],
      [{ apps: 2 }, "2.15", /exactly one/],
      [{ snapshotSealed: false }, "2.15", /sealed/],
      [{ bundlePath: "/Applications/Terminal.app" }, "2.15", /sealed macOS system volume/],
      [{ pid: 78 }, "2.15", /PID or executable changed/],
      [{}, "2.14", /version/],
    ] as const) {
      vi.resetAllMocks()
      vi.mocked(realpathSync).mockImplementation((path) => String(path))
      vi.mocked(readFileSync).mockImplementation(() => executableBytes)
      mockCommands(options)
      expect(() =>
        captureTerminalAppReceipt({ provider: "terminal-app", windowId: 14, tty: "/dev/ttys003" }, 555, version),
      ).toThrow(diagnostic)
    }
  })
})

// A CLI-owned app must not borrow Terminal.app's globally running instance or sealed-volume receipt.
// Existing Terminal-only controls cannot detect that wrong-subject receipt on the five direct routes.
// These are explicit contract-model command results, not a measured Mac exit-code fixture.
test.each([
  "developer-id",
  "bundle-version-differs",
  "not-developer-id",
  "unsigned",
  "missing-tool",
  "modified",
  "unexpected-exit",
  "bad-facts",
  "changed-facts",
] as const)("captures the CLI owner without borrowing Terminal and classifies signature outcomes: %s", (scenario) => {
  const owner = {
    provider: "cli-process" as const,
    ownerPid: 777,
    tty: "/dev/ttys003",
    executablePath: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
    marker: { flag: "--config-file", value: "/private/run/ghostty-run" },
  }
  let displays = 0
  vi.mocked(spawnSync).mockImplementation((command, args = []) => {
    const cmd = String(command)
    const values = args.map(String)
    let stdout: string
    if (cmd === "codesign" && scenario === "missing-tool")
      return { status: null, stdout: "", stderr: "", error: new Error("ENOENT codesign") } as ReturnType<
        typeof spawnSync
      >
    if ((cmd === "ps" || cmd === "/bin/ps") && values.includes("ppid=")) stdout = "777\n"
    else if ((cmd === "ps" || cmd === "/bin/ps") && values.includes("command="))
      stdout = owner.executablePath + " --config-file=/private/run/ghostty-run\n"
    else if ((cmd === "ps" || cmd === "/bin/ps") && values.includes("comm=")) stdout = owner.executablePath + "\n"
    else if (cmd === "codesign" && values.includes("-dv")) {
      displays++
      stdout =
        scenario === "unsigned"
          ? "code object is not signed at all\n"
          : "Identifier=org.ghostty\n" +
            (scenario === "bad-facts"
              ? ""
              : "CDHash=" + (scenario === "changed-facts" && displays > 1 ? "34" : "12").repeat(20) + "\n")
    } else stdout = commandOutput(cmd === "/bin/ps" ? "ps" : cmd, values)
    const status =
      cmd !== "codesign"
        ? 0
        : values.includes("-R")
          ? scenario === "not-developer-id"
            ? 3
            : scenario === "unexpected-exit"
              ? 2
              : 0
          : values.includes("--verify") && ["unsigned", "modified"].includes(scenario)
            ? 1
            : 0
    return { status, stdout, stderr: cmd === "codesign" ? stdout : "", error: undefined } as ReturnType<
      typeof spawnSync
    >
  })
  const capture = () =>
    captureTerminalAppReceipt(owner, 555, scenario === "bundle-version-differs" ? "cli-build-tag" : "2.15", [
      "/invoked/ghostty",
      "--token=private",
      "--config-file=/private/public-config",
    ])
  const failure = {
    "missing-tool": /strict verification failed/,
    modified: /invalid or modified/,
    "unexpected-exit": /failed with exit 2/,
    "bad-facts": /identifier or CDHash/,
    "changed-facts": /changed during receipt/,
  }[scenario as "missing-tool" | "modified" | "unexpected-exit" | "bad-facts" | "changed-facts"]
  if (failure) {
    expect(capture).toThrow(failure)
    return
  }
  const result = capture()
  const commands = JSON.parse(String(result.trace.codesignCommandsRaw))
  expect(commands[0]).toMatchObject({
    command: "codesign",
    argv: ["--verify", "--strict", "/Applications/Ghostty.app"],
    status: scenario === "unsigned" ? 1 : 0,
  })
  expect(commands.at(-1)).toMatchObject({
    command: "codesign",
    argv: ["-dv", "--verbose=4", "/Applications/Ghostty.app"],
    status: 0,
  })
  if (scenario !== "unsigned") {
    expect(commands[1]).toMatchObject({
      status: scenario === "not-developer-id" ? 3 : 0,
      stdout: expect.any(String),
      stderr: expect.any(String),
    })
    expect(commands[1].argv[2]).toBe("-R")
    expect(commands[1].argv[3]).toMatch(/^=anchor apple generic/)
  }
  if (scenario === "not-developer-id" || scenario === "unsigned") {
    expect(result.receipt).toBeUndefined()
    expect(result.trace.argvAbsentReason).toBe(scenario === "unsigned" ? "unsigned or ad-hoc" : "not Developer ID")
    return
  }
  expect(result.receipt).toMatchObject({
    bundlePath: "/Applications/Ghostty.app",
    executablePath: owner.executablePath,
    argv: ["/invoked/ghostty", "--token=[redacted]", "--config-file=/private/public-config"],
    sourceArtifact: {
      kind: "developer-id-signed-bundle",
      codeSignature: { identifier: "org.ghostty", cdHash: "12".repeat(20), strictVerified: true },
    },
  })
  expect(JSON.stringify(result)).not.toContain('private"')
})
