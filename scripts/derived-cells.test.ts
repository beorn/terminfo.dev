/**
 * @failure A refused parent leaves its child reading Untestable, a child derives from a parent that is open, invalid,
 *   missing, Supported, reopened, itself derived or refused only by a query's silence (#38772, @cto b1a8ecea), a derived cell looks like a direct measurement, or a Supported
 *   child under a refused parent passes silently.
 * @level l2
 * @consumer projectResults and publicResults, the one selection every site page, census and script reads (33019).
 * @testonly none
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { parseRun } from "@terminfo/run-parser"
import type { ProbeResult, ProbeSuiteManifest } from "@terminfo/probe-defs"
import { initializeRunDraft } from "@terminfo/probe-defs"
import { finalizeCollectedDraft } from "../packages/terminfo.dev/src/capture-writer.ts"
import {
  DERIVED_UNSUPPORTED,
  gradeOsc52Clipboard,
  partsComparable,
  publicDerivedReason,
  type PartReading,
} from "../docs/data/derived-cells.ts"
import type { ReopenedCell } from "../docs/data/reopened-cells.ts"
import { projectResults } from "../docs/data/selected-results.ts"
import { publicResults } from "../docs/data/public-results.ts"
import { UNANSWERED_QUERY } from "./stored-exchange.fixture.ts"
import {
  aggregateCurrentResults,
  rollupInputs,
  currentCoverageSentence,
  decisiveCells,
  runDecidedNothing,
} from "../docs/data/release-scope.ts"

const catalogue = JSON.parse(readFileSync(new URL("../content/features.json", import.meta.url), "utf8")) as Record<
  string,
  { probe?: string } | undefined
>

const TRANSMIT = "extensions.kitty-graphics.transmit"
const DISPLAY = "extensions.kitty-graphics.display"
const ids = [TRANSMIT, DISPLAY, "sgr.bold"]
const OSC17 = "extensions.osc17-highlight-bg"
const OSC117 = "extensions.osc117-reset-highlight-bg"
const OSC_IDS = [OSC17, OSC117]
const suite = (catalogIds: string[]): ProbeSuiteManifest & { schemaVersion: 4 } => ({
  schemaVersion: 4,
  probeHash: "suite",
  sourceRevision: "1".repeat(40),
  generatedAt: "2026-11-10T05:00:00.000Z",
  adapterVersion: "3.3.2",
  catalogIds,
  probes: { term: [], lib: [], mux: [] },
})
const SUITE = suite(ids)
/** A fenced silence: the query drew DA1 and nothing else. Recorded as a query_reply witness. */
const SILENCE = "DA1 answered at +0ms; no reply through the 250 ms window"
/** An effect read: the sequence was written and its effect read back (here, a library's own unhandled report). */
const EFFECT = "library reported this sequence as unhandled"
const EFFECT_READ = JSON.stringify({
  reader: "report",
  target: { code: "17", reports: ["17"] },
  unknown: { code: "9999", reports: ["9999"] },
})
const NO_SETUP =
  "Untestable (no setup): Kitty graphics transmit has no reply to either a=t or a=q after their DA1 controls, so the display cell has no image to place"

type Row =
  | { status: "supported" | "unsupported"; witness?: "effect"; note?: string }
  | { status: "untestable" | "probe-invalid" | "probe-todo"; reason: string }

/** One schema-4 xterm run on Linux; decided rows carry a query_reply witness, open rows only their reason. */
function run(runId: string, rows: Record<string, Row>, catalog: string[] = ids) {
  const manifest = suite(catalog)
  const measuredAt = "2026-11-10T05:00:00.000Z"
  const attempt = { scope: "probe" as const, startedAt: measuredAt }
  const draft = initializeRunDraft({
    runId,
    sourceRevision: SUITE.sourceRevision!,
    manifest,
    source: { kind: "live" },
    intendedSubject: { kind: "term", id: "xterm" },
  })
  draft.subject = {
    kind: "term",
    id: "xterm",
    version: "411",
    os: "linux",
    osVersion: "7.0.0",
    outerTerminal: null,
    mux: null,
    config: "xterm bun collector",
    permissions: null,
  }
  draft.identity = "verified"
  draft.measuredAt = measuredAt
  draft.origin = { kind: "collector" }
  const decided = Object.entries(rows).filter(([, row]) => row.status === "supported" || row.status === "unsupported")
  draft.rawReplies = Object.fromEntries(Object.keys(rows).map((id) => [id, UNANSWERED_QUERY]))
  // An effect row's callback keeps what it read: the library's own report that it left the sequence unhandled.
  for (const [id, row] of Object.entries(rows)) {
    if ("witness" in row && row.witness === "effect") draft.rawReplies[`${id}.callbackResponse`] = EFFECT_READ
  }
  draft.results = catalog.map((featureId): ProbeResult => {
    const row = rows[featureId]
    if (!row) return { featureId, status: "probe-todo", attempt: { scope: "none" }, tests: [], reason: "Not run" }
    if ("reason" in row) {
      // The stored shape of an open row (xterm 411's kitty display row): one test carrying the reason.
      const testId = row.status === "untestable" ? "declared-untestable" : "criterion"
      return {
        featureId,
        status: row.status,
        attempt,
        rawReplyRef: featureId,
        reason: row.reason,
        ...(row.status === "untestable" && { criterionBranch: "headless-observable-review" }),
        tests: [
          { id: testId, status: row.status, attempt, assertionRefs: [], rawReplyRef: featureId, reason: row.reason },
        ],
      }
    }
    const index = decided.findIndex(([id]) => id === featureId)
    const effect = row.witness === "effect"
    return {
      featureId,
      status: row.status,
      assertionType: effect ? "buffer_state" : "query_reply",
      rawReplyRef: featureId,
      ...(row.status === "unsupported" && { reason: effect ? EFFECT : SILENCE }),
      ...(row.status === "supported" && row.note !== undefined && { reason: row.note }),
      attempt,
      tests: [{ id: "criterion", status: row.status, attempt, assertionRefs: [index], rawReplyRef: featureId }],
    }
  })
  const value = finalizeCollectedDraft(draft as Parameters<typeof finalizeCollectedDraft>[0])
  return parseRun(
    `${runId}.json`,
    JSON.stringify({
      ...value,
      assertions: decided.map(([featureId, row]) => ({
        featureId,
        kind: row.status === "supported" ? "positive" : "negative",
        assertionType: "witness" in row && row.witness === "effect" ? "buffer_state" : "query_reply",
        rawReplyRef: featureId,
        expected: "a reply",
        // An effect read retains the state it read; a query keeps its reply or the silence.
        observed:
          "witness" in row && row.witness === "effect" ? EFFECT_READ : row.status === "supported" ? "ACK" : SILENCE,
      })),
    }),
    catalog,
    new Map([[manifest.probeHash, manifest]]),
  )
}

const project = (runs: ReturnType<typeof run>[], reopened: ReopenedCell[] = []) =>
  projectResults(runs, ids, { currentProbeHash: SUITE.probeHash, reopened }, [])
const context = (runs: ReturnType<typeof run>[], reopened: ReopenedCell[] = []) =>
  project(runs, reopened).contexts["term:xterm"]!

describe("unsupported, derived (33019)", () => {
  it("derives the child from a parent refused with its own witness, keeping the child's own reading as a note", () => {
    const measured = run("r1", {
      [TRANSMIT]: { status: "unsupported", witness: "effect" },
      [DISPLAY]: { status: "untestable", reason: NO_SETUP },
    })
    const ctx = context([measured])
    const cell = ctx.cells[DISPLAY]!
    expect(cell.featureResult).toMatchObject({ status: "unsupported", strength: null })
    expect(cell.result.status).toBe("untestable")
    expect(cell.derived).toEqual({
      parent: TRANSMIT,
      parentName: "Kitty graphics transmit",
      parentRunId: "r1",
      parentReason: EFFECT,
      needs: "an image must be transmitted before it can be displayed",
      ownStatus: "untestable",
      ownReason: NO_SETUP,
    })
    expect(ctx.derivedIds).toEqual([DISPLAY])
    expect(ctx.counts.unsupported).toBe(2)
    expect(ctx.counts.untestable).toBe(0)
    const published = publicResults(project([measured]), new Map()).projection.contexts["term:xterm"]!
    expect(published.featureResults[DISPLAY]!.status).toBe("unsupported")
    expect(published.featureResults[DISPLAY]!.reason).toBe(
      `Unsupported, derived: Kitty graphics transmit was refused in run r1 (${EFFECT}); an image must be transmitted before it can be displayed.`,
    )
    expect(published.derivedIds).toEqual([DISPLAY])
  })

  it("counts a derived cell inside Unsupported, says so beside it, and never as a measurement (@cto 448e41b5)", () => {
    const projection = project([
      run("r1", {
        [TRANSMIT]: { status: "unsupported", witness: "effect" },
        [DISPLAY]: { status: "untestable", reason: NO_SETUP },
        "sgr.bold": { status: "untestable", reason: "Untestable (no way): declared" },
      }),
    ])
    const ctx = projection.contexts["term:xterm"]!
    expect(ctx.counts.unsupported).toBe(2)
    expect(ctx.derivedIds).toHaveLength(1)
    expect(decisiveCells(ctx.counts, ctx.derivedIds.length)).toBe(1)
    // The page bar path: an aggregate over the published feature results carries the same split.
    const published = publicResults(projection, new Map()).projection.contexts["term:xterm"]!
    const bar = aggregateCurrentResults(rollupInputs("term:xterm", published), published.catalogIds)
    expect(bar.counts.unsupported).toBe(2)
    expect(bar.derived).toBe(1)
    // #37341 D2: the readout is two counts; the derived split stays on the aggregate, not in the sentence.
    expect(currentCoverageSentence(bar, published.catalogIds)).toBe("3 of 3 tested")
    expect(runDecidedNothing(bar.counts, bar.derived)).toBe(false)
  })

  it("a run whose only Unsupported cells are derived decided nothing", () => {
    expect(
      runDecidedNothing({ supported: 0, unsupported: 2, untestable: 0, "probe-todo": 0, "probe-invalid": 0 }, 2),
    ).toBe(true)
  })

  it.each([
    ["untestable", { status: "untestable", reason: "Untestable (no way): declared" }],
    ["probe-invalid", { status: "probe-invalid", reason: "control failed" }],
    ["probe-todo", { status: "probe-todo", reason: "Not run" }],
    ["supported", { status: "supported" }],
  ] as const)("a %s parent entails nothing: the child keeps its own reading", (_label, parent) => {
    const ctx = context([run("r1", { [TRANSMIT]: parent, [DISPLAY]: { status: "untestable", reason: NO_SETUP } })])
    expect(ctx.cells[DISPLAY]!.featureResult!.status).toBe("untestable")
    expect(ctx.cells[DISPLAY]!.derived).toBeUndefined()
    expect(ctx.derivedIds).toEqual([])
  })

  it("a missing parent entails nothing", () => {
    const ctx = context([run("r1", { [DISPLAY]: { status: "untestable", reason: NO_SETUP } })])
    expect(ctx.cells[DISPLAY]!.featureResult!.status).toBe("untestable")
    expect(ctx.derivedIds).toEqual([])
  })

  it("a child already decided Unsupported stays direct", () => {
    const ctx = context([
      run("r1", { [TRANSMIT]: { status: "unsupported", witness: "effect" }, [DISPLAY]: { status: "unsupported" } }),
    ])
    expect(ctx.cells[DISPLAY]!.derived).toBeUndefined()
    expect(ctx.derivedIds).toEqual([])
  })

  it("a Supported child under a refused parent throws, naming the pair and @cto", () => {
    expect(() =>
      context([
        run("r1", { [TRANSMIT]: { status: "unsupported", witness: "effect" }, [DISPLAY]: { status: "supported" } }),
      ]),
    ).toThrow(
      /Derived pair extensions\.kitty-graphics\.transmit -> extensions\.kitty-graphics\.display in term:xterm: .*bring it to @cto/,
    )
  })

  it("a parent reopened by a ruling reads probe-todo, so the child is no longer derived", () => {
    const measured = run("r1", {
      [TRANSMIT]: { status: "unsupported", witness: "effect" },
      [DISPLAY]: { status: "untestable", reason: NO_SETUP },
    })
    const reopened: ReopenedCell = {
      kind: "term",
      id: "xterm",
      os: "linux",
      featureId: TRANSMIT,
      graded: "unsupported",
      reason: "withdrawn",
      reopenedOn: "2026-11-10",
      ruling: "test",
      evidence: "test",
      exit: { kind: "remeasured", suiteIds: [SUITE.probeHash] },
      witnesses: [{ runId: "r1", assertionIndex: 0 }],
    }
    const ctx = context([measured], [reopened])
    expect(ctx.cells[TRANSMIT]!.featureResult!.status).toBe("probe-todo")
    expect(ctx.cells[DISPLAY]!.featureResult!.status).toBe("untestable")
    expect(ctx.derivedIds).toEqual([])
  })

  it("never derives from a derived parent: a declared chain stops at the first link", () => {
    const chain = [
      { child: DISPLAY, parent: TRANSMIT, parentName: "transmit", needs: "a" },
      { child: "sgr.bold", parent: DISPLAY, parentName: "display", needs: "b" },
    ]
    const measured = run("r1", {
      [TRANSMIT]: { status: "unsupported", witness: "effect" },
      [DISPLAY]: { status: "untestable", reason: NO_SETUP },
      "sgr.bold": { status: "untestable", reason: "Untestable (no way): declared" },
    })
    const ctx = projectResults([measured], ids, { currentProbeHash: SUITE.probeHash, derived: chain }, []).contexts[
      "term:xterm"
    ]!
    expect(ctx.derivedIds).toEqual([DISPLAY])
    expect(ctx.cells["sgr.bold"]!.featureResult!.status).toBe("untestable")
  })

  describe("only an effect read entails (#38772, @cto b1a8ecea)", () => {
    const osc = (rows: Record<string, Row>) =>
      projectResults([run("r1", rows, OSC_IDS)], OSC_IDS, { currentProbeHash: "suite", reopened: [] }, []).contexts[
        "term:xterm"
      ]!
    const RESET_OPEN = "Untestable (no setup): OSC 117 needs a highlight background colour the run could read"

    it("an OSC 17 parent refused only by a fenced silence leaves osc117 at its own state", () => {
      const ctx = osc({ [OSC17]: { status: "unsupported" }, [OSC117]: { status: "untestable", reason: RESET_OPEN } })
      expect(ctx.cells[OSC17]!.featureResult!.status).toBe("unsupported")
      expect(ctx.cells[OSC117]!.featureResult!.status).toBe("untestable")
      expect(ctx.cells[OSC117]!.derived).toBeUndefined()
      expect(ctx.derivedIds).toEqual([])
    })

    it("the same parent refused by an effect read still derives osc117", () => {
      const ctx = osc({
        [OSC17]: { status: "unsupported", witness: "effect" },
        [OSC117]: { status: "untestable", reason: RESET_OPEN },
      })
      expect(ctx.cells[OSC117]!.featureResult).toMatchObject({ status: "unsupported", strength: null })
      expect(ctx.cells[OSC117]!.derived).toMatchObject({ parent: OSC17, parentReason: EFFECT, ownStatus: "untestable" })
      expect(ctx.derivedIds).toEqual([OSC117])
    })

    it("a silence-refused parent with a Supported child is no contradiction: the query is unanswered, not refused", () => {
      const ctx = osc({ [OSC17]: { status: "unsupported" }, [OSC117]: { status: "supported" } })
      expect(ctx.cells[OSC117]!.featureResult!.status).toBe("supported")
      expect(ctx.derivedIds).toEqual([])
    })

    it("a Kitty transmit refused only by silence derives no display cell", () => {
      const ctx = context([
        run("r1", { [TRANSMIT]: { status: "unsupported" }, [DISPLAY]: { status: "untestable", reason: NO_SETUP } }),
      ])
      expect(ctx.cells[DISPLAY]!.featureResult!.status).toBe("untestable")
      expect(ctx.derivedIds).toEqual([])
    })
  })

  it("every declared pair names features in the catalogue, and no child is its own parent", () => {
    for (const pair of DERIVED_UNSUPPORTED) {
      // #33441: a misspelt child silently never fires - applyDerived skips an id it cannot find - so membership is
      // asserted against the recorded catalogue itself, not against a second hand-kept list.
      expect(catalogue[pair.child], `${pair.child} must exist in the recorded catalogue`).toBeDefined()
      expect(catalogue[pair.parent], `${pair.parent} must exist in the recorded catalogue`).toBeDefined()
      expect(pair.child).not.toBe(pair.parent)
      expect(
        publicDerivedReason({
          ...pair,
          parentRunId: "r",
          parentReason: null,
          ownStatus: "untestable",
          ownReason: null,
        }),
      ).toMatch(/^Unsupported, derived: .+ was refused in run r; .+\.$/)
    }
    expect(new Set(DERIVED_UNSUPPORTED.map((pair) => pair.child)).size).toBe(DERIVED_UNSUPPORTED.length)
  })
})

describe("graded from parts: the OSC 52 umbrella reads its write and read rows (#38772, @cto 8cccf709)", () => {
  const W = "extensions.osc52-write"
  const R = "extensions.osc52-read"
  const C = "extensions.osc52-clipboard"
  const OSC52_IDS = [W, R, C]
  const OWN = "Isolated backend returned the exact OSC 52 clipboard nonce"
  const osc52 = (rows: Record<string, Row>) => {
    const projection = projectResults(
      [run("r1", rows, OSC52_IDS)],
      OSC52_IDS,
      { currentProbeHash: "suite", reopened: [] },
      [],
    )
    return { projection, ctx: projection.contexts["term:xterm"]! }
  }

  it("reads Supported only from both halves at defaults, never from its own probe, and cites both parts", () => {
    const { projection, ctx } = osc52({
      [W]: { status: "supported" },
      [R]: { status: "supported" },
      [C]: { status: "unsupported" },
    })
    const cell = ctx.cells[C]!
    expect(cell.featureResult).toMatchObject({ status: "supported", strength: null })
    expect(cell.result.status).toBe("unsupported")
    expect(cell.derived).toEqual({
      parts: [
        { feature: W, name: "OSC 52 write", runId: "r1", status: "supported", reason: null },
        { feature: R, name: "OSC 52 read", runId: "r1", status: "supported", reason: null },
      ],
      cites: W,
      words: "copy and paste-back both work at default settings (OSC 52 write and OSC 52 read)",
      ownStatus: "unsupported",
      ownReason: SILENCE,
    })
    expect(ctx.derivedIds).toEqual([C])
    const published = publicResults(projection, new Map()).projection.contexts["term:xterm"]!
    expect(published.featureResults[C]).toMatchObject({
      featureId: C,
      status: "supported",
      reason:
        "Graded from OSC 52 write and OSC 52 read in this context: copy and paste-back both work at default settings (OSC 52 write and OSC 52 read).",
      origin: { runId: "r1", resultId: W },
    })
    expect(published.featureResults[C]!.derived).not.toHaveProperty("ownStatus")
  })

  it("an app that reads only under a setting it doesn't ship with is Unsupported, naming the setting", () => {
    const { ctx } = osc52({
      [W]: { status: "supported" },
      [R]: { status: "supported", note: "allow: ghostty --clipboard-read=allow" },
      [C]: { status: "supported" },
    })
    expect(ctx.cells[C]!.featureResult!.status).toBe("unsupported")
    expect(ctx.cells[C]!.derived).toMatchObject({
      words: "copy works (OSC 52 write); reading is off by default (ghostty --clipboard-read=allow), see OSC 52 read",
    })
  })

  it("a refused write is Unsupported; an unmeasured half leaves it To do whatever its own probe read", () => {
    expect(
      osc52({ [W]: { status: "unsupported" }, [R]: { status: "supported" }, [C]: { status: "supported" } }).ctx.cells[
        C
      ]!.featureResult!.status,
    ).toBe("unsupported")
    const open = osc52({
      [W]: { status: "supported" },
      [R]: { status: "probe-todo", reason: "Not run" },
      [C]: { status: "supported" },
    }).ctx
    expect(open.cells[C]!.featureResult!.status).toBe("probe-todo")
    expect(open.cells[C]!.derived).toMatchObject({ words: "needs both halves measured: OSC 52 read is not decided" })
    const invalid = osc52({
      [W]: { status: "probe-invalid", reason: "bad" },
      [R]: { status: "supported" },
      [C]: { status: "supported" },
    }).ctx
    expect(invalid.cells[C]!.featureResult!.status).toBe("probe-todo")
  })

  it("a half that is itself Untestable makes it Untestable", () => {
    const { ctx } = osc52({
      [W]: { status: "supported" },
      [R]: { status: "untestable", reason: "no clipboard" },
      [C]: { status: "supported" },
    })
    expect(ctx.cells[C]!.featureResult!.status).toBe("untestable")
    expect(ctx.cells[C]!.derived).toMatchObject({ words: "OSC 52 read is untestable here" })
  })

  it("compares the halves on app version, OS and profile; a read run on its own named setting may differ in config", () => {
    const subject = (version: string, config: string) => ({ version, os: "linux", osVersion: "7.0.0", config })
    const reading = (reason: string | null): PartReading => ({
      feature: R,
      name: "OSC 52 read",
      runId: "r2",
      status: "supported",
      reason,
    })
    const write: PartReading = { feature: W, name: "OSC 52 write", runId: "r1", status: "supported", reason: null }
    const allow = "allow: ghostty --clipboard-read=allow"
    expect(
      partsComparable(
        [subject("1.4.0", "ghostty"), subject("1.4.0", "ghostty --clipboard-read=allow")],
        [write, reading(allow)],
      ),
    ).toBe(true)
    expect(
      partsComparable([subject("1.4.0", "ghostty"), subject("1.4.0", "ghostty --other")], [write, reading(null)]),
    ).toBe(false)
    expect(
      partsComparable(
        [subject("1.4.0", "ghostty"), subject("1.3.1", "ghostty --clipboard-read=allow")],
        [write, reading(allow)],
      ),
    ).toBe(false)
    expect(partsComparable([subject("1.4.0", "ghostty"), undefined], [write, reading(null)])).toBe(false)
  })

  it("a library is judged with its embedder's setting enabled; an app at its shipped defaults (@cpo/term 5483ec82)", () => {
    const part = (feature: string, status: string, reason: string | null = null): PartReading => ({
      feature,
      name: feature === W ? "OSC 52 write" : "OSC 52 read",
      runId: "r1",
      status,
      reason,
    })
    const harness = `${OWN}; read under harness-supplied osc52=CopyPaste; Alacritty's default OnlyCopy disables clipboard reads`
    expect(gradeOsc52Clipboard([part(W, "supported"), part(R, "supported", harness)], "lib")).toEqual({
      status: "supported",
      words: "copy and paste-back both work; reading needs the embedding app's setting (osc52=CopyPaste)",
      decidedBy: [0, 1],
    })
    expect(gradeOsc52Clipboard([part(W, "supported"), part(R, "supported", harness)], "term").status).toBe(
      "unsupported",
    )
    expect(
      gradeOsc52Clipboard([part(W, "supported"), part(R, "unsupported", "default deny: x")], "term"),
    ).toMatchObject({
      status: "unsupported",
      decidedBy: [1],
    })
  })
})
