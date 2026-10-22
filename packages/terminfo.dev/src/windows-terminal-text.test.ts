/**
 * @failure The Windows Terminal text read returns a confident wrong grid: a short, unsettled or
 *   unparseable UI Automation reply is mapped as the screen, a failed powershell.exe start reads as a
 *   terminal refusal, or a double-width line (which UI Automation returns unmarked) is mapped at half
 *   its width (#30720; spike run 39776473575).
 * @level l1
 * @consumer OwnedTerminal.readCells and consoleHostOwnership on the hosted Windows Terminal arm.
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import {
  SETTLE_GAP_MS,
  SETTLE_PAIRS,
  createLineRenditionTracker,
  readWindowsTerminalRows,
  readWindowsTerminalText,
  windowsTerminalTextScript,
  type PowerShellReply,
} from "./windows-terminal-text.ts"

const reply = (overrides: Partial<PowerShellReply>): PowerShellReply => ({
  stdout: "",
  stderr: "",
  status: 0,
  signal: null,
  timedOut: false,
  ...overrides,
})
const units = (rows: readonly string[], documentEnded = false) =>
  JSON.stringify({
    status: "read",
    documentEnded,
    rows: rows.map((row) => Array.from(row, (unit) => unit.charCodeAt(0))),
  })
const answer = (stdout: string) => () => reply({ stdout })

describe("windowsTerminalTextScript", () => {
  it("reads one TermControl of the named process, exactly rows units, settled by measured pairs", () => {
    const script = windowsTerminalTextScript(8856, 30)
    expect(script).toContain("$ownerPid = 8856")
    expect(script).toContain("$rows = 30")
    expect(script).toContain(`$gapMs = ${String(SETTLE_GAP_MS)}`)
    expect(script).toContain(`$pairs = ${String(SETTLE_PAIRS)}`)
    expect(script).toContain("'TermControl'")
    expect(script).toContain("while ($read.Count -lt $rows)")
    expect(script).toContain("$visible.CompareEndpoints($end, $document, $end)")
    expect(() => windowsTerminalTextScript(0, 30)).toThrow(/pid is not a count/u)
    expect(() => windowsTerminalTextScript(8856, 2.5)).toThrow(/rows is not a count/u)
  })
})

describe("readWindowsTerminalRows", () => {
  it("returns the raw rows, control characters included, exactly as the terminal reported them", () => {
    const rows = ["☺  ", "abc"]
    expect(readWindowsTerminalRows({ pid: 1, rows: 2, run: answer(units(rows)) })).toEqual({
      status: "read",
      rows,
      documentEnded: false,
    })
  })

  // AC2 run 39782783915: on a cleared screen WT's document ends below its last written row, so the visible
  // range held 2 rows of 30. Short is complete only at the document's end.
  it("accepts fewer rows only when the visible range stopped at the document's end", () => {
    expect(readWindowsTerminalRows({ pid: 1, rows: 3, run: answer(units(["ab "], true)) })).toEqual({
      status: "read",
      rows: ["ab "],
      documentEnded: true,
    })
    expect(readWindowsTerminalRows({ pid: 1, rows: 1, run: answer(units(["ab ", "cd "], true)) })).toEqual({
      status: "refused",
      reason: "UI Automation returned 2 rows where the measured screen has 1",
    })
  })

  it.each([
    [answer(units(["abc"])), "UI Automation returned 1 rows where the measured screen has 2"],
    [
      answer(JSON.stringify({ status: "refused", reason: "exposes 0 TermControl elements" })),
      "exposes 0 TermControl elements",
    ],
    [
      answer(JSON.stringify({ status: "read", documentEnded: false, rows: [[0x10000], [65]] })),
      "Windows Terminal returned an unrecognised snapshot",
    ],
    [
      answer(JSON.stringify({ status: "read", rows: [[65], [66]] })),
      "Windows Terminal returned an unrecognised snapshot",
    ],
    [answer("not json"), "Windows Terminal did not return a snapshot: not json"],
    [() => reply({ status: 1, stderr: "Add-Type failed" }), "powershell.exe exited 1: Add-Type failed"],
    [
      () => reply({ status: null, timedOut: true, signal: "SIGKILL" }),
      "Windows Terminal did not answer the UI Automation read (killed by SIGKILL)",
    ],
    [
      () => reply({ status: null, error: { code: "ENOENT", message: "spawnSync powershell.exe ENOENT" } }),
      "Windows Terminal could not be read: ENOENT: spawnSync powershell.exe ENOENT",
    ],
  ])("refuses by name instead of returning a screen", (run, reason) => {
    expect(readWindowsTerminalRows({ pid: 1, rows: 2, run })).toEqual({ status: "refused", reason })
  })
})

describe("readWindowsTerminalText", () => {
  it("maps full-width rows with the macOS mapping and pads nothing", () => {
    const read = readWindowsTerminalText({ pid: 1, rows: 2, cols: 3, run: answer(units(["ab ", "   "])) })
    expect(read).toEqual({
      status: "read",
      app: "windows-terminal",
      cells: { cols: 3, rows: 2, text: ["ab ", "   "], paddedRows: [], droppedLines: 0 },
    })
  })

  it("maps the rows below the document's end as blank rows and records them as padded", () => {
    const read = readWindowsTerminalText({ pid: 1, rows: 3, cols: 3, run: answer(units(["ab "], true)) })
    expect(read).toEqual({
      status: "read",
      app: "windows-terminal",
      cells: { cols: 3, rows: 3, text: ["ab ", "   ", "   "], paddedRows: [2, 3], droppedLines: 0 },
    })
  })

  it("refuses a row the mapping cannot place, never guessing its width", () => {
    const read = readWindowsTerminalText({ pid: 1, rows: 1, cols: 3, run: answer(units(["☺  "])) })
    expect(read).toMatchObject({ status: "refused", reason: expect.stringContaining("U+263A") })
  })
})

describe("createLineRenditionTracker", () => {
  it("refuses after ESC#3, ESC#4 or ESC#6 until a whole-screen erase or reset", () => {
    const tracker = createLineRenditionTracker()
    expect(tracker.refusal()).toBeUndefined()
    tracker.observe("abc\x1b#6wide")
    expect(tracker.refusal()).toContain("ESC#6 set a double-width or double-height line")
    tracker.observe("\x1b[2J\x1b[H")
    expect(tracker.refusal()).toBeUndefined()
    tracker.observe("\x1b#3top\x1b[2J\x1b#4")
    expect(tracker.refusal()).toContain("ESC#4")
    tracker.observe("\x1bc")
    expect(tracker.refusal()).toBeUndefined()
  })

  it("sees a sequence split across two writes", () => {
    const tracker = createLineRenditionTracker()
    tracker.observe("text\x1b")
    tracker.observe("#6")
    expect(tracker.refusal()).toContain("ESC#6")
    tracker.observe("\x1b[2")
    tracker.observe("J")
    expect(tracker.refusal()).toBeUndefined()
  })
})
