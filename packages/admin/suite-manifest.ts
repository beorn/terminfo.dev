/** Record and validate the immutable declaration of an executable probe suite. */

import { existsSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import type { ProbeSuiteManifest } from "@terminfo/probe-defs"
import type { ProbeSuiteSnapshot } from "./versions.ts"
import { parseSuiteManifest, canonicalJson } from "@terminfo/run-parser"

const KINDS = ["term", "lib", "mux"] as const

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
  return { suiteId, path, manifest: readSuiteManifestFile(path, suiteId) }
}

export function readSuiteManifestFile(path: string, suiteId: string): ProbeSuiteManifest {
  if (!SUITE_ID_RE.test(suiteId) || basename(path) !== `${suiteId}.json`) {
    throw new Error(`${path}: expected a suite manifest filed as ${suiteId}.json with a twelve-lowercase-hex suite id`)
  }
  let source: string
  try {
    source = readFileSync(path, "utf8")
  } catch (cause) {
    throw new Error(`${path}: cannot read suite manifest for ${suiteId}`, { cause })
  }
  let manifest: ProbeSuiteManifest
  try {
    manifest = parseSuiteManifest(path, source)
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
  return manifest
}

/** Verify a stored declaration against the currently executable suite. */
export function verifySuiteManifest(
  path: string,
  snapshot: ProbeSuiteSnapshot,
  providedSource?: string,
): ProbeSuiteManifest {
  let source = providedSource
  if (source === undefined) {
    try {
      source = readFileSync(path, "utf8")
    } catch (cause) {
      throw new Error(`Cannot read suite manifest ${path}`, { cause })
    }
  }
  return verifyValue(parseSuiteManifest(path, source), path, snapshot)
}
