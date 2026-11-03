/**
 * @failure A reply-path cell measured zero reply bytes and carries no assertion, so the writer refused it as
 *   "support result requires measured evidence" instead of letting its kept answer decide (@chief ef840edc).
 * @level l1
 * @consumer parseProbeResults for every reply-path-audit cell in a current lib run
 * @testonly none
 */
import { expect, it } from "vitest"
import { REPLY_PATH_AUDIT_REVIEW, type ProbeSuiteManifest } from "@terminfo/probe-defs"
import { parseRun } from "./index.ts"

const FEATURE = "extensions.kitty-graphics"
const REF = JSON.stringify(["lib", "vt100-rust", "0.16.2", "linux", FEATURE])
const SUITE = "reply-path-suite"
const manifest: ProbeSuiteManifest & { schemaVersion: 4 } = {
  schemaVersion: 4,
  catalogIds: [FEATURE],
  probeHash: SUITE,
  adapterVersion: "3",
  probes: { term: [], lib: [FEATURE], mux: [] },
}

const draft = (status: "unsupported" | "supported", assertionType?: string) => ({
  schemaVersion: 4,
  source: { kind: "live" },
  runId: "reply-path-run",
  suiteId: SUITE,
  probeHash: SUITE,
  sourceRevision: "1".repeat(40),
  subject: {
    kind: "lib",
    id: "vt100-rust",
    version: "0.16.2",
    os: "linux",
    osVersion: null,
    outerTerminal: null,
    mux: null,
    config: null,
    permissions: null,
  },
  intendedSubject: { kind: "lib", id: "vt100-rust", version: "0.16.2" },
  runtimeIdentity: {
    kind: "js",
    runtimeFormat: "js",
    engineVersion: "0.16.2",
    adapterVersion: "0.10.2",
    termlessRevision: "2".repeat(40),
    resolvedPath: "/fixtures/vt100-rust/index.ts",
    integrity: {
      kind: "source",
      repository: "vterm",
      revision: "3".repeat(40),
      treeOid: "4".repeat(40),
      cleanTree: true,
    },
  },
  measuredAt: "2026-11-03T06:36:52.893Z",
  identity: "verified",
  origin: { kind: "collector" },
  rawReplies: { [FEATURE]: '{"replyPathAudit":{"captures":1,"replyBytes":0}}' },
  assertions: [],
  results: [
    {
      featureId: FEATURE,
      attempt: { scope: "probe", startedAt: "2026-11-03T06:36:52.893Z" },
      criterionBranch: REPLY_PATH_AUDIT_REVIEW,
      ...(assertionType !== undefined && { assertionType }),
      reviewRef: REF,
      tests: [
        {
          id: "review",
          status,
          attempt: { scope: "probe", startedAt: "2026-11-03T06:36:52.893Z" },
          reviewRef: REF,
          reason: "the kept source answer decides this cell",
        },
      ],
      status,
    },
  ],
  screenshotRefs: [],
  textSnapshotRefs: [],
})

const read = (status: "unsupported" | "supported", assertionType?: string) =>
  parseRun("reply-path.json", JSON.stringify(draft(status, assertionType)), [FEATURE], new Map([[SUITE, manifest]]))

it("seals a reply-path cell its kept answer decides, with no fabricated assertion", () => {
  const parsed = read("unsupported")
  expect(parsed.results?.[0]?.status).toBe("unsupported")
  expect(parsed.results?.[0]?.assertionType).toBeUndefined()
  expect(parsed.assertions).toEqual([])
})

it("still refuses a reply-path cell that claims evidence it does not have", () => {
  expect(() => read("supported")).toThrow("support result requires measured evidence")
  // A declared assertion type with nothing bound is refused by the assertion reader, never accepted as proof.
  expect(() => read("unsupported", "buffer_state")).toThrow("lacks bound negative assertion")
})
