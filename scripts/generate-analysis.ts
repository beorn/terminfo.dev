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
  historical?: boolean
  year?: number
  manufacturer?: string
  cpu?: string
  significance?: string
  repo?: string
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
  const raw = loadJson<Record<string, FeatureMeta>>(join(contentDir, "features.json"), "feature metadata")
  delete (raw as Record<string, unknown>).$comment
  for (const [id, feat] of Object.entries(raw)) {
    assert(typeof feat.name === "string" && feat.name.length > 0, `Feature '${id}' missing name`)
  }
  return raw
}

function loadTerminals(): Record<string, TerminalMeta> {
  const raw = loadJson<Record<string, TerminalMeta>>(join(contentDir, "terminals.json"), "terminal metadata")
  for (const [id, term] of Object.entries(raw)) {
    assert(typeof term.label === "string", `Terminal '${id}' missing label`)
    assert(typeof term.slug === "string", `Terminal '${id}' missing slug`)
  }
  return raw
}

function loadCategories(): Record<string, CategoryMeta> {
  return loadJson<Record<string, CategoryMeta>>(join(contentDir, "categories.json"), "category metadata")
}

function loadStandards(): Record<string, StandardMeta> {
  return loadJson<Record<string, StandardMeta>>(join(contentDir, "standards.json"), "standard metadata")
}

function loadBaselines(): Record<string, BaselineMeta> {
  return loadJson<Record<string, BaselineMeta>>(join(contentDir, "baselines.json"), "baseline metadata")
}

interface GlossaryEntry {
  expansion: string
  description: string
  link?: string
}

function loadGlossary(): Record<string, GlossaryEntry> {
  const path = join(contentDir, "glossary.json")
  if (!existsSync(path)) return {}
  return loadJson<Record<string, GlossaryEntry>>(path, "glossary")
}

interface FrameworkMeta {
  label: string
  url: string
  repo: string
  language: string
  runtime: string
  description: string
  baseline: string
  body: string
}

function loadFrameworks(): Record<string, FrameworkMeta> {
  const path = join(contentDir, "frameworks.json")
  if (!existsSync(path)) return {}
  return loadJson<Record<string, FrameworkMeta>>(path, "framework metadata")
}

function loadAnnotations(): Record<string, { note: string; url?: string; result?: string }> {
  const path = join(contentDir, "annotations.json")
  if (!existsSync(path)) return {}
  return loadJson<Record<string, { note: string; url?: string; result?: string }>>(path, "annotations")
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
    assert(typeof raw.generated === "string", `Missing generated timestamp in ${file}`)

    // Validate all result values
    for (const [feature, result] of Object.entries(raw.results)) {
      assert(typeof result === "boolean", `Invalid result '${result}' for ${feature} in ${file} — expected boolean`)
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
  const resultMap = new Map<string, { results: Record<string, boolean>; version: string; type: "app" | "headless" }>()

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
        if (ann.result === "partial")
          results[feature] = true // partial counts as supported
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
  // Features in results should be in features.json — warn for missing
  // (probes may include features not yet documented in features.json)
  const undocumented = new Set<string>()
  for (const [termId, data] of resultMap) {
    for (const featureId of Object.keys(data.results)) {
      if (!features[featureId]) {
        undocumented.add(featureId)
      }
    }
  }
  if (undocumented.size > 0) {
    console.warn(
      `Warning: ${undocumented.size} feature(s) in probe results not in features.json: ${[...undocumented].join(", ")}`,
    )
  }

  // Warn (but don't throw) for terminals with no results (skip historical — they have no probes)
  for (const [termId, meta] of Object.entries(terminals)) {
    if (meta.historical) continue
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
      const noOtherSupports = otherTerminals.every(([, other]) => other.results[featureId] !== true)
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

  // Baseline compliance
  const failedBaselines = Object.entries(stats.baselineCompliance)
    .filter(([, bl]) => bl.pct < 100)
    .map(([name]) => baselines[name]?.label ?? name)
  const passedBaselines = Object.entries(stats.baselineCompliance)
    .filter(([, bl]) => bl.pct === 100)
    .map(([name]) => baselines[name]?.label ?? name)

  // Score summary + baseline in one sentence
  if (failedBaselines.length === 0 && passedBaselines.length > 0) {
    parts.push(
      `${stats.name} scores <strong>${stats.pct}%</strong> (${stats.yes}/${stats.total}) on the terminfo.dev feature matrix, achieving <strong>100%</strong> compliance on all four baselines (${passedBaselines.join(", ")})`,
    )
  } else if (failedBaselines.length > 0) {
    parts.push(
      `${stats.name} scores <strong>${stats.pct}%</strong> (${stats.yes}/${stats.total}) on the terminfo.dev feature matrix, with gaps in the ${failedBaselines.join(", ")} baseline${failedBaselines.length > 1 ? "s" : ""}`,
    )
  } else {
    parts.push(
      `${stats.name} scores <strong>${stats.pct}%</strong> (${stats.yes}/${stats.total}) on the terminfo.dev feature matrix`,
    )
  }

  // Ranking
  parts.push(`Ranks <strong>#${rank}</strong> of ${totalTerminals} tested terminals`)

  // Only include documented features (in features.json) in human-readable lists
  const documented = (ids: string[]) => ids.filter((id) => features[id])

  // Unique strengths
  const docUniqueSupported = documented(stats.uniquelySupported)
  if (docUniqueSupported.length > 0) {
    const names = docUniqueSupported.slice(0, 5).map((id) => featureName(features, id))
    parts.push(`Uniquely supports: ${names.join(", ")}`)
  }

  // Unique gaps
  const docUniqueMissing = documented(stats.uniquelyMissing)
  if (docUniqueMissing.length > 0 && docUniqueMissing.length <= 5) {
    const names = docUniqueMissing.map((id) => featureName(features, id))
    parts.push(`Uniquely missing (all other terminals pass): ${names.join(", ")}`)
  }

  // Missing features (if few)
  const docMissing = documented(stats.missingFeatures)
  if (docMissing.length > 0 && docMissing.length <= 8) {
    const names = docMissing.map((id) => featureName(features, id))
    parts.push(`Missing: ${names.join(", ")}`)
  } else if (docMissing.length > 8) {
    parts.push(`Missing <strong>${docMissing.length}</strong> features`)
  }

  return {
    analysis: `<p>${parts.join(". ")}.</p>`,
    date: new Date().toISOString().slice(0, 10),
    probeCount: stats.total,
    changes: null,
  }
}

function generateHistoricalAnalysis(termId: string, meta: TerminalMeta): AnalysisEntry {
  const parts: string[] = []

  parts.push(`<strong>${meta.label}</strong> (${meta.year}) was manufactured by ${meta.manufacturer ?? "unknown"}`)

  if (meta.significance) {
    parts.push(meta.significance)
  }

  parts.push("This is a historical reference entry — no automated probe data is available for this terminal")

  return {
    analysis: `<p>${parts.join(". ")}.</p>`,
    date: new Date().toISOString().slice(0, 10),
    probeCount: 0,
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

  const perfect = terminals.filter((s) => s.baselineCompliance[baselineName]?.pct === 100)
  const imperfect = terminals
    .filter(
      (s) => s.baselineCompliance[baselineName]?.pct !== undefined && s.baselineCompliance[baselineName].pct < 100,
    )
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
    const laggards = imperfect.slice(0, 3).map((s) => `${s.name} (${s.baselineCompliance[baselineName]?.pct ?? 0}%)`)
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
    const diff = statsA.pct - statsB.pct
    parts.push(`${statsA.name} leads by ${diff} percentage point${diff === 1 ? "" : "s"}`)
  } else if (statsB.pct > statsA.pct) {
    const diff = statsB.pct - statsA.pct
    parts.push(`${statsB.name} leads by ${diff} percentage point${diff === 1 ? "" : "s"}`)
  } else {
    parts.push("Both terminals are tied in overall score")
  }

  // Features A has that B doesn't (only documented features)
  const onlyA = Object.entries(statsA.results)
    .filter(([id, v]) => v === true && statsB.results[id] !== true && features[id])
    .map(([id]) => id)
  // Features B has that A doesn't (only documented features)
  const onlyB = Object.entries(statsB.results)
    .filter(([id, v]) => v === true && statsA.results[id] !== true && features[id])
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

  parts.push(`The <strong>${catMeta.label}</strong> category covers ${categoryFeatures.length} features`)

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
  const commonGaps = [...gapCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
  if (commonGaps.length > 0) {
    const gapNames = commonGaps.map(
      ([id, count]) => `${featureName(features, id)} (${count} terminal${count === 1 ? " fails" : "s fail"})`,
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
    `<strong>${stdMeta.label}</strong> defines ${taggedFeatures.length} feature${taggedFeatures.length === 1 ? "" : "s"} in the terminfo.dev matrix`,
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

// --- Feature analysis ---

function generateFeatureAnalysis(
  featureId: string,
  feature: FeatureMeta,
  allStats: Map<string, TerminalStats>,
  annotations: Record<string, { note: string; url?: string; result?: string }>,
): AnalysisEntry {
  const parts: string[] = []
  const category = featureId.split(".")[0]
  const slug = feature.slug ?? featureId.replaceAll(".", "-")

  // Count support across terminals that have this feature
  let supported = 0
  let unsupported = 0
  const unsupportedNames: string[] = []
  const notesMap: string[] = []

  for (const [termId, stats] of allStats) {
    if (!(featureId in stats.results)) continue
    if (stats.results[featureId]) {
      supported++
    } else {
      unsupported++
      unsupportedNames.push(stats.name)
      const ann = annotations[`${termId}:${featureId}`]
      if (ann?.note) notesMap.push(`${stats.name}: ${ann.note}`)
    }
  }

  const total = supported + unsupported
  if (total === 0) return { analysis: "", date: new Date().toISOString().slice(0, 10), changes: null }

  const pct = Math.round((supported / total) * 100)

  // Support summary
  if (supported === total) {
    parts.push(`Supported by <strong>all ${total}</strong> tested terminals — universal adoption`)
  } else if (supported === 0) {
    parts.push(`<strong>Not supported</strong> by any tested terminal`)
  } else {
    parts.push(`Supported by <strong>${supported}</strong> of <strong>${total}</strong> terminals (${pct}%)`)
  }

  // Who doesn't support it
  if (unsupportedNames.length > 0 && unsupportedNames.length <= 5) {
    parts.push(`Not supported by: ${unsupportedNames.join(", ")}`)
  }

  // Baseline context
  if (feature.baseline) {
    parts.push(
      `Part of the <strong>${feature.baseline === "core" ? "Core TUI" : feature.baseline === "modern" ? "Modern TUI" : feature.baseline === "rich" ? "Rich TUI" : "Unicode"}</strong> baseline`,
    )
  }

  // Notable annotations
  if (notesMap.length > 0 && notesMap.length <= 3) {
    parts.push(`Notes: ${notesMap.join("; ")}`)
  }

  return {
    analysis: `<p>${parts.join(". ")}.</p>`,
    date: new Date().toISOString().slice(0, 10),
    changes: null,
  }
}

// --- Framework analysis ---

function generateFrameworkAnalysis(
  fwId: string,
  fw: FrameworkMeta,
  allStats: Map<string, TerminalStats>,
  features: Record<string, FeatureMeta>,
  baselines: Record<string, BaselineMeta>,
  allFrameworks: Record<string, FrameworkMeta>,
): AnalysisEntry {
  const parts: string[] = []
  const terminals = [...allStats.values()]

  const baselineName = fw.baseline
  const baselineMeta = baselines[baselineName]
  const baselineLabel = baselineMeta?.label ?? baselineName

  // Count terminals that meet the required baseline (100% compliance)
  const compatible = terminals.filter((s) => s.baselineCompliance[baselineName]?.pct === 100)
  const incompatible = terminals.filter(
    (s) => s.baselineCompliance[baselineName]?.pct !== undefined && s.baselineCompliance[baselineName].pct < 100,
  )

  if (compatible.length === terminals.length) {
    parts.push(
      `${fw.label} requires the ${baselineLabel} baseline — <strong>all ${terminals.length}</strong> tested terminals are fully compatible`,
    )
  } else {
    parts.push(
      `${fw.label} requires the ${baselineLabel} baseline — <strong>${compatible.length}</strong> of ${terminals.length} tested terminals are fully compatible`,
    )
  }

  if (compatible.length > 0 && compatible.length <= 8) {
    const names = compatible.map((s) => s.name)
    parts.push(`Compatible: ${names.join(", ")}`)
  }

  if (incompatible.length > 0 && incompatible.length <= 5) {
    const laggards = incompatible.map((s) => `${s.name} (${s.baselineCompliance[baselineName]?.pct ?? 0}%)`)
    parts.push(`Partial compatibility: ${laggards.join(", ")}`)
  }

  // Compare with other frameworks in the same baseline tier
  const sameTier = Object.entries(allFrameworks).filter(([id, f]) => id !== fwId && f.baseline === baselineName)
  if (sameTier.length > 0) {
    const names = sameTier.map(([, f]) => f.label)
    parts.push(`Same baseline tier (${baselineLabel}) as ${names.join(", ")}`)
  }

  // Mention frameworks with different baselines for context
  const otherTiers = Object.entries(allFrameworks).filter(([id, f]) => id !== fwId && f.baseline !== baselineName)
  if (otherTiers.length > 0) {
    const grouped = new Map<string, string[]>()
    for (const [, f] of otherTiers) {
      const bl = baselines[f.baseline]?.label ?? f.baseline
      if (!grouped.has(bl)) grouped.set(bl, [])
      grouped.get(bl)!.push(f.label)
    }
    const descriptions = [...grouped.entries()].map(([bl, names]) => `${names.join(", ")} (${bl})`)
    parts.push(`Other frameworks target: ${descriptions.join("; ")}`)
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
  assert(openStrong === closeStrong, `${key}: Unclosed <strong> tags (${openStrong} open, ${closeStrong} close)`)

  // Check for unclosed p tags
  const openP = (html.match(/<p>/g) ?? []).length
  const closeP = (html.match(/<\/p>/g) ?? []).length
  assert(openP === closeP, `${key}: Unclosed <p> tags (${openP} open, ${closeP} close)`)
}

function validateNumbersInAnalysis(key: string, analysis: string, stats: TerminalStats | null): void {
  if (!stats) return

  // Extract percentage from analysis
  const pctMatch = analysis.match(/scores <strong>(\d+)%<\/strong>/)
  if (pctMatch) {
    const pctInText = Number.parseInt(pctMatch[1], 10)
    assert(pctInText === stats.pct, `${key}: Percentage in text (${pctInText}%) doesn't match computed (${stats.pct}%)`)
  }

  // Extract yes/total counts
  const countMatch = analysis.match(/\((\d+)\/(\d+)\)/)
  if (countMatch) {
    const yesInText = Number.parseInt(countMatch[1], 10)
    const totalInText = Number.parseInt(countMatch[2], 10)
    assert(yesInText === stats.yes, `${key}: Pass count in text (${yesInText}) doesn't match computed (${stats.yes})`)
    assert(
      totalInText === stats.total,
      `${key}: Total count in text (${totalInText}) doesn't match computed (${stats.total})`,
    )
  }
}

// --- Index page analyses ---

function generateStandardsIndexAnalysis(
  standards: Record<string, StandardMeta>,
  allStats: Map<string, TerminalStats>,
  features: Record<string, FeatureMeta>,
): AnalysisEntry {
  const parts: string[] = []
  const terminals = [...allStats.values()]

  // Count total standards and features
  const standardIds = Object.keys(standards)
  parts.push(
    `Terminfo.dev tracks <strong>${standardIds.length}</strong> terminal standards, from ECMA-48 (1976) to Kitty Extensions (2017)`,
  )

  // Find which standard has best/worst adoption
  const stdAdoption: { id: string; label: string; avgPct: number }[] = []
  for (const [stdId, stdMeta] of Object.entries(standards)) {
    const taggedFeatures = Object.entries(features)
      .filter(([, f]) => f.tags?.includes(stdId))
      .map(([id]) => id)
    if (taggedFeatures.length === 0) continue

    let totalPct = 0
    let count = 0
    for (const stats of terminals) {
      const relevant = taggedFeatures.filter((id) => id in stats.results)
      if (relevant.length === 0) continue
      const yes = relevant.filter((id) => stats.results[id] === true).length
      totalPct += Math.round((yes / relevant.length) * 100)
      count++
    }
    if (count > 0) {
      stdAdoption.push({ id: stdId, label: stdMeta.label, avgPct: Math.round(totalPct / count) })
    }
  }

  stdAdoption.sort((a, b) => b.avgPct - a.avgPct)

  if (stdAdoption.length >= 2) {
    const best = stdAdoption[0]
    const worst = stdAdoption[stdAdoption.length - 1]
    parts.push(
      `Highest average adoption: <strong>${best.label}</strong> at ${best.avgPct}%. Lowest: <strong>${worst.label}</strong> at ${worst.avgPct}%`,
    )
  }

  // Count terminals with 100% on foundational standards
  const foundational = ["ecma-48", "vt100"]
  for (const stdId of foundational) {
    const taggedFeatures = Object.entries(features)
      .filter(([, f]) => f.tags?.includes(stdId))
      .map(([id]) => id)
    if (taggedFeatures.length === 0) continue
    const perfect = terminals.filter((stats) => {
      const relevant = taggedFeatures.filter((id) => id in stats.results)
      const yes = relevant.filter((id) => stats.results[id] === true).length
      return relevant.length > 0 && yes === relevant.length
    })
    if (perfect.length > 0) {
      parts.push(
        `<strong>${perfect.length}</strong> of ${terminals.length} terminals achieve 100% ${standards[stdId]?.label ?? stdId} compliance`,
      )
    }
  }

  return {
    analysis: `<p>${parts.join(". ")}.</p>`,
    date: new Date().toISOString().slice(0, 10),
    changes: null,
  }
}

function generateFeaturesIndexAnalysis(
  categories: Record<string, CategoryMeta>,
  allStats: Map<string, TerminalStats>,
  features: Record<string, FeatureMeta>,
): AnalysisEntry {
  const parts: string[] = []
  const terminals = [...allStats.values()]

  // Total feature count
  const totalFeatures = Object.keys(features).length
  const totalCategories = Object.keys(categories).length
  parts.push(
    `The terminfo.dev matrix covers <strong>${totalFeatures}</strong> features across <strong>${totalCategories}</strong> categories`,
  )

  // Find best category (highest avg adoption) and worst
  const catAdoption: { id: string; label: string; avgPct: number }[] = []
  for (const [catId, catMeta] of Object.entries(categories)) {
    const catFeatures = Object.entries(features)
      .filter(([id]) => id.startsWith(catId + "."))
      .map(([id]) => id)
    if (catFeatures.length === 0) continue

    let totalPct = 0
    let count = 0
    for (const stats of terminals) {
      const relevant = catFeatures.filter((id) => id in stats.results)
      if (relevant.length === 0) continue
      const yes = relevant.filter((id) => stats.results[id] === true).length
      totalPct += Math.round((yes / relevant.length) * 100)
      count++
    }
    if (count > 0) {
      catAdoption.push({ id: catId, label: catMeta.label, avgPct: Math.round(totalPct / count) })
    }
  }

  catAdoption.sort((a, b) => b.avgPct - a.avgPct)

  if (catAdoption.length >= 2) {
    const best = catAdoption[0]
    const worst = catAdoption[catAdoption.length - 1]
    parts.push(
      `Best-supported category: <strong>${best.label}</strong> (${best.avgPct}% average). Most challenging: <strong>${worst.label}</strong> (${worst.avgPct}%)`,
    )
  }

  // Count universally supported features
  const universalCount = Object.keys(features).filter((fid) => {
    return terminals.every((stats) => {
      if (!(fid in stats.results)) return true // skip if not tested
      return stats.results[fid] === true
    })
  }).length

  if (universalCount > 0) {
    parts.push(`<strong>${universalCount}</strong> features are universally supported by all tested terminals`)
  }

  // Count features with zero support
  const zeroSupport = Object.keys(features).filter((fid) => {
    const tested = terminals.filter((stats) => fid in stats.results)
    if (tested.length === 0) return false
    return tested.every((stats) => stats.results[fid] !== true)
  }).length

  if (zeroSupport > 0) {
    parts.push(
      `<strong>${zeroSupport}</strong> feature${zeroSupport === 1 ? " has" : "s have"} zero support across all tested terminals`,
    )
  }

  return {
    analysis: `<p>${parts.join(". ")}.</p>`,
    date: new Date().toISOString().slice(0, 10),
    changes: null,
  }
}

// --- Auto-linking ---

/**
 * Post-process analysis HTML to auto-link mentions of terminals, features,
 * baselines, categories, standards, and glossary acronyms. Uses hover-link
 * styling (inherit color, brand on hover). Adds title tooltips for glossary
 * acronyms. Skips text already inside <a> tags or <strong> tags.
 */
function linkify(
  html: string,
  terminals: Record<string, TerminalMeta>,
  features: Record<string, FeatureMeta>,
  categories: Record<string, CategoryMeta>,
  standards: Record<string, StandardMeta>,
  baselines: Record<string, BaselineMeta>,
  glossary: Record<string, GlossaryEntry> = {},
): string {
  // Build lookup: display name → { href, original, title? } sorted longest-first to avoid partial matches
  const entities: Array<{ pattern: RegExp; href: string; title?: string }> = []

  // Terminals (by label)
  for (const [, t] of Object.entries(terminals)) {
    if (!t.label || !t.slug) continue
    entities.push({
      pattern: new RegExp(`\\b${escapeRegex(t.label)}\\b`, "g"),
      href: `/terminal/${t.slug}`,
    })
  }

  // Baselines (by label + " baseline" or just label when preceded by baseline context)
  for (const [id, b] of Object.entries(baselines)) {
    entities.push({
      pattern: new RegExp(`\\b${escapeRegex(b.label)}\\s+[Bb]aseline\\b`, "g"),
      href: `/baseline/${id}`,
    })
  }

  // Categories (by label)
  for (const [id, c] of Object.entries(categories)) {
    if (!c.label) continue
    entities.push({
      pattern: new RegExp(`\\b${escapeRegex(c.label)}\\b`, "g"),
      href: `/${id}`,
    })
  }

  // Standards (by label)
  for (const [id, s] of Object.entries(standards)) {
    if (!s.label) continue
    entities.push({
      pattern: new RegExp(`\\b${escapeRegex(s.label)}\\b`, "g"),
      href: `/${id}`,
    })
  }

  // Features (by name — only features with unique enough names)
  for (const [id, f] of Object.entries(features)) {
    if (!f.name || !f.slug) continue
    const category = id.split(".")[0]
    // Skip very short/generic names that would cause false positives
    if (f.name.length < 8) continue
    // Use (?!\w) instead of \b at end — feature names like "Mode Reporting (DECRPM)"
    // end with ) which is non-word, so \b wouldn't match after it
    entities.push({
      pattern: new RegExp(`\\b${escapeRegex(f.name)}(?!\\w)`, "g"),
      href: `/${category}/${f.slug}`,
    })
  }

  // External TUI frameworks mentioned in analysis
  const externalLinks = [
    { name: "Ink", href: "https://github.com/vadimdemedes/ink" },
    { name: "Textual", href: "https://textual.textualize.io" },
    { name: "Bubbletea", href: "https://github.com/charmbracelet/bubbletea" },
  ]
  for (const { name, href } of externalLinks) {
    entities.push({
      pattern: new RegExp(`\\b${escapeRegex(name)}\\b`, "g"),
      href,
    })
  }

  // Build glossary title lookup — maps matched text to expansion tooltip
  const glossaryTitles = new Map<string, string>()
  for (const [acronym, entry] of Object.entries(glossary)) {
    glossaryTitles.set(acronym, entry.expansion)
  }

  // Add title tooltips to existing entities when they match a glossary term
  for (const entity of entities) {
    if (entity.title) continue // already has a title
    // Extract the literal text from the regex source (strip \b and other anchors)
    const literal = entity.pattern.source.replace(/\\b|\\s\+.*|\(\?!\\w\)/g, "").replace(/\\\\/g, "\\")
    const title = glossaryTitles.get(literal)
    if (title) entity.title = title
  }

  // Add glossary-only acronyms that aren't already covered by other entities
  // (skip very short acronyms < 4 chars to avoid false positives like ED, EL, ICH)
  const coveredPatterns = new Set(entities.map((e) => e.pattern.source))
  for (const [acronym, entry] of Object.entries(glossary)) {
    if (!entry.link || acronym.length < 4) continue
    const source = `\\b${escapeRegex(acronym)}\\b`
    if (coveredPatterns.has(source)) continue
    entities.push({
      pattern: new RegExp(source, "g"),
      href: entry.link,
      title: entry.expansion,
    })
  }

  // Sort by pattern length descending (longer matches first)
  entities.sort((a, b) => b.pattern.source.length - a.pattern.source.length)

  // Process: split HTML into inside-tag and outside-tag segments
  // Only linkify text outside existing tags
  let result = ""
  let i = 0
  while (i < html.length) {
    if (html[i] === "<") {
      // Inside a tag — copy verbatim until closing >
      const end = html.indexOf(">", i)
      if (end === -1) {
        result += html.slice(i)
        break
      }
      result += html.slice(i, end + 1)

      // If this is an <a> tag, skip to </a>
      const tagContent = html.slice(i, end + 1)
      if (tagContent.startsWith("<a ") || tagContent === "<a>") {
        const closeA = html.indexOf("</a>", end)
        if (closeA !== -1) {
          result += html.slice(end + 1, closeA + 4)
          i = closeA + 4
          continue
        }
      }

      i = end + 1
    } else {
      // Text node — find next tag
      const nextTag = html.indexOf("<", i)
      const text = nextTag === -1 ? html.slice(i) : html.slice(i, nextTag)

      // Collect all non-overlapping matches in a single pass, then apply.
      // This avoids sequential .replace() re-processing its own HTML output
      // (which would corrupt title attributes by matching words inside them).
      const matches: Array<{ start: number; end: number; href: string; title?: string; text: string }> = []
      for (const entity of entities) {
        entity.pattern.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = entity.pattern.exec(text)) !== null) {
          const start = m.index
          const end = start + m[0].length
          // Skip if overlapping with an already-collected match
          if (matches.some((prev) => start < prev.end && end > prev.start)) continue
          matches.push({ start, end, href: entity.href, title: entity.title, text: m[0] })
        }
      }
      // Sort by position and build result
      matches.sort((a, b) => a.start - b.start)
      let linked = ""
      let pos = 0
      for (const m of matches) {
        linked += text.slice(pos, m.start)
        const titleAttr = m.title ? ` title="${escapeHtmlAttr(m.title)}"` : ""
        linked += `<a href="${m.href}" class="hover-link"${titleAttr}>${m.text}</a>`
        pos = m.end
      }
      linked += text.slice(pos)

      result += linked
      i = nextTag === -1 ? html.length : nextTag
    }
  }

  return result
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// --- Main ---

function loadAllData() {
  const features = loadFeatures()
  const terminals = loadTerminals()
  const categories = loadCategories()
  const standards = loadStandards()
  const baselines = loadBaselines()
  const annotations = loadAnnotations()
  const frameworks = loadFrameworks()
  const glossary = loadGlossary()

  const appResults = loadProbeDir(probesAppsDir)
  const libResults = loadProbeDir(probesLibsDir)

  const resultMap = buildTerminalResultMap(terminals, appResults, libResults, annotations)

  // Cross-validate
  crossValidate(features, terminals, resultMap)

  return { features, terminals, categories, standards, baselines, annotations, frameworks, glossary, resultMap }
}

function generateAnalysis(): Record<string, AnalysisEntry> {
  const { features, terminals, categories, standards, baselines, annotations, frameworks, glossary, resultMap } =
    loadAllData()
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

  // 1b. Historical terminal pages (no probe data)
  for (const [termId, meta] of Object.entries(terminals)) {
    if (!meta.historical) continue
    const slug = meta.slug
    if (slugSeen.has(slug)) continue
    slugSeen.add(slug)

    const key = `terminal/${slug}`
    const entry = generateHistoricalAnalysis(termId, meta)
    validateHtml(entry.analysis, key)
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

    const [orderedA, orderedB] = statsA.slug === slugs[0] ? [statsA, statsB] : [statsB, statsA]
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

  // 6. Feature pages
  for (const [featureId, featureMeta] of Object.entries(features)) {
    const category = featureId.split(".")[0]
    const slug = featureMeta.slug ?? featureId.replaceAll(".", "-")
    const key = `${category}/${slug}`
    const entry = generateFeatureAnalysis(featureId, featureMeta, allStats, annotations)
    if (entry.analysis) {
      validateHtml(entry.analysis, key)
      output[key] = entry
    }
  }

  // 7. Framework pages
  for (const [fwId, fw] of Object.entries(frameworks)) {
    const key = `framework/${fwId}`
    const entry = generateFrameworkAnalysis(fwId, fw, allStats, features, baselines, frameworks)
    if (entry.analysis) {
      validateHtml(entry.analysis, key)
      output[key] = entry
    }
  }

  // 8. Standards index page
  {
    const entry = generateStandardsIndexAnalysis(standards, allStats, features)
    validateHtml(entry.analysis, "standards-index")
    output["standards-index"] = entry
  }

  // 9. Features index page
  {
    const entry = generateFeaturesIndexAnalysis(categories, allStats, features)
    validateHtml(entry.analysis, "features-index")
    output["features-index"] = entry
  }

  // Post-process: auto-link entity mentions in all analysis text
  for (const [key, entry] of Object.entries(output)) {
    entry.analysis = linkify(entry.analysis, terminals, features, categories, standards, baselines, glossary)
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
  const frameworkCount = Object.keys(analysis).filter((k) => k.startsWith("framework/")).length
  const categoryCount = Object.keys(analysis).filter(
    (k) =>
      !k.startsWith("terminal/") &&
      !k.startsWith("baseline/") &&
      !k.startsWith("compare/") &&
      !k.startsWith("framework/") &&
      !k.includes("/"),
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
    console.log(`  ${frameworkCount} framework pages`)
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
  console.log(
    `  ${entryCount} entries (${terminalCount} terminals, ${baselineCount} baselines, ${compareCount} comparisons, ${frameworkCount} frameworks, ${categoryCount} categories/standards)`,
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
