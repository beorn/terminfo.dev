/**
 * @failure A missing, malformed, stale, or disputed run silently becomes a positive/negative terminal claim.
 * @level l2
 * @consumer Site, API, analysis, and reviewed census import.
 * @testonly none
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadSelectedResults as loadCurrentSelectedResults,
  parseInterpretations,
  projectHistoricalResults as projectResults,
  readVerifiedArtifact,
} from "../docs/data/selected-results.ts"
import { assessRunAdmission, planAdmission } from "./admit-run.ts"
import { publicHistoricalResults as publicResults, readCellEvidence } from "../docs/data/public-results.ts"
import { loadFeatures } from "@terminfo/catalog"
import { aggregateCells, classifyCell, isStaleRelation } from "../docs/data/release-scope.ts"
import {
  decodeHistoricalCollectorRun as decodeCollectorRun,
  decodeExactUtf8,
  parseRun as parseRunSource,
} from "@terminfo/run-parser"
import type { ObservationFrame, ProbeSuiteManifest } from "@terminfo/probe-defs"
import { readRetainedDaemonProbeResponse, saveDaemonProbeRun } from "../packages/terminfo.dev/src/daemon-client.ts"
import { probeSuiteSnapshot } from "../packages/admin/versions.ts"
import * as suiteManifest from "../packages/admin/suite-manifest.ts"
import muxIdentity from "../packages/terminfo.dev/src/fixtures/mux-identity.json"

// These immutable v1/v2 fixtures exercise the explicit historical reader and historical public API.
const loadSelectedResults = (...args: Parameters<typeof loadCurrentSelectedResults>) =>
  loadCurrentSelectedResults(...args).historical

const catalog = ["cursor.position", "extensions.graphics", "extensions.query"]
/** 28240: the app-launch receipt parser refuses a placeholder digest (one repeated character), so
 * these receipt fixtures carry a two-character cycle where they used to carry "a".repeat(64). */
const RECEIPT_EXECUTABLE_SHA256 = "a1".repeat(32)
const RECEIPT_SOURCE_SHA256 = "b2".repeat(32)
const manifest = (probeHash: string, ids = ["extensions.graphics", "extensions.query"]): ProbeSuiteManifest => ({
  probeHash,
  sourceRevision: "1".repeat(40),
  generatedAt: "2026-09-28T00:00:00.000Z",
  adapterVersion: "3.3.1",
  catalogIds: catalog,
  probes: { app: ids, headless: ids, mux: ids },
})
const manifests = new Map([
  ["current", manifest("current")],
  ["old", manifest("old")],
  ["state", manifest("state", ["cursor.position"])],
  ["pixels", manifest("pixels", ["extensions.graphics"])],
  ["query", manifest("query", ["extensions.query"])],
  ["with-diagnostic", manifest("with-diagnostic", ["extensions.graphics", "extensions.query", "cursor.position"])],
  ["a8bafe49cdd4", manifest("a8bafe49cdd4")],
  ["21739d9e768f", manifest("21739d9e768f")],
  ["9918f283121a", manifest("9918f283121a")],
  ["tree", manifest("tree")],
  ["release", manifest("release")],
])
const parseRun = (path: string, source: string, catalogIds: readonly string[]) =>
  parseRunSource(path, source, catalogIds, manifests)
const target = {
  kind: "app" as const,
  id: "kitty",
  version: "0.46.2",
  os: "macos",
  osVersion: "25.4.0",
  outerTerminal: null,
  mux: null,
  config: null,
  permissions: null,
}
const identityReplies = { "device.primary-da": "\u001b[?62;52;c", "device.xtversion": "kitty(0.46.2)" }
const observation = (
  featureId: string,
  outcome: "supported" | "unsupported" | "inconclusive" | "error",
  evidence: "query" | "behavior",
  reason?: "timeout",
) => ({ featureId, outcome, evidence, ...(reason && { reason }), rawReplyRef: featureId })
const run = (runId: string, overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  runId,
  target,
  identity: "verified",
  suiteId: "suite-2",
  probeHash: "current",
  suiteComplete: true,
  sourceRevision: "2".repeat(40),
  measuredAt: "2026-09-28T12:00:00.000Z",
  origin: { kind: "collector" },
  rawReplies: { ...identityReplies, "extensions.query": "ACK", "extensions.graphics": "NO", "cursor.position": "" },
  assertions: [
    {
      featureId: "extensions.query",
      kind: "positive",
      rawReplyRef: "extensions.query",
      expected: "ACK",
      observed: "ACK",
    },
    {
      featureId: "extensions.graphics",
      kind: "negative",
      rawReplyRef: "extensions.graphics",
      expected: "ACK",
      observed: "NO",
    },
  ],
  screenshotRefs: [],
  observations: [
    observation("extensions.query", "supported", "query"),
    observation("extensions.graphics", "unsupported", "behavior"),
  ],
  ...overrides,
})
const reviewFor = (value: ReturnType<typeof parseRun>) => ({
  id: `review-${value.runId}`,
  runId: value.runId,
  runSha256: value.sha256,
  reviewer: "reviewer",
  reason: "checked captured identity",
  scope: {
    target: { kind: value.target.kind, id: value.target.id },
    versions: [value.target.version, value.target.version] as [string, string],
    suites: [value.suiteId, value.suiteId] as [string, string],
  },
  sources: [value.path],
  supersedes: [],
  verifiesIdentity: true,
  reviewed: true,
})

const contentDirs: string[] = []
afterEach(() => {
  for (const path of contentDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

function temporaryContent() {
  const path = mkdtempSync(join(tmpdir(), "terminfo-selected-"))
  contentDirs.push(path)
  for (const name of ["probes-apps", "probes-mux", "probes-libs", "artifacts", "suites"]) mkdirSync(join(path, name))
  for (const [hash, declaration] of manifests) {
    writeFileSync(join(path, "suites", `${hash}.json`), JSON.stringify(declaration))
  }
  // @terminfo/catalog's one shape requires a full record per row; this fixture only reads the ids.
  writeFileSync(
    join(path, "features.json"),
    JSON.stringify(
      Object.fromEntries(
        catalog.map((id) => [
          id,
          { name: id, slug: id.replaceAll(".", "-"), body: "fixture", probe: "fixture", baseline: "supported" },
        ]),
      ),
    ),
  )
  return path
}

describe("selected results", () => {
  it("selects collector-only identity while keeping subsets in history and refusing explicit DA1 conflicts", () => {
    const rawReplies = {
      "collector.xtversion": "\x1bP>|kitty(0.46.2)\x1b\\\x1b[?62;52;c",
      "extensions.query": "ACK",
      "extensions.graphics": "NO",
    }
    const complete = parseRun("collector-only.json", JSON.stringify(run("collector-only", { rawReplies })), catalog)
    const partial = parseRun(
      "collector-subset.json",
      JSON.stringify(
        run("collector-subset", {
          rawReplies,
          suiteComplete: false,
          observations: [observation("extensions.query", "supported", "query")],
        }),
      ),
      catalog,
    )
    const conflicting = parseRun(
      "collector-conflict.json",
      JSON.stringify(
        run("collector-conflict", {
          rawReplies: { ...rawReplies, "device.primary-da": "\x1b[?1;2c" },
        }),
      ),
      catalog,
    )
    const disagreement = parseRun(
      "collector-disagreement.json",
      JSON.stringify(
        run("collector-disagreement", {
          rawReplies: { ...rawReplies, "device.primary-da": "\x1b[?62;4;c" },
        }),
      ),
      catalog,
    )
    const candidates = [complete, partial, conflicting, disagreement]
    const projection = projectResults(candidates, candidates.map(reviewFor), catalog, { currentProbeHash: "current" })
    expect(projection.current["app:kitty"]?.runId).toBe("collector-only")
    expect(projection.versions["app:kitty"]?.map((value) => value.runId)).toEqual(["collector-only"])
    expect(projection.history["app:kitty"]?.map((value) => value.runId).sort()).toEqual(
      ["collector-only", "collector-subset", "collector-conflict", "collector-disagreement"].sort(),
    )
    expect(projection.exclusions).toEqual([
      { runId: partial.runId, path: partial.path, reason: "suite-incomplete" },
      { runId: conflicting.runId, path: conflicting.path, reason: "identity-replies-mismatch" },
      { runId: disagreement.runId, path: disagreement.path, reason: "identity-replies-mismatch" },
    ])
  })

  it("rejects conclusive v2 consumed or legacy claims without measured assertions", () => {
    const base = run("claimed", {
      identity: "unverified",
      suiteId: "current",
      sourceRevision: "a".repeat(40),
      assertions: [],
      observations: [{ featureId: "extensions.query", outcome: "supported", evidence: "consumed" }],
      suiteComplete: false,
    })
    for (const evidence of ["consumed", "legacy"]) {
      expect(() =>
        decodeCollectorRun(
          `${evidence}.json`,
          JSON.stringify({
            ...base,
            observations: [{ featureId: "extensions.query", outcome: "supported", evidence }],
          }),
          manifest("current"),
          "a".repeat(40),
        ),
      ).toThrow(/conclusive.*consumed|conclusive.*legacy/i)
    }
  })

  it("retains a declined callback as non-measuring and rejects forged none evidence", () => {
    const emptyTrace = JSON.stringify({ writes: [], queries: [], events: [] })
    const recorded = {
      featureId: "extensions.query",
      outcome: "inconclusive" as const,
      reason: "policy-refused" as const,
      evidence: "none" as const,
      rawReplyRef: "extensions.query",
    }
    const declined = run("declined", {
      probeHash: "query",
      suiteComplete: true,
      assertions: [],
      rawReplies: { ...identityReplies, "extensions.query": emptyTrace },
      observations: [recorded],
    })
    const parsed = parseRun("declined.json", JSON.stringify(declined), catalog)
    const selected = projectResults([parsed], [reviewFor(parsed)], catalog, { currentProbeHash: "query" }).current[
      "app:kitty"
    ]
    expect(selected?.cells["extensions.query"]).toMatchObject({
      outcome: "inconclusive",
      reason: "policy-refused",
      evidence: "none",
      conclusive: false,
    })
    expect(selected?.counts.conclusive).toBe(0)
    expect(selected?.v1["extensions.query"]).toBeUndefined()
    const corrected = projectResults(
      [parsed],
      [
        reviewFor(parsed),
        {
          id: "review-decline",
          reviewer: "reviewer",
          reason: "confirmed callback was declined",
          scope: {
            target: { kind: "app" as const, id: "kitty" },
            versions: ["0.46.2", "0.46.2"] as [string, string],
            suites: [parsed.suiteId, parsed.suiteId] as [string, string],
          },
          sources: [parsed.path],
          supersedes: [],
          featureId: "extensions.query",
          observation: recorded,
        },
      ],
      catalog,
      { currentProbeHash: "query" },
    ).current["app:kitty"]
    expect(corrected?.cells["extensions.query"]?.conclusive).toBe(false)
    expect(corrected?.counts.conclusive).toBe(0)
    expect(corrected?.v1["extensions.query"]).toBeUndefined()

    const reject = (observation: Record<string, unknown>, trace = emptyTrace) =>
      parseRun(
        "forged-none.json",
        JSON.stringify({
          ...declined,
          rawReplies: { ...identityReplies, "extensions.query": trace },
          observations: [observation],
        }),
        catalog,
      )
    for (const outcome of ["supported", "unsupported"]) {
      expect(() => reject({ ...recorded, outcome, reason: undefined })).toThrow(/conclusive.*none/)
    }
    expect(() => reject({ ...recorded, reason: "timeout" })).toThrow(/none.*policy-refused/)
    expect(() => reject({ ...recorded, rawReplyRef: undefined })).toThrow(/none.*rawReplyRef/)
    const image = `sha256:${"a".repeat(64)}`
    expect(() => reject({ ...recorded, screenshotRef: image })).toThrow(/none.*screenshotRef/)
    expect(() => reject({ ...recorded, frames: [] })).toThrow(/none.*frames/)
    for (const trace of [
      JSON.stringify({ writes: ["\x1bc"], queries: [], events: [] }),
      JSON.stringify({ writes: [], queries: [{ sequence: "\x1b[c" }], events: [] }),
      JSON.stringify({ writes: [], queries: [], events: [{ kind: "write" }] }),
    ]) {
      expect(() => reject(recorded, trace)).toThrow(/none.*zero-byte trace/)
    }
  })

  it("decodes exact current collector bytes without promoting legacy or a mismatched source", () => {
    const collectorRevision = "a".repeat(40)
    const value = run("public", {
      identity: "unverified",
      suiteId: "current",
      sourceRevision: collectorRevision,
      observations: [observation("extensions.query", "supported", "query")],
      suiteComplete: false,
    })
    const raw = `${JSON.stringify(value)}\n`
    const decoded = decodeCollectorRun("public.json", raw, manifest("current"), collectorRevision)
    expect(decoded.raw).toBe(raw)
    expect(decoded.sha256).toBe(createHash("sha256").update(raw).digest("hex"))
    expect(decoded.run.suiteComplete).toBe(false)
    expect(decoded.run.identity).toBe("unverified")
    expect(decoded.run).not.toHaveProperty("path")
    expect(decoded.run).not.toHaveProperty("sha256")
    expect(decoded.run).not.toHaveProperty("legacy")
    expect(() => decodeExactUtf8(Buffer.from([0xff]), "invalid.json")).toThrow(/UTF-8/i)
    expect(() => decodeExactUtf8(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), "bom.json")).toThrow(
      /exact.*UTF-8|UTF-8.*bytes/i,
    )
    expect(() =>
      decodeCollectorRun(
        "legacy.json",
        JSON.stringify({ terminal: "kitty", version: "0.46.2", generated: value.measuredAt, results: {} }),
        manifest("current"),
        collectorRevision,
      ),
    ).toThrow(/schemaVersion.*2|v2/i)
    for (const [name, changed] of [
      ["future", { schemaVersion: 3 }],
      ["suite", { probeHash: "other" }],
      ["source", { sourceRevision: "b".repeat(40) }],
      ["identity", { identity: "verified" }],
      ["origin", { origin: { kind: "manual-capture" } }],
      ["reply", { rawReplies: { "extensions.query": "ACK" } }],
    ] as const) {
      expect(() =>
        decodeCollectorRun(
          `${name}.json`,
          JSON.stringify({ ...value, ...changed }),
          manifest("current"),
          collectorRevision,
        ),
      ).toThrow()
    }
    const mixedManifest = {
      ...manifest("current", ["extensions.query"]),
      probes: {
        app: ["extensions.query"],
        mux: ["extensions.query"],
        headless: ["extensions.query", "extensions.graphics"],
      },
    }
    const foreignDiagnostic = {
      ...value,
      observations: [observation("extensions.query", "supported", "query")],
      assertions: value.assertions.filter((entry) => entry.featureId === "extensions.query"),
      ungradedDiagnostics: { "extensions.graphics": { kind: "legacy-callback", pass: false } },
      suiteComplete: true,
    }
    const foreignAssertion = {
      ...foreignDiagnostic,
      assertions: value.assertions,
      ungradedDiagnostics: {},
    }
    expect(() =>
      decodeCollectorRun("foreign-assertion.json", JSON.stringify(foreignAssertion), mixedManifest, collectorRevision),
    ).toThrow(/assertion.*extensions.graphics.*outside suite/i)
    expect(() =>
      decodeCollectorRun(
        "foreign-diagnostic.json",
        JSON.stringify(foreignDiagnostic),
        mixedManifest,
        collectorRevision,
      ),
    ).toThrow(/diagnostic.*extensions.graphics.*outside suite/i)
  })

  it("never admits an uncommitted source revision even with an identity review", () => {
    const dirty = parseRun(
      "dirty.json",
      JSON.stringify(run("dirty", { sourceRevision: `${"2".repeat(40)}+dirty` })),
      catalog,
    )
    const projection = projectResults([dirty], [reviewFor(dirty)], catalog, { currentProbeHash: "current" })
    expect(projection.current).toEqual({})
    expect(projection.exclusions).toContainEqual(
      expect.objectContaining({ runId: "dirty", reason: "source-uncommitted" }),
    )
    expect(projection.history["app:kitty"]?.[0]?.sourceRevision).toContain("+dirty")
  })
  it("derives completeness from trusted target membership and refuses unknown suites", () => {
    const partial = run("partial", { observations: [observation("extensions.query", "supported", "query")] })
    expect(() => parseRun("partial.json", JSON.stringify(partial), catalog)).toThrow(/suiteComplete.*1.*2/)
    const unknown = run("unknown-suite", { probeHash: "unknown" })
    expect(() => parseRun("unknown-suite.json", JSON.stringify(unknown), catalog)).toThrow(/unknown suite.*unknown/)
    const outside = run("outside", {
      observations: [{ featureId: "cursor.position", outcome: "inconclusive", evidence: "query", reason: "timeout" }],
      suiteComplete: false,
    })
    expect(() => parseRun("outside.json", JSON.stringify(outside), catalog)).toThrow(/cursor.position.*suite/)
  })

  it("keeps partial runs as labeled history and selects only complete runs", () => {
    const complete = parseRun("complete.json", JSON.stringify(run("complete", { probeHash: "old" })), catalog)
    const partial = parseRun(
      "partial.json",
      JSON.stringify(
        run("partial", {
          observations: [observation("extensions.query", "supported", "query")],
          suiteComplete: false,
          measuredAt: "2026-09-29T00:00:00.000Z",
        }),
      ),
      catalog,
    )
    const projection = projectResults([complete, partial], [reviewFor(complete), reviewFor(partial)], catalog, {
      currentProbeHash: "current",
    })
    expect(projection.current["app:kitty"]?.runId).toBe("complete")
    expect(projection.versions["app:kitty"]?.map((value) => value.runId)).toEqual(["complete"])
    expect(projection.history["app:kitty"]?.find((value) => value.runId === "partial")?.suiteFreshness).toBe(
      "partial (1 of 2 probes)",
    )
    expect(projection.exclusions).toContainEqual(
      expect.objectContaining({ runId: "partial", reason: "suite-incomplete" }),
    )
    expect(projectResults([partial], [reviewFor(partial)], catalog, { currentProbeHash: "current" }).current).toEqual(
      {},
    )
  })
  it("names the release suite and the tree suite separately, and never labels a release-suite run older", () => {
    const releaseSuiteId = "a8bafe49cdd4"
    const liveTree = "21739d9e768f"
    const labelOf = (probeHash: string) => {
      const parsed = parseRun("labelled.json", JSON.stringify(run("labelled", { probeHash })), catalog)
      const projection = projectResults([parsed], [reviewFor(parsed)], catalog, {
        currentProbeHash: liveTree,
        releaseSuiteId,
      })
      return (
        projection.current["app:kitty"] ?? projection.versions["app:kitty"]?.[0] ?? projection.history["app:kitty"]?.[0]
      )
    }
    const onRelease = labelOf(releaseSuiteId)
    expect(onRelease?.suiteFreshness).toBe(`release suite ${releaseSuiteId}`)
    expect(onRelease?.suiteRelation).toBe("release")
    expect(isStaleRelation(onRelease!.suiteRelation)).toBe(false)

    const onTree = labelOf(liveTree)
    expect(onTree?.suiteFreshness).toBe(`tree suite ${liveTree}`)
    expect(onTree?.suiteRelation).toBe("tree")
    expect(isStaleRelation(onTree!.suiteRelation)).toBe(false)

    const onOther = labelOf("9918f283121a")
    expect(onOther?.suiteFreshness).toMatch(/^older suite \(\d+ probes\)$/)
    expect(onOther?.suiteRelation).toBe("older")
    expect(isStaleRelation(onOther!.suiteRelation)).toBe(true)
  })

  it("classifies every read run once into the projection table, one row per feature, named per basis (28792)", () => {
    const parsed = parseRun(
      "table-parity.json",
      JSON.stringify(
        run("table-parity", {
          observations: [
            observation("extensions.query", "supported", "query"),
            observation("extensions.graphics", "error", "behavior", "timeout"),
          ],
        }),
      ),
      catalog,
    )
    const projection = projectResults([parsed], [reviewFor(parsed)], catalog, { currentProbeHash: "current" })
    const versions = Object.values(projection.history).flat()
    expect(versions.length).toBeGreaterThan(0)
    // Every run the projection read has exactly one classified row, and no run is classified twice.
    expect(Object.keys(projection.table).sort()).toEqual(versions.map((value) => value.runId).sort())
    for (const version of versions) {
      const table = projection.table[version.runId]!
      // The table IS the classification: one call per cell, made once in the projection.
      for (const [featureId, cell] of Object.entries(version.cells)) {
        expect(table[featureId]).toBe(classifyCell(cell))
      }
      const present = Object.keys(version.cells)
      // Every basis shape the consumers use: the run's own cells, a basis naming an absent cell, and none.
      for (const ids of [present, [...present, "not.a.catalog.id"], []]) {
        const aggregate = aggregateCells(table, ids)
        // The fold's denominator is the basis, and every basis id lands in exactly one named state.
        expect(aggregate.denominator).toBe(ids.length)
        expect(Object.values(aggregate.counts).reduce((sum, count) => sum + count, 0)).toBe(ids.length)
        expect(Object.values(aggregate.idsByState).flat()).toHaveLength(ids.length)
      }
    }
    // The selected run is one of them, so a bar consumer reads `table[current[context].runId]`.
    expect(projection.table[projection.current["app:kitty"]!.runId]).toBeDefined()
  })

  it("verifies screenshot bytes without writing and refuses missing, modified, or non-PNG artifacts", () => {
    const content = temporaryContent()
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    )
    const digest = createHash("sha256").update(png).digest("hex")
    const screenshotRef = `sha256:${digest}`
    const artifactPath = join(content, "artifacts", `${digest}.png`)
    writeFileSync(artifactPath, png)
    const controlPng = Buffer.concat([png, Buffer.from("control frame")])
    const controlDigest = createHash("sha256").update(controlPng).digest("hex")
    const controlRef = `sha256:${controlDigest}`
    writeFileSync(join(content, "artifacts", `${controlDigest}.png`), controlPng)
    writeFileSync(
      join(content, "probes-apps", "pixels.json"),
      JSON.stringify(
        run("pixels", {
          probeHash: "pixels",
          assertions: [],
          screenshotRefs: [controlRef, screenshotRef],
          observations: [
            {
              featureId: "extensions.graphics",
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "pixels",
              screenshotRef,
              frames: [
                { role: "control", ref: controlRef, capturedAt: 1, label: "before" },
                { role: "target", ref: screenshotRef, capturedAt: 2, label: "after" },
              ],
            },
          ],
        }),
      ),
    )
    const output = join(content, "built-artifacts")
    const cell = loadSelectedResults(content, "current", { artifactDir: output }).history["app:kitty"]?.[0]?.cells[
      "extensions.graphics"
    ]
    expect(cell?.chain.screenshotRef).toBe(screenshotRef)
    expect(cell?.record.screenshot).toEqual({ url: `/artifacts/${digest}.png`, sha256: digest })
    expect(cell?.record.frames).toEqual([
      {
        role: "control",
        label: "before",
        capturedAt: 1,
        kind: "pixels",
        url: `/artifacts/${controlDigest}.png`,
        sha256: controlDigest,
      },
      {
        role: "target",
        label: "after",
        capturedAt: 2,
        kind: "pixels",
        url: `/artifacts/${digest}.png`,
        sha256: digest,
      },
    ])
    expect(existsSync(output)).toBe(false)
    expect(
      loadSelectedResults(content, "current").history["app:kitty"]?.[0]?.cells["extensions.graphics"],
    ).toBeDefined()
    expect(existsSync(output)).toBe(false)
    expect(readVerifiedArtifact(content, screenshotRef, "pixels.json")).toEqual(png)
    expect(readVerifiedArtifact(content, controlRef, "pixels.json")).toEqual(controlPng)
    const invalidPng = Buffer.from("not a PNG")
    const invalidRef = `sha256:${createHash("sha256").update(invalidPng).digest("hex")}`
    writeFileSync(join(content, "artifacts", `${invalidRef.slice(7)}.png`), invalidPng)
    expect(() => readVerifiedArtifact(content, invalidRef, "pixels.json")).toThrow(/not a PNG/)
    expect(() => readVerifiedArtifact(content, "../../outside.png", "pixels.json")).toThrow(/invalid screenshotRef/)
    writeFileSync(artifactPath, Buffer.concat([png, Buffer.from("changed")]))
    expect(() => loadSelectedResults(content, "current")).toThrow(/artifact.*(hash|digest)/)
    rmSync(artifactPath)
    expect(() => loadSelectedResults(content, "current")).toThrow(/missing.*artifact/)
  })

  it("refuses screenshot paths and correction sources that bypass the artifact store", () => {
    expect(() =>
      parseRun("path.json", JSON.stringify(run("path", { screenshotRefs: ["../../outside.png"] })), catalog),
    ).toThrow(/screenshotRef/)
    const measured = parseRun("run.json", JSON.stringify(run("no-artifact")), catalog)
    const screenshotRef = `sha256:${"1".repeat(64)}`
    const correction = {
      ...reviewFor(measured),
      featureId: "extensions.graphics",
      sources: [screenshotRef],
      observation: {
        featureId: "extensions.graphics",
        outcome: "supported" as const,
        evidence: "pixels" as const,
        screenshotRef,
      },
    }
    expect(() => projectResults([measured], [correction], catalog, { currentProbeHash: "current" })).toThrow(
      /unknown screenshotRef/,
    )
  })

  it("refuses inherited reply keys and unsupported positive assertions", () => {
    const inherited = run("inherited", {
      observations: [
        { featureId: "extensions.query", outcome: "supported", evidence: "query", rawReplyRef: "toString" },
      ],
    })
    expect(() => parseRun("inherited.json", JSON.stringify(inherited), catalog)).toThrow(/missing raw reply.*toString/)
    const missingAssertion = run("missing-assertion", { assertions: [] })
    expect(() => parseRun("missing-assertion.json", JSON.stringify(missingAssertion), catalog)).toThrow(
      /extensions.query.*positive/,
    )
  })

  it("refuses diagnostics that overlap an observation or invent a result kind", () => {
    const overlapping = run("overlap", {
      ungradedDiagnostics: { "extensions.query": { kind: "legacy-callback", pass: true } },
    })
    expect(() => parseRun("overlap.json", JSON.stringify(overlapping), catalog)).toThrow(
      /extensions.query.*both|both.*extensions.query/,
    )
    const invented = run("invented", {
      ungradedDiagnostics: { "cursor.position": { kind: "unsupported", pass: false } },
    })
    expect(() => parseRun("invented.json", JSON.stringify(invented), catalog)).toThrow(/diagnostic.*cursor.position/)
  })

  it("retains old callback diagnostics without adding them to tested or support counts", () => {
    const diagnostic = { kind: "legacy-callback" as const, pass: true, note: "old callback" }
    const measured = parseRun(
      "diagnostic.json",
      JSON.stringify(
        run("diagnostic", {
          probeHash: "with-diagnostic",
          suiteComplete: false,
          ungradedDiagnostics: { "cursor.position": diagnostic },
        }),
      ),
      catalog,
    )
    const selected = projectResults([measured], [reviewFor(measured)], catalog, { currentProbeHash: "with-diagnostic" })
      .history["app:kitty"]?.[0]
    expect(selected?.ungradedDiagnostics).toEqual({
      evidence: "legacy",
      label: "old callback result, unverified",
      results: { "cursor.position": diagnostic },
    })
    expect(selected?.counts).toMatchObject({ tested: 2, notTested: 1, conclusive: 2 })
    expect(selected?.cells["cursor.position"]).toBeUndefined()
    expect(selected?.v1["cursor.position"]).toBeUndefined()
  })

  it("requires expected and observed values bound to the same feature and raw record", () => {
    const value = run("binding", {
      probeHash: "query",
      observations: [observation("extensions.query", "supported", "query")],
    })
    for (const assertion of [
      {
        featureId: "extensions.graphics",
        kind: "positive",
        rawReplyRef: "extensions.query",
        expected: "ACK",
        observed: "ACK",
      },
      {
        featureId: "extensions.query",
        kind: "positive",
        rawReplyRef: "extensions.graphics",
        expected: "ACK",
        observed: "ACK",
      },
      { featureId: "extensions.query", kind: "positive", rawReplyRef: "extensions.query", expected: "ACK" },
    ]) {
      expect(() => parseRun("binding.json", JSON.stringify({ ...value, assertions: [assertion] }), catalog)).toThrow(
        /extensions.query.*assertion/,
      )
    }
  })

  it("requires state observations and performed actions instead of bare capability flags", () => {
    const makeState = (observed: string, evidence: string, action?: string) =>
      run("state", {
        probeHash: "state",
        observations: [
          { featureId: "cursor.position", outcome: "supported", evidence, rawReplyRef: "cursor.position" },
        ],
        rawReplies: { ...identityReplies, "cursor.position": observed },
        assertions: [
          {
            featureId: "cursor.position",
            kind: "positive",
            rawReplyRef: "cursor.position",
            expected: "cursor moves to column 3",
            observed,
            action,
          },
        ],
      })
    expect(() => parseRun("flag.json", JSON.stringify(makeState("true", "parser-state")), catalog)).toThrow(
      /actual state snapshot/,
    )
    expect(() => parseRun("empty.json", JSON.stringify(makeState("{}", "parser-state")), catalog)).toThrow(
      /actual state snapshot/,
    )
    const state = JSON.stringify({ cursor: { row: 1, column: 3 } })
    expect(() => parseRun("action.json", JSON.stringify(makeState(state, "interaction")), catalog)).toThrow(
      /performed action/,
    )
    expect(
      parseRun("state.json", JSON.stringify(makeState(state, "interaction", "press Right twice")), catalog)
        .observations[0]?.outcome,
    ).toBe("supported")
  })

  it("rejects invalid required input and unsupported claims without an asserted negative", () => {
    expect(() => parseRun("broken.json", "{", catalog)).toThrow(/broken\.json/)
    expect(() =>
      parseRun(
        "duplicate.json",
        '{"terminal":"kitty","terminalVersion":"1","results":{"cursor.position":true,"cursor.position":false}}',
        catalog,
      ),
    ).toThrow(/duplicate.*cursor\.position/)
    expect(() =>
      parseRun(
        "unknown.json",
        JSON.stringify(run("unknown", { observations: [observation("no.such.feature", "supported", "query")] })),
        catalog,
      ),
    ).toThrow(/no\.such\.feature/)
    expect(() =>
      parseRun(
        "negative.json",
        JSON.stringify(
          run("negative", { observations: [observation("extensions.graphics", "unsupported", "behavior", "timeout")] }),
        ),
        catalog,
      ),
    ).toThrow(/negative/)
  })

  it("selects verified identity, current suite, latest measurement and runId within an exact target", () => {
    const runs = [
      run("older-version-newer-time", {
        target: { ...target, version: "0.40.0" },
        rawReplies: {
          ...identityReplies,
          "device.xtversion": "kitty(0.40.0)",
          "extensions.query": "ACK",
          "extensions.graphics": "NO",
        },
        measuredAt: "2026-10-01T00:00:00.000Z",
      }),
      run("old-suite", { probeHash: "old", measuredAt: "2026-10-02T00:00:00.000Z" }),
      run("unverified", {
        identity: "unverified",
        measuredAt: "2026-10-03T00:00:00.000Z",
        rawReplies: {
          "device.primary-da": "\u001b[?62;52;c",
          "extensions.query": "ACK",
          "extensions.graphics": "NO",
          "cursor.position": "",
        },
      }),
      run("a"),
      run("z"),
      run("headless", {
        target: { ...target, kind: "headless" },
        runtimeIdentity: {
          kind: "js",
          runtimeFormat: "js",
          engineVersion: "0.46.2",
          resolvedPath: "/pkg/kitty/index.js",
          integrity: { kind: "registry", lockIntegrity: "sha512-example" },
          adapterVersion: "1.0.0",
          termlessRevision: "rev123",
        },
      }),
    ].map((value) => parseRun(`${value.runId}.json`, JSON.stringify(value), catalog))
    const projection = projectResults(runs, runs.filter((r) => r.runId !== "unverified").map(reviewFor), catalog, {
      currentProbeHash: "current",
    })
    expect(projection.current["app:kitty"]?.runId).toBe("z")
    expect(projection.current["headless:kitty"]?.runId).toBe("headless")
    expect(projection.exclusions).toContainEqual(
      expect.objectContaining({ runId: "unverified", reason: "identity-replies-mismatch" }),
    )
    expect(projection.versions["app:kitty"]).toHaveLength(2)
    expect(projection.current["app:kitty"]?.counts).toMatchObject({
      catalog: 3,
      tested: 2,
      notTested: 1,
      conclusive: 2,
    })
  })

  // 29930: a release-bound reading selects within its declared freeze. While the tree has moved past
  // the release suite, a version's runs are ranked release suite, then tree suite, then older; a newer
  // capture at the tree therefore cannot displace the frozen reading. With no move the ordering is the
  // one the site has always used.
  it("ranks the release suite above the tree suite while the tree has moved (29930)", () => {
    const runs = [
      run("tree-suite", { probeHash: "tree", measuredAt: "2026-10-17T23:08:16.413Z" }),
      run("release-suite", { probeHash: "release", measuredAt: "2026-10-17T23:19:21.384Z" }),
    ].map((value) => parseRun(`${value.runId}.json`, JSON.stringify(value), catalog))
    const reviews = runs.map(reviewFor)
    expect(
      projectResults(runs, reviews, catalog, { currentProbeHash: "tree", releaseSuiteId: "release" }).current[
        "app:kitty"
      ]?.runId,
    ).toBe("release-suite")
    // No move: no release declaration, or one that IS the tree suite -- today's choice, unchanged.
    expect(projectResults(runs, reviews, catalog, { currentProbeHash: "tree" }).current["app:kitty"]?.runId).toBe(
      "tree-suite",
    )
    expect(
      projectResults(runs, reviews, catalog, { currentProbeHash: "tree", releaseSuiteId: "tree" }).current["app:kitty"]
        ?.runId,
    ).toBe("tree-suite")
  })

  it("leaves the selected run byte-identical when a same-version tree-suite capture is admitted (29930)", () => {
    const release = run("release-run", { probeHash: "release", measuredAt: "2026-10-17T00:00:00.000Z" })
    const capture = run("tree-capture", { probeHash: "tree", measuredAt: "2026-10-17T01:00:00.000Z" })
    const policy = { currentProbeHash: "tree", releaseSuiteId: "release" }
    const build = (values: Record<string, unknown>[]) => {
      const parsed = values.map((value) => parseRun(`${value.runId as string}.json`, JSON.stringify(value), catalog))
      return projectResults(parsed, parsed.map(reviewFor), catalog, policy)
    }
    const before = build([release])
    const after = build([release, capture])
    expect(after.current["app:kitty"]).toEqual(before.current["app:kitty"])
    // The capture is admitted and kept in history, labelled -- it just cannot be the selected run.
    expect(after.history["app:kitty"]?.map((value) => value.runId)).toContain("tree-capture")
  })

  it("still selects a newer terminal version measured only at the tree, off the release suite (29930)", () => {
    // The version sort runs first, so a newer version with no release-suite run is still selected and
    // reads ineligible at a cohort: an honest dark, never a claim.
    const runs = [
      run("release-old-version", { probeHash: "release", measuredAt: "2026-10-17T00:00:00.000Z" }),
      run("tree-new-version", {
        probeHash: "tree",
        measuredAt: "2026-10-17T01:00:00.000Z",
        target: { ...target, version: "0.47.0" },
        rawReplies: {
          ...identityReplies,
          "device.xtversion": "kitty(0.47.0)",
          "extensions.query": "ACK",
          "extensions.graphics": "NO",
          "cursor.position": "",
        },
      }),
    ].map((value) => parseRun(`${value.runId}.json`, JSON.stringify(value), catalog))
    const reviews = runs.map(reviewFor)
    const projection = projectResults(runs, reviews, catalog, { currentProbeHash: "tree", releaseSuiteId: "release" })
    const selected = projection.current["app:kitty"]
    expect(selected?.runId).toBe("tree-new-version")
    expect(selected?.suiteId).toBe("suite-2")
    expect(selected?.suiteRelation).toBe("tree")
  })

  it("scopes reviewed corrections and leaves raw run bytes unchanged", () => {
    const capture = run("kitty-app", {
      assertions: [
        ...run("kitty-app").assertions,
        {
          featureId: "extensions.graphics",
          kind: "positive",
          rawReplyRef: "extensions.graphics",
          expected: "explicit protocol rejection",
          observed: "NO",
        },
      ],
    })
    const bytes = JSON.stringify(capture)
    const hash = createHash("sha256").update(bytes).digest("hex")
    const app = parseRun("app.json", bytes, catalog)
    const headless = parseRun(
      "headless.json",
      JSON.stringify(
        run("kitty-headless", {
          target: { ...target, kind: "headless" },
          runtimeIdentity: {
            kind: "js",
            runtimeFormat: "js",
            engineVersion: "0.46.2",
            resolvedPath: "/pkg/kitty/index.js",
            integrity: { kind: "registry", lockIntegrity: "sha512-example" },
            adapterVersion: "1.0.0",
            termlessRevision: "rev123",
          },
        }),
      ),
      catalog,
    )
    const correction = {
      id: "review-1",
      reviewer: "reviewer",
      reason: "controlled replay",
      scope: {
        target: { kind: "app" as const, id: "kitty" },
        versions: ["0.46.2", "0.46.2"] as [string, string],
        suites: ["suite-2", "suite-2"] as [string, string],
      },
      sources: ["capture://1"],
      supersedes: [],
      featureId: "extensions.graphics",
      observation: observation("extensions.graphics", "supported", "behavior"),
    }
    const projection = projectResults([app, headless], [reviewFor(app), reviewFor(headless), correction], catalog, {
      currentProbeHash: "current",
    })
    // CTO 716686ae: development must apply the same correction, not classify the raw cells again.
    // No previous test could cover this production entry because it did not exist.
    expect(projection.table[app.runId]?.["extensions.graphics"]).toBe("supported")
    expect(projection.current["app:kitty"]?.cells["extensions.graphics"]?.outcome).toBe("supported")
    expect(projection.current["app:kitty"]?.cells["extensions.graphics"]?.record.rawReply).toBe("NO")
    expect(projection.current["app:kitty"]?.reviews).toContainEqual(
      expect.objectContaining({ id: correction.id, reviewer: correction.reviewer, reason: correction.reason }),
    )
    expect(projection.current["headless:kitty"]?.cells["extensions.graphics"]?.outcome).toBe("unsupported")
    expect(app.sha256).toBe(hash)
    expect(JSON.stringify(capture)).toBe(bytes)
  })

  it("requires a rerun TODO for historical booleans without attempt evidence and retains attempted failures", () => {
    const legacy = parseRun(
      "legacy.json",
      JSON.stringify({
        terminal: "kitty",
        terminalVersion: "0.46.2",
        os: "macos",
        osVersion: "25.4.0",
        generated: "2026-04-06T16:53:04.733Z",
        results: { "cursor.position": true, "extensions.graphics": false },
      }),
      catalog,
    )
    const timeout = parseRun(
      "timeout.json",
      JSON.stringify(
        run("timeout", {
          observations: [
            observation("extensions.query", "inconclusive", "query", "timeout"),
            observation("extensions.graphics", "unsupported", "behavior"),
          ],
        }),
      ),
      catalog,
    )
    const projection = projectResults([legacy, timeout], [reviewFor(timeout)], catalog, { currentProbeHash: "current" })
    expect(projection.history["app:kitty"]?.find((r) => r.runId === legacy.runId)?.counts.conclusive).toBe(0)
    const retainedPath = join(import.meta.dirname, "../content/probes-apps/kitty-0.46.2-macos.json")
    const retainedCatalog = Object.keys(loadFeatures(join(import.meta.dirname, "../content")))
    const retained = parseRun(retainedPath, readFileSync(retainedPath, "utf8"), retainedCatalog)
    const historical = projectResults([retained], [], retainedCatalog, { currentProbeHash: "current" })
    const historicalCell = historical.history["app:kitty"]?.[0]?.cells["sgr.bold"]
    expect(historical.table[retained.runId]?.["sgr.bold"]).toBe("untested")
    expect(historicalCell).toMatchObject({
      outcome: "supported",
      evidence: "legacy",
      conclusive: false,
      note: "Historical result lacks retained attempt evidence; rerun required (TEST TODO).",
      record: { assertions: [] },
    })
    expect(historicalCell?.record.rawReply).toBeUndefined()
    expect(publicResults(historical, new Map()).projection.history["app:kitty"]?.[0]?.cells["sgr.bold"]?.note).toBe(
      "Historical result lacks retained attempt evidence; rerun required (TEST TODO).",
    )
    if (!historicalCell) throw new Error("Missing retained legacy fixture")
    historicalCell.note = "Private historical annotation"
    expect(
      publicResults(historical, new Map()).projection.history["app:kitty"]?.[0]?.cells["sgr.bold"]?.note,
    ).toBeUndefined()
    expect(retained.observations.find((cell) => cell.featureId === "sgr.bold")?.note).toBeUndefined()
    expect(projection.table[timeout.runId]?.["extensions.query"]).toBe("error")

    expect(projection.exclusions).toContainEqual(
      expect.objectContaining({ runId: legacy.runId, reason: "identity-unverified" }),
    )
    expect(projection.current["app:kitty"]?.cells["extensions.query"]?.outcome).toBe("inconclusive")
    expect(projection.current["app:kitty"]?.v1["extensions.query"]).toBeUndefined()
    const correction = {
      id: "legacy-note",
      reviewer: "reviewer",
      reason: "later source",
      scope: {
        target: { kind: "app" as const, id: "kitty" },
        versions: ["0.46.2", "0.46.2"] as [string, string],
        suites: ["legacy", "legacy"] as [string, string],
      },
      sources: ["capture://later"],
      supersedes: [],
      featureId: "extensions.graphics",
      observation: { featureId: "extensions.graphics", outcome: "supported" as const, evidence: "consumed" as const },
    }
    expect(() => projectResults([legacy], [correction], catalog, { currentProbeHash: "current" })).toThrow(
      /conclusive.*consumed/,
    )
  })

  it("admits insufficient evidence only for an inconclusive observation", () => {
    const partial = (outcome: "inconclusive" | "error" | "supported") =>
      run(`insufficient-${outcome}`, {
        probeHash: "query",
        assertions:
          outcome === "supported"
            ? [
                {
                  featureId: "extensions.query",
                  kind: "positive",
                  rawReplyRef: "extensions.query",
                  expected: "ACK",
                  observed: "ACK",
                },
              ]
            : [],
        observations: [
          {
            featureId: "extensions.query",
            outcome,
            reason: "insufficient-evidence",
            evidence: "query",
            rawReplyRef: "extensions.query",
          },
        ],
      })
    const inconclusive = parseRun("inconclusive.json", JSON.stringify(partial("inconclusive")), catalog)
    expect(inconclusive.observations).toMatchObject([{ outcome: "inconclusive", reason: "insufficient-evidence" }])
    expect(() => parseRun("error.json", JSON.stringify(partial("error")), catalog)).toThrow(
      /insufficient-evidence.*inconclusive/,
    )
    expect(() => parseRun("supported.json", JSON.stringify(partial("supported")), catalog)).toThrow(
      /insufficient-evidence.*inconclusive/,
    )
  })

  it("requires a source and exact run ID before a review verifies identity", () => {
    const broad = {
      id: "review-broad",
      reviewer: "reviewer",
      reason: "looks plausible",
      scope: { target: { kind: "app", id: "kitty" }, versions: ["0.46.2", "0.46.2"], suites: ["legacy", "legacy"] },
      sources: ["capture://1"],
      supersedes: [],
      verifiesIdentity: true,
    }
    expect(() => parseInterpretations("interpretations.json", JSON.stringify([broad]), catalog)).toThrow(/exact runId/)
    const invalidCorrection = {
      ...broad,
      verifiesIdentity: false,
      featureId: "extensions.graphics",
      observation: {
        featureId: "extensions.graphics",
        outcome: "unsupported",
        evidence: "behavior",
        reason: "timeout",
      },
    }
    expect(() => parseInterpretations("interpretations.json", JSON.stringify([invalidCorrection]), catalog)).toThrow(
      /conclusive.*reason/,
    )
  })

  it("admits a schema-v2 kitty run from matching DA1 and XTVERSION without a pin, and records the rule", () => {
    const da1 = "\u001b[?62;52;c"
    const xtversion = "kitty(0.46.2)"
    const candidate = parseRun(
      "kitty-self.json",
      JSON.stringify(
        run("kitty-self", {
          rawReplies: {
            "device.primary-da": da1,
            "device.xtversion": xtversion,
            "extensions.query": "ACK",
            "extensions.graphics": "NO",
            "cursor.position": "",
          },
        }),
      ),
      catalog,
    )
    const selected = projectResults([candidate], [], catalog, { currentProbeHash: "current" }).current["app:kitty"]
    expect(selected?.runId).toBe("kitty-self")
    expect(selected?.identityAdmission).toEqual({
      rule: "kitty",
      da1,
      xtversion,
    })
    if (!selected) throw new Error("expected admitted kitty run")
    const published = publicResults(
      {
        current: { "app:kitty": selected },
        table: {
          "app:kitty": Object.fromEntries(Object.entries(selected.cells).map(([id, cell]) => [id, classifyCell(cell)])),
        },
        versions: {},
        history: {},
        exclusions: [],
        releaseSuiteId: null,
        treeSuiteId: "current",
        treeMovedPastRelease: false,
      },
      new Map(),
    ).projection.current["app:kitty"]
    expect(published?.identityAdmission).toEqual(selected.identityAdmission)
  })

  it("admits a schema-v2 wezterm run from its measured DA1 and XTVERSION, and refuses either half alone", () => {
    const da1 = "\u001b[?65;4;6;18;22;52c"
    const xtversion = "WezTerm 0-unstable-2026-09-17"
    const provenance = {
      executable: {
        path: "/nix/store/wezterm/bin/wezterm",
        sha256: "a1".repeat(32),
        version: "wezterm 0-unstable-2026-09-17",
      },
      sourceArtifact: { url: "https://example.invalid/wezterm-0-unstable-2026-09-17.tar.gz", sha256: "b7".repeat(32) },
      runtime: {
        imageId: `sha256:${"c".repeat(64)}`,
        imageTarSha256: "d4".repeat(32),
        arch: "x86_64-linux",
        nixLockRevision: "e".repeat(40),
        sourceRevision: "2".repeat(40),
        cleanTree: true,
        suiteHash: "current",
      },
      fixture: {
        definition: "wezterm identity",
        config: "NONE",
        font: "DejaVu Sans Mono",
        geometry: "80x24, 800x600",
        display: "Xvfb :0",
        gl: "Mesa llvmpipe",
      },
    }
    const wezterm = (runId: string, replies: Record<string, string>) =>
      parseRun(
        `${runId}.json`,
        JSON.stringify(
          run(runId, {
            target: { ...target, id: "wezterm", version: "0-unstable-2026-09-17", os: "linux" },
            provenance,
            rawReplies: { ...replies, "extensions.query": "ACK", "extensions.graphics": "NO", "cursor.position": "" },
          }),
        ),
        catalog,
      )
    const candidate = wezterm("wezterm-self", { "device.primary-da": da1, "device.xtversion": xtversion })
    const selected = projectResults([candidate], [], catalog, { currentProbeHash: "current" }).current["app:wezterm"]
    expect(selected?.runId).toBe("wezterm-self")
    expect(selected?.identityAdmission).toEqual({ rule: "wezterm", da1, xtversion })

    const projection = projectResults(
      [
        wezterm("wezterm-foreign-da1", { "device.primary-da": "\u001b[?62;52;c", "device.xtversion": xtversion }),
        wezterm("wezterm-foreign-xtversion", { "device.primary-da": da1, "device.xtversion": "kitty(0.46.2)" }),
        wezterm("wezterm-silent", { "device.primary-da": da1 }),
      ],
      [],
      catalog,
      { currentProbeHash: "current" },
    )
    expect(projection.current["app:wezterm"]).toBeUndefined()
    expect(projection.exclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: "wezterm-foreign-da1", reason: "identity-replies-mismatch" }),
        expect.objectContaining({ runId: "wezterm-foreign-xtversion", reason: "identity-replies-mismatch" }),
        expect.objectContaining({ runId: "wezterm-silent", reason: "identity-replies-mismatch" }),
      ]),
    )
  })

  it("admits a controlled-Linux alacritty run from ?6c and the apparatus-measured executable, and refuses every other half", () => {
    const da1 = "\u001b[?6c"
    const executable = { version: "alacritty 0.17.0", sha256: "31".repeat(32) }
    const provenance = {
      executable: { path: "/nix/store/alacritty-0.17.0/bin/alacritty", ...executable },
      sourceArtifact: { url: "https://example.invalid/alacritty-0.17.0.tar.gz", sha256: "b7".repeat(32) },
      runtime: {
        imageId: `sha256:${"c".repeat(64)}`,
        imageTarSha256: "d4".repeat(32),
        arch: "x86_64-linux",
        nixLockRevision: "e".repeat(40),
        sourceRevision: "2".repeat(40),
        cleanTree: true,
        suiteHash: "current",
      },
      fixture: {
        definition: "alacritty identity",
        config: "NONE",
        font: "DejaVu Sans Mono",
        geometry: "80x24, 800x600",
        display: "Xvfb :0",
        gl: "Mesa llvmpipe",
      },
    }
    const linuxTarget = { ...target, id: "alacritty", version: "0.17.0", os: "linux" }
    const replies = (primaryDa: string) => ({
      "device.primary-da": primaryDa,
      "extensions.query": "ACK",
      "extensions.graphics": "NO",
      "cursor.position": "",
    })
    const alacritty = (runId: string, changes: Record<string, unknown> = {}) =>
      parseRun(
        `${runId}.json`,
        JSON.stringify(run(runId, { target: linuxTarget, provenance, rawReplies: replies(da1), ...changes })),
        catalog,
      )
    const projected = (candidates: ReturnType<typeof alacritty>[]) =>
      projectResults(candidates, [], catalog, { currentProbeHash: "current" })

    const admitted = projected([alacritty("alacritty-linux")])
    expect(admitted.current["app:alacritty"]?.runId).toBe("alacritty-linux")
    expect(admitted.current["app:alacritty"]?.identityAdmission).toEqual({ rule: "alacritty", da1, executable })

    const refused = projected([
      alacritty("alacritty-foreign-da1", { rawReplies: replies("\u001b[?64;1;2c") }),
      alacritty("alacritty-unknown", { target: { ...linuxTarget, version: "unknown" }, provenance: undefined }),
      alacritty("alacritty-no-provenance", { provenance: undefined }),
      alacritty("alacritty-dirty", {
        provenance: { ...provenance, runtime: { ...provenance.runtime, cleanTree: false } },
      }),
      alacritty("alacritty-other-os", { target: { ...linuxTarget, os: "windows" } }),
      alacritty("alacritty-macos-no-receipt", { target: { ...linuxTarget, os: "macos" } }),
    ])
    expect(refused.current["app:alacritty"]).toBeUndefined()
    expect(refused.exclusions).toEqual(
      expect.arrayContaining(
        [
          "alacritty-foreign-da1",
          "alacritty-unknown",
          "alacritty-no-provenance",
          "alacritty-dirty",
          "alacritty-other-os",
          "alacritty-macos-no-receipt",
        ].map((runId) => expect.objectContaining({ runId, reason: "identity-replies-mismatch" })),
      ),
    )
    // A version that disagrees never reaches identity: the loader refuses it by name, so a second
    // number can never pass falsely (packages/run-parser/src/provenance-version.test.ts).
    expect(() =>
      alacritty("alacritty-version-mismatch", {
        provenance: { ...provenance, executable: { ...provenance.executable, version: "alacritty 0.17.1" } },
      }),
    ).toThrow(/differs from target.version/)

    // macOS is unchanged by the Linux branch: the same run with a matching CFBundle receipt admits.
    const launchReceipt = {
      bundlePath: "/Applications/Alacritty.app",
      cfBundleShortVersionString: "0.17.0",
      cfBundleVersion: "1",
      executablePath: "/Applications/Alacritty.app/Contents/MacOS/alacritty",
      executableSha256: RECEIPT_EXECUTABLE_SHA256,
      sourceArtifact: { path: "/System/Library/Assets/com.alacritty.pkg", sha256: RECEIPT_SOURCE_SHA256 },
    }
    const macos = projected([
      alacritty("alacritty-macos", {
        target: { ...linuxTarget, os: "macos" },
        provenance: undefined,
        origin: { kind: "collector", appLaunch: launchReceipt },
      }),
    ])
    expect(macos.current["app:alacritty"]?.identityAdmission).toEqual({
      rule: "alacritty",
      da1,
      receipt: { cfBundleShortVersionString: "0.17.0" },
    })

    // ?6c identifies nothing on its own: a terminal with no profile is still refused, not admitted
    // by the alacritty rule.
    const stranger = projected([alacritty("stranger-da1", { target: { ...linuxTarget, id: "cursor" } })])
    expect(stranger.current["app:cursor"]).toBeUndefined()
    expect(stranger.exclusions).toContainEqual(
      expect.objectContaining({ runId: "stranger-da1", reason: "identity-no-profile" }),
    )
  })

  it("excludes a pinned app without an identity profile as identity-no-profile, before provenance", () => {
    const replies = {
      "device.primary-da": "\u001b[?62;52;c",
      "device.xtversion": "Cursor 2.6.21",
      "extensions.query": "ACK",
      "extensions.graphics": "NO",
      "cursor.position": "",
    }
    const macos = parseRun(
      "cursor-macos.json",
      JSON.stringify(
        run("cursor-macos", {
          target: { ...target, id: "cursor" },
          rawReplies: replies,
        }),
      ),
      catalog,
    )
    const linux = parseRun(
      "cursor-linux.json",
      JSON.stringify(
        run("cursor-linux", {
          target: { ...target, id: "cursor", os: "linux" },
          rawReplies: replies,
        }),
      ),
      catalog,
    )
    const mismatch = parseRun(
      "kitty-mismatch.json",
      JSON.stringify(
        run("kitty-mismatch", {
          rawReplies: {
            ...identityReplies,
            "device.primary-da": "\u001b[?1;2c",
            "extensions.query": "ACK",
            "extensions.graphics": "NO",
            "cursor.position": "",
          },
        }),
      ),
      catalog,
    )
    const projection = projectResults([macos, linux, mismatch], [macos, linux, mismatch].map(reviewFor), catalog, {
      currentProbeHash: "current",
    })
    expect(projection.current["app:cursor"]).toBeUndefined()
    expect(projection.current["app:kitty"]).toBeUndefined()
    expect(projection.exclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: "cursor-macos", reason: "identity-no-profile" }),
        expect.objectContaining({ runId: "cursor-linux", reason: "identity-no-profile" }),
        expect.objectContaining({ runId: "kitty-mismatch", reason: "identity-replies-mismatch" }),
      ]),
    )
    expect(projection.exclusions.find((row) => row.runId === "cursor-linux")?.reason).not.toBe(
      "native-provenance-missing",
    )
  })

  it("keeps exact v3 HTTP draft bytes outside current selection and seals only after enrichment", async () => {
    const content = temporaryContent()
    const directory = `${content}-http-responses`
    contentDirs.push(directory)
    const receipt = { manifest: manifest("current"), collectorRevision: "a".repeat(40) }
    const {
      observations: _observations,
      suiteComplete: _complete,
      ...metadata
    } = run("retained-current-http", {
      suiteId: "current",
      sourceRevision: receipt.collectorRevision,
      identity: "unverified",
      assertions: [],
    })
    const raw = `${JSON.stringify({
      ...metadata,
      schemaVersion: 3,
      intendedContext: { kind: "app", id: "kitty" },
      results: catalog.map((featureId) => ({
        featureId,
        status: "test-todo",
        attempt: { scope: "none" },
        checks: [],
        reason: "Not started",
      })),
    })}\r\n`
    const retained = await readRetainedDaemonProbeResponse(new Response(raw), { directory, receipt })
    expect(retained.run).not.toHaveProperty("sealedAt")
    const path = saveDaemonProbeRun(retained.run, join(content, "probes-apps"))
    const enriched = parseRun(path, readFileSync(path, "utf8"), catalog)
    expect(readFileSync(retained.path, "utf8")).toBe(raw)
    expect(enriched.sha256).not.toBe(retained.sha256)
    expect(enriched.rawReplies["collector.httpResponseSha256"]).toBe(retained.sha256)
    expect(enriched.results).toEqual(retained.run.results)
    const after = loadCurrentSelectedResults(content, "current")
    expect(after.current["app:kitty"]).toMatchObject({
      runId: retained.run.runId,
      sha256: enriched.sha256,
      score: { supported: 0, all: 3 },
      complete: false,
    })
    expect(after.historical.current).toEqual({})
  })

  it("selects a reviewed Terminal.app run only with DA2 family and an exact launch receipt", () => {
    const appLaunch = {
      bundlePath: "/System/Applications/Utilities/Terminal.app",
      cfBundleShortVersionString: "2.15",
      cfBundleVersion: "455",
      executablePath: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
      executableSha256: RECEIPT_EXECUTABLE_SHA256,
      sourceArtifact: { path: "/System/Library/Assets/com.apple.Terminal.pkg", sha256: RECEIPT_SOURCE_SHA256 },
    }
    const candidate = (runId: string, changes: Record<string, unknown> = {}) =>
      parseRun(
        `${runId}.json`,
        JSON.stringify(
          run(runId, {
            target: { ...target, id: "terminal-app", version: "2.15" },
            rawReplies: {
              "device.primary-da": "\x1b[?1;2c",
              "device.secondary-da": "\x1b[>1;95;0c",
              "extensions.query": "ACK",
              "extensions.graphics": "NO",
            },
            origin: { kind: "collector", appLaunch },
            ...changes,
          }),
        ),
        catalog,
      )
    const accepted = candidate("terminal-receipt")
    expect(
      projectResults([accepted], [reviewFor(accepted)], catalog, { currentProbeHash: "current" }).current[
        "app:terminal-app"
      ]?.runId,
    ).toBe("terminal-receipt")
    for (const invalid of [
      candidate("missing-receipt", { origin: { kind: "collector" } }),
      candidate("version-mismatch", {
        origin: { kind: "collector", appLaunch: { ...appLaunch, cfBundleShortVersionString: "2.14" } },
      }),
      candidate("wrong-family", { rawReplies: { ...accepted.rawReplies, "device.secondary-da": "\x1b[>0;95;0c" } }),
      candidate("unexpected-xtversion", {
        rawReplies: { ...accepted.rawReplies, "device.xtversion": "\x1bP>|kitty(0.49.1)\x1b\\" },
      }),
    ]) {
      expect(
        projectResults([invalid], [reviewFor(invalid)], catalog, { currentProbeHash: "current" }).current[
          "app:terminal-app"
        ],
      ).toBeUndefined()
    }
    expect(() =>
      candidate("unmeasured-binary", {
        origin: { kind: "collector", appLaunch: { ...appLaunch, executableSha256: "missing" } },
      }),
    ).toThrow(/executableSha256/)
  })

  it("accepts only a fully measured sealed macOS system-volume source for Terminal.app", () => {
    const appLaunch = {
      bundlePath: "/System/Applications/Utilities/Terminal.app",
      cfBundleShortVersionString: "2.15",
      cfBundleVersion: "455",
      executablePath: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
      executableSha256: RECEIPT_EXECUTABLE_SHA256,
      sourceArtifact: {
        kind: "sealed-macos-system-volume",
        macOSBuild: "25E144",
        snapshotUUID: "11111111-2222-3333-4444-555555555555",
        snapshotName: "com.apple.os.update-AAA",
        sealed: true,
        codeSignature: { identifier: "com.apple.Terminal", cdHash: "b".repeat(40), strictVerified: true },
      },
    }
    const candidate = (launch: unknown) =>
      parseRun(
        "sealed-terminal.json",
        JSON.stringify(
          run("sealed-terminal", {
            target: { ...target, id: "terminal-app", version: "2.15" },
            rawReplies: {
              "device.primary-da": "\x1b[?1;2c",
              "device.secondary-da": "\x1b[>1;95;0c",
              "extensions.query": "ACK",
              "extensions.graphics": "NO",
            },
            origin: { kind: "collector", appLaunch: launch },
          }),
        ),
        catalog,
      )
    const accepted = candidate(appLaunch)
    expect(accepted.origin.appLaunch?.sourceArtifact).toMatchObject({ kind: "sealed-macos-system-volume" })
    expect(
      projectResults([accepted], [reviewFor(accepted)], catalog, { currentProbeHash: "current" }).current[
        "app:terminal-app"
      ]?.runId,
    ).toBe("sealed-terminal")
    for (const invalid of [
      { ...appLaunch, sourceArtifact: { ...appLaunch.sourceArtifact, sealed: false } },
      { ...appLaunch, sourceArtifact: { ...appLaunch.sourceArtifact, snapshotUUID: "" } },
      {
        ...appLaunch,
        sourceArtifact: {
          ...appLaunch.sourceArtifact,
          codeSignature: { ...appLaunch.sourceArtifact.codeSignature, strictVerified: false },
        },
      },
    ]) {
      expect(() => candidate(invalid)).toThrow(/sourceArtifact/)
    }
  })

  it("accepts a derived source tree for an app launch and refuses one with no upstream revision", () => {
    const appLaunch = {
      bundlePath: "/Applications/Ghostty.app",
      cfBundleShortVersionString: "1.3.1",
      cfBundleVersion: "1",
      executablePath: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
      executableSha256: RECEIPT_EXECUTABLE_SHA256,
      sourceArtifact: {
        kind: "derived-source-tree",
        url: "https://github.com/ghostty-org/ghostty/archive/refs/tags/v1.3.1.tar.gz",
        revision: "refs/tags/v1.3.1",
        narSri: "sha256-+ddMmUe9Jjkun4qqW8XFXVgwVZdVHsGWcQzndgIlBjQ=",
        sha256: RECEIPT_SOURCE_SHA256,
      },
    }
    const candidate = (launch: unknown) =>
      parseRun(
        "derived-source.json",
        JSON.stringify(
          run("derived-source", {
            target: { ...target, id: "terminal-app", version: "2.15" },
            rawReplies: {
              "device.primary-da": "\x1b[?1;2c",
              "device.secondary-da": "\x1b[>1;95;0c",
              "extensions.query": "ACK",
              "extensions.graphics": "NO",
            },
            origin: { kind: "collector", appLaunch: launch },
          }),
        ),
        catalog,
      )
    expect(candidate(appLaunch).origin.appLaunch?.sourceArtifact).toMatchObject({ kind: "derived-source-tree" })
    expect(() => candidate({ ...appLaunch, sourceArtifact: { ...appLaunch.sourceArtifact, revision: "" } })).toThrow(
      /revision/,
    )
    expect(() =>
      candidate({ ...appLaunch, sourceArtifact: { ...appLaunch.sourceArtifact, sha256: "not-a-sha256" } }),
    ).toThrow(/sourceArtifact/)
  })

  it("refuses a headless runtime receipt whose loaded engine version conflicts with target", () => {
    const value = run("headless-mismatch", {
      target: { ...target, kind: "headless" },
      runtimeIdentity: {
        kind: "js",
        runtimeFormat: "js",
        engineVersion: "0.40.0",
        resolvedPath: "/pkg/kitty/index.js",
        integrity: { kind: "registry", lockIntegrity: "sha512-example" },
        adapterVersion: "1.0.0",
        termlessRevision: "rev123",
      },
    })
    expect(() => parseRun("headless-mismatch.json", JSON.stringify(value), catalog)).toThrow(
      /headless-mismatch.*engineVersion/,
    )
  })

  it("keeps a dirty source engine in history even with a matching review", () => {
    const value = run("dirty-source", {
      target: { ...target, kind: "headless" },
      runtimeIdentity: {
        kind: "js",
        runtimeFormat: "js",
        engineVersion: target.version,
        resolvedPath: "/repo/packages/kitty/index.js",
        integrity: {
          kind: "source",
          repository: "/repo",
          revision: "a".repeat(40),
          treeOid: "b".repeat(40),
          cleanTree: false,
        },
        adapterVersion: "0.9.2",
        termlessRevision: "c".repeat(40),
      },
    })
    const parsed = parseRun("dirty-source.json", JSON.stringify(value), catalog)
    const projection = projectResults([parsed], [reviewFor(parsed)], catalog, { currentProbeHash: "current" })
    expect(projection.current["headless:kitty"]).toBeUndefined()
    expect(projection.exclusions).toContainEqual(
      expect.objectContaining({ runId: "dirty-source", reason: "runtime-identity-unverified" }),
    )
  })

  it("requires measured in-run native provenance for a selectable Linux app", () => {
    const provenance = {
      executable: { path: "/nix/store/kitty/bin/kitty", sha256: "a1".repeat(32), version: "kitty 0.46.2" },
      sourceArtifact: { url: "https://example.invalid/kitty-0.46.2.txz", sha256: "b7".repeat(32) },
      runtime: {
        imageId: `sha256:${"c".repeat(64)}`,
        imageTarSha256: "d4".repeat(32),
        arch: "x86_64-linux",
        nixLockRevision: "e".repeat(40),
        sourceRevision: "2".repeat(40),
        cleanTree: true,
        suiteHash: "current",
      },
      fixture: {
        definition: "curly underline before/after",
        config: "NONE",
        font: "DejaVu Sans Mono",
        geometry: "80x24, 800x600",
        display: "Xvfb :0",
        gl: "Mesa llvmpipe",
      },
    }
    const linux = (runId: string, changes: Record<string, unknown> = {}) =>
      parseRun(
        `${runId}.json`,
        JSON.stringify(run(runId, { target: { ...target, os: "linux" }, provenance, ...changes })),
        catalog,
      )
    const accepted = linux("linux-receipt")
    expect(accepted.provenance).toMatchObject(provenance)
    expect(
      projectResults([accepted], [reviewFor(accepted)], catalog, { currentProbeHash: "current" }).current["app:kitty"]
        ?.runId,
    ).toBe("linux-receipt")
    const missing = linux("linux-missing", { provenance: undefined })
    expect(
      projectResults([missing], [reviewFor(missing)], catalog, { currentProbeHash: "current" }).current["app:kitty"],
    ).toBeUndefined()
    const dirty = linux("linux-dirty", {
      provenance: { ...provenance, runtime: { ...provenance.runtime, cleanTree: false } },
    })
    expect(
      projectResults([dirty], [reviewFor(dirty)], catalog, { currentProbeHash: "current" }).current["app:kitty"],
    ).toBeUndefined()
    expect(() =>
      linux("linux-version-mismatch", {
        provenance: { ...provenance, executable: { ...provenance.executable, version: "kitty 0.46.20" } },
      }),
    ).toThrow(/executable.version.*target.version/)
    expect(() =>
      linux("linux-suite-mismatch", {
        provenance: { ...provenance, runtime: { ...provenance.runtime, suiteHash: "old" } },
      }),
    ).toThrow(/suiteHash.*probeHash/)
  })

  it("requires actual WASM bytes and a native sidecar bound to loaded bytes", () => {
    const wasm = run("wasm-no-binary", {
      target: { ...target, kind: "headless" },
      runtimeIdentity: {
        kind: "js",
        runtimeFormat: "wasm",
        engineVersion: target.version,
        resolvedPath: "/pkg/kitty/index.js",
        integrity: { kind: "registry", lockIntegrity: "sha512-example" },
        adapterVersion: "0.9.2",
        termlessRevision: "c".repeat(40),
      },
    })
    expect(() => parseRun("wasm-no-binary.json", JSON.stringify(wasm), catalog)).toThrow(/loadedBinary/)
    const native = run("native-hash-mismatch", {
      target: { ...target, kind: "headless" },
      runtimeIdentity: {
        kind: "native",
        engineVersion: target.version,
        loadedBinary: { path: "/pkg/kitty/engine.node", sha256: "a".repeat(64) },
        provenance: {
          sha256: "b".repeat(64),
          sourceCommit: "c".repeat(40),
          buildHash: "d".repeat(64),
          toolchain: "rustc 1",
          lockSha256: "e".repeat(64),
        },
        adapterVersion: "0.9.2",
        termlessRevision: "c".repeat(40),
      },
    })
    expect(() => parseRun("native-hash-mismatch.json", JSON.stringify(native), catalog)).toThrow(/sidecar SHA256/)
  })

  it("requires a per-probe screenshot reference for pixel evidence", () => {
    const withoutImage = run("pixels-no-image", {
      observations: [
        {
          featureId: "extensions.graphics",
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "pixels",
        },
      ],
    })
    expect(() => parseRun("pixels-no-image.json", JSON.stringify(withoutImage), catalog)).toThrow(
      /pixels-no-image.*screenshotRef/,
    )
    const prematureSupport = run("pixels-unreviewed", {
      probeHash: "pixels",
      screenshotRefs: [`sha256:${"a".repeat(64)}`],
      observations: [
        {
          featureId: "extensions.graphics",
          outcome: "supported",
          evidence: "pixels",
          screenshotRef: `sha256:${"a".repeat(64)}`,
        },
      ],
    })
    // @cto b12b71b2: a lone screenshotRef is not a decided verdict. Pixels are admitted in a raw
    // run only as a frame pair whose own assertion cites the digest it decided on.
    expect(() => parseRun("pixels-unreviewed.json", JSON.stringify(prematureSupport), catalog)).toThrow(
      /requires control and target frames/,
    )
    const captureError = run("pixels-capture-error", {
      probeHash: "pixels",
      assertions: [],
      observations: [
        { featureId: "extensions.graphics", outcome: "error", reason: "collector-error", evidence: "pixels" },
      ],
    })
    expect(parseRun("pixels-capture-error.json", JSON.stringify(captureError), catalog).observations).toMatchObject([
      { outcome: "error", reason: "collector-error", evidence: "pixels" },
    ])
  })

  it("binds control and target frames to the run before admitting pixel observations", () => {
    const control = `sha256:${"a".repeat(64)}`
    const targetRef = `sha256:${"b".repeat(64)}`
    const later = `sha256:${"c".repeat(64)}`
    const frames: [ObservationFrame, ObservationFrame] = [
      {
        role: "control",
        ref: control,
        capturedAt: 1,
        label: "unstyled X",
        sourceRef: `sha256:${"d".repeat(64)}`,
      },
      { role: "target", ref: targetRef, capturedAt: 2, label: "curly underline X" },
    ]
    const visual = (changes: Record<string, unknown> = {}) =>
      run("visual", {
        probeHash: "pixels",
        screenshotRefs: [control, targetRef, later],
        assertions: [],
        observations: [
          {
            featureId: "extensions.graphics",
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            evidence: "pixels",
            screenshotRef: targetRef,
            frames,
          },
        ],
        ...changes,
      })
    const observed = parseRun("visual.json", JSON.stringify(visual()), catalog)
    expect(observed.observations[0]?.frames).toEqual(frames)
    const correction = {
      ...reviewFor(observed),
      featureId: "extensions.graphics",
      sources: [control, targetRef],
      observation: {
        featureId: "extensions.graphics",
        outcome: "supported" as const,
        evidence: "pixels" as const,
        screenshotRef: targetRef,
        frames,
      },
    }
    expect(
      projectResults([observed], [correction], catalog, { currentProbeHash: "current" }).history["app:kitty"]?.[0]
        ?.cells["extensions.graphics"]?.outcome,
    ).toBe("supported")
    for (const alteredFrames of [
      [frames[0], { ...frames[1], capturedAt: 99 }],
      [
        { ...frames[0], role: "target" as const },
        { ...frames[1], role: "control" as const },
      ],
      [...frames, { ...frames[1], capturedAt: 3, label: "fabricated later frame" }],
    ]) {
      expect(() =>
        projectResults(
          [observed],
          [
            {
              ...correction,
              observation: {
                ...correction.observation,
                screenshotRef: alteredFrames[0]?.role === "target" ? control : targetRef,
                frames: alteredFrames,
              },
            },
          ],
          catalog,
          { currentProbeHash: "current" },
        ),
      ).toThrow(/immutable.*feature frame/)
    }
    const invalid = (candidate: unknown) =>
      parseRun("invalid-frame.json", JSON.stringify(visual({ observations: [candidate] })), catalog)
    const base = observed.observations[0]
    if (!base) throw new Error("missing visual observation")
    expect(() => invalid({ ...base, frames: [{ ...frames[0], ref: `sha256:${"e".repeat(64)}` }, frames[1]] })).toThrow(
      /absent from the run's screenshotRefs/,
    )
    expect(() => invalid({ ...base, frames: [frames[1]] })).toThrow(/control.*target/)
    expect(() => invalid({ ...base, frames: [frames[0]] })).toThrow(/control.*target/)
    expect(() => invalid({ ...base, screenshotRef: control })).toThrow(/primary.*target/)
    expect(() => invalid({ ...base, frames: [{ ...frames[0], sourceRef: "fixture.xwd" }, frames[1]] })).toThrow(
      /sourceRef/,
    )
    expect(() =>
      invalid({
        ...base,
        frames: [frames[0], frames[1], { role: "target", ref: later, capturedAt: 2, label: "later" }],
      }),
    ).toThrow(/target.*capturedAt/)
  })

  it("presents a text-snapshot frame with its text kind and original TXT URL", () => {
    const content = temporaryContent()
    const snapshot = Buffer.from("ab \ncd \n", "utf8")
    const digest = createHash("sha256").update(snapshot).digest("hex")
    const snapshotRef = `sha256:${digest}`
    writeFileSync(join(content, "artifacts", `${digest}.txt`), snapshot)
    // The same bytes under the screenshot extension: the kind, not the extension alone, decides the
    // check, so a text snapshot can never pass a PNG's rules.
    writeFileSync(join(content, "artifacts", `${digest}.png`), snapshot)
    const textFrame = (role: "control" | "target", at: number) => ({
      kind: "text-cells" as const,
      role,
      ref: snapshotRef,
      capturedAt: at,
      label: `${role} text`,
      cellDigest: snapshotRef,
      frameDigest: snapshotRef,
      cellRectangle: { top: 1, left: 1, bottom: 2, right: 3 },
    })
    const frames: [ObservationFrame, ObservationFrame] = [textFrame("control", 1), textFrame("target", 2)]
    const textRun = run("text-cells", {
      probeHash: "pixels",
      assertions: [],
      screenshotRefs: [],
      textSnapshotRefs: [snapshotRef],
      observations: [
        {
          featureId: "extensions.graphics",
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "text",
          frames,
        },
      ],
    })
    writeFileSync(join(content, "probes-apps", "text-cells.json"), JSON.stringify(textRun))
    // The retained bytes are admitted as a text snapshot, and refused as a screenshot: one kind
    // table decides both, so the same bytes cannot pass the other kind's check.
    expect(readVerifiedArtifact(content, snapshotRef, "text-cells.json", "text-snapshot")).toEqual(snapshot)
    expect(() => readVerifiedArtifact(content, snapshotRef, "text-cells.json")).toThrow(/is not a PNG/)
    const measured = parseRun("text-cells.json", JSON.stringify(textRun), catalog)
    const projection = projectResults([measured], [], catalog, { currentProbeHash: "current" })
    const cell = projection.history["app:kitty"]?.[0]?.cells["extensions.graphics"]
    // The frame keeps its kind and digest and gets NO url: no .txt URL is emitted for a renderer
    // that only knows how to draw an <img>.
    expect(cell?.record.frames?.map(({ kind, url, sha256 }) => ({ kind, url, sha256 }))).toEqual([
      { kind: "text-cells", url: undefined, sha256: digest },
      { kind: "text-cells", url: undefined, sha256: digest },
    ])
    expect(cell?.conclusive).toBe(false)
    // The presentation owner maps retained text to TXT while preserving its distinct kind.
    const present = {
      id: "present-text",
      runId: measured.runId,
      runSha256: measured.sha256,
      reviewer: "reviewer",
      reason: "show the reviewed text snapshot",
      scope: reviewFor(measured).scope,
      sources: ["capture://text-cells"],
      supersedes: [] as string[],
      featureId: "extensions.graphics",
      presentsEvidence: true,
    }
    const presented = projectResults([measured], [present], catalog, { currentProbeHash: "current" })
    const published = publicResults(presented, new Map())
    const publicCell = published.projection.history["app:kitty"]?.[0]?.cells["extensions.graphics"]
    const expectedFrames = frames.map((frame) => ({
      role: frame.role,
      label: frame.label,
      capturedAt: frame.capturedAt,
      kind: "text-cells",
      url: `/artifacts/${digest}.txt`,
      sha256: digest,
    }))
    expect(publicCell?.record?.frames).toEqual(expectedFrames)
    expect(publicCell?.record).not.toHaveProperty("screenshot")
    expect(publicCell?.presentation.state).toBe("presented")
    if (publicCell?.presentation.state === "presented") {
      expect(publicCell.presentation.url).toBe(`/api/v2/evidence/${measured.sha256}.json#extensions.graphics`)
    }
    expect(published.documents.get(`/api/v2/evidence/${measured.sha256}.json`)?.document).toMatchObject({
      cells: {
        "extensions.graphics": {
          record: { frames: expectedFrames },
        },
      },
    })
    const multiRun = parseRun("multi-cell.json", JSON.stringify(run("multi-cell")), catalog)
    const presentGraphics = {
      ...present,
      id: "present-graphics-in-same-run",
      runId: multiRun.runId,
      runSha256: multiRun.sha256,
      scope: reviewFor(multiRun).scope,
      featureId: "extensions.graphics",
    }
    const presentQuery = {
      ...presentGraphics,
      id: "present-query-in-same-run",
      featureId: "extensions.query",
    }
    const multiPresented = projectResults([multiRun], [reviewFor(multiRun), presentGraphics, presentQuery], catalog, {
      currentProbeHash: "current",
    })
    const multiPublished = publicResults(multiPresented, new Map())
    expect([...multiPublished.documents.keys()]).toEqual([`/api/v2/evidence/${multiRun.sha256}.json`])
    const runDoc = multiPublished.documents.get(`/api/v2/evidence/${multiRun.sha256}.json`)!
    const expectedSha = createHash("sha256").update(runDoc.bytes).digest("hex")
    const versionCells = multiPublished.projection.current["app:kitty"]?.cells
    expect(versionCells?.["extensions.graphics"]?.presentation).toMatchObject({
      state: "presented",
      url: `/api/v2/evidence/${multiRun.sha256}.json#extensions.graphics`,
      sha256: expectedSha,
    })
    expect(versionCells?.["extensions.query"]?.presentation).toMatchObject({
      state: "presented",
      url: `/api/v2/evidence/${multiRun.sha256}.json#extensions.query`,
      sha256: expectedSha,
    })
    const parsedRunDoc = JSON.parse(runDoc.bytes) as {
      version: number
      runId: string
      runSha256: string
      cells: Record<string, Record<string, unknown>>
    }
    const baseExpectation = {
      schemaVersion: multiRun.schemaVersion,
      runId: multiRun.runId,
      runSha256: multiRun.sha256,
      featureId: "extensions.graphics",
      reviewId: "present-graphics-in-same-run",
    }
    expect(readCellEvidence(parsedRunDoc, baseExpectation)).toMatchObject({
      version: 2,
      runId: multiRun.runId,
      runSha256: multiRun.sha256,
      featureId: "extensions.graphics",
      review: { id: "present-graphics-in-same-run" },
    })
    expect(() => readCellEvidence(parsedRunDoc, { ...baseExpectation, featureId: "cursor.position" })).toThrow(
      "no evidence stored for this cell",
    )
    expect(() => readCellEvidence(parsedRunDoc, { ...baseExpectation, runSha256: "0".repeat(64) })).toThrow(
      "Evidence document identity or structure does not match this result",
    )
    expect(() =>
      readCellEvidence(
        {
          ...parsedRunDoc,
          cells: {
            ...parsedRunDoc.cells,
            "extensions.graphics": { ...parsedRunDoc.cells["extensions.graphics"], featureId: "extensions.query" },
          },
        },
        baseExpectation,
      ),
    ).toThrow("Evidence document identity or structure does not match this result")
    expect(() => readCellEvidence(parsedRunDoc, { ...baseExpectation, reviewId: "wrong-review" })).toThrow(
      "Evidence document identity or structure does not match this result",
    )
    expect(() => readCellEvidence({ ...parsedRunDoc, version: 1 }, baseExpectation)).toThrow(
      "Evidence document identity or structure does not match this result",
    )
    const redirects = readFileSync(join(import.meta.dirname, "..", "docs", "public", "_redirects"), "utf8")
    expect(redirects).toContain("/api/v2/evidence/:run/*   /api/v2/evidence/:run.json   301")
  })

  // AC2–AC4: the public result reader must promote a reviewed character claim only from this
  // run's verified five-shape bytes. The old text test has no qualification and cannot catch it.
  it.each(
    [
      { name: "all five", missing: undefined, os: "macos", declared: true, fault: undefined, expected: true },
      ...["mid-line-gap", "trailing-gap", "soft-wrap", "prior-scrollback", "empty-last-row"].map((missing) => ({
        name: `missing ${missing}`,
        missing,
        fault: undefined,
        os: "macos",
        declared: true,
        expected: false,
      })),
      // A run outside the recipe's context is neither admitted nor qualified by the macOS recipe it recorded.
      { name: "Windows", missing: undefined, os: "windows", declared: true, fault: undefined, expected: false },
      { name: "Linux", missing: undefined, os: "linux", declared: true, fault: undefined, expected: false },
      { name: "undeclared claim", missing: undefined, os: "macos", declared: false, fault: undefined, expected: false },
      ...[
        "changed-bytes",
        "failed-shape",
        "wrong-rectangle",
        "wrong-version",
        "suite-recipe-mismatch",
        "console-host",
        "extra-control",
        "extra-target",
      ].map((fault) => ({
        name: fault,
        missing: undefined,
        os: "macos",
        declared: true,
        fault,
        expected: false,
      })),
    ].flatMap((scenario) =>
      (["supported", "unsupported"] as const).flatMap((outcome) =>
        [false, true].map((interpreted) => ({ ...scenario, outcome, interpreted })),
      ),
    ),
  )(
    "qualifies a character text result: $name/$outcome/interpreted=$interpreted",
    ({ missing, os, declared, fault, expected, outcome, interpreted }) => {
      const content = temporaryContent()
      const featureId = "text.overwrite"
      const suiteId = "qualified-text"
      const blank = "            "
      const filled = ["CCCCCCCCCCCC", "CCCCCCCCCCCC", "CCCCCCCCCCCC", "CCCCCCCCCCCC"]
      // Independently stated expected grids for R=4, C=12; do not call the recipe under test.
      const prior = ["H2          ", "H3          ", "H4          ", "H5          "]
      const grids = [
        { shape: "mid-line-gap", control: filled, target: ["A       B   ", blank, blank, "Z           "] },
        { shape: "trailing-gap", control: filled, target: ["A           ", "B           ", blank, "Z           "] },
        { shape: "soft-wrap", control: filled, target: ["WWWWWWWWWWWW", "XY          ", blank, blank] },
        {
          shape: "prior-scrollback",
          control: ["H0          ", "H1          ", "H2          ", "H3          "],
          target: prior,
        },
        { shape: "empty-last-row", control: prior, target: ["H3          ", "H4          ", "H5          ", blank] },
      ]
      const refs = new Set<string>()
      const textSnapshots = new Map<string, Buffer>()
      let capturedAt = 0
      const frame = (rows: readonly string[], role: "control" | "target"): ObservationFrame => {
        const bytes = Buffer.from(
          (fault === "changed-bytes" && role === "target" ? ["X           ", ...rows.slice(1)] : rows).join("\n"),
          "utf8",
        )
        const digest = createHash("sha256").update(bytes).digest("hex")
        const ref = `sha256:${digest}`
        refs.add(ref)
        writeFileSync(join(content, "artifacts", `${digest}.txt`), bytes)
        textSnapshots.set(ref, readVerifiedArtifact(content, ref, "qualified-text.json", "text-snapshot"))
        return {
          kind: "text-cells",
          role,
          ref,
          capturedAt: ++capturedAt,
          label: `${role} grid`,
          cellDigest: ref,
          frameDigest: ref,
          cellRectangle: { top: 1, left: 1, bottom: fault === "wrong-rectangle" ? 3 : 4, right: 12 },
        }
      }
      const shapes = grids
        .filter(({ shape }) => shape !== missing)
        .map(({ shape, control, target }) => {
          if (fault === "failed-shape" && shape === "mid-line-gap") return { shape, reason: "terminal refused shape" }
          const frames = [frame(control, "control"), frame(target, "target")]
          // A valid first pair cannot hide a later, conflicting witness for this same shape.
          if (shape === "mid-line-gap" && (fault === "extra-control" || fault === "extra-target")) {
            frames.push(frame(["D           ", blank, blank, blank], fault === "extra-control" ? "control" : "target"))
          }
          return { shape, frames }
        })
      const observationFrames = [frame(filled, "control"), frame(["AX          ", blank, blank, blank], "target")]
      const targetRef = observationFrames[1]?.ref
      if (!targetRef) throw new Error("Missing target fixture")
      const suite = Object.assign(manifest(suiteId, [featureId]), {
        textClaims: declared ? [featureId] : [],
        textQualification: {
          version: 2,
          recipes: [fault === "suite-recipe-mismatch" ? "other-suite-recipe" : "macos-text-cells-v1"],
        },
      })
      const raw = run("qualified-text", {
        target: { ...target, os },
        probeHash: suiteId,
        textSnapshotRefs: [...refs],
        textQualification: {
          version: fault === "wrong-version" ? 1 : 2,
          recipe: "macos-text-cells-v1",
          grid: { rows: 4, cols: 12 },
          shapes,
        },
        rawReplies: { ...identityReplies, [featureId]: "retained character comparison" },
        assertions: [
          {
            featureId,
            kind: outcome === "supported" ? "positive" : "negative",
            rawReplyRef: featureId,
            expected: "the sampled character grid",
            observed: targetRef,
          },
        ],
        observations: [
          {
            featureId,
            outcome,
            evidence: "text",
            rawReplyRef: featureId,
            frames: observationFrames,
            ...(fault === "console-host" && {
              host: {
                image: "OpenConsole.exe",
                executablePath: "C:/Windows/OpenConsole.exe",
                executableSha256: `sha256:${"a".repeat(64)}`,
              },
            }),
          },
        ],
      })
      const measured = parseRunSource(
        "qualified-text.json",
        JSON.stringify(raw),
        [featureId],
        new Map([[suiteId, suite]]),
      )
      const original = measured.observations.find((entry) => entry.featureId === featureId)!
      // Deliberately omit the original console host: an interpretation cannot hide immutable host facts.
      const { host: _host, ...reviewedObservation } = original
      const correction = { ...reviewFor(measured), featureId, observation: reviewedObservation }
      const projection = projectResults(
        [measured],
        interpreted ? [correction] : [],
        [featureId],
        Object.assign({ currentProbeHash: suiteId }, { textSnapshots }),
      )
      const version = projection.history["app:kitty"]?.[0]
      const cell = version?.cells[featureId]
      expect(cell?.outcome).toBe(outcome)
      expect(cell?.conclusive).toBe(expected)
      expect(projection.table[measured.runId]?.[featureId]).toBe(classifyCell(cell!))
      expect(version?.textQualification).toEqual(measured.textQualification)
      const failedAssessment =
        missing !== undefined ||
        os !== "macos" ||
        [
          "changed-bytes",
          "failed-shape",
          "wrong-rectangle",
          "wrong-version",
          "suite-recipe-mismatch",
          "extra-control",
          "extra-target",
        ].includes(fault ?? "")
      if (failedAssessment) {
        expect(cell?.textQualificationReason).toMatch(/Run qualified-text: /u)
        if (missing) expect(cell?.textQualificationReason).toContain(missing)
        if (os !== "macos") {
          expect(cell?.textQualificationReason).toContain("is not the recipe for this run's observer context (none)")
        }
        if (fault === "suite-recipe-mismatch") {
          expect(cell?.textQualificationReason).toContain("cited suite declaration")
        }
        if (fault === "extra-control" || fault === "extra-target") {
          expect(cell?.textQualificationReason).toContain("mid-line-gap requires exactly one control and one target")
        }
      } else {
        expect(cell).not.toHaveProperty("textQualificationReason")
      }
      if (interpreted) expect(cell?.chain.correctionId).toBe(correction.id)
    },
  )
  it("keeps a supported raw text observation non-conclusive", () => {
    const content = temporaryContent()
    const snapshot = Buffer.from("ab \ncd \n", "utf8")
    const digest = createHash("sha256").update(snapshot).digest("hex")
    const snapshotRef = `sha256:${digest}`
    writeFileSync(join(content, "artifacts", `${digest}.txt`), snapshot)
    const textFrame = (role: "control" | "target", at: number) => ({
      kind: "text-cells" as const,
      role,
      ref: snapshotRef,
      capturedAt: at,
      label: `${role} text`,
      cellDigest: snapshotRef,
      frameDigest: snapshotRef,
      cellRectangle: { top: 1, left: 1, bottom: 2, right: 3 },
    })
    const frames: [ObservationFrame, ObservationFrame] = [textFrame("control", 1), textFrame("target", 2)]
    // A raw decided text row carries its own bound positive assertion, exactly as a decided pixel
    // row does, and the assertion cites the frame digest the verdict rests on.
    const textRun = run("text-supported", {
      probeHash: "pixels",
      textSnapshotRefs: [snapshotRef],
      observations: [
        {
          featureId: "extensions.graphics",
          outcome: "supported",
          evidence: "text",
          rawReplyRef: "extensions.graphics",
          frames,
        },
      ],
      assertions: [
        {
          featureId: "extensions.graphics",
          kind: "positive",
          rawReplyRef: "extensions.graphics",
          expected: "the text snapshot to show",
          observed: snapshotRef,
        },
      ],
    })
    const measured = parseRun("text-supported.json", JSON.stringify(textRun), catalog)
    const projection = projectResults([measured], [], catalog, { currentProbeHash: "current" })
    const cell = projection.history["app:kitty"]?.[0]?.cells["extensions.graphics"]
    // A raw text verdict reads as supported and is still never a measurement: the cells are not
    // decisive until the app's own hosted rows pass all five readback shapes — a mid-line gap, a
    // trailing gap, a soft wrap, an empty last row, and prior scrollback.
    expect(cell?.outcome).toBe("supported")
    expect(cell?.conclusive).toBe(false)
    expect(cell).not.toHaveProperty("textQualificationReason")
    expect(projection.history["app:kitty"]?.[0]).not.toHaveProperty("textQualification")
  })

  // 30055 AC4: the public cell carries the host the observation recorded, and a pixels row carries
  // none — the site reads one structured field, never a caption parsed out of a raw reply.
  it("carries the console host onto the public text cell, and a pixels cell has none", () => {
    const content = temporaryContent()
    const snapshot = Buffer.from("ab \ncd \n", "utf8")
    const snapshotDigest = createHash("sha256").update(snapshot).digest("hex")
    const snapshotRef = `sha256:${snapshotDigest}`
    writeFileSync(join(content, "artifacts", `${snapshotDigest}.txt`), snapshot)
    const textFrame = (role: "control" | "target", at: number) => ({
      kind: "text-cells" as const,
      role,
      ref: snapshotRef,
      capturedAt: at,
      label: `${role} text`,
      cellDigest: snapshotRef,
      frameDigest: snapshotRef,
      cellRectangle: { top: 1, left: 1, bottom: 2, right: 3 },
    })
    const frames: [ObservationFrame, ObservationFrame] = [textFrame("control", 1), textFrame("target", 2)]
    const host = {
      image: "OpenConsole.exe",
      executablePath: "C:\\Windows\\System32\\OpenConsole.exe",
      executableSha256: `sha256:${"c".repeat(64)}`,
    }
    const textRun = run("windows-text-host", {
      probeHash: "pixels",
      assertions: [],
      screenshotRefs: [],
      textSnapshotRefs: [snapshotRef],
      observations: [
        {
          featureId: "extensions.graphics",
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "text",
          frames,
          host,
        },
      ],
    })
    const measuredText = parseRun("windows-text-host.json", JSON.stringify(textRun), catalog)
    const textProjection = projectResults([measuredText], [], catalog, { currentProbeHash: "current" })
    const textCell = publicResults(textProjection, new Map()).projection.history["app:kitty"]?.[0]?.cells[
      "extensions.graphics"
    ]
    expect(textCell?.host).toEqual(host)

    const controlRef = `sha256:${createHash("sha256").update("control-png").digest("hex")}`
    const targetRef = `sha256:${createHash("sha256").update("target-png").digest("hex")}`
    const pixelsRun = run("windows-pixels", {
      probeHash: "pixels",
      assertions: [],
      screenshotRefs: [controlRef, targetRef],
      observations: [
        {
          featureId: "extensions.graphics",
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "pixels",
          screenshotRef: targetRef,
          frames: [
            { role: "control", ref: controlRef, capturedAt: 1, label: "before" },
            { role: "target", ref: targetRef, capturedAt: 2, label: "after" },
          ],
        },
      ],
    })
    const measuredPixels = parseRun("windows-pixels.json", JSON.stringify(pixelsRun), catalog)
    const pixelsProjection = projectResults([measuredPixels], [], catalog, { currentProbeHash: "current" })
    const pixelsCell = publicResults(pixelsProjection, new Map()).projection.history["app:kitty"]?.[0]?.cells[
      "extensions.graphics"
    ]
    expect(pixelsCell).toBeDefined()
    expect(pixelsCell?.host).toBeUndefined()
  })

  it("binds a text interpretation to the run's own frames, and keeps it non-conclusive", () => {
    const content = temporaryContent()
    const snapshot = Buffer.from("ab \ncd \n", "utf8")
    const digest = createHash("sha256").update(snapshot).digest("hex")
    const snapshotRef = `sha256:${digest}`
    writeFileSync(join(content, "artifacts", `${digest}.txt`), snapshot)
    const textFrame = (role: "control" | "target", at: number) => ({
      kind: "text-cells" as const,
      role,
      ref: snapshotRef,
      capturedAt: at,
      label: `${role} text`,
      cellDigest: snapshotRef,
      frameDigest: snapshotRef,
      cellRectangle: { top: 1, left: 1, bottom: 2, right: 3 },
    })
    const frames: [ObservationFrame, ObservationFrame] = [textFrame("control", 1), textFrame("target", 2)]
    const textRun = run("text-cells", {
      probeHash: "pixels",
      assertions: [],
      screenshotRefs: [],
      textSnapshotRefs: [snapshotRef],
      observations: [
        {
          featureId: "extensions.graphics",
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "text",
          frames,
        },
      ],
    })
    const measured = parseRun("text-cells.json", JSON.stringify(textRun), catalog)
    const correction = {
      ...reviewFor(measured),
      featureId: "extensions.graphics",
      sources: [snapshotRef],
      observation: {
        featureId: "extensions.graphics",
        outcome: "supported" as const,
        evidence: "text" as const,
        frames,
      },
    }
    // A text interpretation is recomputable exactly as a pixel one is: this run's bytes, its own
    // recorded frames, and a decision that still reads non-conclusive on the site.
    const reviewed = projectResults([measured], [correction], catalog, { currentProbeHash: "current" })
    expect(reviewed.history["app:kitty"]?.[0]?.cells["extensions.graphics"]?.outcome).toBe("supported")
    expect(reviewed.history["app:kitty"]?.[0]?.cells["extensions.graphics"]?.conclusive).toBe(false)
    expect(() =>
      projectResults(
        [measured],
        [{ ...correction, observation: { ...correction.observation, frames: undefined } }],
        catalog,
        { currentProbeHash: "current" },
      ),
    ).toThrow(/text interpretation .* requires control and target frames/)
    expect(() =>
      projectResults(
        [measured],
        [
          {
            ...correction,
            observation: { ...correction.observation, frames: [frames[0], { ...frames[1], capturedAt: 99 }] },
          },
        ],
        catalog,
        { currentProbeHash: "current" },
      ),
    ).toThrow(/immutable.*feature frame/)
  })

  it("cannot borrow another feature's retained image for a reviewed pixel result", () => {
    const control = `sha256:${"a".repeat(64)}`
    const graphics = `sha256:${"b".repeat(64)}`
    const query = `sha256:${"c".repeat(64)}`
    const graphicsFrames = [
      { role: "control" as const, ref: control, capturedAt: 1, label: "control" },
      { role: "target" as const, ref: graphics, capturedAt: 2, label: "graphics" },
    ]
    const queryFrames = [
      { role: "control" as const, ref: control, capturedAt: 3, label: "control" },
      { role: "target" as const, ref: query, capturedAt: 4, label: "query" },
    ]
    const measured = parseRun(
      "two-features.json",
      JSON.stringify(
        run("two-features", {
          screenshotRefs: [control, graphics, query],
          assertions: [],
          observations: [
            {
              featureId: "extensions.graphics",
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "pixels",
              screenshotRef: graphics,
              frames: graphicsFrames,
            },
            {
              featureId: "extensions.query",
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "pixels",
              screenshotRef: query,
              frames: queryFrames,
            },
          ],
        }),
      ),
      catalog,
    )
    const correction = {
      ...reviewFor(measured),
      featureId: "extensions.graphics",
      observation: {
        featureId: "extensions.graphics",
        outcome: "supported" as const,
        evidence: "pixels" as const,
        screenshotRef: query,
        frames: [graphicsFrames[0]!, queryFrames[1]!],
      },
    }
    expect(() => projectResults([measured], [correction], catalog, { currentProbeHash: "current" })).toThrow(
      /immutable.*feature frame/,
    )
  })

  it("refuses a reviewed animation claim from a static pixel pair", () => {
    const ids = [...catalog, "sgr.blink"]
    const suites = new Map([...manifests, ["blink", manifest("blink", ["sgr.blink"])]])
    const control = `sha256:${"a".repeat(64)}`
    const targetRef = `sha256:${"b".repeat(64)}`
    const later = `sha256:${"c".repeat(64)}`
    const frames = [
      { role: "control" as const, ref: control, capturedAt: 1, label: "unblinking" },
      { role: "target" as const, ref: targetRef, capturedAt: 2, label: "phase one" },
    ]
    const measured = parseRunSource(
      "blink.json",
      JSON.stringify(
        run("blink", {
          probeHash: "blink",
          screenshotRefs: [control, targetRef, later],
          assertions: [],
          observations: [
            {
              featureId: "sgr.blink",
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "pixels",
              screenshotRef: targetRef,
              frames,
            },
          ],
        }),
      ),
      ids,
      suites,
    )
    const correction = {
      ...reviewFor(measured),
      featureId: "sgr.blink",
      observation: {
        featureId: "sgr.blink",
        outcome: "supported" as const,
        evidence: "pixels" as const,
        screenshotRef: targetRef,
        frames,
      },
    }
    expect(() => projectResults([measured], [correction], ids, { currentProbeHash: "blink" })).toThrow(
      /temporal.*2 target/,
    )
    const temporalFrames = [...frames, { role: "target" as const, ref: later, capturedAt: 3, label: "phase two" }]
    const temporalMeasured = parseRunSource(
      "blink-temporal.json",
      JSON.stringify(
        run("blink-temporal", {
          probeHash: "blink",
          screenshotRefs: [control, targetRef, later],
          assertions: [],
          observations: [
            {
              featureId: "sgr.blink",
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "pixels",
              screenshotRef: later,
              frames: temporalFrames,
            },
          ],
        }),
      ),
      ids,
      suites,
    )
    const temporal = {
      ...reviewFor(temporalMeasured),
      featureId: "sgr.blink",
      observation: {
        ...correction.observation,
        screenshotRef: later,
        frames: temporalFrames,
      },
    }
    expect(
      projectResults([temporalMeasured], [temporal], ids, { currentProbeHash: "blink" }).history["app:kitty"]?.[0]
        ?.cells["sgr.blink"]?.outcome,
    ).toBe("supported")
  })

  it("rejects a future schema even when it also carries legacy fields", () => {
    const hybrid = {
      ...run("hybrid"),
      schemaVersion: 4,
      terminal: "kitty",
      terminalVersion: "0.46.2",
      generated: "2026-09-28T12:00:00.000Z",
      results: { "cursor.position": true },
    }
    expect(() => parseRun("future.json", JSON.stringify(hybrid), catalog)).toThrow(/future\.json.*schemaVersion/)
  })

  it("rejects correction evidence that cannot be traced to the immutable run", () => {
    const measured = parseRun("run.json", JSON.stringify(run("evidence-run")), catalog)
    const base = {
      id: "correction",
      reviewer: "reviewer",
      reason: "reviewed evidence",
      scope: {
        target: { kind: "app" as const, id: "kitty" },
        versions: ["0.46.2", "0.46.2"] as [string, string],
        suites: ["suite-2", "suite-2"] as [string, string],
      },
      sources: ["capture://1"],
      supersedes: [],
      featureId: "extensions.graphics",
    }
    const pixels = {
      ...base,
      observation: { featureId: "extensions.graphics", outcome: "supported" as const, evidence: "pixels" as const },
    }
    expect(() => parseInterpretations("interpretations.json", JSON.stringify([pixels]), catalog)).toThrow(
      /screenshotRef/,
    )
    const inventedRaw = {
      ...base,
      observation: {
        featureId: "extensions.graphics",
        outcome: "supported" as const,
        evidence: "query" as const,
        rawReplyRef: "missing-reply",
      },
    }
    expect(() =>
      projectResults([measured], [reviewFor(measured), inventedRaw], catalog, { currentProbeHash: "current" }),
    ).toThrow(/missing-reply/)
  })

  it("supersedes corrections and identity reviews regardless of file order", () => {
    const measured = parseRun("run.json", JSON.stringify(run("supersession")), catalog)
    const scope = {
      target: { kind: "app" as const, id: "kitty" },
      versions: ["0.46.2", "0.46.2"] as [string, string],
      suites: ["suite-2", "suite-2"] as [string, string],
    }
    const a = {
      id: "a",
      reviewer: "reviewer",
      reason: "first reading",
      scope,
      sources: ["capture://a"],
      supersedes: [],
      featureId: "extensions.graphics",
      observation: {
        featureId: "extensions.graphics",
        outcome: "supported" as const,
        evidence: "behavior" as const,
        rawReplyRef: "extensions.graphics",
      },
    }
    const b = {
      id: "b",
      reviewer: "reviewer",
      reason: "corrected reading",
      scope,
      sources: ["capture://b"],
      supersedes: ["a"],
      featureId: "extensions.graphics",
      observation: {
        featureId: "extensions.graphics",
        outcome: "inconclusive" as const,
        reason: "timeout" as const,
        evidence: "behavior" as const,
        rawReplyRef: "extensions.graphics",
      },
    }
    expect(
      projectResults([measured], [reviewFor(measured), b, a], catalog, { currentProbeHash: "current" }).current[
        "app:kitty"
      ]?.cells["extensions.graphics"]?.outcome,
    ).toBe("inconclusive")
    const review = reviewFor(measured)
    const revoke = { ...review, id: "revoke", verifiesIdentity: false, reviewed: false, supersedes: [review.id] }
    const afterRevoke = projectResults([measured], [review, revoke], catalog, { currentProbeHash: "current" }).current[
      "app:kitty"
    ]
    expect(afterRevoke?.runId).toBe("supersession")
    expect(afterRevoke?.reviews).toEqual([])
  })

  it("presents only the immutable original feature payload across a correction and withdrawal", () => {
    const measured = parseRun("presentation.json", JSON.stringify(run("presentation")), catalog)
    const base = {
      runId: measured.runId,
      runSha256: measured.sha256,
      reviewer: "reviewer",
      reason: "reviewed original feature evidence",
      scope: reviewFor(measured).scope,
      sources: ["capture://presentation"],
      supersedes: [] as string[],
      featureId: "extensions.graphics",
    }
    const decision = { ...base, id: "show-graphics", presentsEvidence: true }
    const correction = {
      ...base,
      id: "correct-graphics",
      observation: observation("extensions.graphics", "inconclusive", "behavior", "timeout"),
    }
    const selected = projectResults([measured], [reviewFor(measured), correction, decision], catalog, {
      currentProbeHash: "current",
    }).current["app:kitty"]?.cells["extensions.graphics"]
    expect(selected?.outcome).toBe("inconclusive")
    expect(selected?.presentation?.decision).toEqual({
      id: decision.id,
      reviewer: decision.reviewer,
      reason: decision.reason,
      sources: decision.sources,
      presentsEvidence: true,
    })
    expect(selected?.presentation?.original.observation).toEqual(measured.observations[1])
    expect(selected?.presentation?.original.record).toEqual({
      rawReply: "NO",
      assertions: measured.assertions.filter((assertion) => assertion.featureId === "extensions.graphics"),
    })
    expect(selected?.presentation?.original.observation.outcome).toBe("unsupported")
    const withdrawal = {
      ...base,
      id: "withdraw-graphics",
      reason: "no longer present on the site",
      supersedes: [decision.id],
      presentsEvidence: false,
    }
    const withdrawn = projectResults([measured], [reviewFor(measured), correction, decision, withdrawal], catalog, {
      currentProbeHash: "current",
    })
    expect(withdrawn.current["app:kitty"]?.cells["extensions.graphics"]?.presentation?.decision).toMatchObject({
      id: withdrawal.id,
      reason: withdrawal.reason,
      presentsEvidence: false,
    })
    expect(withdrawn.current["app:kitty"]?.cells["extensions.graphics"]?.presentation?.original.observation).toEqual(
      measured.observations[1],
    )
    expect(withdrawn.current["app:kitty"]?.cells["extensions.query"]?.presentation).toBeUndefined()
  })

  it("requires exclusive, exact, existing and in-scope presentation bindings by record name", () => {
    const measured = parseRun("presentation.json", JSON.stringify(run("presentation-bindings")), catalog)
    const decision = {
      id: "present-query",
      runId: measured.runId,
      runSha256: measured.sha256,
      reviewer: "reviewer",
      reason: "reviewed original query",
      scope: reviewFor(measured).scope,
      sources: ["capture://query"],
      supersedes: [],
      featureId: "extensions.query",
      presentsEvidence: false,
    }
    const parse = (entry: Record<string, unknown>) =>
      parseInterpretations("interpretations.json", JSON.stringify([entry]), catalog)
    for (const extra of [
      { reviewed: false },
      { verifiesIdentity: false },
      { observation: null },
      { origin: "documentation" },
    ]) {
      expect(() => parse({ ...decision, ...extra })).toThrow(
        /present-query.*(reviewed|verifiesIdentity|observation|origin)/,
      )
    }
    expect(() => parse({ ...decision, presentsEvidence: "yes" })).toThrow(/present-query.*presentsEvidence/)
    expect(() => parse({ ...decision, runId: undefined })).toThrow(/present-query.*runId/)
    expect(() => parse({ ...decision, runSha256: undefined })).toThrow(/present-query.*run SHA256/)
    expect(() => parse({ ...decision, featureId: undefined })).toThrow(/present-query.*featureId/)
    const project = (entry: typeof decision) =>
      projectResults([measured], [entry], catalog, { currentProbeHash: "current" })
    expect(() => project({ ...decision, runId: "missing-run" })).toThrow(/present-query.*runId/)
    expect(() => project({ ...decision, runSha256: "0".repeat(64) })).toThrow(/present-query.*SHA256/)
    expect(() =>
      project({ ...decision, scope: { ...decision.scope, versions: ["9.0", "9.0"] as [string, string] } }),
    ).toThrow(/present-query.*scope/)
    expect(() => project({ ...decision, featureId: "cursor.position" })).toThrow(/present-query.*observation/)
  })

  it("refuses duplicate active presentation decisions and cross-decision supersession", () => {
    const measured = parseRun("presentation.json", JSON.stringify(run("presentation-supersession")), catalog)
    const review = reviewFor(measured)
    const decision = {
      id: "present-query",
      runId: measured.runId,
      runSha256: measured.sha256,
      reviewer: "reviewer",
      reason: "reviewed query",
      scope: review.scope,
      sources: ["capture://query"],
      supersedes: [] as string[],
      featureId: "extensions.query",
      presentsEvidence: true,
    }
    const project = (entries: Parameters<typeof projectResults>[1]) =>
      projectResults([measured], entries, catalog, { currentProbeHash: "current" })
    for (const presentsEvidence of [true, false]) {
      expect(() => project([decision, { ...decision, id: "duplicate", presentsEvidence }])).toThrow(
        /present-query.*duplicate|duplicate.*present-query/,
      )
    }
    expect(() => project([review, { ...decision, id: "cross", supersedes: [review.id] }])).toThrow(
      /cross.*review-presentation-supersession|cross.*review-presentation|cross.*review/,
    )
    expect(() => project([decision, { ...review, id: "cross-back", supersedes: [decision.id] }])).toThrow(
      /cross-back.*present-query/,
    )
    const otherRun = parseRun("other.json", JSON.stringify(run("other-run")), catalog)
    expect(() =>
      projectResults(
        [measured, otherRun],
        [
          decision,
          {
            ...decision,
            id: "wrong-target",
            runId: otherRun.runId,
            runSha256: otherRun.sha256,
            supersedes: [decision.id],
          },
        ],
        catalog,
        { currentProbeHash: "current" },
      ),
    ).toThrow(/wrong-target.*present-query/)
  })

  it("compares measured instants across time zones", () => {
    const earlier = parseRun(
      "earlier.json",
      JSON.stringify(run("earlier", { measuredAt: "2026-09-28T14:00:00+02:00" })),
      catalog,
    )
    const later = parseRun("later.json", JSON.stringify(run("later", { measuredAt: "2026-09-28T12:30:00Z" })), catalog)
    expect(
      projectResults([earlier, later], [reviewFor(earlier), reviewFor(later)], catalog, { currentProbeHash: "current" })
        .current["app:kitty"]?.runId,
    ).toBe("later")
  })

  it("rejects malformed interpretation ranges and boolean review fields", () => {
    const measured = parseRun("run.json", JSON.stringify(run("scope-run")), catalog)
    const review = reviewFor(measured)
    expect(() =>
      parseInterpretations(
        "bad-range.json",
        JSON.stringify([{ ...review, scope: { ...review.scope, versions: [17, null] } }]),
        catalog,
      ),
    ).toThrow(/bad-range\.json.*versions/)
    expect(() =>
      parseInterpretations("bad-flag.json", JSON.stringify([{ ...review, reviewed: "yes" }]), catalog),
    ).toThrow(/bad-flag\.json.*reviewed/)
  })
})

describe("named not-tested coverage partition", () => {
  it("partitions measured plus named coverage against the catalog without double counting", () => {
    const source = run("nt", {
      probeHash: "with-diagnostic",
      rawReplies: {
        ...identityReplies,
        "extensions.graphics": "NO",
        "extensions.query": "ACK",
        "cursor.position": "P",
      },
      notTested: [
        {
          featureId: "cursor.position",
          reason: "no-semantic-observable",
          noObservable: "rendered colors (pixels)",
          rawReplyRef: "cursor.position",
        },
      ],
    })
    const measured = parseRun("nt.json", JSON.stringify(source), catalog)
    const selected = projectResults([measured], [reviewFor(measured)], catalog, {
      currentProbeHash: "with-diagnostic",
    }).current["app:kitty"]
    expect(selected?.counts).toMatchObject({ catalog: 3, tested: 2, notTested: 1 })
    expect(selected?.cells["cursor.position"]).toBeUndefined()
    expect(selected?.notTestedCoverage).toEqual({
      named: [
        {
          featureId: "cursor.position",
          reason: "no-semantic-observable",
          noObservable: "rendered colors (pixels)",
          rawReplyRef: "cursor.position",
        },
      ],
      measured: 2,
      namedCount: 1,
      remainder: 0,
    })
    expect(selected?.suite).toMatchObject({ observed: 3, expected: 3, complete: true, namedNotTested: 1 })
    expect(selected?.suiteFreshness).toBe("tree suite with-diagnostic")
  })

  it("keeps an unrecorded remainder unnamed and reports the suite as partial", () => {
    const source = run("partial", { observations: [], suiteComplete: false })
    const measured = parseRun("partial.json", JSON.stringify(source), catalog)
    const selected = projectResults([measured], [reviewFor(measured)], catalog, {
      currentProbeHash: "current",
    }).history["app:kitty"]?.[0]
    expect(selected?.counts).toMatchObject({ catalog: 3, tested: 0, notTested: 3 })
    expect(selected?.notTestedCoverage).toEqual({ named: [], measured: 0, namedCount: 0, remainder: 3 })
    expect(selected?.suiteFreshness).toBe("partial (0 of 2 probes)")
  })
})

describe("identity self-admission", () => {
  const project = (runs: ReturnType<typeof parseRun>[], pins: ReturnType<typeof reviewFor>[] = []) =>
    projectResults(runs, pins, catalog, { currentProbeHash: "current" })

  const terminalAppLaunch = {
    bundlePath: "/System/Applications/Utilities/Terminal.app",
    cfBundleShortVersionString: "2.15",
    cfBundleVersion: "455",
    executablePath: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
    executableSha256: RECEIPT_EXECUTABLE_SHA256,
    sourceArtifact: { path: "/System/Library/Assets/com.apple.Terminal.pkg", sha256: RECEIPT_SOURCE_SHA256 },
  }

  // MUST 3: receipt refusal is a public code, not private path text or copied identity.
  it("keeps receipt refusals private and fails loudly on receipt I/O faults", () => {
    const directory = mkdtempSync(join(tmpdir(), "terminfo-receipt-refusal-"))
    contentDirs.push(directory)
    const source = run("private-receipt", {
      rawReplies: {
        ...identityReplies,
        "extensions.query": "ACK",
        "extensions.graphics": "NO",
        "collector.disposableOwnership": JSON.stringify({
          kind: "github-hosted-runner",
          receiptSha256: "ab".repeat(32),
        }),
      },
    })
    const loaded = parseRun(join(directory, "probes-apps", "run.json"), JSON.stringify(source), catalog)
    const projection = project([loaded])
    expect(projection.exclusions).toContainEqual(
      expect.objectContaining({
        runId: loaded.runId,
        reason: "ownership-receipt-missing",
      }),
    )
    expect(projection.history["app:kitty"]?.[0]?.identityAdmission).toBeUndefined()
    const receiptPath = join(directory, "receipt-directory")
    mkdirSync(receiptPath)
    try {
      assessRunAdmission(loaded, [], { mode: "historical", receiptPath, contentDir: directory })
      throw new Error("Receipt I/O fault was swallowed")
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).cause).toMatchObject({ code: "EISDIR" })
    }
  })

  it("refuses mux identities relayed from an outer app", () => {
    const parsed = parseRun(
      "mux.json",
      JSON.stringify(
        run("mux-no-profile", {
          target: { ...target, kind: "mux", id: "tmux" },
        }),
      ),
      catalog,
    )
    expect(project([parsed]).exclusions).toContainEqual(
      expect.objectContaining({
        runId: "mux-no-profile",
        reason: "identity-replies-mismatch",
      }),
    )
  })

  // Mux identity must join the retained outer-app and launch evidence (30069).
  it.each(muxIdentity.specimens)(
    "admits $mux only as a mux with matching retained outer-app custody",
    ({ mux, version, run: specimen }) => {
      const projectedManifest = manifest(specimen.probeHash, muxIdentity.featureIds)
      for (const kind of ["mux", "app"] as const) {
        const parsed = parseRunSource(
          `detached-${mux}-${kind}.json`,
          JSON.stringify({ ...specimen, target: { ...specimen.target, kind, id: mux, version } }),
          muxIdentity.featureIds,
          new Map([[specimen.probeHash, projectedManifest]]),
        )
        const assessment = assessRunAdmission(parsed, [], { mode: "historical" })
        expect.soft(assessment.accepted, `${mux}/${kind} must retain the outer-proof refusal`).toBe(false)
        if (!assessment.accepted) {
          expect.soft(assessment.reason).toBe(kind === "mux" ? "outer-app-proof-missing" : "identity-replies-mismatch")
        }
      }
      const outerTarget = {
        ...target,
        os: specimen.target.os,
        osVersion: specimen.target.osVersion,
        permissions: specimen.target.permissions,
      }
      const outerProvenance = {
        executable: { path: "/nix/store/kitty/bin/kitty", sha256: RECEIPT_EXECUTABLE_SHA256, version: target.version },
        sourceArtifact: { url: "https://example.invalid/kitty.tar", sha256: RECEIPT_SOURCE_SHA256 },
        runtime: {
          imageId: `sha256:${RECEIPT_EXECUTABLE_SHA256}`,
          imageTarSha256: RECEIPT_SOURCE_SHA256,
          arch: "amd64",
          nixLockRevision: "1".repeat(40),
          sourceRevision: specimen.sourceRevision,
          cleanTree: true,
          suiteHash: specimen.probeHash,
        },
        fixture: {
          definition: "fixture",
          config: "fixture",
          font: "fixture",
          geometry: "100x30",
          display: "fixture",
          gl: "fixture",
        },
      }
      // A well-formed app preflight is not an attached launch. No receipt is fabricated here.
      const withoutAttachment = parseRunSource(
        `unbound-${mux}.json`,
        JSON.stringify({
          ...specimen,
          target: { ...specimen.target, kind: "mux", id: mux, version, outerTerminal: "kitty", mux },
          outerApp: { target: outerTarget, rawReplies: identityReplies, provenance: outerProvenance },
        }),
        muxIdentity.featureIds,
        new Map([[specimen.probeHash, projectedManifest]]),
      )
      expect(assessRunAdmission(withoutAttachment, [], { mode: "historical" })).toMatchObject({
        accepted: false,
        reason: "mux-attachment-missing",
      })
      // Controlled retained-byte fixtures exercise historical joins, not live launch authority.
      const processIdentity = (pid: number) => ({ pid, startTicks: String(1000 + pid) })
      const launchRunId = "12".repeat(16)
      const attachment = {
        platform: "linux",
        mux,
        bootId: "11111111-2222-3333-4444-555555555555",
        receiptSha256: "",
        launchRunId,
        captureRunId: specimen.runId,
        preflightCollector: processIdentity(95),
        outerShell: { ...processIdentity(92), ttyRdev: 34816 },
        outerTerminal: processIdentity(76),
        collector: { ...processIdentity(149), ttyRdev: 34817 },
        attachedClient: { ...processIdentity(148), ttyRdev: 34816 },
        chain: [149, 145, 92, 76].map((pid) => ({
          ...processIdentity(pid),
          executablePath:
            pid === 145 ? `/nix/store/mux/bin/${mux}` : pid === 76 ? outerProvenance.executable.path : "/bin/bash",
          ttyRdev: pid === 149 ? 34817 : 34816,
        })),
        executable: { path: `/nix/store/mux/bin/${mux}`, sha256: RECEIPT_EXECUTABLE_SHA256, version },
        config: { path: "/out/mux-empty.conf", sha256: RECEIPT_SOURCE_SHA256 },
        socketPath: `/out/${launchRunId}.sock`,
        session: `terminfo-${launchRunId}`,
      }
      const receipt = {
        schemaVersion: 1,
        runId: launchRunId,
        profile: "default",
        display: { name: ":22", number: 22, displayFdPath: "/out/display", xvfbPid: 200 },
        terminal: { pid: 76, collectorPid: 149, windowId: "42", windowPid: 76 },
        selection: {
          helperPid: 201,
          helperExecutable: { path: "/bin/xclip", sha256: RECEIPT_EXECUTABLE_SHA256 },
          baselinePath: "/out/baseline",
          baselineSha256: RECEIPT_SOURCE_SHA256,
          initialReadSha256: RECEIPT_SOURCE_SHA256,
        },
        config: outerProvenance.fixture.config,
        permissions: "default",
        target: {
          kind: "mux",
          mux,
          bootId: attachment.bootId,
          preflightCollector: attachment.preflightCollector,
          outerShell: attachment.outerShell,
          outerTerminal: attachment.outerTerminal,
          collector: processIdentity(149),
          executable: attachment.executable,
          config: attachment.config,
          socketPath: attachment.socketPath,
          session: attachment.session,
        },
      }
      const receiptSource = JSON.stringify(receipt)
      attachment.receiptSha256 = createHash("sha256").update(receiptSource).digest("hex")
      const boundSource = {
        ...specimen,
        target: {
          ...specimen.target,
          kind: "mux",
          id: mux,
          version,
          outerTerminal: "kitty",
          mux,
          config: attachment.config.path,
        },
        outerApp: {
          target: { ...outerTarget, config: outerProvenance.fixture.config },
          provenance: outerProvenance,
          rawReplies: {
            ...identityReplies,
            "collector.preflightIdentity": JSON.stringify({ ...attachment.preflightCollector, launchRunId }),
          },
        },
        rawReplies: {
          ...specimen.rawReplies,
          "collector.terminalOwnership": JSON.stringify({ muxAttachment: attachment }),
          "collector.clipboardFixture": JSON.stringify({
            receiptSource,
            receiptSha256: attachment.receiptSha256,
            muxAttachmentProof: attachment,
          }),
        },
      }
      const assessBound = (source: unknown) =>
        assessRunAdmission(
          parseRunSource(
            `bound-${mux}.json`,
            JSON.stringify(source),
            muxIdentity.featureIds,
            new Map([[specimen.probeHash, projectedManifest]]),
          ),
          [],
          { mode: "historical" },
        )
      expect(assessBound(boundSource)).toMatchObject({ accepted: true })
      // Placement (unlike historical projection) must bind the completed host composition to
      // these exact mux bytes. Reuse the accepted proof; unmeasured live probes stay not-tested.
      const live = probeSuiteSnapshot()
      const directory = mkdtempSync(join(tmpdir(), `terminfo-mux-completion-${mux}-`))
      contentDirs.push(directory)
      const path = join(directory, "run.json")
      const destination = join(directory, "placed.json")
      const placementSource = {
        ...boundSource,
        suiteId: live.probeHash,
        probeHash: live.probeHash,
        outerApp: {
          ...boundSource.outerApp,
          provenance: {
            ...outerProvenance,
            runtime: { ...outerProvenance.runtime, suiteHash: live.probeHash },
          },
        },
        notTested: live.probes.mux
          .filter((id) => !muxIdentity.featureIds.includes(id))
          .map((featureId) => ({
            featureId,
            reason: "no-semantic-observable",
            noObservable: "the retained identity specimen did not measure this probe",
            rawReplyRef: featureId,
          })),
        rawReplies: {
          ...boundSource.rawReplies,
          ...Object.fromEntries(
            live.probes.mux
              .filter((id) => !muxIdentity.featureIds.includes(id))
              .map((id) => [id, "fixture: not measured by the retained identity specimen"]),
          ),
        },
      }
      const bytes = JSON.stringify(placementSource)
      writeFileSync(path, bytes)
      const hostPath = join(directory, "host-measured.json")
      const hostSource = JSON.stringify({ ...receipt, preset: "default", clipboardProfile: "default" })
      writeFileSync(hostPath, hostSource)
      const completionPath = join(directory, "run-receipt.json")
      const completion = {
        probeRun: { runId: specimen.runId, sha256: createHash("sha256").update(bytes).digest("hex") },
        receiptInputs: { hostSha256: createHash("sha256").update(hostSource).digest("hex") },
      }
      // The authoring guard is independently exercised with real Git fixtures in admit-run.test;
      // this case owns the real placement/receipt boundary, before that final branch check.
      const authoring = vi.spyOn(suiteManifest, "assertDeclareIsAuthoring").mockImplementation(() => {})
      try {
        expect(() => planAdmission(path, destination)).toThrow(/missing run-receipt\.json/)
        expect(() => planAdmission(path, destination)).toThrow(/bun scripts\/release1-collection\.ts --plan/)
        writeFileSync(
          completionPath,
          JSON.stringify({ ...completion, probeRun: { ...completion.probeRun, sha256: "0".repeat(64) } }),
        )
        expect(() => planAdmission(path, destination)).toThrow(/does not bind probeRun/)
        writeFileSync(completionPath, JSON.stringify({ ...completion, receiptInputs: { hostSha256: "0".repeat(64) } }))
        expect(() => planAdmission(path, destination)).toThrow(/does not bind receiptInputs/)
        writeFileSync(completionPath, JSON.stringify(completion))
        expect(planAdmission(path, destination)).toMatchObject({ target: { kind: "mux", id: mux } })
        expect(existsSync(destination)).toBe(false)
      } finally {
        authoring.mockRestore()
      }

      expect(
        assessBound({
          ...boundSource,
          rawReplies: { ...boundSource.rawReplies, "collector.clipboardFixture": "{broken" },
        }),
      ).toMatchObject({
        accepted: false,
        reason: "mux-attachment-invalid",
        detail: expect.stringContaining("mux clipboard fixture"),
      })
      const ownership = boundSource.rawReplies["collector.terminalOwnership"]
      expect(
        assessBound({
          ...boundSource,
          rawReplies: {
            ...boundSource.rawReplies,
            "collector.terminalOwnership": ownership.replace("{", '{"muxAttachment":null,'),
          },
        }),
      ).toMatchObject({
        accepted: false,
        reason: "mux-attachment-invalid",
        detail: expect.stringContaining("duplicate"),
      })
      for (const [field, value] of Object.entries({
        bootId: "99999999-2222-3333-4444-555555555555",
        preflightCollector: processIdentity(96),
        outerShell: { ...attachment.outerShell, startTicks: "9999" },
        outerTerminal: processIdentity(77),
        collector: processIdentity(150),
        executable: { ...attachment.executable, sha256: "cd".repeat(32) },
        config: { ...attachment.config, sha256: "cd".repeat(32) },
        socketPath: `/out/other-${launchRunId}.sock`,
        session: `other-${launchRunId}`,
      })) {
        const source = JSON.stringify({
          ...receipt,
          terminal: {
            ...receipt.terminal,
            ...(field === "outerTerminal" ? { pid: 77 } : {}),
            ...(field === "collector" ? { collectorPid: 150 } : {}),
          },
          target: { ...receipt.target, [field]: value },
        })
        const changedProof = { ...attachment, receiptSha256: createHash("sha256").update(source).digest("hex") }
        const changed = {
          ...boundSource,
          rawReplies: {
            ...boundSource.rawReplies,
            "collector.terminalOwnership": JSON.stringify({ muxAttachment: changedProof }),
            "collector.clipboardFixture": JSON.stringify({
              receiptSource: source,
              receiptSha256: changedProof.receiptSha256,
              muxAttachmentProof: changedProof,
            }),
          },
        }
        expect.soft(assessBound(changed), field).toMatchObject({ accepted: false, reason: "mux-attachment-invalid" })
      }
      for (const fixture of [
        undefined,
        { receiptSource, receiptSha256: attachment.receiptSha256 },
        { receiptSource: receiptSource + " ", receiptSha256: attachment.receiptSha256 },
        {
          receiptSource,
          receiptSha256: attachment.receiptSha256,
          muxAttachmentProof: { ...attachment, launchRunId: "56".repeat(16) },
        },
      ]) {
        expect
          .soft(
            assessBound({
              ...boundSource,
              rawReplies: {
                ...boundSource.rawReplies,
                "collector.clipboardFixture": fixture === undefined ? undefined : JSON.stringify(fixture),
              },
            }),
          )
          .toMatchObject({ accepted: false, reason: "mux-attachment-invalid" })
      }
      expect
        .soft(
          assessBound({
            ...boundSource,
            outerApp: {
              ...boundSource.outerApp,
              rawReplies: {
                ...boundSource.outerApp.rawReplies,
                "collector.preflightIdentity": JSON.stringify({
                  ...attachment.preflightCollector,
                  launchRunId: "56".repeat(16),
                }),
              },
            },
          }),
        )
        .toMatchObject({ accepted: false, reason: "mux-attachment-invalid" })
      // App provenance must not turn a genuine mux into an app. The original missing-provenance
      // case could reject for the wrong reason and miss this kind mismatch.
      const labelledApp = parseRunSource(
        `mislabelled-${mux}.json`,
        JSON.stringify({
          ...specimen,
          target: { ...specimen.target, kind: "app", id: mux, version },
          provenance: {
            ...outerProvenance,
            executable: { ...outerProvenance.executable, path: `/nix/store/mux/bin/${mux}`, version },
          },
        }),
        muxIdentity.featureIds,
        new Map([[specimen.probeHash, projectedManifest]]),
      )
      expect(assessRunAdmission(labelledApp, [], { mode: "historical" })).toMatchObject({
        accepted: false,
        reason: "identity-replies-mismatch",
      })
    },
  )

  it("matches Screen's retained DA2 version before applying native ownership requirements", () => {
    const specimen = muxIdentity.specimens.find((entry) => entry.mux === "screen")!
    const suites = new Map([[specimen.run.probeHash, manifest(specimen.run.probeHash, muxIdentity.featureIds)]])
    for (const [version, da2, reason] of [
      [specimen.version, specimen.run.rawReplies["device.secondary-da"], "outer-app-proof-missing"],
      ["4.09.02", specimen.run.rawReplies["device.secondary-da"], "identity-replies-mismatch"],
      [specimen.version, "\x1b[>83;9999999999999999;0c", "identity-replies-mismatch"],
      [specimen.version, "\x1b[>83;99999999999999999999;0c", "identity-replies-mismatch"],
    ]) {
      const parsed = parseRunSource(
        "screen-identity.json",
        JSON.stringify({
          ...specimen.run,
          target: { ...specimen.run.target, kind: "mux", id: "screen", version },
          rawReplies: { ...specimen.run.rawReplies, "device.secondary-da": da2 },
        }),
        muxIdentity.featureIds,
        suites,
      )
      expect(assessRunAdmission(parsed, [], { mode: "historical" })).toMatchObject({ accepted: false, reason })
    }
  })

  // Only the measured Linux owner is approved; the Linux corpus cannot witness a Darwin leak.
  it.each(muxIdentity.specimens)(
    "keeps macOS $mux admission held pending its measured owner",
    ({ mux, version, run: specimen }) => {
      const parsed = parseRunSource(
        "darwin-mux.json",
        JSON.stringify({
          ...specimen,
          target: { ...specimen.target, kind: "mux", id: mux, version, os: "darwin" },
        }),
        muxIdentity.featureIds,
        new Map([[specimen.probeHash, manifest(specimen.probeHash, muxIdentity.featureIds)]]),
      )
      expect(assessRunAdmission(parsed, [], { mode: "historical" })).toMatchObject({
        accepted: false,
        reason: "mux-platform-unqualified",
      })
    },
  )

  it("excludes a schema-v2 kitty run whose XTVERSION is missing", () => {
    const parsed = parseRun(
      "kitty-missing.json",
      JSON.stringify(
        run("kitty-missing", {
          rawReplies: {
            "device.primary-da": "\u001b[?62;52;c",
            "extensions.query": "ACK",
            "extensions.graphics": "NO",
            "cursor.position": "",
          },
        }),
      ),
      catalog,
    )
    const projection = project([parsed])
    expect(projection.current["app:kitty"]).toBeUndefined()
    expect(projection.exclusions).toContainEqual(
      expect.objectContaining({ runId: "kitty-missing", reason: "identity-replies-mismatch" }),
    )
  })

  it("refuses a version prefix that the token regex would have accepted", () => {
    const parsed = parseRun(
      "kitty-prefix.json",
      JSON.stringify(
        run("kitty-prefix", {
          target: { ...target, version: "0.42" },
          rawReplies: {
            "device.primary-da": "\u001b[?62;52;c",
            "device.xtversion": "kitty(0.42.1)",
            "extensions.query": "ACK",
            "extensions.graphics": "NO",
            "cursor.position": "",
          },
        }),
      ),
      catalog,
    )
    const projection = project([parsed])
    expect(projection.current["app:kitty"]).toBeUndefined()
    expect(projection.exclusions).toContainEqual(
      expect.objectContaining({ runId: "kitty-prefix", reason: "identity-replies-mismatch" }),
    )
  })

  it("rejects iTerm2 when a mux-relayed screen DA3 is present without an iTerm2 XTVERSION", () => {
    const parsed = parseRun(
      "iterm2-relay.json",
      JSON.stringify(
        run("iterm2-relay", {
          target: { ...target, id: "iterm2", version: "3.5.11" },
          rawReplies: {
            "device.primary-da": "\u001b[?64;1;2;6;9;15;21;22;28;32c",
            "device.tertiary-da": "\u001bP!|7E56544D\u001b\\",
            "extensions.query": "ACK",
            "extensions.graphics": "NO",
            "cursor.position": "",
          },
        }),
      ),
      catalog,
    )
    const projection = project([parsed])
    expect(projection.current["app:iterm2"]).toBeUndefined()
    expect(projection.exclusions).toContainEqual(
      expect.objectContaining({ runId: "iterm2-relay", reason: "identity-replies-mismatch" }),
    )
  })

  it("does not let a schema-v2 pin admit a mismatching XTVERSION", () => {
    const parsed = parseRun(
      "kitty-pinned-mismatch.json",
      JSON.stringify(
        run("kitty-pinned-mismatch", {
          rawReplies: {
            "device.primary-da": "\u001b[?62;52;c",
            "device.xtversion": "kitty(0.40.0)",
            "extensions.query": "ACK",
            "extensions.graphics": "NO",
            "cursor.position": "",
          },
        }),
      ),
      catalog,
    )
    const projection = project([parsed], [reviewFor(parsed)])
    expect(projection.current["app:kitty"]).toBeUndefined()
    expect(projection.exclusions).toContainEqual(
      expect.objectContaining({ runId: "kitty-pinned-mismatch", reason: "identity-replies-mismatch" }),
    )
  })

  it("still requires a pin for a schema-v1 run even when identity replies match", () => {
    const parsed = parseRun(
      "legacy-kitty.json",
      JSON.stringify({
        terminal: "kitty",
        terminalVersion: "0.46.2",
        os: "macos",
        osVersion: "25.4.0",
        generated: "2026-04-06T16:53:04.733Z",
        results: { "extensions.query": true, "extensions.graphics": false },
        responses: {
          "device.primary-da": "\u001b[?62;52;c",
          "device.xtversion": "kitty(0.46.2)",
        },
      }),
      catalog,
    )
    expect(parsed.schemaVersion).toBe(1)
    const projection = project([parsed])
    expect(projection.current["app:kitty"]).toBeUndefined()
    expect(projection.exclusions).toContainEqual(
      expect.objectContaining({ runId: parsed.runId, reason: "identity-unverified" }),
    )
  })

  it("keeps existing pins admitting eleven engines and three kitty apps", () => {
    const engines = [
      "xtermjs",
      "ghostty",
      "vt100",
      "vt220",
      "vterm",
      "alacritty",
      "wezterm",
      "vt100-rust",
      "libvterm",
      "ghostty-native",
      "kitty",
    ]
    const headlessRuns = engines.map((id, index) =>
      parseRun(
        `engine-${id}.json`,
        JSON.stringify(
          run(`engine-${id}`, {
            target: { ...target, kind: "headless", id, version: `1.${index}.0` },
            runtimeIdentity: {
              kind: "js",
              runtimeFormat: "js",
              engineVersion: `1.${index}.0`,
              resolvedPath: `/pkg/${id}/index.js`,
              integrity: { kind: "registry", lockIntegrity: "sha512-example" },
              adapterVersion: "1.0.0",
              termlessRevision: "rev123",
            },
          }),
        ),
        catalog,
      ),
    )
    const kittyRuns = ["25.4.0", "24.6.0", "23.5.0"].map((osVersion) =>
      parseRun(
        `kitty-${osVersion}.json`,
        JSON.stringify(
          run(`kitty-${osVersion}`, {
            target: { ...target, os: "macos", osVersion },
            rawReplies: {
              ...identityReplies,
              "extensions.query": "ACK",
              "extensions.graphics": "NO",
              "cursor.position": "",
            },
          }),
        ),
        catalog,
      ),
    )
    const all = [...headlessRuns, ...kittyRuns]
    const projection = project(all, all.map(reviewFor))
    expect(engines.map((id) => projection.current[`headless:${id}`]?.runId)).toEqual(
      engines.map((id) => `engine-${id}`),
    )
    const kittyCurrent = Object.entries(projection.current)
      .filter(([key]) => key.startsWith("app:kitty"))
      .map(([, value]) => value.runId)
      .sort()
    expect(kittyCurrent).toEqual(["kitty-23.5.0", "kitty-24.6.0", "kitty-25.4.0"])
  })

  it("admits a schema-v2 headless engine from runtimeIdentity without XTVERSION or a pin", () => {
    const parsed = parseRun(
      "engine-no-xtversion.json",
      JSON.stringify(
        run("engine-no-xtversion", {
          target: { ...target, kind: "headless", id: "xtermjs", version: "6.0.0" },
          runtimeIdentity: {
            kind: "js",
            runtimeFormat: "js",
            engineVersion: "6.0.0",
            resolvedPath: "/pkg/xtermjs/index.js",
            integrity: { kind: "registry", lockIntegrity: "sha512-example" },
            adapterVersion: "1.0.0",
            termlessRevision: "rev123",
          },
          rawReplies: {
            "extensions.query": "ACK",
            "extensions.graphics": "NO",
            "cursor.position": "",
          },
        }),
      ),
      catalog,
    )
    const projection = project([parsed])
    expect(projection.current["headless:xtermjs"]?.runId).toBe("engine-no-xtversion")
    expect(projection.current["headless:xtermjs"]?.identityAdmission).toEqual({ rule: "runtime-identity" })
    expect(projection.exclusions).not.toContainEqual(expect.objectContaining({ runId: "engine-no-xtversion" }))
  })

  it("rejects Terminal.app XTVERSION, admits kitty on a shared DA1, and records the launch receipt", () => {
    const da1 = "\u001b[?62;52;c"
    const kitty = parseRun(
      "kitty-shared-da1.json",
      JSON.stringify(
        run("kitty-shared-da1", {
          rawReplies: {
            "device.primary-da": da1,
            "device.xtversion": "kitty(0.46.2)",
            "extensions.query": "ACK",
            "extensions.graphics": "NO",
            "cursor.position": "",
          },
        }),
      ),
      catalog,
    )
    const unexpectedXtversion = parseRun(
      "terminal-xtversion.json",
      JSON.stringify(
        run("terminal-xtversion", {
          target: { ...target, id: "terminal-app", version: "2.15" },
          rawReplies: {
            "device.primary-da": "\x1b[?1;2c",
            "device.secondary-da": "\x1b[>1;95;0c",
            "device.xtversion": "kitty(0.46.2)",
            "extensions.query": "ACK",
            "extensions.graphics": "NO",
          },
          origin: { kind: "collector", appLaunch: terminalAppLaunch },
        }),
      ),
      catalog,
    )
    const accepted = parseRun(
      "terminal-receipt.json",
      JSON.stringify(
        run("terminal-receipt", {
          target: { ...target, id: "terminal-app", version: "2.15" },
          rawReplies: {
            "device.primary-da": "\x1b[?1;2c",
            "device.secondary-da": "\x1b[>1;95;0c",
            "extensions.query": "ACK",
            "extensions.graphics": "NO",
          },
          origin: { kind: "collector", appLaunch: terminalAppLaunch },
        }),
      ),
      catalog,
    )
    const projection = project([kitty, unexpectedXtversion, accepted])
    expect(projection.current["app:kitty"]?.runId).toBe("kitty-shared-da1")
    expect(projection.current["app:terminal-app"]?.runId).toBe("terminal-receipt")
    expect(projection.current["app:terminal-app"]?.identityAdmission).toEqual({
      rule: "terminal-app",
      da1: "\x1b[?1;2c",
      receipt: { cfBundleShortVersionString: "2.15" },
    })
    expect(projection.exclusions).toContainEqual(
      expect.objectContaining({ runId: "terminal-xtversion", reason: "identity-replies-mismatch" }),
    )
  })
})

// Pre-seal decisions must bind capture bytes without hashing the final status into itself.
// Existing identity/presentation cases require final-run hashes and cannot represent this branch.
describe("pre-seal capture decisions", () => {
  const decision = {
    id: "capture-review",
    runId: "capture-run",
    featureId: "extensions.graphics",
    captureSha256: "a1".repeat(32),
    decision: "untestable",
    reviewed: true,
    reviewer: "reviewer",
    reason: "This headless parser has no display surface for the visual viewport claim",
    scope: {
      target: { kind: "headless", id: "xtermjs" },
      versions: ["6.0.0", "6.0.0"],
      suites: ["a1b2c3d4e5f6", "a1b2c3d4e5f6"],
    },
    sources: ["capture://exact-binding"],
    supersedes: [],
  }
  it("accepts a typed reviewed impossibility independently of a final-run hash", () => {
    expect(parseInterpretations("capture-review.json", JSON.stringify([decision]), catalog)).toEqual([decision])
  })
  it.each([
    { decision: undefined },
    { captureSha256: "not-a-digest" },
    { reviewed: false },
    { runSha256: "b2".repeat(32) },
    { verifiesIdentity: true },
    { observation: { outcome: "supported" } },
  ])("rejects ambiguous or authority-mixed capture review %o", (change) => {
    expect(() =>
      parseInterpretations("capture-review.json", JSON.stringify([{ ...decision, ...change }]), catalog),
    ).toThrow(/capture|pre-seal/)
  })
})

// 30565: a displayed run publishes its unreviewed cells through one lazy trace document (rulings 3f4b1d98,
// 2239262c). The document is public, so its exact shape is the privacy contract.
describe("run traces", () => {
  // A stored live exchange: the written bytes and one query, with the read window the trace must drop.
  const exchange = (match: string[] | null, extra: Record<string, unknown> = {}) => {
    const query = { sequence: "\u001b[c", match, reason: "reply", raw: "READ_WINDOW", rawBase64: "UkVBRF9XSU5ET1c=" }
    return JSON.stringify({
      writes: ["\u001b[0m"],
      queries: [query],
      events: [
        { kind: "write", sequence: "\u001b[0m" },
        { kind: "query", ...query, sentinel: { atMs: 1, graceMs: 250 } },
      ],
      ...extra,
    })
  }
  const decision = (measured: ReturnType<typeof parseRun>, featureId: string, presentsEvidence: boolean) => ({
    id: `${presentsEvidence ? "present" : "withdraw"}-${featureId}`,
    runId: measured.runId,
    runSha256: measured.sha256,
    reviewer: "reviewer",
    reason: "exact-run presentation decision",
    scope: reviewFor(measured).scope,
    sources: ["https://example.org/review"],
    supersedes: [] as string[],
    featureId,
    presentsEvidence,
  })
  /** A selected kitty run whose stored records carry every field a trace must keep or drop. */
  const traced = (decisions: (measured: ReturnType<typeof parseRun>) => unknown[] = () => []) => {
    const measured = parseRun(
      "trace.json",
      JSON.stringify(
        run("trace-run", {
          rawReplies: {
            ...identityReplies,
            "extensions.query": exchange(["UNLISTED_MATCH"], { captures: [{ text: "SCREEN_CAPTURE" }] }),
            "extensions.graphics": "UNLISTED_PLAIN_REPLY",
            "cursor.position": "",
          },
          assertions: [
            {
              featureId: "extensions.query",
              kind: "positive",
              rawReplyRef: "extensions.query",
              expected: "a DA1 reply",
              observed: "UNLISTED_OBSERVED",
              action: "ASSERTION_ACTION",
              note: "ASSERTION_NOTE",
            },
            {
              featureId: "extensions.graphics",
              kind: "negative",
              rawReplyRef: "extensions.graphics",
              expected: "ACK",
              observed: "NO",
            },
          ],
          observations: [
            { ...observation("extensions.query", "supported", "query"), note: "OBSERVATION_NOTE" },
            observation("extensions.graphics", "unsupported", "behavior"),
          ],
        }),
      ),
      catalog,
    )
    const projection = projectResults([measured], decisions(measured) as never[], catalog, {
      currentProbeHash: "current",
    })
    const version = projection.current["app:kitty"]
    if (!version) throw new Error("expected the traced run to be selected")
    version.ungradedDiagnostics.results["cursor.position"] = {
      kind: "legacy-callback",
      pass: false,
      note: "DIAGNOSTIC_NOTE",
    }
    // A census-listed feature with the same stored shape: its reply is a closed-grammar DA1 report. It
    // also carries the media and note a real cell can hold.
    const digest = "3c".repeat(32)
    const { presentation: _template, ...template } = version.cells["extensions.query"]!
    version.cells["device.primary-da"] = {
      ...template,
      featureId: "device.primary-da",
      note: "CELL_NOTE",
      screenshotRef: `sha256:${digest}`,
      record: {
        rawReply: exchange(["\u001b[?62;52c", "62;52"]),
        assertions: [
          { featureId: "device.primary-da", kind: "positive", expected: "a DA1 reply", observed: "\u001b[?62;52c" },
        ],
        screenshot: { url: `/artifacts/${digest}.png`, sha256: digest },
        frames: [
          {
            role: "target",
            label: "FRAME_LABEL",
            capturedAt: 2,
            kind: "pixels",
            url: `/artifacts/${digest}.png`,
            sha256: digest,
          },
        ],
      },
    }
    const targets = new Map([["kitty", { contextKey: "app:kitty", selected: version }]])
    return { measured, projection, version, targets }
  }
  const traceOf = (published: ReturnType<typeof publicResults>) => {
    const receipt = published.selectedByBackend.kitty?.selected.trace
    if (!receipt) throw new Error("expected a trace receipt on the displayed run")
    const stored = published.documents.get(receipt.url)
    if (!stored) throw new Error(`expected the trace document ${receipt.url}`)
    const { cells } = JSON.parse(stored.bytes) as { cells: Record<string, unknown> }
    return { receipt, bytes: stored.bytes, cells }
  }

  it("gives a displayed run one receipt whose document holds exactly the allowlisted fields (AC1)", () => {
    const { measured, projection, version, targets } = traced()
    const published = publicResults(projection, targets)
    const { receipt, bytes } = traceOf(published)
    expect(receipt.url).toBe(`/api/v2/traces/${measured.sha256}.json`)
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(receipt.sha256)
    // The receipt lives once, on the run: every mapping of the run carries it, and no cell does.
    expect(published.projection.current["app:kitty"]?.trace).toEqual(receipt)
    for (const cell of Object.values(published.selectedByBackend.kitty?.selected.cells ?? {})) {
      expect(cell).not.toHaveProperty("trace")
    }
    expect(version.identityAdmission).toBeDefined()
    expect(JSON.parse(bytes)).toEqual({
      version: 1,
      runId: "trace-run",
      runSha256: measured.sha256,
      measuredAt: "2026-09-28T12:00:00.000Z",
      sourceRevision: "2".repeat(40),
      identity: { recorded: "verified", admission: version.identityAdmission },
      cells: {
        "device.primary-da": {
          outcome: "supported",
          evidence: "query",
          events: [
            { kind: "write", sequence: "\u001b[0m" },
            { kind: "query", sequence: "\u001b[c", reason: "reply", match: ["\u001b[?62;52c", "62;52"] },
          ],
          assertions: [{ kind: "positive", expected: "a DA1 reply", observed: "\u001b[?62;52c" }],
        },
        "extensions.query": {
          outcome: "supported",
          evidence: "query",
          replyWithheld: true,
          events: [
            { kind: "write", sequence: "\u001b[0m" },
            { kind: "query", sequence: "\u001b[c", reason: "reply" },
          ],
          assertions: [{ kind: "positive", expected: "a DA1 reply" }],
        },
        "extensions.graphics": {
          outcome: "unsupported",
          evidence: "behavior",
          replyWithheld: true,
          assertions: [{ kind: "negative", expected: "ACK" }],
        },
      },
    })
  })

  it("keeps notes, actions, diagnostics, media, read windows and unlisted replies out of every trace (AC2)", () => {
    const { projection, version, targets } = traced()
    const { presentation: _template, ...template } = version.cells["extensions.query"]!
    version.cells["device.xtwinops-21"] = {
      ...template,
      featureId: "device.xtwinops-21",
      outcome: "unsupported",
      record: {
        rawReply: exchange(["\u001b]luser@host: ~/x\u001b\\", "user@host: ~/x"]),
        assertions: [
          {
            featureId: "device.xtwinops-21",
            kind: "negative",
            expected: "no window title report",
            observed: "user@host: ~/x",
          },
        ],
      },
    }
    const { bytes, cells } = traceOf(publicResults(projection, targets))
    expect(cells["device.xtwinops-21"]).toEqual({
      outcome: "unsupported",
      evidence: "query",
      replyWithheld: true,
      events: [
        { kind: "write", sequence: "\u001b[0m" },
        { kind: "query", sequence: "\u001b[c", reason: "reply" },
      ],
      assertions: [{ kind: "negative", expected: "no window title report" }],
    })
    for (const marker of [
      "OBSERVATION_NOTE",
      "CELL_NOTE",
      "ASSERTION_NOTE",
      "ASSERTION_ACTION",
      "DIAGNOSTIC_NOTE",
      "legacy-callback",
      "3c".repeat(32),
      "FRAME_LABEL",
      "SCREEN_CAPTURE",
      "READ_WINDOW",
      "UkVBRF9XSU5ET1c=",
      "graceMs",
      "UNLISTED_MATCH",
      "UNLISTED_OBSERVED",
      "UNLISTED_PLAIN_REPLY",
      "user@host: ~/x",
      "trace.json",
    ]) {
      expect(bytes).not.toContain(marker)
    }
  })

  it("keeps events alone only when an exchange's events equals its writes plus queries in order", () => {
    const { projection, version, targets } = traced()
    version.cells["device.primary-da"]!.record.rawReply = JSON.stringify({
      writes: ["\u001b[0m", "\u001b[?25h"],
      queries: [{ sequence: "\u001b[c", match: ["\u001b[?62;52c", "62;52"], reason: "reply", raw: "READ_WINDOW" }],
      events: [
        { kind: "write", sequence: "\u001b[0m" },
        { kind: "query", sequence: "\u001b[c", match: ["\u001b[?62;52c", "62;52"], reason: "reply" },
      ],
    })
    const { cells } = traceOf(publicResults(projection, targets))
    expect(cells["device.primary-da"]).toEqual({
      outcome: "supported",
      evidence: "query",
      writes: ["\u001b[0m", "\u001b[?25h"],
      queries: [{ sequence: "\u001b[c", reason: "reply", match: ["\u001b[?62;52c", "62;52"] }],
      events: [
        { kind: "write", sequence: "\u001b[0m" },
        { kind: "query", sequence: "\u001b[c", reason: "reply", match: ["\u001b[?62;52c", "62;52"] },
      ],
      assertions: [{ kind: "positive", expected: "a DA1 reply", observed: "\u001b[?62;52c" }],
    })
  })

  it("traces only displayed runs, and never a cell a presentation review decided", () => {
    const untraced = traced()
    const quiet = publicResults(untraced.projection, new Map())
    expect([...quiet.documents.keys()].filter((url) => url.includes("/traces/"))).toEqual([])
    expect(quiet.projection.current["app:kitty"]).not.toHaveProperty("trace")

    const reviewed = traced((measured) => [
      decision(measured, "extensions.query", false),
      decision(measured, "extensions.graphics", true),
    ])
    const { cells } = traceOf(publicResults(reviewed.projection, reviewed.targets))
    expect(Object.keys(cells)).toEqual(["device.primary-da"])
  })

  it("keeps a headless run's parser state and observed values without their read windows", () => {
    const { projection, version } = traced()
    const { presentation: _template, ...template } = version.cells["extensions.query"]!
    // Its own digest: a trace is shared by sha256, so the app run's receipt would answer for this one.
    const headless: typeof version = {
      ...version,
      sha256: "d4".repeat(32),
      target: { ...version.target, kind: "headless" },
      cells: {
        "extensions.query": {
          ...template,
          evidence: "parser-state",
          record: {
            rawReply: JSON.stringify({
              before: { fg: 7 },
              after: { fg: 1 },
              originalRaw: "ORIGINAL_WINDOW",
              steps: [{ changedRawBase64: "Q0hBTkdFRA==", row: 0 }],
            }),
            assertions: [
              {
                featureId: "extensions.query",
                kind: "positive",
                expected: "the foreground changes",
                observed: JSON.stringify({ fg: 1, restoredRaw: "RESTORED_WINDOW" }),
              },
            ],
          },
        },
      },
    }
    const published = publicResults(projection, new Map([["kitty", { contextKey: "app:kitty", selected: headless }]]))
    expect(traceOf(published).cells).toEqual({
      "extensions.query": {
        outcome: "supported",
        evidence: "parser-state",
        parserState: { before: { fg: 7 }, after: { fg: 1 }, steps: [{ row: 0 }] },
        assertions: [{ kind: "positive", expected: "the foreground changes", observed: '{"fg":1}' }],
      },
    })
  })

  it("refuses stored text that starts like JSON but does not parse, naming the run and feature", () => {
    const { projection, version, targets } = traced()
    version.cells["extensions.graphics"]!.record.rawReply = '{"fg":1,"originalRaw":"ORIGINAL_WINDOW"'
    expect(() => publicResults(projection, targets)).toThrow(
      /run trace-run feature extensions.graphics\.rawReply: stored text starts like JSON but does not parse/,
    )
  })
})
