/**
 * @failure Controlling TTY cannot be opened on win32 or non-TTY stdin.
 * @level l2
 * @consumer openControllingTTY in terminfo CLI
 * @testonly none
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockOpenSync = vi.hoisted(() => vi.fn())
const mockWriteStream = vi.hoisted(() => {
  return vi.fn().mockImplementation(function (this: { fd: number; isTTY: boolean }, fd: number) {
    this.fd = fd
    this.isTTY = true
  })
})

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  openSync: mockOpenSync,
}))

vi.mock("node:tty", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:tty")>()),
  WriteStream: mockWriteStream,
}))

import { openControllingTTY, wasCollectorOpenedControllingTTY } from "./tty.ts"

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")

beforeEach(() => {
  mockOpenSync.mockReset()
  mockWriteStream.mockClear()
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true })
})

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
  if (originalIsTTY) Object.defineProperty(process.stdin, "isTTY", originalIsTTY)
  else delete (process.stdin as unknown as { isTTY?: unknown }).isTTY
  vi.clearAllMocks()
})

describe("openControllingTTY", () => {
  it("refuses when stdin is not a TTY", () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false })
    expect(() => openControllingTTY()).toThrow("JSON/file collection requires interactive TTY stdin for probe replies")
    expect(mockOpenSync).not.toHaveBeenCalled()
  })

  it("opens CONOUT$ on Windows and tracks the output", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" })
    mockOpenSync.mockReturnValue(42)

    const out = openControllingTTY()

    expect(mockOpenSync).toHaveBeenCalledWith("CONOUT$", "w")
    expect(mockWriteStream).toHaveBeenCalledWith(42)
    expect(wasCollectorOpenedControllingTTY(out as unknown as NodeJS.WriteStream)).toBe(true)
  })

  it("surfaces CONOUT$ open error on Windows", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" })
    mockOpenSync.mockImplementation(() => {
      throw new Error("device not found")
    })

    expect(() => openControllingTTY()).toThrow("Cannot open controlling CONOUT$ before probing: device not found")
  })

  it("opens /dev/tty on POSIX platforms and tracks the output", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" })
    mockOpenSync.mockReturnValue(7)

    const out = openControllingTTY()

    expect(mockOpenSync).toHaveBeenCalledWith("/dev/tty", "w")
    expect(mockWriteStream).toHaveBeenCalledWith(7)
    expect(wasCollectorOpenedControllingTTY(out as unknown as NodeJS.WriteStream)).toBe(true)
  })

  it("surfaces /dev/tty open error on POSIX platforms", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" })
    mockOpenSync.mockImplementation(() => {
      throw new Error("permission denied")
    })

    expect(() => openControllingTTY()).toThrow("Cannot open controlling /dev/tty before probing: permission denied")
  })
})
