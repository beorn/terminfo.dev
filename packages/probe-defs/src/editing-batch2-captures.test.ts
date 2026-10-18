/**
 * @failure Editing capture fixtures advertised a cell-readback claim the application collector
 *   cannot make: they returned only a cursor-position measurement, with no pre-edit control or
 *   post-edit target a reviewer could judge. A missing capture branch must not silently change
 *   the cursor-only fallback, and an undersized terminal must refuse before writing.
 * @level l1
 * @consumer App probe pixel frames for editing operations.
 * @testonly none
 */
import { createHash } from "node:crypto"
import { expect, test } from "vitest"
import { parseObservationFrames } from "@terminfo/run-parser"
import { editingProbes, editingReadbackRows } from "./editing.ts"
import { createSemanticSurface } from "./testing/semantic-surface.ts"
import type { ObservationFrame, ProbeDefinition, TermContext, TermlessContext } from "./types.ts"

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
        pixelsDigest: `sha256:${String(frames.length + 1).repeat(64)}`,
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
 * A capture adapter that MODELS DECSACE and DECCARA instead of handing every capture its own
 * digest: the digest is a function of the cells the writes actually left on screen. A double that
 * invents a distinct digest per capture cannot fail on the arm's writes — a mutant that sets the
 * wrong extent, omits DECCARA, or grades the seed still earns three different digests and passes
 * (@cto round-2 B2, which reproduced exactly those three mutants at 7a364cac).
 *
 * The ref is deliberately CONSTANT: a frame pair compared by retained artifact would read "same
 * frame" here, so an arm that regressed to `ref` cannot pass this double.
 */
function decsaceCaptureContext() {
  const DECSACE_SEED_PAINT = "\x1b[0m\x1b[2J\x1b[H\x1b[1;1Habcdefgh\x1b[2;1Hijklmnop"
  const DECSACE_CARA = "\x1b[1;2;2;3;7$r"
  // The screen is the EXISTING semantic surface, not a private CUP/ED/DECSACE/DECCARA interpreter:
  // createSemanticSurface already models every one of those sequences (@cto round-3c B5), so this
  // double cannot drift from the terminal the probe says it models.
  const surface = createSemanticSurface({ rows: 2, cols: 8 })
  const frameWrites: string[] = []
  const writes: string[] = []
  let sinceCapture = ""
  const digest = () => {
    const painted = Array.from({ length: 2 }, (_, row) =>
      Array.from({ length: 8 }, (_, col) => {
        const cell = surface.getCell(row, col)
        return `${cell.inverse ? "#" : "."}${cell.char}`
      }).join(""),
    ).join("|")
    // A real digest spelling, so the observation this double produces can also be fed to the run
    // parser (@cto round-3c B1): a synthetic prefix would be refused at parse time.
    return `sha256:${createHash("sha256").update(painted).digest("hex")}`
  }

  const context: TermContext = {
    rows: 24,
    cols: 80,
    write: (sequence) => {
      writes.push(sequence)
      sinceCapture += sequence
      surface.feed(sequence)
    },
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
  }
  context.capture = async ({ role, label }) => {
    const frame: ObservationFrame = {
      role,
      label,
      capturedAt: frameWrites.length + 1,
      ref: `sha256:${"a".repeat(64)}`,
      pixelsDigest: digest(),
    }
    frameWrites.push(sinceCapture)
    sinceCapture = ""
    return frame
  }
  return { context, frameWrites, writes, seed: DECSACE_SEED_PAINT, cara: DECSACE_CARA }
}

/**
 * decsace converted with the attribute-cell kind (@cto 2026-10-18): on an adapter that reports
 * frames it measures BOTH extents. The stream frame is the control, so the arm is supported only
 * when DECSACE 2 and DECSACE 0 leave screens that differ from the seed AND from each other.
 */
test("editing.decsace grades the frames its own writes produced", async () => {
  const { context, frameWrites, writes, seed, cara } = decsaceCaptureContext()
  const result = await find("editing.decsace").term!(context)
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "pixels" })
  // The bytes each capture was taken after, in order: two reads of one static frame BEFORE any
  // DECSACE write (the shared stability pair), then the seed paint, DECSACE 2 + DECCARA, then
  // DECSACE 0 + DECCARA. A swapped, missing or late write changes this.
  expect(frameWrites).toEqual(["\x1b[0m\x1b[?25l", "", seed, `${seed}\x1b[2*x${cara}`, `${seed}\x1b[0*x${cara}`])
  // The observation cites the three DECIDED frames; the stability pair is the first two buckets
  // above and exists as evidence in the arm's own sequence, not as frames to grade.
  const frames = (result.observation?.frames ?? []) as ObservationFrame[]
  expect(frames.map((frame) => frame.label)).toEqual([
    "editing.decsace: seed before DECSACE",
    "editing.decsace: DECSACE 2 rectangle frame",
    "editing.decsace: DECSACE 0 stream frame",
  ])
  const observed = JSON.parse(String(result.assertions?.[0]?.observed)) as Record<string, string>
  expect(observed.kind).toBe("whole")
  expect(observed.seed).not.toBe(observed.rectangle)
  expect(observed.seed).not.toBe(observed.stream)
  expect(observed.rectangle).not.toBe(observed.stream)
  // The shared lifecycle closes as well as opens: DECTCEM restored and the screen reset on the way
  // out, so the next probe on this terminal does not inherit a hidden cursor (@dev/review2 R3 B1).
  expect(writes).toContain("\x1b[?25h")
  expect(writes.at(-1)).toBe("\x1b[0m\x1b[2J\x1b[H")
})

test("editing.decsace restores the cursor when a capture throws", async () => {
  const { context, writes } = decsaceCaptureContext()
  context.capture = async () => {
    throw new Error("capture failed")
  }
  await expect(find("editing.decsace").term!(context)).rejects.toThrow(/capture failed/)
  expect(writes).toContain("\x1b[?25h")
  expect(writes.at(-1)).toBe("\x1b[0m\x1b[2J\x1b[H")
})

test("editing.decsace clears its DECSACE extent before restoring the cursor", async () => {
  const { context, writes } = decsaceCaptureContext()
  const original = context.capture!
  context.capture = async (request) => {
    if (request.label === "editing.decsace: DECSACE 2 rectangle frame") throw new Error("rectangle capture failed")
    return original(request)
  }
  await expect(find("editing.decsace").term!(context)).rejects.toThrow(/rectangle capture failed/)
  // DECSACE 2 is a terminal MODE: the next probe would read it if the throw path skipped the reset,
  // and 2J does not clear it (@cto round-3c B4). The cleanup must land BEFORE DECTCEM is restored.
  const cleanup = writes.indexOf("\x1b[0*x")
  const restored = writes.indexOf("\x1b[?25h")
  expect(cleanup).toBeGreaterThanOrEqual(0)
  expect(restored).toBeGreaterThan(cleanup)
  expect(writes.at(-1)).toBe("\x1b[0m\x1b[2J\x1b[H")
})

test("editing.decsace parser arm refuses a grid below its 2x8 fixture", () => {
  const definition = find("editing.decsace")
  /**
   * The parser arm reads cols, feed, getCell and the scrollback. A surface has no title or
   * capability census, so those two are named empty here rather than spread in as absent members.
   */
  const termless = (rows: number, cols: number): TermlessContext => {
    const surface = createSemanticSurface({ rows, cols })
    const feedCapture = surface.feedCapture
    const getScrollback = surface.getScrollback
    if (feedCapture === undefined || getScrollback === undefined) {
      throw new Error("the semantic surface lacks a reader the parser arm needs")
    }
    return {
      cols: surface.cols,
      feed: surface.feed,
      feedCapture,
      getCell: surface.getCell,
      getCursor: surface.getCursor,
      getMode: surface.getMode,
      getText: surface.getText,
      getScrollback,
      getTitle: () => "",
      reset: surface.reset,
      capabilities: {
        truecolor: false,
        kittyKeyboard: false,
        kittyGraphics: false,
        sixel: false,
        osc8Hyperlinks: false,
        semanticPrompts: false,
        reflow: false,
        unicode: "",
        extensions: new Set<string>(),
      },
    }
  }
  const refused = definition.termless!(termless(1, 8))
  expect(refused.observation).toMatchObject({ outcome: "inconclusive" })
  expect(String(refused.observation?.note)).toContain("Need a measured 2x8 fixture")
  const exact = definition.termless!(termless(2, 8))
  expect(exact.observation?.outcome).toBe("supported")
  expect(String(exact.assertions?.[0]?.observed)).toContain("##")
})

test("editing.decsace without a capture adapter still clears its DECSACE extent", async () => {
  const { context, writes } = captureContext(24, 80, false)
  const result = await find("editing.decsace").term!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive" })
  // The no-capture branch runs no lifecycle, so the mode reset is its own job (@cto round-3c B4).
  expect(writes.join("")).toContain("\x1b[2*x")
  expect(writes.join("")).toContain("\x1b[0*x")
})

test("editing.decsace observations carry a target screenshotRef the run parser accepts", async () => {
  const { context } = decsaceCaptureContext()
  const result = await find("editing.decsace").term!(context)
  const observation = result.observation
  const frames = (observation?.frames ?? []) as ObservationFrame[]
  const evidence = observation?.evidence
  if (evidence === undefined) throw new Error("the DECSACE arm returned no evidence kind")
  expect(evidence).toBe("pixels")
  expect(observation?.screenshotRef).toBeDefined()
  const refs = frames.map((frame) => frame.ref)
  // The arm returns pixels for every outcome, and the run parser refuses a pixels observation
  // without a screenshotRef and a non-target citation (@cto round-3c B1). Feeding the arm's own
  // observation through that parser is the test that catches it.
  expect(() =>
    parseObservationFrames(frames, "test", "editing.decsace", refs, [], observation?.screenshotRef, evidence),
  ).not.toThrow()
})

/**
 * A text-only double is the macOS case: its digest cannot see an attribute, so both extents read the
 * same frame. That must be inconclusive BY NAME — never a pass (nothing was separated) and never a
 * negative (the attribute may well have been applied).
 */
test("editing.decsace reads equal extents inconclusive by name, never supported", async () => {
  const { context, frames } = captureContext(24, 80)
  context.capture = async ({ role, label }) => {
    const frame = {
      role,
      label,
      capturedAt: 1,
      ref: `sha256:${"a".repeat(64)}`,
      pixelsDigest: `sha256:${"a".repeat(64)}`,
    }
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
  // Two stability reads before the paint, then the seed and the two extent frames: the pair is the
  // shared control every pixel arm runs (@cto round-3c B2), so it is part of this arm's sequence.
  expect(frames).toHaveLength(5)
})

/**
 * P2 from review2 source audit 97414a37: `ref` is the RETAINED ARTIFACT, and the shared type says
 * encoded container chunks can differ between identical images. Comparing refs alone therefore lets
 * unchanged pixels read as a measured extent difference. The arm must compare the frame kind measured
 * digest (pixelsDigest for pixels, cellDigest for text cells) and name the gap when one is absent.
 */
test("editing.decsace compares measured digests, not retained artifact refs", async () => {
  const { context } = captureContext(24, 80)
  let reads = 0
  context.capture = async ({ role, label }) => {
    reads += 1
    // Three DIFFERENT artifact refs over ONE measured screen: the encoded bytes differ, the
    // measurement does not.
    return {
      role,
      label,
      capturedAt: reads,
      ref: `sha256:${String(reads).repeat(64)}`,
      pixelsDigest: `sha256:${"f".repeat(64)}`,
    }
  }
  const result = await find("editing.decsace").term!(context)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "pixels",
  })
  expect(String(result.observation?.note)).toContain("same frame")
  expect(result.assertions).toBeUndefined()
})

test("editing.decsace names an adapter that reports no measured digest", async () => {
  const { context } = captureContext(24, 80)
  let reads = 0
  context.capture = async ({ role, label }) => {
    reads += 1
    // The stability pair reports a digest, so the refusal below is the FRAME-kind rule, not the
    // earlier stability refusal: this test keeps the two named refusals distinguishable.
    return {
      role,
      label,
      capturedAt: reads,
      ref: `sha256:${String(reads).repeat(64)}`,
      ...(reads <= 2 ? { pixelsDigest: `sha256:${"0".repeat(64)}` } : {}),
    }
  }
  const result = await find("editing.decsace").term!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(String(result.observation?.note)).toContain("do not all report one measured digest kind")
  expect(result.assertions).toBeUndefined()
})

/**
 * @cto round-2 B1a: a per-frame `whole ?? cells` can compare one frame's whole-window digest with
 * another frame's region digest — those never match, so the mismatch reads as a measured extent
 * difference. One kind must be present on ALL three frames, or the row is inconclusive.
 */
test("editing.decsace refuses frames whose measured digests are of different kinds", async () => {
  const { context } = captureContext(24, 80)
  let reads = 0
  context.capture = async ({ role, label }) => {
    reads += 1
    const frame: ObservationFrame = {
      role,
      label,
      capturedAt: reads,
      ref: `sha256:${String(reads).repeat(64)}`,
      ...(reads === 4 ? { regionDigest: `sha256:${"c".repeat(64)}` } : { pixelsDigest: `sha256:${"p".repeat(64)}` }),
    }
    return frame
  }
  const result = await find("editing.decsace").term!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(String(result.observation?.note)).toContain("one measured digest kind")
  expect(result.assertions).toBeUndefined()
})

/**
 * @cto round-2 B1b: the cursor is hidden and two captures of one static frame must agree, exactly as
 * the capture-region oracle requires (region-readback.ts). A frame that moved between two reads of
 * the same static screen cannot decide anything.
 */
test("editing.decsace refuses a capture that is not byte-stable", async () => {
  const { context } = captureContext(24, 80)
  let reads = 0
  context.capture = async ({ role, label }) => {
    reads += 1
    const mark = String(reads).repeat(64)
    return {
      role,
      label,
      capturedAt: reads,
      ref: `sha256:${mark}`,
      regionDigest: `sha256:${mark}`,
      pixelsDigest: `sha256:${mark}`,
    }
  }
  const result = await find("editing.decsace").term!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(String(result.observation?.note)).toContain("not byte-stable")
  expect(result.assertions).toBeUndefined()
  // The same ONE shape the region oracle emits (@cto round-3c B3): the two reads in the response,
  // the second capture cited, and no fabricated frame on a path that never reached a target.
  const response = JSON.parse(String(result.response)) as {
    stability: { regionDigest: string[]; pixelsDigest: string[] }
  }
  expect(response.stability.regionDigest).toEqual([`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`])
  expect(response.stability.pixelsDigest).toEqual([`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`])
  expect(result.observation?.screenshotRef).toBe(`sha256:${"2".repeat(64)}`)
  expect(result.observation?.frames ?? []).toHaveLength(0)
})

/**
 * @cto round-2 B2 mutant 2: a frame that did not move from the seed has measured no change at all,
 * so an ignored DECCARA cannot be separated from a digest that cannot see attributes.
 */
test("editing.decsace refuses a target frame that did not move from the seed", async () => {
  const { context } = captureContext(24, 80)
  let reads = 0
  context.capture = async ({ role, label }) => {
    reads += 1
    // Order: two stability reads, the seed paint, then the rectangle and the stream extents.
    const digest = reads <= 2 ? "stable" : reads === 3 ? "seed" : reads === 4 ? "rect" : "seed"
    return { role, label, capturedAt: reads, ref: `sha256:${digest}`, pixelsDigest: `sha256:${digest}` }
  }
  const result = await find("editing.decsace").term!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(String(result.observation?.note)).toContain("stream frame did not differ from the seed")
  expect(result.assertions).toBeUndefined()
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

/**
 * The expected frame must carry the row's actual cell attributes: DECCARA sets inverse inside
 * the rectangle and DECRARA clears it. Read only the expected phase through the existing semantic
 * surface, so a seed or target frame cannot satisfy this pin. Keep one surface across all writes
 * to preserve the terminal's SGR state between phases.
 */
test.each(["editing.deccara", "editing.decrara"])("%s paints its expected cells and inverse flags", async (id) => {
  const row = editingReadbackRows.find((entry) => entry.id === id)
  if (!row?.sentinel) throw new Error(`missing sentinel for ${id}`)
  const { context, writes } = readbackCaptureContext(24, 80, {
    row: row.sentinel.row,
    col: row.sentinel.col ?? 1,
  })
  const surface = createSemanticSurface({ rows: 24, cols: 80 })
  const write = context.write
  context.write = (bytes) => {
    write(bytes)
    surface.feed(bytes)
  }
  const capture = context.capture!
  const expectedFrames: { char: string; inverse: boolean }[][][] = []
  context.capture = async (request) => {
    if (request.label === `${id}: expected frame`) {
      expect(request.cells).toEqual({ top: 1, left: 1, bottom: 3, right: 6 })
      expectedFrames.push(
        Array.from({ length: 3 }, (_, cellRow) =>
          Array.from({ length: 6 }, (_, cellCol) => {
            const cell = surface.getCell(cellRow, cellCol)
            return { char: cell.char, inverse: cell.inverse }
          }),
        ),
      )
    }
    return capture(request)
  }
  await find(id).term!(context)
  // The row sets DECSACE 2 to measure the rectangle extent, so the shared lifecycle must clear the
  // MODE before DECTCEM comes back: 2J does not reset it (@cto round-3c B4).
  expect(writes).toContain("\x1b[0*x")
  expect(writes.indexOf("\x1b[?25h")).toBeGreaterThan(writes.indexOf("\x1b[0*x"))
  expect(expectedFrames).toEqual([
    ["aaaaaZ", "bbbbbY", "cccccX"].map((characters) =>
      [...characters].map((char, col) => ({ char, inverse: id === "editing.deccara" && col < 5 })),
    ),
  ])
})
