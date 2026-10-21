/** Executable probe suite identity, source environment, and version catalog. */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import { loadFeatures } from "@terminfo/catalog"
import { ALL_PROBES, TEXT_QUALIFICATION_SPEC, type ProbeSuiteManifest } from "@terminfo/probe-defs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, "..", "..")
const ADAPTER_PACKAGE_PATH = "packages/terminfo.dev/package.json"
// Include the collector's executed local imports: ownership and identity affect the observation too.
const ADAPTER_SOURCE_PATHS = [
  "packages/probes/collect-headless.ts",
  "packages/probes/headless-batch.ts",
  "packages/probes/headless-identity.ts",
  "packages/probes/proven-reply-paths.ts",
  "packages/probes/termless-root.ts",
  "packages/admin/versions.ts",
  "packages/admin/app-harness.ts",
  "packages/admin/src/terminal-app-receipt.ts",
  "packages/terminfo.dev/src/terminal-app-window.ts",
  "packages/terminfo.dev/src/probe-output.ts",
  "scripts/admit-run.ts",
  "packages/terminfo.dev/src/probes/unified.ts",
  "packages/terminfo.dev/src/tty.ts",
  "packages/terminfo.dev/src/linux-clipboard.ts",
  "packages/terminfo.dev/src/owned-terminal.ts",
  "packages/terminfo.dev/src/owned-process.ts",
  "packages/terminfo.dev/src/windows-console-ffi.ts",
  "packages/terminfo.dev/src/windows-console-cells.ts",
  "packages/terminfo.dev/src/windows-console-geometry.ts",
  "packages/terminfo.dev/src/windows-kernel32.ts",
  "packages/terminfo.dev/src/windows-process-ancestry.ts",
  "packages/terminfo.dev/src/disposable-receipt.ts",
  "packages/terminfo.dev/src/linux-capture.ts",
  "packages/terminfo.dev/src/capture-core.ts",
  "packages/terminfo.dev/src/darwin-capture.ts",
  "packages/terminfo.dev/src/darwin-terminal-text.ts",
  "packages/terminfo.dev/src/capture-calibration.ts",
  "packages/terminfo.dev/src/text-qualification.ts",
  "packages/terminfo.dev/src/linux-input.ts",
  "packages/terminfo.dev/src/serve.ts",
  "packages/terminfo.dev/src/detect.ts",
  "packages/terminfo.dev/src/identity-guard.ts",
  "packages/run-parser/src/index.ts",
  "packages/run-parser/src/app-launch.ts",
  "scripts/release1-collection.ts",
  "scripts/interpretations.ts",
  "scripts/linux-container-run.sh",
  "scripts/owned-app-remote-run.ts",
  "scripts/hosted-runner-receipt.ts",
  "packages/terminfo.dev/src/daemon-client.ts",
  "packages/terminfo.dev/src/capture-writer.ts",
  "packages/terminfo.dev/src/index.tsx",
  "packages/terminfo.dev/src/submit.ts",
  "packages/admin/src/admit-collected-run.ts",
  "packages/admin/src/app.ts",
  "packages/admin/src/here.ts",
  "packages/admin/src/mux.ts",
  "packages/admin/src/server.ts",
  "packages/catalog/src/index.ts",
  "docs/data/full-census.ts",
  "content/terminals.json",
  ".github/workflows/macos-measurement.yml",
  ".github/workflows/windows-measurement.yml",
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
  catalogIds: string[]
  probes: ProbeSuiteManifest["probes"]
  textClaims?: string[]
  textQualification?: ProbeSuiteManifest["textQualification"]
  /** Paths whose committed bytes define this suite declaration. */
  sourcePaths: string[]
}

/** Compute suite identity and applicable membership from the same live inputs. */
export function probeSuiteSnapshot(repoRoot: string = REPO_ROOT): ProbeSuiteSnapshot {
  const hash = createHash("md5")
  const catalogIds = Object.keys(loadFeatures(join(repoRoot, "content"))).sort()
  hash.update("catalogIds")
  hash.update(JSON.stringify(catalogIds))

  const probeFiles = readdirSync(join(repoRoot, "packages", "probes"))
    .filter((f) => f.endsWith(".probe.ts"))
    .sort()
  const definitionFiles = readdirSync(join(repoRoot, "packages", "probe-defs", "src"))
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
    hash.update(readFileSync(join(repoRoot, relativePath)))
  }

  const adapterPackage: unknown = JSON.parse(readFileSync(join(repoRoot, ADAPTER_PACKAGE_PATH), "utf8"))
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
  const textClaims = ALL_PROBES.filter((probe) => probe.term !== null && probe.textClaim === "characters")
    .map((probe) => probe.id)
    .sort()
  return {
    ...(textClaims.length === 0 ? {} : { textClaims, textQualification: TEXT_QUALIFICATION_SPEC }),
    probeHash: hash.digest("hex").slice(0, 12),
    adapterVersion,
    catalogIds,
    probes: { app, headless, mux: [...app] },
    sourcePaths,
  }
}

/** Derive the suite declaration record from a live suite snapshot. */
/**
 * The manifest a declaration writes. A freeze act passes the release it is freezing, so the pointer
 * is part of what the writer emits and no human appends it to the JSON afterwards; admission passes
 * nothing, because admitting a run names a suite without claiming it as a release's current one.
 */
export function derivedSuiteManifest(
  snapshot: ProbeSuiteSnapshot = probeSuiteSnapshot(),
  freeze?: { release: string; at: string },
): ProbeSuiteManifest {
  return {
    probeHash: snapshot.probeHash,
    adapterVersion: snapshot.adapterVersion,
    probes: snapshot.probes,
    catalogIds: [...snapshot.catalogIds],
    ...(snapshot.textClaims === undefined ? {} : { textClaims: snapshot.textClaims }),
    ...(snapshot.textQualification === undefined ? {} : { textQualification: snapshot.textQualification }),
    ...(freeze === undefined ? {} : { freeze: { release: freeze.release, at: freeze.at } }),
  }
}

function collectorCommittedInputs(snapshot: ProbeSuiteSnapshot): string[] {
  return [
    ...snapshot.sourcePaths,
    "packages/terminfo.dev/src",
    "packages/terminfo.dev/bin/terminfo.mjs",
    "packages/admin/versions.ts",
    "packages/admin/app-harness.ts",
    "scripts/admit-run.ts",
    "packages/run-parser/src",
    "packages/run-parser/package.json",
    "scripts/build-cli.ts",
    "scripts/suite-manifest.ts",
    "packages/admin/suite-manifest.ts",
    "bun.lock",
  ]
}

/** Committed collector inputs that have local modifications and cannot produce a reproducible build or run. */
export function uncommittedCollectorDirt(
  cwd: string = REPO_ROOT,
  snapshot: ProbeSuiteSnapshot = probeSuiteSnapshot(cwd),
): string {
  return execFileSync("git", ["status", "--porcelain", "--", ...collectorCommittedInputs(snapshot)], {
    cwd,
    encoding: "utf8",
  }).trim()
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
