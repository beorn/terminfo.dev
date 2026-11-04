import type {
  CaptureCells,
  CaptureRectangle,
  ObservationFrame,
  ProbeDefinition,
  ProbeCallbackResult,
  TermProbeSource,
  LibProbeSource,
} from "./types.ts"
import { frameDigests } from "./types.ts"
import {
  probe,
  withModeSourceReview,
  replyFailure,
  decrpmModeProbe,
  headlessDecrpmArm,
  parserStateResult,
  notTestedResult,
  reviewResult,
  HEADLESS_OBSERVABLE_REVIEW,
  sameRgb,
  isBlank,
  queryDecrpm,
  decrpmReading,
  decrpmResult,
  decrpmPs,
  decrpmReplyPattern,
  sweepCellWidth,
  cellWidthTransition,
  type DecrpmPs,
  stackStateResult,
  stackVerdict,
  type StackReading,
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
        note: "alternate-screen entry not observed, so exit cannot be attributed",
      },
      assertions: [],
      tests: [
        {
          id: "entry-qualified",
          status: "test-todo",
          reason: "alternate-screen entry not observed, so exit cannot be attributed",
        },
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
 * What each push/pop row claims, one home for its headless and capture arms (#31904, @cto 6e4f7300
 * and 0613b68d). Each fixture named here is the one both arms run.
 */
const STACK_EXPECTED = {
  sgr: {
    push: "XTPUSHSGR saves the state current at push time: after set bold and italic, push, set plain, pop, bold and italic is restored",
    pop: "XTPOPSGR restores the pushed state: after set bold, push, set italic, pop, bold is restored",
  },
  mode: {
    push: "XTSAVE saves the state current at save time: after set DECAWM on, save, set DECAWM off, save, set DECAWM on, restore, DECAWM off is restored",
    pop: "XTRESTORE restores the saved state: after set DECAWM off, save, set DECAWM on, restore, DECAWM off is restored",
  },
  color: {
    push: "XTPUSHCOLORS saves the state current at push time: after set index 1 magenta, push, set index 1 green, pop, magenta is restored",
    pop: "XTPOPCOLORS restores the pushed state: after set index 1 blue, push, set index 1 green, pop, blue is restored",
  },
} as const

type CaptureSpec = Parameters<typeof captureRegionVerdict>[2]
/** A fixture's target frame read as the same-run expected frame, its ignored contrast, or neither. */
type CaptureRead = { match: "expected" | "ignored" | "other"; result: ProbeCallbackResult }

/**
 * One stack fixture through the shared capture oracle, its frames labelled with the fixture name.
 * A refusal or an unreviewed capture carries no observation; the row returns it unchanged rather
 * than reading a state from it.
 */
async function captureStackFixture(
  ctx: TermProbeSource,
  id: string,
  fixture: string,
  spec: CaptureSpec,
): Promise<CaptureRead | ProbeCallbackResult> {
  const result = await captureRegionVerdict(ctx, `${id} ${fixture}`, spec)
  if (!result) throw new Error(`${id}: owned ${fixture} capture disappeared`)
  const outcome = result.observation?.outcome
  if (outcome === undefined) return result
  return { match: outcome === "supported" ? "expected" : outcome === "unsupported" ? "ignored" : "other", result }
}

/** One row's grade from its fixture readings, with every fixture's frames kept as its evidence. */
function captureStackResult(
  operation: "push" | "pop",
  expected: string,
  readings: { pop: StackReading; push: StackReading },
  reads: readonly CaptureRead[],
  decided: { pass: boolean | null; note?: string } = stackVerdict(operation, readings.pop, readings.push),
): ProbeCallbackResult {
  const frames = reads.flatMap((read) => read.result.observation?.frames ?? [])
  const screenshotRef = reads.find((read) => read.result.observation?.screenshotRef)?.result.observation?.screenshotRef
  const observed = JSON.stringify({ ...readings, fixtures: reads.map((read) => read.result.response) })
  const evidence = { assertionType: "screenshot" as const, frames, ...(screenshotRef && { screenshotRef }) }
  if (decided.pass === null) {
    // No operation was observed, so the row is a required review (TEST TODO), never a TEST FAILURE
    // (@cto 19664c4c); every fixture's frames stay its evidence.
    const reason = decided.note ?? "no stack operation was observed"
    return {
      pass: false,
      criterionBranch: "visual-review",
      tests: [{ id: "review", status: "test-todo", reason }],
      response: observed,
      observation: { outcome: "inconclusive", reason: "insufficient-evidence", ...evidence, note: reason },
    }
  }
  const signal = `${operation}-observed`
  const status = decided.pass ? ("supported" as const) : ("unsupported" as const)
  return {
    pass: decided.pass,
    criterionBranch: signal,
    tests: [{ id: signal, status, assertionRefs: [0] }],
    response: observed,
    assertions: [{ assertionType: "screenshot", kind: decided.pass ? "positive" : "negative", expected, observed }],
    observation: { outcome: status, ...evidence, ...(decided.note && { note: decided.note }) },
  }
}

/**
 * The push and pop fixtures of a stack row, captured in that order so a stale stack keeps the POP
 * fixture's snapshot into the PUSH fixture. The PUSH fixture is compared with the earlier state
 * first; only when it matches neither that nor the push-time state is it captured again against the
 * persisted state, so every PUSH reading the verdict table needs is a measured frame.
 */
async function captureStackRow(
  ctx: TermProbeSource,
  operation: "push" | "pop",
  id: string,
  expected: string,
  popSpec: CaptureSpec,
  pushSpec: (contrast: "earlier" | "persisted") => CaptureSpec,
): Promise<ProbeCallbackResult> {
  const popRead = await captureStackFixture(ctx, id, "POP fixture", popSpec)
  if (!("match" in popRead)) return popRead
  const pop: StackReading =
    popRead.match === "expected" ? "restored" : popRead.match === "ignored" ? "persisted" : "other"
  const reads = [popRead]
  let push: StackReading = "other"
  for (const contrast of ["earlier", "persisted"] as const) {
    const pushRead = await captureStackFixture(ctx, id, `PUSH fixture (${contrast} contrast)`, pushSpec(contrast))
    if (!("match" in pushRead)) return pushRead
    reads.push(pushRead)
    push = pushRead.match === "expected" ? "restored" : pushRead.match === "ignored" ? contrast : "other"
    if (push !== "other") break
  }
  return captureStackResult(operation, expected, { pop, push }, reads)
}

/** Route stack writes through a tracker so a capture failure pops only a push that is still open. */
function trackedStack(ctx: TermProbeSource, push: string, pop: string): { ctx: TermProbeSource; open: () => boolean } {
  let pushed = false
  const split = new RegExp(`(${push.replace(/[[\]{}#]/g, "\\$&")}|${pop.replace(/[[\]{}#]/g, "\\$&")})`)
  return {
    open: () => pushed,
    ctx: {
      ...ctx,
      write(sequence) {
        for (const part of sequence.split(split)) {
          if (!part) continue
          ctx.write(part)
          if (part === push) pushed = true
          if (part === pop) pushed = false
        }
      },
    },
  }
}

/**
 * SGR-stack capture (#31904): the headless arm's two fixtures, read from the pixels of Y alone.
 * - POP fixture: bold, push, reset, italic X, pop, Y. Bold Y is restored, italic Y persisted.
 * - PUSH fixture: bold, italic, push, reset, X, pop, Y. Bold-and-italic Y is restored, bold Y the
 *   earlier state, plain Y persisted.
 * The seed is a blank region, distinct from every Y the fixtures can leave.
 */
async function xtSgrStackCapture(ctx: TermProbeSource, operation: "push" | "pop"): Promise<ProbeCallbackResult> {
  const id = operation === "push" ? "modes.xtpushsgr" : "modes.xtpopsgr"
  const refusal = captureRefusal(ctx, 5, 6, id)
  if (refusal) return refusal
  const stack = trackedStack(ctx, "\x1b[#{", "\x1b[#}")
  try {
    const reset = "\x1b[0m\x1b[2J\x1b[H"
    const paintY = (attributes: string) => `${reset}\x1b[3;4H${attributes}Y\x1b[0m`
    const spec = (edit: string, restored: string, ignored: string): CaptureSpec => ({
      region: { top: 3, left: 4, bottom: 3, right: 4 },
      sentinel: { row: 4, col: 1 },
      cursorRow: 5,
      minRows: 5,
      minCols: 6,
      seed: reset,
      edit: `${reset}\x1b[3;3H${edit}Y\x1b[0m`,
      expected: paintY(restored),
      ignored: paintY(ignored),
      discriminator: { signal: "y-restored", expected: "change" },
      timeoutMs: DEFAULT_TIMEOUT_MS,
    })
    return await captureStackRow(
      stack.ctx,
      operation,
      id,
      `${id}: ${STACK_EXPECTED.sgr[operation]}`,
      spec("\x1b[1m\x1b[#{\x1b[0m\x1b[3mX\x1b[#}", "\x1b[1m", "\x1b[3m"),
      (contrast) => spec("\x1b[1m\x1b[3m\x1b[#{\x1b[0mX\x1b[#}", "\x1b[1;3m", contrast === "earlier" ? "\x1b[1m" : ""),
    )
  } finally {
    if (stack.open()) ctx.write("\x1b[#}")
    ctx.write("\x1b[0m\x1b[2J\x1b[H")
  }
}

/**
 * Mode save/restore capture (#31904): the headless arm's three fixtures, read from the pixels of
 * row 2, column 1. Every frame writes exactly `ctx.cols` Xs then one `!`: with wrap off the `!`
 * stays on row 1 and the cell is empty; with wrap on it holds the `!`.
 * - Restore control: off, save, on, restore. Off is restored, on persisted.
 * - On-control: on, save, off, restore. On is restored; off means restore returned an unsaved state.
 * - Overwrite test: on, save, off, save, on, restore. Off is restored; on is the earlier save when the
 *   controls restored, and persisted when they did not.
 * An off-valued fixture's seed already shows off, so it is a declared no-change whose measured
 * negative is the on contrast (@cto 009e40cd, 4e804806).
 */
async function xtModeSaveCapture(ctx: TermProbeSource, operation: "push" | "pop"): Promise<ProbeCallbackResult> {
  const id = operation === "push" ? "modes.xtsave" : "modes.xtrestore"
  const refusal = captureRefusal(ctx, 4, 2, id)
  if (refusal) return refusal
  const expected = `${id}: ${STACK_EXPECTED.mode[operation]}`
  const xs = "X".repeat(Number.isSafeInteger(ctx.cols) && ctx.cols > 0 ? ctx.cols : 0)
  const [OFF, ON, SAVE, RESTORE] = ["\x1b[?7l", "\x1b[?7h", "\x1b[?7s", "\x1b[?7r"]
  const reset = `${OFF}\x1b[0m\x1b[2J\x1b[H`
  const offFrame = reset
  const onFrame = `${reset}\x1b[2;1H!`
  const fixture = (name: string, steps: readonly string[], restoresOn: boolean) =>
    captureStackFixture(ctx, id, name, {
      region: { top: 2, left: 1, bottom: 2, right: 1 },
      sentinel: { row: 3, col: 1 },
      cursorRow: 4,
      minRows: 4,
      minCols: 2,
      seed: `${reset}${xs}!`,
      edit: `${steps.join("")}\x1b[0m\x1b[2J\x1b[H${xs}!`,
      expected: restoresOn ? onFrame : offFrame,
      ignored: restoresOn ? offFrame : onFrame,
      discriminator: { signal: "wrap-restored", expected: restoresOn ? "change" : "no-change" },
      cleanup: ON,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    })
  const control = await fixture("restore control", [OFF, SAVE, ON, RESTORE], false)
  if (!("match" in control)) return control
  const onControl = await fixture("on-control", [ON, SAVE, OFF, RESTORE], true)
  if (!("match" in onControl)) return onControl
  const overwrite = await fixture("overwrite test", [ON, SAVE, OFF, SAVE, ON, RESTORE], false)
  if (!("match" in overwrite)) return overwrite
  const reads = [control, onControl, overwrite]
  const pop: StackReading =
    control.match === "ignored"
      ? "persisted"
      : control.match === "expected" && onControl.match === "expected"
        ? "restored"
        : "other"
  const push: StackReading =
    overwrite.match === "expected"
      ? "restored"
      : overwrite.match === "ignored"
        ? pop === "restored"
          ? "earlier"
          : "persisted"
        : "other"
  if (control.match === "expected" && onControl.match === "ignored") {
    return captureStackResult(operation, expected, { pop, push }, reads, {
      pass: operation === "pop" ? false : null,
      note:
        operation === "pop"
          ? "restore returned DECAWM off after on was saved"
          : "restore returned DECAWM off whatever was saved, so no save was observed",
    })
  }
  const verdict = stackVerdict(operation, pop, push)
  return captureStackResult(operation, expected, { pop, push }, reads, {
    pass: verdict.pass,
    note:
      pop === "persisted" && push === "persisted"
        ? "save then restore restored no earlier state"
        : verdict.note?.replace("push saved no current snapshot", "save kept the earlier saved state"),
  })
}

/**
 * Color-stack capture (#31904): the headless arm's two fixtures, read from the pixels of Y alone.
 * Y is printed through palette index 1 after the pop and read before any later palette change; X
 * is outside the compared cell, because a correct pop may recolor it (turn362).
 * - POP fixture: blue, push, green, X, pop, Y. Blue Y is restored, green Y persisted.
 * - PUSH fixture: blue, magenta, push, green, X, pop, Y. Magenta Y is restored, blue Y the earlier
 *   state, green Y persisted.
 * The references paint Y through the same index, so a run whose OSC 4 does not move the index
 * leaves expected and contrast equal and the oracle declines it by name.
 */
async function xtColorStackCapture(ctx: TermProbeSource, operation: "push" | "pop"): Promise<ProbeCallbackResult> {
  const id = operation === "push" ? "modes.xtpushcolors" : "modes.xtpopcolors"
  const refusal = captureRefusal(ctx, 4, 8, id)
  if (refusal) return refusal
  const stack = trackedStack(ctx, "\x1b[#P", "\x1b[#Q")
  try {
    const reset = "\x1b[0m\x1b[2J\x1b[H"
    const osc4 = (hex: string) => `\x1b]4;1;rgb:${hex}\x07`
    const BLUE = osc4("00/00/ff")
    const GREEN = osc4("00/ff/00")
    const MAGENTA = osc4("ff/00/ff")
    const paintY = (color: string) => `${reset}${color}\x1b[1;2H\x1b[38;5;1mY\x1b[0m`
    const spec = (before: string, restored: string, ignored: string): CaptureSpec => ({
      region: { top: 1, left: 2, bottom: 1, right: 2 },
      sentinel: { row: 3, col: 1 },
      cursorRow: 4,
      minRows: 4,
      minCols: 8,
      seed: reset,
      edit: `${reset}${before}\x1b[#P${GREEN}\x1b[1;1H\x1b[38;5;1mX\x1b[#Q\x1b[38;5;1mY\x1b[0m`,
      expected: paintY(restored),
      ignored: paintY(ignored),
      discriminator: { signal: "palette-y-restored", expected: "change" },
      cleanup: "\x1b]104\x07",
      timeoutMs: DEFAULT_TIMEOUT_MS,
    })
    return await captureStackRow(
      stack.ctx,
      operation,
      id,
      `${id}: ${STACK_EXPECTED.color[operation]}`,
      spec(BLUE, BLUE, GREEN),
      (contrast) => spec(`${BLUE}${MAGENTA}`, MAGENTA, contrast === "earlier" ? BLUE : GREEN),
    )
  } finally {
    if (stack.open()) ctx.write("\x1b[#Q")
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
 * Headless SGR-stack read-back (#30700, split by operation in #31904). B, X and Y occupy columns
 * 1-3 and only Y is graded. POP fixture: bold B (A), push, SGR 0, italic X, pop, Y; bold-only Y is
 * restored, italic-only Y persisted. PUSH fixture: bold (the earlier state, also the POP fixture's
 * pushed state), add italic (the push-time state) and write B, push, SGR 0, X, pop, Y; bold+italic Y
 * is restored, bold-only Y is the earlier state, plain Y persisted. Every pass value is non-default,
 * so a pop that resets to the default never passes, and the PUSH fixture's pass value differs from
 * the POP fixture's, so a stack that keeps a stale snapshot never passes the push row. The control
 * writes bold, italic and bold+italic cells with no stack ops, so a backend that does not report bold
 * or italic has no observable for the claim (a coverage record, TEST TODO).
 */
function xtSgrStackHeadless(ctx: LibProbeSource, operation: "push" | "pop"): ProbeCallbackResult {
  const id = operation === "push" ? "modes.xtpushsgr" : "modes.xtpopsgr"
  const expected = `${id}: ${STACK_EXPECTED.sgr[operation]}`
  if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 3) {
    return parserStateResult(null, expected, { cols: ctx.cols }, "Measured grid needs three columns")
  }
  const readBXY = () => ({ b: ctx.getCell(0, 0), x: ctx.getCell(0, 1), y: ctx.getCell(0, 2) })
  const charsIntact = (cells: ReturnType<typeof readBXY>) =>
    cells.b.char === "B" && cells.x.char === "X" && cells.y.char === "Y"
  const plain = (cell: StackCell) => cell.bold !== true && cell.italic !== true
  const boldItalic = (cell: StackCell) => cell.bold === true && cell.italic === true
  let pushed = false
  try {
    ctx.feed("\x1b[0m\x1b[2J\x1b[1;1H\x1b[1mB\x1b[0m\x1b[3mX\x1b[1mY\x1b[0m")
    const control = readBXY()
    if (!charsIntact(control) || !boldOnly(control.b) || !italicOnly(control.x) || !boldItalic(control.y)) {
      return notTestedResult(
        "bold and italic cell attributes in the headless readback (control frame not calibrated)",
        { control },
      )
    }
    const fixture = (prefix: string, pushState: string, changed: string) => {
      ctx.feed(`\x1b[0m\x1b[2J\x1b[1;1H${prefix}${pushState}B`)
      const pushOutput = ctx.feedCapture("\x1b[#{")
      pushed = true
      if (pushOutput.length > 0) return pushOutput
      ctx.feed(`\x1b[0m${changed}X`)
      const popOutput = ctx.feedCapture("\x1b[#}")
      pushed = false
      if (popOutput.length > 0) return popOutput
      ctx.feed("Y\x1b[0m")
      return readBXY()
    }
    const popCells = fixture("", "\x1b[1m", "\x1b[3m")
    if (typeof popCells === "string") return stackOutputResult(popCells)
    const pushCells = fixture("\x1b[1m", "\x1b[3m", "")
    if (typeof pushCells === "string") return stackOutputResult(pushCells)
    const state = { control, popFixture: popCells, pushFixture: pushCells }
    if (!charsIntact(popCells) || !charsIntact(pushCells)) {
      return parserStateResult(null, expected, state, "Stack sequence disturbed the B, X, Y cells")
    }
    const pop: StackReading = boldOnly(popCells.y) ? "restored" : italicOnly(popCells.y) ? "persisted" : "other"
    const push: StackReading = boldItalic(pushCells.y)
      ? "restored"
      : boldOnly(pushCells.y)
        ? "earlier"
        : plain(pushCells.y)
          ? "persisted"
          : "other"
    const verdict = stackVerdict(operation, pop, push)
    return stackStateResult(verdict, expected, { ...state, pop, push })
  } finally {
    if (pushed) ctx.feed("\x1b[#}")
    ctx.feed("\x1b[0m\x1b[2J\x1b[H")
  }
}

/**
 * Headless XTSAVE/XTRESTORE read-back (#30700, split by operation in #31904): the pixel capture's
 * overflow fixture, read from cells. Every frame writes exactly `cols` Xs then one `!`: with
 * auto-wrap off the `!` overwrites the last column and row 2 stays empty; with wrap on it lands at
 * row 2, column 1. Two controls calibrate both wrap states, so a backend that cannot show either
 * state has no observable for the claim (a coverage record, TEST TODO) rather than a negative. Two
 * fixtures follow, each graded by one overflow frame after the restore (@cto 6e4f7300, 009e40cd):
 * - Restore control (POP fixture): off, save, on, restore. Off is restored, on persisted.
 * - Overwrite test (PUSH fixture): on, save, off, save, on, restore. Off is restored; on is the
 *   earlier save when the control restored, and persisted when it did not.
 * Wrap on is the default, so every pass value is off: a restore that only resets to the default
 * looks the same as one that restored nothing, and both rows read the joint negative (@cto
 * 0613b68d). On returning while the control passed blames only the save that kept the earlier state.
 * An on-control (on, save, off, restore, expect on) runs after the restore control: a restore that
 * sets off whatever was saved passes both off fixtures, so the control counts as restored only when
 * the on-control also returns on; otherwise restore failed to return a saved on, a negative for the
 * restore row only, since no save is visible through it (vterm 0.10.1, #31904).
 */
function xtModeSaveHeadless(ctx: LibProbeSource, operation: "push" | "pop"): ProbeCallbackResult {
  const id = operation === "push" ? "modes.xtsave" : "modes.xtrestore"
  const expected = `${id}: ${STACK_EXPECTED.mode[operation]}`
  const rows = ctx.getScrollback().screenLines
  if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 2 || !Number.isSafeInteger(rows) || rows < 2) {
    return parserStateResult(null, expected, { rows, cols: ctx.cols }, "Measured grid needs two rows and two columns")
  }
  const xs = "X".repeat(ctx.cols)
  const overflow = () => ({ last: ctx.getCell(0, ctx.cols - 1), next: ctx.getCell(1, 0) })
  const wrapped = (frame: ReturnType<typeof overflow>) => frame.last.char === "X" && frame.next.char === "!"
  const stayed = (frame: ReturnType<typeof overflow>) => frame.last.char === "!" && frame.next.char !== "!"
  const OFF = "\x1b[?7l"
  const ON = "\x1b[?7h"
  const SAVE = "\x1b[?7s"
  const RESTORE = "\x1b[?7r"
  try {
    ctx.feed(`${OFF}\x1b[0m\x1b[2J\x1b[1;1H${xs}!`)
    const off = overflow()
    ctx.feed(`${ON}\x1b[0m\x1b[2J\x1b[1;1H${xs}!`)
    const on = overflow()
    if (!stayed(off) || !wrapped(on)) {
      return notTestedResult("both auto-wrap states (DECAWM off and on) in the headless readback", {
        rows,
        cols: ctx.cols,
        off,
        on,
      })
    }
    // Save and restore must emit nothing; a reply is returned as the fixture's output instead.
    const fixture = (steps: readonly string[]): ReturnType<typeof overflow> | string => {
      for (const step of steps) {
        if (step === SAVE || step === RESTORE) {
          const output = ctx.feedCapture(step)
          if (output.length > 0) return output
        } else ctx.feed(step)
      }
      ctx.feed(`\x1b[0m\x1b[2J\x1b[1;1H${xs}!`)
      return overflow()
    }
    const control = fixture([OFF, SAVE, ON, RESTORE])
    if (typeof control === "string") return stackOutputResult(control)
    const onControl = fixture([ON, SAVE, OFF, RESTORE])
    if (typeof onControl === "string") return stackOutputResult(onControl)
    const overwrite = fixture([ON, SAVE, OFF, SAVE, ON, RESTORE])
    if (typeof overwrite === "string") return stackOutputResult(overwrite)
    const pop: StackReading = wrapped(control)
      ? "persisted"
      : stayed(control) && wrapped(onControl)
        ? "restored"
        : "other"
    const push: StackReading = stayed(overwrite)
      ? "restored"
      : wrapped(overwrite)
        ? pop === "restored"
          ? "earlier"
          : "persisted"
        : "other"
    const state = {
      rows,
      cols: ctx.cols,
      off,
      on,
      control,
      onControl,
      overwrite,
      autoWrap: ctx.getMode("autoWrap"),
      pop,
      push,
    }
    // A restore that returns off after on was saved fails the pop claim itself, but hides any save
    // behind it, so only the restore row is negative (@cto 972a8462).
    if (stayed(control) && stayed(onControl)) {
      return operation === "pop"
        ? parserStateResult(false, expected, state, "restore returned DECAWM off after on was saved")
        : stackStateResult(
            { pass: null, note: "restore returned DECAWM off whatever was saved, so no save was observed" },
            expected,
            state,
          )
    }
    const verdict = stackVerdict(operation, pop, push)
    const note =
      pop === "persisted" && push === "persisted"
        ? "save then restore restored no earlier state"
        : verdict.note?.replace("push saved no current snapshot", "save kept the earlier saved state")
    return stackStateResult({ pass: verdict.pass, note }, expected, state)
  } finally {
    ctx.feed(`${ON}\x1b[0m\x1b[2J\x1b[H`)
  }
}

const COLOR_STACK_BLUE = { r: 0, g: 0, b: 255 }
const COLOR_STACK_GREEN = { r: 0, g: 255, b: 0 }
const COLOR_STACK_MAGENTA = { r: 255, g: 0, b: 255 }

/**
 * Headless XTPUSHCOLORS/XTPOPCOLORS read-back (#30700, split by operation in #31904). Calibration
 * redefines palette index 1 blue, green and magenta, drawing and reading a cell each time, which
 * proves OSC 4 moves the reported foreground at all (on @xterm/headless, the per-instance palette
 * array mirrors _core._inputHandler.onColor events, so OSC 4 cell-color calibration grades that
 * engine-delivered index+rgb event; #31735, @cto 863bef67). Two fixtures follow, each printing X
 * after the change and Y after the pop; Y alone is graded, read before any later palette change can
 * recolor it, and X is never graded, because a correct pop may recolor it (turn362).
 * - POP fixture: set blue, push, set green, X, pop, Y. Blue Y is restored, green Y persisted.
 * - PUSH fixture: set blue (the earlier state), set magenta (the push-time state), push, set green,
 *   X, pop, Y. Magenta Y is restored, blue Y is the earlier state, green Y persisted.
 * Every pass value is a redefined, non-default color, so a pop that resets the palette never passes,
 * and the PUSH fixture's pass value differs from the POP fixture's, so a stack that keeps a stale
 * snapshot never passes the push row (@cto 6e4f7300). A readback whose colors do not follow OSC 4
 * has no observable for the claim (a coverage record, TEST TODO) rather than a negative.
 */
function xtColorStackHeadless(ctx: LibProbeSource, operation: "push" | "pop"): ProbeCallbackResult {
  const id = operation === "push" ? "modes.xtpushcolors" : "modes.xtpopcolors"
  const expected = `${id}: ${STACK_EXPECTED.color[operation]}`
  if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 2) {
    return parserStateResult(null, expected, { cols: ctx.cols }, "Measured grid needs two columns")
  }
  const osc4 = (hex: string) => `\x1b]4;1;rgb:${hex}\x07`
  const BLUE = osc4("00/00/ff")
  const GREEN = osc4("00/ff/00")
  const MAGENTA = osc4("ff/00/ff")
  let pushed = false
  try {
    const calibrate = (set: string) => {
      ctx.feed(`\x1b[0m\x1b[2J\x1b[1;1H${set}\x1b[38;5;1mA`)
      return ctx.getCell(0, 0)
    }
    const calibration = { blue: calibrate(BLUE), green: calibrate(GREEN), magenta: calibrate(MAGENTA) }
    const reads = (cell: StackCell, rgb: typeof COLOR_STACK_BLUE) =>
      cell.char === "A" && !!cell.fg && sameRgb(cell.fg, rgb)
    if (
      !reads(calibration.blue, COLOR_STACK_BLUE) ||
      !reads(calibration.green, COLOR_STACK_GREEN) ||
      !reads(calibration.magenta, COLOR_STACK_MAGENTA)
    ) {
      return notTestedResult("OSC 4 redefinition of palette index 1 reflected in the headless cell colors", calibration)
    }
    const fixture = (before: string) => {
      ctx.feed(`\x1b[0m\x1b[2J\x1b[1;1H${before}`)
      const pushOutput = ctx.feedCapture("\x1b[#P")
      pushed = true
      if (pushOutput.length > 0) return pushOutput
      ctx.feed(`${GREEN}\x1b[38;5;1mX`)
      const popOutput = ctx.feedCapture("\x1b[#Q")
      pushed = false
      if (popOutput.length > 0) return popOutput
      ctx.feed("\x1b[38;5;1mY\x1b[0m")
      return { x: ctx.getCell(0, 0), y: ctx.getCell(0, 1) }
    }
    const popCells = fixture(BLUE)
    if (typeof popCells === "string") return stackOutputResult(popCells)
    const pushCells = fixture(BLUE + MAGENTA)
    if (typeof pushCells === "string") return stackOutputResult(pushCells)
    const state = { calibration, popFixture: popCells, pushFixture: pushCells }
    const yOf = (cells: typeof popCells) => (cells.x.char === "X" && cells.y.char === "Y" ? cells.y.fg : undefined)
    const popY = yOf(popCells)
    const pushY = yOf(pushCells)
    if (!popY || !pushY) {
      return parserStateResult(null, expected, state, "X and Y cells after the pop were not exposed")
    }
    const pop: StackReading = sameRgb(popY, COLOR_STACK_BLUE)
      ? "restored"
      : sameRgb(popY, COLOR_STACK_GREEN)
        ? "persisted"
        : "other"
    const push: StackReading = sameRgb(pushY, COLOR_STACK_MAGENTA)
      ? "restored"
      : sameRgb(pushY, COLOR_STACK_BLUE)
        ? "earlier"
        : sameRgb(pushY, COLOR_STACK_GREEN)
          ? "persisted"
          : "other"
    const verdict = stackVerdict(operation, pop, push)
    return stackStateResult(verdict, expected, { ...state, pop, push })
  } finally {
    if (pushed) ctx.feed("\x1b[#Q")
    ctx.feed("\x1b]104\x07\x1b[0m\x1b[2J\x1b[H")
  }
}

const ALT_1049_SEED_A = "PRIMARY-A"
const ALT_1049_SEED_B = "PRIMARY-B"
const ALT_1049_MARK = "ALT-MARK"

function activeScreenRow(ctx: LibProbeSource, row: number): number {
  const { totalLines, screenLines } = ctx.getScrollback()
  return Math.max(0, totalLines - screenLines) + row
}

/** Read the exact characters of a horizontal span; never an inequality shortcut. */
function readAlt1049Span(ctx: LibProbeSource, row: number, length: number): string {
  const activeRow = activeScreenRow(ctx, row)
  let text = ""
  for (let index = 0; index < length; index += 1) text += ctx.getCell(activeRow, index).char
  return text
}

function alt1049SpanBlank(ctx: LibProbeSource, row: number, length: number): boolean {
  const activeRow = activeScreenRow(ctx, row)
  for (let index = 0; index < length; index += 1) {
    if (!isBlank(ctx.getCell(activeRow, index).char)) return false
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

type AlternateReflowPhase = {
  id: "alternate-grow" | "alternate-shrink"
  from: 12 | 20
  to: 12 | 20
  outcome: "reflow" | "preserved-wraps" | "truncated" | "invalid" | "identity-unavailable" | "not-entered"
  status: "supported" | "unsupported" | "test-todo" | "test-failure"
  reason: string
}

type AltScreenRoundtripFacts = Readonly<{
  before: Readonly<{ x: number; y: number }>
  seedA: string
  seedB: string
  mark: string
}>

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
  measureReflow?: (ctx: LibProbeSource, facts: AltScreenRoundtripFacts) => AlternateReflowPhase | undefined,
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
  let roundtripFailure: { error: unknown } | undefined
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
        // An unqualified entry is a missing prerequisite for the exit: TEST TODO, and source never decides it
        // (#32246, @cto batch7 A-F1 and 84e7b78b).
        return notTestedResult("alternate-screen entry not observed, so exit cannot be attributed", state)
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
    measureReflow?.(ctx, Object.freeze({ before: Object.freeze({ ...before }), seedA, seedB, mark }))
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
  } catch (error) {
    roundtripFailure = { error }
    throw error
  } finally {
    // Existing mode callbacks retain their exact cleanup and error behavior. Reflow's inserted
    // measurement must retain a failed measured leave as well as a failed finally-leave.
    if (!measureReflow) ctx.feed(leave + "\x1b[0m")
    else {
      try {
        ctx.feed(leave + "\x1b[0m")
      } catch (error) {
        if (!roundtripFailure) throw error
        const errors = [roundtripFailure.error, error]
        throw new AggregateError(
          errors,
          errors.map((cause) => (cause instanceof Error ? cause.message : String(cause))).join("; "),
          { cause: errors[0] },
        )
      }
    }
  }
}

/** @internal Reflow-only measurement inside the existing, seeded 1049 roundtrip; not a mode grade. */
export function measureAlternateReflow(
  ctx: LibProbeSource,
  measure: (ctx: LibProbeSource, facts: AltScreenRoundtripFacts) => AlternateReflowPhase,
): { roundtrip: ProbeCallbackResult; measurement?: AlternateReflowPhase; measurementError?: string } {
  let measurement: AlternateReflowPhase | undefined
  let failure: { error: unknown } | undefined
  let roundtrip: ProbeCallbackResult
  try {
    roundtrip = altScreenRoundtrip(
      ctx,
      ALT_SCREEN_1049,
      "enter",
      "Primary restored after alternate reflow",
      (source, facts) => {
        try {
          measurement = measure(source, facts)
          return measurement
        } catch (error) {
          // The slot cannot change roundtrip policy: both measured and final leaves still execute.
          failure = { error }
          // silent-fallback-allow: The caller records this error as an invalid phase; original causes remain available if cleanup also fails.
          return undefined
        }
      },
    )
  } catch (error) {
    if (!failure) throw error
    const errors = [failure.error, error]
    throw new AggregateError(
      errors,
      errors.map((cause) => (cause instanceof Error ? cause.message : String(cause))).join("; "),
      { cause: errors[0] },
    )
  }
  return {
    roundtrip,
    ...(measurement !== undefined && { measurement }),
    ...(failure && {
      measurementError: failure.error instanceof Error ? failure.error.message : String(failure.error),
    }),
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
    const activeRow = activeScreenRow(ctx, 0)
    let text = ""
    for (let col = 0; col < width; col += 1) {
      const char = ctx.getCell(activeRow, col).char
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

const modeDefinitions: ProbeDefinition[] = [
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
          return replyFailure(
            "no parsable cursor position reply; the public projection returned null and retained no bytes",
          )
        }
        return {
          pass: false,
          response: JSON.stringify(pos),
          criterionBranch: HEADLESS_OBSERVABLE_REVIEW,
          tests: [
            {
              id: "review",
              status: "test-todo",
              reason: "Cursor responsiveness after exit does not measure the restored buffer",
            },
          ],
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
      // Unknown mode metadata cannot determine the state to restore.
      if (originallyEnabled !== null) ctx.feed(originallyEnabled ? "\x1b[?7h" : "\x1b[?7l")
    }
  }),

  // Mouse tracking
  decrpmModeProbe("modes.mouse-tracking", 1000, headlessDecrpmArm(1000, "mouseTracking")),

  // Focus tracking
  decrpmModeProbe("modes.focus-tracking", 1004, headlessDecrpmArm(1004, "focusTracking")),

  // Reverse video
  {
    ...decrpmModeProbe("modes.reverse-video", 5, headlessDecrpmArm(5, "reverseVideo", { requireReadback: true }), true),
    libAssertionType: "query_reply",
  },

  // Synchronized output
  {
    ...decrpmModeProbe(
      "modes.synchronized-output",
      2026,
      headlessDecrpmArm(2026, "syncOutput", { requireReadback: true }),
      true,
    ),
    libAssertionType: "query_reply",
  },

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
            const ok = on === 1 && off === 2
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
          return replyFailure(
            "no parsable cursor position reply; the public projection returned null and retained no bytes",
          )
        }
        return {
          pass: false,
          response: JSON.stringify(pos),
          criterionBranch: HEADLESS_OBSERVABLE_REVIEW,
          tests: [
            {
              id: "review",
              status: "test-todo",
              reason: "Cursor advance does not measure whether X displaced the existing cells",
            },
          ],
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
      let resetSent = false
      try {
        ctx.feed("\x1b=")
        const setMode = ctx.getMode("applicationKeypad")
        ctx.feed("\x1b>")
        resetSent = true
        const resetMode = ctx.getMode("applicationKeypad")
        const response = JSON.stringify({ setMode, resetMode })
        const facet = "keypad key encoding unmeasured; mode state measured"
        if (setMode === true && resetMode === false) {
          const note = `DECKPAM set/reset state agrees; ${facet}`
          return {
            pass: true,
            response,
            note,
            observation: { outcome: "supported", assertionType: "buffer_state", note },
            assertions: [
              {
                assertionType: "buffer_state",
                kind: "positive",
                expected: "DECKPAM true then DECKPNM false",
                observed: response,
              },
            ],
          }
        }
        const reason =
          setMode === null || resetMode === null
            ? `adapter binding ${ctx.backendName} applicationKeypad`
            : `DECKPAM state pair: set ${setMode}, reset ${resetMode}`
        const note = `${reason}; ${facet}`
        return {
          pass: false,
          response,
          note,
          observation: {
            outcome: "inconclusive",
            assertionType: "buffer_state",
            reason: "insufficient-evidence",
            note,
          },
          tests: [{ id: "criterion", status: "test-todo", reason }],
        }
      } finally {
        if (!resetSent) ctx.feed("\x1b>")
      }
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
        if (ps === null) {
          return replyFailure(
            "no usable DECRPM reply; alternate-buffer clearing was not measured; the public projection returned null and retained no bytes",
          )
        }
        return {
          pass: false,
          response: decrpmReading(ps),
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            assertionType: "query_reply",
            note: "DECRPM status does not measure alternate-buffer clearing",
          },
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
              ? replyFailure(
                  "no parsable cursor position reply; the public projection returned null and retained no bytes",
                )
              : {
                  observation: {
                    outcome: "inconclusive",
                    reason: "insufficient-evidence",
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
                ? replyFailure(
                    "no parsable cursor position reply; the public projection returned null and retained no bytes",
                  )
                : {
                    observation: {
                      outcome: "inconclusive",
                      reason: "insufficient-evidence",
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
          return replyFailure(
            "no parsable cursor position reply; the public projection returned null and retained no bytes",
          )
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
    headlessDecrpmArm(1007, "altScroll", { requireReadback: true }),
    altScroll1007,
    "input_bytes",
  ),

  // ?1005 — UTF-8 mouse encoding (legacy)
  decrpmModeProbe("modes.utf8-mouse-1005", 1005, headlessDecrpmArm(1005)),

  // ?3 — DECCOLM 80/132 column switch, decided by cell state, 18t only corroborating (#31381, cee6d003)
  {
    id: "modes.deccolm",
    termWrites: "query",
    termAssertionType: "query_reply",
    libAssertionType: "buffer_state",
    lib: (ctx) => {
      if (typeof (ctx as { getCursor?: unknown }).getCursor !== "function") {
        return reviewResult(
          "no-cell-width-readback",
          "Library probe source exposes no cell-width readback, so this run cannot decide it",
          "no cell-width readback",
          { cols: ctx.cols },
        )
      }
      const geometryReply = /\x1b\[8;([1-9][0-9]*);([1-9][0-9]*)t/
      const replyNotes: string[] = []
      const reply18t = (phase: string) => {
        const raw = ctx.feedCapture("\x1b[18t")
        const match = geometryReply.exec(raw)
        if (raw && !match) replyNotes.push(`Malformed 18t reply (${phase}): ${JSON.stringify(raw)}`)
        return match ? Number(match[2]) : null
      }
      // Close the 80/132 policy gate for the baseline and gate control A. The collector destroys this
      // probe's disposable backend; no unavailable prior ?40 state is invented for cleanup.
      ctx.feed("\x1b[?40l")
      const initial = sweepCellWidth(ctx)
      const initial18t = reply18t("initial")
      const mirror = initial.kind === "width" && initial.width === 132
      const change = mirror ? "\x1b[?3l" : "\x1b[?3h"
      const restore = mirror ? "\x1b[?3h" : "\x1b[?3l"
      try {
        // Gate control A: with ?40 closed the mode must not move the width.
        ctx.feed(change)
        const gateBefore = sweepCellWidth(ctx)
        ctx.feed(restore + "\x1b[?40h" + change)
        const enabled = sweepCellWidth(ctx)
        const enabled18t = reply18t("enabled")
        ctx.feed(restore)
        const restored = sweepCellWidth(ctx)
        const restored18t = reply18t("restored")
        // Gate control B: with ?40 closed again the mode must not move the width a second time.
        ctx.feed("\x1b[?40l" + change)
        const gateAfter = sweepCellWidth(ctx)
        ctx.feed(restore + "\x1b[?40h")
        const decrpmRaw = ctx.feedCapture("\x1b[?3$p")
        const decrpm = decrpmPs(decrpmReplyPattern(3).exec(decrpmRaw)?.[1])
        if (decrpmRaw && decrpm === null) {
          replyNotes.push(`Malformed or out-of-range DECRPM mode 3 reply: ${JSON.stringify(decrpmRaw)}`)
        }
        const result = cellWidthTransition({
          initial,
          gateBefore,
          enabled,
          restored,
          gateAfter,
          decrpm,
          reply18t: { initial: initial18t, enabled: enabled18t, restored: restored18t },
        })
        if (replyNotes.length) {
          if (result.observation) {
            result.observation.note = [result.observation.note, ...replyNotes].filter(Boolean).join("; ")
          } else {
            for (const test of result.tests ?? []) {
              if (test.status === "test-failure") {
                test.reason = [test.reason, ...replyNotes].filter(Boolean).join("; ")
              }
            }
          }
        }
        return result
      } finally {
        ctx.feed(restore + "\x1b[?40h")
      }
    },
    async term(ctx) {
      return decrpmResult(await queryDecrpm(ctx, 3), 3)
    },
  },

  // ?4 — DECSCLM needs presentation timing, not mode recognition or final parser state.
  decrpmModeProbe("modes.decsclm", 4, headlessDecrpmArm(4, "smoothScroll", { requireReadback: true }), true),

  // Mode 2031 — color scheme reporting (dark/light mode notifications)
  // Adopted by: iTerm2, tmux 3.6, Contour, foot, kitty
  {
    ...probe(
      "modes.color-scheme-reporting",
      headlessDecrpmArm(2031, "colorSchemeReporting", { requireReadback: true }),
      decrpmModeProbe("modes.color-scheme-reporting", 2031, null, true).term,
      "query_reply",
    ),
    termNeedsDisposable: true,
    libAssertionType: "query_reply",
  },

  // XTPUSHSGR — push SGR stack (CSI # {)
  // Headless: cell read-back of the push/pop roundtrip; terminal: pixel capture of the same frame.
  {
    ...probe(
      "modes.xtpushsgr",
      (ctx) => xtSgrStackHeadless(ctx, "push"),
      async (ctx) => {
        if (ctx.capture) return xtSgrStackCapture(ctx, "push")
        ctx.write("\x1b[#{")
        try {
          const pos = await ctx.queryCursorPosition()
          if (!pos) {
            return replyFailure(
              "no parsable cursor position reply; the public projection returned null and retained no bytes",
            )
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
      (ctx) => xtSgrStackHeadless(ctx, "pop"),
      async (ctx) => {
        if (ctx.capture) return xtSgrStackCapture(ctx, "pop")
        ctx.write("\x1b[#{")
        ctx.write("\x1b[#}")
        const pos = await ctx.queryCursorPosition()
        if (!pos) {
          return replyFailure(
            "no parsable cursor position reply; the public projection returned null and retained no bytes",
          )
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
      (ctx) => xtModeSaveHeadless(ctx, "push"),
      async (ctx) => {
        if (ctx.capture) return xtModeSaveCapture(ctx, "push")
        ctx.write("\x1b[?7s")
        try {
          const pos = await ctx.queryCursorPosition()
          if (!pos) {
            return replyFailure(
              "no parsable cursor position reply; the public projection returned null and retained no bytes",
            )
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
      (ctx) => xtModeSaveHeadless(ctx, "pop"),
      async (ctx) => {
        if (ctx.capture) return xtModeSaveCapture(ctx, "pop")
        ctx.write("\x1b[?7s")
        ctx.write("\x1b[?7r")
        const pos = await ctx.queryCursorPosition()
        if (!pos) {
          return replyFailure(
            "no parsable cursor position reply; the public projection returned null and retained no bytes",
          )
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
      (ctx) => xtColorStackHeadless(ctx, "push"),
      async (ctx) => {
        if (ctx.capture) return xtColorStackCapture(ctx, "push")
        ctx.write("\x1b[#P")
        try {
          const pos = await ctx.queryCursorPosition()
          if (!pos) {
            return replyFailure(
              "no parsable cursor position reply; the public projection returned null and retained no bytes",
            )
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
      (ctx) => xtColorStackHeadless(ctx, "pop"),
      async (ctx) => {
        if (ctx.capture) return xtColorStackCapture(ctx, "pop")
        ctx.write("\x1b[#P")
        ctx.write("\x1b[#Q")
        const pos = await ctx.queryCursorPosition()
        if (!pos) {
          return replyFailure(
            "no parsable cursor position reply; the public projection returned null and retained no bytes",
          )
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
      (ctx) => {
        const expected = "CSI 9 SP p yields observable scroll-speed state or effect"
        if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 8) {
          return parserStateResult(
            null,
            expected,
            { cols: ctx.cols },
            "Need eight measured columns for the parser control",
          )
        }
        ctx.feed("\x1b[2J\x1b[H")
        const seed = { text: ctx.getText(), cursor: ctx.getCursor() }
        if (seed.text.trim() !== "" || seed.cursor.x !== 0 || seed.cursor.y !== 0) {
          return parserStateResult(null, expected, seed, "DECSSCLS blank-screen control was not established")
        }
        ctx.feed("\x1b[9 pQ")
        const state = { text: ctx.getText(), cursor: ctx.getCursor() }
        const { totalLines, screenLines } = ctx.getScrollback()
        const screenTop = Math.max(0, totalLines - screenLines)
        const line = state.text.split("\n").slice(screenTop).join("\n").trimEnd()
        if (line === "Q" && state.cursor.x === 1 && state.cursor.y === 0) {
          return parserStateResult(
            null,
            expected,
            state,
            "CSI 9 SP p consumed with no visible effect; scroll-speed presentation remains unmeasured",
            "CSI 9 SP p consumed with no visible effect; this library exposes no scroll-speed readback; decided only by an independent source review of the engine's CSI dispatcher",
          )
        }
        if (["9 pQ", "[9 pQ", "\x1b[9 pQ"].includes(line) && state.cursor.x === line.length && state.cursor.y === 0) {
          return parserStateResult(false, expected, state, "CSI 9 SP p leaked as text before the marker Q")
        }
        return parserStateResult(
          null,
          expected,
          state,
          "DECSSCLS marker was misplaced or the grid changed; scroll-speed effect unmeasured",
        )
      },
      decsscls,
    ),
    // The library measures parser consumption only; source review must decide an empty observation.
    // Neither that measurement nor a stored speed can establish timed presentation support.
    termAssertionType: "screenshot",
    libAssertionType: "buffer_state",
    termNeedsGeometry: true,
  },
]

export const modesProbes: ProbeDefinition[] = modeDefinitions.map(withModeSourceReview)
