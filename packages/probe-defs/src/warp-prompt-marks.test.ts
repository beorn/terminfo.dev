/**
 * @failure #34899 r2 C1/C2: the Warp app arm must decide a mark from a same-run differential, and
 *   must never grade an inert reader, a block that moved with the mark, or a boundary that does not
 *   follow the mark. Every undecided outcome stays open naming the control that failed. #34899 AC4b
 *   (@cto 171e1def): a frame the unknown OSC or the SGR reset also changes never grades Supported, the
 *   overlay-visibility and both negative controls are recorded as role "control" by digest, and the
 *   positional rows' reason says criterion W §1's prompt-mark positive control stays unmet here.
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

/** One capture the fake answered, in the order it was asked, with the role it was asked for. */
interface Captured {
  role: ObservationFrame["role"]
  label: string
  ref: string
  regionDigest: string
}

/**
 * A 24x80 screen model: clear, CUP, CSI m and OSC are understood, and a 133/633 mark paints a boundary
 * above its row. SGR is parsed so "[0m" never lands on the screen as text.
 */
function screenSource(options: {
  acceptsMarks: boolean
  withCapture: boolean
  unstable?: boolean
  /** A broken reader: every mark paints its boundary at this row, wherever the mark itself is written. */
  boundaryRow?: number
  /** A broken reader that paints the boundary for ANY OSC, an unknown 1337 included. */
  anyOsc?: boolean
  /** A broken reader whose band moves on an SGR write that carries no mark. */
  paintsOnSgr?: boolean
  /** Rows a sticky overlay covers: their crop shows the overlay, never the grid text under it. */
  chromeRows?: readonly number[]
  /** Filled with every capture this source answers. */
  captured?: Captured[]
}): TermProbeSource {
  const screen: string[][] = Array.from({ length: ROWS }, () => Array(COLS).fill(" "))
  let captures = 0
  let row = 0
  let col = 0
  const paintBoundary = (): void => {
    if (row > 0) screen[(options.boundaryRow ?? row) - 1]![col] = "="
  }
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
        const sgr = /^\x1b\[[\d;]*m/.exec(rest)
        if (sgr !== null) {
          if (options.paintsOnSgr === true) paintBoundary()
          index += sgr[0].length - 1
          continue
        }
        const osc = /^\x1b\]([^\x07]*)\x07/.exec(rest)
        if (osc !== null) {
          const promptMark = /^(133|633);/.test(osc[1]!)
          if (options.acceptsMarks && (promptMark || options.anyOsc === true)) paintBoundary()
          index += osc[0].length - 1
          continue
        }
        continue
      }
      if (row < ROWS && col < COLS) screen[row]![col] = text[index]!
      col += 1
    }
  }
  const overlay = (line: number): string[] => ("warp block header " + String(line)).padEnd(COLS).split("")
  const capture = async (request: {
    role: ObservationFrame["role"]
    cells?: CaptureCells
    label: string
  }): Promise<ObservationFrame> => {
    const cells = request.cells!
    const stable = screen
      .map((line, index) => (options.chromeRows?.includes(index + 1) === true ? overlay(index + 1) : line))
      .slice(cells.top - 1, cells.bottom)
      .map((line) => line.slice(cells.left - 1, cells.right).join(""))
      .join("\n")
    captures += 1
    const text = options.unstable === true ? stable + " " + String(captures) : stable
    options.captured?.push({
      role: request.role,
      label: request.label,
      ref: "sha256:" + hash(text),
      regionDigest: hash(text),
    })
    return {
      role: request.role,
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

// #34899 AC4b (@cto 171e1def): the two negative controls write bytes that are not a prompt mark in the
// mark's place. A reader whose frame changes for them shows a region that is not specific to the mark,
// so they can block a Supported and never grant one.
const OSC133_A = { id: "extensions.osc133-a", mark: "\x1b]133;A\x07", kind: "prompt-start" } as const
const OSC133_D = { id: "extensions.osc133-d", mark: "\x1b]133;D;0\x07", kind: "command-finished" } as const

interface RecordedControl {
  kind: string
  passed?: boolean
  unchanged?: boolean
  boundary: { label: string; ref: string; regionDigest?: string; regionRectangle?: unknown }
  history: { label: string; ref: string; regionDigest?: string; regionRectangle?: unknown }
}

function recordedControls(result: ProbeCallbackResult): Record<string, RecordedControl> | undefined {
  return (JSON.parse(String(result.response)) as { controls?: Record<string, RecordedControl> }).controls
}

test("a reader that paints for any OSC, an unknown 1337 included, never grades supported", async () => {
  const result = await warpPromptMarkAppResult(
    screenSource({ acceptsMarks: true, withCapture: true, anyOsc: true }),
    OSC133_A,
    fallback,
  )
  expect(result.pass).not.toBe(true)
  expect(result.tests?.[0]?.status).toBe("probe-todo")
  expect(result.tests?.[0]?.reason).toContain("the unknown-OSC control (ESC ] 1337 ; probe BEL in place of the mark)")
  expect(result.tests?.[0]?.reason).not.toContain("the SGR-only control")
  expect(recordedControls(result)?.unknownOsc?.unchanged).toBe(false)
})

test("a reader whose band moves on an SGR-only write never grades supported", async () => {
  const result = await warpPromptMarkAppResult(
    screenSource({ acceptsMarks: true, withCapture: true, paintsOnSgr: true }),
    OSC133_A,
    fallback,
  )
  expect(result.pass).not.toBe(true)
  expect(result.tests?.[0]?.status).toBe("probe-todo")
  expect(result.tests?.[0]?.reason).toContain("the SGR-only control (ESC [ 0 m in place of the mark)")
  expect(result.tests?.[0]?.reason).not.toContain("the unknown-OSC control")
  expect(recordedControls(result)?.sgrOnly?.unchanged).toBe(false)
})

test("osc133-a and osc133-d each record six role-control captures, cited by ref and digest", async () => {
  for (const spec of [OSC133_A, OSC133_D]) {
    const captured: Captured[] = []
    const result = await warpPromptMarkAppResult(
      screenSource({ acceptsMarks: true, withCapture: true, captured }),
      spec,
      fallback,
    )
    const controls = captured.filter((frame) => frame.role === "control")
    expect(controls, spec.id).toHaveLength(6)
    // The existing ten target captures keep their order, labels and place ahead of every control.
    expect(
      captured.slice(0, 10).map((frame) => frame.role + " " + frame.label),
      spec.id,
    ).toEqual(
      [
        "mark alone",
        "mark alone, second read",
        "mark omitted",
        "mark omitted at the moved position",
        "mark at another position",
      ].flatMap((variant) => [
        "target " + spec.id + ": " + variant + " boundary",
        "target " + spec.id + ": " + variant + " history",
      ]),
    )
    expect(captured, spec.id).toHaveLength(16)
    const recorded = recordedControls(result)
    expect(Object.keys(recorded ?? {}), spec.id).toEqual(["overlayVisibility", "unknownOsc", "sgrOnly"])
    expect(recorded?.overlayVisibility?.kind, spec.id).toBe("overlay-visibility")
    const cited = Object.values(recorded ?? {}).flatMap((control) => [control.boundary, control.history])
    expect(
      cited.map((read) => [read.label, read.ref, read.regionDigest]),
      spec.id,
    ).toEqual(controls.map((frame) => [frame.label, frame.ref, frame.regionDigest]))
    for (const read of cited) expect(read.regionRectangle, read.label).toBeDefined()
  }
})

test("an overlay over rows 1-2 with an unchanged band names foreign-mark observability and the overlay-visibility digests", async () => {
  const result = await warpPromptMarkAppResult(
    screenSource({ acceptsMarks: false, withCapture: true, chromeRows: [1, 2] }),
    OSC133_A,
    fallback,
  )
  expect(result.tests?.[0]?.status).toBe("probe-todo")
  const reason = String(result.tests?.[0]?.reason)
  expect(reason).toContain("left the boundary band unchanged")
  expect(reason).toContain("foreign-mark observability stays a named PROBE TODO")
  expect(reason).toContain(
    "criterion W §1's prompt-mark positive control stays unmet in this route: the collector is the single command Warp runs, and TermProbeSource cannot run a shell command",
  )
  const overlay = recordedControls(result)?.overlayVisibility
  expect(overlay?.passed).toBe(true)
  expect(reason).toContain("the overlay-visibility control held")
  expect(reason).toContain(String(overlay?.history.regionDigest))
  expect(reason).toContain(String(overlay?.boundary.regionDigest))
})

test("without an overlay the overlay-visibility control fails by name and moves no grade", async () => {
  const open = await warpPromptMarkAppResult(
    screenSource({ acceptsMarks: false, withCapture: true }),
    OSC133_A,
    fallback,
  )
  expect(open.tests?.[0]?.status).toBe("probe-todo")
  expect(open.tests?.[0]?.reason).toContain("the overlay-visibility control failed")
  expect(open.tests?.[0]?.reason).toContain("rows 1-2 followed the new grid text")
  expect(recordedControls(open)?.overlayVisibility?.passed).toBe(false)
  // The same failed control beside a working mark leaves the grade where the differential put it.
  const working = await warpPromptMarkAppResult(
    screenSource({ acceptsMarks: true, withCapture: true }),
    OSC133_A,
    fallback,
  )
  expect(recordedControls(working)?.overlayVisibility?.passed).toBe(false)
  expect(working.tests?.[0]?.status).toBe("supported")
})
