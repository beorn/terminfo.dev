/**
 * Headless library probes — run Vitest probes against Termless backends.
 *
 * Reuses logic from the old probes CLI (packages/cli/index.ts).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseVitestJson, fromPerBackendFiles, type CensusData } from "../parse.ts"
import { manifest, backends as allBackendNames, isReady, entry } from "@termless/core"
import { renderReport } from "../report.tsx"
import { runVersionedProbes, probeHash, loadVersionsCatalog } from "../versions.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..", "..", "..")
const DEFAULT_RESULTS_DIR = join(ROOT, "content", "probes-libs")

// ── Selector parsing ──

interface BackendSelector {
  backend: string
  version: string | null // null = latest, "*" = all from versions.json
}

function parseSelector(arg: string): BackendSelector[] {
  const slashIdx = arg.indexOf("/")
  let name: string
  let version: string | null = null

  if (slashIdx >= 0) {
    name = arg.slice(0, slashIdx)
    version = arg.slice(slashIdx + 1) || null
  } else {
    name = arg
  }

  // Resolve upstream URI to backend name
  if (name.includes(":")) {
    const m = manifest()
    const match = Object.entries(m.backends).find(([_, e]) => e.upstream === name)
    if (!match) {
      console.error(`No backend found for upstream: ${name}`)
      process.exit(1)
    }
    name = match[0]
  }

  const all = allBackendNames()
  if (!all.includes(name)) {
    console.error(`Unknown backend: ${name}\nAvailable: ${all.join(", ")}`)
    process.exit(1)
  }

  if (version === "*") {
    try {
      const catalog = loadVersionsCatalog()
      const config = catalog.backends[name]
      if (!config) {
        console.error(`No version history for ${name} in versions.json`)
        process.exit(1)
      }
      return config.versions.map((v) => ({ backend: name, version: v }))
    } catch {
      console.error(`Could not load versions.json`)
      process.exit(1)
    }
  }

  return [{ backend: name, version }]
}

// ── Helpers ──

function loadSavedResults(resultsDir: string): CensusData | null {
  if (!existsSync(resultsDir)) return null

  const files = readdirSync(resultsDir).filter((f) => f.endsWith(".json"))
  if (files.length === 0) return null

  const perBackend: Array<{
    backend: string
    version: string
    generated: string
    results: Record<string, boolean>
    notes?: Record<string, string>
  }> = []

  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(resultsDir, file), "utf-8")) as any
      if (data.backend && data.results) perBackend.push(data as (typeof perBackend)[0])
    } catch {}
  }

  if (perBackend.length === 0) return null

  const latest = new Map<string, (typeof perBackend)[0]>()
  for (const e of perBackend) {
    const existing = latest.get(e.backend)
    if (!existing || e.generated > existing.generated) latest.set(e.backend, e)
  }

  return fromPerBackendFiles([...latest.values()])
}

function filterData(data: CensusData, names: Set<string>): CensusData {
  const backendNames = data.backendNames.filter((n) => names.has(n))
  const results = new Map<string, Map<string, boolean>>()
  const notes = new Map<string, Map<string, string>>()
  for (const name of backendNames) {
    results.set(name, data.results.get(name)!)
    notes.set(name, data.notes.get(name) ?? new Map())
  }
  return { backendNames, featureIds: data.featureIds, results, notes, categories: data.categories }
}

function isCacheValid(resultsDir: string, currentHash: string): boolean {
  if (!existsSync(resultsDir)) return false
  const files = readdirSync(resultsDir).filter((f) => f.endsWith(".json"))
  if (files.length === 0) return false
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(resultsDir, file), "utf-8")) as any
      if (data.probeHash !== currentHash) return false
    } catch {
      return false
    }
  }
  return true
}

function saveResults(data: CensusData, resultsDir: string, hash?: string): string[] {
  mkdirSync(resultsDir, { recursive: true })

  const generated = new Date().toISOString()
  const writtenFiles: string[] = []
  const m = manifest()

  for (const name of data.backendNames) {
    const features = data.results.get(name)!
    const backendNotes = data.notes.get(name)
    const version = m.backends[name]?.version ?? "latest"
    const filepath = join(resultsDir, `${name}-${version}.json`)

    writeFileSync(
      filepath,
      JSON.stringify(
        {
          backend: name,
          version,
          generated,
          ...(hash ? { probeHash: hash } : {}),
          results: Object.fromEntries(features),
          ...(backendNotes && backendNotes.size > 0 ? { notes: Object.fromEntries(backendNotes) } : {}),
        },
        null,
        2,
      ),
    )
    writtenFiles.push(filepath)
  }

  return writtenFiles
}

function findUnannotatedFailures(data: CensusData): Array<{ backend: string; feature: string; autoNote: string }> {
  const annotationsPath = join(ROOT, "content", "annotations.json")
  let annotations: Record<string, { note: string }> = {}
  try {
    annotations = JSON.parse(readFileSync(annotationsPath, "utf-8")) as Record<string, { note: string }>
  } catch {}

  const missing: Array<{ backend: string; feature: string; autoNote: string }> = []

  for (const name of data.backendNames) {
    const results = data.results.get(name)
    const notes = data.notes.get(name)
    if (!results) continue

    for (const [feature, pass] of results) {
      if (pass) continue
      const key = `${name}:${feature}`
      if (annotations[key]) continue
      const autoNote = notes?.get(feature) ?? "not supported"
      missing.push({ backend: name, feature, autoNote })
    }
  }

  return missing
}

function printNotes(data: CensusData) {
  let hasNotes = false
  for (const name of data.backendNames) {
    const backendNotes = data.notes.get(name)
    if (!backendNotes || backendNotes.size === 0) continue
    if (!hasNotes) {
      console.log("\nNotes:\n")
      hasNotes = true
    }
    console.log(`  ${name}:`)
    for (const [feature, note] of backendNotes) {
      console.log(`    ${feature.padEnd(28)} ${note}`)
    }
  }
  if (hasNotes) console.log("")
}

// ── Main ──

export async function runTermlessProbes(selectors: string[], opts: { force?: boolean }): Promise<void> {
  const resultsDir = DEFAULT_RESULTS_DIR

  // If no selectors and no --all, list available backends
  if (selectors.length === 0 && !opts.force) {
    const installed = allBackendNames().filter(isReady)
    const available = allBackendNames().filter((n) => !isReady(n))

    // Check if --all was used (selectors is empty array from --all flag)
    // The caller passes [] for --all
    // Actually, --all comes in as opts — but we need to distinguish
    // "terminfo probe termless" (bare) from "terminfo probe termless --all"
    // The parent passes [] for --all. For bare, selectors is also [].
    // We differentiate by checking if the function was called from --all context.
    // Since this function is called with [] for --all, we proceed to run all.
    // For bare "terminfo probe termless", the parent would not call this at all
    // (it would show the help). But our current code calls with [].

    // Run all installed backends
    console.log(`\nRunning termless probes on ${installed.length} backends...`)
    if (available.length > 0) {
      console.log(`(${available.length} backends not installed: ${available.join(", ")})\n`)
    }
  }

  const parsed = selectors.length > 0 ? selectors.flatMap(parseSelector) : null
  const versionedSelectors = parsed?.filter((s) => s.version !== null) ?? []
  const latestSelectors = parsed?.filter((s) => s.version === null) ?? []
  const hash = probeHash()

  // Run latest probes
  let latestData: CensusData | null = null

  if (!parsed || latestSelectors.length > 0) {
    if (!opts.force && !parsed) {
      const cached = loadSavedResults(resultsDir)
      if (cached && isCacheValid(resultsDir, hash)) {
        console.log(`\nResults up to date (probe hash: ${hash}). Use --force to re-run.\n`)
        latestData = cached
      }
    }

    if (!latestData) {
      console.log(`\nRunning termless probes (hash: ${hash})...\n`)

      const proc = Bun.spawn(
        ["bun", "vitest", "run", "--config", "packages/probes/vitest.config.ts", "--reporter", "json"],
        {
          cwd: ROOT,
          stdout: "pipe",
          stderr: "pipe",
        },
      )

      const stdout = await new Response(proc.stdout).text()
      await proc.exited

      if (!stdout.trim()) {
        console.error("Error: vitest produced no JSON output")
        process.exit(1)
      }

      try {
        latestData = parseVitestJson(JSON.parse(stdout))
      } catch {
        console.error("Error: failed to parse vitest JSON output")
        process.exit(1)
      }

      if (latestSelectors.length > 0) {
        const names = new Set(latestSelectors.map((s) => s.backend))
        latestData = filterData(latestData, names)
      }

      saveResults(latestData, resultsDir, hash)
    }
  }

  // Run versioned probes
  if (versionedSelectors.length > 0) {
    console.log(
      `\nRunning versioned probes: ${versionedSelectors.map((s) => `${s.backend}/${s.version}`).join(", ")}\n`,
    )

    const results = await runVersionedProbes({
      force: opts.force,
      backends: [...new Set(versionedSelectors.map((s) => s.backend))],
      resultsDir,
    })

    for (const r of results) {
      if (r.skipped) console.log(`  ${r.backend}@${r.version} — cached`)
      else if (r.error) console.log(`  ${r.backend}@${r.version} — error: ${r.error}`)
      else console.log(`  ${r.backend}@${r.version} — ${r.passCount}/${r.featureCount}`)
    }
  }

  // Show report
  const allData = loadSavedResults(resultsDir)
  if (allData) {
    const output = await renderReport(allData)
    console.log(output)
    printNotes(allData)

    // Validate: every failure must have an annotation
    const missing = findUnannotatedFailures(allData)
    if (missing.length > 0) {
      console.error(`\n${missing.length} failure(s) without annotations in annotations.json:\n`)
      for (const m of missing) {
        console.error(`  "${m.backend}:${m.feature}": { "note": "${m.autoNote}" }`)
      }
      console.error(`\nAdd these to annotations.json with human-readable explanations.\n`)
      process.exitCode = 1
    }
  }
}
