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
}

export type TerminalTextRead =
  | { readonly status: "read"; readonly app: TerminalTextApp; readonly cells: TerminalCellGrid }
  | { readonly status: "refused"; readonly reason: string }

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
export function terminalTextScript(app: TerminalTextApp, tty: string, cols: number, rows: number): string {
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
  var refused = function (reason) {
    return JSON.stringify({ status: "refused", reason: ${JSON.stringify(label)} + " " + reason })
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
    var text = String(match.contents())
    if (String(match.tty()) !== ${JSON.stringify(tty)}) {
      return refused("changed the session's TTY while its text was read")
    }
${geometry}
    var lines = text.split(/\\r?\\n/)
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
    var dropped = lines.length - ${String(rows)}
    if (dropped < 0) {
      return refused("returned " + lines.length + " rows where the measured screen has ${String(rows)}" +
        " (the app reports " + appRows + " rows x " + appCols + " columns)")
    }
    return JSON.stringify({
      status: "read",
      lines: lines.slice(dropped),
      droppedLines: dropped,
      appCols: appCols,
      appRows: appRows,
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
export const NAMED_SINGLE_CELL_GLYPHS = [
  { codePoint: 0x00e9, name: "é, the UTF-8 sample cell" },
  { codePoint: 0x2500, name: "─ horizontal line, DEC Special Graphics q" },
  { codePoint: 0x2502, name: "│ vertical line, DEC Special Graphics x" },
  { codePoint: 0x250c, name: "┌ upper-left corner, DEC Special Graphics l" },
  { codePoint: 0x2510, name: "┐ upper-right corner, DEC Special Graphics k" },
  { codePoint: 0x2514, name: "└ lower-left corner, DEC Special Graphics m" },
  { codePoint: 0x2518, name: "┘ lower-right corner, DEC Special Graphics j" },
] as const

const NAMED_SINGLE_CELL_CODES: ReadonlySet<number> = new Set(NAMED_SINGLE_CELL_GLYPHS.map(({ codePoint }) => codePoint))

/** True for the only code points this read maps to exactly one cell: printable ASCII and the named
 * glyphs above. Anything else — combining marks, wide characters, East Asian ambiguous characters,
 * control characters — has a cell width a text snapshot cannot name, and the mapping refuses rather
 * than guesses. */
export function isSingleCellCodePoint(codePoint: number): boolean {
  return (codePoint >= 0x20 && codePoint <= 0x7e) || NAMED_SINGLE_CELL_CODES.has(codePoint)
}

const hex = (codePoint: number): string => `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`

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
    // A row that passed those checks has width `cols`: the terminal trims only trailing blanks, so
    // padding them back is a measurement. The row is recorded so the evidence label can say so.
    if (points.length < cols) paddedRows.push(row)
    mapped.push(points.length < cols ? `${line}${" ".repeat(cols - points.length)}` : line)
  }
  return { cols, rows, text: mapped, paddedRows, droppedLines }
}

export interface TerminalTextReadOptions {
  readonly app: TerminalTextApp
  readonly tty: string
  readonly cols: number
  readonly rows: number
  readonly timeoutMs?: number
  /** Injection seam for tests; production runs /usr/bin/osascript. */
  readonly run?: (script: string) => OsascriptReply
}

const stringArray = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string") ? value : undefined

/** Read the owned macOS session's text and map it onto cells, or refuse with the reason. */
export function readTerminalTextSnapshot(options: TerminalTextReadOptions): TerminalTextRead {
  const { label } = TERMINAL_TEXT_APPS[options.app]
  const run = options.run ?? ((script: string) => defaultRun(script, options.timeoutMs ?? 5_000))
  const reply = run(terminalTextScript(options.app, options.tty, options.cols, options.rows))
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
    return { status: "refused", reason }
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
  const cells = mapSnapshotToCells(lines, appCols, appRows, droppedLines)
  if (typeof cells === "string") return { status: "refused", reason: cells }
  return { status: "read", app: options.app, cells }
}
