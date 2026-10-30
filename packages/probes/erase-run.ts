/** Runner-owned immutable capture, offline assertion, native metadata and artifact lifecycle. */
import { recordArtifact, type TestArtifactBase, type TestContext } from "vitest"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join, isAbsolute } from "node:path"
import { platform, release } from "node:os"
import {
  ALL_PROBES,
  initializeRunDraft,
  sealRunDraft,
  recordExecutedProbe,
  type CapturedRunDraft,
  type CurrentProbeRun,
  type ProbeResult,
} from "@terminfo/probe-defs"
import {
  derivedSuiteManifest,
  probeSuiteSnapshot,
  sourceSuiteEnvironment,
  uncommittedCollectorDirt,
} from "../admin/versions.ts"
import { saveDaemonProbeRun } from "../terminfo.dev/src/capture-writer.ts"
import { headlessRuntimeIdentity } from "./headless-identity.ts"
import { HEADLESS_TERMINAL } from "./headless-terminal.ts"
import { eraseProbes } from "../probe-defs/src/erase.ts"
import { captureEraseCalls, replayEraseCalls } from "./erase-replay.ts"
import { readEraseCapture } from "./erase-capture.ts"

type EraseRecords = ReturnType<typeof replayEraseCalls>
export interface EraseRunRecord {
  captureRunId?: string
  assertions: CurrentProbeRun[]
  checks: EraseRecords[]
  files: string[]
  error?: string
  failureResults?: ProbeResult[]
}
interface EraseArtifact extends TestArtifactBase {
  type: "terminfo:erase"
}
const eraseArtifactKey = Symbol("terminfo:erase")
declare module "vitest" {
  interface TaskMeta {
    terminfoErase?: EraseRunRecord
  }
  interface ProvidedContext {
    eraseArtifactRoot: string
  }
  interface TestArtifactRegistry {
    [eraseArtifactKey]: EraseArtifact
  }
}

export async function runEraseReplay(context: TestContext, directory: string): Promise<EraseRunRecord> {
  const finalRecord: EraseRunRecord = { assertions: [], checks: [], files: [] }
  let failure: unknown
  let failed = false
  const fail = (error: unknown) => {
    failed = true
    failure = error
    const message = error instanceof Error ? error.message : String(error)
    finalRecord.error = message
    finalRecord.failureResults = eraseProbes.map(({ id }) =>
      recordExecutedProbe({
        featureId: id,
        attempt: { scope: "probe", startedAt: new Date().toISOString() },
        assertions: [],
        diagnostic: { kind: "collector-error", name: error instanceof Error ? error.name : "Error", message },
      }),
    )
  }
  try {
    if (!isAbsolute(directory)) throw new Error("Erase artifact directory must be an explicit absolute path")
    const snapshot = probeSuiteSnapshot()
    const dirt = uncommittedCollectorDirt(undefined, snapshot)
    if (dirt) throw new Error("Erase capture requires committed source inputs:\n" + dirt)
    const manifest = derivedSuiteManifest(snapshot)
    const sourceRevision = sourceSuiteEnvironment().TERMINFO_SOURCE_REVISION
    const runtimeIdentity = await headlessRuntimeIdentity("xtermjs", "@termless/xtermjs", "js")
    const subject = {
      kind: "lib" as const,
      id: "xtermjs",
      version: runtimeIdentity.engineVersion,
      os: platform(),
      osVersion: release(),
      outerTerminal: null,
      mux: null,
      config: "default",
      permissions: null,
    }
    const measuredAt = new Date().toISOString()
    const capture: CapturedRunDraft = {
      ...initializeRunDraft({
        runId: randomUUID(),
        manifest,
        sourceRevision,
        source: { kind: "live" },
        intendedSubject: subject,
      }),
      subject,
      runtimeIdentity,
      identity: "verified",
      measuredAt,
      origin: { kind: "collector" },
    }
    const recorded = captureEraseCalls(context)
    capture.rawReplies["collector.callLog"] = JSON.stringify(recorded.log)
    capture.rawReplies["collector.captureChecks"] = JSON.stringify(recorded.results)
    capture.rawReplies["collector.traceManifest"] = JSON.stringify({
      captureKind: "buffer_state",
      geometry: HEADLESS_TERMINAL,
      blobs: [],
    })
    mkdirSync(directory, { recursive: true })
    const capturePath = saveDaemonProbeRun(capture, directory)
    finalRecord.captureRunId = capture.runId
    finalRecord.files.push(capturePath)
    const source = {
      kind: "trace" as const,
      trace: {
        path: basename(capturePath),
        sha256: createHash("sha256").update(readFileSync(capturePath)).digest("hex"),
      },
      captureRunId: capture.runId,
      captureSuiteId: capture.suiteId,
      captureSourceRevision: sourceRevision,
    }
    const expected = { manifest, sourceRevision, subject, runtimeIdentity, geometry: HEADLESS_TERMINAL }
    for (let attempt = 0; attempt < 2; attempt++) {
      const assertion: CapturedRunDraft = {
        ...initializeRunDraft({ runId: randomUUID(), manifest, sourceRevision, source, intendedSubject: subject }),
        subject: { ...subject },
        runtimeIdentity,
        identity: capture.identity,
        measuredAt,
        origin: { ...capture.origin },
      }
      const validated = readEraseCapture(directory, source, expected)
      const records = replayEraseCalls(validated.log, context)
      for (const { featureId, result, checks } of records) {
        if (!ALL_PROBES.some(({ id }) => id === featureId))
          throw new Error("Erase result outside catalogue: " + featureId)
        if (result.response !== undefined) assertion.rawReplies[featureId] = result.response
        for (const item of result.assertions ?? [])
          assertion.assertions.push({ ...item, featureId, rawReplyRef: featureId })
        const precondition = checks.find((check) => check.kind === "precondition" && !check.ok)
        const domain = recordExecutedProbe({
          featureId,
          attempt: { scope: "probe", startedAt: new Date().toISOString() },
          assertions: assertion.assertions,
          tests: result.tests,
          criterionBranch: result.criterionBranch,
          observation: result.observation && { ...result.observation, featureId, rawReplyRef: featureId },
          coverage: result.notTested && { ...result.notTested, featureId, rawReplyRef: featureId },
          diagnostic: precondition
            ? {
                kind: "collector-error",
                name: "PreconditionFailed",
                message: "Erase precondition failed: " + precondition.matcher,
              }
            : undefined,
          rawReplyRef: featureId,
        })
        const index = assertion.results.findIndex((entry) => entry.featureId === featureId)
        if (index < 0) throw new Error("Erase result missing from declared catalogue: " + featureId)
        assertion.results[index] = domain
      }
      const sealed = sealRunDraft(assertion)
      const path = join(directory, assertion.runId + ".assertion.json")
      const checksPath = join(directory, assertion.runId + ".checks.json")
      writeFileSync(path, JSON.stringify(sealed, null, 2), { flag: "wx" })
      writeFileSync(checksPath, JSON.stringify(records, null, 2), { flag: "wx" })
      finalRecord.assertions.push(sealed)
      finalRecord.checks.push(records)
      finalRecord.files.push(path, checksPath)
    }
  } catch (error) {
    fail(error)
  } finally {
    try {
      await recordArtifact(context.task, {
        type: "terminfo:erase",
        attachments: finalRecord.files.map((path) => ({ path, contentType: "application/json" })),
      })
    } catch (error) {
      fail(error)
    } finally {
      context.task.meta.terminfoErase = finalRecord
    }
  }
  if (failed) throw failure
  return finalRecord
}
