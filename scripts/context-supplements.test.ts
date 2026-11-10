/**
 * @failure A read-allowed supplement run renames its terminal's context key, adds a context, or changes any cell
 *   other than its two declared ids; or a no-reply under a setting the terminal may silently ignore is published as
 *   unsupported. A truecolor-on Screen run (#33151) changes a decided default cell's status, notes a cell it did not
 *   decide, or a mux run with an undeclared config reads as the default context.
 * @level l2
 * @consumer projectResults, the one selection the site, write-selection and the project map read (33119).
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { parseRun } from "@terminfo/run-parser"
import type { ProbeResult, ProbeSuiteManifest } from "@terminfo/probe-defs"
import { initializeRunDraft } from "@terminfo/probe-defs"
import { finalizeCollectedDraft } from "../packages/terminfo.dev/src/capture-writer.ts"
import {
  checkSupplement,
  MUX_DEFAULT_CONFIG,
  READ_ALLOWED,
  SCREEN_TRUECOLOR_CONFIG,
  supplementOf,
  TRUECOLOR_ON,
} from "../docs/data/context-supplements.ts"
import { projectResults } from "../docs/data/selected-results.ts"
import { publicResults } from "../docs/data/public-results.ts"

const READ = "extensions.osc52-read"
const ROUND_TRIP = "extensions.osc52-clipboard"
const FG = "sgr.fg.truecolor"
const BG = "sgr.bg.truecolor"
const TRUECOLOR = "extensions.truecolor"
const ids = [READ, ROUND_TRIP, "sgr.bold", "sgr.italic", FG, BG, TRUECOLOR]
const suite: ProbeSuiteManifest & { schemaVersion: 4 } = {
  schemaVersion: 4,
  probeHash: "supplement-suite",
  sourceRevision: "1".repeat(40),
  generatedAt: "2026-11-10T05:00:00.000Z",
  adapterVersion: "3.3.2",
  catalogIds: ids,
  probes: { term: [], lib: [], mux: [] },
}
const at = "2026-11-10T05:00:00.000Z"
const attempt = { scope: "probe" as const, startedAt: at }

type Measured = Record<string, "supported" | "unsupported">

/** One schema-4 run of `app` on Linux: every id an untouched TODO except the measured ones. */
function run(
  app: string,
  runId: string,
  measured: Measured,
  permissions: string | null,
  measuredAt = at,
  mux?: { config: string },
) {
  const kind = mux ? "mux" : "term"
  const draft = initializeRunDraft({
    runId,
    sourceRevision: suite.sourceRevision!,
    manifest: suite,
    source: { kind: "live" },
    intendedSubject: { kind, id: app },
  })
  draft.subject = {
    kind,
    id: app,
    version: mux ? "5.0.2" : "1.0.0",
    os: "linux",
    osVersion: "7.0.0",
    outerTerminal: mux ? "kitty" : null,
    mux: mux ? app : null,
    config: mux ? mux.config : permissions ? `${app} --allow-read bun collector` : `${app} bun collector`,
    permissions,
  }
  draft.identity = "verified"
  draft.measuredAt = measuredAt
  draft.origin = { kind: "collector" }
  const entries = Object.entries(measured)
  draft.rawReplies = Object.fromEntries(entries.map(([id, status]) => [id, status === "supported" ? "ACK" : "NO"]))
  draft.results = ids.map((featureId): ProbeResult => {
    const index = entries.findIndex(([id]) => id === featureId)
    const status = measured[featureId]
    if (!status) return { featureId, status: "probe-todo", attempt: { scope: "none" }, tests: [], reason: "Not run" }
    return {
      featureId,
      status,
      assertionType: "query_reply",
      rawReplyRef: featureId,
      attempt,
      tests: [{ id: "criterion", status, attempt, assertionRefs: [index], rawReplyRef: featureId }],
    }
  })
  const value = finalizeCollectedDraft(draft as Parameters<typeof finalizeCollectedDraft>[0])
  return parseRun(
    `${runId}.json`,
    JSON.stringify({
      ...value,
      assertions: entries.map(([featureId, status]) => ({
        featureId,
        kind: status === "supported" ? "positive" : "negative",
        assertionType: "query_reply",
        rawReplyRef: featureId,
        expected: "ACK",
        observed: status === "supported" ? "ACK" : "NO",
      })),
    }),
    ids,
    new Map([[suite.probeHash, suite]]),
  )
}

const project = (runs: ReturnType<typeof run>[]) => projectResults(runs, ids, { currentProbeHash: suite.probeHash }, [])

describe("read-allowed supplement (33119)", () => {
  const allowed = READ_ALLOWED.permissions.kitty!
  const base = run("kitty", "default-run", { "sgr.bold": "supported" }, null)
  const supplement = run("kitty", "supplement-run", { [READ]: "supported", [ROUND_TRIP]: "unsupported" }, allowed)

  it("keeps every context key, version and other cell byte-identical", () => {
    const without = project([base])
    const withIt = project([base, supplement])
    expect(Object.keys(withIt.contexts)).toEqual(Object.keys(without.contexts))
    expect(Object.keys(withIt.contexts)).toEqual(["term:kitty"])
    expect(JSON.stringify(withIt.versions)).toBe(JSON.stringify(without.versions))
    const before = without.contexts["term:kitty"]!
    const after = withIt.contexts["term:kitty"]!
    for (const id of ids.filter((id) => !READ_ALLOWED.featureIds.includes(id))) {
      expect(JSON.stringify(after.cells[id]), id).toBe(JSON.stringify(before.cells[id]))
    }
    expect(after.subject).toEqual(before.subject)
  })

  it("fills the two open cells with the supplement's own run id and qualifier", () => {
    const context = project([base, supplement]).contexts["term:kitty"]!
    for (const [id, status] of [
      [READ, "supported"],
      [ROUND_TRIP, "unsupported"],
    ] as const) {
      const cell = context.cells[id]!
      expect(cell.origin).toEqual({ runId: "supplement-run", resultId: id })
      expect(cell.result.status).toBe(status)
      expect(cell.supplement).toEqual({
        name: "read-allowed",
        qualifier: "with clipboard read allowed",
        runId: "supplement-run",
        declaredDefault: READ_ALLOWED.declaredDefaults.kitty,
        filled: true,
      })
    }
    expect(context.contributingRunIds).toEqual(["default-run", "supplement-run"])
  })

  it("publishes the filled cell from the supplement's own run, with its marker", () => {
    const published = publicResults(project([base, supplement]), new Map()).projection.contexts["term:kitty"]!
    expect(published.featureResults[READ]).toMatchObject({
      status: "supported",
      origin: { runId: "supplement-run", resultId: READ },
      supplement: { qualifier: "with clipboard read allowed", filled: true },
    })
    expect(published.featureResults["sgr.bold"]?.supplement).toBeUndefined()
    expect(Object.keys(published.sources)).toEqual(["default-run", "supplement-run"])
  })

  it("joins the default context's history, never versions", () => {
    const projection = project([base, supplement])
    expect(projection.history["term:kitty"]?.map((version) => version.runId)).toEqual(["default-run", "supplement-run"])
    expect(projection.versions["term:kitty"]?.map((version) => version.runId)).toEqual(["default-run"])
  })

  it("never touches a decided default cell", () => {
    const decided = run("kitty", "default-run", { [READ]: "unsupported" }, null)
    const context = project([decided, supplement]).contexts["term:kitty"]!
    expect(context.cells[READ]?.origin.runId).toBe("default-run")
    expect(context.cells[READ]?.supplement).toBeUndefined()
    expect(context.cells[ROUND_TRIP]?.origin.runId).toBe("supplement-run")
  })

  it("leaves a silently-ignoring terminal's no-reply open, and takes its reply", () => {
    const xterm = run("xterm", "xterm-default", {}, null)
    const silent = run("xterm", "xterm-allow", { [READ]: "unsupported", [ROUND_TRIP]: "supported" }, allowed)
    const context = project([xterm, silent]).contexts["term:xterm"]!
    expect(context.cells[READ]?.origin.runId).toBe("xterm-default")
    expect(context.cells[READ]?.result.status).toBe("probe-todo")
    expect(context.cells[READ]?.supplement).toMatchObject({
      runId: "xterm-allow",
      filled: false,
      open: "read allowed by setting, not proved in force",
    })
    expect(context.cells[ROUND_TRIP]?.origin.runId).toBe("xterm-allow")
    expect(context.cells[ROUND_TRIP]?.result.status).toBe("supported")
  })

  it("reads only the declared ids, and the newest supplement run wins", () => {
    const stray = run(
      "kitty",
      "old-supplement",
      { [READ]: "unsupported", "sgr.italic": "supported" },
      allowed,
      "2026-11-09T05:00:00.000Z",
    )
    const context = project([base, stray, supplement]).contexts["term:kitty"]!
    expect(context.cells["sgr.italic"]?.origin.runId).toBe("default-run")
    expect(context.cells[READ]?.origin.runId).toBe("supplement-run")
  })

  it("treats a run with undeclared permissions as an ordinary context (the split is what keeps keys)", () => {
    const other = run("kitty", "other-run", { [READ]: "supported" }, "clipboard: read=deny,write=allow")
    const keys = Object.keys(project([base, other]).contexts)
    expect(keys).toHaveLength(2)
    expect(keys.every((key) => key.startsWith("term:kitty@"))).toBe(true)
  })

  it("fills nothing without a default context to supplement", () => {
    const projection = project([supplement])
    expect(Object.keys(projection.contexts)).toEqual([])
    expect(projection.versions).toEqual({})
  })
})

/** One Linux Screen run through Kitty, recording `config` as its mux config. */
const screen = (runId: string, measured: Measured, config: string, measuredAt = at) =>
  run("screen", runId, measured, null, measuredAt, { config })

describe("truecolor-on supplement (33151)", () => {
  const base = run(
    "screen",
    "screen-default",
    { [FG]: "unsupported", [BG]: "unsupported", "sgr.bold": "supported" },
    null,
    at,
    {
      config: MUX_DEFAULT_CONFIG,
    },
  )
  const truecolor = screen(
    "screen-truecolor",
    { [FG]: "supported", [BG]: "unsupported", [TRUECOLOR]: "supported" },
    SCREEN_TRUECOLOR_CONFIG,
  )

  it("keys the Screen run on its recorded config, never on permissions", () => {
    expect(supplementOf(truecolor.subject)).toBe(TRUECOLOR_ON)
    expect(supplementOf(base.subject)).toBeUndefined()
    // A term run whose config happens to equal the Screen value is not a supplement: Apps key on permissions only.
    expect(
      supplementOf({ kind: "term", id: "screen", os: "linux", config: SCREEN_TRUECOLOR_CONFIG, permissions: null }),
    ).toBeUndefined()
  })

  it("keeps the context keys and every other cell, and never changes a decided cell's status", () => {
    const without = project([base])
    const withIt = project([base, truecolor])
    expect(Object.keys(withIt.contexts)).toEqual(Object.keys(without.contexts))
    const key = Object.keys(withIt.contexts)[0]!
    const before = without.contexts[key]!
    const after = withIt.contexts[key]!
    for (const id of ids.filter((id) => !TRUECOLOR_ON.featureIds.includes(id))) {
      expect(JSON.stringify(after.cells[id]), id).toBe(JSON.stringify(before.cells[id]))
    }
    for (const id of [FG, BG]) {
      expect(after.cells[id]?.origin.runId, id).toBe("screen-default")
      expect(after.cells[id]?.result, id).toEqual(before.cells[id]?.result)
    }
  })

  it("notes the decided rows with the supplement's own status, run and declared default", () => {
    const key = Object.keys(project([base]).contexts)[0]!
    const cells = project([base, truecolor]).contexts[key]!.cells
    const marker = {
      name: "truecolor-on",
      qualifier: "with truecolor on",
      runId: "screen-truecolor",
      declaredDefault: TRUECOLOR_ON.declaredDefaults.screen,
      filled: false,
    }
    expect(cells[FG]?.supplement).toEqual({ ...marker, noted: "supported" })
    expect(cells[BG]?.supplement).toEqual({ ...marker, noted: "unsupported" })
    // The open DECRQSS row is filled as any open cell is, from the supplement's own run.
    expect(cells[TRUECOLOR]?.origin.runId).toBe("screen-truecolor")
    expect(cells[TRUECOLOR]?.supplement).toMatchObject({ name: "truecolor-on", filled: true })
  })

  it("adds no marker when no supplement run answered", () => {
    const key = Object.keys(project([base]).contexts)[0]!
    const cells = project([base]).contexts[key]!.cells
    expect(cells[FG]?.supplement).toBeUndefined()
    expect(cells[TRUECOLOR]?.supplement).toBeUndefined()
  })

  it("refuses a Linux mux run whose config is neither the default nor a declared supplement", () => {
    const stray = screen("screen-stray", { [FG]: "supported" }, "/out/mux-other.conf")
    expect(() => project([base, stray])).toThrow(
      'screen-stray: mux screen records config "/out/mux-other.conf", which is neither the default /out/mux-empty.conf nor a declared context supplement',
    )
  })

  it("refuses a supplement that declares both or neither recorded field, by name", () => {
    expect(() => checkSupplement({ ...TRUECOLOR_ON, permissions: { screen: "x" } })).toThrow(
      "Context supplement truecolor-on must declare exactly one of permissions or config; it declares both",
    )
    const { config: _config, ...neither } = TRUECOLOR_ON
    expect(() => checkSupplement(neither)).toThrow(
      "Context supplement truecolor-on must declare exactly one of permissions or config; it declares neither",
    )
    expect(() => checkSupplement(READ_ALLOWED)).not.toThrow()
  })
})
