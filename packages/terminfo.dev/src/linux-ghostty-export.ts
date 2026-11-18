/**
 * Ghostty's own scrollback export as the Linux arm's history count (#34278), under @cto a1663f9d's five
 * conditions:
 * 1. The file is the one Ghostty hands over: `write_scrollback_file:paste` types the file's path into this pane,
 *    and this reader takes it from its own input. No temp-directory guess and no newest-file search.
 * 2. The file is new for this trigger (modified no earlier than the key press) and is read once, then removed, so
 *    a leftover file cannot pass.
 * 3. The keybind is a declared precondition: the container launch adds GHOSTTY_EXPORT_KEYBIND to Ghostty's
 *    arguments (recorded in the launch receipt) and exports it, and the key reaches the app as an XTEST key event.
 * 4. It answers only what a dump answers: how many lines are retained. It reports no viewport position.
 * 5. The method is named in the receipt.
 * A failed or empty export is unavailable (probe-todo), never a negative.
 *
 * Measured 2026-11-18 on Ghostty 1.4.0 (/hh/var/@dev/4/34278/hand/FINDINGS.txt): the path arrives as plain text,
 * with no bracketed-paste markers and no newline, so the reader presses Return after the key to end it; the file
 * holds the history above the screen only (60 lines written on 24 rows: lines 1..36), its last line unterminated.
 */
import type { TerminalScrollbackReading } from "@terminfo/probe-defs"
import { ScrollbackReadingUnavailable } from "@terminfo/probe-defs"

/** The launch argument value the container declares; serve.ts installs this reader only when it matches. */
export const GHOSTTY_EXPORT_KEYBIND = "ctrl+shift+f12=write_scrollback_file:paste"
/** The same key, in the XTEST adapter's (xdotool) key names. */
const GHOSTTY_EXPORT_KEY = "ctrl+shift+F12"
export const GHOSTTY_EXPORT_METHOD = "app's scrollback export (Ghostty write_scrollback_file:paste)"
/** The pasted path, ended by the Return this reader presses after the key. */
const PASTED_PATH = /(\/[^\r\n\x1b]*)\r/
/** Timestamps on the export's file system can round down by a tick; a file older than this before the press fails. */
const MTIME_TOLERANCE_MS = 10

export interface GhosttyExportDeps {
  /** Press a key on the owned window through the run's XTEST adapter. */
  readonly press: (keys: string) => Promise<void>
  /** Arm a read of this pane's own input, run `inject`, and return the pattern's match or null on timeout. */
  readonly readPasted: (pattern: RegExp, inject: () => Promise<void>) => Promise<string[] | null>
  readonly now: () => number
  readonly stat: (path: string) => { readonly isFile: boolean; readonly mtimeMs: number }
  readonly readOnce: (path: string) => string
  readonly remove: (path: string) => void
  /** The screen rows from the run geometry: the export holds the history above them only. */
  readonly screenRows: () => number
}

function unavailable(reason: string): never {
  throw new ScrollbackReadingUnavailable(`Ghostty scrollback export: ${reason}`)
}

/** Count the lines of a history dump: newline-separated, the last one possibly unterminated. */
export function exportedHistoryLines(text: string): number {
  if (text === "") return 0
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n").length
}

export async function readGhosttyExport(deps: GhosttyExportDeps): Promise<TerminalScrollbackReading> {
  const pressedAt = deps.now()
  const match = await deps.readPasted(PASTED_PATH, async () => {
    await deps.press(GHOSTTY_EXPORT_KEY)
    await deps.press("Return")
  })
  const path = match?.[1]
  if (path === undefined || path === "/") unavailable("Ghostty typed no file path into the pane")
  let file: { readonly isFile: boolean; readonly mtimeMs: number }
  try {
    file = deps.stat(path)
  } catch (error) {
    unavailable(`the path Ghostty typed cannot be read: ${path}: ${(error as Error).message}`)
  }
  if (!file.isFile) unavailable(`the path Ghostty typed is not a file: ${path}`)
  if (file.mtimeMs + MTIME_TOLERANCE_MS < pressedAt) {
    unavailable(`the file predates the key press (${file.mtimeMs} < ${pressedAt}): ${path}`)
  }
  const text = deps.readOnce(path)
  deps.remove(path)
  if (text === "") unavailable(`the export is empty: ${path}`)
  const history = exportedHistoryLines(text)
  const rows = deps.screenRows()
  return {
    totalLines: history + rows,
    screenLines: rows,
    receipt: JSON.stringify({
      method: GHOSTTY_EXPORT_METHOD,
      keybind: GHOSTTY_EXPORT_KEYBIND,
      path,
      pressedAt,
      mtimeMs: file.mtimeMs,
      historyLines: history,
      screenRows: rows,
      geometrySource: "rows from run geometry",
    }),
  }
}
