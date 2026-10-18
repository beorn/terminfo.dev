/**
 * @failure A blank last row or a blank screen reads as "could not read"; an Automation (TCC) denial
 *   the app raises inside the script reads as an ordinary refusal; a missing osascript reads as a
 *   terminal refusing the read; a read that walked an iTerm2 window for sessions it does not expose,
 *   mapped scrollback or a soft-wrapped line onto the screen, or padded a row containing a character
 *   whose width it cannot name would decide those rows on a snapshot nobody could place on the grid.
 * @level l1
 * @consumer readTerminalTextSnapshot, the macOS half of the hosted-arm cell readback.
 * @testonly none
 */
import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import {
  automationDeniedReason,
  classifyOsascriptFailure,
  isSingleCellCodePoint,
  mapSnapshotToCells,
  NAMED_SINGLE_CELL_GLYPHS,
  osascriptReply,
  readTerminalTextSnapshot,
  terminalTextScript,
  type OsascriptReply,
} from "./darwin-terminal-text.ts"

const reply = (overrides: Partial<OsascriptReply>): OsascriptReply => ({
  stdout: "",
  stderr: "",
  status: 0,
  signal: null,
  timedOut: false,
  ...overrides,
})

/**
 * Run the generated JXA against a fake object model, so the script's own walk is exercised rather
 * than searched for strings. The fake mirrors each app's dictionary: a Terminal.app window exposes
 * tabs with the TTY on the tab, and an iTerm2 window exposes tabs whose sessions carry the TTY.
 */
interface FakeSession {
  tty: () => string
  contents: () => string
  rows: () => number
  columns: () => number
}
interface FakeTerminalTab {
  tty: () => string
  contents: () => string
  numberOfRows: () => number
  numberOfColumns: () => number
}
type FakeWindow = { tabs: readonly unknown[] }

const terminalTab = (overrides: Partial<FakeTerminalTab> = {}): FakeTerminalTab => ({
  tty: () => "/dev/ttys003",
  contents: () => "ab\ncd\n",
  numberOfRows: () => 2,
  numberOfColumns: () => 4,
  ...overrides,
})

const itermSession = (overrides: Partial<FakeSession> = {}): FakeSession => ({
  tty: () => "/dev/ttys007",
  contents: () => "ab\ncd\n",
  rows: () => 2,
  columns: () => 4,
  ...overrides,
})

const fakeApplication = (app: { running?: boolean; frontmost?: boolean; windows: readonly FakeWindow[] }): unknown => ({
  running: () => app.running ?? true,
  frontmost: () => app.frontmost ?? true,
  windows: app.windows,
})

interface ScriptReply {
  status: string
  reason?: string
  errorNumber?: number | null
  lines?: string[]
  droppedLines?: number
  appCols?: number
  appRows?: number
}

const runGenerated = (script: string, application: unknown): ScriptReply =>
  JSON.parse(String(runInNewContext(`${script}\nrun()`, { Application: () => application }))) as ScriptReply

describe("terminalTextScript — the walk each app's object model actually exposes", () => {
  it("reads Terminal.app's owned tab and returns its rows, its grid and a dropped count of zero", () => {
    const script = terminalTextScript("terminal-app", "/dev/ttys003", 4, 2)
    expect(runGenerated(script, fakeApplication({ windows: [{ tabs: [terminalTab()] }] }))).toEqual({
      status: "read",
      lines: ["ab", "cd"],
      droppedLines: 0,
      appCols: 4,
      appRows: 2,
    })
  })

  it("walks iTerm2 windows, then tabs, then sessions, and keeps only the last measured rows", () => {
    const session = itermSession({ contents: () => "scroll1\nscroll2\nnew1\nnew2\n" })
    const script = terminalTextScript("iterm2", "/dev/ttys007", 4, 2)
    const result = runGenerated(script, fakeApplication({ windows: [{ tabs: [{ sessions: [session] }] }] }))
    expect(result.status).toBe("read")
    expect(result.lines).toEqual(["new1", "new2"])
    expect(result.droppedLines).toBe(2)
    expect(result.appCols).toBe(4)
    expect(result.appRows).toBe(2)
  })

  it("finds the owned session in a later window and skips the tabs of other windows", () => {
    const other = terminalTab({ tty: () => "/dev/ttys001" })
    const script = terminalTextScript("terminal-app", "/dev/ttys003", 4, 2)
    const result = runGenerated(script, fakeApplication({ windows: [{ tabs: [other] }, { tabs: [terminalTab()] }] }))
    expect(result.status).toBe("read")
    expect(result.lines).toEqual(["ab", "cd"])
  })

  // Empty text is a value: the terminator is popped once, in the script, so a real blank last row
  // and a blank screen survive as rows of their own.
  it("keeps a blank last row instead of reading it as a missing one", () => {
    const script = terminalTextScript("terminal-app", "/dev/ttys003", 4, 2)
    const result = runGenerated(
      script,
      fakeApplication({ windows: [{ tabs: [terminalTab({ contents: () => "ab\n\n" })] }] }),
    )
    expect(result).toEqual({ status: "read", lines: ["ab", ""], droppedLines: 0, appCols: 4, appRows: 2 })
  })

  it("keeps a blank screen as two blank rows", () => {
    const script = terminalTextScript("terminal-app", "/dev/ttys003", 4, 2)
    const result = runGenerated(
      script,
      fakeApplication({ windows: [{ tabs: [terminalTab({ contents: () => "\n\n" })] }] }),
    )
    expect(result).toEqual({ status: "read", lines: ["", ""], droppedLines: 0, appCols: 4, appRows: 2 })
  })

  it("keeps a blank last row that follows scrollback, without pulling the scrollback onto the screen", () => {
    const session = itermSession({ contents: () => "scroll1\nscroll2\nab\n\n" })
    const result = runGenerated(
      terminalTextScript("iterm2", "/dev/ttys007", 4, 2),
      fakeApplication({ windows: [{ tabs: [{ sessions: [session] }] }] }),
    )
    expect(result).toEqual({ status: "read", lines: ["ab", ""], droppedLines: 2, appCols: 4, appRows: 2 })
  })

  it("refuses when no Terminal.app tab is on the owned TTY", () => {
    const script = terminalTextScript("terminal-app", "/dev/ttys003", 4, 2)
    const result = runGenerated(
      script,
      fakeApplication({ windows: [{ tabs: [terminalTab({ tty: () => "/dev/ttys001" })] }] }),
    )
    expect(result.status).toBe("refused")
    expect(result.reason).toMatch(/Terminal\.app has no session on the owned TTY/u)
  })

  it("refuses when no iTerm2 session is on the owned TTY", () => {
    const result = runGenerated(
      terminalTextScript("iterm2", "/dev/ttys007", 4, 2),
      fakeApplication({ windows: [{ tabs: [{ sessions: [itermSession({ tty: () => "/dev/ttys001" })] }] }] }),
    )
    expect(result.status).toBe("refused")
    expect(result.reason).toMatch(/iTerm2 has no session on the owned TTY/u)
  })

  it("refuses when two Terminal.app tabs claim the owned TTY", () => {
    const result = runGenerated(
      terminalTextScript("terminal-app", "/dev/ttys003", 4, 2),
      fakeApplication({ windows: [{ tabs: [terminalTab(), terminalTab()] }] }),
    )
    expect(result.status).toBe("refused")
    expect(result.reason).toMatch(/more than one session on the owned TTY/u)
  })

  it("refuses when two iTerm2 sessions claim the owned TTY", () => {
    const result = runGenerated(
      terminalTextScript("iterm2", "/dev/ttys007", 4, 2),
      fakeApplication({
        windows: [{ tabs: [{ sessions: [itermSession()] }] }, { tabs: [{ sessions: [itermSession()] }] }],
      }),
    )
    expect(result.status).toBe("refused")
    expect(result.reason).toMatch(/more than one session on the owned TTY/u)
  })

  it("refuses a Terminal.app that is not frontmost", () => {
    const result = runGenerated(
      terminalTextScript("terminal-app", "/dev/ttys003", 4, 2),
      fakeApplication({ frontmost: false, windows: [] }),
    )
    expect(result.status).toBe("refused")
    expect(result.reason).toMatch(/Terminal\.app is not frontmost/u)
  })

  it("refuses an iTerm2 that is not frontmost", () => {
    const result = runGenerated(
      terminalTextScript("iterm2", "/dev/ttys007", 4, 2),
      fakeApplication({ frontmost: false, windows: [] }),
    )
    expect(result.status).toBe("refused")
    expect(result.reason).toMatch(/iTerm2 is not frontmost/u)
  })

  it("refuses a terminal that is not running", () => {
    const result = runGenerated(
      terminalTextScript("iterm2", "/dev/ttys007", 4, 2),
      fakeApplication({ running: false, windows: [] }),
    )
    expect(result.status).toBe("refused")
    expect(result.reason).toMatch(/iTerm2 is not running/u)
  })

  it("refuses when the session changes TTY between the match and the contents read", () => {
    let calls = 0
    const session = itermSession({ tty: () => (++calls === 1 ? "/dev/ttys007" : "/dev/ttys099") })
    const result = runGenerated(
      terminalTextScript("iterm2", "/dev/ttys007", 4, 2),
      fakeApplication({ windows: [{ tabs: [{ sessions: [session] }] }] }),
    )
    expect(result.status).toBe("refused")
    expect(result.reason).toMatch(/changed the session's TTY while its text was read/u)
  })

  it("refuses a screen with fewer lines than the measured rows instead of inventing the missing ones", () => {
    const session = itermSession({ contents: () => "only\n" })
    const result = runGenerated(
      terminalTextScript("iterm2", "/dev/ttys007", 4, 2),
      fakeApplication({ windows: [{ tabs: [{ sessions: [session] }] }] }),
    )
    expect(result.status).toBe("refused")
    expect(result.reason).toMatch(/returned 1 rows where the measured screen has 2/u)
  })

  it("names an error the app raised instead of reporting it as a refusal of the read", () => {
    const session = itermSession({
      contents: () => {
        throw new Error("window closed")
      },
    })
    const result = runGenerated(
      terminalTextScript("iterm2", "/dev/ttys007", 4, 2),
      fakeApplication({ windows: [{ tabs: [{ sessions: [session] }] }] }),
    )
    expect(result.status).toBe("refused")
    expect(result.reason).toMatch(/raised while reading: window closed/u)
    expect(result.errorNumber).toBeNull()
  })

  it("carries the app's own error number out of the catch, so a denial is not read as a raise", () => {
    const denied = Object.assign(new Error("Not authorized to send Apple events to iTerm2."), { errorNumber: -1743 })
    const session = itermSession({
      contents: () => {
        throw denied
      },
    })
    const result = runGenerated(
      terminalTextScript("iterm2", "/dev/ttys007", 4, 2),
      fakeApplication({ windows: [{ tabs: [{ sessions: [session] }] }] }),
    )
    expect(result.status).toBe("refused")
    expect(result.errorNumber).toBe(-1743)
  })
})

describe("isSingleCellCodePoint — one code point, one cell, or the mapping is refused", () => {
  it("accepts printable ASCII", () => {
    expect(isSingleCellCodePoint(0x20)).toBe(true)
    expect(isSingleCellCodePoint(0x41)).toBe(true)
    expect(isSingleCellCodePoint(0x7e)).toBe(true)
  })

  // 30098: the macOS apps return the charset rows' glyphs as drawn, so each one this arm maps is a
  // named entry with its own proof rather than a range.
  it.each(
    NAMED_SINGLE_CELL_GLYPHS.map((glyph) => ({
      ...glyph,
      hex: `U+${glyph.codePoint.toString(16).toUpperCase().padStart(4, "0")}`,
    })),
  )("accepts the named glyph $name ($hex)", ({ codePoint }) => {
    expect(isSingleCellCodePoint(codePoint)).toBe(true)
  })

  it.each([
    ["a tab", 0x09],
    ["a C0 control", 0x1f],
    ["a DEL control", 0x7f],
    ["an East Asian ambiguous character", 0x00b1], // ±
    ["a wide character the rows paint", 0x4e16], // 世
    ["a wide kana", 0x3042], // あ
    ["a wide emoji", 0x1f600], // 😀
    ["an unmapped box drawing glyph", 0x2501], // ━ — plausible, not measured by any row
  ])("refuses %s, which is not a named single-cell glyph", (_name, codePoint) => {
    expect(isSingleCellCodePoint(Number(codePoint))).toBe(false)
  })
})

describe("mapSnapshotToCells — exact, or padded-and-named, never guessed", () => {
  it("maps a snapshot that fits the measured grid exactly, padding nothing and dropping nothing", () => {
    expect(mapSnapshotToCells(["abc", "def"], 3, 2, 0)).toEqual({
      cols: 3,
      rows: 2,
      text: ["abc", "def"],
      paddedRows: [],
      droppedLines: 0,
    })
  })

  it("carries the dropped scrollback count it was given", () => {
    expect(mapSnapshotToCells(["ab"], 2, 1, 7)).toEqual({
      cols: 2,
      rows: 1,
      text: ["ab"],
      paddedRows: [],
      droppedLines: 7,
    })
  })

  it("refuses a wrapped line by name, because the row boundary is unknown", () => {
    const mapped = mapSnapshotToCells(["abcd", "def"], 3, 2, 0)
    expect(mapped).toMatch(/row 1 is 4 characters over 3 columns/u)
    expect(mapped).toMatch(/wrapped/u)
  })

  // One fixture per refused class: each of these would otherwise pad into a confident wrong row.
  it.each([
    ["a combining mark", "e\u0301x", /U\+0301/u],
    ["a wide symbol", "\u2705ab", /U\+2705/u],
    ["a wide emoji", "\u{1F680}ab", /U\+1F680/u],
    ["an East Asian ambiguous character", "\u00b1ab", /U\+00B1/u],
    ["a tab", "a\tb", /U\+0009/u],
    ["a replacement character", "\ufffdab", /U\+FFFD/u],
  ])("refuses %s by naming its code point", (_name, row, pattern) => {
    const mapped = mapSnapshotToCells([String(row)], 3, 1, 0)
    expect(mapped).toMatch(pattern)
    expect(mapped).toMatch(/not printable ASCII or one of the named single-cell glyphs/u)
  })

  // 30098 specimen: Terminal.app and iTerm2 return DEC Special Graphics as drawn, so the charset
  // rows' cells map exactly once those glyphs are named.
  it("maps a charset row's drawn glyphs exactly, padding nothing", () => {
    expect(mapSnapshotToCells(["q\u2500q"], 3, 1, 0)).toEqual({
      cols: 3,
      rows: 1,
      text: ["q\u2500q"],
      paddedRows: [],
      droppedLines: 0,
    })
  })

  it("pads a trimmed row back to the measured width and names it as padded", () => {
    expect(mapSnapshotToCells(["ab"], 3, 1, 0)).toEqual({
      cols: 3,
      rows: 1,
      text: ["ab "],
      paddedRows: [1],
      droppedLines: 0,
    })
  })

  it("leaves a row that already reaches the measured width untouched", () => {
    expect(mapSnapshotToCells(["ab", "abcd"], 4, 2, 0)).toEqual({
      cols: 4,
      rows: 2,
      text: ["ab  ", "abcd"],
      paddedRows: [1],
      droppedLines: 0,
    })
  })

  it("maps an empty last row to blanks, which is what it is", () => {
    expect(mapSnapshotToCells(["ab", ""], 3, 2, 0)).toEqual({
      cols: 3,
      rows: 2,
      text: ["ab ", "   "],
      paddedRows: [1, 2],
      droppedLines: 0,
    })
  })

  it("refuses a snapshot whose line count is not the screen's row count", () => {
    expect(mapSnapshotToCells(["abc"], 3, 2, 0)).toMatch(/1 rows where the measured screen has 2/u)
  })

  it("refuses a dropped-line count that is not a count", () => {
    expect(mapSnapshotToCells(["ab"], 2, 1, -1)).toMatch(/dropped-line count is not a count: -1/u)
  })

  it("refuses a missing dropped-line count instead of reading it as zero", () => {
    // The count is required: a read that did not say what it left above the screen would otherwise
    // report "dropped nothing" through a default nobody measured.
    expect(mapSnapshotToCells(["ab"], 2, 1, undefined as unknown as number)).toMatch(
      /dropped-line count is not a count: undefined/u,
    )
  })

  it("refuses a geometry that is not a size", () => {
    expect(mapSnapshotToCells(["ab"], 0, 1, 0)).toMatch(/not a size: 0x1/u)
  })
})

describe("osascriptReply — one mapping for every way the child can end", () => {
  it("passes a normal reply through", () => {
    expect(osascriptReply({ stdout: "out", stderr: "", status: 0, signal: null })).toEqual({
      stdout: "out",
      stderr: "",
      status: 0,
      signal: null,
      timedOut: false,
    })
  })

  it("treats a signal with no error as a timeout, because a killed child never answered", () => {
    const mapped = osascriptReply({ status: null, signal: "SIGKILL" })
    expect(mapped.timedOut).toBe(true)
    expect(mapped.signal).toBe("SIGKILL")
  })

  it("treats the timeout signal as a timeout", () => {
    const mapped = osascriptReply({
      status: null,
      signal: "SIGKILL",
      error: Object.assign(new Error("killed"), { code: "ETIMEDOUT" }),
    })
    expect(mapped.timedOut).toBe(true)
    expect(mapped.error?.code).toBe("ETIMEDOUT")
  })

  it("carries a spawn error with its code and message and does not call it a timeout", () => {
    const mapped = osascriptReply({
      status: null,
      error: Object.assign(new Error("spawn /usr/bin/osascript ENOENT"), { code: "ENOENT" }),
    })
    expect(mapped.timedOut).toBe(false)
    expect(mapped.error).toEqual({ code: "ENOENT", message: "spawn /usr/bin/osascript ENOENT" })
  })
})

describe("classifyOsascriptFailure — each failure needs a different fix", () => {
  it("names an Automation (TCC) denial instead of reporting a script failure", () => {
    const reason = classifyOsascriptFailure(
      reply({ status: 1, stderr: "execution error: Not authorized to send Apple events to Terminal. (-1743)" }),
      "terminal-app",
    )
    expect(reason).toMatch(/TCC/u)
    expect(reason).toContain("Terminal.app")
  })

  it("names a timeout as a read that did not finish, not as a refusal of the terminal", () => {
    expect(classifyOsascriptFailure(reply({ timedOut: true, status: null }), "iterm2")).toMatch(
      /iTerm2 did not answer the text read before its timeout/u,
    )
  })

  it("names the signal that killed the read, so a crash does not read as a timeout", () => {
    expect(classifyOsascriptFailure(reply({ status: null, signal: "SIGKILL", timedOut: true }), "iterm2")).toMatch(
      /iTerm2 did not answer the text read \(killed by SIGKILL\)/u,
    )
  })

  it("names a child that never started before anything the terminal did", () => {
    const reason = classifyOsascriptFailure(
      reply({ status: null, error: { code: "ENOENT", message: "spawn /usr/bin/osascript ENOENT" } }),
      "iterm2",
    )
    expect(reason).toMatch(/could not be read: ENOENT: spawn \/usr\/bin\/osascript ENOENT/u)
  })

  it("carries the terminal's own words when it refuses for another reason", () => {
    expect(classifyOsascriptFailure(reply({ status: 1, stderr: "some other failure" }), "iterm2")).toContain(
      "some other failure",
    )
  })
})

describe("readTerminalTextSnapshot — one path, refusals with reasons", () => {
  const base = { app: "iterm2" as const, tty: "/dev/ttys007", cols: 3, rows: 1 }

  it("reads the snapshot the terminal returned", () => {
    const read = readTerminalTextSnapshot({
      ...base,
      run: () =>
        reply({
          stdout: JSON.stringify({ status: "read", lines: ["abc"], droppedLines: 0, appCols: 3, appRows: 1 }),
        }),
    })
    expect(read).toEqual({
      status: "read",
      app: "iterm2",
      cells: { cols: 3, rows: 1, text: ["abc"], paddedRows: [], droppedLines: 0 },
    })
  })

  it("reads a blank screen as blanks rather than as a read that failed", () => {
    const read = readTerminalTextSnapshot({
      ...base,
      rows: 2,
      run: () =>
        reply({
          stdout: JSON.stringify({ status: "read", lines: ["", ""], droppedLines: 0, appCols: 3, appRows: 2 }),
        }),
    })
    expect(read).toEqual({
      status: "read",
      app: "iterm2",
      cells: { cols: 3, rows: 2, text: ["   ", "   "], paddedRows: [1, 2], droppedLines: 0 },
    })
  })

  it("runs its own generated script against the app's object model end to end", () => {
    const session = itermSession({ contents: () => "scrolled away\nscroll\naaa\n", columns: () => 6 })
    const read = readTerminalTextSnapshot({
      ...base,
      cols: 6,
      rows: 2,
      run: (script) => {
        const result = runGenerated(script, fakeApplication({ windows: [{ tabs: [{ sessions: [session] }] }] }))
        return reply({ stdout: JSON.stringify(result) })
      },
    })
    expect(read).toEqual({
      status: "read",
      app: "iterm2",
      cells: { cols: 6, rows: 2, text: ["scroll", "aaa   "], paddedRows: [2], droppedLines: 1 },
    })
  })

  it("refuses a snapshot from an app grid that is not the measured one", () => {
    const read = readTerminalTextSnapshot({
      ...base,
      run: () =>
        reply({ stdout: JSON.stringify({ status: "read", lines: ["abc"], droppedLines: 0, appCols: 4, appRows: 1 }) }),
    })
    expect(read.status).toBe("refused")
    if (read.status === "refused") expect(read.reason).toMatch(/reports 1x4 where the measured grid is 1x3/u)
  })

  // One row per field: the refusal has four clauses, and a fixture that omits three of them at once
  // would pin only "at least one is missing" while any single clause could be deleted.
  it.each([
    ["rows", { status: "read", lines: null, droppedLines: 0, appCols: 3, appRows: 1 }],
    ["its own grid columns", { status: "read", lines: ["abc"], droppedLines: 0, appRows: 1 }],
    ["its own grid rows", { status: "read", lines: ["abc"], droppedLines: 0, appCols: 3 }],
    ["the number of rows it dropped", { status: "read", lines: ["abc"], appCols: 3, appRows: 1 }],
  ])("refuses a snapshot that does not say %s", (_field, payload) => {
    const read = readTerminalTextSnapshot({ ...base, run: () => reply({ stdout: JSON.stringify(payload) }) })
    expect(read.status).toBe("refused")
    if (read.status === "refused") {
      expect(read.reason).toMatch(/without its rows, its own grid and the number of rows it dropped/u)
    }
  })

  it("passes a refusal the terminal made straight through, as a refusal with its reason", () => {
    const read = readTerminalTextSnapshot({
      ...base,
      run: () => reply({ stdout: JSON.stringify({ status: "refused", reason: "iTerm2 is not frontmost" }) }),
    })
    expect(read).toEqual({ status: "refused", reason: "iTerm2 is not frontmost" })
  })

  it("refuses with the TCC reason when osascript reports the denial on stderr", () => {
    const read = readTerminalTextSnapshot({
      ...base,
      run: () =>
        reply({ status: 1, stderr: "execution error: Not authorized to send Apple events to iTerm2. (-1743)" }),
    })
    expect(read).toEqual({ status: "refused", reason: automationDeniedReason("iterm2") })
  })

  it("refuses with the TCC reason when the app raises the denial inside the script", () => {
    const read = readTerminalTextSnapshot({
      ...base,
      run: () =>
        reply({
          stdout: JSON.stringify({
            status: "refused",
            reason: "raised while reading: Not authorized to send Apple events.",
            errorNumber: -1743,
          }),
        }),
    })
    expect(read).toEqual({ status: "refused", reason: automationDeniedReason("iterm2") })
  })

  it("passes a raise that is not a denial through with the app's own words", () => {
    const read = readTerminalTextSnapshot({
      ...base,
      run: () =>
        reply({
          stdout: JSON.stringify({
            status: "refused",
            reason: "raised while reading: window closed",
            errorNumber: -1728,
          }),
        }),
    })
    expect(read).toEqual({ status: "refused", reason: "raised while reading: window closed" })
  })

  it("refuses when the terminal answers with something that is not a snapshot", () => {
    const read = readTerminalTextSnapshot({ ...base, run: () => reply({ stdout: "not json" }) })
    expect(read.status).toBe("refused")
  })

  it("refuses a JSON answer that carries no status at all", () => {
    const read = readTerminalTextSnapshot({ ...base, run: () => reply({ stdout: JSON.stringify({ lines: ["abc"] }) }) })
    expect(read).toEqual({ status: "refused", reason: "iTerm2 returned no status in its snapshot" })
  })

  it("refuses a status it does not recognise instead of reading it as an empty screen", () => {
    const read = readTerminalTextSnapshot({
      ...base,
      run: () => reply({ stdout: JSON.stringify({ status: "error", lines: ["abc"] }) }),
    })
    expect(read).toEqual({ status: "refused", reason: "iTerm2 returned an unrecognised snapshot" })
  })

  it("passes the mapping's own refusal through, so the row that could not be placed is named", () => {
    const read = readTerminalTextSnapshot({
      ...base,
      run: () =>
        reply({
          stdout: JSON.stringify({ status: "read", lines: ["abcdef"], droppedLines: 0, appCols: 3, appRows: 1 }),
        }),
    })
    expect(read.status).toBe("refused")
    if (read.status === "refused") expect(read.reason).toMatch(/row 1 is 6 characters over 3 columns/u)
  })
})
