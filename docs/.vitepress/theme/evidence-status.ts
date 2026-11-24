/**
 * The ONE status rule and short message templates an evidence cell applies to a stored result.
 *
 * #37341 Q1 (@cpo/term f16a5a52): a result we haven't decided is left blank. The three undecided statuses and a
 * missing result wear one status: an em dash with no badge, whose hover reads "No result yet". An environment
 * position is no exception. Any decided status shows as stored.
 *
 * #37631: one short message template per evidence kind for default result cards.
 */
import type { FeatureResultStatus } from "../../../packages/probe-defs/src/types.ts"
import { DIFFERS_BY_CONTEXT } from "../../data/app-cells.ts"
import { categoryMark } from "../../data/result-categories.ts"

export type EvidenceTone = "yes" | "no" | "ungraded" | "unknown" | "error" | "differs"

export interface EvidenceStatus {
  readonly text: string
  readonly icon: string
  readonly tone: EvidenceTone
  /** The hover words of a cell that has no badge text. */
  readonly title?: string
}

/** What an undecided or missing result wears: a blank cell, never an invented verdict and never an internal label. */
export const NO_RESULT_STATUS: EvidenceStatus = { text: "", icon: "—", tone: "unknown", title: "No result yet" }

const STORED_STATUS: Readonly<Record<FeatureResultStatus, EvidenceStatus>> = {
  supported: { text: "Supported", icon: "✓", tone: "yes" },
  unsupported: { text: "Unsupported", icon: "✗", tone: "no" },
  // #37761: the same mark the bar's popover and every result list use (result-categories.ts is its one home).
  untestable: { text: "Untestable", icon: categoryMark("untestable"), tone: "ungraded" },
  "probe-todo": NO_RESULT_STATUS,
  "probe-invalid": NO_RESULT_STATUS,
  "probe-conflict": NO_RESULT_STATUS,
}

/**
 * What a cell wears when the contexts that measured the same release disagree (@cto d321729a rule 3):
 * decided, in its own bucket, never Supported or Unsupported. The cell itself names each context.
 */
export const DIFFERS_BY_CONTEXT_STATUS: EvidenceStatus = { text: "Differs by context", icon: "≠", tone: "differs" }

/** What a cell derived from a refused parent wears (#33019): never the bare words of a direct measurement. */
export const DERIVED_UNSUPPORTED_STATUS: EvidenceStatus = { text: "Unsupported, derived", icon: "✗", tone: "no" }

export function evidenceStatus(
  _featureId: string,
  status: FeatureResultStatus | typeof DIFFERS_BY_CONTEXT | undefined,
  derived = false,
): EvidenceStatus {
  if (status === undefined) return NO_RESULT_STATUS
  if (status === DIFFERS_BY_CONTEXT) return DIFFERS_BY_CONTEXT_STATUS
  if (status === "unsupported" && derived) return DERIVED_UNSUPPORTED_STATUS
  const shown = STORED_STATUS[status]
  if (shown === undefined) throw new Error(`evidenceStatus: unknown stored status ${JSON.stringify(status)}`)
  return shown
}

/** The words a table cell prints for a status: the badge text, or the hover words of a blank. */
export function evidenceStatusWords(status: EvidenceStatus): string {
  return status.text || (status.title ?? "")
}

/** Closed set of public card evidence kinds (one short template each, #37631). */
export type CardEvidenceKind =
  | "screen"
  | "reply"
  | "no-reply"
  | "untestable"
  | "differs"
  | "no-result"
  | "derived"
  | "other"

export interface CardMessageInput {
  readonly status: FeatureResultStatus | typeof DIFFERS_BY_CONTEXT | undefined
  readonly derived?: boolean
  readonly assertionType?: string
  /** Evidence sentences already worded by evidence-messages.ts when the trace is loaded. */
  readonly traceEvidence?: readonly string[]
  /** Short reader-safe reason stored on the cell (used for untestable or fallback unsupported reason). */
  readonly reason?: string
}

/** Classify a cell into one public card evidence kind. */
export function cardEvidenceKind(input: CardMessageInput): CardEvidenceKind {
  if (input.status === undefined) return "no-result"
  if (input.status === "probe-todo" || input.status === "probe-invalid" || input.status === "probe-conflict") {
    return "no-result"
  }
  if (input.status === DIFFERS_BY_CONTEXT) return "differs"
  if (input.status === "unsupported" && input.derived) return "derived"
  if (input.status === "untestable") return "untestable"
  const joined = input.traceEvidence?.join(" ") ?? ""
  if (input.assertionType === "screenshot" || input.assertionType === "visual") return "screen"
  if (input.assertionType === "query_reply") {
    if (/no reply|sent nothing/i.test(joined) || /no reply|timed out|sentinel/i.test(input.reason ?? "")) {
      return "no-reply"
    }
    return "reply"
  }
  return "other"
}

/**
 * One short, plain message template per evidence kind for the default result card (#37631).
 * Prefers the trace's exact `evidence-messages.ts` sentence(s) when loaded; otherwise uses a
 * concise per-kind sentence without raw JSON, internal paths, or probe scaffolding.
 */
export function evidenceSummaryLine(input: CardMessageInput): string {
  const kind = cardEvidenceKind(input)
  if (kind === "no-result") return "No result yet for this release."
  if (kind === "differs") return "Results differ across measured contexts."
  if (kind === "derived") return "Unsupported because its required parent feature is unsupported."
  if (input.traceEvidence && input.traceEvidence.length > 0) {
    return input.traceEvidence.join(" ")
  }
  if (kind === "untestable") {
    const cleanReason = input.reason?.trim()
    return cleanReason ? `Untestable: ${cleanReason}` : "Could not be tested automatically in this environment."
  }
  if (kind === "screen") {
    return input.status === "supported"
      ? "Screen matched the expected frame."
      : "Screen did not match the expected frame."
  }
  if (kind === "reply") {
    return input.status === "supported"
      ? "Terminal returned the expected reply."
      : "Terminal did not return the expected reply."
  }
  if (kind === "no-reply") {
    return "Terminal sent no reply to the query."
  }
  const cleanReason = input.reason?.trim()
  if (cleanReason) return cleanReason
  return input.status === "supported"
    ? "Terminal produced the expected result."
    : "Terminal did not produce the expected result."
}

/**
 * One plain sentence describing what a feature should do, derived from its catalog description or
 * probe guidance — never raw assertion JSON like `cell-aligned region {"top":3,...}`.
 */
export function plainExpectedSentence(input: {
  readonly body?: string
  readonly probeGuidance?: string
  readonly featureName?: string
}): string {
  const fromBody = firstPlainSentence(input.body)
  if (fromBody) return fromBody
  const fromProbe = firstPlainSentence(input.probeGuidance?.replace(/^(?:Headless|App|Libraries)\s*:\s*/iu, ""))
  if (fromProbe) return fromProbe
  return input.featureName
    ? `Terminal handles ${input.featureName} as specified.`
    : "Terminal handles this sequence as specified."
}

function firstPlainSentence(raw?: string): string | undefined {
  if (!raw) return undefined
  const text = raw
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!text) return undefined
  // Split at sentence-ending punctuation, skipping common abbreviations like i.e., e.g., vs., etc.
  const match = /^(.+?(?<!\b(?:i\.e|e\.g|etc|vs|fig|no|approx))[.!?])(?:\s+[A-Z0-9"'(]|$)/u.exec(text)
  const sentence = (match?.[1] ?? text).trim()
  if (sentence.length <= 180) return sentence
  return `${sentence.slice(0, 177).trimEnd()}…`
}

export interface TechnicalDetailsInput {
  readonly declaredSequence?: string
  readonly observedSummary: string
  readonly hasStepTable: boolean
  readonly fullSentBytes?: string
  readonly fullReplyBytes?: string
  readonly queryBytes?: string
  readonly parserStatePre?: string
  readonly selectionExplanation?: string
  readonly evidenceError?: string
}

export interface TechnicalDetailsSelection {
  readonly showSteps: boolean
  readonly sentBytes?: string
  readonly queryBytes?: string
  readonly replyBytes?: string
  readonly parserStatePre?: string
  readonly selectionExplanation?: string
  readonly evidenceError?: string
  readonly hasContent: boolean
}

function normalizeSeq(text?: string): string {
  return (text ?? "")
    .replace(/\s+/g, " ")
    .replace(/ESC\s*\[\s*/g, "ESC[")
    .replace(/ESC\s*\]\s*/g, "ESC]")
    .replace(/ESC\s*P\s*/g, "ESCP")
    .replace(/ESC\s*\\/g, "ESC\\")
    .trim()
}

/**
 * Strip the trailing DA1 device-check fence (`ESC [ c`) when the declared test sequence itself
 * is not DA1 (`ESC [ c`), so Technical details never repeats a query that only adds the probe fence.
 */
function stripTrailingFence(query: string, declared: string): string {
  if (/ESC\[c$/i.test(declared)) return query
  return query.replace(/\s*ESC\[c\s*$/i, "").trim()
}

/**
 * Select only non-duplicate technical details for a result card (#37631).
 * Never repeats Expected, Observed, or a query/write identical to Test sequence (+ fence);
 * when nothing genuinely new remains, `hasContent` is false and the disclosure is omitted.
 */
export function technicalDetailsContent(input: TechnicalDetailsInput): TechnicalDetailsSelection {
  const normDeclared = normalizeSeq(input.declaredSequence)
  const normObserved = normalizeSeq(input.observedSummary)

  const normSent = normalizeSeq(input.fullSentBytes)
  const sentBytes =
    input.fullSentBytes && normSent !== "" && normSent !== normDeclared ? input.fullSentBytes : undefined

  const rawQuery = input.queryBytes?.trim()
  const normQuery = stripTrailingFence(normalizeSeq(rawQuery), normDeclared)
  const queryBytes =
    rawQuery && normQuery !== "" && normQuery !== normDeclared && normQuery !== normSent ? rawQuery : undefined

  const normReply = normalizeSeq(input.fullReplyBytes)
  const replyAlreadyInObserved = normReply !== "" && normObserved.includes(normReply)
  const replyBytes =
    input.fullReplyBytes && normReply !== "" && !replyAlreadyInObserved ? input.fullReplyBytes : undefined

  const parserStatePre = input.parserStatePre?.trim() ? input.parserStatePre : undefined
  const selectionExplanation = input.selectionExplanation?.trim() ? input.selectionExplanation : undefined
  const evidenceError = input.evidenceError?.trim() ? input.evidenceError : undefined

  const hasContent = Boolean(
    input.hasStepTable ||
    sentBytes ||
    queryBytes ||
    replyBytes ||
    parserStatePre ||
    selectionExplanation ||
    evidenceError,
  )

  return {
    showSteps: input.hasStepTable,
    ...(sentBytes && { sentBytes }),
    ...(queryBytes && { queryBytes }),
    ...(replyBytes && { replyBytes }),
    ...(parserStatePre && { parserStatePre }),
    ...(selectionExplanation && { selectionExplanation }),
    ...(evidenceError && { evidenceError }),
    hasContent,
  }
}
