/**
 * @failure sgr.blink captures one target frame, so a blinking terminal photographed in its off phase reads the same
 *   as one that never blinks, and seven app cells cannot be decided (#31812); or a redraw that moves the screen, or
 *   a first sample caught before the fixture finished painting (A,B,B,B), is read as blink.
 * @level l1
 * @consumer app sgr.blink results projected into terminal support cells
 * @testonly none
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest"
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
function app(opts: {
  styled: readonly string[]
  plain: readonly string[]
  geometry: boolean
  latencyMs?: number
  styledAt?: (now: number) => string
}) {
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
      const digest = isPlain
        ? opts.plain[plain++]
        : role === "control"
          ? "unstyled"
          : (opts.styledAt?.(Date.now()) ?? opts.styled[styled++])
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

// The schedule's own waits run on a fake clock, so nine samples over 2000 ms cost no wall time.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] })
})
afterEach(() => {
  vi.useRealTimers()
})

async function term(context: TermProbeSource) {
  const pending = blink().term!(context)
  await vi.runAllTimersAsync()
  return pending
}

const SAMPLES = 9
const STEADY_PLAIN = Array.from({ length: SAMPLES + 1 }, () => "p")
const ALTERNATING = Array.from({ length: SAMPLES }, (_, index) => (index % 2 === 0 ? "on" : "off"))
const EQUAL = Array.from({ length: SAMPLES }, () => "on")
const plainMovingAt = (index: number) => STEADY_PLAIN.map((value, at) => (at === index ? "q" : value))

test("blink samples the styled text nine times over 2000 ms with no write between, beside a plain line", async () => {
  const { context, writes, captures } = app({ styled: ALTERNATING, plain: STEADY_PLAIN, geometry: true })
  const result = await term(context)
  const samples = captures.filter((entry) => entry.cells?.top === 3).slice(1)
  expect(samples).toHaveLength(SAMPLES)
  // The plain line is in the control and in every sample: ten frames.
  expect(captures.filter((entry) => entry.cells?.top === 1)).toHaveLength(SAMPLES + 1)
  // The control (text and plain line) sees the control write; every sample sees the one fixture write after it.
  const controlWrites = captures[0]!.writes
  expect(captures[1]!.writes).toBe(controlWrites)
  expect(new Set(captures.slice(2).map((entry) => entry.writes))).toEqual(new Set([controlWrites + 1]))
  expect(samples.at(-1)!.at - samples[0]!.at).toBeGreaterThanOrEqual(2000)
  expect(writes[controlWrites - 1]).toContain("\x1b[1;3H")
  expect(writes[controlWrites - 1]).not.toContain("\x1b[5m")
  expect(writes[controlWrites]).toContain("\x1b[1;3H")
  expect(writes[controlWrites]).toContain("\x1b[5m")
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "screenshot" })
  expect(result.assertions).toMatchObject([{ kind: "positive" }])
  expect(JSON.parse(result.response ?? "")).toMatchObject({ styled: ALTERNATING, plain: STEADY_PLAIN })
})

test("a first sample caught before the fixture finished painting (A,B,B,B) is not blink", async () => {
  // @dev/10's counterexample (#31812 first-line review): mid-paint first, then steady styled text.
  const styled = ["partial", ...Array.from({ length: SAMPLES - 1 }, () => "steady")]
  const { context } = app({ styled, plain: STEADY_PLAIN, geometry: true })
  const result = await term(context)
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
  for (const styled of [["partial", ...Array.from({ length: SAMPLES - 1 }, () => "steady")], EQUAL]) {
    const { context } = app({ styled, plain: STEADY_PLAIN, geometry: true })
    const result = await term(context)
    expect(result.tests).toMatchObject([
      { id: "capture", status: "supported" },
      { id: "review", status: "test-todo" },
    ])
    expect(record(result).status).not.toBe("test-failure")
  }
  const { context } = app({ styled: ALTERNATING, plain: STEADY_PLAIN, geometry: true })
  expect(record(await term(context)).status).toBe("supported")
})

test("a one-way change later in the window (A,A,B,B) is not blink either", async () => {
  const styled = Array.from({ length: SAMPLES }, (_, index) => (index < 4 ? "a" : "b"))
  const { context } = app({ styled, plain: STEADY_PLAIN, geometry: true })
  const result = await term(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", note: expect.stringContaining("one way") })
})

test("nine equal blink samples stay inconclusive: no blink period is recorded, so they are not Unsupported", async () => {
  const { context } = app({ styled: EQUAL, plain: STEADY_PLAIN, geometry: true })
  const result = await term(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", note: expect.stringContaining("blink period") })
  expect(result.observation?.outcome).not.toBe("unsupported")
})

test("a plain line that moves between samples vetoes blink: redraw, scroll or cursor motion is not blink", async () => {
  const { context } = app({ styled: ALTERNATING, plain: plainMovingAt(3), geometry: true })
  const result = await term(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", note: expect.stringContaining("plain line") })
})

test("the plain line is held across all ten frames: a control that differs from the samples vetoes blink", async () => {
  const { context } = app({ styled: ALTERNATING, plain: plainMovingAt(0), geometry: true })
  const result = await term(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", note: expect.stringContaining("plain line") })
})

test("a producer that settles 150 ms per acquisition records requested offsets beside invocation and capture times", async () => {
  const { context } = app({
    styled: ALTERNATING,
    plain: STEADY_PLAIN,
    geometry: true,
    latencyMs: 150,
  })
  const result = await term(context)
  expect(result.observation).toMatchObject({ outcome: "supported" })
  const { timing } = JSON.parse(result.response ?? "") as {
    timing: Array<{ requestedOffsetMs: number; invokedMs: number; styledCapturedAt: number; plainCapturedAt: number }>
  }
  expect(timing.map((entry) => entry.requestedOffsetMs)).toEqual([0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000])
  // Two settled acquisitions per sample take longer than the 250 ms gap, so invocations land after the
  // requested offsets; the record says so instead of relabelling them.
  expect(timing.at(-1)!.invokedMs).toBeGreaterThan(2000)
  for (const entry of timing) {
    expect(entry.plainCapturedAt - entry.styledCapturedAt).toBeGreaterThanOrEqual(140)
  }
})

test("without a measured raster the control and nine blink samples go to review together", async () => {
  const { context, captures } = app({ styled: [], plain: [], geometry: false })
  const result = await term(context)
  expect(captures).toHaveLength(SAMPLES + 1)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", assertionType: "screenshot" })
  expect(result.observation?.frames).toHaveLength(SAMPLES + 1)
  expect(result.tests).toMatchObject([
    { id: "capture", status: "supported" },
    { id: "review", status: "test-todo" },
  ])
})

// #32083 (@cto 18528242): a return needs an earlier sample, not the control, so the schedule must hold two
// transitions of a 500 ms on/off blink whatever phase its first sample lands on; the old 750 ms schedule held one
// transition when the first sample landed at the start of a phase.
test("a 500 ms on/off blink returns to an earlier sample at every starting phase", async () => {
  for (const phaseMs of [0, 100, 200, 300, 400]) {
    const start = Date.now()
    const { context } = app({
      styled: [],
      plain: STEADY_PLAIN,
      geometry: true,
      styledAt: (now) => (Math.floor((now - start + phaseMs) / 500) % 2 === 0 ? "on" : "off"),
    })
    const result = await term(context)
    expect(result.observation, "phase " + String(phaseMs) + " ms").toMatchObject({ outcome: "supported" })
  }
})
