/**
 * @failure A missing, malformed, stale, or disputed run silently becomes a positive/negative terminal claim.
 * @level l2
 * @consumer Site, API, analysis, and reviewed census import.
 * @testonly none
 */
import { afterEach, describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadSelectedResults, parseInterpretations, projectResults } from "../docs/data/selected-results.ts"
import { decodeCollectorRun, decodeExactUtf8, parseRun as parseRunSource } from "@terminfo/run-parser"
import type { ObservationFrame, ProbeSuiteManifest } from "@terminfo/probe-defs"

const catalog = ["cursor.position", "extensions.graphics", "extensions.query"]
const manifest = (probeHash: string, ids = ["extensions.graphics", "extensions.query"]): ProbeSuiteManifest => ({
  probeHash,
  sourceRevision: "1".repeat(40),
  generatedAt: "2026-09-28T00:00:00.000Z",
  adapterVersion: "3.3.1",
  probes: { app: ids, headless: ids, mux: ids },
})
const manifests = new Map([
  ["current", manifest("current")],
  ["old", manifest("old")],
  ["state", manifest("state", ["cursor.position"])],
  ["pixels", manifest("pixels", ["extensions.graphics"])],
  ["query", manifest("query", ["extensions.query"])],
  ["with-diagnostic", manifest("with-diagnostic", ["extensions.graphics", "extensions.query", "cursor.position"])],
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
  writeFileSync(join(path, "features.json"), JSON.stringify(Object.fromEntries(catalog.map((id) => [id, {}]))))
  return path
}

describe("selected results", () => {
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
  it("loads screenshot bytes by digest and refuses a missing or modified artifact", () => {
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
        url: `/artifacts/${controlDigest}.png`,
        sha256: controlDigest,
      },
      { role: "target", label: "after", capturedAt: 2, url: `/artifacts/${digest}.png`, sha256: digest },
    ])
    expect(readFileSync(join(output, `${digest}.png`))).toEqual(png)
    expect(readFileSync(join(output, `${controlDigest}.png`))).toEqual(controlPng)
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
      run("unverified", { identity: "unverified", measuredAt: "2026-10-03T00:00:00.000Z" }),
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
      expect.objectContaining({ runId: "unverified", reason: "identity-unverified" }),
    )
    expect(projection.versions["app:kitty"]).toHaveLength(2)
    expect(projection.current["app:kitty"]?.counts).toMatchObject({
      catalog: 3,
      tested: 2,
      notTested: 1,
      conclusive: 2,
    })
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
    expect(projection.current["app:kitty"]?.cells["extensions.graphics"]?.outcome).toBe("supported")
    expect(projection.current["app:kitty"]?.cells["extensions.graphics"]?.record.rawReply).toBe("NO")
    expect(projection.current["app:kitty"]?.reviews).toContainEqual(
      expect.objectContaining({ id: correction.id, reviewer: correction.reviewer, reason: correction.reason }),
    )
    expect(projection.current["headless:kitty"]?.cells["extensions.graphics"]?.outcome).toBe("unsupported")
    expect(app.sha256).toBe(hash)
    expect(JSON.stringify(capture)).toBe(bytes)
  })

  it("keeps legacy booleans ungraded and omits unknown causes from v1", () => {
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

  it("requires matching run SHA and a measured identity reply before selection", () => {
    const candidate = parseRun("kitty.json", JSON.stringify(run("kitty-verified")), catalog)
    expect(
      projectResults([candidate], [], catalog, { currentProbeHash: "current" }).current["app:kitty"],
    ).toBeUndefined()
    expect(
      projectResults([candidate], [{ ...reviewFor(candidate), runSha256: "0".repeat(64) }], catalog, {
        currentProbeHash: "current",
      }).current["app:kitty"],
    ).toBeUndefined()
    expect(
      projectResults([candidate], [reviewFor(candidate)], catalog, { currentProbeHash: "current" }).current["app:kitty"]
        ?.runId,
    ).toBe(candidate.runId)
  })

  it("selects a reviewed Terminal.app run only with DA2 family and an exact launch receipt", () => {
    const appLaunch = {
      bundlePath: "/System/Applications/Utilities/Terminal.app",
      cfBundleShortVersionString: "2.15",
      cfBundleVersion: "455",
      executablePath: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
      executableSha256: "a".repeat(64),
      sourceArtifact: { path: "/System/Library/Assets/com.apple.Terminal.pkg", sha256: "b".repeat(64) },
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
      executableSha256: "a".repeat(64),
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
      executable: { path: "/nix/store/kitty/bin/kitty", sha256: "a".repeat(64), version: "kitty 0.46.2" },
      sourceArtifact: { url: "https://example.invalid/kitty-0.46.2.txz", sha256: "b".repeat(64) },
      runtime: {
        imageId: `sha256:${"c".repeat(64)}`,
        imageTarSha256: "d".repeat(64),
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
    expect(() => parseRun("pixels-unreviewed.json", JSON.stringify(prematureSupport), catalog)).toThrow(
      /collector pixels.*reviewed Interpretation/,
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
      /frame.*absent from run/,
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
      schemaVersion: 3,
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
    expect(
      projectResults([measured], [review, revoke], catalog, { currentProbeHash: "current" }).current["app:kitty"],
    ).toBeUndefined()
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
