/**
 * @failure A capture-region verdict read from an unguarded post-sequence capture grades a slow or
 *   stale window as unsupported: kitty 0.49.2 answers the cursor report after ESC # 8 and never
 *   repaints, so "after equals seed" taken from a bare capture is a false negative. A missing paint
 *   witness, a paint seen outside the sentinel region and an unstable capture must each be
 *   inconclusive BY NAME; the three compared frames must share one cursor state; and an unusable
 *   region or a missing pixel report must refuse before a single byte reaches the terminal.
 * @level l1
 * @consumer App-mode cell-readback decisions for editing and reset rows on owned contexts.
 * @testonly none
 */
import { expect, test } from "vitest"
import {
  captureRegionReadbackDecision,
  captureRegionVerdict,
  queryPixelGeometry,
  type CellRegion,
  type PixelGeometry,
  type RegionCapture,
  type RegionRead,
  type RegionReadback,
} from "./region-readback.ts"
import type {
  CaptureCells,
  CapturePixelGeometry,
  MeasuredProbeResult,
  ObservationFrame,
  TermContext,
  TerminalQueryOutcome,
} from "./types.ts"

const SEED = "\x1b[1;1Hseed"
const EDIT = "\x1b[1;3H\x1b[1P"
const EXPECTED = "\x1b[1;1Hexpected"
const GEOMETRY: PixelGeometry = { cellWidth: 8, cellHeight: 16, textWidth: 640, textHeight: 384 }
const SENTINEL_CELL = "3,1,3,1"

function spec(overrides: Partial<RegionReadback> = {}): RegionReadback {
  return {
    region: { top: 1, left: 1, bottom: 1, right: 8 },
    sentinel: { row: 3, col: 1 },
    cursorRow: 4,
    seed: SEED,
    edit: EDIT,
    expected: EXPECTED,
    pixelGeometry: GEOMETRY,
    timeoutMs: 200,
    pollMs: 1,
    minRows: 2,
    minCols: 9,
    ...overrides,
  }
}

function key(region: CellRegion): string {
  return `${region.top},${region.left},${region.bottom},${region.right}`
}

/** The cells the terminal SHOWS for the writes so far. The test owns what each fixture paints. */
type Painter = (writes: readonly string[]) => string

/**
 * A terminal that repaints what it was told: the expected frame is written PLAINLY in the same run,
 * so an applied sequence must leave cells byte-identical to it. `applied` is what the sequence
 * leaves behind — the plainly written frame when the edit worked, the seed when it did nothing.
 */
function painter(options: { applied: string }): Painter {
  return (writes) => {
    if (writes.some((entry) => entry.includes("expected"))) return "edited"
    return writes.join("").includes(SEED + EDIT) ? options.applied : "seed"
  }
}

interface Fake {
  ctx: TermContext
  read: RegionRead
  writes: string[]
  timeline: string[]
  requests: Array<{ region: CellRegion; pixelGeometry: PixelGeometry; label: string }>
}

/**
 * A terminal whose window shows the newest paint only after `repaintAfterPolls` captures, or never
 * when that is "never" — the apparatus measured on kitty 0.49.2. The witness cell shows the last
 * glyph written, unless the harness cannot see the witness cell at all (`sentinelAnswers: false`),
 * which models a cells-to-pixels rectangle that lands outside the painted area.
 */
function ownedWindow(options: {
  rows?: number
  cols?: number
  repaintAfterPolls: number | "never"
  regionDigest: Painter
  sentinelAnswers?: boolean
  unstable?: boolean
}): Fake {
  const sentinelAnswers = options.sentinelAnswers ?? true
  let screen = options.regionDigest([])
  let glyph = ""
  let polls = 0
  let reads = 0
  let pendingWrite = false
  const writes: string[] = []
  const timeline: string[] = []
  const requests: Fake["requests"] = []
  const ctx: TermContext = {
    rows: options.rows ?? 24,
    cols: options.cols ?? 80,
    write(sequence) {
      writes.push(sequence)
      timeline.push(`write:${sequence}`)
      pendingWrite = true
    },
    queryCursorPosition: async () => ({ row: 4, col: 1 }),
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
  }
  const read: RegionRead = async ({ role, label, region, pixelGeometry }) => {
    reads += 1
    requests.push({ region, pixelGeometry, label })
    timeline.push(`read:${key(region)}`)
    if (pendingWrite) {
      pendingWrite = false
      polls = 0
    }
    polls += 1
    if (options.repaintAfterPolls !== "never" && polls >= options.repaintAfterPolls) {
      screen = options.regionDigest(writes)
      if (sentinelAnswers) {
        const witnessWrite = writes.filter((entry) => /^\x1b\[\d+;\d+H.$/.test(entry)).at(-1)
        if (witnessWrite) glyph = witnessWrite.slice(-1)
      }
    }
    const frame: ObservationFrame = {
      role,
      label,
      capturedAt: reads,
      ref: `sha256:${String(reads).repeat(64)}`,
    }
    const cell = key(region)
    const content = cell === SENTINEL_CELL ? glyph : screen
    const suffix = options.unstable ? `-${reads}` : ""
    const capture: RegionCapture = {
      regionDigest: `${cell}|${content}${suffix}`,
      pixelsDigest: `frame|${screen}|${glyph}${suffix}`,
      frame,
    }
    return capture
  }
  return { ctx, read, writes, timeline, requests }
}

async function decide(fake: Fake, overrides: Partial<RegionReadback> = {}): Promise<MeasuredProbeResult> {
  const result = await captureRegionReadbackDecision(fake.ctx, "editing.delete-chars", spec(overrides), fake.read)
  if (!result?.observation) throw new Error("expected a decided result carrying an observation")
  return result as MeasuredProbeResult
}

/** The reads that compared the region; every other read is a witness or a baseline on one cell. */
function regionReads(fake: Fake): Fake["requests"] {
  return fake.requests.filter(({ region }) => key(region) !== SENTINEL_CELL)
}

test("a painted edit that reaches the expected frame is supported, from three witnessed captures", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 2, regionDigest: painter({ applied: "edited" }) })
  const result = await decide(fake)
  expect(result.observation.outcome).toBe("supported")
  expect(result.observation.evidence).toBe("pixels")
  expect(result.assertions?.[0]?.kind).toBe("positive")
  expect(regionReads(fake).map(({ label }) => label)).toEqual([
    "editing.delete-chars: pre-edit seed",
    "editing.delete-chars: post-sequence target",
    "editing.delete-chars: expected frame",
  ])
  expect(result.observation.frames).toHaveLength(6)
})

test("a terminal that leaves the edit in place is unsupported only because the witness proved the paint", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: painter({ applied: "seed" }) })
  const result = await decide(fake)
  expect(result.observation.outcome).toBe("unsupported")
  expect(result.assertions?.[0]?.kind).toBe("negative")
})

test("a stale window is inconclusive by name, never unsupported: kitty answers the cursor report and never repaints", async () => {
  const fake = ownedWindow({ repaintAfterPolls: "never", regionDigest: () => "seed" })
  // The same fixture answers no CSI 16 t, so its cell size is DERIVED from 14 t / 18 t — and that
  // basis must survive the ORDINARY timeout too, not only the frame-moved one (28763, @dev/review2:
  // an unchanged window made the timeout drop the basis the caller supplied).
  fake.ctx.queryWithSentinelOutcome = async (sequence) => {
    if (sequence === "\x1b[14t") {
      return { match: ["\x1b[4;384;640t", "384", "640"], reason: "reply", raw: "", rawBase64: "" }
    }
    if (sequence === "\x1b[18t") {
      return { match: ["\x1b[8;24;80t", "24", "80"], reason: "reply", raw: "", rawBase64: "" }
    }
    return { match: null, reason: "sentinel", raw: "\x1b[?6c", rawBase64: "" }
  }
  const mapped = await queryPixelGeometry(fake.ctx)
  if (!("geometry" in mapped)) throw new Error(`expected a mapped cell size, got: ${mapped.missing}`)
  const result = await decide(fake, { pixelGeometry: mapped.geometry, geometrySource: mapped.source })
  expect(result.observation.outcome).toBe("inconclusive")
  expect(result.observation.reason).toBe("timeout")
  expect(result.observation.note).toContain("no paint witness within 200 ms")
  expect(result.observation.note).toContain("cannot separate a painted frame from a stale one")
  expect(result.observation.note).toContain("cell geometry derived from CSI 14 t / CSI 18 t")
  expect(result.assertions).toBeUndefined()
})

test("a frame that moves while the witness cell stands still names the geometry, not a capability", async () => {
  const fake = ownedWindow({
    repaintAfterPolls: 2,
    sentinelAnswers: false,
    // The seed itself repaints the region, so the frame moves while the unseen witness cell stands
    // still — the shape a wrong cells-to-pixels rectangle produces.
    regionDigest: (writes) => {
      if (writes.some((entry) => entry.includes("expected"))) return "edited"
      return writes.join("").includes(SEED) ? "seed" : "initial"
    },
  })
  const result = await decide(fake)
  expect(result.observation.outcome).toBe("inconclusive")
  expect(result.observation.reason).toBe("timeout")
  expect(result.observation.note).toContain("paint witnessed outside the sentinel region")
  expect(result.observation.note).toContain("cells-to-pixels geometry is wrong")
})

test("an edit that matches neither the seed nor the expected frame is inconclusive by name", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: painter({ applied: "other" }) })
  const result = await decide(fake)
  expect(result.observation.outcome).toBe("inconclusive")
  expect(result.observation.reason).toBe("insufficient-evidence")
  expect(result.observation.note).toContain("matched none of the compared frames (seed, expected)")
})

// A spec whose four compared planes each paint a distinct frame, so a run can be told apart by the
// plane it showed. The optional fourth plane is the frame the sequence would leave if it ignored
// the one attribute its row claims (a DECSCA-protected cell erased, an EL that drops the current
// background); an after-frame equal to it must read a measured negative, not an unnamed unknown.
const PLANES = {
  seed: "\x1b[1;1HAAA",
  edit: "\x1b[1;2H\x1b[1P",
  expected: "\x1b[1;1HBBB",
  ignored: "\x1b[1;1HCCC",
} as const
const PLANE_SPEC = { seed: PLANES.seed, edit: PLANES.edit, expected: PLANES.expected, ignored: PLANES.ignored }

/** The frame the terminal shows: whichever plane was painted LAST, with `applied` for the target. */
function planePainter(applied: string, ignoredReadsAs?: string): Painter {
  return (writes) => {
    const joined = writes.join("")
    if (ignoredReadsAs !== undefined && joined.includes(PLANES.ignored)) return ignoredReadsAs
    const planes: Array<[string, string]> = [
      ["ignored", PLANES.ignored],
      ["expected", PLANES.expected],
      ["target", PLANES.seed + PLANES.edit],
      ["seed", PLANES.seed],
    ]
    let label = "seed"
    let at = -1
    for (const [candidate, token] of planes) {
      const found = joined.lastIndexOf(token)
      if (found > at) {
        label = candidate
        at = found
      }
    }
    return label === "target" ? applied : label
  }
}

test("an ignored-attribute plane names the attribute-dropping run unsupported, behind a proven paint", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: planePainter("ignored") })
  const result = await decide(fake, PLANE_SPEC)
  expect(result.observation.outcome).toBe("unsupported")
  expect(result.assertions?.[0]?.kind).toBe("negative")
  expect(result.observation.frames).toHaveLength(8)
  expect(regionReads(fake).map(({ label }) => label)).toEqual([
    "editing.delete-chars: pre-edit seed",
    "editing.delete-chars: post-sequence target",
    "editing.delete-chars: expected frame",
    "editing.delete-chars: ignored-attribute frame",
  ])
})

test("a run that cannot separate the ignored plane from the expected plane is inconclusive by name", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: planePainter("other", "expected") })
  const result = await decide(fake, PLANE_SPEC)
  expect(result.observation.outcome).toBe("inconclusive")
  expect(result.observation.note).toContain("ignored-attribute frame and the expected frame read the same cells")
})

test("a spec with no ignored plane keeps its three-plane verdict", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: painter({ applied: "edited" }) })
  const result = await decide(fake)
  expect(result.observation.outcome).toBe("supported")
  expect(result.observation.frames).toHaveLength(6)
})

test("a degenerate run whose seed frame reads as its expected frame is inconclusive by name", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: () => "same" })
  const result = await decide(fake)
  expect(result.observation.outcome).toBe("inconclusive")
  expect(result.observation.note).toContain("seed frame and the expected frame read the same cells")
})

test("an unstable capture refuses before the first glyph is written", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: painter({ applied: "edited" }), unstable: true })
  const result = await decide(fake)
  expect(result.observation.outcome).toBe("inconclusive")
  expect(result.observation.note).toContain("were not byte-stable")
  expect(fake.writes.some((entry) => /^\x1b\[\d+;\d+H.$/.test(entry))).toBe(false)
})

test("DECTCEM is off before the first capture and restored after the last, around every read", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: painter({ applied: "edited" }) })
  const result = await decide(fake)
  expect(result.observation.outcome).toBe("supported")
  const hide = fake.timeline.indexOf("write:\x1b[?25l")
  const show = fake.timeline.indexOf("write:\x1b[?25h")
  const reads = fake.timeline.map((event, index) => ({ event, index })).filter(({ event }) => event.startsWith("read:"))
  expect(hide).toBeGreaterThanOrEqual(0)
  expect(show).toBeGreaterThanOrEqual(0)
  expect(hide).toBeLessThan(reads[0]!.index)
  expect(show).toBeGreaterThan(reads.at(-1)!.index)
  expect(fake.timeline.filter((event) => event === "write:\x1b[?25l")).toHaveLength(1)
  expect(fake.timeline.filter((event) => event === "write:\x1b[?25h")).toHaveLength(1)
})

test("a run without an owned capture keeps the caller's pixel path instead of deciding", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: () => "seed" })
  const result = await captureRegionReadbackDecision(fake.ctx, "editing.delete-chars", spec(), null)
  expect(result).toBeNull()
  expect(fake.writes).toEqual([])
})

test("a region that leaves the measured grid refuses before any byte", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: () => "seed" })
  const result = await decide(fake, { region: { top: 1, left: 1, bottom: 1, right: 81 } })
  expect(result.observation.outcome).toBe("inconclusive")
  expect(result.observation.note).toContain("leaves the measured 24x80 grid")
  expect(fake.writes).toEqual([])
})

test("a witness cell inside the compared region refuses before any byte", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: () => "seed" })
  const result = await decide(fake, { sentinel: { row: 1, col: 4 } })
  expect(result.observation.note).toContain("lies inside compared region")
  expect(fake.writes).toEqual([])
})

test("a compared region covering the cursor row refuses before any byte", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: () => "seed" })
  const result = await decide(fake, { cursorRow: 1 })
  expect(result.observation.note).toContain("includes the cursor row 1")
  expect(fake.writes).toEqual([])
})

test("an undersized measured grid refuses before any byte", async () => {
  const fake = ownedWindow({ rows: 2, cols: 4, repaintAfterPolls: 1, regionDigest: () => "seed" })
  const result = await decide(fake)
  expect(result.observation.note).toContain("needs a measured grid of at least 2x9")
  expect(fake.writes).toEqual([])
})

test("a terminal that answered neither pixel report refuses before any byte", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: () => "seed" })
  const result = await decide(fake, {
    pixelGeometry: { cellWidth: 0, cellHeight: 16, textWidth: 640, textHeight: 384 },
  })
  expect(result.observation.note).toContain("needs the terminal's own positive pixel report")
  expect(fake.writes).toEqual([])
})

test("every capture carries the terminal's own pixel report, and witness reads use the reserved cell alone", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: painter({ applied: "edited" }) })
  const result = await decide(fake)
  expect(result.observation.outcome).toBe("supported")
  expect(regionReads(fake)).toHaveLength(3)
  for (const { region, pixelGeometry } of fake.requests) {
    expect(pixelGeometry).toEqual(GEOMETRY)
    expect(["1,1,1,8", SENTINEL_CELL]).toContain(key(region))
  }
  expect(fake.requests.filter(({ region }) => key(region) !== SENTINEL_CELL)).toHaveLength(3)
})

// The raw-run contract requires a citation (child 28582, @cto b12b71b2): evidence "pixels" is
// refused unless the observation carries a screenshotRef, and evidence "none" is refused unless its
// trace is zero-byte. A query already written is therefore NOT "none", and a branch that captured
// must cite the capture.

test("a pixel query answered with a sentinel reports query evidence, not a zero-byte refusal", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: () => "seed" })
  const ctx: TermContext = {
    ...fake.ctx,
    queryWithSentinelOutcome: async () => ({ match: null, reason: "sentinel", raw: "\x1b[c", rawBase64: "" }),
    capture: async (request) => ({
      role: request.role,
      label: request.label,
      capturedAt: 1,
      ref: `sha256:${"a".repeat(64)}`,
    }),
  }
  const geometry = spec()
  const result = await captureRegionVerdict(ctx, "editing.delete-chars", {
    region: geometry.region,
    sentinel: geometry.sentinel,
    cursorRow: geometry.cursorRow,
    seed: geometry.seed,
    edit: geometry.edit,
    expected: geometry.expected,
    timeoutMs: geometry.timeoutMs,
    pollMs: geometry.pollMs,
    minRows: geometry.minRows,
    minCols: geometry.minCols,
  })
  if (!result?.observation) throw new Error("expected a decided result carrying an observation")
  expect(result.observation.outcome).toBe("inconclusive")
  expect(result.observation.evidence).toBe("query")
  expect(result.observation.note).toContain("CSI 16 t")
})

/**
 * @failure A terminal that answers no CSI 16 t (alacritty, on Linux and macOS) reads as having no
 *   pixel report at all, so every region row on it stays undecided although the same terminal
 *   reports the text area twice — in pixels and in characters (28763).
 * @level l1
 * @consumer The capture-region readback, on every app row that needs a cells-to-pixels rectangle.
 * @testonly none
 */
test("a terminal with no CSI 16 t maps cells from its own 14 t and 18 t text area by whole-number division", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: painter({ applied: "edited" }) })
  const asked: string[] = []
  fake.ctx.queryWithSentinelOutcome = async (sequence) => {
    asked.push(sequence)
    if (sequence === "\x1b[14t") {
      return { match: ["\x1b[4;384;640t", "384", "640"], reason: "reply", raw: "", rawBase64: "" }
    }
    if (sequence === "\x1b[18t") {
      return { match: ["\x1b[8;24;80t", "24", "80"], reason: "reply", raw: "", rawBase64: "" }
    }
    return { match: null, reason: "sentinel", raw: "\x1b[?6c", rawBase64: "" }
  }
  const mapped = await queryPixelGeometry(fake.ctx)
  if (!("geometry" in mapped)) throw new Error(`expected a mapped cell size, got: ${mapped.missing}`)
  expect(asked).toEqual(["\x1b[16t", "\x1b[14t", "\x1b[18t"])
  expect(mapped.geometry).toEqual({ cellWidth: 8, cellHeight: 16, textWidth: 640, textHeight: 384 })
  // @cto fix 1 (2026-10-12): every number names its basis.
  expect(mapped.source).toBe("derived from CSI 14 t / CSI 18 t")
  // And the row DECIDES with it, which is the whole point of the mapping: the same fixture that
  // answers no cell size now reads its compared cells at the derived 8x16 — and its observation
  // records WHERE that geometry came from, beside the geometry itself.
  const result = await decide(fake, { pixelGeometry: mapped.geometry, geometrySource: mapped.source })
  expect(result.observation.outcome).toBe("supported")
  expect(result.observation.evidence).toBe("pixels")
  for (const { pixelGeometry } of fake.requests) expect(pixelGeometry).toEqual(mapped.geometry)
  expect(JSON.parse(result.response ?? "null")).toMatchObject({
    pixelGeometry: mapped.geometry,
    geometrySource: "derived from CSI 14 t / CSI 18 t",
  })
  // A terminal that DOES answer 16 t names the other basis, so the two are never confused.
  const reporting = ownedWindow({ repaintAfterPolls: 1, regionDigest: () => "seed" })
  reporting.ctx.queryWithSentinelOutcome = async (sequence) =>
    sequence === "\x1b[16t"
      ? { match: ["\x1b[6;16;8t", "16", "8"], reason: "reply", raw: "", rawBase64: "" }
      : { match: ["\x1b[4;384;640t", "384", "640"], reason: "reply", raw: "", rawBase64: "" }
  const reported = await queryPixelGeometry(reporting.ctx)
  if (!("geometry" in reported)) throw new Error("16 t and 14 t both replied, so a cell size is reported")
  expect(reported.source).toBe("reported by CSI 16 t")
})

test("a text area that does not divide into whole pixels refuses BY NAME and maps nothing", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: painter({ applied: "edited" }) })
  fake.ctx.queryWithSentinelOutcome = async (sequence) => {
    if (sequence === "\x1b[14t") {
      return { match: ["\x1b[4;385;640t", "385", "640"], reason: "reply", raw: "", rawBase64: "" }
    }
    if (sequence === "\x1b[18t") {
      return { match: ["\x1b[8;24;80t", "24", "80"], reason: "reply", raw: "", rawBase64: "" }
    }
    return { match: null, reason: "sentinel", raw: "\x1b[?6c", rawBase64: "" }
  }
  const mapped = await queryPixelGeometry(fake.ctx)
  if ("geometry" in mapped) throw new Error("385 pixels over 24 rows is not a cell height to round")
  // 385 pixels over 24 rows is not a cell height at all: these are two replies that disagree about
  // the text area, so the refusal names the numbers instead of picking one.
  expect(mapped.missing).toContain("640x385 pixel text area over 80x24 characters")
  expect(mapped.missing).toContain("does not divide into a whole-pixel cell size")
})

/**
 * 28763 fix 2 (@cto 2026-10-12): the failure NAMES are the contract, so each one gets its own test.
 * Every case asserts the reply it names AND that no geometry is mapped — a refusal is not a guess.
 */
test("a terminal that answers neither CSI 16 t nor CSI 14 t names both replies it got", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: () => "seed" })
  const reasons: Record<string, TerminalQueryOutcome["reason"]> = {
    "\x1b[16t": "sentinel",
    "\x1b[14t": "timeout",
  }
  fake.ctx.queryWithSentinelOutcome = async (sequence) => ({
    match: null,
    reason: reasons[sequence] ?? "timeout",
    raw: "\x1b[?6c",
    rawBase64: "",
  })
  const mapped = await queryPixelGeometry(fake.ctx)
  if ("geometry" in mapped) throw new Error("a terminal that answered neither report has no cell size to map")
  expect(mapped.missing).toContain("CSI 16 t")
  expect(mapped.missing).toContain("sentinel")
  expect(mapped.missing).toContain("CSI 14 t")
  expect(mapped.missing).toContain("timeout")
})

test("a 14 t reply behind a silent CSI 16 t names 16 t and the 18 t that never came", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: () => "seed" })
  fake.ctx.queryWithSentinelOutcome = async (sequence) => {
    if (sequence === "\x1b[14t") {
      return { match: ["\x1b[4;384;640t", "384", "640"], reason: "reply", raw: "", rawBase64: "" }
    }
    return { match: null, reason: "sentinel", raw: "\x1b[?6c", rawBase64: "" }
  }
  const mapped = await queryPixelGeometry(fake.ctx)
  if ("geometry" in mapped) throw new Error("18 t is what makes the division exact, so its absence maps nothing")
  expect(mapped.missing).toContain("CSI 16 t")
  expect(mapped.missing).toContain("sentinel")
  expect(mapped.missing).toContain("CSI 18 t")
})

test("a report that parses to zero or to non-numbers names the numbers, on both paths", async () => {
  // The 16 t / 14 t path: the cell size came back zero, so the refusal quotes the parsed geometry.
  const reported = ownedWindow({ repaintAfterPolls: 1, regionDigest: () => "seed" })
  reported.ctx.queryWithSentinelOutcome = async (sequence) => {
    if (sequence === "\x1b[16t") {
      return { match: ["\x1b[6;0;8t", "0", "8"], reason: "reply", raw: "", rawBase64: "" }
    }
    if (sequence === "\x1b[14t") {
      return { match: ["\x1b[4;384;640t", "384", "640"], reason: "reply", raw: "", rawBase64: "" }
    }
    return { match: null, reason: "sentinel", raw: "\x1b[?6c", rawBase64: "" }
  }
  const zeroCell = await queryPixelGeometry(reported.ctx)
  if ("geometry" in zeroCell) throw new Error("a zero cell height is not a pixel report")
  expect(zeroCell.missing).toContain("did not parse as positive numbers")
  expect(zeroCell.missing).toContain('"cellHeight":0')

  // The derived path: both text areas parsed, but as zeros, so the refusal quotes them by number.
  const derived = ownedWindow({ repaintAfterPolls: 1, regionDigest: () => "seed" })
  derived.ctx.queryWithSentinelOutcome = async (sequence) => {
    if (sequence === "\x1b[14t") {
      return { match: ["\x1b[4;0;0t", "0", "0"], reason: "reply", raw: "", rawBase64: "" }
    }
    if (sequence === "\x1b[18t") {
      return { match: ["\x1b[8;24;80t", "24", "80"], reason: "reply", raw: "", rawBase64: "" }
    }
    return { match: null, reason: "sentinel", raw: "\x1b[?6c", rawBase64: "" }
  }
  const zeroArea = await queryPixelGeometry(derived.ctx)
  if ("geometry" in zeroArea) throw new Error("a 0x0 text area is not a measurement")
  expect(zeroArea.missing).toContain("did not parse as positive numbers")
  expect(zeroArea.missing).toContain("0x0 pixels over 80x24 characters")
})

test("an unstable capture cites the capture it took, so the run stays writable", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: painter({ applied: "edited" }), unstable: true })
  const result = await decide(fake)
  expect(result.observation.outcome).toBe("inconclusive")
  expect(result.observation.evidence).toBe("pixels")
  expect(result.observation.screenshotRef).toBeDefined()
})

test("a degenerate seed-equals-expected run cites the frames it took", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: () => "same" })
  const result = await decide(fake)
  expect(result.observation.outcome).toBe("inconclusive")
  expect(result.observation.evidence).toBe("pixels")
  expect(result.observation.screenshotRef).toBeDefined()
  expect(result.observation.frames).toHaveLength(6)
})

test("a paint-witness timeout cites the capture it took, so the run stays writable", async () => {
  const fake = ownedWindow({ repaintAfterPolls: "never", regionDigest: () => "seed" })
  const result = await decide(fake)
  expect(result.observation.outcome).toBe("inconclusive")
  expect(result.observation.reason).toBe("timeout")
  expect(result.observation.evidence).toBe("pixels")
  expect(result.observation.screenshotRef).toBeDefined()
})
