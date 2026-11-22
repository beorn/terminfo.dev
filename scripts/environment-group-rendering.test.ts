/**
 * @failure A run's nine environment positions print as PROBE TODO, so "manual by design" reads as
 *   unmeasured work and the published denominator disagrees with the bars, tooltips and sentences.
 * @level l2
 * @consumer terminfo.dev home, baseline, terminal, compare and full-scope pages plus the admin matrix
 * @source-grep the status words live in VitePress <script setup> blocks and Vue components, which no
 *   unit runner imports; each site is therefore pinned by the predicate and the words it must print,
 *   and the arithmetic it prints is exercised directly through the fold and the sentence.
 * @testonly none
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { Command } from "@silvery/commander"
import {
  ENVIRONMENT_GROUP_IDS,
  initializeRunDraft,
  recordCollectorSelection,
  recordCollectorAttempt,
  readCollectorAttempt,
} from "@terminfo/probe-defs"
import type { ProbeResult, CapturedRunDraft, ProbeSuiteManifest, RunDraft } from "@terminfo/probe-defs"
import * as publicCollector from "../packages/terminfo.dev/src/serve.ts"
import * as probeOutput from "../packages/terminfo.dev/src/probe-output.ts"
import * as daemonClient from "../packages/terminfo.dev/src/daemon-client.ts"
import { currentCoverageSentence, aggregateCurrentResults } from "../docs/data/release-scope.ts"
import { scopeAggregate } from "../docs/data/full-scope.ts"
import { evidenceStatus, NO_RESULT_STATUS } from "../docs/.vitepress/theme/evidence-status.ts"

const root = join(import.meta.dirname, "..")
const source = (path: string) => readFileSync(join(root, path), "utf8")
vi.mock("../packages/terminfo.dev/src/serve.ts", () => ({
  collectProbeRun: vi.fn(),
  getTrustedSuiteReceipt: vi.fn(),
  getCliSuiteProbeHash: () => "abcdef123456",
  listDaemons: vi.fn(),
  startDaemon: vi.fn(),
}))
vi.mock("../packages/terminfo.dev/src/daemon-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../packages/terminfo.dev/src/daemon-client.ts")>()),
  requestDaemonProbe: vi.fn(),
  readRetainedDaemonProbeResponse: vi.fn(),
}))
vi.mock("../packages/terminfo.dev/src/probe-output.ts", () => ({ probeOutputStream: vi.fn(() => undefined) }))
const gradedIds = Array.from({ length: 264 }, (_, index) => `capability.${index}`)
const catalogIds = [...ENVIRONMENT_GROUP_IDS, ...gradedIds]
const todos = (): ProbeResult[] =>
  catalogIds.map((featureId) => ({
    featureId,
    status: "probe-todo",
    attempt: { scope: "none" },
    tests: [],
    reason: "No implementation",
  }))

describe("public test CLI coverage uses the collected manifest", () => {
  let program: Command

  beforeAll(async () => {
    const parse = vi.spyOn(Command.prototype, "parse").mockReturnThis()
    try {
      await import("../packages/terminfo.dev/src/index.tsx")
      const parsed = parse.mock.contexts[0]
      if (!parsed) throw new Error("CLI entry point did not parse its command")
      program = parsed
      program.commands
        .find((command) => command.name() === "test")!
        .exitOverride()
        .configureOutput({ writeErr: () => {} })
    } finally {
      parse.mockRestore()
    }
  })

  // #37341 D2, D12: the CLI prints the one coverage readout; the environment rows add no clause and no position.
  it.each([
    ["current", catalogIds, undefined],
    ["historical", gradedIds, undefined],
    ["selected", catalogIds, ["device.primary-da"]],
    ["empty", catalogIds, []],
  ] as const)("prints the %s catalogue's coverage over its graded features only", async (_label, ids, probeIds) => {
    const manifest = {
      schemaVersion: 4 as const,
      probeHash: "abcdef123456",
      sourceRevision: "a".repeat(40),
      generatedAt: "2026-10-25T00:00:00.000Z",
      adapterVersion: "test",
      catalogIds: [...ids],
      probes: { term: [], lib: [], mux: [] },
    } satisfies ProbeSuiteManifest
    const run: CapturedRunDraft = {
      ...initializeRunDraft({
        source: { kind: "live" },
        runId: "1234567890abcdef1234567890abcdef",
        sourceRevision: manifest.sourceRevision,
        manifest,
        intendedSubject: { kind: "term", id: "kitty", version: "1" },
      }),
      subject: {
        kind: "term",
        id: "kitty",
        version: "1",
        os: "linux",
        osVersion: null,
        outerTerminal: null,
        mux: null,
        config: null,
        permissions: null,
      },
      identity: "unverified",
      measuredAt: "2026-10-25T00:00:00.000Z",
      origin: { kind: "collector" },
    }
    const response =
      probeIds?.length === 0
        ? initializeRunDraft({
            source: run.source,
            runId: run.runId,
            sourceRevision: run.sourceRevision,
            manifest,
            intendedSubject: run.intendedSubject,
          })
        : run
    if (probeIds?.length === 0) {
      recordCollectorSelection(response, [])
      recordCollectorAttempt(response, { ids: [], result: "empty" })
    }
    vi.mocked(publicCollector.collectProbeRun).mockClear().mockResolvedValue(response)
    vi.mocked(probeOutput.probeOutputStream).mockClear()
    vi.mocked(publicCollector.getTrustedSuiteReceipt).mockReturnValue({
      manifest,
      collectorRevision: manifest.sourceRevision,
    })
    const output = vi.spyOn(console, "log").mockImplementation(() => {})
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await program.parseAsync(
        [
          "test",
          ...(probeIds === undefined ? [] : ["--probe-ids", JSON.stringify(probeIds)]),
          ...(probeIds?.length === 0 ? ["--json"] : []),
        ],
        { from: "user" },
      )
      expect(publicCollector.collectProbeRun).toHaveBeenCalledTimes(1)
      expect(publicCollector.collectProbeRun).toHaveBeenCalledWith(probeIds === undefined ? {} : { ids: probeIds })
      if (probeIds?.length === 0) {
        expect(probeOutput.probeOutputStream).not.toHaveBeenCalled()
        const saved = JSON.parse(String(stdout.mock.calls[0]?.[0])) as RunDraft
        expect(saved.runId).toBe(run.runId)
        expect(readCollectorAttempt(saved.rawReplies)).toEqual({ ids: [], result: "empty" })
        expect(saved).not.toHaveProperty("subject")
        expect(saved).not.toHaveProperty("measuredAt")
        expect(saved).not.toHaveProperty("sealedAt")
        expect(stderr.mock.calls.flat().join(" ")).not.toContain("identity unverified")
        return
      }
      const summary = output.mock.calls.map(([line]) => line).find((line) => /\d+ of \d+ tested/.test(String(line)))
      expect(summary).toBe("0 of 264 tested")
    } finally {
      output.mockRestore()
      stdout.mockRestore()
      stderr.mockRestore()
    }
  })
  // AC1/AC5: inline argument coverage cannot detect a named-daemon filter being silently ignored.
  it("forwards explicit empty IDs to a named daemon and writes the retained unmeasured draft", async () => {
    const directory = mkdtempSync(join(tmpdir(), "terminfo-cli-empty-"))
    const manifest = {
      schemaVersion: 4 as const,
      probeHash: "abcdef123456",
      sourceRevision: "a".repeat(40),
      generatedAt: "2026-10-25T00:00:00.000Z",
      adapterVersion: "test",
      catalogIds,
      probes: { term: [], lib: [], mux: [] },
    }
    const run = initializeRunDraft({
      source: { kind: "live" },
      runId: "named-empty-cli",
      manifest,
      sourceRevision: manifest.sourceRevision,
      intendedSubject: { kind: "term", id: "kitty" },
    })
    recordCollectorSelection(run, [])
    recordCollectorAttempt(run, { ids: [], result: "empty" })
    const raw = JSON.stringify(run)
    const path = join(directory, "original-response")
    writeFileSync(path, raw)
    const daemon = {
      pid: 22,
      port: 43210,
      runId: "daemon",
      token: "a".repeat(64),
      terminal: "kitty",
      terminalVersion: "1",
      os: "linux",
      osVersion: "fixture",
      started: "2026-10-25T00:00:00.000Z",
    }
    vi.mocked(publicCollector.listDaemons).mockReturnValue([daemon])
    vi.mocked(daemonClient.requestDaemonProbe).mockClear().mockResolvedValue(new Response(raw))
    vi.mocked(daemonClient.readRetainedDaemonProbeResponse).mockResolvedValue({
      kind: "empty-selection",
      run,
      path,
      sha256: createHash("sha256").update(raw).digest("hex"),
    })
    vi.mocked(probeOutput.probeOutputStream).mockClear()
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await program.parseAsync(["test", "kitty", "--probe-ids", "[]", "--json"], { from: "user" })
      expect(daemonClient.requestDaemonProbe).toHaveBeenCalledWith(daemon, undefined, [])
      expect(stdout).toHaveBeenCalledWith(raw)
      expect(probeOutput.probeOutputStream).not.toHaveBeenCalled()
      expect(stderr.mock.calls.flat().join(" ")).toContain("no probes executed")
    } finally {
      stdout.mockRestore()
      stderr.mockRestore()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  // Raw CLI output is diagnostic custody, including runs with no pending review.
  // Coverage summaries above never inspect emitted run bytes or the daemon finalizer.
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
    [false, false, true],
  ])(
    "retains public collected results (daemon=%s, review=%s, human=%s)",
    async (daemon, pending, human: boolean = false) => {
      const manifest = {
        schemaVersion: 4 as const,
        probeHash: "abcdef123456",
        sourceRevision: "a".repeat(40),
        generatedAt: "2026-10-25T00:00:00.000Z",
        adapterVersion: "test",
        catalogIds: ["sgr.bold"],
        catalogEntrySha256: { "sgr.bold": "b".repeat(64) },
        probes: { term: [], lib: [], mux: [] },
      } satisfies ProbeSuiteManifest
      const run: CapturedRunDraft = {
        ...initializeRunDraft({
          source: { kind: "live" },
          runId: "raw-cli-draft",
          manifest,
          sourceRevision: manifest.sourceRevision,
          intendedSubject: { kind: "term", id: "kitty", version: "1" },
        }),
        subject: {
          kind: "term",
          id: "kitty",
          version: "1",
          os: "linux",
          osVersion: null,
          outerTerminal: null,
          mux: null,
          config: null,
          permissions: null,
        },
        identity: "unverified",
        measuredAt: "2026-10-25T00:00:00.000Z",
        origin: { kind: "collector" },
      }
      if (pending) {
        run.rawReplies["sgr.bold"] = "reply"
        run.assertions = [
          {
            featureId: "sgr.bold",
            kind: "positive",
            assertionType: "query_reply",
            expected: "reply",
            observed: "reply",
            rawReplyRef: "sgr.bold",
          },
        ]
        run.results[0] = {
          featureId: "sgr.bold",
          status: "probe-todo",
          reason: "Independent review pending",
          assertionType: "query_reply",
          rawReplyRef: "sgr.bold",
          attempt: { scope: "probe", startedAt: run.measuredAt },
          tests: [
            {
              id: "capture",
              status: "supported",
              assertionRefs: [0],
              attempt: { scope: "probe", startedAt: run.measuredAt },
            },
            { id: "review", status: "probe-todo", reason: "Independent review pending", attempt: { scope: "none" } },
          ],
        }
      }
      vi.mocked(publicCollector.collectProbeRun).mockResolvedValue(run)
      vi.mocked(publicCollector.getTrustedSuiteReceipt).mockReturnValue({
        manifest,
        collectorRevision: manifest.sourceRevision,
      })
      vi.mocked(publicCollector.listDaemons).mockReturnValue([
        {
          pid: 22,
          port: 43210,
          runId: "daemon",
          token: "a".repeat(64),
          terminal: "kitty",
          terminalVersion: "1",
          os: "linux",
          osVersion: "fixture",
          started: "2026-10-25T00:00:00.000Z",
        },
      ])
      vi.mocked(daemonClient.requestDaemonProbe).mockResolvedValue(new Response(JSON.stringify(run)))
      vi.mocked(daemonClient.readRetainedDaemonProbeResponse).mockResolvedValue({
        kind: "captured",
        run,
        path: "/unused-retained-response",
        sha256: "a".repeat(64),
      })
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {})
      const output = vi.spyOn(console, "log").mockImplementation(() => {})
      try {
        await program.parseAsync(["test", ...(daemon ? ["kitty"] : []), ...(human ? [] : ["--json"])], { from: "user" })
        if (human) {
          const diagnostic = output.mock.calls.flat().join(" ")
          expect(diagnostic).toContain("incomplete; identity unverified")
          expect(diagnostic).not.toContain("required review pending")
          return
        }
        const saved = JSON.parse(String(stdout.mock.calls[0]?.[0])) as CapturedRunDraft
        expect(saved.runId).toBe(run.runId)
        expect(saved).not.toHaveProperty("sealedAt")
        if (pending) {
          expect(saved.rawReplies["sgr.bold"]).toBe("reply")
          expect(saved.results.find((row) => row.featureId === "sgr.bold")).toMatchObject({
            status: "probe-todo",
            rawReplyRef: "sgr.bold",
            tests: expect.arrayContaining([
              { id: "review", status: "probe-todo", reason: "Independent review pending", attempt: { scope: "none" } },
            ]),
          })
        }
      } finally {
        stdout.mockRestore()
        stderr.mockRestore()
        output.mockRestore()
      }
    },
  )
  it("passes exact probe IDs into the existing daemon startup selection input", async () => {
    const before = process.env.TERMINFO_PROBE_IDS
    vi.mocked(publicCollector.startDaemon).mockClear()
    try {
      await program.parseAsync(["test", "--serve", "--probe-ids", '["device.primary-da"]'], { from: "user" })
      expect(process.env.TERMINFO_PROBE_IDS).toBe('["device.primary-da"]')
      expect(publicCollector.startDaemon).toHaveBeenCalledWith(0)
    } finally {
      if (before === undefined) delete process.env.TERMINFO_PROBE_IDS
      else process.env.TERMINFO_PROBE_IDS = before
    }
  })
})

describe("#30917 environment groups are never graded, and never PROBE TODO", () => {
  // #37341 D2 supersedes the named clause: the readout counts the graded features only and names no group.
  it("counts the graded features only and names no environment group", () => {
    const bar = aggregateCurrentResults(todos(), catalogIds)
    expect(bar.denominator).toBe(264)
    expect(currentCoverageSentence(bar, catalogIds)).toBe("0 of 264 tested")
    expect(currentCoverageSentence(bar)).toBe("0 of 264 tested")
  })

  it("scores 264 of 273 catalogue positions and keeps every recorded position counted as one", () => {
    const scope = scopeAggregate({ scope: "app:kitty", catalogIds, results: todos() })
    expect(scope.catalogRows).toBe(273)
    expect(scope.denominator).toBe(264)
    expect(scope.fraction).toBe("0/264")
    const manual = scope.groups.filter((group) => group.key === "capability")
    expect(manual.map((group) => group.catalogRows)).toEqual([264])
  })

  it("wires the home page bar, tooltip and legend to the one predicate", () => {
    const home = source("docs/index.md")
    // #37761: the bar, its popover lists and their counts all read the bar's own fold, whose ids come from
    // scoredFeatureIds, so no environment group can be drawn, listed or counted.
    expect(home).toContain("rowFacts(data)")
    expect(source("docs/.vitepress/theme/row-facts.ts")).toContain("categoryIds(bar)")
    expect(source("docs/data/result-categories.ts")).toContain("const ids = bar.idsByState")
    expect(source("docs/data/release-scope.ts")).toContain("for (const id of scoredFeatureIds(catalogIds)) {")
    expect(home).toContain("currentCoverageSentence(bar, displayedSelections[backendName]?.selected.catalogIds)")
    // #37341 Q2: the public catalogue holds no environment position, so no public page names one.
    expect(home).not.toMatch(/manual[ -]by[ -]design/i)
  })

  it("wires the baseline bar and its meta line to the one predicate", () => {
    const baseline = source("docs/baseline/[id].md")
    // #37761 7d: the rows are home's Baseline-card rows, over this baseline's graded features only.
    expect(baseline).toContain("const within = features.map(f => f.id).filter(id => !isEnvironmentGroup(id))")
    expect(baseline).toContain(':ids="facts.within(s.name, within, p.id)"')
    expect(baseline).not.toMatch(/manual[ -]by[ -]design/i)
    // #33441: the printed words are the one row readout, so the page delegates; #37341 D2: the helper prints the
    // shared two counts and nothing else.
    expect(baseline).toContain(':readout="shareRow(s).text"')
    expect(baseline).toContain("return baselineReadout(s)")
    const readouts = source("docs/data/baseline-readouts.ts")
    expect(readouts).toContain("`${currentSupportedShare(stats)} · ${currentCoverageSentence(stats)}`")
  })

  it("wires the terminal page's coverage sentence to the run's own catalogue", () => {
    const terminal = source("docs/terminals/[id].md")
    expect(terminal).toContain("currentCoverageSentence(measuredBar, selectedRun.catalogIds)")
    expect(terminal).not.toMatch(/manual[ -]by[ -]design/i)
    // #37341 Q4: the published cells fold over the run's own catalogue, so an unpublished cell counts as no result.
    expect(terminal).toContain("aggregateCurrentResults(rollupInputs(p.backendId, selection), selection.catalogIds)")
    expect(terminal).toContain("const defaultRun = data.selectedByBackend[p.backendId]?.selected")
    expect(terminal).toContain("runSha.value ? recordedRuns.find(run => run.sha256 === runSha.value) : defaultRun")
  })

  it("gives the evidence cell the manual-by-design words only for a stored PROBE TODO", () => {
    const cell = source("docs/.vitepress/theme/ResultEvidenceCell.vue")
    expect(cell).toContain(
      "evidenceStatus(props.featureId, joined.value?.status ?? currentResult.value?.status, derived.value)",
    )
  })

  it("renders a stored supported environment row as Supported, never NOT MEASURED (D1)", () => {
    // @cto 98cd142b D1: the projection keeps a stored status on an environment row, so a blanket
    // environment override would publish "NOT MEASURED" over a real measurement.
    expect(evidenceStatus("device.env-term", "supported")).toEqual({ text: "Supported", icon: "✓", tone: "yes" })
    expect(evidenceStatus("device.env-term", "unsupported").text).toBe("Unsupported")
    // #33019: only an Unsupported cell can wear the derived words.
    expect(evidenceStatus("extensions.kitty-graphics.display", "unsupported", true).text).toBe("Unsupported, derived")
    expect(evidenceStatus("extensions.kitty-graphics.display", "untestable", true).text).toBe("Untestable")
    // #37341 Q1: every undecided status, on an environment row or a graded one, is the one blank: no label.
    expect(evidenceStatus("device.env-term", "probe-invalid")).toBe(NO_RESULT_STATUS)
    expect(evidenceStatus("device.env-term", "probe-todo")).toBe(NO_RESULT_STATUS)
    expect(evidenceStatus("sgr.bold", "probe-todo")).toBe(NO_RESULT_STATUS)
    expect(evidenceStatus("sgr.bold", "probe-conflict")).toBe(NO_RESULT_STATUS)
    expect(evidenceStatus("sgr.bold", undefined)).toBe(NO_RESULT_STATUS)
  })

  it("publishes the term-feature denominator and manual environment groups as contract text", () => {
    // #37341 D2, D6: the API states the graded denominator and that an undecided result is absent.
    const api = source("docs/api.md")
    expect(api).toContain("`score.all` is the number of graded features (264")
    expect(api).toContain("A result we haven't decided is left blank")
    expect(api).not.toMatch(/manual by design|PROBE TODO|NOT MEASURED/)
    const full = source("docs/release/full-273.md")
    expect(full).toContain("data.gradedRows")
    expect(full).toContain("data.environmentGroups")
    expect(full).toContain("(manual by design)")
    expect(full).toContain("zero PROBE TODO, zero PROBE INVALID and zero PROBE CONFLICT among the term features")
  })

  it("names the nine on the OS page tooltip too (D2)", () => {
    const os = source("docs/os/[id].paths.ts")
    expect(os).toContain("currentCoverageSentence(stats, data.selectedByBackend[source.name]?.selected.catalogIds)")
  })
})
