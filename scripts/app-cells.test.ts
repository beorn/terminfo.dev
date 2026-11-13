/**
 * @failure  Two contexts' cells for a row join although the app version, the row's catalogue entry hash or the
 *           row's defining probe-defs file differs; a refused row merges a grade from the other context or does
 *           not name why it was refused; two contexts that both recorded nothing join on the shared absence;
 *           two disagreeing decided grades read decided; a reopened cell is decided by a context that never had
 *           the ruling; or the site's primary, and so a refused row's grade, depends on run arrival order.
 * @level    l1
 * @consumer Site selection join and pick: the per-row join and run-order-independent pick (33587, @cto d805d1af).
 * @testonly none
 */
/**
 * The join that publishes one app's cells, row by row, from every context whose cell passes the three tests
 * (equal app version, equal catalogue entry hash, byte-equal defining file), and the pick that names the primary.
 */
import { describe, expect, it } from "vitest"
import {
  joinContextCells,
  type ContextCellFacts,
  type ContextFacts,
  type DefinitionCheck,
} from "../docs/data/app-cells.ts"
import { pickContextRun, type ContextCandidate, type LineageRun } from "../docs/data/run-selection.ts"

const REV_A = "a".repeat(40)
const REV_B = "b".repeat(40)
const SAME = "suite-aaa"
const OTHER = "suite-bbb"
const cell = (status: ContextCellFacts["status"], over: Partial<ContextCellFacts> = {}): ContextCellFacts => ({
  status,
  version: "1.0.0",
  suite: SAME,
  entryHash: "entry-1",
  sourceRevision: REV_A,
  runId: `${status}-run`,
  ...over,
})
const context = (key: string, cells: Record<string, ContextCellFacts | undefined>): ContextFacts => ({ key, cells })
/** Every defining file is byte-equal: the join decides on version and entry hash alone. */
const sameFile: DefinitionCheck = () => null
/** The defining file changed between REV_A and REV_B for every row. */
const changedFile: DefinitionCheck = (featureId, left, right) =>
  left === right ? null : `packages/probe-defs/src/${featureId.split(".")[0]}.ts differs between ${left} and ${right}`

describe("joinContextCells", () => {
  it("keeps one decided grade when every joined context agrees", () => {
    const joined = joinContextCells(
      context("primary", { "sgr.blink": cell("supported", { runId: "r1" }) }),
      [context("second", { "sgr.blink": cell("supported", { runId: "r2" }) })],
      ["sgr.blink"],
      sameFile,
    )
    expect(joined.cells["sgr.blink"]?.status).toBe("supported")
    expect(joined.cells["sgr.blink"]?.from.map((source) => source.runId)).toEqual(["r1", "r2"])
    expect(joined.contexts).toEqual(["primary", "second"])
  })

  it("joins two contexts on different suites when the row's entry hash and defining file are equal", () => {
    const joined = joinContextCells(
      context("hosted", { "cursor.hide": cell("probe-todo", { runId: "r1" }) }),
      [context("owned", { "cursor.hide": cell("supported", { suite: OTHER, sourceRevision: REV_B, runId: "r2" }) })],
      ["cursor.hide"],
      sameFile,
    )
    expect(joined.cells["cursor.hide"]).toMatchObject({
      status: "supported",
      from: [{ context: "owned", status: "supported", runId: "r2" }],
      refused: [],
    })
  })

  it("reads open probe-conflict and names both contexts when two joined contexts decided differently", () => {
    const joined = joinContextCells(
      context("primary", { "input.xtest-key": cell("supported", { runId: "r1" }) }),
      [context("second", { "input.xtest-key": cell("unsupported", { runId: "r2" }) })],
      ["input.xtest-key"],
      sameFile,
    )
    expect(joined.cells["input.xtest-key"]?.status).toBe("probe-conflict")
    expect(joined.cells["input.xtest-key"]?.from).toEqual([
      { context: "primary", status: "supported", runId: "r1" },
      { context: "second", status: "unsupported", runId: "r2" },
    ])
    expect(joined.counts["probe-conflict"]).toBe(1)
    expect(joined.counts["differs-by-context"]).toBe(0)
    expect(joined.counts.supported).toBe(0)
  })

  it("takes the decided grade when the other joined context only left it to do", () => {
    const joined = joinContextCells(
      context("primary", { "modes.focus-tracking": cell("probe-todo") }),
      [context("second", { "modes.focus-tracking": cell("supported", { runId: "r2" }) })],
      ["modes.focus-tracking"],
      sameFile,
    )
    expect(joined.cells["modes.focus-tracking"]?.status).toBe("supported")
    expect(joined.cells["modes.focus-tracking"]?.from.map((source) => source.context)).toEqual(["second"])
  })

  it("reads Invalid and names the context that errored when nothing is decided", () => {
    const joined = joinContextCells(
      context("primary", { "scrollback.total-lines": cell("probe-todo") }),
      [context("second", { "scrollback.total-lines": cell("probe-invalid", { runId: "r2" }) })],
      ["scrollback.total-lines"],
      sameFile,
    )
    expect(joined.cells["scrollback.total-lines"]?.status).toBe("probe-invalid")
    expect(joined.cells["scrollback.total-lines"]?.from).toEqual([
      { context: "second", status: "probe-invalid", runId: "r2" },
    ])
  })

  it("lets Conflicting outrank Invalid when nothing is decided", () => {
    const joined = joinContextCells(
      context("primary", { "sgr.bg.bright": cell("probe-conflict", { runId: "r1" }) }),
      [context("second", { "sgr.bg.bright": cell("probe-invalid", { runId: "r2" }) })],
      ["sgr.bg.bright"],
      sameFile,
    )
    expect(joined.cells["sgr.bg.bright"]?.status).toBe("probe-conflict")
    expect(joined.cells["sgr.bg.bright"]?.from.map((source) => source.context)).toEqual(["primary"])
  })

  it("refuses a row whose catalogue entry hash differs, by name, and shows only the primary run", () => {
    const joined = joinContextCells(
      context("primary", { "sgr.blink": cell("probe-todo", { runId: "r1" }) }),
      [context("other", { "sgr.blink": cell("supported", { suite: OTHER, entryHash: "entry-2", runId: "r2" }) })],
      ["sgr.blink"],
      sameFile,
    )
    expect(joined.cells["sgr.blink"]).toEqual({
      status: "probe-todo",
      from: [],
      primary: { context: "primary", status: "probe-todo", runId: "r1" },
      refused: [
        {
          context: "other",
          runId: "r2",
          reason: `catalogue entry for sgr.blink differs between suite ${OTHER} and ${SAME}`,
        },
      ],
    })
    expect(joined.contexts).toEqual(["primary"])
  })

  it("refuses a row whose defining probe-defs file differs between the two source revisions", () => {
    const joined = joinContextCells(
      context("primary", { "sgr.blink": cell("unsupported", { runId: "r1" }) }),
      [context("other", { "sgr.blink": cell("supported", { sourceRevision: REV_B, runId: "r2" }) })],
      ["sgr.blink"],
      changedFile,
    )
    expect(joined.cells["sgr.blink"]).toMatchObject({
      status: "unsupported",
      from: [{ context: "primary", status: "unsupported", runId: "r1" }],
      refused: [{ context: "other", reason: `packages/probe-defs/src/sgr.ts differs between ${REV_A} and ${REV_B}` }],
    })
  })

  it("never joins a context that measured another app version", () => {
    const joined = joinContextCells(
      context("primary", { "sgr.underline.color": cell("supported", { version: "1.4.0", runId: "r1" }) }),
      [context("older-app", { "sgr.underline.color": cell("unsupported", { version: "1.3.1", runId: "r2" }) })],
      ["sgr.underline.color"],
      sameFile,
    )
    expect(joined.cells["sgr.underline.color"]?.status).toBe("supported")
    expect(joined.cells["sgr.underline.color"]?.refused).toEqual([
      { context: "older-app", runId: "r2", reason: "app version 1.3.1 differs from 1.4.0" },
    ])
    expect(joined.contexts).toEqual(["primary"])
  })

  it("keeps a reopened cell at To do even when a joined context has a decided grade", () => {
    const joined = joinContextCells(
      context("primary", { "sgr.blink": cell("probe-todo", { reopened: true, runId: "r1" }) }),
      [context("second", { "sgr.blink": cell("supported", { runId: "r2" }) })],
      ["sgr.blink"],
      sameFile,
    )
    expect(joined.cells["sgr.blink"]).toMatchObject({ status: "probe-todo", from: [] })
    expect(joined.counts["probe-todo"]).toBe(1)
  })

  it("never joins two contexts that both recorded no catalogue entry hash", () => {
    const joined = joinContextCells(
      context("primary", { "sgr.blink": cell("probe-todo", { entryHash: null }) }),
      [context("second", { "sgr.blink": cell("supported", { entryHash: null, runId: "r2" }) })],
      ["sgr.blink"],
      sameFile,
    )
    expect(joined.cells["sgr.blink"]).toMatchObject({ status: "probe-todo", from: [] })
    expect(joined.cells["sgr.blink"]?.refused[0]?.reason).toBe(
      `suite ${SAME} records no catalogue entry hash for sgr.blink`,
    )
    expect(joined.contexts).toEqual(["primary"])
  })

  it("never joins two contexts that both recorded no app version", () => {
    const joined = joinContextCells(
      context("primary", { "sgr.blink": cell("supported", { version: null }) }),
      [context("second", { "sgr.blink": cell("unsupported", { version: null, runId: "r2" }) })],
      ["sgr.blink"],
      sameFile,
    )
    expect(joined.cells["sgr.blink"]?.status).toBe("supported")
    expect(joined.cells["sgr.blink"]?.from.map((source) => source.context)).toEqual(["primary"])
  })

  it("counts one position per catalogue feature, never one per context", () => {
    const joined = joinContextCells(
      context("primary", { a: cell("supported"), b: cell("probe-todo"), c: undefined }),
      [context("second", { a: cell("supported"), b: cell("unsupported"), c: cell("supported") })],
      ["a", "b", "c"],
      sameFile,
    )
    expect(Object.values(joined.counts).reduce((sum, count) => sum + count, 0)).toBe(3)
    expect(joined.counts).toMatchObject({ supported: 1, unsupported: 1, "probe-todo": 1 })
    expect(joined.cells.c).toEqual({ status: "probe-todo", from: [], refused: [] })
  })
})

describe("the site's primary pick and join are independent of run arrival order", () => {
  // REV_OLD is an ancestor of REV_NEW; REV_SIDE shares no line with either.
  const REV_OLD = "1".repeat(40)
  const REV_NEW = "2".repeat(40)
  const REV_SIDE = "3".repeat(40)
  const history = {
    isAncestor: (ancestor: string, descendant: string): boolean =>
      ancestor === descendant || (ancestor === REV_OLD && descendant === REV_NEW),
  }
  const candidate = (key: string, measuredAt: string): ContextCandidate => ({
    key,
    kind: "term",
    terminalId: "terminal-app",
    os: "macos",
    permissions: null,
    sources: [{ runId: `${key}-run`, measuredAt, suiteId: SAME, suiteRelation: "older" }],
    states: {},
  })
  const runs: Partial<Record<string, LineageRun[]>> = {
    hosted: [{ runId: "hosted-run", version: "2.15", sourceRevision: REV_OLD }],
    owned: [{ runId: "owned-run", version: "2.15", sourceRevision: REV_NEW }],
  }
  const lineage = { runs: (c: ContextCandidate) => runs[c.key] ?? [], history }
  const facts: Record<string, ContextFacts> = {
    // `cursor.hide` joins (same entry hash, same file); `sgr.blink` is refused (entry hash differs).
    hosted: context("hosted", {
      "cursor.hide": cell("supported", { sourceRevision: REV_OLD, runId: "hosted-run" }),
      "sgr.blink": cell("supported", { sourceRevision: REV_OLD, entryHash: "old", runId: "hosted-run" }),
    }),
    owned: context("owned", {
      "cursor.hide": cell("probe-todo", { sourceRevision: REV_NEW, suite: OTHER, runId: "owned-run" }),
      "sgr.blink": cell("unsupported", { sourceRevision: REV_NEW, suite: OTHER, entryHash: "new", runId: "owned-run" }),
    }),
  }
  const site = (ids: string[], arrival: ContextCandidate[]) => {
    const picked = pickContextRun(arrival, lineage)
    if (!picked) throw new Error("no pick")
    const primary = facts[picked.run.key] as ContextFacts
    const others = arrival.filter((c) => c.key !== picked.run.key).map((c) => facts[c.key] as ContextFacts)
    return {
      primary: picked.run.key,
      selection: picked.selection,
      joined: joinContextCells(primary, others, ids, sameFile),
    }
  }
  // Owned measured last, then hosted measured last: wall-clock and list order both flip.
  const ownedLast = [candidate("hosted", "2026-11-11T00:00:00Z"), candidate("owned", "2026-11-12T00:00:00Z")]
  const hostedLast = [candidate("owned", "2026-11-10T00:00:00Z"), candidate("hosted", "2026-11-12T00:00:00Z")]

  it("gives identical output in both arrival orders when every row joins", () => {
    const a = site(["cursor.hide"], ownedLast)
    const b = site(["cursor.hide"], hostedLast)
    expect(a.primary).toBe("owned")
    expect(a.selection).toBe("app version, then source ancestry")
    expect(b).toEqual(a)
    expect(a.joined.cells["cursor.hide"]?.status).toBe("supported")
  })

  it("gives identical output in both arrival orders with a refused row, which shows the descendant run", () => {
    const a = site(["cursor.hide", "sgr.blink"], ownedLast)
    const b = site(["cursor.hide", "sgr.blink"], hostedLast)
    expect(b).toEqual(a)
    expect(a.joined.cells["sgr.blink"]).toMatchObject({
      status: "unsupported",
      primary: { context: "owned", runId: "owned-run" },
      refused: [{ context: "hosted", runId: "hosted-run" }],
    })
  })

  it("prefers the higher app version over a descendant source revision", () => {
    const newerApp: Partial<Record<string, LineageRun[]>> = {
      ...runs,
      hosted: [{ runId: "hosted-run", version: "2.16", sourceRevision: REV_OLD }],
    }
    const picked = pickContextRun(ownedLast, { runs: (c) => newerApp[c.key] ?? [], history })
    expect(picked?.run.key).toBe("hosted")
  })

  it("refuses by name when the two source revisions are unrelated", () => {
    const side: Partial<Record<string, LineageRun[]>> = {
      ...runs,
      hosted: [{ runId: "hosted-run", version: "2.15", sourceRevision: REV_SIDE }],
    }
    expect(() => pickContextRun(ownedLast, { runs: (c) => side[c.key] ?? [], history })).toThrow(
      /Contexts hosted \(3{40}\), owned \(2{40}\) measured app version 2\.15 from unrelated source revisions/,
    )
  })

  // @failure A selected run could become the site's primary and the row would read as the whole suite,
  // because the lineage pick ordered by version and ancestry only.
  // @level l2 @consumer the site's per-(app, OS) primary pick, which never names a partial reading.
  it("never lets a selected run stand for the suite when a full run ties with it", () => {
    const partial = (key: string): ContextCandidate => {
      const built = candidate(key, "2026-11-12T00:00:00Z")
      return { ...built, sources: built.sources.map((source) => ({ ...source, partial: true })) }
    }
    // Both measure the same version from the same source tip, so only the partial flag separates them, and
    // the key order would otherwise put the selected run first.
    const sameTip: Partial<Record<string, LineageRun[]>> = {
      aaa: [{ runId: "aaa-run", version: "2.15", sourceRevision: REV_NEW }],
      zzz: [{ runId: "zzz-run", version: "2.15", sourceRevision: REV_NEW }],
    }
    const lineageForTip = { runs: (c: ContextCandidate) => sameTip[c.key] ?? [], history }
    expect(pickContextRun([partial("aaa"), candidate("zzz", "2026-11-11T00:00:00Z")], lineageForTip)).toMatchObject({
      run: { key: "zzz" },
      selection: "app version, then source ancestry",
    })
    // When the selected run is the only one standing, the reason says so instead of claiming the suite.
    expect(pickContextRun([partial("aaa")], lineageForTip)).toMatchObject({
      run: { key: "aaa" },
      selection: "latest partial selection",
    })
  })
})
