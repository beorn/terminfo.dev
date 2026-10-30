import type {
  ProbeResult,
  ProbeStatus,
  Observation,
  ObservationReason,
  ProbeAssertion,
} from "../../packages/probe-defs/src/types.ts"
import type { IdentityAdmission } from "../../packages/admin/run-admission.ts"
import type { CellEvidence, HistoricalCellEvidence } from "./public-results.ts"

export type LoadedCellEvidence =
  | (CellEvidence & { version: 4; runId: string; runSha256: string })
  | (HistoricalCellEvidence & { version: 2; runId: string; runSha256: string })

export interface CellEvidenceExpectation {
  schemaVersion: number
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

export interface TraceCellRecord {
  outcome?: Observation["outcome"]
  status?: ProbeStatus
  assertionType?: Observation["assertionType"] | ProbeResult["assertionType"]
  reason?: ObservationReason
  replyWithheld?: true
  writes?: string[]
  queries?: TraceQuery[]
  events?: TraceEvent[]
  parserState?: unknown
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
    admission?: IdentityAdmission
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
    reasonLine?: string
    items: TracePaneItem[]
    sourceLine: string
    identityLine: string
    notKeptLine: string
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

export const REASON_EXPLANATIONS: Record<ObservationReason, string> = {
  "no-response": "No terminal reply was recorded for this query.",
  timeout: "The probe did not finish before its time limit.",
  permission: "Required permission was not available for this probe.",
  "policy-refused": "The configured policy declined to run or allow this probe.",
  "collector-error": "The collector failed to complete this probe.",
  "invalid-reply": "The recorded reply did not match this probe’s expected format.",
  "insufficient-evidence": "The recorded observation does not establish support; more evidence is needed.",
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
      const parts = ["ESC", "[", head, inter, final].filter(Boolean)
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

function formatTraceIdentity(identity: LoadedCellTrace["identity"]): string {
  const recorded = `Identity ${identity.recorded} in run file`
  const admission = identity.admission
  if (!admission) return `${recorded}; not admitted.`
  const details: string[] = []
  if (admission.da1) details.push(`DA1 ${formatControlBytes(admission.da1)}`)
  if (admission.xtversion) details.push(`XTVERSION ${formatControlBytes(admission.xtversion)}`)
  if (admission.receipt?.cfBundleShortVersionString) {
    details.push(`bundle ${admission.receipt.cfBundleShortVersionString}`)
  }
  if (admission.executable) {
    details.push(`executable ${admission.executable.version}`)
  }
  return `${recorded}; admitted by ${admission.rule} rule${details.length > 0 ? ` (${details.join(", ")})` : ""}.`
}

/**
 * Validate a parsed per-run evidence document (`version: 2` for historical runs, `version: 4` for
 * schema-3 or schema-4 runs) and extract the cell record for `expectation.featureId`.
 */
export function readCellEvidence(parsed: unknown, expectation: CellEvidenceExpectation): LoadedCellEvidence {
  const expectedDocumentVersion = expectation.schemaVersion === 3 || expectation.schemaVersion === 4 ? 4 : 2
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
  const payload = isRecord(cellEntry)
    ? expectation.schemaVersion === 3 || expectation.schemaVersion === 4
      ? cellEntry.result
      : cellEntry.observation
    : undefined
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
    ...(cellEntry as unknown as CellEvidence | HistoricalCellEvidence),
  } as LoadedCellEvidence
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
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    parsed.runId !== expectation.runId ||
    parsed.runSha256 !== expectation.runSha256 ||
    typeof parsed.measuredAt !== "string" ||
    (parsed.sourceRevision !== null && typeof parsed.sourceRevision !== "string") ||
    !isRecord(parsed.identity) ||
    typeof parsed.identity.recorded !== "string" ||
    !isRecord(parsed.cells)
  ) {
    throw new Error("Trace document identity or structure does not match this result")
  }
  const cellEntry = parsed.cells[expectation.featureId]
  if (cellEntry === undefined) {
    throw new Error("no trace stored for this cell")
  }
  if (
    !isRecord(cellEntry) ||
    !Array.isArray(cellEntry.assertions) ||
    (expectation.schemaVersion === 3 || expectation.schemaVersion === 4
      ? typeof cellEntry.status !== "string"
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
      ...(isRecord(parsed.identity.admission) && {
        admission: parsed.identity.admission as unknown as IdentityAdmission,
      }),
    },
    featureId: expectation.featureId,
    cell: cellEntry as unknown as TraceCellRecord,
  }
}

/**
 * Format the TESTED and EXPECTED popover panes from a validated cell trace and catalog metadata (#30565).
 */
export function describeTracePanes(trace: LoadedCellTrace, options: TracePaneOptions = {}): TracePaneCopy {
  const { cell } = trace
  const measuredDate = trace.measuredAt.slice(0, 10)
  const shortRunId = trace.runId.slice(0, 8)
  const runPrefix = trace.schemaVersion === 3 || trace.schemaVersion === 4 ? "Current run" : "Historical run"
  const evidenceMethod = cell.assertionType ?? "no typed observation retained"
  const sourceLine = `${runPrefix} ${shortRunId} · ${measuredDate} · ${evidenceMethod} · presentation not reviewed`
  const identityLine = formatTraceIdentity(trace.identity)
  const reasonLine = cell.reason ? `${cell.reason}: ${REASON_EXPLANATIONS[cell.reason] ?? cell.reason}` : undefined

  const items: TracePaneItem[] = []
  let notKeptLine: string

  const isHeadless =
    options.subjectKind === "lib" || cell.assertionType === "buffer_state" || cell.parserState !== undefined
  const writes =
    cell.writes && cell.writes.length > 0
      ? cell.writes
      : (cell.events ?? []).flatMap((e) => (e.kind === "write" && typeof e.sequence === "string" ? [e.sequence] : []))
  const queries: TraceQuery[] =
    cell.queries && cell.queries.length > 0
      ? cell.queries
      : (cell.events ?? []).flatMap((e) =>
          e.kind === "query" && typeof e.sequence === "string"
            ? [
                {
                  sequence: e.sequence,
                  ...(e.reason && { reason: e.reason }),
                  ...(e.match !== undefined && { match: e.match }),
                },
              ]
            : [],
        )

  if (isHeadless) {
    const rev = trace.sourceRevision ? trace.sourceRevision.slice(0, 8) : "not recorded"
    items.push({
      label: "Sent",
      text: `Input bytes were not stored by this run (source revision ${rev}).`,
    })
    const observedState =
      cell.parserState !== undefined
        ? formatParserState(cell.parserState)
        : cell.assertions
            .map((a) => a.observed)
            .filter((v): v is string => v !== undefined && v !== "")
            .map(formatControlBytes)
            .join("\n") || "Nothing"
    items.push({
      label: "Observed · parser state",
      pre: observedState,
    })
    notKeptLine = "Not kept: screenshot (headless parser has none), input bytes"
  } else if (writes.length > 0 || queries.length > 0) {
    if (writes.length > 0) {
      items.push({
        label: "Sent",
        code: writes.map(formatControlBytes).join("  "),
      })
    }
    if (queries.length > 0) {
      const reasons = [...new Set(queries.map((q) => q.reason).filter(Boolean))].join(", ")
      items.push({
        label: `Query${reasons ? ` · ${reasons}` : ""}`,
        code: queries.map((q) => formatControlBytes(q.sequence)).join("  "),
      })
    }
    const primaryMatches = queries
      .map((q) => (q.match?.[0] !== undefined ? formatControlBytes(q.match[0]) : undefined))
      .filter((v): v is string => v !== undefined)
    const observedValues = cell.assertions
      .map((a) => a.observed)
      .filter((v): v is string => v !== undefined && v !== "")
      .map(formatControlBytes)

    if (cell.replyWithheld) {
      items.push({
        label: "Observed",
        text: "Observed bytes not reviewed for publication.",
      })
    } else if (primaryMatches.length > 0) {
      items.push({
        label: "Observed",
        code: primaryMatches.join("  "),
        ...(observedValues.length > 0 && { text: `Observed: ${observedValues.join(", ")}` }),
      })
    } else if (observedValues.length > 0) {
      items.push({
        label: "Observed",
        code: observedValues.join("\n"),
      })
    } else {
      const reasons = [...new Set(queries.map((q) => q.reason).filter(Boolean))].join(", ")
      items.push({
        label: "Observed",
        text: queries.length > 0 ? `No matching reply (${reasons || "none"}).` : "No reply recorded.",
      })
    }
    notKeptLine = "Not kept: screenshot, raw read window (including sentinel reply), reviewed evidence file"
  } else if (cell.replyWithheld) {
    items.push({
      label: "Sent",
      text: "Input bytes were not stored by this run.",
    })
    items.push({
      label: "Observed",
      text: "Observed bytes not reviewed for publication.",
    })
    notKeptLine = "Not kept: screenshot, raw read window, reviewed evidence file"
  } else {
    const nothingSent = cell.reason === "policy-refused" || cell.reason === "permission"
    items.push({
      label: "Sent",
      text: nothingSent ? "Nothing" : "Input bytes were not stored by this run.",
    })
    items.push({
      label: "Observed",
      text: "Nothing",
    })
    notKeptLine = "Not kept: collector note, screenshot, reviewed evidence file"
  }

  const testedLines = [
    ...(reasonLine ? [reasonLine] : []),
    ...items.flatMap((item) => [item.label, item.code, item.pre, item.text].filter((v): v is string => Boolean(v))),
    sourceLine,
    identityLine,
    notKeptLine,
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
      ...(reasonLine && { reasonLine }),
      items,
      sourceLine,
      identityLine,
      notKeptLine,
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
