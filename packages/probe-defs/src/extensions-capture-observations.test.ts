/**
 * @failure Observable extension rendering is graded from consumption, or a capture attempt is silently credited as support.
 * @level l1
 * @consumer App extension callbacks for truecolor, Sixel and iTerm2 images on an owned capture terminal.
 * @testonly none
 */
import { expect, test } from "vitest"
import { createHash } from "node:crypto"
import { parseObservationFrames, parseRun } from "@terminfo/run-parser"
import { extensionsProbes, OSC9_PROGRESS_APP_NO_OBSERVER } from "./extensions.ts"
import { ScrollbackReadingUnavailable } from "./scrollback.ts"
import { DECLARED_UNTESTABLE_TEST, HEADLESS_OBSERVABLE_REVIEW, recordExecutedProbe } from "./helpers.ts"
import { finalizeVisualResult, fontLigatureMuxCoverage } from "./sgr.ts"
import { assertCalibratedCaptureGeometry } from "./calibrated-capture-geometry.ts"
import { createSemanticSurface } from "./testing/semantic-surface.ts"
import { cellRectangle } from "../../terminfo.dev/src/capture-core.ts"
import type { ObservationFrame, ProbeSuiteManifest, TermProbeSource } from "./types.ts"

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
    capture: async (request) => {
      assertCalibratedCaptureGeometry(context.captureGeometry, request)
      const { role, label } = request
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
    colour?: { applies?: boolean; unknownApplies?: boolean; sentinel?: boolean; resetRestores?: boolean }
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
        // OSC 12 colours the cursor and OSC 112 puts it back. `resetRestores: false` models a terminal that accepts the
        // reset sequence and keeps the colour -- the shape this arm must name, never call Unsupported (33102).
        if (bytes.includes("\x1b]12;rgb:12/34/56\x07") && options.colour.applies) defaultColour = "requested"
        if (bytes.includes("\x1b]112\x07") && options.colour.resetRestores !== false) defaultColour = "initial"
        if (bytes.includes("\x1b[3;2HXX")) plane = defaultColour
        if (bytes.includes("\x1b[38;5;12mXX")) plane = "requested"
      }
      if (/^\x1b\[1;1H.$/.test(bytes)) glyph = bytes.slice(-1)
    },
    capture: async (request: {
      role: "control" | "target"
      label: string
      cells?: { top: number; left: number; bottom: number; right: number }
      pixelGeometry?: { cellWidth: number; cellHeight: number; textWidth: number; textHeight: number }
    }) => {
      assertCalibratedCaptureGeometry(context.captureGeometry, request)
      const { role, label, cells } = request
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
  { id: "extensions.osc9-progress", effect: "progress" as const, cause: "no observer" },
  { id: "extensions.osc555-flash", effect: "flash" as const, cause: "no way" },
])("$id qualifies its original no-change ending", async ({ id, effect, cause }) => {
  const { context } = calibratedIterm2Arm({ colour: {}, effect })
  const result = await find(id).term!(context)
  expect(result.tests ?? []).toContainEqual(
    expect.objectContaining({ id: "declared-untestable", status: "untestable" }),
  )
  expect(result.note).toContain(cause)
})

// #33171 (@cto e1aa0710): the App arms' observer is missing, so they read "no observer" verbatim; a multiplexer arm
// shares this callback and must keep #32604's sentence plus its hop suffix. A blanket reword would miss that split.
test("OSC 9;4 says no observer on an App arm and keeps the no-setup sentence with its hop suffix on a mux arm", async () => {
  const app = calibratedIterm2Arm({ colour: {}, effect: "progress" }).context
  const appResult = await find("extensions.osc9-progress").term!(app)
  expect(appResult.note).toBe(OSC9_PROGRESS_APP_NO_OBSERVER)
  expect(appResult.tests).toContainEqual(
    expect.objectContaining({ id: "declared-untestable", status: "untestable", reason: OSC9_PROGRESS_APP_NO_OBSERVER }),
  )

  const mux = { ...calibratedIterm2Arm({ colour: {}, effect: "progress" }).context, mux: "screen" as const }
  const muxResult = await find("extensions.osc9-progress").term!(mux)
  const sentence =
    "Untestable (no setup): OSC 9;4 clear/set-50/clear left the whole window unchanged after plain paint/restore and made-up subcommand controls; no progress display was observable in this run."
  expect(muxResult.note).toBe(sentence)
  const featureId = "extensions.osc9-progress"
  const recorded = recordExecutedProbe({
    featureId,
    attempt: { scope: "probe", startedAt: "2026-11-10T00:00:00.000Z" },
    coverage: muxResult.notTested && { featureId, ...muxResult.notTested, rawReplyRef: featureId },
    assertions: [],
    tests: muxResult.tests,
    rawReplyRef: featureId,
    criterionBranch: muxResult.criterionBranch,
  })
  // The same subject shape the mux no-setup test above passes: the finalizer names the mux by its id.
  const screen = { kind: "mux" as const, id: "screen", outerTerminal: "kitty" }
  const finalized = finalizeVisualResult(recorded, screen, [])
  expect(finalized.reason).toBe(
    `${sentence}; unchanged effect could have stopped at screen or its outer terminal kitty`,
  )
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

test("extensions.osc112-reset-cursor reads the cursor cell after the reset, not only in cleanup", async () => {
  const { context, writes } = calibratedIterm2Arm({ colour: { applies: true }, effect: "cursor" })
  const result = await find("extensions.osc112-reset-cursor").term!(context)
  const coloured = writes.findIndex((bytes) => bytes.includes("\x1b]12;rgb:12/34/56\x07"))
  const reset = writes.findIndex((bytes) => bytes.includes("\x1b]112\x07"))
  expect(coloured).toBeGreaterThan(-1)
  expect(reset).toBeGreaterThan(coloured)
  expect(result.observation?.outcome).toBe("supported")
  expect(result.observation?.frames?.some((frame) => /reset after OSC 112/.test(frame.label))).toBe(true)
  // Run-parser refuses a whole run whose screenshot row cites a control frame as its primary, so the
  // decided row must name the changed cursor cell — the one target frame — not the reset control.
  const targets = result.observation?.frames?.filter((frame) => frame.role === "target") ?? []
  expect(targets).toHaveLength(1)
  expect(result.observation?.screenshotRef).toBe(targets[0]?.ref)
})

test("extensions.osc112-reset-cursor names a reset that did not restore the cursor colour", async () => {
  const { context } = calibratedIterm2Arm({ colour: { applies: true, resetRestores: false }, effect: "cursor" })
  const result = await find("extensions.osc112-reset-cursor").term!(context)
  expect(result.pass).not.toBe(true)
  expect(result.note).toContain("the frame after the reset still differs")
  expect(result.observation?.outcome).not.toBe("supported")
})

test("extensions.font-ligatures records mux declared-untestable coverage and leaves a native subject on its own path", () => {
  // D160 (#32762, @cto bf695ddc): the multiplexer only emits text cells, so ligature shaping is the
  // host terminal's observable. A mux subject emits the declared-untestable test and rolls up as
  // Untestable (not probe-todo), keeping the raw state and leaving a native subject on its own path.
  const state = { ligatureSample: "-> => ==" }
  const coverage = fontLigatureMuxCoverage({ kind: "mux" }, state)
  expect(coverage?.notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable: "ligature shaping is done by the host terminal; the multiplexer only emits text cells",
  })
  expect(coverage?.note).toBe("ligature shaping is done by the host terminal; the multiplexer only emits text cells")
  expect(coverage?.criterionBranch).toBe(HEADLESS_OBSERVABLE_REVIEW)
  expect(coverage?.tests).toEqual([
    {
      id: DECLARED_UNTESTABLE_TEST,
      status: "untestable",
      reason: "ligature shaping is done by the host terminal; the multiplexer only emits text cells",
    },
  ])
  expect(coverage?.response).toBe(JSON.stringify(state))
  expect(coverage?.observation).toBeUndefined()
  expect(coverage?.assertions).toBeUndefined()
  const recorded = recordExecutedProbe({
    featureId: "extensions.font-ligatures",
    attempt: { scope: "probe", startedAt: "2026-11-09T07:00:00.000Z" },
    coverage: {
      featureId: "extensions.font-ligatures",
      ...coverage!.notTested,
      rawReplyRef: "extensions.font-ligatures",
    },
    criterionBranch: coverage!.criterionBranch,
    tests: coverage!.tests,
    assertions: [],
    rawReplyRef: "extensions.font-ligatures",
  })
  expect(recorded.status).toBe("untestable")
  expect(recorded.tests).toEqual([
    expect.objectContaining({
      id: DECLARED_UNTESTABLE_TEST,
      status: "untestable",
      reason: "ligature shaping is done by the host terminal; the multiplexer only emits text cells",
    }),
  ])
  expect(fontLigatureMuxCoverage({ kind: "term" }, state)).toBeUndefined()
})

test.each([
  {
    name: "supported",
    behavior: "scrolls-and-restores" as const,
    expectedStatus: "supported" as const,
    expectedOutcome: "supported" as const,
    expectedAssertions: 1,
    expectedFrames: 5,
    expectedReason: /wheel\+capture route: frame after OSC 720 differed from bottom and wheel-down returned to bottom/,
  },
  {
    name: "unsupported",
    behavior: "ignores-osc720" as const,
    expectedStatus: "unsupported" as const,
    expectedOutcome: "unsupported" as const,
    expectedAssertions: 1,
    expectedFrames: 4,
    expectedReason: /wheel\+capture route: frame after OSC 720 equals bottom with wheel controls held/,
  },
  {
    name: "inconclusive-changed-not-restored",
    behavior: "osc720-sticks" as const,
    expectedStatus: "probe-todo" as const,
    expectedOutcome: "inconclusive" as const,
    expectedAssertions: 0,
    expectedFrames: 5,
    expectedReason:
      /wheel\+capture route: frame after OSC 720 changed from bottom, but wheel-down did not restore the bottom frame/,
  },
  {
    name: "inconclusive-wheel-up-control-failed",
    behavior: "wheel-up-noop" as const,
    expectedStatus: "probe-todo" as const,
    expectedOutcome: "inconclusive" as const,
    expectedAssertions: 0,
    expectedFrames: 2,
    expectedReason: /wheel\+capture route: wheel-up control did not change the captured frame/,
  },
  {
    name: "inconclusive-wheel-down-control-failed",
    behavior: "wheel-down-noop" as const,
    expectedStatus: "probe-todo" as const,
    expectedOutcome: "inconclusive" as const,
    expectedAssertions: 0,
    expectedFrames: 3,
    expectedReason: /wheel\+capture route: wheel-down control did not return to the bottom frame/,
  },
])(
  "extensions.osc720-scroll-up wheel+capture round-trips through parseRun for $name",
  async ({ name, behavior, expectedStatus, expectedOutcome, expectedAssertions, expectedFrames, expectedReason }) => {
    const featureId = "extensions.osc720-scroll-up"
    const definition = find(featureId)
    const writes: string[] = []
    const frames: ObservationFrame[] = []
    let offset = 0
    let afterOsc720 = false
    const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`
    const context: TermProbeSource = {
      kind: "live",
      rows: 24,
      cols: 80,
      captureKind: "pixels",
      // Even when an App scrollback reader exists without viewportOffset (e.g. Kitty/WezTerm),
      // route 2 (wheel+capture) runs instead of stopping at not-tested.
      getScrollback: async () => ({ totalLines: 50, screenLines: 24 }),
      write: (bytes) => {
        writes.push(bytes)
        if (bytes.includes("\x1b]720\x07")) {
          afterOsc720 = true
          if (behavior === "scrolls-and-restores" || behavior === "osc720-sticks") {
            offset = 1
          }
        }
      },
      queryCursorPosition: async () => ({ row: 24, col: 40 }),
      measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
      query: async () => null,
      queryWithSentinel: async () => null,
      queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
      queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
      queryMode: async () => null,
      readInput: async (pattern, _timeoutMs, inject) => {
        await inject?.()
        return pattern.test("a") ? ["a"] : null
      },
      input: {
        injectKey: async () => {},
        injectClick: async (button) => {
          if (button === 4) {
            if (behavior !== "wheel-up-noop") offset = 1
          } else if (button === 5) {
            if (behavior === "wheel-down-noop") return
            if (behavior === "osc720-sticks" && afterOsc720) return
            offset = 0
          }
        },
      },
      capture: async ({ role, label }) => {
        const plane = offset > 0 ? "history-plane" : "bottom-plane"
        const frame: ObservationFrame = {
          kind: "pixels",
          role,
          label,
          capturedAt: frames.length + 1,
          ref: digest(`frame-${frames.length + 1}-${plane}`),
          pixelsDigest: digest(`pixels-${plane}`),
        }
        frames.push(frame)
        return frame
      },
    }
    const result = await definition.term!(context)
    expect(result.observation?.outcome).toBe(expectedOutcome)
    expect(result.observation?.assertionType).toBe("screenshot")
    expect(result.observation?.frames).toHaveLength(expectedFrames)
    const assertions = (result.assertions ?? []).map((entry) => ({
      ...entry,
      featureId,
      rawReplyRef: featureId,
    }))
    expect(assertions).toHaveLength(expectedAssertions)
    const recorded = recordExecutedProbe({
      featureId,
      attempt: { scope: "probe", startedAt: "2026-11-09T10:00:00.000Z" },
      rawReplyRef: featureId,
      observation: result.observation ? { ...result.observation, featureId, rawReplyRef: featureId } : undefined,
      assertions,
      tests: result.tests,
    })
    expect(recorded.status).toBe(expectedStatus)
    expect(recorded.reason).toMatch(expectedReason)
    const suite = "b".repeat(64)
    const manifest: ProbeSuiteManifest = {
      schemaVersion: 4,
      probeHash: suite,
      adapterVersion: "3.3.1",
      generatedAt: "2026-11-09T10:00:00.000Z",
      catalogIds: [featureId],
      probes: { term: [featureId], lib: [], mux: [] },
    }
    const run = {
      schemaVersion: 4,
      source: { kind: "live" },
      runId: `osc720-${name}`,
      suiteId: suite,
      probeHash: suite,
      sourceRevision: "4".repeat(40),
      intendedSubject: { kind: "term", id: "kitty" },
      subject: {
        kind: "term",
        id: "kitty",
        version: "0.49.2",
        os: "linux",
        osVersion: null,
        outerTerminal: null,
        mux: null,
        config: null,
        permissions: null,
      },
      identity: "unverified",
      measuredAt: "2026-11-09T10:01:00.000Z",
      origin: { kind: "collector" },
      sealedAt: "2026-11-09T10:02:00.000Z",
      rawReplies: {
        [featureId]: JSON.stringify({ writes, queries: [{ query: "\x1b[6n", raw: "\x1b[24;40R" }], events: [] }),
        ...(result.response ? { [`${featureId}.callbackResponse`]: result.response } : {}),
      },
      assertions,
      screenshotRefs: [...new Set((recorded.frames ?? []).map((frame) => frame.ref))],
      results: [recorded],
    }
    const parsed = parseRun(`osc720-${name}.json`, JSON.stringify(run), [featureId], new Map([[suite, manifest]]))
    expect(parsed.results?.[0]?.status).toBe(expectedStatus)
    expect(parsed.results?.[0]?.reason).toMatch(expectedReason)
    expect(parsed.results?.[0]?.frames).toHaveLength(expectedFrames)
    expect(
      parseObservationFrames(
        parsed.results?.[0]?.frames,
        `osc720-${name}.json`,
        featureId,
        parsed.screenshotRefs,
        parsed.textSnapshotRefs,
        parsed.results?.[0]?.screenshotRef,
        parsed.results?.[0]?.assertionType,
      ),
    ).toHaveLength(expectedFrames)
    expect(parsed.assertions).toHaveLength(expectedAssertions)
  },
)

test("extensions.osc720-scroll-up excludes tmux and screen so their cells keep today's result", async () => {
  const definition = find("extensions.osc720-scroll-up")
  const tmuxApp = captureApp(24, 80)
  tmuxApp.context.mux = "tmux"
  tmuxApp.context.getScrollback = async () => ({ totalLines: 44, screenLines: 24, viewportOffset: 20 })
  tmuxApp.context.queryCursorPosition = async () => ({ row: 1, col: 1 })
  const tmuxResult = await definition.term!(tmuxApp.context)
  expect(tmuxResult.observation).toBeUndefined()
  expect(tmuxResult.tests).toEqual([
    { id: "criterion", status: "probe-todo", reason: "Cursor answered; scrollback viewport was not measured" },
  ])

  const screenApp = captureApp(24, 80)
  screenApp.context.mux = "screen"
  screenApp.context.getScrollback = async () => ({ totalLines: 44, screenLines: 24 })
  const screenResult = await definition.term!(screenApp.context)
  expect(screenResult.notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable: "terminal reports no viewport offset",
  })
})

test("OSC 720 retains unavailable history as unmeasured while unexpected reader errors still fail", async () => {
  const featureId = "extensions.osc720-scroll-up"
  const definition = find(featureId)
  // Hosted Terminal.app run 355f60ec: the owned reader refused before its marker control.
  const reason =
    "Terminal.app history holds a line of 310 characters on a 120-column grid, so it wrapped and its lines are not rows"
  for (const mux of [undefined, "tmux", "screen"] as const) {
    const { context } = captureApp(30, 120)
    if (mux !== undefined) context.mux = mux
    context.getScrollback = async () => {
      throw new ScrollbackReadingUnavailable(reason)
    }
    const result = await definition.term!(context)
    expect(result.notTested?.noObservable).toContain(reason)
    expect(
      recordExecutedProbe({
        featureId,
        attempt: { scope: "probe", startedAt: "2026-11-11T01:33:28.453Z" },
        assertions: [],
        coverage: result.notTested && { featureId, ...result.notTested, rawReplyRef: featureId },
      }).status,
    ).toBe("probe-todo")
  }

  const { context } = captureApp(30, 120)
  const unexpected = new Error("owned history transport failed")
  context.getScrollback = async () => {
    throw unexpected
  }
  await expect(definition.term!(context)).rejects.toBe(unexpected)
})

test.each([
  {
    name: "supported-in-place-reflow",
    growBehavior: "reflowed" as const,
    shrinkBehavior: "reflowed" as const,
    expectedStatus: "supported" as const,
    expectedOutcome: "supported" as const,
    expectedAssertions: 1,
    expectedFrames: 12,
    expectedReason:
      /main-screen reflow measured across shrink \(reflowed\) and grow \(reflowed\); retained history unmeasured/,
  },
  {
    name: "supported-in-place-reflow-via-cpr-clamp",
    growBehavior: "reflowed" as const,
    shrinkBehavior: "reflowed" as const,
    disableCsi18t: true,
    expectedStatus: "supported" as const,
    expectedOutcome: "supported" as const,
    expectedAssertions: 1,
    expectedFrames: 12,
    expectedReason:
      /main-screen reflow measured across shrink \(reflowed\) and grow \(reflowed\); retained history unmeasured; wide characters, alternate screen and cursor on a wrapped line unmeasured/,
  },
  {
    name: "supported-reflowed-history-on-shrink",
    growBehavior: "reflowed" as const,
    shrinkBehavior: "reflowed-history" as const,
    expectedStatus: "supported" as const,
    expectedOutcome: "supported" as const,
    expectedAssertions: 1,
    expectedFrames: 12,
    expectedReason:
      /main-screen reflow measured across shrink \(reflowed-history\) and grow \(reflowed\); retained history unmeasured/,
  },
  {
    name: "unsupported-preserved-grow-clipped-shrink",
    growBehavior: "preserved" as const,
    shrinkBehavior: "clipped" as const,
    expectedStatus: "unsupported" as const,
    expectedOutcome: "unsupported" as const,
    expectedAssertions: 1,
    expectedFrames: 12,
    expectedReason:
      /main-screen did not reflow across shrink \(clipped\) and grow \(preserved\); retained history unmeasured/,
  },
  {
    name: "unsupported-dropped-continuation-on-grow",
    growBehavior: "dropped-continuation" as const,
    shrinkBehavior: "reflowed" as const,
    expectedStatus: "unsupported" as const,
    expectedOutcome: "unsupported" as const,
    expectedAssertions: 1,
    expectedFrames: 12,
    expectedReason:
      /main-screen did not reflow across shrink \(reflowed\) and grow \(clipped\); retained history unmeasured/,
  },
  {
    name: "probe-todo-ambiguous-layout",
    growBehavior: "reflowed" as const,
    shrinkBehavior: "unknown" as const,
    expectedStatus: "probe-todo" as const,
    expectedOutcome: undefined,
    expectedAssertions: 0,
    expectedFrames: 0,
    expectedReason:
      /Main-screen reflow captures did not uniquely match a candidate reference layout; retained history unmeasured/,
  },
  {
    name: "probe-todo-unstable-settle",
    growBehavior: "unstable" as const,
    shrinkBehavior: "reflowed" as const,
    expectedStatus: "probe-todo" as const,
    expectedOutcome: undefined,
    expectedAssertions: 0,
    expectedFrames: 0,
    expectedReason: /Main-grow post-resize captures did not stabilize; retained history unmeasured/,
  },
  {
    name: "probe-todo-unanswered-ref-fence",
    growBehavior: "reflowed" as const,
    shrinkBehavior: "reflowed" as const,
    dropRefFence: true,
    expectedStatus: "probe-todo" as const,
    expectedOutcome: undefined,
    expectedAssertions: 0,
    expectedFrames: 0,
    expectedReason: /No cursor-position reply after painting main-grow ref reflowed; retained history unmeasured/,
  },
  {
    name: "probe-invalid-unanswered-ref-fence-and-restore-failed",
    growBehavior: "reflowed" as const,
    shrinkBehavior: "reflowed" as const,
    dropRefFence: true,
    failRestore: true,
    expectedStatus: "probe-invalid" as const,
    expectedOutcome: undefined,
    expectedAssertions: 0,
    expectedFrames: 0,
    expectedReason: /Reflow probe could not restore original terminal size/,
  },
  {
    name: "probe-invalid-restore-failed",
    growBehavior: "reflowed" as const,
    shrinkBehavior: "reflowed" as const,
    failRestore: true,
    expectedStatus: "probe-invalid" as const,
    expectedOutcome: undefined,
    expectedAssertions: 0,
    expectedFrames: 0,
    expectedReason: /Reflow probe could not restore original terminal size/,
  },
  {
    name: "refuses-shrunken-cropped-capture-geometry",
    growBehavior: "reflowed" as const,
    shrinkBehavior: "reflowed" as const,
    shrunkenCaptureGeometry: true,
    expectedStatus: "probe-invalid" as const,
    expectedOutcome: undefined,
    expectedAssertions: 0,
    expectedFrames: 0,
    expectedReason: /Linux capture calibration refused: terminal pixel geometry changed after origin calibration/,
  },
])(
  "extensions.reflow App resize+capture round-trips through parseRun for $name",
  async ({
    name,
    growBehavior,
    shrinkBehavior,
    disableCsi18t,
    dropRefFence,
    failRestore,
    shrunkenCaptureGeometry,
    expectedStatus,
    expectedOutcome,
    expectedAssertions,
    expectedFrames,
    expectedReason,
  }) => {
    const featureId = "extensions.reflow"
    const definition = find(featureId)
    const writes: string[] = []
    const frames: ObservationFrame[] = []
    const resizeCalls: { width: number; height: number }[] = []
    const rows = 10
    const wideCols = 24
    const narrowCols = 16
    let currentCols = wideCols
    let screenPlane = "blank"
    let gridLines: string[] = Array.from({ length: rows }, () => "")
    let phaseState: "init" | "pre-shrunk" | "grown" | "shrunk" = "init"
    let settleCaptures = 0
    const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`
    const realSetTimeout = globalThis.setTimeout
    const realDateNow = Date.now
    let fakeNow = realDateNow()
    const timeoutDelays: number[] = []
    Date.now = () => fakeNow
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const delay = ms ?? 0
      timeoutDelays.push(delay)
      fakeNow += delay
      fn()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    try {
      const growRow1Full = "G1-alpha".padEnd(narrowCols, "x")
      const growRow2 = "G2-Z"
      const growSoft = growRow1Full + growRow2
      const shrinkRow1Full = "S1-alpha".padEnd(narrowCols, "y")
      const shrinkRow2 = "S2-Z"
      const paintPayload = (payload: string, autowrap: boolean) => {
        const next: string[] = []
        const logicalLines = payload.replace(/\r\n$/, "").split("\r\n")
        for (const logical of logicalLines) {
          if (!autowrap || logical.length <= currentCols) {
            next.push(logical.slice(0, currentCols))
          } else {
            for (let offset = 0; offset < logical.length; offset += currentCols) {
              next.push(logical.slice(offset, offset + currentCols))
            }
          }
        }
        gridLines = Array.from({ length: rows }, (_, idx) => next[idx] ?? "")
      }
      const context: TermProbeSource = {
        kind: "live",
        rows,
        cols: wideCols,
        captureKind: "pixels",
        captureGeometry: {
          geometry: {
            cellWidth: 10,
            cellHeight: 20,
            textWidth: wideCols * 10,
            textHeight: rows * 20,
          },
          source: "measured by complete raster calibration",
        },
        write: (bytes) => {
          writes.push(bytes)
          if (bytes.includes("G1-alpha") && bytes.includes(growRow2) && currentCols === narrowCols) {
            screenPlane = "seed-grow"
            paintPayload(`${growSoft}\r\nHARD-a\r\nHARD-b\r\n`, true)
          } else if (bytes.includes("S1-alpha") && bytes.includes(shrinkRow2) && currentCols === wideCols) {
            screenPlane = "seed-shrink"
            paintPayload(`${shrinkRow1Full}${shrinkRow2}\r\nHARD-a\r\nHARD-b\r\n`, true)
          } else if (
            bytes.startsWith("\x1b[?7h\x1b[0m\x1b[2J\x1b[3J\x1b[H") ||
            bytes.startsWith("\x1b[?7l\x1b[0m\x1b[2J\x1b[3J\x1b[H") ||
            bytes.startsWith("\x1b[?7h\x1b[0m\x1b[2J\x1b[H") ||
            bytes.startsWith("\x1b[?7l\x1b[0m\x1b[2J\x1b[H")
          ) {
            const autowrap = bytes.startsWith("\x1b[?7h")
            const body = bytes
              .replace(/^\x1b\[\?7[hl]\x1b\[0m\x1b\[2J(?:\x1b\[3J)?\x1b\[H/, "")
              .replace(/\x1b\[\?7h$/, "")
            screenPlane = "ref-paint"
            paintPayload(body, autowrap)
          }
        },
        queryCursorPosition: async () => {
          if (dropRefFence && screenPlane === "ref-paint") return null
          if (screenPlane === "seed-grow" && currentCols === narrowCols) return { row: 5, col: 1 }
          if (screenPlane === "seed-shrink" && currentCols === wideCols) return { row: 4, col: 1 }
          return { row: rows, col: currentCols }
        },
        measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
        query: async () => null,
        queryWithSentinel: async () => null,
        queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
        queryWithSentinelOutcome: async (sequence) => {
          writes.push(sequence)
          if (sequence === "\x1b[18t" && !disableCsi18t) {
            const raw = `\x1b[8;${rows};${currentCols}t`
            return {
              match: /\x1b\[8;(\d+);(\d+)t/.exec(raw),
              reason: "reply",
              raw,
              rawBase64: Buffer.from(raw).toString("base64"),
            }
          }
          return { match: null, reason: "timeout", raw: "", rawBase64: "" }
        },
        queryMode: async () => null,
        input: {
          injectKey: async () => {},
          injectClick: async () => {},
          resizeWindow: async (width, height) => {
            resizeCalls.push({ width, height })
            if (width < wideCols * 10) {
              currentCols = narrowCols
              if (phaseState === "init") {
                phaseState = "pre-shrunk"
              } else {
                phaseState = "shrunk"
                screenPlane = `shrink:${shrinkBehavior}`
                if (shrinkBehavior === "reflowed") {
                  gridLines = [shrinkRow1Full, shrinkRow2, "HARD-a", "HARD-b", ""]
                } else if (shrinkBehavior === "reflowed-history") {
                  gridLines = [shrinkRow2, "HARD-a", "HARD-b", "", ""]
                } else if (shrinkBehavior === "clipped") {
                  gridLines = [shrinkRow1Full, "HARD-a", "HARD-b", "", ""]
                } else {
                  gridLines = ["UNKNOWN", "", "", "", ""]
                }
              }
            } else {
              if (failRestore && (phaseState === "shrunk" || (dropRefFence && phaseState === "grown"))) {
                currentCols = narrowCols
              } else {
                currentCols = wideCols
              }
              if (phaseState === "pre-shrunk") {
                phaseState = "grown"
                screenPlane = `grow:${growBehavior}`
                settleCaptures = 0
                if (growBehavior === "reflowed") {
                  gridLines = [growSoft, "HARD-a", "HARD-b", "", ""]
                } else if (growBehavior === "preserved") {
                  gridLines = [growRow1Full, growRow2, "HARD-a", "HARD-b", ""]
                } else if (growBehavior === "dropped-continuation") {
                  gridLines = [growRow1Full, "HARD-a", "HARD-b", "", ""]
                }
              }
            }
            return { width: wideCols * 10, height: rows * 20 }
          },
        },
        capture: async (rawRequest) => {
          const request =
            shrunkenCaptureGeometry && rawRequest.cells && rawRequest.pixelGeometry
              ? {
                  ...rawRequest,
                  pixelGeometry: {
                    ...rawRequest.pixelGeometry,
                    textWidth: rawRequest.cells.right * rawRequest.pixelGeometry.cellWidth,
                    textHeight: rawRequest.cells.bottom * rawRequest.pixelGeometry.cellHeight,
                  },
                }
              : rawRequest
          assertCalibratedCaptureGeometry(context.captureGeometry, request)
          const { role, label, cells } = request
          const cropTop = cells?.top ?? 1
          const cropLeft = cells?.left ?? 1
          const cropBottom = cells?.bottom ?? rows
          const cropRight = cells?.right ?? currentCols
          const croppedRows: string[] = []
          for (let r = cropTop - 1; r < cropBottom; r++) {
            const line = (gridLines[r] ?? "").padEnd(cropRight, " ")
            croppedRows.push(line.slice(cropLeft - 1, cropRight))
          }
          let regionKey = croppedRows.join("\n")
          if (screenPlane === "grow:unstable") {
            settleCaptures++
            regionKey = `grow:unstable-${settleCaptures}`
          }
          const frame: ObservationFrame = {
            kind: "pixels",
            role,
            label,
            capturedAt: frames.length + 1,
            ref: digest(`frame-${frames.length + 1}-${regionKey}`),
            sourceRef: digest(`source-${frames.length + 1}`),
            regionDigest: digest(`cells-${regionKey}`),
            pixelsDigest: digest(`pixels-${regionKey}`),
          }
          frames.push(frame)
          return frame
        },
      }
      if (shrunkenCaptureGeometry) {
        await expect(definition.term!(context)).rejects.toMatchObject({
          name: "UndeclaredTerminalGeometry",
          message: "Linux capture calibration refused: terminal pixel geometry changed after origin calibration",
        })
        expect(frames).toHaveLength(0)
        expect(resizeCalls.at(-1)).toEqual({ width: wideCols * 10, height: rows * 20 })
        expect(currentCols).toBe(wideCols)
        return
      }
      const result = await definition.term!(context)
      expect(resizeCalls[0]?.width).toBeLessThan(wideCols * 10)
      const clearAndPaintWrites = writes.filter((entry) => entry.includes("\x1b[2J") && !entry.startsWith("\x1b[18t"))
      expect(clearAndPaintWrites.length).toBeGreaterThan(0)
      for (const entry of clearAndPaintWrites) {
        expect(entry).toContain("\x1b[2J\x1b[3J\x1b[H")
      }
      if (dropRefFence) {
        expect(frames).toHaveLength(3)
        expect(resizeCalls).toHaveLength(3)
      } else if (growBehavior === "unstable") {
        expect(frames).toHaveLength(2)
        expect(resizeCalls).toHaveLength(3)
      } else {
        expect(frames).toHaveLength(12)
        expect(resizeCalls).toHaveLength(4)
        expect(timeoutDelays.filter((ms) => ms >= 1000)).toHaveLength(2)
      }
      expect(result.observation?.outcome).toBe(expectedOutcome)
      expect(result.observation?.frames ?? []).toHaveLength(expectedFrames)
      const assertions = (result.assertions ?? []).map((entry) => ({
        ...entry,
        featureId,
        rawReplyRef: featureId,
      }))
      expect(assertions).toHaveLength(expectedAssertions)
      const recorded = recordExecutedProbe({
        featureId,
        attempt: { scope: "probe", startedAt: "2026-11-09T10:00:00.000Z" },
        rawReplyRef: featureId,
        observation: result.observation ? { ...result.observation, featureId, rawReplyRef: featureId } : undefined,
        assertions,
        tests: result.tests,
      })
      expect(recorded.status).toBe(expectedStatus)
      expect(recorded.reason).toMatch(expectedReason)
      const suite = "b".repeat(64)
      const manifest: ProbeSuiteManifest = {
        schemaVersion: 4,
        probeHash: suite,
        adapterVersion: "3.3.1",
        generatedAt: "2026-11-09T10:00:00.000Z",
        catalogIds: [featureId],
        probes: { term: [featureId], lib: [], mux: [] },
      }
      const run = {
        schemaVersion: 4,
        source: { kind: "live" },
        runId: `reflow-${name}`,
        suiteId: suite,
        probeHash: suite,
        sourceRevision: "4".repeat(40),
        intendedSubject: { kind: "term", id: "kitty" },
        subject: {
          kind: "term",
          id: "kitty",
          version: "0.49.2",
          os: "linux",
          osVersion: null,
          outerTerminal: null,
          mux: null,
          config: null,
          permissions: null,
        },
        identity: "unverified",
        measuredAt: "2026-11-09T10:01:00.000Z",
        origin: { kind: "collector" },
        sealedAt: "2026-11-09T10:02:00.000Z",
        rawReplies: {
          [featureId]: JSON.stringify({
            writes,
            queries: [{ query: "\x1b[18t", raw: `\x1b[8;${rows};${wideCols}t` }],
            events: [],
          }),
          ...(result.response ? { [`${featureId}.callbackResponse`]: result.response } : {}),
        },
        assertions,
        screenshotRefs: [...new Set((recorded.frames ?? []).flatMap((frame) => [frame.ref, frame.sourceRef ?? []]))],
        results: [recorded],
      }
      const parsed = parseRun(`reflow-${name}.json`, JSON.stringify(run), [featureId], new Map([[suite, manifest]]))
      expect(parsed.results?.[0]?.status).toBe(expectedStatus)
      expect(parsed.results?.[0]?.reason).toMatch(expectedReason)
      expect(parsed.results?.[0]?.frames ?? []).toHaveLength(expectedFrames)
      if (expectedFrames > 0) {
        expect(
          parseObservationFrames(
            parsed.results?.[0]?.frames,
            `reflow-${name}.json`,
            featureId,
            parsed.screenshotRefs,
            parsed.textSnapshotRefs,
            parsed.results?.[0]?.screenshotRef,
            parsed.results?.[0]?.assertionType,
          ),
        ).toHaveLength(expectedFrames)
      }
      expect(parsed.assertions).toHaveLength(expectedAssertions)
    } finally {
      globalThis.setTimeout = realSetTimeout
      Date.now = realDateNow
    }
  },
)

test.each(["tmux", "screen"] as const)(
  "extensions.reflow keeps %s as PROBE TODO on the terminal-app arm",
  async (mux) => {
    const app = captureApp(24, 80)
    app.context.mux = mux
    const result = await find("extensions.reflow").term!(app.context)
    expect(result).toEqual({
      pass: false,
      note: "tmux and GNU Screen remain PROBE TODO on this arm",
      tests: [{ id: "criterion", status: "probe-todo", reason: "tmux and GNU Screen remain PROBE TODO on this arm" }],
    })
    expect(app.writes).toEqual([])
  },
)

test("extensions.reflow sizes narrow window from original 800px window width so capture-core cellRectangle fits 793px inset grid (#32797)", async () => {
  const featureId = "extensions.reflow"
  const definition = find(featureId)
  const rows = 20
  const wideCols = 61
  const cellWidth = 13
  const cellHeight = 29
  const textOrigin = { x: 3, y: 10 }
  const pixelGeometry = {
    cellWidth,
    cellHeight,
    textWidth: wideCols * cellWidth, // 793px inside 800px window (7px spare centered at x=3)
    textHeight: rows * cellHeight, // 580px inside 600px window (20px spare centered at y=10)
  }
  let liveWindow = { width: 800, height: 600 }
  let currentCols = wideCols
  let currentRows = rows
  let screenPlane = "blank"
  let gridLines: string[] = Array.from({ length: rows }, () => "")
  let phaseState: "init" | "pre-shrunk" | "grown" | "shrunk" = "init"
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const resizeCalls: { width: number; height: number }[] = []
  const capturedRectangles: { label: string; width: number; height: number; x: number; y: number }[] = []
  const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`
  const realSetTimeout = globalThis.setTimeout
  const realDateNow = Date.now
  let fakeNow = realDateNow()
  Date.now = () => fakeNow
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    fakeNow += ms ?? 0
    fn()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout
  try {
    const narrowCols = 40
    const growRow1Full = "G1-alpha".padEnd(narrowCols, "x")
    const growRow2 = "G2-Z"
    const growSoft = growRow1Full + growRow2
    const shrinkRow1Full = "S1-alpha".padEnd(narrowCols, "y")
    const shrinkRow2 = "S2-Z"
    const paintPayload = (payload: string, autowrap: boolean) => {
      const next: string[] = []
      for (const logical of payload.replace(/\r\n$/, "").split("\r\n")) {
        if (!autowrap || logical.length <= currentCols) {
          next.push(logical.slice(0, currentCols))
        } else {
          for (let offset = 0; offset < logical.length; offset += currentCols) {
            next.push(logical.slice(offset, offset + currentCols))
          }
        }
      }
      gridLines = Array.from({ length: currentRows }, (_, idx) => next[idx] ?? "")
    }
    const context: TermProbeSource = {
      kind: "live",
      rows,
      cols: wideCols,
      captureKind: "pixels",
      captureGeometry: {
        geometry: pixelGeometry,
        source: "measured by complete raster calibration",
      },
      write: (bytes) => {
        writes.push(bytes)
        if (bytes.includes("G1-alpha") && bytes.includes(growRow2) && currentCols === narrowCols) {
          screenPlane = "seed-grow"
          paintPayload(`${growSoft}\r\nHARD-a\r\nHARD-b\r\n`, true)
        } else if (bytes.includes("S1-alpha") && bytes.includes(shrinkRow2) && currentCols === wideCols) {
          screenPlane = "seed-shrink"
          paintPayload(`${shrinkRow1Full}${shrinkRow2}\r\nHARD-a\r\nHARD-b\r\n`, true)
        } else if (bytes.startsWith("\x1b[?7h\x1b[0m\x1b[2J") || bytes.startsWith("\x1b[?7l\x1b[0m\x1b[2J")) {
          const autowrap = bytes.startsWith("\x1b[?7h")
          const body = bytes
            .replace(/^\x1b\[\?7[hl]\x1b\[0m\x1b\[2J(?:\x1b\[3J)?\x1b\[H/, "")
            .replace(/\x1b\[\?7h$/, "")
          screenPlane = "ref-paint"
          paintPayload(body, autowrap)
        }
      },
      queryCursorPosition: async () => {
        if (screenPlane === "seed-grow" && currentCols === narrowCols) return { row: 5, col: 1 }
        if (screenPlane === "seed-shrink" && currentCols === wideCols) return { row: 4, col: 1 }
        return { row: currentRows, col: currentCols }
      },
      measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
      query: async () => null,
      queryWithSentinel: async () => null,
      queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
      queryWithSentinelOutcome: async (sequence) => {
        writes.push(sequence)
        if (sequence === "\x1b[18t") {
          const raw = `\x1b[8;${currentRows};${currentCols}t`
          return {
            match: /\x1b\[8;(\d+);(\d+)t/.exec(raw),
            reason: "reply",
            raw,
            rawBase64: Buffer.from(raw).toString("base64"),
          }
        }
        return { match: null, reason: "timeout", raw: "", rawBase64: "" }
      },
      queryMode: async () => null,
      input: {
        injectKey: async () => {},
        injectClick: async () => {},
        resizeWindow: async (width, height) => {
          const previous = { ...liveWindow }
          resizeCalls.push({ width, height })
          liveWindow = { width, height }
          currentCols = Math.floor(width / cellWidth)
          currentRows = Math.floor(height / cellHeight)
          if (currentCols === narrowCols) {
            if (phaseState === "init" || phaseState === "pre-shrunk") {
              phaseState = "pre-shrunk"
            } else {
              phaseState = "shrunk"
              gridLines = [shrinkRow1Full, shrinkRow2, "HARD-a", "HARD-b", ""]
            }
          } else if (currentCols === wideCols && phaseState === "pre-shrunk") {
            phaseState = "grown"
            gridLines = [growSoft, "HARD-a", "HARD-b", "", ""]
          }
          return previous
        },
      },
      capture: async (request) => {
        assertCalibratedCaptureGeometry(context.captureGeometry, request)
        if (!request.cells || !request.pixelGeometry) {
          throw new Error("Reflow capture must carry cells and calibrated pixelGeometry")
        }
        // Call the real capture-core cellRectangle against the simulated live X11 window.
        const rectangle = cellRectangle({
          cells: request.cells,
          pixelGeometry: request.pixelGeometry,
          textOrigin,
          windowWidth: liveWindow.width,
          windowHeight: liveWindow.height,
        })
        capturedRectangles.push({ label: request.label, ...rectangle })
        const croppedRows: string[] = []
        for (let r = request.cells.top - 1; r < request.cells.bottom; r++) {
          const line = (gridLines[r] ?? "").padEnd(request.cells.right, " ")
          croppedRows.push(line.slice(request.cells.left - 1, request.cells.right))
        }
        const regionKey = croppedRows.join("\n")
        const frame: ObservationFrame = {
          kind: "pixels",
          role: request.role,
          label: request.label,
          capturedAt: frames.length + 1,
          ref: digest(`kitty-frame-${frames.length + 1}-${regionKey}`),
          sourceRef: digest(`kitty-source-${frames.length + 1}`),
          regionDigest: digest(`kitty-cells-${regionKey}`),
          pixelsDigest: digest(`kitty-pixels-${regionKey}`),
          regionRectangle: rectangle,
        }
        frames.push(frame)
        return frame
      },
    }

    const result = await definition.term!(context)
    expect(result.pass).toBe(true)
    expect(resizeCalls).toEqual([
      { width: 520, height: 580 },
      { width: 527, height: 600 },
      { width: 800, height: 600 },
      { width: 527, height: 600 },
      { width: 800, height: 600 },
    ])
    const parsedResponse = JSON.parse(result.response!) as {
      provisionalNarrowWidthPx: number
      narrowWidthPx: number
      originalWindow: { width: number; height: number }
    }
    expect(parsedResponse.provisionalNarrowWidthPx).toBe(520)
    expect(parsedResponse.narrowWidthPx).toBe(527)
    expect(parsedResponse.originalWindow).toEqual({ width: 800, height: 600 })
    expect(frames).toHaveLength(12)
    expect(capturedRectangles.find((entry) => entry.label === "main-shrink after")).toEqual({
      label: "main-shrink after",
      x: 3,
      y: 10,
      width: 520,
      height: 145,
    })

    const suite = "c".repeat(64)
    const manifest: ProbeSuiteManifest = {
      schemaVersion: 4,
      probeHash: suite,
      adapterVersion: "3.3.1",
      generatedAt: "2026-11-09T10:00:00.000Z",
      catalogIds: [featureId],
      probes: { term: [featureId], lib: [], mux: [] },
    }
    const assertions = (result.assertions ?? []).map((entry) => ({
      ...entry,
      featureId,
      rawReplyRef: featureId,
    }))
    const recorded = recordExecutedProbe({
      featureId,
      attempt: { scope: "probe", startedAt: "2026-11-09T10:00:00.000Z" },
      rawReplyRef: featureId,
      observation: result.observation ? { ...result.observation, featureId, rawReplyRef: featureId } : undefined,
      assertions,
      tests: result.tests,
    })
    const parsed = parseRun(
      "reflow-kitty-800x600.json",
      JSON.stringify({
        schemaVersion: 4,
        source: { kind: "live" },
        runId: "reflow-kitty-800x600",
        suiteId: suite,
        probeHash: suite,
        sourceRevision: "4".repeat(40),
        intendedSubject: { kind: "term", id: "kitty" },
        subject: {
          kind: "term",
          id: "kitty",
          version: "0.49.2",
          os: "linux",
          osVersion: null,
          outerTerminal: null,
          mux: null,
          config: null,
          permissions: null,
        },
        identity: "unverified",
        measuredAt: "2026-11-09T10:01:00.000Z",
        origin: { kind: "collector" },
        sealedAt: "2026-11-09T10:02:00.000Z",
        rawReplies: {
          [featureId]: JSON.stringify({ writes, queries: [], events: [] }),
          [`${featureId}.callbackResponse`]: result.response,
        },
        assertions,
        screenshotRefs: [...new Set((recorded.frames ?? []).flatMap((frame) => [frame.ref, frame.sourceRef ?? []]))],
        results: [recorded],
      }),
      [featureId],
      new Map([[suite, manifest]]),
    )
    expect(parsed.results?.[0]?.status).toBe("supported")
    expect(parsed.results?.[0]?.frames).toHaveLength(12)
  } finally {
    globalThis.setTimeout = realSetTimeout
    Date.now = realDateNow
  }
})

test("extensions.reflow clears scrollback with 2J then 3J so prior ALINKZ scrollback cannot pull into row 1 on grow (#32797)", async () => {
  const featureId = "extensions.reflow"
  const definition = find(featureId)
  const rows = 28
  const wideCols = 88
  const narrowCols = 58
  const cellWidth = 9
  const cellHeight = 21
  const textOrigin = { x: 0, y: 0 }
  const pixelGeometry = {
    cellWidth,
    cellHeight,
    textWidth: wideCols * cellWidth, // 792px inside 800px window
    textHeight: rows * cellHeight, // 588px inside 600px window
  }
  let liveWindow = { width: 800, height: 600 }
  let currentCols = wideCols
  let currentRows = rows
  let screenPlane = "blank"
  let scrollback: string[] = ["ALINKZ"]
  let gridLines: string[] = Array.from({ length: rows }, () => "")
  let phaseState: "init" | "pre-shrunk" | "grown" | "shrunk" = "init"
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const resizeCalls: { width: number; height: number }[] = []
  const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`
  const realSetTimeout = globalThis.setTimeout
  const realDateNow = Date.now
  let fakeNow = realDateNow()
  Date.now = () => fakeNow
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    fakeNow += ms ?? 0
    fn()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout
  try {
    const growRow1Full = "G1-alpha".padEnd(narrowCols, "x")
    const growRow2 = "G2-Z"
    const growSoft = growRow1Full + growRow2
    const shrinkRow1Full = "S1-alpha".padEnd(narrowCols, "y")
    const shrinkRow2 = "S2-Z"
    const applyClear = (bytes: string) => {
      const idx2J = bytes.indexOf("\x1b[2J")
      const idx3J = bytes.indexOf("\x1b[3J")
      // Simulate Kitty pushing non-blank screen lines into scrollback on 2J; 3J only clears
      // those lines too when sent AFTER 2J (\x1b[2J\x1b[3J\x1b[H).
      if (idx3J !== -1 && (idx2J === -1 || idx3J < idx2J)) {
        scrollback = []
      }
      if (idx2J !== -1) {
        const nonEmpty = gridLines.filter((line) => line.length > 0)
        if (nonEmpty.length > 0) scrollback.push(...nonEmpty)
        gridLines = Array.from({ length: currentRows }, () => "")
      }
      if (idx3J !== -1 && idx2J !== -1 && idx3J > idx2J) {
        scrollback = []
      }
    }
    const paintPayload = (payload: string, autowrap: boolean) => {
      const next: string[] = []
      for (const logical of payload.replace(/\r\n$/, "").split("\r\n")) {
        if (!autowrap || logical.length <= currentCols) {
          next.push(logical.slice(0, currentCols))
        } else {
          for (let offset = 0; offset < logical.length; offset += currentCols) {
            next.push(logical.slice(offset, offset + currentCols))
          }
        }
      }
      gridLines = Array.from({ length: currentRows }, (_, idx) => next[idx] ?? "")
    }
    const context: TermProbeSource = {
      kind: "live",
      rows,
      cols: wideCols,
      captureKind: "pixels",
      captureGeometry: {
        geometry: pixelGeometry,
        source: "measured by complete raster calibration",
      },
      write: (bytes) => {
        writes.push(bytes)
        if (bytes.includes("\x1b[2J") || bytes.includes("\x1b[3J")) {
          applyClear(bytes)
        }
        if (bytes.includes("G1-alpha") && bytes.includes(growRow2) && currentCols === narrowCols) {
          screenPlane = "seed-grow"
          paintPayload(`${growSoft}\r\nHARD-a\r\nHARD-b\r\n`, true)
        } else if (bytes.includes("S1-alpha") && bytes.includes(shrinkRow2) && currentCols === wideCols) {
          screenPlane = "seed-shrink"
          paintPayload(`${shrinkRow1Full}${shrinkRow2}\r\nHARD-a\r\nHARD-b\r\n`, true)
        } else if (bytes.startsWith("\x1b[?7h\x1b[0m\x1b[2J") || bytes.startsWith("\x1b[?7l\x1b[0m\x1b[2J")) {
          const autowrap = bytes.startsWith("\x1b[?7h")
          const body = bytes
            .replace(/^\x1b\[\?7[hl]\x1b\[0m\x1b\[2J(?:\x1b\[3J)?\x1b\[H/, "")
            .replace(/\x1b\[\?7h$/, "")
          if (body.length > 0) {
            screenPlane = "ref-paint"
            paintPayload(body, autowrap)
          }
        }
      },
      queryCursorPosition: async () => {
        if (screenPlane === "seed-grow" && currentCols === narrowCols) return { row: 5, col: 1 }
        if (screenPlane === "seed-shrink" && currentCols === wideCols) return { row: 4, col: 1 }
        return { row: currentRows, col: currentCols }
      },
      measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
      query: async () => null,
      queryWithSentinel: async () => null,
      queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
      queryWithSentinelOutcome: async (sequence) => {
        writes.push(sequence)
        if (sequence === "\x1b[18t") {
          const raw = `\x1b[8;${currentRows};${currentCols}t`
          return {
            match: /\x1b\[8;(\d+);(\d+)t/.exec(raw),
            reason: "reply",
            raw,
            rawBase64: Buffer.from(raw).toString("base64"),
          }
        }
        return { match: null, reason: "timeout", raw: "", rawBase64: "" }
      },
      queryMode: async () => null,
      input: {
        injectKey: async () => {},
        injectClick: async () => {},
        resizeWindow: async (width, height) => {
          const previous = { ...liveWindow }
          resizeCalls.push({ width, height })
          liveWindow = { width, height }
          currentCols = Math.floor(width / cellWidth)
          currentRows = Math.floor(height / cellHeight)
          if (currentCols === narrowCols) {
            if (phaseState === "init" || phaseState === "pre-shrunk") {
              phaseState = "pre-shrunk"
            } else {
              phaseState = "shrunk"
              // Shrink pushes top wrapped physical row into scrollback (reflowed-history).
              scrollback.push(shrinkRow1Full)
              gridLines = [shrinkRow2, "HARD-a", "HARD-b", "", ""]
            }
          } else if (currentCols === wideCols && phaseState === "pre-shrunk") {
            phaseState = "grown"
            // Alacritty behavior: unwrapping 2 rows -> 1 row frees 1 viewport row and pulls
            // the most recent scrollback line into Row 1 when scrollback is non-empty!
            if (scrollback.length > 0) {
              const pulled = scrollback.pop()!
              gridLines = [pulled, growSoft, "HARD-a", "HARD-b", ""]
            } else {
              gridLines = [growSoft, "HARD-a", "HARD-b", "", ""]
            }
          }
          return previous
        },
      },
      capture: async (request) => {
        assertCalibratedCaptureGeometry(context.captureGeometry, request)
        const rectangle = cellRectangle({
          cells: request.cells!,
          pixelGeometry: request.pixelGeometry!,
          textOrigin,
          windowWidth: liveWindow.width,
          windowHeight: liveWindow.height,
        })
        const croppedRows: string[] = []
        for (let r = request.cells!.top - 1; r < request.cells!.bottom; r++) {
          const line = (gridLines[r] ?? "").padEnd(request.cells!.right, " ")
          croppedRows.push(line.slice(request.cells!.left - 1, request.cells!.right))
        }
        const regionKey = croppedRows.join("\n")
        const frame: ObservationFrame = {
          kind: "pixels",
          role: request.role,
          label: request.label,
          capturedAt: frames.length + 1,
          ref: digest(`alacritty-frame-${frames.length + 1}-${regionKey}`),
          sourceRef: digest(`alacritty-source-${frames.length + 1}`),
          regionDigest: digest(`alacritty-cells-${regionKey}`),
          pixelsDigest: digest(`alacritty-pixels-${regionKey}`),
          regionRectangle: rectangle,
        }
        frames.push(frame)
        return frame
      },
    }

    const result = await definition.term!(context)
    expect(result.pass).toBe(true)
    expect(result.tests).toEqual([
      {
        id: "criterion",
        status: "supported",
        reason:
          "main-screen reflow measured across shrink (reflowed-history) and grow (reflowed); retained history unmeasured; wide characters, alternate screen and cursor on a wrapped line unmeasured",
      },
    ])
    expect(resizeCalls).toEqual([
      { width: 522, height: 588 },
      { width: 530, height: 600 },
      { width: 800, height: 600 },
      { width: 530, height: 600 },
      { width: 800, height: 600 },
    ])
    expect(frames).toHaveLength(12)
  } finally {
    globalThis.setTimeout = realSetTimeout
    Date.now = realDateNow
  }
})
