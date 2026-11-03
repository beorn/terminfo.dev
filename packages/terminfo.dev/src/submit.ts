/** Offline contribution from exact current capture/final bytes. */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import type { ProbeSuiteManifest } from "@terminfo/probe-defs"
import { decodeCollectorRun, decodeCollectorDraft, decodeExactUtf8, parseJsonStrict } from "@terminfo/run-parser"

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
  schemaVersion: 4
  complete: boolean
  attachmentPath: string
} {
  const rawBytes = readFileSync(rawRunPath)
  const raw = decodeExactUtf8(rawBytes, rawRunPath)
  const value = parseJsonStrict(rawRunPath, raw)
  const decoder =
    typeof value === "object" && value !== null && "sealedAt" in value ? decodeCollectorRun : decodeCollectorDraft
  const decoded = decoder(rawRunPath, raw, receipt.manifest, receipt.collectorRevision)
  if ("kind" in decoded && decoded.kind === "empty-selection") {
    throw new Error(`${rawRunPath}: empty selection where a capture was required`)
  }
  const { run } = decoded
  if (run.screenshotRefs.length > 0 || (run.textSnapshotRefs?.length ?? 0) > 0) {
    throw new Error(
      `${rawRunPath}: screenshot or text-snapshot artifact bytes are not retained with this offline draft`,
    )
  }
  const current = aggregateCurrentResults(run.results, receipt.manifest.catalogIds ?? [])
  const complete = current.complete
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
    coverage: {
      counts: current.counts,
      score: { supported: current.supported, all: current.denominator },
      complete,
      sealed: "sealedAt" in run,
      explicit: `${current.denominator}/${current.denominator}`,
    },
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
    ...(!complete ? ["Current execution is incomplete: TEST TODO or TEST FAILURE remains."] : []),
    ...(!("sealedAt" in run) ? ["Unsealed draft: not sealed or admitted."] : []),
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
    attachmentPath,
  }
}
