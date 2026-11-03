/**
 * @failure The internal preview shows a half-written hourly run as newest, silently drops a missing or unreadable run,
 *   lets a raw (unreviewed) cell replace a reviewed headline, hides a same-suite disagreement, labels a pending source
 *   review as a failure, or lets raw cells move any accepted score, count or completeness rollup.
 * @level l2
 * @consumer docs/data/working-runs.ts, read by docs/data/full-project.data.ts (full-273 page) and scripts/generate-api.ts
 * @source-grep these are the first tests of the hourly working-run view; no existing test reads TERMINFO_SITE_WORKING_RUNS_DIR.
 * @testonly none
 */
import { createHash } from "node:crypto"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { LoadedRun } from "@terminfo/run-parser"
import type { ProbeStatus } from "@terminfo/probe-defs"
import { loadFeatures } from "@terminfo/catalog"
import { rollupTerminalStatuses } from "../docs/data/release-scope.ts"
import {
  RAW_LABEL,
  composeWorkingView,
  loadWorkingRun,
  newestCompleteRun,
  selectedSiteWorkingRun,
  workingCell,
  workingRunStamp,
  type LoadedWorkingRun,
} from "../docs/data/working-runs.ts"
import { compatibilitySubjects, loadCurrentResults } from "../docs/data/current-results.ts"
import { generateApi } from "./generate-api.ts"
import { loadRawCapture } from "../packages/admin/raw-capture.ts"

function runsDir(): string {
  return mkdtempSync(join(tmpdir(), "terminfo-working-runs-"))
}

function run(parent: string, name: string, summary?: unknown, cells = true): string {
  const dir = join(parent, name)
  mkdirSync(dir, { recursive: true })
  if (summary !== undefined) {
    writeFileSync(join(dir, "summary.json"), typeof summary === "string" ? summary : JSON.stringify(summary))
  }
  if (cells) writeFileSync(join(dir, "cells.json"), "{}")
  return dir
}

const OLD = "2026-11-02T19-34-05-072Z-e8437509ec6a"
const PARTIAL = "2026-11-02T20-34-05-309Z-75c7a72a53da"
const WRITING = "2026-11-02T21-34-03-594Z-2d0bc819ffc1"

describe("newestCompleteRun: the site reads the newest COMPLETE hourly run (requirement 2)", () => {
  it("skips a finished-partial run and a run still being written", () => {
    const parent = runsDir()
    run(parent, OLD, { complete: true })
    run(parent, PARTIAL, { complete: false }, false)
    run(parent, WRITING, undefined, false)
    expect(newestCompleteRun(parent)).toEqual({
      id: OLD,
      dir: join(parent, OLD),
      startedAt: "2026-11-02T19:34:05.072Z",
    })
  })

  it("refuses loudly when no run is complete", () => {
    const parent = runsDir()
    run(parent, WRITING, undefined, false)
    expect(() => newestCompleteRun(parent)).toThrow(`no complete hourly run in ${parent}`)
  })

  it("names a missing cells.json in a run that declares itself complete instead of silently selecting an older run", () => {
    const parent = runsDir()
    run(parent, OLD, { complete: true })
    run(parent, PARTIAL, { complete: true }, false)
    expect(() => newestCompleteRun(parent)).toThrow(join(parent, PARTIAL, "cells.json"))
  })

  it("refuses loudly when a newer run's summary is unreadable instead of skipping it", () => {
    const parent = runsDir()
    run(parent, OLD, { complete: true })
    run(parent, PARTIAL, "{ truncated")
    expect(() => newestCompleteRun(parent)).toThrow(join(parent, PARTIAL, "summary.json"))
  })

  it("refuses loudly when the runs directory is absent", () => {
    const parent = join(runsDir(), "missing")
    expect(() => newestCompleteRun(parent)).toThrow(parent)
  })

  it("leaves the site on accepted results only when the variable is unset", () => {
    expect(selectedSiteWorkingRun({})).toBeNull()
  })
})

describe("loadWorkingRun: a selected run's raw captures load loudly", () => {
  const root = join(import.meta.dirname, "..")
  const catalogIds = Object.keys(loadFeatures(join(root, "content")))
  // Reuse a real committed payload and its committed manifest. Only the hourly envelope is synthetic.
  function collection() {
    const parent = runsDir()
    const dir = run(parent, OLD, { complete: true })
    const headless = join(dir, "headless")
    mkdirSync(headless)
    const rawPath = join(headless, "vterm.draft.json")
    copyFileSync(
      join(root, "content/probes-libs/vterm-0.10.1-linux-a22f06ca-2505-4c0d-a518-b0b01f8bbe76.json"),
      rawPath,
    )
    // The committed payload predates #32246: its stored source-answer cells read TEST TODO (operator 2026-11-03),
    // so the hourly rollup this envelope carries is over the statuses the reader reads, not the stored ones.
    const payload = loadRawCapture(rawPath, { root, catalogIds }) as {
      results: Array<{ featureId: string; status: string }>
    }
    const summary = {
      complete: true,
      expectedEngines: ["vterm"],
      presentEngines: ["vterm"],
      missingEngines: [],
      refused: [],
      rollups: {
        vterm: rollupTerminalStatuses(
          Object.fromEntries(payload.results.map((r) => [r.featureId, r.status])),
          catalogIds,
        ),
      },
    }
    const collected = { directory: headless, requested: ["vterm"], runs: [rawPath], failures: [] }
    const save = () => {
      writeFileSync(join(dir, "summary.json"), JSON.stringify(summary))
      writeFileSync(join(headless, "collection.json"), JSON.stringify(collected))
    }
    save()
    return { parent, dir, summary, collected, save }
  }

  it("loads the current collection and summary rollups without the retired pass layout", () => {
    const fixture = collection()
    const loaded = loadWorkingRun(newestCompleteRun(fixture.parent), { root, catalogIds })
    expect(loaded.unreadable).toBeUndefined()
    expect(loaded.unmeasured).toEqual([])
    expect(loaded.runs).toHaveLength(1)
    expect(loaded.runs[0]?.subject.id).toBe("vterm")
    expect(loaded.runs[0]?.results).toHaveLength(273)
    expect(loaded.runs[0]?.runId).toBe("a22f06ca-2505-4c0d-a518-b0b01f8bbe76")
  })

  it("names a missing current collection", () => {
    const parent = runsDir()
    const dir = run(parent, OLD, { complete: true })
    expect(() => loadWorkingRun(newestCompleteRun(parent), { root, catalogIds })).toThrow(
      join(dir, "headless/collection.json"),
    )
  })

  it.each(["absent", "outside"])("refuses a capture that is %s from its run directory", (kind) => {
    const fixture = collection()
    fixture.collected.runs = [kind === "outside" ? "/etc/passwd" : join(fixture.dir, "missing.draft.json")]
    fixture.save()
    expect(() => loadWorkingRun(newestCompleteRun(fixture.parent), { root, catalogIds })).toThrow(
      "outside the run directory or absent",
    )
  })

  it.each(["missing rollup", "wrong counts", "missing engine", "collection failure"])(
    "refuses a complete envelope with %s",
    (kind) => {
      const fixture = collection()
      if (kind === "missing rollup") Reflect.deleteProperty(fixture.summary.rollups, "vterm")
      if (kind === "wrong counts") fixture.summary.rollups.vterm.counts.supported++
      if (kind === "missing engine") fixture.collected.runs = []
      if (kind === "collection failure") {
        Reflect.set(fixture.collected, "failures", [{ engine: "vterm", error: "refused" }])
      }
      fixture.save()
      expect(() => loadWorkingRun(newestCompleteRun(fixture.parent), { root, catalogIds })).toThrow(
        kind === "wrong counts" ? "rollup" : kind === "missing rollup" ? "rollup" : "complete",
      )
    },
  )
})

const raw = (status: ProbeStatus, criterionBranch?: string, version = "1.0") => ({
  featureId: "a.one",
  status,
  ...(criterionBranch && { criterionBranch }),
  runId: "raw-run",
  suiteId: "suite-new",
  version,
  measuredAt: "2026-11-02T21:36:00.000Z",
})
const reviewed = (status: ProbeStatus, suiteId = "suite-new", criterionBranch?: string, version = "1.0") => ({
  status,
  ...(criterionBranch && { criterionBranch }),
  runId: "accepted-run",
  suiteId,
  version,
  measuredAt: "2026-10-20T00:00:00.000Z",
  suiteLabel: `older suite ${suiteId}`,
})

describe("workingCell: reviewed stays the headline, raw sits beside it (requirement 3)", () => {
  it("keeps the reviewed answer as headline and labels the raw cell beside it", () => {
    const cell = workingCell(raw("supported"), reviewed("supported"))
    expect(cell.headline).toBe("reviewed")
    expect(cell.relation).toBe("same-suite")
    expect(cell.reviewed?.status).toBe("supported")
    expect(cell.raw).toMatchObject({
      label: RAW_LABEL,
      runId: "raw-run",
      suiteId: "suite-new",
      differsFromReviewed: false,
    })
    expect(RAW_LABEL).toBe("raw, unreviewed")
  })

  it("marks a same-suite disagreement as differing from reviewed", () => {
    const cell = workingCell(raw("unsupported"), reviewed("supported"))
    expect(cell.headline).toBe("reviewed")
    expect(cell.raw.differsFromReviewed).toBe(true)
  })

  it("keeps the reviewed older-suite label on a different suite and never claims a disagreement there", () => {
    const cell = workingCell(raw("unsupported"), reviewed("supported", "suite-old"))
    expect(cell.relation).toBe("different-suite")
    expect(cell.headline).toBe("reviewed")
    expect(cell.reviewed?.suiteLabel).toBe("older suite suite-old")
    expect(cell.raw.differsFromReviewed).toBe(false)
  })

  it("labels a raw-only answer raw, unreviewed", () => {
    const cell = workingCell(raw("supported"), undefined)
    expect(cell.relation).toBe("raw-only")
    expect(cell.headline).toBe("raw")
    expect(cell.reviewed).toBeNull()
    expect(cell.raw.label).toBe("raw, unreviewed")
  })

  it("labels a pending source review as pending review, not failure", () => {
    const cell = workingCell(raw("test-failure", "source-negative-review"), undefined)
    expect(cell.raw.pendingReview).toBe(true)
    expect(cell.raw.display).toBe("pending review")
    expect(cell.raw.status).toBe("test-failure")
  })

  // @cto REVISE R1 (11b52b66d): a REVIEWED answer keeps its source-negative-review branch (run-parser seals e.g. vterm
  // kitty-click as unsupported through it); only a still-open TODO/FAILURE on that branch is pending.
  it("shows a reviewed unsupported-by-source-review answer as unsupported", () => {
    const cell = workingCell(raw("unsupported"), reviewed("unsupported", "suite-new", "source-negative-review"))
    expect(cell.reviewed?.display).toBe("unsupported")
  })

  it("shows a pending raw cell beside it as pending review, never as differing", () => {
    const cell = workingCell(
      raw("test-failure", "source-negative-review"),
      reviewed("unsupported", "suite-new", "source-negative-review"),
    )
    expect(cell.reviewed?.display).toBe("unsupported")
    expect(cell.raw.display).toBe("pending review")
    expect(cell.raw.pendingReview).toBe(true)
    expect(cell.raw.differsFromReviewed).toBe(false)
  })

  // @cto REVISE R2: "differs" needs the same suite AND the same engine version.
  it("never marks a same-suite disagreement across engine versions as differing, and carries both versions", () => {
    const cell = workingCell(
      raw("unsupported", undefined, "0.16.2"),
      reviewed("supported", "suite-new", undefined, "0.15.0"),
    )
    expect(cell.relation).toBe("same-suite")
    expect(cell.raw.differsFromReviewed).toBe(false)
    expect(cell.raw.version).toBe("0.16.2")
    expect(cell.reviewed?.version).toBe("0.15.0")
  })
})

describe("raw cells never enter an accepted rollup (requirement 3)", () => {
  it("leaves the accepted projection and every accepted api/v3 field unchanged when a working run is added", () => {
    const contentDir = join(import.meta.dirname, "..", "content")
    const { projection } = loadCurrentResults(contentDir)
    const compat = compatibilitySubjects(projection, contentDir)
    const entry = [...compat.values()].find((candidate) => Object.keys(candidate.selected.cells).length >= 2)
    if (!entry?.selected.subject) throw new Error("fixture has no reviewed context with two cells")
    const [first, second] = Object.values(entry.selected.cells)
    if (!first || !second) throw new Error("fixture context lacks cells")
    const flip = (status: ProbeStatus): ProbeStatus => (status === "supported" ? "unsupported" : "supported")
    const reviewedRun = {
      runId: "hourly-reviewed-subject",
      probeHash: first.run.probeHash,
      suiteId: first.run.suiteId,
      sourceRevision: "0".repeat(40),
      measuredAt: "2026-11-02T21:36:00.000Z",
      subject: { ...entry.selected.subject, version: first.run.subject.version },
      results: [
        { featureId: first.result.featureId, status: first.result.status, attempt: { scope: "none" }, tests: [] },
        {
          featureId: second.result.featureId,
          status: flip(second.result.status),
          attempt: { scope: "none" },
          tests: [],
        },
      ],
    } as unknown as LoadedRun
    const rawOnly = {
      runId: "hourly-raw-only",
      probeHash: "aaaaaaaaaaaa",
      suiteId: "aaaaaaaaaaaa",
      sourceRevision: "0".repeat(40),
      measuredAt: "2026-11-02T21:37:00.000Z",
      subject: {
        kind: "lib",
        id: "vt100-hourly-only",
        version: "1",
        os: "linux",
        osVersion: "k",
        outerTerminal: null,
        mux: null,
        config: null,
        permissions: null,
      },
      results: [
        { featureId: "sgr.bold", status: "supported", attempt: { scope: "none" }, tests: [] },
        { featureId: "sgr.faint", status: "test-todo", attempt: { scope: "none" }, tests: [] },
        { featureId: "device.env-term", status: "supported", attempt: { scope: "none" }, tests: [] },
      ],
    } as unknown as LoadedRun
    const working: LoadedWorkingRun = {
      id: OLD,
      dir: "/nonexistent",
      startedAt: "2026-11-02T19:34:05.072Z",
      runs: [reviewedRun, rawOnly],
      unmeasured: [],
    }
    // The accepted rollups a page or api reads: per context counts, score, completeness, contributors and statuses.
    // (Never JSON.stringify the contexts themselves: each cell holds its whole run, raw replies included.)
    const rollups = (): string =>
      JSON.stringify(
        Object.entries(projection.contexts).map(([key, context]) => [
          key,
          context.counts,
          context.score,
          context.complete,
          context.contributingRunIds,
          Object.entries(context.cells).map(([id, cell]) => [id, cell.origin.runId, cell.result.status]),
        ]),
      )
    const before = rollups()
    const view = composeWorkingView(projection, compat, working)
    expect(rollups()).toBe(before)
    const context = view.contexts.find((row) => row.runId === "hourly-reviewed-subject")
    expect(context?.reviewedContextKey).toBe(entry.contextKey)
    expect(context?.cells[0]).toMatchObject({ headline: "reviewed", relation: "same-suite" })
    expect(context?.cells[1]?.raw.differsFromReviewed).toBe(true)
    const only = view.contexts.find((row) => row.runId === "hourly-raw-only")
    expect(only?.contextKey).toMatch(/^lib:vt100-hourly-only@\[/)
    expect(only?.cells[0]).toMatchObject({ headline: "raw", relation: "raw-only" })
    // Raw owns its counts; an environment row remains visible but is not a graded position.
    // Existing byte parity alone would pass if the hourly card never counted any results.
    expect(only).toMatchObject({
      positions: 2,
      counts: {
        supported: 1,
        unsupported: 0,
        untestable: 0,
        "test-todo": 1,
        "test-failure": 0,
      },
    })
    rawOnly.results![0]!.status = "unsupported"
    const changed = composeWorkingView(projection, compat, working).contexts.find((row) => row.runId === rawOnly.runId)
    expect(changed).toMatchObject({
      positions: 2,
      counts: {
        supported: 0,
        unsupported: 1,
        untestable: 0,
        "test-todo": 1,
        "test-failure": 0,
      },
    })
    expect(rollups()).toBe(before)
    expect(view.run).toMatchObject({ id: OLD, startedAt: "2026-11-02T19:34:05.072Z" })

    // Byte comparison of the two data.json documents: every accepted field identical, `working` only added.
    const plain = readFileSync(
      generateApi(mkdtempSync(join(tmpdir(), "terminfo-api-plain-")), { contentDir, working: null }).dataPath,
      "utf8",
    )
    const withRaw = JSON.parse(
      readFileSync(
        generateApi(mkdtempSync(join(tmpdir(), "terminfo-api-raw-")), { contentDir, working }).dataPath,
        "utf8",
      ),
    ) as Record<string, unknown>
    expect(plain).not.toContain('"working"')
    expect(withRaw.working).toMatchObject({ label: RAW_LABEL, run: { id: OLD } })
    const apiWorking = withRaw.working as { contexts: Array<Record<string, unknown>> }
    expect(apiWorking.contexts).toHaveLength(2)
    expect(apiWorking.contexts.find((context) => context.runId === rawOnly.runId)?.cells).toEqual(changed?.cells)
    expect(
      apiWorking.contexts.every((context) => !Object.hasOwn(context, "counts") && !Object.hasOwn(context, "positions")),
    ).toBe(true)
    delete withRaw.working
    expect(
      createHash("sha256")
        .update(`${JSON.stringify(withRaw)}\n`)
        .digest("hex"),
    ).toBe(createHash("sha256").update(plain).digest("hex"))
  }, 300_000)
})

/**
 * Coordinator 2026-11-02: right after a landing changes probe sources, the newest hourly run is on the previous suite,
 * which has no trusted manifest in the new tree. The build must still succeed with accepted bytes unchanged, and say
 * so loudly (banner + stamp) instead of failing every code restart until the next hourly run.
 */
describe("an hourly run on a suite this build cannot trust", () => {
  function untrustedRun(draft: string): ReturnType<typeof newestCompleteRun> {
    const parent = runsDir()
    const dir = run(parent, OLD, {
      complete: true,
      expectedEngines: ["kitty"],
      presentEngines: ["kitty"],
      missingEngines: [],
      refused: [],
      rollups: { kitty: rollupTerminalStatuses({}, []) },
    })
    mkdirSync(join(dir, "headless"))
    const rawRun = join(dir, "headless", "kitty.draft.json")
    writeFileSync(rawRun, draft)
    writeFileSync(
      join(dir, "headless", "collection.json"),
      JSON.stringify({ directory: join(dir, "headless"), requested: ["kitty"], runs: [rawRun], failures: [] }),
    )
    return newestCompleteRun(parent)
  }
  const root = join(import.meta.dirname, "..")

  it("builds with a loud banner and stamp, and leaves every accepted api/v3 byte unchanged", () => {
    const suite = "000000000000"
    const loaded = loadWorkingRun(
      untrustedRun(JSON.stringify({ runId: "r", probeHash: suite, suiteId: suite, sourceRevision: "s" })),
      { root, catalogIds: [] },
    )
    expect(loaded.runs).toEqual([])
    const tree = loaded.unreadable?.treeSuiteId
    expect(tree).toMatch(/^[0-9a-f]{12}$/)
    expect(loaded.unreadable?.banner).toBe(
      `Hourly run ${OLD} (suite ${suite}) cannot be read by this build: no trusted manifest for that suite; ` +
        `next hourly run on suite ${tree} will show`,
    )
    expect(loaded.unreadable?.reason).toContain(`suite ${suite} has no committed manifest`)
    expect(workingRunStamp(loaded)).toEqual({
      id: OLD,
      startedAt: "2026-11-02T19:34:05.072Z",
      unreadable: loaded.unreadable?.reason,
    })

    const contentDir = join(root, "content")
    const plain = readFileSync(
      generateApi(mkdtempSync(join(tmpdir(), "terminfo-api-plain-")), { contentDir, working: null }).dataPath,
      "utf8",
    )
    const banner = JSON.parse(
      readFileSync(
        generateApi(mkdtempSync(join(tmpdir(), "terminfo-api-banner-")), { contentDir, working: loaded }).dataPath,
        "utf8",
      ),
    ) as Record<string, unknown>
    expect(banner.working).toMatchObject({ contexts: [], unreadable: { banner: loaded.unreadable?.banner } })
    expect(Object.keys(banner.contexts as Record<string, unknown>).length).toBeGreaterThan(0)
    delete banner.working
    expect(
      createHash("sha256")
        .update(`${JSON.stringify(banner)}\n`)
        .digest("hex"),
    ).toBe(createHash("sha256").update(plain).digest("hex"))
  }, 300_000)

  it("keeps every other capture error a hard failure", () => {
    expect(() => loadWorkingRun(untrustedRun("{ truncated"), { root, catalogIds: [] })).toThrow("kitty.draft.json")
  })
})
