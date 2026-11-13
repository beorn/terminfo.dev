/**
 * @failure A tmux row is graded without the outer terminal's command record, or a report line is counted outside
 *   its own invocation window: the five rows whose record line the qualifying run found must be decided by the
 *   DA1 control plus the row's own line, and `editing.decrqcra`, whose bytes produced no line on either channel,
 *   must stay open by name instead of grading silence (@cto ac738b73 / 5c25b17f, 33630).
 * @level l2
 * @consumer The owned collector's outer command reader, the five mux arms and decrqcra's open arm.
 * @testonly none
 */
import { afterEach, expect, test, vi } from "vitest"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCallLog, withCallLog } from "viprobe"
import {
  MUX_OUTER_DECRQ_UNREADABLE,
  MUX_OUTER_DECRQ_UNREADABLE_BRANCH,
  MUX_OUTER_ROWS,
  editingProbes,
  extensionsProbes,
  muxOuterRowGrade,
  withMuxOuterRows,
  withMuxOuterUnreadableRow,
  type TermProbeSource,
} from "@terminfo/probe-defs"
import { beginMuxSgrCommandRead, hasOuterCommandMatcher } from "./app-semantic-state.ts"

afterEach(() => {
  vi.unstubAllEnvs()
})

// The six windows, copied verbatim from the direct outer kitty 0.49.2 run that qualified the rows (33630).
const captured = readFileSync(new URL("./fixtures/kitty-mux-outer-rows.txt", import.meta.url), "utf8")

function window(name: string): string {
  const lines = captured.split("\n")
  const start = lines.indexOf(`# window: ${name}`)
  if (start < 0) throw new Error(`fixture has no window ${name}`)
  const kept: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line === "" || line.startsWith("# window: ")) break
    kept.push(`${line}\n`)
  }
  return kept.join("")
}

const ROWS = [
  ["extensions.kitty-graphics", "kitty-graphics"],
  ["extensions.osc701-locale", "osc701"],
  ["extensions.osc702-version", "osc702"],
  ["extensions.osc776-cell-size", "osc776"],
  ["extensions.osc7770-font-size", "osc7770"],
] as const

async function muxArm(definition: { id: string; term?: unknown }, mux: "tmux" | "screen") {
  const writes: string[] = []
  const source = { kind: "live", cols: 80, rows: 24, mux, write: (text: string) => void writes.push(text) }
  const log = createCallLog()
  const session = withCallLog(source as unknown as TermProbeSource, { mode: "record", log })
  const result = await (definition.term as (ctx: TermProbeSource) => Promise<{ criterionBranch?: string }>)(
    session.context,
  )
  session.finish()
  return { writes, result, callLog: JSON.stringify(log) }
}

async function read(featureId: string, mux: "tmux" | "screen", record: string) {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-mux-rows-"))
  const artifacts = join(directory, "artifacts")
  const daemon = join(directory, "daemon.log")
  mkdirSync(artifacts)
  try {
    writeFileSync(daemon, "")
    const runId = "b".repeat(32)
    vi.stubEnv("TERMINFO_RUN_ID", runId)
    vi.stubEnv("TERMINFO_MUX_KIND", mux)
    vi.stubEnv("TERMINFO_TARGET_ID", "kitty")
    vi.stubEnv("TERMINFO_TARGET_VERSION", "0.49.2")
    vi.stubEnv("TERMINFO_CAPTURE_DIRECTORY", artifacts)
    const reader = beginMuxSgrCommandRead({
      featureId,
      subject: {
        kind: "mux",
        id: mux,
        version: mux === "tmux" ? "3.8" : "5.0.2",
        os: "linux",
        outerTerminal: "kitty",
      },
      proof: {
        platform: "linux",
        mux,
        launchRunId: runId,
        collector: { pid: process.pid, startTicks: "1", ttyRdev: 1 },
      },
    })
    if (reader.status !== "ready") return reader
    const definition = extensionsProbes.find((probe) => probe.id === featureId)!
    const arm = await muxArm(definition, mux)
    appendFileSync(daemon, record)
    return await reader.read(arm.callLog)
  } finally {
    rmSync(directory, { recursive: true })
  }
}

test.each(ROWS)("%s: the mux arm sends its target, then the DA1 control, and names its branch", async (id, name) => {
  const row = MUX_OUTER_ROWS[id]!
  const definition = extensionsProbes.find((probe) => probe.id === id)!
  expect(hasOuterCommandMatcher(id)).toBe(true)
  const arm = await muxArm(definition, "tmux")
  expect(arm.writes).toEqual([row.write, "\u001b[c"])
  expect(arm.result.criterionBranch).toBe(row.branch)
  expect(window(name).length).toBeGreaterThan(0)
})

test.each(ROWS)("%s: the wrapper leaves a Screen callback alone and only swaps tmux", async (id) => {
  const row = MUX_OUTER_ROWS[id]!
  const seen: Array<string | undefined> = []
  const original = async (ctx: TermProbeSource) => {
    seen.push(ctx.mux)
    return { pass: false, reason: "the row's own callback" }
  }
  const definition = withMuxOuterRows(MUX_OUTER_ROWS)({ id, term: original } as never)
  const screenWrites: string[] = []
  const screenResult = await (definition.term as (ctx: TermProbeSource) => Promise<{ criterionBranch?: string }>)({
    kind: "live",
    cols: 80,
    rows: 24,
    mux: "screen",
    write: (text: string) => void screenWrites.push(text),
  } as unknown as TermProbeSource)
  expect(seen).toEqual(["screen"])
  expect(screenWrites).toEqual([])
  expect(screenResult.criterionBranch).toBeUndefined()

  const tmuxWrites: string[] = []
  const tmuxResult = await (definition.term as (ctx: TermProbeSource) => Promise<{ criterionBranch?: string }>)({
    kind: "live",
    cols: 80,
    rows: 24,
    mux: "tmux",
    write: (text: string) => void tmuxWrites.push(text),
  } as unknown as TermProbeSource)
  expect(seen).toEqual(["screen"])
  expect(tmuxWrites).toEqual([row.write, "\u001b[c"])
  expect(tmuxResult.criterionBranch).toBe(row.branch)
})

test("editing.decrqcra keeps its bytes, has no reader, and stays open by name on a mux subject", async () => {
  const definition = editingProbes.find((probe) => probe.id === "editing.decrqcra")!
  expect(hasOuterCommandMatcher("editing.decrqcra")).toBe(false)
  const arm = await muxArm(definition, "tmux")
  expect(arm.writes).toEqual(["\u001b[1;1;1;1;1;5*y", "\u001b[c"])
  expect(arm.result).toMatchObject({
    pass: false,
    criterionBranch: MUX_OUTER_DECRQ_UNREADABLE_BRANCH,
    tests: [{ id: "outer-command-record", status: "probe-todo", reason: MUX_OUTER_DECRQ_UNREADABLE }],
  })
})

test("editing.decrqcra keeps its own callback on Screen", async () => {
  const seen: Array<string | undefined> = []
  const definition = withMuxOuterUnreadableRow(
    "editing.decrqcra",
    "\u001b[1;1;1;1;1;5*y",
  )({
    id: "editing.decrqcra",
    term: async (ctx: TermProbeSource) => {
      seen.push(ctx.mux)
      return { pass: false, reason: "the row's own callback" }
    },
  } as never)
  const writes: string[] = []
  const result = await (definition.term as (ctx: TermProbeSource) => Promise<{ criterionBranch?: string }>)({
    kind: "live",
    cols: 80,
    rows: 24,
    mux: "screen",
    write: (text: string) => void writes.push(text),
  } as unknown as TermProbeSource)
  expect(seen).toEqual(["screen"])
  expect(writes).toEqual([])
  expect(result.criterionBranch).toBeUndefined()
})

test.each(ROWS)("%s: the captured window reads the row's own line as sent", async (id, name) => {
  const result = await read(id, "tmux", window(name))
  expect(result).toMatchObject({
    status: "measured",
    target: MUX_OUTER_ROWS[id]!.label,
    targetSent: true,
    outer: { app: "kitty", version: "0.49.2" },
  })
  expect((result as { trace?: { sha256?: string; lines?: number } }).trace?.sha256).toMatch(/^[0-9a-f]{64}$/)
  expect((result as { trace?: { lines?: number } }).trace?.lines).toBeGreaterThan(0)
})

test.each(ROWS)("%s: the control with the row's line removed reads the target as not sent", async (id, name) => {
  const target = rowTargetLine(id)
  const withoutTarget = window(name)
    .split("\n")
    .filter((line) => line !== target)
    .join("\n")
  const result = await read(id, "tmux", withoutTarget)
  expect(result).toMatchObject({ status: "measured", targetSent: false })
})

function rowTargetLine(id: string): string {
  const name = ROWS.find(([row]) => row === id)![1]
  return window(name)
    .split("\n")
    .find((line) => line.length > 0 && line !== "report_device_attributes 0 0")!
}

test("a row line after the control is outside the window", async () => {
  const [target] = window("osc776").split("\n")
  const result = await read("extensions.osc776-cell-size", "tmux", `report_device_attributes 0 0\n${target}\n`)
  expect(result).toMatchObject({ status: "measured", targetSent: false })
})

test.each(ROWS)(
  "%s: a window with no control line is a named invalid, never an empty negative",
  async (id, name) => {
    const withoutControl = window(name)
      .split("\n")
      .filter((line) => line !== "report_device_attributes 0 0")
      .join("\n")
    const result = await read(id, "tmux", withoutControl)
    expect(result.status).toBe("unavailable")
    expect((result as { reason: string }).reason).toMatch(/no device-attributes control line/)
  },
  20_000,
)

test("a row's code in another form is a named failure, not a did-not-forward grade", async () => {
  const other = window("osc701").replace(
    /^\[[0-9.]+\] Ignoring OSC 701, used by mintty for locale$/m,
    "[1.000] Unknown OSC escape code: 701",
  )
  const result = await read("extensions.osc701-locale", "tmux", other)
  expect(result.status).toBe("unavailable")
  expect((result as { reason: string }).reason).toMatch(/in another form/)
}, 20_000)

test("the grade reads only the outer record: sent is open, not sent is the criterion's Unsupported", () => {
  const row = MUX_OUTER_ROWS["extensions.osc701-locale"]!
  const grade = muxOuterRowGrade(row)
  const sent = grade({
    status: "measured",
    target: row.label,
    targetSent: true,
    outer: { app: "kitty", version: "0.49.2" },
    trace: { sha256: "a".repeat(64), lines: 2, window: { offset: 0, endOffset: 20 } },
    detail: {},
  })
  expect(sent.tests?.[0]).toMatchObject({ status: "probe-todo" })
  expect(sent.tests?.[0]?.reason).toMatch(/whether the outer terminal applied it was not read/)

  const missing = grade({
    status: "measured",
    target: row.label,
    targetSent: false,
    outer: { app: "kitty", version: "0.49.2" },
    trace: { sha256: "b".repeat(64), lines: 1, window: { offset: 0, endOffset: 12 } },
    detail: {},
  })
  expect(missing.observation?.outcome).toBe("unsupported")
  expect(missing.note).toContain(`trace sha256 ${"b".repeat(64)}`)

  const unreadable = grade({ status: "unavailable", reason: "no trace" })
  expect(unreadable.tests?.[0]).toMatchObject({ status: "probe-invalid" })
})

test("screen keeps no reader for these rows in this slice", () => {
  const reader = beginMuxSgrCommandRead({
    featureId: "extensions.osc701-locale",
    subject: { kind: "mux", id: "screen", version: "5.0.2", os: "linux", outerTerminal: "kitty" },
  })
  expect(reader.status).toBe("unavailable")
  expect((reader as { reason: string }).reason).toMatch(/No qualified outer command reader/)
})

test.each(ROWS)("%s: on Screen the collector's outer-command grade is never reached", async (id) => {
  const row = MUX_OUTER_ROWS[id]!
  const definition = extensionsProbes.find((probe) => probe.id === id)!
  const subject = { kind: "mux" as const, id: "screen", version: "5.0.2", os: "linux", outerTerminal: "kitty" }
  const reader = beginMuxSgrCommandRead({ featureId: id, subject })
  // unified.ts grades from the outer record only for the tmux branch, and the reader refuses Screen by name, so no
  // Screen row can be graded from a trace this slice never qualified.
  expect(definition.outerCommands?.branch).toBe(row.branch)
  expect(reader.status).toBe("unavailable")
  expect((reader as { reason: string }).reason).toMatch(/No qualified outer command reader/)
  expect(row.branch).not.toBe(MUX_OUTER_DECRQ_UNREADABLE_BRANCH)
})
