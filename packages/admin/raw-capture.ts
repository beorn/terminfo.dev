/**
 * The ONE reader of a raw (unsealed) collector capture: the admin report's private scoreboard and the internal preview
 * site's hourly re-measure view both call it, so a raw draft is parsed one way everywhere (@cto scope GO 2026-11-02,
 * "one loader").
 *
 * A raw capture is evidence, never an admitted or reviewed result. This reader validates the bytes through the
 * canonical `parseRun` in capture mode against the suite's trusted manifest and returns the parsed run; it grades,
 * admits and publishes nothing.
 *
 * The trusted manifest is the committed `content/suites/<suite>.json`, or, when no manifest is committed, the
 * manifest derived from THIS tree's own probe sources, but only when the capture names exactly this tree's suite
 * (the hourly re-measure measures the tree it runs from, and release1-collection trusts the same derived manifest
 * for the drafts it writes). Any other suite has no trusted declaration here, and the capture is refused by name.
 *
 * NO SILENT ERRORS: a missing file, malformed JSON, a header without its identity, an unknown suite, a suite id that
 * disagrees with its manifest, or a capture without recorded results each throw with the path and the cause.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ProbeSuiteManifest } from "@terminfo/probe-defs"
import { parseJsonStrict, parseRun, type LoadedRun } from "@terminfo/run-parser"
import { readExplicitSuiteTarget } from "./suite-manifest.ts"
import { derivedSuiteManifest, probeSuiteSnapshot } from "./versions.ts"

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/**
 * The one refusal a caller may handle by name: the capture's suite has no committed manifest and is not this tree's
 * suite. The preview site turns it into a loud banner (a re-measure on the previous suite right after a landing);
 * the admin report records it in the evidence row. Every other reader error is a plain Error.
 */
export class UntrustedSuiteError extends Error {
  constructor(
    readonly path: string,
    readonly suiteId: string,
    readonly treeSuiteId: string,
    root: string,
  ) {
    super(
      `${path}: suite ${suiteId} has no committed manifest under ${join(root, "content", "suites")} and is not this ` +
        `tree's suite ${treeSuiteId}; the raw capture cannot be read against a trusted declaration`,
    )
    this.name = "UntrustedSuiteError"
  }
}

/** The trusted manifest a capture on `suiteId` is read against, or a loud refusal naming why none exists. */
function trustedManifest(path: string, root: string, suiteId: string): ProbeSuiteManifest {
  if (existsSync(join(root, "content", "suites", `${suiteId}.json`))) {
    return readExplicitSuiteTarget(root, suiteId).manifest
  }
  const tree = probeSuiteSnapshot()
  if (tree.probeHash === suiteId) return derivedSuiteManifest(tree)
  throw new UntrustedSuiteError(path, suiteId, tree.probeHash, root)
}

/**
 * Read one raw capture. `bytes` lets a caller that already read the file (to route it) pass the same bytes, so the
 * parsed run is exactly the bytes it routed.
 */
export function loadRawCapture(
  path: string,
  options: { root: string; catalogIds: readonly string[]; bytes?: string },
): LoadedRun {
  let bytes = options.bytes
  if (bytes === undefined) {
    try {
      bytes = readFileSync(path, "utf8")
    } catch (cause) {
      throw new Error(`${path}: cannot read raw capture (${cause instanceof Error ? cause.message : String(cause)})`, {
        cause,
      })
    }
  }
  const header: unknown = parseJsonStrict(path, bytes)
  if (
    !record(header) ||
    typeof header.runId !== "string" ||
    typeof header.probeHash !== "string" ||
    typeof header.sourceRevision !== "string"
  ) {
    throw new Error(`${path}: a raw capture requires runId, probeHash and sourceRevision`)
  }
  const manifest = trustedManifest(path, options.root, header.probeHash)
  if (header.suiteId !== manifest.probeHash) {
    throw new Error(`${path}: suiteId disagrees with manifest ${manifest.probeHash}`)
  }
  const run = parseRun(path, bytes, options.catalogIds, new Map([[manifest.probeHash, manifest]]))
  if (!run.results) throw new Error(`${path}: raw capture has no recorded results`)
  return run
}
