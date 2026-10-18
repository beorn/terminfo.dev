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
import { editingProbes, editingReadbackRows } from "./editing.ts"
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

/**
 * 28450 slice C moved every editing capture row onto the region verdict, so the ungraded
 * pre-edit-control/post-edit-target pixel pair is no longer reachable for any of them. The decision
 * itself is asserted per id by `testing/region-readback-contract.test.ts`; what stays unique to this
 * file is the guard behaviour, asserted below.
 */
test("every editing capture row asks the terminal's pixel report before painting", async () => {
  for (const id of CAPTURE_IDS) {
    const { context, writes, frames } = captureContext(24, 80)
    const result = await find(id).term!(context)
    expect(result.observation, id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "query",
    })
    expect(String(result.observation?.note), id).toContain("CSI 16 t")
    expect(frames, id).toEqual([])
    expect(writes, id).toEqual([])
  }
})

/**
 * A window whose cells are readable: CSI 16 t and CSI 14 t answer the terminal's own pixel report,
 * the witness cell shows the last glyph written, and the compared cells never move — so the row
 * reaches the decision and its spec, without claiming any capability.
 */
function readbackCaptureContext(rows: number, cols: number, witness = { row: 3, col: 1 }) {
  const writes: string[] = []
  const requests: Array<{ region: { top: number; left: number; bottom: number; right: number }; label: string }> = []
  const frames: ObservationFrame[] = []
  let reads = 0
  const sentinel = `${witness.row},${witness.col},${witness.row},${witness.col}`
  const key = (region: { top: number; left: number; bottom: number; right: number }) =>
    `${region.top},${region.left},${region.bottom},${region.right}`
  const context: TermContext = {
    rows,
    cols,
    write: (sequence) => writes.push(sequence),
    queryCursorPosition: async () => ({ row: 2, col: 1 }),
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    async queryWithSentinelOutcome(sequence) {
      if (sequence === "\x1b[16t") {
        return { match: ["\x1b[6;16;8t", "16", "8"], reason: "reply", raw: "", rawBase64: "" }
      }
      if (sequence === "\x1b[14t") {
        return { match: ["\x1b[4;384;640t", "384", "640"], reason: "reply", raw: "", rawBase64: "" }
      }
      return { match: null, reason: "timeout", raw: "", rawBase64: "" }
    },
    queryMode: async () => null,
  }
  context.capture = async (request) => {
    reads += 1
    const region = request.cells!
    requests.push({ region, label: request.label })
    const frame: ObservationFrame = {
      role: request.role,
      label: request.label,
      capturedAt: reads,
      ref: `sha256:${String(reads).repeat(64)}`,
    }
    frames.push(frame)
    const witnessWrite = writes.filter((entry) => /^\x1b\[\d+;\d+H.$/.test(entry)).at(-1)
    const content = key(region) === sentinel ? (witnessWrite?.slice(-1) ?? "") : "unmoving"
    return { ...frame, regionDigest: `sha256:${key(region)}|${content}`, pixelsDigest: `sha256:frame|${content}` }
  }
  return { context, writes, requests, frames }
}

test("the readback-governed row hands the decision its own region and the terminal's pixel report", async () => {
  const { context, requests } = readbackCaptureContext(24, 80)
  const result = await find("editing.delete-chars").term!(context)
  expect(result.observation?.outcome).toBe("inconclusive")
  expect(String(result.observation?.note)).toContain("seed frame and the expected frame read the same cells")
  const compared = requests.filter(({ region }) => region.right !== region.left || region.bottom !== region.top)
  expect(compared.map(({ region }) => region)).toEqual([
    { top: 1, left: 1, bottom: 1, right: 8 },
    { top: 1, left: 1, bottom: 1, right: 8 },
    { top: 1, left: 1, bottom: 1, right: 8 },
  ])
  expect(compared.map(({ label }) => label)).toEqual([
    "editing.delete-chars: pre-edit seed",
    "editing.delete-chars: post-sequence target",
    "editing.delete-chars: expected frame",
  ])
})

test("the readback-governed row refuses by name when the terminal cannot report its pixel geometry", async () => {
  const { context, frames } = captureContext(24, 80)
  const result = await find("editing.delete-chars").term!(context)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    // Shape B of 28582: the pixel-report queries were already written, so this is not the
    // zero-byte "none" refusal — it is a query that came back unusable.
    evidence: "query",
  })
  expect(String(result.observation?.note)).toContain("CSI 16 t")
  expect(frames).toEqual([])
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
  // insert-chars compares one nine-column row with its witness on row 3, so the kind DERIVES a floor of
  // 3 rows by 9 + the family's two-column margin = 11 columns.
  const tight = captureContext(1, 8)
  expect((await find("editing.insert-chars").term!(tight.context)).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "none",
  })
  expect(tight.writes).toEqual([])
  const margins = captureContext(2, 11)
  const refused = await find("editing.insert-chars").term!(margins.context)
  expect(refused.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "none",
  })
  expect(margins.writes).toEqual([])
  expect(margins.frames).toEqual([])
  // One column short of the derived floor still refuses: the margin is what stops the seed wrapping.
  const narrow = captureContext(3, 10)
  expect((await find("editing.insert-chars").term!(narrow.context)).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "none",
  })
  expect(narrow.writes).toEqual([])
  expect(narrow.frames).toEqual([])
  // Exactly the derived floor opens the guards: the row moves on to the pixel report, no paint yet.
  const fit = captureContext(3, 11)
  expect((await find("editing.insert-chars").term!(fit.context)).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "query",
  })
  expect(fit.frames).toEqual([])
})

test("the capture set covers the cell-edit probes and leaves non-cell probes untouched", () => {
  const captured = editingProbes.filter((probe) => probe.id in Object.fromEntries(CAPTURE_IDS.map((id) => [id, true])))
  expect(captured.map((probe) => probe.id).sort()).toEqual([...CAPTURE_IDS].sort())
  expect(captured).toHaveLength(15)
})

/**
 * 28450 slice C deleted the cursor-only fallback for the thirteen converted rows: a run with no owned
 * capture can only answer "inconclusive", so the row refuses BY NAME and writes nothing rather than
 * keeping an ungraded CPR fixture alive (@cto A2). `editing.decsace` and `editing.decrqcra` keep their
 * own callbacks; the two attribute-rectangle rows converted to the kind with decsace, so their extent
 * refusals are the kind's own (`editing-geometry.test.ts`).
 */
test("without a capture adapter a converted row refuses by name and writes nothing", async () => {
  const { context, writes, frames } = captureContext(24, 80, false)
  const result = await find("editing.insert-chars").term!(context)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "none",
  })
  expect(String(result.observation?.note)).toContain("no owned capture adapter")
  expect(writes).toEqual([])
  expect(frames).toEqual([])
})

/**
 * decsace converted with the attribute-cell kind (@cto 2026-10-18): on an adapter that reports
 * frames it measures BOTH extents. The stream frame is the control, so the arm is supported only
 * when DECSACE 2 and DECSACE 0 leave visibly different screens.
 */
test("editing.decsace measures both DECSACE extents when a capture adapter exists", async () => {
  const { context, frames } = captureContext(24, 80)
  const result = await find("editing.decsace").term!(context)
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "pixels" })
  expect(frames.map((frame) => frame.label)).toEqual([
    "editing.decsace: seed before DECSACE",
    "editing.decsace: DECSACE 2 rectangle frame",
    "editing.decsace: DECSACE 0 stream frame",
  ])
})

/**
 * A text-only double is the macOS case: its digest cannot see an attribute, so both extents read the
 * same frame. That must be inconclusive BY NAME — never a pass (nothing was separated) and never a
 * negative (the attribute may well have been applied).
 */
test("editing.decsace reads equal extents inconclusive by name, never supported", async () => {
  const { context, frames } = captureContext(24, 80)
  context.capture = async ({ role, label }) => {
    const frame = { role, label, capturedAt: 1, ref: `sha256:${"a".repeat(64)}` }
    frames.push(frame)
    return frame
  }
  const result = await find("editing.decsace").term!(context)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "pixels",
  })
  expect(String(result.observation?.note)).toContain("Both DECSACE extent modes left the same frame")
  expect(result.assertions).toBeUndefined()
  expect(frames).toHaveLength(3)
})

/**
 * The two converted attribute rows on a TEXT-ONLY adapter: the seed and the expected frame read the
 * same cells because only attributes changed, so the region oracle refuses by name. This is the macOS
 * census row (@cto 2026-10-18 condition 3) in executable form.
 */
test("an attribute row on a text-only adapter is inconclusive by name", async () => {
  for (const id of ["editing.deccara", "editing.decrara"]) {
    const row = editingReadbackRows.find((entry) => entry.id === id)
    if (!row?.sentinel) throw new Error(`missing sentinel for ${id}`)
    const { context } = readbackCaptureContext(24, 80, { row: row.sentinel.row, col: row.sentinel.col ?? 1 })
    const result = await find(id).term!(context)
    expect(result.observation, id).toMatchObject({ outcome: "inconclusive", evidence: "pixels" })
    expect(String(result.observation?.note), id).toContain("seed frame and the expected frame read the same cells")
    expect(result.assertions, id).toBeUndefined()
  }
})
