import { finalizeCollectedDraft } from "../packages/terminfo.dev/src/capture-writer.ts"
/**
 * @failure Erase replay loses domain results, precondition identity or fixed artifact placement.
 * @level l2
 * @consumer Phase0 erase runner with owned source adapter identity.
 * @reach fs-walk <fixture-only: generated erase capture, assertions, reports and attachments>
 * @testonly none
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { basename, dirname, join } from "node:path"
import { expect, test, vi } from "vitest"
import { createVitest } from "vitest/node"
import CensusReporter from "../packages/admin/reporter.ts"
import { type CapturedRunDraft } from "@terminfo/probe-defs"
import { derivedSuiteManifest, probeSuiteSnapshot } from "../packages/admin/versions.ts"
import { readEraseCapture } from "../packages/probes/erase-capture.ts"
import { HEADLESS_TERMINAL } from "../packages/probes/headless-terminal.ts"
import { parseRun } from "@terminfo/run-parser"

test("production erase configuration isolates reports for repeated invocations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "terminfo-replay-config-"))
  vi.doMock("../packages/probes/erase-store.ts", () => ({ ERASE_REPLAY_ROOT: directory }))
  try {
    const { default: configure } = await import("../packages/probes/erase.vitest.config.ts")
    const first = await configure({ command: "serve", mode: "test" })
    const second = await configure({ command: "serve", mode: "test" })
    expect(first.test?.attachmentsDir).not.toBe(second.test?.attachmentsDir)
    for (const config of [first, second]) {
      expect(config.test?.attachmentsDir?.startsWith(directory + "/")).toBe(true)
    }
  } finally {
    vi.doUnmock("../packages/probes/erase-store.ts")
    await rm(directory, { recursive: true, force: true })
  }
})

test.for(["success", "deciding", "precondition", "replay-failure", "painted-seed"] as const)(
  "actual erase entry persists domain results: %s",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "terminfo-erase-run-"))
    const home = directory
    const reporter = new CensusReporter(directory)
    const nativeStates: string[] = []
    const runtime = await createVitest({
      root: join(dirname(import.meta.filename), "../packages/probes"),
      config: false,
      include: [mode === "success" ? "erase-replay.probe.ts" : "fixtures/erase-fault.fixture.ts"],
      setupFiles: ["fixtures/erase-home.fixture.ts"],
      provide: {
        eraseTestHome: home,
        eraseFault: mode === "success" ? "deciding" : mode,
      },
      reporters: [
        reporter,
        {
          onTestCaseResult(task) {
            nativeStates.push(task.result().state)
          },
        },
      ],
      attachmentsDir: join(directory, "vitest-attachments"),
      watch: false,
      maxWorkers: 1,
    })
    try {
      await runtime.start()
      expect(reporter.records).toHaveLength(1)
      const record = reporter.records[0]!
      expect(nativeStates, String(record.error)).toEqual([mode === "success" ? "passed" : "failed"])
      const reportFiles = (await readdir(directory)).filter((path) => path.endsWith(".report.json"))
      expect(reportFiles).toHaveLength(1)
      const report = JSON.parse(await readFile(join(directory, reportFiles[0]!), "utf8"))
      const counts =
        mode === "success"
          ? { supported: 11 }
          : mode === "deciding"
            ? { supported: 10, unsupported: 1 }
            : mode === "precondition" || mode === "painted-seed"
              ? { supported: 10, "test-failure": 1 }
              : { "test-failure": 11 }
      expect(report, record.error).toMatchObject({ counts })
      // Automatic trace evaluation is diagnostic too; old outcome checks missed its implicit seal.
      const rawPath = record.files[0]
      if (!rawPath) throw new Error("Missing raw capture for derived assertion binding")
      const rawBytes = await readFile(rawPath, "utf8")
      const suite = derivedSuiteManifest(probeSuiteSnapshot())
      for (const run of record.assertions) {
        const path = join(dirname(rawPath), run.runId + ".assertion.draft.json")
        expect(record.files).toContain(path)
        const bytes = await readFile(path, "utf8")
        expect(JSON.parse(bytes)).not.toHaveProperty("sealedAt")
        expect(parseRun(path, bytes, suite.catalogIds!, new Map([[suite.probeHash, suite]])).runId).toBe(run.runId)
        expect(run.source).toMatchObject({
          kind: "trace",
          captureRunId: record.captureRunId,
          trace: { path: basename(rawPath), sha256: createHash("sha256").update(rawBytes).digest("hex") },
        })
      }
      if (mode === "replay-failure") {
        expect(record.error).toMatch(/after the first completed assertion/)
        expect(record.assertions).toHaveLength(1)
        expect(
          record.assertions[0]?.results
            .filter(({ attempt }) => attempt.scope !== "none")
            .every(({ status }) => status === "supported"),
        ).toBe(true)
        expect(record.failureResults).toHaveLength(11)
        expect(record.failureResults?.every(({ status }) => status === "test-failure")).toBe(true)
        expect(record.failureResults?.every(({ attempt }) => attempt.scope === "collection")).toBe(true)
        return
      }
      expect(record.error).toBeUndefined()
      // Accepted identity requirement: real erase captures must bind the imported adapter,
      // which the previous outcome-only assertions did not inspect.
      for (const run of record.assertions) {
        expect(run.runtimeIdentity?.adapterSources?.length).toBeGreaterThan(0)
        expect(run.runtimeIdentity?.adapterSources?.every(({ blobOid }) => /^[a-f0-9]{40}$/.test(blobOid))).toBe(true)
      }
      const capturePath = record.files[0]
      if (!capturePath) throw new Error("Missing real erase capture")
      const capture = JSON.parse(await readFile(capturePath, "utf8")) as CapturedRunDraft
      // Raw capture and automatically derived assertions both remain diagnostic drafts.
      expect(capturePath).toMatch(/\.draft\.json$/)
      expect(capture).not.toHaveProperty("sealedAt")
      if (mode === "success") {
        // The raw reader must accept historical sealed inputs too, while its byte binding remains strict.
        const source = record.assertions[0]!.source
        if (source.kind !== "trace" || !capture.runtimeIdentity) throw new Error("Missing erase trace identity")
        const expected = {
          manifest: derivedSuiteManifest(probeSuiteSnapshot()),
          sourceRevision: capture.sourceRevision,
          subject: capture.subject,
          runtimeIdentity: capture.runtimeIdentity,
          geometry: HEADLESS_TERMINAL,
        }
        expect(readEraseCapture(dirname(capturePath), source, expected).capture.runId).toBe(capture.runId)
        const historicalBytes = JSON.stringify(finalizeCollectedDraft(structuredClone(capture)))
        const historicalPath = join(dirname(capturePath), "historical-capture.json")
        await writeFile(historicalPath, historicalBytes)
        const historicalSource = {
          ...source,
          trace: {
            path: "historical-capture.json",
            sha256: createHash("sha256").update(historicalBytes).digest("hex"),
          },
        }
        expect(readEraseCapture(dirname(capturePath), historicalSource, expected).capture.runId).toBe(capture.runId)
        await writeFile(historicalPath, historicalBytes + "\n")
        expect(() => readEraseCapture(dirname(capturePath), historicalSource, expected)).toThrow(
          "Replay artifact SHA256 differs",
        )
      }
      expect(capture.runtimeIdentity?.adapterSources).toEqual(record.assertions[0]?.runtimeIdentity?.adapterSources)
      expect(record.files.length).toBeGreaterThan(0)
      expect(record.files.every((path) => path.startsWith(join(directory, ".terminfo-dev", "replays") + "/"))).toBe(
        true,
      )
      expect(record.assertions).toHaveLength(2)
      expect(new Set([record.captureRunId, ...record.assertions.map(({ runId }) => runId)]).size).toBe(3)
      const outcomes = record.checks.map((records) => records.map(({ startedAt: _startedAt, ...outcome }) => outcome))
      expect(outcomes[1]).toEqual(outcomes[0])
      for (const [runIndex, run] of record.assertions.entries()) {
        expect(run).not.toHaveProperty("sealedAt")
        expect(run.source).toMatchObject({ kind: "trace", captureRunId: record.captureRunId })
        expect(run.results).toHaveLength(273)
        const selected = run.results.filter(({ attempt }) => attempt.scope !== "none")
        expect(selected).toHaveLength(11)
        expect(
          Object.fromEntries(
            selected.map(({ featureId, attempt }) => [
              featureId,
              attempt.scope === "none" ? undefined : attempt.startedAt,
            ]),
          ),
        ).toEqual(
          Object.fromEntries(record.checks[runIndex]!.map(({ featureId, startedAt }) => [featureId, startedAt])),
        )
        const target = mode === "painted-seed" ? "erase.el-with-attrs" : "erase.character"
        const character = selected.find(({ featureId }) => featureId === target)
        expect(character?.status).toBe(
          mode === "deciding"
            ? "unsupported"
            : mode === "precondition" || mode === "painted-seed"
              ? "test-failure"
              : "supported",
        )
        if (mode === "painted-seed") {
          const capture = record.files[0]
          if (!capture) throw new Error("Missing painted-seed capture path")
          const live = JSON.parse(await readFile(join(dirname(capture), "painted-seed-live.json"), "utf8"))
          expect(live).not.toHaveProperty("observation")
          expect(live).not.toHaveProperty("assertions")
          expect(character?.criterionBranch).toBeUndefined()
          expect(live).toHaveProperty(
            "tests",
            character?.tests.map(({ id, status, reason }) => ({ id, status, reason })),
          )
          expect(character?.tests.every(({ assertionRefs }) => assertionRefs?.length === 0)).toBe(true)
        }
        expect(
          selected.filter(({ featureId }) => featureId !== target).every(({ status }) => status === "supported"),
        ).toBe(true)
      }
      for (const path of record.files) expect(JSON.parse(await readFile(path, "utf8"))).toBeTruthy()
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
)
