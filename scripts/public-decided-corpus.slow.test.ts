/**
 * @failure On the real retained corpus the public projection still publishes a result we haven't decided (a cell, a
 *   test, a trace entry or a count key), a card cites a trace entry the public trace no longer holds, or a card reads
 *   the reason an undecided test recorded (#37341 Q4, D5; @cto 97ba8eea, 760e9219).
 * @level l3
 * @consumer the site (docs/data/probes.data.ts) and the API (scripts/generate-api.ts), which both read publicResults
 * @reach fs-read vendor/terminfo.dev/content/**
 * @testonly none
 */
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { compatibilitySubjects, joinedAppCells, loadCurrentResults } from "../docs/data/current-results.ts"
import {
  publicResults,
  readCellTrace,
  type PublicContextSummary,
  type PublicRunMetadata,
} from "../docs/data/public-results.ts"
import type { CurrentTraceDocument } from "../docs/data/run-trace.ts"
import type { SelectedProjection } from "../docs/data/selected-results.ts"
import { aggregateCurrentResults, rollupInputs } from "../docs/data/release-scope.ts"
import { UNDECIDED_JSON_STATUS } from "./check-private-leak.ts"

/** Spelled out here rather than imported, so this test also reads the code before #37341 (its red run). */
const DECIDED = new Set(["supported", "unsupported", "untestable", "differs-by-context"])
const isPublishedStatus = (status: string) => DECIDED.has(status)
const tested = (counts: Readonly<Record<string, number | undefined>>) =>
  [...DECIDED].reduce((sum, bucket) => sum + (counts[bucket] ?? 0), 0)

const contentDir = join(import.meta.dirname, "..", "content")
let projection: SelectedProjection
let published: ReturnType<typeof publicResults>

beforeAll(() => {
  projection = loadCurrentResults(contentDir).projection
  const subjects = compatibilitySubjects(projection, contentDir)
  published = publicResults(projection, subjects, joinedAppCells(projection, subjects, contentDir))
}, 600_000)

/** Every published summary a page or the API reads: each context, and each subject's (joined) selection. */
const summaries = (): Array<[string, PublicContextSummary]> => [
  ...Object.entries(published.projection.contexts),
  ...Object.entries(published.selectedByBackend).map(([key, value]): [string, PublicContextSummary] => [
    `selected ${key}`,
    value.selected,
  ]),
]

const traceEntry = (source: PublicRunMetadata | undefined, resultId: string) => {
  const document = source?.trace ? published.documents.get(source.trace.url)?.document : undefined
  return (document as CurrentTraceDocument | undefined)?.featureResults[resultId]
}

describe("the real corpus publishes decided results only (Q4)", () => {
  it("leaves every undecided status out of the projection, the subject selections and every published document", () => {
    const undecided = new RegExp(UNDECIDED_JSON_STATUS.source)
    expect(JSON.stringify(published.projection)).not.toMatch(undecided)
    expect(JSON.stringify(published.selectedByBackend)).not.toMatch(undecided)
    const leaking = [...published.documents]
      .filter(([, document]) => undecided.test(document.bytes))
      .map(([url]) => url)
    expect(leaking).toEqual([])
  })

  it("folds every published summary over its catalogue to the counts the stored projection folded", () => {
    const drift: string[] = []
    for (const [key, context] of Object.entries(published.projection.contexts)) {
      const stored = projection.contexts[key]!
      const bar = aggregateCurrentResults(rollupInputs(key, context), context.catalogIds)
      if (tested(bar.counts) !== tested(stored.counts) || bar.denominator !== stored.score.all) {
        drift.push(
          `${key}: published ${tested(bar.counts)} of ${bar.denominator}, stored ${tested(stored.counts)} of ${stored.score.all}`,
        )
      }
    }
    expect(drift).toEqual([])
  })
})

describe("every published card cites decided evidence (D5)", () => {
  it("cites a decided entry of its run's public trace, or for a declared cell its review", () => {
    const broken: string[] = []
    for (const [where, summary] of summaries()) {
      for (const [id, cell] of Object.entries(summary.featureResults)) {
        if (cell.declared) continue
        const entry = traceEntry(summary.sources[cell.origin.runId], cell.origin.resultId)
        if (!entry || !isPublishedStatus(entry.status)) broken.push(`${where}/${id}`)
      }
    }
    expect(broken).toEqual([])
  })

  it("points each derived card at the parent entry its derivation read, and that entry is Unsupported", () => {
    const cards: string[] = []
    const wrong: string[] = []
    for (const [key, context] of Object.entries(published.projection.contexts)) {
      const stored = projection.contexts[key]!
      for (const [id, cell] of Object.entries(context.featureResults)) {
        if (!cell.derived) continue
        cards.push(`${key}/${id}`)
        const parent = stored.cells[cell.derived.parent]
        const source = context.sources[cell.origin.runId]
        const entry = traceEntry(source, cell.origin.resultId)
        if (
          !parent ||
          cell.origin.runId !== parent.origin.runId ||
          cell.origin.resultId !== parent.origin.resultId ||
          cell.origin.runId !== cell.derived.parentRunId ||
          entry?.status !== "unsupported"
        ) {
          wrong.push(`${key}/${id}`)
          continue
        }
        // The reader the card calls in the browser resolves the cited entry from the served bytes' receipt.
        const document = published.documents.get(source!.trace!.url)!
        readCellTrace(document.document, {
          schemaVersion: source!.schemaVersion,
          runId: source!.runId,
          runSha256: source!.sha256,
          featureId: cell.origin.resultId,
          expectedSha256: source!.trace!.sha256,
          actualSha256: source!.trace!.sha256,
        })
        expect(cell.derived).not.toHaveProperty("ownStatus")
        expect(cell.derived).not.toHaveProperty("ownReason")
      }
    }
    expect(wrong).toEqual([])
    // The cards whose own stored entry is undecided: the ones D5 re-points.
    const ownUndecided = cards.filter((card) => {
      const [key, id] = [card.slice(0, card.lastIndexOf("/")), card.slice(card.lastIndexOf("/") + 1)]
      const own = projection.contexts[key]!.cells[id]!
      return !isPublishedStatus(own.result.status)
    })
    // 38702 (@dev/15): the COUNT is a property of the corpus, not of this file. A
    // placement that legitimately re-decides a derived card moves it (25 on the
    // 2.7.3 corpus today; 24 when this line was written), and a pinned number reds
    // on that move alone. What the file must hold is that D5's re-point path is
    // still exercised on real data — the linkage above already proves every derived
    // card cites its parent's unsupported entry — so an empty set cannot pass for a
    // clean one.
    expect(ownUndecided.length, "the corpus must still exercise D5 re-pointing").toBeGreaterThan(0)
  })

  it("cites the review for a cell declared untestable, whose own entry the public trace leaves out", () => {
    const declared: string[] = []
    for (const [key, context] of Object.entries(published.projection.contexts)) {
      for (const [id, cell] of Object.entries(context.featureResults)) {
        if (!cell.declared) continue
        declared.push(`${key}/${id}`)
        expect(cell.status).toBe("untestable")
        expect(cell.reason).toMatch(/^untestable by review \d{4}-\d{2}-\d{2}: /)
        expect(traceEntry(context.sources[cell.origin.runId], cell.origin.resultId)).toBeUndefined()
      }
    }
    expect(declared.some((card) => card.endsWith("/device.term-features"))).toBe(true)
  })
})

describe("no public card reads an undecided reason (@cto 760e9219)", () => {
  it("publishes no reason or hold that a probe-todo or probe-invalid test, or an undecided result, recorded", () => {
    const undecidedWords = new Set<string>()
    for (const version of [...Object.values(projection.versions), ...Object.values(projection.history)].flat()) {
      for (const result of version.results) {
        if (!isPublishedStatus(result.status) && result.reason) undecidedWords.add(result.reason)
        for (const test of result.tests) {
          if (!isPublishedStatus(test.status) && test.reason) undecidedWords.add(test.reason)
        }
      }
    }
    expect(undecidedWords.size).toBeGreaterThan(0)
    const read = (text: string | undefined) =>
      text !== undefined &&
      (undecidedWords.has(text) || text.split(/;\s+/).some((clause) => undecidedWords.has(clause)))
    const leaks: string[] = []
    for (const [where, summary] of summaries()) {
      for (const [id, cell] of Object.entries(summary.featureResults)) {
        if (read(cell.reason) || read(cell.hold)) leaks.push(`${where}/${id}`)
      }
    }
    for (const [key, versions] of Object.entries(published.projection.versions)) {
      for (const version of versions) {
        for (const result of version.results) {
          if (read(result.reason) || read(result.hold)) leaks.push(`${key}/${result.featureId}`)
        }
      }
    }
    expect(leaks).toEqual([])
  })
})
