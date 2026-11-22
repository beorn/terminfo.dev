/**
 * @failure A coverage readout prints internal labels or a percentage of the tested features instead of the two counts
 *   the site, the admin tools and the CLI all promise (#37341 D1, D2 and D12, @cpo/term bfbbc644), or a page that folds
 *   published cells throws once undecided cells are no longer published (#37341 Q4).
 * @level l1
 * @consumer terminfo.dev home, terminal, OS and baseline pages; `terminfo here`, the admin app, mux and server
 *   summaries (`${currentSupportedShare(a)} · ${currentCoverageSentence(a, ids)}`), the admin report and status lines
 * @testonly none
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { ProbeResult } from "@terminfo/probe-defs"
import {
  aggregateCurrentResults,
  currentCoverageSentence,
  currentSupportedShare,
  rollupInputs,
} from "../docs/data/release-scope.ts"

const root = join(import.meta.dirname, "..")
/** A real stored run: 141 Supported, 80 Unsupported, 34 Untestable, 7 PROBE TODO, 2 PROBE INVALID of 264 graded. */
const REAL_RUN = "content/probes-apps/alacritty-0.17.0-linux-4828c88a9bd250a9d8ed53793526662d.json"
const LABELS = /PROBE|NOT MEASURED|manual by design|environment|%/i

const realRun = () => JSON.parse(readFileSync(join(root, REAL_RUN), "utf8")) as { results: ProbeResult[] }

describe("one coverage readout: S supported · T of 264 tested (D1, D2, D12)", () => {
  it("prints a real run's admin and CLI summary line as two counts", () => {
    // The exact composition packages/admin/src/{app,mux,server}.ts and the CLI print, from the same fold they call.
    const run = realRun()
    const catalogIds = run.results.map((result) => result.featureId)
    const aggregate = aggregateCurrentResults(run.results, catalogIds)
    expect(`${currentSupportedShare(aggregate)} · ${currentCoverageSentence(aggregate, catalogIds)}`).toBe(
      "141 supported · 255 of 264 tested",
    )
    expect(currentCoverageSentence(aggregate)).toBe("255 of 264 tested")
  })

  it("counts Supported, Unsupported, Untestable and a disagreement as tested, and nothing undecided", () => {
    const counts = {
      supported: 3,
      unsupported: 2,
      untestable: 1,
      "differs-by-context": 1,
      "probe-todo": 4,
      "probe-invalid": 5,
      "probe-conflict": 6,
    }
    expect(currentCoverageSentence({ counts })).toBe("7 of 22 tested")
    expect(currentSupportedShare({ counts })).toBe("3 supported")
    // An aggregate's derived and by-review breakdowns print nothing extra: no label, no share.
    const aggregate = { counts, derived: 2, byReview: 1 }
    expect(currentCoverageSentence(aggregate)).not.toMatch(LABELS)
  })

  it("prints a run that decided nothing as zeros, never NaN or a percentage", () => {
    const ids = ["sgr.bold", "sgr.italic", "device.env-term"]
    const aggregate = aggregateCurrentResults(
      ids.map((featureId) => ({ featureId, status: "probe-todo" as const })),
      ids,
    )
    expect(`${currentSupportedShare(aggregate)} · ${currentCoverageSentence(aggregate, ids)}`).toBe(
      "0 supported · 0 of 2 tested",
    )
    const empty = aggregateCurrentResults([{ featureId: "device.env-term", status: "probe-todo" }], ["device.env-term"])
    expect(currentCoverageSentence(empty)).toBe("0 of 0 tested")
  })

  it("refuses a count set without its undecided buckets, and a catalogue the counts do not cover", () => {
    // A published count set has lost the undecided keys, so it cannot say how many features were graded.
    expect(() => currentCoverageSentence({ counts: { supported: 1, unsupported: 0, untestable: 0 } } as never)).toThrow(
      /probe-todo/,
    )
    const ids = ["sgr.bold", "sgr.italic"]
    const aggregate = aggregateCurrentResults(
      ids.map((featureId) => ({ featureId, status: "supported" as const })),
      ids,
    )
    expect(() => currentCoverageSentence(aggregate, [...ids, "sgr.dim"])).toThrow(/2 graded.*3 graded/)
  })
})

describe("rollupInputs folds published cells over the whole catalogue (Q4)", () => {
  const catalogIds = ["sgr.bold", "sgr.italic", "sgr.dim", "device.env-term"]

  it("reads a catalogue id the public projection left out as no result", () => {
    const summary = {
      catalogIds,
      featureResults: {
        "sgr.bold": { featureId: "sgr.bold", status: "supported" as const },
        "sgr.italic": { featureId: "sgr.italic", status: "unsupported" as const, derived: { parent: "sgr.bold" } },
      },
    }
    const bar = aggregateCurrentResults(rollupInputs("app", summary), catalogIds)
    expect(bar.denominator).toBe(3)
    expect(bar.counts).toMatchObject({ supported: 1, unsupported: 1, "probe-todo": 1 })
    expect(bar.derived).toBe(1)
    expect(bar.complete).toBe(false)
    expect(currentCoverageSentence(bar, catalogIds)).toBe("2 of 3 tested")
  })

  it("folds an original run's published results the same way", () => {
    const version = { catalogIds, results: [{ featureId: "sgr.dim", status: "untestable" as const }] }
    const bar = aggregateCurrentResults(rollupInputs("run", version), catalogIds)
    expect(bar.counts).toMatchObject({ untestable: 1, "probe-todo": 2 })
  })

  it("still refuses a published id outside the catalogue and a status no bucket means", () => {
    expect(() =>
      rollupInputs("app", {
        catalogIds,
        featureResults: { "sgr.blink": { featureId: "sgr.blink", status: "supported" as const } },
      }),
    ).toThrow(/sgr\.blink.*outside/)
    expect(() =>
      rollupInputs("app", {
        catalogIds,
        featureResults: { "sgr.bold": { featureId: "sgr.bold", status: "maybe" as never } },
      }),
    ).toThrow(/unknown feature status/)
  })
})
