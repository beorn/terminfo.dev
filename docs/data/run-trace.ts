/**
 * Stored-run traces (#30565). For each run a reader can open a result from, one lazy document holds the
 * stored record of every cell as a public card may show it. @cto's rulings 3f4b1d98 and 2239262c (one document
 * per displayed run) set what it publishes without review, and 0e2bbcf6 sets what a card may show; docs/api.md
 * "Evidence and publication" states the same contract for API readers.
 *
 * Published: each cell's outcome or status, assertion type and reason code; the bytes the probe wrote; each
 * query's sequence and reason; the headless parser state; each assertion's kind and expected text; a query's
 * `match` only when it fits a reply shape its feature declares (evidence-messages.ts `REPLY_SHAPES`), a live
 * assertion's `observed` only where `OBSERVED_SHAPES` declares one; and `evidence`, the one or two sentences
 * evidence-messages.ts words from the stored record (#37341).
 * Never published here: notes, assertion actions, ungraded diagnostics, screenshots and frames, and every read
 * window (a key named `raw` or `rawBase64`, or ending in `Raw`, at any depth). A cell carries no path, so no
 * path reaches a trace.
 */
import { createHash } from "node:crypto"
import type { ProbeResult, ProbeAssertion } from "../../packages/probe-defs/src/types.ts"
import {
  evidenceFacts,
  evidenceSentences,
  OBSERVED_SHAPES,
  REPLY_SHAPES,
  replyPublishable,
  type StoredEvidence,
  type StoredQuery,
} from "./evidence-messages.ts"
import type { CurrentSelectedVersion, SelectedVersion } from "./selected-results.ts"
import { isPublishedStatus } from "./app-cells.ts"

/** A read window: terminal reply bytes, never published. */
const READ_WINDOW = /(?:^raw|Raw)(?:Base64)?$/
/** A reason code; free-text reasons remain private. */
const REASON_CODE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

interface TraceQuery {
  sequence: string
  reason?: string
  /** The parsed reply, or null when nothing matched (a sentinel or a timeout). */
  match?: string[] | null
}

interface TraceEvent {
  kind: string
  sequence?: string
  reason?: string
  match?: string[] | null
}

interface TraceAssertion {
  kind: ProbeAssertion["kind"]
  expected: string
  observed?: string
}

interface TraceRecord {
  reason?: string
  /** One or two plain sentences on what the test observed, worded at build time (evidence-messages.ts). */
  evidence?: string[]
  writes?: string[]
  queries?: TraceQuery[]
  events?: TraceEvent[]
  /** A headless engine's state as the run stored it, read windows removed. */
  parserState?: unknown
  assertions: TraceAssertion[]
}

interface CurrentTraceCell extends TraceRecord {
  status: ProbeResult["status"]
  assertionType?: ProbeResult["assertionType"]
}

export interface TraceDocument<Cell> {
  source?: CurrentSelectedVersion["source"]
  version: 1
  runId: string
  runSha256: string
  measuredAt: string
  sourceRevision: string | null
  /** The identity the run recorded for itself, and this build's identity-rule check of a stored run (#34617). */
  identity: { recorded: string; currentRuleCheck?: TraceIdentityRuleCheck }
  featureResults: Record<string, Cell>
}

/**
 * At trace build, the run's retained identity evidence matched this build's identity rule (#34617, @cto
 * 34617-current-rule-contract-go-1347). Present only on a stored run whose check matched; absent is no claim.
 * It claims neither historical admission nor origin control.
 */
export interface TraceIdentityRuleCheck {
  checkedAt: "build"
  rule: string
  /** 12-hex fingerprint of the identity rule's source closure (corpus-placement identityRuleRevision). */
  ruleRevision: string
  da1?: string
  xtversion?: string
  receipt?: { cfBundleShortVersionString: string }
  executable?: { version: string; sha256: string }
}
export type CurrentTraceDocument = TraceDocument<CurrentTraceCell>

function withoutReadWindows(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutReadWindows)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !READ_WINDOW.test(key))
      .map(([key, child]) => [key, withoutReadWindows(child)]),
  )
}

/**
 * A stored reply is JSON or plain text, and plain text is a reply in its own right. Text that starts like
 * JSON must parse: published raw, it would carry its read windows (2026-10-21: all 141,699 such stored
 * replies and observed values parse).
 */
function storedJson(text: string, where: string): { value: unknown } | undefined {
  if (!/^\s*[[{]/.test(text)) return undefined
  try {
    return { value: JSON.parse(text) }
  } catch (error) {
    throw new Error(`${where}: stored text starts like JSON but does not parse: ${(error as Error).message}`)
  }
}

/** Stored text without read windows: a JSON object or array is written again without them. */
function publishedText(text: string, where: string): string {
  const stored = storedJson(text, where)
  return stored ? JSON.stringify(withoutReadWindows(stored.value)) : text
}

function strings(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${where}: expected a list of strings`)
  }
  return value as string[]
}

function optionalString(value: unknown, where: string): string | undefined {
  if (value !== undefined && typeof value !== "string") throw new Error(`${where}: expected a string`)
  return value
}

/** A live probe's stored exchange, read in full for the evidence template; publication is decided per value. */
interface StoredExchange {
  writes?: string[]
  queries?: StoredQuery[]
  events?: Array<TraceEvent & Pick<StoredQuery, "timeoutMs" | "sentinel">>
  /** The exchange's other stored keys (captures, clipboard, title reads), read windows removed. */
  extra: Record<string, unknown>
}

const EXCHANGE_KEYS = new Set(["writes", "queries", "events"])

/** A live probe's stored exchange: the bytes it wrote and each query it made, in order. */
function exchange(value: unknown, where: string): StoredExchange | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const stored = value as Record<string, unknown>
  if (stored.writes === undefined && stored.queries === undefined && stored.events === undefined) return undefined
  const match = (raw: unknown, at: string): { match?: string[] | null } =>
    raw === undefined ? {} : { match: raw === null ? null : strings(raw, at) }
  const item = (raw: unknown, at: string): Record<string, unknown> => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${at}: expected an object`)
    return raw as Record<string, unknown>
  }
  const list = (raw: unknown, at: string): unknown[] => {
    if (!Array.isArray(raw)) throw new Error(`${at}: expected a list`)
    return raw
  }
  const timing = (query: Record<string, unknown>): Pick<StoredQuery, "timeoutMs" | "sentinel"> => ({
    ...(typeof query.timeoutMs === "number" && { timeoutMs: query.timeoutMs }),
    ...(query.sentinel !== undefined &&
      query.sentinel !== null &&
      typeof query.sentinel === "object" && {
        sentinel: { graceMs: (query.sentinel as { graceMs?: number }).graceMs },
      }),
  })
  const writes = stored.writes === undefined ? undefined : strings(stored.writes, `${where}.writes`)
  const queries =
    stored.queries === undefined
      ? undefined
      : list(stored.queries, `${where}.queries`).map((raw, index): StoredQuery => {
          const at = `${where}.queries[${index}]`
          const query = item(raw, at)
          const sequence = optionalString(query.sequence, `${at}.sequence`)
          if (sequence === undefined) throw new Error(`${at}: query has no sequence`)
          const reason = optionalString(query.reason, `${at}.reason`)
          return {
            sequence,
            ...(reason !== undefined && { reason }),
            ...match(query.match, `${at}.match`),
            ...timing(query),
          }
        })
  const events =
    stored.events === undefined
      ? undefined
      : list(stored.events, `${where}.events`).map((raw, index) => {
          const at = `${where}.events[${index}]`
          const event = item(raw, at)
          const kind = optionalString(event.kind, `${at}.kind`)
          if (kind === undefined) throw new Error(`${at}: event has no kind`)
          const sequence = optionalString(event.sequence, `${at}.sequence`)
          const reason = optionalString(event.reason, `${at}.reason`)
          return {
            kind,
            ...(sequence !== undefined && { sequence }),
            ...(reason !== undefined && { reason }),
            ...match(event.match, `${at}.match`),
            ...timing(event),
          }
        })
  const extra = Object.fromEntries(
    Object.entries(stored)
      .filter(([key]) => !EXCHANGE_KEYS.has(key) && !READ_WINDOW.test(key))
      .map(([key, child]) => {
        const text = typeof child === "string" ? storedJson(child, `${where}.${key}`) : undefined
        return [key, withoutReadWindows(text ? text.value : child)]
      }),
  )
  return { ...(writes && { writes }), ...(queries && { queries }), ...(events && { events }), extra }
}

/**
 * The published form of a stored exchange: sequences and reasons, and a reply only when it fits its feature's
 * declared shape. Keep `events` alone only when it equals `writes` plus `queries` in order (2026-10-21 census:
 * 55,983 of 55,983 exchanges with `events`); otherwise keep all three.
 */
function publishedExchange(
  stored: StoredExchange,
  publishable: (reply: string) => boolean,
): Pick<TraceRecord, "writes" | "queries" | "events"> {
  const shown = (match: string[] | null | undefined): { match?: string[] | null } =>
    match === undefined ? {} : match === null || match[0] === undefined || publishable(match[0]) ? { match } : {}
  const writes = stored.writes
  const queries = stored.queries?.map(({ sequence, reason, match }): TraceQuery => ({
    sequence,
    ...(reason !== undefined && { reason }),
    ...shown(match),
  }))
  const events = stored.events?.map(({ kind, sequence, reason, match }): TraceEvent => ({
    kind,
    ...(sequence !== undefined && { sequence }),
    ...(reason !== undefined && { reason }),
    ...shown(match),
  }))
  const eventsEqualWritesAndQueries =
    events !== undefined &&
    events.every((event) => event.kind === "write" || event.kind === "query") &&
    JSON.stringify(events.filter((event) => event.kind === "write")) ===
      JSON.stringify((writes ?? []).map((sequence) => ({ kind: "write", sequence }))) &&
    JSON.stringify(events.filter((event) => event.kind === "query")) ===
      JSON.stringify((queries ?? []).map((query) => ({ kind: "query", ...query })))
  if (eventsEqualWritesAndQueries) return { events }
  return { ...(writes && { writes }), ...(queries && { queries }), ...(events && { events }) }
}

const DECIDED = new Set<ProbeResult["status"]>(["supported", "unsupported", "untestable"])

/** The stored JSON under one raw-reply key, or undefined when the run kept none or kept plain text. */
function storedRecord(raw: Readonly<Record<string, string>>, key: string, where: string): unknown {
  const text = raw[key]
  return text === undefined ? undefined : storedJson(text, `${where}.${key}`)?.value
}

function traceRecord(
  version: Pick<CurrentSelectedVersion, "runId" | "subject">,
  result: ProbeResult,
  raw: ReturnType<CurrentSelectedVersion["readRaw"]>,
  rawReply: string | undefined,
  where: string,
): TraceRecord {
  const { featureId } = result
  const headless = version.subject.kind === "lib"
  const assertions = raw.assertions.filter((assertion) => assertion.featureId === featureId)
  let parserState: unknown
  let stored: StoredExchange | undefined
  if (rawReply !== undefined && rawReply !== "") {
    const json = storedJson(rawReply, `${where}.rawReply`)
    if (headless) parserState = json ? withoutReadWindows(json.value) : rawReply
    else stored = json && exchange(json.value, where)
  }
  // A probe that keeps the read itself as its reply (DA1, DA2, XTVERSION) stores its exchange beside it.
  if (!headless && stored === undefined) {
    const traced = storedRecord(raw.rawReplies, `${featureId}.trace`, where)
    if (traced !== undefined) stored = exchange(traced, `${where}.trace`)
  }
  const reasonCode = result.reason !== undefined && REASON_CODE.test(result.reason) ? result.reason : undefined
  const evidence: StoredEvidence = {
    runId: version.runId,
    featureId,
    subjectKind: version.subject.kind,
    os: version.subject.os,
    status: result.status,
    ...(result.assertionType && { assertionType: result.assertionType }),
    ...(reasonCode !== undefined && { reasonCode }),
    frameKinds: (result.frames ?? []).flatMap((frame) => (frame.kind ? [frame.kind] : [])),
    writes:
      stored?.writes ?? stored?.events?.flatMap((e) => (e.kind === "write" && e.sequence ? [e.sequence] : [])) ?? [],
    queries:
      stored?.queries ??
      stored?.events?.flatMap((e) =>
        e.kind === "query" && e.sequence !== undefined ? [{ ...e, sequence: e.sequence }] : [],
      ) ??
      [],
    exchangeExtra: stored?.extra ?? {},
    callback: headless ? undefined : storedRecord(raw.rawReplies, `${featureId}.callbackResponse`, where),
    ...(parserState !== undefined && { parserState }),
    assertions: assertions.map(({ kind, expected, observed }) => ({ kind, expected, observed })),
  }
  const sentences = DECIDED.has(result.status) ? evidenceSentences(featureId, evidenceFacts(evidence)) : undefined
  const observedShape = OBSERVED_SHAPES[featureId]
  const traced = assertions.map((assertion, index): TraceAssertion => {
    const published = headless || (observedShape !== undefined && observedShape(assertion.observed))
    return {
      kind: assertion.kind,
      expected: assertion.expected,
      ...(published && { observed: publishedText(assertion.observed, `${where}.assertions[${index}].observed`) }),
    }
  })
  return {
    ...(reasonCode !== undefined && { reason: reasonCode }),
    ...(sentences && { evidence: sentences }),
    // A decided cell's reply must have a declared shape (the build fails otherwise); an undecided cell never
    // reaches a public card, so a reply with no declared shape is simply not published.
    ...(stored &&
      publishedExchange(
        stored,
        (reply) =>
          (sentences !== undefined || REPLY_SHAPES[featureId] !== undefined) && replyPublishable(evidence, reply),
      )),
    ...(parserState !== undefined && { parserState }),
    assertions: traced,
  }
}

type TraceVersion = Pick<SelectedVersion, "runId" | "sha256" | "measuredAt" | "identity"> & {
  sourceRevision: string | null
  schemaVersion?: 1 | 2 | 3 | 4
  source?: CurrentSelectedVersion["source"]
  identityRuleCheck?: TraceIdentityRuleCheck
}

function traceDocument<Cell>(
  apiVersion: 2 | 3,
  version: TraceVersion,
  featureResults: Record<string, Cell>,
  /** How many results the run stored: a run with none has no trace; one whose results are all undecided has an empty one. */
  storedResults: number,
): { url: string; sha256: string; bytes: string; document: TraceDocument<Cell> } | undefined {
  if (storedResults === 0) return undefined
  if (version.identity === undefined) throw new Error(`run ${version.runId}: no recorded identity for its trace`)
  const document: TraceDocument<Cell> = {
    ...(version.schemaVersion === 4 && version.source && { source: { ...version.source } }),
    version: 1,
    runId: version.runId,
    runSha256: version.sha256,
    measuredAt: version.measuredAt,
    sourceRevision: version.sourceRevision,
    identity: {
      recorded: version.identity,
      ...(apiVersion === 3 && version.identityRuleCheck && { currentRuleCheck: { ...version.identityRuleCheck } }),
    },
    featureResults,
  }
  const bytes = JSON.stringify(document) + "\n"
  return {
    url: `/api/v${apiVersion}/traces/${version.sha256}.json`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes,
    document,
  }
}

/** Freeze the JSON trace tree before its original run shares it with another consumer. */
function freezeTrace(value: unknown): void {
  if (value === null || typeof value !== "object") return
  for (const child of Object.values(value)) freezeTrace(child)
  Object.freeze(value)
}

/**
 * The allowlisted PUBLIC trace of a current run's stored results (#37341 D5, @cto 97ba8eea): the same decision as the
 * public projection (`isPublishedStatus`) leaves every undecided entry out BEFORE the bytes are hashed, so its digest,
 * the public trace digest, covers exactly what is served. A run whose results are all undecided still has its (empty)
 * trace, so every contributing source keeps its receipt. The stored run and its own digest are never touched.
 * Each value is written as its feature's declared shapes allow.
 */
export function currentTrace(version: CurrentSelectedVersion) {
  if (version.traceMemo?.value) return version.traceMemo.value
  const raw = version.readRaw()
  const cells: Record<string, CurrentTraceCell> = {}
  for (const result of version.results) {
    if (!isPublishedStatus(result.status)) continue
    const rawReply = result.rawReplyRef === undefined ? undefined : raw.rawReplies[result.rawReplyRef]
    if (result.rawReplyRef !== undefined && rawReply === undefined) {
      throw new Error(`Run ${version.runId}/${result.featureId}: missing retained raw reply ${result.rawReplyRef}`)
    }
    cells[result.featureId] = {
      status: result.status,
      ...(result.assertionType && { assertionType: result.assertionType }),
      ...traceRecord(version, result, raw, rawReply, `run ${version.runId} feature ${result.featureId}`),
    }
  }
  const trace = traceDocument(3, { ...version, identity: raw.identity }, cells, version.results.length)
  if (trace && version.traceMemo) {
    freezeTrace(trace)
    version.traceMemo.value = trace
  }
  return trace
}
