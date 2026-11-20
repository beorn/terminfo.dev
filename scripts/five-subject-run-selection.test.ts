/**
 * @failure A partial run of the same app version is picked as a context summary while a complete run stands,
 * so five terminals that had a complete reading read as mostly todo on the status page.
 * @level l2
 * @consumer run-selection pickContextRun and pickByLineage behind the site page pick
 * @testonly none
 * @reach fs-read none
 */
import { describe, expect, it } from "vitest"
import { measuresSelectionOnly, pickContextRun, type HistoricalContextCandidate } from "../docs/data/run-selection.ts"

const probes = Array.from({ length: 273 }, (_, index) => `probe-${index}`)
const COMPLETE_REVISION = "a".repeat(40)
const PARTIAL_REVISION = "b".repeat(40)

interface RunFacts {
  runId: string
  measuredAt: string
  rows: number
}

interface Subject {
  app: string
  kind: "term" | "mux"
  os: string
  version: string
  complete: RunFacts
  partial: RunFacts
}

// The real facts from @cpo/term 06:12 rebuild (/hh/var/@cpo/term/build-0612.log, run ids, times and row
// counts read from /hh/var/@cpo/term/selection/map-selection.json). On all five the partial run stood at a
// source revision descending from the complete run one; on iTerm2 it also stood later in time.
const subjects: Subject[] = [
  {
    app: "kitty",
    kind: "term",
    os: "linux",
    version: "0.49.2",
    complete: { runId: "ab81a9b6b1b5", measuredAt: "2026-11-18T11:25:52.620Z", rows: 273 },
    partial: { runId: "27721c60fad6", measuredAt: "2026-11-18T11:25:10.863Z", rows: 262 },
  },
  {
    app: "alacritty",
    kind: "term",
    os: "linux",
    version: "0.17.0",
    complete: { runId: "eab065dbab3f", measuredAt: "2026-11-18T12:32:43.807Z", rows: 273 },
    partial: { runId: "7c373133323e", measuredAt: "2026-11-18T12:31:46.598Z", rows: 263 },
  },
  {
    app: "tmux",
    kind: "mux",
    os: "linux",
    version: "3.8",
    complete: { runId: "f0d3e442749f", measuredAt: "2026-11-18T13:02:07.929Z", rows: 273 },
    partial: { runId: "1e289238242d", measuredAt: "2026-11-18T13:01:17.684Z", rows: 263 },
  },
  {
    app: "screen",
    kind: "mux",
    os: "linux",
    version: "5.0.2",
    complete: { runId: "1e7f51449dba", measuredAt: "2026-11-18T12:01:23.658Z", rows: 273 },
    partial: { runId: "74bf5cbff1cd", measuredAt: "2026-11-18T12:00:00.374Z", rows: 261 },
  },
  {
    app: "iterm2",
    kind: "term",
    os: "macos",
    version: "3.6.11",
    complete: { runId: "b5ba78c47515", measuredAt: "2026-11-17T23:55:06.785Z", rows: 262 },
    partial: { runId: "cb379c33c587", measuredAt: "2026-11-18T01:11:34.076Z", rows: 1 },
  },
]

const contextCandidate = (subject: Subject, run: RunFacts, partial: boolean): HistoricalContextCandidate => ({
  key: `${subject.app}/${subject.os}/${run.runId}`,
  kind: subject.kind,
  terminalId: subject.app,
  os: subject.os,
  permissions: null,
  states: {},
  cells: {},
  sources: [
    {
      runId: run.runId,
      measuredAt: run.measuredAt,
      suiteId: "five-subject-suite",
      suiteRelation: "tree",
      partial,
    },
  ],
})

const lineageFor = (subject: Subject, complete: HistoricalContextCandidate) => ({
  runs: (candidate: HistoricalContextCandidate) => [
    {
      runId: candidate.sources[0]!.runId,
      version: subject.version,
      sourceRevision: candidate === complete ? COMPLETE_REVISION : PARTIAL_REVISION,
    },
  ],
  history: {
    isAncestor: (ancestor: string, descendant: string) => ancestor === descendant || ancestor === COMPLETE_REVISION,
  },
})

describe.each(subjects)("$app/$os complete run regressions (#34868)", (subject) => {
  const complete = contextCandidate(subject, subject.complete, false)
  const partial = contextCandidate(subject, subject.partial, true)
  const lineage = lineageFor(subject, complete)

  it("picks the complete run by time and by source lineage, in either input order", () => {
    for (const order of [
      [complete, partial],
      [partial, complete],
    ]) {
      expect(pickContextRun(order)).toMatchObject({ run: { key: complete.key } })
      expect(pickContextRun(order, lineage)).toMatchObject({ run: { key: complete.key } })
    }
  })

  it("still names the partial run when no complete run stands", () => {
    expect(pickContextRun([partial])).toMatchObject({
      run: { key: partial.key },
      selection: "latest partial selection",
    })
    expect(pickContextRun([partial], lineage)).toMatchObject({
      run: { key: partial.key },
      selection: "latest partial selection",
    })
  })

  // The 14:12 regression: demoting any context that held a partial source handed these bars to older
  // evidence. Only a context whose every run measured a selection is demoted.
  it("does not demote a context that also holds the complete run", () => {
    const mixed = {
      ...partial,
      key: `${subject.app}/${subject.os}/mixed`,
      sources: [...complete.sources, ...partial.sources],
    }
    for (const order of [
      [mixed, partial],
      [partial, mixed],
    ]) {
      expect(pickContextRun(order)).toMatchObject({ run: { key: mixed.key } })
    }
  })

  it("reads the real row counts as a selection against the declared 273-id cohort", () => {
    expect(subject.partial.rows).toBeLessThan(probes.length)
    expect(
      measuresSelectionOnly({
        selection: { ids: probes.slice(0, subject.partial.rows) },
        selectionCoversSuite: false,
      }),
    ).toBe(true)
    expect(measuresSelectionOnly({ selection: { ids: probes }, selectionCoversSuite: true })).toBe(false)
  })
})
