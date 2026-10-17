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
 * the last `rows` lines and returns the count it dropped. Terminal.app reports its screen only and
 * drops nothing; both take the same slice, and the returned count says which happened, so the
 * evidence label can record it.
 *
 * Refusal is a sentinel with a reason, and it is used wherever the snapshot cannot be mapped to
 * cells EXACTLY: a line the terminal wrapped, a character outside printable ASCII — whose cell width
 * the snapshot cannot name, which covers combining marks, wide characters, East Asian ambiguous
 * characters and tabs — a line count that is not the screen's row count, an app grid that disagrees
 * with the measured one, a session that is not the owned one or that changed TTY while it was read,
 * a terminal that is not frontmost, a read that runs past its timeout or is killed, and an
 * Automation (TCC) denial, which is named as a denial rather than reported as a generic script
 * failure.
 *
 * A row shorter than `cols` is a refusal, not a padding: a printable ASCII code point fills exactly
 * one cell, so the missing width is trailing blanks the terminal trimmed, and the row's exact
 * characters are then unknown.
 *
 * Empty text is a VALUE. Nothing here turns "no characters" into "could not read".
 */
import { spawnSync } from "node:child_process"

/** The two macOS terminals this arm can read, with the bundle name JXA addresses. */
export const TERMINAL_TEXT_APPS = {
  "terminal-app": { application: "Terminal", label: "Terminal.app" },
  iterm2: { application: "iTerm2", label: "iTerm2" },
} as const

export type TerminalTextApp = keyof typeof TERMINAL_TEXT_APPS

/** A text snapshot mapped onto exact cells: one string per row, each exactly `cols` characters. */
export interface TerminalCellGrid {
  readonly cols: number
  readonly rows: number
  readonly text: readonly string[]
  /** Lines the snapshot carried above the visible screen and the read did not map. Zero for a
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
}

/**
 * The JXA that reads the owned session. It selects by TTY, never "the first window": another
 * window's contents would be a confident wrong answer. It also returns the app's own grid, so the
 * caller can refuse a snapshot that is not the measured screen, and the count of scrollback lines
 * it left behind.
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
      return refused("returned " + lines.length + " lines where the measured screen has ${String(rows)} rows")
    }
    return JSON.stringify({
      status: "read",
      text: lines.slice(dropped).join("\\n"),
      droppedLines: dropped,
      appCols: appCols,
      appRows: appRows,
    })
  } catch (error) {
    return refused("raised while reading: " + String(error && error.message ? error.message : error))
  }
}`
}

const defaultRun = (script: string, timeoutMs: number): OsascriptReply => {
  const result = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
    encoding: "utf8",
    timeout: timeoutMs,
    // The macOS measurement workflow kills a hung read rather than letting it hold the run open.
    killSignal: "SIGKILL",
  })
  const code = result.error === undefined ? undefined : (result.error as NodeJS.ErrnoException).code
  return {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    status: result.status,
    signal: result.signal,
    // A child that ran past its timeout, or was killed for any other reason, did not answer: that is
    // a read that never finished, not a terminal that refused.
    timedOut: code === "ETIMEDOUT" || result.signal !== null,
  }
}

/** Name what went wrong, because these failures need different fixes: a TCC denial is a permission
 * a human grants, a timeout is a slow or modal terminal, a missing session is the wrong TTY. */
export function classifyOsascriptFailure(reply: OsascriptReply, app: TerminalTextApp): string {
  const { label } = TERMINAL_TEXT_APPS[app]
  if (reply.timedOut) return `${label} did not answer the text read before it timed out`
  if (/Not authorized to send Apple events|errAEEventNotPermitted|\(-1743\)/iu.test(reply.stderr)) {
    return `Automation (TCC) denied control of ${label}; grant Automation for osascript and rerun`
  }
  if (/is not running/iu.test(reply.stderr)) return `${label} is not running`
  const detail = reply.stderr.trim() || reply.stdout.trim() || `exit ${String(reply.status)}`
  return `${label} refused the text read: ${detail.slice(0, 300)}`
}

/** True for the only code points this read maps to exactly one cell: printable ASCII. Anything
 * else — combining marks, wide characters, East Asian ambiguous characters, control characters —
 * has a cell width a text snapshot cannot name, and the mapping refuses rather than guesses. */
export function isPrintableAsciiCell(codePoint: number): boolean {
  return codePoint >= 0x20 && codePoint <= 0x7e
}

const hex = (codePoint: number): string => `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`

/**
 * Map a text snapshot onto cols x rows cells, or refuse BY NAME where the mapping cannot be exact.
 * `droppedLines` is what the read left above the screen; it is carried, never guessed.
 */
export function mapSnapshotToCells(
  text: string,
  cols: number,
  rows: number,
  droppedLines = 0,
): TerminalCellGrid | string {
  if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 1 || rows < 1) {
    return `the measured geometry is not a size: ${String(cols)}x${String(rows)}`
  }
  if (!Number.isSafeInteger(droppedLines) || droppedLines < 0) {
    return `the dropped-line count is not a count: ${String(droppedLines)}`
  }
  const lines = text.split(/\r?\n/u)
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  if (lines.length !== rows) {
    return `the snapshot has ${String(lines.length)} lines where the measured screen has ${String(rows)} rows`
  }
  const mapped: string[] = []
  for (const [index, line] of lines.entries()) {
    const row = index + 1
    const points = [...line]
    for (const [position, character] of points.entries()) {
      const codePoint = character.codePointAt(0) ?? 0
      if (!isPrintableAsciiCell(codePoint)) {
        return `row ${String(row)} character ${String(position + 1)} is ${hex(codePoint)}, which is not printable ASCII, so the snapshot cannot say how many cells it fills`
      }
    }
    if (points.length > cols) {
      return `row ${String(row)} is ${String(points.length)} characters over ${String(cols)} columns, so the terminal wrapped it and the row boundary is unknown`
    }
    if (points.length < cols) {
      return `row ${String(row)} is ${String(points.length)} characters under ${String(cols)} columns, so the terminal trimmed it and the row's exact characters are unknown`
    }
    mapped.push(line)
  }
  return { cols, rows, text: mapped, droppedLines }
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
    const reason = "reason" in parsed && typeof parsed.reason === "string" ? parsed.reason : "no reason given"
    return { status: "refused", reason }
  }
  if (parsed.status !== "read" || !("text" in parsed) || typeof parsed.text !== "string") {
    return { status: "refused", reason: `${label} returned an unrecognised snapshot` }
  }
  const appCols = "appCols" in parsed && typeof parsed.appCols === "number" ? parsed.appCols : undefined
  const appRows = "appRows" in parsed && typeof parsed.appRows === "number" ? parsed.appRows : undefined
  const droppedLines =
    "droppedLines" in parsed && typeof parsed.droppedLines === "number" ? parsed.droppedLines : undefined
  if (appCols === undefined || appRows === undefined || droppedLines === undefined) {
    return {
      status: "refused",
      reason: `${label} returned a snapshot without its own grid and dropped-line count, so it cannot be placed on the measured screen`,
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
  const cells = mapSnapshotToCells(parsed.text, appCols, appRows, droppedLines)
  if (typeof cells === "string") return { status: "refused", reason: cells }
  return { status: "read", app: options.app, cells }
}
