/**
 * Write the current selection to a caller-given path. The file is never committed and is not under content/.
 * Placed runs come from content/. Each --working-run is passed through the existing workingRuns input.
 */
import { writeFileSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { loadFeatures } from "@terminfo/catalog"
import { probeHash } from "../../packages/admin/versions.ts"
import { CONTENT_DIR } from "../../packages/admin/corpus-placement.ts"
import { loadRawCapture } from "../../packages/admin/raw-capture.ts"
import { loadSelectedResults, type SelectedProjection } from "./selected-results.ts"

export interface SelectionFileCell {
  featureId: string
  status: string
  terminalId: string
  version: string
  os: string | null
  /** The projection's context key, the same key the site's selection uses. */
  context: string
  measuredAt: string
  suiteId: string
  runId: string
  source: "placed" | "working"
  /** Repository-relative run file for a placed row (`content/...`); null for a working run, which is not placed. */
  contentPath: string | null
}

function isUnder(path: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(path))
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
}

export function selectionFile(
  projection: SelectedProjection,
  workingRunIds: ReadonlySet<string>,
  contentDir: string,
): { cells: SelectionFileCell[] } {
  const root = resolve(contentDir, "..")
  const cells: SelectionFileCell[] = []
  for (const [context, summary] of Object.entries(projection.contexts)) {
    for (const [featureId, cell] of Object.entries(summary.cells)) {
      const runId = cell.origin.runId
      const version = cell.run.subject.version
      if (!version) throw new Error(`${runId} ${featureId}: selected cell has no subject version`)
      const working = workingRunIds.has(runId)
      if (!working && !isUnder(cell.run.path, contentDir)) {
        throw new Error(`${runId} ${featureId}: placed run file ${cell.run.path} is not under ${contentDir}`)
      }
      cells.push({
        featureId,
        status: cell.featureResult?.status ?? cell.result.status,
        terminalId: cell.run.subject.id,
        version,
        os: cell.run.subject.os,
        context,
        measuredAt: cell.run.measuredAt,
        suiteId: cell.run.suiteId,
        runId,
        source: working ? "working" : "placed",
        contentPath: working ? null : relative(root, resolve(cell.run.path)).split(sep).join("/"),
      })
    }
  }
  cells.sort((a, b) => a.terminalId.localeCompare(b.terminalId) || a.featureId.localeCompare(b.featureId))
  return { cells }
}

/** Refuse a path that is the content directory or inside it. */
export function refuseOutputUnderContent(outPath: string, contentDir: string): void {
  if (isUnder(outPath, contentDir)) {
    throw new Error(`${outPath}: --out must not be under content/`)
  }
}

export function parseSelectionArgs(argv: readonly string[]): {
  out: string
  content: string
  workingRuns: string[]
} {
  let out: string | undefined
  let content = CONTENT_DIR
  const workingRuns: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === "--out" && next) {
      out = next
      i++
    } else if (arg === "--content" && next) {
      content = next
      i++
    } else if (arg === "--working-run" && next) {
      workingRuns.push(next)
      i++
    } else {
      throw new Error(`unknown argument ${arg ?? ""}`)
    }
  }
  if (!out) throw new Error("--out is required")
  return { out, content, workingRuns }
}

export function writeSelection(options: { out: string; content: string; workingRuns: readonly string[] }): number {
  refuseOutputUnderContent(options.out, options.content)
  const catalog = Object.keys(loadFeatures(options.content))
  const root = resolve(options.content, "..")
  const loaded = options.workingRuns.map((path) => loadRawCapture(path, { root, catalogIds: catalog }))
  const projection = loadSelectedResults(options.content, probeHash(), { workingRuns: loaded })
  const document = selectionFile(projection, new Set(loaded.map((run) => run.runId)), options.content)
  writeFileSync(options.out, `${JSON.stringify(document, null, 2)}\n`)
  console.log(`wrote ${document.cells.length} cells`)
  return document.cells.length
}

if (import.meta.main) {
  const args = parseSelectionArgs(process.argv.slice(2))
  writeSelection(args)
}
