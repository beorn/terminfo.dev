/**
 * @failure #34899 r2 C1/C2: the Warp app arm must decide a mark from a same-run differential, and
 *   must never grade an inert reader, a block that moved with the mark, or a boundary that does not
 *   follow the mark. Every undecided outcome stays open naming the control that failed.
 * @level l1
 * @consumer The Warp term arm behind the eleven OSC 133/633 prompt-mark cells.
 * @testonly none
 */
import { expect, test } from "vitest"
import { extensionsProbes } from "./extensions.ts"
import { warpPromptMarkAppResult } from "./warp-prompt-marks.ts"
import type { CaptureCells, ObservationFrame, ProbeCallbackResult, TermProbeSource } from "./types.ts"

const ROWS = 24
const COLS = 80

function hash(text: string): string {
  let value = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 0x01000193) >>> 0
  }
  return value.toString(16).padStart(8, "0")
}

/** A 24x80 screen model: CUU/clear/OSC are understood, and a mark paints a boundary above its row. */
function screenSource(options: {
  acceptsMarks: boolean
  withCapture: boolean
  unstable?: boolean
  /** A broken reader: every mark paints its boundary at this row, wherever the mark itself is written. */
  boundaryRow?: number
}): TermProbeSource {
  const screen: string[][] = Array.from({ length: ROWS }, () => Array(COLS).fill(" "))
  let captures = 0
  let row = 0
  let col = 0
  const write = (text: string): void => {
    for (let index = 0; index < text.length; index++) {
      if (text[index] === "\x1b") {
        const rest = text.slice(index)
        const clear = /^\x1b\[2J/.exec(rest)
        if (clear !== null) {
          screen.forEach((line) => line.fill(" "))
          row = 0
          col = 0
          index += clear[0].length - 1
          continue
        }
        const move = /^\x1b\[(\d+);(\d+)H/.exec(rest)
        if (move !== null) {
          row = Number(move[1]) - 1
          col = Number(move[2]) - 1
          index += move[0].length - 1
          continue
        }
        const osc = /^\x1b\][^\x07]*\x07/.exec(rest)
        if (osc !== null) {
          if (options.acceptsMarks && row > 0) screen[(options.boundaryRow ?? row) - 1]![col] = "="
          index += osc[0].length - 1
          continue
        }
        continue
      }
      if (row < ROWS && col < COLS) screen[row]![col] = text[index]!
      col += 1
    }
  }
  const capture = async (request: { cells?: CaptureCells; label: string }): Promise<ObservationFrame> => {
    const cells = request.cells!
    const stable = screen
      .slice(cells.top - 1, cells.bottom)
      .map((line) => line.slice(cells.left - 1, cells.right).join(""))
      .join("\n")
    captures += 1
    const text = options.unstable === true ? stable + " " + String(captures) : stable
    return {
      role: "target",
      ref: "sha256:" + hash(text),
      capturedAt: 1,
      label: request.label,
      regionDigest: hash(text),
      regionRectangle: { x: 0, y: 0, width: 1, height: 1 },
    }
  }
  return {
    kind: "native",
    write,
    ...(options.withCapture
      ? {
          capture,
          captureGeometry: {
            geometry: { cellWidth: 8, cellHeight: 16, textWidth: 640, textHeight: 384 },
            source: "measured by complete raster calibration" as const,
          },
        }
      : {}),
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => ({ kind: "unavailable" }) as never,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ kind: "silent" }) as never,
    queryWithSentinelOutcome: async () => ({ kind: "silent" }) as never,
    queryMode: async () => null,
  } as unknown as TermProbeSource
}

const fallback = async (): Promise<ProbeCallbackResult> => ({
  pass: false,
  note: "today's arm",
  tests: [{ id: "criterion", status: "probe-todo" as const, reason: "today's arm" }],
})

test("a reader that paints a boundary at the mark grades it supported", async () => {
  const result = await warpPromptMarkAppResult(
    screenSource({ acceptsMarks: true, withCapture: true }),
    { id: "extensions.osc133-a", mark: "\x1b]133;A\x07", kind: "prompt-start" },
    fallback,
  )
  expect(result.pass).toBe(true)
  expect(result.tests?.[0]?.status).toBe("supported")
  expect(result.observation?.note).toContain("moves with the mark")
})

test("a reader the mark leaves unchanged stays open naming that failure", async () => {
  const result = await warpPromptMarkAppResult(
    screenSource({ acceptsMarks: false, withCapture: true }),
    { id: "extensions.osc133-a", mark: "\x1b]133;A\x07", kind: "prompt-start" },
    fallback,
  )
  expect(result.pass).not.toBe(true)
  expect(result.tests?.[0]?.status).toBe("probe-todo")
  expect(result.tests?.[0]?.reason).toContain("left the boundary band unchanged")
  // #34899 AC4: the run records the rectangles it compared, so a verdict can be re-read without the source.
  expect(result.tests?.[0]?.reason).toContain("rows 3-5, cols 1-40")
  const recorded = JSON.parse(String(result.response)) as { rectangles: unknown }
  expect(recorded.rectangles).toEqual({
    boundary: "rows 3-5, cols 1-40",
    history: "rows 1-2, cols 1-40",
    shiftedBoundary: "rows 6-8, cols 1-40",
  })
})

test("command-finished stays open because a frame does not carry the numeric status", async () => {
  const result = await warpPromptMarkAppResult(
    screenSource({ acceptsMarks: true, withCapture: true }),
    { id: "extensions.osc133-d", mark: "\x1b]133;D;0\x07", kind: "command-finished" },
    fallback,
  )
  expect(result.tests?.[0]?.status).toBe("probe-todo")
  expect(result.tests?.[0]?.reason).toContain("exact numeric status")
})

test("a frame that is not stable across two reads grades nothing", async () => {
  const result = await warpPromptMarkAppResult(
    screenSource({ acceptsMarks: true, withCapture: true, unstable: true }),
    { id: "extensions.osc133-a", mark: "\x1b]133;A\x07", kind: "prompt-start" },
    fallback,
  )
  expect(result.pass).not.toBe(true)
  expect(result.tests?.[0]?.status).toBe("probe-todo")
  expect(result.tests?.[0]?.reason).toContain("two reads of the same frame disagreed")
  // @dev/11's read of run 44398257551: the reason must say WHICH region disagreed, not just that one did.
  expect(result.tests?.[0]?.reason).toContain("the retained history (rows 1-2, cols 1-40)")
})

test("text and properties rows name the reader each one needs", async () => {
  const text = await warpPromptMarkAppResult(
    screenSource({ acceptsMarks: true, withCapture: true }),
    { id: "extensions.osc633-e", mark: "\x1b]633;E;echo hi\x07", kind: "text" },
    fallback,
  )
  expect(text.tests?.[0]?.reason).toContain("command text read FROM the mark")
  const properties = await warpPromptMarkAppResult(
    screenSource({ acceptsMarks: true, withCapture: true }),
    { id: "extensions.osc633-p", mark: "\x1b]633;P;Cwd=/tmp\x07", kind: "properties" },
    fallback,
  )
  expect(properties.tests?.[0]?.reason).toContain("OSC 7 control")
})

test("without a capture adapter the row names the missing frame route", async () => {
  const result = await warpPromptMarkAppResult(
    screenSource({ acceptsMarks: true, withCapture: false }),
    { id: "extensions.osc133-a", mark: "\x1b]133;A\x07", kind: "prompt-start" },
    fallback,
  )
  expect(result.tests?.[0]?.status).toBe("probe-todo")
  expect(result.tests?.[0]?.reason).toContain("no pixel capture adapter")
})

test("the collector flag routes a real mark row to the frame differential", async () => {
  const row = extensionsProbes.find((probe) => probe.id === "extensions.osc133-a")
  if (!row?.term) throw new Error("missing the extensions.osc133-a term arm")
  const source = { ...screenSource({ acceptsMarks: true, withCapture: true }), promptMarkBoundaryRendering: true }
  const result = await (row.term as (ctx: TermProbeSource) => Promise<ProbeCallbackResult>)(
    source as unknown as TermProbeSource,
  )
  expect(result.tests?.[0]?.status).toBe("supported")
  expect(result.observation?.note).toContain("moves with the mark")
})

test("without the flag the same row keeps the cursor-position arm", async () => {
  const row = extensionsProbes.find((probe) => probe.id === "extensions.osc133-a")
  if (!row?.term) throw new Error("missing the extensions.osc133-a term arm")
  const result = await (row.term as (ctx: TermProbeSource) => Promise<ProbeCallbackResult>)(
    screenSource({ acceptsMarks: true, withCapture: true }),
  )
  expect(result.tests?.[0]?.status).not.toBe("supported")
  expect(result.observation?.note ?? "").not.toContain("moves with the mark")
})

// #34949 (@cto fixed-position finding, condition C2): a screen that paints every mark's boundary at a
// fixed row — row 3 here, while the mark moves from row 4 to row 6 — used to grade Supported, because
// the moved mark's band carried different block text and therefore a different digest whatever it did.
test("a boundary painted at a fixed row never grades supported", async () => {
  const result = await warpPromptMarkAppResult(
    screenSource({ acceptsMarks: true, withCapture: true, boundaryRow: 3 }),
    { id: "extensions.osc133-a", mark: "\x1b]133;A\x07", kind: "prompt-start" },
    fallback,
  )
  expect(result.pass).not.toBe(true)
  expect(result.tests?.[0]?.status).toBe("probe-todo")
  expect(result.tests?.[0]?.reason).toContain("did not follow the mark")
})

// The moved mark is compared with the same band and the same fixed text, so the response must carry
// that second omission read: a reader can re-derive the comparison without trusting the summary.
test("the moved-position comparison records its own omission read", async () => {
  const result = await warpPromptMarkAppResult(
    screenSource({ acceptsMarks: true, withCapture: true }),
    { id: "extensions.osc133-a", mark: "\x1b]133;A\x07", kind: "prompt-start" },
    fallback,
  )
  const recorded = JSON.parse(String(result.response)) as Record<string, { boundary?: string }>
  expect(recorded.shiftedOmission?.boundary).toBeDefined()
  expect(recorded.shiftedOmission?.boundary).not.toBe(recorded.shifted?.boundary)
})

// @dev/12's peer REVISE on #34949: band(r) spans r-1..r+1, so the two bands overlapped at row 5 and a
// reader painting every boundary at a fixed row inside the overlap passed both comparisons. The bands
// are disjoint now, and a fixed painter at any row the old geometry shared must fail.
test("a boundary painted at the old overlap row never grades supported", async () => {
  const result = await warpPromptMarkAppResult(
    screenSource({ acceptsMarks: true, withCapture: true, boundaryRow: 5 }),
    { id: "extensions.osc133-a", mark: "\x1b]133;A\x07", kind: "prompt-start" },
    fallback,
  )
  expect(result.pass).not.toBe(true)
  expect(result.tests?.[0]?.status).toBe("probe-todo")
})

test("a boundary painted at a fixed row inside the moved band alone never grades supported", async () => {
  for (const boundaryRow of [6, 8]) {
    const result = await warpPromptMarkAppResult(
      screenSource({ acceptsMarks: true, withCapture: true, boundaryRow }),
      { id: "extensions.osc133-a", mark: "\x1b]133;A\x07", kind: "prompt-start" },
      fallback,
    )
    expect(result.pass, String(boundaryRow)).not.toBe(true)
    expect(result.tests?.[0]?.status, String(boundaryRow)).toBe("probe-todo")
  }
})
