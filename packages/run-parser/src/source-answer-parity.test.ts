/**
 * @failure A kept answer drifts from a committed run, a disputed cell picks a side, or a kept citation names the
 *          engine core, which no committed run may read (@cto de41833e, 85a9cfd9).
 * @level l0
 * @consumer Source-answer application at the writer and the canonical run reader
 * @reach fs-walk vendor/terminfo.dev/content/probes-libs/*.json vendor/terminfo.dev/content/probes-apps/*.json vendor/terminfo.dev/content/probes-mux/*.json
 * @testonly none
 */
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { describe, expect, it } from "vitest"
import {
  SOURCE_ANSWERS,
  finalizeProbeResult,
  repositoryIdentity,
  type HeadlessRuntimeIdentity,
  type SourceAnswerSubject,
} from "@terminfo/probe-defs"
import { resolveMeasuredSourceAnswer } from "./source-answers.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..")
const GHOSTTY_RUN = "ghostty-0.4.0-linux-3bacc3ae-a7c9-4fed-9f3f-a2c0ce01e6f5.json"
/**
 * The eight colour-reset cells whose @dev/1 originals were withdrawn with the superseded 3f3e920e run (#32181).
 * Their reply-path answer is now the only kept answer, so it decides the cell.
 */
const WITHDRAWN = [
  "extensions.osc104-reset-palette",
  "extensions.osc110-reset-fg",
  "extensions.osc111-reset-bg",
  "extensions.osc112-reset-cursor",
  "extensions.osc113-reset-pointer-fg",
  "extensions.osc114-reset-pointer-bg",
  "extensions.osc30001-color-stack-push",
  "extensions.osc30101-color-stack-pop",
].sort()
/**
 * The kitty-graphics trio keeps two disagreeing reply-path answers in the table. That dispute predates #32181,
 * which touches no row outside the eight above, so it stays a dispute in this run and nobody picks a side here.
 */
const PRE_EXISTING_DISPUTES = [
  "extensions.kitty-graphics",
  "extensions.kitty-graphics.display",
  "extensions.kitty-graphics.transmit",
].sort()

interface Run {
  schemaVersion?: number
  subject: SourceAnswerSubject
  runtimeIdentity?: HeadlessRuntimeIdentity
  sourceRevision: string
  results: Array<Record<string, unknown> & { featureId: string; status: string; tests: Array<Record<string, unknown>> }>
}

const currentRuns = () =>
  ["probes-apps", "probes-libs", "probes-mux"].flatMap((dir) =>
    readdirSync(join(ROOT, "content", dir))
      .filter((name) => name.endsWith(".json"))
      .map((name) => ({ dir, name, run: JSON.parse(readFileSync(join(ROOT, "content", dir, name), "utf8")) as Run }))
      .filter(({ run }) => run.schemaVersion === 4),
  )

const resolveCell = (run: Run, featureId: string) =>
  resolveMeasuredSourceAnswer({
    subject: run.subject,
    featureId,
    runtimeIdentity: run.runtimeIdentity,
    sourceRevision: run.sourceRevision,
  })

describe("kept answers against every current committed run", () => {
  // The full committed corpus exceeded Vitest's 5s default under two-worker CI contention.
  it("finds the subject cells and no cell the writer would decide differently", () => {
    const runs = currentRuns()
    expect(runs).toHaveLength(12)
    const drifted: string[] = []
    let cells = 0
    for (const { dir, name, run } of runs) {
      for (const result of run.results) {
        cells++
        const reviewed = result.reviewRef || result.tests.some((test) => test.reviewRef !== undefined)
        const next = finalizeProbeResult(result as never, reviewed ? resolveCell(run, result.featureId) : undefined)
        if (!isDeepStrictEqual(next, result)) drifted.push(`${dir}/${name} ${result.featureId}`)
      }
    }
    // A table edit re-finalizes the affected runs in the same change; this is the cell-for-cell proof of it.
    expect({ cells, drifted }).toEqual({ cells: 3276, drifted: [] })
  }, 30_000)

  it("reads the eight withdrawn colour-reset cells on their surviving reply-path answer", () => {
    const run = currentRuns().find((entry) => entry.name === GHOSTTY_RUN)!.run
    const cells = run.results
      .filter((result) => WITHDRAWN.includes(result.featureId))
      .sort((a, b) => a.featureId.localeCompare(b.featureId))
    expect(cells.map((cell) => cell.featureId)).toEqual(WITHDRAWN)
    for (const cell of cells) {
      // The dispute ends because the table keeps one answer, never because a side was picked by order or kind.
      const row = SOURCE_ANSWERS.find((entry) => entry.featureId === cell.featureId && entry.subject.id === "ghostty")!
      expect(
        row.answers.map((answer) => answer.status),
        cell.featureId,
      ).toEqual(["unsupported"])
      expect(
        row.answers[0]!.originals.map((original) => original.reviewer),
        cell.featureId,
      ).toEqual(["reply-path-audit"])
      expect(cell.status, cell.featureId).toBe("unsupported")
      expect(String(cell.reason).startsWith("kept answers disagree"), cell.featureId).toBe(false)
    }
  })

  it("leaves every other audited ghostty cell on its measured result", () => {
    const run = currentRuns().find((entry) => entry.name === GHOSTTY_RUN)!.run
    const audited = new Set(
      SOURCE_ANSWERS.filter(
        (row) =>
          row.subject.id === "ghostty" &&
          row.answers.some((answer) => answer.originals.some((original) => original.reviewer === "reply-path-audit")),
      ).map((row) => row.featureId),
    )
    const cells = run.results.filter((result) => audited.has(result.featureId))
    expect(cells.length).toBeGreaterThan(WITHDRAWN.length)
    // The eight withdrawn cells no longer read as a dispute; the kitty trio still does, and this change leaves it so.
    const disputed = run.results.filter((result) => String(result.reason).startsWith("kept answers disagree"))
    expect(disputed.map((cell) => cell.featureId).sort()).toEqual(PRE_EXISTING_DISPUTES)
    for (const cell of cells.filter(
      (entry) => !WITHDRAWN.includes(entry.featureId) && !PRE_EXISTING_DISPUTES.includes(entry.featureId),
    )) {
      expect(String(cell.reason).startsWith("kept answers disagree"), cell.featureId).toBe(false)
    }
  })
})
