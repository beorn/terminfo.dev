import type {
  ProbeResult,
  ProbeStatus,
  Observation,
  ObservationReason,
  ProbeAssertion,
} from "../../packages/probe-defs/src/types.ts"
import type { HistoricalCellEvidence } from "./public-results.ts"
import type { TraceIdentityRuleCheck } from "./run-trace.ts"

/**
 * The environment variable each process_environment feature reads, for the evidence sentences and the cards alike.
 * A secret variable (OSC 7577's per-pane token, @cto ee6b7fd9) is never kept, parsed or shown: a card says only
 * whether it was set and how long it was.
 */
export const ENVIRONMENT_READS: Readonly<
  Record<string, { variable: string; value: RegExp } | { variable: string; secret: true }>
> = {
  "device.term-features": { variable: "TERM_FEATURES", value: /^[A-Za-z0-9:,_-]{1,200}$/ },
  "extensions.osc7577-token": { variable: "OSC7577_TOKEN", secret: true },
}

export type LoadedCellEvidence = HistoricalCellEvidence & { version: 2; runId: string; runSha256: string }
export interface CellEvidenceExpectation {
  schemaVersion: 1 | 2
  runId: string
  runSha256: string
  featureId: string
  reviewId: string
  status?: ProbeStatus
}

export interface TraceQuery {
  sequence: string
  reason?: string
  match?: string[] | null
}

export interface TraceEvent {
  kind: string
  sequence?: string
  reason?: string
  match?: string[] | null
}

export interface TraceAssertion {
  kind: ProbeAssertion["kind"]
  expected: string
  observed?: string
}

export interface TraceCaptureImage {
  url: string
  sha256: string
  width: number
  height: number
}

export interface TraceCaptures {
  observed?: TraceCaptureImage
  /** Whole terminal cell grid crop only (never window titlebar or desktop). */
  full?: TraceCaptureImage
  expected?: TraceCaptureImage
  /** Captured text-cell slice for terminals captured as text snapshots (e.g. Terminal.app macOS). */
  textCells?: string
  regionText?: string
}

export interface TraceCellRecord {
  outcome?: Observation["outcome"]
  status?: ProbeStatus
  assertionType?: Observation["assertionType"] | ProbeResult["assertionType"]
  reason?: ObservationReason
  /** One or two plain sentences on what the test observed, worded at trace build (evidence-messages.ts). */
  evidence?: string[]
  writes?: string[]
  queries?: TraceQuery[]
  events?: TraceEvent[]
  parserState?: unknown
  /** Allowlisted verbatim parser/app log line for report-reader probes (Style 5, #38269). */
  logLine?: string
  /** Allowlisted probe-owned clipboard read-back nonce for OSC 52 write probes (Style 5, #38269). */
  clipboardRead?: string
  /** Closed reason slug explaining why an untestable cell could not be tested automatically (Style 5, #38269). */
  untestableCause?: string
  /** Cropped screen capture images emitted under /api/v3/captures/<sha256>.png (#38269). */
  captures?: TraceCaptures
  assertions: TraceAssertion[]
}

export interface LoadedCellTrace {
  version: 1
  schemaVersion: number
  runId: string
  runSha256: string
  measuredAt: string
  sourceRevision: string | null
  identity: {
    recorded: string
    currentRuleCheck?: TraceIdentityRuleCheck
  }
  featureId: string
  cell: TraceCellRecord
}

export interface CellTraceExpectation {
  schemaVersion: number
  runId: string
  runSha256: string
  featureId: string
  expectedSha256?: string
  actualSha256?: string
}

export interface TracePaneItem {
  label: string
  code?: string
  pre?: string
  text?: string
}

export interface TracePaneCopy {
  tested: {
    items: TracePaneItem[]
    sourceLine: string
    /** Absent when the trace carries no identity-rule check (#34617): the recorded draft field is no verdict. */
    identityLine?: string
    text: string
  }
  expected: {
    sequence?: string
    behavior: string
    referenceStatus: string
    text: string
  }
}

export interface TracePaneOptions {
  sequence?: string
  probeGuidance?: string
  subjectKind?: string
  hasReferenceImage?: boolean
}

const CONTROL_NAMES: Record<number, string> = {
  0x00: "NUL",
  0x01: "SOH",
  0x02: "STX",
  0x03: "ETX",
  0x04: "EOT",
  0x05: "ENQ",
  0x06: "ACK",
  0x07: "BEL",
  0x08: "BS",
  0x09: "HT",
  0x0a: "LF",
  0x0b: "VT",
  0x0c: "FF",
  0x0d: "CR",
  0x0e: "SO",
  0x0f: "SI",
  0x10: "DLE",
  0x11: "DC1",
  0x12: "DC2",
  0x13: "DC3",
  0x14: "DC4",
  0x15: "NAK",
  0x16: "SYN",
  0x17: "ETB",
  0x18: "CAN",
  0x19: "EM",
  0x1a: "SUB",
  0x1b: "ESC",
  0x1c: "FS",
  0x1d: "GS",
  0x1e: "RS",
  0x1f: "US",
  0x7f: "DEL",
  0x84: "IND",
  0x85: "NEL",
  0x88: "HTS",
  0x8d: "RI",
  0x8e: "SS2",
  0x8f: "SS3",
  0x90: "DCS",
  0x9b: "CSI",
  0x9c: "ST",
  0x9d: "OSC",
  0x9e: "PM",
  0x9f: "APC",
}

const CELL_SNAPSHOT_KEYS = new Set([
  "char",
  "fg",
  "bg",
  "bold",
  "dim",
  "italic",
  "underline",
  "underlineColor",
  "strikethrough",
  "inverse",
  "blink",
  "hidden",
  "wide",
  "continuation",
  "hyperlink",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function readEscapeToken(normalized: string, index: number): { token: string; length: number } {
  const next = normalized[index + 1]
  if (next === "\\") return { token: "ESC \\", length: 2 }
  const rest = normalized.slice(index + 2)
  if (next === "[") {
    const csi = /^([?>=]?)([0-9:;]*)([ -/]*)([@-~])/.exec(rest)
    if (csi) {
      const [full, prefix, params, inter, final] = csi
      const head = `${prefix ?? ""}${params ?? ""}`
      // A space intermediate is spelled SP, as the standards and features.json write it (`CSI Ps SP p`), so it
      // is never read as a gap between tokens (#38757).
      const intermediates = inter ? [...inter].map((c) => (c === " " ? "SP" : c)).join(" ") : ""
      const parts = ["ESC", "[", head, intermediates, final].filter(Boolean)
      return { token: parts.join(" "), length: 2 + full.length }
    }
  }
  if (next === "P") {
    const dcs = /^([0-9;]*)(\$[qr])([ -~]+?)(?=\u001b\\|$)/.exec(rest)
    if (dcs) {
      const [full, status, op, payload] = dcs
      const csiBody = payload ? /^([?>=]?)([0-9:;]+)([ -/]*)([@-~])$/.exec(payload) : null
      const formattedPayload = csiBody
        ? [`${csiBody[1] ?? ""}${csiBody[2] ?? ""}`, csiBody[3], csiBody[4]].filter(Boolean).join(" ")
        : payload
      const parts = ["ESC", "P", status, op === "$q" ? "$ q" : "$ r", formattedPayload].filter(Boolean)
      return { token: parts.join(" "), length: 2 + full.length }
    }
  }
  return { token: "ESC", length: 1 }
}

function isControlCode(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f)
}

/**
 * Render control bytes visibly (`ESC [ 42 m`, `ESC P $ q m ESC \`, `BEL`, etc.) while keeping
 * ordinary words intact.
 */
export function formatControlBytes(input: string): string {
  // Normalize literal `\x1b` escapes from catalog prose before tokenizing control bytes.
  const normalized = input.replace(/\\x1b/gi, "\u001b")
  const tokens: string[] = []
  let i = 0
  while (i < normalized.length) {
    const ch = normalized.charCodeAt(i)
    if (ch === 0x1b) {
      const { token, length } = readEscapeToken(normalized, i)
      tokens.push(token)
      i += length
      continue
    }
    if (isControlCode(ch)) {
      tokens.push(CONTROL_NAMES[ch] ?? `0x${ch.toString(16).padStart(2, "0")}`)
      i += 1
      continue
    }
    let end = i + 1
    while (end < normalized.length && !isControlCode(normalized.charCodeAt(end))) {
      end += 1
    }
    tokens.push(normalized.slice(i, end))
    i = end
  }
  let out = ""
  for (const token of tokens) {
    const needsSpace =
      out.length > 0 && !out.endsWith(" ") && !out.endsWith("\n") && !token.startsWith(" ") && !token.startsWith("\n")
    if (needsSpace) out += " "
    out += token
  }
  return out
}

function isCellSnapshot(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  return (
    keys.includes("char") &&
    keys.includes("fg") &&
    keys.includes("bg") &&
    keys.every((key) => CELL_SNAPSHOT_KEYS.has(key))
  )
}

function formatColor(color: unknown): string {
  if (color === null || color === undefined) return "null"
  if (isRecord(color) && typeof color.r === "number" && typeof color.g === "number" && typeof color.b === "number") {
    return `rgb(${color.r},${color.g},${color.b})`
  }
  return JSON.stringify(color)
}

function formatCellSnapshot(cell: Record<string, unknown>): string {
  const parts: string[] = []
  if (typeof cell.char === "string" && cell.char !== "") parts.push(JSON.stringify(cell.char))
  if (cell.fg !== null && cell.fg !== undefined) parts.push(`fg ${formatColor(cell.fg)}`)
  if (cell.bg !== null && cell.bg !== undefined) parts.push(`bg ${formatColor(cell.bg)}`)
  if (cell.underlineColor !== null && cell.underlineColor !== undefined) {
    parts.push(`underlineColor ${formatColor(cell.underlineColor)}`)
  }
  if (cell.hyperlink !== null && cell.hyperlink !== undefined) {
    parts.push(`hyperlink ${JSON.stringify(cell.hyperlink)}`)
  }
  for (const flag of [
    "bold",
    "dim",
    "italic",
    "underline",
    "strikethrough",
    "inverse",
    "blink",
    "hidden",
    "wide",
    "continuation",
  ]) {
    if (cell[flag] !== false && cell[flag] !== undefined) {
      parts.push(cell[flag] === true ? flag : `${flag}=${JSON.stringify(cell[flag])}`)
    }
  }
  if (parts.length === 0 || (parts.length === 1 && typeof cell.char === "string")) {
    parts.push("bg null (default)")
  }
  return parts.join(" ")
}

function formatParserState(parserState: unknown): string {
  if (isCellSnapshot(parserState)) return formatCellSnapshot(parserState)
  if (isRecord(parserState)) {
    const entries = Object.entries(parserState)
    if (entries.length === 0) return "{}"
    return entries
      .map(([key, value]) => `${key}: ${isCellSnapshot(value) ? formatCellSnapshot(value) : JSON.stringify(value)}`)
      .join("\n")
  }
  return typeof parserState === "string" ? formatControlBytes(parserState) : JSON.stringify(parserState)
}

/**
 * #34617: name this build's identity-rule check of the run's retained evidence, scoped to the trace build; the
 * recorded collector field (`unverified` on every draft) is kept in the trace but never printed as a verdict.
 */
function formatTraceIdentity(identity: LoadedCellTrace["identity"]): string | undefined {
  const check = identity.currentRuleCheck
  if (!check) return undefined
  const facts = [
    `rule revision ${check.ruleRevision}`,
    ...(check.xtversion !== undefined ? [`XTVERSION "${check.xtversion}"`] : []),
    ...(check.da1 !== undefined ? [`DA1 "${check.da1}"`] : []),
    ...(check.receipt ? [`bundle version ${check.receipt.cfBundleShortVersionString}`] : []),
    ...(check.executable
      ? [`executable ${check.executable.version}, sha256 ${check.executable.sha256.slice(0, 12)}`]
      : []),
  ]
  return `At trace build, retained identity evidence matched the ${check.rule} identity rule (${facts.join("; ")}).`
}

const RULE_CHECK_KEYS = new Set(["checkedAt", "rule", "ruleRevision", "da1", "xtversion", "receipt", "executable"])
const optionalString = (value: unknown): boolean => value === undefined || typeof value === "string"

/** Validate an optional `identity.currentRuleCheck` by name: absent is no claim, malformed is a structure error. */
function readIdentityRuleCheck(value: unknown): TraceIdentityRuleCheck | undefined | null {
  if (value === undefined) return undefined
  if (!isRecord(value) || Object.keys(value).some((key) => !RULE_CHECK_KEYS.has(key))) return null
  const { checkedAt, rule, ruleRevision, da1, xtversion, receipt, executable } = value
  if (
    checkedAt !== "build" ||
    typeof rule !== "string" ||
    rule.length === 0 ||
    typeof ruleRevision !== "string" ||
    !/^[0-9a-f]{12}$/.test(ruleRevision) ||
    !optionalString(da1) ||
    !optionalString(xtversion) ||
    (receipt !== undefined &&
      (!isRecord(receipt) ||
        Object.keys(receipt).length !== 1 ||
        typeof receipt.cfBundleShortVersionString !== "string")) ||
    (executable !== undefined &&
      (!isRecord(executable) ||
        Object.keys(executable).length !== 2 ||
        typeof executable.version !== "string" ||
        typeof executable.sha256 !== "string"))
  ) {
    return null
  }
  return {
    checkedAt,
    rule,
    ruleRevision,
    ...(da1 !== undefined && { da1: da1 as string }),
    ...(xtversion !== undefined && { xtversion: xtversion as string }),
    ...(receipt !== undefined && {
      receipt: { cfBundleShortVersionString: receipt.cfBundleShortVersionString as string },
    }),
    ...(executable !== undefined && {
      executable: { version: executable.version as string, sha256: executable.sha256 as string },
    }),
  }
}

/**
 * Read an archived historical evidence document (`version: 2`) for `expectation.featureId`.
 */
export function readCellEvidence(parsed: unknown, expectation: CellEvidenceExpectation): LoadedCellEvidence {
  const expectedDocumentVersion = 2
  if (
    !isRecord(parsed) ||
    parsed.version !== expectedDocumentVersion ||
    parsed.runId !== expectation.runId ||
    parsed.runSha256 !== expectation.runSha256 ||
    !isRecord(parsed.cells)
  ) {
    throw new Error("Evidence document identity or structure does not match this result")
  }
  const cellEntry = parsed.cells[expectation.featureId]
  if (cellEntry === undefined) {
    throw new Error("no evidence stored for this cell")
  }
  const payload = isRecord(cellEntry) ? cellEntry.observation : undefined
  if (
    !isRecord(cellEntry) ||
    cellEntry.featureId !== expectation.featureId ||
    !isRecord(payload) ||
    payload.featureId !== expectation.featureId ||
    (expectation.status !== undefined && payload.status !== expectation.status) ||
    !isRecord(cellEntry.record) ||
    !Array.isArray(cellEntry.record.assertions) ||
    !isRecord(cellEntry.review) ||
    cellEntry.review.id !== expectation.reviewId
  ) {
    throw new Error("Evidence document identity or structure does not match this result")
  }
  return {
    version: expectedDocumentVersion,
    runId: expectation.runId,
    runSha256: expectation.runSha256,
    ...(cellEntry as unknown as HistoricalCellEvidence),
  } as LoadedCellEvidence
}

const DECIDED_STATUSES = new Set(["supported", "unsupported", "untestable"])

const CAPTURE_URL = /^\/api\/v3\/captures\/[0-9a-f]{64}\.png$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const CLIPBOARD_NONCE = /^terminfo-osc52-[0-9a-f-]{36}$/
const UNTESTABLE_CAUSE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function validCaptureImage(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    typeof value.url === "string" &&
    CAPTURE_URL.test(value.url) &&
    typeof value.sha256 === "string" &&
    SHA256_HEX.test(value.sha256) &&
    value.url === `/api/v3/captures/${value.sha256}.png` &&
    typeof value.width === "number" &&
    Number.isInteger(value.width) &&
    value.width > 0 &&
    typeof value.height === "number" &&
    Number.isInteger(value.height) &&
    value.height > 0
  )
}

function validCaptures(value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  const hasObserved = value.observed !== undefined
  const hasText = value.textCells !== undefined
  if (!hasObserved && !hasText) return false
  if (hasObserved && !validCaptureImage(value.observed)) return false
  if (
    hasText &&
    (typeof value.textCells !== "string" || value.textCells.length === 0 || value.textCells.length > 4000)
  ) {
    return false
  }
  if (value.full !== undefined && !validCaptureImage(value.full)) return false
  if (value.expected !== undefined && !validCaptureImage(value.expected)) return false
  if (value.regionText !== undefined && typeof value.regionText !== "string") return false
  return true
}

/** A decided current cell carries one or two evidence sentences; an undecided one carries none. */
function evidenceFits(status: string, evidence: unknown): boolean {
  if (!DECIDED_STATUSES.has(status)) return evidence === undefined
  return (
    Array.isArray(evidence) &&
    evidence.length >= 1 &&
    evidence.length <= 2 &&
    evidence.every((sentence) => typeof sentence === "string" && sentence.length > 0)
  )
}

/**
 * Validate a parsed per-run trace document (`version: 1`) and extract the trace cell for
 * `expectation.featureId` (#30565, @cto ruling 2239262c condition 2).
 */
export function readCellTrace(parsed: unknown, expectation: CellTraceExpectation): LoadedCellTrace {
  if (expectation.expectedSha256 !== undefined || expectation.actualSha256 !== undefined) {
    if (
      typeof expectation.expectedSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(expectation.expectedSha256) ||
      expectation.actualSha256 !== expectation.expectedSha256
    ) {
      throw new Error("trace failed its receipt")
    }
  }
  const current = expectation.schemaVersion === 3 || expectation.schemaVersion === 4
  const featureResults = isRecord(parsed) ? (current ? parsed.featureResults : parsed.cells) : undefined
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    parsed.runId !== expectation.runId ||
    parsed.runSha256 !== expectation.runSha256 ||
    typeof parsed.measuredAt !== "string" ||
    (parsed.sourceRevision !== null && typeof parsed.sourceRevision !== "string") ||
    !isRecord(parsed.identity) ||
    typeof parsed.identity.recorded !== "string" ||
    !isRecord(featureResults)
  ) {
    throw new Error("Trace document identity or structure does not match this result")
  }
  const currentRuleCheck = readIdentityRuleCheck(parsed.identity.currentRuleCheck)
  if (currentRuleCheck === null) throw new Error("Trace document identity or structure does not match this result")
  const cellEntry = featureResults[expectation.featureId]
  if (cellEntry === undefined) {
    throw new Error(`Trace document for run ${expectation.runId} holds no result for ${expectation.featureId}`)
  }
  if (
    !isRecord(cellEntry) ||
    !Array.isArray(cellEntry.assertions) ||
    !validCaptures(cellEntry.captures) ||
    (cellEntry.logLine !== undefined &&
      (typeof cellEntry.logLine !== "string" || cellEntry.logLine.length === 0 || cellEntry.logLine.length > 240)) ||
    (cellEntry.clipboardRead !== undefined &&
      (typeof cellEntry.clipboardRead !== "string" || !CLIPBOARD_NONCE.test(cellEntry.clipboardRead))) ||
    (cellEntry.untestableCause !== undefined &&
      (typeof cellEntry.untestableCause !== "string" || !UNTESTABLE_CAUSE_SLUG.test(cellEntry.untestableCause))) ||
    (expectation.schemaVersion === 3 || expectation.schemaVersion === 4
      ? typeof cellEntry.status !== "string" || !evidenceFits(cellEntry.status, cellEntry.evidence)
      : typeof cellEntry.outcome !== "string" ||
        (cellEntry.assertionType !== undefined && typeof cellEntry.assertionType !== "string"))
  ) {
    throw new Error("Trace document identity or structure does not match this result")
  }
  return {
    version: 1,
    schemaVersion: expectation.schemaVersion,
    runId: parsed.runId,
    runSha256: parsed.runSha256,
    measuredAt: parsed.measuredAt,
    sourceRevision: parsed.sourceRevision,
    identity: {
      recorded: parsed.identity.recorded,
      ...(currentRuleCheck && { currentRuleCheck }),
    },
    featureId: expectation.featureId,
    cell: cellEntry as unknown as TraceCellRecord,
  }
}

/**
 * Format the TESTED and EXPECTED popover panes from a validated cell trace and catalog metadata (#30565). The
 * TESTED pane shows the bytes the probe wrote and asked, then the evidence sentences the trace carries; every
 * word of those sentences comes from evidence-messages.ts at trace build (#37341).
 */
export function describeTracePanes(trace: LoadedCellTrace, options: TracePaneOptions = {}): TracePaneCopy {
  const { cell } = trace
  const measuredDate = trace.measuredAt.slice(0, 10)
  const shortRunId = trace.runId.slice(0, 8)
  const runPrefix = trace.schemaVersion === 3 || trace.schemaVersion === 4 ? "Current run" : "Historical run"
  const sourceLine = [
    `${runPrefix} ${shortRunId}`,
    measuredDate,
    ...(cell.assertionType ? [cell.assertionType] : []),
  ].join(" · ")
  const identityLine = formatTraceIdentity(trace.identity)

  const items: TracePaneItem[] = []
  // A headless library has a parser state; a live terminal's buffer_state read is not one (#37341).
  const isHeadless = options.subjectKind === "lib" || cell.parserState !== undefined
  const writes =
    cell.writes && cell.writes.length > 0
      ? cell.writes
      : (cell.events ?? []).flatMap((e) => (e.kind === "write" && typeof e.sequence === "string" ? [e.sequence] : []))
  const queries: TraceQuery[] =
    cell.queries && cell.queries.length > 0
      ? cell.queries
      : (cell.events ?? []).flatMap((e) =>
          e.kind === "query" && typeof e.sequence === "string" ? [{ sequence: e.sequence }] : [],
        )
  if (writes.length > 0) items.push({ label: "Sent", code: writes.map(formatControlBytes).join("  ") })
  const asked = queries.filter((query) => query.sequence !== "")
  if (asked.length > 0) {
    items.push({ label: "Query", code: asked.map((q) => formatControlBytes(q.sequence)).join("  ") })
  }
  // A current decided cell always carries its sentences (readCellTrace checks it); a historical trace has none,
  // and shows only what it stored: the bytes and a headless parser state.
  const evidence = cell.evidence
  const state =
    isHeadless && cell.parserState !== undefined && typeof cell.parserState !== "string"
      ? formatParserState(cell.parserState)
      : undefined
  if (evidence !== undefined || state !== undefined) {
    items.push({ label: "Observed", ...(evidence && { text: evidence.join(" ") }), ...(state && { pre: state }) })
  }

  const testedLines = [
    ...items.flatMap((item) => [item.label, item.code, item.text, item.pre].filter((v): v is string => Boolean(v))),
    sourceLine,
    ...(identityLine ? [identityLine] : []),
  ]

  const sequence = options.sequence ? formatControlBytes(options.sequence) : undefined
  const assertionExpected = cell.assertions.map((a) => a.expected.trim()).filter(Boolean)
  const guidance = options.probeGuidance
    ? formatControlBytes(options.probeGuidance.replace(/<\/?code>/g, "").trim())
    : undefined
  const firstExpected = assertionExpected[0]
  const behavior =
    firstExpected !== undefined
      ? formatControlBytes(firstExpected)
      : guidance || "No expected behavior recorded in catalog."
  const referenceStatus = options.hasReferenceImage ? "Reference image recorded" : "No reference image recorded"
  const expectedLines = [...(sequence ? ["Sequence", sequence] : []), "Behavior", behavior, referenceStatus]

  return {
    tested: {
      items,
      sourceLine,
      ...(identityLine && { identityLine }),
      text: testedLines.join("\n"),
    },
    expected: {
      ...(sequence && { sequence }),
      behavior,
      referenceStatus,
      text: expectedLines.join("\n"),
    },
  }
}
