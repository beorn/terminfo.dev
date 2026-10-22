import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type { DarwinMuxAttachmentProof } from "@terminfo/probe-defs"
import { PLACEHOLDER } from "../../run-parser/src/app-launch.ts"
import type { ProcessMarker } from "../../terminfo.dev/src/owned-process.ts"

/**
 * The Darwin owner launch record (#30518 D4.6), as @cto revised it: the existing cli-process launch
 * record kind — the owner binary, the run-scoped marker and the identity file — serialised once as
 * strict JSON and retained as the `collector.outerLaunch` reply. Its exact source text is what the
 * mux attachment proof cites as `receiptSha256`, so a proof cannot be replayed across runs: the
 * record names this run's marker, owner pid, birth second and run-scoped bytes (D4.3, D3).
 *
 * Nothing here measures. It parses retained bytes and compares them; an absent or unreadable input
 * is a named rejection, never a pass.
 */
export interface OuterLaunchRecord {
  launchRunId: string
  executablePath: string
  marker: ProcessMarker
  identityFile: { path: string; sha256: string }
  outerTerminal: { pid: number; startedAtEpochSeconds: number }
  bootId: string
  runFileSha256: string
  autoUpdate: {
    key: "SUEnableAutomaticChecks"
    value: "0" | "1" | "absent"
    plistPath: string
    plistSha256: string | null
  }
}

const DIGEST = /^[0-9a-f]{64}$/
const RUN_ID = /^[0-9a-z-]{1,64}$/ // createProbeRun's ids are lowercase hex; the harness may prefix
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

function fail(detail: string): never {
  throw new Error(`Outer launch record: ${detail}`)
}

function exact(value: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${where} is not an object`)
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    fail(`${where} must have exactly ${keys.join(", ")}`)
  }
  return record
}

function text(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key]
  if (typeof value !== "string" || value.length === 0) fail(`${where} ${key} must be a non-empty string`)
  return value
}

function digest(source: Record<string, unknown>, key: string, where: string): string {
  const value = text(source, key, where)
  if (!DIGEST.test(value)) fail(`${where} ${key} must be a sha256 digest`)
  if (PLACEHOLDER.test(value)) {
    fail(`${where} ${key} is a placeholder: one repeated character, so no bytes were measured`)
  }
  return value
}

function integer(source: Record<string, unknown>, key: string, minimum: number, where: string): number {
  const value = source[key]
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    fail(`${where} ${key} must be a whole number >= ${minimum}`)
  }
  return value
}

/** Parse the retained record's exact source text. Strict JSON, exact keys, digests and ids checked. */
export function parseOuterLaunchRecord(source: string): OuterLaunchRecord {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (cause) {
    fail(`not JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  const where = "record"
  const record = exact(
    value,
    [
      "launchRunId",
      "executablePath",
      "marker",
      "identityFile",
      "outerTerminal",
      "bootId",
      "runFileSha256",
      "autoUpdate",
    ],
    where,
  )
  const launchRunId = text(record, "launchRunId", where)
  if (!RUN_ID.test(launchRunId)) fail("record launchRunId is not a run id")
  const executablePath = text(record, "executablePath", where)
  if (!executablePath.startsWith("/")) fail("record executablePath must be an absolute path")
  const marker = exact(record.marker, ["flag", "value"], "record marker")
  const markerValue = text(marker, "value", "record marker")
  if (!markerValue.includes(launchRunId)) fail("record marker does not carry the run id, so it binds no run")
  const identityFile = exact(record.identityFile, ["path", "sha256"], "record identityFile")
  const identityPath = text(identityFile, "path", "record identityFile")
  if (!identityPath.startsWith("/")) fail("record identityFile path must be absolute")
  const outerTerminal = exact(record.outerTerminal, ["pid", "startedAtEpochSeconds"], "record outerTerminal")
  const autoUpdate = exact(record.autoUpdate, ["key", "value", "plistPath", "plistSha256"], "record autoUpdate")
  if (autoUpdate.key !== "SUEnableAutomaticChecks") fail("record autoUpdate key must be SUEnableAutomaticChecks")
  if (autoUpdate.value !== "0" && autoUpdate.value !== "1" && autoUpdate.value !== "absent") {
    fail('record autoUpdate value must be "0", "1" or "absent"')
  }
  const plistPath = text(autoUpdate, "plistPath", "record autoUpdate")
  const plistSha256 = autoUpdate.plistSha256
  if (plistSha256 !== null && (typeof plistSha256 !== "string" || !DIGEST.test(plistSha256))) {
    fail("record autoUpdate plistSha256 must be a sha256 digest or null")
  }
  const bootId = text(record, "bootId", where)
  if (!UUID.test(bootId)) fail("record bootId is not a UUID")
  return {
    launchRunId,
    executablePath,
    marker: { flag: text(marker, "flag", "record marker"), value: markerValue },
    identityFile: { path: identityPath, sha256: digest(identityFile, "sha256", "record identityFile") },
    outerTerminal: {
      pid: integer(outerTerminal, "pid", 2, "record outerTerminal"),
      startedAtEpochSeconds: integer(outerTerminal, "startedAtEpochSeconds", 1, "record outerTerminal"),
    },
    bootId,
    runFileSha256: digest(record, "runFileSha256", where),
    autoUpdate: {
      key: "SUEnableAutomaticChecks",
      value: autoUpdate.value,
      plistPath,
      plistSha256: plistSha256 as string | null,
    },
  }
}

/**
 * The admission join, mirroring Linux's `muxFixtureMatches`: re-hash the retained text and require the
 * proof's citation to equal it, then compare every identity the record names against the proof. It
 * reads no file: `runApp`'s success path removes the probe run's directory, so the record's own shas
 * are the retained bytes this join can honestly compare (@cto 72e4b60b). A mismatch returns its named
 * cause; nothing falls back to a pass.
 */
export function outerLaunchMismatch(
  source: string,
  proof: DarwinMuxAttachmentProof,
  ownerExecutablePath: string,
): string | null {
  let record: OuterLaunchRecord
  try {
    record = parseOuterLaunchRecord(source)
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
  const cited = createHash("sha256").update(source, "utf8").digest("hex")
  if (cited !== proof.receiptSha256) return "the proof cites another receipt than the retained record"
  if (record.launchRunId !== proof.launchRunId) return "the receipt names another run"
  if (!isDeepStrictEqual(record.outerTerminal, proof.outerTerminal)) {
    return "the receipt's outer terminal differs from the proof"
  }
  if (record.bootId !== proof.bootId) return "the receipt's boot id differs from the proof"
  if (record.executablePath !== ownerExecutablePath) {
    return "the receipt's owner executable differs from the measured outer app"
  }
  return null
}

/**
 * The producer's one write path: serialise the record, then read it back through the same strict
 * parser before anything retains it. A record that would not parse can never be written.
 */
export function serializeOuterLaunchRecord(record: OuterLaunchRecord): string {
  const source = JSON.stringify(record)
  parseOuterLaunchRecord(source)
  return source
}
