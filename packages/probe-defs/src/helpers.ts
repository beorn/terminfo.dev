import { PROBE_STATUSES } from "./types.ts"
import { createHash } from "node:crypto"
import type { ProbeTestInput } from "./types.ts"
import type {
  ProbeAttempt,
  Observation,
  NotTestedCoverage,
  ProbeAssertion,
  UngradedDiagnostic,
  ProbeResult,
  CurrentProbeRun,
  ProbeSuiteManifest,
  RunDraft,
  CollectorSelection,
  CollectorAttempt,
} from "./types.ts"
import type {
  AssertionType,
  ProbeDefinition,
  ProbeCallbackResult,
  TerminalQueryOutcome,
  LibProbeSource,
  TermProbeSource,
} from "./types.ts"
import { replyPathAuditFor, type ReplyPathAudit } from "./reply-path-audit.ts"

function collectorRecord(rawReplies: Record<string, string>, key: string): Record<string, unknown> | undefined {
  const raw = rawReplies[key]
  if (raw === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (cause) {
    throw new Error(`Invalid ${key}: retained record is not JSON`, { cause })
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${key}: expected a retained object`)
  }
  return value as Record<string, unknown>
}

export function collectorIds(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || !value.every((id): id is string => typeof id === "string" && id.length > 0)) {
    throw new Error(`Invalid ${key}: expected resolved probe ids`)
  }
  return [...value]
}

/** Absence is legacy evidence, never an inferred full selection. */
export function readCollectorSelection(rawReplies: Record<string, string>): CollectorSelection | undefined {
  const value = collectorRecord(rawReplies, "collector.selection")
  if (value === undefined) return undefined
  return { ids: collectorIds(value.ids, "collector.selection") }
}

/** Decode the retained start/outcome without manufacturing a time or a successful result. */
export function readCollectorAttempt(rawReplies: Record<string, string>): CollectorAttempt | undefined {
  const value = collectorRecord(rawReplies, "collector.collectionAttempt")
  if (value === undefined) return undefined
  const ids = collectorIds(value.ids, "collector.collectionAttempt")
  const result = value.result
  if (
    result !== undefined &&
    (typeof result !== "string" || !["started", "completed", "empty", "cancelled", "failed"].includes(result))
  ) {
    throw new Error("Invalid collector.collectionAttempt: unknown result")
  }
  if (
    (value.startedAt !== undefined &&
      (typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt)))) ||
    ((result === undefined || result === "started" || result === "completed") && value.startedAt === undefined)
  ) {
    throw new Error("Invalid collector.collectionAttempt: recorded start required for a started attempt")
  }
  if ((result === "failed" || result === "cancelled") && typeof value.error !== "string") {
    throw new Error("Invalid collector.collectionAttempt: original error required")
  }
  if (result !== "failed" && result !== "cancelled" && value.error !== undefined) {
    throw new Error("Invalid collector.collectionAttempt: error requires a failed or cancelled result")
  }
  if (
    value.hostInputs !== undefined &&
    (typeof value.hostInputs !== "object" ||
      value.hostInputs === null ||
      Array.isArray(value.hostInputs) ||
      !Object.values(value.hostInputs).every((entry) => typeof entry === "string"))
  ) {
    throw new Error("Invalid collector.collectionAttempt: invalid retained host inputs")
  }
  return { ...value, ids } as CollectorAttempt
}

export function recordCollectorSelection(draft: RunDraft, ids: readonly string[]): void {
  draft.rawReplies["collector.selection"] = JSON.stringify({ ids })
}

export function recordCollectorAttempt(draft: Pick<RunDraft, "rawReplies">, attempt: CollectorAttempt): void {
  draft.rawReplies["collector.collectionAttempt"] = JSON.stringify(attempt)
}

/** Host-cause citations bind the whole retained input record, including its collection outcome. */
export function collectorAttemptDigest(raw: string): string {
  return createHash("sha256").update(raw).digest("hex")
}

/** Keep the serialized state alongside the exact assertion that used it. */
export function parserStateResult(
  pass: boolean | null,
  expected: string,
  state: object,
  note?: string,
  sourceReviewReason?: string,
  assertionType: AssertionType = "buffer_state",
): ProbeCallbackResult {
  if (sourceReviewReason !== undefined && pass === true) {
    throw new Error("A positive parser state cannot require source review")
  }
  const sourceReview = sourceReviewReason !== undefined
  const response = JSON.stringify(state)
  const assertions: NonNullable<ProbeCallbackResult["assertions"]> | undefined =
    pass === null && !sourceReview
      ? undefined
      : [{ assertionType, kind: pass ? "positive" : "negative", expected, observed: response }]
  return {
    pass: pass === true,
    response,
    ...(note && { note }),
    ...(sourceReview && {
      criterionBranch: SOURCE_NEGATIVE_REVIEW,
      tests: [{ id: "review", status: "test-failure" as const, reason: sourceReviewReason }],
    }),
    observation: {
      outcome: sourceReview || pass === null ? "inconclusive" : pass ? "supported" : "unsupported",
      ...((sourceReview || pass === null) && { reason: "insufficient-evidence" as const }),
      assertionType,
      ...(note && { note }),
    },
    ...(assertions && { assertions }),
  }
}

/** Channel-exact equality of two reported cell colors. */
export function sameRgb(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b
}

/**
 * The probe ran and retained raw state, but this environment exposes no applicable observable for
 * the claim. This is a coverage/applicability record, never a fifth measurement outcome.
 */
export function notTestedResult(noObservable: string, state: object): ProbeCallbackResult {
  return {
    pass: false,
    response: JSON.stringify(state),
    note: noObservable,
    notTested: { reason: "no-semantic-observable", noObservable },
  }
}

export const SOURCE_NEGATIVE_REVIEW = "source-negative-review"
export const SEMANTIC_PROMPT_SOURCE_REVIEW = "semantic-prompt-source-review"

/**
 * A criterion this context has no observable for: the same coverage record and raw state as
 * notTestedResult, with the explicit branch selecting the existing review test. The position
 * stays TEST TODO with a required review pending; nothing here grades support, delivery or
 * Untestable.
 */
export function reviewResult(branch: string, reason: string, noObservable: string, state: object): ProbeCallbackResult {
  return {
    ...notTestedResult(noObservable, state),
    criterionBranch: branch,
    tests: [{ id: "review", status: "test-todo", reason }],
  }
}

/**
 * The headless arm of a criterion that needs OS-level input. An app context without an input
 * adapter keeps its plain coverage record.
 */
export function osInputReviewResult(
  noObservable: string,
  state: object,
  reason = "Library probe source injects no OS-level input; required independent review of the retained raw state pending",
): ProbeCallbackResult {
  return reviewResult("os-input-review", reason, noObservable, state)
}

/**
 * A headless colour criterion missing its initial readback. Reset/stack probes send no mutation
 * when that prerequisite is absent (#30547, @cto D-B). Initial-query probes require a disposable
 * set/query/reset control before selecting this branch. Never a sentinel negative (C10) and never
 * graded from a source read (C7); the reviewer names the missing observable from its source audit.
 */
export function colorReadbackReviewResult(noObservable: string, state: object): ProbeCallbackResult {
  return reviewResult(
    "color-readback-review",
    "Library probe source offers no colour readback; required independent review of the retained raw state pending",
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
export async function utf8DecodingRefusal(ctx: TermProbeSource, id: string): Promise<ProbeCallbackResult | null> {
  if (!ctx.utf8Decoding) return null
  if ((await ctx.utf8Decoding()) !== "8-bit") return null
  return {
    pass: false,
    criterionBranch: "utf8-prerequisite",
    tests: [
      {
        id: "utf8-context",
        status: "test-todo",
        reason: "Measured decoding is ISO-8859-1; correct the pinned locale and rerun this UTF-8 criterion",
      },
    ],
    observation: {
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      assertionType: "query_reply",
      note: `${id}: this run decodes plain-written UTF-8 as ISO-8859-1 (measured: the Neutral-width sample ë advanced the cursor two cells, not one), so the expected frame paints a different string from the one this row claims; the pinned locale is the context to correct, not a capability of this terminal`,
    },
  }
}

/** Selective erase must remove unprotected cells and retain a protected control. */
export function selectiveEraseResult(ctx: LibProbeSource, sequence: string, rectangular: boolean): ProbeCallbackResult {
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
export function unmeasuredCellResult(
  position: { row: number; col: number } | null,
  feature: string,
): ProbeCallbackResult {
  return {
    pass: false,
    ...(position && { response: `${position.row};${position.col}` }),
    note: position ? `Cursor response does not measure ${feature}` : `No cursor response after ${feature}`,
    ...(position === null
      ? {
          tests: [{ id: "criterion", status: "test-failure", reason: `No cursor response after ${feature}` }] as [
            { id: string; status: "test-failure"; reason: string },
          ],
        }
      : {
          observation: {
            outcome: "inconclusive",
            reason: position ? "insufficient-evidence" : "no-response",
            assertionType: "query_reply",
          },
        }),
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
export async function querySgrState(ctx: TermProbeSource): Promise<string[] | null> {
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
 * save, restore or compare a prior state: the cursor-visibility and autowrap equality tests
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
  ctx: TermProbeSource,
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
export async function queryCursorStyle(ctx: TermProbeSource): Promise<number | null> {
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
  ctx: TermProbeSource,
  sequence: string,
  expected: number,
): Promise<ProbeCallbackResult | null> {
  ctx.write(sequence)
  try {
    const ps = await queryCursorStyle(ctx)
    if (ps === null) return null
    const pass = ps === expected
    return {
      pass,
      observation: { outcome: pass ? "supported" : "unsupported", assertionType: "query_reply" },
      assertions: [
        {
          assertionType: "query_reply" as const,
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
): ProbeCallbackResult {
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
      observation: {
        outcome: "inconclusive",
        assertionType: "query_reply",
        reason: "insufficient-evidence",
        note: unmeasured,
      },
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
  const requiredCodes = [...readback.require.map(String), ...(readback.requireTokens ?? [])]
  // A forbid-only claim (reset.sgr, sgr.reset, sgr.fg.default, sgr.bg.default) requires nothing, so its
  // expected text names what it forbids instead of storing an empty token.
  const expected =
    requiredCodes.length > 0
      ? requiredCodes.join(";")
      : readback.forbid !== undefined && readback.forbid.length > 0
        ? `none of ${readback.forbid.join(";")}`
        : "0"
  return {
    pass: ok,
    response: JSON.stringify({ sgr: observed }),
    observation: ok
      ? { outcome: "supported", assertionType: "query_reply" }
      : { outcome: "unsupported", assertionType: "query_reply" },
    assertions: [
      {
        assertionType: "query_reply" as const,
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
  ctx: TermProbeSource,
  id: string,
  sequence: string,
  readback: SgrReadback,
  setup?: { sequence: string; baseline: SgrReadback; readback: SgrReadback },
  independentSetup?: () => Promise<ProbeCallbackResult | null>,
): Promise<ProbeCallbackResult | null> {
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
          if (phase === "setup" && qualified.observation?.outcome === "unsupported" && independentSetup) {
            const captured = await independentSetup()
            if (captured) {
              const instrument = `${id}: the independent capture oracle supplies this result because the terminal's SGR report did not establish setup`
              const note = captured.note ? `${captured.note}; ${instrument}` : instrument
              const retained = {
                response: JSON.stringify({ ...observed, capture: captured.response }),
                note,
              }
              if (captured.observation) {
                return {
                  ...captured,
                  ...retained,
                  observation: {
                    ...captured.observation,
                    note: captured.observation.note ? `${captured.observation.note}; ${instrument}` : instrument,
                  },
                }
              }
              return { ...captured, ...retained }
            }
          }
          const note = `${id}: ${phase} prerequisite was not established${qualified.note ? `: ${qualified.note}` : ""}`
          return {
            pass: false,
            response: JSON.stringify({ phase, ...observed }),
            note,
            observation: {
              outcome: "inconclusive",
              assertionType: "query_reply",
              reason: "insufficient-evidence",
              note,
            },
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
export function sgrPlainFixtureTooSmall(ctx: TermProbeSource): ProbeCallbackResult | undefined {
  const { rows, cols } = ctx
  if (Number.isSafeInteger(rows) && Number.isSafeInteger(cols) && rows >= 1 && cols >= 2) return undefined
  return {
    pass: false,
    tests: [
      { id: "criterion", status: "test-todo", reason: `SGR fixture needs at least 1x2, measured ${rows}x${cols}` },
    ],
  }
}

/** Refuse an SGR capture fixture before any bytes when the measured geometry is too small. */
export function sgrCaptureTooSmall(ctx: TermProbeSource, feature = "SGR capture"): ProbeCallbackResult | undefined {
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
    tests: [
      {
        id: "criterion",
        status: "test-todo",
        reason: `${feature} needs at least ${SGR_CAPTURE_MIN_ROWS}x${SGR_CAPTURE_MIN_COLS}, measured ${rows}x${cols}`,
      },
    ],
  }
}

/** Render a control screen and a target screen and return both frames as inconclusive pixel evidence. */
export async function sgrCaptureFrames(
  ctx: TermProbeSource,
  control: string,
  target: string,
  targetLabel: string,
  meta: Record<string, unknown> = {},
  note = "Control and target pixels captured; visual interpretation requires review",
  controlLabel = `${targetLabel} control`,
): Promise<ProbeCallbackResult> {
  if (!ctx.capture) throw new Error(`${targetLabel}: SGR pixel capture requires a capture callback`)
  ctx.write(control)
  const controlFrame = await ctx.capture({ role: "control", label: controlLabel })
  ctx.write(target)
  const targetFrame = await ctx.capture({ role: "target", label: targetLabel })
  return {
    pass: false,
    response: JSON.stringify({ ...meta, control: controlFrame.label, target: targetFrame.label }),
    criterionBranch: "visual-review",
    tests: [
      { id: "capture", status: "supported", assertionRefs: [0] },
      { id: "review", status: "test-todo", reason: "Valid control and target capture; required visual review pending" },
    ],
    assertions: [
      {
        assertionType: "screenshot" as const,
        kind: "positive",
        expected: `${targetLabel} compared with ${controlLabel}`,
        observed: JSON.stringify({ control: controlFrame, target: targetFrame }),
      },
    ],
    observation: {
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      assertionType: "screenshot",
      screenshotRef: targetFrame.ref,
      frames: [controlFrame, targetFrame],
      note,
    },
  }
}

/** The SGR pixel fixture: the attribute's sequence and the text sample it styles at a 1-based row and column. */
export type SgrCaptureFixture = Readonly<{ sequence: string; sample: string; row: number; col: number }>

/** A probe-owned pixel capture, for an attribute one control/target pair cannot show (sgr.blink, #31812). */
export type SgrCapture = (ctx: TermProbeSource, fixture: SgrCaptureFixture) => Promise<ProbeCallbackResult>

export function sgrProbe(
  id: string,
  sequence: string,
  check: (cell: ReturnType<LibProbeSource["getCell"]>) => boolean | null,
  noObservableWhen?: (cell: ReturnType<LibProbeSource["getCell"]>) => string | null,
  readback?: SgrReadback,
  sourceReviewReason?: string,
  capture?: SgrCapture,
): ProbeDefinition {
  return {
    id,
    termNeedsGeometry: true,
    termAssertionType: readback ? "query_reply" : null,
    lib(ctx) {
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
          : measured || sourceReviewReason !== undefined
            ? undefined
            : "Cell readback cannot distinguish unsupported styling from unreported attributes or collapsed styles; a negative needs rendering review",
        cell.char === "X" && !measured ? sourceReviewReason : undefined,
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
          if (capture) return await capture(ctx, { sequence, sample, row: 3, col: 3 })
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
          tests: [{ id: "criterion", status: "test-failure", reason: "No cursor response" }],
        }
      }
      // Cursor should be at col 2 (wrote 1 char "X")
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
        response: `${pos.row};${pos.col}`,
        tests: [
          {
            id: "criterion",
            status: "test-todo",
            reason: `Cursor advance does not verify SGR styling${ctx.captureGeometryRefusal ? `; Pixel capture unavailable: ${ctx.captureGeometryRefusal}` : ""}`,
          },
        ],
      }
    },

    libAssertionType: "buffer_state",
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
    assertionType: AssertionType,
    reason: "no-response" | "insufficient-evidence",
    note: string,
  ): ProbeCallbackResult => ({
    pass: false,
    response: JSON.stringify({ origin, setup: setupPosition, final }),
    note,
    ...(reason === "no-response"
      ? {
          tests: [{ id: "criterion", status: "test-failure", reason: note }] as [
            ProbeTestInput & { status: "test-failure"; reason: string },
          ],
        }
      : { observation: { outcome: "inconclusive", reason, assertionType, note } }),
  })
  return {
    id,
    termNeedsGeometry: true,
    termAssertionType: "query_reply",
    lib(ctx) {
      ctx.feed("\x1b[1;1H")
      const origin = ctx.getCursor()
      if (origin.x !== 0 || origin.y !== 0) {
        return inconclusive(
          origin,
          null,
          null,
          "buffer_state",
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
          "buffer_state",
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
          "buffer_state",
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
          tests: [{ id: "criterion", status: "test-todo", reason: note }],
        }
      }
      ctx.write("\x1b[1;1H")
      const origin = await ctx.queryCursorPosition()
      if (!origin) return inconclusive(null, null, null, "query_reply", "no-response", "No cursor reply at origin")
      if (origin.row !== 1 || origin.col !== 1) {
        return inconclusive(
          origin,
          null,
          null,
          "query_reply",
          "insufficient-evidence",
          `Cursor origin measured ${origin.row};${origin.col}, expected 1;1`,
        )
      }
      if (setup) ctx.write(setup)
      const setupPosition = setup ? await ctx.queryCursorPosition() : origin
      if (!setupPosition) {
        return inconclusive(origin, null, null, "query_reply", "no-response", "No cursor reply after setup")
      }
      if (setup && !setupExpected) {
        return inconclusive(
          origin,
          setupPosition,
          null,
          "query_reply",
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
          "query_reply",
          "insufficient-evidence",
          `Cursor setup measured ${setupPosition.row};${setupPosition.col}, expected ${wantedSetup.row + 1};${wantedSetup.col + 1}`,
        )
      }
      ctx.write(move)
      const final = await ctx.queryCursorPosition()
      if (!final) {
        return inconclusive(origin, setupPosition, null, "query_reply", "no-response", "No cursor reply after movement")
      }
      const response = JSON.stringify({ origin, setup: setupPosition, final })
      const pass = final.row === expected.row + 1 && final.col === expected.col + 1
      return {
        pass,
        response,
        ...(pass
          ? {}
          : { note: `Cursor measured ${final.row};${final.col}, expected ${expected.row + 1};${expected.col + 1}` }),
        observation: { outcome: pass ? "supported" : "unsupported", assertionType: "query_reply" },
        assertions: [
          {
            assertionType: "query_reply" as const,
            kind: pass ? "positive" : "negative",
            expected: `cursor row=${expected.row + 1}, col=${expected.col + 1} after ${JSON.stringify(move)}`,
            observed: response,
          },
        ],
      }
    },

    libAssertionType: "buffer_state",
  }
}

/**
 * DECRPM mode probe. Responsiveness after enabling a mode does not prove that mode,
 * and blindly disabling it could change a mode the user already had enabled.
 */
export function decrpmModeProbe(
  id: string,
  modeNum: number,
  termlessFn: ((ctx: LibProbeSource) => ProbeCallbackResult) | null,
): ProbeDefinition {
  return {
    id,
    termWrites: "query",
    termAssertionType: "query_reply",
    lib: termlessFn,
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
export function headlessDecrpmArm(modeNum: number, modeName?: string): (ctx: LibProbeSource) => ProbeCallbackResult {
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
export function decrpmResult(ps: DecrpmPs | null, modeNum: number): ProbeCallbackResult {
  if (ps === null) {
    return {
      pass: false,
      note: "No DECRPM response",
      tests: [{ id: "criterion", status: "test-failure", reason: "No DECRPM response" }],
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
        assertionType: "query_reply",
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
      observation: { outcome: "unsupported", assertionType: "query_reply", note },
      assertions: [
        {
          assertionType: "query_reply" as const,
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
    observation: { outcome: "supported", assertionType: "query_reply" },
    assertions: [
      {
        assertionType: "query_reply" as const,
        kind: "positive",
        expected: `DECRPM mode ${modeNum} recognized (set or reset)`,
        observed: reading,
      },
    ],
  }
}

/**
 * The width a re-seeded `X` sweep proves from the engine's own cursor, or the named reason it proves
 * none (#31381, @cto cee6d003). The deciding observation is buffer state: no reply writer, no CPR.
 */
export type CellWidthSweep =
  | { kind: "width"; width: 80 | 132; cursor: { x: number; y: number } }
  | {
      kind: "unmeasured"
      reason: "autowrap off" | "133rd X did not wrap" | "width outside 80/132"
      cursor: { x: number; y: number }
    }

const CELL_WIDTH_SEED = "\x1b[0m\x1b[2J\x1b[H"

/**
 * Re-seed, then write 133 `X`s. The 133rd `X` is what separates the two admitted widths: at 80 the
 * cursor lands at row 1 col 53, at 132 the 133rd wraps and lands at row 1 col 1 — 132 is proven
 * exactly and never rounded up from `W >= 132`. A terminal that never wrapped reads row 0: col 79 or
 * 131 is the named `autowrap off` control (the cursor parks at the last column), col 132 or more is
 * `133rd X did not wrap` (at least 133 wide); every other reading is `width outside 80/132`. The
 * sweep decides from buffer state alone: no reply writer, no CPR.
 */
export function sweepCellWidth(ctx: Pick<LibProbeSource, "feed" | "getCursor">): CellWidthSweep {
  ctx.feed(CELL_WIDTH_SEED)
  ctx.feed("X".repeat(133))
  const cursor = ctx.getCursor()
  if (cursor.y === 1 && cursor.x === 53) return { kind: "width", width: 80, cursor }
  if (cursor.y === 1 && cursor.x === 1) return { kind: "width", width: 132, cursor }
  if (cursor.y === 0 && (cursor.x === 79 || cursor.x === 131)) {
    return { kind: "unmeasured", reason: "autowrap off", cursor }
  }
  if (cursor.y === 0 && cursor.x >= 132) return { kind: "unmeasured", reason: "133rd X did not wrap", cursor }
  return { kind: "unmeasured", reason: "width outside 80/132", cursor }
}

/** One DECCOLM measurement: both gate controls, the roundtrip, and the reply that only corroborates. */
export interface CellWidthTransitionReads {
  /** `?40` closed, mode 3 untouched: the baseline the transition is measured from. */
  initial: CellWidthSweep
  /** Gate control A: `?40` still closed and the mode set; the gate must hold the `initial` width. */
  gateBefore: CellWidthSweep
  /** `?40` opened, then the mode set in the direction the baseline implies. */
  enabled: CellWidthSweep
  /** After the mode was restored. */
  restored: CellWidthSweep
  /** Gate control B: `?40` closed again and the mode re-set; the gate must hold the `restored` width. */
  gateAfter: CellWidthSweep
  /** DECRPM `Ps` for mode 3; `null` when the engine answered nothing. */
  decrpm: DecrpmPs | null
  /** Columns an answering `18 t` reported for each phase; `null` = silent, which is not a datum. */
  reply18t: { initial: number | null; enabled: number | null; restored: number | null }
}

/** A named inconclusive: its typed test row carries the observed reading that named it. */
function cellWidthNamed(
  response: string,
  name: string,
  observed: object,
  assertions?: Array<Omit<ProbeAssertion, "featureId" | "rawReplyRef">>,
): ProbeCallbackResult {
  return {
    pass: false,
    response,
    observation: {
      outcome: "inconclusive",
      assertionType: "buffer_state",
      reason: "insufficient-evidence",
      note: name,
    },
    ...(assertions && { assertions }),
    tests: [{ id: "criterion", status: "test-failure", reason: `${name}: ${JSON.stringify(observed)}` }],
  }
}

/** The gate control's own assertion when ?40 closed did not hold the width (cee6d003). */
function gateNotHonoured(response: string, held: number, phase: string, sweep: { width: number }): ProbeCallbackResult {
  return cellWidthNamed(response, "gate not honoured", { [phase]: sweep }, [
    {
      assertionType: "buffer_state",
      kind: "negative",
      expected: `?40 closed holds the width at ${held} when mode 3 is set`,
      observed: `${phase}=${sweep.width}`,
    },
  ])
}

/**
 * The DECCOLM decision (#31381, @cto cee6d003). A measured no-change is Unsupported only where the
 * engine did not refuse the mode: `Ps 0` or `Ps 4` alongside an unchanged width is inconclusive
 * named, because an engine that says it does not know the mode has not been shown to implement it
 * wrongly. A silent `18 t` decides by width; an `18 t` that answers and disagrees is a named FAILURE.
 */
export function cellWidthTransition(reads: CellWidthTransitionReads): ProbeCallbackResult {
  const response = JSON.stringify(reads)
  const unmeasured = [reads.initial, reads.gateBefore, reads.enabled, reads.restored, reads.gateAfter].find(
    (sweep) => sweep.kind === "unmeasured",
  )
  if (unmeasured?.kind === "unmeasured") {
    const name =
      unmeasured === reads.initial && unmeasured.reason === "width outside 80/132"
        ? "initial width outside 80/132"
        : unmeasured.reason
    return cellWidthNamed(response, name, unmeasured)
  }
  if (
    reads.initial.kind !== "width" ||
    reads.enabled.kind !== "width" ||
    reads.restored.kind !== "width" ||
    reads.gateBefore.kind !== "width" ||
    reads.gateAfter.kind !== "width"
  ) {
    return cellWidthNamed(response, "width outside 80/132", reads)
  }
  const initial = reads.initial.width
  const target = initial === 80 ? 132 : 80
  if (reads.gateBefore.width !== initial) return gateNotHonoured(response, initial, "gateBefore", reads.gateBefore)
  if (reads.gateAfter.width !== reads.restored.width) {
    return gateNotHonoured(response, reads.restored.width, "gateAfter", reads.gateAfter)
  }
  const corroboration: ReadonlyArray<readonly [string, Extract<CellWidthSweep, { kind: "width" }>, number | null]> = [
    ["initial", reads.initial, reads.reply18t.initial],
    ["enabled", reads.enabled, reads.reply18t.enabled],
    ["restored", reads.restored, reads.reply18t.restored],
  ]
  for (const [phase, sweep, claimed] of corroboration) {
    if (claimed !== null && claimed !== sweep.width) {
      return {
        pass: false,
        response,
        tests: [
          {
            id: "criterion",
            status: "test-failure",
            reason: `18t/sweep disagreement W=${sweep.width} vs ${claimed} (${phase})`,
          },
        ],
      }
    }
  }
  const moved = reads.enabled.width === target && reads.restored.width === initial
  if (!moved && (reads.decrpm === 0 || reads.decrpm === 4)) {
    return cellWidthNamed(response, "mode not recognized/settable", {
      decrpm: reads.decrpm,
      enabled: reads.enabled.cursor,
    })
  }
  return {
    pass: moved,
    response,
    observation: { outcome: moved ? "supported" : "unsupported", assertionType: "buffer_state" },
    assertions: [
      {
        assertionType: "buffer_state",
        kind: moved ? "positive" : "negative",
        expected: `DECCOLM changes measured columns ${initial} -> ${target} -> ${initial} with ?40 honoured`,
        observed: `initial=${initial}, enabled=${reads.enabled.width}, restored=${reads.restored.width}`,
      },
      {
        assertionType: "buffer_state",
        kind: "positive",
        expected: `?40 closed holds the width at ${initial} when mode 3 is set, before and after the transition`,
        observed: `gateBefore=${reads.gateBefore.width}, gateAfter=${reads.gateAfter.width}`,
      },
    ],
  }
}

/** Check if a cell character is blank (empty or space). */
export function isBlank(char: string): boolean {
  return char === "" || char === " "
}

export function validSize(value: number, minimum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum
}

export function tooSmall(
  ctx: TermProbeSource,
  rows: number,
  cols: number,
  fixture = "Text fixture",
): ProbeCallbackResult | undefined {
  if (validSize(ctx.rows, rows) && validSize(ctx.cols, cols)) return undefined
  return {
    pass: false,
    tests: [
      {
        id: "criterion",
        status: "test-todo",
        reason: `${fixture} needs at least ${rows}x${cols}; measured ${ctx.rows}x${ctx.cols}`,
      },
    ],
  }
}

/**
 * Simple probe — for probes that need custom logic on both sides.
 */
export function probe(
  id: string,
  lib: ((ctx: LibProbeSource) => ProbeCallbackResult) | null,
  term: ((ctx: TermProbeSource) => Promise<ProbeCallbackResult>) | null,
  termAssertionType?: AssertionType | null,
): ProbeDefinition {
  const audited = lib && ((ctx: LibProbeSource) => replyPathAudited(id, ctx, lib))
  return { id, lib: audited, term, ...(termAssertionType !== undefined ? { termAssertionType } : {}) }
}

export const REPLY_PATH_AUDIT_REVIEW = "reply-path-audit-review"
export const HEADLESS_OBSERVABLE_REVIEW = "headless-observable-review"
export const UNTESTABLE_ONLY_REVIEW_BRANCHES: ReadonlySet<string> = new Set([
  REPLY_PATH_AUDIT_REVIEW,
  HEADLESS_OBSERVABLE_REVIEW,
])

/** The collector's test row for a capture that reached an engine callback its adapter does not reproduce. */
export const HARNESS_INCOMPLETE_TEST = "harness"

/**
 * Apply the reply-path audit table (reply-path-audit.ts) to one library probe; it decides nothing about identity.
 * The review replaces the measured result only when the probe sent its audited query and every matching capture
 * of it returned zero bytes. Any reply byte, an unsent query, or an unlisted artifact/feature keeps the measured result.
 */
function replyPathAudited(
  id: string,
  ctx: LibProbeSource,
  lib: (ctx: LibProbeSource) => ProbeCallbackResult,
): ProbeCallbackResult {
  const entry = replyPathAuditFor(ctx, id)
  if (entry === undefined) return lib(ctx)
  const captures: { text: string; reply: string }[] = []
  const matches = (text: string) =>
    entry.audit.matches === "prefix" ? text.startsWith(entry.audit.query) : text === entry.audit.query
  const record = (text: string, reply: string) => {
    if (matches(text)) captures.push({ text, reply })
  }
  const recorded = new Proxy(ctx, {
    get(target, key): unknown {
      if (key === "queryWithSentinelOutcome") {
        const query = target.queryWithSentinelOutcome
        if (query === undefined) return undefined
        return (text: string, pattern: RegExp) => {
          const outcome = query.call(target, text, pattern)
          record(text, outcome.raw)
          return outcome
        }
      }
      if (key !== "feedCapture") {
        const value: unknown = Reflect.get(target, key, target)
        return value
      }
      return (text: string) => {
        const reply = target.feedCapture(text)
        record(text, reply)
        return reply
      }
    },
  })
  const measured = lib(recorded)
  if (captures.length === 0 || captures.some(({ reply }) => reply.length > 0)) return measured
  const review = replyPathReviewResult(id, entry.artifactSha256, entry.audit, captures, measured)
  return measured.hostRecipeCauses ? { ...review, hostRecipeCauses: measured.hostRecipeCauses } : review
}

/**
 * The cell records which entry fired, the query it matched, and the zero-byte fact. A missing reply path reads
 * "review by reply-path audit"; a cited parser rejection on the live path is Unsupported whatever the artifact's
 * reply delivery, because no reply transport changes a result the engine never produces (@cto d9998884).
 */
function replyPathReviewResult(
  id: string,
  artifactSha256: string,
  audit: ReplyPathAudit,
  captures: readonly { text: string; reply: string }[],
  measured: ProbeCallbackResult,
): ProbeCallbackResult {
  const replyPathAudit = { artifactSha256, featureId: id, ...audit, captures: captures.length, replyBytes: 0 }
  const measuredResponse = measured.response ?? null
  if (audit.kind === "no-reply-path") {
    return reviewResult(
      REPLY_PATH_AUDIT_REVIEW,
      `Review by reply-path audit: the loaded artifact has no reply path (${audit.citation}); Untestable review required`,
      `${id}: no reply path for this query in the loaded artifact`,
      {
        replyPathAudit,
        measuredResponse,
        ...(audit.matches === "prefix" && { matchedQueries: captures.map(({ text }) => text) }),
      },
    )
  }
  return parserStateResult(
    false,
    `parser-level rejection of ${JSON.stringify(audit.query)}`,
    { rejection: "parser", replyPathAudit, measuredResponse },
    "negative by source citation",
    undefined,
    "query_reply",
  )
}

/** Feature support is independent of whether an observer can inspect link metadata. */
export function readHyperlinkMetadata(
  available: boolean,
  readLink: LibProbeSource["getHyperlinkAt"],
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
): ProbeCallbackResult | null {
  const answer = sentinelAnswer(raw)
  if (!sentinel || answer === null || answer.start > 0 || raw.slice(answer.end).trim() !== "") return null
  const observed = `DA1 answered at +${String(sentinel.atMs)}ms; no reply through the ${String(sentinel.graceMs)} ms window`
  return {
    pass: false,
    response: raw,
    observation: { outcome: "unsupported", assertionType: "query_reply", note: "negative by sentinel" },
    assertions: [{ assertionType: "query_reply" as const, kind: "negative", expected, observed }],
  }
}

/**
 * F4 (#30699): a hand-written probe's headless arm reads a bare capture, so on a proven engine a query
 * the terminal ignores looks the same as one the collector never delivered. Ask the sentinel member
 * first: an answered DA1 with no matching frame is the measured negative the criterion names, graded
 * exactly as live grades it. Every other outcome returns null and the probe keeps its own capture
 * reading, so an engine off the proven list is unchanged.
 */
export function sentinelSilenceResult(outcome: TerminalQueryOutcome, expected: string): ProbeCallbackResult | null {
  if (outcome.reason !== "sentinel") return null
  return sentinelNegativeResult(outcome.raw, outcome.sentinel, expected)
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
  manifest: ProbeSuiteManifest & { schemaVersion: 4 }
  source: RunDraft["source"]
  intendedSubject: RunDraft["intendedSubject"]
}): RunDraft {
  if (input.manifest.schemaVersion !== 4) {
    throw new Error("Current run writer requires a schemaVersion 4 suite manifest")
  }
  assertLiveSource(input.source)
  const ids = input.manifest.catalogIds
  if (!ids || ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error(`Suite ${input.manifest.probeHash} requires a nonempty unique frozen catalogIds set`)
  }
  return {
    schemaVersion: 4,
    source: { kind: input.source.kind },
    runId: input.runId,
    suiteId: input.manifest.probeHash,
    probeHash: input.manifest.probeHash,
    sourceRevision: input.sourceRevision,
    intendedSubject: { ...input.intendedSubject },
    results: ids.map((featureId) => ({
      featureId,
      status: "test-todo",
      attempt: { scope: "none" },
      tests: [],
      reason: "Required probe test has not started",
    })),
    rawReplies: {},
    assertions: [],
    screenshotRefs: [],
  }
}

/** Fold only the tests still required by the frozen probe's explicitly selected criterion branch. */
export function finalizeProbeResult(input: Omit<ProbeResult, "status">): ProbeResult {
  const tests = input.tests
  const failed = tests.find((test) => test.status === "test-failure")
  const pending = tests.find((test) => test.status === "test-todo")
  const impossible = tests.find((test) => test.status === "untestable")
  let status: ProbeResult["status"]
  let reason = input.reason
  if (failed) {
    status = "test-failure"
    reason ??= failed.reason ?? "Required test failed after its attempt"
  } else if (pending || tests.length === 0) {
    status = "test-todo"
    reason ??= pending?.reason ?? "Required feature implementation has not run"
  } else if (impossible) {
    status = impossible.reviewRef ? "untestable" : "test-todo"
    reason ??= impossible.reason ?? "Context-impossibility review is required"
  } else {
    status = tests.some((test) => test.status === "unsupported") ? "unsupported" : "supported"
  }
  return { ...input, status, ...(reason === undefined ? {} : { reason }) }
}

/** Seal only measured/enriched identity; pending required review keeps the same draft open. */
export function sealRunDraft(draft: RunDraft, sealedAt = new Date().toISOString()): CurrentProbeRun {
  assertLiveSource(draft.source)
  if (draft.schemaVersion !== 4) throw new Error("Current run writer requires schemaVersion 4")
  if (!draft.subject || !draft.identity || !draft.measuredAt || !draft.origin) {
    throw new Error(`Run ${draft.runId} has no complete measured identity to seal; retain its private draft`)
  }
  if (
    draft.results.some((result) =>
      result.tests.some(
        (test) =>
          test.id === "review" &&
          (test.status === "test-todo" ||
            (result.criterionBranch === SOURCE_NEGATIVE_REVIEW && test.status === "test-failure")),
      ),
    )
  ) {
    throw new Error(`Run ${draft.runId} has a required review pending; retain its unsealed capture`)
  }
  return {
    ...draft,
    subject: draft.subject,
    identity: draft.identity,
    measuredAt: draft.measuredAt,
    origin: draft.origin,
    sealedAt,
  }
}

function assertLiveSource(source: RunDraft["source"]): void {
  const kind = (source as { kind?: unknown } | undefined)?.kind
  if (kind === "trace") throw new Error("trace probe source has no implementation at this source; see recorder #30932")
  if (kind !== "live") throw new Error("Current run writer requires an explicit live probe source")
}

/** Execute the declared callback's proposition once; readers consume this recorded result. */
export function recordExecutedProbe(input: {
  featureId: string
  attempt: Exclude<ProbeAttempt, { scope: "none" }>
  observation?: Observation
  diagnostic?: UngradedDiagnostic
  coverage?: NotTestedCoverage
  rawReplyRef?: string
  assertions: readonly ProbeAssertion[]
  tests?: ProbeTestInput[]
  criterionBranch?: string
}): ProbeResult {
  const { featureId, attempt, observation, diagnostic, coverage } = input
  if (!observation && !coverage && input.tests && !diagnostic) {
    if (
      input.tests.length === 0 ||
      input.tests.some((test) => !["test-todo", "test-failure"].includes(test.status) || !test.reason?.trim())
    ) {
      throw new Error(`Execution-only callback ${featureId} requires nonempty TODO/FAILURE tests with reasons`)
    }
  }
  const assertionRefs = input.assertions.flatMap((entry, index) => (entry.featureId === featureId ? [index] : []))
  const missingCapture = diagnostic?.kind === "collector-error" && diagnostic.name === "FrameUnavailable"
  const status = missingCapture
    ? "test-todo"
    : diagnostic || observation?.outcome === "error"
      ? "test-failure"
      : observation?.outcome === "supported" || observation?.outcome === "unsupported"
        ? observation.outcome
        : coverage
          ? "test-todo"
          : "test-failure"
  const diagnosticReason = diagnostic?.kind === "collector-error" ? diagnostic.message : diagnostic?.note
  const reason =
    !input.tests && !diagnostic && !coverage && observation?.outcome === "inconclusive"
      ? "writer default: inconclusive observation without test rows; callback defect"
      : (diagnosticReason ?? observation?.note ?? coverage?.noObservable ?? observation?.reason)
  const rawReplyRef = observation?.rawReplyRef ?? coverage?.rawReplyRef ?? input.rawReplyRef
  return finalizeProbeResult({
    featureId,
    attempt,
    tests:
      input.tests && !diagnostic && observation?.outcome !== "error"
        ? input.tests.map((test) => {
            if (!test.id || !PROBE_STATUSES.includes(test.status)) {
              throw new Error(`Invalid callback test for ${featureId}`)
            }
            const refs =
              test.assertionRefs === undefined
                ? test.status === "test-todo"
                  ? []
                  : assertionRefs
                : test.assertionRefs.map((index) => {
                    const globalIndex = assertionRefs[index]
                    if (globalIndex === undefined) {
                      throw new Error(`Callback test ${featureId}/${test.id} names an absent assertion`)
                    }
                    return globalIndex
                  })
            return {
              id: test.id,
              status: test.status,
              attempt: test.status === "test-todo" ? { scope: "none" } : attempt,
              assertionRefs: refs,
              ...(rawReplyRef && { rawReplyRef }),
              ...(test.reason && { reason: test.reason }),
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
    ...(observation?.assertionType && { assertionType: observation.assertionType }),
    ...(rawReplyRef && { rawReplyRef }),
    ...(observation?.frames && { frames: observation.frames }),
    ...(observation?.screenshotRef && { screenshotRef: observation.screenshotRef }),
    ...(observation?.host && { host: observation.host }),
    ...(reason && { reason }),
  })
}

/** The execution owner records an aborted collection against affected unfinished features. */
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
      ? finalizeProbeResult({
          ...result,
          attempt,
          reason: diagnostic,
          tests: [
            ...result.tests.filter((test) => test.id !== "collection"),
            { id: "collection", status: "test-failure", attempt, reason: diagnostic },
          ],
        })
      : result,
  )
}
