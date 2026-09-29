/** Executable probe suite identity, source environment, and version catalog. */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import { ALL_PROBES, type ProbeSuiteManifest } from "@terminfo/probe-defs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, "..", "..")
const PROBES_DIR = join(REPO_ROOT, "packages", "probes")
const PROBE_DEFS_DIR = join(REPO_ROOT, "packages", "probe-defs", "src")
const ADAPTER_PACKAGE_PATH = "packages/terminfo.dev/package.json"
// Include the collector's executed local imports: ownership and identity affect the observation too.
const ADAPTER_SOURCE_PATHS = [
  "packages/probes/headless-batch.ts",
  "packages/terminfo.dev/src/probes/unified.ts",
  "packages/terminfo.dev/src/tty.ts",
  "packages/terminfo.dev/src/linux-clipboard.ts",
  "packages/terminfo.dev/src/owned-terminal.ts",
  "packages/terminfo.dev/src/linux-capture.ts",
  "packages/terminfo.dev/src/serve.ts",
  "packages/terminfo.dev/src/detect.ts",
  "packages/terminfo.dev/src/identity-guard.ts",
  "packages/terminfo.dev/src/terminal-app-window.ts",
]
const VERSIONS_PATH = join(REPO_ROOT, "versions.json")

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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

/** Supply a source-tree launcher without overwriting a conflicting declared suite. */
export function ensureSourceSuiteEnvironment(): ReturnType<typeof sourceSuiteEnvironment> {
  const expected = sourceSuiteEnvironment()
  for (const key of ["TERMINFO_PROBE_HASH", "TERMINFO_SOURCE_REVISION"] as const) {
    const declared = process.env[key]
    if (declared !== undefined && declared !== expected[key]) {
      throw new Error(`${key} differs from the current source suite`)
    }
  }
  Object.assign(process.env, expected)
  return expected
}

// ── Version catalog ──

export function loadVersionsCatalog(): VersionsCatalog {
  if (!existsSync(VERSIONS_PATH)) {
    throw new Error(`Versions catalog not found: ${VERSIONS_PATH}`)
  }
  return JSON.parse(readFileSync(VERSIONS_PATH, "utf-8")) as VersionsCatalog
}
