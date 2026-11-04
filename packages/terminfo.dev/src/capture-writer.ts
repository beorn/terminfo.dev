/** Shared immutable capture finalization and persistence for every collector. */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  finalizeProbeResult,
  type CapturedRunDraft as CollectedProbeRun,
  type AssertionType,
  type ProbeSubject,
} from "@terminfo/probe-defs"

const DA1_QUERY = "\u001b[c"
const DA1_REPLY = /\u001b\[\?[0-9;]*c/u

function replySource(sequence: string, reply: string): "host" | "terminal" | "none" {
  const da1 = sequence !== DA1_QUERY && sequence.endsWith(DA1_QUERY) ? DA1_REPLY.exec(reply) : null
  if (da1 === null) return reply === "" ? "none" : "host"
  if (da1.index > 0) return "host"
  return da1.index + da1[0].length < reply.length ? "terminal" : "none"
}

/** The console host a reason names: a text read's recorded host, else the ownership receipt's image. */
function consoleHostBinary(run: CollectedProbeRun): string {
  const hosts = new Set(
    run.results.flatMap((cell) =>
      cell.host ? [`${cell.host.image} ${cell.host.executableSha256.slice(0, "sha256:".length + 12)}`] : [],
    ),
  )
  if (hosts.size > 1) throw new Error(`Run ${run.runId} names ${hosts.size} console hosts; one run has one`)
  const [host] = hosts
  if (host !== undefined) return host
  const receipt = run.rawReplies["collector.terminalOwnership"]
  const image =
    receipt === undefined
      ? undefined
      : (JSON.parse(receipt) as { windowsHosted?: { consoleHost?: { image?: unknown } } }).windowsHosted?.consoleHost
          ?.image
  return typeof image === "string" && image !== "" ? image : "(console host binary not recorded)"
}

function consoleHostHold(
  run: CollectedProbeRun,
  cell: { featureId: string; assertionType?: AssertionType; rawReplyRef?: string },
  verdict: string,
): string | undefined {
  if (run.subject.kind !== "term" || run.subject.os?.toLowerCase() !== "windows") return undefined
  if (verdict !== "supported" && verdict !== "unsupported") return undefined
  if (cell.assertionType !== "query_reply" || cell.rawReplyRef === undefined) {
    return undefined
  }
  const stored = run.rawReplies[cell.rawReplyRef]
  if (stored === undefined) {
    throw new Error(`Run ${run.runId}: ${cell.featureId} cites raw reply ${cell.rawReplyRef}, which the run lacks`)
  }
  const queries = stored.startsWith("{") ? (JSON.parse(stored) as { queries?: unknown }).queries : undefined
  if (stored.startsWith("{") && (!Array.isArray(queries) || queries.length === 0)) return undefined
  const sources = Array.isArray(queries)
    ? queries.map((query: unknown, index) => {
        const { sequence, raw } = (query ?? {}) as { sequence?: unknown; raw?: unknown }
        if (typeof sequence !== "string" || (raw !== undefined && typeof raw !== "string")) {
          throw new Error(`Run ${run.runId}: ${cell.featureId} query ${index} has no readable sequence and reply`)
        }
        return replySource(sequence, raw ?? "")
      })
    : [replySource("", stored)]
  if (sources.every((source) => source === "terminal")) return undefined
  return sources.includes("host")
    ? `answered by the Windows console host ${consoleHostBinary(run)}, not measured on the terminal`
    : "no reply after the console host's DA1; the host may have swallowed the query"
}

/** Finalize one measured capture with applicable source answers. */
export function finalizeCollectedDraft(
  run: CollectedProbeRun,
  intended?: { kind: ProbeSubject["kind"]; id: string; version: string },
): CollectedProbeRun {
  if (run.schemaVersion !== 4 || !Array.isArray(run.results)) {
    throw new Error("Final writer requires the current schema-4 draft; historical runs are read-only")
  }
  if (run.source?.kind !== "live") {
    throw new Error(`Probe source ${String(run.source?.kind)} has no implementation at this source`)
  }
  if (Object.keys(run.source).length !== 1) {
    throw new Error("Current run writer requires exactly { kind: live }")
  }
  if (!run.subject || !run.identity || !run.measuredAt || !run.origin) {
    throw new Error(`Run ${run.runId} has no complete measured identity`)
  }
  if (intended && run.subject.id !== intended.id && run.subject.id !== "unknown") {
    throw new Error(
      `Measured terminal ${run.subject.id} differs from intended ${intended.id}; refusing to relabel capture`,
    )
  }
  if (intended && run.subject.version !== intended.version && run.subject.version !== "unknown") {
    throw new Error(
      `Measured version ${run.subject.version} differs from intended ${intended.version}; refusing to relabel capture`,
    )
  }
  const captured = globalThis.structuredClone(run)
  if (intended) {
    captured.subject.kind = intended.kind
    captured.intendedSubject = { ...captured.intendedSubject, ...intended }
    captured.rawReplies["collector.intent"] = JSON.stringify(intended)
  }
  captured.results = captured.results.map((result) => {
    const reason = consoleHostHold(captured, result, result.status)
    if (reason === undefined) return result
    return {
      ...result,
      reason,
      tests: [
        ...result.tests.filter((test) => test.id !== "console-host"),
        { id: "console-host", status: "probe-todo" as const, attempt: { scope: "none" as const }, reason },
      ],
    }
  })
  // Grades come only from what this run observed; a stored source answer never sets one (#32246).
  captured.results = captured.results.map((result) => finalizeProbeResult(result))
  return captured
}

/** Preserve one immutable collected run under its measured identity. */
export function saveDaemonProbeRun(
  run: CollectedProbeRun,
  directory: string,
  intended?: { kind: ProbeSubject["kind"]; id: string; version: string },
): string {
  const captured = finalizeCollectedDraft(run, intended)
  for (const value of [
    captured.subject.id,
    captured.subject.version,
    captured.subject.os ?? "unknown",
    captured.runId,
  ]) {
    if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error(`Unsafe capture filename component: ${value}`)
  }
  mkdirSync(directory, { recursive: true })
  const bytes = `${JSON.stringify(captured, null, 2)}\n`
  const file = join(
    directory,
    `${captured.subject.id}-${captured.subject.version}-${captured.subject.os ?? "unknown"}-${captured.runId}.draft.json`,
  )
  writeFileSync(file, bytes, { flag: "wx", mode: 0o600 })
  return file
}
