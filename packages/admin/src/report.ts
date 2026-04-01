/**
 * Report command — show saved probe results from both libs and apps.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { fromPerBackendFiles, type CensusData } from "../parse.ts"
import { renderReport } from "../report.tsx"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..", "..", "..")
const LIBS_DIR = join(ROOT, "content", "probes-libs")
const APPS_DIR = join(ROOT, "content", "probes-apps")

function loadResults(dir: string): CensusData | null {
  if (!existsSync(dir)) return null

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"))
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
      const data = JSON.parse(readFileSync(join(dir, file), "utf-8")) as any
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

export async function handleReport(): Promise<void> {
  const libsData = loadResults(LIBS_DIR)
  const appsData = loadResults(APPS_DIR)

  if (!libsData && !appsData) {
    throw new Error(
      "No saved results. Run probes first:\n" +
        "  terminfo probe termless --all   # headless backends\n" +
        "  terminfo probe app --all         # macOS apps\n" +
        "  terminfo probe server --all      # running daemons",
    )
  }

  if (libsData) {
    console.log("\n--- Library Backends ---")
    const output = await renderReport(libsData)
    console.log(output)
    printNotes(libsData)
  }

  if (appsData) {
    log.info?.("\n--- Terminal Apps ---")
    const colWidth = Math.max(6, ...appsData.backendNames.map((n) => n.length)) + 2
    const featureWidth = 30

    // Table output for piping
    console.log(`  ${"Feature".padEnd(featureWidth)}${appsData.backendNames.map((n) => n.padStart(colWidth)).join("")}`)
    console.log(`  ${"-".repeat(featureWidth)}${appsData.backendNames.map(() => "-".repeat(colWidth)).join("")}`)

    for (const [cat, ids] of appsData.categories) {
      console.log(`\n  ${cat}:`)
      for (const id of ids) {
        const suffix = id.slice(cat.length + 1)
        const cells = appsData.backendNames.map((name) => {
          const pass = appsData.results.get(name)?.get(id) ?? false
          return (pass ? "  Y" : "  -").padStart(colWidth)
        })
        console.log(`    ${suffix.padEnd(featureWidth - 2)}${cells.join("")}`)
      }
    }

    console.log(
      `\n  ${"TOTAL".padEnd(featureWidth)}${appsData.backendNames
        .map((name) => {
          const features = appsData.results.get(name)!
          let yes = 0
          for (const r of features.values()) if (r) yes++
          const pct = Math.round((yes / (features.size || 1)) * 100)
          return `${yes}/${features.size} ${pct}%`.padStart(colWidth)
        })
        .join("")}`,
    )
    console.log("")
    printNotes(appsData)
  }
}
