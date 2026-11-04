/** Runner-owned immutable capture, offline assertion, native metadata and artifact lifecycle. */
import { recordArtifact, type TestArtifactBase, type TestContext } from "vitest"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { platform, release } from "node:os"
import {
  ALL_PROBES,
  initializeRunDraft,
  recordExecutedProbe,
  finalizeSgrResult,
  type CapturedRunDraft,
  type ObservationFrame,
  type ProbeResult,
  type TermProbeSource,
} from "@terminfo/probe-defs"
import { parseJsonStrict } from "@terminfo/run-parser"
import { readCallLog, withCallLog, IncompleteReplay } from "viprobe"
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
import { readEraseCapture, readProbeCapture } from "./erase-capture.ts"
import { ERASE_REPLAY_ROOT } from "./erase-store.ts"

type EraseRecords = ReturnType<typeof replayEraseCalls>
export interface EraseRunRecord {
  captureRunId?: string
  assertions: CapturedRunDraft[]
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
  interface TestArtifactRegistry {
    [eraseArtifactKey]: EraseArtifact
  }
}

export async function runEraseReplay(
  context: TestContext,
  retained?: {
    directory: string
    source: Parameters<typeof readProbeCapture>[1]
    expected: Parameters<typeof readProbeCapture>[2]
    featureId: string
  },
): Promise<EraseRunRecord> {
  const startedAt = new Date().toISOString()
  const finalRecord: EraseRunRecord = { assertions: [], checks: [], files: [] }
  let failure: unknown
  let failed = false
  const fail = (error: unknown) => {
    failed = true
    failure = error
    const message = error instanceof Error ? error.message : String(error)
    finalRecord.error = message
    finalRecord.failureResults = (retained ? [{ id: retained.featureId }] : eraseProbes).map(({ id }) =>
      recordExecutedProbe({
        featureId: id,
        attempt: { scope: "collection", startedAt },
        assertions: [],
        diagnostic: { kind: "collector-error", name: error instanceof Error ? error.name : "Error", message },
      }),
    )
  }
  try {
    if (!retained) mkdirSync(ERASE_REPLAY_ROOT, { recursive: true })
    const directory = retained?.directory ?? mkdtempSync(join(ERASE_REPLAY_ROOT, "erase-"))
    const snapshot = probeSuiteSnapshot()
    const dirt = uncommittedCollectorDirt(undefined, snapshot)
    if (dirt) throw new Error("Erase capture requires committed source inputs:\n" + dirt)
    const manifest = derivedSuiteManifest(snapshot)
    const sourceRevision = sourceSuiteEnvironment().TERMINFO_SOURCE_REVISION
    let capture: Pick<
      CapturedRunDraft,
      | "runId"
      | "suiteId"
      | "subject"
      | "runtimeIdentity"
      | "identity"
      | "measuredAt"
      | "origin"
      | "provenance"
      | "outerApp"
    >
    let source: Parameters<typeof readProbeCapture>[1]
    let replay: () => EraseRecords | Promise<EraseRecords>
    let replayFrames: ObservationFrame[] = []
    if (retained) {
      const definition = ALL_PROBES.find(({ id }) => id === retained.featureId && id.startsWith("sgr."))
      if (!definition?.term) throw new IncompleteReplay("Missing selected SGR term callback: " + retained.featureId)
      const bound = readProbeCapture(directory, retained.source, retained.expected)
      capture = bound.capture
      source = retained.source
      const callback = definition.term
      replay = async () => {
        const { capture: validated } = readProbeCapture(directory, retained.source, retained.expected)
        const geometryRaw = validated.rawReplies["collector.geometry"]
        if (typeof geometryRaw === "string") {
          const geometry = parseJsonStrict("SGR replay geometry", geometryRaw) as {
            checks?: Array<{
              featureId: string
              pre?: { status: string; rows?: number; cols?: number }
              post?: { status: string; rows?: number; cols?: number }
            }>
          }
          const measured = geometry.checks?.find(({ featureId }) => featureId === definition.id)
          if (
            measured?.pre?.status === "measured" &&
            (measured.post?.status !== "measured" ||
              measured.pre.rows !== measured.post.rows ||
              measured.pre.cols !== measured.post.cols)
          ) {
            throw new IncompleteReplay("SGR replay geometry changed or became unavailable: " + definition.id)
          }
        }
        const raw = validated.rawReplies[definition.id + ".callLog"]
        if (typeof raw !== "string") throw new IncompleteReplay("Missing full-source call log: " + definition.id)
        replayFrames = []
        const log = readCallLog(parseJsonStrict(definition.id + " call log", raw), {
          onOperation(operation) {
            if (operation.path === "context.capture" && "value" in operation.outcome) {
              replayFrames.push(operation.outcome.value as ObservationFrame)
            }
          },
        })
        const session = withCallLog<TermProbeSource>(null, { mode: "replay", log })
        const startedAt = new Date().toISOString()
        if (session.context.kind !== validated.source.kind) {
          throw new IncompleteReplay("SGR source shape does not match its live capture")
        }
        const result = await callback(session.context)
        session.finish()
        return [{ featureId: definition.id, startedAt, result, checks: [] }]
      }
      finalRecord.files.push(...bound.files)
    } else {
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
      const liveCapture: CapturedRunDraft = {
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
      const recorded = captureEraseCalls(context, runtimeIdentity)
      liveCapture.rawReplies["collector.callLog"] = JSON.stringify(recorded.log)
      liveCapture.rawReplies["collector.captureChecks"] = JSON.stringify(recorded.results)
      liveCapture.rawReplies["collector.traceManifest"] = JSON.stringify({
        captureKind: "buffer_state",
        geometry: HEADLESS_TERMINAL,
        blobs: [],
      })
      const capturePath = saveDaemonProbeRun(liveCapture, directory)
      capture = liveCapture
      finalRecord.files.push(capturePath)
      source = {
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
      replay = () => replayEraseCalls(readEraseCapture(directory, source, expected).log, context)
    }
    finalRecord.captureRunId = capture.runId
    const { subject, runtimeIdentity, measuredAt } = capture
    for (let attempt = 0; attempt < 2; attempt++) {
      const assertion: CapturedRunDraft = {
        ...initializeRunDraft({ runId: randomUUID(), manifest, sourceRevision, source, intendedSubject: subject }),
        subject: { ...subject },
        runtimeIdentity,
        identity: capture.identity,
        measuredAt,
        origin: { ...capture.origin },
        ...(capture.provenance && { provenance: capture.provenance }),
        ...(capture.outerApp && { outerApp: capture.outerApp }),
      }
      const records = await replay()
      for (const { featureId, startedAt, result, checks } of records) {
        if (!ALL_PROBES.some(({ id }) => id === featureId)) {
          throw new Error("Erase result outside catalogue: " + featureId)
        }
        if (result.response !== undefined) assertion.rawReplies[featureId] = result.response
        for (const item of result.assertions ?? []) {
          assertion.assertions.push({ ...item, featureId, rawReplyRef: featureId })
        }
        const precondition = checks.find((check) => check.kind === "precondition" && !check.ok)
        const domain = recordExecutedProbe({
          featureId,
          attempt: { scope: "probe", startedAt },
          assertions: assertion.assertions,
          tests: result.tests,
          criterionBranch: result.criterionBranch,
          observation: result.observation && { ...result.observation, featureId, rawReplyRef: featureId },
          coverage: result.notTested && { ...result.notTested, featureId, rawReplyRef: featureId },
          diagnostic:
            precondition && !result.tests?.some((test) => test.id === "criterion" && test.status === "test-failure")
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
        assertion.results[index] = retained ? finalizeSgrResult(domain, capture.subject, replayFrames) : domain
      }
      const path = join(directory, assertion.runId + ".assertion.draft.json")
      const checksPath = join(directory, assertion.runId + ".checks.json")
      writeFileSync(path, JSON.stringify(assertion, null, 2), { flag: "wx" })
      writeFileSync(checksPath, JSON.stringify(records, null, 2), { flag: "wx" })
      finalRecord.assertions.push(assertion)
      finalRecord.checks.push(records)
      finalRecord.files.push(path, checksPath)
    }
  } catch (error) {
    if (retained && error instanceof Error) error.message = "SGR replay: " + error.message
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
