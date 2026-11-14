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
import { createHash } from "node:crypto"
import { expect, test } from "vitest"
import {
  captureRegionReadbackDecision,
  captureRegionGeometry,
  captureRegionCallbackResult,
  colourOnlyAttempts,
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
  CaptureRenderingAxes,
  MeasuredProbeCallbackResult,
  ObservationFrame,
  PixelCellCrop,
  PixelObservationFrame,
  ProbeCallbackResult,
  ProbeSuiteManifest,
  TermProbeSource,
  TerminalQueryOutcome,
} from "./types.ts"
import { RESET_FAMILY_CAPTURE } from "./reset-family-capture.ts"
import { sgrProbes } from "./sgr.ts"
import { resetProbes } from "./reset.ts"
import { initializeRunDraft, recordExecutedProbe, withReplyFailureEvidence } from "./helpers.ts"
import { decodeCollectorDraft } from "../../run-parser/src/index.ts"

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
  ctx: TermProbeSource
  read: RegionRead
  writes: string[]
  timeline: string[]
  requests: Array<{ region: CellRegion; pixelGeometry: PixelGeometry | undefined; label: string }>
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
  pixelMetadata?: boolean
  unstable?: boolean
  /**
   * The crop rectangle each read reports, keyed by that read's own label. Absent models a
   * hand-built read; the collector-backed reader always carries one with the region digest.
   */
  cropFor?: (label: string) => CaptureRectangle | undefined
  /**
   * The rendering axes and coverage each read reports for its own crop, keyed by that read's own
   * label. Absent models a capture adapter that records digests only, which is every frame written
   * before osc104.
   */
  renderingFor?: (label: string) => CaptureRenderingAxes | undefined
  /**
   * What the capture measured about the grid behind each read's rectangle, keyed by label (33982).
   * Absent models a pre-change or hand-built frame, which cannot be exempted.
   */
  cellCropFor?: (label: string) => PixelCellCrop | undefined
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
  const ctx: TermProbeSource = {
    kind: "live",
    rows: options.rows ?? 24,
    cols: options.cols ?? 80,
    write(sequence) {
      writes.push(sequence)
      timeline.push(`write:${sequence}`)
      pendingWrite = true
    },
    queryCursorPosition: async () => ({ row: 4, col: 1 }),
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
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
    const regionRectangle = options.cropFor?.(label)
    const cellCrop = options.cellCropFor?.(label)
    const frame: ObservationFrame = {
      role,
      label,
      capturedAt: reads,
      ref: `sha256:${String(reads).repeat(64)}`,
      ...(regionRectangle ? { regionRectangle } : {}),
      ...(cellCrop ? { cellCrop } : {}),
    }
    const cell = key(region)
    const content = cell === SENTINEL_CELL ? glyph : screen
    const suffix = options.unstable ? `-${reads}` : ""
    const capture: RegionCapture = {
      regionDigest: `${cell}|${content}${suffix}`,
      pixelsDigest: `frame|${screen}|${glyph}${suffix}`,
      ...(regionRectangle ? { regionRectangle } : {}),
      frame,
    }
    if (options.pixelMetadata) {
      Object.assign(frame, { kind: "pixels", regionDigest: capture.regionDigest, pixelsDigest: capture.pixelsDigest })
    }
    const rendering = options.renderingFor?.(label)
    if (rendering) capture.rendering = rendering
    return capture
  }
  return { ctx, read, writes, timeline, requests }
}

async function decide(fake: Fake, overrides: Partial<RegionReadback> = {}): Promise<MeasuredProbeCallbackResult> {
  const result = await captureRegionReadbackDecision(fake.ctx, "editing.delete-chars", spec(overrides), fake.read)
  if (!result?.observation) throw new Error("expected a decided result carrying an observation")
  return result as MeasuredProbeCallbackResult
}

/** The reads that compared the region; every other read is a witness or a baseline on one cell. */
function regionReads(fake: Fake): Fake["requests"] {
  return fake.requests.filter(({ region }) => key(region) !== SENTINEL_CELL)
}

test("a painted edit that reaches the expected frame is supported, from three witnessed captures", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 2, regionDigest: painter({ applied: "edited" }) })
  const result = await decide(fake)
  expect(result.observation.outcome).toBe("supported")
  expect(result.observation.assertionType).toBe("screenshot")
  expect(result.assertions?.[0]?.kind).toBe("positive")
  expect(regionReads(fake).map(({ label }) => label)).toEqual([
    "editing.delete-chars: capture stability 1",
    "editing.delete-chars: capture stability 2",
    "editing.delete-chars: pre-edit seed",
    "editing.delete-chars: post-sequence target",
    "editing.delete-chars: expected frame",
  ])
  expect(result.observation.frames).toHaveLength(8)
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

test("a frame that moves while the witness cell stands still does not name a cause", async () => {
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
  expect(result.observation.note).toContain("unchanged for 200 ms")
  expect(result.observation.note).toContain("while the frame changed")
  expect(result.observation.note).toContain("cause not determined")
  expect(result.observation.note).not.toContain("geometry is wrong")
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
  // The note names the axis space a PIXEL digest cannot separate (29577, @cto plan GO option A):
  // naming the axes is not naming a cause, so the verdict and its reason stay unchanged.
  expect(result.observation.note).toContain("glyph edges")
  expect(result.observation.note).toContain("background attributes")
  expect(result.observation.note).toContain("layout")
  expect(result.observation.note).not.toContain("the characters")
  expect(result.observation.note).toContain("compared frames: seed, expected")
  expect(result.observation.note).not.toContain("matched none of the compared frames")
  expect(result.observation.note).not.toContain("simply")
})

// osc104 (@cto plan GO, then coverage rule ±2 with floors): a pair whose target frame is the
// expected frame's own background and glyph coverage in a different INK COLOUR is a MEASURED colour
// result — graded negative, with both raw colours named — instead of the "a third distinct frame"
// refusal. Every guard below refuses exactly as before.
const coverage = (values: number[]) => Uint8Array.from(values)
// 16 ink pixels rising through every level, the shape a glyph edge makes.
const glyph = coverage([255, 240, 200, 160, 128, 96, 64, 32, 16, 0, 248, 192, 112, 48, 8, 255])
const axes = (
  inkColour: string,
  options: { coverage?: Uint8Array; background?: string; inkCount?: number; contrast?: number } = {},
) => ({
  background: options.background ?? "#050505",
  inkColour,
  inkCount: options.inkCount ?? glyph.length,
  contrast: options.contrast ?? 191,
  coverage: options.coverage ?? glyph,
})

test("the expected coverage in a different ink colour is graded unsupported and names both colours", async () => {
  const fake = ownedWindow({
    repaintAfterPolls: 1,
    regionDigest: painter({ applied: "other" }),
    pixelMetadata: true,
    renderingFor: (label) =>
      label.endsWith("pre-edit seed")
        ? axes("#616161")
        : label.endsWith("post-sequence target")
          ? axes("#123456")
          : label.endsWith("expected frame")
            ? axes("#c1e3fe")
            : undefined,
  })
  const result = await decide(fake)
  expect(result.observation.outcome).toBe("unsupported")
  expect(result.observation.note).toContain("same geometry in a different ink colour")
  expect(result.observation.note).toContain("#123456")
  expect(result.observation.note).toContain("#c1e3fe")
  expect(result.observation.note).toContain("#616161")
  expect(result.observation.note).toContain("paints a third colour")
  expect(result.observation.note).toContain("within 0 of 255")
  expect(result.observation.note).not.toContain("third distinct frame")
})

test("a target that paints the seed's own colour is named as no change, not as a third colour", async () => {
  const fake = ownedWindow({
    repaintAfterPolls: 1,
    regionDigest: painter({ applied: "other" }),
    pixelMetadata: true,
    renderingFor: (label) =>
      label.endsWith("post-sequence target") || label.endsWith("pre-edit seed")
        ? axes("#616161")
        : label.endsWith("expected frame")
          ? axes("#c1e3fe")
          : undefined,
  })
  const result = await decide(fake)
  expect(result.observation.outcome).toBe("unsupported")
  expect(result.observation.note).toContain("paints the seed's own colour")
  expect(result.observation.note).toContain("changed nothing in this region")
})

test("one or two levels of coverage rounding still fire, three levels refuse", async () => {
  const fire = ownedWindow({
    repaintAfterPolls: 1,
    regionDigest: painter({ applied: "other" }),
    pixelMetadata: true,
    renderingFor: (label) =>
      label.endsWith("post-sequence target")
        ? axes("#123456", {
            coverage: coverage([255, 240, 200, 160, 128, 96, 64, 32, 16, 0, 248, 192, 112, 48, 8, 253]),
          })
        : label.endsWith("expected frame")
          ? axes("#c1e3fe")
          : label.endsWith("pre-edit seed")
            ? axes("#616161")
            : undefined,
  })
  const fired = await decide(fire)
  expect(fired.observation.outcome).toBe("unsupported")
  expect(fired.observation.note).toContain("within 2 of 255")

  const refuse = ownedWindow({
    repaintAfterPolls: 1,
    regionDigest: painter({ applied: "other" }),
    pixelMetadata: true,
    renderingFor: (label) =>
      label.endsWith("post-sequence target")
        ? axes("#123456", {
            coverage: coverage([255, 240, 200, 160, 128, 96, 64, 32, 16, 0, 248, 192, 112, 48, 8, 252]),
          })
        : label.endsWith("expected frame")
          ? axes("#c1e3fe")
          : label.endsWith("pre-edit seed")
            ? axes("#616161")
            : undefined,
  })
  const refused = await decide(refuse)
  expect(refused.observation.outcome).toBe("inconclusive")
  expect(refused.observation.note).toContain("a third distinct frame")
})

test("a one-cell layout shift keeps today's third-distinct-frame refusal", async () => {
  const shifted = coverage([0, 255, 240, 200, 160, 128, 96, 64, 32, 16, 0, 248, 192, 112, 48, 8])
  const fake = ownedWindow({
    repaintAfterPolls: 1,
    regionDigest: painter({ applied: "other" }),
    pixelMetadata: true,
    renderingFor: (label) =>
      label.endsWith("post-sequence target")
        ? axes("#123456", { coverage: shifted })
        : label.endsWith("expected frame")
          ? axes("#c1e3fe")
          : label.endsWith("pre-edit seed")
            ? axes("#616161")
            : undefined,
  })
  const result = await decide(fake)
  expect(result.observation.outcome).toBe("inconclusive")
  expect(result.observation.note).toContain("a third distinct frame")
  expect(result.observation.note).not.toContain("same geometry in a different ink colour")
})

test("a low-contrast or nearly empty frame refuses, so rounding noise never reads as agreement", async () => {
  for (const weak of [{ contrast: 20 }, { inkCount: 4 }]) {
    const fake = ownedWindow({
      repaintAfterPolls: 1,
      regionDigest: painter({ applied: "other" }),
      pixelMetadata: true,
      renderingFor: (label) =>
        label.endsWith("post-sequence target")
          ? axes("#123456", weak)
          : label.endsWith("expected frame")
            ? axes("#c1e3fe")
            : label.endsWith("pre-edit seed")
              ? axes("#616161")
              : undefined,
    })
    const result = await decide(fake)
    expect(result.observation.outcome, JSON.stringify(weak)).toBe("inconclusive")
    expect(result.observation.note).toContain("a third distinct frame")
  }
})

test("a different background keeps today's third-distinct-frame refusal", async () => {
  const fake = ownedWindow({
    repaintAfterPolls: 1,
    regionDigest: painter({ applied: "other" }),
    pixelMetadata: true,
    renderingFor: (label) =>
      label.endsWith("post-sequence target")
        ? axes("#123456", { background: "#101010" })
        : label.endsWith("expected frame")
          ? axes("#c1e3fe")
          : label.endsWith("pre-edit seed")
            ? axes("#616161")
            : undefined,
  })
  const result = await decide(fake)
  expect(result.observation.outcome).toBe("inconclusive")
  expect(result.observation.note).toContain("a third distinct frame")
})

const attempt = (afterInk: string, expectedInk = "#c1e3fe", suffix = "") => [
  {
    kind: "pixels" as const,
    role: "control" as const,
    label: "extensions.osc104" + suffix + ": pre-edit seed",
    ref: "sha256:" + suffix + "seed",
    capturedAt: 0,
    rendering: axes("#616161"),
  },
  {
    kind: "pixels" as const,
    role: "target" as const,
    label: "extensions.osc104" + suffix + ": post-sequence target",
    ref: "sha256:" + suffix + "after",
    capturedAt: 1,
    rendering: axes(afterInk),
  },
  {
    kind: "pixels" as const,
    role: "control" as const,
    label: "extensions.osc104" + suffix + ": expected frame",
    ref: "sha256:" + suffix + "expected",
    capturedAt: 2,
    rendering: axes(expectedInk),
  },
]

test("two attempts that both fire keep the grade and name both after colours", () => {
  const frames = [...attempt("#616161", "#c1e3fe", "-a"), ...attempt("#123456", "#c1e3fe", "-b")]
  const verdict = colourOnlyAttempts("extensions.osc104-reset-palette", frames as never)
  expect(verdict).toBeDefined()
  expect(verdict && "rounds" in verdict ? verdict.rounds : 0).toBe(2)
  const note = verdict && "note" in verdict ? verdict.note : ""
  expect(note).toContain("after colour differed between attempts")
  expect(note).toContain("#616161")
  expect(note).toContain("#123456")
  expect(note).toContain("no-effect")
  expect(note).toContain("third-colour")
  expect(note).toContain("not published as the terminal's behaviour")
})

test("an attempt that matches the expected ink refuses with a named attempts-disagree reason", () => {
  const frames = [...attempt("#123456", "#c1e3fe", "-a"), ...attempt("#c1e3fe", "#c1e3fe", "-b")]
  const verdict = colourOnlyAttempts("extensions.osc104-reset-palette", frames as never)
  expect(verdict && "disagreement" in verdict ? verdict.disagreement : "").toContain("attempts disagree")
})

test("one attempt alone decides nothing extra: the reader's own verdict stands", () => {
  expect(colourOnlyAttempts("extensions.osc104-reset-palette", attempt("#123456") as never)).toBeUndefined()
})

test("a match still grades supported when the frames carry rendering axes", async () => {
  const fake = ownedWindow({
    repaintAfterPolls: 2,
    regionDigest: painter({ applied: "edited" }),
    pixelMetadata: true,
    renderingFor: (label) => (label.endsWith("post-sequence target") ? axes("#c1e3fe") : undefined),
  })
  const result = await decide(fake)
  expect(result.observation.outcome).toBe("supported")
  expect(result.assertions?.[0]?.kind).toBe("positive")
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
  expect(result.observation.assertionType).toBe("query_reply")
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
  setupReference: "\x1b[1;1HDDD",
} as const
const PLANE_SPEC = { seed: PLANES.seed, edit: PLANES.edit, expected: PLANES.expected, ignored: PLANES.ignored }

/** The frame the terminal shows: whichever plane was painted LAST, with `applied` for the target. */
function planePainter(applied: string, ignoredReadsAs?: string): Painter {
  return (writes) => {
    const joined = writes.join("")
    if (ignoredReadsAs !== undefined && joined.includes(PLANES.ignored)) return ignoredReadsAs
    const planes: Array<[string, string]> = [
      ["seed", PLANES.setupReference],
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
  expect(result.observation.frames).toHaveLength(10)
  expect(regionReads(fake).map(({ label }) => label)).toEqual([
    "editing.delete-chars: capture stability 1",
    "editing.delete-chars: capture stability 2",
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
  expect(result.observation.frames).toHaveLength(8)
})

test("a setup reference must equal the seed before either a verdict or a collapsed-control refusal", async () => {
  for (const applied of ["expected", "seed", "ignored", "third"]) {
    const fake = ownedWindow({
      repaintAfterPolls: 1,
      regionDigest: (writes) =>
        writes.join("").includes(PLANES.setupReference) ? "independent-setup" : planePainter(applied)(writes),
    })
    const result = await decide(fake, { ...PLANE_SPEC, setupReference: PLANES.setupReference })
    expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(result.observation.note).toContain("setup reference")
    expect(result.observation.note).toContain("seed")
    expect(result.observation.note).not.toContain("third distinct")
    expect(result.assertions ?? []).toHaveLength(0)
    expect(result.observation.frames).toHaveLength(12)
  }
  const fake = ownedWindow({
    repaintAfterPolls: 1,
    regionDigest: (writes) => (writes.join("").includes(PLANES.setupReference) ? "different-setup" : "same"),
  })
  const result = await decide(fake, { ...PLANE_SPEC, setupReference: PLANES.setupReference })
  expect(result.observation.note).toContain("setup reference")
  expect(result.observation.note).not.toContain("cannot separate")
})

test("a matching setup reference adds independent witnessed evidence", async () => {
  for (const setupReference of [undefined, PLANES.setupReference]) {
    const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: planePainter("expected") })
    const result = await decide(fake, { ...PLANE_SPEC, ...(setupReference && { setupReference }) })
    expect(result.observation.outcome).toBe("supported")
    expect(result.observation.frames).toHaveLength(setupReference ? 12 : 10)
    expect(regionReads(fake).map(({ label }) => label)).toEqual([
      "editing.delete-chars: capture stability 1",
      "editing.delete-chars: capture stability 2",
      "editing.delete-chars: pre-edit seed",
      "editing.delete-chars: post-sequence target",
      "editing.delete-chars: expected frame",
      "editing.delete-chars: ignored-attribute frame",
      ...(setupReference ? ["editing.delete-chars: setup reference frame"] : []),
    ])
    const response = JSON.parse(result.response!)
    expect(response).toMatchObject({
      seed: "1,1,1,8|seed",
      after: "1,1,1,8|expected",
      expected: "1,1,1,8|expected",
      ignored: "1,1,1,8|ignored",
    })
    if (setupReference) expect(response).toHaveProperty("setupReference", "1,1,1,8|seed")
    else expect(response).not.toHaveProperty("setupReference")
  }
})

test("a missing setup-reference digest raises instead of returning a reset verdict", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: planePainter("expected") })
  const read = fake.read
  fake.read = async (request) => {
    const capture = await read(request)
    return request.label.endsWith("setup reference frame") ? { ...capture, regionDigest: undefined! } : capture
  }
  await expect(decide(fake, { ...PLANE_SPEC, setupReference: PLANES.setupReference })).rejects.toThrow("digests")
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

/**
 * @failure A stable paint witness hides moving compared cells, or unrelated whole-window motion
 *   refuses a settled compared rectangle (30031). Existing unstable rows move both digests together.
 * @level l1
 * @consumer The production region decision over an owned capture, before its verdict frames.
 */
test.each(["outside", "inside", "crop", "missing-first", "missing-second"] as const)(
  "stability follows the compared cells: %s movement",
  async (movement) => {
    const rectangle = { x: 0, y: 0, width: 64, height: 16 }
    const fake = ownedWindow({
      repaintAfterPolls: 1,
      regionDigest: painter({ applied: "edited" }),
      cropFor: () => rectangle,
    })
    const read = fake.read
    let secondRef: string | undefined
    fake.read = async (request) => {
      const captured = await read(request)
      if (!request.label.includes("capture stability")) return captured
      if (captured.frame.kind === "text-cells") throw new Error("ownedWindow stability fixture requires pixels")
      const second = request.label.endsWith("2")
      if (second) secondRef = captured.frame.ref
      const crop =
        (movement === "missing-first" && !second) || (movement === "missing-second" && second)
          ? undefined
          : movement === "crop" && second
            ? { ...rectangle, x: 8 }
            : rectangle
      return {
        ...captured,
        // The witness remains fixed. Only a read of the actual compared cells sees this change.
        regionDigest:
          movement === "inside" && second && key(request.region) !== SENTINEL_CELL
            ? `${captured.regionDigest}:changed`
            : captured.regionDigest,
        pixelsDigest: second && movement !== "crop" ? `${captured.pixelsDigest}:changed` : captured.pixelsDigest,
        regionRectangle: crop,
        frame: { ...captured.frame, regionRectangle: crop },
      }
    }
    const result = await decide(fake)
    expect(result.observation.outcome).toBe(movement === "outside" ? "supported" : "inconclusive")
    if (movement === "inside") expect(result.observation.note).toContain("not byte-stable")
    if (movement === "crop") expect(result.observation.note).toContain("different screen positions")
    if (movement !== "outside") {
      expect(result.observation.screenshotRef).toBe(secondRef)
      expect(result.observation.frames ?? []).toEqual([])
    }
    if (movement === "outside") {
      expect(JSON.parse(String(result.response))).toMatchObject({
        stability: {
          regionDigest: ["1,1,1,8|seed", "1,1,1,8|seed"],
          pixelsDigest: ["frame|seed|", "frame|seed|:changed"],
          wholeWindowChanged: true,
        },
      })
    }
  },
)

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
  const result = await captureRegionReadbackDecision(
    fake.ctx,
    "editing.delete-chars",
    spec({ region: { top: 1, left: 1, bottom: 1, right: 81 } }),
    fake.read,
  )
  expect(result?.observation).toBeUndefined()
  expect(result?.tests).toMatchObject([
    { status: "probe-todo", reason: expect.stringContaining("leaves the measured 24x80 grid") },
  ])
  expect(fake.writes).toEqual([])
})

test("a witness cell inside the compared region refuses before any byte", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: () => "seed" })
  const result = await captureRegionReadbackDecision(
    fake.ctx,
    "editing.delete-chars",
    spec({ sentinel: { row: 1, col: 4 } }),
    fake.read,
  )
  expect(result?.observation).toBeUndefined()
  expect(result?.tests).toMatchObject([
    { status: "probe-todo", reason: expect.stringContaining("lies inside compared region") },
  ])
  expect(fake.writes).toEqual([])
})

test("a compared region covering the cursor row refuses before any byte", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: () => "seed" })
  const result = await captureRegionReadbackDecision(
    fake.ctx,
    "editing.delete-chars",
    spec({ cursorRow: 1 }),
    fake.read,
  )
  expect(result?.observation).toBeUndefined()
  expect(result?.tests).toMatchObject([
    { status: "probe-todo", reason: expect.stringContaining("includes the cursor row 1") },
  ])
  expect(fake.writes).toEqual([])
})

test("an undersized measured grid refuses before any byte", async () => {
  const fake = ownedWindow({ rows: 2, cols: 4, repaintAfterPolls: 1, regionDigest: () => "seed" })
  const result = await captureRegionReadbackDecision(fake.ctx, "editing.delete-chars", spec(), fake.read)
  expect(result?.observation).toBeUndefined()
  expect(result?.tests).toMatchObject([
    { status: "probe-todo", reason: expect.stringContaining("needs a measured grid of at least 2x9") },
  ])
  expect(fake.writes).toEqual([])
})

test("a terminal that answered neither pixel report refuses before any byte", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: () => "seed" })
  const result = await captureRegionReadbackDecision(
    fake.ctx,
    "editing.delete-chars",
    spec({
      pixelGeometry: { cellWidth: 0, cellHeight: 16, textWidth: 640, textHeight: 384 },
    }),
    fake.read,
  )
  expect(result?.observation).toBeUndefined()
  expect(result?.tests).toMatchObject([
    { status: "probe-todo", reason: expect.stringContaining("positive pixel report") },
  ])
  expect(fake.writes).toEqual([])
})

test("every capture carries the terminal's own pixel report, and witness reads use the reserved cell alone", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: painter({ applied: "edited" }) })
  const result = await decide(fake)
  expect(result.observation.outcome).toBe("supported")
  expect(regionReads(fake)).toHaveLength(5)
  for (const { region, pixelGeometry } of fake.requests) {
    expect(pixelGeometry).toEqual(GEOMETRY)
    expect(["1,1,1,8", SENTINEL_CELL]).toContain(key(region))
  }
  expect(fake.requests.filter(({ region }) => key(region) !== SENTINEL_CELL)).toHaveLength(5)
})

// The raw-run contract requires a citation (child 28582, @cto b12b71b2): evidence "pixels" is
// refused unless the observation carries a screenshotRef, and evidence "none" is refused unless its
// trace is zero-byte. A query already written is therefore NOT "none", and a branch that captured
// must cite the capture.

test("a pixel query answered with a sentinel reports query evidence, not a zero-byte refusal", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: () => "seed" })
  const ctx: TermProbeSource = {
    ...fake.ctx,
    queryWithSentinelOutcome: async () => ({ match: null, reason: "sentinel", raw: "\x1b[?1;2c", rawBase64: "" }),
    capture: async (request) => ({
      role: request.role,
      label: request.label,
      capturedAt: 1,
      ref: `sha256:${"a".repeat(64)}`,
    }),
  }
  const geometry = spec()
  const result = await captureRegionCallbackResult(ctx, "editing.delete-chars", {
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
  expect(result.observation.assertionType).toBe("query_reply")
  expect(result.observation.note).toContain("CSI 16 t")
  expect(result.tests).toMatchObject([
    {
      id: "criterion",
      status: "probe-invalid",
      reason: expect.stringContaining("this run cannot map cells onto the captured window"),
    },
  ])
  expect(result.assertions).toBeUndefined()
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
  expect(result.observation.assertionType).toBe("screenshot")
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

  // The sentinel case above retained real bytes. Two empty timeouts retain no deciding reply;
  // the no-capture census cannot witness this geometry path, which runs before taking a frame.
  const queries: Array<{ sequence: string; outcome: TerminalQueryOutcome }> = []
  fake.ctx.queryWithSentinelOutcome = async (sequence) => {
    const outcome: TerminalQueryOutcome = { match: null, reason: "timeout", raw: "", rawBase64: "" }
    queries.push({ sequence, outcome })
    return outcome
  }
  const declined = await captureRegionGeometry(fake.ctx, "editing.delete-chars", spec())
  if (!("pass" in declined)) throw new Error("Empty geometry replies must decline the capture")
  expect(declined.observation).toBeUndefined()
  expect(declined.tests).toMatchObject([
    { id: "criterion", status: "probe-invalid", reason: expect.stringContaining("CSI 16 t") },
  ])
  const raw = JSON.stringify(queries)
  const result = recordExecutedProbe({
    featureId: "editing.delete-chars",
    attempt: { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" },
    rawReplyRef: "editing.delete-chars",
    assertions: [],
    tests: declined.tests,
  })
  expect(result.status).toBe("probe-invalid")
  expect(result.assertionType).toBeUndefined()
  expect(result.reason).toContain("CSI 14 t")
  expect(result.reason).toContain("timeout")
  expect(result.rawReplyRef).toBe("editing.delete-chars")
  expect(queries.map(({ sequence }) => sequence)).toEqual(["\x1b[16t", "\x1b[14t"])
  expect(queries.every(({ outcome }) => outcome.raw === "" && outcome.reason === "timeout")).toBe(true)
  expect(JSON.stringify(queries)).toBe(raw)
  expect(fake.requests).toEqual([])
})

// The geometry refusal tests above omit the producer formatter: they missed lost request
// evidence when a partial reply and a required empty timeout coexist on one measured callback.
test.each([
  ["all empty", "", "", "", true, false],
  ["missing text pixels", "\x1b[6;16;8t", "", "", true, true],
  ["missing text cells", "\x1b[?6c", "\x1b[4;384;640t", "", true, true],
  ["zero cell size", "\x1b[6;0;8t", "\x1b[4;384;640t", "", false, true],
  ["nondivisible", "\x1b[?6c", "\x1b[4;384;641t", "\x1b[8;24;80t", false, true],
  ["sentinel", "\x1b[6;16;8t", "\x1b[?6c", "", false, true],
  ["malformed timeout", "\x1b[6;16;8t", "garbage", "", false, true],
] as const)("retains required geometry failure evidence for %s", async (_, cell, pixels, cells, marked, observed) => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: () => "seed" })
  const attempts: Array<{
    sequence: string
    received: string
    timeoutMs: number
    match: string[] | null
    reason: TerminalQueryOutcome["reason"]
  }> = []
  fake.ctx.queryWithSentinelOutcome = async (sequence, pattern) => {
    const raw = sequence === "\x1b[16t" ? cell : sequence === "\x1b[14t" ? pixels : cells
    const match = pattern.exec(raw)
    const reason = match ? "reply" : raw === "\x1b[?6c" ? "sentinel" : "timeout"
    attempts.push({ sequence, received: raw, timeoutMs: 37, match, reason })
    return { raw, rawBase64: btoa(raw), match, reason }
  }
  const callback = await captureRegionGeometry(fake.ctx, "editing.delete-chars", spec())
  if (!("pass" in callback)) throw new Error("Expected the current geometry refusal")
  const observation = structuredClone(callback.observation)
  const criterionReason = callback.tests?.[0]?.reason
  expect(Boolean(observation)).toBe(observed)
  expect("replyFailureTestIds" in callback ? callback.replyFailureTestIds : undefined).toEqual(
    marked ? ["criterion"] : undefined,
  )
  const formatted = withReplyFailureEvidence("editing.delete-chars", callback, { producer: "TTY", attempts })
  expect(formatted.observation).toEqual(observation)
  const stored = recordExecutedProbe({
    featureId: "editing.delete-chars",
    attempt: { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" },
    rawReplyRef: "editing.delete-chars",
    ...(formatted.observation && {
      observation: { ...formatted.observation, featureId: "editing.delete-chars", rawReplyRef: "editing.delete-chars" },
    }),
    assertions: [],
    tests: formatted.tests,
  })
  expect(stored.status).toBe("probe-invalid")
  expect(stored).not.toHaveProperty("replyFailureTestIds")
  if (observed) expect(stored.reason).toBe(observation?.note)
  if (marked) {
    for (const entry of attempts) {
      expect(stored.tests[0]?.reason).toContain(
        `sent ${JSON.stringify(entry.sequence)}; received ${JSON.stringify(entry.received)}`,
      )
    }
    expect(stored.tests[0]?.reason).toContain("timeout 37 ms")
  } else expect(stored.tests[0]?.reason).toBe(criterionReason)
  expect(fake.requests).toEqual([])
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
  expect(result.observation.assertionType).toBe("screenshot")
  expect(result.observation.screenshotRef).toBeDefined()
})

test("a degenerate seed-equals-expected run cites the frames it took", async () => {
  const fake = ownedWindow({ repaintAfterPolls: 1, regionDigest: () => "same" })
  const result = await decide(fake)
  expect(result.observation.outcome).toBe("inconclusive")
  expect(result.observation.assertionType).toBe("screenshot")
  expect(result.observation.screenshotRef).toBeDefined()
  expect(result.observation.frames).toHaveLength(8)
})

test("a paint-witness timeout cites the capture it took, so the run stays writable", async () => {
  const fake = ownedWindow({ repaintAfterPolls: "never", regionDigest: () => "seed" })
  const result = await decide(fake)
  expect(result.observation.outcome).toBe("inconclusive")
  expect(result.observation.reason).toBe("timeout")
  expect(result.observation.assertionType).toBe("screenshot")
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
      kind: "pixels" as const,
      role: captured.frame.role,
      label: captured.frame.label,
      capturedAt: captured.frame.capturedAt,
      ref: captured.frame.ref,
      ...(captured.frame.sourceRef ? { sourceRef: captured.frame.sourceRef } : {}),
      regionDigest: captured.regionDigest,
      pixelsDigest: captured.pixelsDigest,
      ...(captured.regionRectangle ? { regionRectangle: captured.regionRectangle } : {}),
    }
  }
  const result = await captureRegionCallbackResult(fake.ctx, "editing.delete-chars", spec())
  expect(result?.observation).toMatchObject({ outcome: "supported", assertionType: "screenshot" })
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
  const result = await captureRegionCallbackResult(fake.ctx, "editing.delete-chars", spec())
  if (result === null) throw new Error("Expected the calibrated footprint refusal, not an absent capture path")
  expect(result.observation).toBeUndefined()
  expect(result).toMatchObject({
    tests: [
      expect.objectContaining({
        status: "probe-todo",
        reason: expect.stringMatching(/calibrated.*grid|grid.*calibrated/),
      }),
    ],
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
    assertionType: "screenshot",
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

// ── The reset-family decision table ──────────────────────────────────────────────────────────────
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
  const result = await decide(fake, { ...PLANE_SPEC, ignored: PLANES.seed })
  expect(result.observation.outcome).toBe("unsupported")
  expect(result.assertions?.[0]?.kind).toBe("negative")
})

test("a change outside the compared cells moves the whole window and not the verdict", async () => {
  const fake = ownedWindow({
    repaintAfterPolls: 1,
    regionDigest: () => "frame",
    cropFor: () => ({ x: 0, y: 0, width: 64, height: 16 }),
  })
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
  expect(result?.observation).toMatchObject({ outcome: "supported", assertionType: "screenshot" })
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

/**
 * The rows whose reset clears two or more setup attributes. Their expected pixel cannot be produced
 * by a reference independent of that reset, so the pixel oracle declines them by name instead of
 * grading them against a reference that can share the tested sequence's failure.
 */
const NO_REFERENCE_ROWS = ["reset.sgr", "sgr.reset", "sgr.selective-reset.bold"] as const
const GRADED_ROWS = RESET_FAMILY_ROWS.filter((id) => !(NO_REFERENCE_ROWS as readonly string[]).includes(id))

/** The reset-family witness cell, and the shape of one read of its own compared region. */
const FAMILY_SENTINEL = "1,1,1,1"

function familyRow(id: (typeof RESET_FAMILY_ROWS)[number]): Omit<RegionReadback, "pixelGeometry"> {
  const row = RESET_FAMILY_CAPTURE[id]
  if (!row) throw new Error(`${id}: no capture-region row is declared`)
  return row
}

async function familyDecide(
  id: (typeof RESET_FAMILY_ROWS)[number],
  applied: string,
): Promise<MeasuredProbeCallbackResult> {
  const result = await captureRegionCallbackResult(familyTerminal(applied), id, familyRow(id))
  if (!result?.observation) throw new Error(`${id}: the fixture run produced no observation`)
  return result as MeasuredProbeCallbackResult
}

function familyDigest(label: string, applied: string): string {
  return label.endsWith("pre-edit seed") || label.endsWith("setup reference frame")
    ? "seed"
    : label.endsWith("post-sequence target")
      ? applied
      : label.endsWith("expected frame")
        ? "expected"
        : "ignored"
}

/** A terminal that shows the witness glyph the oracle just wrote and the named plane per frame. */
function familyTerminal(applied: string): TermProbeSource {
  let glyph = ""
  let reads = 0
  const frameFor = (role: ObservationFrame["role"], label: string): PixelObservationFrame => {
    reads += 1
    return { role, label, capturedAt: reads, ref: `sha256:${String(reads).repeat(64)}` }
  }
  return {
    kind: "live",
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
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
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

test("every reset-family row keeps its witness and cursor outside the compared cells", () => {
  for (const id of RESET_FAMILY_ROWS) {
    const row = familyRow(id)
    const insideRow = row.sentinel.row >= row.region.top && row.sentinel.row <= row.region.bottom
    const insideColumn = row.sentinel.col >= row.region.left && row.sentinel.col <= row.region.right
    expect(insideRow && insideColumn, `${id}: the witness cell lies outside the compared region`).toBe(false)
    expect(
      row.cursorRow >= row.region.top && row.cursorRow <= row.region.bottom,
      `${id}: the cursor row lies outside the compared region`,
    ).toBe(false)
    if (
      !row.savedRendition &&
      (id === "sgr.fg.default" || id === "sgr.bg.default" || (NO_REFERENCE_ROWS as readonly string[]).includes(id))
    ) {
      expect(row.ignored, `${id}: the ignored frame IS the seed frame`).toBe(row.seed)
      expect(row.setupReference, `${id}: unchanged reference scope`).toBeUndefined()
    }
    expect(row.expected, `${id}: the expected frame differs from the seed`).not.toBe(row.seed)
    expect(row.edit, `${id}: the edit repaints the compared cells in place`).toContain("\x1b[3;")
  }
})

test("each reset-family row decides supported from its own same-run expected frame", async () => {
  for (const id of GRADED_ROWS) {
    const result = await familyDecide(id, "expected")
    expect(result.observation.outcome, id).toBe("supported")
    expect(result.observation.assertionType, id).toBe("screenshot")
    expect(result.assertions?.[0]?.kind, id).toBe("positive")
  }
})

test("each reset-family row reads a no-op as the measured negative, never as a vacuous pass", async () => {
  for (const id of GRADED_ROWS) {
    const result = await familyDecide(id, "ignored")
    expect(result.observation.outcome, id).toBe("unsupported")
    expect(result.assertions?.[0]?.kind, id).toBe("negative")
  }
})

test("each reset-family row names a third distinct frame instead of guessing a capability", async () => {
  for (const id of GRADED_ROWS) {
    const result = await familyDecide(id, "third")
    expect(result.observation.outcome, id).toBe("inconclusive")
    expect(result.observation.note, id).toContain("a third distinct frame")
  }
})

test("every reset-family probe hands its capture arm to the region oracle, on the DECRQSS-silent path", async () => {
  const probes = [...sgrProbes, ...resetProbes]
  for (const id of GRADED_ROWS) {
    const probe = probes.find((candidate) => candidate.id === id)
    expect(probe, `${id}: a probe definition`).toBeDefined()
    const ctx = familyTerminal("expected")
    const result = await probe!.term!(ctx)
    const observation = result.observation
    expect(observation, `${id}: an observation`).toBeDefined()
    expect(observation!.outcome, id).toBe("supported")
    expect(observation!.assertionType, id).toBe("screenshot")
    expect(observation!.note ?? "", `${id}: no ungraded "review required" note`).not.toContain(
      "no same-run pixel check decides the visual effect",
    )
  }
  for (const id of NO_REFERENCE_ROWS.filter((id) => id !== "reset.sgr")) {
    const probe = probes.find((candidate) => candidate.id === id)
    expect(probe, `${id}: a probe definition`).toBeDefined()
    const result = await probe!.term!(statefulTerminal(ALL_ATTRS, { invisible: ["italic"] }).ctx)
    expect(result.observation, id).toBeUndefined()
    expect(result.tests, id).toMatchObject([
      {
        status: "probe-invalid",
        reason: expect.stringContaining("no independent reference exists for a multi-attribute reset"),
      },
    ])
    // The attempted DECRQSS readback makes the named refusal FAILURE; no reply was retained,
    // so it cannot become a query observation.
  }
})

test("a silent DECRQSS readback retains a named failure, and an answering one still grades the row", async () => {
  // The callback attempted DECRQSS but retained no reply. Its named failure keeps the
  // write/query trace without inventing a typed query observation.
  // The DECRQSS-supported path must survive: a terminal that reports its actual baseline, setup
  // and post-reset state is still graded structurally; only a silent one reaches the named refusal.
  const probes = [...sgrProbes, ...resetProbes]
  for (const id of NO_REFERENCE_ROWS.filter((id) => id !== "reset.sgr")) {
    const probe = probes.find((candidate) => candidate.id === id)
    expect(probe, `${id}: a probe definition`).toBeDefined()
    const terminal = statefulTerminal(ALL_ATTRS, { ris: true, invisible: ["italic"] })
    const result = await probe!.term!(terminal.ctx)
    expect(result.observation, id).toBeUndefined()
    expect(result.tests, id).toMatchObject([
      {
        status: "probe-invalid",
        reason: expect.stringContaining("no independent reference exists for a multi-attribute reset"),
      },
    ])
    expect(terminal.writes.length, `${id}: the readback wrote before declining`).toBeGreaterThan(0)
    expect(terminal.queries, `${id}: the DECRQSS query was sent`).toContain("\x1bP$qm\x1b\\")
    expect(result.tests?.[0]?.reason, id).toContain("no independent reference exists for a multi-attribute reset")
    expect(result.tests?.[0]?.reason, id).toContain("the caller wrote before this refusal")
  }
  for (const id of NO_REFERENCE_ROWS) {
    const probe = probes.find((candidate) => candidate.id === id)
    const terminal = statefulTerminal(ALL_ATTRS, { ris: true })
    // The saved-reference capture now decides first; retain separate proof of the query-only route.
    delete terminal.ctx.capture
    terminal.ctx.queryWithSentinelOutcome = async () => {
      const state = terminal.snapshot()
      const reported =
        (
          [
            ["bold", "1"],
            ["faint", "2"],
            ["italic", "3"],
            ["underline", "4"],
            ["inverse", "7"],
          ] as const
        )
          .filter(([attribute]) => state.has(attribute))
          .map(([, code]) => code)
          .join(";") || "0"
      return {
        match: [`\x1bP1$r${reported}m\x1b\\`, reported],
        reason: "reply" as const,
        raw: "",
        rawBase64: "",
      }
    }
    const result = await probe!.term!(terminal.ctx)
    expect(result.observation?.outcome, `${id}: DECRQSS still grades this row`).toBe("supported")
    expect(result.observation?.assertionType, id).toBe("query_reply")
  }
})

// ── Behavioural proof against a circular expected frame ────────────────────────────────────────
//
// The label-driven fixtures above cannot see a terminal whose SGR 0 is PARTIAL: they hand back the
// digest the label asks for. This terminal paints a real cell grid instead, so the expected frame's
// own bytes decide what it shows. A terminal that clears bold and inverse but retains italic paints
// the expected frame with italic still set, which is the false pass this fixture exists to catch.

type SgrAttr = "bold" | "italic" | "inverse" | "underline" | "faint"
type SgrColor = "fg" | "bg" | "uc"
const SGR_ATTRS: readonly SgrAttr[] = ["bold", "italic", "inverse", "underline", "faint"]

interface StatefulTerminal {
  ctx: TermProbeSource
  cells: Map<string, string>
  /** The attributes and colours currently set, read straight from the model. */
  snapshot: () => Set<string>
  /** Every byte this terminal was written, in order — the raw trace the evidence must match. */
  writes: string[]
  /** Every sequence it was queried with, in order. */
  queries: string[]
  captures: string[]
}

interface StatefulOptions {
  ris?: boolean
  initial?: readonly SgrAttr[]
  restoreRetains?: readonly SgrAttr[]
  invisible?: readonly SgrAttr[]
  invalidSgrChanges?: boolean
  resetAddsUnderline?: boolean
  resetDropsItalic?: boolean
  hideBoldWithItalic?: boolean
  /** Attributes the reference does NOT clear: a partial-RIS terminal. */
  risRetains?: readonly (SgrAttr | SgrColor)[]
  risClearsCells?: boolean
  /** Attributes the RESET UNDER TEST fails to clear: the row's cleared set minus this. */
  resetMisses?: readonly (SgrAttr | SgrColor)[]
  ignoreBold?: "always" | "combined"
  resetDropsBold?: boolean
  resetAddsBold?: boolean
  replies?: readonly string[]
}

/** A terminal that paints cells under real SGR state; `sgr0` lists what its SGR 0 actually clears. */
function statefulTerminal(sgr0: readonly SgrAttr[], options: StatefulOptions = {}): StatefulTerminal {
  const state: Record<SgrAttr, boolean> = { bold: false, italic: false, inverse: false, underline: false, faint: false }
  for (const attribute of options.initial ?? []) state[attribute] = true
  const color: Record<SgrColor, string | undefined> = { fg: undefined, bg: undefined, uc: undefined }
  const cells = new Map<string, string>()
  const writes: string[] = []
  const queries: string[] = []
  const captures: string[] = []
  let row = 1
  let col = 1
  let reads = 0
  let saved: { state: typeof state; color: typeof color; row: number; col: number } | undefined
  const visible = (attribute: SgrAttr) =>
    state[attribute] &&
    !options.invisible?.includes(attribute) &&
    !(attribute === "bold" && options.hideBoldWithItalic && state.italic)
  const paint = (char: string) =>
    cells.set(
      `${row},${col}`,
      `${char}|${visible("bold") ? "b" : "-"}${visible("faint") ? "f" : "-"}${visible("italic") ? "i" : "-"}${visible("inverse") ? "v" : "-"}${visible("underline") ? "u" : "-"}|${color.fg ?? ""}|${color.bg ?? ""}|${state.underline ? (color.uc ?? "") : ""}`,
    )
  const miss = new Set<SgrAttr | SgrColor>(options.resetMisses ?? [])
  const clear = (attribute: SgrAttr) => {
    if (!miss.has(attribute) && sgr0.includes(attribute)) state[attribute] = false
  }
  const clearColour = (attribute: SgrColor) => {
    if (!miss.has(attribute)) color[attribute] = undefined
  }
  const applySgr = (params: readonly number[]) => {
    const codes = params.length === 0 ? [0] : params
    for (let index = 0; index < codes.length; index += 1) {
      const code = codes[index]!
      if (code === 0) {
        // A cleared attribute goes to false; one the terminal fails to clear KEEPS whatever it was.
        for (const attribute of SGR_ATTRS) clear(attribute)
        clearColour("fg")
        clearColour("bg")
        clearColour("uc")
        if (options.resetAddsUnderline) state.underline = true
      } else if (code === 1) {
        if (options.ignoreBold !== "always" && !(options.ignoreBold === "combined" && codes.length > 1)) {
          state.bold = true
        }
      } else if (code === 2) state.faint = true
      else if (code === 3) state.italic = true
      else if (code === 4 || code === 21) state.underline = true
      else if (code === 7) state.inverse = true
      else if (code === 22) {
        if (!miss.has("bold")) state.bold = false
        if (!miss.has("faint")) state.faint = false
        if (options.resetDropsItalic) state.italic = false
      } else if (code === 23) {
        if (!miss.has("italic")) state.italic = false
        if (options.resetDropsBold) state.bold = false
        if (options.resetAddsBold) state.bold = true
      } else if (code === 24) {
        if (!miss.has("underline")) state.underline = false
        if (options.resetDropsBold) state.bold = false
        if (options.resetAddsBold) state.bold = true
      } else if (code === 27) {
        if (!miss.has("inverse")) state.inverse = false
        if (options.resetDropsBold) state.bold = false
        if (options.resetAddsBold) state.bold = true
      } else if (code >= 30 && code <= 37) color.fg = String(code)
      else if (code === 39) clearColour("fg")
      else if (code >= 40 && code <= 47) color.bg = String(code)
      else if (code === 49) clearColour("bg")
      else if (code === 58) {
        color.uc = codes.slice(index).join(";")
        index = codes.length
      } else if (code === 59) clearColour("uc")
      else if (code === 99 && options.invalidSgrChanges) state.underline = true
    }
  }
  const snapshot = () =>
    new Set<string>([
      ...SGR_ATTRS.filter((attribute) => state[attribute]),
      ...(["fg", "bg", "uc"] as SgrColor[]).filter((attribute) => color[attribute] !== undefined),
    ])
  const write = (sequence: string) => {
    writes.push(sequence)
    let index = 0
    while (index < sequence.length) {
      const char = sequence[index]!
      if (char === "\x1b" && (sequence[index + 1] === "7" || sequence[index + 1] === "8")) {
        if (sequence[index + 1] === "7") saved = { state: { ...state }, color: { ...color }, row, col }
        else if (saved) {
          for (const attribute of SGR_ATTRS) {
            if (!options.restoreRetains?.includes(attribute)) state[attribute] = saved.state[attribute]
          }
          Object.assign(color, saved.color)
          row = saved.row
          col = saved.col
        }
        index += 2
        continue
      }
      if (char === "\x1b" && sequence[index + 1] === "c") {
        // A terminal that ignores RIS leaves both the cells and the SGR state exactly as they were.
        if (options.ris !== false) {
          const keep = new Set<SgrAttr | SgrColor>(options.risRetains ?? [])
          for (const attribute of SGR_ATTRS) if (!keep.has(attribute)) state[attribute] = false
          if (!keep.has("fg")) color.fg = undefined
          if (!keep.has("bg")) color.bg = undefined
          if (!keep.has("uc")) color.uc = undefined
          if (options.risClearsCells !== false) cells.clear()
          row = 1
          col = 1
        }
        index += 2
        continue
      }
      if (char === "\x1b" && sequence[index + 1] === "[") {
        let end = index + 2
        while (end < sequence.length && !/[@-~]/.test(sequence[end]!)) end += 1
        const final = sequence[end] ?? ""
        const raw = sequence.slice(index + 2, end)
        const params =
          raw === ""
            ? []
            : raw
                .split(";")
                .flatMap((entry) =>
                  /^(?:38|48|58):/.test(entry) ? entry.split(":").filter((part) => part !== "") : [entry],
                )
                .map((entry) => (entry === "" ? 0 : Number(entry)))
        if (final === "m") applySgr(params)
        else if (final === "H") {
          row = params[0] ?? 1
          col = params[1] ?? 1
        } else if (final === "J") cells.clear()
        index = end + 1
        continue
      }
      paint(char)
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
      captures.push(request.label)
      reads += 1
      const frame: ObservationFrame = {
        role: request.role,
        label: request.label,
        capturedAt: reads,
        ref: `sha256:${createHash("sha256").update(String(reads)).digest("hex")}`,
      }
      const key = `${request.cells.top},${request.cells.left},${request.cells.bottom},${request.cells.right}`
      const contents =
        key === FAMILY_SENTINEL
          ? `witness|${cells.get("1,1") ?? ""}`
          : `${cells.get("3,5") ?? "empty"}/${cells.get("3,6") ?? "empty"}`
      const digest = `sha256:${createHash("sha256").update(contents).digest("hex")}`
      return {
        ...frame,
        regionDigest: digest,
        pixelsDigest: `sha256:${createHash("sha256").update(`window|${digest}`).digest("hex")}`,
        regionRectangle: {
          x: (request.cells.left - 1) * GEOMETRY.cellWidth,
          y: (request.cells.top - 1) * GEOMETRY.cellHeight,
          width: (request.cells.right - request.cells.left + 1) * GEOMETRY.cellWidth,
          height: (request.cells.bottom - request.cells.top + 1) * GEOMETRY.cellHeight,
        },
      }
    },
    queryCursorPosition: async () => ({ row: 4, col: 1 }),
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout" as const, raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async (sequence: string) => {
      queries.push(sequence)
      if (options.replies) {
        const reply = options.replies[queries.length - 1]
        if (reply === undefined) throw new Error("Unexpected extra SGR readback")
        const raw = `\x1bP1$r${reply}m\x1b\\`
        return { match: [raw, reply], reason: "reply" as const, raw, rawBase64: Buffer.from(raw).toString("base64") }
      }
      return { match: null, reason: "timeout" as const, raw: "", rawBase64: "" }
    },
    queryMode: async () => null,
  } as unknown as TermProbeSource
  return { ctx, cells, snapshot, writes, queries, captures }
}

const ALL_ATTRS: readonly SgrAttr[] = ["bold", "italic", "inverse", "underline", "faint"]

// #32590: the immutable pre-setter reference must distinguish a complete reset from every
// retained subset. The old tests only refused these captures and never exercised restoration.
test.each(
  ["reset.sgr", "sgr.reset"].flatMap((id) =>
    subsets<SgrAttr>(["bold", "italic", "inverse"]).map((retained) => ({ id, retained })),
  ),
)(
  "$id saved reset reference grades the retained subset $retained and survives the daemon decoder",
  async ({ id, retained }) => {
    const terminal = statefulTerminal(ALL_ATTRS, { resetMisses: retained, risRetains: retained })
    const capture = terminal.ctx.capture!
    const capturedWrites: Array<{ role: ObservationFrame["role"]; label: string; writes: string }> = []
    terminal.ctx.capture = async (request) => {
      if (request.cells?.top === 3 && request.cells.left === 5) {
        capturedWrites.push({ role: request.role, label: request.label, writes: terminal.writes.join("") })
      }
      return capture(request)
    }
    const result = await [...resetProbes, ...sgrProbes].find((candidate) => candidate.id === id)!.term!(terminal.ctx)
    const status = retained.length ? "unsupported" : "supported"
    expect(result.observation).toMatchObject({ outcome: status, assertionType: "screenshot" })
    expect(result.tests).toMatchObject([{ id: id === "reset.sgr" ? "reset" : "criterion", status, assertionRefs: [0] }])
    expect(result.criterionBranch).toBe(id === "reset.sgr" ? "reset-saved-rendition" : "sgr-reset-saved-rendition")
    expect(terminal.queries).toEqual([])
    const target = capturedWrites.find((frame) => frame.role === "target")
    expect(target?.writes).toContain("\x1b[99m")
    expect(target?.writes.match(/\x1b\[0m/g)).toHaveLength(1)
    // Every reference, including the inert SGR99 control, precedes the first target SGR0.
    for (const frame of capturedWrites.filter((frame) => frame.role !== "target")) {
      expect(frame.writes).not.toContain("\x1b[0m")
      expect(frame.writes).not.toContain("\x1bc")
    }
    const evidence = JSON.parse(result.response!) as {
      resetReference: { checks: Array<{ phase: string; digest: string }> }
    }
    const checks = evidence.resetReference.checks
    const baseline = checks[0]!.digest
    const styled = checks.filter((check) => check.phase === "styled")
    expect(styled).toHaveLength(7)
    expect(styled.every((check) => check.digest !== baseline)).toBe(true)
    const restored = checks.filter((check) => check.phase === "restored")
    expect(restored).toHaveLength(7)
    expect(restored.every((check) => check.digest === baseline)).toBe(true)
    expect(terminal.writes.join("").match(/\x1b7/g)).toHaveLength(1)
    expect(terminal.writes.at(-2)).toBe("\x1b[?25h")
    expect(terminal.writes.at(-1)).toBe("\x1b8\x1b[2J\x1b[H")
    // This is the exact strict decoder used by the daemon client. A prior feature assertion
    // catches local/global ref confusion: reset's callback [0] must become run-global [1].
    const decoded = decodeResetCallback(result, terminal, id)
    expect(decoded.kind).toBe("captured")
    expect(decoded.run.results[0]).toMatchObject({ status, tests: [{ assertionRefs: [1] }] })
  },
)

function decodeResetCallback(result: ProbeCallbackResult, terminal: StatefulTerminal, id = "reset.sgr") {
  const sourceRevision = "a".repeat(40)
  const measuredAt = "2026-11-07T09:00:00.000Z"
  const manifest: ProbeSuiteManifest & { schemaVersion: 4 } = {
    schemaVersion: 4,
    probeHash: "abcdef123456",
    sourceRevision,
    generatedAt: measuredAt,
    adapterVersion: "test",
    catalogIds: [id, "sgr.bold"],
    probes: { term: [id], lib: [], mux: [] },
  }
  const assertions = [
    {
      featureId: "sgr.bold",
      rawReplyRef: "sgr.bold",
      assertionType: "buffer_state" as const,
      kind: "positive" as const,
      expected: "bold",
      observed: '{"bold":true}',
    },
    ...(result.assertions ?? []).map((assertion) => ({ ...assertion, featureId: id, rawReplyRef: id })),
  ]
  const recorded = recordExecutedProbe({
    featureId: id,
    attempt: { scope: "probe", startedAt: measuredAt },
    rawReplyRef: id,
    ...(result.observation && { observation: { ...result.observation, featureId: id, rawReplyRef: id } }),
    assertions,
    tests: result.tests,
    criterionBranch: result.criterionBranch,
  })
  const initialized = initializeRunDraft({
    source: { kind: "live" },
    runId: "1234567890abcdef1234567890abcdef",
    sourceRevision,
    manifest,
    intendedSubject: { kind: "term", id: "alacritty", version: "0.17.0" },
  })
  const run = {
    ...initialized,
    subject: {
      kind: "term",
      id: "alacritty",
      version: "0.17.0",
      os: "linux",
      osVersion: null,
      outerTerminal: null,
      mux: null,
      config: null,
      permissions: null,
    },
    identity: "unverified",
    measuredAt,
    origin: { kind: "collector" },
    rawReplies: {
      "sgr.bold": '{"bold":true}',
      [id]: JSON.stringify({
        writes: terminal.writes,
        queries: terminal.queries,
        events: [],
        callbackResponse: result.response,
      }),
    },
    assertions,
    results: initialized.results.map((entry) => (entry.featureId === id ? recorded : entry)),
    screenshotRefs: (result.observation?.frames ?? [])
      .filter((frame) => frame.kind !== "text-cells")
      .map((frame) => frame.ref),
  }
  return decodeCollectorDraft("reset-saved-rendition.json", JSON.stringify(run), manifest, sourceRevision)
}

// SGR22's criterion also preserves italic. The full-reset cases cannot catch an intensity
// survivor, an over-reset, or a wrong-state crop that aliases the expected italic crop.
test.each([
  { retained: [] },
  { retained: ["bold"] },
  { retained: ["faint"] },
  { retained: ["bold", "faint"] },
] satisfies Array<{ retained: SgrAttr[] }>)(
  "SGR22 clears both intensities while preserving italic, retained $retained",
  async ({ retained }) => {
    const terminal = statefulTerminal(ALL_ATTRS, { resetMisses: retained })
    const id = "sgr.selective-reset.bold"
    const result = await sgrProbes.find((candidate) => candidate.id === id)!.term!(terminal.ctx)
    const status = retained.length ? "unsupported" : "supported"
    expect(result.observation).toMatchObject({ outcome: status, assertionType: "screenshot" })
    expect(result.tests).toMatchObject([{ id: "criterion", status, assertionRefs: [0] }])
    expect(terminal.queries).toEqual([])
    expect(terminal.writes.join("")).not.toContain("\x1b[0m")
    expect(terminal.writes.join("")).not.toContain("\x1bc")
    expect(decodeResetCallback(result, terminal, id).run.results[0]).toMatchObject({ status })
  },
)

test("SGR22 clearing the preserved italic is a measured negative", async () => {
  const terminal = statefulTerminal(ALL_ATTRS, { resetDropsItalic: true })
  const result = await sgrProbes.find((candidate) => candidate.id === "sgr.selective-reset.bold")!.term!(terminal.ctx)
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "screenshot" })
  expect(terminal.queries).toEqual([])
})

test("SGR22 rejects an expected/wrong-subset collision before sending the target", async () => {
  const terminal = statefulTerminal(ALL_ATTRS, { hideBoldWithItalic: true })
  const result = await sgrProbes.find((candidate) => candidate.id === "sgr.selective-reset.bold")!.term!(terminal.ctx)
  expect(result.observation).toBeUndefined()
  expect(result.tests).toMatchObject([{ reason: expect.stringMatching(/expected.*(collid|separat)/i) }])
  expect(terminal.writes.join("")).not.toContain("\x1b[22m")
  expect(terminal.queries).toContain("\x1bP$qm\x1b\\")
})

test("a reset declaration with multiple expected subsets throws with its row name", async () => {
  const original = familyRow("reset.sgr")
  const terminal = statefulTerminal(ALL_ATTRS)
  const spec = {
    ...original,
    savedRendition: {
      ...original.savedRendition!,
      subsets: original.savedRendition!.subsets.map((subset, index) => ({
        ...subset,
        ...(index < 2 ? { expected: true as const } : {}),
      })),
    },
  }
  await expect(captureRegionCallbackResult(terminal.ctx, "reset.sgr", spec)).rejects.toThrow(
    /reset\.sgr.*(multiple|more than one).*expected/i,
  )
  expect(terminal.writes).toEqual([])
})

test.each([
  { name: "invisible italic", options: { invisible: ["italic"] }, failed: /subset.*3/ },
  { name: "initial italic", options: { initial: ["italic"] }, failed: /subset.*3/ },
  { name: "restore retains italic", options: { restoreRetains: ["italic"] }, failed: /restored.*3/ },
  {
    name: "reset and restore share a fault",
    options: { resetMisses: ["italic"], restoreRetains: ["italic"] },
    failed: /restored.*3/,
  },
] satisfies Array<{ name: string; options: StatefulOptions; failed: RegExp }>)(
  "unqualified saved reset reference tries DECRQSS and retains its named refusal: $name",
  async ({ options, failed }) => {
    const terminal = statefulTerminal(ALL_ATTRS, options)
    const firstQueryWrites: string[] = []
    const query = terminal.ctx.queryWithSentinelOutcome
    terminal.ctx.queryWithSentinelOutcome = async (...args) => {
      if (firstQueryWrites.length === 0) firstQueryWrites.push(...terminal.writes)
      return query(...args)
    }
    const result = await resetProbes.find((candidate) => candidate.id === "reset.sgr")!.term!(terminal.ctx)
    // The first SGR0 belongs to DECRQSS's baseline, never to failed capture cleanup.
    expect(firstQueryWrites.join("").match(/\x1b\[0m/g)).toHaveLength(1)
    expect(firstQueryWrites).not.toContain("\x1b[0m\x1b[2J\x1b[H")
    expect(result.observation).toBeUndefined()
    expect(result.tests).toMatchObject([{ status: "probe-invalid", reason: expect.stringMatching(failed) }])
    expect(result.tests?.[0]?.reason).toContain("no independent reference")
    expect(terminal.queries).toContain("\x1bP$qm\x1b\\")
    expect(terminal.captures.some((label) => label.includes("reset target"))).toBe(false)
    expect(terminal.writes.join("")).not.toContain("\x1bc")
  },
)

test.each([
  { name: "made-up SGR99 changes the crop", options: { invalidSgrChanges: true }, reason: /SGR 99/, target: false },
  {
    name: "target matches no reference",
    options: { resetAddsUnderline: true },
    reason: /matches no retained/,
    target: true,
  },
] satisfies Array<{ name: string; options: StatefulOptions; reason: RegExp; target: boolean }>)(
  "saved reset reference invalidates a corrupt measurement without querying: $name",
  async ({ options, reason, target }) => {
    const terminal = statefulTerminal(ALL_ATTRS, options)
    const result = await resetProbes.find((candidate) => candidate.id === "reset.sgr")!.term!(terminal.ctx)
    expect(result.tests).toMatchObject([{ status: "probe-invalid", reason: expect.stringMatching(reason) }])
    expect(result.assertions ?? []).toEqual([])
    expect(terminal.queries).toEqual([])
    expect(terminal.captures.some((label) => label.includes("reset target"))).toBe(target)
  },
)

test("an answering DECRQSS decides after a saved reset subset fails, retaining the failed step", async () => {
  const terminal = statefulTerminal(ALL_ATTRS, { invisible: ["italic"], replies: ["0", "1;3;7", "0"] })
  const result = await resetProbes.find((candidate) => candidate.id === "reset.sgr")!.term!(terminal.ctx)
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
  expect(result.observation?.note).toMatch(/subset.*3/)
  expect(terminal.queries).toHaveLength(3)
  expect(terminal.captures.some((label) => label.includes("reset target"))).toBe(false)
})

// A reset verdict requires a separately witnessed FULL setup. Older models always honoured every
// setter; those tests could not expose a reset graded after its preserved bold was never painted.
const SELECTIVE_COMPANION_ROWS = [
  "sgr.selective-reset.underline",
  "sgr.selective-reset.italic",
  "sgr.selective-reset.inverse",
] as const

test.each(
  SELECTIVE_COMPANION_ROWS.flatMap((id) =>
    (["always", "combined"] as const).flatMap((ignoreBold) =>
      (["oracle", "callback"] as const).map((route) => ({ id, ignoreBold, route })),
    ),
  ),
)("$id refuses an unestablished companion by name ($ignoreBold, $route)", async ({ id, ignoreBold, route }) => {
  for (const fault of ["normal", "drops-bold", "adds-bold", "no-op"] as const) {
    const cleared =
      id === "sgr.selective-reset.underline" ? "underline" : id === "sgr.selective-reset.italic" ? "italic" : "inverse"
    const terminal = statefulTerminal(ALL_ATTRS, {
      ris: true,
      ignoreBold,
      resetDropsBold: fault === "drops-bold",
      resetAddsBold: fault === "adds-bold",
      resetMisses: fault === "no-op" ? [cleared] : [],
      ...(route === "callback" && { replies: ["0", "0"] }),
    })
    const probe = sgrProbes.find((candidate) => candidate.id === id)
    if (!probe?.term) throw new Error(`${id}: missing callback`)
    const result =
      route === "oracle"
        ? await captureRegionCallbackResult(terminal.ctx, id, familyRow(id))
        : await probe.term(terminal.ctx)
    const label = `${id}: ${ignoreBold}, ${fault}, ${route}`
    expect(result?.observation?.outcome, label).toBe("inconclusive")
    expect(result?.observation?.reason, label).toBe("insufficient-evidence")
    expect(result?.observation?.note, label).toContain(
      ignoreBold === "always" ? "ignored-attribute frame and the expected frame" : "setup reference",
    )
    expect(result?.assertions ?? [], label).toHaveLength(0)
    if (route === "callback") {
      expect(terminal.queries, label).toHaveLength(2)
      expect(JSON.parse(result!.response!), label).toMatchObject({ baseline: "0", setup: "0" })
    }
  }
})

test.each(GRADED_ROWS)(
  "%s uses qualified pixels when complete neutral SGR reports cannot establish setup",
  async (id) => {
    const terminal = statefulTerminal(ALL_ATTRS, { ris: true, replies: ["0", "0"] })
    const probe = [...sgrProbes, ...resetProbes].find((candidate) => candidate.id === id)
    if (!probe?.term) throw new Error(`${id}: missing callback`)
    const result = await probe.term(terminal.ctx)
    expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "screenshot" })
    expect(result.assertions?.[0]?.kind).toBe("positive")
    expect(terminal.queries).toHaveLength(2)
    expect(terminal.captures.length).toBeGreaterThan(0)
    expect(result.response).toContain('"baseline":"0"')
    expect(result.response).toContain('"setup":"0"')
    expect(result.observation?.note).toContain("independent capture oracle")
    expect(terminal.writes.at(-1)).toBe("\x1b[0m")
  },
)

test.each(SELECTIVE_COMPANION_ROWS)(
  "%s measures a reset that also drops its established companion as unsupported",
  async (id) => {
    for (const route of ["oracle", "callback"] as const) {
      const terminal = statefulTerminal(ALL_ATTRS, {
        ris: true,
        resetDropsBold: true,
        ...(route === "callback" && { replies: ["0", "0"] }),
      })
      const probe = sgrProbes.find((candidate) => candidate.id === id)
      if (!probe?.term) throw new Error(`${id}: missing callback`)
      const result =
        route === "oracle"
          ? await captureRegionCallbackResult(terminal.ctx, id, familyRow(id))
          : await probe.term(terminal.ctx)
      expect(result?.observation, route).toMatchObject({ outcome: "unsupported", assertionType: "screenshot" })
      expect(result?.assertions?.[0]?.kind, route).toBe("negative")
      if (route === "callback") {
        expect(terminal.queries).toHaveLength(2)
        expect(JSON.parse(result!.response!)).toMatchObject({ baseline: "0", setup: "0" })
      }
    }
  },
)

test("a valid final reset reply retains the owning region oracle's independent pixel decision", async () => {
  const terminal = statefulTerminal(ALL_ATTRS, { ris: true, replies: ["0", "1;3", "1"], resetMisses: ["italic"] })
  const probe = sgrProbes.find((candidate) => candidate.id === "sgr.selective-reset.italic")
  if (!probe?.term) throw new Error("missing selective italic callback")
  const result = await probe.term(terminal.ctx)
  // The final state report says italic cleared; the existing pixel fixture observes that it did not.
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "screenshot" })
  expect(result.assertions?.[0]?.kind).toBe("negative")
  expect(terminal.queries).toHaveLength(3)
  expect(terminal.captures.length).toBeGreaterThan(0)
  expect(result.response).toContain('"sgr":"1"')
  expect(result.observation?.note).toContain("DECRQSS")
})

test("an unqualified setup retains an independent measurement refusal and propagates a capture error with cleanup", async () => {
  const probe = sgrProbes.find((candidate) => candidate.id === "sgr.selective-reset.underline")
  if (!probe?.term) throw new Error("missing selective underline callback")
  const refused = statefulTerminal(ALL_ATTRS, { ris: true, replies: ["0", "0"] })
  // Three rows pass the SGR caller's 3x34 preflight but fail the region oracle's fourth cursor row.
  refused.ctx.rows = 3
  const result = await probe.term(refused.ctx)
  expect(result.observation).toBeUndefined()
  expect(result.tests).toMatchObject([
    { status: "probe-invalid", reason: expect.stringContaining("needs a measured grid") },
  ])
  expect(JSON.parse(result.response!)).toMatchObject({ baseline: "0", setup: "0" })
  expect(refused.queries).toHaveLength(2)
  expect(refused.captures).toEqual([])
  expect(refused.writes.at(-1)).toBe("\x1b[0m")

  const throwing = statefulTerminal(ALL_ATTRS, { ris: true, replies: ["0", "0"] })
  throwing.ctx.capture = async () => {
    throw new Error("setup capture failed")
  }
  await expect(probe.term(throwing.ctx)).rejects.toThrow("setup capture failed")
  expect(throwing.queries).toHaveLength(2)
  expect(throwing.writes.at(-1)).toBe("\x1b[0m")
})

/** Every subset, including the empty one: the exhaustive table's domain. */
function subsets<T>(items: readonly T[]): T[][] {
  return items.reduce<T[][]>((sets, item) => [...sets, ...sets.map((set) => [...set, item])], [[]])
}

test("reset rows without a qualified saved reference decline on the pixel path", async () => {
  // A row whose reset clears two or more attributes can be
  // fooled by a reset and a RIS that miss the same part of the cleared set. Each case below WOULD read
  // supported without the refusal; the refusal comes before a byte and says why.
  const cases: Array<{ id: (typeof NO_REFERENCE_ROWS)[number]; miss: SgrAttr[]; keep: (SgrAttr | SgrColor)[] }> = [
    { id: "sgr.reset", miss: ["underline"], keep: ["underline"] },
    { id: "sgr.selective-reset.bold", miss: ["faint"], keep: ["faint"] },
  ]
  for (const entry of cases) {
    const terminal = statefulTerminal(ALL_ATTRS, { ris: true, resetMisses: entry.miss, risRetains: entry.keep })
    const result = await captureRegionCallbackResult(terminal.ctx, entry.id, {
      ...familyRow(entry.id),
      savedRendition: undefined,
    })
    expect(result?.observation, entry.id).toBeUndefined()
    expect(result?.tests, entry.id).toMatchObject([
      {
        status: "probe-todo",
        reason: expect.stringContaining("no independent reference exists for a multi-attribute reset"),
      },
    ])
    // The direct execution-only refusal is TODO before a byte; neither writes nor queries occur.
    expect(terminal.writes, `${entry.id}: the direct refusal wrote nothing`).toEqual([])
    expect(terminal.queries, `${entry.id}: the direct refusal queried nothing`).toEqual([])
  }
  const correct = statefulTerminal(ALL_ATTRS, { ris: true })
  for (const id of NO_REFERENCE_ROWS.filter((id) => id !== "reset.sgr")) {
    const result = await captureRegionCallbackResult(correct.ctx, id, { ...familyRow(id), savedRendition: undefined })
    expect(result?.observation, id).toBeUndefined()
    expect(result?.tests, id).toMatchObject([
      {
        status: "probe-todo",
        reason: expect.stringContaining("no independent reference exists for a multi-attribute reset"),
      },
    ])
  }
})

test("multi-attribute rows retain their query fallback refusal; unchanged refusals prevent circular grades", async () => {
  // Both directions of the refused set. First: membership is derived from the model, not restated.
  const clearsTwoOrMore = RESET_FAMILY_ROWS.filter((id) => {
    const probe = statefulTerminal(ALL_ATTRS, { ris: true })
    const row = familyRow(id)
    probe.ctx.write(row.seed)
    const setup = [...probe.snapshot()]
    probe.ctx.write(row.edit)
    const afterReset = probe.snapshot()
    return setup.filter((attribute) => !afterReset.has(attribute)).length >= 2
  })
  const flagged = RESET_FAMILY_ROWS.filter((id) => familyRow(id).noIndependentReference !== undefined)
  expect(flagged).toEqual([...NO_REFERENCE_ROWS])
  expect(clearsTwoOrMore).toEqual([...NO_REFERENCE_ROWS])

  // Second: strip the flag and grade the same cases. Each one reads supported, so the refusal is
  // what prevents the false pass rather than a coincidence of the fixtures.
  const cases: Array<{ id: (typeof NO_REFERENCE_ROWS)[number]; miss: SgrAttr[]; keep: (SgrAttr | SgrColor)[] }> = [
    { id: "sgr.reset", miss: ["underline"], keep: ["underline"] },
    { id: "sgr.selective-reset.bold", miss: ["faint"], keep: ["faint"] },
  ]
  for (const entry of cases) {
    const { noIndependentReference: _refusal, savedRendition: _saved, ...bare } = familyRow(entry.id)
    const terminal = statefulTerminal(ALL_ATTRS, { ris: true, resetMisses: entry.miss, risRetains: entry.keep })
    const refused = await captureRegionCallbackResult(terminal.ctx, entry.id, {
      ...familyRow(entry.id),
      savedRendition: undefined,
    })
    expect(refused?.observation, `${entry.id}: with the refusal`).toBeUndefined()
    expect(refused?.tests, entry.id).toMatchObject([
      {
        status: "probe-todo",
        reason: expect.stringContaining("no independent reference exists for a multi-attribute reset"),
      },
    ])
    const graded = await captureRegionCallbackResult(terminal.ctx, entry.id, bare)
    expect(graded?.observation?.outcome, `${entry.id}: with the refusal stripped`).toBe("supported")
  }
})

test("the bold row's faint case is the third no-reference row", async () => {
  // SGR 22 clears bold AND faint while the residual repaints only italic, so
  // 22 and RIS both keeping faint left the row reading supported. This is the case the named grade
  // removes; with the grade removed it reads supported.
  const terminal = statefulTerminal(ALL_ATTRS, { ris: true, resetMisses: ["faint"], risRetains: ["faint"] })
  const result = await captureRegionCallbackResult(terminal.ctx, "sgr.selective-reset.bold", {
    ...familyRow("sgr.selective-reset.bold"),
    savedRendition: undefined,
  })
  expect(result?.observation).toBeUndefined()
  expect(result?.tests).toMatchObject([
    {
      status: "probe-todo",
      reason: expect.stringContaining("no independent reference exists for a multi-attribute reset"),
    },
  ])
})

test("no combination of a missed cleared attribute and a retained reference attribute is supported unless the reset cleared everything it claims", async () => {
  // Every row of RESET_FAMILY_CAPTURE, every subset of its CLEARED set
  // (what the reset under test misses) x every subset of its SETUP (what RIS keeps), with the cleared
  // set computed from this model rather than a hand-picked list.
  for (const id of RESET_FAMILY_ROWS) {
    const row = familyRow(id)
    const probe = statefulTerminal(ALL_ATTRS, { ris: true })
    probe.ctx.write(row.seed)
    const setup = [...probe.snapshot()]
    probe.ctx.write(row.edit)
    const afterReset = probe.snapshot()
    const cleared = setup.filter((attribute) => !afterReset.has(attribute))
    for (const misses of subsets(cleared)) {
      for (const keeps of subsets(setup)) {
        const terminal = statefulTerminal(ALL_ATTRS, {
          ris: true,
          resetMisses: misses as Array<SgrAttr | SgrColor>,
          risRetains: keeps as Array<SgrAttr | SgrColor>,
        })
        const result = await captureRegionCallbackResult(terminal.ctx, id, familyRow(id))
        const outcome = result?.observation?.outcome
        const label = `${id}: reset misses [${misses.join("+")}] and RIS keeps [${keeps.join("+")}] (cleared [${cleared.join("+")}])`
        if (outcome === "supported") {
          expect(misses, `${label}: supported although the reset missed part of its cleared set`).toEqual([])
        }
        const keepsOnlyResidual = keeps.every((attribute) => !cleared.includes(attribute))
        if (misses.length === 0 && keepsOnlyResidual && (GRADED_ROWS as readonly string[]).includes(id)) {
          if (keeps.length > 0) {
            // A retained companion contaminates the neutral negative reference. It then equals
            // the expected preserved companion, so even a correct reset lacks a discriminator.
            expect(outcome, `${label}: retained companion collapses the negative reference`).toBe("inconclusive")
            expect(result?.observation?.note, label).toContain("ignored-attribute frame and the expected frame")
          } else {
            expect(outcome, `${label}: independently qualified controls decide a correct reset`).toBe("supported")
          }
        }
      }
    }
  }
})

// Declared visual signals use the same runtime entry and same witnessed planes as legacy rows.
function declaredWindow(
  applied: string,
  options: { noChange?: boolean; stale?: boolean; metadata?: boolean } = {},
): Fake {
  const paint = planePainter(applied)
  return ownedWindow({
    repaintAfterPolls: options.stale ? "never" : 1,
    regionDigest: (writes) => {
      const value = paint(writes)
      return options.noChange && value === "expected" ? "seed" : value
    },
    pixelMetadata: options.metadata ?? true,
    cropFor: (label) =>
      /baseline|paint witness/.test(label)
        ? { x: 0, y: 32, width: 8, height: 16 }
        : { x: 0, y: 0, width: 64, height: 16 },
  })
}

const CHANGE_SIGNAL = { signal: "fixture.changed", expected: "change" as const }
const NO_CHANGE_SIGNAL = { signal: "fixture.restored", expected: "no-change" as const }

test.each([
  ["expected", "supported", "positive"],
  ["seed", "unsupported", "negative"],
  ["ignored", "unsupported", "negative"],
] as const)("declared visual change %s yields an explicit %s row", async (applied, status, kind) => {
  const result = await decide(declaredWindow(applied), { ...PLANE_SPEC, discriminator: CHANGE_SIGNAL })
  expect(result.tests).toEqual([{ id: "fixture.changed", status, assertionRefs: [0] }])
  expect(result.assertions).toHaveLength(1)
  expect(result.assertions?.[0]?.kind).toBe(kind)
  expect(result.observation.screenshotRef).toBe(
    result.observation.frames?.find((frame) => frame.role === "target")?.ref,
  )
})

test.each([
  ["seed", "supported"],
  ["ignored", "unsupported"],
] as const)("declared visual no-change %s uses its independent contrast for %s", async (applied, status) => {
  const result = await decide(declaredWindow(applied, { noChange: true }), {
    ...PLANE_SPEC,
    discriminator: NO_CHANGE_SIGNAL,
  })
  expect(result.tests).toEqual([{ id: "fixture.restored", status, assertionRefs: [0] }])
  expect(result.assertions).toHaveLength(1)
})

test("declared visual missing witness keeps review evidence execution-only", async () => {
  const fake = declaredWindow("seed", { stale: true })
  const result = await captureRegionReadbackDecision(
    fake.ctx,
    "visual",
    spec({ ...PLANE_SPEC, discriminator: CHANGE_SIGNAL, timeoutMs: 5 }),
    fake.read,
  )
  const response = JSON.parse(result?.response ?? "{}") as {
    review?: { note?: string; screenshotRef?: string }
  }
  expect(result?.tests?.[0]).toMatchObject({ id: "review", status: "probe-todo", reason: "no freshness witness" })
  expect(result?.observation).toBeUndefined()
  expect(result?.assertions).toBeUndefined()
  expect(response.review?.note).toContain("no paint witness")
  expect(response.review?.screenshotRef).toMatch(/^sha256:/)
})

// The ordinary fixture paints the target and sentinel together. A partial repaint can instead
// clear the preceding glyph before the requested glyph (and the target) reaches the window.
test.each([
  ["intermediate clear", ["0", " "]],
  ["missing clear return", [" ", "1"]],
  ["missing glyph return", [" ", "1", " "]],
] as const)("declared visual %s cannot establish requested paint", async (_fault, sentinelPaints) => {
  const fake = declaredWindow("expected")
  const read = fake.read
  let targetStep = false
  let sentinelReads = 0
  const write = fake.ctx.write.bind(fake.ctx)
  fake.ctx.write = (sequence) => {
    if (sequence === `${PLANE_SPEC.seed}${PLANE_SPEC.edit}`) targetStep = true
    if (sequence === PLANE_SPEC.expected || sequence === PLANE_SPEC.ignored) targetStep = false
    write(sequence)
  }
  fake.read = async (request) => {
    const captured = await read(request)
    if (targetStep && key(request.region) === SENTINEL_CELL) {
      const painted = sentinelPaints[Math.min(sentinelReads++, sentinelPaints.length - 1)]
      captured.regionDigest = `sentinel|${painted}`
      captured.pixelsDigest = `frame|seed|${painted}`
      captured.frame.regionDigest = captured.regionDigest
      captured.frame.pixelsDigest = captured.pixelsDigest
    } else if (request.role === "target") {
      captured.regionDigest = `${key(request.region)}|seed`
      captured.frame.regionDigest = captured.regionDigest
    }
    return captured
  }
  const result = await captureRegionReadbackDecision(
    fake.ctx,
    "visual",
    spec({ ...PLANE_SPEC, discriminator: CHANGE_SIGNAL, timeoutMs: 5 }),
    fake.read,
  )
  expect(result?.tests).toEqual([{ id: "review", status: "probe-todo", reason: "no freshness witness" }])
  expect(result?.assertions).toBeUndefined()
  expect(result?.observation).toBeUndefined()
  const response = JSON.parse(result?.response ?? "{}") as { review?: { frames?: PixelObservationFrame[] } }
  expect(response.review?.frames?.map((frame) => frame.regionDigest)).toEqual([
    ...sentinelPaints.map((painted) => `sentinel|${painted}`),
    `sentinel|${sentinelPaints.at(-1)}`,
  ])
})

test("declared visual instability before a target frame keeps review evidence execution-only", async () => {
  // Stability control captures cannot satisfy the writer's target-frame screenshot citation contract.
  const fake = declaredWindow("seed", { metadata: true })
  const read = fake.read
  fake.read = async (request) => {
    const captured = await read(request)
    if (request.label.includes("capture stability")) {
      captured.regionDigest += `-${request.label}`
      captured.frame.regionDigest = captured.regionDigest
    }
    return captured
  }
  const result = await captureRegionReadbackDecision(
    fake.ctx,
    "visual",
    spec({
      ...PLANE_SPEC,
      discriminator: CHANGE_SIGNAL,
    }),
    fake.read,
  )

  expect(result?.criterionBranch).toBe("visual-review")
  expect(result?.tests?.[0]?.status).toBe("probe-todo")
  expect(result?.observation).toBeUndefined()
  expect(result?.assertions).toBeUndefined()
  const response = JSON.parse(result?.response ?? "{}") as {
    review?: { note?: string; screenshotRef?: string; frames?: ObservationFrame[] }
    originalResponse?: string | null
  }
  expect(response.review?.note).toBeTruthy()
  expect(response.review?.screenshotRef).toMatch(/^sha256:/)
  expect(response.originalResponse).toContain("stability")
})

test.each(["change", "no-change"] as const)(
  "declared visual %s third frame stays explicit review",
  async (expected) => {
    const result = await decide(declaredWindow("third", { noChange: expected === "no-change" }), {
      ...PLANE_SPEC,
      discriminator: { signal: "fixture.signal", expected },
    })
    expect(result.tests?.[0]?.status).toBe("probe-todo")
    expect(result.tests?.[0]?.reason).toContain("third distinct frame")
    expect(result.assertions).toBeUndefined()
  },
)

test("declared visual no-change requires a distinct ignored contrast", async () => {
  const result = await decide(declaredWindow("seed", { noChange: true }), {
    ...PLANE_SPEC,
    ignored: undefined,
    discriminator: NO_CHANGE_SIGNAL,
  })
  expect(result.tests?.[0]?.status).toBe("probe-todo")
  expect(result.tests?.[0]?.reason).toContain("distinct ignored contrast")
})

test("declared visual collapsed references stay explicit review", async () => {
  const fake = declaredWindow("expected")
  const read = fake.read
  fake.read = async (request) => {
    const captured = await read(request)
    if (request.label.endsWith("ignored-attribute frame")) {
      captured.regionDigest = captured.regionDigest.replace("ignored", "expected")
      Object.assign(captured.frame, { regionDigest: captured.regionDigest })
    }
    return captured
  }
  const result = await decide(fake, { ...PLANE_SPEC, discriminator: CHANGE_SIGNAL })
  expect(result.tests?.[0]?.status).toBe("probe-todo")
  expect(result.tests?.[0]?.reason).toContain("cannot separate")
})

test("declared visual requires actual pixel crop metadata rather than wrapper fallback", async () => {
  await expect(
    decide(declaredWindow("expected", { metadata: false }), {
      ...PLANE_SPEC,
      discriminator: CHANGE_SIGNAL,
    }),
  ).rejects.toThrow(/actual pixel.*digest|pixel.*metadata/)
})

test("declared visual rejects text capture before terminal writes", async () => {
  const fake = declaredWindow("expected")
  fake.ctx.captureKind = "text-cells"
  const result = await captureRegionReadbackDecision(
    fake.ctx,
    "visual",
    spec({
      ...PLANE_SPEC,
      discriminator: CHANGE_SIGNAL,
    }),
    fake.read,
  )
  expect(result?.tests?.[0]?.status).toBe("probe-todo")
  expect(result?.tests?.[0]?.reason).toContain("pixel")
  expect(fake.writes).toHaveLength(0)
})

test("declared visual missing reader is explicit review without writes", async () => {
  const fake = declaredWindow("expected")
  const result = await captureRegionReadbackDecision(fake.ctx, "visual", spec({ discriminator: CHANGE_SIGNAL }), null)
  expect(result?.tests).toEqual([{ id: "review", status: "probe-todo", reason: "no freshness witness" }])
  expect(fake.writes).toHaveLength(0)
})

test.each(["missing crop", "mismatched digest", "text frame"] as const)(
  "declared visual rejects %s from the reader",
  async (fault) => {
    const fake = declaredWindow("expected")
    const read = fake.read
    fake.read = async (request) => {
      const captured = await read(request)
      if (fault === "missing crop") delete captured.regionRectangle
      else if (fault === "mismatched digest") captured.regionDigest = "wrapper-only"
      else {
        captured.frame = {
          kind: "text-cells",
          role: request.role,
          ref: "sha256:text",
          label: request.label,
          capturedAt: 1,
          cellDigest: "text",
          frameDigest: "whole-text",
          cellRectangle: request.region,
        }
      }
      return captured
    }
    await expect(decide(fake, { ...PLANE_SPEC, discriminator: CHANGE_SIGNAL })).rejects.toThrow(/actual pixel.*digests/)
  },
)

test.each(["change", "no-change"] as const)(
  "declared visual %s requires the supplied setup qualification",
  async (expected) => {
    const result = await decide(
      declaredWindow(expected === "change" ? "expected" : "seed", { noChange: expected === "no-change" }),
      {
        ...PLANE_SPEC,
        setupReference: PLANES.ignored,
        discriminator: { signal: "fixture.setup", expected },
      },
    )
    expect(result.tests?.[0]?.status).toBe("probe-todo")
    expect(result.tests?.[0]?.reason).toContain("required setup was not established")
    expect(result.assertions).toBeUndefined()
  },
)

test("declared visual no-change collapsed contrast cannot support or oppose the claim", async () => {
  const result = await decide(declaredWindow("seed", { noChange: true }), {
    ...PLANE_SPEC,
    ignored: PLANES.expected,
    discriminator: NO_CHANGE_SIGNAL,
  })
  expect(result.tests?.[0]?.status).toBe("probe-todo")
  expect(result.tests?.[0]?.reason).toContain("cannot separate")
  expect(result.assertions).toBeUndefined()
})

test("declared visual crop movement alone cannot witness target freshness", async () => {
  const fake = declaredWindow("seed")
  const read = fake.read
  let targetBaseline: RegionCapture | undefined
  fake.read = async (request) => {
    const captured = await read(request)
    if (request.label.endsWith("post-sequence target — baseline")) targetBaseline = captured
    if (request.label.endsWith("post-sequence target — paint witness")) {
      if (!targetBaseline?.regionRectangle) throw new Error("target witness baseline crop missing")
      const moved = { ...captured.regionRectangle!, x: captured.regionRectangle!.x + 1 }
      captured.regionRectangle = moved
      captured.frame.regionRectangle = moved
      // Keep the sentinel and whole frame unchanged: only sampling a shifted crop changes this digest.
      captured.regionDigest = `${targetBaseline.regionDigest}:shifted-crop`
      captured.frame.regionDigest = captured.regionDigest
      captured.pixelsDigest = targetBaseline.pixelsDigest
      captured.frame.pixelsDigest = captured.pixelsDigest
    }
    return captured
  }
  const write = fake.ctx.write.bind(fake.ctx)
  let targetStep = false
  fake.ctx.write = (sequence) => {
    if (sequence === `${PLANE_SPEC.seed}${PLANE_SPEC.edit}`) targetStep = true
    if (targetStep && sequence === "\x1b[3;1H1") {
      // Model a stale sentinel while other frame captures can still be fresh.
      fake.writes.push(sequence)
      targetStep = false
      return
    }
    write(sequence)
  }

  const result = await captureRegionReadbackDecision(
    fake.ctx,
    "visual",
    spec({ ...PLANE_SPEC, discriminator: CHANGE_SIGNAL }),
    fake.read,
  )
  const response = JSON.parse(result?.response ?? "{}") as {
    review?: { note?: string; screenshotRef?: string; frames?: ObservationFrame[] }
  }
  expect(result?.tests?.[0]?.status).toBe("probe-todo")
  expect(result?.tests?.[0]?.reason).toContain("witness crop")
  expect(result?.observation).toBeUndefined()
  expect(result?.assertions).toBeUndefined()
  expect(response.review?.note).toContain("0,32 8x16")
  expect(response.review?.note).toContain("1,32 8x16")
  expect(response.review?.frames?.map(({ regionRectangle }) => regionRectangle)).toEqual([
    { x: 0, y: 32, width: 8, height: 16 },
    { x: 1, y: 32, width: 8, height: 16 },
  ])
  expect(response.review?.screenshotRef).toMatch(/^sha256:/)
})

/**
 * 33982, through the path the real rows run: `captureRegionReadbackDecision`. Warp repaints its text
 * area 35 rows lower when a probe sends RIS, so the seed and post-sequence frames stay at one place
 * while the expected and ignored-attribute frames are cropped 560 px lower. The exemption must read
 * that as one grid move and decide the row, not as two crops of unrelated cells.
 */
function rowsMovedCellCrop(originY: number): PixelCellCrop {
  return {
    origin: { x: 49, y: originY },
    basis: "sentinel pair located by frame difference",
    basisDetail: "sentinel re-located by frame difference at cells 1,2 and 2,1 (33000, 33981)",
    cell: { width: 16, height: 16 },
    grid: { columns: 123, rows: 39 },
    image: { width: 2000, height: 1400 },
    witness: {
      a: { cell: { row: 1, col: 2 }, box: { x: 65, y: originY } },
      b: { cell: { row: 2, col: 1 }, box: { x: 49, y: originY + 16 } },
    },
  }
}

test("a grid that moves 35 rows between the seed and the expected frame is decided, not refused (#33982)", async () => {
  const movedAfter = new Set(["editing.delete-chars: expected frame"])
  const fake = ownedWindow({
    repaintAfterPolls: 2,
    regionDigest: painter({ applied: "edited" }),
    cropFor: (label) => ({ x: 49, y: movedAfter.has(label) ? 638 : 78, width: 48, height: 16 }),
    cellCropFor: (label) => rowsMovedCellCrop(movedAfter.has(label) ? 606 : 46),
  })
  const result = await decide(fake)
  // Decided, not refused: the exemption turns what used to be a tool-invalid row into a verdict.
  expect(result.observation.outcome).toBe("supported")
  expect(JSON.stringify(result.observation)).not.toMatch(/cropped from different positions/)
})
