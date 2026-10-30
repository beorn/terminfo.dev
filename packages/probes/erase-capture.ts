/** Host validation of the existing immutable schema-4 capture before offline erase execution. */
import { createHash } from "node:crypto"
import { readFileSync, realpathSync } from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { RunDraft, ProbeSubject, HeadlessRuntimeIdentity, ProbeSuiteManifest } from "@terminfo/probe-defs"
import { parseRun, parseJsonStrict } from "@terminfo/run-parser"
import { readCallLog, IncompleteReplay } from "viprobe"
import { eraseProbes } from "../probe-defs/src/erase.ts"
import { HEADLESS_TERMINAL } from "./headless-terminal.ts"

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function readReference(directory: string, reference: unknown): Buffer {
  if (
    !object(reference) ||
    Object.keys(reference).sort().join(",") !== "path,sha256" ||
    typeof reference.path !== "string" ||
    !reference.path ||
    isAbsolute(reference.path) ||
    /^[a-z]:/i.test(reference.path) ||
    reference.path.includes("\\") ||
    reference.path.includes("\0") ||
    reference.path.split("/").includes("..") ||
    typeof reference.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(reference.sha256)
  ) {
    throw new IncompleteReplay("Erase artifact requires a relative path and SHA256")
  }
  const root = realpathSync(directory)
  const path = realpathSync(join(root, reference.path))
  const contained = relative(root, path)
  if (contained === ".." || contained.startsWith("../") || isAbsolute(contained)) {
    throw new IncompleteReplay("Erase artifact resolves outside its store: " + reference.path)
  }
  const bytes = readFileSync(path)
  if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256) {
    throw new IncompleteReplay("Erase artifact SHA256 differs: " + reference.path)
  }
  return bytes
}

export function readEraseCapture(
  directory: string,
  source: Extract<RunDraft["source"], { kind: "trace" }>,
  expected: {
    manifest: ProbeSuiteManifest & { schemaVersion: 4 }
    sourceRevision: string
    subject: ProbeSubject
    runtimeIdentity: HeadlessRuntimeIdentity
    geometry: typeof HEADLESS_TERMINAL
  },
) {
  const bytes = readReference(directory, source.trace).toString("utf8")
  const capture = parseRun(
    source.trace.path,
    bytes,
    expected.manifest.catalogIds ?? [],
    new Map([[expected.manifest.probeHash, expected.manifest]]),
  )
  if (
    capture.schemaVersion !== 4 ||
    capture.source?.kind !== "live" ||
    !capture.sealedAt ||
    capture.runId !== source.captureRunId ||
    capture.suiteId !== source.captureSuiteId ||
    capture.suiteId !== expected.manifest.probeHash ||
    capture.sourceRevision !== source.captureSourceRevision ||
    capture.sourceRevision !== expected.sourceRevision ||
    !isDeepStrictEqual(capture.subject, expected.subject) ||
    !isDeepStrictEqual(capture.runtimeIdentity, expected.runtimeIdentity)
  ) {
    throw new IncompleteReplay("Erase capture run, suite, source, subject or loaded runtime binding differs")
  }
  const manifestRaw = capture.rawReplies["collector.traceManifest"]
  if (typeof manifestRaw !== "string") throw new IncompleteReplay("Erase capture is missing collector.traceManifest")
  const manifest = parseJsonStrict("erase trace manifest", manifestRaw)
  if (
    !object(manifest) ||
    Object.keys(manifest).sort().join(",") !== "blobs,captureKind,geometry" ||
    manifest.captureKind !== "buffer_state" ||
    !isDeepStrictEqual(manifest.geometry, expected.geometry) ||
    !Array.isArray(manifest.blobs)
  ) {
    throw new IncompleteReplay("Erase capture kind, geometry or blob manifest differs")
  }
  const blobPaths = new Set<string>()
  for (const blob of manifest.blobs) {
    readReference(directory, blob)
    if (!object(blob) || typeof blob.path !== "string" || blobPaths.has(blob.path)) {
      throw new IncompleteReplay("Erase capture contains duplicate blob references")
    }
    blobPaths.add(blob.path)
  }
  for (const path of [...capture.screenshotRefs, ...(capture.textSnapshotRefs ?? [])]) {
    if (!blobPaths.has(path)) throw new IncompleteReplay("Erase capture has an unbound blob: " + path)
  }
  const raw = capture.rawReplies["collector.callLog"]
  if (typeof raw !== "string") throw new IncompleteReplay("Erase capture is missing collector.callLog")
  const opened: string[] = []
  const log = readCallLog(parseJsonStrict("erase capture call log", raw), {
    onOperation(operation) {
      if (operation.path !== "context.open") return
      if (
        typeof operation.args[0] !== "string" ||
        !isDeepStrictEqual(operation.args[1], expected.geometry) ||
        !("value" in operation.outcome) ||
        !object(operation.outcome.value) ||
        operation.outcome.value.cols !== expected.geometry.cols
      ) {
        throw new IncompleteReplay("Erase context geometry differs from its capture manifest")
      }
      opened.push(operation.args[0])
    },
  })
  if (
    !isDeepStrictEqual(
      opened,
      eraseProbes.map(({ id }) => id),
    )
  ) {
    throw new IncompleteReplay("Erase capture does not contain the selected eleven-probe family")
  }
  return { capture, log }
}
