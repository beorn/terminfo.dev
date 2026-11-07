/**
 * @failure Cursor shape captures an unfocused cursor without reading its own focus key.
 * @level l1
 * @consumer cursor.shape App fallback
 * @testonly none
 */
import { expect, test } from "vitest"
import { cursorProbes } from "../probe-defs/src/cursor.ts"
import { replayTermProbeSource } from "../probe-defs/src/testing/group-harness.ts"

test("cursor shape reads its own plain focus key before capturing steady styles", async () => {
  const events: string[] = []
  const context = replayTermProbeSource(new Map(), {
    write: (sequence) => events.push(sequence),
    queryCursorPosition: async () => ({ row: 2, col: 3 }),
    captureGeometry: {
      source: "measured by complete raster calibration",
      geometry: { cellWidth: 8, cellHeight: 16, textWidth: 640, textHeight: 384 },
    },
    input: {
      injectKey: async (key) => {
        events.push(`key:${key}`)
      },
      injectClick: async () => {},
    },
    readInput: async (pattern, _timeout, inject) => {
      await inject?.()
      events.push("read:a")
      return pattern.exec("a")
    },
    capture: async (request) => {
      events.push("capture")
      return {
        ...request,
        ref: `cursor-${events.length}.png`,
        capturedAt: events.length,
        regionDigest: "block",
        pixelsDigest: "window",
        regionRectangle: { x: 32, y: 32, width: 8, height: 16 },
      }
    },
  })
  const probe = cursorProbes.find((candidate) => candidate.id === "cursor.shape")
  if (!probe?.term) throw new Error("cursor.shape App callback missing")
  await probe.term(context)
  expect(events.indexOf("key:a")).toBeGreaterThanOrEqual(0)
  expect(events.indexOf("read:a")).toBeLessThan(events.indexOf("capture"))
  expect(events.some((sequence) => sequence.includes("\x1b[2 q"))).toBe(true)
  expect(events).toContain("\x1b[6 q")
  expect(events).toContain("\x1b[4 q")
  expect(events.some((sequence) => sequence.includes("\x1b[99 q"))).toBe(true)
  expect(events.some((sequence) => sequence.includes("\x1b[?25l"))).toBe(true)
  expect(events.at(-1)).toBe("\x1b[0 q\x1b[?25h")
})
