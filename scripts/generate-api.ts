/**
 * Generate the terminfo.dev JSON API and SVG badges.
 *
 * Outputs:
 *   docs/public/api/v1/data.json     — conclusive compatibility projection
 *   docs/public/api/v1/badges/*.svg   — per-terminal score badges
 *   docs/public/api/v2/data.json     — exact-context outcomes and provenance
 *
 * Standalone `bun scripts/generate-api.ts` refreshes tracked docs/public
 * snapshots for local/dev consumers. VitePress buildEnd passes the ignored
 * build outDir so `bun run build` emits fresh deploy artifacts without
 * dirtying the source tree.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { compatibilityTargets, loadCurrentResults } from "../docs/data/current-results.ts"
import { parseJsonStrict, type SelectedVersion } from "../docs/data/selected-results.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")
const docsDir = join(root, "docs")
const publicDir = join(docsDir, "public")
const apiDir = join(publicDir, "api", "v1")
const contentDir = join(root, "content")

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

interface ApiData {
  version: number
  generated: string
  methodology: {
    revision: string
    v2: string
    methods: string
    keyPolicy: string
    contexts: Record<
      string,
      {
        contextKey: string
        runSha256: string
        target: SelectedVersion["target"]
        reviewer?: string
        reason?: string
        sources?: string[]
      }
    >
  }
  features: Record<
    string,
    {
      name: string
      category: string
      slug: string
      url?: string
      tags?: string[]
      baseline?: string
    }
  >
  terminals: Record<
    string,
    {
      name: string
      version: string
      type: "app" | "headless"
      platforms?: string[]
      url?: string
      score: { total: number; pass: number; pct: number }
    }
  >
  results: Record<string, Record<string, string>>
  notes: Record<string, Record<string, string>>
}

// --- Loaders ---

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

interface BackendMeta {
  label?: string
  url?: string
}

function loadFeaturesJson(): Record<string, FeatureMeta> {
  const path = join(contentDir, "features.json")
  const raw = parseJsonStrict(path, readFileSync(path, "utf-8"))
  if (!isRecord(raw)) throw new Error(`${path}: expected feature catalog object`)
  const result: Record<string, FeatureMeta> = {}
  for (const [id, val] of Object.entries(raw)) {
    if (id.startsWith("$")) continue
    if (typeof val === "string") result[id] = { name: val }
    else {
      if (!isRecord(val) || typeof val.name !== "string") throw new Error(`${path}: ${id} requires a feature name`)
      for (const field of ["slug", "url", "group", "body", "probe", "baseline"]) {
        if (val[field] !== undefined && typeof val[field] !== "string") {
          throw new Error(`${path}: invalid ${id}.${field}`)
        }
      }
      if (val.tags !== undefined && (!Array.isArray(val.tags) || !val.tags.every((tag) => typeof tag === "string"))) {
        throw new Error(`${path}: invalid ${id}.tags`)
      }
      result[id] = val as unknown as FeatureMeta
    }
  }
  return result
}

function loadBackendMeta(): Record<string, BackendMeta> {
  // Try to load backends.json from @termless/core
  const candidates = [
    join(root, "node_modules", "@termless", "core", "backends.json"),
    join(root, "..", "termless", "backends.json"),
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      const raw = parseJsonStrict(p, readFileSync(p, "utf-8"))
      if (!isRecord(raw) || !isRecord(raw.backends)) throw new Error(`${p}: missing backend metadata object`)
      const result: Record<string, BackendMeta> = {}
      for (const [id, value] of Object.entries(raw.backends)) {
        if (!isRecord(value)) throw new Error(`${p}: invalid backend ${id}`)
        if (
          (value.label !== undefined && typeof value.label !== "string") ||
          (value.url !== undefined && typeof value.url !== "string")
        ) {
          throw new Error(`${p}: invalid label or URL for ${id}`)
        }
        result[id] = {
          ...(typeof value.label === "string" && { label: value.label }),
          ...(typeof value.url === "string" && { url: value.url }),
        }
      }
      return result
    }
  }
  throw new Error(`Missing required backend metadata; searched ${candidates.join(", ")}`)
}

// --- Label / slug helpers ---

const appLabels: Record<string, string> = {
  ghostty: "Ghostty",
  kitty: "Kitty",
  iterm2: "iTerm2",
  "terminal-app": "Terminal.app",
  warp: "Warp",

  cursor: "Cursor",
  "com.microsoft.VSCode": "VS Code",
  "com.todesktop.230313mzl4w4u92": "Cursor",
}

const appUrls: Record<string, string> = {
  ghostty: "https://ghostty.org",
  kitty: "https://sw.kovidgoyal.net/kitty/",
  iterm2: "https://iterm2.com",
  "terminal-app": "https://support.apple.com/guide/terminal",
  warp: "https://www.warp.dev",
  "com.microsoft.VSCode": "https://code.visualstudio.com",
}

// --- Badge SVG ---

function badgeColor(pct: number): string {
  if (pct >= 90) return "#4c1"
  if (pct >= 70) return "#dfb317"
  return "#e05d44"
}

function measureText(text: string): number {
  // Approximate character width for Verdana 11px
  return Math.round(text.length * 6.6 + 10)
}

function generateBadgeSvg(label: string, pass: number, total: number, pct: number): string {
  const rightText = `${pct}% (${pass}/${total})`
  const leftWidth = Math.max(measureText(label), 50)
  const rightWidth = Math.max(measureText(rightText), 50)
  const totalWidth = leftWidth + rightWidth
  const color = badgeColor(pct)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${leftWidth}" height="20" fill="#555"/>
    <rect x="${leftWidth}" width="${rightWidth}" height="20" fill="${color}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${leftWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${leftWidth / 2}" y="14">${label}</text>
    <text x="${leftWidth + rightWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${rightText}</text>
    <text x="${leftWidth + rightWidth / 2}" y="14">${rightText}</text>
  </g>
</svg>`
}

// --- Main ---

export function generateApi(outDir?: string): { dataPath: string; badgeCount: number } {
  const targetApiDir = outDir ? join(outDir, "api", "v1") : apiDir
  const targetBadgesDir = join(targetApiDir, "badges")
  mkdirSync(targetBadgesDir, { recursive: true })

  const featuresJson = loadFeaturesJson()
  const backendMeta = loadBackendMeta()
  const { projection } = loadCurrentResults(contentDir, { artifactDir: join(outDir ?? publicDir, "artifacts") })
  const byTarget = compatibilityTargets(projection, contentDir)
  // Catalog metadata stays available, but only reviewed, conclusive observations become v1 result keys.
  const allFeatureIds = new Set(Object.keys(featuresJson))

  // Build features map
  const features: ApiData["features"] = {}
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

  // Build terminals map + results + notes
  const terminals: ApiData["terminals"] = {}
  const results: ApiData["results"] = {}
  const notes: ApiData["notes"] = {}
  const contexts: ApiData["methodology"]["contexts"] = {}

  for (const [key, { selected, contextKey, policy }] of byTarget) {
    if (selected.counts.conclusive === 0) continue
    const { kind, id, os } = selected.target
    if (kind === "mux") continue // v1 terminal type only describes apps and headless engines; v2 carries mux targets.
    const meta = backendMeta[id]
    const label = kind === "app" ? (appLabels[id] ?? id) : (meta?.label ?? id)
    if (terminals[key]) throw new Error(`Ambiguous API terminal key ${key}: multiple selected targets`)
    const { conclusive: total, supported: pass } = selected.counts
    const pct = Math.round((pass / total) * 100)
    terminals[key] = {
      name: label,
      version: selected.target.version,
      type: kind === "headless" ? "headless" : "app",
      ...(os && { platforms: [os] }),
      ...(appUrls[id] && { url: appUrls[id] }),
      ...(!appUrls[id] && meta?.url && { url: meta.url }),
      score: { total, pass, pct },
    }
    results[key] = Object.fromEntries(
      Object.entries(selected.v1).map(([feature, value]) => [feature, value ? "yes" : "no"]),
    )
    notes[key] = Object.fromEntries(
      Object.entries(selected.cells).flatMap(([feature, cell]) =>
        Object.hasOwn(selected.v1, feature) && cell.note ? [[feature, cell.note]] : [],
      ),
    )
    contexts[key] = {
      contextKey,
      runSha256: selected.sha256,
      target: selected.target,
      ...(policy && { reviewer: policy.reviewer, reason: policy.reason, sources: policy.sources }),
    }
  }

  // Build the API data object
  const apiData: ApiData = {
    version: 1,
    generated:
      Object.values(projection.current)
        .map((v) => v.measuredAt)
        .sort()
        .at(-1) ?? "",
    methodology: {
      revision: "2026-09-28",
      v2: "/api/v2/data.json",
      methods: "/contribute#what-a-probe-can-establish",
      keyPolicy:
        "Released v1 keys keep their published target kind; another kind with the same catalog ID uses kind-ID. New collisions keep the app at the bare ID. v2 uses full kind:ID contexts.",
      contexts,
    },
    features,
    terminals,
    results,
    notes,
  }

  // Write data.json
  const dataPath = join(targetApiDir, "data.json")
  writeFileSync(dataPath, JSON.stringify(apiData, null, 2) + "\n")

  // v2 retains exact context keys and every selected cell's outcome and provenance.
  const v2Dir = outDir ? join(outDir, "api", "v2") : join(publicDir, "api", "v2")
  mkdirSync(v2Dir, { recursive: true })
  writeFileSync(
    join(v2Dir, "data.json"),
    JSON.stringify(
      { version: 2, generated: apiData.generated, methodology: apiData.methodology, features, ...projection },
      null,
      2,
    ) + "\n",
  )

  // Generate badges
  let badgeCount = 0
  for (const [slug, terminal] of Object.entries(terminals)) {
    const svg = generateBadgeSvg(terminal.name, terminal.score.pass, terminal.score.total, terminal.score.pct)
    writeFileSync(join(targetBadgesDir, `${slug}.svg`), svg)
    badgeCount++
  }

  return { dataPath, badgeCount }
}

// Allow standalone execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const { dataPath, badgeCount } = generateApi()
  const data = JSON.parse(readFileSync(dataPath, "utf-8")) as {
    terminals: Record<string, unknown>
    features: Record<string, unknown>
  }
  const terminalCount = Object.keys(data.terminals).length
  const featureCount = Object.keys(data.features).length
  console.log(`Generated ${dataPath}`)
  console.log(`  ${featureCount} features, ${terminalCount} terminals`)
  console.log(`  ${badgeCount} badge SVGs`)
}
