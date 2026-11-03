/** Record and validate the immutable declaration of an executable probe suite. */

import { spawnSync } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ProbeSuiteManifest } from "@terminfo/probe-defs"
import {
  derivedSuiteManifest,
  probeSuiteSnapshot,
  uncommittedCollectorDirt,
  type ProbeSuiteSnapshot,
} from "./versions.ts"
import { parseSuiteManifest, canonicalJson } from "@terminfo/run-parser"

export { derivedSuiteManifest, uncommittedCollectorDirt }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const KINDS = ["term", "lib", "mux"] as const

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
  if (!sameStrings(value.catalogIds, snapshot.catalogIds)) {
    throw new Error(`Suite catalogue membership mismatch: ${path}`)
  }
  if (canonicalJson(value.catalogEntrySha256) !== canonicalJson(snapshot.catalogEntrySha256)) {
    throw new Error(`Suite catalogue entry hashes mismatch: ${path}`)
  }
  for (const kind of KINDS) {
    if (!sameStrings(value.probes[kind], snapshot.probes[kind])) {
      throw new Error(`Suite ${kind} membership mismatch: ${path}`)
    }
  }
  if (
    snapshot.textClaims === undefined
      ? value.textClaims !== undefined
      : !sameStrings(value.textClaims, snapshot.textClaims)
  ) {
    throw new Error(`Suite text claims mismatch: ${path}`)
  }
  if (
    value.textQualification?.version !== snapshot.textQualification?.version ||
    value.textQualification?.recipe !== snapshot.textQualification?.recipe
  ) {
    throw new Error(`Suite text qualification mismatch: ${path}`)
  }
  return value
}

/** Every suite manifest is named by twelve lowercase hex characters (28018). */
const SUITE_ID_RE = /^[0-9a-f]{12}$/u

export type ExplicitSuiteTarget = Readonly<{ suiteId: string; path: string; manifest: ProbeSuiteManifest }>

/**
 * Read a suite the caller named instead of the live collector suite (28018). A ruling can name an
 * older suite the registry still carries, and no collector can be made to re-derive it.
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
 * Declaring a suite is authoring, so it may only run on a checkout that can carry the commit it
 * writes: a declare on a shared-main checkout writes a manifest no commit will take. The
 * discriminator is the branch, not the commit, and not whether the branch is already ahead: a
 * fresh branch cut at origin/main authors the commit the admission creates, while the default
 * branch and a detached HEAD leave the write on nobody's commit.
 */
type GitResult = { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

function declarationCheckoutState(cwd: string): { authoring: boolean; detail: string } {
  const run = (args: string[]): GitResult => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" })
    if (result.error) throw new Error(`Cannot declare a suite: git ${args.join(" ")} failed`, { cause: result.error })
    return result
  }
  // Any status we did not ask for, and any signal, is a fact we do not have; the guard must say which
  // command failed and where, not fall back to a default branch set it could not read.
  const failure = (args: string[], result: GitResult): never => {
    const outcome = result.signal === null ? `exited ${result.status}` : `was killed by ${result.signal}`
    const stderr = result.stderr.trim()
    throw new Error(
      `Cannot declare a suite: git ${args.join(" ")} in ${cwd} ${outcome}` + (stderr === "" ? "" : `: ${stderr}`),
    )
  }
  const headArgs = ["rev-parse", "HEAD"]
  const head = run(headArgs)
  if (head.status !== 0) return failure(headArgs, head)
  const branchArgs = ["symbolic-ref", "--quiet", "--short", "HEAD"]
  const branch = run(branchArgs)
  if (branch.status === 1) return { authoring: false, detail: "its HEAD is detached" }
  if (branch.status !== 0) return failure(branchArgs, branch)
  const name = branch.stdout.trim()
  // main is always a default branch here, whatever origin/HEAD names: a clone cut from an author
  // branch can point origin/HEAD elsewhere, and a write on main is never the act this guard admits.
  const originArgs = ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]
  const originHead = run(originArgs)
  const defaults = new Set(["main"])
  if (originHead.status === 0) {
    const remoteDefault = originHead.stdout.trim().replace(/^origin\//u, "")
    if (remoteDefault === "") {
      throw new Error(`Cannot declare a suite: git ${originArgs.join(" ")} in ${cwd} named no branch`)
    }
    defaults.add(remoteDefault)
  } else if (originHead.status !== 1) {
    // --quiet exits 1 when the optional ref is absent or names no branch (a direct ref); both are
    // ordinary, because main is always a default here and a named task branch still authors its own
    // commit. Any other exit, or a signal, is a failure we did not ask for and must be named.
    return failure(originArgs, originHead)
  }
  if (defaults.has(name)) return { authoring: false, detail: `its HEAD is the default branch (${name})` }
  return { authoring: true, detail: `it is on the non-default branch ${name}` }
}

export function assertDeclareIsAuthoring(cwd: string, suiteHash?: string): void {
  const state = declarationCheckoutState(cwd)
  if (state.authoring) return
  const subject = suiteHash ? `Suite ${suiteHash}` : "This tree's suite"
  throw new Error(
    `${subject} cannot be declared or admitted on this checkout (${cwd}): ${state.detail}, so a declaration or an ` +
      "admission written here lands on no commit.\n" +
      "Create or switch to a branch that is not the default (git switch -c task/<name> origin/main), then re-run.",
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
