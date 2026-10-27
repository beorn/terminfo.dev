/**
 * @failure Darwin subject identity records the kernel release instead of the measured macOS product version.
 * @level l1
 * @consumer detectTerminal subject identity used by the real collector.
 * @testonly none
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest"

const execFile = vi.hoisted(() => vi.fn())
const spawn = vi.hoisted(() => vi.fn())
const kernelRelease = vi.hoisted(() => vi.fn())
const detectWindowsAncestor = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: execFile,
  spawnSync: spawn,
}))
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  release: kernelRelease,
}))
vi.mock("./windows-process-ancestry.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./windows-process-ancestry.ts")>()
  return {
    ...actual,
    detectHostedWindowsAncestor: (...args: Parameters<typeof actual.detectHostedWindowsAncestor>) =>
      detectWindowsAncestor(...args),
  }
})

import { detectTerminal, getWindowsAppVersion } from "./detect.ts"
import { resolveMeasuredAppVersion } from "./identity-guard.ts"
import * as windowsProcessAncestry from "./windows-process-ancestry.ts"

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
const originalGetBuiltinModule = process.getBuiltinModule

beforeEach(() => {
  vi.stubEnv("TMUX", "")
  vi.stubEnv("STY", "")
  vi.stubEnv("TERM_PROGRAM", "Apple_Terminal")
  vi.stubEnv("TERM_PROGRAM_VERSION", "2.14")
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
  kernelRelease.mockReturnValue("25.6.0")
  execFile.mockReturnValue("26.6.2\n") // measured by /usr/bin/sw_vers on the owned Mac fixture
  detectWindowsAncestor.mockReturnValue(null)
})

test.each(["tmux", "screen"])("%s hint survives inherited outer app identity but cannot override replies", (mux) => {
  vi.stubEnv(mux === "tmux" ? "TMUX" : "STY", "owned-mux-session")
  vi.stubEnv("__CFBundleIdentifier", "net.kovidgoyal.kitty")
  vi.stubEnv("KITTY_WINDOW_ID", "1")
  vi.stubEnv("TERM_PROGRAM", "kitty")
  vi.stubEnv("TERM_PROGRAM_VERSION", "0.49.2")
  const hint = detectTerminal()
  expect(hint).toMatchObject({ name: mux, version: "" })
  const muxReplies: Record<string, string> =
    mux === "tmux"
      ? { "collector.xtversion": "\x1bP>|tmux 3.6\x1b\\\x1b[?1;2;4c" }
      : { "collector.xtversion": "\x1b[?1;2c", "collector.da2": "\x1b[>83;40901;0c\x1b[?1;2c" }
  expect(resolveMeasuredAppVersion(hint.name, hint.version, muxReplies)).toBe(mux === "tmux" ? "3.6" : "4.09.01")
  // A fresh Kitty can inherit the same mux hint. Refuse naming both; never record it as the mux.
  expect(() =>
    resolveMeasuredAppVersion(hint.name, hint.version, {
      "collector.xtversion": "\x1bP>|kitty(0.49.2)\x1b\\\x1b[?62;52;c",
    }),
  ).toThrow(new RegExp(`${mux}.*kitty`))
})

test("nested TMUX and STY do not arbitrarily choose an innermost mux", () => {
  vi.stubEnv("TMUX", "tmux-session")
  vi.stubEnv("STY", "screen-session")
  expect(() => detectTerminal()).toThrow(/TMUX.*STY.*ambiguous/)
})

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
  process.getBuiltinModule = originalGetBuiltinModule
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

test("Darwin subject identity uses the bounded sw_vers product version", () => {
  expect(detectTerminal()).toMatchObject({ os: "macos", osVersion: "26.6.2" })
  expect(execFile).toHaveBeenCalledWith(
    "/usr/bin/sw_vers",
    ["-productVersion"],
    expect.objectContaining({ encoding: "utf8", timeout: expect.any(Number) }),
  )
  expect(kernelRelease).not.toHaveBeenCalled()
})

test.each(["", "Darwin Kernel Version 25.6.0", "26..6", "26.6.2 extra"])(
  "Darwin subject identity refuses invalid sw_vers output %j",
  (value) => {
    execFile.mockReturnValue(value)
    expect(() => detectTerminal()).toThrow(/sw_vers.*productVersion/)
  },
)

test("Darwin subject identity surfaces sw_vers failure", () => {
  execFile.mockImplementation(() => {
    throw new Error("measured sw_vers failure")
  })
  expect(() => detectTerminal()).toThrow(/sw_vers.*productVersion.*measured sw_vers failure/)
})

test("non-Darwin subject identity keeps the OS release", () => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true })
  kernelRelease.mockReturnValue("6.17.0")
  expect(detectTerminal()).toMatchObject({ os: "linux", osVersion: "6.17.0" })
  expect(execFile).not.toHaveBeenCalled()
})

test("Windows Terminal detects version via PowerShell", () => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true })
  kernelRelease.mockReturnValue("10.0.26100")
  vi.stubEnv("TERM_PROGRAM", "")
  vi.stubEnv("TERM_PROGRAM_VERSION", "")
  vi.stubEnv("WT_SESSION", "9f8a3d4e-1234-5678-abcd-ef0123456789")
  execFile.mockReturnValue("1.21.2361.0\n")
  expect(detectTerminal()).toMatchObject({
    name: "windows-terminal",
    version: "1.21.2361.0",
    os: "windows",
    osVersion: "10.0.26100",
  })
  expect(execFile).toHaveBeenCalledWith(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", expect.stringContaining("Get-AppxPackage *WindowsTerminal*")],
    expect.objectContaining({ encoding: "utf-8", timeout: 3000 }),
  )
})

test("Windows Terminal handles PowerShell error gracefully with empty version", () => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true })
  kernelRelease.mockReturnValue("10.0.26100")
  vi.stubEnv("TERM_PROGRAM", "")
  vi.stubEnv("TERM_PROGRAM_VERSION", "")
  vi.stubEnv("WT_SESSION", "9f8a3d4e-1234-5678-abcd-ef0123456789")
  execFile.mockImplementation(() => {
    throw new Error("PowerShell not available")
  })
  expect(detectTerminal()).toMatchObject({
    name: "windows-terminal",
    version: "",
    os: "windows",
    osVersion: "10.0.26100",
  })
})

test("Windows Alacritty detects from proven process ancestor and queries --version only on its executablePath", () => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true })
  kernelRelease.mockReturnValue("10.0.26100")
  vi.stubEnv("TERM_PROGRAM", "")
  vi.stubEnv("TERM_PROGRAM_VERSION", "")
  vi.stubEnv("WT_SESSION", "")
  vi.stubEnv("ALACRITTY_WINDOW_ID", "")
  vi.stubEnv("TERM", "xterm-256color")
  detectWindowsAncestor.mockReturnValue({
    app: { id: "alacritty", comm: "alacritty.exe" },
    row: { pid: 4684, ppid: 9644, comm: "alacritty.exe" },
    executablePath: "D:\\a\\_temp\\alacritty\\alacritty.exe",
  })
  spawn.mockReturnValue({ status: 0, stdout: "alacritty 0.17.0 (94e7c88)\r\n", stderr: "" })
  expect(detectTerminal()).toEqual({
    name: "alacritty",
    version: "0.17.0",
    os: "windows",
    osVersion: "10.0.26100",
  })
  expect(spawn).toHaveBeenCalledWith(
    "D:\\a\\_temp\\alacritty\\alacritty.exe",
    ["--version"],
    expect.objectContaining({ encoding: "utf8", timeout: 3000, windowsHide: true }),
  )
  expect(execFile).not.toHaveBeenCalled()
})

test("Windows Alacritty returns unknown empty version without PATH or Get-Command fallback when ancestor executablePath is absent", () => {
  expect(getWindowsAppVersion("alacritty", null)).toBe("")
  expect(spawn).not.toHaveBeenCalled()
  expect(execFile).not.toHaveBeenCalled()
})

test("detectTerminal on Windows without bun:ffi skips the process-table probe and does not throw", async () => {
  const actualAncestry = await vi.importActual<typeof windowsProcessAncestry>("./windows-process-ancestry.ts")
  Object.defineProperty(process, "platform", { value: "win32", configurable: true })
  kernelRelease.mockReturnValue("10.0.26100")
  vi.stubEnv("TERM_PROGRAM", "")
  vi.stubEnv("TERM_PROGRAM_VERSION", "")
  vi.stubEnv("WT_SESSION", "")
  vi.stubEnv("ALACRITTY_WINDOW_ID", "")
  vi.stubEnv("TERM", "xterm-256color")
  process.getBuiltinModule = ((id: string) =>
    id === "bun:ffi" ? undefined : originalGetBuiltinModule(id)) as typeof process.getBuiltinModule
  detectWindowsAncestor.mockImplementation(() => actualAncestry.detectHostedWindowsAncestor())
  expect(detectTerminal()).toEqual({
    name: "xterm-256color",
    version: "",
    os: "windows",
    osVersion: "10.0.26100",
  })
  expect(detectWindowsAncestor).not.toHaveBeenCalled()
})

test("detectTerminal on Windows with bun:ffi propagates a Toolhelp process-table failure by name instead of falling back to $TERM", () => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true })
  kernelRelease.mockReturnValue("10.0.26100")
  vi.stubEnv("TERM_PROGRAM", "")
  vi.stubEnv("TERM_PROGRAM_VERSION", "")
  vi.stubEnv("WT_SESSION", "")
  vi.stubEnv("ALACRITTY_WINDOW_ID", "")
  vi.stubEnv("TERM", "xterm-256color")
  detectWindowsAncestor.mockImplementation(() => {
    throw new Error("CreateToolhelp32Snapshot read no process table: error 8")
  })
  expect(() => detectTerminal()).toThrow("CreateToolhelp32Snapshot read no process table: error 8")
})
