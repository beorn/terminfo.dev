/**
 * @failure Kitty batch-1 pixel fixtures advertised controls they could not establish: a wide glyph
 *   overwrote its Z flank, reset frames never rendered a changed color, history/alt/region controls
 *   were reproducible by a terminal that ignores the sequence, and the duplicate SGR capture recipe
 *   dropped helpers.ts's 3x34 geometry refusal.
 * @level l1
 * @consumer App probe pixel frames for terminal support cells.
 * @testonly none
 */
import { expect, test } from "vitest"
import { charsetsProbes } from "./charsets.ts"
import { scrollbackProbes } from "./scrollback.ts"
import { sgrProbes } from "./sgr.ts"
import type { ObservationFrame, ProbeDefinition, TermContext } from "./types.ts"

function captureContext(rows: number, cols: number) {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const context: TermContext = {
    rows,
    cols,
    write: (sequence) => writes.push(sequence),
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
    capture: async ({ role, label }) => {
      const frame = {
        role,
        label,
        capturedAt: frames.length + 1,
        ref: `sha256:${String(frames.length + 1).repeat(64)}`,
      }
      frames.push(frame)
      return frame
    },
  }
  return { context, writes, frames }
}

function find(list: ProbeDefinition[], id: string): ProbeDefinition {
  const definition = list.find((probe) => probe.id === id)
  if (!definition?.term) throw new Error(`missing app callback for ${id}`)
  return definition
}

test("charsets.utf8 keeps the Z flank outside the two-cell glyph and reports both occupied cells", async () => {
  const { context, writes, frames } = captureContext(4, 6)
  const result = await find(charsetsProbes, "charsets.utf8").term!(context)
  expect(writes).toContain("\x1b[1;1H     \x1b[1;1HA??Z")
  expect(writes).toContain("\x1b[2;1H     \x1b[2;1HA??Z")
  expect(writes).toContain("\x1b[1;2H\u00e9\x1b[2;2H\u4e16\x1b[4;4H")
  const response = JSON.parse(String(result.response)) as { sampleCells: { row: number; col: number }[] }
  expect(response.sampleCells).toEqual([
    { row: 1, col: 2 },
    { row: 2, col: 2 },
    { row: 2, col: 3 },
  ])
  expect(frames.map(({ role }) => role)).toEqual(["control", "target"])
  expect(frames[1]?.label).toContain("cols 2-3")
})

test("sgr reset captures render a distinct setup color and refuse undersized geometry", async () => {
  const defaultFg = find(sgrProbes, "sgr.fg.default")
  const small = captureContext(2, 33)
  expect((await defaultFg.term!(small.context)).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "none",
  })
  expect(small.writes).toEqual([])

  const ok = captureContext(3, 34)
  await defaultFg.term!(ok.context)
  expect(ok.writes).toContain("\x1b[0m\x1b[2J\x1b[3;3H\x1b[31mXX\x1b[39mYY")
  expect(ok.frames.map(({ role }) => role)).toEqual(["control", "target"])

  const underline = captureContext(3, 34)
  await find(sgrProbes, "sgr.underline-color-reset").term!(underline.context)
  expect(underline.writes).toContain("\x1b[0m\x1b[2J\x1b[3;3H\x1b[4m\x1b[58;2;255;0;128mXX\x1b[59mYY")
  expect(underline.writes.some((sequence) => sequence.indexOf("58;2;255;0;128") > sequence.indexOf("\x1b[59m"))).toBe(
    false,
  )
})

test("scrollback.accumulate needs three control rows and does not home over TOP before overflow", async () => {
  const accumulate = find(scrollbackProbes, "scrollback.accumulate")
  const small = captureContext(2, 61)
  expect((await accumulate.term!(small.context)).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "none",
  })
  expect(small.writes).toEqual([])

  const ok = captureContext(3, 61)
  await accumulate.term!(ok.context)
  expect(ok.writes).toContain("\x1b[2;1H")
  expect(ok.writes.includes("\x1b[H")).toBe(false)
})

test("scrollback.alt-screen proves the alt screen was entered before the restore", async () => {
  const { context, writes, frames } = captureContext(4, 61)
  const result = await find(scrollbackProbes, "scrollback.alt-screen").term!(context)
  expect(frames.map(({ role }) => role)).toEqual(["control", "control", "target"])
  expect(frames[1]?.label).toContain("no MAIN_SCREEN_MARKER")
  expect(writes).toContain("\x1b[?1049h")
  expect(writes).toContain("\x1b[2;1HALT_SCREEN")
  expect(result.observation?.frames).toHaveLength(3)
})

test("scrollback.decstbm-reset proves the region was active and needs nine columns", async () => {
  const reset = find(scrollbackProbes, "scrollback.decstbm-reset")
  const small = captureContext(12, 8)
  expect((await reset.term!(small.context)).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "none",
  })
  expect(small.writes).toEqual([])

  const ok = captureContext(12, 61)
  const result = await reset.term!(ok.context)
  expect(ok.frames.map(({ role }) => role)).toEqual(["control", "control", "target"])
  expect(ok.frames[1]?.label).toContain("Region rows 5-10 active")
  expect(ok.writes).toContain("\x1b[5;10r")
  expect(ok.writes).toContain("\x1b[2;1H")
  expect(result.observation?.frames).toHaveLength(3)
})

test("scrollback.set-region needs six columns for its FIXED/down fixture", async () => {
  const setRegion = find(scrollbackProbes, "scrollback.set-region")
  const small = captureContext(12, 5)
  expect((await setRegion.term!(small.context)).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "none",
  })
  expect(small.writes).toEqual([])
})
