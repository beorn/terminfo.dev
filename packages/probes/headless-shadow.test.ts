/**
 * @failure A headless lib row is stored without its own full-source call log, the saved run's shadow grades a lib row
 * through another grader, compares a status a live-only input decided, loses a row without a log from its family, or
 * the termless command returns before its report exists (#30932 S3, @cto 30932-s3-plan-ruling-1626).
 * @level l2
 * @consumer `terminfo probe termless` (runTermlessProbes) -> the real headless worker -> saved schema-4 run -> the bound
 * reader -> lib replay -> gradeLibRow -> the private shadow report
 * @reach fs-walk <fixture-only: the test reads the collection directory its own command wrote>
 * @testonly none
 */
import { createHash } from "node:crypto"
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { afterAll, expect, it, vi } from "vitest"
import { ALL_PROBES, type CapturedRunDraft } from "@terminfo/probe-defs"
import { runTermlessProbes } from "../admin/src/termless.ts"
import { shadowReportPath } from "../admin/src/collected-run.ts"
import { headlessCollectorSuite } from "./collect-headless.ts"
import { headlessFamily, shadowStoredRun, type ShadowReport } from "./stored-run-shadow.ts"
import { OWNED_LAYOUT } from "./fixtures/owned-layout.fixture.ts"

/** Comparable rows from several families, a declaration-predicate row, and a census row that reads randomness. */
const IDS = [
  "erase.character",
  "erase.line.right",
  "sgr.bold",
  "sgr.italic",
  "cursor.move.absolute",
  "cursor.move.home",
  "device.primary-da",
  "device.status-report",
  "modes.bracketed-paste",
  "extensions.kitty-keyboard",
  "extensions.osc52-read",
]

const directories: string[] = []
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")

/** Run the real termless command once; return its saved run, the bytes' digest before the shadow, and the report. */
async function termless(): Promise<{ run: string; before: string; report: ShadowReport; stored: CapturedRunDraft }> {
  const lines: string[] = []
  vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")))
  try {
    await runTermlessProbes(["xtermjs"], { probeIds: IDS })
  } finally {
    log.mockRestore()
  }
  const directory = /directory: (\S+)/.exec(lines.join("\n"))?.[1]
  if (!directory) throw new Error("termless printed no collection directory:\n" + lines.join("\n"))
  directories.push(directory)
  const collection = JSON.parse(readFileSync(join(directory, "collection.json"), "utf8")) as { runs: string[] }
  expect(collection.runs).toHaveLength(1)
  const run = collection.runs[0]!
  // The report exists when the command has returned: it was awaited.
  const report = JSON.parse(readFileSync(shadowReportPath(run), "utf8")) as ShadowReport
  const stored = JSON.parse(readFileSync(run, "utf8")) as CapturedRunDraft
  return { run, before: sha256(run), report, stored }
}

function counts(report: ShadowReport) {
  const sum = (key: "agree" | "disagree" | "incomplete" | "notComparable") =>
    report.families.reduce((total, family) => total + family[key], 0)
  return { agree: sum("agree"), disagree: sum("disagree"), incomplete: sum("incomplete"), notComparable: sum("notComparable") }
}

/** A tampered copy of a saved run, beside it, shadowed against the same suite. */
async function shadowTampered(run: string, name: string, tamper: (stored: CapturedRunDraft) => void) {
  const copy = join(dirname(run), `${name}-${basename(run)}`)
  copyFileSync(run, copy)
  const stored = JSON.parse(readFileSync(copy, "utf8")) as CapturedRunDraft
  tamper(stored)
  writeFileSync(copy, `${JSON.stringify(stored, null, 2)}\n`)
  const { manifest, runRevision } = headlessCollectorSuite()
  return shadowStoredRun(copy, { manifest, sourceRevision: runRevision })
}

const row = (report: ShadowReport, featureId: string) => report.rows.find((entry) => entry.featureId === featureId)

it.runIf(OWNED_LAYOUT)(
  "termless records each lib row's call log, and its awaited shadow agrees through the headless grader",
  { timeout: 240_000 },
  async () => {
    const first = await termless()
    const second = await termless()
    for (const { run, before, report, stored } of [first, second]) {
      // The shadow wrote its report beside the run and never touched the run.
      expect(sha256(run)).toBe(before)
      expect(report.runIncomplete).toBeUndefined()
      const executed = stored.results!.filter((result) => result.attempt?.scope !== "none")
      expect(executed.map((result) => result.featureId).sort()).toEqual([...IDS].sort())
      // Every executed lib row carries its own first-pass log.
      for (const { featureId } of executed) expect(typeof stored.rawReplies[featureId + ".callLog"]).toBe("string")
      // Every row once: replayed rows plus excluded rows are the run's rows.
      expect(report.rows.length + report.excluded.reduce((sum, entry) => sum + entry.rows, 0)).toBe(
        stored.results!.length,
      )
      for (const featureId of IDS) expect(row(report, featureId)?.family).toBe(headlessFamily(featureId))
      const total = counts(report)
      const comparable = total.agree + total.disagree
      // Reported, so a vacuous pass is visible: at least one comparable row, and every comparable row agrees.
      console.info("#30932 S3 shadow counts", basename(run), JSON.stringify(total))
      expect(comparable).toBeGreaterThan(0)
      expect(report.rows.filter((entry) => entry.outcome === "disagree")).toEqual([])
      expect(report.rows.filter((entry) => entry.outcome === "incomplete")).toEqual([])
      // The clipboard read is silent on xterm.js, so fresh-instance repeats regrade it; that input is named first.
      expect(row(report, "extensions.osc52-read")).toMatchObject({
        outcome: "not-comparable",
        input: "fresh-instance repeat passes regraded this row",
      })
      // Repeat passes record no call log: only the first pass is replayable evidence.
      const repeats = JSON.parse(stored.rawReplies["collector.repeatPasses"]!) as Record<string, Record<string, string>>
      for (const pass of [repeats.second!, repeats.third!]) {
        expect(Object.keys(pass).filter((key) => key.endsWith(".callLog"))).toEqual([])
      }
      expect(row(report, "extensions.kitty-keyboard")?.outcome).not.toBe("incomplete")
    }
    // Two live captures of the same rows are not byte-identical (viprobe records each call's wall and monotonic
    // times), and each one replays strictly to its own result: the agreement above holds for both.
    const id = "sgr.bold"
    expect(first.stored.rawReplies[id + ".callLog"]).not.toBe(second.stored.rawReplies[id + ".callLog"])

    const { run, stored } = first
    const agreed = first.report.rows.find((entry) => entry.outcome === "agree")!.featureId
    // A coherent edit the run parser still accepts: a probe-invalid stored status beside unchanged evidence.
    const other = "probe-invalid"

    const tampered = await shadowTampered(run, "status", (draft) => {
      Object.assign(draft.results!.find((result) => result.featureId === agreed)!, { status: other, reason: "tampered" })
    })
    expect(row(tampered, agreed), JSON.stringify(row(tampered, agreed))).toMatchObject({
      outcome: "disagree",
      stored: { status: other },
    })

    const missing = await shadowTampered(run, "nolog", (draft) => {
      delete draft.rawReplies[agreed + ".callLog"]
    })
    expect(row(missing, agreed)).toMatchObject({
      family: headlessFamily(agreed),
      outcome: "incomplete",
      reason: expect.stringContaining("Missing full-source call log"),
    })

    const inputs: Array<[string, (draft: CapturedRunDraft) => void, string]> = [
      ["late", (draft) => void (draft.rawReplies[agreed + ".late"] = "\x1b[0n"), "late reply"],
      ["repeat", (draft) => void (draft.rawReplies["collector.repeats." + agreed] = "{}"), "fresh-instance repeat"],
      [
        "cleanup",
        (draft) => {
          // The collector's own overwrite after a failed backend destroy (headless-batch collectPass).
          const result = draft.results!.find((entry) => entry.featureId === agreed)!
          const reason = `headless xtermjs probe ${agreed}: backend cleanup failed`
          Object.assign(result, {
            status: "probe-invalid",
            reason,
            tests: [...result.tests, { id: "cleanup", status: "probe-invalid", attempt: result.attempt, reason }],
          })
        },
        "cleanup failure",
      ],
      [
        "collector-error",
        (draft) => {
          // The collector's caught error as a saved row carries it (a schema-4 run keeps no diagnostics list).
          Object.assign(draft.results!.find((entry) => entry.featureId === agreed)!, {
            status: "probe-invalid",
            reason: `headless xtermjs probe ${agreed}: callback threw`,
            tests: [],
          })
        },
        "live collector error",
      ],
    ]
    for (const [name, tamper, input] of inputs) {
      const report = await shadowTampered(run, name, tamper)
      // Not comparable by name even though the stored status is unchanged.
      expect(row(report, agreed), name + " " + JSON.stringify(row(report, agreed))).toMatchObject({
        outcome: "not-comparable",
        input: expect.stringContaining(input),
      })
    }

    // Without its repeat evidence the census row is still not comparable: its callback reads randomness.
    const census = await shadowTampered(run, "census", (draft) => {
      delete draft.rawReplies["collector.repeats.extensions.osc52-read"]
    })
    expect(row(census, "extensions.osc52-read")).toMatchObject({
      outcome: "not-comparable",
      input: expect.stringContaining("randomUUID"),
    })

    // A log whose recorded call no longer matches what the callback asks diverges loudly: never agreement.
    const diverged = await shadowTampered(run, "diverged", (draft) => {
      const log = JSON.parse(draft.rawReplies[agreed + ".callLog"]!) as { calls: Array<{ path: string }> }
      log.calls[0]!.path = log.calls[0]!.path + "Elsewhere"
      draft.rawReplies[agreed + ".callLog"] = JSON.stringify(log)
    })
    expect(row(diverged, agreed)?.outcome).toBe("incomplete")
  },
)

it("names a headless family for every lib probe from its id alone", () => {
  for (const probe of ALL_PROBES.filter((entry) => entry.lib)) {
    expect(headlessFamily(probe.id)).toMatch(/^headless:[a-z0-9-]+$/)
  }
})
