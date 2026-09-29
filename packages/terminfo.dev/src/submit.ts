/** Offline draft from one exact, unreviewed v2 collector run. */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import type { ProbeSuiteManifest } from "@terminfo/probe-defs"
import { decodeCollectorRun, decodeExactUtf8 } from "@terminfo/run-parser"

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
): { sha256: string; runId: string; suiteComplete: boolean; attachmentPath: string } {
  const rawBytes = readFileSync(rawRunPath)
  const raw = decodeExactUtf8(rawBytes, rawRunPath)
  const decoded = decodeCollectorRun(rawRunPath, raw, receipt.manifest, receipt.collectorRevision)
  const { run } = decoded
  if (run.screenshotRefs.length > 0) {
    throw new Error(`${rawRunPath}: screenshot artifact bytes are not retained with this offline draft`)
  }
  const expected = receipt.manifest.probes[run.target.kind].length
  const ungraded = Object.keys(run.ungradedDiagnostics ?? {}).length
  const missing = expected - run.observations.length - ungraded
  if (missing < 0) throw new Error(`${rawRunPath}: observation/diagnostic counts exceed trusted suite`)
  const context = {
    target: run.target.kind,
    terminal: run.target.id,
    version: run.target.version,
    os: run.target.os ?? "unknown",
    osVersion: run.target.osVersion ?? "unknown",
    outerTerminal: run.target.outerTerminal ?? "unknown",
    mux: run.target.mux ?? "unknown",
    config: run.target.config ?? "unknown",
    permissions: run.target.permissions ?? "unknown",
    measuredAt: run.measuredAt,
    cliVersion: receipt.cliVersion,
    suiteId: run.suiteId,
    probeHash: run.probeHash,
    sourceRevision: run.sourceRevision,
    identity: run.identity,
    runId: run.runId,
    runSha256: decoded.sha256,
    runByteLength: rawBytes.length,
    coverage: {
      explicit: `${run.observations.length}/${expected}`,
      ungraded,
      missing,
      suiteComplete: run.suiteComplete,
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
    ...(run.suiteComplete ? [] : ["This run is partial: history only; not current terminal support."]),
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
  return { sha256: decoded.sha256, runId: run.runId, suiteComplete: run.suiteComplete, attachmentPath }
}
