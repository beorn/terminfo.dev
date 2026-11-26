/**
 * @failure A headless lib row is stored without its own full-source call log, the saved run's shadow grades a lib row
 * through another grader, compares a status a live-only input decided, loses a row without a log from its family, or
 * the termless command returns before its report exists (#30932 S3, @cto 30932-s3-plan-ruling-1626).
 * @level l2
 * @consumer `terminfo probe termless` (runTermlessProbes) -> the real headless worker -> saved schema-4 run -> the bound
 * reader -> lib replay -> gradeLibRow -> the private shadow report; `terminfo report --reassert` (#30932 S4, the
 * shipped CLI through its own arguments) over that saved run and tampered copies
 * @reach fs-walk <fixture-only: the test reads the collection directory its own command wrote>
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, expect, it, vi } from "vitest"
import { createXtermBackend } from "@termless/xtermjs"
import { ALL_PROBES, type CapturedRunDraft, type LibProbeSource } from "@terminfo/probe-defs"
import { readCallLog, withCallLog } from "viprobe"
import { replyFailure } from "../probe-defs/src/helpers.ts"
import { runTermlessProbes } from "../admin/src/termless.ts"
import { shadowReportPath } from "../admin/src/collected-run.ts"
import { headlessCollectorSuite } from "./collect-headless.ts"
import { collectBatch, declaredLibAssertionTypes, gradeLibRow } from "./headless-batch.ts"
import { APP_ONLY_EXCLUSION, headlessFamily, shadowStoredRun, type ShadowReport } from "./stored-run-shadow.ts"
import { OWNED_LAYOUT } from "./fixtures/owned-layout.fixture.ts"
import type { ReassertDocument } from "../admin/src/report.ts"

/** The shipped admin CLI, run as an operator runs it (#30932 S4). */
const ADMIN = join(dirname(fileURLToPath(import.meta.url)), "..", "admin", "src", "index.ts")
const reassert = (...args: string[]) =>
  spawnSync(process.execPath, [ADMIN, "report", "--reassert", ...args], { encoding: "utf8", timeout: 120_000 })

/**
 * Comparable rows from several families; declaration-predicate rows (kitty keyboard, unsupported; the icon title,
 * supported with a buffer_state assertion only its `then` branch declares); and a clipboard row whose identifiers
 * are drawn through the source, so its call log holds them (#30932 AC1).
 */
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
  "extensions.osc0-icon-title",
  "extensions.osc52-read",
]

/** #38801: an App only row the library collector records without sending its probe. */
const APP_ONLY_ID = "input.xtest-key"

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
    await runTermlessProbes(["xtermjs"], { probeIds: [...IDS, APP_ONLY_ID] })
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
  return {
    agree: sum("agree"),
    disagree: sum("disagree"),
    incomplete: sum("incomplete"),
    notComparable: sum("notComparable"),
  }
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
      // #38801: the App only row is decided at collection scope with no reply, no log and no grade.
      const appOnly = stored.results!.find((result) => result.featureId === APP_ONLY_ID)!
      expect(appOnly).toMatchObject({
        status: "untestable",
        attempt: { scope: "collection" },
        reason: "OS input reaches only an app window; a library gets no OS keys or clicks.",
        tests: [{ id: "declared-untestable", status: "untestable" }],
      })
      expect(Object.keys(stored.rawReplies).filter((key) => key.startsWith(APP_ONLY_ID))).toEqual([])
      expect(stored.assertions!.filter((assertion) => assertion.featureId === APP_ONLY_ID)).toEqual([])
      expect(report.excluded).toContainEqual({ reason: APP_ONLY_EXCLUSION, rows: 1, featureIds: [APP_ONLY_ID] })
      const executed = stored.results!.filter(
        (result) => result.attempt?.scope !== "none" && result.featureId !== APP_ONLY_ID,
      )
      expect(executed.map((result) => result.featureId).sort()).toEqual([...IDS].sort())
      // Every executed lib row carries its own first-pass log.
      for (const { featureId } of executed) expect(typeof stored.rawReplies[featureId + ".callLog"]).toBe("string")
      // Every row once: replayed rows plus excluded rows are the run's rows.
      expect(report.rows.length + report.excluded.reduce((sum, entry) => sum + entry.rows, 0)).toBe(
        stored.results!.length,
      )
      for (const featureId of IDS) expect(row(report, featureId)?.family).toBe(headlessFamily(featureId))
      // Exact, so a vacuous pass is visible: every row this suite can speak for agrees (#30932 AC1), including the
      // clipboard row: its nonce is a draw the source recorded and its repeat pass recorded its own log.
      expect(counts(report)).toEqual({ agree: 12, disagree: 0, incomplete: 0, notComparable: 0 })
      expect(report.rows.filter((entry) => entry.outcome === "disagree")).toEqual([])
      expect(report.rows.filter((entry) => entry.outcome === "incomplete")).toEqual([])
      // The clipboard read is silent on xterm.js, so fresh-instance repeats regraded it: the row replays from the
      // second pass's own recorded log, and its nonce is a recorded draw rather than a side channel.
      expect(row(report, "extensions.osc52-read")).toMatchObject({ outcome: "agree" })
      // The second pass's log is kept once, beside the repeat record; it is never doubled inside
      // collector.repeatPasses, and the third pass, which never grades a row, records none.
      const repeats = JSON.parse(stored.rawReplies["collector.repeatPasses"]!) as Record<string, Record<string, string>>
      for (const pass of [repeats.second!, repeats.third!]) {
        expect(Object.keys(pass).filter((key) => key.endsWith(".callLog"))).toEqual([])
      }
      for (const { featureId } of executed) {
        const repeated = stored.rawReplies["collector.repeats." + featureId] !== undefined
        expect(typeof stored.rawReplies["collector.repeatCallLog." + featureId] === "string", featureId).toBe(repeated)
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
      Object.assign(
        draft.results!.find((result) => result.featureId === agreed)!,
        { status: other, reason: "tampered" },
      )
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
          Object.assign(
            draft.results!.find((entry) => entry.featureId === agreed)!,
            {
              status: "probe-invalid",
              reason: `headless xtermjs probe ${agreed}: callback threw`,
              tests: [],
            },
          )
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

    // #30932 AC1: the clipboard nonce is a draw the log holds, so a log one draw short refuses by name instead of
    // letting the replay draw a fresh identifier and grade against it.
    const shortDraw = await shadowTampered(run, "short-draw", (draft) => {
      const key = "collector.repeatCallLog.extensions.osc52-read"
      const log = JSON.parse(draft.rawReplies[key]!) as { calls: Array<{ path: string }> }
      const at = log.calls.findIndex((call) => call.path.endsWith("randomUUID"))
      expect(at).toBeGreaterThanOrEqual(0)
      log.calls.splice(at, 1)
      draft.rawReplies[key] = JSON.stringify(log)
    })
    expect(
      row(shortDraw, "extensions.osc52-read"),
      JSON.stringify(row(shortDraw, "extensions.osc52-read")),
    ).toMatchObject({
      outcome: "incomplete",
      reason: expect.stringContaining("missing call"),
    })

    // The icon-title declaration predicate and its callback both read getIconLabel from the logged source. Without it
    // in the log's root, the replayed declaration and callback both change: never agreement. (No xterm.js row has a
    // source-reading predicate whose branch alone changes the grade, so the branch is not isolated here.)
    const branch = "extensions.osc0-icon-title"
    const flipped = await shadowTampered(run, "declaration", (draft) => {
      const log = JSON.parse(draft.rawReplies[branch + ".callLog"]!) as { root: { entries: [string, unknown][] } }
      const at = log.root.entries.findIndex(([key]) => key === "getIconLabel")
      expect(at).toBeGreaterThanOrEqual(0)
      log.root.entries.splice(at, 1)
      draft.rawReplies[branch + ".callLog"] = JSON.stringify(log)
    })
    expect(row(flipped, branch)?.outcome, JSON.stringify(row(flipped, branch))).not.toBe("agree")

    // A log whose recorded call no longer matches what the callback asks diverges loudly: never agreement.
    const diverged = await shadowTampered(run, "diverged", (draft) => {
      const log = JSON.parse(draft.rawReplies[agreed + ".callLog"]!) as { calls: Array<{ path: string }> }
      log.calls[0]!.path = log.calls[0]!.path + "Elsewhere"
      draft.rawReplies[agreed + ".callLog"] = JSON.stringify(log)
    })
    expect(row(diverged, agreed)?.outcome).toBe("incomplete")

    // AC1 (#30932): a native host-recipe record is evidence, not an exclusion. An empty record - the shape 181 of
    // alacritty's 239 excluded rows carried - says the callback asked the host nothing, so the row replays and
    // agrees; a query that failed live is still refused by name rather than replayed as an empty answer.
    const hostEmpty = await shadowTampered(run, "hostrecipe-empty", (draft) => {
      draft.rawReplies["collector.hostRecipes." + agreed] = JSON.stringify({
        runId: stored.runId,
        captures: [],
        causes: [],
      })
    })
    expect(row(hostEmpty, agreed), JSON.stringify(row(hostEmpty, agreed))).toMatchObject({ outcome: "agree" })
    const hostFailed = await shadowTampered(run, "hostrecipe-error", (draft) => {
      draft.rawReplies["collector.hostRecipes." + agreed] = JSON.stringify({
        runId: stored.runId,
        captures: [{ query: "\u001b[c", response: "", error: "ENOENT" }],
        causes: [],
      })
    })
    expect(row(hostFailed, agreed)).toMatchObject({
      outcome: "not-comparable",
      input: expect.stringContaining("native host-recipe query error"),
    })

    // AC1: the live routing decision is not an input a replay cannot reproduce. A row the collector routed through
    // the probe's declared host recipe replays from its own retained captures like any other row.
    const declared = await shadowTampered(run, "declared-recipe", (draft) => {
      const replyPath = JSON.parse(draft.rawReplies["collector.replyPath"]!) as {
        decisions: Record<string, { member: boolean; reason: string }>
      }
      replyPath.decisions[agreed] = { member: false, reason: "probe uses its declared host recipe" }
      draft.rawReplies["collector.replyPath"] = JSON.stringify(replyPath)
    })
    expect(row(declared, agreed), JSON.stringify(row(declared, agreed))).toMatchObject({ outcome: "agree" })

    // #30932 S4: the shipped command reasserts the same saved run offline, through its real arguments, and agrees
    // with the collector's own shadow; the tampered copies above decide its exit, worst first (2 > 1 > 0).
    const statusCopy = join(dirname(run), `status-${basename(run)}`)
    const nologCopy = join(dirname(run), `nolog-${basename(run)}`)
    const agreeing = reassert(run)
    expect([agreeing.status, agreeing.stderr]).toEqual([0, ""])
    for (const f of first.report.families) {
      expect(agreeing.stdout).toContain(
        `  ${f.family} ${f.rows} rows: ${f.agree} agree, ${f.disagree} disagree, ${f.incomplete} incomplete, ${f.notComparable} not comparable`,
      )
    }
    expect(agreeing.stdout).toContain(
      "not comparable extensions.osc52-read: fresh-instance repeat passes regraded this row",
    )
    expect(agreeing.stdout).toContain(`${run}: run ${stored.runId} (lib xtermjs`)
    expect(agreeing.stdout).toMatch(/Reassert: 1 input\(s\); exit 0 /)
    expect(sha256(run)).toBe(first.before) // read only
    const disagreeing = reassert(run, statusCopy)
    expect(disagreeing.status).toBe(1)
    expect(disagreeing.stdout).toContain(`disagree ${agreed}: stored ${other} (tampered), replayed`)
    const json = reassert(run, statusCopy, nologCopy, "--json")
    expect(json.status).toBe(2)
    // One parseable document on stdout, nothing else: every input in order, each with its identity.
    const document = JSON.parse(json.stdout) as ReassertDocument
    expect(document).toMatchObject({ format: "terminfo-reassert", version: 1, exitCode: 2 })
    expect(document.inputs.map((entry) => entry.input)).toEqual([run, statusCopy, nologCopy])
    const outcomes = document.inputs.map((entry) =>
      "report" in entry ? entry.report.rows.find((r) => r.featureId === agreed)?.outcome : entry.failure.name,
    )
    expect(outcomes).toEqual(["agree", "disagree", "incomplete"])
    expect(document.inputs[0]).toMatchObject({
      report: {
        run: { runId: stored.runId, sourceRevision: stored.sourceRevision },
        replayedWith: { sourceRevision: stored.sourceRevision },
      },
    })
  },
)

// No registered row on xterm.js or vterm marks a reply failure (measured over every lib probe, 2026-11-17), so the
// real-run witness above never reaches withReplyFailureEvidence. A marked callback, run live and replayed from its
// own call log in the shadow's order (declaration, then callback), grades to the live row only when the retained
// captures reach the grader (@cto 30932-s3-plan-ruling-1626: "never silently omit it").
it("replays a marked reply failure to the live row through the retained captures", async () => {
  const definition = ALL_PROBES.find((entry) => entry.id === "cursor.position-report")!
  const probe = {
    ...definition,
    lib(ctx: LibProbeSource) {
      expect(ctx.feedCapture("\x1b[9999n")).toBe("")
      return replyFailure("No probe reply")
    },
  }
  // The collector names each probe on stderr; the project's output guard refuses unasserted output.
  const progress = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  const batch = await collectBatch(async () => createXtermBackend(), "xtermjs", [probe]).finally(() =>
    progress.mockRestore(),
  )
  const live = batch.results[0]!
  expect(live.tests[0]?.replyFailure).toEqual({
    producer: "headless",
    attempts: [{ sent: "\x1b[9999n", received: null, timeoutMs: null, matchState: "no-match" }],
  })
  const session = withCallLog<LibProbeSource>(null, {
    mode: "replay",
    log: readCallLog(JSON.parse(batch.rawReplies[probe.id + ".callLog"]!)),
  })
  const declared = declaredLibAssertionTypes(probe, session.context)
  const result = JSON.parse(JSON.stringify(probe.lib(session.context))) as ReturnType<typeof probe.lib>
  session.finish()
  const captures = (
    JSON.parse(batch.rawReplies["collector.queryCaptures." + probe.id]!) as {
      captures: { query: string; response: string }[]
    }
  ).captures
  const attempt = live.attempt as { scope: "probe"; startedAt: string }
  expect(gradeLibRow({ probe, result, declared, attempt, captures })).toEqual(live)
  // Without the retained captures the grade loses the evidence: the input is load-bearing, not decorative.
  expect(gradeLibRow({ probe, result, declared, attempt, captures: [] }).tests[0]?.replyFailure).not.toEqual(
    live.tests[0]?.replyFailure,
  )
})

it("names a headless family for every lib probe from its id alone", () => {
  for (const probe of ALL_PROBES.filter((entry) => entry.lib)) {
    expect(headlessFamily(probe.id)).toMatch(/^headless:[a-z0-9-]+$/)
  }
})
