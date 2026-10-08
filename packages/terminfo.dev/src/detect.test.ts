/**
 * @failure Darwin target identity records the kernel release instead of the measured macOS product version.
 * @level l1
 * @consumer detectTerminal target identity used by the real collector.
 * @testonly none
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest"

const execFile = vi.hoisted(() => vi.fn())
const kernelRelease = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: execFile,
}))
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  release: kernelRelease,
}))

import { detectTerminal } from "./detect.ts"

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")

beforeEach(() => {
  vi.stubEnv("TERM_PROGRAM", "Apple_Terminal")
  vi.stubEnv("TERM_PROGRAM_VERSION", "2.14")
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
  kernelRelease.mockReturnValue("25.6.0")
  execFile.mockReturnValue("26.6.2\n") // measured by /usr/bin/sw_vers on the owned Mac fixture
})

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

test("Darwin target identity uses the bounded sw_vers product version", () => {
  expect(detectTerminal()).toMatchObject({ os: "macos", osVersion: "26.6.2" })
  expect(execFile).toHaveBeenCalledWith(
    "/usr/bin/sw_vers",
    ["-productVersion"],
    expect.objectContaining({ encoding: "utf8", timeout: expect.any(Number) }),
  )
  expect(kernelRelease).not.toHaveBeenCalled()
})

test.each(["", "Darwin Kernel Version 25.6.0", "26..6", "26.6.2 extra"])(
  "Darwin target identity refuses invalid sw_vers output %j",
  (value) => {
    execFile.mockReturnValue(value)
    expect(() => detectTerminal()).toThrow(/sw_vers.*productVersion/)
  },
)

test("Darwin target identity surfaces sw_vers failure", () => {
  execFile.mockImplementation(() => {
    throw new Error("measured sw_vers failure")
  })
  expect(() => detectTerminal()).toThrow(/sw_vers.*productVersion.*measured sw_vers failure/)
})

test("non-Darwin target identity keeps the OS release", () => {
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
