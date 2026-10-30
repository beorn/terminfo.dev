/**
 * @failure Recorder checks lose their task, evaluate twice, stop at a soft mismatch, reach the reporter before attachments finish, or get reported from native pass counts instead of retained domain results.
 * @level l2
 * @consumer The approved Phase0 Terminfo recorder/check adapter on installed Vitest5.0.4.
 * @reach runs an isolated Vitest fixture with concurrent native soft failures, TaskMeta and artifact delivery.
 * @reach fs-walk <fixture-only: generated erase capture, assertion, report and attachment directory>
 * @testonly none
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { expect, test } from "vitest"
import CensusReporter from "../admin/reporter.ts"
import { createVitest, version, type Reporter } from "vitest/node"
import type { RuntimeArtifact } from "./fixtures/vitest-runtime.fixture.ts"

test("installed Vitest preserves task-owned checks and awaited reporter attachments", async () => {
  expect(version).toBe("5.0.4")
  const artifacts = new Map<string, RuntimeArtifact>()
  const artifactBytes = new Map<string, unknown>()
  const finalRecordBytes = new Map<string, unknown>()
  const matcherEvaluations: number[] = []
  const contracts: unknown[] = []
  const completed: Array<{ id: string; name: string; state: string; errors: string[]; attachmentsReady: boolean }> = []
  const directory = await mkdtemp(join(tmpdir(), "terminfo-vitest-runtime-"))
  const reporter: Reporter = {
    onTestModuleCollected(module) {
      for (const error of module.errors()) console.error("runtime fixture collection: " + error.message)
    },
    async onTestCaseArtifactRecord(task, artifact) {
      if (artifact.type !== "terminfo:runtime-proof") return
      const path = artifact.attachments?.[0]?.path
      if (!path) throw new Error("Vitest did not persist the recorded artifact attachment")
      artifacts.set(task.id, artifact)
      artifactBytes.set(task.id, JSON.parse(await readFile(path, "utf8")))
    },
    // Public TaskMeta survives failed tasks; final records are persisted here, never through final annotate.
    async onTestCaseResult(task) {
      const contract = task.meta().terminfoCheckContract
      if (contract) {
        contracts.push({ ...contract, state: task.result().state })
        return
      }
      const finalRecord = task.meta().terminfoRuntimeProof
      const evaluations = task.meta().terminfoMatcherEvaluations
      if (typeof evaluations === "number") matcherEvaluations.push(evaluations)
      if (!finalRecord) {
        throw new Error(
          "Vitest did not deliver the failed task's final metadata: " +
            task
              .result()
              .errors?.map((error) => error.message)
              .join("; "),
        )
      }
      const path = join(directory, `${task.id}.final.json`)
      await writeFile(path, JSON.stringify(finalRecord))
      finalRecordBytes.set(task.id, JSON.parse(await readFile(path, "utf8")))
      completed.push({
        id: task.id,
        name: task.name,
        state: task.result().state,
        errors: task.result().errors?.map((error) => error.message) ?? [],
        attachmentsReady: artifactBytes.has(task.id) && finalRecordBytes.has(task.id),
      })
    },
  }
  const runtime = await createVitest({
    root: dirname(import.meta.filename),
    config: false,
    include: ["fixtures/vitest-runtime.fixture.ts"],
    reporters: [reporter],
    attachmentsDir: directory,
    watch: false,
    maxWorkers: 1,
  })
  try {
    await runtime.start()
    expect(completed).toHaveLength(2)
    expect(contracts).toEqual([{ finishThrew: true, prematureCount: null, state: "failed" }])
    expect(Math.max(...matcherEvaluations)).toBe(4)
    expect(new Set(completed.map((task) => task.id)).size).toBe(2)
    for (const [label, value] of [
      ["left", 10],
      ["right", 20],
    ] as const) {
      const task = completed.find((item) => item.name === `native soft continuation ${label}`)
      expect(task).toMatchObject({
        state: "failed",
        errors: ["runtime proof deliberately includes a soft mismatch"],
        attachmentsReady: true,
      })
      if (!task) throw new Error(`Missing completed runtime fixture: ${label}`)
      const checks = [
        { taskId: task.id, label, received: value, expected: value + 1, ok: false },
        { taskId: task.id, label, received: value, expected: value, ok: true },
      ]
      expect(artifacts.get(task.id)).toMatchObject({ taskId: task.id, checks })
      const retainedChecks = [
        {
          step: 1,
          kind: "assertion",
          matcher: "toRecorderRuntimeEqual",
          arguments: [value + 1],
          expected: value + 1,
          actual: value,
          ok: false,
        },
        {
          step: 2,
          kind: "precondition",
          matcher: "toRecorderRuntimeEqual",
          arguments: [value],
          expected: value,
          actual: value,
          ok: true,
        },
      ]
      expect(artifacts.get(task.id)?.retainedChecks).toEqual(retainedChecks)
      expect(artifactBytes.get(task.id)).toEqual(retainedChecks)
      expect(finalRecordBytes.get(task.id)).toEqual({ taskId: task.id, checks, retainedChecks })
    }
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)

test.for(["success", "capture-failure", "deciding", "precondition", "replay-failure", "painted-seed"] as const)(
  "actual erase entry persists domain results: %s",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "terminfo-erase-run-"))
    const reporter = new CensusReporter(directory)
    const nativeStates: string[] = []
    const runtime = await createVitest({
      root: dirname(import.meta.filename),
      config: false,
      include: [
        mode === "success" || mode === "capture-failure" ? "erase-replay.probe.ts" : "fixtures/erase-fault.fixture.ts",
      ],
      provide: {
        eraseArtifactRoot: mode === "capture-failure" ? "relative-store-is-invalid" : directory,
        eraseFault: mode === "success" || mode === "capture-failure" ? "deciding" : mode,
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
            : mode === "precondition" || mode === "painted-seed"
              ? { supported: 10, "test-failure": 1 }
              : { "test-failure": 11 }
      expect(report).toMatchObject({ counts })
      if (mode === "capture-failure") {
        expect(record.error).toMatch(/explicit absolute path/)
        expect(record.assertions).toEqual([])
        expect(record.failureResults).toHaveLength(11)
        expect(record.failureResults?.every(({ status }) => status === "test-failure")).toBe(true)
        expect(record.failureResults?.every(({ attempt }) => attempt.scope === "collection")).toBe(true)
        return
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
          const live = JSON.parse(await readFile(join(directory, "painted-seed-live.json"), "utf8"))
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
