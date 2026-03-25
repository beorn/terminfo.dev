/**
 * Generate analysis.json — computed stats and template-based commentary
 * for every page type on terminfo.dev.
 *
 * Reads measured probe results + curated editorial content,
 * cross-validates everything, computes stats, generates analysis text,
 * and writes content/analysis.json.
 *
 * Usage:
 *   bun scripts/generate-analysis.ts              # Generate analysis.json
 *   bun scripts/generate-analysis.ts --dry-run    # Print what would be generated
 *   bun scripts/generate-analysis.ts --validate   # Validate existing against data
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")
const contentDir = join(root, "content")
const probesAppsDir = join(contentDir, "probes-apps")
const probesLibsDir = join(contentDir, "probes-libs")

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

interface TerminalMeta {
  label: string
  slug: string
  url?: string
  description?: string
  body?: string
  headlessBackends?: string[]
  manifestBackend?: string
  platforms?: string[]
}

interface CategoryMeta {
  label: string
  order: number
  description: string
}

interface StandardMeta {
  label: string
  url: string
  description: string
}

interface BaselineMeta {
  label: string
  emoji: string
  color: string
  order: number
  tagline: string
  description: string
  forDevelopers: string
  forTerminalAuthors: string
}

interface AppResult {
  terminal?: string
  backend?: string
  terminalVersion?: string
  version?: string
  os?: string
  generated?: string
  source?: string
  results: Record<string, boolean>
  notes?: Record<string, string>
}

interface TerminalStats {
  name: string
  slug: string
  total: number
  yes: number
  no: number
  pct: number
  results: Record<string, boolean>
  baselineCompliance: Record<string, { total: number; yes: number; pct: number }>
  uniquelySupported: string[]
  uniquelyMissing: string[]
  missingFeatures: string[]
  version: string
  type: "app" | "headless"
}

interface AnalysisEntry {
  analysis: string
  date: string
  probeCount?: number
  changes: string | null
}

// --- Assertions ---

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// --- Data Loading ---

function loadJson<T>(path: string, description: string): T {
  assert(existsSync(path), `Missing required file: ${path} (${description})`)
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T
  } catch (e) {
    throw new Error(`Failed to parse ${path} (${description}): ${e}`)
  }
}

function loadFeatures(): Record<string, FeatureMeta> {
  const raw = loadJson<Record<string, FeatureMeta>>(
    join(contentDir, "features.json"),
    "feature metadata",
  )
  delete (raw as Record<string, unknown>).$comment
  for (const [id, feat] of Object.entries(raw)) {
    assert(typeof feat.name === "string" && feat.name.length > 0, `Feature '${id}' missing name`)
  }
  return raw
}

function loadTerminals(): Record<string, TerminalMeta> {
  const raw = loadJson<Record<string, TerminalMeta>>(
    join(contentDir, "terminals.json"),
    "terminal metadata",
  )
  for (const [id, term] of Object.entries(raw)) {
    assert(typeof term.label === "string", `Terminal '${id}' missing label`)
    assert(typeof term.slug === "string", `Terminal '${id}' missing slug`)
  }
  return raw
}

function loadCategories(): Record<string, CategoryMeta> {
  return loadJson<Record<string, CategoryMeta>>(
    join(contentDir, "categories.json"),
    "category metadata",
  )
}

function loadStandards(): Record<string, StandardMeta> {
  return loadJson<Record<string, StandardMeta>>(
    join(contentDir, "standards.json"),
    "standard metadata",
  )
}

function loadBaselines(): Record<string, BaselineMeta> {
  return loadJson<Record<string, BaselineMeta>>(
    join(contentDir, "baselines.json"),
    "baseline metadata",
  )
}

function loadAnnotations(): Record<string, { note: string; url?: string; result?: string }> {
  const path = join(contentDir, "annotations.json")
  if (!existsSync(path)) return {}
  return loadJson<Record<string, { note: string; url?: string; result?: string }>>(
    path,
    "annotations",
  )
}

/** Load probe results from a directory, keyed by terminal/backend name. */
function loadProbeDir(dir: string): Map<string, AppResult> {
  if (!existsSync(dir)) return new Map()
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"))
  const latest = new Map<string, AppResult>()

  for (const file of files) {
    const path = join(dir, file)
    const raw = loadJson<AppResult>(path, `probe result ${file}`)
    const key = raw.terminal ?? raw.backend
    assert(key, `Missing terminal/backend in ${file}`)
    assert(raw.results && typeof raw.results === "object", `Missing results in ${file}`)
    assert(
      typeof raw.generated === "string",
      `Missing generated timestamp in ${file}`,
    )

    // Validate all result values
    for (const [feature, result] of Object.entries(raw.results)) {
      assert(
        typeof result === "boolean",
        `Invalid result '${result}' for ${feature} in ${file} — expected boolean`,
      )
    }

    // Keep latest per terminal/backend
    if (!latest.has(key) || (raw.generated ?? "") > (latest.get(key)!.generated ?? "")) {
      latest.set(key, raw)
    }
  }

  return latest
}

// --- Mapping: which terminal names map to which backends ---

function buildTerminalResultMap(
  terminals: Record<string, TerminalMeta>,
  appResults: Map<string, AppResult>,
  libResults: Map<string, AppResult>,
  annotations: Record<string, { note: string; url?: string; result?: string }>,
): Map<string, { results: Record<string, boolean>; version: string; type: "app" | "headless" }> {
  const resultMap = new Map<
    string,
    { results: Record<string, boolean>; version: string; type: "app" | "headless" }
  >()

  for (const [termId, meta] of Object.entries(terminals)) {
    // Try app results first (direct match by terminal ID)
    if (appResults.has(termId)) {
      const app = appResults.get(termId)!
      resultMap.set(termId, {
        results: app.results,
        version: app.terminalVersion ?? app.version ?? "",
        type: "app",
      })
      continue
    }

    // Try headless backend (manifestBackend)
    const backendName = meta.manifestBackend
    if (backendName && libResults.has(backendName)) {
      const lib = libResults.get(backendName)!
      // Apply annotation overrides
      const results = { ...lib.results }
      for (const [key, ann] of Object.entries(annotations)) {
        const [backend, ...fp] = key.split(":")
        if (backend !== backendName) continue
        const feature = fp.join(":")
        if (ann.result === "partial") results[feature] = true // partial counts as supported
        else if (ann.result === "yes") results[feature] = true
        else if (ann.result === "no") results[feature] = false
      }
      resultMap.set(termId, {
        results,
        version: lib.version ?? "",
        type: "headless",
      })
      continue
    }

    // Also try headless backends listed in headlessBackends[]
    if (meta.headlessBackends) {
      for (const hb of meta.headlessBackends) {
        if (libResults.has(hb)) {
          const lib = libResults.get(hb)!
          const results = { ...lib.results }
          for (const [key, ann] of Object.entries(annotations)) {
            const [backend, ...fp] = key.split(":")
            if (backend !== hb) continue
            const feature = fp.join(":")
            if (ann.result === "partial") results[feature] = true
            else if (ann.result === "yes") results[feature] = true
            else if (ann.result === "no") results[feature] = false
          }
          resultMap.set(termId, {
            results,
            version: lib.version ?? "",
            type: "headless",
          })
          break
        }
      }
    }
  }

  return resultMap
}

// --- Cross-validation ---

function crossValidate(
  features: Record<string, FeatureMeta>,
  terminals: Record<string, TerminalMeta>,
  resultMap: Map<string, { results: Record<string, boolean> }>,
): void {
  // Every feature ID in results must exist in features.json
  for (const [termId, data] of resultMap) {
    for (const featureId of Object.keys(data.results)) {
      assert(
        features[featureId],
        `Feature '${featureId}' found in results for '${termId}' but not in features.json`,
      )
    }
  }

  // Warn (but don't throw) for terminals with no results
  for (const termId of Object.keys(terminals)) {
    if (!resultMap.has(termId)) {
      console.warn(`Warning: Terminal '${termId}' has no probe results (no app or headless data)`)
    }
  }
}

// --- Stats Computation ---

function computeTerminalStats(
  termId: string,
  termMeta: TerminalMeta,
  data: { results: Record<string, boolean>; version: string; type: "app" | "headless" },
  features: Record<string, FeatureMeta>,
  baselineFeatures: Record<string, string[]>,
  allTerminalResults: Map<string, { results: Record<string, boolean> }>,
): TerminalStats {
  const results = data.results
  const total = Object.keys(results).length
  const yes = Object.values(results).filter((v) => v === true).length
  const no = total - yes
  const pct = total > 0 ? Math.round((yes / total) * 100) : 0

  // Per-baseline compliance
  const baselineCompliance: Record<string, { total: number; yes: number; pct: number }> = {}
  for (const [baselineName, featureIds] of Object.entries(baselineFeatures)) {
    const relevantIds = featureIds.filter((id) => id in results)
    const baselineYes = relevantIds.filter((id) => results[id] === true).length
    const baselineTotal = relevantIds.length
    baselineCompliance[baselineName] = {
      total: baselineTotal,
      yes: baselineYes,
      pct: baselineTotal > 0 ? Math.round((baselineYes / baselineTotal) * 100) : 0,
    }
  }

  // Features uniquely supported (this terminal supports, no other does)
  const uniquelySupported: string[] = []
  // Features uniquely missing (every other terminal passes, this one doesn't)
  const uniquelyMissing: string[] = []
  const missingFeatures: string[] = []

  const otherTerminals = [...allTerminalResults.entries()].filter(([id]) => id !== termId)

  for (const [featureId, supported] of Object.entries(results)) {
    if (!supported) {
      missingFeatures.push(featureId)
      // Check if every other terminal passes this
      const allOthersPass = otherTerminals.every(([, other]) => other.results[featureId] === true)
      if (allOthersPass && otherTerminals.length > 0) {
        uniquelyMissing.push(featureId)
      }
    } else {
      // Check if no other terminal supports this
      const noOtherSupports = otherTerminals.every(
        ([, other]) => other.results[featureId] !== true,
      )
      if (noOtherSupports && otherTerminals.length > 0) {
        uniquelySupported.push(featureId)
      }
    }
  }

  return {
    name: termMeta.label,
    slug: termMeta.slug,
    total,
    yes,
    no,
    pct,
    results,
    baselineCompliance,
    uniquelySupported,
    uniquelyMissing,
    missingFeatures,
    version: data.version,
    type: data.type,
  }
}

function buildBaselineFeatureMap(features: Record<string, FeatureMeta>): Record<string, string[]> {
  const map: Record<string, string[]> = {}
  for (const [id, feat] of Object.entries(features)) {
    if (feat.baseline) {
      if (!map[feat.baseline]) map[feat.baseline] = []
      map[feat.baseline].push(id)
    }
  }
  return map
}

// --- Ranking ---

function rankTerminals(stats: Map<string, TerminalStats>): Map<string, number> {
  const sorted = [...stats.entries()].sort((a, b) => b[1].pct - a[1].pct || b[1].yes - a[1].yes)
  const ranks = new Map<string, number>()
  for (let i = 0; i < sorted.length; i++) {
    ranks.set(sorted[i][0], i + 1)
  }
  return ranks
}

// --- Analysis Generation (Template-based) ---

function featureName(features: Record<string, FeatureMeta>, id: string): string {
  return features[id]?.name ?? id
}

function generateTerminalAnalysis(
  termId: string,
  stats: TerminalStats,
  rank: number,
  totalTerminals: number,
  features: Record<string, FeatureMeta>,
  baselines: Record<string, BaselineMeta>,
): AnalysisEntry {
  const parts: string[] = []

  // Score summary
  parts.push(
    `${stats.name} scores <strong>${stats.pct}%</strong> (${stats.yes}/${stats.total}) on the terminfo.dev feature matrix`,
  )

  // Baseline compliance
  const failedBaselines = Object.entries(stats.baselineCompliance)
    .filter(([, bl]) => bl.pct < 100)
    .map(([name]) => baselines[name]?.label ?? name)
  const passedBaselines = Object.entries(stats.baselineCompliance)
    .filter(([, bl]) => bl.pct === 100)
    .map(([name]) => baselines[name]?.label ?? name)

  if (failedBaselines.length === 0 && passedBaselines.length > 0) {
    parts.push(`achieving <strong>100%</strong> compliance on all four baselines (${passedBaselines.join(", ")})`)
  } else if (failedBaselines.length > 0) {
    parts.push(`with gaps in the ${failedBaselines.join(", ")} baseline${failedBaselines.length > 1 ? "s" : ""}`)
  }

  // Ranking
  parts.push(`Ranks <strong>#${rank}</strong> of ${totalTerminals} tested terminals`)

  // Unique strengths
  if (stats.uniquelySupported.length > 0) {
    const names = stats.uniquelySupported.slice(0, 5).map((id) => featureName(features, id))
    parts.push(`Uniquely supports: ${names.join(", ")}`)
  }

  // Unique gaps
  if (stats.uniquelyMissing.length > 0 && stats.uniquelyMissing.length <= 5) {
    const names = stats.uniquelyMissing.map((id) => featureName(features, id))
    parts.push(`Uniquely missing (all other terminals pass): ${names.join(", ")}`)
  }

  // Missing features (if few)
  if (stats.missingFeatures.length > 0 && stats.missingFeatures.length <= 8) {
    const names = stats.missingFeatures.map((id) => featureName(features, id))
    parts.push(`Missing: ${names.join(", ")}`)
  } else if (stats.missingFeatures.length > 8) {
    parts.push(`Missing <strong>${stats.missingFeatures.length}</strong> features`)
  }

  return {
    analysis: `<p>${parts.join(". ")}.</p>`,
    date: new Date().toISOString().slice(0, 10),
    probeCount: stats.total,
    changes: null,
  }
}

function generateBaselineAnalysis(
  baselineName: string,
  baselineMeta: BaselineMeta,
  allStats: Map<string, TerminalStats>,
  features: Record<string, FeatureMeta>,
): AnalysisEntry {
  const parts: string[] = []
  const terminals = [...allStats.values()]

  const perfect = terminals.filter(
    (s) => s.baselineCompliance[baselineName]?.pct === 100,
  )
  const imperfect = terminals
    .filter((s) => s.baselineCompliance[baselineName]?.pct !== undefined && s.baselineCompliance[baselineName].pct < 100)
    .sort((a, b) => (a.baselineCompliance[baselineName]?.pct ?? 0) - (b.baselineCompliance[baselineName]?.pct ?? 0))

  if (perfect.length === terminals.length) {
    parts.push(
      `All <strong>${terminals.length}</strong> tested terminals achieve <strong>100%</strong> ${baselineMeta.label} compliance`,
    )
  } else {
    parts.push(
      `<strong>${perfect.length}</strong> of ${terminals.length} tested terminals achieve 100% ${baselineMeta.label} compliance`,
    )
  }

  if (imperfect.length > 0) {
    const laggards = imperfect.slice(0, 3).map(
      (s) =>
        `${s.name} (${s.baselineCompliance[baselineName]?.pct ?? 0}%)`,
    )
    parts.push(`Lagging: ${laggards.join(", ")}`)

    // Find what features the laggards are missing
    const missingCounts = new Map<string, number>()
    for (const s of imperfect) {
      const bl = s.baselineCompliance[baselineName]
      if (!bl) continue
      for (const [fid, supported] of Object.entries(s.results)) {
        if (!supported && features[fid]?.baseline === baselineName) {
          missingCounts.set(fid, (missingCounts.get(fid) ?? 0) + 1)
        }
      }
    }
    const commonMissing = [...missingCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id]) => featureName(features, id))
    if (commonMissing.length > 0) {
      parts.push(`Most commonly missing: ${commonMissing.join(", ")}`)
    }
  }

  return {
    analysis: `<p>${parts.join(". ")}.</p>`,
    date: new Date().toISOString().slice(0, 10),
    changes: null,
  }
}

function generateCompareAnalysis(
  termIdA: string,
  termIdB: string,
  statsA: TerminalStats,
  statsB: TerminalStats,
  features: Record<string, FeatureMeta>,
): AnalysisEntry {
  const parts: string[] = []

  // Overall scores
  parts.push(
    `<strong>${statsA.name}</strong> scores ${statsA.pct}% (${statsA.yes}/${statsA.total}) vs <strong>${statsB.name}</strong> at ${statsB.pct}% (${statsB.yes}/${statsB.total})`,
  )

  // Who leads
  if (statsA.pct > statsB.pct) {
    parts.push(`${statsA.name} leads by ${statsA.pct - statsB.pct} percentage points`)
  } else if (statsB.pct > statsA.pct) {
    parts.push(`${statsB.name} leads by ${statsB.pct - statsA.pct} percentage points`)
  } else {
    parts.push("Both terminals are tied in overall score")
  }

  // Features A has that B doesn't
  const onlyA = Object.entries(statsA.results)
    .filter(([id, v]) => v === true && statsB.results[id] !== true)
    .map(([id]) => id)
  // Features B has that A doesn't
  const onlyB = Object.entries(statsB.results)
    .filter(([id, v]) => v === true && statsA.results[id] !== true)
    .map(([id]) => id)

  if (onlyA.length > 0) {
    const names = onlyA.slice(0, 5).map((id) => featureName(features, id))
    const suffix = onlyA.length > 5 ? ` and ${onlyA.length - 5} more` : ""
    parts.push(`Only in ${statsA.name}: ${names.join(", ")}${suffix}`)
  }

  if (onlyB.length > 0) {
    const names = onlyB.slice(0, 5).map((id) => featureName(features, id))
    const suffix = onlyB.length > 5 ? ` and ${onlyB.length - 5} more` : ""
    parts.push(`Only in ${statsB.name}: ${names.join(", ")}${suffix}`)
  }

  if (onlyA.length === 0 && onlyB.length === 0) {
    parts.push("Both terminals support identical features")
  }

  return {
    analysis: `<p>${parts.join(". ")}.</p>`,
    date: new Date().toISOString().slice(0, 10),
    changes: null,
  }
}

function generateCategoryAnalysis(
  catId: string,
  catMeta: CategoryMeta,
  allStats: Map<string, TerminalStats>,
  features: Record<string, FeatureMeta>,
): AnalysisEntry {
  const parts: string[] = []
  const categoryFeatures = Object.entries(features)
    .filter(([id]) => id.startsWith(catId + "."))
    .map(([id]) => id)

  parts.push(
    `The <strong>${catMeta.label}</strong> category covers ${categoryFeatures.length} features`,
  )

  // Find best and worst terminals for this category
  const catScores: { name: string; yes: number; total: number; pct: number }[] = []
  for (const [, stats] of allStats) {
    const relevant = categoryFeatures.filter((id) => id in stats.results)
    const yes = relevant.filter((id) => stats.results[id] === true).length
    const total = relevant.length
    if (total > 0) {
      catScores.push({ name: stats.name, yes, total, pct: Math.round((yes / total) * 100) })
    }
  }
  catScores.sort((a, b) => b.pct - a.pct || b.yes - a.yes)

  const perfect = catScores.filter((s) => s.pct === 100)
  if (perfect.length > 0) {
    const names = perfect.map((s) => s.name)
    if (perfect.length === catScores.length) {
      parts.push(`All ${catScores.length} tested terminals achieve 100%`)
    } else {
      parts.push(
        `Top performers (100%): ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` and ${names.length - 5} more` : ""}`,
      )
    }
  }

  // Common gaps
  const gapCounts = new Map<string, number>()
  for (const [, stats] of allStats) {
    for (const fid of categoryFeatures) {
      if (fid in stats.results && stats.results[fid] !== true) {
        gapCounts.set(fid, (gapCounts.get(fid) ?? 0) + 1)
      }
    }
  }
  const commonGaps = [...gapCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
  if (commonGaps.length > 0) {
    const gapNames = commonGaps.map(
      ([id, count]) => `${featureName(features, id)} (${count} terminals fail)`,
    )
    parts.push(`Common gaps: ${gapNames.join(", ")}`)
  }

  return {
    analysis: `<p>${parts.join(". ")}.</p>`,
    date: new Date().toISOString().slice(0, 10),
    changes: null,
  }
}

function generateStandardAnalysis(
  stdId: string,
  stdMeta: StandardMeta,
  allStats: Map<string, TerminalStats>,
  features: Record<string, FeatureMeta>,
): AnalysisEntry {
  const parts: string[] = []
  const taggedFeatures = Object.entries(features)
    .filter(([, f]) => f.tags?.includes(stdId))
    .map(([id]) => id)

  parts.push(
    `<strong>${stdMeta.label}</strong> defines ${taggedFeatures.length} features in the terminfo.dev matrix`,
  )

  // Adoption: how many terminals support all features in this standard?
  const stdScores: { name: string; yes: number; total: number; pct: number }[] = []
  for (const [, stats] of allStats) {
    const relevant = taggedFeatures.filter((id) => id in stats.results)
    const yes = relevant.filter((id) => stats.results[id] === true).length
    const total = relevant.length
    if (total > 0) {
      stdScores.push({ name: stats.name, yes, total, pct: Math.round((yes / total) * 100) })
    }
  }
  stdScores.sort((a, b) => b.pct - a.pct || b.yes - a.yes)

  if (stdScores.length > 0) {
    const avgPct = Math.round(stdScores.reduce((sum, s) => sum + s.pct, 0) / stdScores.length)
    parts.push(`Average adoption across terminals: <strong>${avgPct}%</strong>`)
  }

  const perfect = stdScores.filter((s) => s.pct === 100)
  if (perfect.length > 0) {
    const names = perfect.map((s) => s.name)
    parts.push(
      `Full compliance (100%): ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` and ${names.length - 5} more` : ""}`,
    )
  }

  if (stdScores.length > 0) {
    const worst = stdScores[stdScores.length - 1]
    if (worst.pct < 100) {
      parts.push(`Lowest: ${worst.name} at ${worst.pct}% (${worst.yes}/${worst.total})`)
    }
  }

  return {
    analysis: `<p>${parts.join(". ")}.</p>`,
    date: new Date().toISOString().slice(0, 10),
    changes: null,
  }
}

// --- Popular comparisons ---

const POPULAR_COMPARISONS: [string, string][] = [
  ["ghostty", "kitty"],
  ["ghostty", "iterm2"],
  ["ghostty", "warp"],
  ["ghostty", "terminal-app"],
  ["kitty", "iterm2"],
  ["kitty", "warp"],
  ["iterm2", "terminal-app"],
  ["iterm2", "warp"],
  ["com.microsoft.VSCode", "cursor"],
  ["warp", "terminal-app"],
]

// --- Validation of generated HTML ---

function validateHtml(html: string, key: string): void {
  // Check for unclosed strong tags
  const openStrong = (html.match(/<strong>/g) ?? []).length
  const closeStrong = (html.match(/<\/strong>/g) ?? []).length
  assert(
    openStrong === closeStrong,
    `${key}: Unclosed <strong> tags (${openStrong} open, ${closeStrong} close)`,
  )

  // Check for unclosed p tags
  const openP = (html.match(/<p>/g) ?? []).length
  const closeP = (html.match(/<\/p>/g) ?? []).length
  assert(openP === closeP, `${key}: Unclosed <p> tags (${openP} open, ${closeP} close)`)
}

function validateNumbersInAnalysis(
  key: string,
  analysis: string,
  stats: TerminalStats | null,
): void {
  if (!stats) return

  // Extract percentage from analysis
  const pctMatch = analysis.match(/scores <strong>(\d+)%<\/strong>/)
  if (pctMatch) {
    const pctInText = Number.parseInt(pctMatch[1], 10)
    assert(
      pctInText === stats.pct,
      `${key}: Percentage in text (${pctInText}%) doesn't match computed (${stats.pct}%)`,
    )
  }

  // Extract yes/total counts
  const countMatch = analysis.match(/\((\d+)\/(\d+)\)/)
  if (countMatch) {
    const yesInText = Number.parseInt(countMatch[1], 10)
    const totalInText = Number.parseInt(countMatch[2], 10)
    assert(
      yesInText === stats.yes,
      `${key}: Pass count in text (${yesInText}) doesn't match computed (${stats.yes})`,
    )
    assert(
      totalInText === stats.total,
      `${key}: Total count in text (${totalInText}) doesn't match computed (${stats.total})`,
    )
  }
}

// --- Main ---

function loadAllData() {
  const features = loadFeatures()
  const terminals = loadTerminals()
  const categories = loadCategories()
  const standards = loadStandards()
  const baselines = loadBaselines()
  const annotations = loadAnnotations()

  const appResults = loadProbeDir(probesAppsDir)
  const libResults = loadProbeDir(probesLibsDir)

  const resultMap = buildTerminalResultMap(terminals, appResults, libResults, annotations)

  // Cross-validate
  crossValidate(features, terminals, resultMap)

  return { features, terminals, categories, standards, baselines, annotations, resultMap }
}

function generateAnalysis(): Record<string, AnalysisEntry> {
  const { features, terminals, categories, standards, baselines, resultMap } = loadAllData()
  const baselineFeatures = buildBaselineFeatureMap(features)
  const output: Record<string, AnalysisEntry> = {}

  // Compute stats for all terminals that have results
  const allStats = new Map<string, TerminalStats>()
  for (const [termId, data] of resultMap) {
    const meta = terminals[termId]
    if (!meta) continue
    const stats = computeTerminalStats(termId, meta, data, features, baselineFeatures, resultMap)
    allStats.set(termId, stats)
  }

  const ranks = rankTerminals(allStats)
  const totalTerminals = allStats.size

  // Deduplicate terminals by slug (e.g., multiple cursor entries)
  const slugSeen = new Set<string>()

  // 1. Terminal pages
  for (const [termId, stats] of allStats) {
    const slug = stats.slug
    if (slugSeen.has(slug)) continue
    slugSeen.add(slug)

    const key = `terminal/${slug}`
    const rank = ranks.get(termId) ?? totalTerminals
    const entry = generateTerminalAnalysis(termId, stats, rank, totalTerminals, features, baselines)

    // Validate
    validateHtml(entry.analysis, key)
    validateNumbersInAnalysis(key, entry.analysis, stats)

    output[key] = entry
  }

  // 2. Baseline pages
  for (const [baselineId, baselineMeta] of Object.entries(baselines)) {
    const key = `baseline/${baselineId}`
    const entry = generateBaselineAnalysis(baselineId, baselineMeta, allStats, features)
    validateHtml(entry.analysis, key)
    output[key] = entry
  }

  // 3. Comparison pages (popular pairs only)
  for (const [idA, idB] of POPULAR_COMPARISONS) {
    const statsA = allStats.get(idA)
    const statsB = allStats.get(idB)
    if (!statsA || !statsB) continue

    // Alphabetical slug ordering for deterministic URLs
    const slugs = [statsA.slug, statsB.slug].sort()
    const key = `compare/${slugs[0]}-vs-${slugs[1]}`

    const [orderedA, orderedB] =
      statsA.slug === slugs[0] ? [statsA, statsB] : [statsB, statsA]
    const entry = generateCompareAnalysis(
      slugs[0] === statsA.slug ? idA : idB,
      slugs[0] === statsA.slug ? idB : idA,
      orderedA,
      orderedB,
      features,
    )
    validateHtml(entry.analysis, key)
    output[key] = entry
  }

  // 4. Category pages
  for (const [catId, catMeta] of Object.entries(categories)) {
    const key = catId
    const entry = generateCategoryAnalysis(catId, catMeta, allStats, features)
    validateHtml(entry.analysis, key)
    output[key] = entry
  }

  // 5. Standard pages
  for (const [stdId, stdMeta] of Object.entries(standards)) {
    const key = stdId
    const entry = generateStandardAnalysis(stdId, stdMeta, allStats, features)
    validateHtml(entry.analysis, key)
    output[key] = entry
  }

  return output
}

// --- CLI ---

const args = process.argv.slice(2)
const isDryRun = args.includes("--dry-run")
const isValidate = args.includes("--validate")

try {
  const analysis = generateAnalysis()
  const result = {
    $generated: new Date().toISOString(),
    ...analysis,
  }

  const outputPath = join(contentDir, "analysis.json")
  const entryCount = Object.keys(analysis).length
  const terminalCount = Object.keys(analysis).filter((k) => k.startsWith("terminal/")).length
  const baselineCount = Object.keys(analysis).filter((k) => k.startsWith("baseline/")).length
  const compareCount = Object.keys(analysis).filter((k) => k.startsWith("compare/")).length
  const categoryCount = Object.keys(analysis).filter((k) =>
    !k.startsWith("terminal/") && !k.startsWith("baseline/") && !k.startsWith("compare/") && !k.includes("/"),
  ).length

  if (isValidate) {
    // Validate existing analysis.json against current data
    if (!existsSync(outputPath)) {
      console.error("No existing analysis.json to validate")
      process.exit(1)
    }
    const existing = JSON.parse(readFileSync(outputPath, "utf-8")) as Record<string, unknown>
    const existingKeys = Object.keys(existing).filter((k) => k !== "$generated")
    const newKeys = Object.keys(analysis)

    const missing = newKeys.filter((k) => !existingKeys.includes(k))
    const extra = existingKeys.filter((k) => !newKeys.includes(k))

    if (missing.length > 0) {
      console.error(`Missing entries in existing analysis.json: ${missing.join(", ")}`)
    }
    if (extra.length > 0) {
      console.warn(`Extra entries in existing analysis.json: ${extra.join(", ")}`)
    }

    console.log(`Validation: ${existingKeys.length} existing entries, ${newKeys.length} expected`)
    console.log(`  ${missing.length} missing, ${extra.length} extra`)

    if (missing.length > 0) process.exit(1)
    console.log("Validation passed")
    process.exit(0)
  }

  if (isDryRun) {
    console.log(`Would generate ${entryCount} entries:`)
    console.log(`  ${terminalCount} terminal pages`)
    console.log(`  ${baselineCount} baseline pages`)
    console.log(`  ${compareCount} comparison pages`)
    console.log(`  ${categoryCount} category/standard pages`)
    console.log()
    for (const [key, entry] of Object.entries(analysis)) {
      // Strip HTML for preview
      const plain = entry.analysis.replace(/<[^>]+>/g, "")
      console.log(`  ${key}: ${plain.slice(0, 120)}...`)
    }
    process.exit(0)
  }

  // Write output
  writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n")
  console.log(`Generated ${outputPath}`)
  console.log(`  ${entryCount} entries (${terminalCount} terminals, ${baselineCount} baselines, ${compareCount} comparisons, ${categoryCount} categories/standards)`)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
