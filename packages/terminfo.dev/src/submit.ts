/** Offline contribution from exact current capture/final bytes, or explicitly historical v2 bytes. */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import type { ProbeSuiteManifest } from "@terminfo/probe-defs"
import {
  decodeCollectorRun,
  decodeCollectorDraft,
  decodeHistoricalCollectorRun,
  decodeExactUtf8,
  parseJsonStrict,
} from "@terminfo/run-parser"

import { aggregateCurrentResults } from "../../../docs/data/release-scope.ts"

export interface DraftReceipt {
  manifest: ProbeSuiteManifest
  collectorRevision: string
  cliVersion: string
}

function fenceFor(source: string): string {
  const longest = Math.max(3, ...Array.from(source.matchAll(/~+/g), ([run]) => run.length))
  return "~".repeat(longest + 1)
}

export function createDraft(
  rawRunPath: string,
  draftPath: string,
  receipt: DraftReceipt,
): {
  sha256: string
  runId: string
  schemaVersion: 2 | 4
  complete: boolean
  historical: boolean
  suiteComplete?: boolean
  attachmentPath: string
} {
  const rawBytes = readFileSync(rawRunPath)
  const raw = decodeExactUtf8(rawBytes, rawRunPath)
  const value = parseJsonStrict(rawRunPath, raw)
  const version =
    typeof value === "object" && value !== null && "schemaVersion" in value ? value.schemaVersion : undefined
  const decoder =
    version === 2
      ? decodeHistoricalCollectorRun
      : typeof value === "object" && value !== null && "sealedAt" in value
        ? decodeCollectorRun
        : decodeCollectorDraft
  const decoded = decoder(rawRunPath, raw, receipt.manifest, receipt.collectorRevision)
  const { run } = decoded
  if (run.screenshotRefs.length > 0 || (run.textSnapshotRefs?.length ?? 0) > 0) {
    throw new Error(
      `${rawRunPath}: screenshot or text-snapshot artifact bytes are not retained with this offline draft`,
    )
  }
  const current =
    run.schemaVersion === 4 ? aggregateCurrentResults(run.results, receipt.manifest.catalogIds ?? []) : undefined
  const expected = receipt.manifest.probes[run.subject.kind].length
  const historicalCoverage =
    run.schemaVersion === 2
      ? {
          historical: true,
          current: false,
          explicit: `${run.observations.length}/${expected}`,
          ungraded: Object.keys(run.ungradedDiagnostics ?? {}).length,
          missing: expected - run.observations.length - Object.keys(run.ungradedDiagnostics ?? {}).length,
          suiteComplete: run.suiteComplete,
        }
      : undefined
  if (historicalCoverage && historicalCoverage.missing < 0) {
    throw new Error(`${rawRunPath}: observation/diagnostic counts exceed trusted suite`)
  }
  const complete = current?.complete ?? false
  const context = {
    subject: run.subject.kind,
    terminal: run.subject.id,
    version: run.subject.version,
    os: run.subject.os ?? "unknown",
    osVersion: run.subject.osVersion ?? "unknown",
    outerTerminal: run.subject.outerTerminal ?? "unknown",
    mux: run.subject.mux ?? "unknown",
    config: run.subject.config ?? "unknown",
    permissions: run.subject.permissions ?? "unknown",
    measuredAt: run.measuredAt,
    cliVersion: receipt.cliVersion,
    suiteId: run.suiteId,
    probeHash: run.probeHash,
    sourceRevision: run.sourceRevision,
    identity: run.identity,
    runId: run.runId,
    runSha256: decoded.sha256,
    runByteLength: rawBytes.length,
    schemaVersion: run.schemaVersion,
    historical: run.schemaVersion === 2,
    coverage: current
      ? {
          counts: current.counts,
          score: { supported: current.supported, all: current.denominator },
          complete,
          sealed: "sealedAt" in run,
          explicit: `${current.denominator}/${current.denominator}`,
        }
      : historicalCoverage,
  }
  const contextJson = JSON.stringify(context, null, 2)
  const fence = fenceFor(contextJson)
  const attachmentPath = join(dirname(draftPath), `${decoded.sha256}.json`)
  if (attachmentPath === draftPath) throw new Error("Draft path cannot be the raw attachment path")
  const draft = [
    "# Terminal observation draft",
    "",
    "This command creates files offline and does not send them. Review this draft before posting it as a GitHub issue.",
    "If you choose to contribute, include this consent statement:",
    "I dedicate these results to the public domain (CC0 1.0) so terminfo.dev can publish them under any license.",
    ...(run.schemaVersion === 2 ? ["Historical schema-2 evidence: history only; not current terminal support."] : []),
    ...(run.schemaVersion === 4 && !complete
      ? ["Current execution is incomplete: TEST TODO or TEST FAILURE remains."]
      : []),
    ...(run.schemaVersion === 4 && !("sealedAt" in run)
      ? ["Required review pending: this capture remains an unsealed draft."]
      : []),
    "",
    "## Measured context and coverage",
    "",
    `${fence}json`,
    contextJson,
    fence,
    "",
    "## Exact original run bytes",
    "",
    `[Attach the original JSON file](${basename(attachmentPath)}) (SHA256 ${decoded.sha256}; ${rawBytes.length} bytes).`,
    "",
  ].join("\n")
  if (existsSync(attachmentPath)) {
    if (!readFileSync(attachmentPath).equals(rawBytes)) {
      throw new Error(`${attachmentPath}: existing content-addressed attachment differs from raw run bytes`)
    }
  } else {
    writeFileSync(attachmentPath, rawBytes, { flag: "wx", mode: 0o600 })
  }
  writeFileSync(draftPath, draft, { flag: "wx", mode: 0o600 })
  return {
    sha256: decoded.sha256,
    runId: run.runId,
    schemaVersion: run.schemaVersion,
    complete,
    historical: run.schemaVersion === 2,
    ...(run.schemaVersion === 2 && { suiteComplete: run.suiteComplete }),
    attachmentPath,
  }
}
