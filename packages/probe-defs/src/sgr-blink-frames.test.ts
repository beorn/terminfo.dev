/**
 * @failure sgr.blink captures one target frame, so a blinking terminal photographed in its off phase reads the same
 *   as one that never blinks, and seven app cells cannot be decided (#31812); or a redraw that moves the screen, or
 *   a first sample caught before the fixture finished painting (A,B,B,B), is read as blink.
 * @level l1
 * @consumer app sgr.blink results projected into terminal support cells
 * @testonly none
 */
import { expect, test } from "vitest"
import { recordExecutedProbe } from "./helpers.ts"
import { sgrProbes } from "./sgr.ts"
import type { CaptureCells, ObservationFrame, TermProbeSource } from "./types.ts"

function blink() {
  const probe = sgrProbes.find((value) => value.id === "sgr.blink")
  if (!probe?.term) throw new Error("missing sgr.blink term callback")
  return probe
}

const GEOMETRY = {
  geometry: { cellWidth: 8, cellHeight: 16, textWidth: 640, textHeight: 384 },
  source: "measured by complete raster calibration" as const,
}

/** An app context whose capture answers each styled sample with the next digest in `styled`, and each plain
 *  line capture (the control's first) with the next one in `plain`; the unstyled control frame reads
 *  "unstyled". `latencyMs` makes every acquisition settle first, as the Linux producer does. */
function app(opts: { styled: readonly string[]; plain: readonly string[]; geometry: boolean; latencyMs?: number }) {
  const writes: string[] = []
  const captures: Array<{ writes: number; at: number; label: string; cells?: CaptureCells }> = []
  let styled = 0
  let plain = 0
  const context: TermProbeSource = {
    kind: "live",
    write: (bytes) => writes.push(bytes),
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
    cols: 80,
    rows: 24,
    ...(opts.geometry ? { captureGeometry: GEOMETRY } : {}),
    capture: async ({ role, label, cells }): Promise<ObservationFrame> => {
      const requestedWrites = writes.length
      if (opts.latencyMs) await new Promise((resolve) => setTimeout(resolve, opts.latencyMs))
      captures.push({ writes: requestedWrites, at: Date.now(), label, ...(cells ? { cells } : {}) })
      const index = captures.length
      const base = { role, label, capturedAt: Date.now(), ref: `frame-${String(index)}` }
      if (!cells) return { ...base, pixelsDigest: `whole-${String(index)}` }
      const isPlain = cells.top === 1
      const digest = isPlain ? opts.plain[plain++] : role === "control" ? "unstyled" : opts.styled[styled++]
      return {
        ...base,
        regionDigest: digest,
        pixelsDigest: `whole-${String(index)}`,
        regionRectangle: { x: 16, y: isPlain ? 0 : 32, width: 8 * (cells.right - cells.left + 1), height: 16 },
      }
    },
  }
  return { context, writes, captures }
}

const STEADY_PLAIN = ["p", "p", "p", "p", "p"]

test("blink samples the styled text four times over 750 ms with no write between, beside a plain line", async () => {
  const { context, writes, captures } = app({ styled: ["on", "off", "on", "off"], plain: STEADY_PLAIN, geometry: true })
  const result = await blink().term!(context)
  const samples = captures.filter((entry) => entry.cells?.top === 3).slice(1)
  expect(samples).toHaveLength(4)
  // The plain line is in the control and in every sample: five frames.
  expect(captures.filter((entry) => entry.cells?.top === 1)).toHaveLength(5)
  // The control (text and plain line) sees the control write; every sample sees the one fixture write after it.
  const controlWrites = captures[0]!.writes
  expect(captures[1]!.writes).toBe(controlWrites)
  expect(new Set(captures.slice(2).map((entry) => entry.writes))).toEqual(new Set([controlWrites + 1]))
  expect(samples.at(-1)!.at - samples[0]!.at).toBeGreaterThanOrEqual(740)
  expect(writes[controlWrites - 1]).toContain("\x1b[1;3H")
  expect(writes[controlWrites - 1]).not.toContain("\x1b[5m")
  expect(writes[controlWrites]).toContain("\x1b[1;3H")
  expect(writes[controlWrites]).toContain("\x1b[5m")
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "screenshot" })
  expect(result.assertions).toMatchObject([{ kind: "positive" }])
  expect(JSON.parse(result.response ?? "")).toMatchObject({ styled: ["on", "off", "on", "off"], plain: STEADY_PLAIN })
})

test("a first sample caught before the fixture finished painting (A,B,B,B) is not blink", async () => {
  // @dev/10's counterexample (#31812 first-line review): mid-paint first, then steady styled text.
  const { context } = app({ styled: ["partial", "steady", "steady", "steady"], plain: STEADY_PLAIN, geometry: true })
  const result = await blink().term!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", note: expect.stringContaining("one way") })
  expect(result.pass).toBe(false)
})

test("an undecided blink is recorded as review pending, never a test failure; a return is recorded Supported", async () => {
  // @dev/10's fold proof (#31812 r2): a rowless inconclusive result persisted as TEST FAILURE.
  const record = (result: Awaited<ReturnType<NonNullable<ReturnType<typeof blink>["term"]>>>) =>
    recordExecutedProbe({
      featureId: "sgr.blink",
      attempt: { scope: "probe", startedAt: "2026-10-30T03:00:00.000Z" },
      // The collector stamps the callback's observation and each assertion with its feature before the fold.
      ...(result.observation ? { observation: { ...result.observation, featureId: "sgr.blink" } } : {}),
      assertions: (result.assertions ?? []).map((assertion) => ({ ...assertion, featureId: "sgr.blink" })),
      ...(result.tests ? { tests: result.tests } : {}),
      ...(result.criterionBranch ? { criterionBranch: result.criterionBranch } : {}),
    })
  for (const styled of [
    ["partial", "steady", "steady", "steady"],
    ["on", "on", "on", "on"],
  ]) {
    const { context } = app({ styled, plain: STEADY_PLAIN, geometry: true })
    const result = await blink().term!(context)
    expect(result.tests).toMatchObject([
      { id: "capture", status: "supported" },
      { id: "review", status: "test-todo" },
    ])
    expect(record(result).status).not.toBe("test-failure")
  }
  const { context } = app({ styled: ["on", "off", "on", "off"], plain: STEADY_PLAIN, geometry: true })
  expect(record(await blink().term!(context)).status).toBe("supported")
})

test("a one-way change later in the window (A,A,B,B) is not blink either", async () => {
  const { context } = app({ styled: ["a", "a", "b", "b"], plain: STEADY_PLAIN, geometry: true })
  const result = await blink().term!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", note: expect.stringContaining("one way") })
})

test("four equal blink samples stay inconclusive: no blink period is recorded, so they are not Unsupported", async () => {
  const { context } = app({ styled: ["on", "on", "on", "on"], plain: STEADY_PLAIN, geometry: true })
  const result = await blink().term!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", note: expect.stringContaining("blink period") })
  expect(result.observation?.outcome).not.toBe("unsupported")
})

test("a plain line that moves between samples vetoes blink: redraw, scroll or cursor motion is not blink", async () => {
  const { context } = app({ styled: ["on", "off", "on", "off"], plain: ["p", "p", "p", "q", "p"], geometry: true })
  const result = await blink().term!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", note: expect.stringContaining("plain line") })
})

test("the plain line is held across all five frames: a control that differs from the samples vetoes blink", async () => {
  const { context } = app({ styled: ["on", "off", "on", "off"], plain: ["q", "p", "p", "p", "p"], geometry: true })
  const result = await blink().term!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", note: expect.stringContaining("plain line") })
})

test("a producer that settles 150 ms per acquisition records requested offsets beside invocation and capture times", async () => {
  const { context } = app({
    styled: ["on", "off", "on", "off"],
    plain: STEADY_PLAIN,
    geometry: true,
    latencyMs: 150,
  })
  const result = await blink().term!(context)
  expect(result.observation).toMatchObject({ outcome: "supported" })
  const { timing } = JSON.parse(result.response ?? "") as {
    timing: Array<{ requestedOffsetMs: number; invokedMs: number; styledCapturedAt: number; plainCapturedAt: number }>
  }
  expect(timing.map((entry) => entry.requestedOffsetMs)).toEqual([0, 250, 500, 750])
  // Two settled acquisitions per sample take longer than the 250 ms gap, so invocations land after the
  // requested offsets; the record says so instead of relabelling them.
  expect(timing.at(-1)!.invokedMs).toBeGreaterThan(750)
  for (const entry of timing) {
    expect(entry.plainCapturedAt - entry.styledCapturedAt).toBeGreaterThanOrEqual(140)
  }
}, 10_000)

test("without a measured raster the control and four blink samples go to review together", async () => {
  const { context, captures } = app({ styled: [], plain: [], geometry: false })
  const result = await blink().term!(context)
  expect(captures).toHaveLength(5)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", assertionType: "screenshot" })
  expect(result.observation?.frames).toHaveLength(5)
  expect(result.tests).toMatchObject([
    { id: "capture", status: "supported" },
    { id: "review", status: "test-todo" },
  ])
})
