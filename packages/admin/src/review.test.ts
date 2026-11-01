/**
 * @failure Review application silently seals a capture or changes retained evidence.
 * @level l2
 * @consumer Internal admin review intake/apply
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import {
  initializeRunDraft,
  recordExecutedProbe,
  type CaptureDecision,
  type CapturedRunDraft,
  type CurrentProbeRun,
  type ProbeSuiteManifest,
} from "@terminfo/probe-defs"
import { retainCaptureBinding, parseRun } from "@terminfo/run-parser"
import { saveDaemonProbeRun } from "../../terminfo.dev/src/capture-writer.ts"

type FixtureCitation = { sourceIndex: number } & (
  | { kind: "git"; repo: "terminfo.dev"; commit: string; path: string; startLine: number; endLine: number }
  | { kind: "external"; root: string; path: string; sha256: string }
  | { kind: "reference"; text: string }
)
type FixtureIndex = {
  run: { sha256: string }
  pending: unknown[]
  decisions: Array<{ source: string; startedAt: string; sha256: string; citations: FixtureCitation[] }>
}

const roots: string[] = []
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})
const temporary = () => {
  const path = mkdtempSync(join(tmpdir(), "terminfo-review-"))
  roots.push(path)
  return path
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex")
const startedAt = "2026-11-01T11:00:00.000Z"
const sourceRepo = join(import.meta.dirname, "../../..")
const sourcePin = spawnSync("git", ["rev-parse", "HEAD"], { cwd: sourceRepo, encoding: "utf8" }).stdout.trim()
// Dispatch fixture only: production suite/hash/cleanliness ownership remains getTrustedSuiteReceipt.
function producerFixture(repo: string, manifest: ProbeSuiteManifest, mode = "valid") {
  const producer = join(repo, "packages/terminfo.dev/src/serve.ts")
  mkdirSync(dirname(producer), { recursive: true })
  writeFileSync(join(repo, "fixture-manifest.json"), JSON.stringify(manifest))
  writeFileSync(join(repo, "AGENTS.md"), "Pinned source fixture\nSecond line\nThird line\n")
  writeFileSync(
    producer,
    `import {readFileSync,existsSync} from "node:fs";
export function getTrustedSuiteReceipt(){
if (${JSON.stringify(mode)} === "dirty" || existsSync(new URL("../../../fixture-refusal.txt",import.meta.url))) throw new Error("Collector source is uncommitted: fixture");
const manifest=JSON.parse(readFileSync(new URL("../../../fixture-manifest.json",import.meta.url),"utf8"));
if (${JSON.stringify(mode)} === "suite") manifest.probeHash="111111111111";
return {manifest,collectorRevision:${mode === "commit" ? '"0".repeat(40)' : "process.env.TERMINFO_SOURCE_REVISION"}}}`,
  )
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.test",
        GIT_COMMITTER_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.test",
      },
    })
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  git("init", "--quiet")
  git("add", "packages/terminfo.dev/src/serve.ts", "AGENTS.md")
  git("commit", "--quiet", "-m", "fixture")
  return { repo, producer, pin: git("rev-parse", "HEAD") }
}
function fixture() {
  const manifest: ProbeSuiteManifest & { schemaVersion: 4 } = {
    schemaVersion: 4,
    probeHash: "abcdef123456",
    sourceRevision: "a".repeat(40),
    generatedAt: startedAt,
    adapterVersion: "test",
    catalogIds: ["device.primary-da", "device.secondary-da"],
    catalogEntrySha256: { "device.primary-da": "a".repeat(64), "device.secondary-da": "b".repeat(64) },
    probes: { term: ["device.primary-da", "device.secondary-da"], lib: [], mux: [] },
  }
  const run: CapturedRunDraft = {
    ...initializeRunDraft({
      source: { kind: "live" },
      runId: "review-fixture",
      sourceRevision: sourcePin,
      manifest,
      intendedSubject: { kind: "term", id: "kitty", version: "1" },
    }),
    subject: {
      kind: "term",
      id: "kitty",
      version: "1",
      os: "linux",
      osVersion: null,
      outerTerminal: null,
      mux: null,
      config: null,
      permissions: null,
    },
    identity: "unverified",
    measuredAt: startedAt,
    origin: { kind: "collector" },
  }
  const featureId = "device.primary-da"
  run.rawReplies[featureId] = "retained reply"
  run.assertions = ["first", "second"].map((note) => ({
    featureId,
    kind: "positive",
    assertionType: "query_reply",
    expected: "retained reply",
    observed: "retained reply",
    rawReplyRef: featureId,
    note,
  }))
  run.results[0] = {
    featureId,
    status: "test-todo",
    reason: "Independent review pending",
    assertionType: "query_reply",
    rawReplyRef: featureId,
    attempt: { scope: "probe", startedAt },
    tests: [
      { id: "capture", status: "supported", assertionRefs: [0, 1], attempt: { scope: "probe", startedAt } },
      { id: "review", status: "test-todo", reason: "Independent review pending", attempt: { scope: "none" } },
    ],
  }
  const binding = retainCaptureBinding(run, featureId, manifest.catalogEntrySha256![featureId])
  const source = JSON.stringify({
    id: "review-decision",
    runId: run.runId,
    featureId,
    captureSha256: binding.sha256,
    evidence: binding.evidence,
    decision: "untestable",
    reviewed: true,
    reviewer: "fixture reviewer",
    reason: "Independent capture review",
    sources: ["retained fixture capture"],
    supersedes: [],
    scope: { subject: { kind: "term", id: "kitty" }, versions: ["1", "1"], suites: [run.probeHash, run.probeHash] },
  })
  return { manifest, run, source }
}

// K1/K2: existing writer tests intentionally seal a completed review, so miss explicit private review output.
test("completed review stays draft only when requested; collector default still seals", () => {
  const { manifest, run, source } = fixture()
  const reviews = { manifest, decisions: [{ source, startedAt }], origin: () => undefined }
  const output = saveDaemonProbeRun(run, temporary(), undefined, { ...reviews, keepDraft: true })
  const bytes = readFileSync(output, "utf8")
  expect(JSON.parse(bytes)).not.toHaveProperty("sealedAt")
  expect(output).toMatch(/\.draft\.json$/)
  expect(
    parseRun(output, bytes, manifest.catalogIds!, new Map([[manifest.probeHash, manifest]]), { mode: "capture" })
      .results?.[0]?.status,
  ).toBe("untestable")
  const collected = saveDaemonProbeRun(run, temporary(), undefined, reviews)
  expect((JSON.parse(readFileSync(collected, "utf8")) as CurrentProbeRun).sealedAt).toEqual(expect.any(String))
})

function intakeFixture(mode = "valid", registered = true) {
  const f = fixture(),
    directory = temporary(),
    registry = join(directory, "suite"),
    output = join(directory, "intake.json")
  mkdirSync(join(registry, "content", "suites"), { recursive: true })
  const manifestPath = join(registry, "content", "suites", `${f.manifest.probeHash}.json`)
  if (registered) writeFileSync(manifestPath, JSON.stringify(f.manifest))
  const { repo, pin, producer } = producerFixture(join(directory, "producer"), f.manifest, mode)
  f.run.sourceRevision = pin
  delete f.run.rawReplies["collector.capture.device.primary-da"]
  delete f.run.rawReplies["collector.evidence.device.primary-da"]
  const binding = retainCaptureBinding(f.run, "device.primary-da", f.manifest.catalogEntrySha256!["device.primary-da"])
  f.source = JSON.stringify({
    ...(JSON.parse(f.source) as CaptureDecision),
    captureSha256: binding.sha256,
    evidence: binding.evidence,
  })
  const input = join(directory, "retained.draft.json")
  const original = `${JSON.stringify(f.run)}\r\n`
  writeFileSync(input, original)
  return {
    ...f,
    directory,
    input,
    original,
    manifestPath,
    producer,
    options: {
      input,
      output,
      suiteRoot: registry,
      context: { kind: "term", id: "kitty", os: "linux" },
      terminfoRepo: repo,
      terminfoCommit: pin,
      termlessRepo: repo,
      termlessCommit: pin,
    },
    applyOptions: { intake: output, output: join(directory, "reviewed"), receipt: join(directory, "receipt.json") },
  }
}
async function prepared(verdict = "supported") {
  const api = await import("./review.ts"),
    f = intakeFixture()
  api.intakeReview(f.options)
  const index = JSON.parse(readFileSync(f.options.output, "utf8")) as FixtureIndex
  const entry = `terminfo.dev@${f.options.terminfoCommit}:AGENTS.md:L1-L3`
  const source = JSON.stringify({ ...(JSON.parse(f.source) as CaptureDecision), decision: verdict, sources: [entry] })
  index.decisions = [
    {
      source,
      startedAt,
      sha256: sha(source),
      citations: [
        {
          kind: "git",
          sourceIndex: 0,
          repo: "terminfo.dev",
          commit: f.options.terminfoCommit,
          path: "AGENTS.md",
          startLine: 1,
          endLine: 3,
        },
      ],
    },
  ]
  return { ...f, api, index, source, save: () => writeFileSync(f.options.output, JSON.stringify(index)) }
}

// R1/R3: writer coverage misses CLI intake selection, exact input custody and independent postchecks.
test.each(["supported", "unsupported", "untestable", "tool-gap"])(
  "intake/apply preserves evidence and downstream files for %s",
  async (verdict) => {
    const f = await prepared(verdict)
    const sentinels = ["selected.json", "admitted.json", "seal.json"].map((name) => join(f.directory, name))
    for (const path of sentinels) writeFileSync(path, "unchanged downstream bytes\n")
    const frozen = readFileSync(f.manifestPath)
    f.save()
    const receipt = f.api.applyReview(f.applyOptions)
    expect(receipt.canonicalReadback).toBe("PASS")
    expect(receipt.downstreamOperationInvoked).toBe(false)
    expect(readFileSync(f.input, "utf8")).toBe(f.original)
    expect(readFileSync(f.manifestPath)).toEqual(frozen)
    for (const path of sentinels) expect(readFileSync(path, "utf8")).toBe("unchanged downstream bytes\n")
    const after = JSON.parse(readFileSync(receipt.output!, "utf8")) as CapturedRunDraft
    expect(after).not.toHaveProperty("sealedAt")
    expect(after.results.map((r: { featureId: string }) => r.featureId)).toEqual(f.run.results.map((r) => r.featureId))
    expect(after.results[1]).toEqual(f.run.results[1])
    expect(after.assertions.slice(0, 2)).toEqual(f.run.assertions)
    expect(after.assertions).toHaveLength(verdict === "supported" || verdict === "unsupported" ? 4 : 2)
    for (const [key, value] of Object.entries(f.run.rawReplies)) expect(after.rawReplies[key]).toBe(value)
    expect(after.rawReplies["collector.review.review-decision"]).toBe(f.source)
    expect(statSync(receipt.output!).mode & 0o077).toBe(0)
    expect(statSync(f.applyOptions.receipt).mode & 0o077).toBe(0)
    expect(() => f.api.applyReview(f.applyOptions)).toThrow(/exist/i)
  },
)

// R2/R4/R5: canonical parser accepts free-text source strings, so cannot enforce index/blob correspondence.
test.each(["decision-hash", "source-entry", "missing-object", "external-sha", "stale-binding"])(
  "refuses %s without rewriting inputs",
  async (fault) => {
    const f = await prepared()
    const indexed = f.index.decisions[0]
    if (!indexed) throw new Error("Fixture requires an indexed decision")
    if (fault === "decision-hash") indexed.source += " "
    if (fault === "source-entry" || fault === "missing-object") {
      const citation = indexed.citations[0]
      if (!citation || citation.kind !== "git") throw new Error("Fixture requires a Git citation")
      if (fault === "source-entry") citation.endLine = 4
      else citation.path = "required-missing-source.ts"
    }
    if (fault === "external-sha") {
      const path = "external.rs"
      writeFileSync(join(f.directory, path), "present tree")
      const source = JSON.stringify({
        ...(JSON.parse(f.source) as CaptureDecision),
        sources: [`${path} sha256:${"0".repeat(64)}`],
      })
      f.index.decisions = [
        {
          source,
          startedAt,
          sha256: sha(source),
          citations: [{ kind: "external", sourceIndex: 0, root: f.directory, path, sha256: "0".repeat(64) }],
        },
      ]
    }
    if (fault === "missing-object") {
      const citation = indexed.citations[0]
      if (!citation || citation.kind !== "git") throw new Error("Fixture requires a Git citation")
      const source = JSON.stringify({
        ...(JSON.parse(f.source) as CaptureDecision),
        sources: [`terminfo.dev@${citation.commit}:${citation.path}:L1-L3`],
      })
      indexed.source = source
      indexed.sha256 = sha(source)
    }
    if (fault === "stale-binding") {
      const run = JSON.parse(f.original) as CapturedRunDraft
      run.rawReplies["device.primary-da"] = "changed reply"
      writeFileSync(f.input, JSON.stringify(run))
      f.index.run.sha256 = sha(JSON.stringify(run))
    }
    f.save()
    const before = readFileSync(f.input)
    expect(() => f.api.applyReview(f.applyOptions)).toThrow(/hash|source|citation|SHA|binding|immutable|resolve/i)
    expect(readFileSync(f.input)).toEqual(before)
  },
)

// R2: existing coverage kept the root present, so missed missing files and non-ENOENT stat failures.
test.each(["absent-root", "present", "missing-file", "invalid-root"])(
  "external source presence is reported truthfully: %s",
  async (state) => {
    const f = await prepared("untestable"),
      path = "optional/engine.rs",
      bytes = "source bytes",
      root = join(f.directory, "external", "tree")
    if (state === "present") {
      mkdirSync(join(root, "optional"), { recursive: true })
      writeFileSync(join(root, path), bytes)
    } else if (state === "missing-file") {
      mkdirSync(root, { recursive: true })
    } else if (state === "invalid-root") {
      writeFileSync(join(f.directory, "external"), "not a directory")
    }
    const source = JSON.stringify({
      ...(JSON.parse(f.source) as CaptureDecision),
      sources: [`${path} sha256:${sha(bytes)}`],
    })
    f.index.decisions = [
      {
        source,
        startedAt,
        sha256: sha(source),
        citations: [{ kind: "external", sourceIndex: 0, root, path, sha256: sha(bytes) }],
      },
    ]
    f.save()
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      if (state === "missing-file" || state === "invalid-root") {
        expect(() => f.api.applyReview(f.applyOptions)).toThrow(
          /decisions\[0\].*citations\[0\].*sources\[0\].*(ENOENT|ENOTDIR)/,
        )
        expect(() => readFileSync(f.applyOptions.receipt)).toThrow(/ENOENT/)
        expect(readFileSync(f.input, "utf8")).toBe(f.original)
        return
      }
      const receipt = f.api.applyReview(f.applyOptions)
      expect(receipt.citations).toContain(
        state === "present" ? `verified: ${path}` : `unverified: ${root} (tree absent)`,
      )
      expect(readFileSync(f.applyOptions.receipt, "utf8")).toContain(state === "present" ? "verified:" : "unverified:")
      expect(diagnostic.mock.calls).toEqual(state === "present" ? [] : [[`unverified: ${root} (tree absent)`]])
    } finally {
      diagnostic.mockRestore()
    }
  },
)

// R2: the source-receipt fallback must not hide registry lookup errors other than ENOENT.
test("registry inspection refuses a non-directory parent instead of falling back", async () => {
  const api = await import("./review.ts"),
    f = intakeFixture("valid", false)
  f.options.suiteRoot = join(f.directory, "blocked-registry")
  writeFileSync(f.options.suiteRoot, "not a directory")
  expect(() => api.intakeReview(f.options)).toThrow(/blocked-registry.*ENOTDIR|ENOTDIR.*blocked-registry/)
  expect(() => readFileSync(f.options.output)).toThrow(/ENOENT/)
})

// Diagnostic fold: invalid later entries must identify their own decision, before any postimage write.
test("a non-object decision identifies its index", async () => {
  const f = await prepared()
  writeFileSync(f.options.output, JSON.stringify({ ...f.index, decisions: [...f.index.decisions, null] }))
  expect(() => f.api.applyReview(f.applyOptions)).toThrow(/decisions\[1\].*record/)
  expect(() => readFileSync(f.applyOptions.receipt)).toThrow(/ENOENT/)
})

// R1/R6: no writer test exercises an explicit empty issuer scope or ambiguous pass rawRun selection.
test("empty intake/apply is explicit and pass selection refuses absent or mismatched contexts", async () => {
  const api = await import("./review.ts"),
    f = intakeFixture()
  const run = structuredClone(f.run)
  run.results[0] = structuredClone(run.results[1]!)
  run.results[0]!.featureId = "device.primary-da"
  run.assertions = []
  run.rawReplies = {}
  writeFileSync(f.input, JSON.stringify(run))
  api.intakeReview(f.options)
  const index = JSON.parse(readFileSync(f.options.output, "utf8")) as FixtureIndex
  expect(index.pending).toEqual([])
  expect(index.decisions).toEqual([])
  expect(api.applyReview(f.applyOptions)).toMatchObject({ output: null, decisionsApplied: 0, empty: true })
  const pass = join(f.directory, "pass.json")
  for (const contexts of [
    [],
    [{ context: f.options.context }],
    [{ context: { kind: "term", id: "other", os: "linux" }, rawRun: f.input }],
  ]) {
    writeFileSync(
      pass,
      JSON.stringify({ probeHash: f.manifest.probeHash, sourceRevision: f.run.sourceRevision, contexts }),
    )
    expect(() => api.intakeReview({ ...f.options, input: pass, output: join(f.directory, "unused.json") })).toThrow(
      /context|rawRun/i,
    )
  }
})

// R6: function tests cannot catch missing CLI registration or diagnostics contaminating JSON stdout.
test("review CLI offers help, emits JSON only, and reports missing resources on stderr", () => {
  const f = intakeFixture(),
    entry = join(import.meta.dirname, "index.ts")
  const invoke = (args: string[]) => spawnSync(process.execPath, [entry, "review", ...args], { encoding: "utf8" })
  const help = invoke(["intake", "--help"])
  expect(help.status).toBe(0)
  expect(help.stdout).toContain("--suite-root")
  expect(help.stdout).toMatch(/pinned-source\s+receipt/)
  const flags = [
    "--input",
    f.input,
    "--context",
    JSON.stringify(f.options.context),
    "--suite-root",
    f.options.suiteRoot,
    "--terminfo-repo",
    f.options.terminfoRepo,
    "--terminfo-commit",
    f.options.terminfoCommit,
    "--termless-repo",
    f.options.termlessRepo,
    "--termless-commit",
    f.options.termlessCommit,
    "--output",
    f.options.output,
  ]
  // The CLI parser owns flag diagnostics; direct intake calls cannot catch a missing --context label.
  for (const context of [
    "{",
    "{}",
    '{"kind":"term","id":"kitty"}',
    '{"kind":"mux","id":"tmux"}',
    '{"kind":"term","os":"linux"}',
    '{"id":"kitty","os":"linux"}',
  ]) {
    const malformed = [...flags]
    malformed[malformed.indexOf("--context") + 1] = context
    const rejected = invoke(["intake", ...malformed])
    expect(rejected.status).not.toBe(0)
    expect(rejected.stdout).toBe("")
    expect(rejected.stderr).toContain("--context")
  }
  const intake = invoke(["intake", ...flags])
  expect(intake.status, intake.stderr).toBe(0)
  expect(JSON.parse(intake.stdout)).toMatchObject({ pending: 1 })
  const applied = invoke([
    "apply",
    "--intake",
    f.options.output,
    "--output",
    f.applyOptions.output,
    "--receipt",
    f.applyOptions.receipt,
  ])
  expect(applied.status, applied.stderr).toBe(0)
  expect(JSON.parse(applied.stdout)).toMatchObject({ empty: true, output: null })
  const failure = invoke([
    "apply",
    "--intake",
    join(f.directory, "absent.json"),
    "--output",
    f.applyOptions.output,
    "--receipt",
    join(f.directory, "failure.json"),
  ])
  expect(failure.status).not.toBe(0)
  expect(failure.stdout).toBe("")
  expect(failure.stderr).toContain("absent.json")
})

// R1/R4: a valid Git object is not proof it is this capture's source; failed pass leftovers are not inputs.
test.each(["pin", "failed-pass", "reference-bypass"])("refuses misleading source provenance: %s", async (fault) => {
  const f = await prepared()
  if (fault === "pin") {
    const parent = spawnSync("git", ["rev-parse", "HEAD^"], { cwd: sourceRepo, encoding: "utf8" }).stdout.trim()
    expect(() =>
      f.api.intakeReview({ ...f.options, output: join(f.directory, "other.json"), terminfoCommit: parent }),
    ).toThrow(/source|pin/i)
  } else if (fault === "failed-pass") {
    const pass = join(f.directory, "failed-pass.json")
    writeFileSync(
      pass,
      JSON.stringify({
        probeHash: f.manifest.probeHash,
        sourceRevision: f.run.sourceRevision,
        contexts: [{ context: f.options.context, status: "failed", rawRun: f.input }],
      }),
    )
    expect(() => f.api.intakeReview({ ...f.options, input: pass, output: join(f.directory, "other.json") })).toThrow(
      /status|failed|measured/i,
    )
  } else {
    const indexed = f.index.decisions[0],
      entry = (JSON.parse(f.source) as CaptureDecision).sources[0]
    if (!indexed || entry === undefined) throw new Error("Fixture requires an indexed decision and source entry")
    indexed.citations = [{ kind: "reference", sourceIndex: 0, text: entry }]
    f.save()
    expect(() => f.api.applyReview(f.applyOptions)).toThrow(/code|citation|classification/i)
  }
})

// R1/R2 amendment: registry tests miss dispatch to the pinned producer and its explicit refusal/mismatch.
// This tiny producer fixture tests the wrapper only; real getTrustedSuiteReceipt evidence is separate.
test.each(["valid", "suite", "commit", "dirty"])(
  "unregistered private capture uses pinned producer: %s",
  async (mode) => {
    const api = await import("./review.ts"),
      f = intakeFixture(mode, false)
    const opts = f.options,
      producer = f.producer,
      pin = opts.terminfoCommit
    if (mode !== "valid") {
      expect(() => api.intakeReview(opts)).toThrow(
        mode === "dirty" ? /uncommitted/ : mode === "suite" ? /receipt suite mismatch/ : /receipt commit mismatch/,
      )
    } else {
      const result = api.intakeReview(opts),
        index = JSON.parse(readFileSync(opts.output, "utf8")) as FixtureIndex
      expect(result.manifest).toMatchObject({
        kind: "source-receipt",
        producer,
        pin,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
      expect(index.pending).toHaveLength(1)
      expect(api.applyReview(f.applyOptions)).toMatchObject({ manifest: result.manifest, empty: true })
    }
  },
)

// R3: ordinary observation reviews duplicate assertions; the approved semantic source route must not.
test("semantic source review retains no invented observation assertions", async () => {
  const api = await import("./review.ts"),
    f = intakeFixture(),
    featureId = "extensions.osc133-a"
  const manifest = {
    ...f.manifest,
    catalogIds: [featureId],
    catalogEntrySha256: { [featureId]: "a".repeat(64) },
    probes: { term: [], lib: [featureId], mux: [] },
  }
  const run: CapturedRunDraft = {
    ...f.run,
    intendedSubject: { kind: "lib", id: "vt100", version: "1" },
    subject: { ...f.run.subject, kind: "lib", id: "vt100" },
    assertions: [],
    rawReplies: { [featureId]: '{"mark":"parser state"}' },
    runtimeIdentity: {
      kind: "js",
      runtimeFormat: "wasm",
      engineVersion: "1",
      adapterVersion: "1",
      termlessRevision: sourcePin,
      adapterSources: [{ path: "packages/vt100/src/index.ts", blobOid: "b".repeat(40) }],
      resolvedPath: "/fixtures/engine.js",
      integrity: {
        kind: "source",
        repository: "fixture",
        revision: "3".repeat(40),
        treeOid: "4".repeat(40),
        cleanTree: true,
      },
      loadedBinary: { path: "/fixtures/engine.wasm", sha256: "a".repeat(64) },
    },
    results: [
      recordExecutedProbe({
        featureId,
        attempt: { scope: "probe", startedAt },
        assertions: [],
        tests: [{ id: "review", status: "test-todo", reason: "Independent source review pending" }],
        criterionBranch: "semantic-prompt-source-review",
      }),
    ],
  }
  const binding = retainCaptureBinding(run, featureId, "a".repeat(64))
  writeFileSync(f.input, JSON.stringify(run))
  writeFileSync(f.manifestPath, JSON.stringify(manifest))
  writeFileSync(join(f.options.terminfoRepo, "fixture-manifest.json"), JSON.stringify(manifest))
  api.intakeReview({ ...f.options, context: { kind: "lib", id: "vt100", os: "linux" } })
  const index = JSON.parse(readFileSync(f.options.output, "utf8")) as FixtureIndex,
    text = "Independent source row names parser arm and mark state"
  const source = JSON.stringify({
    ...(JSON.parse(f.source) as CaptureDecision),
    featureId,
    captureSha256: binding.sha256,
    evidence: binding.evidence,
    decision: "supported",
    sources: [text],
    scope: { subject: { kind: "lib", id: "vt100" }, versions: ["1", "1"], suites: [run.probeHash, run.probeHash] },
  })
  index.decisions = [
    { source, startedAt, sha256: sha(source), citations: [{ kind: "reference", sourceIndex: 0, text }] },
  ]
  writeFileSync(f.options.output, JSON.stringify(index))
  const receipt = api.applyReview(f.applyOptions),
    output = JSON.parse(readFileSync(receipt.output!, "utf8")) as CapturedRunDraft
  const result = output.results[0],
    review = result?.tests[0]
  if (!result || !review) throw new Error("Fixture requires a reviewed result")
  expect(output.assertions).toEqual([])
  expect(review.assertionRefs).toEqual([])
  expect(result.status).toBe("supported")
  expect(output.rawReplies[`collector.review.review-decision`]).toBe(source)
})

// R3 amendment: registry presence must never bypass the pinned producer's cleanliness/loaded-suite checks.
test.each(["dirty", "catalogue"])("registry still checks its pinned source: %s", async (mode) => {
  const api = await import("./review.ts"),
    f = intakeFixture()
  if (mode === "dirty") writeFileSync(join(f.options.terminfoRepo, "fixture-refusal.txt"), "explicit producer refusal")
  else {
    const manifest = {
      ...f.manifest,
      catalogEntrySha256: { ...f.manifest.catalogEntrySha256, "device.primary-da": "0".repeat(64) },
    }
    writeFileSync(f.manifestPath, JSON.stringify(manifest))
  }
  expect(() => api.intakeReview(f.options)).toThrow(mode === "dirty" ? /uncommitted/ : /registry.*identity/i)
})

// R1: self-reported clean state cannot prove the filesystem producer is the pinned Git blob.
// The refusal propagation case above leaves producer bytes intact and misses this substitution.
test("refuses altered producer bytes even when they return the same trusted receipt", async () => {
  const api = await import("./review.ts"),
    f = intakeFixture()
  writeFileSync(f.producer, `${readFileSync(f.producer, "utf8")}\n// locally altered producer\n`)
  expect(() => api.intakeReview(f.options)).toThrow(
    `Source receipt producer bytes differ from pinned source: ${f.producer}@${f.options.terminfoCommit}`,
  )
})
