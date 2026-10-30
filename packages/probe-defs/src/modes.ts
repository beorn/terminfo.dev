import type {
  CaptureCells,
  CaptureRectangle,
  HeadlessRuntimeIdentity,
  ObservationFrame,
  ProbeDefinition,
  ProbeCallbackResult,
  TermProbeSource,
  LibProbeSource,
} from "./types.ts"
import { frameDigests } from "./types.ts"
import {
  probe,
  decrpmModeProbe,
  headlessDecrpmArm,
  parserStateResult,
  notTestedResult,
  reviewResult,
  HEADLESS_OBSERVABLE_REVIEW,
  osInputReviewResult,
  sameRgb,
  isBlank,
  queryDecrpm,
  decrpmReading,
  decrpmResult,
  type DecrpmPs,
} from "./helpers.ts"
import { applicationKeypad, altScroll1007 } from "./input.ts"
import { regionReadbackProbes, type RegionReadbackRow } from "./region-readback-kind.ts"
import { captureRegionVerdict, DEFAULT_TIMEOUT_MS } from "./region-readback.ts"

/** One addressing fixture supplies both parser-state and capture-region observers. */
export const modesReadbackRows: readonly RegionReadbackRow[] = [
  {
    id: "modes.origin",
    textClaim: "characters",
    expected: "DECOM makes CUP 1;1 address the top of the measured vertical margins",
    // LF proves rows 3–6 form a scroll region before testing origin-relative addressing.
    seed:
      "\x1b[?6l\x1b[?69l\x1b[r\x1b[0m\x1b[2J\x1b[H" +
      "A\x1b[2;1HU\x1b[3;1HB\x1b[4;1HC\x1b[5;1HD\x1b[6;1HE\x1b[7;1HZ" +
      "\x1b[3;6r\x1b[6;1H\n",
    before: [
      ["A", "", ""],
      ["U", "", ""],
      ["C", "", ""],
      ["D", "", ""],
      ["E", "", ""],
      ["", "", ""],
      ["Z", "", ""],
    ],
    // Normalize before the app oracle appends screen-relative parking/witness writes.
    steps: [{ write: "\x1b[?6h\x1b[1;1HX\x1b[?6l\x1b[r" }],
    after: [
      ["A", "", ""],
      ["U", "", ""],
      ["X", "", ""],
      ["D", "", ""],
      ["E", "", ""],
      ["", "", ""],
      ["Z", "", ""],
    ],
    ignored: [
      ["X", "", ""],
      ["U", "", ""],
      ["C", "", ""],
      ["D", "", ""],
      ["E", "", ""],
      ["", "", ""],
      ["Z", "", ""],
    ],
    controls: [
      { row: 1, col: 0, char: "U" },
      { row: 3, col: 0, char: "D" },
      { row: 4, col: 0, char: "E" },
      { row: 6, col: 0, char: "Z" },
    ],
    seedNote: "The vertical scroll-margin prerequisite was not measured",
    controlNote: "Origin addressing moved cells outside its discriminator",
    reset: "\x1b[?6l\x1b[?69l\x1b[r\x1b[0m\x1b[2J\x1b[H",
    cleanup: "\x1b[?6l\x1b[?69l\x1b[r\x1b[0m\x1b[2J\x1b[H",
  },
]

/** Refuse a modes capture fixture before any bytes when the measured geometry is too small. */
function captureRefusal(
  ctx: TermProbeSource,
  minRows: number,
  minCols: number,
  feature: string,
): ProbeCallbackResult | undefined {
  if (!ctx.capture && !ctx.cells) return undefined
  if (Number.isSafeInteger(ctx.rows) && Number.isSafeInteger(ctx.cols) && ctx.rows >= minRows && ctx.cols >= minCols) {
    return undefined
  }
  return {
    pass: false,
    tests: [
      {
        id: "criterion",
        status: "test-todo",
        reason: `${feature} capture needs at least ${minRows}x${minCols}, measured ${ctx.rows}x${ctx.cols}`,
      },
    ],
  }
}

/** Marker restoration, qualified by a separately witnessed actual alternate-buffer marker. */
async function primaryRestoreCapture(
  ctx: TermProbeSource,
  id: string,
  mode: 47 | 1047 | 1049,
  primary: string,
  alternate: string,
): Promise<ProbeCallbackResult> {
  const leave = `\x1b[?${mode}l`
  const enter = `\x1b[?${mode}h`
  const baseline = `${leave}\x1b[0m\x1b[2J\x1b[H${primary}`
  const alternateFrame = `${enter}\x1b[0m\x1b[2J\x1b[H${alternate}`
  // An alternate seed makes restoration a change in the existing character oracle.
  // Keep the unrelated ?47 recipe and its no-change pixel criterion intact.
  const changesSeed = mode !== 47
  const result = await captureRegionVerdict(ctx, id, {
    region: { top: 1, left: 1, bottom: 1, right: Math.max(primary.length, alternate.length) },
    sentinel: { row: 2, col: 1 },
    cursorRow: 3,
    minRows: 3,
    minCols: 8,
    seed: changesSeed ? `${baseline}${alternateFrame}` : baseline,
    edit: changesSeed ? leave : `${alternateFrame}${leave}`,
    expected: baseline,
    ignored: alternateFrame,
    ...(ctx.captureKind !== "text-cells" && {
      discriminator: {
        signal: "primary-marker-restored",
        expected: changesSeed ? ("change" as const) : ("no-change" as const),
      },
    }),
    cleanup: leave,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  })
  if (!result) throw new Error(`${id}: owned primary restoration capture disappeared`)
  if (result.observation?.outcome === "supported" || result.observation?.outcome === "unsupported") {
    // The generic character oracle supplies the observation and assertion; name that same
    // measured criterion before adding this callback's explicitly unmeasured facets.
    result.tests ??= [{ id: "primary-marker-restored", status: result.observation.outcome, assertionRefs: [0] }]
  }
  const remainingFacets = {
    id: "remaining-facets",
    status: "test-todo" as const,
    reason:
      mode === 1049
        ? "Primary-marker capture does not measure saved cursor or retained scrollback restoration"
        : mode === 1047
          ? "Primary-marker roundtrip does not measure exact alternate-buffer clear-on-exit; same-1047 re-entry cannot establish it"
          : "Single alternate-screen roundtrip does not measure alternate contents surviving the next entry",
  }
  if (
    mode !== 47 &&
    result.observation &&
    result.tests?.some((test) => test.id === "primary-marker-restored" && test.status === "unsupported")
  ) {
    // Distinct painted markers do not independently establish entry into another buffer.
    // Without that prerequisite the failed roundtrip cannot be attributed to exit.
    return {
      ...result,
      pass: false,
      observation: {
        ...result.observation,
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        note: "entry not qualified; failed primary restoration cannot establish an exit negative",
      },
      assertions: [],
      tests: [
        { id: "entry-qualified", status: "test-todo", reason: "entry not qualified before the failed exit roundtrip" },
        remainingFacets,
      ],
    }
  }
  if (
    result.tests?.some(
      (test) => test.id === "primary-marker-restored" && (test.status === "supported" || test.status === "unsupported"),
    ) &&
    result.assertions?.[0]
  ) {
    result.assertions.push({
      assertionType: result.assertions[0].assertionType,
      kind: "positive",
      expected: `${id}: actual alternate marker ${alternate} differs from the independently painted primary ${primary} in the same crop behind its paint witness`,
      observed: result.response ?? "",
    })
    result.tests.push({ id: "alternate-marker-control", status: "supported", assertionRefs: [1] })
    result.tests.push(remainingFacets)
  }
  return result
}

/**
 * SGR-stack capture: the target pushes bold, RESETS the live attributes, applies italic to X, and
 * pops before Y. A working roundtrip leaves Y bold-only (bold restored, no italic); an ignored
 * push/pop leaves Y italic-only (bold never restored, italic never cleared). Comparing both
 * attributes in one frame — bold present AND italic absent — is the discriminator. A pending push
 * is popped on capture failure so the fixture never leaves the stack unbalanced.
 */
async function xtSgrStackCapture(ctx: TermProbeSource, id: string, label: string): Promise<ProbeCallbackResult> {
  const refusal = captureRefusal(ctx, 5, 6, id)
  if (refusal) return refusal
  let pushed = false
  const stackCtx: TermProbeSource = {
    ...ctx,
    write(sequence) {
      // Keep the original successful-write boundary around push/pop even though the oracle
      // supplies one fixture string: a failure before the push must not pop somebody else's stack.
      for (const part of sequence.split(/(\x1b\[#[{}])/)) {
        if (!part) continue
        ctx.write(part)
        if (part === "\x1b[#{") pushed = true
        if (part === "\x1b[#}") pushed = false
      }
    },
  }
  try {
    const reset = "\x1b[0m\x1b[2J\x1b[H"
    const paintY = (attributes: string) => `${reset}\x1b[3;4H${attributes}Y\x1b[0m`
    const stackEdit = `${reset}\x1b[3;3H\x1b[1m\x1b[#{\x1b[0m\x1b[3mX\x1b[#}Y\x1b[0m`
    const results: ProbeCallbackResult[] = []
    for (const axis of [
      { signal: "bold-restored", seed: paintY("") },
      { signal: "italic-cleared", seed: paintY("\x1b[1;3m") },
    ]) {
      const result = await captureRegionVerdict(stackCtx, id, {
        region: { top: 3, left: 4, bottom: 3, right: 4 },
        sentinel: { row: 4, col: 1 },
        cursorRow: 5,
        minRows: 5,
        minCols: 6,
        seed: axis.seed,
        edit: stackEdit,
        expected: paintY("\x1b[1m"),
        ignored: paintY("\x1b[3m"),
        discriminator: { signal: axis.signal, expected: "change" },
        timeoutMs: DEFAULT_TIMEOUT_MS,
      })
      if (!result) throw new Error(`${id}: owned SGR capture disappeared`)
      results.push(result)
    }
    const assertions = results.flatMap((result) => result.assertions ?? [])
    let offset = 0
    const tests = results.flatMap((result, index) => {
      const axis = index === 0 ? "bold-restored" : "italic-cleared"
      const axisTests =
        result.tests ??
        (result.observation?.outcome === "inconclusive"
          ? [
              {
                id: "review",
                status: "test-todo" as const,
                reason: result.observation.note ?? `${axis}: insufficient visual evidence`,
              },
            ]
          : undefined)
      if (!axisTests?.length) throw new Error(`${id}: ${axis} returned no required criterion rows`)
      const rows = axisTests.map((test) => ({
        ...test,
        id: test.id === axis ? axis : `${axis}.${test.id}`,
        ...(test.assertionRefs && { assertionRefs: test.assertionRefs.map((ref) => ref + offset) }),
      }))
      offset += result.assertions?.length ?? 0
      return rows
    })
    const frames = results.flatMap((result) => result.observation?.frames ?? [])
    const screenshotRef = results.find((result) => result.observation?.screenshotRef)?.observation?.screenshotRef
    const allSupported = tests.length === 2 && tests.every((test) => test.status === "supported")
    const negative = tests.some((test) => test.status === "unsupported")
    if (!results.some((result) => result.observation)) {
      return {
        pass: false,
        criterionBranch: "visual-review",
        response: JSON.stringify({ label, axes: results.map((result) => result.response) }),
        tests: [
          {
            id: "review",
            status: tests.some((test) => test.status === "test-failure") ? "test-failure" : "test-todo",
            reason: tests.map((test) => `${test.id}: ${test.reason}`).join("; "),
          },
        ],
      }
    }
    return {
      pass: allSupported,
      criterionBranch: "sgr-stack-axes",
      tests,
      assertions,
      response: JSON.stringify({ label, axes: results.map((result) => result.response) }),
      observation: {
        outcome: negative ? "unsupported" : allSupported ? "supported" : "inconclusive",
        ...(!negative && !allSupported && { reason: "insufficient-evidence" as const }),
        assertionType: "screenshot",
        frames,
        ...(screenshotRef && { screenshotRef }),
        note: "Bold restoration and italic clearing are separately qualified against their own seed and the same bold-only/italic-only references; both run the same stack edit",
      },
    }
  } finally {
    if (pushed) ctx.write("\x1b[#}")
    ctx.write("\x1b[0m\x1b[2J\x1b[H")
  }
}

/**
 * Mode save/restore capture: the fixture reaches the true measured wrap boundary. Both frames
 * write exactly `ctx.cols` Xs so the cursor is on the last column, then one `!`. With wrap off the
 * `!` overwrites the last column and stays on row 1; with wrap saved-then-restored it wraps to
 * row 2. Both frames therefore differ only by the restored wrap state.
 */
async function xtModeSaveCapture(ctx: TermProbeSource, id: string): Promise<ProbeCallbackResult> {
  const refusal = captureRefusal(ctx, 4, 2, id)
  if (refusal) return refusal
  const xs = "X".repeat(Number.isSafeInteger(ctx.cols) && ctx.cols > 0 ? ctx.cols : 0)
  const reset = "\x1b[?7l\x1b[0m\x1b[2J\x1b[H"
  const result = await captureRegionVerdict(ctx, id, {
    region: { top: 2, left: 1, bottom: 2, right: 1 },
    sentinel: { row: 3, col: 1 },
    cursorRow: 4,
    minRows: 4,
    minCols: 2,
    seed: `${reset}${xs}!`,
    edit: `\x1b[?7h\x1b[?7s\x1b[?7l\x1b[?7r\x1b[0m\x1b[2J\x1b[H${xs}!`,
    expected: `${reset}\x1b[2;1H!`,
    ignored: reset,
    discriminator: { signal: "wrap-restored", expected: "change" },
    cleanup: "\x1b[?7h",
    timeoutMs: DEFAULT_TIMEOUT_MS,
  })
  if (!result) throw new Error(`${id}: owned mode-save capture disappeared`)
  return result
}

/**
 * Color-stack capture: index 1 is first set to a KNOWN baseline (blue) so a pop is measurably
 * distinct. The target pushes the palette, redefines index 1 green, prints X, pops, then prints Y.
 * Judge the roundtrip by Y ALONE: Y must match the blue baseline control, so a green Y means the pop
 * did not restore the saved palette. Do NOT grade on X: X is printed through SGR 38;5;1, a palette
 * reference into index 1, so a correct pop may recolor the already-drawn X blue -- its green-or-blue
 * color is not evidence either way, and a blue X is not an ignored push/pop. If a pre-pop green X is
 * wanted as extra evidence, capture it before the pop instead of reading it from this frame. A
 * palette-setup failure (the control not measured blue) stays inconclusive. A pending push is popped
 * only when one is open, so a successful roundtrip is never double-popped.
 */
async function xtColorStackCapture(ctx: TermProbeSource, id: string): Promise<ProbeCallbackResult> {
  const refusal = captureRefusal(ctx, 4, 8, id)
  if (refusal) return refusal
  let pushed = false
  const stackCtx: TermProbeSource = {
    ...ctx,
    write(sequence) {
      for (const part of sequence.split(/(\x1b\[#[PQ])/)) {
        if (!part) continue
        ctx.write(part)
        if (part === "\x1b[#P") pushed = true
        if (part === "\x1b[#Q") pushed = false
      }
    },
  }
  try {
    const reset = "\x1b[0m\x1b[2J\x1b[H"
    const blue = "\x1b]4;1;rgb:00/00/ff\x07"
    const green = "\x1b]4;1;rgb:00/ff/00\x07"
    const baseline = `${reset}${blue}\x1b[1;1H\x1b[38;5;1mXY\x1b[0m`
    const result = await captureRegionVerdict(stackCtx, id, {
      region: { top: 1, left: 2, bottom: 1, right: 2 },
      sentinel: { row: 3, col: 1 },
      cursorRow: 4,
      minRows: 4,
      minCols: 8,
      seed: baseline,
      edit: `${reset}${blue}\x1b[#P${green}\x1b[1;1H\x1b[38;5;1mX\x1b[#Q\x1b[38;5;1mY\x1b[0m`,
      expected: baseline,
      ignored: `${reset}${green}\x1b[1;2H\x1b[38;5;1mY\x1b[0m`,
      setupReference: `${reset}\x1b[1;2H\x1b[38;2;0;0;255mY\x1b[0m`,
      discriminator: { signal: "palette-y-restored", expected: "no-change" },
      cleanup: "\x1b]104\x07",
      timeoutMs: DEFAULT_TIMEOUT_MS,
    })
    if (!result) throw new Error(`${id}: owned palette capture disappeared`)
    return result
  } finally {
    if (pushed) ctx.write("\x1b[#Q")
    ctx.write("\x1b]104\x07\x1b[0m\x1b[2J\x1b[H")
  }
}

/** A stack operation that produced output: the invalid-reply record the read-back arms keep. */
function stackOutputResult(output: string): ProbeCallbackResult {
  return {
    pass: false,
    response: output,
    observation: {
      outcome: "inconclusive",
      reason: "invalid-reply",
      assertionType: "query_reply",
      note: "Unexpected output during stack operation",
    },
  }
}

type StackCell = ReturnType<LibProbeSource["getCell"]>

/** Bold-only and italic-only are the two shapes the SGR-stack fixture discriminates between. */
function boldOnly(cell: StackCell): boolean {
  return cell.bold === true && cell.italic !== true
}

function italicOnly(cell: StackCell): boolean {
  return cell.italic === true && cell.bold !== true
}

/**
 * Headless SGR-stack read-back (#30700): the pixel capture's frame, read from the parser's cells. B
 * is written bold, then the push, SGR 0, italic X, the pop, Y. A working roundtrip leaves Y
 * bold-only (bold restored, italic cleared); an ignored push/pop leaves Y italic-only. The control
 * writes the same cells with no stack ops, so a backend that does not report bold or italic, or
 * whose SGR 0 does not clear bold, has no observable for the claim (a coverage record, TEST TODO)
 * rather than a negative.
 */
function xtSgrStackHeadless(ctx: LibProbeSource, id: string, label: string): ProbeCallbackResult {
  const expected = `${id}: ${label} leaves Y bold-only (bold restored by the pop, italic cleared)`
  if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 3) {
    return parserStateResult(null, expected, { cols: ctx.cols }, "Measured grid needs three columns")
  }
  const readBXY = () => ({ b: ctx.getCell(0, 0), x: ctx.getCell(0, 1), y: ctx.getCell(0, 2) })
  const charsIntact = (cells: ReturnType<typeof readBXY>) =>
    cells.b.char === "B" && cells.x.char === "X" && cells.y.char === "Y"
  let pushed = false
  try {
    ctx.feed("\x1b[0m\x1b[2J\x1b[1;1H\x1b[1mB\x1b[0m\x1b[3mXY\x1b[0m")
    const control = readBXY()
    if (!charsIntact(control) || !boldOnly(control.b) || !italicOnly(control.x) || !italicOnly(control.y)) {
      return notTestedResult(
        "bold and italic cell attributes in the headless readback (control frame not calibrated)",
        {
          control,
        },
      )
    }
    ctx.feed("\x1b[0m\x1b[2J\x1b[1;1H\x1b[1mB")
    const pushOutput = ctx.feedCapture("\x1b[#{")
    pushed = true
    if (pushOutput.length > 0) return stackOutputResult(pushOutput)
    ctx.feed("\x1b[0m\x1b[3mX")
    const popOutput = ctx.feedCapture("\x1b[#}")
    pushed = false
    if (popOutput.length > 0) return stackOutputResult(popOutput)
    ctx.feed("Y\x1b[0m")
    const target = readBXY()
    const state = { control, target }
    if (!charsIntact(target)) {
      return parserStateResult(null, expected, state, "Stack sequence disturbed the B, X, Y cells")
    }
    if (boldOnly(target.y)) return parserStateResult(true, expected, state)
    if (italicOnly(target.y)) return parserStateResult(false, expected, state)
    return parserStateResult(null, expected, state, "Y after the pop is neither bold-only nor italic-only")
  } finally {
    if (pushed) ctx.feed("\x1b[#}")
    ctx.feed("\x1b[0m\x1b[2J\x1b[H")
  }
}

/**
 * Headless XTSAVE/XTRESTORE read-back (#30700): the pixel capture's overflow fixture, read from
 * cells. Every frame writes exactly `cols` Xs then one `!`: with auto-wrap off the `!` overwrites
 * the last column and row 2 stays empty; with wrap on it lands at row 2, column 1. Two controls
 * calibrate both wrap states before the target saves wrap on, disables it and restores it, so a
 * backend that cannot show either state has no observable for the claim (a coverage record, TEST
 * TODO) rather than a negative.
 */
function xtModeSaveHeadless(ctx: LibProbeSource, id: string): ProbeCallbackResult {
  const expected = `${id}: the ${ctx.cols}-column overflow ! wraps to row 2 after DECAWM is saved on, disabled and restored`
  const rows = ctx.getScrollback().screenLines
  if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 2 || !Number.isSafeInteger(rows) || rows < 2) {
    return parserStateResult(null, expected, { rows, cols: ctx.cols }, "Measured grid needs two rows and two columns")
  }
  const xs = "X".repeat(ctx.cols)
  const overflow = () => ({ last: ctx.getCell(0, ctx.cols - 1), next: ctx.getCell(1, 0) })
  const wrapped = (frame: ReturnType<typeof overflow>) => frame.last.char === "X" && frame.next.char === "!"
  const stayed = (frame: ReturnType<typeof overflow>) => frame.last.char === "!" && frame.next.char !== "!"
  try {
    ctx.feed(`\x1b[?7l\x1b[0m\x1b[2J\x1b[1;1H${xs}!`)
    const off = overflow()
    ctx.feed(`\x1b[?7h\x1b[0m\x1b[2J\x1b[1;1H${xs}!`)
    const on = overflow()
    if (!stayed(off) || !wrapped(on)) {
      return notTestedResult("both auto-wrap states (DECAWM off and on) in the headless readback", {
        rows,
        cols: ctx.cols,
        off,
        on,
      })
    }
    const saveOutput = ctx.feedCapture("\x1b[?7s")
    if (saveOutput.length > 0) return stackOutputResult(saveOutput)
    ctx.feed("\x1b[?7l")
    const restoreOutput = ctx.feedCapture("\x1b[?7r")
    if (restoreOutput.length > 0) return stackOutputResult(restoreOutput)
    ctx.feed(`\x1b[0m\x1b[2J\x1b[1;1H${xs}!`)
    const target = overflow()
    const state = { rows, cols: ctx.cols, off, on, target, autoWrap: ctx.getMode("autoWrap") }
    if (wrapped(target)) return parserStateResult(true, expected, state)
    if (stayed(target)) return parserStateResult(false, expected, state)
    return parserStateResult(null, expected, state, "Overflow ! after the restore landed in neither wrap state")
  } finally {
    ctx.feed("\x1b[?7h\x1b[0m\x1b[2J\x1b[H")
  }
}

const COLOR_STACK_BLUE = { r: 0, g: 0, b: 255 }
const COLOR_STACK_GREEN = { r: 0, g: 255, b: 0 }

/**
 * Headless XTPUSHCOLORS/XTPOPCOLORS read-back (#30700): the pixel capture's palette fixture, read
 * from cells. Calibration redefines index 1 blue, draws and reads a cell, then green and reads
 * again, which proves OSC 4 moves the reported foreground at all (on @xterm/headless, the
 * per-instance palette array mirrors _core._inputHandler.onColor events, so OSC 4 cell-color
 * calibration grades that engine-delivered index+rgb event; #31735, @cto 863bef67). The target sets the blue
 * baseline, pushes, redefines index 1 green, prints X, pops and prints Y. Y alone is graded, read
 * before any later palette change can recolor it: blue means the pop restored the saved palette,
 * green means it did not. X is never graded, because a correct pop may recolor it (turn362). A
 * readback whose colors do not follow OSC 4 has no observable for the claim (a coverage record,
 * TEST TODO) rather than a negative.
 */
function xtColorStackHeadless(ctx: LibProbeSource, id: string): ProbeCallbackResult {
  const expected = `${id}: Y printed through index 1 after the pop reads the blue baseline, not the pushed green`
  if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 2) {
    return parserStateResult(null, expected, { cols: ctx.cols }, "Measured grid needs two columns")
  }
  let pushed = false
  try {
    ctx.feed("\x1b[0m\x1b[2J\x1b[1;1H\x1b]4;1;rgb:00/00/ff\x07\x1b[38;5;1mA")
    const blue = ctx.getCell(0, 0)
    ctx.feed("\x1b[0m\x1b[2J\x1b[1;1H\x1b]4;1;rgb:00/ff/00\x07\x1b[38;5;1mB")
    const green = ctx.getCell(0, 0)
    const calibration = { blue, green }
    if (
      blue.char !== "A" ||
      green.char !== "B" ||
      !blue.fg ||
      !green.fg ||
      !sameRgb(blue.fg, COLOR_STACK_BLUE) ||
      !sameRgb(green.fg, COLOR_STACK_GREEN)
    ) {
      return notTestedResult("OSC 4 redefinition of palette index 1 reflected in the headless cell colors", calibration)
    }
    ctx.feed("\x1b[0m\x1b[2J\x1b[1;1H\x1b]4;1;rgb:00/00/ff\x07")
    const pushOutput = ctx.feedCapture("\x1b[#P")
    pushed = true
    if (pushOutput.length > 0) return stackOutputResult(pushOutput)
    ctx.feed("\x1b]4;1;rgb:00/ff/00\x07\x1b[38;5;1mX")
    const popOutput = ctx.feedCapture("\x1b[#Q")
    pushed = false
    if (popOutput.length > 0) return stackOutputResult(popOutput)
    ctx.feed("\x1b[38;5;1mY\x1b[0m")
    const x = ctx.getCell(0, 0)
    const y = ctx.getCell(0, 1)
    const state = { calibration, x, y }
    if (x.char !== "X" || y.char !== "Y" || !y.fg) {
      return parserStateResult(null, expected, state, "X and Y cells after the pop were not exposed")
    }
    if (sameRgb(y.fg, COLOR_STACK_BLUE)) return parserStateResult(true, expected, state)
    if (sameRgb(y.fg, COLOR_STACK_GREEN)) return parserStateResult(false, expected, state)
    return parserStateResult(
      null,
      expected,
      state,
      "Y after the pop matches neither the blue baseline nor the pushed green",
    )
  } finally {
    if (pushed) ctx.feed("\x1b[#Q")
    ctx.feed("\x1b]104\x07\x1b[0m\x1b[2J\x1b[H")
  }
}

const ALT_1049_SEED_A = "PRIMARY-A"
const ALT_1049_SEED_B = "PRIMARY-B"
const ALT_1049_MARK = "ALT-MARK"

/** Read the exact characters of a horizontal span; never an inequality shortcut. */
function readAlt1049Span(ctx: LibProbeSource, row: number, length: number): string {
  let text = ""
  for (let index = 0; index < length; index += 1) text += ctx.getCell(row, index).char
  return text
}

function alt1049SpanBlank(ctx: LibProbeSource, row: number, length: number): boolean {
  for (let index = 0; index < length; index += 1) {
    if (!isBlank(ctx.getCell(row, index).char)) return false
  }
  return true
}

/** What one alternate-screen mode promises; ?47, ?1047 and ?1049 share the one seeded roundtrip below. */
interface AltScreenMode {
  /** The private mode the roundtrip sets and resets: CSI ? <mode> h enters, CSI ? <mode> l leaves. */
  readonly mode: 47 | 1047 | 1049
  /**
   * Entry must blank the seeded spans. Only ?1049 promises that: xterm clears ?1047's alternate buffer
   * on EXIT (DECRST 1047, "clearing screen first if in the Alternate Screen Buffer"), and ?47 leaves
   * clearing implementation-defined, so both grade entry by the primary seeds not showing (#30702).
   */
  readonly clearsOnEnter: boolean
  /** Leaving must clear the alternate buffer (1047 only, DECRST 1047): a second entry shows ALT-MARK gone. */
  readonly clearsOnExit: boolean
  /** Only 1049 saves the cursor on entry and restores it on exit. */
  readonly savesCursor: boolean
}

const ALT_SCREEN_1049: AltScreenMode = { mode: 1049, clearsOnEnter: true, clearsOnExit: false, savesCursor: true }
const ALT_SCREEN_1047: AltScreenMode = { mode: 1047, clearsOnEnter: false, clearsOnExit: true, savesCursor: false }
const ALT_SCREEN_47: AltScreenMode = { mode: 47, clearsOnEnter: false, clearsOnExit: false, savesCursor: false }

/**
 * Exact loaded sources whose engine implements no alternate screen at all (#31388, @dev/10 d2dbb969). On such
 * an engine a ?1049 exit is not "unattributed": there is no alternate buffer to leave, so the honest grade is a
 * negative decided by source — the shape of the audited title stack (#31735, @cto 863bef67), but keyed on a
 * source tuple because a JS source engine has no loaded binary to hash. Repository, revision, tree and resolved
 * path must all match and the tree must be clean. An adapter name is never enough: the adapters are
 * pass-throughs, and a moved or locally modified engine must fall back to the existing inconclusive answer.
 */
const ALT_SCREEN_UNIMPLEMENTED_AUDITS: ReadonlyMap<string, string> = new Map([
  [
    "git@github.com:beorn/vterm.git@53a9eb9291b7880f4dc6a39a6802301049997a72:5ffc7ad9ae120d0bf93c64b0fdc712eb40892896:vendor/vterm/packages/vt100/src/index.ts",
    "vterm packages/vt100/src/screen.ts:99 'Main screen buffer (no alternate screen in VT100)'; no CSI ? 1049 changes state in that source tree, so there is no alternate buffer for exit to leave",
  ],
  [
    "git@github.com:beorn/vterm.git@53a9eb9291b7880f4dc6a39a6802301049997a72:69366752918a6086c639123799cc3ac68d8083a0:vendor/vterm/packages/vt220/src/index.ts",
    "vterm packages/vt220/src/screen.ts:145 'Main screen buffer (no alternate screen in VT220)', with :90 listing the alternate screen among what it does not cover; no CSI ? 1049 changes state in that source tree",
  ],
])

/** The source citation for the loaded engine, or undefined when the exact source is not audited. */
function altScreenAbsenceCitation(identity: HeadlessRuntimeIdentity | undefined): string | undefined {
  if (identity === undefined || !("resolvedPath" in identity)) return undefined
  const integrity = identity.integrity
  if (integrity.kind !== "source" || !integrity.cleanTree) return undefined
  return ALT_SCREEN_UNIMPLEMENTED_AUDITS.get(
    `${integrity.repository}@${integrity.revision}:${integrity.treeOid}:${identity.resolvedPath}`,
  )
}

/**
 * One measured alternate-screen roundtrip, shared by the 1049 enter and exit callbacks and by the
 * ?47 and ?1047 callbacks (#30702). Existing ctx only: feed, getCell, getCursor, getScrollback and
 * cols. No rows API and no entry-homing requirement. EVERY callback grades supported only when the
 * entire seeded roundtrip holds: alternate spans that left the primary seed (blank for the clearing
 * modes 1049 and 1047; ?47's clearing is implementation-defined, so its spans only must not still
 * show the seed), distinct ALT-MARK readback, exact PRIMARY-A/PRIMARY-B restoration, ALT-MARK absent
 * from the restored position, for 1049 alone saved-cursor restoration, and for 1047 alone the exit
 * clear (DECRST 1047): a second entry after the restore must show ALT-MARK gone. Inadequate geometry,
 * an unmeasured seed, an unavailable readback and an unattributed restoration failure are
 * inconclusive; a negative needs measured setup plus a feature-specific failed assertion. 1049
 * splits enter and exit into two features, so its restoration failure cannot be attributed to
 * either; ?47 and ?1047 are each ONE swap feature (phase "roundtrip"), so a measured restoration
 * failure is that feature's own negative. Cleanup leaves the mode in finally and stays loud: a
 * cleanup failure is never swallowed into a result.
 */
function altScreenRoundtrip(
  ctx: LibProbeSource,
  screen: AltScreenMode,
  phase: "enter" | "exit" | "roundtrip",
  expected: string,
): ProbeCallbackResult {
  const enter = `\x1b[?${screen.mode}h`
  const leave = `\x1b[?${screen.mode}l`
  const rows = ctx.getScrollback().screenLines
  const cols = ctx.cols
  const needed = Math.max(ALT_1049_SEED_A.length, ALT_1049_SEED_B.length, ALT_1049_MARK.length)
  // Pre-cursor parks at row 4/col 6 (\x1b[5;7H): 1049's measured geometry must cover the seeds,
  // the marker AND that saved cursor, so 5 rows are required, not just 3. A mode that saves no
  // cursor needs only the seeded rows.
  const minRows = screen.savesCursor ? 5 : 3
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < minRows || cols < needed) {
    return parserStateResult(
      null,
      expected,
      { rows, cols, needed },
      `${screen.mode} fixture needs at least ${minRows} visible rows and ${needed} columns`,
    )
  }
  ctx.feed("\x1b[2J\x1b[1;1H" + ALT_1049_SEED_A)
  ctx.feed("\x1b[3;1H" + ALT_1049_SEED_B)
  ctx.feed("\x1b[5;7H")
  let before: { x: number; y: number }
  let seedA: string
  let seedB: string
  try {
    before = { ...ctx.getCursor() }
    seedA = readAlt1049Span(ctx, 0, ALT_1049_SEED_A.length)
    seedB = readAlt1049Span(ctx, 2, ALT_1049_SEED_B.length)
  } catch (error) {
    return alt1049ReadbackInconclusive(expected, "Primary seed readback failed", error)
  }
  if (seedA !== ALT_1049_SEED_A || seedB !== ALT_1049_SEED_B) {
    return parserStateResult(null, expected, { rows, cols, seedA, seedB }, "Primary seed was not measured")
  }
  // The saved-cursor claim (1049 only) is only measurable if the pre-cursor was actually parked at
  // the commanded row 4/col 6. A constant getCursor would make before==after trivially true, so an
  // unmeasured or mismatched pre-cursor is setup failure, checked before 1049h is fed.
  if (
    screen.savesCursor &&
    (!Number.isSafeInteger(before.x) || !Number.isSafeInteger(before.y) || before.x !== 6 || before.y !== 4)
  ) {
    return parserStateResult(
      null,
      expected,
      { before, expectedCursor: { x: 6, y: 4 } },
      "Parked pre-cursor was not measured at row 4/col 6",
    )
  }
  try {
    ctx.feed(enter)
    let blankA: boolean
    let blankB: boolean
    let seedShown: boolean
    try {
      blankA = alt1049SpanBlank(ctx, 0, ALT_1049_SEED_A.length)
      blankB = alt1049SpanBlank(ctx, 2, ALT_1049_SEED_B.length)
      seedShown =
        readAlt1049Span(ctx, 0, ALT_1049_SEED_A.length) === ALT_1049_SEED_A ||
        readAlt1049Span(ctx, 2, ALT_1049_SEED_B.length) === ALT_1049_SEED_B
    } catch (error) {
      return alt1049ReadbackInconclusive(expected, "Alternate-buffer readback failed", error)
    }
    // A clearing mode must show blank seeded spans. ?47 and ?1047 leave entry clearing implementation-
    // defined, so only a span that still shows its primary seed fails their entry; other alternate
    // content passes.
    const entered = screen.clearsOnEnter ? blankA && blankB : !seedShown
    if (!entered) {
      const state = { seedA, seedB, blankA, blankB, ...(!screen.clearsOnEnter && { seedShown }) }
      if (phase === "exit") {
        // An engine audited as having no alternate screen cannot have entered one, so its exit is decided by
        // source rather than left unattributed (#31388). Every other engine keeps the inconclusive answer below:
        // an exit across an unqualified entry is genuinely unattributable, and the broad failed-entry branch
        // stays as it is.
        const sourceCitation = altScreenAbsenceCitation(ctx.runtimeIdentity)
        if (sourceCitation !== undefined) {
          return parserStateResult(false, expected, { ...state, sourceCitation }, "negative by source citation")
        }
        return parserStateResult(
          null,
          expected,
          state,
          "Entry did not clear the seeded primary spans; exit cannot be attributed",
        )
      }
      return parserStateResult(
        false,
        expected,
        state,
        screen.clearsOnEnter
          ? `CSI ? ${screen.mode} h did not clear the seeded primary spans`
          : `CSI ? ${screen.mode} h left a seeded primary span visible`,
      )
    }
    ctx.feed("\x1b[1;1H" + ALT_1049_MARK)
    let mark: string
    try {
      mark = readAlt1049Span(ctx, 0, ALT_1049_MARK.length)
    } catch (error) {
      return alt1049ReadbackInconclusive(expected, "Alternate-marker readback failed", error)
    }
    if (mark !== ALT_1049_MARK) {
      return parserStateResult(null, expected, { mark }, "Alternate marker was not measured")
    }
    ctx.feed(leave)
    let restoredA: string
    let restoredB: string
    let leaked: boolean
    let after: { x: number; y: number }
    try {
      restoredA = readAlt1049Span(ctx, 0, ALT_1049_SEED_A.length)
      restoredB = readAlt1049Span(ctx, 2, ALT_1049_SEED_B.length)
      leaked = readAlt1049Span(ctx, 0, ALT_1049_MARK.length) === ALT_1049_MARK
      after = { ...ctx.getCursor() }
    } catch (error) {
      return alt1049ReadbackInconclusive(expected, "Restored-primary readback failed", error)
    }
    // DECRST 1047 clears the alternate buffer on exit (xterm ctlseqs), so that mode enters once more
    // after the measured restore and reads the marker span: a BLANK span is the clear, ALT-MARK still
    // shown is the feature's own negative, and any other content (a partial clear) is inconclusive by
    // name. No other mode promises an exit clear (#30702).
    let reentered: string | undefined
    let reenteredBlank = false
    if (screen.clearsOnExit) {
      ctx.feed(enter)
      try {
        reentered = readAlt1049Span(ctx, 0, ALT_1049_MARK.length)
        reenteredBlank = alt1049SpanBlank(ctx, 0, ALT_1049_MARK.length)
      } catch (error) {
        return alt1049ReadbackInconclusive(expected, "Re-entered alternate-buffer readback failed", error)
      } finally {
        ctx.feed(leave)
      }
    }
    const state = {
      before,
      seedA,
      seedB,
      mark,
      restoredA,
      restoredB,
      leaked,
      after,
      ...(screen.clearsOnExit && { reentered }),
    }
    const failures: string[] = []
    if (restoredA !== ALT_1049_SEED_A) failures.push("PRIMARY-A not restored")
    if (restoredB !== ALT_1049_SEED_B) failures.push("PRIMARY-B not restored")
    if (leaked) failures.push("ALT-MARK leaked into the restored position")
    if (screen.savesCursor && (after.x !== before.x || after.y !== before.y)) {
      failures.push("saved cursor not restored")
    }
    if (screen.clearsOnExit && reentered === ALT_1049_MARK) {
      failures.push(
        `ALT-MARK still shown on re-entry: CSI ? ${screen.mode} l did not clear the alternate buffer on exit`,
      )
    }
    if (failures.length === 0) {
      if (screen.clearsOnExit && !reenteredBlank) {
        return parserStateResult(
          null,
          expected,
          state,
          `Re-entered alternate buffer shows other content, neither blank nor ALT-MARK: ${JSON.stringify(reentered)}`,
        )
      }
      return parserStateResult(true, expected, state, undefined)
    }
    if (phase === "roundtrip") {
      // One swap feature owns both directions, so a primary that did not come back, or a marker
      // that reached it, after a measured seed, entry and marker is its own negative.
      return parserStateResult(false, expected, state, `${screen.mode} roundtrip failed: ` + failures.join("; "))
    }
    return parserStateResult(
      null,
      expected,
      state,
      `${screen.mode} roundtrip failed: ` +
        failures.join("; ") +
        "; cannot attribute failure to enter or exit: blank spans and ALT-MARK do not distinguish an alternate buffer from erasure, and cursor mismatch does not distinguish save from restore",
    )
  } finally {
    ctx.feed(leave + "\x1b[0m")
  }
}

function alt1049ReadbackInconclusive(expected: string, note: string, error: unknown): ProbeCallbackResult {
  const message = error instanceof Error ? error.message : String(error)
  return parserStateResult(null, expected, { readbackError: message }, note)
}

/** Row 1's seed for the margin fixture: one glyph in each of columns 1-8. */
const LR_MARGIN_SEED = "ABCDEFGH"
/** ICH at column 3 with no margins shifts C-G right one column and pushes H off column 8. */
const LR_MARGIN_UNBOUNDED = "AB CDEFG"
/** The same ICH under DECSLRM 3;6 shifts only columns 3-6: F drops at the right margin, G and H stay. */
const LR_MARGIN_BOUNDED = "AB CDEGH"
const LR_MARGIN_EXPECTED =
  "Left-right margin mode constrains horizontal operations: ICH at column 3 under DECSLRM 3;6 drops F at column 6 and leaves G and H in columns 7-8"

/**
 * Headless DECLRMM read-back (#30702): DECSLRM 3;6 under ?69h, then ICH at column 3, read back from
 * row 1's cells inside AND outside the margins. Honoured margins confine the shift to columns 3-6, so
 * F drops at the right margin and G and H stay in columns 7-8; ignored margins shift the whole row
 * exactly as the control does. The control runs the same ICH with no margins first, so a backend
 * whose readback does not show ICH shifting the row has no observable for the claim (a coverage
 * record, TEST TODO) rather than a negative. Cleanup resets the margins while ?69 is still set,
 * where CSI s is DECSLRM rather than a cursor save, then leaves the mode.
 */
function leftRightMarginHeadless(ctx: LibProbeSource): ProbeCallbackResult {
  const width = LR_MARGIN_SEED.length
  if (!Number.isSafeInteger(ctx.cols) || ctx.cols < width) {
    return parserStateResult(null, LR_MARGIN_EXPECTED, { cols: ctx.cols }, "Measured grid needs eight columns")
  }
  const readRow = (): string => {
    let text = ""
    for (let col = 0; col < width; col += 1) {
      const char = ctx.getCell(0, col).char
      text += isBlank(char) ? " " : char
    }
    return text
  }
  let margins = false
  try {
    ctx.feed("\x1b[0m\x1b[2J\x1b[1;1H" + LR_MARGIN_SEED)
    const seed = readRow()
    if (seed !== LR_MARGIN_SEED) {
      return parserStateResult(null, LR_MARGIN_EXPECTED, { seed }, "Margin seed ABCDEFGH was not measured")
    }
    ctx.feed("\x1b[1;3H\x1b[@")
    const control = readRow()
    if (control !== LR_MARGIN_UNBOUNDED) {
      return parserStateResult(
        null,
        LR_MARGIN_EXPECTED,
        {
          seed,
          control,
        },
        undefined,
        "ICH shifting row 1 right from column 3 in the headless readback (control frame not calibrated)",
      )
    }
    ctx.feed("\x1b[0m\x1b[2J\x1b[1;1H" + LR_MARGIN_SEED)
    margins = true
    ctx.feed("\x1b[?69h\x1b[3;6s\x1b[1;3H\x1b[@")
    const target = readRow()
    const state = { seed, control, margins: "3-6", target }
    if (target === LR_MARGIN_BOUNDED) return parserStateResult(true, LR_MARGIN_EXPECTED, state)
    if (target === LR_MARGIN_UNBOUNDED) {
      return parserStateResult(
        false,
        LR_MARGIN_EXPECTED,
        state,
        "ICH under DECSLRM 3;6 shifted the whole row, exactly as the control without margins did",
      )
    }
    return parserStateResult(
      null,
      LR_MARGIN_EXPECTED,
      state,
      "ICH under margins 3-6 left neither the bounded nor the unbounded shift",
    )
  } finally {
    ctx.feed((margins ? "\x1b[s" : "") + "\x1b[?69l\x1b[0m\x1b[2J\x1b[H")
  }
}

const DECSSCLS_JUMP = "\x1b[9 p"
const DECSSCLS_SLOW = "\x1b[0 p"
const DECSSCLS_SETTLE_MS = 300
const DECSSCLS_LINES_PER_SECOND = 9
/**
 * Rows the burst must overrun the measured screen by, so scrolling is forced at any geometry, and
 * enough of the throttled window survives the capture latency for the timing bound to be decisive.
 */
const DECSSCLS_OVERFLOW_ROWS = 16
/**
 * The marker band is authored this many lines before the burst's last line. The burst runs 16 lines
 * past the screen and its trailing line feed leaves one blank row under the text, so seven lines
 * before the last settles the band at screen row `rows - 8`: above the cursor, inside the witness.
 */
const DECSSCLS_MARKER_LINES_BEFORE_BURST_END = 7
/**
 * The second target frame is taken this long after the throttle window closes. A terminal that
 * honours the rate has finished by then; one that is merely slow has not, and that grades
 * inconclusive rather than unsupported.
 */
const DECSSCLS_SETTLE_MARGIN_MS = 500
/** A full-width band whose pixels are identical wherever the row lands. */
const decssclsBand = (cols: number): string => `\x1b[48;5;196m${" ".repeat(cols)}\x1b[0m`
/**
 * Slack under the throttled window. At 9 lines per second one line takes 111 ms, so 150 ms is more
 * than a full line: a terminal that honours the rate moves at least one line between the first and
 * second target frame, while a capture that returns a few milliseconds either side of the bound
 * cannot flip the verdict on its own.
 */
const DECSSCLS_TIMING_MARGIN_MS = 150
/**
 * DECSCLM smooth scrolling, the mode DECSSCLS's documented rate applies to. Both phases set it, and
 * the probe reads DECSCLM before it starts (DECRQM 4) so the finally can put back exactly what it
 * found. No run-level reset exists between probes, so a probe that leaves smooth scrolling on would
 * change the timing of every later row that never asked for it.
 */
const DECSSCLM_SMOOTH = "\x1b[?4h"
const DECSSCLM_JUMP = "\x1b[?4l"

/** The burst overruns the measured screen by a fixed margin, so no context can absorb it without scrolling. */
function decssclsBurst(rows: number, cols: number): { text: string; lines: number; markerLine: number } {
  const lines = rows + DECSSCLS_OVERFLOW_ROWS
  const markerLine = lines - DECSSCLS_MARKER_LINES_BEFORE_BURST_END
  const band = decssclsBand(cols)
  return {
    text:
      Array.from({ length: lines }, (_, index) => (index + 1 === markerLine ? band : `line ${index + 1}`)).join(
        "\r\n",
      ) + "\r\n",
    lines,
    markerLine,
  }
}

/**
 * The cell region a phase compares: the top rows of the text area, above the row the burst leaves
 * the cursor on, so no cursor repaint reaches it and scrolling has to move text through it.
 */
function decssclsWitness(rows: number, cols: number): CaptureCells {
  return { top: 1, left: 1, bottom: rows - 1, right: cols }
}

interface DecssclsPair {
  /** True when the two frames were cropped from the same rectangle, so their digests compare. */
  sameRectangle: boolean
  /** The region digest changed between the pair: content moved through the witness region. */
  changed: boolean
  /** The two frames' region digests, in capture order, so a decided verdict can cite them. */
  digests: readonly [string, string]
  /** When the witness capture completed, in ms. Reported; the band frame's time decides the window. */
  firstElapsedMs: number
  /** When the first band capture completed, in ms: the decisive bound for "inside the window". */
  firstBandElapsedMs: number
  screenshotRef: string
  rectangles: readonly [CaptureRectangle, CaptureRectangle]
  /** Whether the marker band was found at its settled row in each frame. */
  band: readonly [boolean, boolean]
  bandDigests: readonly [string, string]
}

/**
 * DECSSCLS (CSI Ps SP p) sets presentation speed and has no query. The same-run control sets jump
 * scrolling; the target sets the documented 9-lines-per-second rate. Each phase takes two frames of
 * the same screen and a one-row capture at the marker's settled row: the first frame as soon as the
 * collector can after the burst, the second after the settle delay (for the target, after the
 * throttled window would have closed). The burst overruns the MEASURED row count, so every context
 * has to scroll; that alone does not attribute a frame difference to scrolling.
 *
 * The witness comparison is raw-pixel region digests of ONE cells rectangle, never the encoded frame
 * ref: a repaint cannot move text through a crop that excludes the cursor row, so a changed region
 * means content moved. The band is an independent witness: authored above the burst's last line, so
 * a jump puts it at its settled row immediately, an honoured scroll brings it there after the
 * window, and a slower scroll has not brought it there yet.
 *
 * A target is `supported` only when the band arrives (absent at the first band capture, present at
 * the second) and the witness changed, while the jump control stayed identical. A band present in
 * the target's first band capture, inside the throttled window, is `unsupported`: the terminal put
 * the final content there without honouring the rate. The band capture's own time decides the
 * window, so a slow witness read cannot smuggle a late band into an early bound. Everything else is
 * `inconclusive` with a named reason: the band has not arrived, the band contradicts the witness,
 * the control moved, the first band capture landed after the window could have finished, or the
 * frames were cropped from different rectangles.
 */
async function decsscls(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
  const captureCallback = ctx.capture
  if (!captureCallback) {
    return notTestedResult(
      "DECSSCLS needs rendered frames; this context exposes no pixel capture callback (a text-only arm keeps its buffer, not its viewport)",
      { capture: false },
    )
  }
  const frames: ObservationFrame[] = []
  const rows = ctx.rows
  if (!Number.isSafeInteger(rows) || rows < 1) {
    return notTestedResult("DECSSCLS needs a measured screen height to force a real scroll", {
      rows,
    })
  }
  if (rows < 2) {
    return notTestedResult(
      "DECSSCLS needs at least two rows: its witness sits ABOVE the cursor row, and a one-row screen has no row above it",
      { rows },
    )
  }
  if (rows < 10) {
    return notTestedResult(
      "DECSSCLS marker needs a measured screen of at least 10 rows to place a band above the cursor",
      { rows },
    )
  }
  const cols = ctx.cols
  const geometry = ctx.captureGeometry?.geometry
  if (!Number.isSafeInteger(cols) || cols < 1 || geometry === undefined) {
    const refusal = ctx.captureGeometryRefusal
    return notTestedResult(
      refusal === undefined
        ? "DECSSCLS needs a measured pixel geometry to digest a cell region"
        : `DECSSCLS needs a measured pixel geometry to digest a cell region; this run refused capture geometry: ${refusal}`,
      {
        rows,
        cols,
        geometry: geometry !== undefined,
        ...(refusal !== undefined && { captureGeometryRefusal: refusal }),
      },
    )
  }
  const priorMode = await ctx.queryMode(4)
  const restoreMode = priorMode === "set" ? DECSSCLM_SMOOTH : DECSSCLM_JUMP
  const restoredDecsclm =
    priorMode === "set"
      ? "smooth (CSI ?4h), as read before the probe"
      : priorMode === "reset"
        ? "jump (CSI ?4l), as read before the probe"
        : "jump (CSI ?4l); prior DECSCLM unknown, restored reset"
  const burst = decssclsBurst(rows, cols)
  // The clear and home fill the first `rows` lines without scrolling, so only the rest line-feeds
  // scroll. The window counts those scrolls, not the burst length.
  const scrolledLines = Math.max(1, burst.lines - rows + 1)
  const throttledDurationMs = Math.ceil((scrolledLines / DECSSCLS_LINES_PER_SECOND) * 1000)
  const witness = decssclsWitness(rows, cols)
  // The burst's last authored line settles on the cursor row, so the band's settled row is its
  // authored line minus every line the burst scrolled off the top. That is `rows - 8` by design;
  // deriving it from the bytes keeps the reference sample and the capture on the row the burst
  // actually paints, including the trailing line feed's own scroll.
  const markerRow = burst.markerLine - scrolledLines
  const markerCells = { top: markerRow, left: 1, bottom: markerRow, right: cols }
  const captureRegion = async (
    role: ObservationFrame["role"],
    label: string,
    cells: CaptureCells,
  ): Promise<{ cells: string; rectangle: CaptureRectangle; ref: string }> => {
    const frame = await captureCallback({ role, label, cells, pixelGeometry: geometry })
    frames.push(frame)
    if (frame.kind === "text-cells") {
      throw new Error(
        `${label}: DECSSCLS reads presentation speed from pixels; the capture adapter returned a text-cells frame, whose buffer can jump while the viewport still scrolls`,
      )
    }
    const digests = frameDigests(frame)
    if (digests.cells === undefined || digests.whole === undefined || frame.regionRectangle === undefined) {
      throw new Error(
        `${label}: the capture adapter returned a pixels frame with no digest for the requested cells (cells ${String(digests.cells)}, whole ${String(digests.whole)}, rectangle ${String(frame.regionRectangle)})`,
      )
    }
    return { cells: digests.cells, rectangle: frame.regionRectangle, ref: frame.ref }
  }
  const capture = (role: ObservationFrame["role"], label: string) => captureRegion(role, label, witness)
  const captureBand = (role: ObservationFrame["role"], label: string) => captureRegion(role, label, markerCells)
  let markerRef = ""
  const phase = async (
    role: ObservationFrame["role"],
    setting: string,
    label: string,
    settleMs: number,
  ): Promise<DecssclsPair> => {
    ctx.write(DECSSCLM_SMOOTH)
    const startedAt = performance.now()
    ctx.write("\x1b[?1049h\x1b[2J\x1b[H" + setting + burst.text)
    const first = await capture(role, `${label} t0`)
    const firstElapsedMs = performance.now() - startedAt
    const firstBand = await captureBand(role, `${label} t0 band`)
    const firstBandElapsedMs = performance.now() - startedAt
    await new Promise<void>((resolve) => {
      setTimeout(resolve, settleMs)
    })
    const second = await capture(role, `${label} t1`)
    const secondBand = await captureBand(role, `${label} t1 band`)
    const sameRectangle =
      first.rectangle.x === second.rectangle.x &&
      first.rectangle.y === second.rectangle.y &&
      first.rectangle.width === second.rectangle.width &&
      first.rectangle.height === second.rectangle.height
    return {
      sameRectangle,
      changed: first.cells !== second.cells,
      digests: [first.cells, second.cells],
      firstElapsedMs,
      firstBandElapsedMs,
      screenshotRef: second.ref,
      rectangles: [first.rectangle, second.rectangle],
      band: [firstBand.cells === markerRef, secondBand.cells === markerRef],
      bandDigests: [firstBand.cells, secondBand.cells],
    }
  }
  const restored =
    "CSI 0 SP p, and DECSCLM restored to the mode read before the probe; the DECSSCLS speed itself is not queryable"
  try {
    ctx.write("\x1b[?1049h\x1b[2J\x1b[H" + "\r\n".repeat(markerRow - 1) + decssclsBand(cols) + "\r\n")
    markerRef = (await captureBand("control", "DECSSCLS marker reference")).cells
    const control = await phase("control", DECSSCLS_JUMP, "DECSSCLS jump control", DECSSCLS_SETTLE_MS)
    const target = await phase(
      "target",
      DECSSCLS_SLOW,
      "DECSSCLS 9 lines per second",
      throttledDurationMs + DECSSCLS_SETTLE_MARGIN_MS,
    )
    const timingBoundMs = throttledDurationMs - DECSSCLS_TIMING_MARGIN_MS
    const bandInsideWindow = target.firstBandElapsedMs <= timingBoundMs
    const observed = {
      controlChanged: control.changed,
      targetChanged: target.changed,
      controlFirstElapsedMs: control.firstElapsedMs,
      targetFirstElapsedMs: target.firstElapsedMs,
      controlFirstBandElapsedMs: control.firstBandElapsedMs,
      targetFirstBandElapsedMs: target.firstBandElapsedMs,
      settleMs: DECSSCLS_SETTLE_MS,
      targetSettleMs: throttledDurationMs + DECSSCLS_SETTLE_MARGIN_MS,
      lines: burst.lines,
      scrolledLines,
      rows,
      throttledDurationMs,
      timingBoundMs,
      decssclm: {
        prior: priorMode ?? "none",
        setForBothPhases: "CSI ?4h",
        restored: restoredDecsclm,
      },
      regionDigests: {
        control: control.digests,
        target: target.digests,
      },
      rectangles: {
        control: control.rectangles,
        target: target.rectangles,
      },
      marker: {
        settledRow: markerRow,
        reference: markerRef,
        control: control.band,
        target: target.band,
        digests: {
          control: control.bandDigests,
          target: target.bandDigests,
        },
      },
      restored,
    }
    const response = JSON.stringify(observed)
    if (!control.sameRectangle || !target.sameRectangle) {
      const note =
        "Frames were cropped from different rectangles, so their digests do not compare; the capture arm must place the same region for both frames"
      return {
        pass: false,
        response,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          assertionType: "screenshot",
          screenshotRef: target.screenshotRef,
          frames,
          note,
        },
      }
    }
    if (control.changed || !control.band[0] || !control.band[1]) {
      const note = control.changed
        ? "The jump control moved between two frames of the same screen: this arm's region digest is not stable across an unchanged screen, so no target pair can be read"
        : "The marker band was not at its settled row in both jump-control frames: this arm's band capture is not stable across an unchanged screen, so no target pair can be read"
      return {
        pass: false,
        response,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          assertionType: "screenshot",
          screenshotRef: target.screenshotRef,
          frames,
          note,
        },
      }
    }
    if (!bandInsideWindow) {
      const note = `The target's marker band was first captured after ${Math.round(target.firstBandElapsedMs)} ms, outside the ${throttledDurationMs} ms throttled window (-${DECSSCLS_TIMING_MARGIN_MS} ms margin), so its arrival cannot be placed inside the window and the pair cannot grade it`
      return {
        pass: false,
        response,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          assertionType: "screenshot",
          screenshotRef: target.screenshotRef,
          frames,
          note,
        },
      }
    }
    if (target.band[0]) {
      const note = `The marker band was already at its settled row in the target's first band capture, ${Math.round(target.firstBandElapsedMs)} ms in and inside the ${throttledDurationMs} ms window a throttled scroll would still be running in; the terminal put the content there without honouring the rate`
      return {
        pass: false,
        response,
        observation: {
          outcome: "unsupported",
          assertionType: "screenshot",
          screenshotRef: target.screenshotRef,
          frames,
          note,
        },
        assertions: [{ assertionType: "screenshot" as const, kind: "negative", expected: note, observed: response }],
      }
    }
    if (target.band[1] && target.changed) {
      const note = `The marker band reached its settled row between the two target frames and text moved through the witness region, while the jump control stayed identical and the band's first capture landed inside the ${throttledDurationMs} ms window`
      return {
        pass: true,
        response,
        observation: {
          outcome: "supported",
          assertionType: "screenshot",
          screenshotRef: target.screenshotRef,
          frames,
          note,
        },
        assertions: [{ assertionType: "screenshot" as const, kind: "positive", expected: note, observed: response }],
      }
    }
    const note = target.band[1]
      ? "The marker band was at its settled row in the second target frame but the witness region was identical, so the band and the region digest contradict each other and the pair cannot grade"
      : `The marker band had not reached its settled row ${DECSSCLS_SETTLE_MARGIN_MS} ms after the ${throttledDurationMs} ms throttled window closed; a scroll slower than the requested rate is not evidence that the setting was ignored`
    return {
      pass: false,
      response,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        assertionType: "screenshot",
        screenshotRef: target.screenshotRef,
        frames,
        note,
      },
    }
  } finally {
    ctx.write(DECSSCLS_SLOW + restoreMode + "\x1b[?1049l\x1b[0m")
  }
}

export const modesProbes: ProbeDefinition[] = [
  // Alt screen enter — measured roundtrip (narrow CTO-approved 1049 slice)
  decrpmModeProbe("modes.alt-screen.enter", 1049, (ctx) =>
    altScreenRoundtrip(
      ctx,
      ALT_SCREEN_1049,
      "enter",
      "CSI ? 1049 h switches to a cleared alternate buffer (full seeded roundtrip)",
    ),
  ),

  // Alt screen exit
  {
    ...probe(
      "modes.alt-screen.exit",
      (ctx) =>
        altScreenRoundtrip(
          ctx,
          ALT_SCREEN_1049,
          "exit",
          "CSI ? 1049 l restores the primary buffer and the saved cursor",
        ),
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 3 || ctx.cols < 3) {
          return {
            pass: false,
            tests: [
              {
                id: "criterion",
                status: "test-todo",
                reason: `Alt-screen exit fixture needs at least 3x3, measured ${ctx.rows}x${ctx.cols}`,
              },
            ],
          }
        }
        const refusal = captureRefusal(ctx, 3, 8, "Alt-screen exit")
        if (refusal) return refusal
        if (ctx.capture || ctx.cells) {
          return primaryRestoreCapture(ctx, "modes.alt-screen.exit", 1049, "PRIMARY", "ALTONLY")
        }
        ctx.write("\x1b[?1049h") // enter
        try {
          ctx.write("\x1b[3;3H") // move somewhere in alt
        } finally {
          ctx.write("\x1b[?1049l") // exit the fixture's alt screen
        }
        const pos = await ctx.queryCursorPosition()
        if (!pos) {
          return { pass: false, tests: [{ id: "criterion", status: "test-failure", reason: "no-response" }] }
        }
        return {
          pass: false,
          response: JSON.stringify(pos),
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            assertionType: "query_reply",
            note: "Cursor responsiveness after exit does not measure the restored buffer",
          },
        }
      },
    ),
    termNeedsGeometry: true,
    cellReadback: true,
    textClaim: "characters",
  },

  // Bracketed paste
  decrpmModeProbe("modes.bracketed-paste", 2004, headlessDecrpmArm(2004, "bracketedPaste")),

  // Application cursor keys
  decrpmModeProbe("modes.application-cursor", 1, headlessDecrpmArm(1, "applicationCursor")),

  // Auto wrap
  decrpmModeProbe("modes.auto-wrap", 7, (ctx) => {
    const expected = "DECAWM wraps Y after a full measured row of X"
    const rows = ctx.getScrollback().screenLines
    if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 2 || !Number.isSafeInteger(rows) || rows < 2) {
      return parserStateResult(null, expected, { rows, cols: ctx.cols }, "Measured grid needs two rows")
    }
    const originallyEnabled = ctx.getMode("autoWrap")
    try {
      ctx.feed("\x1b[?7h")
      const enabled = ctx.getMode("autoWrap")
      // #30574: unreported mode metadata is null; measured cells can still decide.
      if (enabled === false) {
        return parserStateResult(null, expected, { originallyEnabled, enabled }, "Auto-wrap setup was not measured")
      }
      ctx.feed("X".repeat(ctx.cols) + "Y")
      const last = ctx.getCell(0, ctx.cols - 1)
      const next = ctx.getCell(1, 0)
      return parserStateResult(last.char === "X" && next.char === "Y", expected, {
        rows,
        cols: ctx.cols,
        originallyEnabled,
        enabled,
        last,
        next,
      })
    } finally {
      // #30574: the runtime getter can be null despite its current boolean type.
      if (originallyEnabled !== null) ctx.feed(originallyEnabled ? "\x1b[?7h" : "\x1b[?7l")
    }
  }),

  // Mouse tracking
  decrpmModeProbe("modes.mouse-tracking", 1000, headlessDecrpmArm(1000, "mouseTracking")),

  // Focus tracking
  decrpmModeProbe("modes.focus-tracking", 1004, headlessDecrpmArm(1004, "focusTracking")),

  // Reverse video
  decrpmModeProbe("modes.reverse-video", 5, (ctx) => {
    ctx.feed("\x1b[?5h")
    const note = "rendered colors (pixels)"
    return reviewResult(HEADLESS_OBSERVABLE_REVIEW, `Headless observable review required: ${note}`, note, {
      mode: ctx.getMode("reverseVideo"),
    })
  }),

  // Synchronized output
  decrpmModeProbe("modes.synchronized-output", 2026, (ctx) => {
    ctx.feed("\x1b[?2026h")
    ctx.feed("Hello")
    ctx.feed("\x1b[?2026l")
    const note = "frame timing"
    return reviewResult(HEADLESS_OBSERVABLE_REVIEW, `Headless observable review required: ${note}`, note, {
      text: ctx.getText(),
    })
  }),

  // Origin mode
  ...regionReadbackProbes(modesReadbackRows),

  // Insert/replace mode (IRM)
  {
    ...probe(
      "modes.insert-replace",
      (ctx) => {
        const expected = "IRM inserts X before measured ABC instead of replacing A"
        const rows = ctx.getScrollback().screenLines
        if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 4 || !Number.isSafeInteger(rows) || rows < 1) {
          return parserStateResult(null, expected, { cols: ctx.cols, rows }, "IRM fixture needs at least 1x4")
        }
        ctx.feed("\x1b[4l\x1b[1;1H\x1b[2KABC")
        const seed = Array.from({ length: 4 }, (_, col) => ctx.getCell(0, col).char)
        ctx.feed("\x1b[1;1H")
        const origin = ctx.getCursor()
        if (
          seed[0] !== "A" ||
          seed[1] !== "B" ||
          seed[2] !== "C" ||
          !isBlank(seed[3] ?? "\0") ||
          origin.x !== 0 ||
          origin.y !== 0
        ) {
          return parserStateResult(null, expected, { seed, origin }, "Cannot verify IRM seed and cursor origin")
        }
        try {
          ctx.feed("\x1b[4h")
          ctx.feed("X")
          const after = Array.from({ length: 4 }, (_, col) => ctx.getCell(0, col).char)
          const inserted = after[0] === "X" && after[1] === "A" && after[2] === "B" && after[3] === "C"
          const replaced = after[0] === "X" && after[1] === "B" && after[2] === "C" && isBlank(after[3] ?? "\0")
          return parserStateResult(
            inserted ? true : replaced ? false : null,
            expected,
            { seed, origin, after },
            inserted || replaced ? undefined : "Measured cells match neither insertion nor replacement",
          )
        } finally {
          ctx.feed("\x1b[4l")
        }
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 1 || ctx.cols < 5) {
          return {
            pass: false,
            tests: [
              {
                id: "criterion",
                status: "test-todo",
                reason: `Insert-replace fixture needs at least 1x5, measured ${ctx.rows}x${ctx.cols}`,
              },
            ],
          }
        }
        const refusal = captureRefusal(ctx, 1, 6, "Insert/replace")
        if (refusal) return refusal
        // IRM is ANSI mode 4; DECRQM (`CSI 4 $ p`) reports it without reading cells.
        // A complete report decides the claim; no report falls through to the cell fixture below.
        let on: DecrpmPs | null
        try {
          ctx.write("\x1b[4h")
          on = await queryDecrpm(ctx, 4, "ansi")
        } finally {
          ctx.write("\x1b[4l")
        }
        if (on !== null && on !== 0) {
          const off = await queryDecrpm(ctx, 4, "ansi")
          if (off !== null && off !== 0) {
            // The stored reading keeps the Ps (#30557 r2): a permanent state (Ps 3 or 4) fails the toggle.
            const ok = (on === 1 || on === 3) && (off === 2 || off === 4)
            return {
              pass: ok,
              response: JSON.stringify({ on: decrpmReading(on), off: decrpmReading(off) }),
              observation: ok
                ? { outcome: "supported", assertionType: "query_reply" }
                : { outcome: "unsupported", assertionType: "query_reply" },
              assertions: [
                {
                  assertionType: "query_reply" as const,
                  kind: ok ? "positive" : "negative",
                  expected: "DECRQM mode 4 reports set after CSI 4 h and reset after CSI 4 l",
                  observed: `${decrpmReading(on)} -> ${decrpmReading(off)}`,
                },
              ],
            }
          }
        }
        if (ctx.capture || ctx.cells) {
          const reset = "\x1b[4l\x1b[0m\x1b[2J\x1b[H"
          const result = await captureRegionVerdict(
            ctx,
            "modes.insert-replace",
            {
              region: { top: 1, left: 1, bottom: 1, right: 5 },
              sentinel: { row: 2, col: 1 },
              cursorRow: 3,
              minRows: 3,
              minCols: 6,
              seed: `${reset}XBCD`,
              edit: `${reset}ABCD\x1b[1;1H\x1b[4hX\x1b[4l`,
              expected: `${reset}XABCD`,
              ignored: `${reset}XBCD`,
              ...(ctx.captureKind !== "text-cells" && {
                discriminator: { signal: "inserted-cells", expected: "change" as const },
              }),
              cleanup: "\x1b[4l",
              timeoutMs: DEFAULT_TIMEOUT_MS,
            },
            true,
          )
          if (!result) throw new Error("modes.insert-replace: owned capture disappeared")
          return result
        }
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("ABCD")
        ctx.write("\x1b[1;2H") // move to col 2
        ctx.write("\x1b[4h") // enable insert mode
        try {
          ctx.write("X")
        } finally {
          ctx.write("\x1b[4l") // disable this fixture's insert mode
        }
        const pos = await ctx.queryCursorPosition()
        if (!pos) {
          return { pass: false, tests: [{ id: "criterion", status: "test-failure", reason: "no-response" }] }
        }
        return {
          pass: false,
          response: JSON.stringify(pos),
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            assertionType: "query_reply",
            note: "Cursor advance does not measure whether X displaced the existing cells",
          },
        }
      },
    ),
    termNeedsGeometry: true,
    cellReadback: true,
    textClaim: "characters",
  },

  // SGR mouse encoding
  decrpmModeProbe("modes.mouse-sgr", 1006, headlessDecrpmArm(1006, "sgrMouse")),

  // All-motion mouse tracking
  decrpmModeProbe("modes.mouse-all", 1003, headlessDecrpmArm(1003, "mouseTracking")),

  // Application keypad: DECKPAM then KP_5 encoding (SS3 u vs 5)
  probe(
    "modes.application-keypad",
    (ctx) => {
      ctx.feed("\x1b=")
      const onMode = ctx.getMode("applicationKeypad")
      // #30574: retain unknown runtime mode state until the public type is widened.
      const on = onMode === null ? null : onMode === true
      ctx.feed("\x1b>")
      const offMode = ctx.getMode("applicationKeypad")
      // #30574: unknown is not a measured failure to disable the mode.
      const off = offMode === null ? null : offMode === false
      return osInputReviewResult("keypad input", { on, off })
    },
    applicationKeypad,
    "input_bytes",
  ),

  // Left/right margin mode
  {
    ...probe(
      "modes.left-right-margin",
      (ctx) => leftRightMarginHeadless(ctx),
      async (ctx) => {
        const refusal = captureRefusal(ctx, 2, 8, "Left/right margin")
        if (refusal) return refusal
        if (ctx.capture) {
          const reset = "\x1b[?69h\x1b[s\x1b[?69l\x1b[?7h\x1b[0m\x1b[2J\x1b[H"
          const result = await captureRegionVerdict(ctx, "modes.left-right-margin", {
            region: { top: 2, left: 3, bottom: 2, right: 3 },
            sentinel: { row: 3, col: 1 },
            cursorRow: 4,
            minRows: 4,
            minCols: 8,
            seed: `${reset}ABCDE`,
            edit: `${reset}\x1b[?69h\x1b[3;6s\x1b[1;3HABCDE\x1b[s\x1b[?69l`,
            expected: `${reset}\x1b[2;3HE`,
            ignored: reset,
            discriminator: { signal: "margin-wrap", expected: "change" },
            cleanup: "\x1b[?69h\x1b[s\x1b[?69l\x1b[?7h",
            timeoutMs: DEFAULT_TIMEOUT_MS,
          })
          if (!result) throw new Error("modes.left-right-margin: owned capture disappeared")
          return result
        }
        return {
          pass: false,
          tests: [
            {
              id: "criterion",
              status: "test-todo",
              reason: "Margin mode left unchanged; this probe does not measure left/right margin behavior",
            },
          ],
        }
      },
    ),
    termNeedsGeometry: true,
  },

  // ?47 — legacy alt screen (no cursor save)
  {
    ...probe(
      "modes.altscreen-47",
      (ctx) => altScreenRoundtrip(ctx, ALT_SCREEN_47, "roundtrip", "?47 swaps the visible screen buffer"),
      async (ctx) => {
        const refusal = captureRefusal(ctx, 1, 8, "?47 alternate screen")
        if (refusal) return refusal
        if (ctx.capture) return primaryRestoreCapture(ctx, "modes.altscreen-47", 47, "MAIN47", "ALT47")
        return {
          pass: false,
          tests: [
            {
              id: "criterion",
              status: "test-todo",
              reason: "Alternate buffer left unchanged; this probe does not measure its visible contents",
            },
          ],
        }
      },
    ),
    termNeedsGeometry: true,
  },

  // ?1047 — alt screen; DECRST 1047 clears the alternate buffer on EXIT (headless: graded by a second entry)
  {
    ...probe(
      "modes.altscreen-1047",
      (ctx) =>
        altScreenRoundtrip(ctx, ALT_SCREEN_1047, "roundtrip", "?1047 swaps and clears the visible alternate buffer"),
      async (ctx) => {
        const refusal = captureRefusal(ctx, 3, 8, "?1047 alternate screen")
        if (refusal) return refusal
        if (ctx.capture || ctx.cells) {
          return primaryRestoreCapture(ctx, "modes.altscreen-1047", 1047, "MAIN47", "ALT1047")
        }
        const ps = await queryDecrpm(ctx, 1047)
        // Ps 4 says the terminal knows 1047 and cannot set it: the shared grader marks it unsupported (#30557 r2).
        if (ps === 4) return decrpmResult(ps, 1047)
        return {
          pass: false,
          ...(ps !== null && { response: decrpmReading(ps) }),
          ...(ps === null
            ? {
                tests: [
                  {
                    id: "criterion",
                    status: "test-failure",
                    reason:
                      ps === null
                        ? "No DECRPM reply; alternate-buffer clearing was not measured"
                        : "DECRPM status does not measure alternate-buffer clearing",
                  },
                ] as [{ id: string; status: "test-failure"; reason: string }],
              }
            : {
                observation: {
                  outcome: "inconclusive",
                  reason: ps === null ? "no-response" : "insufficient-evidence",
                  assertionType: "query_reply",
                  note:
                    ps === null
                      ? "No DECRPM reply; alternate-buffer clearing was not measured"
                      : "DECRPM status does not measure alternate-buffer clearing",
                },
              }),
        }
      },
      "query_reply",
    ),
    termNeedsGeometry: true,
    cellReadback: true,
    textClaim: "characters",
  },

  // ?1048 — save/restore cursor only (no alt screen)
  {
    ...probe(
      "modes.altscreen-1048",
      (ctx) => {
        const expected = "?1048 restores saved cursor from 15;20 to 5;10"
        const rows = ctx.getScrollback().screenLines
        if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(ctx.cols) || rows < 15 || ctx.cols < 20) {
          return parserStateResult(null, expected, { rows, cols: ctx.cols }, "Cursor-save fixture needs at least 15x20")
        }
        ctx.feed("\x1b[5;10H") // row 5, col 10 (1-based) — termless 0-based: y=4, x=9
        const before = { ...ctx.getCursor() }
        if (before.y !== 4 || before.x !== 9) {
          return parserStateResult(
            null,
            expected,
            { before },
            "Cursor-save fixture did not establish its start position",
          )
        }
        ctx.feed("\x1b[?1048h") // save
        let displaced: ReturnType<typeof ctx.getCursor>
        try {
          ctx.feed("\x1b[15;20H")
          displaced = { ...ctx.getCursor() }
          if (displaced.y !== 14 || displaced.x !== 19) {
            return parserStateResult(
              null,
              expected,
              { before, displaced },
              "Cursor-save fixture did not measure displacement",
            )
          }
        } finally {
          ctx.feed("\x1b[?1048l") // restore this fixture's saved cursor
        }
        const after = ctx.getCursor()
        return parserStateResult(after.y === 4 && after.x === 9, expected, {
          before,
          displaced,
          after,
        })
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 15 || ctx.cols < 20) {
          return {
            pass: false,
            tests: [
              {
                id: "criterion",
                status: "test-todo",
                reason: `Cursor-save fixture needs at least 15x20, measured ${ctx.rows}x${ctx.cols}`,
              },
            ],
          }
        }
        ctx.write("\x1b[5;10H") // row 5, col 10
        const before = await ctx.queryCursorPosition()
        if (!before || before.row !== 5 || before.col !== 10) {
          return {
            pass: false,
            ...(before === null
              ? {
                  tests: [
                    {
                      id: "criterion",
                      status: "test-failure",
                      reason: "Cursor-save fixture did not establish its start position",
                    },
                  ] as [{ id: string; status: "test-failure"; reason: string }],
                }
              : {
                  observation: {
                    outcome: "inconclusive",
                    reason: before ? "insufficient-evidence" : "no-response",
                    assertionType: "query_reply",
                    note: "Cursor-save fixture did not establish its start position",
                  },
                }),
          }
        }
        ctx.write("\x1b[?1048h") // save
        let displaced: { row: number; col: number } | null = null
        try {
          ctx.write("\x1b[15;20H") // move
          displaced = await ctx.queryCursorPosition()
          if (!displaced || displaced.row !== 15 || displaced.col !== 20) {
            return {
              pass: false,
              ...(displaced === null
                ? {
                    tests: [
                      {
                        id: "criterion",
                        status: "test-failure",
                        reason: "Cursor-save fixture did not measure displacement",
                      },
                    ] as [{ id: string; status: "test-failure"; reason: string }],
                  }
                : {
                    observation: {
                      outcome: "inconclusive",
                      reason: displaced ? "insufficient-evidence" : "no-response",
                      assertionType: "query_reply",
                      note: "Cursor-save fixture did not measure displacement",
                    },
                  }),
            }
          }
        } finally {
          ctx.write("\x1b[?1048l") // restore this fixture's saved cursor
        }
        const pos = await ctx.queryCursorPosition()
        if (!pos) {
          return { pass: false, tests: [{ id: "criterion", status: "test-failure", reason: "no-response" }] }
        }
        const measured = { before, displaced, after: pos }
        const pass = pos.row === 5 && pos.col === 10
        return {
          pass,
          response: JSON.stringify(measured),
          observation: { outcome: pass ? "supported" : "unsupported", assertionType: "query_reply" },
          assertions: [
            {
              assertionType: "query_reply" as const,
              kind: pass ? "positive" : "negative",
              expected: "?1048 restores cursor from 15;20 to 5;10",
              observed: JSON.stringify(measured),
            },
          ],
        }
      },
    ),
    termNeedsGeometry: true,
  },

  // ?1007 — alt-scroll: wheel-as-cursor-keys on alt-screen (decided-row move off DECRPM)
  probe(
    "modes.alt-scroll-1007",
    () => osInputReviewResult("OS-level XTEST wheel injection", { input: false }),
    altScroll1007,
    "input_bytes",
  ),

  // ?1005 — UTF-8 mouse encoding (legacy)
  decrpmModeProbe("modes.utf8-mouse-1005", 1005, headlessDecrpmArm(1005)),

  // ?3 — DECCOLM 80/132 column switch
  decrpmModeProbe("modes.deccolm", 3, (ctx) => {
    const before = ctx.feedCapture("\x1b[18t")
    if (before.length === 0) return notTestedResult("18t unanswered", { before })
    const geometryReply = /\x1b\[8;([1-9][0-9]*);([1-9][0-9]*)t/
    const initial = geometryReply.exec(before)
    const initialCols = Number(initial?.[2])
    if (!initial || !Number.isSafeInteger(Number(initial[1])) || !Number.isSafeInteger(initialCols)) {
      return {
        pass: false,
        response: JSON.stringify({ before }),
        observation: {
          outcome: "inconclusive",
          assertionType: "query_reply",
          reason: "invalid-reply",
          note: "Initial 18t did not return a complete positive row/column geometry",
        },
      }
    }
    if (initialCols !== 80 && initialCols !== 132) {
      return {
        pass: false,
        response: JSON.stringify({ before }),
        observation: {
          outcome: "inconclusive",
          assertionType: "query_reply",
          reason: "insufficient-evidence",
          note: "DECCOLM requires an initial measured width of 80 or 132 columns",
        },
      }
    }

    const targetCols = initialCols === 80 ? 132 : 80
    const change = initialCols === 80 ? "\x1b[?3h" : "\x1b[?3l"
    const restore = initialCols === 80 ? "\x1b[?3l" : "\x1b[?3h"
    // Open the 80/132 policy gate before measuring the effect. The collector destroys this
    // probe's disposable backend; no unavailable prior ?40 state is invented for cleanup.
    ctx.feed("\x1b[?40h")
    let enabled: string
    try {
      ctx.feed(change)
      enabled = ctx.feedCapture("\x1b[18t")
    } finally {
      ctx.feed(restore)
    }
    const restored = ctx.feedCapture("\x1b[18t")
    const response = JSON.stringify({ before, enabled, restored })
    const measured = [enabled, restored].map((reply) => geometryReply.exec(reply))
    if (
      measured.some(
        (match) => !match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2])),
      )
    ) {
      return {
        pass: false,
        response,
        observation: {
          outcome: "inconclusive",
          assertionType: "query_reply",
          reason: enabled.length === 0 || restored.length === 0 ? "no-response" : "invalid-reply",
          note: "DECCOLM did not measure complete enabled and restored 18t geometry",
        },
      }
    }
    const pass = Number(measured[0]?.[2]) === targetCols && Number(measured[1]?.[2]) === initialCols
    return {
      pass,
      response,
      observation: { outcome: pass ? "supported" : "unsupported", assertionType: "query_reply" },
      assertions: [
        {
          assertionType: "query_reply",
          kind: pass ? "positive" : "negative",
          expected: `DECCOLM changes measured columns ${initialCols} -> ${targetCols} -> ${initialCols} after ?40 is enabled`,
          observed: response,
        },
      ],
    }
  }),

  // ?4 — DECSCLM needs presentation timing, not mode recognition or final parser state.
  decrpmModeProbe("modes.decsclm", 4, () => {
    const note = "DECSCLM requires presentation timing capture"
    return reviewResult(HEADLESS_OBSERVABLE_REVIEW, `Headless observable review required: ${note}`, note, {
      presentation: false,
    })
  }),

  // Mode 2031 — color scheme reporting (dark/light mode notifications)
  // Adopted by: iTerm2, tmux 3.6, Contour, foot, kitty
  {
    ...probe(
      "modes.color-scheme-reporting",
      () => {
        const note = "Mode 2031 requires a host palette actuator and persistent unsolicited-event listener"
        return reviewResult(HEADLESS_OBSERVABLE_REVIEW, `Headless observable review required: ${note}`, note, {
          paletteActuator: false,
          persistentListener: false,
        })
      },
      async (ctx) => {
        const ps = await queryDecrpm(ctx, 2031)
        // Ps 4 says the terminal knows the mode and cannot set it: unsupported, as decrpmResult grades it (#30557).
        const recognized = ps === 1 || ps === 2 || ps === 3
        const note =
          ps === null
            ? "No DECRPM 2031 reply; update events were not tested"
            : ps === 0
              ? "DECRPM 2031 explicitly unrecognized"
              : ps === 4
                ? "DECRPM 2031 permanently reset (Ps 4); the terminal cannot set it"
                : `DECRPM 2031 recognized (${decrpmReading(ps)}); update events were not tested`
        if (ps === null) {
          return {
            pass: recognized,
            note,
            response: undefined,
            tests: [{ id: "criterion", status: "test-failure", reason: note }],
          }
        }
        return {
          pass: recognized,
          note,
          response: ps === null ? undefined : decrpmReading(ps),
          observation: {
            outcome: ps === null ? "inconclusive" : recognized ? "supported" : "unsupported",
            assertionType: "query_reply",
            ...(ps === null && { reason: "no-response" as const }),
            note,
          },
          ...(ps !== null && {
            assertions: [
              {
                assertionType: "query_reply" as const,
                kind: recognized ? ("positive" as const) : ("negative" as const),
                // Ps 4 is recognized and cannot be set: the assertion names that, as decrpmResult does (@dev/2 72304b0e).
                expected:
                  ps === 4 ? "DECRPM mode 2031 can be set" : "DECRPM 2031 recognizes color-scheme reporting mode",
                observed: decrpmReading(ps),
              },
            ],
          }),
        }
      },
      "query_reply",
    ),
    termWrites: "query",
  },

  // XTPUSHSGR — push SGR stack (CSI # {)
  // Headless: cell read-back of the push/pop roundtrip; terminal: pixel capture of the same frame.
  {
    ...probe(
      "modes.xtpushsgr",
      (ctx) => xtSgrStackHeadless(ctx, "modes.xtpushsgr", "XTPUSHSGR (CSI # {) then XTPOPSGR"),
      async (ctx) => {
        if (ctx.capture) return xtSgrStackCapture(ctx, "modes.xtpushsgr", "XTPUSHSGR (CSI # {) then XTPOPSGR")
        ctx.write("\x1b[#{")
        try {
          const pos = await ctx.queryCursorPosition()
          if (!pos) {
            return { pass: false, tests: [{ id: "criterion", status: "test-failure", reason: "no-response" }] }
          }
          return {
            pass: false,
            response: JSON.stringify(pos),
            tests: [
              {
                id: "criterion",
                status: "test-todo",
                reason: `Cursor responsiveness does not measure saved/restored state${ctx.captureGeometryRefusal ? `; Pixel capture unavailable: ${ctx.captureGeometryRefusal}` : ""}`,
              },
            ],
          }
        } finally {
          ctx.write("\x1b[#}") // pop to clean up
        }
      },
    ),
    termNeedsGeometry: true,
  },

  // XTPOPSGR — pop SGR stack (CSI # })
  // Push first so the pop is meaningful; both arms grade the roundtrip, never responsiveness.
  {
    ...probe(
      "modes.xtpopsgr",
      (ctx) => xtSgrStackHeadless(ctx, "modes.xtpopsgr", "XTPOPSGR (CSI # }) after a push"),
      async (ctx) => {
        if (ctx.capture) return xtSgrStackCapture(ctx, "modes.xtpopsgr", "XTPOPSGR (CSI # }) after a push")
        ctx.write("\x1b[#{")
        ctx.write("\x1b[#}")
        const pos = await ctx.queryCursorPosition()
        if (!pos) {
          return { pass: false, tests: [{ id: "criterion", status: "test-failure", reason: "no-response" }] }
        }
        return {
          pass: false,
          response: JSON.stringify(pos),
          tests: [
            {
              id: "criterion",
              status: "test-todo",
              reason: `Cursor responsiveness does not measure saved/restored state${ctx.captureGeometryRefusal ? `; Pixel capture unavailable: ${ctx.captureGeometryRefusal}` : ""}`,
            },
          ],
        }
      },
    ),
    termNeedsGeometry: true,
  },

  // XTSAVE — save DEC private modes (CSI ? Pm s). Use DECAWM (mode 7) — universally supported.
  {
    ...probe(
      "modes.xtsave",
      (ctx) => xtModeSaveHeadless(ctx, "modes.xtsave"),
      async (ctx) => {
        if (ctx.capture) return xtModeSaveCapture(ctx, "modes.xtsave")
        ctx.write("\x1b[?7s")
        try {
          const pos = await ctx.queryCursorPosition()
          if (!pos) {
            return { pass: false, tests: [{ id: "criterion", status: "test-failure", reason: "no-response" }] }
          }
          return {
            pass: false,
            response: JSON.stringify(pos),
            tests: [
              {
                id: "criterion",
                status: "test-todo",
                reason: `Cursor responsiveness does not measure saved/restored state${ctx.captureGeometryRefusal ? `; Pixel capture unavailable: ${ctx.captureGeometryRefusal}` : ""}`,
              },
            ],
          }
        } finally {
          ctx.write("\x1b[?7r") // restore to clean up
        }
      },
    ),
    termNeedsGeometry: true,
  },

  // XTRESTORE — restore DEC private modes (CSI ? Pm r). Pair with a save first.
  {
    ...probe(
      "modes.xtrestore",
      (ctx) => xtModeSaveHeadless(ctx, "modes.xtrestore"),
      async (ctx) => {
        if (ctx.capture) return xtModeSaveCapture(ctx, "modes.xtrestore")
        ctx.write("\x1b[?7s")
        ctx.write("\x1b[?7r")
        const pos = await ctx.queryCursorPosition()
        if (!pos) {
          return { pass: false, tests: [{ id: "criterion", status: "test-failure", reason: "no-response" }] }
        }
        return {
          pass: false,
          response: JSON.stringify(pos),
          tests: [
            {
              id: "criterion",
              status: "test-todo",
              reason: `Cursor responsiveness does not measure saved/restored state${ctx.captureGeometryRefusal ? `; Pixel capture unavailable: ${ctx.captureGeometryRefusal}` : ""}`,
            },
          ],
        }
      },
    ),
    termNeedsGeometry: true,
  },

  // XTPUSHCOLORS — push color palette (CSI # P)
  {
    ...probe(
      "modes.xtpushcolors",
      (ctx) => xtColorStackHeadless(ctx, "modes.xtpushcolors"),
      async (ctx) => {
        if (ctx.capture) return xtColorStackCapture(ctx, "modes.xtpushcolors")
        ctx.write("\x1b[#P")
        try {
          const pos = await ctx.queryCursorPosition()
          if (!pos) {
            return { pass: false, tests: [{ id: "criterion", status: "test-failure", reason: "no-response" }] }
          }
          return {
            pass: false,
            response: JSON.stringify(pos),
            tests: [
              {
                id: "criterion",
                status: "test-todo",
                reason: `Cursor responsiveness does not measure saved/restored state${ctx.captureGeometryRefusal ? `; Pixel capture unavailable: ${ctx.captureGeometryRefusal}` : ""}`,
              },
            ],
          }
        } finally {
          ctx.write("\x1b[#Q") // pop to clean up
        }
      },
    ),
    termNeedsGeometry: true,
  },

  // XTPOPCOLORS — pop color palette (CSI # Q). Push first so the pop is meaningful.
  {
    ...probe(
      "modes.xtpopcolors",
      (ctx) => xtColorStackHeadless(ctx, "modes.xtpopcolors"),
      async (ctx) => {
        if (ctx.capture) return xtColorStackCapture(ctx, "modes.xtpopcolors")
        ctx.write("\x1b[#P")
        ctx.write("\x1b[#Q")
        const pos = await ctx.queryCursorPosition()
        if (!pos) {
          return { pass: false, tests: [{ id: "criterion", status: "test-failure", reason: "no-response" }] }
        }
        return {
          pass: false,
          response: JSON.stringify(pos),
          tests: [
            {
              id: "criterion",
              status: "test-todo",
              reason: `Cursor responsiveness does not measure saved/restored state${ctx.captureGeometryRefusal ? `; Pixel capture unavailable: ${ctx.captureGeometryRefusal}` : ""}`,
            },
          ],
        }
      },
    ),
    termNeedsGeometry: true,
  },

  // DECSSCLS — presentation speed with no query; measured by a settled jump control and a timed
  // two-frame comparison of the same burst under the 9-lines-per-second setting.
  {
    ...probe(
      "modes.decsscls",
      () => {
        const note = "DECSSCLS controls presentation timing; the headless parser paints no frames"
        return reviewResult(HEADLESS_OBSERVABLE_REVIEW, `Headless observable review required: ${note}`, note, {
          presentation: false,
        })
      },
      decsscls,
    ),
    // The terminal arm captures timed frames and reports evidence "pixels"; the headless arm paints
    // no frames and refuses before it measures, so its method is none — the canonical declaration
    // for a refusal before measurement, the same rule input.kitty-click-events follows.
    termAssertionType: "screenshot",
    libAssertionType: null,
    termNeedsGeometry: true,
  },
]
