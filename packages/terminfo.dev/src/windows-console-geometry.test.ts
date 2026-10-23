/**
 * @failure The hosted Windows arm reports a window size it never read, or substitutes a default
 *   when both console reads fail, so the candidate-2 classics grade on a fabricated geometry
 *   (#29558, 138 inconclusive observations carrying "No verified owned terminal for geometry read").
 * @level l1
 * @consumer createOwnedTerminal's windows arm in the terminfo collector
 * @testonly none
 */
import { describe, expect, it, vi } from "vitest"
import { decodeConsoleScreenBufferInfo } from "./windows-console-ffi.ts"
import { parseModeConGeometry, readConsoleGeometry } from "./windows-console-geometry.ts"

/** A real `cmd /c mode con` body, byte shape as measured on the hosted runner 2026-10-15. */
const MODE_CON_40x100 = `
Status for device CON:
----------------------

    Lines:          40
    Columns:        100

    Keyboard rate:  31
    Keyboard delay: 1
    Code page:      65001
`

/** A CONSOLE_SCREEN_BUFFER_INFO as the two measured reads on the hosted runner laid it out. */
const csbi = (
  buffer: { cols: number; rows: number },
  window: { left: number; top: number; right: number; bottom: number },
) => {
  const bytes = new Uint8Array(22)
  const view = new DataView(bytes.buffer)
  view.setInt16(0, buffer.cols, true)
  view.setInt16(2, buffer.rows, true)
  view.setInt16(10, window.left, true)
  view.setInt16(12, window.top, true)
  view.setInt16(14, window.right, true)
  view.setInt16(16, window.bottom, true)
  return bytes
}

describe("decodeConsoleScreenBufferInfo — the mapping measured on the runner (#29558)", () => {
  it("reads the two geometries the same console reported before and after a resize", () => {
    const before = csbi({ cols: 110, rows: 30 }, { left: 0, top: 0, right: 109, bottom: 29 })
    const after = csbi({ cols: 100, rows: 40 }, { left: 0, top: 0, right: 99, bottom: 39 })

    expect(decodeConsoleScreenBufferInfo(before)).toEqual({ cols: 110, rows: 30 })
    expect(decodeConsoleScreenBufferInfo(after)).toEqual({ cols: 100, rows: 40 })
  })

  it("reads the visible window, never the scrollback-inclusive buffer height", () => {
    const scrolled = csbi({ cols: 110, rows: 9001 }, { left: 0, top: 0, right: 109, bottom: 29 })

    expect(decodeConsoleScreenBufferInfo(scrolled)).toEqual({ cols: 110, rows: 30 })
  })

  it("refuses a read shorter than the structure it decodes", () => {
    expect(() => decodeConsoleScreenBufferInfo(new Uint8Array(8))).toThrow(/bytes/)
  })
})

describe("parseModeConGeometry — the node-compatible fallback read (#29558)", () => {
  it("reads rows then columns from the device status block", () => {
    expect(parseModeConGeometry(MODE_CON_40x100)).toEqual({ cols: 100, rows: 40 })
  })

  it("refuses a body that carries no geometry instead of guessing one", () => {
    expect(() => parseModeConGeometry("Status for device CON:\n----------------------\n")).toThrow(/geometry/)
  })

  it("refuses a body with only one of the two numbers", () => {
    expect(() => parseModeConGeometry("    Lines:          40\n")).toThrow(/geometry/)
  })
})

describe("readConsoleGeometry — the console the probes write to (#29558)", () => {
  it("uses the ffi read and does not spawn a child when it answers", async () => {
    const modeCon = vi.fn(() => ({ stdout: MODE_CON_40x100, stderr: "", status: 0 }))
    const read = await readConsoleGeometry({
      ffi: vi.fn(async () => ({ cols: 110, rows: 30 })),
      modeCon,
    })

    expect(read).toEqual({ status: "measured", via: "ffi", cols: 110, rows: 30 })
    expect(modeCon).not.toHaveBeenCalled()
  })

  it("falls back to `mode con` when the ffi binding is not available, and says which read answered", async () => {
    const read = await readConsoleGeometry({
      ffi: vi.fn(async () => {
        throw new Error("no bun:ffi on this runtime")
      }),
      modeCon: vi.fn(() => ({ stdout: MODE_CON_40x100, stderr: "", status: 0 })),
    })

    expect(read).toEqual({ status: "measured", via: "mode-con", cols: 100, rows: 40 })
  })

  it("is unavailable, with both attempts named, when neither read answers — never a default size", async () => {
    const read = await readConsoleGeometry({
      ffi: vi.fn(async () => {
        throw new Error("CreateFileW CONOUT$ failed")
      }),
      modeCon: vi.fn(() => ({ stdout: "not a console", stderr: "redirected", status: 1 })),
    })

    expect(read.status).toBe("unavailable")
    if (read.status !== "unavailable") throw new Error("unreachable")
    expect(read.diagnostic).toMatch(/CreateFileW CONOUT\$ failed/)
    expect(read.diagnostic).toMatch(/mode con/)
    expect(read).not.toHaveProperty("cols")
    expect(read).not.toHaveProperty("rows")
  })

  it("refuses `mode con` output that parses but came from a failed command — never a default size", async () => {
    // @dev/7 r1 finding 3: the existing failure case used UNPARSEABLE stdout, so a nonzero exit with
    // two plausible numbers was still accepted as measured geometry.
    for (const status of [1, null] as const) {
      const read = await readConsoleGeometry({
        ffi: vi.fn(async () => {
          throw new Error("CreateFileW CONOUT$ failed")
        }),
        modeCon: vi.fn(() => ({ stdout: MODE_CON_40x100, stderr: "the handle is invalid", status })),
      })

      expect(read.status).toBe("unavailable")
      if (read.status !== "unavailable") throw new Error("unreachable")
      expect(read).not.toHaveProperty("cols")
      expect(read).not.toHaveProperty("rows")
      expect(read.diagnostic).toMatch(/`mode con` (exited nonzero|returned no exit status)/)
      expect(read.diagnostic).toMatch(/the handle is invalid/)
    }
  })

  it("refuses to reach for either default read off Windows", async () => {
    const read = await readConsoleGeometry({ platform: "linux" })

    expect(read.status).toBe("unavailable")
    if (read.status !== "unavailable") throw new Error("unreachable")
    expect(read.diagnostic).toMatch(/win32/)
  })
})
