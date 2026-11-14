/** Record and validate the immutable declaration of an executable probe suite. */

import { existsSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import type { ProbeSuiteManifest } from "@terminfo/probe-defs"
import { derivedSuiteManifest, probeSuiteSnapshot, type ProbeSuiteSnapshot } from "./versions.ts"
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
  const declared = (spec: ProbeSuiteManifest["textQualification"]): string =>
    spec === undefined ? "" : JSON.stringify([spec.version, "recipes" in spec ? spec.recipes : spec.recipe])
  if (declared(value.textQualification) !== declared(snapshot.textQualification)) {
    throw new Error(`Suite text qualification mismatch: ${path}`)
  }
  return value
}

/** Every suite manifest is named by twelve lowercase hex characters (28018). */
const SUITE_ID_RE = /^[0-9a-f]{12}$/u

export type ExplicitSuiteTarget = Readonly<{ suiteId: string; path: string; manifest: ProbeSuiteManifest }>

/**
 * The one refusal a caller may handle by name: the named suite has no committed manifest and is not this tree's
 * live suite. It carries the tree's suite id so a caller can keep its own wording without deriving the tree again.
 */
export class MissingSuiteManifestError extends Error {
  constructor(
    readonly path: string,
    readonly suiteId: string,
    readonly treeSuiteId: string,
  ) {
    super(`${path}: no suite manifest carries that id, so "--suite ${suiteId}" names no suite in this registry`)
    this.name = "MissingSuiteManifestError"
  }
}

/**
 * The tree a named suite is measured against, decided once: `root` carries the registry and is the measured tree
 * when it holds probe sources (a checkout). A vault root holding only `content/suites` measures this installed
 * tree, which is what every caller did before the decision was folded here — the halves could disagree only
 * because the registry half read `root` while the tree half read the default. There is no "unknown tree" state: an
 * installation whose own probe sources cannot be read fails loudly rather than reporting a suite it never measured.
 */
function measuredTree(root: string): ProbeSuiteSnapshot {
  return existsSync(join(root, "packages", "probes")) ? probeSuiteSnapshot(root) : probeSuiteSnapshot()
}

/**
 * Read a suite the caller named instead of the live collector suite (28018). A ruling can name an
 * older suite the registry still carries, and no collector can be made to re-derive it.
 * The target is therefore read, never assumed: the id must be shaped like a suite id, a manifest must
 * carry it, and that manifest must declare the id it is filed under.
 *
 * The one live-suite exception (@cto 70719828 rule 1): `content/suites` is retention, so a suite with
 * no placed run is correctly absent from it. When the named id IS this tree's live suite, the target
 * is derived from the measured tree by the one existing deriver instead of refused. Every other
 * absent id still refuses by name, because a derived declaration never stands in for an older suite
 * (rule 3), and that is the property 28018 exists to keep.
 */
export function readExplicitSuiteTarget(root: string, suiteId: string): ExplicitSuiteTarget {
  if (!SUITE_ID_RE.test(suiteId)) {
    throw new Error(
      `--suite ${JSON.stringify(suiteId)} is not a suite id: twelve lowercase hex characters name one suite manifest`,
    )
  }
  const path = join(root, "content", "suites", `${suiteId}.json`)
  if (!existsSync(path)) {
    const tree = measuredTree(root)
    if (tree.probeHash === suiteId) {
      return { suiteId, path: `${suiteId} (derived from this tree)`, manifest: derivedSuiteManifest(tree) }
    }
    throw new MissingSuiteManifestError(path, suiteId, tree.probeHash)
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
