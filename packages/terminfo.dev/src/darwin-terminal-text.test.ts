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
  mapITermBufferToCells,
  NAMED_SINGLE_CELL_GLYPHS,
  osascriptReply,
  readTerminalAppHistory,
  readTerminalTextSnapshot,
  terminalAppHistoryReader,
  terminalTextScript,
  type OsascriptReply,
  type TerminalHistoryControl,
} from "./darwin-terminal-text.ts"
import { ScrollbackReadingUnavailable } from "@terminfo/probe-defs"

const ascii = (length: number, character = "x"): string => character.repeat(length)

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
  diagnostic?: unknown
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

  // 33512: run 42939520969 refused Terminal.app's 29 rows on a 30-row screen with nothing retained,
  // so whether the missing row was a wrapped logical line could not be read. The refusal keeps what
  // the app returned and each line's length; the equality check and its refusal are unchanged.
  it("refuses a short Terminal.app screen and carries the lines it returned with their lengths", () => {
    const script = terminalTextScript("terminal-app", "/dev/ttys003", 4, 3)
    const result = runGenerated(
      script,
      fakeApplication({
        windows: [{ tabs: [terminalTab({ contents: () => "abcdef\ncd\n", numberOfRows: () => 3 })] }],
      }),
    )
    expect(result.status).toBe("refused")
    expect(result.reason).toMatch(/returned 2 rows where the measured screen has 3/u)
    expect(result.diagnostic).toEqual({
      contents: "abcdef\ncd\n",
      tty: "/dev/ttys003",
      appCols: 4,
      appRows: 3,
      splitRows: 3,
      terminatorRemoved: true,
      rowsAfterPop: 2,
      lineLengths: [6, 2],
    })
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

describe("iTerm2 physical buffer mapping", () => {
  // api.proto LineContents is a physical row, including soft continuations. This is a protocol
  // contract fixture, not a claim that a hosted app returned these bytes.
  it("keeps physical soft-wrap/blank rows and names omitted or explicit trailing blanks", () => {
    // GHA 42490280120, iTerm2 3.6.11 buffer 616bf541: Q has one mapped/styled cell;
    // its blank rows have neither. Written spaces remain cells, unlike omitted trailing nulls.
    expect(
      mapITermBufferToCells(
        [
          {
            text: "Q",
            code_points_per_cell: [{ num_code_points: 1, repeats: 1 }],
            continuation: 1,
            style: [{ image: 0, repeats: 1 }],
          },
          { text: "", code_points_per_cell: [], continuation: 1, style: [] },
          { text: " ".repeat(80), code_points_per_cell: [{ repeats: 80 }], style: [{ repeats: 80 }] },
        ],
        80,
        3,
      ),
    ).toEqual({
      cols: 80,
      rows: 3,
      text: ["Q" + " ".repeat(79), " ".repeat(80), " ".repeat(80)],
      paddedRows: [1, 2],
      droppedLines: 0,
    })
    expect(
      mapITermBufferToCells(
        [
          { text: "abcd", code_points_per_cell: [{ repeats: 4 }], continuation: 2, style: [{ repeats: 4 }] },
          {
            text: "ef",
            code_points_per_cell: [
              { num_code_points: 1, repeats: 2 },
              { num_code_points: 0, repeats: 1 },
            ],
            continuation: 1,
            style: [{ repeats: 3 }],
          },
          { text: "", code_points_per_cell: [], style: [] },
        ],
        4,
        3,
      ),
    ).toEqual({ cols: 4, rows: 3, text: ["abcd", "ef  ", "    "], paddedRows: [2, 3], droppedLines: 0 })
  })

  it.each([
    {
      name: "interior uninitialized cell",
      line: {
        text: "ab",
        code_points_per_cell: [{ repeats: 1 }, { num_code_points: 0, repeats: 1 }, { repeats: 1 }],
        style: [{ repeats: 4 }],
      },
      reason: /interior uninitialized cell/u,
    },
    {
      name: "unconsumed code points",
      line: { text: "ab", code_points_per_cell: [{ repeats: 1 }], style: [{ repeats: 4 }] },
      reason: /code.point consumption/u,
    },
    {
      name: "map beyond physical columns",
      line: { text: "abcde", code_points_per_cell: [{ repeats: 5 }], style: [{ repeats: 4 }] },
      reason: /map.*columns/u,
    },
    {
      name: "missing repeat count",
      line: { text: "a", code_points_per_cell: [{}], style: [{ repeats: 4 }] },
      reason: /repeat/u,
    },
    {
      name: "multiple code points in one cell",
      line: { text: "a\u0301", code_points_per_cell: [{ num_code_points: 2, repeats: 1 }], style: [{ repeats: 4 }] },
      reason: /code points per cell/u,
    },
    {
      name: "omitted image cells",
      line: { text: "", code_points_per_cell: [], style: [{ repeats: 4, image: 1 }] },
      reason: /image/u,
    },
    {
      name: "unproved image-free trailing cells",
      line: { text: "a", code_points_per_cell: [{ repeats: 1 }], style: [] },
      reason: /style.*coverage/u,
    },
    {
      name: "styles longer than the returned cell map",
      line: { text: "a", code_points_per_cell: [{ repeats: 1 }], style: [{ repeats: 4 }] },
      reason: /style.*cell map has 1/u,
    },
    {
      name: "styles beyond physical columns",
      line: { text: "abcd", code_points_per_cell: [{ repeats: 4 }], style: [{ repeats: 5 }] },
      reason: /style coverage exceeds 4 columns/u,
    },
  ])("refuses $name without reconstructing its cells", ({ line, reason }) => {
    expect(mapITermBufferToCells([line], 4, 1)).toMatch(reason)
  })

  it("requires the complete measured row count", () => {
    expect(mapITermBufferToCells([], 4, 1)).toMatch(/0 rows.*1/u)
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

  // 33512: the short-screen refusal is the one a reader has to explain, so its diagnostic is typed
  // here — and the reply's raw screen text is NOT one of the fields that travels (30729 AC3b).
  it("carries the reply's diagnostic as a typed record and never its raw contents", () => {
    const read = readTerminalTextSnapshot({
      ...base,
      run: () =>
        reply({
          stdout: JSON.stringify({
            status: "refused",
            reason: "iTerm2 returned 0 rows where the measured screen has 1",
            diagnostic: {
              contents: "raw-screen-text-no-reader-may-see",
              tty: "/dev/ttys007",
              appCols: 3,
              appRows: 1,
              splitRows: 2,
              terminatorRemoved: true,
              rowsAfterPop: 0,
              lineLengths: [3],
            },
          }),
        }),
    })
    expect(read).toEqual({
      status: "refused",
      reason:
        "iTerm2 returned 0 rows where the measured screen has 1, and its 1 logical lines are 11 rows where the measured screen has 1",
      diagnostic: {
        tty: "/dev/ttys007",
        appCols: 3,
        appRows: 1,
        splitRows: 2,
        terminatorRemoved: true,
        rowsAfterPop: 0,
        lineLengths: [3],
        lineLengthsTruncated: false,
      },
    })
    expect(JSON.stringify(read)).not.toContain("raw-screen-text-no-reader-may-see")
  })

  // 30729 AC3b: Terminal.app's contents() returns LOGICAL lines, so a 30-row screen can report 29.
  // Where every line is a whole number of rows and they add up to the measured screen, the rows are
  // rebuilt through the one splitter; the reply's text still never reaches the record.
  it("rebuilds a short screen from logical lines that wrapped, instead of refusing it", () => {
    const read = readTerminalTextSnapshot({
      app: "terminal-app",
      tty: "/dev/ttys003",
      cols: 120,
      rows: 2,
      run: () =>
        reply({
          stdout: JSON.stringify({
            status: "refused",
            reason: "Terminal.app returned 1 rows where the measured screen has 2",
            diagnostic: {
              contents: `${ascii(120, "a")}${ascii(120, "b")}\n`,
              tty: "/dev/ttys003",
              appCols: 120,
              appRows: 2,
              splitRows: 2,
              terminatorRemoved: true,
              rowsAfterPop: 1,
              lineLengths: [240],
            },
          }),
        }),
    })
    expect(read).toEqual({
      status: "read",
      app: "terminal-app",
      cells: {
        cols: 120,
        rows: 2,
        text: [ascii(120, "a"), ascii(120, "b")],
        paddedRows: [],
        droppedLines: 0,
        splitLineCount: 1,
      },
    })
    expect(JSON.stringify(read)).not.toContain(ascii(240, "a"))
  })

  it("keeps the short-screen refusal, with the split's own reason, where a line cannot be split", () => {
    const read = readTerminalTextSnapshot({
      app: "terminal-app",
      tty: "/dev/ttys003",
      cols: 120,
      rows: 2,
      run: () =>
        reply({
          stdout: JSON.stringify({
            status: "refused",
            reason: "Terminal.app returned 1 rows where the measured screen has 2",
            diagnostic: {
              contents: `${ascii(121)}\n`,
              tty: "/dev/ttys003",
              appCols: 120,
              appRows: 2,
              splitRows: 2,
              terminatorRemoved: true,
              rowsAfterPop: 1,
              lineLengths: [121],
            },
          }),
        }),
    })
    expect(read.status).toBe("refused")
    if (read.status === "refused") {
      expect(read.reason).toMatch(
        /returned 1 rows where the measured screen has 2, and line 1 is 121 cells over 120 columns/u,
      )
      expect(read.diagnostic?.lineLengths).toEqual([121])
    }
    expect(JSON.stringify(read)).not.toContain(ascii(121))
  })

  // @dev/15's revise on 4b48cfd7e: a split is measured at the app's column count, so it may only
  // run where the reply stated a grid and that grid IS the measured one. Neither arm may assume it.
  it("does not split a reply whose diagnostic this read could not type, so no grid is assumed", () => {
    const read = readTerminalTextSnapshot({
      app: "terminal-app",
      tty: "/dev/ttys003",
      cols: 3,
      rows: 1,
      run: () =>
        reply({
          stdout: JSON.stringify({
            status: "refused",
            reason: "Terminal.app returned 1 rows where the measured screen has 1",
            diagnostic: { contents: "abcdef\n", tty: "/dev/ttys003", appCols: 3, appRows: 1 },
          }),
        }),
    })
    expect(read).toEqual({
      status: "refused",
      reason: "Terminal.app returned 1 rows where the measured screen has 1",
      diagnosticDropped: 1,
    })
  })

  it("refuses an app grid that is not the measured one instead of splitting at the measured width", () => {
    const read = readTerminalTextSnapshot({
      app: "terminal-app",
      tty: "/dev/ttys003",
      cols: 3,
      rows: 1,
      run: () =>
        reply({
          stdout: JSON.stringify({
            status: "refused",
            reason: "Terminal.app returned 1 rows where the measured screen has 1",
            diagnostic: {
              contents: "abcabc\n",
              tty: "/dev/ttys003",
              appCols: 6,
              appRows: 1,
              splitRows: 2,
              terminatorRemoved: true,
              rowsAfterPop: 1,
              lineLengths: [6],
            },
          }),
        }),
    })
    expect(read.status).toBe("refused")
    if (read.status === "refused") {
      expect(read.reason).toMatch(
        /returned 1 rows where the measured screen has 1, and Terminal.app reports 1x6 where the measured grid is 1x3, so its lines are not the measured screen/u,
      )
    }
    expect(JSON.stringify(read)).not.toContain("abcabc")
  })

  // A partial record would read as a measured zero, so the whole diagnostic is dropped and the drop
  // is counted: a missing field is never filled in.
  it.each([
    [
      "the rows it left after popping the terminator",
      { tty: "/dev/ttys007", appCols: 3, appRows: 1, splitRows: 2, terminatorRemoved: true, lineLengths: [3] },
    ],
    [
      "a length that is not a count",
      {
        tty: "/dev/ttys007",
        appCols: 3,
        appRows: 1,
        splitRows: 2,
        terminatorRemoved: true,
        rowsAfterPop: 0,
        lineLengths: ["3"],
      },
    ],
    [
      "the terminator flag",
      { tty: "/dev/ttys007", appCols: 3, appRows: 1, splitRows: 2, rowsAfterPop: 0, lineLengths: [3] },
    ],
  ])("drops a diagnostic without %s and counts the drop", (_missing, diagnostic) => {
    const read = readTerminalTextSnapshot({
      ...base,
      run: () => reply({ stdout: JSON.stringify({ status: "refused", reason: "short screen", diagnostic }) }),
    })
    expect(read).toEqual({ status: "refused", reason: "short screen", diagnosticDropped: 1 })
  })

  it("bounds the line lengths it keeps to the measured screen and says it truncated them", () => {
    const read = readTerminalTextSnapshot({
      ...base,
      run: () =>
        reply({
          stdout: JSON.stringify({
            status: "refused",
            reason: "iTerm2 returned 0 rows where the measured screen has 1",
            diagnostic: {
              tty: "/dev/ttys007",
              appCols: 3,
              appRows: 1,
              splitRows: 10,
              terminatorRemoved: true,
              rowsAfterPop: 9,
              lineLengths: [1, 2, 3, 4, 5, 6, 7, 8, 9],
            },
          }),
        }),
    })
    expect(read.status).toBe("refused")
    if (read.status === "refused") {
      expect(read.diagnostic?.lineLengths).toEqual([1, 2, 3, 4, 5])
      expect(read.diagnostic?.lineLengthsTruncated).toBe(true)
    }
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

/**
 * A Terminal.app tab that processes the reader's own writes: a clear empties the screen, and each
 * CRLF-terminated line lands on the next row, scrolling the top row into history at the bottom. Its
 * contents() is the padded screen and its history() the retained lines through the padded screen,
 * so the real generated JXA, the reply parser and the control all run against it (31741).
 */
function terminalModel(rows: number, cols: number, options: { loseEvery?: number } = {}) {
  const scrollback: string[] = []
  let screen: string[] = []
  let written = 0
  const padded = () => [...screen, ...Array.from({ length: rows - screen.length }, () => "")]
  const write = (text: string) => {
    if (text.includes("\x1b[2J")) screen = []
    for (const line of text
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
      .split("\r\n")
      .slice(0, -1)) {
      written++
      if (options.loseEvery !== undefined && written % options.loseEvery === 0) continue
      screen.push(line)
      if (screen.length === rows) scrollback.push(screen.shift()!)
    }
  }
  const tab: Record<string, unknown> = {
    tty: () => "/dev/ttys003",
    contents: () => `${padded().join("\n")}\n`,
    history: () => `${[...scrollback, ...padded()].join("\n")}\n`,
    numberOfRows: () => rows,
    numberOfColumns: () => cols,
  }
  const run = (script: string): OsascriptReply =>
    reply({
      stdout: String(
        runInNewContext(`${script}\nrun()`, { Application: () => fakeApplication({ windows: [{ tabs: [tab] }] }) }),
      ),
    })
  return { write, run, scrollback, tab }
}

describe("Terminal.app history: one snapshot, one count definition, and a per-run control (31741)", () => {
  it("reads contents and history in the same script, and only Terminal.app is asked for history", () => {
    const script = terminalTextScript("terminal-app", "/dev/ttys003", 4, 2, true)
    expect(script.match(/match\.contents\(\)/g)).toHaveLength(1)
    expect(script.match(/match\.history\(\)/g)).toHaveLength(1)
    expect(terminalTextScript("terminal-app", "/dev/ttys003", 4, 2)).not.toContain("history()")
    expect(() => terminalTextScript("iterm2", "/dev/ttys007", 4, 2, true)).toThrow(/Only Terminal.app/)
  })

  it("counts retained lines above the screen plus the screen's rows; an empty history reads exactly rows", () => {
    const model = terminalModel(4, 20)
    const empty = readTerminalAppHistory({ tty: "/dev/ttys003", cols: 20, rows: 4, run: model.run })
    expect(empty).toEqual({ status: "read", historyLines: [], reading: { totalLines: 4, screenLines: 4 } })
    model.write("a\r\nb\r\nc\r\nd\r\ne\r\n")
    const read = readTerminalAppHistory({ tty: "/dev/ttys003", cols: 20, rows: 4, run: model.run })
    // a and b scrolled off; c, d, e are on screen above the blank cursor row.
    expect(read).toEqual({
      status: "read",
      historyLines: ["a", "b", "c", "d", "e"],
      reading: { totalLines: 2 + 4, screenLines: 4 },
    })
  })

  // 30729: a wrapped history line is split by the same splitter the screen read uses, so history
  // lines stay rows for both readers rather than each keeping its own rule.
  it("splits a wrapped history line with the screen read's own splitter", () => {
    const model = terminalModel(4, 20)
    model.write(`${"x".repeat(40)}\r\n`)
    const read = readTerminalAppHistory({ tty: "/dev/ttys003", cols: 20, rows: 4, run: model.run })
    // 40 cells on 20 columns fills two of the screen's four rows; the count is still the screen's.
    expect(read).toEqual({
      status: "read",
      historyLines: ["x".repeat(40)],
      reading: { totalLines: 4, screenLines: 4 },
    })
  })

  it.each([
    ["a wrapped line", { history: (): string => `${"x".repeat(21)}\n\n\n\n\n` }, /21 characters on a 20-column grid/],
    [
      "history not ending with the screen",
      { history: (): string => "a\nb\n", contents: (): string => "c\n\n\n\n" },
      /does not end with the screen/,
    ],
    ["a tab that raises on history()", { history: undefined }, /raised while reading: .*history/],
  ] as const)("refuses %s, so it gives no reading", (_name, overrides, reason) => {
    const model = terminalModel(4, 20)
    Object.assign(model.tab, overrides)
    if (overrides.history === undefined) delete model.tab.history
    const read = readTerminalAppHistory({ tty: "/dev/ttys003", cols: 20, rows: 4, run: model.run })
    expect(read.status).toBe("refused")
    expect(read.status === "refused" && read.reason).toMatch(reason)
  })

  it("a timed-out script is no reading, never zero lines", () => {
    const read = readTerminalAppHistory({
      tty: "/dev/ttys003",
      cols: 20,
      rows: 4,
      run: () => reply({ status: null, signal: "SIGTERM", timedOut: true }),
    })
    expect(read.status).toBe("refused")
  })

  it("proves itself once per run, then reads; the control's numbers are retained", async () => {
    const model = terminalModel(6, 40)
    const controls: TerminalHistoryControl[] = []
    const reader = terminalAppHistoryReader({
      read: () => readTerminalAppHistory({ tty: "/dev/ttys003", cols: 40, rows: 6, run: model.run }),
      write: model.write,
      rows: 6,
      nonce: "run-1",
      pollMs: 1,
      onControl: (control) => controls.push(control),
    })
    const first = await reader()
    expect(controls).toEqual([{ markers: 11, before: 0, after: 11, status: "passed" }])
    expect(model.scrollback.at(0)).toBe("terminfo history control run-1 0")
    // 11 markers on 6 rows: 6 scrolled into history, then the control cleared the 5 on screen.
    expect(first).toEqual({ totalLines: 6 + 6, screenLines: 6 })
    model.write(Array.from({ length: 16 }, (_unused, index) => `line ${index}\r\n`).join(""))
    const second = await reader()
    expect(second.totalLines - first.totalLines).toBe(16 - 5)
    expect(controls).toHaveLength(1)
  })

  it("a control whose markers do not all land is no reading, by name, for every later call", async () => {
    const model = terminalModel(6, 40, { loseEvery: 7 })
    const controls: TerminalHistoryControl[] = []
    const reader = terminalAppHistoryReader({
      read: () => readTerminalAppHistory({ tty: "/dev/ttys003", cols: 40, rows: 6, run: model.run }),
      write: model.write,
      rows: 6,
      nonce: "run-2",
      timeoutMs: 20,
      pollMs: 1,
      onControl: (control) => controls.push(control),
    })
    await expect(reader()).rejects.toThrow(ScrollbackReadingUnavailable)
    await expect(reader()).rejects.toThrow("the control wrote 11 marker lines and the history grew by 10")
    expect(controls).toEqual([
      {
        markers: 11,
        before: 0,
        after: 10,
        status: "failed",
        reason: "the control wrote 11 marker lines and the history grew by 10",
      },
    ])
  })
})
