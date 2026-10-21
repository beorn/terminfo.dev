/**
 * Stored-run traces (#30565). For each run a reader can open a result from, one lazy document holds the
 * stored record of every cell that no presentation review has decided. @cto's rulings 3f4b1d98 and
 * 2239262c (one document per displayed run) set what it publishes without that review; docs/api.md
 * "Evidence and publication" states the same contract for API readers.
 *
 * Published: each cell's outcome or status, evidence method and reason code; the bytes the probe wrote;
 * each query's sequence and reason; the headless parser state; each assertion's kind and expected text;
 * and, for features on REPLY_LIST only, a query's `match` and a live assertion's `observed`.
 * Never published here: notes, assertion actions, ungraded diagnostics, screenshots and frames, and
 * every read window (a key named `raw` or `rawBase64`, or ending in `Raw`, at any depth). A cell carries
 * no path, so no path reaches a trace.
 */
import { createHash } from "node:crypto"
import type { CapabilityResult, Observation, ProbeAssertion } from "../../packages/probe-defs/src/types.ts"
import type { CurrentSelectedVersion, SelectedVersion } from "./selected-results.ts"

/**
 * The 226 features whose stored replies use a closed grammar: digits, separators and fixed tokens, as in
 * DECRQSS, DECRPM, DA and colour reports. Fail closed: the live reply of any other feature is withheld,
 * and its cell says so. Derived from the 2026-10-21 reply-grammar census at terminfo 9b080d6dc9 over
 * every committed run (444 runs, 101,140 cells, 263 features seen: 236 LIST, 9 REVIEW, 18 HOLD), keeping
 * 217 LIST ids plus 9 ids approved in @cto review 758fe191 (`erase.line.all`, `erase.line.left`,
 * `erase.line.right`, `erase.screen.above`, `erase.screen.all`, `erase.screen.below`,
 * `extensions.osc1337-capabilities`, `extensions.osc21-kitty-color`, `extensions.osc702-version`), while
 * excluding titles, icon labels, kitty-graphics error replies, clipboard, paths, unit IDs and free text.
 * A feature joins only with the same census evidence and a review.
 */
const REPLY_LIST: ReadonlySet<string> = new Set([
  // charsets (4)
  "charsets.dec-line-drawing",
  "charsets.dec-special",
  "charsets.g0-g1-switching",
  "charsets.utf8",
  // cursor (22)
  "cursor.ansi-restore",
  "cursor.ansi-save",
  "cursor.cpl",
  "cursor.cud-past-bottom",
  "cursor.cup-boundaries",
  "cursor.cup-scroll-region",
  "cursor.cuu-past-top",
  "cursor.hide",
  "cursor.horizontal-absolute",
  "cursor.hpa",
  "cursor.move.absolute",
  "cursor.move.back",
  "cursor.move.down",
  "cursor.move.forward",
  "cursor.move.home",
  "cursor.move.up",
  "cursor.next-line",
  "cursor.position-report",
  "cursor.reverse-wrap",
  "cursor.save-restore",
  "cursor.shape",
  "cursor.vpa",
  // device (12)
  "device.decrpm",
  "device.decrqss",
  "device.dsr-996-color-scheme",
  "device.primary-da",
  "device.secondary-da",
  "device.status-report",
  "device.xtreportcolors",
  "device.xtwinops-14",
  "device.xtwinops-16",
  "device.xtwinops-18",
  "device.xtwinops-22",
  "device.xtwinops-23",
  // editing (17)
  "editing.deccara",
  "editing.deccra",
  "editing.decdc",
  "editing.decera",
  "editing.decfra",
  "editing.decic",
  "editing.decrara",
  "editing.decrqcra",
  "editing.decsace",
  "editing.decsera",
  "editing.delete-chars",
  "editing.delete-lines",
  "editing.insert-chars",
  "editing.insert-lines",
  "editing.repeat-char",
  "editing.sl",
  "editing.sr",
  // erase (11)
  "erase.character",
  "erase.ed-scroll-region",
  "erase.el-with-attrs",
  "erase.line.all",
  "erase.line.left",
  "erase.line.right",
  "erase.screen.above",
  "erase.screen.all",
  "erase.screen.below",
  "erase.screen.scrollback",
  "erase.selective",
  // extensions (51)
  "extensions.kitty-keyboard",
  "extensions.kitty-keyboard.disambiguate",
  "extensions.kitty-keyboard.report-all-keys",
  "extensions.kitty-keyboard.report-alternate",
  "extensions.kitty-keyboard.report-events",
  "extensions.kitty-keyboard.report-text",
  "extensions.osc-633-vscode",
  "extensions.osc10-fg-color",
  "extensions.osc11-bg-color",
  "extensions.osc117-reset-highlight-bg",
  "extensions.osc119-reset-highlight-fg",
  "extensions.osc12-cursor-color",
  "extensions.osc133-a",
  "extensions.osc133-b",
  "extensions.osc133-c",
  "extensions.osc133-d",
  "extensions.osc133-p",
  "extensions.osc1337-capabilities",
  "extensions.osc1337-cellsize",
  "extensions.osc17-highlight-bg",
  "extensions.osc176-app-id",
  "extensions.osc19-highlight-fg",
  "extensions.osc21-kitty-color",
  "extensions.osc22-pointer",
  "extensions.osc30001-color-stack-push",
  "extensions.osc3008-context",
  "extensions.osc30101-color-stack-pop",
  "extensions.osc4-palette",
  "extensions.osc440-audio",
  "extensions.osc5-special-color",
  "extensions.osc555-flash",
  "extensions.osc633-a",
  "extensions.osc633-b",
  "extensions.osc633-c",
  "extensions.osc633-d",
  "extensions.osc633-e",
  "extensions.osc633-p",
  "extensions.osc66-text-sizing",
  "extensions.osc702-version",
  "extensions.osc720-scroll-up",
  "extensions.osc776-cell-size",
  "extensions.osc777-notify",
  "extensions.osc7770-font-size",
  "extensions.osc7777-font-window-size",
  "extensions.osc8",
  "extensions.osc9-progress",
  "extensions.semantic-prompts",
  "extensions.sixel",
  "extensions.sixel-da1",
  "extensions.sixel-geometry-report",
  "extensions.truecolor",
  // input (11)
  "input.button-event-mouse",
  "input.csi-u",
  "input.kitty-click-events",
  "input.modify-other-keys",
  "input.modify-other-keys-3",
  "input.pixel-mouse",
  "input.urxvt-mouse",
  "input.x10-mouse",
  "input.xtest-click",
  "input.xtest-key",
  "input.xtest-wheel",
  // modes (29)
  "modes.alt-screen.enter",
  "modes.alt-screen.exit",
  "modes.alt-scroll-1007",
  "modes.altscreen-1047",
  "modes.altscreen-1048",
  "modes.altscreen-47",
  "modes.application-cursor",
  "modes.application-keypad",
  "modes.auto-wrap",
  "modes.color-scheme-reporting",
  "modes.deccolm",
  "modes.decsclm",
  "modes.decsscls",
  "modes.focus-tracking",
  "modes.insert-replace",
  "modes.left-right-margin",
  "modes.mouse-all",
  "modes.mouse-sgr",
  "modes.mouse-tracking",
  "modes.origin",
  "modes.reverse-video",
  "modes.synchronized-output",
  "modes.utf8-mouse-1005",
  "modes.xtpopcolors",
  "modes.xtpopsgr",
  "modes.xtpushcolors",
  "modes.xtpushsgr",
  "modes.xtrestore",
  "modes.xtsave",
  // reset (4)
  "reset.decaln",
  "reset.ris",
  "reset.sgr",
  "reset.soft",
  // scrollback (9)
  "scrollback.accumulate",
  "scrollback.alt-screen",
  "scrollback.decstbm",
  "scrollback.decstbm-reset",
  "scrollback.reverse-index",
  "scrollback.scroll-down",
  "scrollback.scroll-up",
  "scrollback.set-region",
  "scrollback.total-lines",
  // sgr (32)
  "sgr.bg.256",
  "sgr.bg.bright",
  "sgr.bg.default",
  "sgr.bg.standard",
  "sgr.bg.truecolor",
  "sgr.blink",
  "sgr.bold",
  "sgr.faint",
  "sgr.fg.256",
  "sgr.fg.bright",
  "sgr.fg.default",
  "sgr.fg.standard",
  "sgr.fg.truecolor",
  "sgr.hidden",
  "sgr.inverse",
  "sgr.italic",
  "sgr.overline",
  "sgr.reset",
  "sgr.selective-reset.bold",
  "sgr.selective-reset.inverse",
  "sgr.selective-reset.italic",
  "sgr.selective-reset.underline",
  "sgr.strikethrough",
  "sgr.underline-color-indexed",
  "sgr.underline-color-reset",
  "sgr.underline-color-rgb",
  "sgr.underline.color",
  "sgr.underline.curly",
  "sgr.underline.dashed",
  "sgr.underline.dotted",
  "sgr.underline.double",
  "sgr.underline.single",
  // text (20)
  "text.backspace",
  "text.basic",
  "text.cbt",
  "text.cht",
  "text.combining",
  "text.cr",
  "text.hts",
  "text.index",
  "text.newline",
  "text.next-line",
  "text.overwrite",
  "text.reverse-index-scroll",
  "text.tab",
  "text.tbc",
  "text.wide.cjk",
  "text.wide.emoji",
  "text.wide.emoji-flags",
  "text.wide.emoji-vs16",
  "text.wide.emoji-zwj",
  "text.wrap",
  // unicode (4)
  "unicode.east-asian-ambiguous",
  "unicode.grapheme-cursor",
  "unicode.tab-stops",
  "unicode.wrap-boundary",
])

/** A read window: bytes a terminal returned, which stay behind presentation review. */
const READ_WINDOW = /(?:^raw|Raw)(?:Base64)?$/
/** A reason code; a free-text reason stays behind presentation review. */
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
  /** The run stored reply content that this trace leaves out; a read window alone does not count. */
  replyWithheld?: true
  writes?: string[]
  queries?: TraceQuery[]
  events?: TraceEvent[]
  /** A headless engine's state as the run stored it, read windows removed. */
  parserState?: unknown
  assertions: TraceAssertion[]
}

interface HistoricalTraceCell extends TraceRecord {
  outcome: Observation["outcome"]
  evidence: Observation["evidence"]
}

interface CurrentTraceCell extends TraceRecord {
  status: CapabilityResult["status"]
  evidence?: CapabilityResult["evidence"]
}

export interface TraceDocument<Cell> {
  version: 1
  runId: string
  runSha256: string
  measuredAt: string
  sourceRevision: string | null
  /** The identity the run recorded for itself, and the admission rule selection applied to it. */
  identity: { recorded: string; admission?: SelectedVersion["identityAdmission"] }
  cells: Record<string, Cell>
}
export type HistoricalTraceDocument = TraceDocument<HistoricalTraceCell>
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

type Exchange = Pick<TraceRecord, "writes" | "queries" | "events"> & { leftOut: boolean }

const EXCHANGE_KEYS = new Set(["writes", "queries", "events"])

/**
 * A live probe's stored exchange: the bytes it wrote and each query it made, in order. Other stored keys
 * (captures, clipboard, grid and the like) and a query's timing stay out; `leftOut` says content did.
 */
function exchange(value: unknown, listed: boolean, where: string): Exchange | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const stored = value as Record<string, unknown>
  if (stored.writes === undefined && stored.queries === undefined && stored.events === undefined) return undefined
  let leftOut = Object.keys(stored).some((key) => !EXCHANGE_KEYS.has(key) && !READ_WINDOW.test(key))
  const match = (raw: unknown, at: string): { match?: string[] | null } => {
    if (raw === undefined) return {}
    const values = raw === null ? null : strings(raw, at)
    if (!listed && values !== null && values.length > 0) leftOut = true
    return listed ? { match: values } : {}
  }
  const item = (raw: unknown, at: string): Record<string, unknown> => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${at}: expected an object`)
    return raw as Record<string, unknown>
  }
  const list = (raw: unknown, at: string): unknown[] => {
    if (!Array.isArray(raw)) throw new Error(`${at}: expected a list`)
    return raw
  }
  const writes = stored.writes === undefined ? undefined : strings(stored.writes, `${where}.writes`)
  const queries =
    stored.queries === undefined
      ? undefined
      : list(stored.queries, `${where}.queries`).map((raw, index): TraceQuery => {
          const at = `${where}.queries[${index}]`
          const query = item(raw, at)
          const sequence = optionalString(query.sequence, `${at}.sequence`)
          if (sequence === undefined) throw new Error(`${at}: query has no sequence`)
          const reason = optionalString(query.reason, `${at}.reason`)
          return { sequence, ...(reason !== undefined && { reason }), ...match(query.match, `${at}.match`) }
        })
  const events =
    stored.events === undefined
      ? undefined
      : list(stored.events, `${where}.events`).map((raw, index): TraceEvent => {
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
          }
        })
  // Keep `events` alone only when it equals `writes` plus `queries` in order (2026-10-21 census: 55,983 of
  // 55,983 exchanges with `events`); otherwise keep all three.
  const eventsEqualWritesAndQueries =
    events !== undefined &&
    events.every((event) => event.kind === "write" || event.kind === "query") &&
    JSON.stringify(events.filter((event) => event.kind === "write")) ===
      JSON.stringify((writes ?? []).map((sequence) => ({ kind: "write", sequence }))) &&
    JSON.stringify(events.filter((event) => event.kind === "query")) ===
      JSON.stringify((queries ?? []).map((query) => ({ kind: "query", ...query })))
  if (eventsEqualWritesAndQueries) return { events, leftOut }
  return {
    ...(writes && { writes }),
    ...(queries && { queries }),
    ...(events && { events }),
    leftOut,
  }
}

function traceRecord(
  featureId: string,
  headless: boolean,
  reason: string | undefined,
  rawReply: string | undefined,
  assertions: readonly ProbeAssertion[],
  where: string,
): TraceRecord {
  const listed = REPLY_LIST.has(featureId)
  const showObserved = headless || listed
  let withheld = false
  let parserState: unknown
  let stored: Exchange | undefined
  if (rawReply !== undefined && rawReply !== "") {
    const json = storedJson(rawReply, `${where}.rawReply`)
    if (headless) parserState = json ? withoutReadWindows(json.value) : rawReply
    else {
      stored = json && exchange(json.value, listed, where)
      // A live reply stored outside an exchange (screen state, a single read) is never published here.
      if (stored ? stored.leftOut : true) withheld = true
    }
  }
  const traced = assertions.map((assertion, index): TraceAssertion => {
    if (!showObserved && assertion.observed !== "") withheld = true
    return {
      kind: assertion.kind,
      expected: assertion.expected,
      ...(showObserved && { observed: publishedText(assertion.observed, `${where}.assertions[${index}].observed`) }),
    }
  })
  return {
    ...(reason !== undefined && REASON_CODE.test(reason) && { reason }),
    ...(withheld && { replyWithheld: true as const }),
    ...(stored?.writes && { writes: stored.writes }),
    ...(stored?.queries && { queries: stored.queries }),
    ...(stored?.events && { events: stored.events }),
    ...(parserState !== undefined && { parserState }),
    assertions: traced,
  }
}

type TraceVersion = Pick<SelectedVersion, "runId" | "sha256" | "measuredAt" | "identity" | "identityAdmission"> & {
  sourceRevision: string | null
}

function traceDocument<Cell>(
  apiVersion: 2 | 3,
  version: TraceVersion,
  cells: Record<string, Cell>,
): { url: string; sha256: string; bytes: string; document: TraceDocument<Cell> } | undefined {
  if (Object.keys(cells).length === 0) return undefined
  if (version.identity === undefined) throw new Error(`run ${version.runId}: no recorded identity for its trace`)
  const document: TraceDocument<Cell> = {
    version: 1,
    runId: version.runId,
    runSha256: version.sha256,
    measuredAt: version.measuredAt,
    sourceRevision: version.sourceRevision,
    identity: {
      recorded: version.identity,
      ...(version.identityAdmission && { admission: version.identityAdmission }),
    },
    cells,
  }
  const bytes = JSON.stringify(document) + "\n"
  return {
    url: `/api/v${apiVersion}/traces/${version.sha256}.json`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes,
    document,
  }
}

/** The trace of a historical run's cells that carry no presentation decision; none when every cell has one. */
export function historicalTrace(version: SelectedVersion) {
  const headless = version.target.kind === "headless"
  const cells: Record<string, HistoricalTraceCell> = {}
  for (const [featureId, cell] of Object.entries(version.cells)) {
    if (cell.presentation) continue
    cells[featureId] = {
      outcome: cell.outcome,
      evidence: cell.evidence,
      ...traceRecord(
        featureId,
        headless,
        cell.reason,
        cell.record.rawReply,
        cell.record.assertions,
        `run ${version.runId} feature ${featureId}`,
      ),
    }
  }
  return traceDocument(2, version, cells)
}

/** The trace of a current run's results that carry no presentation decision; none when every result has one. */
export function currentTrace(version: CurrentSelectedVersion) {
  const headless = version.target.kind === "headless"
  const cells: Record<string, CurrentTraceCell> = {}
  for (const result of version.results) {
    if (version.presentations[result.featureId]) continue
    const rawReply = result.rawReplyRef === undefined ? undefined : version.rawReplies[result.rawReplyRef]
    if (result.rawReplyRef !== undefined && rawReply === undefined) {
      throw new Error(`Run ${version.runId}/${result.featureId}: missing retained raw reply ${result.rawReplyRef}`)
    }
    cells[result.featureId] = {
      status: result.status,
      ...(result.evidence && { evidence: result.evidence }),
      ...traceRecord(
        result.featureId,
        headless,
        result.reason,
        rawReply,
        version.assertions.filter((assertion) => assertion.featureId === result.featureId),
        `run ${version.runId} feature ${result.featureId}`,
      ),
    }
  }
  return traceDocument(3, version, cells)
}
