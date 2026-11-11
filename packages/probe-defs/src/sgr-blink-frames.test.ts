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
import { finalizeVisualResult, sgrProbes } from "./sgr.ts"
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

/** An app context whose one capture per sample answers the styled region with the next digest in
 *  `styled` and the same shot's plain control region with the next one in `plain` (the control
 *  shot's first); the unstyled control frame reads "unstyled". `latencyMs` makes every
 *  acquisition settle first, as the Linux producer does. */
function app(opts: {
  styled: readonly string[]
  plain: readonly string[]
  geometry: boolean
  latencyMs?: number
  styledAt?: (now: number) => string
  controls?: boolean
  repaint?: boolean
  capturedAt?: (now: number, sample: number) => number
}) {
  const writes: string[] = []
  const captures: Array<{
    writes: number
    at: number
    label: string
    cells?: CaptureCells
    controlCells?: CaptureCells
  }> = []
  const keys: string[] = []
  const focusReads: number[] = []
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
    ...(opts.controls
      ? {
          input: {
            injectKey: async (key: string) => {
              keys.push(key)
            },
            injectClick: async () => {},
            focusRoundTrip: async () => {
              focusReads.push(Date.now())
              return {
                ownedWindowId: "owned",
                helperWindowId: "helper",
                focusedWindowIds: ["owned", "helper", "owned"] as [string, string, string],
              }
            },
          },
          readInput: async (pattern: RegExp, _timeout?: number, inject?: () => Promise<void>) => {
            await inject?.()
            return keys.at(-1)?.match(pattern) ?? null
          },
        }
      : {}),
    capture: async ({ role, label, cells, controlCells }): Promise<ObservationFrame> => {
      const requestedWrites = writes.length
      if (opts.latencyMs) await new Promise((resolve) => setTimeout(resolve, opts.latencyMs))
      captures.push({
        writes: requestedWrites,
        at: Date.now(),
        label,
        ...(cells ? { cells } : {}),
        ...(controlCells ? { controlCells } : {}),
      })
      const index = captures.length
      const base = {
        role,
        label,
        capturedAt: opts.capturedAt?.(Date.now(), styled) ?? Date.now(),
        ref: `frame-${String(index)}`,
      }
      if (!cells) return { ...base, pixelsDigest: `whole-${String(index)}` }
      const isPlain = cells.top === 1
      const digest =
        cells.top === 2
          ? opts.repaint === false
            ? "unpainted"
            : writes.at(-1)!
          : isPlain
            ? opts.plain[plain++]
            : role === "control"
              ? "unstyled"
              : (opts.styledAt?.(Date.now()) ?? opts.styled[styled++])
      return {
        ...base,
        regionDigest: digest,
        pixelsDigest: `whole-${String(index)}`,
        regionRectangle: { x: 16, y: 16 * (cells.top - 1), width: 8 * (cells.right - cells.left + 1), height: 16 },
        ...(controlCells
          ? {
              controlRegionDigest: opts.plain[plain++],
              controlRegionRectangle: {
                x: 16,
                y: 16 * (controlCells.top - 1),
                width: 8 * (controlCells.right - controlCells.left + 1),
                height: 16,
              },
            }
          : {}),
      }
    },
  }
  return { context, writes, captures, keys, focusReads }
}

// The schedule's own waits run on a fake clock, so the requested samples over 7500 ms cost no wall time.
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

const SAMPLES = 16
const STEADY_PLAIN = Array.from({ length: SAMPLES + 1 }, () => "p")
const ALTERNATING = Array.from({ length: SAMPLES }, (_, index) => (index % 2 === 0 ? "on" : "off"))
const EQUAL = Array.from({ length: SAMPLES }, () => "on")
const plainMovingAt = (index: number) => STEADY_PLAIN.map((value, at) => (at === index ? "q" : value))

// A valid DECRQSS reply must still reach blink's owned multi-frame oracle.
// Existing rows only exercise the query-silence fallback.
test("a valid 0;5 reply reaches the owned blink oracle", async () => {
  const { context, captures } = app({ styled: ALTERNATING, plain: STEADY_PLAIN, geometry: true })
  const raw = "\x1bP1$r0;5m\x1b\\"
  const reply: TermProbeSource["queryWithSentinelOutcome"] = async (_sequence, pattern) => ({
    match: raw.match(pattern),
    reason: "reply",
    raw,
    rawBase64: btoa(raw),
  })
  context.queryWithSentinelOutcome = vi.fn(reply)
  const result = await term(context)
  expect(context.queryWithSentinelOutcome).toHaveBeenCalledTimes(1)
  expect(captures.filter((entry) => entry.cells?.top === 3)).toHaveLength(SAMPLES + 1)
  // One shot per sample carries both regions: the plain line is never a separate capture.
  expect(captures.filter((entry) => entry.cells?.top === 1)).toHaveLength(0)
  expect(captures.filter((entry) => entry.controlCells?.top === 1)).toHaveLength(SAMPLES + 1)
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "screenshot" })
  expect(result.assertions).toMatchObject([{ kind: "positive", assertionType: "screenshot" }])
})

test("blink samples the styled text sixteen times over 7500 ms with no write between, beside a plain line", async () => {
  const { context, writes, captures } = app({ styled: ALTERNATING, plain: STEADY_PLAIN, geometry: true })
  const result = await term(context)
  const samples = captures.filter((entry) => entry.cells?.top === 3).slice(1)
  expect(samples).toHaveLength(SAMPLES)
  // The plain line rides the same shot as the control and every sample, never its own capture.
  expect(captures.filter((entry) => entry.controlCells?.top === 1)).toHaveLength(SAMPLES + 1)
  expect(captures.filter((entry) => entry.cells?.top === 1)).toHaveLength(0)
  // The control sees the control write; every sample sees the one fixture write after it.
  const controlWrites = captures[0]!.writes
  expect(new Set(captures.slice(1).map((entry) => entry.writes))).toEqual(new Set([controlWrites + 1]))
  expect(samples.at(-1)!.at - samples[0]!.at).toBeGreaterThanOrEqual(7500)
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
  // One change never reads Supported; inside the achieved-frames gate it may only speak as a
  // negative, and only with its live controls (#33117).
  const styled = ["partial", ...Array.from({ length: SAMPLES - 1 }, () => "steady")]
  const { context } = app({ styled, plain: STEADY_PLAIN, geometry: true })
  const result = await term(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive" })
  expect(result.pass).toBe(false)
  const controlled = app({ styled, plain: STEADY_PLAIN, geometry: true, controls: true })
  expect((await term(controlled.context)).observation).toMatchObject({ outcome: "unsupported" })
})

test("an undecided blink is recorded as review pending, never a test failure; a return is recorded Supported", async () => {
  // @dev/10's fold proof (#31812 r2): a rowless inconclusive result persisted as PROBE INVALID.
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
      { id: "review", status: "probe-todo" },
    ])
    expect(record(result).status).not.toBe("probe-invalid")
  }
  const { context } = app({ styled: ALTERNATING, plain: STEADY_PLAIN, geometry: true })
  expect(record(await term(context)).status).toBe("supported")
})

test("a one-way change achieved too slowly stays open: capture too slow to decide blink", async () => {
  // The Terminal.app 3053c5ec shape (#33117): one change then a hold, but the achieved capturedAt
  // gaps are far above the negative gate's ceiling, so the series could not have seen a return.
  const styled = Array.from({ length: SAMPLES }, (_, index) => (index < 4 ? "a" : "b"))
  const { context } = app({
    styled,
    plain: STEADY_PLAIN,
    geometry: true,
    capturedAt: (_now, sample) => sample * 1000,
  })
  const result = await term(context)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    note: expect.stringContaining("capture too slow to decide blink"),
  })
})

test("equal blink samples without their live controls stay inconclusive, not Unsupported", async () => {
  const { context } = app({ styled: EQUAL, plain: STEADY_PLAIN, geometry: true })
  const result = await term(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", note: expect.stringContaining("blink period") })
  expect(result.observation?.outcome).not.toBe("unsupported")
})

test("equal blink samples achieved too slowly stay open even with every live control", async () => {
  const { context } = app({
    styled: EQUAL,
    plain: STEADY_PLAIN,
    geometry: true,
    controls: true,
    capturedAt: (_now, sample) => sample * 1000,
  })
  const result = await term(context)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    note: expect.stringContaining("capture too slow to decide blink"),
  })
})

test("a plain line that moves between samples vetoes blink: redraw, scroll or cursor motion is not blink", async () => {
  const { context } = app({ styled: ALTERNATING, plain: plainMovingAt(3), geometry: true })
  const result = await term(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", note: expect.stringContaining("plain line") })
})

test("the plain line is held across the control and every sample: a control that differs from the samples vetoes blink", async () => {
  const { context } = app({ styled: ALTERNATING, plain: plainMovingAt(0), geometry: true })
  const result = await term(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", note: expect.stringContaining("plain line") })
})

test("a producer that settles 200 ms per acquisition records requested offsets beside invocation and capture times", async () => {
  const { context } = app({
    styled: ALTERNATING,
    plain: STEADY_PLAIN,
    geometry: true,
    latencyMs: 200,
  })
  const result = await term(context)
  expect(result.observation).toMatchObject({ outcome: "supported" })
  const { timing } = JSON.parse(result.response ?? "") as {
    timing: Array<{ requestedOffsetMs: number; invokedMs: number; styledCapturedAt: number; plainCapturedAt: number }>
  }
  expect(timing.map((entry) => entry.requestedOffsetMs)).toEqual([
    0, 512, 1043, 1581, 2083, 2604, 3101, 3636, 4106, 4615, 5078, 5610, 6018, 6544, 6985, 7500,
  ])
  // One settled acquisition per sample now (#33117): the plain control is cropped from the same
  // shot, so its timestamp IS the styled sample's, not a second settled acquisition later.
  expect(timing.at(-1)!.invokedMs).toBeGreaterThanOrEqual(7500)
  for (const entry of timing) {
    expect(entry.plainCapturedAt - entry.styledCapturedAt).toBe(0)
  }
})

test("without a measured raster the control and the blink samples go to review together", async () => {
  const { context, captures } = app({ styled: [], plain: [], geometry: false })
  const result = await term(context)
  expect(captures).toHaveLength(SAMPLES + 1)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", assertionType: "screenshot" })
  expect(result.observation?.frames).toHaveLength(SAMPLES + 1)
  expect(result.tests).toMatchObject([
    { id: "capture", status: "supported" },
    { id: "review", status: "probe-todo" },
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

// The callback owns these decisions: old coverage only knew returns, settle and unqualified flat.
// Qualified fade and flat exercise existing focus/input/capture boundaries, with no production seam.
test.each([
  {
    name: "qualified fade",
    styled: Array.from({ length: SAMPLES }, (_, index) => String(index)),
    outcome: "supported",
  },
  { name: "controlled flat", styled: EQUAL, outcome: "unsupported" },
])("$name decides from same-row temporal controls", async ({ styled, outcome }) => {
  const { context, captures, keys, focusReads } = app({ styled, plain: STEADY_PLAIN, geometry: true, controls: true })
  const result = await term(context)
  expect(result.observation).toMatchObject({ outcome })
  expect(focusReads).toHaveLength(2)
  if (outcome === "unsupported") {
    expect(keys).toEqual(["a"])
    const samples = captures.filter((entry) => entry.cells?.top === 3).slice(1)
    expect(samples.at(-1)!.at - samples[0]!.at).toBeGreaterThanOrEqual(7500)
    const paint = captures.filter((entry) => entry.cells?.top === 2)
    expect(paint).toHaveLength(2)
    expect(paint[1]!.at).toBeGreaterThanOrEqual(samples.at(-1)!.at)
    const record = recordExecutedProbe({
      featureId: "sgr.blink",
      attempt: { scope: "probe", startedAt: "2026-11-07T19:00:00.000Z" },
      observation: { ...result.observation!, featureId: "sgr.blink" },
      assertions: (result.assertions ?? []).map((assertion) => ({ ...assertion, featureId: "sgr.blink" })),
      tests: result.tests,
      criterionBranch: result.criterionBranch,
    })
    expect(record.status).toBe("unsupported")
    expect(finalizeVisualResult(record, { kind: "term" }, result.observation!.frames ?? []).status).toBe("unsupported")
    const mux = finalizeVisualResult(
      record,
      { kind: "mux", outerTerminal: "ghostty" },
      result.observation!.frames ?? [],
    )
    expect(mux.status).toBe("probe-todo")
    expect(mux.reason).toContain("ghostty")
  }
})

// Each omitted control must stay pending for that reason, rather than accidentally passing another guard.
test.each([
  {
    name: "focus",
    reason: "focus read",
    change: (ctx: TermProbeSource) => {
      delete ctx.input!.focusRoundTrip
    },
  },
  {
    name: "input fixture",
    reason: "literal a",
    change: (ctx: TermProbeSource) => {
      delete ctx.readInput
    },
  },
  {
    name: "input echo",
    reason: "literal a",
    change: (ctx: TermProbeSource) => {
      ctx.readInput = async (_pattern, _timeout, inject) => {
        await inject?.()
        return null
      }
    },
  },
  {
    name: "changed focus",
    reason: "focus read",
    change: (ctx: TermProbeSource) => {
      let reads = 0
      ctx.input!.focusRoundTrip = async () => ({
        ownedWindowId: ++reads === 1 ? "owned" : "other",
        helperWindowId: "helper",
        focusedWindowIds: ["owned", "helper", "owned"],
      })
    },
  },
])("flat needs its $name control", async ({ change, reason }) => {
  const { context } = app({ styled: EQUAL, plain: STEADY_PLAIN, geometry: true, controls: true })
  change(context)
  const result = await term(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", note: expect.stringContaining(reason) })
  expect(result.tests).toContainEqual(expect.objectContaining({ status: "probe-todo" }))
})

test.each([
  {
    name: "actual span 3000 ms",
    capturedAt: (_now: number, index: number) => index * 200,
    repaint: true,
    reason: "capture too slow to decide blink",
  },
  {
    name: "key age exactly 15000 ms",
    capturedAt: (now: number) => now + 12000,
    repaint: true,
    reason: "input age under 15000",
  },
  { name: "blind repaint", capturedAt: (now: number) => now, repaint: false, reason: "Capture blind" },
])("flat stays pending with $name", async ({ capturedAt, repaint, reason }) => {
  const { context } = app({ styled: EQUAL, plain: STEADY_PLAIN, geometry: true, controls: true, capturedAt, repaint })
  const result = await term(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", note: expect.stringContaining(reason) })
})

test.each([
  {
    name: "missing focus",
    styled: Array.from({ length: SAMPLES }, (_, index) => String(index)),
    controls: false,
    plain: STEADY_PLAIN,
    outcome: "inconclusive",
  },
  {
    // Two values are no fade: one change then stillness inside the gate is a decidable negative.
    name: "two values",
    styled: Array.from({ length: SAMPLES }, (_, index) => (index < SAMPLES / 2 ? "0" : "1")),
    controls: true,
    plain: STEADY_PLAIN,
    outcome: "unsupported",
  },
  {
    name: "equal final pair",
    styled: Array.from({ length: SAMPLES }, (_, index) => String(Math.min(index, SAMPLES - 2))),
    controls: true,
    plain: STEADY_PLAIN,
    outcome: "inconclusive",
  },
  {
    name: "moving plain",
    styled: Array.from({ length: SAMPLES }, (_, index) => String(index)),
    controls: true,
    plain: plainMovingAt(4),
    outcome: "inconclusive",
  },
])(
  "fade needs qualified values, final movement, plain and focus: $name",
  async ({ styled, controls, plain, outcome }) => {
    const { context } = app({ styled, plain, geometry: true, controls })
    expect((await term(context)).observation).toMatchObject({ outcome })
  },
)

test("a 14999 ms key age remains fresh at the exact 7500 ms capture span", async () => {
  const { context } = app({
    styled: EQUAL,
    plain: STEADY_PLAIN,
    geometry: true,
    controls: true,
    capturedAt: (now) => now + 7499,
  })
  const result = await term(context)
  expect(result.observation).toMatchObject({ outcome: "unsupported", note: expect.stringContaining("14999 ms") })
  expect(result.observation?.note).toContain("measured 7500 ms")
})
