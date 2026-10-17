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
  CaptureRectangle,
  MeasuredProbeResult,
  ObservationFrame,
  TermContext,
  TerminalQueryOutcome,
} from "./types.ts"
import { RESET_FAMILY_CAPTURE } from "./reset-family-capture.ts"
import { sgrProbes } from "./sgr.ts"
import { resetProbes } from "./reset.ts"

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
  /**
   * The crop rectangle each read reports, keyed by that read's own label. Absent models a
   * hand-built read; the collector-backed reader always carries one with the region digest.
   */
  cropFor?: (label: string) => CaptureRectangle | undefined
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
    const regionRectangle = options.cropFor?.(label)
    const capture: RegionCapture = {
      regionDigest: `${cell}|${content}${suffix}`,
      pixelsDigest: `frame|${screen}|${glyph}${suffix}`,
      ...(regionRectangle ? { regionRectangle } : {}),
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

test("a post-sequence frame equal to the caller's control is inconclusive, named, never a capability claim", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: painter({ applied: "seed" }) })
  const result = await decide(fake)
  expect(result.observation.outcome).toBe("inconclusive")
  expect(result.observation.reason).toBe("insufficient-evidence")
  expect(result.observation.note).toContain("equals the caller's control (seed) frame")
  expect(result.observation.note).not.toContain("a third distinct frame")
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

test("an edit that is a third distinct frame is inconclusive, stating the observation only", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: painter({ applied: "other" }) })
  const result = await decide(fake)
  expect(result.observation.outcome).toBe("inconclusive")
  expect(result.observation.reason).toBe("insufficient-evidence")
  // The three compared planes are pairwise distinct. The note states that fact and nothing more:
  // no implied cause (a third distinct frame is also what a WRONG effect looks like), no "simply"
  // (#28829, CTO).
  expect(result.observation.note).toContain("a third distinct frame")
  expect(result.observation.note).toContain("cannot tell an incorrect effect from a rendering difference")
  expect(result.observation.note).toContain("compared frames: seed, expected")
  expect(result.observation.note).not.toContain("matched none of the compared frames")
  expect(result.observation.note).not.toContain("simply")
})

// 28752: a row whose expected frame is written PLAINLY assumes the run decodes plain UTF-8. The
// measured context fact decides that, so an 8-bit run is inconclusive BY NAME — never a capability
// negative, and never a run refusal.
test("a measured 8-bit decoding context refuses by name before any capture", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: painter({ applied: "edited" }) })
  let asked = 0
  fake.ctx.utf8Decoding = async () => {
    asked += 1
    return "8-bit"
  }
  const result = await decide(fake, { requiresUtf8: true })
  expect(result.observation.outcome).toBe("inconclusive")
  expect(result.observation.reason).toBe("insufficient-evidence")
  expect(result.observation.evidence).toBe("query")
  expect(result.observation.note).toContain("decodes plain-written UTF-8 as ISO-8859-1")
  expect(result.assertions).toBeUndefined()
  expect(asked).toBe(1)
  expect(fake.requests).toEqual([])
  expect(fake.writes).toEqual([])
})

test("a measured utf8 decoding context leaves a plain-written row to its pixel oracle", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 2, regionDigest: painter({ applied: "edited" }) })
  fake.ctx.utf8Decoding = async () => "utf8"
  const result = await decide(fake, { requiresUtf8: true })
  expect(result.observation.outcome).toBe("supported")
})

test("a row that declares no plain-written assumption never reads the fact", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 2, regionDigest: painter({ applied: "edited" }) })
  let asked = 0
  fake.ctx.utf8Decoding = async () => {
    asked += 1
    return "8-bit"
  }
  const result = await decide(fake)
  expect(result.observation.outcome).toBe("supported")
  expect(asked).toBe(0)
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

test("region rows consume the same calibrated run geometry without re-dividing window replies", async () => {
  const fake = ownedWindow({
    repaintAfterPolls: 1,
    regionDigest: painter({ applied: "edited" }),
    cropFor: () => ({ x: 10, y: 64, width: 64, height: 16 }),
  })
  const reading = { geometry: GEOMETRY, source: "measured by complete raster calibration" as const }
  Object.assign(fake.ctx, { captureGeometry: reading })
  let queries = 0
  fake.ctx.queryWithSentinelOutcome = async () => {
    queries++
    return { match: null, reason: "sentinel", raw: "\x1b[c", rawBase64: "" }
  }
  fake.ctx.capture = async (request) => {
    if (!request.cells || !request.pixelGeometry) throw new Error("Region request lacks its calibrated geometry")
    const captured = await fake.read({
      role: request.role,
      label: request.label,
      region: request.cells,
      pixelGeometry: request.pixelGeometry,
    })
    // The real adapter always carries the crop rectangle beside the digest; a stub that dropped it
    // would model a capture the collector cannot produce.
    return {
      ...captured.frame,
      regionDigest: captured.regionDigest,
      pixelsDigest: captured.pixelsDigest,
      ...(captured.regionRectangle ? { regionRectangle: captured.regionRectangle } : {}),
    }
  }
  const result = await captureRegionVerdict(fake.ctx, "editing.delete-chars", spec())
  expect(result?.observation).toMatchObject({ outcome: "supported", evidence: "pixels" })
  expect(queries).toBe(0)
  expect(fake.requests.length).toBeGreaterThan(0)
  expect(fake.requests.every((request) => request.pixelGeometry === reading.geometry)).toBe(true)
})

test("region rows refuse a calibrated footprint that no longer covers the current grid before paint", async () => {
  const fake = ownedWindow({ rows: 30, cols: 120, repaintAfterPolls: 1, regionDigest: painter({ applied: "edited" }) })
  fake.ctx.captureGeometry = { geometry: GEOMETRY, source: "measured by complete raster calibration" }
  fake.ctx.capture = async () => {
    throw new Error("A stale calibrated footprint must be refused before capture")
  }
  const result = await captureRegionVerdict(fake.ctx, "editing.delete-chars", spec())
  expect(result?.observation).toMatchObject({
    outcome: "inconclusive",
    evidence: "none",
    note: expect.stringMatching(/calibrated.*grid|grid.*calibrated/),
  })
  expect(fake.writes).toEqual([])
  expect(fake.requests).toEqual([])
})

/**
 * The ghostty 1.3.1/linux `erase.el-with-attrs` specimen (run 0c0527c520ab): the after frame's
 * dominant colour covered 518 rows, fewer than the reported 780x528 text area, so that one frame
 * was placed in the whole window and cropped at y=36 while the seed, expected and ignored frames
 * were cropped at y=62 — 26 pixels, about one row, apart.
 */
function specimenCrop(label: string): CaptureRectangle {
  return { x: 10, y: label.includes("post-sequence target") ? 36 : 62, width: 104, height: 24 }
}

test("compared frames cropped from different screen positions refuse BY NAME, naming every rectangle", async () => {
  const fake = ownedWindow({
    repaintAfterPolls: 2,
    regionDigest: painter({ applied: "edited" }),
    cropFor: specimenCrop,
  })
  const result = await decide(fake)
  expect(result.pass).toBe(false)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "pixels",
  })
  expect(result.observation.note).toContain("the compared frames were cropped from different screen positions")
  expect(result.observation.note).toContain("the seed frame cropped at 10,62 104x24")
  expect(result.observation.note).toContain("the post-sequence frame cropped at 10,36 104x24")
  expect(result.observation.note).toContain("the expected frame cropped at 10,62 104x24")
})

test("compared frames cropped at ONE position decide as before, so it is the rectangles and not the recording", async () => {
  const fake = ownedWindow({
    repaintAfterPolls: 2,
    regionDigest: painter({ applied: "edited" }),
    cropFor: () => ({ x: 10, y: 62, width: 104, height: 24 }),
  })
  const result = await decide(fake)
  expect(result.observation.outcome).toBe("supported")
})

// ── The reset-family ruling (@cto ab8cd612, 29816) ───────────────────────────────────────────────
//
// The seeded negatives behind these tests, each refusing a false pass: a vacuous after == seed (the
// control test above), a no-op once the ignored frame IS the seed (below), an unrelated change
// outside the compared cells (below), cursor blink (DECTCEM is off before the first capture, and the
// outside-region test keeps the window moving), one anti-aliased pixel INSIDE the region (the
// third-distinct test), a control already in the target state (the seed-equals-expected test),
// geometry drift (the crop-rectangle tests), an invisible attribute (the ignored-equals-expected
// test), and a coincidental ignored match (the attribute-dropping test).

test("a no-op is the measured negative only when the caller's ignored frame IS the seed frame", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: planePainter("seed") })
  const result = await decide(fake, { ...PLANES, ignored: PLANES.seed })
  expect(result.observation.outcome).toBe("unsupported")
  expect(result.assertions?.[0]?.kind).toBe("negative")
})

test("a change outside the compared cells moves the whole window and not the verdict", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: () => "frame" })
  const stable = fake.read
  const read: RegionRead = async (request) => {
    const captured = await stable(request)
    if (key(request.region) === SENTINEL_CELL) return captured
    // A status line, a clock or the cursor repaints on every capture, so the WHOLE-WINDOW digest
    // changes each read while the compared cells are byte-identical to the expected frame.
    const digest = request.label.endsWith("pre-edit seed") ? "seed" : "expected"
    return { ...captured, regionDigest: digest, pixelsDigest: `window|${request.label}` }
  }
  const result = await captureRegionReadbackDecision(fake.ctx, "editing.delete-chars", spec(), read)
  expect(result?.observation).toMatchObject({ outcome: "supported", evidence: "pixels" })
})

const RESET_FAMILY_ROWS = [
  "reset.sgr",
  "sgr.reset",
  "sgr.fg.default",
  "sgr.bg.default",
  "sgr.underline-color-reset",
  "sgr.selective-reset.bold",
  "sgr.selective-reset.underline",
  "sgr.selective-reset.italic",
  "sgr.selective-reset.inverse",
] as const

/** The reset-family witness cell, and the shape of one read of its own compared region. */
const FAMILY_SENTINEL = "1,1,1,1"

function familyRow(id: (typeof RESET_FAMILY_ROWS)[number]): Omit<RegionReadback, "pixelGeometry"> {
  const row = RESET_FAMILY_CAPTURE[id]
  if (!row) throw new Error(`${id}: no capture-region row is declared`)
  return row
}

async function familyDecide(id: (typeof RESET_FAMILY_ROWS)[number], applied: string): Promise<MeasuredProbeResult> {
  const result = await captureRegionVerdict(familyTerminal(applied), id, familyRow(id))
  if (!result?.observation) throw new Error(`${id}: the fixture run produced no observation`)
  return result as MeasuredProbeResult
}

function familyDigest(label: string, applied: string): string {
  return label.endsWith("pre-edit seed")
    ? "seed"
    : label.endsWith("post-sequence target")
      ? applied
      : label.endsWith("expected frame")
        ? "expected"
        : "ignored"
}

/** A terminal that shows the witness glyph the oracle just wrote and the named plane per frame. */
function familyTerminal(applied: string): TermContext {
  let glyph = ""
  let reads = 0
  const frameFor = (role: ObservationFrame["role"], label: string): ObservationFrame => {
    reads += 1
    return { role, label, capturedAt: reads, ref: `sha256:${String(reads).repeat(64)}` }
  }
  return {
    rows: 24,
    cols: 80,
    captureGeometry: { geometry: GEOMETRY, source: "measured by complete raster calibration" },
    write(sequence) {
      const witness = /^\x1b\[(\d+);(\d+)H(.)$/.exec(sequence)
      if (witness) glyph = witness[3] ?? glyph
    },
    capture: async (request) => {
      // The region reader always asks with cells; a capture without them is not this fixture.
      if (!("cells" in request) || !request.cells) throw new Error("the reset-family fixture is read by region")
      const frame = frameFor(request.role, request.label)
      const digest = key(request.cells) === FAMILY_SENTINEL ? `witness|${glyph}` : familyDigest(request.label, applied)
      return {
        ...frame,
        regionDigest: digest,
        pixelsDigest: `window|${digest}`,
        regionRectangle: { x: 0, y: 0, width: 16, height: 16 },
      }
    },
    queryCursorPosition: async () => ({ row: 4, col: 1 }),
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
  }
}

test("the nine reset-family rows declare one capture-region row each", () => {
  expect(Object.keys(RESET_FAMILY_CAPTURE).sort()).toEqual([...RESET_FAMILY_ROWS].sort())
})

test("every reset-family row keeps its witness and cursor out of the compared cells, and its ignored frame is the seed", () => {
  for (const id of RESET_FAMILY_ROWS) {
    const row = familyRow(id)
    const insideRow = row.sentinel.row >= row.region.top && row.sentinel.row <= row.region.bottom
    const insideColumn = row.sentinel.col >= row.region.left && row.sentinel.col <= row.region.right
    expect(insideRow && insideColumn, `${id}: the witness cell lies outside the compared region`).toBe(false)
    expect(
      row.cursorRow >= row.region.top && row.cursorRow <= row.region.bottom,
      `${id}: the cursor row lies outside the compared region`,
    ).toBe(false)
    expect(row.ignored, `${id}: the ignored frame IS the seed frame`).toBe(row.seed)
    expect(row.expected, `${id}: the expected frame differs from the seed`).not.toBe(row.seed)
    expect(row.edit, `${id}: the edit repaints the compared cells in place`).toContain("\x1b[3;")
  }
})

test("each reset-family row decides supported from its own same-run expected frame", async () => {
  for (const id of RESET_FAMILY_ROWS) {
    const result = await familyDecide(id, "expected")
    expect(result.observation.outcome, id).toBe("supported")
    expect(result.observation.evidence, id).toBe("pixels")
    expect(result.assertions?.[0]?.kind, id).toBe("positive")
  }
})

test("each reset-family row reads a no-op as the measured negative, never as a vacuous pass", async () => {
  for (const id of RESET_FAMILY_ROWS) {
    const result = await familyDecide(id, "ignored")
    expect(result.observation.outcome, id).toBe("unsupported")
    expect(result.assertions?.[0]?.kind, id).toBe("negative")
  }
})

test("each reset-family row names a third distinct frame instead of guessing a capability", async () => {
  for (const id of RESET_FAMILY_ROWS) {
    const result = await familyDecide(id, "third")
    expect(result.observation.outcome, id).toBe("inconclusive")
    expect(result.observation.note, id).toContain("a third distinct frame")
  }
})

test("every reset-family probe hands its capture arm to the region oracle, on the DECRQSS-silent path", async () => {
  const probes = [...sgrProbes, ...resetProbes]
  for (const id of RESET_FAMILY_ROWS) {
    const probe = probes.find((candidate) => candidate.id === id)
    expect(probe, `${id}: a probe definition`).toBeDefined()
    const ctx = familyTerminal("expected")
    const result = await probe!.term!(ctx)
    const observation = result.observation
    expect(observation, `${id}: an observation`).toBeDefined()
    expect(observation!.outcome, id).toBe("supported")
    expect(observation!.evidence, id).toBe("pixels")
    expect(observation!.note ?? "", `${id}: no ungraded "review required" note`).not.toContain(
      "visual interpretation requires review",
    )
  }
})

// ── Behavioural proof against a circular expected frame (@dev/review2, 29816 REVISE) ────────────
//
// The label-driven fixtures above cannot see a terminal whose SGR 0 is PARTIAL: they hand back the
// digest the label asks for. This terminal paints a real cell grid instead, so the expected frame's
// own bytes decide what it shows. A terminal that clears bold and inverse but retains italic paints
// the expected frame with italic still set, which is exactly the false pass review2 found.

type SgrAttr = "bold" | "italic" | "inverse" | "underline"

interface StatefulTerminal {
  ctx: TermContext
  cells: Map<string, string>
}

/** A terminal that paints cells under real SGR state; `sgr0` lists what its SGR 0 actually clears. */
function statefulTerminal(sgr0: readonly SgrAttr[]): StatefulTerminal {
  const state: Record<SgrAttr, boolean> = { bold: false, italic: false, inverse: false, underline: false }
  const cells = new Map<string, string>()
  let row = 1
  let col = 1
  let reads = 0
  const paint = () =>
    cells.set(
      `${row},${col}`,
      `${state.bold ? "b" : "-"}${state.italic ? "i" : "-"}${state.inverse ? "v" : "-"}${state.underline ? "u" : "-"}`,
    )
  const applySgr = (params: readonly number[]) => {
    const codes = params.length === 0 ? [0] : params
    for (const code of codes) {
      if (code === 0) {
        // A cleared attribute goes to false; one the terminal fails to clear KEEPS whatever it was.
        for (const attribute of Object.keys(state) as SgrAttr[]) if (sgr0.includes(attribute)) state[attribute] = false
      } else if (code === 1) state.bold = true
      else if (code === 3) state.italic = true
      else if (code === 4 || code === 21) state.underline = true
      else if (code === 7) state.inverse = true
      else if (code === 22) state.bold = false
      else if (code === 23) state.italic = false
      else if (code === 24) state.underline = false
      else if (code === 27) state.inverse = false
    }
  }
  const write = (sequence: string) => {
    let index = 0
    while (index < sequence.length) {
      const char = sequence[index]!
      if (char === "\x1b" && sequence[index + 1] === "c") {
        for (const attribute of Object.keys(state) as SgrAttr[]) state[attribute] = false
        cells.clear()
        row = 1
        col = 1
        index += 2
        continue
      }
      if (char === "\x1b" && sequence[index + 1] === "[") {
        let end = index + 2
        while (end < sequence.length && !/[@-~]/.test(sequence[end]!)) end += 1
        const final = sequence[end] ?? ""
        const raw = sequence.slice(index + 2, end)
        const params = raw === "" ? [] : raw.split(";").map((entry) => (entry === "" ? 0 : Number(entry)))
        if (final === "m") applySgr(params)
        else if (final === "H") {
          row = params[0] ?? 1
          col = params[1] ?? 1
        } else if (final === "J") cells.clear()
        index = end + 1
        continue
      }
      paint()
      col += 1
      index += 1
    }
  }
  const ctx = {
    rows: 24,
    cols: 80,
    captureGeometry: { geometry: GEOMETRY, source: "measured by complete raster calibration" },
    write,
    capture: async (request: { role: ObservationFrame["role"]; label: string; cells?: CaptureCells }) => {
      if (!request.cells) throw new Error("the stateful terminal is read by region")
      reads += 1
      const frame: ObservationFrame = {
        role: request.role,
        label: request.label,
        capturedAt: reads,
        ref: `sha256:${String(reads).repeat(64)}`,
      }
      const key = `${request.cells.top},${request.cells.left},${request.cells.bottom},${request.cells.right}`
      const digest =
        key === FAMILY_SENTINEL
          ? `witness|${cells.get("1,1") ?? ""}`
          : `${cells.get("3,5") ?? "empty"}/${cells.get("3,6") ?? "empty"}`
      return {
        ...frame,
        regionDigest: digest,
        pixelsDigest: `window|${digest}`,
        regionRectangle: { x: 0, y: 0, width: 16, height: 16 },
      }
    },
    queryCursorPosition: async () => ({ row: 4, col: 1 }),
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout" as const, raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout" as const, raw: "", rawBase64: "" }),
    queryMode: async () => null,
  } as unknown as TermContext
  return { ctx, cells }
}

test("a terminal whose SGR 0 retains italic cannot pass reset.sgr on a circular expected frame", async () => {
  const partial = statefulTerminal(["bold", "inverse"])
  const result = await captureRegionVerdict(partial.ctx, "reset.sgr", familyRow("reset.sgr"))
  expect(result?.observation, "reset.sgr produced no observation").toBeDefined()
  expect(result?.observation?.outcome, "a retained italic must never read as supported").not.toBe("supported")
})

test("a terminal whose SGR 0 retains underline cannot pass sgr.reset on a circular expected frame", async () => {
  const partial = statefulTerminal(["bold", "italic"])
  const result = await captureRegionVerdict(partial.ctx, "sgr.reset", familyRow("sgr.reset"))
  expect(result?.observation?.outcome, "a retained underline must never read as supported").not.toBe("supported")
})

test("a correct SGR 0 still decides both full-reset rows supported, so the fixture is not vacuous", async () => {
  for (const id of ["reset.sgr", "sgr.reset"] as const) {
    const correct = statefulTerminal(["bold", "italic", "inverse", "underline"])
    const result = await captureRegionVerdict(correct.ctx, id, familyRow(id))
    expect(result?.observation?.outcome, id).toBe("supported")
  }
})
