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
import { spawnSync } from "node:child_process"
import {
  SOURCE_ANSWERS,
  finalizeProbeResult,
  repositoryIdentity,
  type HeadlessRuntimeIdentity,
  type SourceAnswer,
  type SourceAnswerSubject,
} from "@terminfo/probe-defs"
import { resolveMeasuredSourceAnswer } from "./source-answers.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..")
const GHOSTTY_RUN = "ghostty-0.4.0-linux-3f3e920e-ebf8-4d81-ace1-52445a05a992.json"
/** The eight cells whose kept answers disagree now that both the colour-readback and reply-path passes are kept. */
const DISPUTED = [
  "extensions.osc104-reset-palette",
  "extensions.osc110-reset-fg",
  "extensions.osc111-reset-bg",
  "extensions.osc112-reset-cursor",
  "extensions.osc113-reset-pointer-fg",
  "extensions.osc114-reset-pointer-bg",
  "extensions.osc30001-color-stack-push",
  "extensions.osc30101-color-stack-pop",
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
      .filter(({ run }) => run.schemaVersion === 4 && run.runtimeIdentity !== undefined),
  )

const resolveCell = (run: Run, featureId: string) =>
  resolveMeasuredSourceAnswer({
    subject: run.subject,
    featureId,
    runtimeIdentity: run.runtimeIdentity,
    sourceRevision: run.sourceRevision,
  })

describe("kept answers against every current committed run", () => {
  it("finds the subject cells and no cell the writer would decide differently", () => {
    const runs = currentRuns()
    expect(runs.length).toBeGreaterThan(0)
    const drifted: string[] = []
    let cells = 0
    for (const { dir, name, run } of runs) {
      for (const result of run.results) {
        if (!result.reviewRef && !result.tests.some((test) => test.reviewRef !== undefined)) continue
        cells++
        const next = finalizeProbeResult(result as never, resolveCell(run, result.featureId))
        if (!isDeepStrictEqual(next, result)) drifted.push(`${dir}/${name} ${result.featureId}`)
      }
    }
    // A table edit re-finalizes the affected runs in the same change; this is the cell-for-cell proof of it.
    expect({ cells, drifted }).toEqual({ cells, drifted: [] })
  })

  it("reads the disputed ghostty cells as test-todo with both originals named", () => {
    const run = currentRuns().find((entry) => entry.name === GHOSTTY_RUN)!.run
    const cells = run.results
      .filter((result) => DISPUTED.includes(result.featureId))
      .sort((a, b) => a.featureId.localeCompare(b.featureId))
    expect(cells.map((cell) => cell.featureId)).toEqual(DISPUTED)
    for (const cell of cells) {
      expect(cell.status, cell.featureId).toBe("test-todo")
      const reason = String(cell.reason)
      expect(reason.startsWith("kept answers disagree"), cell.featureId).toBe(true)
      // Never a pick by order or kind: both kept originals travel with the cell.
      expect(reason, cell.featureId).toContain("@dev/1: ")
      expect(reason, cell.featureId).toContain("reply-path-audit: ")
      const row = SOURCE_ANSWERS.find((entry) => entry.featureId === cell.featureId && entry.subject.id === "ghostty")!
      const statuses = new Set(row.answers.map((answer) => answer.status))
      expect(statuses.size, cell.featureId).toBeGreaterThan(1)
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
    expect(cells.length).toBeGreaterThan(DISPUTED.length)
    // Exactly the eight disputed cells read as a dispute; every other audited cell keeps its measured result.
    const disputed = run.results.filter((result) => String(result.reason).startsWith("kept answers disagree"))
    expect(disputed.map((cell) => cell.featureId).sort()).toEqual(DISPUTED)
    for (const cell of cells.filter((entry) => !DISPUTED.includes(entry.featureId))) {
      expect(String(cell.reason).startsWith("kept answers disagree"), cell.featureId).toBe(false)
    }
  })
})
