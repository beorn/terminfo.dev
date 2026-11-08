/**
 * @failure Observable extension rendering is graded from consumption, or a capture attempt is silently credited as support.
 * @level l1
 * @consumer App extension callbacks for truecolor, Sixel and iTerm2 images on an owned capture terminal.
 * @testonly none
 */
import { expect, test } from "vitest"
import { extensionsProbes } from "./extensions.ts"
import { recordExecutedProbe } from "./helpers.ts"
import { finalizeVisualResult } from "./sgr.ts"
import { createSemanticSurface } from "./testing/semantic-surface.ts"
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
    colour?: { applies?: boolean; unknownApplies?: boolean; sentinel?: boolean }
    effect?: "cursor" | "progress" | "flash"
    blind?: boolean
  } = {},
) {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  let plane = "blank"
  let glyph = ""
  let reads = 0
  let defaultColour = "initial"
  let cursorShown = true
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
      if (options.effect) {
        if (bytes.includes("\x1b[?25h")) cursorShown = true
        if (bytes.includes("\x1b[?25l")) cursorShown = false
        if (bytes.includes("\x1b[2;2HX") && !options.blind) plane = "damage"
        if (bytes.includes("\x1b[2;2H ")) plane = "blank"
      }
      if (options.colour) {
        if (bytes.includes("\x1b]7110") && options.colour.unknownApplies) defaultColour = "wrong"
        if (/\x1b\](?:4;0|10);rgb:12\/34\/56/.test(bytes) && options.colour.applies) defaultColour = "requested"
        if (bytes.includes("\x1b[3;2HXX")) plane = defaultColour
        if (bytes.includes("\x1b[38;2;18;52;86mXX")) plane = "requested"
      }
      if (/^\x1b\[1;1H.$/.test(bytes)) glyph = bytes.slice(-1)
    },
    capture: async ({
      role,
      label,
      cells,
    }: {
      role: "control" | "target"
      label: string
      cells?: { top: number; left: number; bottom: number; right: number }
    }) => {
      const frame: ObservationFrame = {
        kind: "pixels",
        role,
        label,
        capturedAt: ++reads,
        ref: `sha256:frame${reads}`,
        regionDigest:
          cells?.top === 1 && cells.left === 1
            ? `witness:${glyph}`
            : options.effect === "cursor"
              ? `cursor:${options.blind ? true : cursorShown}:${defaultColour}`
              : `plane:${plane}`,
        pixelsDigest: `window:${plane}:${glyph}`,
        ...(cells && {
          regionRectangle: {
            x: (cells.left - 1) * 8,
            y: (cells.top - 1) * 17,
            width: (cells.right - cells.left + 1) * 8,
            height: (cells.bottom - cells.top + 1) * 17,
          },
        }),
      }
      frames.push(frame)
      return frame
    },
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout" as const, raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async (sequence: string) => {
      writes.push(sequence)
      return options.colour?.sentinel !== false && options.colour
        ? {
            match: null,
            reason: "sentinel" as const,
            raw: "\x1b[?1;2c",
            rawBase64: "G1s/MTsyYw==",
            sentinel: { atMs: 1, graceMs: 1 },
          }
        : { match: null, reason: "timeout" as const, raw: "", rawBase64: "" }
    },
    queryCursorPosition: async () => (options.effect === "cursor" ? { row: 2, col: 3 } : null),
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
    expectedReason:
      "the cell did not change; this capture through outer terminal kitty cannot separate the multiplexer from its outer terminal",
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
  const finalized = finalizeVisualResult(recorded, subject, frames)
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

// CTO47c0b849: prior visual-review tests never compared same-cell pixels or qualified a negative.
function ligatureApp(
  options: {
    pair?: number
    font?: string
    bleed?: boolean
    blind?: boolean
    text?: boolean
    moved?: boolean
    lagPaint?: boolean
  } = {},
) {
  const app = captureApp(3, 80)
  const surface = createSemanticSurface({ rows: 3, cols: 80 })
  const pending: string[] = []
  app.context.captureGeometry = {
    geometry: { cellWidth: 8, cellHeight: 16, textWidth: 640, textHeight: 48 },
    source: "measured by complete raster calibration",
  }
  app.context.captureKind = options.text ? "text-cells" : "pixels"
  app.context.queryWithSentinelOutcome = async (sequence, pattern) => {
    app.writes.push(sequence)
    const raw = options.font ? "\x1b]50;" + options.font + "\x07" : ""
    return {
      match: raw.match(pattern),
      reason: raw ? "reply" : "timeout",
      raw,
      rawBase64: Buffer.from(raw).toString("base64"),
    }
  }
  app.context.write = (bytes) => {
    app.writes.push(bytes)
    if (options.lagPaint) pending.push(bytes)
    else surface.feed(bytes)
  }
  app.context.capture = async ({ role, label, cells }) => {
    const index = app.frames.length + 1
    const chars: string[] = []
    if (cells) {
      for (let row = cells.top; row <= cells.bottom; row++) {
        for (let col = cells.left; col <= cells.right; col++) {
          let glyph = surface.getCell(row - 1, col - 1).char
          // A raster crop may include neighbouring ink without any shaping engine.
          if (
            row === 3 &&
            options.bleed &&
            glyph !== " " &&
            [surface.getCell(2, col - 2).char, surface.getCell(2, col).char].some((char) => char !== " ")
          ) {
            glyph += ":neighbour-ink"
          }
          const first = options.pair
          if (row === 3 && first !== undefined && (col === first || col === first + 1)) {
            const pair = surface.getCell(2, first - 1).char + surface.getCell(2, first).char
            if (["!=", "->", "=>", "<=", "=="].includes(pair)) glyph += ":shaped"
          }
          chars.push(row === 3 && options.blind && glyph === "-" ? "!" : glyph)
        }
      }
    }
    const frame: ObservationFrame = {
      kind: "pixels",
      role,
      label,
      capturedAt: index,
      ref: "ligature-" + index,
      regionDigest: cells ? chars.join("|") : undefined,
      pixelsDigest: "whole-window-motion-" + index,
      ...(cells && {
        regionRectangle: {
          x: (cells.left - 1) * 8 + (options.moved && role === "target" ? 8 : 0),
          y: (cells.top - 1) * 16,
          width: (cells.right - cells.left + 1) * 8,
          height: (cells.bottom - cells.top + 1) * 16,
        },
      }),
    }
    app.frames.push(frame)
    for (const bytes of pending.splice(0)) surface.feed(bytes)
    return frame
  }
  return app
}

test.each([
  ["no shaped pair, moving whole frame", {}, "unsupported"],
  // A renderer may expose the preceding write for one capture, including a not-yet-painted clear.
  // Synchronous surfaces cannot catch a stale positive glyph becoming the target's blank baseline.
  ["paint lags one capture", { lagPaint: true }, "unsupported"],
  ["only first pair shapes", { pair: 3 }, "supported"],
  ["only last pair shapes, rendering font reported", { pair: 15, font: "JetBrains Mono" }, "supported"],
  ["neighbour bleed without shaping", { bleed: true }, "inconclusive"],
  ["neighbour bleed even with shaping", { bleed: true, pair: 3 }, "inconclusive"],
  ["blind positive control", { blind: true }, "inconclusive"],
  ["text cells cannot show shaping", { text: true }, "inconclusive"],
  ["target crop moved", { moved: true }, "inconclusive"],
] as const)("extensions.font-ligatures: %s", async (_name, options, outcome) => {
  const { context, frames, writes } = ligatureApp(options)
  const result = await find("extensions.font-ligatures").term!(context)
  expect(result.observation?.outcome ?? "inconclusive").toBe(outcome)
  expect(result.pass).toBe(outcome === "supported")
  if (outcome !== "inconclusive") {
    expect(JSON.parse(result.response!)).toMatchObject({ font: "font" in options ? options.font : "unreported" })
    expect(result.assertions).toHaveLength(1)
    const target = frames.filter((frame) => frame.role === "target")
    expect(target).toHaveLength(10)
    expect(target.map((frame) => frame.regionRectangle?.x)).toEqual([16, 24, 40, 48, 64, 72, 88, 96, 112, 120])
    expect(target.every((frame) => frame.regionRectangle?.width === 8 && frame.regionRectangle.height === 16)).toBe(
      true,
    )
    expect(writes.some((write) => write.includes("! = - > = > < = = ="))).toBe(false)
  }
  if (!("text" in options)) {
    expect(writes.at(-1)).toContain("\x1b[2J")
    expect(writes.some((write) => write.includes("\x1b[?25h"))).toBe(true)
  }
})

test("extensions.font-ligatures leaves missing pixel geometry unresolved", async () => {
  const app = ligatureApp()
  app.context.captureGeometry = undefined
  const result = await find("extensions.font-ligatures").term!(app.context)
  expect(result.pass).toBe(false)
  expect(result.observation?.outcome).not.toBe("unsupported")
  expect(app.frames).toEqual([])
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

// 32604: query silence cannot substitute for the same-run made-up OSC and paint controls.
// Existing image tests do not exercise the colour-reset/stack App fallback.
test.each([
  "extensions.osc104-reset-palette",
  "extensions.osc110-reset-fg",
  "extensions.osc30001-color-stack-push",
  "extensions.osc30101-color-stack-pop",
])("%s declares no setup only after controlled unchanged paint", async (id) => {
  const { context, writes } = calibratedIterm2Arm({ colour: {} })
  const result = await find(id).term!(context)
  expect(result.tests ?? []).toContainEqual(
    expect.objectContaining({ id: "declared-untestable", status: "untestable" }),
  )
  expect(result.note).toContain("no setup")
  expect(writes.some((bytes) => bytes.includes("\x1b]7110"))).toBe(true)
  const recorded = recordExecutedProbe({
    featureId: id,
    attempt: { scope: "probe", startedAt: "2026-11-07T00:00:00.000Z" },
    coverage: result.notTested && { featureId: id, ...result.notTested, rawReplyRef: id },
    assertions: [],
    tests: result.tests,
    rawReplyRef: id,
    criterionBranch: result.criterionBranch,
  })
  const subject = { kind: "mux" as const, id: "screen", outerTerminal: "kitty" }
  const finalized = finalizeVisualResult(recorded, subject, [])
  expect(finalized.status).toBe("untestable")
  expect(finalized.reason).toContain("screen")
  expect(finalized.reason).toContain("kitty")
  expect(finalizeVisualResult(recorded, { kind: "term" }, [])).toEqual(recorded)
})

test.each([
  { label: "colour setup works", colour: { applies: true }, invalid: false },
  { label: "made-up OSC changes the sample", colour: { unknownApplies: true }, invalid: true },
  { label: "query delivery control absent", colour: { sentinel: false }, invalid: false },
])("colour no-setup refuses $label", async ({ colour, invalid }) => {
  const { context } = calibratedIterm2Arm({ colour })
  const result = await find("extensions.osc110-reset-fg").term!(context)
  expect(result.tests?.some((entry) => entry.status === "untestable")).not.toBe(true)
  // A failed shared-oracle control must keep its invalid measurement status.
  if (invalid) {
    const featureId = "extensions.osc110-reset-fg"
    const recorded = recordExecutedProbe({
      featureId,
      attempt: { scope: "probe", startedAt: "2026-11-07T00:00:00.000Z" },
      observation: result.observation && { ...result.observation, featureId, rawReplyRef: featureId },
      coverage: result.notTested && { featureId, ...result.notTested, rawReplyRef: featureId },
      assertions: (result.assertions ?? []).map((entry) => ({ ...entry, featureId })),
      tests: result.tests,
      rawReplyRef: featureId,
      criterionBranch: result.criterionBranch,
    })
    expect(recorded.status).toBe("probe-invalid")
  }
})

// Whole-window effects and a visible cursor need their own sensitivity control, not CPR credit.
test.each([
  { id: "extensions.osc112-reset-cursor", effect: "cursor" as const, cause: "no setup" },
  { id: "extensions.osc9-progress", effect: "progress" as const, cause: "no setup" },
  { id: "extensions.osc555-flash", effect: "flash" as const, cause: "no way" },
])("$id qualifies its original no-change ending", async ({ id, effect, cause }) => {
  const { context } = calibratedIterm2Arm({ colour: {}, effect })
  const result = await find(id).term!(context)
  expect(result.tests ?? []).toContainEqual(
    expect.objectContaining({ id: "declared-untestable", status: "untestable" }),
  )
  expect(result.note).toContain(cause)
})

test.each([
  { id: "extensions.osc112-reset-cursor", effect: "cursor" as const },
  { id: "extensions.osc9-progress", effect: "progress" as const },
  { id: "extensions.osc555-flash", effect: "flash" as const },
])("$id cannot declare no-change with a blind capture", async ({ id, effect }) => {
  const { context } = calibratedIterm2Arm({ colour: {}, effect, blind: true })
  const result = await find(id).term!(context)
  expect(result.tests?.some((entry) => entry.status === "untestable")).not.toBe(true)
})
