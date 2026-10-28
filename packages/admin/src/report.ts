/** Report command — render the canonical selected observations and separate history. */

import { dirname, join } from "node:path"
import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { loadFeatures } from "@terminfo/catalog"
import { parseJsonStrict, parseRun } from "@terminfo/run-parser"
import { loadCurrentResults } from "../../../docs/data/current-results.ts"
import { fullContextCensus } from "../../../docs/data/full-census.ts"
import { readExplicitSuiteTarget } from "../suite-manifest.ts"
import { renderReport } from "../report.tsx"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

function revision(ref: string, optional = false): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: ROOT, encoding: "utf8" })
  if (optional && result.status === 1) return undefined
  if (result.error || result.status !== 0 || !/^[a-f0-9]{40}\s*$/.test(result.stdout)) {
    throw new Error(`Cannot read ${ref} in ${ROOT}: ${result.error?.message ?? result.stderr}`)
  }
  return result.stdout.trim()
}

/** Raw inputs are evidence, not pass declarations or publication receipts. */
function rawScoreboard(paths: readonly string[], contentDir: string): string {
  const census = fullContextCensus(contentDir)
  const catalogIds = Object.keys(loadFeatures(contentDir))
  let observedAt = ""
  const rows = new Map<
    string,
    Array<{ runId: string; suite: string; source: string; sha256: string; detail: string; counts: string }>
  >()
  for (const path of paths) {
    const bytes = readFileSync(path, "utf8")
    const header: unknown = parseJsonStrict(path, bytes)
    if (
      !record(header) ||
      typeof header.runId !== "string" ||
      typeof header.probeHash !== "string" ||
      typeof header.sourceRevision !== "string"
    ) {
      throw new Error(`${path}: a raw capture requires runId, probeHash and sourceRevision`)
    }
    const subject = header.subject ?? header.target
    if (!record(subject) || typeof subject.id !== "string" || typeof subject.os !== "string") {
      throw new Error(`${path}: raw capture has no recorded subject identity`)
    }
    const kind = subject.kind === "headless" ? "lib" : subject.kind === "app" ? "term" : subject.kind
    if (typeof header.measuredAt === "string" && header.measuredAt > observedAt) observedAt = header.measuredAt
    const context = census.contexts.find(
      (row) => row.kind === kind && row.terminalId === subject.id && (kind === "lib" || row.os === subject.os),
    )
    if (!context) {
      throw new Error(`${path}: ${String(subject.kind)}:${subject.id}/${subject.os} is outside the canonical census`)
    }
    let detail = "baseline/unreviewed"
    let counts = "not validated"
    try {
      const { manifest } = readExplicitSuiteTarget(ROOT, header.probeHash)
      if (header.suiteId !== manifest.probeHash) {
        throw new Error(`${path}: suiteId disagrees with manifest ${manifest.probeHash}`)
      }
      const run = parseRun(path, bytes, catalogIds, new Map([[manifest.probeHash, manifest]]), { mode: "capture" })
      if (!run.results) throw new Error(`${path}: raw capture has no recorded results`)
      const totals: Record<string, number> = {}
      for (const result of run.results) totals[result.status] = (totals[result.status] ?? 0) + 1
      counts = ["supported", "unsupported", "test-failure", "test-todo"]
        .map((status) => `${status}=${totals[status] ?? 0}`)
        .join(" ")
    } catch (error) {
      // Retain the named evidence row when its declaration is absent or invalid; it proves no verdict.
      detail += `; ${error instanceof Error ? error.message : String(error)}`
    }
    const sources = rows.get(context.context) ?? []
    sources.push({
      runId: header.runId,
      suite: `${header.probeHash}@${header.sourceRevision}`,
      source: path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      detail,
      counts,
    })
    rows.set(context.context, sources)
  }
  const head = revision("HEAD")
  const live = revision("refs/remotes/origin/live", true)
  const escape = (value: string) => value.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ")
  const lines = [
    "Not a pass, not an admission",
    `Content revision ${head}; origin/live ${live ?? "absent"}; provenLive=${head === live}`,
    "Raw observations remain baseline/unreviewed; no admission or publication is inferred.",
    `Observation: ${observedAt || "no capture timestamp recorded"}; owner @dev/10. Explicit inputs: ${paths.map(escape).join(", ")}`,
    "| Context | State | Pass | Run / suite | Counts / evidence |",
    "| --- | --- | --- | --- | --- |",
  ]
  for (const context of census.contexts) {
    const sources = rows.get(context.context)
    if (!sources) {
      lines.push(
        `| ${context.context} | to-measure | no pass | no captured run supplied | not recorded; resolving query: explicit inputs above |`,
      )
      continue
    }
    lines.push(
      `| ${context.context} | measured-unpublished | no pass | ${sources.map((row) => escape(`${row.runId} ${row.suite}`)).join("; ")} | ${sources.map((row) => escape(`${row.counts}; ${row.detail}; ${row.source}; sha256=${row.sha256}`)).join("; ")} |`,
    )
  }
  return lines.join("\n")
}

export async function handleReport(options: { scoreboard?: string[] } = {}): Promise<void> {
  const contentDir = join(ROOT, "content")
  if (options.scoreboard) {
    console.log(rawScoreboard(options.scoreboard, contentDir))
    return
  }
  const { projection } = loadCurrentResults(contentDir)
  // The selector has already validated this required catalog; its IDs supply the report's absent rows.
  const featureIds = Object.keys(loadFeatures(contentDir))
  console.log(await renderReport(projection, featureIds))
}
