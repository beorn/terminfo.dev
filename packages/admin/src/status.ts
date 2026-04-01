/**
 * Status command — show config, cache, backends, and results overview.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { backends as allBackendNames, isReady, entry } from "@termless/core"
import { probeHash, loadVersionsCatalog } from "../versions.ts"
import { fromPerBackendFiles, type CensusData } from "../parse.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..", "..", "..")
const LIBS_DIR = join(ROOT, "content", "probes-libs")
const APPS_DIR = join(ROOT, "content", "probes-apps")
const PROBES_DIR = join(ROOT, "packages", "probes")

function loadSavedResults(dir: string): CensusData | null {
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

function isCacheValid(dir: string, currentHash: string): boolean {
  if (!existsSync(dir)) return false
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"))
  if (files.length === 0) return false
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(dir, file), "utf-8")) as any
      if (data.probeHash !== currentHash) return false
    } catch {
      return false
    }
  }
  return true
}

function shortPath(p: string): string {
  const cwd = process.cwd()
  const home = process.env.HOME ?? ""
  if (p.startsWith(cwd)) return p.slice(cwd.length + 1)
  if (home && p.startsWith(home)) return "~" + p.slice(home.length)
  return p
}

export async function handleStatus(): Promise<void> {
  const installed = allBackendNames().filter(isReady)
  const available = allBackendNames().filter((n) => !isReady(n))
  const hash = probeHash()

  const probeFiles = existsSync(PROBES_DIR)
    ? readdirSync(PROBES_DIR)
        .filter((f) => f.endsWith(".probe.ts"))
        .sort()
    : []

  const libFiles = existsSync(LIBS_DIR) ? readdirSync(LIBS_DIR).filter((f) => f.endsWith(".json")) : []
  const appFiles = existsSync(APPS_DIR) ? readdirSync(APPS_DIR).filter((f) => f.endsWith(".json")) : []

  let catalog: ReturnType<typeof loadVersionsCatalog> | null = null
  try {
    catalog = loadVersionsCatalog()
  } catch {}

  const libData = loadSavedResults(LIBS_DIR)
  const appData = loadSavedResults(APPS_DIR)

  console.log("\nterminfo.dev status\n")
  console.log(`  Probe hash:       ${hash}`)
  console.log(`  Probe files:      ${probeFiles.length} (${probeFiles.join(", ")})`)

  if (libData) {
    console.log(`  Lib features:     ${libData.featureIds.length}`)
    console.log(`  Lib backends:     ${libData.backendNames.length} (${libData.backendNames.join(", ")})`)
  }

  if (appData) {
    console.log(`  App terminals:    ${appData.backendNames.length} (${appData.backendNames.join(", ")})`)
  }

  console.log("\n  Termless backends:")
  for (const name of [...installed, ...available]) {
    const e = entry(name)
    const ready = isReady(name)
    const upstream = e?.upstream ? `${e.upstream}${e.version ? ` ${e.version}` : ""}` : ""
    console.log(`    ${ready ? "+" : "-"} ${`${name} (${e?.type ?? "?"})`.padEnd(26)} ${upstream}`)
  }

  console.log("\n  Results:")
  console.log(`    Libs:  ${libFiles.length} files in ${shortPath(LIBS_DIR)}/`)
  console.log(`    Apps:  ${appFiles.length} files in ${shortPath(APPS_DIR)}/`)
  console.log(`    Cache: ${isCacheValid(LIBS_DIR, hash) ? "valid" : "stale (re-run needed)"}`)

  if (catalog) {
    console.log("\n  Versions (from versions.json):")
    for (const [name, config] of Object.entries(catalog.backends)) {
      console.log(`    ${name.padEnd(16)} ${config.versions.join(", ")}`)
    }
  }

  if (libData) {
    console.log("\n  Categories:")
    for (const [cat, ids] of libData.categories) {
      console.log(`    ${cat.padEnd(16)} ${ids.length} features`)
    }
  }

  // List running daemons
  try {
    const { listDaemons } = await import("../../terminfo.dev/src/serve.ts")
    const daemons = listDaemons()
    if (daemons.length > 0) {
      console.log("\n  Running daemons:")
      for (const d of daemons) {
        const label = `${d.terminal}${d.terminalVersion ? ` ${d.terminalVersion}` : ""}`
        console.log(`    ${label.padEnd(25)} port ${d.port}`)
      }
    }
  } catch {}

  console.log("")
}
