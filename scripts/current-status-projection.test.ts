/**
 * @failure Historical rows are selected as current, or stored TODO/failure disappear from current scores.
 * @level l2
 * @consumer Current result selector, API v3 and site build
 * @testonly none
 * @reach fs-read vendor/terminfo.dev/test-fixtures/probes-apps/** vendor/terminfo.dev/content/features.json vendor/terminfo.dev/content/suites/**
 */
import { describe, expect, it } from "vitest"
import { parseRun, parseSuiteManifest } from "@terminfo/run-parser"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { publicResults, type EvidenceDocument } from "../docs/data/public-results.ts"
import type { ProbeResult, ProbeSuiteManifest, TextQualification } from "@terminfo/probe-defs"
import { ENVIRONMENT_GROUP_IDS } from "@terminfo/probe-defs"
import { projectResults, maskRunnerStorePath } from "../docs/data/selected-results.ts"
import { currentCoverageSentence } from "../docs/data/release-scope.ts"

// Explicit schema-3 wire fixture; current public results use tests and assertionType.
type Schema3Result = Omit<ProbeResult, "tests" | "assertionType"> & { checks: ProbeResult["tests"]; evidence?: string }
const ids = Array.from({ length: 273 }, (_, index) => `capability.${index}`)
const suite: ProbeSuiteManifest = {
  probeHash: "current-five-status",
  sourceRevision: "1".repeat(40),
  generatedAt: "2026-10-21T05:00:00.000Z",
  adapterVersion: "3.3.2",
  catalogIds: ids,
  probes: { term: [], lib: [], mux: [] },
}
const attempt = { scope: "probe" as const, startedAt: "2026-10-21T05:00:00.000Z" }
const raw = (results: Schema3Result[]) => ({
  schemaVersion: 3,
  runId: "current-run",
  target: {
    kind: "app",
    id: "kitty",
    version: "0.46.2",
    os: "macos",
    osVersion: null,
    outerTerminal: null,
    mux: null,
    config: null,
    permissions: null,
  },
  intendedContext: { kind: "app", id: "kitty" },
  identity: "verified",
  suiteId: suite.probeHash,
  probeHash: suite.probeHash,
  sourceRevision: suite.sourceRevision,
  measuredAt: "2026-10-21T05:00:00.000Z",
  sealedAt: "2026-10-21T05:00:01.000Z",
  origin: { kind: "collector" },
  rawReplies: { "device.primary-da": "\u001b[?62;52;c", "device.xtversion": "kitty(0.46.2)" },
  assertions: [],
  screenshotRefs: [],
  results,
})
const parse = (value: object) =>
  parseRun("fixture.json", JSON.stringify(value), ids, new Map([[suite.probeHash, suite]]))
const todos = (): Schema3Result[] =>
  ids.map((featureId) => ({
    featureId,
    status: "test-todo",
    attempt: { scope: "none" },
    checks: [],
    reason: "No implementation",
  }))
// Existing selection tests exercise v1/v2 observation grading; they cannot prove that v3 selection
// reads the stored five statuses and frozen denominator without applying later interpretations.
describe("current execution projection", () => {
  // #31594 AC1/AC2: whole-run fixtures cannot expose a partial run erasing untouched evidence.
  // The existing parser/projection seam must retain cells, not select the best-looking result.
  it.each(["test-failure", "test-todo"] as const)(
    "composes selected %s with original unselected and unreached results from two runs",
    (status) => {
      const baselineResults = todos()
      const baseline = raw(baselineResults)
      const assertions = ids.slice(0, 4).map((featureId) => ({
        featureId,
        kind: "positive",
        rawReplyRef: featureId,
        expected: "ACK",
        observed: "ACK",
      }))
      for (const [index, featureId] of ids.slice(0, 4).entries()) {
        baselineResults[index] = {
          featureId,
          status: "supported",
          evidence: "query",
          rawReplyRef: featureId,
          attempt,
          checks: [{ id: "criterion", status: "supported", attempt, assertionRefs: [index], rawReplyRef: featureId }],
        }
      }
      const prior = parse({
        ...baseline,
        runId: "baseline-run",
        assertions,
        rawReplies: { ...baseline.rawReplies, ...Object.fromEntries(ids.slice(0, 4).map((id) => [id, "ACK"])) },
      })
      const nextResults = todos()
      const emittedAttempt = { scope: "probe" as const, startedAt: "2026-10-21T06:00:00.000Z" }
      nextResults[0] = {
        featureId: ids[0]!,
        status,
        attempt: emittedAttempt,
        checks: [
          {
            id: "criterion",
            status,
            attempt: status === "test-todo" ? { scope: "none" } : emittedAttempt,
            reason: "Selected callback retained this outcome",
          },
        ],
        reason: "Selected callback retained this outcome",
      }
      nextResults[3] = {
        featureId: ids[3]!,
        status: "test-todo",
        attempt: emittedAttempt,
        checks: [
          { id: "criterion", status: "test-todo", attempt: { scope: "none" }, reason: "Observable unavailable" },
        ],
        reason: "Observable unavailable",
      }
      const selectedIds = [ids[0]!, ids[2]!, ids[3]!]
      const next = raw(nextResults)
      const latest = parse({
        ...next,
        runId: "selected-run",
        measuredAt: "2026-10-21T06:00:00.000Z",
        sealedAt: "2026-10-21T06:00:01.000Z",
        rawReplies: {
          ...next.rawReplies,
          "collector.selection": JSON.stringify({ ids: selectedIds }),
          "collector.collectionAttempt": JSON.stringify({
            ids: selectedIds,
            startedAt: "2026-10-21T06:00:00.000Z",
            result: "failed",
            error: "Worker stopped before the third selected callback",
          }),
        },
      })
      const projection = projectResults([prior, latest], [], ids, { currentProbeHash: suite.probeHash }, [])
      const current = projection.current["term:kitty"]!
      expect(current.results.find((result) => result.featureId === ids[0])?.status).toBe(status)
      expect(current.results.find((result) => result.featureId === ids[1])).toBe(prior.results?.[1])
      expect(current.results.find((result) => result.featureId === ids[2])).toBe(prior.results?.[2])
      expect(current.results.find((result) => result.featureId === ids[3])).toBe(latest.results?.[3])
      expect(prior.rawReplies[ids[1]!]).toBe("ACK")
      expect(prior.assertions[1]?.featureId).toBe(ids[1])
    },
  )

  it("keeps every TODO visible over all 273 and admits current identity using the existing measured rule", () => {
    const run = parse(raw(todos()))
    const projection = projectResults(
      [run],
      [],
      ["different-live-catalogue"],
      { currentProbeHash: suite.probeHash },
      [],
    )
    const selected = projection.current["term:kitty"]
    expect(selected?.results).toEqual(run.results)
    expect(selected?.score).toEqual({ supported: 0, all: 273 })
    expect(selected?.counts["test-todo"]).toBe(273)
    expect(selected?.complete).toBe(false)
    expect(projection.table[run.runId]).toEqual(Object.fromEntries(ids.map((id) => [id, "test-todo"])))
  })
  it("retains an actual failed check alongside TODO without a decisive assertion hiding either", () => {
    const results = todos()
    results[0] = {
      featureId: ids[0]!,
      status: "test-failure",
      attempt,
      checks: [{ id: "collection", status: "test-failure", attempt, reason: "callback threw" }],
      reason: "callback threw",
    }
    const projection = projectResults([parse(raw(results))], [], ids, { currentProbeHash: suite.probeHash }, [])
    expect(projection.current["term:kitty"]?.counts).toEqual({
      supported: 0,
      unsupported: 0,
      untestable: 0,
      "test-todo": 272,
      "test-failure": 1,
    })
    expect(projection.current["term:kitty"]?.complete).toBe(false)
  })
  it("can finish all unsupported at zero supported out of 273, without excluding capabilities", () => {
    const value = raw(
      ids.map((featureId, index) => ({
        featureId,
        status: "unsupported",
        evidence: "query",
        rawReplyRef: featureId,
        attempt,
        checks: [{ id: "criterion", status: "unsupported", attempt, assertionRefs: [index], rawReplyRef: featureId }],
      })),
    )
    for (const featureId of ids) value.rawReplies[featureId as keyof typeof value.rawReplies] = "NO"
    const assertions = ids.map((featureId) => ({
      featureId,
      kind: "negative",
      rawReplyRef: featureId,
      expected: "ACK",
      observed: "NO",
    }))
    const projection = projectResults(
      [parse({ ...value, assertions })],
      [],
      ids,
      { currentProbeHash: suite.probeHash },
      [],
    )
    expect(projection.current["term:kitty"]?.score).toEqual({ supported: 0, all: 273 })
    expect(projection.current["term:kitty"]?.counts.unsupported).toBe(273)
    expect(projection.current["term:kitty"]?.complete).toBe(true)
  })
  it("leaves a corpus of only legacy runs with no current row and no invented current score", () => {
    const { results: _results, sealedAt: _sealedAt, ...metadata } = raw([])
    const legacy = parse({ ...metadata, schemaVersion: 2, observations: [], suiteComplete: true })
    const projection = projectResults([legacy], [], ids, { currentProbeHash: suite.probeHash }, [])
    expect(projection.current).toEqual({})
    expect(projection.versions).toEqual({})
    expect(projection.history).toEqual({})
    // The legacy run is read only for input identity, never projected into a row of its own.
    expect(projection.table[legacy.runId]).toBeUndefined()
  })

  it("grades a 273-row run over its 264 graded ids and never counts an environment group", () => {
    const supportedGroup = ENVIRONMENT_GROUP_IDS[0]
    const splitIds = [...ENVIRONMENT_GROUP_IDS, ...Array.from({ length: 264 }, (_, index) => `capability.${index}`)]
    const results: Schema3Result[] = splitIds.map((featureId) =>
      featureId === supportedGroup
        ? {
            featureId,
            status: "supported",
            evidence: "query",
            rawReplyRef: featureId,
            attempt,
            checks: [{ id: "criterion", status: "supported", attempt, assertionRefs: [0], rawReplyRef: featureId }],
          }
        : { featureId, status: "test-todo", attempt: { scope: "none" }, checks: [], reason: "No implementation" },
    )
    const splitSuite: ProbeSuiteManifest = { ...suite, catalogIds: splitIds }
    const base = raw(results)
    const value = {
      ...base,
      rawReplies: { ...base.rawReplies, [supportedGroup]: "OK" },
      assertions: [
        { featureId: supportedGroup, kind: "positive", rawReplyRef: supportedGroup, expected: "OK", observed: "OK" },
      ],
    }
    const run = parseRun("fixture.json", JSON.stringify(value), splitIds, new Map([[splitSuite.probeHash, splitSuite]]))
    const projection = projectResults([run], [], splitIds, { currentProbeHash: suite.probeHash }, [])
    const selected = projection.current["term:kitty"]
    // The supported-looking environment row stays recorded, and never graded: numerator and
    // denominator both cover the same 264 ids (CTO condition, verdict 427f2da3).
    expect(selected?.results.find((result) => result.featureId === supportedGroup)?.status).toBe("supported")
    expect(currentCoverageSentence(selected!, selected!.catalogIds)).not.toContain("NOT MEASURED")
    expect(selected?.score).toEqual({ supported: 0, all: 264 })
    expect(selected?.counts).toEqual({
      supported: 0,
      unsupported: 0,
      untestable: 0,
      "test-todo": 264,
      "test-failure": 0,
    })
    expect(selected?.complete).toBe(false)
  })
})

// An unchanged reviewed default key must still identify its canonical subject after the rename.
it("normalizes historical reviewed context keys without rewriting arbitrary configuration text", () => {
  expect(maskRunnerStorePath('app:kitty@["app","kitty","macos",null,null,null,null,null]')).toBe(
    'term:kitty@["term","kitty","macos",null,null,null,null,null]',
  )
  expect(maskRunnerStorePath('headless:xtermjs@["headless","xtermjs","linux",null,null,null,null,null]')).toBe(
    'lib:xtermjs@["lib","xtermjs","linux",null,null,null,null,null]',
  )
  expect(maskRunnerStorePath("app:keep-this-config")).toBe("app:keep-this-config")
})

it("retains the recorded live source only on selected schema-4 metadata", () => {
  const historical = raw(todos())
  const { target, intendedContext, results, ...metadata } = historical
  const current = {
    ...metadata,
    schemaVersion: 4,
    source: { kind: "live" },
    subject: { ...target, kind: "term" },
    intendedSubject: { ...intendedContext, kind: "term" },
    results: results.map(({ checks, ...result }) => ({ ...result, tests: checks })),
  }
  const loaded = parseRun(
    "live.json",
    JSON.stringify(current),
    ids,
    new Map([[suite.probeHash, { ...suite, schemaVersion: 4 }]]),
  )
  const selected = projectResults([loaded], [], ids, { currentProbeHash: suite.probeHash }, []).current["term:kitty"]
  expect(selected?.schemaVersion).toBe(4)
  expect(selected?.source).toEqual({ kind: "live" })
  const oldSelected = projectResults([parse(historical)], [], ids, { currentProbeHash: suite.probeHash }, []).current[
    "term:kitty"
  ]
  expect(oldSelected?.schemaVersion).toBe(3)
  expect(oldSelected).not.toHaveProperty("source")
})

// The historical failed text read retained qualification but no frame. Existing mapper cases with
// frames cannot detect losing that link when the old evidence label is decoded privately.
it("keeps the retained failed text read's qualification link without widening current frame requirements", () => {
  const root = join(import.meta.dirname, "..")
  const path = join(root, "test-fixtures/probes-apps/terminal-app-2.15-macos-81d7321e92df660ce1c01931bebedbd2.json")
  const bytes = readFileSync(path, "utf8")
  const wire = JSON.parse(bytes) as {
    probeHash: string
    results: Array<{ featureId: string; evidence?: string; status: string; frames?: unknown }>
    textQualification: TextQualification
  }
  const historicalResult = wire.results.find((result) => result.featureId === "charsets.utf8")
  if (!historicalResult) throw new Error("Historical text failure fixture is missing")
  expect(historicalResult.evidence).toBe("text")
  expect(historicalResult.status).toBe("test-failure")
  expect(historicalResult.frames).toBeUndefined()
  const manifestPath = join(root, "content/suites", `${wire.probeHash}.json`)
  const manifest = parseSuiteManifest(manifestPath, readFileSync(manifestPath, "utf8"))
  const catalogIds = Object.keys(
    JSON.parse(readFileSync(join(root, "content/features.json"), "utf8")) as Record<string, unknown>,
  )
  const run = parseRun(path, bytes, catalogIds, new Map([[manifest.probeHash, manifest]]))
  const projection = projectResults([run], [], catalogIds, { currentProbeHash: manifest.probeHash }, [])
  const selected = Object.values(projection.history)
    .flat()
    .find((version) => version.runId === run.runId)
  if (!selected) throw new Error("Retained fixture was not projected")
  selected.presentations["charsets.utf8"] = {
    id: "review-text-failure",
    reviewer: "fixture",
    reason: "Present retained failure",
    sources: [],
    presentsEvidence: true,
  }
  const published = publicResults(projection, new Map())
  const evidenceUrl = `/api/v3/evidence/${run.sha256}.json`
  const document = published.documents.get(evidenceUrl)?.document as EvidenceDocument
  const cell = document.cells["charsets.utf8"]
  if (!cell) throw new Error("Presented fixture result is missing")
  const qualification = cell.textQualification
  expect(qualification).toEqual({
    url: `/api/v3/evidence/${run.sha256}/text-qualification.json`,
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  })
  if (!qualification) throw new Error("Historical qualification link is missing")
  expect(published.documents.get(qualification.url)?.document).toMatchObject({ qualification: wire.textQualification })
  expect(cell.result.status).toBe("test-failure")
  expect(cell.result).not.toHaveProperty("evidence")

  // A current result has no historical qualification fact: a real text-cells frame is still needed.
  const current = globalThis.structuredClone(projection)
  const currentVersion = Object.values(current.history)
    .flat()
    .find((version) => version.runId === run.runId)
  if (!currentVersion) throw new Error("Current mapper fixture is missing")
  currentVersion.schemaVersion = 4
  currentVersion.source = { kind: "live" }
  const currentDocument = publicResults(current, new Map()).documents.get(evidenceUrl)?.document as EvidenceDocument
  expect(currentDocument.cells["charsets.utf8"]?.textQualification).toBeUndefined()
  const framed = run.results?.find((result) => result.frames?.some((frame) => frame.kind === "text-cells"))
  const currentResult = currentVersion.results.find((result) => result.featureId === "charsets.utf8")
  if (!framed || !currentResult) throw new Error("Current text frame mapper fixture is missing")
  currentResult.frames = globalThis.structuredClone(framed.frames)
  const framedDocument = publicResults(current, new Map()).documents.get(evidenceUrl)?.document as EvidenceDocument
  expect(framedDocument.cells["charsets.utf8"]?.textQualification).toEqual(qualification)
})
