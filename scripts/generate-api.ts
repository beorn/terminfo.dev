/**
 * Generate the terminfo.dev v3 JSON API.
 *
 * Outputs:
 *   api/v3/data.json              — sealed schema-3 results
 *   api/v3/evidence|runs|traces/  — exact-run documents and their artifacts
 *
 * `/api/v1` is frozen: its committed bytes under docs/public/api/v1/ are no
 * longer generated. `/api/v2` was never public and has no generator.
 *
 * Standalone `bun scripts/generate-api.ts` writes a v3 API into the
 * source-public tree for local inspection. VitePress buildEnd passes the
 * ignored build outDir so `bun run build` emits fresh deploy artifacts
 * without dirtying the source tree.
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
  rmdirSync,
  lstatSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { compatibilityTargets, loadCurrentResults } from "../docs/data/current-results.ts"
import { CAPABILITY_STATUSES } from "@terminfo/probe-defs"
import { parseJsonStrict } from "@terminfo/run-parser"
import { loadFeatures } from "@terminfo/catalog"
import { readVerifiedArtifact } from "../docs/data/selected-results.ts"
import { publicResults, type CellEvidence, type HistoricalCellEvidence } from "../docs/data/public-results.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")
const docsDir = join(root, "docs")
const publicDir = join(docsDir, "public")
const contentDir = join(root, "content")
// Cloudflare Pages Free-plan limits (25 MiB per asset, 20,000 files per deployment).
const maxAssetBytes = 25 * 1024 * 1024
const maxOutputFiles = 20_000

function writeAsset(path: string, data: string | Buffer): void {
  const bytes = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength
  if (bytes > maxAssetBytes) {
    throw new Error(`${path}: ${bytes} bytes exceeds the ${maxAssetBytes}-byte Cloudflare Pages asset limit`)
  }
  writeFileSync(path, data)
}

/**
 * Check the complete deployment tree, including files written by VitePress after API generation. It also
 * reports the run trace documents, which stay out of data.json, and each data.json's size.
 */
export function assertDeploymentLimits(dir: string): {
  fileCount: number
  fileLimit: number
  fileHeadroom: number
  traceFiles: number
  traceBytes: number
  dataJsonBytes: Record<string, number>
} {
  let fileCount = 0
  let traceFiles = 0
  let traceBytes = 0
  const dataJsonBytes: Record<string, number> = {}
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`${path}: symlink in deployment output`)
      if (entry.isDirectory()) {
        visit(path)
      } else if (entry.isFile()) {
        const bytes = lstatSync(path).size
        if (bytes > maxAssetBytes) {
          throw new Error(`${path}: ${bytes} bytes exceeds the ${maxAssetBytes}-byte Cloudflare Pages asset limit`)
        }
        fileCount++
        const relative = path.slice(dir.length + 1)
        if (/^api\/v[23]\/traces\//.test(relative)) {
          traceFiles++
          traceBytes += bytes
        } else if (/^api\/v[123]\/data\.json$/.test(relative)) dataJsonBytes[relative] = bytes
      } else {
        throw new Error(`${path}: unexpected deployment output type`)
      }
    }
  }
  visit(dir)
  if (fileCount > maxOutputFiles) {
    throw new Error(`${dir}: ${fileCount} files exceeds the ${maxOutputFiles}-file Cloudflare Pages Free-plan limit`)
  }
  if (fileCount === 0) throw new Error(`${dir}: deployment output contains no files`)
  const fileHeadroom = maxOutputFiles - fileCount
  return { fileCount, fileLimit: maxOutputFiles, fileHeadroom, traceFiles, traceBytes, dataJsonBytes }
}

// --- Types ---

interface FeatureMeta {
  name: string
  slug?: string
  url?: string
  tags?: string[]
  group?: string
  body?: string
  probe?: string
  baseline?: string
}

interface ApiFeature {
  name: string
  category: string
  slug: string
  url?: string
  tags?: string[]
  baseline?: string
}

// --- Loaders ---

function loadFeaturesJson(): Record<string, FeatureMeta> {
  return loadFeatures(contentDir)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

// --- Main ---

/** Replace only previously emitted, byte-matching files; unknown surviving artifacts fail by path. */
function writeEvidence(
  out: string,
  documents: ReturnType<typeof publicResults>["documents"],
  runDocuments: ReadonlyMap<string, Buffer>,
  contentDir: string,
): void {
  const expected = new Map<string, Buffer>()
  for (const [url, { bytes, document }] of documents) {
    expected.set(url.slice(1), Buffer.from(bytes))
    // A run's trace holds no captures: they stay behind presentation review. Discriminate trace
    // documents by their trace path / identity header, never by `cells` (per-run evidence documents
    // also key approved cells under `cells`).
    const frames: Array<{ sha256: string; kind?: string }> = []
    if (url.startsWith("/api/v3/traces/") || "identity" in document) {
      // Trace documents carry no frame or screenshot artifacts.
    } else if ("qualification" in document) {
      for (const shape of document.qualification.shapes) {
        if (shape.frames) frames.push(...shape.frames)
      }
    } else {
      const cells: Record<string, CellEvidence | HistoricalCellEvidence> = document.cells
      for (const cell of Object.values(cells)) {
        if (cell.record.screenshot) frames.push({ ...cell.record.screenshot, kind: undefined })
        if (cell.record.frames) frames.push(...cell.record.frames)
      }
    }
    for (const frame of frames) {
      const text = frame.kind === "text-cells"
      const path = `artifacts/${frame.sha256}.${text ? "txt" : "png"}`
      if (!expected.has(path)) {
        expected.set(
          path,
          readVerifiedArtifact(
            contentDir,
            `sha256:${frame.sha256}`,
            document.runId,
            text ? "text-snapshot" : "screenshot",
          ),
        )
      }
    }
  }
  for (const [url, bytes] of runDocuments) expected.set(url.slice(1), bytes)
  const inventoryPath = join(out, "api", "v3", "evidence-files.json")
  const owned = new Map<string, string>()
  const isOwnedPath = (path: string) =>
    /^(?:artifacts\/[a-f0-9]{64}\.(?:png|txt)|api\/v3\/evidence\/[a-f0-9]{64}(?:\.json|\/[A-Za-z0-9_.%~-]+\.json)|api\/v3\/(?:runs|traces)\/[a-f0-9]{64}\.json)$/.test(
      path,
    )
  if (existsSync(inventoryPath)) {
    if (lstatSync(inventoryPath).isSymbolicLink()) throw new Error(`${inventoryPath}: evidence inventory is a symlink`)
    const prior = parseJsonStrict(inventoryPath, readFileSync(inventoryPath, "utf8"))
    if (!isRecord(prior) || prior.version !== 1 || !Array.isArray(prior.files)) {
      throw new Error(`${inventoryPath}: invalid generated evidence inventory`)
    }
    for (const row of prior.files) {
      if (
        !isRecord(row) ||
        typeof row.path !== "string" ||
        !isOwnedPath(row.path) ||
        typeof row.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(row.sha256) ||
        owned.has(row.path)
      ) {
        throw new Error(
          `${inventoryPath}: invalid generated evidence file ${isRecord(row) ? String(row.path) : "record"}`,
        )
      }
      owned.set(row.path, row.sha256)
    }
  }
  const existing = new Map<string, Buffer>()
  const visit = (relative: string): void => {
    const path = join(out, relative)
    if (!existsSync(path)) return
    if (lstatSync(path).isSymbolicLink()) throw new Error(`${path}: evidence directory is a symlink`)
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`
      if (entry.isSymbolicLink()) throw new Error(`${join(out, child)}: evidence artifact is a symlink`)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) existing.set(child, readFileSync(join(out, child)))
      else throw new Error(`${join(out, child)}: unexpected evidence artifact type`)
    }
  }
  visit("artifacts")
  visit("api/v3/evidence")
  visit("api/v3/runs")
  visit("api/v3/traces")
  // Check the complete population before performing any replacement or withdrawal.
  for (const [relative, bytes] of existing) {
    if (expected.get(relative)?.equals(bytes)) continue
    if (owned.get(relative) !== createHash("sha256").update(bytes).digest("hex")) {
      throw new Error(`${join(out, relative)}: unapproved or modified evidence artifact`)
    }
  }
  const prunedDirs = new Set<string>()
  for (const [relative] of existing) {
    if (!expected.has(relative)) {
      const fullPath = join(out, relative)
      unlinkSync(fullPath)
      prunedDirs.add(dirname(fullPath))
    }
  }
  for (const dir of prunedDirs) {
    if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir)
  }
  for (const [relative, bytes] of expected) {
    const path = join(out, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeAsset(path, bytes)
  }
  mkdirSync(dirname(inventoryPath), { recursive: true })
  writeAsset(
    inventoryPath,
    JSON.stringify(
      {
        version: 1,
        files: [...expected]
          .map(([path, bytes]) => ({
            path,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      },
      null,
      2,
    ) + "\n",
  )
}

export function generateApi(
  outDir?: string,
  options: { contentDir?: string } = {},
): {
  dataPath: string
  fileCount: number
  fileLimit: number
  fileHeadroom: number
} {
  // Tests pass a checked-in content root (#30764); the site always uses the repository's own content/.
  const resultsDir = options.contentDir ?? contentDir
  const featuresJson = loadFeaturesJson()
  const { projection } = loadCurrentResults(resultsDir)
  const published = publicResults(projection, compatibilityTargets(projection, resultsDir))
  const runDocuments = new Map<string, Buffer>()
  const allFeatureIds = new Set(Object.keys(featuresJson))

  // Build features map
  const features: Record<string, ApiFeature> = {}
  for (const id of [...allFeatureIds].sort()) {
    const meta = featuresJson[id]
    const [category] = id.split(".")
    if (!category) throw new Error(`Invalid feature ID ${id}`)
    features[id] = {
      name: meta?.name ?? id,
      category,
      slug: meta?.slug ?? id.replaceAll(".", "-"),
      ...(meta?.url && { url: meta.url }),
      ...(meta?.tags?.length && { tags: meta.tags }),
      ...(meta?.baseline && { baseline: meta.baseline }),
    }
  }

  // Only sealed schema-3 runs supply current results.
  type CurrentVersion = (typeof published.projection.current)[string]
  const currentRef = (version: CurrentVersion) => {
    const url = `/api/v3/runs/${version.sha256}.json`
    const bytes = Buffer.from(JSON.stringify(version) + "\n")
    const prior = runDocuments.get(url)
    if (prior && !prior.equals(bytes)) throw new Error(`Conflicting current run document ${url}`)
    runDocuments.set(url, bytes)
    const { results: _results, ...metadata } = version
    return { ...metadata, url, documentSha256: createHash("sha256").update(bytes).digest("hex") }
  }
  const currentGroups = (groups: Record<string, CurrentVersion[]>) =>
    Object.fromEntries(Object.entries(groups).map(([key, versions]) => [key, versions.map(currentRef)]))
  const currentData = {
    version: 3,
    generated:
      Object.values(projection.current)
        .map((run) => run.measuredAt)
        .sort()
        .at(-1) ?? "",
    methodology: {
      revision: "2026-10-20-sealed-five-statuses",
      statuses: CAPABILITY_STATUSES,
      score: "Supported / all frozen catalog positions; no exclusions.",
      completion:
        "A context is complete only with zero TEST TODO and TEST FAILURE. Absent required contexts remain incomplete.",
      historical: { v1: "/api/v1/data.json" },
      evidence: "Captures, free-form reasons and diagnostics require the separate exact-run presentation decision.",
    },
    features,
    catalogIds: [...allFeatureIds].sort(),
    currentRunCount: published.projection.currentRunCount,
    ...(published.projection.currentRunCount === 0 && {
      message: "No current schema-3 runs; historical results remain available.",
    }),
    current: Object.fromEntries(
      Object.entries(published.projection.current).map(([key, run]) => [key, currentRef(run)]),
    ),
    versions: currentGroups(published.projection.versions),
    history: currentGroups(published.projection.history),
    exclusions: published.projection.exclusions,
  }
  const v3Dir = outDir ? join(outDir, "api", "v3") : join(publicDir, "api", "v3")
  mkdirSync(v3Dir, { recursive: true })
  const dataPath = join(v3Dir, "data.json")
  writeEvidence(outDir ?? publicDir, published.documents, runDocuments, resultsDir)
  writeAsset(dataPath, JSON.stringify(currentData) + "\n")

  return { dataPath, ...assertDeploymentLimits(outDir ?? publicDir) }
}

// Allow standalone execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const { dataPath } = generateApi()
  const data = JSON.parse(readFileSync(dataPath, "utf-8")) as {
    current: Record<string, unknown>
    features: Record<string, unknown>
  }
  const runCount = Object.keys(data.current).length
  const featureCount = Object.keys(data.features).length
  console.log(`Generated ${dataPath}`)
  console.log(`  ${featureCount} features, ${runCount} current runs`)
}
