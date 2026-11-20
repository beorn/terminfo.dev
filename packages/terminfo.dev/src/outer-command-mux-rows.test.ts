/**
 * @failure A tmux row is graded without the outer terminal's command record, or a report line is counted outside its
 *   own invocation window: the five rows whose record line the qualifying run found must be decided by the shared
 *   title forwarding control plus the row's own line, and `editing.decrqcra`, whose bytes produced no line on either
 *   channel, must stay open by name instead of grading silence (@cto ac738b73 / 5c25b17f / 60c52bf0, 33630). Under
 *   the default tmux config, where no forwarding control can arrive, those five rows are declared untestable — never
 *   probe-invalid and never Unsupported.
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
  MUX_OUTER_NO_RECORD,
  MUX_OUTER_ROWS,
  editingProbes,
  extensionsProbes,
  isDeclaredUntestable,
  muxOuterNoControlDefault,
  muxOuterRowGrade,
  withMuxOuterRows,
  withMuxOuterUnreadableRow,
  type TermProbeSource,
} from "@terminfo/probe-defs"
import { beginMuxSgrCommandRead, hasOuterCommandMatcher } from "./app-semantic-state.ts"
import { TMUX_SET_TITLES_CONFIG } from "./disposable-receipt.ts"

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

const CONTROL = /^\u001b\]2;(tdv-title-[0-9a-f]{24})\u001b\\$/

/** The one forwarding control this arm wrote, as the outer record line it produces. */
function controlLine(writes: string[]): string {
  const nonces = writes.flatMap((text) => CONTROL.exec(text)?.[1] ?? [])
  if (nonces.length !== 1) throw new Error(`arm wrote ${nonces.length} forwarding controls; one is required`)
  return `set_title ${nonces[0]}`
}

/** The qualified window plus the control this invocation wrote — what a set-titles run leaves in the record. */
function withControl(record: string, writes: string[]): string {
  return record + controlLine(writes) + "\n"
}

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

async function read(
  featureId: string,
  mux: "tmux" | "screen",
  record: string | ((writes: string[]) => string),
  config?: string,
) {
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
    const subject = {
      kind: "mux" as const,
      id: mux,
      version: mux === "tmux" ? "3.8" : "5.0.2",
      os: "linux",
      outerTerminal: "kitty",
      ...(config === undefined ? {} : { config }),
    }
    const reader = beginMuxSgrCommandRead({
      featureId,
      subject,
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
    appendFileSync(daemon, typeof record === "function" ? record(arm.writes) : record)
    return await reader.read(arm.callLog)
  } finally {
    rmSync(directory, { recursive: true })
  }
}

test.each(ROWS)(
  "%s: the mux arm sends its target, then the shared title control, and names its branch",
  async (id, name) => {
    const row = MUX_OUTER_ROWS[id]!
    const definition = extensionsProbes.find((probe) => probe.id === id)!
    expect(hasOuterCommandMatcher(id)).toBe(true)
    const arm = await muxArm(definition, "tmux")
    expect(arm.writes).toHaveLength(2)
    expect(arm.writes[0]).toBe(row.write)
    expect(arm.writes[1]).toMatch(CONTROL)
    expect(arm.result.criterionBranch).toBe(row.branch)
    expect(window(name).length).toBeGreaterThan(0)
  },
)

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

  const directWrites: string[] = []
  const directResult = await (definition.term as (ctx: TermProbeSource) => Promise<{ criterionBranch?: string }>)({
    kind: "live",
    cols: 80,
    rows: 24,
    write: (text: string) => void directWrites.push(text),
  } as unknown as TermProbeSource)
  expect(seen).toEqual(["screen", undefined])
  expect(directWrites).toEqual([])
  expect(directResult.criterionBranch).toBeUndefined()

  const tmuxWrites: string[] = []
  const tmuxResult = await (definition.term as (ctx: TermProbeSource) => Promise<{ criterionBranch?: string }>)({
    kind: "live",
    cols: 80,
    rows: 24,
    mux: "tmux",
    write: (text: string) => void tmuxWrites.push(text),
  } as unknown as TermProbeSource)
  expect(seen).toEqual(["screen", undefined])
  expect(tmuxWrites).toHaveLength(2)
  expect(tmuxWrites[0]).toBe(row.write)
  expect(tmuxWrites[1]).toMatch(CONTROL)
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

test.each(ROWS)("%s: the lib callback is the same function, so no library row can move", (id) => {
  const row = MUX_OUTER_ROWS[id]!
  const lib = () => ({ pass: false, reason: "library callback" })
  const term = async () => ({ pass: false, reason: "terminal callback" })
  const wrapped = withMuxOuterRows(MUX_OUTER_ROWS)({ id, lib, term } as never)
  // 33801's eleven library rows run through `lib`; the wrapper replaces only `term`, and only for tmux.
  expect(wrapped.lib).toBe(lib)
  expect(wrapped.term).not.toBe(term)
  expect(row.branch).toBe(MUX_OUTER_ROWS[id]!.branch)
})

test("editing.decrqcra: the lib callback is untouched there too", () => {
  const lib = () => ({ pass: false, reason: "library callback" })
  const wrapped = withMuxOuterUnreadableRow(
    "editing.decrqcra",
    "\u001b[1;1;1;1;1;5*y",
  )({
    id: "editing.decrqcra",
    lib,
    term: async () => ({ pass: false, reason: "terminal callback" }),
  } as never)
  expect(wrapped.lib).toBe(lib)
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

test.each(ROWS)(
  "%s: the qualified window plus this invocation's control reads the row's own line as sent",
  async (id, name) => {
    const result = await read(id, "tmux", (writes) => withControl(window(name), writes), TMUX_SET_TITLES_CONFIG)
    expect(result).toMatchObject({
      status: "measured",
      target: MUX_OUTER_ROWS[id]!.label,
      targetSent: true,
      outer: { app: "kitty", version: "0.49.2" },
    })
    expect((result as { trace?: { sha256?: string; lines?: number } }).trace?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect((result as { trace?: { lines?: number } }).trace?.lines).toBeGreaterThan(0)
  },
  20_000,
)

test.each(ROWS)(
  "%s: the control with the row's line removed reads the target as not sent",
  async (id, name) => {
    const target = rowTargetLine(id)
    const result = await read(
      id,
      "tmux",
      (writes) =>
        withControl(
          window(name)
            .split("\n")
            .filter((line) => line !== target)
            .join("\n"),
          writes,
        ),
      TMUX_SET_TITLES_CONFIG,
    )
    expect(result).toMatchObject({ status: "measured", targetSent: false })
  },
  20_000,
)

function rowTargetLine(id: string): string {
  const name = ROWS.find(([row]) => row === id)![1]
  return window(name)
    .split("\n")
    .find((line) => line.length > 0 && line !== "report_device_attributes 0 0")!
}

test("a row line after the control is outside this invocation's window", async () => {
  const [target] = window("osc776").split("\n")
  const result = await read(
    "extensions.osc776-cell-size",
    "tmux",
    (writes) => `${controlLine(writes)}\n${target}\n`,
    TMUX_SET_TITLES_CONFIG,
  )
  expect(result.status).toBe("unavailable")
  expect((result as { reason: string }).reason).toMatch(/only after its forwarding control/)
}, 20_000)

test.each(ROWS)(
  "%s: a set-titles window with no control line is a named invalid, never an empty negative",
  async (id, name) => {
    const withoutControl = window(name)
      .split("\n")
      .filter((line) => line !== "report_device_attributes 0 0")
      .join("\n")
    const result = await read(id, "tmux", withoutControl, TMUX_SET_TITLES_CONFIG)
    expect(result.status).toBe("unavailable")
    expect((result as { reason: string }).reason).toMatch(/no forwarding control line/)
    const graded = muxOuterRowGrade(MUX_OUTER_ROWS[id]!)(result)
    expect(graded.tests?.[0]?.status).toBe("probe-invalid")
  },
  20_000,
)

test.each(ROWS)(
  "%s: the default tmux config makes the row declared untestable, not invalid",
  async (id, name) => {
    const result = await read(id, "tmux", window(name), "/out/mux-empty.conf")
    expect(result.status).toBe("unavailable")
    expect(result).toMatchObject({ titlesForwarded: false, noForwardingControl: true })
    const row = MUX_OUTER_ROWS[id]!
    const graded = muxOuterRowGrade(row)(result)
    expect(isDeclaredUntestable(graded)).toBe(true)
    expect(graded.tests).toEqual([
      { id: "declared-untestable", status: "untestable", reason: muxOuterNoControlDefault(row.label) },
    ])
  },
  20_000,
)

test("a row's code in another form is a named failure, not a did-not-forward grade", async () => {
  const other = window("osc701").replace(
    /^\[[0-9.]+\] Ignoring OSC 701, used by mintty for locale$/m,
    "[1.000] Unknown OSC escape code: 701",
  )
  const result = await read(
    "extensions.osc701-locale",
    "tmux",
    (writes) => withControl(other, writes),
    TMUX_SET_TITLES_CONFIG,
  )
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
  expect(unreadable.tests?.[0]?.reason).toBe(`${MUX_OUTER_NO_RECORD} no trace`)
})

test("the grade keeps a set-titles read's own failure reason when the control is missing", () => {
  const row = MUX_OUTER_ROWS["extensions.osc701-locale"]!
  const graded = muxOuterRowGrade(row)({
    status: "unavailable",
    reason: "Outer command record has no forwarding control line: set_title tdv-title-x",
    titlesForwarded: true,
    noForwardingControl: true,
    detail: {},
  })
  expect(graded.tests?.[0]?.status).toBe("probe-invalid")
  expect(graded.tests?.[0]?.reason).toMatch(/has no forwarding control line/)
})

test("screen keeps no reader for these rows in this slice", () => {
  const reader = beginMuxSgrCommandRead({
    featureId: "extensions.osc701-locale",
    subject: { kind: "mux", id: "screen", version: "5.0.2", os: "linux", outerTerminal: "kitty" },
  })
  expect(reader.status).toBe("unavailable")
  expect((reader as { reason: string }).reason).toMatch(/No qualified outer command reader/)
})

test.each(ROWS)("%s: on Screen the collector's outer-command grade is never invoked", async (id) => {
  const row = MUX_OUTER_ROWS[id]!
  const registered = extensionsProbes.find((probe) => probe.id === id)!
  const subject = { kind: "mux" as const, id: "screen", version: "5.0.2", os: "linux", outerTerminal: "kitty" }
  // The real wrapper around a sentinel callback, carrying the REGISTERED definition's own grade, so the guard below
  // runs the same comparison unified.ts runs and a spy can see whether the grade was reached.
  const grade = vi.fn(registered.outerCommands!.grade)
  const wrapped = withMuxOuterRows(MUX_OUTER_ROWS)({ id, term: async () => ({ pass: false, reason: "own" }) } as never)
  const definition = { ...wrapped, outerCommands: { branch: registered.outerCommands!.branch, grade } }
  const writes: string[] = []
  let result = await (definition.term as (ctx: TermProbeSource) => Promise<{ criterionBranch?: string }>)({
    kind: "live",
    cols: 80,
    rows: 24,
    mux: "screen",
    write: (text: string) => void writes.push(text),
  } as unknown as TermProbeSource)
  expect(writes).toEqual([])
  if (
    definition.outerCommands &&
    subject.kind === "mux" &&
    result.criterionBranch === definition.outerCommands.branch
  ) {
    result = grade({ status: "unavailable", reason: "no trace" })
  }
  expect(grade).not.toHaveBeenCalled()
  // And the reader refuses Screen by name, so even a reached grade could not invent a trace result.
  const reader = beginMuxSgrCommandRead({ featureId: id, subject })
  expect(reader.status).toBe("unavailable")
  expect((reader as { reason: string }).reason).toMatch(/No qualified outer command reader/)
  expect(row.branch).not.toBe(MUX_OUTER_DECRQ_UNREADABLE_BRANCH)
})
