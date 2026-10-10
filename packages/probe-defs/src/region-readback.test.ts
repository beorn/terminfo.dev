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
  type CellRegion,
  type PixelGeometry,
  type RegionCapture,
  type RegionRead,
  type RegionReadback,
} from "./region-readback.ts"
import type { ObservationFrame, ProbeResult, TermContext } from "./types.ts"

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

async function decide(fake: Fake, overrides: Partial<RegionReadback> = {}): Promise<ProbeResult> {
  const result = await captureRegionReadbackDecision(fake.ctx, "editing.delete-chars", spec(overrides), fake.read)
  if (!result) throw new Error("expected a decided result")
  return result
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
  const result = await decide(fake)
  expect(result.observation.outcome).toBe("inconclusive")
  expect(result.observation.reason).toBe("timeout")
  expect(result.observation.note).toContain("no paint witness within 200 ms")
  expect(result.observation.note).toContain("cannot separate a painted frame from a stale one")
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
  expect(result.observation.note).toContain("matched neither the seed frame nor the expected frame")
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
  const result = await decide(fake, { pixelGeometry: { cellWidth: 0, cellHeight: 16, textWidth: 640, textHeight: 384 } })
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
