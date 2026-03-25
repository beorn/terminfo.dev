/**
 * Generate the terminfo.dev JSON API and SVG badges.
 *
 * Outputs:
 *   docs/public/api/v1/data.json     — complete compatibility database
 *   docs/public/api/v1/badges/*.svg   — per-terminal score badges
 *
 * Called from the VitePress buildEnd hook (docs/.vitepress/config.ts)
 * or standalone: bun scripts/generate-api.ts
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")
const docsDir = join(root, "docs")
const publicDir = join(docsDir, "public")
const apiDir = join(publicDir, "api", "v1")
const badgesDir = join(apiDir, "badges")
const resultsDir = join(docsDir, "data", "results")
const appDir = join(resultsDir, "app")

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

function loadFeaturesJson(): Record<string, FeatureMeta> {
  const path = join(root, "features.json")
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, any>
  delete raw.$comment
  const result: Record<string, FeatureMeta> = {}
  for (const [id, val] of Object.entries(raw)) {
    if (typeof val === "string") result[id] = { name: val }
    else result[id] = val as FeatureMeta
  }
  return result
}

function loadAnnotations(): Record<string, { note: string; url?: string; result?: string }> {
  const path = join(root, "annotations.json")
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, "utf-8"))
}

function loadBackendMeta(): Record<string, any> {
  // Try to load backends.json from @termless/core
  const candidates = [
    join(root, "node_modules", "@termless", "core", "backends.json"),
    join(root, "..", "termless", "backends.json"),
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, "utf-8")).backends ?? {}
    }
  }
  return {}
}

// --- App results (primary) ---

interface AppResult {
  terminal: string
  terminalVersion: string
  os?: string
  generated?: string
  results: Record<string, boolean>
  notes?: Record<string, string>
}

function loadAppResults(): {
  terminals: Map<
    string,
    { version: string; platforms: Set<string>; results: Record<string, string>; notes: Record<string, string> }
  >
  featureIds: Set<string>
} {
  const terminals = new Map<
    string,
    { version: string; platforms: Set<string>; results: Record<string, string>; notes: Record<string, string> }
  >()
  const featureIds = new Set<string>()

  if (!existsSync(appDir)) return { terminals, featureIds }

  const files = readdirSync(appDir).filter((f) => f.endsWith(".json"))
  // Keep latest per terminal
  const latest = new Map<string, AppResult>()
  const platformMap = new Map<string, Set<string>>()

  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(appDir, file), "utf-8")) as AppResult
      if (!raw.terminal || !raw.results) continue
      const key = raw.terminal
      if (!latest.has(key) || (raw.generated ?? "") > (latest.get(key)!.generated ?? "")) {
        latest.set(key, raw)
      }
      if (raw.os) {
        if (!platformMap.has(key)) platformMap.set(key, new Set())
        platformMap.get(key)!.add(raw.os)
      }
    } catch {}
  }

  for (const [name, raw] of latest) {
    const results: Record<string, string> = {}
    const notes: Record<string, string> = {}
    for (const [id, val] of Object.entries(raw.results)) {
      results[id] = val ? "yes" : "no"
      featureIds.add(id)
      if (raw.notes?.[id]) notes[id] = raw.notes[id]!
    }
    terminals.set(name, {
      version: raw.terminalVersion ?? "",
      platforms: platformMap.get(name) ?? new Set(),
      results,
      notes,
    })
  }

  return { terminals, featureIds }
}

// --- Headless results (fallback) ---

function loadHeadlessResults(): {
  terminals: Map<string, { version: string; results: Record<string, string>; notes: Record<string, string> }>
  featureIds: Set<string>
} {
  const terminals = new Map<
    string,
    { version: string; results: Record<string, string>; notes: Record<string, string> }
  >()
  const featureIds = new Set<string>()

  const files = readdirSync(resultsDir).filter((f) => f.endsWith(".json") && f !== "census.json")
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(resultsDir, file), "utf-8")) as any
      if (!raw.backend) continue
      const results: Record<string, string> = {}
      const notes: Record<string, string> = {}
      for (const [id, val] of Object.entries(raw.results ?? {})) {
        results[id] = typeof val === "boolean" ? (val ? "yes" : "no") : ((val as any).support ?? "unknown")
        featureIds.add(id)
        if (raw.notes?.[id]) notes[id] = raw.notes[id]
      }
      terminals.set(raw.backend, { version: raw.version ?? "", results, notes })
    } catch {}
  }

  return { terminals, featureIds }
}

// --- Label / slug helpers ---

const appLabels: Record<string, string> = {
  ghostty: "Ghostty",
  kitty: "Kitty",
  iterm2: "iTerm2",
  "terminal-app": "Terminal.app",
  warp: "Warp",
  cmux: "cmux",
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

function slugify(name: string, label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+$/, "")
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
  const annotations = loadAnnotations()
  const backendMeta = loadBackendMeta()

  // Load app results (primary) and headless results (fallback)
  const app = loadAppResults()
  const headless = loadHeadlessResults()

  // Map headless → app name collisions
  const headlessToApp: Record<string, string> = {
    xtermjs: "com.microsoft.VSCode",
    "ghostty-native": "ghostty",
    kitty: "kitty",
  }

  // Merge all feature IDs
  const allFeatureIds = new Set([...app.featureIds, ...headless.featureIds])

  // Build features map
  const features: ApiData["features"] = {}
  for (const id of [...allFeatureIds].sort()) {
    const meta = featuresJson[id]
    const category = id.split(".")[0]!
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

  // App terminals first (primary)
  for (const [name, data] of app.terminals) {
    const label = appLabels[name] ?? name
    const slug = slugify(name, label)
    const pass = Object.values(data.results).filter((v) => v === "yes").length
    const total = Object.keys(data.results).length
    const pct = total > 0 ? Math.round((pass / total) * 100) : 0

    terminals[slug] = {
      name: label,
      version: data.version,
      type: "app",
      ...(data.platforms.size > 0 && { platforms: [...data.platforms] }),
      ...(appUrls[name] && { url: appUrls[name] }),
      score: { total, pass, pct },
    }
    results[slug] = data.results
    notes[slug] = data.notes
  }

  // Headless terminals (fallback — skip if app version exists)
  const appNames = new Set(app.terminals.keys())
  for (const [name, data] of headless.terminals) {
    const appName = headlessToApp[name]
    if (appName && appNames.has(appName)) continue
    if (appNames.has(name)) continue

    const meta = backendMeta[name]
    const label = meta?.label ?? name
    const slug = slugify(name, label)

    // Apply annotation overrides to headless results
    for (const [key, ann] of Object.entries(annotations)) {
      const [backend, ...fp] = key.split(":")
      if (backend !== name) continue
      const feature = fp.join(":")
      if (ann.note) data.notes[feature] = ann.note
      if (ann.result) data.results[feature] = ann.result
    }

    const pass = Object.values(data.results).filter((v) => v === "yes").length
    const total = Object.keys(data.results).length
    const pct = total > 0 ? Math.round((pass / total) * 100) : 0

    terminals[slug] = {
      name: label,
      version: data.version,
      type: "headless",
      ...(meta?.url && { url: meta.url }),
      score: { total, pass, pct },
    }
    results[slug] = data.results
    notes[slug] = data.notes
  }

  // Build the API data object
  const apiData: ApiData = {
    version: 1,
    generated: new Date().toISOString(),
    features,
    terminals,
    results,
    notes,
  }

  // Write data.json
  const dataPath = join(targetApiDir, "data.json")
  writeFileSync(dataPath, JSON.stringify(apiData, null, 2) + "\n")

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
  const data = JSON.parse(readFileSync(dataPath, "utf-8"))
  const terminalCount = Object.keys(data.terminals).length
  const featureCount = Object.keys(data.features).length
  console.log(`Generated ${dataPath}`)
  console.log(`  ${featureCount} features, ${terminalCount} terminals`)
  console.log(`  ${badgeCount} badge SVGs`)
}
