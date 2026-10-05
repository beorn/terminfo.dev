/**
 * @failure Editing capture fixtures advertised a cell-readback claim the application collector
 *   cannot make: they returned only a cursor-position measurement, with no pre-edit control or
 *   post-edit target a reviewer could judge. A missing capture branch must not silently change
 *   the cursor-only fallback, and an undersized terminal must refuse before writing.
 * @level l1
 * @consumer App probe pixel frames for editing operations.
 * @testonly none
 */
import { expect, test } from "vitest"
import { editingProbes } from "./editing.ts"
import type { ObservationFrame, ProbeDefinition, TermContext } from "./types.ts"

const CAPTURE_IDS = [
  "editing.insert-chars",
  "editing.delete-chars",
  "editing.insert-lines",
  "editing.delete-lines",
  "editing.repeat-char",
  "editing.decfra",
  "editing.decera",
  "editing.decsera",
  "editing.deccra",
  "editing.deccara",
  "editing.decrara",
  "editing.sl",
  "editing.sr",
  "editing.decic",
  "editing.decdc",
] as const

function captureContext(rows: number, cols: number, withCapture = true) {
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
  }
  if (withCapture) {
    context.capture = async ({ role, label }) => {
      const frame = {
        role,
        label,
        capturedAt: frames.length + 1,
        ref: `sha256:${String(frames.length + 1).repeat(64)}`,
      }
      frames.push(frame)
      return frame
    }
  }
  return { context, writes, frames }
}

function find(id: string): ProbeDefinition {
  const definition = editingProbes.find((probe) => probe.id === id)
  if (!definition?.term) throw new Error(`missing editing term callback for ${id}`)
  return definition
}

test("every editing capture probe records a pre-edit control and a post-edit target", async () => {
  for (const id of CAPTURE_IDS) {
    const { context, writes, frames } = captureContext(24, 80)
    const result = await find(id).term!(context)
    expect(result.observation, id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "pixels",
    })
    expect(
      frames.map(({ role }) => role),
      id,
    ).toEqual(["control", "target"])
    expect(frames[0]?.label, id).toContain("pre-edit seed")
    expect(frames[0]?.label, id).toContain(id)
    expect(frames[1]?.label, id).toBe(id)
    expect(writes[0], id).toBe("\x1b[0m\x1b[2J")
    expect(writes.length, id).toBeGreaterThanOrEqual(3)
    expect(result.observation?.frames, id).toHaveLength(2)
    const response = JSON.parse(String(result.response)) as {
      region: { row: number; col: number; rows: number; cols: number }
    }
    expect(response.region.rows, id).toBeGreaterThanOrEqual(1)
    expect(response.region.cols, id).toBeGreaterThanOrEqual(1)
  }
})

test("an undersized terminal refuses an editing capture before writing", async () => {
  for (const id of CAPTURE_IDS) {
    const { context, writes, frames } = captureContext(1, 1)
    const result = await find(id).term!(context)
    expect(result.observation, id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "none",
    })
    expect(writes, id).toEqual([])
    expect(frames, id).toEqual([])
  }
})

test("a seed at the very edge refuses so it cannot wrap or scroll the captured region", async () => {
  // insert-chars draws eight columns on one row; the guard's margin requires 2x10.
  const tight = captureContext(1, 8)
  expect((await find("editing.insert-chars").term!(tight.context)).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "none",
  })
  expect(tight.writes).toEqual([])
  const margins = captureContext(2, 10)
  const result = await find("editing.insert-chars").term!(margins.context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", evidence: "pixels" })
  expect(margins.frames.map(({ role }) => role)).toEqual(["control", "target"])
})

test("the capture set covers the cell-edit probes and leaves non-cell probes untouched", () => {
  const captured = editingProbes.filter((probe) => probe.id in Object.fromEntries(CAPTURE_IDS.map((id) => [id, true])))
  expect(captured.map((probe) => probe.id).sort()).toEqual([...CAPTURE_IDS].sort())
  expect(captured).toHaveLength(15)
})

test("without a capture adapter the cursor-only fallback is unchanged", async () => {
  const { context } = captureContext(24, 80, false)
  const result = await find("editing.insert-chars").term!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "no-response", evidence: "query" })
})

test("editing.decsace stays a non-capture probe even when a capture adapter exists", async () => {
  const { context, frames } = captureContext(24, 80)
  const result = await find("editing.decsace").term!(context)
  expect(result.observation?.outcome).toBe("inconclusive")
  expect(frames).toEqual([])
})
