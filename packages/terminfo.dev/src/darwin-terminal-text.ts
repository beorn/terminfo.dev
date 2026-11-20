/**
 * Cell-content readback for the macOS app arms.
 *
 * Terminal.app and iTerm2 answer no CSI 16 t, and their pixel sizes do not divide into whole cells
 * (860x467 over 120x30; 587x462 over 80x25), so the pixel capture path refuses them by design. This
 * module asks the terminal itself for its text instead: one JXA read of the owned session's
 * contents, through the same `osascript -l JavaScript` path the macOS measurement workflow already
 * uses. It returns TEXT ONLY — never pixels, never attributes — and every result says so by shape:
 * there is no attribute field to misread as one.
 *
 * The session is selected by the owned TTY, never as "the first window": another window's contents
 * would be a confident wrong answer. The walk differs by app because the object models do: Terminal.app
 * puts the TTY on a tab, and iTerm2's windows expose tabs and its tabs expose sessions, so asking an
 * iTerm2 window for sessions directly raises.
 *
 * iTerm2's contents runs from the first scrollback line to the last grid row, so the script keeps
 * the last `rows` rows and returns the count it dropped. Rows are newline-TERMINATED in that string,
 * so the script pops the terminator once and returns the kept rows as an array; nothing downstream
 * pops again, because a second pop eats a real blank last row. Terminal.app reports its screen only
 * and drops nothing; both take the same slice, and the returned count says which happened, so the
 * evidence label can record it.
 *
 * Refusal is a sentinel with a reason, and it is used wherever the snapshot cannot be mapped to
 * cells EXACTLY: a row the terminal wrapped, a character outside printable ASCII and the named
 * single-cell glyphs below — whose cell width the snapshot cannot name, which covers combining
 * marks, wide characters, East Asian ambiguous characters and tabs — a row count that is not the
 * screen's row count, an app grid that disagrees
 * with the measured one, a session that is not the owned one or that changed TTY while it was read,
 * a terminal that is not frontmost, a read that runs past its timeout or is killed, and an
 * Automation (TCC) denial, which is named as a denial whether the app raises it inside the script or
 * osascript reports it on stderr.
 *
 * Padding depends on that allowlist and on nothing else: a printable ASCII code point or one of
 * the named glyphs fills exactly one cell, so a row shorter than `cols` that passed every check is
 * a row whose trailing blanks the terminal trimmed, and padding them back restores its exact
 * characters. Every padded row is named in `paddedRows` so the evidence label can say so.
 *
 * Empty text is a VALUE. A blank row and a blank screen are rows of spaces, never "could not read".
 */
import { spawnSync } from "node:child_process"
import {
  ScrollbackReadingUnavailable,
  type TerminalScrollbackReading,
  type TextSnapshotDiagnostic,
} from "@terminfo/probe-defs"
import { hex, isSingleCellCodePoint } from "./single-cell.ts"
import { splitLogicalLine, splitLogicalRows } from "./logical-rows.ts"
import { ownedHistoryReceipt } from "./owned-history-receipt.ts"

/** The two macOS terminals this arm can read, with the bundle name JXA addresses. */
export const TERMINAL_TEXT_APPS = {
  "terminal-app": { application: "Terminal", label: "Terminal.app" },
  iterm2: { application: "iTerm2", label: "iTerm2" },
} as const

export type TerminalTextApp = keyof typeof TERMINAL_TEXT_APPS

/** Apple events' errAEEventNotPermitted: the Automation (TCC) denial. */
const TCC_ERROR_NUMBER = -1743

/** A text snapshot mapped onto exact cells: one string per row, each exactly `cols` characters. */
export interface TerminalCellGrid {
  readonly cols: number
  readonly rows: number
  readonly text: readonly string[]
  /** 1-based rows whose trailing blanks the terminal trimmed and this read padded back to `cols`.
   * Named, never silent: the evidence label says which rows were padded. */
  readonly paddedRows: readonly number[]
  /** Rows the snapshot carried above the visible screen and the read did not map. Zero for a
   * terminal that reports its screen alone. */
  readonly droppedLines: number
  /** How many returned logical lines had to be split into rows, when the app returned logical
   * lines that wrapped (30729 AC3b). Absent when the rows came back as rows. */
  readonly splitLineCount?: number
}

export type TerminalTextRead =
  | {
      readonly status: "read"
      readonly app: TerminalTextApp | "kitty" | "windows-terminal" | "wezterm"
      readonly cells: TerminalCellGrid
    }
  | {
      readonly status: "refused"
      readonly reason: string
      /** The reply's own account of the rows it returned, when it stated one in the typed shape. */
      readonly diagnostic?: TextSnapshotDiagnostic
      /** How many stated diagnostics this read could not type. Present only when one was dropped. */
      readonly diagnosticDropped?: number
    }

export interface OsascriptReply {
  readonly stdout: string
  readonly stderr: string
  readonly status: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
  /** Set when the child could not be started at all. Named before anything else, so a missing
   * osascript is not reported as a terminal that refused the read. */
  readonly error?: { readonly code: string | undefined; readonly message: string }
}

/**
 * The JXA that reads the owned session. It selects by TTY, never "the first window": another
 * window's contents would be a confident wrong answer. It returns the kept rows as an array (so the
 * terminator is popped once, here), the app's own grid so the caller can refuse a snapshot that is
 * not the measured screen, and the count of scrollback rows it left behind.
 */
export function terminalTextScript(
  app: TerminalTextApp,
  tty: string,
  cols: number,
  rows: number,
  /** Terminal.app only: also read the tab's history() in the SAME script, so screen and history are one snapshot. */
  history = false,
): string {
  if (history && app !== "terminal-app") throw new Error("Only Terminal.app exposes a tab history() to read")
  const { application, label } = TERMINAL_TEXT_APPS[app]
  const select =
    app === "terminal-app"
      ? `    for (var w = 0; w < app.windows.length; w++) {
      var tabs = app.windows[w].tabs
      for (var t = 0; t < tabs.length; t++) {
        if (String(tabs[t].tty()) === ${JSON.stringify(tty)}) matches.push(tabs[t])
      }
    }`
      : `    for (var w = 0; w < app.windows.length; w++) {
      var tabs = app.windows[w].tabs
      for (var t = 0; t < tabs.length; t++) {
        var sessions = tabs[t].sessions
        for (var s = 0; s < sessions.length; s++) {
          if (String(sessions[s].tty()) === ${JSON.stringify(tty)}) matches.push(sessions[s])
        }
      }
    }`
  const geometry =
    app === "terminal-app"
      ? `    var appCols = Number(match.numberOfColumns())
    var appRows = Number(match.numberOfRows())`
      : `    var appCols = Number(match.columns())
    var appRows = Number(match.rows())`
  return `function run() {
  var refused = function (reason, diagnostic) {
    var response = { status: "refused", reason: ${JSON.stringify(label)} + " " + reason }
    if (diagnostic !== undefined) response.diagnostic = diagnostic
    return JSON.stringify(response)
  }
  try {
    var app = Application(${JSON.stringify(application)})
    if (!app.running()) return refused("is not running")
    if (!app.frontmost()) return refused("is not frontmost, so its screen state is not the measured one")
    var matches = []
${select}
    if (matches.length === 0) return refused("has no session on the owned TTY")
    if (matches.length > 1) return refused("has more than one session on the owned TTY")
    var match = matches[0]
    var text = String(match.contents())${history ? "\n    var historyText = String(match.history())" : ""}
    var readTty = String(match.tty())
    if (readTty !== ${JSON.stringify(tty)}) {
      return refused("changed the session's TTY while its text was read")
    }
${geometry}
    var lines = text.split(/\\r?\\n/)
    var splitRows = lines.length
    var terminatorRemoved = lines.length > 0 && lines[lines.length - 1] === ""
    if (terminatorRemoved) lines.pop()
    var dropped = lines.length - ${String(rows)}
    if (dropped < 0) {
      // What the app returned stays in the refusal: whether a missing row is a wrapped logical line is
      // read from these lengths, never inferred (33512).
      return refused("returned " + lines.length + " rows where the measured screen has ${String(rows)}", {
        contents: text, tty: readTty, appCols: appCols, appRows: appRows,
        splitRows: splitRows, terminatorRemoved: terminatorRemoved, rowsAfterPop: lines.length,
        lineLengths: lines.map(function (line) { return line.length })
      })
    }
    return JSON.stringify({
      status: "read",
      lines: lines.slice(dropped),
      droppedLines: dropped,
      appCols: appCols,
      appRows: appRows,${history ? "\n      history: historyText," : ""}
    })
  } catch (error) {
    // The app can raise INSIDE the script (a denied Apple event arrives here with its own number),
    // so the denial is carried out with the script's exit code 0 rather than left to stderr.
    return JSON.stringify({
      status: "refused",
      reason: "raised while reading: " + String(error && error.message ? error.message : error),
      errorNumber: error && typeof error.errorNumber === "number" ? error.errorNumber : null,
    })
  }
}`
}

/** One spawnSync result as a reply. Pure, so a killed or missing child is classified where no
 * osascript exists. */
export function osascriptReply(result: {
  stdout?: string | null
  stderr?: string | null
  status?: number | null
  signal?: NodeJS.Signals | null
  error?: NodeJS.ErrnoException
}): OsascriptReply {
  const code = result.error?.code
  return {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    status: result.status ?? null,
    signal: result.signal ?? null,
    // A killed child never answered, however it was killed: that is a read that never finished, not
    // a terminal that refused.
    timedOut: code === "ETIMEDOUT" || (result.signal ?? null) !== null,
    ...(result.error !== undefined && { error: { code, message: result.error.message } }),
  }
}

const defaultRun = (script: string, timeoutMs: number): OsascriptReply =>
  osascriptReply(
    spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
      encoding: "utf8",
      timeout: timeoutMs,
      // The macOS measurement workflow kills a hung read rather than letting it hold the run open.
      killSignal: "SIGKILL",
    }),
  )

/** The Automation (TCC) denial, named as a permission a human grants rather than a script failure. */
export function automationDeniedReason(app: TerminalTextApp): string {
  return `Automation (TCC) denied control of ${TERMINAL_TEXT_APPS[app].label}; grant Automation for osascript and rerun`
}

/** Name what went wrong, because these failures need different fixes: a missing binary is a host
 * problem, a TCC denial is a permission a human grants, a timeout is a slow or modal terminal, and
 * a missing session is the wrong TTY. */
export function classifyOsascriptFailure(reply: OsascriptReply, app: TerminalTextApp): string {
  const { label } = TERMINAL_TEXT_APPS[app]
  // A child that never started is the first thing to say: nothing the terminal did caused it.
  if (reply.error !== undefined && reply.error.code !== "ETIMEDOUT") {
    return `${label} could not be read: ${reply.error.code ?? "the text read could not start"}: ${reply.error.message}`
  }
  if (reply.timedOut) {
    const how = reply.signal === null ? "before its timeout" : `(killed by ${reply.signal})`
    return `${label} did not answer the text read ${how}`
  }
  if (/Not authorized to send Apple events|errAEEventNotPermitted|\(-1743\)/iu.test(reply.stderr)) {
    return automationDeniedReason(app)
  }
  if (/is not running/iu.test(reply.stderr)) return `${label} is not running`
  const detail = reply.stderr.trim() || reply.stdout.trim() || `exit ${String(reply.status)}`
  return `${label} refused the text read: ${detail.slice(0, 300)}`
}

/**
 * The non-ASCII code points this read maps, one NAMED entry each: the glyphs the Character Sets rows
 * actually paint, which the terminals return as drawn (30098, specimen run 39159788591). A code point
 * joins this list only because a measured row expects it as one cell — never a Unicode width table,
 * and never a range. The charset rows carry ASCII flank controls, so a glyph that filled two cells
 * would shift its flank and fail the row loudly instead of passing.
 */
export { NAMED_SINGLE_CELL_GLYPHS, isSingleCellCodePoint } from "./single-cell.ts"

/**
 * Map the read's rows onto cols x rows cells, or refuse BY NAME where the mapping cannot be exact.
 * The rows are already the screen's (the script popped the terminator and sliced the scrollback), so
 * a blank last row here is a blank last row and never a lost one.
 * `droppedLines` is what the read left above the screen; it is REQUIRED and carried, never defaulted:
 * a count the read did not give is refused by name, because 0 would claim nothing was left behind.
 */
export function mapSnapshotToCells(
  lines: readonly string[],
  cols: number,
  rows: number,
  droppedLines: number,
): TerminalCellGrid | string {
  if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 1 || rows < 1) {
    return `the measured geometry is not a size: ${String(cols)}x${String(rows)}`
  }
  if (!Number.isSafeInteger(droppedLines) || droppedLines < 0) {
    return `the dropped-line count is not a count: ${String(droppedLines)}`
  }
  if (lines.length !== rows) {
    return `the snapshot has ${String(lines.length)} rows where the measured screen has ${String(rows)}`
  }
  const mapped: string[] = []
  const paddedRows: number[] = []
  for (const [index, line] of lines.entries()) {
    const row = index + 1
    const points = [...line]
    for (const [position, character] of points.entries()) {
      const codePoint = character.codePointAt(0) ?? 0
      if (!isSingleCellCodePoint(codePoint)) {
        return `row ${String(row)} character ${String(position + 1)} is ${hex(codePoint)}, which is not printable ASCII or one of the named single-cell glyphs, so the snapshot cannot say how many cells it fills`
      }
    }
    if (points.length > cols) {
      return `row ${String(row)} is ${String(points.length)} characters over ${String(cols)} columns, so the terminal wrapped it and the row boundary is unknown`
    }
    // A row that passed those tests has width `cols`: the terminal trims only trailing blanks, so
    // padding them back is a measurement. The row is recorded so the evidence label can say so.
    if (points.length < cols) paddedRows.push(row)
    mapped.push(points.length < cols ? `${line}${" ".repeat(cols - points.length)}` : line)
  }
  return { cols, rows, text: mapped, paddedRows, droppedLines }
}

/** Fields from the vendored official api.proto; each entry is one physical screen row. */
export interface ITermLineContents {
  readonly text?: string
  readonly code_points_per_cell: readonly { readonly num_code_points?: number; readonly repeats?: number }[]
  readonly continuation?: number
  readonly style: readonly { readonly image?: number; readonly repeats?: number }[]
}

/**
 * Validate the protocol's physical-cell map before handing its strings to the existing mapper.
 * Only trailing uninitialized cells may use that mapper's named blank padding. Raw protocol
 * retention preserves continuation/style metadata; no logical-line joining happens here.
 */
export function mapITermBufferToCells(
  contents: readonly ITermLineContents[],
  cols: number,
  rows: number,
): TerminalCellGrid | string {
  if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 1 || rows < 1) {
    return `the measured geometry is not a size: ${String(cols)}x${String(rows)}`
  }
  if (contents.length !== rows) return `iTerm2 returned ${contents.length} rows where the measured screen has ${rows}`
  const lines: string[] = []
  for (const [index, line] of contents.entries()) {
    const row = index + 1
    if ((line.continuation ?? 1) !== 1 && line.continuation !== 2) {
      return `iTerm2 row ${row} has an unknown continuation`
    }
    // PTYSession.stringForLine (iTerm2 3.6.11) emits styles and the cell map over the same
    // returned cells. Both omit trailing uninitialized cells; images must still refuse.
    let styled = 0
    for (const style of line.style) {
      if ((style.image ?? 0) !== 0) return `iTerm2 row ${row} contains image cells omitted from its text map`
      if (!Number.isSafeInteger(style.repeats) || style.repeats === undefined || style.repeats < 1) {
        return `iTerm2 row ${row} has an invalid style repeat count`
      }
      styled += style.repeats
      if (styled > cols) return `iTerm2 row ${row} style coverage exceeds ${cols} columns`
    }
    const text = line.text ?? ""
    const points = [...text]
    let consumed = 0
    let cells = 0
    let trailingEmpty = false
    for (const run of line.code_points_per_cell) {
      if (!Number.isSafeInteger(run.repeats) || run.repeats === undefined || run.repeats < 1) {
        return `iTerm2 row ${row} has an invalid cell-map repeat count`
      }
      cells += run.repeats
      if (cells > cols) return `iTerm2 row ${row} cell map exceeds ${cols} columns`
      // The proto2 default is one, not zero; preserve an explicitly encoded zero.
      const count = run.num_code_points ?? 1
      if (count === 0) {
        trailingEmpty = true
      } else if (count === 1) {
        if (trailingEmpty) return `iTerm2 row ${row} has an interior uninitialized cell`
        consumed += run.repeats
      } else {
        return `iTerm2 row ${row} has unsupported code points per cell: ${count}`
      }
    }
    if (consumed !== points.length) {
      return `iTerm2 row ${row} code-point consumption is ${consumed}, but its text has ${points.length}`
    }
    if (styled !== cells) return `iTerm2 row ${row} style coverage is ${styled} cells, but its cell map has ${cells}`
    lines.push(text)
  }
  return mapSnapshotToCells(lines, cols, rows, 0)
}

export interface TerminalTextReadOptions {
  readonly app: TerminalTextApp
  readonly tty: string
  readonly cols: number
  readonly rows: number
  readonly timeoutMs?: number
  /** Injection seam for tests; production runs /usr/bin/osascript. */
  readonly run?: (script: string) => OsascriptReply
  /** Owned retention consumes the original transport reply before refusal discards its diagnostics. */
  readonly onReply?: (reply: OsascriptReply) => void
}

const stringArray = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string") ? value : undefined

/** Rows a diagnostic may name beyond the measured screen: a wrapped logical line adds a few at most. */
const DIAGNOSTIC_ROW_MARGIN = 4

const nonNegativeInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined

/**
 * The reply's stated diagnostic as the one record that may travel, or undefined when it states
 * anything less: a partial record is not filled in, because a blank field would read as a measured
 * zero. The reply's raw `contents` is never copied — the lengths are what a missing row is read from
 * — and `lineLengths` stops at the measured screen plus a small margin rather than growing the record
 * with whatever scrollback the app returned.
 */
function parseSnapshotDiagnostic(value: unknown, rowBound: number): TextSnapshotDiagnostic | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const tty = typeof record.tty === "string" && record.tty !== "" ? record.tty : undefined
  const appCols = nonNegativeInteger(record.appCols)
  const appRows = nonNegativeInteger(record.appRows)
  const splitRows = nonNegativeInteger(record.splitRows)
  const rowsAfterPop = nonNegativeInteger(record.rowsAfterPop)
  const terminatorRemoved = typeof record.terminatorRemoved === "boolean" ? record.terminatorRemoved : undefined
  if (!Array.isArray(record.lineLengths)) return undefined
  const kept: number[] = []
  for (const entry of record.lineLengths) {
    const length = nonNegativeInteger(entry)
    if (length === undefined) return undefined
    if (kept.length < rowBound) kept.push(length)
  }
  if (
    tty === undefined ||
    appCols === undefined ||
    appRows === undefined ||
    splitRows === undefined ||
    rowsAfterPop === undefined ||
    terminatorRemoved === undefined
  ) {
    return undefined
  }
  return {
    tty,
    appCols,
    appRows,
    splitRows,
    terminatorRemoved,
    rowsAfterPop,
    lineLengths: kept,
    lineLengthsTruncated: kept.length < record.lineLengths.length,
  }
}

/**
 * The reply's raw `contents`, held only long enough to try a split. It is deliberately NOT copied
 * into the diagnostic or the run record: the refusal still carries the typed record alone (30729).
 */
function rawReplyText(diagnostic: unknown): string | undefined {
  if (typeof diagnostic !== "object" || diagnostic === null) return undefined
  const contents = (diagnostic as Record<string, unknown>).contents
  return typeof contents === "string" ? contents : undefined
}

/** The reply's logical lines, with the single trailing terminator removed exactly as the script did. */
function rawReplyLines(text: string, terminatorRemoved: boolean): readonly string[] {
  const lines = text.split(/\r?\n/)
  if (terminatorRemoved && lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

type SnapshotReply =
  | {
      readonly status: "refused"
      readonly reason: string
      readonly diagnostic?: TextSnapshotDiagnostic
      readonly diagnosticDropped?: number
    }
  | {
      readonly status: "read"
      readonly lines: readonly string[]
      readonly appCols: number
      readonly appRows: number
      readonly droppedLines: number
      readonly history?: string
      /** Set only when the rows were rebuilt from the terminal's LOGICAL lines, with how many lines
       * had to be split. A read of the screen's own rows leaves it absent. */
      readonly splitLineCount?: number
    }

/** One owned-session script run and its reply checks, shared by the screen and history reads. */
function readSnapshotReply(options: TerminalTextReadOptions, history: boolean): SnapshotReply {
  const { label } = TERMINAL_TEXT_APPS[options.app]
  const run = options.run ?? ((script: string) => defaultRun(script, options.timeoutMs ?? 5_000))
  const reply = run(terminalTextScript(options.app, options.tty, options.cols, options.rows, history))
  options.onReply?.(reply)
  if (reply.timedOut || reply.status !== 0) {
    return { status: "refused", reason: classifyOsascriptFailure(reply, options.app) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(reply.stdout.trim())
  } catch {
    return {
      status: "refused",
      reason: `${label} did not return a snapshot: ${reply.stdout.trim().slice(0, 200) || "empty output"}`,
    }
  }
  if (typeof parsed !== "object" || parsed === null || !("status" in parsed)) {
    return { status: "refused", reason: `${label} returned no status in its snapshot` }
  }
  if (parsed.status === "refused") {
    // A denial the app raised inside the script comes back here, with its own error number and a
    // successful osascript: it is still a TCC denial, and says so rather than reading as a raise.
    if ("errorNumber" in parsed && parsed.errorNumber === TCC_ERROR_NUMBER) {
      return { status: "refused", reason: automationDeniedReason(options.app) }
    }
    const reason = "reason" in parsed && typeof parsed.reason === "string" ? parsed.reason : "no reason given"
    if (!("diagnostic" in parsed) || parsed.diagnostic === undefined) return { status: "refused", reason }
    // A short screen is the refusal this diagnostic explains (33512); the measured screen plus a
    // margin is the bound, so an app that overstated its own grid cannot grow the record.
    const diagnostic = parseSnapshotDiagnostic(parsed.diagnostic, options.rows + DIAGNOSTIC_ROW_MARGIN)
    // Terminal.app returns LOGICAL lines, so a short screen can be rows that wrapped (30729 AC3b).
    // The split is attempted on the reply's held text, and that text never leaves this function: the
    // refusal below carries the typed record, never the screen.
    const held = rawReplyText(parsed.diagnostic)
    const lines = held === undefined ? undefined : rawReplyLines(held, diagnostic?.terminatorRemoved === true)
    // A split measures row boundaries at a column count, so it is attempted only when the reply
    // stated a grid and that grid is the measured one. A record this read could not type proves
    // nothing about the screen, and a grid that disagrees is another screen by the same rule the
    // read path refuses below; either way the refusal stands, and the reason says which was missing.
    if (diagnostic === undefined) {
      return {
        status: "refused",
        reason: `${reason}, and the reply's grid could not be typed, so no split was attempted`,
        diagnosticDropped: 1,
      }
    }
    if (diagnostic.appCols !== options.cols || diagnostic.appRows !== options.rows) {
      return {
        status: "refused",
        reason: `${reason}, and ${label} reports ${String(diagnostic.appRows)}x${String(diagnostic.appCols)} where the measured grid is ${String(options.rows)}x${String(options.cols)}, so its lines are not the measured screen`,
        diagnostic,
      }
    }
    const split = lines === undefined ? undefined : splitLogicalRows(lines, options.cols, options.rows)
    if (split !== undefined && "rows" in split) {
      return {
        status: "read",
        lines: split.rows,
        appCols: diagnostic.appCols,
        appRows: diagnostic.appRows,
        droppedLines: 0,
        splitLineCount: split.splitLineCount,
      }
    }
    const refused = split === undefined ? reason : `${reason}, and ${split.reason}`
    return { status: "refused", reason: refused, diagnostic }
  }
  if (parsed.status !== "read" || !("lines" in parsed)) {
    return { status: "refused", reason: `${label} returned an unrecognised snapshot` }
  }
  const lines = stringArray(parsed.lines)
  const appCols = "appCols" in parsed && typeof parsed.appCols === "number" ? parsed.appCols : undefined
  const appRows = "appRows" in parsed && typeof parsed.appRows === "number" ? parsed.appRows : undefined
  const droppedLines =
    "droppedLines" in parsed && typeof parsed.droppedLines === "number" ? parsed.droppedLines : undefined
  if (lines === undefined || appCols === undefined || appRows === undefined || droppedLines === undefined) {
    return {
      status: "refused",
      reason: `${label} returned a snapshot without its rows, its own grid and the number of rows it dropped, so it cannot be placed on the measured screen`,
    }
  }
  // The app's grid is the screen the text came from. If it is not the measured one, the snapshot is
  // some other screen and every row would be a confident wrong answer.
  if (appRows !== options.rows || appCols !== options.cols) {
    return {
      status: "refused",
      reason: `${label} reports ${String(appRows)}x${String(appCols)} where the measured grid is ${String(options.rows)}x${String(options.cols)}, so its contents are not the measured screen`,
    }
  }
  const historyText = "history" in parsed && typeof parsed.history === "string" ? parsed.history : undefined
  if (history && historyText === undefined) {
    return { status: "refused", reason: `${label} returned a snapshot without the history it was asked for` }
  }
  return {
    status: "read",
    lines,
    appCols,
    appRows,
    droppedLines,
    ...(historyText !== undefined && { history: historyText }),
  }
}

/** Read the owned macOS session's text and map it onto cells, or refuse with the reason. */
export function readTerminalTextSnapshot(options: TerminalTextReadOptions): TerminalTextRead {
  const snapshot = readSnapshotReply(options, false)
  if (snapshot.status === "refused") return snapshot
  const cells = mapSnapshotToCells(snapshot.lines, snapshot.appCols, snapshot.appRows, snapshot.droppedLines)
  if (typeof cells === "string") return { status: "refused", reason: cells }
  return {
    status: "read",
    app: options.app,
    cells: snapshot.splitLineCount === undefined ? cells : { ...cells, splitLineCount: snapshot.splitLineCount },
  }
}

export type TerminalHistoryRead =
  | {
      readonly status: "read"
      /** Terminal.app's history() text lines, one terminator removed, trailing empty lines removed. */
      readonly historyLines: readonly string[]
      readonly reading: TerminalScrollbackReading
    }
  | { readonly status: "refused"; readonly reason: string }

const trimTrailingEmpty = (lines: readonly string[]): readonly string[] => {
  let end = lines.length
  while (end > 0 && lines[end - 1] === "") end--
  return lines.slice(0, end)
}

/**
 * Terminal.app's retained history, read with its screen in ONE script (31741). A row is one text
 * line of the tab's history(), which runs from the oldest retained line through the screen; one line
 * terminator and then every trailing empty line are removed from both history and screen, so blank
 * rows under the last written line count nowhere. totalLines = (history lines - screen lines) +
 * screen rows: the retained lines above the screen plus the measured screen, so the screen rows are
 * inside the count and an empty history reads exactly `rows`. screenLines = rows. Capacity is never
 * set: Terminal.app does not report it, and a count that stopped growing is not one. Refused, so no
 * reading, when a line is longer than the grid (it wrapped, so lines are not rows) or when the
 * history does not end with the screen's lines.
 */
export function readTerminalAppHistory(options: Omit<TerminalTextReadOptions, "app">): TerminalHistoryRead {
  const label = TERMINAL_TEXT_APPS["terminal-app"].label
  const snapshot = readSnapshotReply({ ...options, app: "terminal-app" }, true)
  // The shared reply check has already refused a grid that is not the measured one.
  if (snapshot.status === "refused") return snapshot
  const raw = (snapshot.history ?? "").split(/\r?\n/)
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop()
  const historyLines = trimTrailingEmpty(raw)
  const screen = trimTrailingEmpty(snapshot.lines)
  // History lines are not padded to full width, so only a line longer than the grid can have
  // wrapped; a line at or under it is one row and passes through unchanged. A line that did wrap is
  // split by the same splitter the screen read uses, never by a second set of rules (30729).
  const rowsOf = (lines: readonly string[]): readonly string[] | { readonly reason: string } => {
    const rebuilt: string[] = []
    for (const [index, line] of lines.entries()) {
      if ([...line].length <= options.cols) {
        rebuilt.push(line)
        continue
      }
      const pieces = splitLogicalLine(line, options.cols, index + 1)
      if ("reason" in pieces) return pieces
      rebuilt.push(...pieces)
    }
    return rebuilt
  }
  const historyRows = rowsOf(historyLines)
  const screenRows = rowsOf(screen)
  if ("reason" in historyRows || "reason" in screenRows) {
    const wrapped = [...historyLines, ...screen].find((line) => [...line].length > options.cols) ?? ""
    return {
      status: "refused",
      reason: `${label} history holds a line of ${String([...wrapped].length)} characters on a ${String(options.cols)}-column grid, so it wrapped and its lines are not rows`,
    }
  }
  const tail = historyRows.slice(historyRows.length - screenRows.length)
  if (screenRows.length > historyRows.length || tail.some((line, index) => line !== screenRows[index])) {
    return {
      status: "refused",
      reason: `${label} history does not end with the screen's ${String(screenRows.length)} lines, so its count cannot be placed above this screen`,
    }
  }
  // The owned tab's tty is the one this run measured; Terminal.app publishes no second tty for the tab, and
  // the record says so with an absent listed tty rather than claiming a match it never made.
  const identity = ownedHistoryReceipt({
    surface: "terminal-app",
    measuredTty: options.tty,
    executable: options.run === undefined ? "osascript" : undefined,
  })
  if (identity.status === "refused") return { status: "refused", reason: identity.reason }
  return {
    status: "read",
    historyLines,
    reading: {
      totalLines: historyRows.length - screenRows.length + options.rows,
      screenLines: options.rows,
      receipt: identity.receipt,
    },
  }
}

/** The per-run control's numbers, retained with the run so the packet can show them (31741). */
export interface TerminalHistoryControl {
  readonly markers: number
  readonly before: number
  readonly after: number
  readonly status: "passed" | "failed"
  readonly reason?: string
}

/**
 * Terminal.app's history reader for one run. Before its first reading it proves itself on the live
 * tab: it clears the screen, writes `rows + 5` numbered marker lines (past one screen), and the
 * history must then hold every marker, first and last included, with its line count grown by exactly
 * that many. Only then, after clearing the screen again, does it return readings. A failed control,
 * a refused read or a read that never settles is no reading, by name, for every later call too: it
 * never reads as 0 lines.
 */
export function terminalAppHistoryReader(options: {
  read: () => TerminalHistoryRead
  write: (text: string) => void
  rows: number
  nonce: string
  timeoutMs?: number
  pollMs?: number
  onControl?: (control: TerminalHistoryControl) => void
}): () => Promise<TerminalScrollbackReading> {
  const { read, write, rows, nonce, onControl } = options
  const timeoutMs = options.timeoutMs ?? 5_000
  const pollMs = options.pollMs ?? 100
  let control: Promise<void> | undefined
  const unavailable = (reason: string) => new ScrollbackReadingUnavailable(`Terminal.app history: ${reason}`)
  const once = (): TerminalHistoryRead & { status: "read" } => {
    const reading = read()
    if (reading.status === "refused") throw unavailable(reading.reason)
    return reading
  }
  /** Reads until `accept` holds or the deadline passes; the last reading either way. */
  const until = async (accept: (reading: TerminalHistoryRead & { status: "read" }) => boolean) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const reading = once()
      if (accept(reading) || Date.now() >= deadline) return reading
      await new Promise<void>((resolve) => {
        setTimeout(resolve, pollMs)
      })
    }
  }
  const settled = async () => {
    let previous: number | undefined
    return until((reading) => {
      const same = previous === reading.historyLines.length
      previous = reading.historyLines.length
      return same
    })
  }
  const prove = async () => {
    write("\x1b[0m\x1b[2J\x1b[H")
    const before = (await settled()).historyLines.length
    const markers = Array.from({ length: rows + 5 }, (_unused, index) => `terminfo history control ${nonce} ${index}`)
    write(markers.map((marker) => `${marker}\r\n`).join(""))
    const reading = await until((candidate) => candidate.historyLines.length >= before + markers.length)
    const after = reading.historyLines.length
    const written = reading.historyLines.slice(before, before + markers.length)
    const reason =
      after !== before + markers.length
        ? `the control wrote ${String(markers.length)} marker lines and the history grew by ${String(after - before)}`
        : written.some((line, index) => line !== markers[index])
          ? `the history grew by ${String(markers.length)} lines but does not hold the control's markers in order, first ${JSON.stringify(written[0])}, last ${JSON.stringify(written.at(-1))}`
          : undefined
    onControl?.({
      markers: markers.length,
      before,
      after,
      status: reason === undefined ? "passed" : "failed",
      ...(reason !== undefined && { reason }),
    })
    write("\x1b[0m\x1b[2J\x1b[H")
    if (reason !== undefined) throw unavailable(reason)
  }
  return async () => {
    control ??= prove()
    await control
    return (await settled()).reading
  }
}
