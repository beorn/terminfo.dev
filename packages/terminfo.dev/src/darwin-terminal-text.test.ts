/**
 * @failure The macOS app arms read class-A rows without a cell readback, and a readback that walked
 *   an iTerm2 window for sessions it does not expose, mapped scrollback or a soft-wrapped line onto
 *   the screen, padded a row containing a character whose width it cannot name, or trusted a grid
 *   other than the measured one would decide those rows on a snapshot nobody could place on the grid.
 * @level l1
 * @consumer readTerminalTextSnapshot, the macOS half of the hosted-arm cell readback.
 * @testonly none
 */
import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import {
  classifyOsascriptFailure,
  isPrintableAsciiCell,
  mapSnapshotToCells,
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

const fakeApplication = (app: {
  running?: boolean
  frontmost?: boolean
  windows: readonly FakeWindow[]
}): unknown => ({
  running: () => app.running ?? true,
  frontmost: () => app.frontmost ?? true,
  windows: app.windows,
})

interface ScriptReply {
  status: string
  reason?: string
  text?: string
  droppedLines?: number
  appCols?: number
  appRows?: number
}

const runGenerated = (script: string, application: unknown): ScriptReply =>
  JSON.parse(String(runInNewContext(`${script}\nrun()`, { Application: () => application }))) as ScriptReply

describe("terminalTextScript — the walk each app's object model actually exposes", () => {
  it("reads Terminal.app's owned tab and returns its text, its grid and a dropped count of zero", () => {
    const script = terminalTextScript("terminal-app", "/dev/ttys003", 4, 2)
    expect(runGenerated(script, fakeApplication({ windows: [{ tabs: [terminalTab()] }] }))).toEqual({
      status: "read",
      text: "ab\ncd",
      droppedLines: 0,
      appCols: 4,
      appRows: 2,
    })
  })

  it("walks iTerm2 windows, then tabs, then sessions, and keeps only the last measured rows", () => {
    const session = itermSession({ contents: () => "scroll1\nscroll2\nnew1\nnew2\n" })
    const script = terminalTextScript("iterm2", "/dev/ttys007", 4, 2)
    const result = runGenerated(
      script,
      fakeApplication({ windows: [{ tabs: [{ sessions: [session] }] }] }),
    )
    expect(result.status).toBe("read")
    expect(result.text).toBe("new1\nnew2")
    expect(result.droppedLines).toBe(2)
    expect(result.appCols).toBe(4)
    expect(result.appRows).toBe(2)
  })

  it("finds the owned session in a later window and skips the tabs of other windows", () => {
    const other = terminalTab({ tty: () => "/dev/ttys001" })
    const script = terminalTextScript("terminal-app", "/dev/ttys003", 4, 2)
    const result = runGenerated(script, fakeApplication({ windows: [{ tabs: [other] }, { tabs: [terminalTab()] }] }))
    expect(result.status).toBe("read")
    expect(result.text).toBe("ab\ncd")
  })

  it("refuses when no tab or session is on the owned TTY", () => {
    const script = terminalTextScript("terminal-app", "/dev/ttys003", 4, 2)
    const result = runGenerated(script, fakeApplication({ windows: [{ tabs: [terminalTab({ tty: () => "/dev/ttys001" })] }] }))
    expect(result.status).toBe("refused")
    expect(result.reason).toMatch(/Terminal\.app has no session on the owned TTY/u)
  })

  it("refuses when two sessions claim the owned TTY", () => {
    const script = terminalTextScript("iterm2", "/dev/ttys007", 4, 2)
    const result = runGenerated(
      script,
      fakeApplication({
        windows: [{ tabs: [{ sessions: [itermSession()] }] }, { tabs: [{ sessions: [itermSession()] }] }],
      }),
    )
    expect(result.status).toBe("refused")
    expect(result.reason).toMatch(/more than one session on the owned TTY/u)
  })

  it("refuses a terminal that is not frontmost", () => {
    const script = terminalTextScript("iterm2", "/dev/ttys007", 4, 2)
    const result = runGenerated(script, fakeApplication({ frontmost: false, windows: [] }))
    expect(result.status).toBe("refused")
    expect(result.reason).toMatch(/not frontmost/u)
  })

  it("refuses a terminal that is not running", () => {
    const result = runGenerated(terminalTextScript("iterm2", "/dev/ttys007", 4, 2), fakeApplication({ running: false, windows: [] }))
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
    expect(result.reason).toMatch(/returned 1 lines where the measured screen has 2 rows/u)
  })

  it("names an error the app raised instead of reporting it as a refusal of the read", () => {
    const session = itermSession({ contents: () => { throw new Error("window closed") } })
    const result = runGenerated(
      terminalTextScript("iterm2", "/dev/ttys007", 4, 2),
      fakeApplication({ windows: [{ tabs: [{ sessions: [session] }] }] }),
    )
    expect(result.status).toBe("refused")
    expect(result.reason).toMatch(/raised while reading: window closed/u)
  })
})

describe("isPrintableAsciiCell — one code point, one cell, or the mapping is refused", () => {
  it("accepts printable ASCII and nothing else", () => {
    expect(isPrintableAsciiCell(0x20)).toBe(true)
    expect(isPrintableAsciiCell(0x41)).toBe(true)
    expect(isPrintableAsciiCell(0x7e)).toBe(true)
    expect(isPrintableAsciiCell(0x09)).toBe(false) // tab
    expect(isPrintableAsciiCell(0x1f)).toBe(false)
    expect(isPrintableAsciiCell(0x7f)).toBe(false)
    expect(isPrintableAsciiCell(0x00e9)).toBe(false) // é
    expect(isPrintableAsciiCell(0x3042)).toBe(false) // あ
    expect(isPrintableAsciiCell(0x1f600)).toBe(false) // 😀
  })
})

describe("mapSnapshotToCells — exact, or padded-and-named, never guessed", () => {
  it("maps a snapshot that fits the measured grid exactly, padding nothing and dropping nothing", () => {
    expect(mapSnapshotToCells("abc\ndef\n", 3, 2)).toEqual({
      cols: 3,
      rows: 2,
      text: ["abc", "def"],
      paddedRows: [],
      droppedLines: 0,
    })
  })

  it("carries the dropped scrollback count it was given", () => {
    expect(mapSnapshotToCells("ab\n", 2, 1, 7)).toEqual({
      cols: 2,
      rows: 1,
      text: ["ab"],
      paddedRows: [],
      droppedLines: 7,
    })
  })

  it("refuses a wrapped line by name, because the row boundary is unknown", () => {
    const mapped = mapSnapshotToCells("abcd\ndef\n", 3, 2)
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
    const mapped = mapSnapshotToCells(String(row), 3, 1)
    expect(mapped).toMatch(pattern)
    expect(mapped).toMatch(/not printable ASCII/u)
  })

  it("pads a trimmed row back to the measured width and names it as padded", () => {
    expect(mapSnapshotToCells("ab\n", 3, 1)).toEqual({
      cols: 3,
      rows: 1,
      text: ["ab "],
      paddedRows: [1],
      droppedLines: 0,
    })
  })

  it("leaves a row that already reaches the measured width untouched", () => {
    expect(mapSnapshotToCells("ab\nabcd\n", 4, 2)).toEqual({
      cols: 4,
      rows: 2,
      text: ["ab  ", "abcd"],
      paddedRows: [1],
      droppedLines: 0,
    })
  })

  it("maps an empty last row to blanks, which is what it is", () => {
    expect(mapSnapshotToCells("ab\n\n", 3, 2)).toEqual({
      cols: 3,
      rows: 2,
      text: ["ab ", "   "],
      paddedRows: [1, 2],
      droppedLines: 0,
    })
  })

  it("refuses a snapshot whose line count is not the screen's row count", () => {
    expect(mapSnapshotToCells("abc\n", 3, 2)).toMatch(/1 lines where the measured screen has 2 rows/u)
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

  it("names a timeout as a stale snapshot, not as a refusal of the terminal", () => {
    expect(classifyOsascriptFailure(reply({ timedOut: true, status: null }), "iterm2")).toMatch(/timed out/u)
  })

  it("names a killed child as a timeout, because a read that was killed never answered", () => {
    expect(classifyOsascriptFailure(reply({ status: null, signal: "SIGKILL", timedOut: true }), "iterm2")).toMatch(
      /timed out/u,
    )
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
          stdout: JSON.stringify({ status: "read", text: "abc\n", droppedLines: 0, appCols: 3, appRows: 1 }),
        }),
    })
    expect(read).toEqual({
      status: "read",
      app: "iterm2",
      cells: { cols: 3, rows: 1, text: ["abc"], paddedRows: [], droppedLines: 0 },
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
        reply({ stdout: JSON.stringify({ status: "read", text: "abc\n", droppedLines: 0, appCols: 4, appRows: 1 }) }),
    })
    expect(read.status).toBe("refused")
    if (read.status === "refused") expect(read.reason).toMatch(/reports 1x4 where the measured grid is 1x3/u)
  })

  it("refuses a snapshot that does not say its grid or what it dropped", () => {
    const read = readTerminalTextSnapshot({
      ...base,
      run: () => reply({ stdout: JSON.stringify({ status: "read", text: "abc\n" }) }),
    })
    expect(read.status).toBe("refused")
    if (read.status === "refused") expect(read.reason).toMatch(/without its own grid and dropped-line count/u)
  })

  it("passes a refusal the terminal made straight through, as a refusal with its reason", () => {
    const read = readTerminalTextSnapshot({
      ...base,
      run: () => reply({ stdout: JSON.stringify({ status: "refused", reason: "iTerm2 is not frontmost" }) }),
    })
    expect(read).toEqual({ status: "refused", reason: "iTerm2 is not frontmost" })
  })

  it("refuses with the TCC reason when the script was denied", () => {
    const read = readTerminalTextSnapshot({
      ...base,
      run: () =>
        reply({ status: 1, stderr: "execution error: Not authorized to send Apple events to iTerm2. (-1743)" }),
    })
    expect(read.status).toBe("refused")
    if (read.status === "refused") expect(read.reason).toMatch(/TCC/u)
  })

  it("refuses when the terminal answers with something that is not a snapshot", () => {
    const read = readTerminalTextSnapshot({ ...base, run: () => reply({ stdout: "not json" }) })
    expect(read.status).toBe("refused")
  })
})
