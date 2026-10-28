/** Report command — render the canonical selected observations and separate history. */

import { basename, dirname, join } from "node:path"
import { readFileSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { loadFeatures } from "@terminfo/catalog"
import { parseJsonStrict, parseRun } from "@terminfo/run-parser"
import { PROBE_STATUSES } from "@terminfo/probe-defs"
import { loadCurrentResults } from "../../../docs/data/current-results.ts"
import { fullContextCensus } from "../../../docs/data/full-census.ts"
import { isStaleRelation } from "../../../docs/data/release-scope.ts"
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

/** Explicit inputs are evidence, not publication receipts. No pass is synthesized from raw captures. */
function rawScoreboard(paths: readonly string[], contentDir: string): string {
  const census = fullContextCensus(contentDir)
  const catalogIds = Object.keys(loadFeatures(contentDir))
  let observedAt = ""
  const rows = new Map<
    string,
    Array<{
      runId: string
      suite: string
      source: string
      sha256: string
      detail: string
      counts: string
      pass: string
      frozenAt: string
      state: string
      selected: boolean
      admitted: boolean
    }>
  >()
  type PassContext = { pass: string; frozenAt: string; suite: string; sourceRevision: string; context?: string }
  type EvidenceRow = NonNullable<ReturnType<typeof rows.get>>[number]
  const append = (context: string, row: EvidenceRow): EvidenceRow => {
    rows.set(context, [...(rows.get(context) ?? []), row])
    return row
  }
  function read(input: string, pass?: PassContext): EvidenceRow | undefined {
    const path = statSync(input).isDirectory() ? join(input, "pass.json") : input
    const bytes = readFileSync(path, "utf8")
    const header: unknown = parseJsonStrict(path, bytes)
    if (record(header) && Array.isArray(header.contexts)) {
      if (pass) throw new Error(`${path}: a pass context must cite a raw run, not another pass`)
      if (typeof header.probeHash !== "string" || typeof header.sourceRevision !== "string") {
        throw new Error(`${path}: pass requires probeHash and sourceRevision`)
      }
      const freeze = header.freeze
      const declaration = readExplicitSuiteTarget(ROOT, header.probeHash).manifest
      if (
        freeze !== undefined &&
        (!record(freeze) || freeze.id !== header.probeHash || freeze.release !== declaration.freeze?.release)
      ) {
        throw new Error(`${path}: freeze disagrees with suite ${header.probeHash}`)
      }
      const identity: PassContext = {
        pass: record(freeze) && typeof freeze.id === "string" ? freeze.id : basename(dirname(path)),
        frozenAt: declaration.freeze?.at ?? "",
        suite: header.probeHash,
        sourceRevision: header.sourceRevision,
      }
      const deferrals = record(freeze) ? (freeze.deferrals ?? []) : []
      if (!Array.isArray(deferrals)) throw new Error(`${path}: freeze.deferrals must be an array`)
      const deferred = new Map<string, string>()
      for (const value of deferrals) {
        if (
          !record(value) ||
          typeof value.context !== "string" ||
          typeof value.routeIssue !== "string" ||
          !value.routeIssue ||
          typeof value.reason !== "string" ||
          !value.reason ||
          !census.contexts.some((row) => row.context === value.context)
        ) {
          throw new Error(`${path}: deferral requires a canonical context, routeIssue and reason`)
        }
        if (deferred.has(value.context)) throw new Error(`${path}: duplicate deferral ${value.context}`)
        deferred.set(value.context, `${value.reason}; route ${value.routeIssue}`)
      }
      for (const value of header.contexts) {
        if (!record(value) || !record(value.context)) throw new Error(`${path}: pass has no context identity`)
        const subject = value.context
        const context = census.contexts.find(
          (row) =>
            row.kind === subject.kind && row.terminalId === subject.id && (row.kind === "lib" || row.os === subject.os),
        )
        if (!context) throw new Error(`${path}: pass names a context outside the canonical census`)
        const reason = deferred.get(context.context)
        if (reason === undefined && typeof value.rawRun === "string") {
          const declared = { ...identity, context: context.context }
          const capture = read(value.rawRun, declared)
          if (value.status === "admitted" && typeof value.admittedPath === "string") {
            const admitted = read(value.admittedPath, declared)
            if (!capture || !admitted || capture.runId !== admitted.runId || capture.suite !== admitted.suite) {
              throw new Error(
                `${path}: admitted path ${value.admittedPath} does not identify captured run ${value.rawRun}`,
              )
            }
            admitted.admitted = true
          }
        } else {
          append(context.context, {
            selected: false,
            admitted: false,
            pass: identity.pass,
            frozenAt: identity.frozenAt,
            state: reason ? "deferred" : "to-measure",
            suite: `${header.probeHash}@${header.sourceRevision}`,
            runId: "no captured run supplied",
            source: path,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            counts: "not measured",
            detail: reason ?? String(value.error ?? value.reason ?? "not recorded"),
          })
        }
      }
      for (const context of deferred.keys()) {
        if (!rows.get(context)?.some((row) => row.source === path)) {
          throw new Error(`${path}: deferred context ${context} is absent from the pass`)
        }
      }
      return
    }
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
    if (pass && (pass.suite !== header.probeHash || pass.sourceRevision !== header.sourceRevision)) {
      throw new Error(`${path}: raw suite/source disagrees with pass ${pass.pass}`)
    }
    let detail = "baseline/unreviewed"
    let counts = "not validated"
    try {
      if (pass?.context && pass.context !== context.context) {
        throw new Error(`${path}: declared ${pass.context}; recorded ${context.context}`)
      }
      const { manifest } = readExplicitSuiteTarget(ROOT, header.probeHash)
      if (header.suiteId !== manifest.probeHash) {
        throw new Error(`${path}: suiteId disagrees with manifest ${manifest.probeHash}`)
      }
      const run = parseRun(path, bytes, catalogIds, new Map([[manifest.probeHash, manifest]]), { mode: "capture" })
      if (!run.results) throw new Error(`${path}: raw capture has no recorded results`)
      const totals: Record<string, number> = {}
      for (const result of run.results) totals[result.status] = (totals[result.status] ?? 0) + 1
      counts = PROBE_STATUSES.map((status) => `${status}=${totals[status] ?? 0}`).join(" ")
    } catch (error) {
      // Retain the named evidence row when its declaration is absent or invalid; it proves no verdict.
      detail += `; ${error instanceof Error ? error.message : String(error)}`
    }
    return append(pass?.context ?? context.context, {
      selected: false,
      admitted: false,
      pass: pass?.pass ?? "no pass",
      frozenAt: pass?.frozenAt ?? "",
      state: "measured-unpublished",
      runId: header.runId,
      suite: `${header.probeHash}@${header.sourceRevision}`,
      source: path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      detail,
      counts,
    })
  }
  for (const path of paths) read(path)
  const head = revision("HEAD")
  const live = revision("refs/remotes/origin/live", true)
  const contentStatus = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "--", "content"], {
    cwd: ROOT,
    encoding: "utf8",
  })
  if (contentStatus.error || contentStatus.status !== 0) {
    throw new Error(
      `Cannot establish content revision in ${ROOT}: ${contentStatus.error?.message ?? contentStatus.stderr}`,
    )
  }
  const dirtyContent = contentStatus.stdout.length > 0
  const provenLive = head === live && !dirtyContent
  const { projection } = loadCurrentResults(contentDir)
  for (const selected of Object.values(projection.current)) {
    if (selected.measuredAt > observedAt) observedAt = selected.measuredAt
    const context = census.contexts.find(
      (row) =>
        row.kind === selected.subject.kind &&
        row.terminalId === selected.subject.id &&
        (row.kind === "lib" || row.os === selected.subject.os),
    )
    if (!context) continue
    const publication = provenLive
      ? `selected at ${head}, live proven`
      : `selected at ${head}, live unproven (origin/live ${live ?? "absent"}${dirtyContent ? "; content differs from HEAD" : ""})`
    const detail = `${publication}; ${selected.complete ? (provenLive ? "reviewed-pass; publication proven" : "reviewed-pass-awaiting-publish") : "reviewed-fail; recorded FAIL/TODO remains"}`
    const state = isStaleRelation(selected.suiteRelation)
      ? "stale"
      : provenLive && selected.complete
        ? "published"
        : "measured-unpublished"
    const matching =
      rows.get(context.context)?.filter((row) => row.runId === selected.runId && row.sha256 === selected.sha256) ?? []
    if (matching.length > 0) {
      for (const row of matching) {
        row.state = state
        row.detail = `${detail}; ${selected.suiteFreshness}`
      }
    } else {
      append(context.context, {
        selected: true,
        admitted: false,
        pass: "no pass",
        frozenAt: "",
        state,
        runId: selected.runId,
        suite: `${selected.probeHash}@${selected.sourceRevision}`,
        source: `loadCurrentResults(${contentDir}).projection.current`,
        sha256: selected.sha256,
        detail: `${detail}; ${selected.suiteFreshness}`,
        counts: Object.entries(selected.counts)
          .map(([status, count]) => `${status}=${count}`)
          .join(" "),
      })
    }
  }
  const escape = (value: string) => value.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ")
  const lines = [
    "Terminal context scoreboard — Not a pass, not an admission",
    `Content revision ${head}; origin/live ${live ?? "absent"}; provenLive=${provenLive}${dirtyContent ? "; content differs from HEAD" : ""}`,
    "Unselected raw observations remain baseline/unreviewed; admission and publication use recorded evidence only.",
    `Observation: ${observedAt || "no capture timestamp recorded"}; owner not recorded in inputs. Explicit inputs: ${paths.map(escape).join(", ")}`,
    ...projection.exclusions.map((row) => `Excluded run ${row.runId}: ${escape(row.reason)}; ${escape(row.path)}`),
    "| Context | State | Pass | Run / suite | Counts / evidence |",
    "| --- | --- | --- | --- | --- |",
  ]
  for (const context of census.contexts) {
    const sources = rows
      .get(context.context)
      ?.sort(
        (left, right) =>
          right.frozenAt.localeCompare(left.frozenAt) ||
          Number(right.admitted) - Number(left.admitted) ||
          Number(left.selected) - Number(right.selected) ||
          left.source.localeCompare(right.source) ||
          left.runId.localeCompare(right.runId),
      )
    const latest = sources?.[0]
    if (!latest) {
      lines.push(
        `| ${context.context} | to-measure | no pass | no captured run supplied | not recorded; resolving query: explicit inputs above |`,
      )
      continue
    }
    const selectedStates = sources?.filter((row) => row.selected).map((row) => row.state) ?? []
    const state = latest.selected
      ? selectedStates.includes("stale")
        ? "stale"
        : selectedStates.every((value) => value === "published")
          ? "published"
          : "measured-unpublished"
      : latest.state
    lines.push(
      `| ${context.context} | ${state} | ${escape(latest.pass)} | ${escape(`${latest.runId} ${latest.suite}`)} | ${escape(`${latest.counts}; ${latest.detail}; ${latest.source}; sha256=${latest.sha256}`)}${sources
        ?.slice(1)
        .map((row) =>
          escape(
            `; ${row.selected ? "selected evidence" : `earlier pass ${row.pass}`}: ${row.runId} ${row.suite}; ${row.counts}; ${row.state}; ${row.detail}; ${row.source}; sha256=${row.sha256}`,
          ),
        )
        .join("")} |`,
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
