/**
 * @failure A stored reply-path or source-negative cell carrying a kept source answer is read as Unsupported (or
 *   refused) instead of PROBE TODO, so a Terminfo probe result is again decided from source (operator 2026-11-03, #32246).
 * @level l1
 * @consumer parseProbeResults for every stored reply-path-audit / source-negative cell in a retained lib run
 * @testonly none
 */
import { expect, it } from "vitest"
import {
  REPLY_PATH_AUDIT_REVIEW,
  SOURCE_NEGATIVE_REVIEW,
  SOURCE_ONLY_NEGATIVE_REVIEW_BRANCHES,
  UNTESTABLE_ONLY_REVIEW_BRANCHES,
  type ProbeSuiteManifest,
} from "@terminfo/probe-defs"
import { parseRun, SOURCE_ANSWER_RETIRED_REASON } from "./index.ts"

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

const draft = (
  status: "unsupported" | "supported",
  assertionType?: string,
  branch: string = REPLY_PATH_AUDIT_REVIEW,
) => ({
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
      criterionBranch: branch,
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

const read = (status: "unsupported" | "supported", assertionType?: string, branch?: string) =>
  parseRun(
    "reply-path.json",
    JSON.stringify(draft(status, assertionType, branch)),
    [FEATURE],
    new Map([[SUITE, manifest]]),
  )

it("reads a stored reply-path cell its kept answer used to decide as PROBE TODO, refs stripped", () => {
  const parsed = read("unsupported")
  expect(parsed.results?.[0]).toMatchObject({ status: "probe-todo", reason: SOURCE_ANSWER_RETIRED_REASON })
  expect(parsed.results?.[0]?.reviewRef).toBeUndefined()
  expect(parsed.results?.[0]?.tests[0]).toMatchObject({ status: "probe-todo", reason: SOURCE_ANSWER_RETIRED_REASON })
  expect(parsed.results?.[0]?.tests[0]?.reviewRef).toBeUndefined()
  expect(parsed.assertions).toEqual([])
})

it("never uses a stored source answer to decide a probe result, whatever status or assertion type it claims", () => {
  expect(read("supported").results?.[0]?.status).toBe("probe-todo")
  expect(read("unsupported", "buffer_state").results?.[0]?.status).toBe("probe-todo")
})

// Every row is the SAME status with the SAME kept-answer marker: the stored source answer no longer decides any
// branch, so each reads PROBE TODO with the retired reason (operator 2026-11-03, @cto 153143ff). The
// headless-observable branch keeps its own shape rule (untestable only), which fires before any answer is read.
const BRANCH_ROWS: ReadonlyArray<{ branch: string; refusal?: string }> = [
  {
    branch: "headless-observable-review",
    refusal: "headless-observable-review review admits only an untestable decision",
  },
  { branch: REPLY_PATH_AUDIT_REVIEW },
  { branch: SOURCE_NEGATIVE_REVIEW },
  { branch: "color-readback-review" },
]

it("reads a stored kept-answer negative as PROBE TODO on every branch that admits the shape", () => {
  for (const row of BRANCH_ROWS) {
    if (row.refusal !== undefined) {
      expect(() => read("unsupported", undefined, row.branch), row.branch).toThrow(row.refusal)
    } else {
      expect(read("unsupported", undefined, row.branch).results?.[0], row.branch).toMatchObject({
        status: "probe-todo",
        reason: SOURCE_ANSWER_RETIRED_REASON,
      })
    }
  }
})

// A branch cannot be both untestable-only and source-only-negative; if one ever joined both sets, the two rules
// would contradict and the row above would stop meaning what it says (@cto 93c86660 condition 2).
it("keeps the untestable-only and source-only-negative branch sets disjoint", () => {
  const both = [...SOURCE_ONLY_NEGATIVE_REVIEW_BRANCHES].filter((branch) => UNTESTABLE_ONLY_REVIEW_BRANCHES.has(branch))
  expect(both).toEqual([])
})
