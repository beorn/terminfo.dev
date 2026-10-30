/**
 * @failure The full-scope preview could print a context with no evidence as zero percent or as
 *   included, hide a context it cannot score, drop catalog rows from the basis, or disagree with the
 *   one arithmetic owner about S/D and D/N — each of which turns an honest incomplete development
 *   state into a claim the admitted pass has not made.
 * @level l2
 * @consumer terminfo.dev /release/full-273 (step 7 private development preview)
 * @source-grep the page is wired by text (its data import and its unadmitted warning), so only a
 *   site build exercises the render; every assertion here runs the real loader and its rows.
 * @testonly none
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as currentResults from "../docs/data/current-results.ts"
import * as publicResults from "../docs/data/public-results.ts"
import * as fullProject from "../docs/data/full-project.ts"
import { scopeAggregate } from "../docs/data/full-scope.ts"
import * as versions from "../packages/admin/versions.ts"
import type { LoadedRun } from "@terminfo/run-parser"
import type { ProbeResult } from "@terminfo/probe-defs"
import type { SelectedContextSummary, CurrentSelectedVersion } from "../docs/data/selected-results.ts"
import { loadFullProjectData } from "../docs/data/full-project.data.ts"

const root = join(import.meta.dirname, "..")
const data = loadFullProjectData()

describe("the full-273 preview", () => {
  it("covers all 273 catalog rows over all 33 expected contexts", () => {
    expect(data.catalogRows).toBe(273)
    expect(data.contexts).toHaveLength(33)
    expect(data.collected + data.notCollected).toBe(33)
  })

  it("prints Supported over all 273 and finishes only at zero TODO/failure", () => {
    for (const row of data.contexts) {
      if (!row.collected) continue
      const { result } = row
      expect(result.catalogRows).toBe(273)
      // D132 B (#30917): the run records all 273 positions, but the score is over the graded
      // catalogue — the nine environment groups are visible and never in the denominator. The page
      // states the same rule (docs/release/full-273.md: "Supported / all <gradedRows> graded features").
      expect(result.denominator).toBe(data.gradedRows)
      expect(result.fraction).toBe(`${result.supported}/${data.gradedRows}`)
      expect(result.complete).toBe(result.counts["test-todo"] === 0 && result.counts["test-failure"] === 0)
      expect(result.groups.reduce((sum, group) => sum + group.catalogRows, 0)).toBe(273)
    }
  })

  it("never scores a context it could not collect", () => {
    for (const row of data.contexts) {
      if (row.collected) continue
      expect(row.cause.trim()).not.toBe("")
      expect("result" in row).toBe(false)
    }
  })

  // The wholly-empty corpus witness lives with the row builder that owns it
  // (scripts/full-project.test.ts, "keeps an all-history corpus incomplete without inventing a
  // current score"): this page test reads the live corpus, which now holds a first collected
  // context, so it asserts the same properties without pinning a count that content keeps moving.
  it("keeps the live reading's evidence and completeness tied to the contexts it collected", () => {
    const collected = data.contexts.filter((row) => row.collected)
    expect(Object.keys(data.evidenceContexts).sort()).toEqual(collected.map((row) => row.context).sort())
    expect(data.recordedPositions).toBe(collected.reduce((sum, row) => sum + row.result.catalogRows, 0))
    expect(data.complete).toBe(
      data.contexts.length > 0 && data.notCollected === 0 && collected.every((row) => row.result.complete),
    )
  })

  // Accepted requirement: composed cells retain original receipts and off-suite holds.
  // A single context-level run receipt cannot prove either retained-cell property.
  it("retains original source receipts and marks off-suite observations as held", () => {
    for (const row of data.contexts) {
      if (!row.collected) continue
      const context = data.evidenceContexts[row.context]
      expect(context?.contextKey).toBe(row.selection.contextKey)
      expect(Object.keys(context?.sources ?? {}).sort()).toEqual(row.sources.map((source) => source.runId).sort())
      expect([...row.heldIds].sort()).toEqual(
        row.observations
          .filter((observation) => observation.hold)
          .map((observation) => observation.id)
          .sort(),
      )
      for (const observation of row.observations) {
        const cell = context?.cells[observation.id]
        expect(cell, `${row.context} ${observation.id}`).toBeDefined()
        expect(cell?.origin).toEqual(observation.origin)
        expect(cell?.status).toBe(observation.state)
        const source = context?.sources[observation.origin.runId]
        expect(source?.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(source?.suiteId).toBe(observation.suiteId)
        expect(source?.measuredAt).toBe(observation.measuredAt)
        if (observation.suiteId !== data.suiteId) {
          expect(observation.hold).toBe(
            `retained from suite ${observation.suiteId}, measured ${observation.measuredAt}; not release evidence`,
          )
          expect(row.heldIds).toContain(observation.id)
        } else {
          expect(observation.hold).toBeUndefined()
        }
      }
    }
  })

  it("renders both the observation note and its named limitation", () => {
    const page = readFileSync(join(root, "docs", "release", "full-273.md"), "utf8")
    expect(page).toContain("observation.note")
    expect(page).toContain("observation.reason")
    expect(page).toContain("limitation:")
  })

  it("keeps the whole reading labelled development and unadmitted", () => {
    expect(data.mode).toBe("development")
    const page = readFileSync(join(root, "docs", "release", "full-273.md"), "utf8")
    expect(page).toContain("import { data } from '../data/full-project.data'")
    expect(page).toContain("Development reading")
    expect(page).toContain("NOT COLLECTED")
  })
})

// AC1/2/3, CTOa3360fa7/5af532bb: fixture selected receipts vary against the immutable
// technical-owner DATA snapshot. The real corpus cannot witness each stale identity arm.
describe("accepted tool-gap metadata in the existing private preview", () => {
  afterEach(() => vi.restoreAllMocks())

  function fixture() {
    const ids = ["extensions.osc1-icon", "device.primary-da", "a.done", "device.env-term"]
    const rows: fullProject.FullContextRow[] = []
    const contexts: Record<string, SelectedContextSummary> = {}
    const published: Record<string, publicResults.PublicContextSummary> = {}
    const history: Record<string, CurrentSelectedVersion[]> = {}
    const suite = "c7df853eef35"
    for (let index = 0; index < 11; index++) {
      const engine = index === 0 ? "libvterm" : "fixture-engine-" + index
      const contextKey = "lib:" + engine
      const results: ProbeResult[] = ids.map((featureId, n) => ({
        featureId,
        status: n === 2 ? "untestable" : "test-todo",
        attempt: { scope: "none" },
        tests: [],
        reason: "recorded-" + n,
      }))
      // Explicit loader-input fixture, not a parsed or admitted product result.
      const run = {
        runId: index === 0 ? "959ccc7dfdd25375a9922b33286f7180" : "fixture-run-" + index,
        suiteId: suite,
        sha256:
          index === 0
            ? "ebba95d6da8e6efa8fa8e80bf522de1af1f560fd968897eadf28a28b7780a9fe"
            : String(index).padStart(64, "0"),
        sourceRevision: "0df200f426a0adf5b4518eb38a7474bbd4bc5abe",
        measuredAt: "2026-10-29T22:37:32.875Z",
        subject: { kind: "lib", id: engine, version: "0.3.3", os: "linux", permissions: null },
        runtimeIdentity: {
          engineVersion: "0.3.3",
          termlessRevision: "cd5cd5172680fd240ee3445dea96289793bc2d59",
          loadedBinary: { sha256: "5937bd79139ee5856bcf1bd619cc44fcd2d750d3def3066a74956678cdaaaeb2" },
        },
        results,
      } as unknown as LoadedRun
      const cells = Object.fromEntries(
        results.map((result) => [
          result.featureId,
          { origin: { runId: run.runId, resultId: result.featureId }, result, run },
        ]),
      )
      const aggregate = scopeAggregate({ scope: contextKey, catalogIds: ids, results })
      contexts[contextKey] = {
        contextKey,
        subject: run.subject,
        cells,
        contributingRunIds: [run.runId],
        catalogIds: ids,
        attempts: [],
        missingIds: [],
        counts: aggregate.counts,
        score: { supported: 0, all: 3 },
        complete: false,
      }
      history[contextKey] = [run as unknown as CurrentSelectedVersion]
      published[contextKey] = {
        cells: Object.fromEntries(results.map((result) => [result.featureId, result])),
      } as unknown as publicResults.PublicContextSummary
      rows.push({
        context: engine + "/headless",
        terminalId: engine,
        os: "headless",
        kind: "lib",
        collected: true,
        selection: { contextKey, method: "only current" },
        sources: [{ runId: run.runId, suiteId: run.suiteId, measuredAt: run.measuredAt, suiteRelation: "tree" }],
        heldIds: [],
        result: aggregate,
        observations: results.map((cell) => ({
          id: cell.featureId,
          state: cell.status,
          method: null,
          note: null,
          reason: cell.reason ?? null,
          origin: cells[cell.featureId]!.origin,
          suiteId: run.suiteId,
          measuredAt: run.measuredAt,
        })),
      })
    }
    vi.spyOn(versions, "probeHash").mockReturnValue(suite)
    vi.spyOn(currentResults, "loadCurrentResults").mockReturnValue({
      projection: { contexts, history, versions: history },
    } as ReturnType<typeof currentResults.loadCurrentResults>)
    vi.spyOn(currentResults, "compatibilitySubjects").mockReturnValue(new Map())
    vi.spyOn(publicResults, "publicResults").mockReturnValue({ projection: { contexts: published } } as ReturnType<
      typeof publicResults.publicResults
    >)
    vi.spyOn(fullProject, "buildFullProjectRows").mockImplementation(() => ({
      contexts: structuredClone(rows),
      catalogRows: 4,
      gradedRows: 3,
      environmentGroups: 1,
      collected: rows.filter((row) => row.collected).length,
      notCollected: rows.filter((row) => !row.collected).length,
      complete: false,
      recordedPositions: 44,
      requiredSuiteId: suite,
    }))
    return { rows, contexts, source: contexts["lib:libvterm"]!.cells[ids[0]!]!.run }
  }

  it("folds the owner-authored population and annotates only its exact cell among eleven libraries", () => {
    const f = fixture(),
      before = JSON.stringify(f.contexts)
    const output = loadFullProjectData()
    expect(output.toolGaps).toMatchObject({
      authorityPath: "docs/data/full-project.data.ts",
      authoritySha256: "aeaaefbd91bc6d34a6cd6057590fd1234912e2c10ed239b11ec6fa08085e32ad",
      membershipComplete: false,
      namedTodo: 1,
      unnamedTodo: 21,
      failures: 0,
      eligibleForConsideration: false,
      classes: [{ name: "icon-name state", accepted: 1, matched: 1 }],
    })
    const named = output.contexts.flatMap((row) =>
      row.collected ? row.observations.filter((cell) => cell.note !== null) : [],
    )
    expect(named).toHaveLength(1)
    expect(named[0]).toMatchObject({
      state: "test-todo",
      note: "Our libvterm adapter does not expose the engine's icon-name callback state.",
      reason: "recorded-0",
    })
    expect(JSON.stringify(f.contexts)).toBe(before)
    expect(output.complete).toBe(false)
    expect(
      output.contexts.every(
        (row) => row.collected && row.observations[2]?.state === "untestable" && row.observations[3]?.note === null,
      ),
    ).toBe(true)
  })

  it.each(["suiteId", "runId", "sha256", "sourceRevision", "measuredAt"] as const)(
    "does not borrow an accepted row with a stale selected %s",
    (key) => {
      const f = fixture()
      f.source[key] = "stale"
      if (key === "runId") {
        const context = f.contexts["lib:libvterm"]!
        context.contributingRunIds = ["stale"]
        for (const cell of Object.values(context.cells)) cell.origin.runId = "stale"
        const row = f.rows[0]
        if (!row?.collected) throw new Error("fixture row missing")
        row.sources[0]!.runId = "stale"
        for (const observation of row.observations) observation.origin.runId = "stale"
      }
      expect(loadFullProjectData().toolGaps).toMatchObject({
        namedTodo: 0,
        unnamedTodo: 22,
        eligibleForConsideration: false,
        classes: [{ name: "icon-name state", accepted: 1, matched: 0 }],
      })
    },
  )

  it("requires exact engine, version, adapter and loaded artifact identity", () => {
    const f = fixture()
    f.source.subject.version = "stale"
    expect(loadFullProjectData().toolGaps.namedTodo).toBe(0)
    f.source.subject.version = "0.3.3"
    if (!f.source.runtimeIdentity) throw new Error("fixture runtime missing")
    f.source.runtimeIdentity.termlessRevision = "stale"
    expect(loadFullProjectData().toolGaps.namedTodo).toBe(0)
    f.source.runtimeIdentity.termlessRevision = "cd5cd5172680fd240ee3445dea96289793bc2d59"
    if (!("loadedBinary" in f.source.runtimeIdentity) || !f.source.runtimeIdentity.loadedBinary) {
      throw new Error("fixture binary missing")
    }
    f.source.runtimeIdentity.loadedBinary.sha256 = "stale"
    expect(loadFullProjectData().toolGaps.namedTodo).toBe(0)
  })

  it("keeps a matching FAIL unannotated and blocks the cut", () => {
    const f = fixture(),
      first = f.rows[0]
    if (!first?.collected) throw new Error("fixture first row missing")
    first.observations[0]!.state = "test-failure"
    f.source.results![0]!.status = "test-failure"
    expect(loadFullProjectData().toolGaps).toMatchObject({
      namedTodo: 0,
      unnamedTodo: 21,
      failures: 1,
      eligibleForConsideration: false,
    })
    expect(loadFullProjectData().contexts[0]).toMatchObject({ observations: [{ note: null }, {}, {}, {}] })
  })

  it("never treats the incomplete authority population or a missing library context as eligible", () => {
    const f = fixture()
    for (const row of f.rows) {
      if (row.collected) {
        for (const cell of row.observations) {
          if (cell.id === "device.primary-da") cell.state = "untestable"
        }
      }
    }
    expect(loadFullProjectData().toolGaps).toMatchObject({
      namedTodo: 1,
      unnamedTodo: 10,
      eligibleForConsideration: false,
    })
    f.rows[0] = {
      context: "libvterm/headless",
      terminalId: "libvterm",
      os: "headless",
      kind: "lib",
      collected: false,
      cause: "no selected run",
    }
    expect(loadFullProjectData().toolGaps.eligibleForConsideration).toBe(false)
  })
})
