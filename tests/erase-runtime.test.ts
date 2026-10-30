/**
 * @failure Erase capture/assertion reports lose domain results on success, deciding, precondition or replay failure.
 * @level l2
 * @consumer Phase0 erase recorder entry on installed Vitest5.0.4 with owned source adapter identity.
 * @reach fs-walk <fixture-only: generated erase capture, assertion, report and attachment directory>
 * @testonly none
 */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { expect, test } from "vitest"
import { createVitest } from "vitest/node"
import CensusReporter from "../packages/admin/reporter.ts"

test.for(["success", "deciding", "precondition", "replay-failure"] as const)(
  "actual erase entry persists domain results: %s",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "terminfo-erase-run-"))
    const reporter = new CensusReporter(directory)
    const nativeStates: string[] = []
    const runtime = await createVitest({
      root: join(dirname(import.meta.filename), "../packages/probes"),
      config: false,
      include: [mode === "success" ? "erase-replay.probe.ts" : "fixtures/erase-fault.fixture.ts"],
      provide: {
        eraseArtifactRoot: directory,
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
      expect(nativeStates).toEqual([mode === "success" ? "passed" : "failed"])
      const reportFiles = (await readdir(directory)).filter((path) => path.endsWith(".report.json"))
      expect(reportFiles).toHaveLength(1)
      const report = JSON.parse(await readFile(join(directory, reportFiles[0]!), "utf8"))
      const counts =
        mode === "success"
          ? { supported: 11 }
          : mode === "deciding"
            ? { supported: 10, unsupported: 1 }
            : mode === "precondition"
              ? { supported: 10, "test-failure": 1 }
              : { "test-failure": 11 }
      expect(report).toMatchObject({ counts })
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
      expect(record.assertions).toHaveLength(2)
      expect(new Set([record.captureRunId, ...record.assertions.map(({ runId }) => runId)]).size).toBe(3)
      const outcomes = record.checks.map((records) => records.map(({ startedAt: _startedAt, ...outcome }) => outcome))
      expect(outcomes[1]).toEqual(outcomes[0])
      for (const [runIndex, run] of record.assertions.entries()) {
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
        const character = selected.find(({ featureId }) => featureId === "erase.character")
        expect(character?.status).toBe(
          mode === "deciding" ? "unsupported" : mode === "precondition" ? "test-failure" : "supported",
        )
        expect(
          selected
            .filter(({ featureId }) => featureId !== "erase.character")
            .every(({ status }) => status === "supported"),
        ).toBe(true)
      }
      for (const path of record.files) expect(JSON.parse(await readFile(path, "utf8"))).toBeTruthy()
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
)
