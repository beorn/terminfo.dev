/**
 * Status command — show installed backends, reviewed current results, and saved archives.
 */

import { existsSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { backends as allBackendNames, isReady, entry } from "@termless/core"
import { probeHash, loadVersionsCatalog } from "../versions.ts"
import { loadCurrentResults } from "../../../docs/data/current-results.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..", "..", "..")
const LIBS_DIR = join(ROOT, "content", "probes-libs")
const APPS_DIR = join(ROOT, "content", "probes-apps")
const MUX_DIR = join(ROOT, "content", "probes-mux")
const PROBES_DIR = join(ROOT, "packages", "probes")

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
  const muxFiles = existsSync(MUX_DIR) ? readdirSync(MUX_DIR).filter((f) => f.endsWith(".json")) : []
  let catalog: ReturnType<typeof loadVersionsCatalog>
  try {
    catalog = loadVersionsCatalog()
  } catch (cause) {
    throw new Error(`Cannot load versions catalog ${join(ROOT, "versions.json")}`, { cause })
  }
  const projection = loadCurrentResults(join(ROOT, "content")).projection
  const current = Object.entries(projection.current).sort(([left], [right]) => left.localeCompare(right))
  const headless = current.filter(([, run]) => run.target.kind === "headless")
  const apps = current.filter(([, run]) => run.target.kind === "app")
  const muxes = current.filter(([, run]) => run.target.kind === "mux")
  const headlessFeatures = new Set(headless.flatMap(([, run]) => Object.keys(run.cells)))

  console.log("\nterminfo.dev status\n")
  console.log(`  Probe hash:       ${hash}`)
  console.log(`  Probe files:      ${probeFiles.length} (${probeFiles.join(", ")})`)

  console.log("\n  Termless backends:")
  for (const name of [...installed, ...available]) {
    const e = entry(name)
    const ready = isReady(name)
    const upstream = e?.upstream ? `${e.upstream}${e.version ? ` ${e.version}` : ""}` : ""
    console.log(`    ${ready ? "+" : "-"} ${`${name} (${e?.type ?? "?"})`.padEnd(26)} ${upstream}`)
  }

  console.log("\n  Current reviewed results:")
  console.log(`    Contexts: ${current.length} (${headless.length} headless, ${apps.length} app, ${muxes.length} mux)`)
  console.log(`    Headless observed feature IDs: ${headlessFeatures.size}`)
  for (const [key, run] of current) {
    const cells = Object.values(run.cells)
    const inconclusive = cells.filter((cell) => cell.outcome === "inconclusive").length
    const errors = cells.filter((cell) => cell.outcome === "error").length
    console.log(
      `    ${key} ${run.target.version} (${run.runId}): ${run.counts.tested} tested, ${run.counts.notTested} not tested, ${run.counts.conclusive} conclusive (${run.counts.supported} supported, ${run.counts.unsupported} unsupported), ${inconclusive} inconclusive, ${errors} error`,
    )
  }
  console.log(`    Excluded archived runs: ${projection.exclusions.length}`)

  console.log("\n  Saved archive files:")
  console.log(`    Archive libs: ${libFiles.length} files in ${shortPath(LIBS_DIR)}/`)
  console.log(`    Archive apps: ${appFiles.length} files in ${shortPath(APPS_DIR)}/`)
  console.log(`    Archive mux:  ${muxFiles.length} files in ${shortPath(MUX_DIR)}/`)

  console.log("\n  Versions (from versions.json):")
  for (const [name, config] of Object.entries(catalog.backends)) {
    console.log(`    ${name.padEnd(16)} ${config.versions.join(", ")}`)
  }

  // List running daemons
  const { listDaemons } = await import("terminfo.dev/src/serve.ts")
  const daemons = listDaemons()
  if (daemons.length > 0) {
    console.log("\n  Running daemons:")
    for (const d of daemons) {
      const label = `${d.terminal}${d.terminalVersion ? ` ${d.terminalVersion}` : ""}`
      console.log(`    ${label.padEnd(25)} port ${d.port}`)
    }
  }

  console.log("")
}
