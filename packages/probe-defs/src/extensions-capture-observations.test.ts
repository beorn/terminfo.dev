/**
 * @failure Observable extension rendering is graded from consumption, or a capture attempt is silently credited as support.
 * @level l1
 * @consumer App extension callbacks for truecolor, Sixel and iTerm2 images on an owned capture terminal.
 * @testonly none
 */
import { expect, test } from "vitest"
import { extensionsProbes } from "./extensions.ts"
import { recordExecutedProbe } from "./helpers.ts"
import { finalizeSgrResult } from "./sgr.ts"
import type { ObservationFrame, TermProbeSource } from "./types.ts"

function captureApp(rows: number, cols: number) {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const context: TermProbeSource = {
    kind: "live",
    rows,
    cols,
    write: (bytes) => writes.push(bytes),
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    // A real context writes the query bytes before waiting; record them so a probe's query is
    // observable here instead of vanishing into the fake.
    queryWithSentinelOutcome: async (sequence: string) => {
      writes.push(sequence)
      return { match: null, reason: "timeout", raw: "", rawBase64: "" }
    },
    queryMode: async () => null,
    capture: async ({ role, label }) => {
      const frame = {
        role,
        label,
        capturedAt: frames.length + 1,
        ref: `sha256:${String(frames.length + 1).repeat(64)}`,
      }
      frames.push(frame)
      return frame
    },
  }
  return { context, writes, frames }
}

function find(id: string) {
  const definition = extensionsProbes.find((probe) => probe.id === id)
  if (!definition?.term) throw new Error(`missing app extension callback for ${id}`)
  return definition
}

// extensions.truecolor is NOT here: its claim is cell storage, decided by the DECRQSS SGR oracle
// (extensions-qualification covers it), and a pixel comparison was never able to decide it.
// extensions.sixel and extensions.iterm2-images are NOT unasserted visual-review captures:
// both decide through the region oracle against an independent SGR-background reference and
// plain-text OSC/DCS body negative control.
const ITERM2_GEOMETRY = { cellWidth: 8, cellHeight: 17, textWidth: 8 * 80, textHeight: 17 * 24 }

function calibratedIterm2Arm(
  options: {
    target?: "red" | "blank" | "printed" | "third"
    truecolor?: boolean
    captureKind?: "pixels" | "text-cells"
  } = {},
) {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  let plane = "blank"
  let glyph = ""
  let reads = 0
  const context = {
    kind: "live" as const,
    rows: 24,
    cols: 80,
    captureKind: options.captureKind ?? ("pixels" as const),
    captureGeometry: { geometry: ITERM2_GEOMETRY, source: "measured by complete raster calibration" as const },
    write: (bytes: string) => {
      writes.push(bytes)
      if (bytes.includes("\x1b[2J")) plane = "blank"
      if (bytes.includes("\x1b]1337;File=inline=1")) plane = options.target ?? "red"
      else if (bytes.includes("1337;File=inline=1")) plane = "printed"
      if (bytes.includes("\x1b[48;2;255;0;0m") && options.truecolor !== false) plane = "red"
      if (/^\x1b\[1;1H.$/.test(bytes)) glyph = bytes.slice(-1)
    },
    capture: async ({
      role,
      label,
      cells,
    }: {
      role: "control" | "target"
      label: string
      cells?: { top: number; left: number }
    }) => {
      const frame: ObservationFrame = {
        kind: "pixels",
        role,
        label,
        capturedAt: ++reads,
        ref: `sha256:frame${reads}`,
        regionDigest: cells?.top === 1 && cells.left === 1 ? `witness:${glyph}` : `plane:${plane}`,
        pixelsDigest: `window:${plane}:${glyph}`,
      }
      frames.push(frame)
      return frame
    },
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout" as const, raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async (sequence: string) => {
      writes.push(sequence)
      return { match: null, reason: "timeout" as const, raw: "", rawBase64: "" }
    },
    queryCursorPosition: async () => null,
    queryMode: async () => null,
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
  } as unknown as TermProbeSource
  return { context, writes, frames }
}

test.each([
  {
    name: "painted inline image matches SGR reference -> Supported",
    options: { target: "red" as const },
    subject: { kind: "term" as const },
    expectedStatus: "supported",
  },
  {
    name: "bare terminal no-change -> Unsupported",
    options: { target: "blank" as const },
    subject: { kind: "term" as const },
    expectedStatus: "unsupported",
  },
  {
    name: "multiplexer no-change -> PROBE TODO naming outer terminal",
    options: { target: "blank" as const },
    subject: { kind: "mux" as const, outerTerminal: "kitty" },
    expectedStatus: "probe-todo",
    expectedReason: "An unchanged cell through outer terminal kitty cannot show which one stopped the image",
  },
  {
    name: "printed OSC body as plain text -> Unsupported even on multiplexer",
    options: { target: "printed" as const },
    subject: { kind: "mux" as const, outerTerminal: "kitty" },
    expectedStatus: "unsupported",
  },
  {
    name: "third distinct frame -> PROBE INVALID",
    options: { target: "third" as const },
    subject: { kind: "term" as const },
    expectedStatus: "probe-invalid",
  },
  {
    name: "seed equals expected (collapsed reference control) -> PROBE INVALID",
    options: { target: "red" as const, truecolor: false },
    subject: { kind: "term" as const },
    expectedStatus: "probe-invalid",
  },
])("extensions.iterm2-images controls: $name", async ({ options, subject, expectedStatus, expectedReason }) => {
  const { context, writes, frames } = calibratedIterm2Arm(options)
  const result = await find("extensions.iterm2-images").term!(context)
  expect(
    writes.some((write) => write.includes("\x1b]1337;File=inline=1;width=3;height=3;preserveAspectRatio=0:")),
  ).toBe(true)
  expect(writes.some((write) => write.includes("\x1b[48;2;255;0;0m"))).toBe(true)
  expect(
    writes.some(
      (write) =>
        !write.includes("\x1b]1337") && write.includes("1337;File=inline=1;width=3;height=3;preserveAspectRatio=0:"),
    ),
  ).toBe(true)
  const recorded = recordExecutedProbe({
    featureId: "extensions.iterm2-images",
    attempt: { scope: "probe", startedAt: "2026-11-07T00:00:00.000Z" },
    observation: result.observation
      ? { ...result.observation, featureId: "extensions.iterm2-images", rawReplyRef: "extensions.iterm2-images" }
      : undefined,
    assertions: (result.assertions ?? []).map((entry) => ({ ...entry, featureId: "extensions.iterm2-images" })),
    tests: result.tests,
    rawReplyRef: "extensions.iterm2-images",
    criterionBranch: result.criterionBranch,
  })
  const finalized = finalizeSgrResult(recorded, subject, frames)
  expect(finalized.status).toBe(expectedStatus)
  if (expectedReason) {
    expect(finalized.reason).toBe(expectedReason)
  }
})

test("extensions.iterm2-images refuses an undersized or text-cells capture terminal before any bytes", async () => {
  const { context, writes, frames } = captureApp(2, 8)
  const result = await find("extensions.iterm2-images").term!(context)
  expect(result.observation).toBeUndefined()
  expect(result.tests).toMatchObject([expect.objectContaining({ status: "probe-todo", reason: expect.any(String) })])
  expect(result.assertions).toBeUndefined()
  expect(frames).toEqual([])
  expect(writes).toEqual([])

  const textCells = calibratedIterm2Arm({ captureKind: "text-cells" })
  const textResult = await find("extensions.iterm2-images").term!(textCells.context)
  expect(textResult.observation).toBeUndefined()
  expect(textResult.tests).toMatchObject([
    expect.objectContaining({ status: "probe-todo", reason: expect.any(String) }),
  ])
  expect(textCells.writes).toEqual([])
})

test("each image target refuses missing pixel geometry before painting any payload", async () => {
  const sixel = captureApp(24, 80)
  const refused = await find("extensions.sixel").term!(sixel.context)
  expect(refused.observation).toBeUndefined()
  expect(refused.tests).toMatchObject([
    expect.objectContaining({ status: "probe-invalid", reason: expect.any(String) }),
  ])
  expect(sixel.writes.some((write) => write.includes("\x1bP0;1;0q"))).toBe(false)
  const iterm = captureApp(24, 80)
  const itermRefused = await find("extensions.iterm2-images").term!(iterm.context)
  expect(itermRefused.observation).toBeUndefined()
  expect(itermRefused.tests).toMatchObject([
    expect.objectContaining({ status: "probe-invalid", reason: expect.any(String) }),
  ])
  expect(iterm.writes.some((write) => write.includes("\x1b]1337;File=inline=1"))).toBe(false)
  // Truecolor asks the terminal for its own SGR state instead of painting two RGB runs.
  const truecolor = captureApp(24, 80)
  await find("extensions.truecolor").term!(truecolor.context)
  expect(truecolor.writes.some((write) => write.includes("\x1b[38;2;255;128;0m"))).toBe(true)
  expect(truecolor.writes.some((write) => write.includes("\x1bP$qm"))).toBe(true)
})

test("extensions.font-ligatures captures a spaced control and a contiguous operator sample", async () => {
  const { context, writes, frames } = captureApp(24, 80)
  const result = await find("extensions.font-ligatures").term!(context)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    assertionType: "screenshot",
  })
  expect(result.pass).toBe(false)
  expect(result.criterionBranch).toBe("visual-review")
  expect(result.tests).toEqual([
    { id: "capture", status: "supported", assertionRefs: [0] },
    { id: "review", status: "probe-todo", reason: expect.any(String) },
  ])
  expect(result.assertions).toEqual([
    {
      assertionType: "screenshot",
      kind: "positive",
      expected: expect.any(String),
      observed: JSON.stringify({ control: frames[0], target: frames[1] }),
    },
  ])
  expect(frames.map(({ role }) => role)).toEqual(["control", "target"])
  expect(result.observation?.frames).toHaveLength(2)
  expect(writes.some((write) => write.includes("! = - > = > < = = ="))).toBe(true)
  expect(writes.some((write) => write.includes("!= -> => <= =="))).toBe(true)
})

test("extensions.font-ligatures fits the minimum admitted three-row capture geometry", async () => {
  const { context, writes, frames } = captureApp(3, 80)
  const result = await find("extensions.font-ligatures").term!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", assertionType: "screenshot" })
  expect(frames.map(({ role }) => role)).toEqual(["control", "target"])
  expect(writes.some((write) => write.includes("!= -> => <= =="))).toBe(true)
})

test("extensions.font-ligatures names a missing capture instead of claiming a measurement", async () => {
  const { context, frames } = captureApp(24, 80)
  const noCapture = { ...context, capture: undefined }
  const result = await find("extensions.font-ligatures").term!(noCapture)
  expect(result.notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable: expect.stringContaining("capture"),
  })
  expect(result.observation).toBeUndefined()
  expect(result.assertions).toBeUndefined()
  expect(frames).toEqual([])
})

test("extensions.font-ligatures refuses an undersized capture terminal before any bytes", async () => {
  const { context, writes, frames } = captureApp(2, 8)
  const result = await find("extensions.font-ligatures").term!(context)
  expect(result.observation).toBeUndefined()
  expect(result.tests).toMatchObject([expect.objectContaining({ status: "probe-todo", reason: expect.any(String) })])
  expect(result.assertions).toBeUndefined()
  expect(frames).toEqual([])
  expect(writes).toEqual([])
})
