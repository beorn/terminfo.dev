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
 * The one scan that answers "which suites claim this release". `frozenSuiteIdFor` reads it, and the
 * freeze act runs the same scan BEFORE writing, so a write can never leave a registry its own reader
 * refuses. One copy, so the two can never disagree about what a claim is.
 */
function suiteClaimsFor(
  contentDir: string,
  release: string,
): { dir: string; claims: string[]; registryExists: boolean } {
  const dir = join(contentDir, "suites")
  if (!existsSync(dir)) return { dir, claims: [], registryExists: false }
  const claims: string[] = []
  for (const name of readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()) {
    const path = join(dir, name)
    const manifest = parseSuiteManifest(path, readFileSync(path, "utf8"))
    if (manifest.freeze?.release === release) claims.push(manifest.probeHash)
  }
  return { dir, claims, registryExists: true }
}

/**
 * The one suite manifest whose `freeze.release` names this release. The 83 manifests ARE the suite
 * registry, so the pointer cannot name a suite no manifest carries. Two manifests claiming one
 * release, or a release no manifest freezes, is refused loudly — a silent fallback would relabel
 * every run on the release suite "older" and suppress the tree-move banner.
 */
export function frozenSuiteIdFor(contentDir: string, release: string): string {
  const { dir, claims, registryExists } = suiteClaimsFor(contentDir, release)
  // A reader must resolve a release against a registry; a writer may create the first declaration.
  if (!registryExists) {
    throw new Error(
      `${dir}: the suite registry is required to name the current suite for release "${release}"; ` +
        'without it every run on the release suite is relabelled "older suite" and the tree-move banner is suppressed',
    )
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

/**
 * The release's lineage: the suite it is frozen at, then each suite it published on before, newest
 * first. The whole list is carried on the current freeze record, so it survives every later move;
 * nothing here walks another manifest, which would lose history the moment a move clears the old
 * record, and nothing infers it from the current pointer.
 */
export function frozenSuiteLineage(contentDir: string, release: string): string[] {
  const suiteId = frozenSuiteIdFor(contentDir, release)
  const path = join(contentDir, "suites", `${suiteId}.json`)
  const manifest = parseSuiteManifest(path, readFileSync(path, "utf8"))
  // The record stores the list oldest first; the reader's lineage names the newest step first.
  return [suiteId, ...(manifest.freeze?.previous ?? []).map((entry) => entry.suite).reverse()]
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

/** Every suite manifest is named by twelve lowercase hex characters (28018). */
const SUITE_ID_RE = /^[0-9a-f]{12}$/u

export type ExplicitSuiteTarget = Readonly<{ suiteId: string; path: string; manifest: ProbeSuiteManifest }>

/**
 * Read a suite the caller named instead of the live collector suite (28018). `--freeze`/`--move`
 * derive their target from `probeSuiteSnapshot`, which is the suite the collector builds NOW; a ruling
 * can name an older suite the registry still carries, and no collector can be made to re-derive it.
 * The target is therefore read, never assumed: the id must be shaped like a suite id, a manifest must
 * carry it, and that manifest must declare the id it is filed under. The live snapshot is not consulted
 * and no live-suite comparison runs, because the named suite is deliberately not the live one.
 */
export function readExplicitSuiteTarget(root: string, suiteId: string): ExplicitSuiteTarget {
  if (!SUITE_ID_RE.test(suiteId)) {
    throw new Error(
      `--suite ${JSON.stringify(suiteId)} is not a suite id: twelve lowercase hex characters name one suite manifest`,
    )
  }
  const path = join(root, "content", "suites", `${suiteId}.json`)
  if (!existsSync(path)) {
    throw new Error(
      `${path}: no suite manifest carries that id, so \"--suite ${suiteId}\" names no suite in this registry`,
    )
  }
  let manifest: ProbeSuiteManifest
  try {
    manifest = parseSuiteManifest(path, readFileSync(path, "utf8"))
  } catch (cause) {
    throw new Error(`${path}: the suite manifest does not parse, so --suite ${suiteId} cannot name a target`, {
      cause,
    })
  }
  if (manifest.probeHash !== suiteId) {
    throw new Error(
      `${path}: the manifest declares suite ${manifest.probeHash}, not ${suiteId}; --suite refuses a misfiled record`,
    )
  }
  return { suiteId, path, manifest }
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

/**
 * Add or replace the release pointer on a declaration that already exists. The record itself is not
 * rewritten: only the `freeze` key changes, so the probes and versions an admission verified stay
 * exactly as written.
 */
function applySuiteFreeze(
  path: string,
  freeze: { release: string; at?: string; previous?: { suite: string; from: string; until: string }[] },
): { status: "existing" | "frozen"; path: string } {
  const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  const current = stored.freeze as { release?: unknown; at?: unknown; previous?: unknown } | undefined
  // A freeze that asks for the pointer this record already carries is a no-op: rewriting it would
  // erase the lineage an earlier move appended and reset the instant the release was frozen.
  if (current?.release === freeze.release && typeof current.at === "string") return { status: "existing", path }
  stored.freeze = {
    release: freeze.release,
    at: freeze.at ?? new Date().toISOString(),
    ...(freeze.previous === undefined || freeze.previous.length === 0 ? {} : { previous: freeze.previous }),
  }
  // The one writer of the freeze key checks the exact bytes it is about to write with the reader's own
  // parser, so neither a freeze nor a move can land a record every reader refuses.
  const bytes = `${JSON.stringify(stored, null, 2)}\n`
  parseSuiteManifest(path, bytes)
  writeFileSync(path, bytes)
  return { status: "frozen", path }
}

/**
 * The freeze act as one operation: scan the release's claimants, refuse before writing if any suite
 * already claims it, write the pointer, then resolve the way a reader does. The check is the reader's
 * own scan rather than a second rule, so a freeze can never leave a registry its reader refuses.
 */
export function freezeCurrentSuiteManifest(
  root: string,
  release: string,
  options: { snapshot?: ProbeSuiteSnapshot; at?: string; suite?: string } = {},
): { status: "created" | "existing" | "frozen"; path: string; suiteId: string } {
  // An explicit suite is read from the registry and never compared with the live collector suite:
  // the point of naming one is that the ruling names a suite the collector no longer builds (28018).
  const named = options.suite === undefined ? undefined : readExplicitSuiteTarget(root, options.suite)
  if (named !== undefined && options.snapshot !== undefined) {
    throw new Error("--suite names its own target; pass a snapshot or a suite, never both")
  }
  const snapshot = named === undefined ? (options.snapshot ?? probeSuiteSnapshot(root)) : undefined
  const suiteId = named?.suiteId ?? (snapshot as ProbeSuiteSnapshot).probeHash
  assertDeclareIsAuthoring(root, suiteId)
  const contentDir = join(root, "content")
  const path = named?.path ?? join(contentDir, "suites", `${suiteId}.json`)
  // One check, not two policies: compute the claims this write would LEAVE, for every release it
  // touches — the one requested and the one this suite claims now — and refuse unless each ends with
  // exactly one suite. Every read goes through the same scan frozenSuiteIdFor uses.
  const requested = suiteClaimsFor(contentDir, release)
  const others = requested.claims.filter((claim) => claim !== suiteId)
  if (others.length > 0) {
    const pair = [...others, suiteId]
    throw new Error(`${requested.dir}: ${pair.length} suite manifests claim release "${release}": ${pair.join(", ")}`)
  }
  const current = existsSync(path) ? parseSuiteManifest(path, readFileSync(path, "utf8")).freeze?.release : undefined
  if (current !== undefined && current !== release) {
    const remaining = suiteClaimsFor(contentDir, current).claims.filter((claim) => claim !== suiteId)
    // Both arms of the reader's exactly-one rule, not just the zero one: a move that leaves the old
    // release with two claimants would put the registry in the state `frozenSuiteIdFor` refuses.
    if (remaining.length === 0) {
      throw new Error(
        `${requested.dir}: no suite manifest declares freeze.release "${current}" would remain: freezing suite ` +
          `${suiteId} for "${release}" would leave "${current}" with no suite. Freeze a different suite ` +
          `for "${release}", or have the cohort read "${current}".`,
      )
    }
    if (remaining.length > 1) {
      throw new Error(
        `${requested.dir}: ${remaining.length} suite manifests would claim release "${current}": ` +
          `${remaining.join(", ")}. Freezing suite ${suiteId} for "${release}" would leave "${current}" ` +
          `with more than one suite, which its reader refuses. Freeze a different suite for "${release}", or have ` +
          `the cohort read "${current}".`,
      )
    }
  }
  // The instant is captured here, at the write boundary, so record derivation stays a pure function
  // of its inputs and a caller can pin a fixed instant in a test.
  const frozen = { release, at: options.at ?? new Date().toISOString() }
  if (!existsSync(path)) {
    if (snapshot === undefined) {
      throw new Error(
        `${path}: --suite names an existing registry record; it never creates one. Freeze the live collector suite, ` +
          "or admit a run on this suite first",
      )
    }
    const created = persistSuiteManifest(path, derivedSuiteManifest(snapshot, frozen), snapshot)
    return { status: created, path, suiteId: frozenSuiteIdFor(contentDir, release) }
  }
  // A live suite is checked against the executable one. A named suite was checked against its own record
  // by readExplicitSuiteTarget, and holding it to the live snapshot is exactly what naming it avoids.
  if (snapshot !== undefined) verifySuiteManifest(path, snapshot)
  const applied = applySuiteFreeze(path, frozen)
  return { ...applied, suiteId: frozenSuiteIdFor(contentDir, release) }
}

/**
 * Move a release pointer onto the current suite, recording the suite it left as `freeze.previous` in
 * the same operation. A move is the one write allowed to leave the old suite with no claimant, so it
 * is a named act and never a side effect of freezing a second suite.
 */
export function moveReleasePointer(
  root: string,
  release: string,
  options: { snapshot?: ProbeSuiteSnapshot; at?: string; suite?: string } = {},
): { status: "existing" | "moved"; from: string; to: string; path: string } {
  // A move names the suite the pointer lands on. Without --suite that is the live collector suite; with
  // it, the registry record the caller named, read and checked against its own id (28018).
  const named = options.suite === undefined ? undefined : readExplicitSuiteTarget(root, options.suite)
  if (named !== undefined && options.snapshot !== undefined) {
    throw new Error("--suite names its own target; pass a snapshot or a suite, never both")
  }
  const snapshot = named === undefined ? (options.snapshot ?? probeSuiteSnapshot(root)) : undefined
  const to = named?.suiteId ?? (snapshot as ProbeSuiteSnapshot).probeHash
  assertDeclareIsAuthoring(root, to)
  const contentDir = join(root, "content")
  const { claims } = suiteClaimsFor(contentDir, release)
  if (claims.length > 1) {
    throw new Error(
      `${join(contentDir, "suites")}: ${claims.length} suite manifests claim release "${release}": ${claims.join(", ")}`,
    )
  }
  const from = claims[0]
  if (from === undefined) {
    throw new Error(
      `${join(contentDir, "suites")}: no suite manifest declares freeze.release "${release}", so there is no ` +
        `pointer to move; a release's first suite is frozen with --freeze ${release}`,
    )
  }
  // The claim scan named this suite, so its own record must carry the release. Anything else means the
  // scan and the record disagree: a no-op would report a claim the record does not hold, and a move
  // would silently leave the suite out of the lineage. One check, before either.
  const fromPath = join(contentDir, "suites", `${from}.json`)
  const fromFreeze = parseSuiteManifest(fromPath, readFileSync(fromPath, "utf8")).freeze
  if (fromFreeze?.release !== release) {
    throw new Error(
      `${fromPath}: the claim scan names suite ${from} for release "${release}", but its record carries ` +
        `${fromFreeze === undefined ? "no freeze" : `freeze.release "${fromFreeze.release}"`}; the scan and the ` +
        "record disagree, so the pointer is neither moved nor reported as held",
    )
  }
  const path = named?.path ?? join(contentDir, "suites", `${to}.json`)
  if (from === to) return { status: "existing", from, to, path }
  if (!existsSync(path)) {
    throw new Error(
      `${path}: the suite moving release "${release}" has no manifest; admit a run on it before moving the pointer`,
    )
  }
  // Same rule as the freeze: a live target is verified against the executable suite, a named one against
  // its own record. The named record is what the registry says this suite is, and that is the claim made.
  if (snapshot !== undefined) verifySuiteManifest(path, snapshot)
  const target = parseSuiteManifest(path, readFileSync(path, "utf8"))
  // A manifest carries one freeze. Moving this release onto a suite another release already claims
  // would take that claim away and leave it with no suite, so it is refused by name.
  if (target.freeze !== undefined && target.freeze.release !== release) {
    throw new Error(
      `${path}: suite ${to} already declares freeze.release "${target.freeze.release}"; moving "${release}" ` +
        `onto it would leave "${target.freeze.release}" with no suite`,
    )
  }
  // New record first, old claim second: a crash between the two leaves two claimants, which every
  // reader refuses loudly, never zero, which would relabel the old suite's runs as unpublishable.
  const at = options.at ?? new Date().toISOString()
  const carried = [...(fromFreeze.previous ?? []), { suite: from, from: fromFreeze.at, until: at }]
  // A repeat would leave a lineage the parser refuses, after the write had already landed. Refuse
  // before any byte moves: moving back onto a suite this release published on is a cycle, not a move.
  if (carried.some((entry) => entry.suite === to)) {
    throw new Error(
      `${path}: moving release "${release}" to suite ${to} would repeat suite ${to} in its freeze lineage; ` +
        "a release cannot return to a suite it already published on",
    )
  }
  applySuiteFreeze(path, { release, at, previous: carried })
  const stored = JSON.parse(readFileSync(fromPath, "utf8")) as Record<string, unknown>
  delete stored.freeze
  writeFileSync(fromPath, `${JSON.stringify(stored, null, 2)}\n`)
  return { status: "moved", from, to, path }
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

export type SuiteManifestMode = "check" | "freeze" | "move" | "usage"

/** A bare invocation is never a declare: the write needs the explicit verb (27843 AC2). */
export function suiteManifestMode(argv: string[]): SuiteManifestMode {
  if (argv.length === 1 && argv[0] === "--check") return "check"
  const [verb, release, flag, target, ...rest] = argv
  if (rest.length > 0) return "usage"
  const named = flag === "--suite"
  if (named && (target === undefined || target.trim() === "")) return "usage"
  if (flag !== undefined && !named) return "usage"
  const verbLength = named ? 4 : 2
  if (argv.length !== verbLength) return "usage"
  if ((verb === "--freeze" || verb === "--move") && release !== undefined && release.trim() !== "") {
    return verb === "--freeze" ? "freeze" : "move"
  }
  return "usage"
}
