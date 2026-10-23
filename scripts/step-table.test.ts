/**
 * @failure The popover could print "the last column" instead of the run's measured column, invent a pass on a
 *   held Windows result, lose the sent bytes behind an unreadable wall of A's, or build a step table for a cell
 *   whose measured steps it cannot name — each of which turns recorded evidence into a claim the run never made.
 * @level l1
 * @consumer terminfo.dev result popover (#30756)
 * @source-grep the step names and setup positions live in packages/probe-defs/src/cursor.ts, so only a measured
 *   run proves the expectations are the probe's own. The run is a checked-in verbatim copy (#30764): the live
 *   round leaves content/ on Friday. The helper is display-only and never re-grades a cell.
 * @reach fs-read vendor/terminfo.dev/test-fixtures/probes-apps/** vendor/terminfo.dev/test-fixtures/probes-libs/** vendor/terminfo.dev/test-fixtures/probes-mux/** vendor/terminfo.dev/test-fixtures/artifacts/**
 * @testonly none
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  compactBytes,
  compressBytes,
  describeReplyBytes,
  describeSentBytes,
  describeStepTable,
  type StepSource,
} from "../docs/data/step-table.ts"

// Checked-in copies of the run files this suite reads (#30764 M4): the old round leaves content/ on
// Friday, and these assertions must keep reading a real recorded run, not a hand-written stub.
const fixtures = join(import.meta.dirname, "..", "test-fixtures")

interface StoredRun {
  results?: Array<{ featureId: string; status: string }>
  assertions: Array<{ featureId: string; kind: string; expected: string; observed?: string }>
  rawReplies: Record<string, string>
}

function storedRun(file: string): StoredRun {
  return JSON.parse(readFileSync(join(fixtures, "probes-apps", file), "utf8")) as StoredRun
}

/** The popover's source for one cell, exactly as the component assembles it from a run's trace. */
function source(file: string, status: string): StepSource {
  const run = storedRun(file)
  const reply = run.rawReplies["cursor.reverse-wrap"]
  if (reply === undefined) throw new Error(`${file} has no cursor.reverse-wrap reply`)
  const stored = JSON.parse(reply) as { writes: string[]; queries: StepSource["queries"]; events: StepSource["events"] }
  const geometry = JSON.parse(run.rawReplies["collector.geometry"] ?? "{}") as {
    grant?: { rows: number; cols: number }
    corroboration?: { status: string; rows: number; cols: number }
  }
  const screen =
    geometry.corroboration?.status === "agree"
      ? { rows: geometry.corroboration.rows, cols: geometry.corroboration.cols }
      : geometry.grant
  const assertion = run.assertions.find((entry) => entry.featureId === "cursor.reverse-wrap")
  if (assertion === undefined) throw new Error(`${file} has no cursor.reverse-wrap assertion`)
  return {
    status,
    assertions: [assertion],
    writes: stored.writes,
    queries: stored.queries,
    events: stored.events,
    ...(screen && { screen }),
  }
}

const warp = "warp-v0.2026.10.14.08.27.stable_01-macos-0a0afdf422002ff3f9896a3088e4a169.json"
const alacrittyWindows = "alacritty-0.17.0-windows-20eb3ab6d830e196eb3fa08dade7740a.json"
const terminalApp = "terminal-app-2.15-macos-81d7321e92df660ce1c01931bebedbd2.json"

describe("the popover step table", () => {
  it("names each recorded step and grades the measured one against the run's own width", () => {
    const table = describeStepTable(source(warp, "unsupported"))
    expect(table?.rows.map((row) => row.step)).toEqual(["Home", "After wrap", "After 2 backspaces"])
    expect(table?.rows.map((row) => row.result)).toEqual(["pass", "pass", "fail"])
    expect(table?.rows[2]?.expected).toBe("row 1, col 123")
    expect(table?.rows[2]?.got).toBe("row 2, col 1")
    expect(table?.rows[2]?.reply).toBe("ESC[2;1R")
    expect(table?.summary).toBe("After 2 backspaces, the cursor stayed at row 2, col 1; expected row 1, col 123.")
  })

  it("reads each run's own width, never the words 'the last column'", () => {
    const widths = [
      [warp, "unsupported", 123],
      [alacrittyWindows, "test-todo", 100],
      [terminalApp, "supported", 120],
    ] as const
    for (const [file, status, cols] of widths) {
      const table = describeStepTable(source(file, status))
      expect(table?.rows[2]?.expected).toBe(`row 1, col ${cols}`)
      expect(JSON.stringify(table)).not.toContain("last column")
    }
  })

  it("reports a held Windows result as held, not as a failed terminal", () => {
    const table = describeStepTable(source(alacrittyWindows, "test-todo"))
    expect(table?.rows[2]?.result).toBe("held")
    expect(table?.rows[2]?.got).toBe("row 2, col 1")
  })

  it("shows a passing measurement as the return it measured", () => {
    const table = describeStepTable(source(terminalApp, "supported"))
    expect(table?.rows[2]).toMatchObject({ expected: "row 1, col 120", got: "row 1, col 120", result: "pass" })
    expect(table?.summary).toBe("After 2 backspaces, the cursor returned to row 1, col 120, as expected.")
  })

  it("summarises repeated bytes and keeps the full bytes one click away", () => {
    const sent = describeSentBytes(source(warp, "unsupported"))
    expect(sent?.summary).toContain("A ×123 B")
    expect(sent?.full).toContain("A".repeat(123))
    expect(sent?.full).toContain("ESC [ ?45 h")
    expect(describeReplyBytes(source(warp, "unsupported"))?.full).toBe("ESC [ 1;1 R  ESC [ 2;2 R  ESC [ 2;1 R")
  })

  it("refuses to build a table without the run's measured width", () => {
    const withoutScreen = source(warp, "unsupported")
    delete withoutScreen.screen
    expect(describeStepTable(withoutScreen)).toBeUndefined()
  })

  it("leaves a cell it cannot name to the recorded panes", () => {
    const other = source(terminalApp, "supported")
    other.assertions = [{ kind: "positive", expected: "Bold text is drawn bold", observed: "captured pixels" }]
    expect(describeStepTable(other)).toBeUndefined()
  })

  it("throws when a JSON-shaped observed assertion does not parse", () => {
    const broken = source(terminalApp, "supported")
    broken.assertions = [{ kind: "positive", expected: "row 1, col 120", observed: "{broken" }]
    expect(() => describeStepTable(broken)).toThrow("observed assertion is JSON-shaped but does not parse")
  })

  it("keeps short repeats literal so control sequences stay readable", () => {
    expect(compressBytes("AAB")).toBe("AAB")
    expect(compressBytes("\x1b[?45h")).toBe("ESC [ ?45 h")
    expect(compactBytes("\x1b[?45h")).toBe("ESC[?45h")
  })
})
