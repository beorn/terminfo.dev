/**
 * @failure The hosted Windows arm reports a window size it never read, substitutes a default when
 *   the console read fails, or reads a child's own console instead of the owned one, so the
 *   candidate-2 classics grade on a fabricated geometry (#29558, 138 inconclusive observations
 *   carrying "No verified owned terminal for geometry read"; #30731, `mode con` read 120×9001 while
 *   the owned window was 110×30).
 * @level l1
 * @consumer createOwnedTerminal's windows arm in the terminfo collector
 * @testonly none
 */
import { spawn, spawnSync } from "node:child_process"
import { describe, expect, it, vi } from "vitest"
import { decodeConsoleScreenBufferInfo } from "./windows-console-ffi.ts"
import { readConsoleGeometry } from "./windows-console-geometry.ts"

// A child process has its own console, so no read through one is a read of the owned window (#30731).
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}))

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

describe("readConsoleGeometry — the console the probes write to (#29558, #30731)", () => {
  it("measures the owned console through the ffi read", async () => {
    const read = await readConsoleGeometry({ ffi: vi.fn(async () => ({ cols: 110, rows: 30 })) })

    expect(read).toEqual({ status: "measured", cols: 110, rows: 30 })
  })

  it("is unavailable, naming the ffi failure, when the ffi read fails — no second read, never a default size", async () => {
    const read = await readConsoleGeometry({
      ffi: vi.fn(async () => {
        throw new Error("CreateFileW CONOUT$ failed")
      }),
    })

    expect(read.status).toBe("unavailable")
    if (read.status !== "unavailable") throw new Error("unreachable")
    expect(read.diagnostic).toMatch(/GetConsoleScreenBufferInfo on CONOUT\$ failed \(CreateFileW CONOUT\$ failed\)/)
    expect(read).not.toHaveProperty("cols")
    expect(read).not.toHaveProperty("rows")
    expect(spawn).not.toHaveBeenCalled()
    expect(spawnSync).not.toHaveBeenCalled()
  })
})
