/**
 * Versioned probes — run probes against older upstream versions of backends.
 *
 * For each backend+version pair in versions.json:
 * 1. Install the upstream package at that version to a cache directory
 * 2. Generate a vitest config with `resolve.alias` to redirect the upstream import
 * 3. Run vitest probes in a subprocess, parsing JSON output
 * 4. Save results as {backend}-{version}.json
 * 5. Skip if result already exists and probe files haven't changed (hash match)
 *
 * Uses Vite's `resolve.alias` rather than NODE_PATH because Bun's module
 * resolution ignores NODE_PATH when the package is already available in
 * the workspace node_modules. The alias approach intercepts at the bundler
 * level before Bun's resolver runs.
 *
 * Only JS/WASM backends are supported — native backends require building
 * each version from source (deferred).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync, execSync } from "node:child_process"
import { createLogger } from "loggily"
import { parseVitestJson } from "./parse.ts"
import { ensureCachedVersion } from "@termless/core"
import { ALL_PROBES, type ProbeSuiteManifest } from "@terminfo/probe-defs"

const log = createLogger("probes")

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, "..", "..")
const RESULTS_DIR = join(REPO_ROOT, "content", "probes-libs")
const PROBES_DIR = join(REPO_ROOT, "packages", "probes")
const PROBE_DEFS_DIR = join(REPO_ROOT, "packages", "probe-defs", "src")
const ADAPTER_PACKAGE_PATH = "packages/terminfo.dev/package.json"
// Include the collector's executed local imports: ownership and identity affect the observation too.
const ADAPTER_SOURCE_PATHS = [
  "packages/terminfo.dev/src/probes/unified.ts",
  "packages/terminfo.dev/src/tty.ts",
  "packages/terminfo.dev/src/linux-clipboard.ts",
  "packages/terminfo.dev/src/owned-terminal.ts",
  "packages/terminfo.dev/src/linux-capture.ts",
  "packages/terminfo.dev/src/serve.ts",
  "packages/terminfo.dev/src/detect.ts",
  "packages/terminfo.dev/src/identity-guard.ts",
]
const VERSIONS_PATH = join(REPO_ROOT, "versions.json")
// Cache dir handled by ensureCachedVersion() in backends.ts

// ── Types ──

interface VersionsCatalog {
  backends: Record<
    string,
    {
      upstream: string
      versions: string[]
    }
  >
}

interface VersionRunResult {
  backend: string
  version: string
  skipped: boolean
  featureCount?: number
  passCount?: number
  error?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ── Probe hash ──

export interface ProbeSuiteSnapshot {
  probeHash: string
  adapterVersion: string
  probes: ProbeSuiteManifest["probes"]
  /** Paths whose committed bytes define this suite declaration. */
  sourcePaths: string[]
}

/** Compute suite identity and applicable membership from the same live inputs. */
export function probeSuiteSnapshot(): ProbeSuiteSnapshot {
  const hash = createHash("md5")

  const probeFiles = readdirSync(PROBES_DIR)
    .filter((f) => f.endsWith(".probe.ts"))
    .sort()
  const definitionFiles = readdirSync(PROBE_DEFS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".spec.ts"))
    .sort()
  const sourcePaths = [
    ...probeFiles.map((f) => `packages/probes/${f}`),
    ...definitionFiles.map((f) => `packages/probe-defs/src/${f}`),
    "packages/probes/setup.ts",
    "packages/probes/vitest.config.ts",
    ...ADAPTER_SOURCE_PATHS,
    ADAPTER_PACKAGE_PATH,
  ]
  for (const relativePath of sourcePaths) {
    if (relativePath === ADAPTER_PACKAGE_PATH) continue
    hash.update(relativePath)
    hash.update(readFileSync(join(REPO_ROOT, relativePath)))
  }

  const adapterPackage: unknown = JSON.parse(readFileSync(join(REPO_ROOT, ADAPTER_PACKAGE_PATH), "utf8"))
  if (!isRecord(adapterPackage) || typeof adapterPackage.version !== "string" || !adapterPackage.version) {
    throw new Error(`Invalid adapter version in ${ADAPTER_PACKAGE_PATH}`)
  }
  const adapterVersion = adapterPackage.version
  hash.update("adapterVersion")
  hash.update(adapterVersion)

  const ids = ALL_PROBES.map((probe) => probe.id)
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate probe IDs in ALL_PROBES")
  const app = ALL_PROBES.filter((probe) => probe.term !== null)
    .map((probe) => probe.id)
    .sort()
  const headless = ALL_PROBES.filter((probe) => probe.termless !== null)
    .map((probe) => probe.id)
    .sort()
  return {
    probeHash: hash.digest("hex").slice(0, 12),
    adapterVersion,
    probes: { app, headless, mux: [...app] },
    sourcePaths,
  }
}

/** Executable suite identity, independent of the backend that runs it. */
export function probeHash(): string {
  return probeSuiteSnapshot().probeHash
}

/** Metadata for a source-tree daemon; the daemon rechecks the revision and suite. */
export function sourceSuiteEnvironment(): { TERMINFO_PROBE_HASH: string; TERMINFO_SOURCE_REVISION: string } {
  return {
    TERMINFO_PROBE_HASH: probeHash(),
    TERMINFO_SOURCE_REVISION: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim(),
  }
}

// ── Version catalog ──

export function loadVersionsCatalog(): VersionsCatalog {
  if (!existsSync(VERSIONS_PATH)) {
    throw new Error(`Versions catalog not found: ${VERSIONS_PATH}`)
  }
  return JSON.parse(readFileSync(VERSIONS_PATH, "utf-8")) as VersionsCatalog
}

// ── Cache management ──

// Version installation delegated to ensureCachedVersion() from backends.ts

/**
 * Check if a cached result is still valid (probe hash matches).
 */
function isCacheValid(resultPath: string, currentHash: string): boolean {
  if (!existsSync(resultPath)) return false

  try {
    const data: unknown = JSON.parse(readFileSync(resultPath, "utf-8"))
    return isRecord(data) && data.probeHash === currentHash
  } catch {
    return false
  }
}

/**
 * Resolve the path to the upstream package entry point within a cache dir.
 * For scoped packages like @xterm/headless, walk node_modules/@xterm/headless.
 */
function resolveUpstreamPath(cacheDir: string, upstream: string): string {
  const nodeModules = join(cacheDir, "node_modules")
  const pkgDir = join(nodeModules, ...upstream.split("/"))

  if (!existsSync(pkgDir)) {
    throw new Error(`Package ${upstream} not found in ${nodeModules}`)
  }

  // Read package.json to find the entry point
  const pkgJson: unknown = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"))
  if (!isRecord(pkgJson)) throw new Error(`Invalid package metadata for ${upstream} in ${pkgDir}`)
  const candidate = pkgJson.module ?? pkgJson.main ?? "index.js"
  if (typeof candidate !== "string") throw new Error(`Invalid package entry for ${upstream} in ${pkgDir}`)
  const entry = candidate
  const entryPath = join(pkgDir, entry)

  if (existsSync(entryPath)) return entryPath

  // Fallback: just return the package directory (Vite will resolve from there)
  return pkgDir
}

// ── Run probes for a single backend+version ──

/**
 * Generate a temporary vitest config that uses resolve.alias to redirect
 * the upstream package import to the cached version.
 */
function generateVersionedConfig(upstream: string, aliasTarget: string): string {
  // Escape backslashes for the path in the generated JS
  const escapedTarget = aliasTarget.replace(/\\/g, "\\\\")

  return `
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "${upstream}": "${escapedTarget}",
    },
  },
  test: {
    include: ["packages/probes/**/*.probe.ts"],
  },
})
`.trim()
}

/**
 * Run probes for a specific backend at a specific upstream version.
 *
 * Strategy: generate a vitest config with `resolve.alias` that redirects the
 * upstream package import (e.g., @xterm/headless) to a cached version.
 * All backends load; we extract only the target backend's results.
 */
function runProbesForVersion(
  backendName: string,
  upstream: string,
  version: string,
  cacheDir: string,
): ReturnType<typeof parseVitestJson> | null {
  log.debug?.(`Running probes: ${backendName}@${version}`)

  // Resolve the cached upstream package path
  let aliasTarget: string
  try {
    aliasTarget = resolveUpstreamPath(cacheDir, upstream)
  } catch (e: unknown) {
    log.debug?.(`Failed to resolve upstream path: ${errorMessage(e)}`)
    return null
  }

  // Generate temporary vitest config
  const configContent = generateVersionedConfig(upstream, aliasTarget)
  const configPath = join(REPO_ROOT, `.vitest.probes-${backendName}-${version.replace(/\./g, "_")}.ts`)

  try {
    writeFileSync(configPath, configContent)

    const result = execSync(["bun", "vitest", "run", "--config", configPath, "--reporter", "json"].join(" "), {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      timeout: 120_000,
    })

    const stdout = result.toString("utf-8")
    if (!stdout.trim()) {
      log.debug?.(`No output from vitest for ${backendName}@${version}`)
      return null
    }

    const json = JSON.parse(stdout)
    return parseVitestJson(json)
  } catch (e: unknown) {
    // vitest exits with non-zero when tests fail — that's expected for probes
    // Try to parse stdout from the error
    const failedOutput = isRecord(e) ? e.stdout : undefined
    if (typeof failedOutput === "string" || Buffer.isBuffer(failedOutput)) {
      try {
        const stdout = typeof failedOutput === "string" ? failedOutput : failedOutput.toString("utf-8")
        const json: unknown = JSON.parse(stdout)
        return parseVitestJson(json)
      } catch (parseError: unknown) {
        log.debug?.(`Could not parse vitest output for ${backendName}@${version}: ${errorMessage(parseError)}`)
      }
    }
    log.debug?.(`Error running probes for ${backendName}@${version}: ${errorMessage(e)}`)
    return null
  } finally {
    // Clean up temporary config
    try {
      unlinkSync(configPath)
    } catch {}
  }
}

// ── Main entry point ──

export interface VersionsRunOptions {
  /** Only run specific backends (default: all in catalog) */
  backends?: string[]
  /** Force re-run even if cache is valid */
  force?: boolean
  /** Results directory (default: packages/probes/results) */
  resultsDir?: string
}

/**
 * Run versioned probes — probes against older versions of backends.
 */
export function runVersionedProbes(opts?: VersionsRunOptions): Promise<VersionRunResult[]> {
  const catalog = loadVersionsCatalog()
  const hash = probeHash()
  const results: VersionRunResult[] = []

  mkdirSync(RESULTS_DIR, { recursive: true })

  const backendFilter = opts?.backends ? new Set(opts.backends) : new Set(Object.keys(catalog.backends))

  for (const [backendName, config] of Object.entries(catalog.backends)) {
    if (!backendFilter.has(backendName)) continue

    for (const version of config.versions) {
      const filename = `${backendName}-${version}.json`
      const resultPath = join(RESULTS_DIR, filename)

      // Check cache
      if (!opts?.force && isCacheValid(resultPath, hash)) {
        log.debug?.(`Skipping ${backendName}@${version} (cache valid, hash=${hash})`)
        results.push({ backend: backendName, version, skipped: true })
        continue
      }

      // Install upstream at version
      let cacheDir: string
      try {
        cacheDir = ensureCachedVersion(config.upstream, version)
      } catch (e: unknown) {
        results.push({ backend: backendName, version, skipped: false, error: errorMessage(e) })
        continue
      }

      // Run probes
      const data = runProbesForVersion(backendName, config.upstream, version, cacheDir)

      if (!data || data.backendNames.length === 0) {
        results.push({
          backend: backendName,
          version,
          skipped: false,
          error: "No results from vitest",
        })
        continue
      }

      // Extract results for this backend only
      const backendResults = data.results.get(backendName)
      const backendNotes = data.notes.get(backendName)

      if (!backendResults) {
        results.push({
          backend: backendName,
          version,
          skipped: false,
          error: `Backend "${backendName}" not found in vitest output`,
        })
        continue
      }

      // Save result file
      let passCount = 0
      for (const r of backendResults.values()) {
        if (r) passCount++
      }

      const perBackend = {
        backend: backendName,
        version,
        probeHash: hash,
        generated: new Date().toISOString(),
        results: Object.fromEntries(backendResults),
        ...(backendNotes && backendNotes.size > 0 ? { notes: Object.fromEntries(backendNotes) } : {}),
      }

      writeFileSync(resultPath, JSON.stringify(perBackend, null, 2))
      log.debug?.(`Saved ${resultPath}`)

      results.push({
        backend: backendName,
        version,
        skipped: false,
        featureCount: backendResults.size,
        passCount,
      })
    }
  }

  return Promise.resolve(results)
}
