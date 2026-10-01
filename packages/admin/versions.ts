/** Probe hashing and the legacy version catalog metadata; no version installation. */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, "..", "..")
const PROBES_DIR = join(REPO_ROOT, "packages", "probes")
const VERSIONS_PATH = join(REPO_ROOT, "versions.json")

interface VersionsCatalog {
  backends: Record<string, { upstream: string; versions: string[] }>
}

export function probeHash(): string {
  const hash = createHash("md5")

  // Hash all probe files
  const probeFiles = readdirSync(PROBES_DIR)
    .filter((f) => f.endsWith(".probe.ts"))
    .sort()
  for (const f of probeFiles) {
    hash.update(readFileSync(join(PROBES_DIR, f)))
  }

  // Hash the backends infrastructure (changes here affect results)
  const backendsFile = join(PROBES_DIR, "setup.ts")
  if (existsSync(backendsFile)) {
    hash.update(readFileSync(backendsFile))
  }

  return hash.digest("hex").slice(0, 12)
}

// ── Version catalog ──

export function loadVersionsCatalog(): VersionsCatalog {
  if (!existsSync(VERSIONS_PATH)) {
    throw new Error(`Versions catalog not found: ${VERSIONS_PATH}`)
  }
  return JSON.parse(readFileSync(VERSIONS_PATH, "utf-8")) as VersionsCatalog
}
