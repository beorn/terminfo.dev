/**
 * @failure A superseded physical variant of an app (an older kernel or argv of the same app+OS) keeps serving beside the
 *   current one, so one app shows two columns and the older column can carry a criterion text nothing current defines;
 *   or the collapse wrongly drops an app whose only collected suite is older, which the site labels "older suite".
 * @level l2
 * @consumer compatibilitySubjects, the selection behind publicResults and every served page column (#39077, @cpo/term).
 * @testonly none
 */
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parseRun } from "@terminfo/run-parser"
import { initializeRunDraft, type ProbeResult, type ProbeSuiteManifest, type ProbeSubject } from "@terminfo/probe-defs"
import { finalizeCollectedDraft } from "../packages/terminfo.dev/src/capture-writer.ts"
import { projectResults } from "../docs/data/selected-results.ts"
import { compatibilitySubjects, contributingRuns } from "../docs/data/current-results.ts"

const CONTENT = join(import.meta.dirname, "..", "content")
const IDS = ["modes.auto-wrap"]
const OLD_SUITE = "variant-old-suite"
const NEW_SUITE = "variant-new-suite"
const NOT_AN_ANCESTOR = { isAncestor: () => false }

const OLD_REVISION = "1".repeat(40)
const NEW_REVISION = "2".repeat(40)
const ANCESTRY = {
  // Git's is-ancestor is reflexive, and the pick's descendantOfAll relies on that for a single revision.
  isAncestor: (older: string, newer: string) => older === newer || (older === OLD_REVISION && newer === NEW_REVISION),
}

const manifest = (probeHash: string, sourceRevision: string): ProbeSuiteManifest & { schemaVersion: 4 } => ({
  schemaVersion: 4,
  probeHash,
  sourceRevision,
  generatedAt: "2026-11-20T05:00:00.000Z",
  adapterVersion: "3.3.2",
  catalogIds: IDS,
  probes: { term: [], lib: [], mux: [] },
})
const suites = {
  [OLD_SUITE]: manifest(OLD_SUITE, OLD_REVISION),
  [NEW_SUITE]: manifest(NEW_SUITE, NEW_REVISION),
}

const ATTEMPT = { scope: "probe" as const, startedAt: "2026-11-20T05:00:00.000Z" }
const supported = (featureId: string): ProbeResult => ({
  featureId,
  status: "supported",
  attempt: ATTEMPT,
  assertionType: "query_reply",
  rawReplyRef: featureId,
  tests: [{ id: "criterion", status: "supported", attempt: ATTEMPT, assertionRefs: [0], rawReplyRef: featureId }],
})
const REASONS = new Map(IDS.map((id) => [id, "ACK"]))

/** The old variant: an earlier kitty build on an earlier kernel, with its own argv. */
const OLD_VARIANT: ProbeSubject = {
  kind: "term",
  id: "kitty",
  version: "0.49.2",
  os: "linux",
  osVersion: "7.0.0-34-generic",
  outerTerminal: null,
  mux: null,
  config: "kitty --class terminfo-kitty-container-daemon",
  permissions: null,
}
/** The current variant of the same app+OS: a newer build on the newer kernel. */
const NEW_VARIANT: ProbeSubject = {
  ...OLD_VARIANT,
  version: "0.51.1",
  osVersion: "7.0.0-43-generic",
  config: "nice -n 10 kitty --config NONE --class terminfo-kitty-container-daemon",
}

const run = (runId: string, suite: string, subject: ProbeSubject, measuredAt: string) => {
  const spec = suites[suite]!
  const draft = initializeRunDraft({
    runId,
    sourceRevision: spec.sourceRevision!,
    manifest: spec,
    source: { kind: "live" },
    intendedSubject: { kind: "term", id: "kitty" },
  })
  draft.subject = subject
  draft.identity = "verified"
  draft.measuredAt = measuredAt
  draft.origin = { kind: "collector" }
  draft.rawReplies = {
    "collector.selection": JSON.stringify({ ids: IDS }),
    "collector.collectionAttempt": JSON.stringify({ ids: IDS, startedAt: measuredAt, result: "completed" }),
    ...Object.fromEntries(REASONS),
  }
  draft.results = IDS.map(supported)
  const sealed = finalizeCollectedDraft(draft as Parameters<typeof finalizeCollectedDraft>[0]) as unknown as Record<
    string,
    unknown
  >
  return parseRun(
    `${runId}.json`,
    JSON.stringify({
      ...sealed,
      assertions: IDS.map((featureId) => ({
        featureId,
        kind: "positive" as const,
        assertionType: "query_reply" as const,
        rawReplyRef: featureId,
        expected: "ACK",
        observed: "ACK",
      })),
      rawReplies: { ...(sealed.rawReplies as Record<string, string>), ...Object.fromEntries(REASONS) },
    }),
    IDS,
    new Map(Object.entries(suites)),
  )
}

const servedFor = (runs: ReturnType<typeof run>[]) => {
  const projection = projectResults(runs, IDS, { currentProbeHash: NEW_SUITE }, [])
  const served = compatibilitySubjects(projection, CONTENT, ANCESTRY)
  return { projection, served }
}

describe("#39077 the served matrix holds one variant per app+OS", () => {
  it("serves the current variant and keeps the superseded one out of the selection", () => {
    const { projection, served } = servedFor([
      run("old-variant", OLD_SUITE, OLD_VARIANT, "2026-11-03T00:00:00.000Z"),
      run("new-variant", NEW_SUITE, NEW_VARIANT, "2026-11-27T00:00:00.000Z"),
    ])
    // Both variants are in the projection — the older one is history, not deleted.
    expect(Object.keys(projection.contexts)).toHaveLength(2)
    const entries = [...served.values()]
    expect(entries).toHaveLength(1)
    const only = entries[0]!
    expect(contributingRuns(only.selected)[0]?.version).toBe("0.51.1")
    expect(only.contextKey).toContain("7.0.0-43-generic")
    expect(only.contextKey).toContain(NEW_VARIANT.config!)
    // The superseded variant's context is present but is not the one any page column reads.
    const supersededKeys = Object.keys(projection.contexts).filter((key) => key !== only.contextKey)
    expect(supersededKeys).toHaveLength(1)
    expect(projection.contexts[supersededKeys[0]!]!.subject?.osVersion).toBe("7.0.0-34-generic")
  })

  it("still serves an app whose only collected suite is older, which the site labels older suite", () => {
    const { served } = servedFor([run("only-old-suite", OLD_SUITE, OLD_VARIANT, "2026-11-03T00:00:00.000Z")])
    const entries = [...served.values()]
    expect(entries).toHaveLength(1)
    // The old-suite label is the site's existing behaviour (33109); the variant rule must not blank it.
    // A single context keys by its bare stem, so the variant is read from the subject facts.
    expect(entries[0]!.contextKey).toBe("term:kitty")
    expect(entries[0]!.selected.subject?.osVersion).toBe("7.0.0-34-generic")
  })
})
