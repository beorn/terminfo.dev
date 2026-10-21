import { CAPABILITY_STATUSES } from "./types.ts"
import type { ProbeCheckResult } from "./types.ts"
import type {
  CapabilityAttempt,
  Observation,
  NotTestedCoverage,
  ProbeAssertion,
  UngradedDiagnostic,
  CapabilityResult,
  CurrentProbeRun,
  ProbeSuiteManifest,
  RunDraft,
} from "./types.ts"
import type {
  ObservationEvidence,
  ProbeDefinition,
  ProbeResult,
  TerminalQueryOutcome,
  TermlessContext,
  TermContext,
} from "./types.ts"

/** Keep the serialized state alongside the exact assertion that used it. */
export function parserStateResult(pass: boolean | null, expected: string, state: object, note?: string): ProbeResult {
  const response = JSON.stringify(state)
  const assertions: NonNullable<ProbeResult["assertions"]> | undefined =
    pass === null ? undefined : [{ kind: pass ? "positive" : "negative", expected, observed: response }]
  return {
    pass: pass === true,
    response,
    ...(note && { note }),
    observation: {
      outcome: pass === null ? "inconclusive" : pass ? "supported" : "unsupported",
      ...(pass === null && { reason: "insufficient-evidence" as const }),
      evidence: "parser-state",
      ...(note && { note }),
    },
    ...(assertions && { assertions }),
  }
}

/**
 * The probe ran and retained raw state, but this environment exposes no applicable observable for
 * the claim. This is a coverage/applicability record, never a fifth measurement outcome.
 */
export function notTestedResult(noObservable: string, state: object): ProbeResult {
  return {
    pass: false,
    response: JSON.stringify(state),
    note: noObservable,
    notTested: { reason: "no-semantic-observable", noObservable },
  }
}

/**
 * A criterion this context has no observable for: the same coverage record and raw state as
 * notTestedResult, with the explicit branch selecting the existing review check. The position
 * stays TEST TODO with a required review pending; nothing here grades support, delivery or
 * Untestable.
 */
function reviewResult(branch: string, reason: string, noObservable: string, state: object): ProbeResult {
  return {
    ...notTestedResult(noObservable, state),
    criterionBranch: branch,
    checks: [{ id: "review", status: "test-todo", reason }],
  }
}

/**
 * The headless arm of a criterion that needs OS-level input. An app context without an input
 * adapter keeps its plain coverage record.
 */
export function osInputReviewResult(
  noObservable: string,
  state: object,
  reason = "Headless context injects no OS-level input; required independent review of the retained raw state pending",
): ProbeResult {
  return reviewResult("os-input-review", reason, noObservable, state)
}

/**
 * The headless arm of a colour reset or stack criterion whose first colour readback answered
 * nothing (#30547, @cto D-B): the effect cannot be observed, so the reset, push or pop is never
 * sent. Never a sentinel negative (C10) and never graded from a source read (C7); the reviewer
 * names the engine's missing observable from its source audit row.
 */
export function colorReadbackReviewResult(noObservable: string, state: object): ProbeResult {
  return reviewResult(
    "color-readback-review",
    "Headless context offers no colour readback; required independent review of the retained raw state pending",
    noObservable,
    state,
  )
}

/**
 * A row whose claim compares plainly written glyphs against a sequence of pixels assumes the
 * terminal decodes plain UTF-8 — a CONTEXT, measured once per run and never assumed (#28752). A
 * measured 8-bit (ISO-8859-1) decoding means the expected frame paints a different string from the
 * one the row claims, so the row cannot be decided in this context: it is inconclusive and NAMES
 * the cause. The run is NOT refused — a refusal is a new gate, and a named cause loses nothing.
 * The two named non-measurements — `silent` (no cursor report arrived) and `unusable` (one arrived
 * the measurement cannot read) — involve no measured decoding and claim none, so they leave the row
 * to its own oracle: a context that cannot answer this round trip already fails its geometry and
 * width reads by name (@dev/review2).
 */
export async function utf8DecodingRefusal(ctx: TermContext, id: string): Promise<ProbeResult | null> {
  if (!ctx.utf8Decoding) return null
  if ((await ctx.utf8Decoding()) !== "8-bit") return null
  return {
    pass: false,
    criterionBranch: "utf8-prerequisite",
    checks: [
      {
        id: "utf8-context",
        status: "test-todo",
        reason: "Measured decoding is ISO-8859-1; correct the pinned locale and rerun this UTF-8 criterion",
      },
    ],
    observation: {
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "query",
      note: `${id}: this run decodes plain-written UTF-8 as ISO-8859-1 (measured: the Neutral-width sample ë advanced the cursor two cells, not one), so the expected frame paints a different string from the one this row claims; the pinned locale is the context to correct, not a capability of this terminal`,
    },
  }
}

/** Selective erase must remove unprotected cells and retain a protected control. */
export function selectiveEraseResult(ctx: TermlessContext, sequence: string, rectangular: boolean): ProbeResult {
  const expected = "DECSCA-protected P survives while selective erase clears ABCD"
  if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 6) {
    return parserStateResult(null, expected, { cols: ctx.cols }, "Need six measured columns")
  }
  try {
    ctx.feed('\x1b[1;1H\x1b[1"qP\x1b[0"qABCDZ')
    const before = Array.from({ length: 6 }, (_, col) => ctx.getCell(0, col).char)
    if (before.join("") !== "PABCDZ") {
      return parserStateResult(null, expected, { before }, "Selective erase seed was not measured")
    }
    ctx.feed(sequence)
    const after = Array.from({ length: 6 }, (_, col) => ctx.getCell(0, col).char)
    if (after[0] !== "P") {
      // The DECSCA-protected P is the row's discriminator: an erase that takes it ignored the
      // protection the claim rests on, a measured negative (@chief 2026-10-11T22:58Z). Reporting
      // "cannot attribute" here would name the one shape the claim is about as unmeasured.
      return parserStateResult(
        false,
        expected,
        { before, after },
        "The DECSCA-protected P was erased: protection ignored",
      )
    }
    const outsideControl = !rectangular || after[5] === "Z"
    return parserStateResult(
      outsideControl ? after.slice(1, rectangular ? 5 : 6).every(isBlank) : null,
      expected,
      { before, after },
      outsideControl ? undefined : "Outside-rectangle control failed; cannot attribute selective erase",
    )
  } finally {
    ctx.feed('\x1b[0"q')
  }
}

/** CPR cannot establish changed cells, styling, or scrollback contents. */
export function unmeasuredCellResult(position: { row: number; col: number } | null, feature: string): ProbeResult {
  return {
    pass: false,
    ...(position && { response: `${position.row};${position.col}` }),
    note: position ? `Cursor response does not measure ${feature}` : `No cursor response after ${feature}`,
    observation: {
      outcome: "inconclusive",
      reason: position ? "insufficient-evidence" : "no-response",
      evidence: "query",
    },
  }
}

/**
 * SGR parameters a DECRQSS reply must carry (and, for a reset, must not), plus exact tokens.
 * `require`/`forbid` match a parameter's leading code; `requireTokens` distinguishes the
 * sub-parameter families that share a code, such as the underline styles under 4 (`4:3`).
 */
export interface SgrReadback {
  require: readonly number[]
  forbid?: readonly number[]
  requireTokens?: readonly string[]
}

/**
 * DECRQSS `$ q m` — the SGR parameter tokens the terminal itself reports as active, sub-parameters
 * preserved (`4:3`, `58:2:255:0:128`).
 * A complete `DCS 1 $ r <Ps> m ST` reply is parsed; a timeout, a DA1 sentinel, or a
 * `DCS 0 $ r ST` "request not recognized" reply all return null. A missing readback is
 * never a negative.
 */
export async function querySgrState(ctx: TermContext): Promise<string[] | null> {
  const outcome = await ctx.queryWithSentinelOutcome("\x1bP$qm\x1b\\", /\x1bP1\$r([0-9;:]*)m\x1b\\/)
  if (outcome.reason !== "reply") return null
  const payload = outcome.match?.[1]
  if (payload === undefined) return null
  if (payload === "") return []
  return payload.split(";")
}

/** The leading code of a DECRQSS parameter token (`4:3` -> 4). */
function leadingSgrCode(token: string): number {
  return Number(token.split(":")[0])
}

/** The DECRPM reply to one DECRQM: `CSI ? Pd ; Ps $ y` for a DEC private mode, `CSI Pd ; Ps $ y` for an ANSI mode. */
export function decrpmReplyPattern(modeNumber: number, kind: "private" | "ansi" = "private"): RegExp {
  return new RegExp(`\\x1b\\[${kind === "private" ? "\\?" : ""}${modeNumber};([0-4])\\$y`)
}

/** A DECRPM Ps kept distinct (#30557): 0 not recognized, 1 set, 2 reset, 3 permanently set, 4 permanently reset. */
export type DecrpmPs = 0 | 1 | 2 | 3 | 4

/** The one reading of Ps for every DECRPM consumer; anything outside 0–4 is no readback. */
export function decrpmPs(ps: string | undefined): DecrpmPs | null {
  if (ps === undefined || ps === "") return null
  const status = Number(ps)
  return status === 0 || status === 1 || status === 2 || status === 3 || status === 4 ? status : null
}

/**
 * The fold over decrpmPs, 1/3 set, 2/4 reset, 0 not recognized, for tty.ts queryMode and the readers that only
 * save, restore or compare a prior state: the cursor-visibility and autowrap equality checks
 * (text-qualification.ts, capture-calibration.ts), the DECSCLM restore (modes.ts) and the DECAWM gate (text.ts).
 * No grader reads this word: it hides Ps 4 behind "reset", so a grader reads the Ps through queryDecrpm (#30557).
 */
export function decrpmStatus(ps: string | undefined): "set" | "reset" | "unknown" | null {
  const reading = decrpmPs(ps)
  if (reading === null) return null
  if (reading === 0) return "unknown"
  return reading === 1 || reading === 3 ? "set" : "reset"
}

/**
 * One DECRQM on the app arm, read by the shared parser with Ps kept distinct: `CSI ? Ps $ p` for a DEC private mode
 * (the same bytes queryMode folds), `CSI Ps $ p` for an ANSI mode such as IRM.
 */
export async function queryDecrpm(
  ctx: TermContext,
  modeNum: number,
  kind: "private" | "ansi" = "private",
): Promise<DecrpmPs | null> {
  const query = kind === "private" ? `\x1b[?${modeNum}$p` : `\x1b[${modeNum}$p`
  const match = await ctx.queryWithSentinel(query, decrpmReplyPattern(modeNum, kind))
  return decrpmPs(match?.[1])
}

/**
 * DECRQSS `$ q SP q` — the terminal's own DECSCUSR cursor-style setting. A complete
 * `DCS 1 $ r <Ps> SP q ST` reply yields `<Ps>`; a timeout, a DA1 sentinel, or a `DCS 0 $ r ST`
 * "request not recognized" reply all return null. A missing readback is never a negative.
 */
export async function queryCursorStyle(ctx: TermContext): Promise<number | null> {
  const outcome = await ctx.queryWithSentinelOutcome("\x1bP$q q\x1b\\", /\x1bP1\$r([0-9]+) q\x1b\\/)
  if (outcome.reason !== "reply") return null
  const payload = outcome.match?.[1]
  if (payload === undefined) return null
  const ps = Number(payload)
  return Number.isInteger(ps) ? ps : null
}

/**
 * Decide a DECSCUSR shape claim from the terminal's own DECRQSS report when it answers, and return
 * null when it stays silent so the caller keeps its existing (pixel) evidence path. A missing
 * readback is never a negative.
 */
export async function cursorStyleReadbackDecision(
  ctx: TermContext,
  sequence: string,
  expected: number,
): Promise<ProbeResult | null> {
  ctx.write(sequence)
  try {
    const ps = await queryCursorStyle(ctx)
    if (ps === null) return null
    const pass = ps === expected
    return {
      pass,
      observation: { outcome: pass ? "supported" : "unsupported", evidence: "query" },
      assertions: [
        {
          kind: pass ? "positive" : "negative",
          expected: `DECRQSS reports cursor style ${expected} after ${sequence}`,
          observed: String(ps),
        },
      ],
    }
  } finally {
    ctx.write("\x1b[0 q")
  }
}

/**
 * The terminal's own DECRQSS report may spell a style as a colon sub-parameter of the code we
 * require: measured, kitty-0.49.2 reports SGR 21 (doubly underlined) as `4:2`, and `4:1` is the
 * single underline `4` spelled out. Fold those equivalences into the reported codes so the
 * terminal's chosen encoding cannot decide the claim.
 */
const SGR_CODE_ALIASES: Readonly<Record<string, number>> = { "4:1": 4, "4:2": 21 }

/** Decide an SGR claim from the terminal own DECRQSS report. */
export function sgrReadbackResult(
  id: string,
  sequence: string,
  state: readonly string[],
  readback: SgrReadback,
): ProbeResult {
  // Extended-color operands are one parameter, never independent attributes. Keep the raw state
  // below, but compare equivalent legacy semicolon and colon reports as complete color tokens.
  const parameters: string[] = []
  let unmeasured: string | undefined
  const remaining = [...state]
  for (let token = remaining.shift(); token !== undefined; token = remaining.shift()) {
    const selector = leadingSgrCode(token)
    // Underline reports have one style subparameter, from 0 (off) through 5 (dashed).
    if (selector === 4 && token.includes(":") && !/^4:[0-5]$/.test(token)) {
      unmeasured = `DECRQSS underline parameter ${token} has an unqualified style or extra subparameters`
      break
    }
    if (![38, 48, 58].includes(selector)) {
      parameters.push(token)
      continue
    }
    let parts = token.split(":")
    if (parts.length === 1) {
      const mode = remaining.shift()
      const operands = mode === "2" ? 3 : mode === "5" ? 1 : 0
      parts = [token, ...(mode === undefined ? [] : [mode]), ...remaining.splice(0, operands)]
    }
    // The optional ISO color-space slot is omitted or zero in the equivalent RGB form.
    if (parts[1] === "2" && parts.length === 6 && (parts[2] === "" || parts[2] === "0")) parts.splice(2, 1)
    const values = parts.slice(2)
    const complete = (parts[1] === "2" && values.length === 3) || (parts[1] === "5" && values.length === 1)
    if (!complete || values.some((value) => !/^\d+$/.test(value) || Number(value) > 255)) {
      unmeasured = `DECRQSS color parameter ${parts.join(":")} is incomplete or has an unqualified encoding`
      break
    }
    if (parameters.some((parameter) => leadingSgrCode(parameter) === selector)) {
      unmeasured = `DECRQSS reports more than one color parameter for ${selector}`
      break
    }
    parameters.push(parts.map(Number).join(":"))
  }
  for (const expected of readback.requireTokens ?? []) {
    const selector = leadingSgrCode(expected)
    if (![38, 48, 58].includes(selector)) continue
    const actual = parameters.find((parameter) => leadingSgrCode(parameter) === selector)
    if (actual && actual.split(":")[1] !== expected.split(":")[1]) {
      unmeasured = `DECRQSS reports ${actual}, which cannot establish requested color representation ${expected}`
    }
  }
  const observed = state.length === 0 ? "0" : state.join(";")
  if (unmeasured) {
    return {
      pass: false,
      response: JSON.stringify({ sgr: observed }),
      note: unmeasured,
      observation: { outcome: "inconclusive", evidence: "query", reason: "insufficient-evidence", note: unmeasured },
    }
  }
  const codes = parameters.flatMap((token) => {
    // Style zero explicitly disables underline; its leading 4 is not an active attribute.
    if (token === "4:0") return [24]
    const alias = SGR_CODE_ALIASES[token]
    return alias === undefined ? [leadingSgrCode(token)] : [leadingSgrCode(token), alias]
  })
  const required = readback.require.every((code) => codes.includes(code))
  const forbidden = readback.forbid?.some((code) => codes.includes(code)) ?? false
  const tokensRequired = readback.requireTokens?.every((token) => parameters.includes(token)) ?? true
  const ok = required && !forbidden && tokensRequired
  const expected = [...readback.require.map(String), ...(readback.requireTokens ?? [])].join(";")
  return {
    pass: ok,
    response: JSON.stringify({ sgr: observed }),
    observation: ok ? { outcome: "supported", evidence: "query" } : { outcome: "unsupported", evidence: "query" },
    assertions: [
      {
        kind: ok ? "positive" : "negative",
        expected: `${id}: DECRQSS reports ${expected} after ${sequence}`,
        observed,
      },
    ],
  }
}

/**
 * Decide an SGR claim from the terminal's own DECRQSS report when it answers, and return null when
 * it stays silent so the caller keeps its existing (capture or cursor) evidence path. A missing
 * readback is never a negative.
 */
export async function sgrReadbackDecision(
  ctx: TermContext,
  id: string,
  sequence: string,
  readback: SgrReadback,
  setup?: { sequence: string; baseline: SgrReadback; readback: SgrReadback },
): Promise<ProbeResult | null> {
  const observed: Record<string, string> = {}
  try {
    ctx.write("\x1b[0m")
    if (setup) {
      // A final neutral reply cannot prove a reset unless the same transaction first established
      // a neutral baseline and the requested setup. Keep all phases inside the cleanup lifetime.
      for (const [phase, bytes, criterion] of [
        ["baseline", "", setup.baseline],
        ["setup", setup.sequence, setup.readback],
      ] as const) {
        if (bytes) ctx.write(bytes)
        const state = await querySgrState(ctx)
        if (state === null) return null
        observed[phase] = state.join(";")
        const qualified = sgrReadbackResult(id, bytes, state, criterion)
        if (!qualified.pass) {
          const note = `${id}: ${phase} prerequisite was not established${qualified.note ? `: ${qualified.note}` : ""}`
          return {
            pass: false,
            response: JSON.stringify({ phase, ...observed }),
            note,
            observation: { outcome: "inconclusive", evidence: "query", reason: "insufficient-evidence", note },
          }
        }
      }
    }
    ctx.write(sequence)
    const state = await querySgrState(ctx)
    if (state === null) return null
    const result = sgrReadbackResult(id, sequence, state, readback)
    return setup
      ? { ...result, response: JSON.stringify({ sgr: state.length === 0 ? "0" : state.join(";"), ...observed }) }
      : result
  } finally {
    ctx.write("\x1b[0m")
  }
}

/**
 * SGR probe — feed SGR sequence + "X", verify cell attribute (termless) or cursor position (term).
 *
 * A capture fixture renders at row 3 column 3; a smaller measured terminal clamps CUP or
 * wraps/scrolls the sample, so the shared guard refuses before any bytes.
 *
 * Termless: positive cell state establishes parser support. Adapters may omit
 * attributes or collapse styles, so a mismatch cannot establish non-support.
 * Term: cursor advance only proves the sequence was consumed, not that its style rendered.
 */
export const SGR_CAPTURE_MIN_ROWS = 3
export const SGR_CAPTURE_MIN_COLS = 34

/**
 * The 1x2 floor the plain SGR fixture refuses BEFORE any bytes: the sequence plus the X sample need
 * two cells, and a terminal below that cannot answer the cursor read the fixture grades. A caller
 * whose arm writes before falling back (the DECRQSS readback) still calls this first, so the refusal
 * is never preceded by bytes of its own.
 */
export function sgrPlainFixtureTooSmall(ctx: TermContext): ProbeResult | undefined {
  const { rows, cols } = ctx
  if (Number.isSafeInteger(rows) && Number.isSafeInteger(cols) && rows >= 1 && cols >= 2) return undefined
  return {
    pass: false,
    observation: {
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "none",
      note: `SGR fixture needs at least 1x2, measured ${rows}x${cols}`,
    },
  }
}

/** Refuse an SGR capture fixture before any bytes when the measured geometry is too small. */
export function sgrCaptureTooSmall(ctx: TermContext, feature = "SGR capture"): ProbeResult | undefined {
  if (!ctx.capture) return undefined
  const { rows, cols } = ctx
  if (
    Number.isSafeInteger(rows) &&
    Number.isSafeInteger(cols) &&
    rows >= SGR_CAPTURE_MIN_ROWS &&
    cols >= SGR_CAPTURE_MIN_COLS
  ) {
    return undefined
  }
  return {
    pass: false,
    observation: {
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "none",
      note: `${feature} needs at least ${SGR_CAPTURE_MIN_ROWS}x${SGR_CAPTURE_MIN_COLS}, measured ${rows}x${cols}`,
    },
  }
}

/** Render a control screen and a target screen and return both frames as inconclusive pixel evidence. */
export async function sgrCaptureFrames(
  ctx: TermContext,
  control: string,
  target: string,
  targetLabel: string,
  meta: Record<string, unknown> = {},
  note = "Control and target pixels captured; visual interpretation requires review",
  controlLabel = `${targetLabel} control`,
): Promise<ProbeResult> {
  if (!ctx.capture) throw new Error(`${targetLabel}: SGR pixel capture requires a capture callback`)
  ctx.write(control)
  const controlFrame = await ctx.capture({ role: "control", label: controlLabel })
  ctx.write(target)
  const targetFrame = await ctx.capture({ role: "target", label: targetLabel })
  return {
    pass: false,
    response: JSON.stringify({ ...meta, control: controlFrame.label, target: targetFrame.label }),
    criterionBranch: "visual-review",
    checks: [
      { id: "capture", status: "supported", assertionRefs: [0] },
      { id: "review", status: "test-todo", reason: "Valid control and target capture; required visual review pending" },
    ],
    assertions: [
      {
        kind: "positive",
        expected: `${targetLabel} compared with ${controlLabel}`,
        observed: JSON.stringify({ control: controlFrame, target: targetFrame }),
      },
    ],
    observation: {
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "pixels",
      screenshotRef: targetFrame.ref,
      frames: [controlFrame, targetFrame],
      note,
    },
  }
}

export function sgrProbe(
  id: string,
  sequence: string,
  check: (cell: ReturnType<TermlessContext["getCell"]>) => boolean | null,
  noObservableWhen?: (cell: ReturnType<TermlessContext["getCell"]>) => string | null,
  readback?: SgrReadback,
): ProbeDefinition {
  return {
    id,
    termNeedsGeometry: true,
    termObservationEvidence: readback ? "query" : "consumed",
    termless(ctx) {
      ctx.feed(sequence + "X")
      const cell = ctx.getCell(0, 0)
      if (cell.char === "X") {
        const noObservable = noObservableWhen?.(cell)
        if (noObservable) return notTestedResult(noObservable, cell)
      }
      const measured = cell.char === "X" && check(cell) === true
      return parserStateResult(
        measured ? true : null,
        `${id}: attribute applied to the rendered X cell`,
        cell,
        cell.char !== "X"
          ? "No rendered X cell to evaluate"
          : measured
            ? undefined
            : "Cell readback cannot distinguish unsupported styling from unreported attributes or collapsed styles; a negative needs rendering review",
      )
    },
    async term(ctx) {
      const refusal = sgrPlainFixtureTooSmall(ctx)
      if (refusal) return refusal
      if (readback) {
        // The capture fixture guard refuses before any bytes on a measured small terminal, so the
        // readback must not emit its own sequences ahead of it.
        if (ctx.capture) {
          const refusal = sgrCaptureTooSmall(ctx, "SGR fixture")
          if (refusal) return refusal
        }
        const decided = await sgrReadbackDecision(ctx, id, sequence, readback)
        if (decided) return decided
      }
      if (ctx.capture) {
        const refusal = sgrCaptureTooSmall(ctx, "SGR fixture")
        if (refusal) return refusal
        const sample = "AaBb 0123456789 - terminal text"
        try {
          return await sgrCaptureFrames(
            ctx,
            "\x1b[0m\x1b[2J\x1b[3;3H" + sample,
            "\x1b[0m\x1b[2J\x1b[3;3H" + sequence + sample,
            id,
            { sample, startRow: 3, startCol: 3, sampleCells: sample.length },
            undefined,
            "Unstyled text sample",
          )
        } finally {
          ctx.write("\x1b[0m")
        }
      }
      ctx.write("\x1b[1;1H\x1b[2K") // clear line
      ctx.write(sequence + "X\x1b[0m")
      const pos = await ctx.queryCursorPosition()
      if (!pos) {
        return {
          pass: false,
          note: "No cursor response",
          observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" },
        }
      }
      // Cursor should be at col 2 (wrote 1 char "X")
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
        response: `${pos.row};${pos.col}`,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "consumed",
          note: "Cursor advance does not verify SGR styling",
        },
      }
    },

    termlessObservationEvidence: "parser-state",
  }
}

/**
 * Cursor probe — move cursor, verify position.
 * Termless uses 0-based coordinates, term DSR uses 1-based.
 */
export function cursorProbe(
  id: string,
  setup: string,
  move: string,
  expected: { row: number; col: number },
  setupExpected?: { row: number; col: number },
): ProbeDefinition {
  const inconclusive = (
    origin: object | null,
    setupPosition: object | null,
    final: object | null,
    evidence: ObservationEvidence,
    reason: "no-response" | "insufficient-evidence",
    note: string,
  ): ProbeResult => ({
    pass: false,
    response: JSON.stringify({ origin, setup: setupPosition, final }),
    note,
    observation: { outcome: "inconclusive", reason, evidence, note },
  })
  return {
    id,
    termNeedsGeometry: true,
    termObservationEvidence: "query",
    termless(ctx) {
      ctx.feed("\x1b[1;1H")
      const origin = ctx.getCursor()
      if (origin.x !== 0 || origin.y !== 0) {
        return inconclusive(
          origin,
          null,
          null,
          "parser-state",
          "insufficient-evidence",
          `Cursor origin measured ${origin.y};${origin.x}, expected 0;0`,
        )
      }
      if (setup) ctx.feed(setup)
      const setupPosition = setup ? ctx.getCursor() : origin
      if (setup && !setupExpected) {
        return inconclusive(
          origin,
          setupPosition,
          null,
          "parser-state",
          "insufficient-evidence",
          "Cursor setup has no expected position",
        )
      }
      const wantedSetup = setupExpected ?? { row: 0, col: 0 }
      if (setupPosition.x !== wantedSetup.col || setupPosition.y !== wantedSetup.row) {
        return inconclusive(
          origin,
          setupPosition,
          null,
          "parser-state",
          "insufficient-evidence",
          `Cursor setup measured ${setupPosition.y};${setupPosition.x}, expected ${wantedSetup.row};${wantedSetup.col}`,
        )
      }
      ctx.feed(move)
      const final = ctx.getCursor()
      return parserStateResult(
        final.x === expected.col && final.y === expected.row,
        `cursor row=${expected.row}, col=${expected.col} (0-based) after ${JSON.stringify(move)}`,
        { origin, setup: setupPosition, final },
      )
    },
    async term(ctx) {
      const minRows = Math.max(1, expected.row + 1, (setupExpected?.row ?? 0) + 1)
      const minCols = Math.max(1, expected.col + 1, (setupExpected?.col ?? 0) + 1)
      if (ctx.rows < minRows || ctx.cols < minCols) {
        const note = `Cursor fixture needs at least ${minRows} rows and ${minCols} columns; measured ${ctx.rows}x${ctx.cols}`
        return {
          pass: false,
          note,
          observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none", note },
        }
      }
      ctx.write("\x1b[1;1H")
      const origin = await ctx.queryCursorPosition()
      if (!origin) return inconclusive(null, null, null, "query", "no-response", "No cursor reply at origin")
      if (origin.row !== 1 || origin.col !== 1) {
        return inconclusive(
          origin,
          null,
          null,
          "query",
          "insufficient-evidence",
          `Cursor origin measured ${origin.row};${origin.col}, expected 1;1`,
        )
      }
      if (setup) ctx.write(setup)
      const setupPosition = setup ? await ctx.queryCursorPosition() : origin
      if (!setupPosition) return inconclusive(origin, null, null, "query", "no-response", "No cursor reply after setup")
      if (setup && !setupExpected) {
        return inconclusive(
          origin,
          setupPosition,
          null,
          "query",
          "insufficient-evidence",
          "Cursor setup has no expected position",
        )
      }
      const wantedSetup = setupExpected ?? { row: 0, col: 0 }
      if (setupPosition.row !== wantedSetup.row + 1 || setupPosition.col !== wantedSetup.col + 1) {
        return inconclusive(
          origin,
          setupPosition,
          null,
          "query",
          "insufficient-evidence",
          `Cursor setup measured ${setupPosition.row};${setupPosition.col}, expected ${wantedSetup.row + 1};${wantedSetup.col + 1}`,
        )
      }
      ctx.write(move)
      const final = await ctx.queryCursorPosition()
      if (!final) {
        return inconclusive(origin, setupPosition, null, "query", "no-response", "No cursor reply after movement")
      }
      const response = JSON.stringify({ origin, setup: setupPosition, final })
      const pass = final.row === expected.row + 1 && final.col === expected.col + 1
      return {
        pass,
        response,
        ...(pass
          ? {}
          : { note: `Cursor measured ${final.row};${final.col}, expected ${expected.row + 1};${expected.col + 1}` }),
        observation: { outcome: pass ? "supported" : "unsupported", evidence: "query" },
        assertions: [
          {
            kind: pass ? "positive" : "negative",
            expected: `cursor row=${expected.row + 1}, col=${expected.col + 1} after ${JSON.stringify(move)}`,
            observed: response,
          },
        ],
      }
    },

    termlessObservationEvidence: "parser-state",
  }
}

/**
 * DECRPM mode probe. Responsiveness after enabling a mode does not prove that mode,
 * and blindly disabling it could change a mode the user already had enabled.
 */
export function decrpmModeProbe(
  id: string,
  modeNum: number,
  termlessFn: ((ctx: TermlessContext) => ProbeResult) | null,
): ProbeDefinition {
  return {
    id,
    termWrites: "query",
    termObservationEvidence: "query",
    termless: termlessFn,
    async term(ctx) {
      return decrpmResult(await queryDecrpm(ctx, modeNum), modeNum)
    },
  }
}

/**
 * The headless arm of a DECRQM mode criterion (#30543): the engine's own DECRPM reply, read by the same parser and
 * graded by the same decrpmResult as the app arm, whenever the adapter delivers one; otherwise the review branch.
 * The adapter's getMode value rides along as context only, never as evidence (libvterm hard-codes it; wezterm
 * derives part of it from a byte scan). The branch keys on the observed reply, never on an engine name.
 */
export function headlessDecrpmArm(modeNum: number, modeName?: string): (ctx: TermlessContext) => ProbeResult {
  return (ctx) => {
    ctx.feed(`\x1b[?${modeNum}h`)
    // Read the adapter's mode view before the query. vt100 and vt220 used to run `CSI ? 1 $ p` as a DECCKM
    // reset, so a getMode read after the query reported the mode already reset; since #30558 they ignore a
    // query they do not have, and the order no longer changes the reading. Reading first still keeps the
    // context independent of how any engine treats an unknown query.
    const mode = modeName === undefined ? undefined : ctx.getMode(modeName)
    const reply = ctx.feedCapture(`\x1b[?${modeNum}$p`)
    const state = modeName === undefined ? { reply } : { reply, mode }
    ctx.feed(`\x1b[?${modeNum}l`)
    const ps = decrpmPs(decrpmReplyPattern(modeNum).exec(reply)?.[1])
    if (ps === null) {
      return osInputReviewResult(
        `DECRPM reply to CSI ? ${modeNum} $ p`,
        state,
        "The adapter delivered no DECRPM reply from the engine; required independent review of the retained raw state pending",
      )
    }
    return { ...decrpmResult(ps, modeNum), response: JSON.stringify(state) }
  }
}

const DECRPM_WORDS: Record<DecrpmPs, string> = {
  0: "not recognized",
  1: "set",
  2: "reset",
  3: "permanently set",
  4: "permanently reset",
}

/** A DECRPM reading as a cell stores it: the word and the numeric Ps, so a stored "reset" never hides a Ps 4 (#30557). */
export function decrpmReading(ps: DecrpmPs): string {
  return `${DECRPM_WORDS[ps]} (Ps ${ps})`
}

/**
 * The one grader of a DECRPM reading, shared by the app arm and the headless arm (#30557, @cto 254dd9cf):
 * Ps 1, 2 and 3 grade supported; Ps 4 grades unsupported, because the terminal says it knows the mode and
 * that the mode cannot be set (xterm.js answers exactly that for 1005); Ps 0 and no reply are inconclusive.
 */
export function decrpmResult(ps: DecrpmPs | null, modeNum: number): ProbeResult {
  if (ps === null) {
    return {
      pass: false,
      note: "No DECRPM response",
      observation: {
        outcome: "inconclusive",
        reason: "no-response",
        evidence: "query",
        note: "No DECRPM response",
      },
    }
  }
  const reading = decrpmReading(ps)
  if (ps === 0) {
    return {
      pass: false,
      note: `DECRPM mode ${modeNum}: not recognized; mode behavior unmeasured`,
      response: reading,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "query",
        note: `DECRPM mode ${modeNum}: not recognized; mode behavior unmeasured`,
      },
    }
  }
  if (ps === 4) {
    const note = `DECRPM mode ${modeNum}: ${reading}; the terminal knows the mode and cannot set it`
    return {
      pass: false,
      note,
      response: reading,
      observation: { outcome: "unsupported", evidence: "query", note },
      assertions: [
        {
          kind: "negative",
          expected: `DECRPM mode ${modeNum} can be set`,
          observed: reading,
        },
      ],
    }
  }
  return {
    pass: true,
    note: `DECRPM mode ${modeNum}: ${reading}`,
    response: reading,
    observation: { outcome: "supported", evidence: "query" },
    assertions: [
      {
        kind: "positive",
        expected: `DECRPM mode ${modeNum} recognized (set or reset)`,
        observed: reading,
      },
    ],
  }
}

/** Check if a cell character is blank (empty or space). */
export function isBlank(char: string): boolean {
  return char === "" || char === " "
}

/**
 * Simple probe — for probes that need custom logic on both sides.
 */
export function probe(
  id: string,
  termless: ((ctx: TermlessContext) => ProbeResult) | null,
  term: ((ctx: TermContext) => Promise<ProbeResult>) | null,
  termObservationEvidence?: ObservationEvidence,
): ProbeDefinition {
  return { id, termless, term, ...(termObservationEvidence && { termObservationEvidence }) }
}

/** Feature support is independent of whether an observer can inspect link metadata. */
export function readHyperlinkMetadata(
  available: boolean,
  readLink: TermlessContext["getHyperlinkAt"],
  row: number,
  col: number,
  backendName: string,
): string | null | undefined {
  if (!available) return undefined
  if (typeof readLink !== "function") {
    throw new Error(`${backendName} declares OSC 8 metadata but has no getHyperlinkAt method at ${row},${col}`)
  }
  const hyperlink = readLink(row, col)
  if (hyperlink !== null && typeof hyperlink !== "string") {
    throw new Error(`${backendName} declares OSC 8 metadata but returned an invalid value at ${row},${col}`)
  }
  return hyperlink
}

/** A complete DA1 answer, as the live collector has always matched it. */
const DA1_ANSWER = /\x1b\[\?[0-9;]+c/gu

/**
 * F1 (27832): which DA1 answer in a read is the sentinel's (#30559, @cto 86260f80 rule 1). The sentinel
 * is written after the query, so its answer is the LAST DA1-shaped answer in the read, and every byte
 * before it is the query's reply, even a reply shaped like a DA1 answer (Terminal.app answers DA3 that
 * way). Null until a DA1 answer has arrived. Every reader that asks which DA1 answer ends the query
 * asks here.
 */
export function sentinelAnswer(raw: string): { start: number; end: number } | null {
  let last: { start: number; end: number } | null = null
  for (const found of raw.matchAll(DA1_ANSWER)) last = { start: found.index, end: found.index + found[0].length }
  return last
}

/**
 * F1 (27832): a DA1 sentinel answered on time with nothing else said through the grace window is a
 * measured negative, not an unknown — the terminal was alive and did not answer the query. `sentinel`
 * carries the measured ordering (its arrival and the window that followed), which the negative cites
 * so a reader can tell it from an explicit negative reply without a new evidence member.
 *
 * Returns null when the collector measured no sentinel, when any byte precedes the sentinel's own
 * answer (a DA1-shaped reply included: the terminal said something, #30559), or when anything but
 * whitespace follows it (a partial frame is the site's own `invalid-reply`, not a silent terminal),
 * so the caller keeps its existing inconclusive grade.
 */
export function sentinelNegativeResult(
  raw: string,
  sentinel: { atMs: number; graceMs: number } | undefined,
  expected: string,
): ProbeResult | null {
  const answer = sentinelAnswer(raw)
  if (!sentinel || answer === null || answer.start > 0 || raw.slice(answer.end).trim() !== "") return null
  const observed = `DA1 answered at +${String(sentinel.atMs)}ms; no reply through the ${String(sentinel.graceMs)} ms window`
  return {
    pass: false,
    response: raw,
    observation: { outcome: "unsupported", evidence: "query", note: "negative by sentinel" },
    assertions: [{ kind: "negative", expected, observed }],
  }
}

/** The ordering note a reply carries when it arrived after the DA1 sentinel rather than before it. */
export const REPLY_AFTER_SENTINEL_NOTE = "reply after sentinel"

/** The frame a query grader reads from an outcome: a reply's match, never bytes that arrived without one. */
export function replyFrame(outcome: TerminalQueryOutcome): string | null {
  return outcome.reason === "reply" ? (outcome.match?.[0] ?? null) : null
}

/** What the bytes read so far say about a query that carried a DA1 sentinel. */
export type SentinelRead =
  | { kind: "pending"; match: string[] | null }
  | { kind: "reply"; match: string[] }
  | { kind: "unmatched"; match: string[] | null }
  | { kind: "answered"; match: string[] | null }

/**
 * F1 (27832) has one reading rule for both collectors (#30554, @cto 452bc032 condition 3). Until a DA1
 * answer arrives the read is `pending`. The sentinel's answer is the last DA1-shaped one
 * (`sentinelAnswer`, #30559), and a frame ahead of it is a plain `reply` with no sentinel facts.
 * Bytes ahead of it that match nothing are `unmatched`: the terminal said something, so it was not
 * silent (@cto 67840412 R1). Only a DA1 answer with nothing before it is `answered`. Both of those
 * carry any frame that followed the answer. The live collector reads every chunk this way and decides
 * at the end of the grace window, on the whole read; the headless member reads its two captures once.
 */
export function readSentinelReply(buffer: string, pattern: RegExp): SentinelRead {
  const found = buffer.match(pattern)
  const match = found ? [...found] : null
  const answer = sentinelAnswer(buffer)
  if (!answer) return { kind: "pending", match }
  if (match && (found?.index ?? 0) < answer.start) return { kind: "reply", match }
  if (answer.start > 0) return { kind: "unmatched", match }
  return { kind: "answered", match }
}

/**
 * F1 (27832): how long the collector keeps reading after a DA1 sentinel before it calls a missing
 * reply a measured negative. Sized by measurement, once: re-run the sentinel-fired features on every
 * Release 1 terminal with a 1 s post-DA1 read and record any late reply and its delay, then
 * grace = max(250 ms, 2 x the largest observed delay). 250 ms is the floor until that measurement
 * lands; the issue names any terminal that answers late and the features it answers late for.
 */
const SENTINEL_GRACE_MS = 250

/**
 * The window is a measured value, so the one-time sizing pass may widen it without a code change:
 * TERMINFO_SENTINEL_GRACE_MS sets the post-DA1 read for that pass only. An unset or empty value is
 * the floor. Anything that is not a positive whole number of milliseconds falls back to the same
 * floor and says so on stderr: a typo here must never be silent, and a mistyped sizing value does
 * not justify refusing the pass (28385, 30255). The live and headless collectors read this one value
 * (#30554).
 */
export function sentinelGraceMs(
  raw: string | undefined = typeof process !== "undefined" ? process.env.TERMINFO_SENTINEL_GRACE_MS : undefined,
  warn: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): number {
  if (raw === undefined || raw === "") return SENTINEL_GRACE_MS
  const value = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(value) || value < 1) {
    warn(
      `TERMINFO_SENTINEL_GRACE_MS ${JSON.stringify(raw)} is not a positive whole number of milliseconds; ` +
        `using the ${SENTINEL_GRACE_MS} ms floor for this run`,
    )
    return SENTINEL_GRACE_MS
  }
  return value
}

/** Initialize actual work before preflight; a callback-only schedule cannot stand in for the catalogue. */
export function initializeRunDraft(input: {
  runId: string
  sourceRevision: string
  manifest: ProbeSuiteManifest
  intendedContext: RunDraft["intendedContext"]
}): RunDraft {
  const ids = input.manifest.catalogIds
  if (!ids || ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error(`Suite ${input.manifest.probeHash} requires a nonempty unique frozen catalogIds set`)
  }
  return {
    schemaVersion: 3,
    runId: input.runId,
    suiteId: input.manifest.probeHash,
    probeHash: input.manifest.probeHash,
    sourceRevision: input.sourceRevision,
    intendedContext: { ...input.intendedContext },
    results: ids.map((featureId) => ({
      featureId,
      status: "test-todo",
      attempt: { scope: "none" },
      checks: [],
      reason: "Required capability test has not started",
    })),
    rawReplies: {},
    assertions: [],
    screenshotRefs: [],
  }
}

/** Fold only the checks still required by the frozen probe's explicitly selected criterion branch. */
export function finalizeCapabilityResult(input: Omit<CapabilityResult, "status">): CapabilityResult {
  const checks = input.checks
  const failed = checks.find((check) => check.status === "test-failure")
  const pending = checks.find((check) => check.status === "test-todo")
  const impossible = checks.find((check) => check.status === "untestable")
  let status: CapabilityResult["status"]
  let reason = input.reason
  if (failed) {
    status = "test-failure"
    reason ??= failed.reason ?? "Required check failed after its attempt"
  } else if (pending || checks.length === 0) {
    status = "test-todo"
    reason ??= pending?.reason ?? "Required capability implementation has not run"
  } else if (impossible) {
    status = impossible.reviewRef ? "untestable" : "test-todo"
    reason ??= impossible.reason ?? "Context-impossibility review is required"
  } else {
    status = checks.some((check) => check.status === "unsupported") ? "unsupported" : "supported"
  }
  return { ...input, status, ...(reason === undefined ? {} : { reason }) }
}

/** Seal only measured/enriched identity; pending required review keeps the same draft open. */
export function sealRunDraft(draft: RunDraft, sealedAt = new Date().toISOString()): CurrentProbeRun {
  if (!draft.target || !draft.identity || !draft.measuredAt || !draft.origin) {
    throw new Error(`Run ${draft.runId} has no complete measured identity to seal; retain its private draft`)
  }
  if (
    draft.results.some((result) => result.checks.some((check) => check.id === "review" && check.status === "test-todo"))
  ) {
    throw new Error(`Run ${draft.runId} has a required review pending; retain its unsealed capture`)
  }
  return {
    ...draft,
    target: draft.target,
    identity: draft.identity,
    measuredAt: draft.measuredAt,
    origin: draft.origin,
    sealedAt,
  }
}

/** Execute the declared callback's proposition once; readers consume this recorded result. */
export function recordExecutedCapability(input: {
  featureId: string
  attempt: Exclude<CapabilityAttempt, { scope: "none" }>
  observation?: Observation
  diagnostic?: UngradedDiagnostic
  coverage?: NotTestedCoverage
  assertions: readonly ProbeAssertion[]
  checks?: ProbeCheckResult[]
  criterionBranch?: string
}): CapabilityResult {
  const { featureId, attempt, observation, diagnostic, coverage } = input
  const assertionRefs = input.assertions.flatMap((entry, index) => (entry.featureId === featureId ? [index] : []))
  const missingCapture = diagnostic?.kind === "collector-error" && diagnostic.name === "FrameUnavailable"
  const status = missingCapture
    ? "test-todo"
    : diagnostic || observation?.outcome === "error"
      ? "test-failure"
      : observation?.outcome === "supported" || observation?.outcome === "unsupported"
        ? observation.outcome
        : coverage || observation?.evidence === "none" || observation?.evidence === "consumed"
          ? "test-todo"
          : "test-failure"
  const diagnosticReason = diagnostic?.kind === "collector-error" ? diagnostic.message : diagnostic?.note
  const reason = diagnosticReason ?? observation?.note ?? coverage?.noObservable ?? observation?.reason
  const rawReplyRef = observation?.rawReplyRef ?? coverage?.rawReplyRef
  return finalizeCapabilityResult({
    featureId,
    attempt,
    checks:
      input.checks && !diagnostic && observation?.outcome !== "error"
        ? input.checks.map((check) => {
            if (!check.id || !CAPABILITY_STATUSES.includes(check.status)) {
              throw new Error(`Invalid callback check for ${featureId}`)
            }
            const refs =
              check.assertionRefs === undefined
                ? check.status === "test-todo"
                  ? []
                  : assertionRefs
                : check.assertionRefs.map((index) => {
                    const globalIndex = assertionRefs[index]
                    if (globalIndex === undefined) {
                      throw new Error(`Callback check ${featureId}/${check.id} names an absent assertion`)
                    }
                    return globalIndex
                  })
            return {
              id: check.id,
              status: check.status,
              attempt: check.status === "test-todo" ? { scope: "none" } : attempt,
              assertionRefs: refs,
              ...(rawReplyRef && { rawReplyRef }),
              ...(check.reason && { reason: check.reason }),
            }
          })
        : [
            {
              id: "criterion",
              status,
              attempt: status === "test-todo" ? { scope: "none" } : attempt,
              assertionRefs,
              ...(rawReplyRef && { rawReplyRef }),
              ...(reason && { reason }),
            },
          ],
    ...(input.criterionBranch && { criterionBranch: input.criterionBranch }),
    ...(observation?.evidence && { evidence: observation.evidence }),
    ...(rawReplyRef && { rawReplyRef }),
    ...(observation?.frames && { frames: observation.frames }),
    ...(observation?.screenshotRef && { screenshotRef: observation.screenshotRef }),
    ...(observation?.host && { host: observation.host }),
    ...(reason && { reason }),
  })
}

/** The execution owner records an aborted collection against affected unfinished capabilities. */
export function recordCollectionFailure(
  draft: RunDraft,
  startedAt: string,
  diagnostic: string,
  delegatedIds: readonly string[],
): void {
  const delegated = new Set(delegatedIds)
  const diagnosticRef = "collector.failure"
  draft.rawReplies[diagnosticRef] = diagnostic
  const attempt = { scope: "collection" as const, startedAt, diagnosticRef }
  draft.results = draft.results.map((result) =>
    result.status === "test-todo" && delegated.has(result.featureId)
      ? finalizeCapabilityResult({
          ...result,
          attempt,
          reason: diagnostic,
          checks: [
            ...result.checks.filter((check) => check.id !== "collection"),
            { id: "collection", status: "test-failure", attempt, reason: diagnostic },
          ],
        })
      : result,
  )
}
