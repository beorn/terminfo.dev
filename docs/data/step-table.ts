/**
 * The popover's plain result line, step table and byte summaries (#30756).
 *
 * The stored result reason, the sent bytes and the terminal's replies already exist in a run; this module
 * turns them into the three things a reader needs first — what happened, which step disagreed, and the raw
 * evidence underneath. It is display-only: it reads recorded values and never re-grades a cell.
 *
 * Scope: the reverse-wrap probe (`packages/probe-defs/src/cursor.ts` `cursor.reverse-wrap`) is the one cell
 * whose measured steps can be named, because its assertion stores `{ measured: [{ step, report }] }`. Every
 * other cell returns `undefined` here and keeps the existing recorded panes.
 */
import { formatControlBytes } from "./evidence-reader"

export interface StepQuery {
  sequence: string
  match?: string[] | null
}

export interface StepEvent {
  kind: string
  sequence?: string
  match?: string[] | null
}

export interface StepAssertion {
  kind: string
  expected: string
  observed?: string
}

export interface StepSource {
  /** The displayed capability status, e.g. `supported`, `unsupported`, `test-todo`. */
  status: string
  assertions: readonly StepAssertion[]
  queries?: readonly StepQuery[]
  events?: readonly StepEvent[]
  writes?: readonly string[]
  /** The run's measured screen, from its `collector.geometry` receipt. */
  screen?: { rows: number; cols: number }
}

export type StepResult = "pass" | "fail" | "held"

export interface StepRow {
  step: string
  sent?: string
  reply?: string
  expected?: string
  got?: string
  result: StepResult
}

export interface StepTable {
  rows: StepRow[]
  /** The sentence that belongs under the badge: what happened, in the reader's words. */
  summary?: string
}

export interface ByteSummary {
  summary: string
  full: string
}

interface MeasuredStep {
  step: string
  report: { row: number; col: number } | null
}

interface Segment {
  sent: string
  query?: StepQuery
}

/**
 * Reverse-wrap's setup steps are fixed by the probe: home must report 1;1 and the deferred wrap 2;2, or the
 * probe returns inconclusive before it grades anything (`cursor.ts`, the reverse-wrap `ask("home")` /
 * `ask("wrapped")` guards). The graded step expects the last column of row 1, which is the run's measured
 * width — never the words "the last column".
 */
const SETUP_EXPECTATIONS: Record<string, { row: number; col: number }> = {
  home: { row: 1, col: 1 },
  wrapped: { row: 2, col: 2 },
}

const STEP_LABELS: Record<string, string> = { home: "Home", wrapped: "After wrap" }

const REVERSE_WRAP_STEPS = ["home", "wrapped", "reverted"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function readMeasured(observed?: string): MeasuredStep[] | undefined {
  if (!observed || !observed.startsWith("{")) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(observed)
  } catch {
    throw new Error("observed assertion is JSON-shaped but does not parse")
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.measured)) return undefined
  const steps: MeasuredStep[] = []
  for (const item of parsed.measured) {
    if (!isRecord(item) || typeof item.step !== "string") return undefined
    if (item.report === null) {
      steps.push({ step: item.step, report: null })
      continue
    }
    if (!isRecord(item.report)) return undefined
    const { row, col } = item.report
    if (!Number.isSafeInteger(row) || !Number.isSafeInteger(col)) return undefined
    steps.push({ step: item.step, report: { row: row as number, col: col as number } })
  }
  return steps.length > 0 ? steps : undefined
}

/** One segment per query: the bytes written since the previous query, and that query's reply. */
function readSegments(source: StepSource): Segment[] {
  const events = source.events && source.events.length > 0 ? source.events : undefined
  if (events) {
    const segments: Segment[] = []
    let pending: string[] = []
    for (const event of events) {
      if (event.kind === "write" && typeof event.sequence === "string") {
        pending.push(event.sequence)
        continue
      }
      if (event.kind === "query" && typeof event.sequence === "string") {
        segments.push({
          sent: pending.join(""),
          query: { sequence: event.sequence, ...(event.match !== undefined && { match: event.match }) },
        })
        pending = []
      }
    }
    // Bytes written after the last query are teardown (mode reset); they stay in the full sent bytes only.
    return segments
  }
  const queries = source.queries ?? []
  if (queries.length === 0) return []
  const writes = source.writes ?? []
  return queries.map((query, index) => ({ sent: index === 0 ? writes.join("") : "", query }))
}

/** `AAAA…AB` becomes `A ×123 B`; control bytes stay visible. Repeats shorter than four stay verbatim. */
export function compressBytes(input: string): string {
  const collapsed = input.replace(
    /([\x20-\x7e])\1{3,}/g,
    (run: string, char: string, offset: number, whole: string) => {
      const next = whole[offset + run.length]
      const separator = next !== undefined && next > " " && next <= "~" ? " " : ""
      return `${char} ×${run.length}${separator}`
    },
  )
  return formatControlBytes(collapsed)
}

export interface RecordedBytes {
  writes?: string[]
  queries?: StepQuery[]
  events?: StepEvent[]
}

/**
 * Read the bytes a run stored for one cell: its `{ writes, queries, events }` record, or a bare reply string,
 * which carries no step structure. A record that is JSON-shaped but unparseable is a broken receipt, not an
 * empty one, so it raises instead of rendering a cell with no evidence.
 */
export function readRecordedBytes(rawReply: string | undefined): RecordedBytes {
  if (rawReply === undefined || !rawReply.startsWith("{")) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(rawReply)
  } catch {
    throw new Error("recorded evidence is JSON-shaped but does not parse")
  }
  if (!isRecord(parsed)) return {}
  const writes = Array.isArray(parsed.writes)
    ? parsed.writes.filter((write): write is string => typeof write === "string")
    : undefined
  const queries = Array.isArray(parsed.queries)
    ? parsed.queries.flatMap((query): StepQuery[] =>
        isRecord(query) && typeof query.sequence === "string"
          ? [
              {
                sequence: query.sequence,
                ...(Array.isArray(query.match) || query.match === null
                  ? { match: query.match as string[] | null }
                  : {}),
              },
            ]
          : [],
      )
    : undefined
  const events = Array.isArray(parsed.events)
    ? parsed.events.flatMap((event): StepEvent[] =>
        isRecord(event) && typeof event.kind === "string"
          ? [
              {
                kind: event.kind,
                ...(typeof event.sequence === "string" && { sequence: event.sequence }),
                ...((Array.isArray(event.match) || event.match === null) && { match: event.match as string[] | null }),
              },
            ]
          : [],
      )
    : undefined
  return {
    ...(writes && writes.length > 0 && { writes }),
    ...(queries && queries.length > 0 && { queries }),
    ...(events && events.length > 0 && { events }),
  }
}

/** The same bytes in the form a table cell can hold: `ESC[?45h ESC[?7h ESC[H`, never `ESC [ ?45 h`. */
export function compactBytes(input: string): string {
  return compressBytes(input)
    .replace(/ESC \[ /g, "ESC[")
    .replace(
      /ESC\[([0-9;:?<>=!" ]*) ?([@-~])/g,
      (_match, params: string, final: string) => `ESC[${params.trim().replace(/ /g, "")}${final}`,
    )
}

function bytesOf(source: StepSource): string[] {
  const events = source.events ?? []
  const written = events.flatMap((event) =>
    event.kind === "write" && typeof event.sequence === "string" ? [event.sequence] : [],
  )
  return written.length > 0 ? written : [...(source.writes ?? [])]
}

export function describeSentBytes(source: StepSource): ByteSummary | undefined {
  const written = bytesOf(source)
  if (written.length === 0) return undefined
  const full = formatControlBytes(written.join(" "))
  return { summary: compactBytes(written.join("")), full }
}

export function describeReplyBytes(source: StepSource): ByteSummary | undefined {
  const events = source.events ?? []
  const replies = events.flatMap((event) =>
    event.kind === "query" && event.match !== undefined && event.match !== null && typeof event.match[0] === "string"
      ? [event.match[0]]
      : [],
  )
  const fromQueries = (source.queries ?? []).flatMap((query) =>
    typeof query.match?.[0] === "string" ? [query.match[0]] : [],
  )
  const raw = replies.length > 0 ? replies : fromQueries
  if (raw.length === 0) return undefined
  const full = raw.map((reply) => formatControlBytes(reply)).join("  ")
  return { summary: compactBytes(raw.join("")), full }
}

function position(report: { row: number; col: number }): string {
  return `row ${report.row}, col ${report.col}`
}

function backspaceCount(sent: string): number | undefined {
  if (sent.length === 0 || !/^[\x08\x7f]+$/.test(sent)) return undefined
  return sent.length
}

function stepLabel(step: string, sent: string): string {
  const backspaces = step === "reverted" ? backspaceCount(sent) : undefined
  if (backspaces !== undefined) return `After ${backspaces} backspace${backspaces === 1 ? "" : "s"}`
  return STEP_LABELS[step] ?? step.charAt(0).toUpperCase() + step.slice(1)
}

/** The sentence under the badge; it names the graded step and both positions, never the raw reason string. */
function stepSummary(label: string, expected: string, got: { row: number; col: number } | null, pass: boolean) {
  if (got === null) return `${label}, no position was reported; expected ${expected}.`
  if (pass) return `${label}, the cursor returned to ${position(got)}, as expected.`
  return `${label}, the cursor stayed at ${position(got)}; expected ${expected}.`
}

export function describeStepTable(source: StepSource): StepTable | undefined {
  const measured = readMeasured(source.assertions[0]?.observed)
  if (!measured) return undefined
  if (measured.map((entry) => entry.step).join(",") !== REVERSE_WRAP_STEPS.join(",")) return undefined
  const cols = source.screen?.cols
  if (!Number.isSafeInteger(cols) || (cols as number) < 2) return undefined
  const width = cols as number
  const segments = readSegments(source)
  const rows = measured.map((entry, index): StepRow => {
    const segment = segments[index]
    const graded = index === measured.length - 1
    const expected = graded ? { row: 1, col: width } : SETUP_EXPECTATIONS[entry.step]
    const expectedText = expected ? position(expected) : undefined
    const matches =
      expected !== undefined &&
      entry.report !== null &&
      entry.report.row === expected.row &&
      entry.report.col === expected.col
    const result: StepResult = graded
      ? matches
        ? "pass"
        : source.status === "supported" || source.status === "unsupported"
          ? "fail"
          : "held"
      : matches
        ? "pass"
        : "fail"
    return {
      step: stepLabel(entry.step, segment?.sent ?? ""),
      ...(segment?.sent ? { sent: compactBytes(segment.sent) } : {}),
      ...(typeof segment?.query?.match?.[0] === "string" ? { reply: compactBytes(segment.query.match[0]) } : {}),
      ...(expectedText !== undefined && { expected: expectedText }),
      ...(entry.report !== null && { got: position(entry.report) }),
      result,
    }
  })
  const gradedRow = rows[rows.length - 1]!
  const gradedStep = measured[measured.length - 1]!
  const summary =
    gradedRow.expected !== undefined
      ? stepSummary(gradedRow.step, gradedRow.expected, gradedStep.report, gradedRow.result === "pass")
      : undefined
  return { rows, ...(summary && { summary }) }
}
