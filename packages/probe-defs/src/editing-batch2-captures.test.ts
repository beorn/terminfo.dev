/**
 * @failure Editing capture fixtures advertised a cell-readback claim the application collector
 *   cannot make: they returned only a cursor-position measurement, with no pre-edit control or
 *   post-edit target a reviewer could judge. A missing capture branch must not silently change
 *   the cursor-only fallback, and an undersized terminal must refuse before writing. The DECSACE
 *   parser arm must classify its recorded frame pair: a measured ignore of either extent is a
 *   negative, and a DECCARA that inverts nothing leaves the extent unobservable (#30702).
 * @level l1
 * @consumer App probe pixel frames for editing operations.
 * @testonly none
 */
import { createHash } from "node:crypto"
import { expect, test } from "vitest"
import { parseObservationFrames } from "@terminfo/run-parser"
import { editingProbes, editingReadbackRows } from "./editing.ts"
import { captureStabilityPair } from "./region-readback.ts"
import { libProbeSource } from "./testing/group-harness.ts"
import { createSemanticSurface } from "./testing/semantic-surface.ts"
import type { ObservationFrame, ProbeDefinition, TermProbeSource, LibProbeSource } from "./types.ts"

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

function captureSource(rows: number, cols: number, withCapture = true) {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const context: TermProbeSource = {
    kind: "live",
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
    const { context, writes, frames } = captureSource(24, 80)
    const result = await find(id).term!(context)
    expect(result.observation, id).toBeUndefined()
    expect(result.tests, id).toMatchObject([
      { id: "criterion", status: "test-failure", reason: expect.stringContaining("cell size in pixels") },
    ])
    expect(String(result.tests?.[0]?.reason), id).toContain("CSI 16 t")
    expect(frames, id).toEqual([])
    expect(writes, id).toEqual([])
  }
})

/**
 * A window whose cells are readable: CSI 16 t and CSI 14 t answer the terminal's own pixel report,
 * the witness cell shows the last glyph written, and the compared cells never move — so the row
 * reaches the decision and its spec, without claiming any capability.
 */
function readbackCaptureSource(rows: number, cols: number, witness = { row: 3, col: 1 }) {
  const writes: string[] = []
  const requests: Array<{ region: { top: number; left: number; bottom: number; right: number }; label: string }> = []
  const frames: ObservationFrame[] = []
  let reads = 0
  const sentinel = `${witness.row},${witness.col},${witness.row},${witness.col}`
  const key = (region: { top: number; left: number; bottom: number; right: number }) =>
    `${region.top},${region.left},${region.bottom},${region.right}`
  const context: TermProbeSource = {
    kind: "live",
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
  const { context, requests } = readbackCaptureSource(24, 80)
  const result = await find("editing.delete-chars").term!(context)
  expect(result.observation?.outcome).toBe("inconclusive")
  expect(String(result.observation?.note)).toContain("seed frame and the expected frame read the same cells")
  const compared = requests.filter(({ region }) => region.right !== region.left || region.bottom !== region.top)
  expect(compared.map(({ region }) => region)).toEqual([
    { top: 1, left: 1, bottom: 1, right: 8 },
    { top: 1, left: 1, bottom: 1, right: 8 },
    { top: 1, left: 1, bottom: 1, right: 8 },
    { top: 1, left: 1, bottom: 1, right: 8 },
    { top: 1, left: 1, bottom: 1, right: 8 },
  ])
  expect(compared.map(({ label }) => label)).toEqual([
    "editing.delete-chars: capture stability 1",
    "editing.delete-chars: capture stability 2",
    "editing.delete-chars: pre-edit seed",
    "editing.delete-chars: post-sequence target",
    "editing.delete-chars: expected frame",
  ])
})

test("the readback-governed row refuses by name when the terminal cannot report its pixel geometry", async () => {
  const { context, frames } = captureSource(24, 80)
  const result = await find("editing.delete-chars").term!(context)
  expect(result.observation).toBeUndefined()
  expect(result.tests).toMatchObject([
    { id: "criterion", status: "test-failure", reason: expect.stringContaining("cell size in pixels") },
  ])
  expect(String(result.tests?.[0]?.reason)).toContain("CSI 16 t")
  expect(frames).toEqual([])
})

test("an undersized terminal refuses an editing capture before writing", async () => {
  for (const id of CAPTURE_IDS) {
    const { context, writes, frames } = captureSource(1, 1)
    const result = await find(id).term!(context)
    expect(result.observation, id).toBeUndefined()
    expect(result, id).toMatchObject({
      tests: [
        expect.objectContaining({
          status: "test-todo",
          reason: expect.stringMatching(
            new RegExp(
              `^${id}: capture-region readback needs a measured grid of at least [0-9]+x[0-9]+; measured 1x1$`,
            ),
          ),
        }),
      ],
    })
    expect(writes, id).toEqual([])
    expect(frames, id).toEqual([])
  }
})

test("a seed at the very edge refuses so it cannot wrap or scroll the captured region", async () => {
  // insert-chars compares one nine-column row with its witness on row 3, so the kind DERIVES a floor of
  // 3 rows by 9 + the family's two-column margin = 11 columns.
  const tight = captureSource(1, 8)
  const tightResult = await find("editing.insert-chars").term!(tight.context)
  expect(tightResult.observation).toBeUndefined()
  expect(tightResult).toMatchObject({
    tests: [
      expect.objectContaining({
        status: "test-todo",
        reason: "editing.insert-chars: capture-region readback needs a measured grid of at least 3x11; measured 1x8",
      }),
    ],
  })
  expect(tight.writes).toEqual([])
  const margins = captureSource(2, 11)
  const refused = await find("editing.insert-chars").term!(margins.context)
  expect(refused.observation).toBeUndefined()
  expect(refused).toMatchObject({
    tests: [
      expect.objectContaining({
        status: "test-todo",
        reason: "editing.insert-chars: capture-region readback needs a measured grid of at least 3x11; measured 2x11",
      }),
    ],
  })
  expect(margins.writes).toEqual([])
  expect(margins.frames).toEqual([])
  // One column short of the derived floor still refuses: the margin is what stops the seed wrapping.
  const narrow = captureSource(3, 10)
  const narrowResult = await find("editing.insert-chars").term!(narrow.context)
  expect(narrowResult.observation).toBeUndefined()
  expect(narrowResult).toMatchObject({
    tests: [
      expect.objectContaining({
        status: "test-todo",
        reason: "editing.insert-chars: capture-region readback needs a measured grid of at least 3x11; measured 3x10",
      }),
    ],
  })
  expect(narrow.writes).toEqual([])
  expect(narrow.frames).toEqual([])
  // Exactly the derived floor opens the guards: the row moves on to the pixel report, no paint yet.
  const fit = captureSource(3, 11)
  const fitting = await find("editing.insert-chars").term!(fit.context)
  expect(fitting.observation).toBeUndefined()
  expect(fitting.tests).toMatchObject([
    { id: "criterion", status: "test-failure", reason: expect.stringContaining("cell size in pixels") },
  ])
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
 * keeping an ungraded CPR fixture alive (28450 A2). `editing.decsace` and `editing.decrqcra` keep their
 * own callbacks; the two attribute-rectangle rows converted to the kind with decsace, so their extent
 * refusals are the kind's own (`editing-geometry.test.ts`).
 */
test("without a capture adapter a converted row refuses by name and writes nothing", async () => {
  const { context, writes, frames } = captureSource(24, 80, false)
  const result = await find("editing.insert-chars").term!(context)
  expect(result.observation).toBeUndefined()
  expect(result).toMatchObject({
    tests: [
      expect.objectContaining({
        status: "test-todo",
        reason:
          "editing.insert-chars: no owned capture adapter is installed in this run, so the region fixture cannot be read back",
      }),
    ],
  })
  expect(String(result.tests?.[0]?.reason)).toContain("no owned capture adapter")
  expect(writes).toEqual([])
  expect(frames).toEqual([])
})

const DECSACE_GEOMETRY = {
  geometry: { cellWidth: 8, cellHeight: 16, textWidth: 640, textHeight: 384 },
  source: "measured by complete raster calibration",
} as const
const DECSACE_RECTANGLE = { x: 0, y: 0, width: 64, height: 32 }

function decsacePixelSource() {
  const fixture = captureSource(24, 80)
  fixture.context.captureGeometry = DECSACE_GEOMETRY
  return fixture
}

/**
 * A capture adapter that MODELS DECSACE and DECCARA instead of handing every capture its own
 * digest: the digest is a function of the cells the writes actually left on screen. A double that
 * invents a distinct digest per capture cannot fail on the arm's writes — a mutant that sets the
 * wrong extent, omits DECCARA, or grades the seed still earns three different digests and passes.
 *
 * Each frame carries a DISTINCT ref, so the run parser's citation rule can fail on this double: a
 * pixel return that cites a control frame, or drops its citation, is refused. A comparison that
 * regressed to `ref` is caught by the digest-versus-ref row below, which gives one measured screen
 * three different refs.
 */
function decsaceCaptureSource() {
  const DECSACE_SEED_PAINT = "\x1b[0m\x1b[2J\x1b[H\x1b[1;1Habcdefgh\x1b[2;1Hijklmnop"
  const DECSACE_CARA = "\x1b[1;2;2;3;7$r"
  // The screen is the EXISTING semantic surface, not a private CUP/ED/DECSACE/DECCARA interpreter:
  // createSemanticSurface already models every one of those sequences, so this
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
    // parser: a synthetic prefix would be refused at parse time.
    return `sha256:${createHash("sha256").update(painted).digest("hex")}`
  }

  const context: TermProbeSource = {
    kind: "live",
    rows: 24,
    cols: 80,
    captureGeometry: DECSACE_GEOMETRY,
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
    const index = frameWrites.length + 1
    const frame: ObservationFrame = {
      role,
      label,
      capturedAt: index,
      ref: `sha256:${createHash("sha256").update(`${index}:${label}`).digest("hex")}`,
      regionDigest: digest(),
      pixelsDigest: `sha256:${createHash("sha256")
        .update("whole:" + digest())
        .digest("hex")}`,
      regionRectangle: DECSACE_RECTANGLE,
    }
    frameWrites.push(sinceCapture)
    sinceCapture = ""
    return frame
  }
  return { context, frameWrites, writes, seed: DECSACE_SEED_PAINT, cara: DECSACE_CARA }
}

/**
 * DECSACE converted with the attribute-cell kind: on an adapter that reports frames it measures
 * BOTH extents. The stream frame is the control, so the arm is supported only when DECSACE 2 and
 * DECSACE 0 leave screens that differ from the seed AND from each other.
 */
test("editing.decsace grades the frames its own writes produced", async () => {
  const { context, frameWrites, writes, seed, cara } = decsaceCaptureSource()
  const result = await find("editing.decsace").term!(context)
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "screenshot" })
  // The bytes each capture was taken after, in order: the seed paint, the pair's two reads of that
  // SEEDED screen, then DECSACE 2 + DECCARA, then DECSACE 0 + DECCARA. The seed frame is the pair's
  // second read, so a pair taken before the paint changes this.
  expect(frameWrites).toEqual([`\x1b[0m\x1b[?25l${seed}`, "", `${seed}\x1b[2*x${cara}`, `${seed}\x1b[0*x${cara}`])
  // The observation cites the seed — the pair's second read — and the two extent frames; the
  // pair's first read is evidence in the arm's own sequence, not a frame to grade.
  const frames = (result.observation?.frames ?? []) as ObservationFrame[]
  expect(frames.map((frame) => frame.label)).toEqual([
    "editing.decsace: seed stability 2",
    "editing.decsace: DECSACE 2 rectangle frame",
    "editing.decsace: DECSACE 0 stream frame",
  ])
  const observed = JSON.parse(String(result.assertions?.[0]?.observed)) as Record<string, string>
  expect(observed.kind).toBe("cells")
  expect(observed.seed).not.toBe(observed.rectangle)
  expect(observed.seed).not.toBe(observed.stream)
  expect(observed.rectangle).not.toBe(observed.stream)
  // The shared lifecycle closes as well as opens: DECTCEM restored and the screen reset on the way
  // out, so the next probe on this terminal does not inherit a hidden cursor.
  expect(writes).toContain("\x1b[?25h")
  expect(writes.at(-1)).toBe("\x1b[0m\x1b[2J\x1b[H")
})

test("editing.decsace restores the cursor when a capture throws", async () => {
  const { context, writes } = decsaceCaptureSource()
  context.capture = async () => {
    throw new Error("capture failed")
  }
  await expect(find("editing.decsace").term!(context)).rejects.toThrow(/capture failed/)
  expect(writes).toContain("\x1b[?25h")
  expect(writes.at(-1)).toBe("\x1b[0m\x1b[2J\x1b[H")
})

test("editing.decsace clears its DECSACE extent before restoring the cursor", async () => {
  const { context, writes } = decsaceCaptureSource()
  const original = context.capture!
  context.capture = async (request) => {
    if (request.label === "editing.decsace: DECSACE 2 rectangle frame") throw new Error("rectangle capture failed")
    return original(request)
  }
  await expect(find("editing.decsace").term!(context)).rejects.toThrow(/rectangle capture failed/)
  // DECSACE 2 is a terminal MODE: the next probe would read it if the throw path skipped the reset,
  // and 2J does not clear it. The cleanup must land BEFORE DECTCEM is restored.
  const cleanup = writes.indexOf("\x1b[0*x")
  const restored = writes.indexOf("\x1b[?25h")
  expect(cleanup).toBeGreaterThanOrEqual(0)
  expect(restored).toBeGreaterThan(cleanup)
  expect(writes.at(-1)).toBe("\x1b[0m\x1b[2J\x1b[H")
})

test("editing.decsace parser arm refuses a grid below its 2x8 fixture", () => {
  const definition = find("editing.decsace")
  // A semantic surface already supplies every field the parser arm reads, and the shared headless
  // harness fills the inert remainder, so this test carries no hand-built context.
  const lib = (rows: number, cols: number) => libProbeSource(createSemanticSurface({ rows, cols }))
  const refused = definition.lib!(lib(1, 8))
  expect(refused.observation).toMatchObject({ outcome: "inconclusive" })
  expect(String(refused.observation?.note)).toContain("Need a measured 2x8 fixture")
  // The floor has two halves: the row needs two rows AND eight columns.
  const narrow = definition.lib!(lib(2, 7))
  expect(narrow.observation).toMatchObject({ outcome: "inconclusive" })
  expect(String(narrow.observation?.note)).toContain("Need a measured 2x8 fixture")
  const exact = definition.lib!(lib(2, 8))
  expect(exact.observation?.outcome).toBe("supported")
  expect(String(exact.assertions?.[0]?.observed)).toContain("##")
})

const DECSACE_RECT = ".##.....|.##....."
const DECSACE_STREAM = ".#######|###....."

/**
 * A 2x8 headless model whose cells after each DECSACE extent's DECCARA carry exactly the declared
 * inverse pattern, so a test states the frame pair a terminal recorded and reads the arm's class.
 */
function decsacePairSource(rect: string, stream: string): LibProbeSource {
  const chars = ["abcdefgh", "ijklmnop"]
  let pattern = ""
  return libProbeSource({
    cols: 8,
    feed: (text) => {
      if (text.includes("\x1b[2*x")) pattern = rect
      else if (text.includes("\x1b[0*x")) pattern = stream
    },
    getCell: (row, col) =>
      ({ char: chars[row]?.[col] ?? " ", inverse: pattern.split("|")[row]?.[col] === "#" }) as ReturnType<
        LibProbeSource["getCell"]
      >,
    getCursor: () => ({ x: 0, y: 0, visible: true, style: null }),
  })
}

test.each([
  ["the honoured pair", "supported", DECSACE_RECT, DECSACE_STREAM, undefined],
  ["both frames on the stream pattern", "unsupported", DECSACE_STREAM, DECSACE_STREAM, "DECSACE 2 was ignored"],
  ["both frames on the rectangle pattern", "unsupported", DECSACE_RECT, DECSACE_RECT, "DECSACE 0 was ignored"],
] as const)("editing.decsace grades %s %s from the recorded frames", (_label, outcome, rect, stream, note) => {
  const result = find("editing.decsace").lib!(decsacePairSource(rect, stream))
  expect(result.observation).toMatchObject({ outcome, assertionType: "buffer_state" })
  if (note) expect(String(result.observation?.note)).toContain(note)
  expect(result.assertions).toMatchObject([{ kind: outcome === "supported" ? "positive" : "negative" }])
  expect(JSON.parse(result.response ?? "{}")).toEqual({ rect, stream })
})

test("editing.decsace with no inverse cell in either frame records the extent as unobservable (TEST TODO)", () => {
  const none = "........|........"
  const result = find("editing.decsace").lib!(decsacePairSource(none, none))
  expect(result.pass).toBe(false)
  expect(result.observation).toBeUndefined()
  expect(result.notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable: "DECCARA not honoured, extent unobservable",
  })
  expect(result.assertions).toBeUndefined()
})

test("editing.decsace keeps any other agreeing pair inconclusive by name, never a pass", () => {
  const corner = ".#......|........"
  const result = find("editing.decsace").lib!(decsacePairSource(corner, corner))
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(String(result.observation?.note)).toContain("neither the rectangle nor the stream extent")
  expect(result.assertions).toBeUndefined()
})

test("editing.decsace keeps a differing pair that is not the two extents inconclusive by name, never a verdict", () => {
  for (const [rect, stream] of [
    [DECSACE_STREAM, DECSACE_RECT],
    [DECSACE_RECT, ".#......|........"],
  ] as const) {
    const label = `rect ${rect} stream ${stream}`
    const result = find("editing.decsace").lib!(decsacePairSource(rect, stream))
    expect(result.observation, label).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(String(result.observation?.note), label).toContain("differ but are not the rectangle and stream extents")
    expect(result.assertions, label).toBeUndefined()
    expect(JSON.parse(result.response ?? "{}"), label).toEqual({ rect, stream })
  }
})

test("editing.decsace without a capture adapter still clears its DECSACE extent", async () => {
  const { context, writes } = captureSource(24, 80, false)
  const result = await find("editing.decsace").term!(context)
  expect(result.observation).toBeUndefined()
  expect(result.tests).toEqual([
    {
      id: "criterion",
      status: "test-failure",
      reason: "No cursor response after attributes set by DECCARA under a DECSACE extent",
    },
  ])
  // The no-capture branch runs no lifecycle, so the mode reset is its own job: DECSACE 2 is set and
  // then cleared, in that order, because a run that leaves the extent mode set changes the next
  // probe's DECCARA/DECRARA reach.
  const sequence = writes.join("")
  expect(sequence).toContain("\x1b[2*x")
  expect(sequence.indexOf("\x1b[0*x")).toBeGreaterThan(sequence.indexOf("\x1b[2*x"))
})

/**
 * The arm returns pixels on four paths — supported, equal extents, no measured digest, and a target
 * that did not move from the seed. Every one of them is fed through the run parser's own rules with
 * a DISTINCT ref per frame, so a return that cites a control frame or drops its citation fails here
 * rather than shipping. The refs handed to the parser are the frames' own, so the parser's
 * absent-ref clause cannot fire on this arm; the two failures above are the ones it can produce.
 */
test("every DECSACE pixel return carries target frames with a valid screenshot citation", async () => {
  const counted = (digestOf: (reads: number) => string | undefined) => () => {
    const { context } = decsacePixelSource()
    let reads = 0
    context.capture = async ({ role, label }) => {
      reads += 1
      const pixelsDigest = digestOf(reads)
      return {
        role,
        label,
        capturedAt: reads,
        ref: `sha256:${String(reads).repeat(64)}`,
        ...(pixelsDigest === undefined ? {} : { regionDigest: pixelsDigest, pixelsDigest }),
        regionRectangle: DECSACE_RECTANGLE,
      }
    }
    return context
  }
  const returns: Array<{ name: string; build: () => TermProbeSource; outcome: string; note: string }> = [
    {
      name: "supported",
      build: () => decsaceCaptureSource().context,
      outcome: "supported",
      note: "differ from the seed and from each other",
    },
    {
      name: "equal extents",
      build: counted(() => `sha256:${"f".repeat(64)}`),
      outcome: "inconclusive",
      note: "Both DECSACE extent modes left the same frame",
    },
    {
      name: "no measured digest",
      build: counted((reads) => (reads <= 2 ? `sha256:${"0".repeat(64)}` : undefined)),
      outcome: "inconclusive",
      note: "without the required pixel cells digest and rectangle",
    },
    {
      name: "target did not move",
      build: counted((reads) => `sha256:${(reads === 3 ? "b" : "a").repeat(64)}`),
      outcome: "inconclusive",
      note: "stream frame did not differ from the seed",
    },
  ]
  for (const { name, build, outcome, note } of returns) {
    const result = await find("editing.decsace").term!(build())
    const observation = result.observation
    if (observation === undefined) throw new Error(`${name}: the DECSACE arm returned no observation`)
    expect(observation.outcome, name).toBe(outcome)
    expect(String(observation.note), name).toContain(note)
    expect(observation.assertionType, name).toBe("screenshot")
    const frames = (observation.frames ?? []) as ObservationFrame[]
    if (name === "no measured digest") {
      const measured = frames.find((frame) => frame.kind !== "text-cells" && frame.pixelsDigest !== undefined)
      const missing = frames.find((frame) => frame.kind !== "text-cells" && frame.pixelsDigest === undefined)
      if (!measured || !missing) throw new Error("Missing measured/unmeasured capture controls")
      for (const [first, second] of [
        [measured, missing],
        [missing, measured],
        [missing, missing],
      ] as const) {
        const { stability } = await captureStabilityPair(
          "editing.decsace",
          "screenshot",
          async () => ({ frame: first }),
          async () => ({ frame: second }),
        )
        expect(stability.wholeWindowChanged).toBeNull()
      }
    }
    const refs = frames.map((frame) => frame.ref)
    expect(new Set(refs).size, name).toBe(refs.length)
    // The parser is the witness, not this test: a dropped citation and a citation of a control
    // frame both fail its own rules, so each red names the rule the arm has to satisfy.
    expect(
      () =>
        parseObservationFrames(frames, "test", "editing.decsace", refs, [], observation.screenshotRef, "screenshot"),
      name,
    ).not.toThrow()
    expect(observation.screenshotRef, name).toBeDefined()
  }
})

/**
 * An attribute-blind pixel double leaves both extents as the same measured cell region. That must be inconclusive BY NAME — never a pass (nothing was separated) and never a
 * negative (the attribute may well have been applied).
 */
test("editing.decsace reads equal extents inconclusive by name, never supported", async () => {
  const { context, frames } = decsacePixelSource()
  context.capture = async ({ role, label }) => {
    const frame = {
      role,
      label,
      capturedAt: 1,
      ref: `sha256:${"a".repeat(64)}`,
      regionDigest: `sha256:${"a".repeat(64)}`,
      pixelsDigest: `sha256:${"a".repeat(64)}`,
      regionRectangle: DECSACE_RECTANGLE,
    }
    frames.push(frame)
    return frame
  }
  const result = await find("editing.decsace").term!(context)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    assertionType: "screenshot",
  })
  expect(String(result.observation?.note)).toContain("Both DECSACE extent modes left the same frame")
  expect(result.assertions).toBeUndefined()
  // The seed paint, the pair's two reads of that seeded screen, then the two extent frames: the pair
  // is the shared control every pixel arm runs, so it is part of this arm's sequence and the seed
  // frame is its second read.
  expect(frames).toHaveLength(4)
})

/**
 * `ref` is the RETAINED ARTIFACT, and the shared type says
 * encoded container chunks can differ between identical images. Comparing refs alone therefore lets
 * unchanged pixels read as a measured extent difference. The arm must compare the frame kind measured
 * cell-region digest and name the gap when one is absent; whole-window changes cannot decide this arm.
 */
test("editing.decsace compares measured digests, not retained artifact refs", async () => {
  const { context } = decsacePixelSource()
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
      regionDigest: `sha256:${"f".repeat(64)}`,
      pixelsDigest: `sha256:${"f".repeat(64)}`,
      regionRectangle: DECSACE_RECTANGLE,
    }
  }
  const result = await find("editing.decsace").term!(context)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    assertionType: "screenshot",
  })
  expect(String(result.observation?.note)).toContain("same frame")
  expect(result.assertions).toBeUndefined()
})

test("editing.decsace names an adapter that reports no measured digest", async () => {
  const { context } = decsacePixelSource()
  let reads = 0
  context.capture = async ({ role, label }) => {
    reads += 1
    // The pair's two reads agree, so the refusal below is the frame-kind rule: a frame that
    // reports no measured digest is named by the arm that compares the frames, not by the
    // stability control.
    return {
      role,
      label,
      capturedAt: reads,
      ref: `sha256:${String(reads).repeat(64)}`,
      ...(reads <= 2 ? { regionDigest: `sha256:${"0".repeat(64)}` } : {}),
      regionRectangle: DECSACE_RECTANGLE,
    }
  }
  const result = await find("editing.decsace").term!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(String(result.observation?.note)).toContain("without the required pixel cells digest and rectangle")
  expect(result.assertions).toBeUndefined()
})

/**
 * A per-frame `whole ?? cells` can compare one frame's whole-window digest with
 * another frame's region digest — those never match, so the mismatch reads as a measured extent
 * difference. One kind must be present on ALL three frames, or the row is inconclusive.
 */
test("editing.decsace refuses frames whose measured digests are of different kinds", async () => {
  const { context } = decsacePixelSource()
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
  expect(String(result.observation?.note)).toContain("without the required pixel cells digest and rectangle")
  expect(result.assertions).toBeUndefined()
})

/**
 * The cursor is hidden and two captures of one static frame must agree, exactly as
 * the capture-region oracle requires (region-readback.ts). A frame that moved between two reads of
 * the same static screen cannot decide anything.
 */
test("editing.decsace refuses a capture that is not byte-stable", async () => {
  const { context } = decsacePixelSource()
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
      regionRectangle: DECSACE_RECTANGLE,
    }
  }
  const result = await find("editing.decsace").term!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(String(result.observation?.note)).toContain("not byte-stable")
  expect(result.assertions).toBeUndefined()
  // The same ONE shape the region oracle emits: the two reads in the response,
  // the second capture cited, and no fabricated frame on a path that never reached a target.
  const response = JSON.parse(String(result.response)) as {
    stability: { regionDigest: string[]; pixelsDigest: string[] }
  }
  expect(response.stability.regionDigest).toEqual([`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`])
  expect(response.stability.pixelsDigest).toEqual([null, null])
  expect(result.observation?.screenshotRef).toBe(`sha256:${"2".repeat(64)}`)
  expect(result.observation?.frames ?? []).toHaveLength(0)
})

/**
 * The stability pair measures the SEEDED screen: the seed paint is written before the first read and
 * the pair's second read is the seed frame. A seed still settling between those two reads is refused
 * with the same shape as any unstable capture — both digests in the response, the second read cited,
 * and no frames — instead of being compared against the extent frames.
 */
test("editing.decsace refuses a seed that changes between the pair's two reads", async () => {
  const { context, frameWrites, seed } = decsaceCaptureSource()
  const capture = context.capture!
  const refs: string[] = []
  context.capture = async (request) => {
    if (request.label === "editing.decsace: seed stability 2") context.write("\x1b[1;1HX")
    const frame = await capture(request)
    refs.push(frame.ref)
    return frame
  }
  const result = await find("editing.decsace").term!(context)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    assertionType: "screenshot",
  })
  expect(String(result.observation?.note)).toContain("not byte-stable")
  expect(result.assertions).toBeUndefined()
  // The first read already came after the seed paint, so the pair measured the seeded screen.
  expect(frameWrites[0]).toBe(`\x1b[0m\x1b[?25l${seed}`)
  expect(frameWrites[1]).toBe("\x1b[1;1HX")
  const response = JSON.parse(String(result.response)) as { stability: { regionDigest: string[] } }
  expect(response.stability.regionDigest).toHaveLength(2)
  expect(response.stability.regionDigest[0]).not.toBe(response.stability.regionDigest[1])
  expect(result.observation?.screenshotRef).toBe(refs[1])
  expect(result.observation?.frames ?? []).toHaveLength(0)
})

/**
 * A frame that did not move from the seed has measured no change at all,
 * so an ignored DECCARA cannot be separated from a digest that cannot see attributes.
 */
test("editing.decsace refuses a target frame that did not move from the seed", async () => {
  const { context } = decsacePixelSource()
  let reads = 0
  context.capture = async ({ role, label }) => {
    reads += 1
    // Order: the seed paint, the pair's two reads of that seeded screen (the second IS the seed
    // frame), then the rectangle and the stream extents.
    const digest = reads <= 2 ? "seed" : reads === 3 ? "rect" : "seed"
    return {
      role,
      label,
      capturedAt: reads,
      ref: `sha256:${digest}`,
      regionDigest: `sha256:${digest}`,
      pixelsDigest: `sha256:${digest}`,
      regionRectangle: DECSACE_RECTANGLE,
    }
  }
  const result = await find("editing.decsace").term!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(String(result.observation?.note)).toContain("stream frame did not differ from the seed")
  expect(result.assertions).toBeUndefined()
})

/**
 * The two converted attribute rows on a TEXT-ONLY adapter: the seed and the expected frame read the
 * same cells because only attributes changed, so the region oracle refuses by name. This is the macOS
 * census row in executable form.
 */
test("an attribute row on a text-only adapter is inconclusive by name", async () => {
  for (const id of ["editing.deccara", "editing.decrara"]) {
    const row = editingReadbackRows.find((entry) => entry.id === id)
    if (!row?.sentinel) throw new Error(`missing sentinel for ${id}`)
    const { context } = readbackCaptureSource(24, 80, { row: row.sentinel.row, col: row.sentinel.col ?? 1 })
    const result = await find(id).term!(context)
    expect(result.observation, id).toMatchObject({ outcome: "inconclusive", assertionType: "screenshot" })
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
  const { context, writes } = readbackCaptureSource(24, 80, {
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
  // MODE before DECTCEM comes back: 2J does not reset it.
  expect(writes).toContain("\x1b[0*x")
  expect(writes.indexOf("\x1b[?25h")).toBeGreaterThan(writes.indexOf("\x1b[0*x"))
  expect(expectedFrames).toEqual([
    ["aaaaaZ", "bbbbbY", "cccccX"].map((characters) =>
      [...characters].map((char, col) => ({ char, inverse: id === "editing.deccara" && col < 5 })),
    ),
  ])
})
