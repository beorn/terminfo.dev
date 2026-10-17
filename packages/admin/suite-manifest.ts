/** Record and validate the immutable declaration of an executable probe suite. */

import { spawnSync } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ProbeSuiteManifest } from "@terminfo/probe-defs"
import {
  derivedSuiteManifest,
  probeSuiteSnapshot,
  uncommittedCollectorDirt,
  type ProbeSuiteSnapshot,
} from "./versions.ts"
import { parseSuiteManifest } from "@terminfo/run-parser"

export { derivedSuiteManifest, uncommittedCollectorDirt }

/**
 * The one suite manifest whose `freeze.release` names this release. The 83 manifests ARE the suite
 * registry, so the pointer cannot name a suite no manifest carries. Two manifests claiming one
 * release, or a release no manifest freezes, is refused loudly — a silent fallback would relabel
 * every run on the release suite "older" and suppress the tree-move banner.
 */
export function frozenSuiteIdFor(contentDir: string, release: string): string {
  const dir = join(contentDir, "suites")
  if (!existsSync(dir)) {
    throw new Error(
      `${dir}: the suite registry is required to name the current suite for release "${release}"; ` +
        'without it every run on the release suite is relabelled "older suite" and the tree-move banner is suppressed',
    )
  }
  const claims: string[] = []
  for (const name of readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()) {
    const path = join(dir, name)
    const manifest = parseSuiteManifest(path, readFileSync(path, "utf8"))
    if (manifest.freeze?.release === release) claims.push(manifest.probeHash)
  }
  if (claims.length === 0) {
    throw new Error(`${dir}: no suite manifest declares freeze.release "${release}"`)
  }
  if (claims.length > 1) {
    throw new Error(`${dir}: ${claims.length} suite manifests claim release "${release}": ${claims.join(", ")}`)
  }
  const [suiteId] = claims
  if (!suiteId) throw new Error(`${dir}: release "${release}" resolved to no suite`)
  return suiteId
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const RUN_DIRS = ["probes-apps", "probes-libs", "probes-mux"] as const
const KINDS = ["app", "headless", "mux"] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sameStrings(actual: unknown, expected: string[]): actual is string[] {
  return (
    Array.isArray(actual) && actual.length === expected.length && actual.every((id, index) => id === expected[index])
  )
}

function verifyValue(value: ProbeSuiteManifest, path: string, snapshot: ProbeSuiteSnapshot): ProbeSuiteManifest {
  if (value.probeHash !== snapshot.probeHash) throw new Error(`Suite hash mismatch: ${path}`)
  if (value.adapterVersion !== snapshot.adapterVersion) throw new Error(`Suite adapter version mismatch: ${path}`)
  for (const kind of KINDS) {
    if (!sameStrings(value.probes[kind], snapshot.probes[kind])) {
      throw new Error(`Suite ${kind} membership mismatch: ${path}`)
    }
  }
  return value
}

/** Verify a stored declaration against the currently executable suite. */
export function verifySuiteManifest(path: string, snapshot: ProbeSuiteSnapshot): ProbeSuiteManifest {
  let source: string
  try {
    source = readFileSync(path, "utf8")
  } catch (cause) {
    throw new Error(`Cannot read suite manifest ${path}`, { cause })
  }
  return verifyValue(parseSuiteManifest(path, source), path, snapshot)
}

/** Create exclusively; an existing hash is checked and its original metadata retained. */
export function persistSuiteManifest(
  path: string,
  manifest: ProbeSuiteManifest,
  snapshot: ProbeSuiteSnapshot,
): "created" | "existing" {
  verifyValue(parseSuiteManifest(path, JSON.stringify(manifest)), path, snapshot)
  mkdirSync(dirname(path), { recursive: true })
  let descriptor: number
  try {
    descriptor = openSync(path, "wx")
  } catch (cause) {
    if (isRecord(cause) && cause.code === "EEXIST") {
      verifySuiteManifest(path, snapshot)
      return "existing"
    }
    throw new Error(`Cannot create suite manifest ${path}`, { cause })
  }
  try {
    writeFileSync(descriptor, `${JSON.stringify(manifest, null, 2)}\n`)
  } finally {
    closeSync(descriptor)
  }
  return "created"
}

/**
 * Declaring a suite is authoring, so it may only run on a checkout carrying work that
 * is not yet on main: a declare on a shared-main checkout writes a manifest no commit will take.
 * `--check` still runs anywhere; validating a stored declaration is a read.
 *
 * ADMISSION PASSES THIS GUARD. `scripts/admit-run.ts` declares the run's manifest and admits the
 * run in one commit on a branch ahead of origin/main, so the guard holds unchanged. Do not weaken
 * it to "fix" admission; admission is authoring by construction.
 */
function declarationCheckoutState(cwd: string): "authoring" | "on-main" {
  const run = (args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" })
    if (result.error) throw new Error(`Cannot declare a suite: git ${args.join(" ")} failed`, { cause: result.error })
    return result
  }
  const head = run(["rev-parse", "HEAD"])
  if (head.status !== 0) throw new Error(`Cannot declare a suite outside a Git checkout (${cwd})`)
  const declared = run(["rev-parse", "--verify", "origin/main^{commit}"])
  if (declared.status !== 0) {
    throw new Error(`Cannot declare a suite: ${cwd} offers no origin/main to compare the declared revision against`)
  }
  const ancestor = run(["merge-base", "--is-ancestor", head.stdout.trim(), declared.stdout.trim()])
  if (ancestor.status === 0) return "on-main"
  if (ancestor.status !== 1) {
    throw new Error(
      `Cannot declare a suite: git merge-base --is-ancestor failed (${ancestor.status}): ${ancestor.stderr.trim()}`,
    )
  }
  return "authoring"
}

export function assertDeclareIsAuthoring(cwd: string, suiteHash?: string): void {
  if (declarationCheckoutState(cwd) === "authoring") return
  const subject = suiteHash ? `Suite ${suiteHash}` : "This tree's suite"
  throw new Error(
    `${subject} cannot be declared or admitted on this checkout (${cwd}): its HEAD is already on origin/main, so a ` +
      "declaration or an admission written here lands on no commit.\n" +
      "A collector authors nothing: the freeze act lands this suite's declaration on main, and admission runs from " +
      "a branch with at least one commit ahead of origin/main (a fresh branch cut at the pin is NOT enough): bun " +
      "scripts/admit-run.ts --for <run.json>",
  )
}

export function declareCurrentSuiteManifest(
  root: string = ROOT,
  snapshot: ProbeSuiteSnapshot = probeSuiteSnapshot(root),
): { status: "created" | "existing"; path: string } {
  assertDeclareIsAuthoring(root, snapshot.probeHash)
  const path = join(root, "content", "suites", `${snapshot.probeHash}.json`)
  if (existsSync(path)) {
    verifySuiteManifest(path, snapshot)
    return { status: "existing", path }
  }
  return { status: persistSuiteManifest(path, derivedSuiteManifest(snapshot), snapshot), path }
}

/** Every committed run names the suite that produced it. */
export function citedSuiteHashes(cwd = ROOT): Map<string, string[]> {
  const byHash = new Map<string, string[]>()
  for (const dir of RUN_DIRS) {
    const full = join(cwd, "content", dir)
    if (!existsSync(full)) throw new Error(`Missing required probe directory ${full}`)
    for (const file of readdirSync(full).sort()) {
      if (!file.endsWith(".json")) continue
      const path = join(full, file)
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(path, "utf8"))
      } catch (cause) {
        throw new Error(`Cannot read committed run ${path}`, { cause })
      }
      if (!isRecord(parsed)) throw new Error(`Committed run ${path} is not an object`)
      // Legacy v1 runs predate the executable suite and cite nothing; only schema v2 carries one.
      if (parsed.schemaVersion !== 2) continue
      if (typeof parsed.probeHash !== "string" || !/^[0-9a-f]{12}$/.test(parsed.probeHash)) {
        throw new Error(`Committed v2 run ${path} declares no valid probeHash`)
      }
      const files = byHash.get(parsed.probeHash) ?? []
      files.push(file)
      byHash.set(parsed.probeHash, files)
    }
  }
  return byHash
}

/**
 * The composed-tree suite gate (27832 direction (2)). A non-fast-forward compose of two adapter
 * branches produces a suite hash nobody cited, and the old check went red on exactly that. New
 * rule: (a) EXISTENCE — every committed run's `probeHash` has `content/suites/<hash>.json`, and
 * each manifest is named for the hash it declares; (b) the CHEAP FILE-HASH DERIVATION — when this
 * tree's own suite is declared, verify the stored manifest against the live snapshot. Recomputing
 * a historical suite's `probes` would execute old probe-defs code and belongs to admission, never
 * to this hermetic gate (see the residual-risk note in 27859).
 */
export function checkCitedSuiteManifests(
  cwd = ROOT,
  snapshot: ProbeSuiteSnapshot = probeSuiteSnapshot(),
): { cited: number; manifests: number } {
  const suitesDir = join(cwd, "content", "suites")
  const cited = citedSuiteHashes(cwd)
  const missing: string[] = []
  for (const [hash, files] of cited) {
    const path = join(suitesDir, `${hash}.json`)
    if (!existsSync(path)) {
      missing.push(`${hash} — ${files.length} run(s), e.g. ${files[0]}`)
      continue
    }
    const manifest = parseSuiteManifest(path, readFileSync(path, "utf8"))
    if (manifest.probeHash !== hash) {
      throw new Error(`Suite manifest ${path} declares ${manifest.probeHash}, not its filename ${hash}`)
    }
  }
  if (missing.length > 0) {
    throw new Error(`Cited runs have no committed suite manifest:\n${missing.sort().join("\n")}`)
  }
  const currentPath = join(suitesDir, `${snapshot.probeHash}.json`)
  if (existsSync(currentPath)) verifySuiteManifest(currentPath, snapshot)
  return { cited: cited.size, manifests: cited.size }
}

export type SuiteManifestMode = "check" | "usage"

/** A bare invocation is never a declare: the write needs the explicit verb (27843 AC2). */
export function suiteManifestMode(argv: string[]): SuiteManifestMode {
  if (argv.length !== 1) return "usage"
  if (argv[0] === "--check") return "check"
  return "usage"
}
