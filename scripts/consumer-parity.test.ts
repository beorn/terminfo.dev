/**
 * @failure Consumers disagree about admitted runs, unscoped annotations leak into commentary, or malformed metadata silently omits analysis sections.
 * @level l2
 * @consumer Site matrix, terminal paths, v1/v2 API and generated analysis.
 * @testonly none
 */
import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync, cpSync, symlinkSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SelectedCell, SelectedVersion } from "../docs/data/selected-results.ts"
import * as selectedResults from "../docs/data/selected-results.ts"
import type { EvidenceDocument, PublicVersion } from "../docs/data/public-results.ts"

interface CompatibilityData {
  results: Record<string, Record<string, string>>
  terminals: Record<string, unknown>
  notes: Record<string, Record<string, string>>
}

const fixture = vi.hoisted(() => {
  const runSha256 = "a".repeat(64)
  const measuredAt = "2026-09-28T12:34:56.000Z"
  const target = {
    kind: "app",
    id: "kitty",
    version: "0.46.2",
    os: "macos",
    osVersion: "25.4.0",
    outerTerminal: null,
    mux: null,
    config: null,
    permissions: null,
  }
  const cells = {
    "sgr.bold": {
      featureId: "sgr.bold",
      outcome: "supported",
      evidence: "query",
      conclusive: true,
      note: "unchecked collector note /home/fixture/private",
      record: {
        rawReply: "\u001b[1;2R",
        assertions: [
          { featureId: "sgr.bold", kind: "positive", expected: "PRIVATE_ASSERTION_EXPECTED", observed: "\u001b[1;2R" },
        ],
      },
      chain: {
        origin: { kind: "collector", appLaunch: { bundlePath: "/private/fixture/app" } },
        method: "query",
        runId: "kitty-reviewed",
        runSha256,
      },
    },
    "extensions.sixel": {
      featureId: "extensions.sixel",
      outcome: "unsupported",
      evidence: "behavior",
      conclusive: true,
      record: {
        assertions: [
          { featureId: "extensions.sixel", kind: "negative", expected: "sixel image", observed: "no image" },
        ],
      },
      chain: { origin: { kind: "collector" }, method: "behavior", runId: "kitty-reviewed", runSha256 },
    },
  }
  const selected = {
    runId: "kitty-reviewed",
    target,
    measuredAt,
    suiteId: "suite-v2",
    probeHash: "current",
    suiteFreshness: "current",
    sourceRevision: "rev",
    sha256: runSha256,
    suite: { observed: 2, expected: 2, complete: true },
    cells,
    v1: { "sgr.bold": true, "extensions.sixel": false },
    counts: { catalog: 270, tested: 2, notTested: 268, conclusive: 2, supported: 1, unsupported: 1 },
    ungradedDiagnostics: {
      evidence: "legacy",
      label: "old callback result, unverified",
      results: { "sgr.bold": { kind: "collector-error", name: "PRIVATE_DIAGNOSTIC" } },
    },
    reviews: [
      { id: "kitty-review", reviewer: "reviewer", reason: "exact-run identity checked", sources: ["review://kitty"] },
    ],
  }
  const mux = {
    ...selected,
    runId: "tmux-reviewed",
    sha256: "b".repeat(64),
    suite: { observed: 1, expected: 1, complete: true },
    target: { ...target, kind: "mux", id: "tmux", outerTerminal: "kitty", mux: "tmux" },
    reviews: [
      { id: "tmux-review", reviewer: "reviewer", reason: "exact-run identity checked", sources: ["review://tmux"] },
    ],
    cells: {},
    v1: { "sgr.bold": true },
    counts: { catalog: 270, tested: 1, notTested: 269, conclusive: 1, supported: 1, unsupported: 0 },
  }
  const screen = {
    ...mux,
    runId: "screen-reviewed",
    sha256: "d".repeat(64),
    measuredAt: "2026-09-29T12:34:56.000Z",
    target: { ...mux.target, id: "screen", mux: "screen", version: "5.0" },
    cells: {
      "sgr.bold": {
        ...cells["sgr.bold"],
        outcome: "inconclusive",
        conclusive: false,
        chain: { origin: { kind: "collector" }, method: "query", runId: "screen-reviewed", runSha256: "d".repeat(64) },
      },
    },
    v1: {},
    counts: { catalog: 270, tested: 1, notTested: 269, conclusive: 0, supported: 0, unsupported: 0 },
  }
  const olderScreen = {
    ...selected,
    runId: "screen-older-reviewed",
    sha256: "c".repeat(64),
    target: { ...screen.target, version: "4.9" },
    cells: Object.fromEntries(
      Object.entries(cells).map(([id, cell]) => [
        id,
        {
          ...cell,
          chain: { ...cell.chain, runId: "screen-older-reviewed", runSha256: "c".repeat(64) },
        },
      ]),
    ),
  }
  const alternateKitty = {
    ...selected,
    runId: "kitty-clipboard-reviewed",
    sha256: "e".repeat(64),
    target: { ...target, permissions: "clipboard: read=deny,write=allow" },
    cells: {},
    v1: {},
    counts: { catalog: 270, tested: 0, notTested: 270, conclusive: 0, supported: 0, unsupported: 0 },
  }
  return {
    runSha256,
    measuredAt,
    selected,
    mux,
    screen,
    projection: {
      current: { "app:kitty": selected, "mux:tmux": mux, "mux:screen": screen },
      versions: {
        "app:kitty": [selected],
        "app:kitty:clipboard": [alternateKitty],
        "headless:kitty": [
          {
            ...alternateKitty,
            sha256: "f".repeat(64),
            target: { ...target, kind: "headless" },
          },
        ],
        "mux:tmux": [mux],
        "mux:screen": [screen, olderScreen],
      },
      history: { "app:kitty": [selected], "mux:tmux": [mux], "mux:screen": [screen] },
      exclusions: [],
    },
  }
})

vi.mock("../docs/data/current-results.ts", () => ({
  loadCurrentResults: () => ({ projection: fixture.projection }),
  compatibilityTargets: () =>
    new Map([
      ["kitty", { contextKey: "app:kitty", selected: fixture.selected }],
      ["tmux", { contextKey: "mux:tmux", selected: fixture.mux }],
      ["screen", { contextKey: "mux:screen", selected: fixture.screen }],
    ]),
}))

import probesLoader from "../docs/data/probes.data.ts"
import { loadProbes } from "../docs/data/load-probes.ts"
import * as probeData from "../docs/data/load-probes.ts"
import { loadFullProbes } from "../docs/data/probes.data.ts"
import * as currentResults from "../docs/data/current-results.ts"
import terminalPaths from "../docs/terminals/[id].paths.ts"
import comparePaths from "../docs/compare/[id].paths.ts"
import baselinePaths from "../docs/baseline/[id].paths.ts"
import categoryPaths from "../docs/[id].paths.ts"
import featurePaths from "../docs/[category]/[id].paths.ts"
import { generateApi, assertDeploymentLimits } from "./generate-api.ts"
import { generateAnalysis } from "./generate-analysis.ts"

it("analysis rejects malformed required catalogs before replacing its output", () => {
  const out = mkdtempSync(join(tmpdir(), "terminfo-analysis-metadata-"))
  try {
    const sourceRoot = join(import.meta.dirname, "..")
    mkdirSync(join(out, "scripts"))
    mkdirSync(join(out, "content"))
    for (const dir of ["probes-apps", "probes-mux", "probes-libs"]) mkdirSync(join(out, "content", dir))
    for (const dir of ["docs", "node_modules"]) symlinkSync(join(sourceRoot, dir), join(out, dir), "dir")
    const script = join(out, "scripts", "generate-analysis.ts")
    cpSync(join(import.meta.dirname, "generate-analysis.ts"), script)
    for (const name of [
      "features",
      "terminals",
      "categories",
      "standards",
      "baselines",
      "frameworks",
      "glossary",
      "annotations",
    ]) {
      cpSync(join(sourceRoot, "content", `${name}.json`), join(out, "content", `${name}.json`))
    }
    const control = spawnSync(process.execPath, [script, "--dry-run"], { cwd: out, encoding: "utf8", timeout: 10_000 })
    expect(control.error).toBeUndefined()
    expect(control.status, control.stderr).toBe(0)
    expect(control.stdout).toContain("Would generate")
    const outputPath = join(out, "content", "analysis.json")
    writeFileSync(outputPath, "PRESERVE_PREVIOUS_ANALYSIS")
    for (const [name, invalid] of [
      ["features", "[]"],
      ["terminals", "[]"],
      ["categories", "[]"],
      ["standards", "[]"],
      ["baselines", "[]"],
      ["features", "null"],
    ] as const) {
      const path = join(out, "content", `${name}.json`)
      const original = readFileSync(path, "utf8")
      writeFileSync(path, invalid)
      const result = spawnSync(process.execPath, [script], { cwd: out, encoding: "utf8", timeout: 10_000 })
      expect(result.error).toBeUndefined()
      expect(result.status, `${name}: ${result.stderr}`).toBe(1)
      expect(result.stderr).toContain(path)
      expect(result.stdout).not.toContain("Generated ")
      expect(readFileSync(outputPath, "utf8")).toBe("PRESERVE_PREVIOUS_ANALYSIS")
      writeFileSync(path, original)
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

it("analysis validation refuses stale live values and key drift but labels historical schema checks", () => {
  // --validate must prove current values, not merely presence; existing catalog-refusal coverage cannot detect this.
  const out = mkdtempSync(join(tmpdir(), "terminfo-analysis-validation-"))
  try {
    const sourceRoot = join(import.meta.dirname, "..")
    mkdirSync(join(out, "scripts"))
    mkdirSync(join(out, "content"))
    for (const dir of ["probes-apps", "probes-mux", "probes-libs"]) mkdirSync(join(out, "content", dir))
    for (const dir of ["docs", "node_modules"]) symlinkSync(join(sourceRoot, dir), join(out, dir), "dir")
    const script = join(out, "scripts", "generate-analysis.ts")
    cpSync(join(import.meta.dirname, "generate-analysis.ts"), script)
    for (const name of [
      "features",
      "terminals",
      "categories",
      "standards",
      "baselines",
      "frameworks",
      "glossary",
      "annotations",
    ]) {
      cpSync(join(sourceRoot, "content", `${name}.json`), join(out, "content", `${name}.json`))
    }
    const run = (args: string[]) =>
      spawnSync(process.execPath, [script, ...args], { cwd: out, encoding: "utf8", timeout: 10_000 })
    const generated = run([])
    expect(generated.status, generated.stderr).toBe(0)
    const outputPath = join(out, "content", "analysis.json")
    const original = readFileSync(outputPath, "utf8")
    const isFixtureObject = (value: unknown): value is Record<string, unknown> =>
      value !== null && typeof value === "object" && !Array.isArray(value)
    const parseFixture = (): Record<string, unknown> => {
      const data: unknown = JSON.parse(original)
      if (!isFixtureObject(data)) throw new Error("Expected generated analysis fixture object")
      return data
    }
    const entry = (data: Record<string, unknown>, key: string): Record<string, unknown> => {
      const value = data[key]
      if (!isFixtureObject(value)) throw new Error(`Expected generated analysis fixture entry: ${key}`)
      return value
    }
    const control = parseFixture()
    const liveKey = "terminals/kitty"
    const historicalKey = "terminals/vt100-historical"
    const valid = run(["--validate"])
    expect(valid.status, valid.stderr).toBe(0)
    const cases: Array<[string, (data: typeof control) => void]> = [
      [
        liveKey,
        (data) => {
          entry(data, liveKey).analysis = "<p>Stale claimed support.</p>"
        },
      ],
      [
        liveKey,
        (data) => {
          entry(data, liveKey).date = "2000-01-01"
        },
      ],
      [
        liveKey,
        (data) => {
          entry(data, liveKey).probeCount = 123
        },
      ],
      [
        liveKey,
        (data) => {
          delete data[liveKey]
        },
      ],
      [
        "stale-extra",
        (data) => {
          data["stale-extra"] = data[liveKey]
        },
      ],
      [
        historicalKey,
        (data) => {
          entry(data, historicalKey).analysis = 42
        },
      ],
      [
        historicalKey,
        (data) => {
          entry(data, historicalKey).probeCount = 123
        },
      ],
    ]
    for (const [key, mutate] of cases) {
      const data = parseFixture()
      mutate(data)
      const bytes = JSON.stringify(data)
      writeFileSync(outputPath, bytes)
      const result = run(["--validate"])
      expect(result.status, `${key}: ${result.stderr}`).toBe(1)
      expect(result.stderr).toContain(key)
      expect(result.stdout).not.toContain("Validation passed")
      expect(readFileSync(outputPath, "utf8")).toBe(bytes)
    }
    expect(valid.stdout).toContain(`${liveKey}: current-value passed`)
    expect(valid.stdout).toContain(`${historicalKey}: historical-schema passed`)
    entry(control, historicalKey).analysis = "<p>Older historical reference.</p>"
    entry(control, historicalKey).date = "2000-01-01"
    writeFileSync(outputPath, JSON.stringify(control))
    const historical = run(["--validate"])
    expect(historical.status, historical.stderr).toBe(0)
    expect(historical.stdout).toContain(`${historicalKey}: historical-schema passed`)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}, 30_000)

describe("selected-run consumer parity", () => {
  it("publishes v2 run references that resolve to digest-verified full run documents", () => {
    const out = mkdtempSync(join(tmpdir(), "terminfo-run-documents-"))
    try {
      generateApi(out)
      type RunReference = {
        runId: string
        target: Record<string, unknown>
        measuredAt: string
        suiteId: string
        probeHash: string
        suiteFreshness: string
        sourceRevision: string
        sha256: string
        counts: Record<string, unknown>
        url: string
        documentSha256: string
      }
      const v2 = JSON.parse(readFileSync(join(out, "api", "v2", "data.json"), "utf8")) as {
        current: Record<string, RunReference>
        versions: Record<string, RunReference[]>
        history: Record<string, RunReference[]>
      }
      const refs = [v2.current["app:kitty"], v2.versions["mux:screen"]?.[0], v2.history["app:kitty"]?.[0]]
      for (const ref of refs) {
        if (!ref) throw new Error("Expected current, version and history run references")
        expect(ref).toMatchObject({
          runId: expect.any(String),
          target: expect.any(Object),
          measuredAt: expect.any(String),
          suiteId: expect.any(String),
          probeHash: expect.any(String),
          suiteFreshness: expect.any(String),
          sourceRevision: expect.any(String),
          sha256: expect.any(String),
          counts: expect.any(Object),
          url: expect.stringMatching(/^\/api\/v2\/runs\/[a-f0-9]{64}\.json$/),
          documentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        })
        const documentBytes = readFileSync(join(out, ref.url))
        expect(createHash("sha256").update(documentBytes).digest("hex")).toBe(ref.documentSha256)
        const document = JSON.parse(documentBytes.toString("utf8")) as Record<string, unknown>
        expect(document).toMatchObject({ runId: ref.runId, sha256: ref.sha256, target: ref.target })
        expect(document.cells).toBeDefined()
      }
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it("ships current cells without global selection history while routes retain versions", () => {
    const site = probesLoader.load()
    expect(Object.hasOwn(site, "selected")).toBe(false)
    expect(site.selectedByBackend.screen?.selected.cells["sgr.bold"]?.outcome).toBe("inconclusive")

    const server = loadProbes()
    expect(server.selected.versions["mux:screen"]?.map((version) => version.target.version)).toEqual(["5.0", "4.9"])
    expect(server.selected.history["mux:screen"]?.[0]?.runId).toBe(fixture.screen.runId)
  })

  it("keeps raw evidence and unchecked collector notes out of generated site and API summaries", () => {
    const out = mkdtempSync(join(tmpdir(), "terminfo-presentation-"))
    try {
      const site = probesLoader.load()
      generateApi(out)
      const v1 = readFileSync(join(out, "api", "v1", "data.json"), "utf8")
      const v2 = readFileSync(join(out, "api", "v2", "data.json"), "utf8")
      for (const serialized of [JSON.stringify(site), v1, v2]) {
        for (const marker of [
          "PRIVATE_ASSERTION_EXPECTED",
          "PRIVATE_DIAGNOSTIC",
          "/home/fixture/private",
          "/private/fixture/app",
        ]) {
          expect(serialized).not.toContain(marker)
        }
      }
      expect(site.results.kitty?.["sgr.bold"]).toBe("yes")
      expect(JSON.parse(v1)).toMatchObject({ results: { kitty: { "sgr.bold": "yes" } } })
      expect(site.selectedByBackend.kitty?.selected.cells["sgr.bold"]?.chain.runSha256).toBe(fixture.runSha256)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it("presents only approved original feature details and withdraws generated files without changing v1 results", () => {
    const out = mkdtempSync(join(tmpdir(), "terminfo-presentation-approved-"))
    const copied = mkdtempSync(join(tmpdir(), "terminfo-presentation-copied-public-"))
    const cell = fixture.selected.cells["sgr.bold"] as unknown as SelectedCell
    const original = structuredClone(cell)
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    )
    const digest = createHash("sha256").update(png).digest("hex")
    const screenshot = { url: `/artifacts/${digest}.png`, sha256: digest }
    const imageReader = vi.spyOn(selectedResults, "readVerifiedScreenshot").mockImplementation((_content, ref) => {
      expect(ref).toBe(`sha256:${digest}`)
      return png
    })
    try {
      cell.presentation = {
        decision: {
          id: "present-bold",
          reviewer: "reviewer",
          reason: "checked original evidence",
          sources: ["https://example.org/review"],
          presentsEvidence: true,
        },
        original: {
          observation: {
            featureId: "sgr.bold",
            outcome: original.outcome,
            evidence: original.evidence,
            note: original.note,
          },
          record: { ...original.record, screenshot },
        },
      }
      cell.chain.correctionId = "correct-bold"
      cell.note = "Reviewed correction note"
      cell.record = { rawReply: "CORRECTION_OTHER_FEATURE_RAW", assertions: [] }
      const site = probesLoader.load()
      const presented = site.selectedByBackend.kitty?.selected.cells["sgr.bold"]?.presentation
      expect(presented?.state).toBe("presented")
      if (presented?.state !== "presented") throw new Error("Missing presented evidence")
      generateApi(out)
      const evidenceFile = join(out, presented.url.slice(1))
      const bytes = readFileSync(evidenceFile)
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(presented.sha256)
      const document = JSON.parse(bytes.toString("utf8")) as EvidenceDocument
      expect(document).toMatchObject({
        runId: fixture.selected.runId,
        runSha256: fixture.runSha256,
        featureId: "sgr.bold",
      })
      expect(document.record.rawReply).toBe(original.record.rawReply)
      expect(bytes.toString("utf8")).not.toContain("CORRECTION_OTHER_FEATURE_RAW")
      expect(document.observation.note).toBe(original.note)
      expect(JSON.stringify(site)).not.toContain("PRIVATE_ASSERTION_EXPECTED")
      expect(readFileSync(join(out, screenshot.url.slice(1)))).toEqual(png)
      const v1Before = JSON.parse(readFileSync(join(out, "api/v1/data.json"), "utf8")) as CompatibilityData
      expect(v1Before.notes.kitty?.["sgr.bold"]).toBe("Reviewed correction note")

      // A new staged build may start with a previous docs/public snapshot copied into it.
      cpSync(out, copied, { recursive: true })
      cell.presentation.decision = {
        ...cell.presentation.decision,
        id: "withdraw-bold",
        reason: "Withdrawn for recheck",
        presentsEvidence: false,
      }
      generateApi(out)
      generateApi(copied)
      expect(existsSync(evidenceFile)).toBe(false)
      expect(existsSync(join(copied, presented.url.slice(1)))).toBe(false)
      expect(existsSync(join(out, screenshot.url.slice(1)))).toBe(false)
      expect(existsSync(join(copied, screenshot.url.slice(1)))).toBe(false)
      const after = probesLoader.load().selectedByBackend.kitty?.selected.cells["sgr.bold"]
      expect(after?.presentation).toMatchObject({ state: "withdrawn", review: { reason: "Withdrawn for recheck" } })
      const v1After = JSON.parse(readFileSync(join(out, "api/v1/data.json"), "utf8")) as CompatibilityData
      expect(v1After.results).toEqual(v1Before.results)
      expect(v1After.terminals).toEqual(v1Before.terminals)
      expect(v1After.notes.kitty?.["sgr.bold"]).toBe("Reviewed correction note")

      Reflect.deleteProperty(cell.chain, "correctionId")
      cell.note = original.note
      cell.presentation.decision.presentsEvidence = true
      generateApi(out)
      expect(JSON.parse(readFileSync(join(out, "api/v1/data.json"), "utf8"))).toMatchObject({
        notes: { kitty: { "sgr.bold": original.note } },
      })
    } finally {
      imageReader.mockRestore()
      Object.assign(cell, original)
      delete cell.presentation
      rmSync(out, { recursive: true, force: true })
      rmSync(copied, { recursive: true, force: true })
    }
  })

  it("fails by path if copied static evidence was never owned by the generator", () => {
    const out = mkdtempSync(join(tmpdir(), "terminfo-unapproved-artifact-"))
    const path = join(out, "artifacts", `${"f".repeat(64)}.png`)
    try {
      mkdirSync(join(out, "artifacts"))
      writeFileSync(path, "UNAPPROVED_STATIC_IMAGE")
      expect(() => generateApi(out)).toThrow(path)
      expect(readFileSync(path, "utf8")).toBe("UNAPPROVED_STATIC_IMAGE")
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it("withdraws an owned run document after its last public projection reference is removed", () => {
    const out = mkdtempSync(join(tmpdir(), "terminfo-stale-run-"))
    const runPath = join(out, "api", "v2", "runs", `${fixture.runSha256}.json`)
    const current = fixture.projection.current["app:kitty"]
    const versions = fixture.projection.versions["app:kitty"]
    const history = fixture.projection.history["app:kitty"]
    try {
      generateApi(out)
      expect(existsSync(runPath)).toBe(true)
      Reflect.deleteProperty(fixture.projection.current, "app:kitty")
      fixture.projection.versions["app:kitty"] = []
      fixture.projection.history["app:kitty"] = []
      generateApi(out)
      expect(existsSync(runPath)).toBe(false)
    } finally {
      if (current) fixture.projection.current["app:kitty"] = current
      fixture.projection.versions["app:kitty"] = versions ?? []
      fixture.projection.history["app:kitty"] = history ?? []
      rmSync(out, { recursive: true, force: true })
    }
  })

  it("reports the real output path when the conservative file-count cap is exceeded", () => {
    const out = mkdtempSync(join(tmpdir(), "terminfo-api-file-count-"))
    try {
      for (let index = 0; index < 20_000; index++) {
        writeFileSync(join(out, `ordinary-${index}.txt`), "x")
      }
      let failure: unknown
      try {
        generateApi(out)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toContain(out)
      expect((failure as Error).message).toMatch(/files exceeds the 20000-file Cloudflare Pages Free-plan limit/)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  }, 30_000)

  it("refuses an API asset above the deployment byte limit before writing it", () => {
    const out = mkdtempSync(join(tmpdir(), "terminfo-api-size-"))
    const cell = fixture.selected.cells["sgr.bold"]!
    const originalNote = cell.note
    try {
      // A reviewed correction note is public run content. The raw UTF-8 body
      // exceeds the single-file cap even though string length alone would not.
      Object.assign(cell.chain, { correctionId: "large-reviewed-correction" })
      cell.note = "界".repeat(9 * 1024 * 1024)
      expect(() => generateApi(out)).toThrow(
        new RegExp(`api/v2/runs/${fixture.runSha256}\\.json.*bytes.*26214400.*Cloudflare Pages`),
      )
      expect(existsSync(join(out, "api", "v2", "data.json"))).toBe(false)
    } finally {
      Reflect.deleteProperty(cell.chain, "correctionId")
      cell.note = originalNote
      rmSync(out, { recursive: true, force: true })
    }
  })

  // An empty deployment directory is a wrong build target, not evidence of spare capacity.
  it("refuses an empty deployment tree instead of certifying the wrong directory", () => {
    const out = mkdtempSync(join(tmpdir(), "terminfo-empty-deploy-"))
    try {
      expect(() => assertDeploymentLimits(out)).toThrow(`${out}: deployment output contains no files`)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  // The renderer writes files outside the API writer; its final deployment check must cover them too.
  it.each(["oversized", "symlink"])("rejects %s site assets at the final deployment boundary", (kind) => {
    const out = mkdtempSync(join(tmpdir(), "terminfo-site-asset-limit-"))
    const path = join(out, "page.html")
    try {
      if (kind === "oversized") writeFileSync(path, Buffer.alloc(25 * 1024 * 1024 + 1))
      else symlinkSync("missing-page.html", path)
      let failure: unknown
      try {
        assertDeploymentLimits(out)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toContain(path)
      expect((failure as Error).message).toContain(kind === "oversized" ? "26214401 bytes" : "symlink")
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it("keeps the same run, conclusive counts and measurement time in every consumer", () => {
    const warnings: string[] = []
    const warning = vi.spyOn(console, "warn").mockImplementation((message: unknown) => warnings.push(String(message)))
    const out = mkdtempSync(join(tmpdir(), "terminfo-api-parity-"))
    try {
      const site = probesLoader.load()
      const terminal = terminalPaths.paths().find((page) => page.params.id === "kitty")
      const analyses = generateAnalysis()
      const analysis = analyses["terminals/kitty"]
      generateApi(out)
      const v1 = JSON.parse(readFileSync(join(out, "api", "v1", "data.json"), "utf8")) as {
        results: Record<string, Record<string, string>>
        terminals: Record<string, { score: { total: number; pass: number } }>
        methodology: { contexts: Record<string, { contextKey: string; runSha256: string }> }
      }
      const v2 = JSON.parse(readFileSync(join(out, "api", "v2", "data.json"), "utf8")) as {
        current: Record<
          string,
          { sha256: string; counts: { conclusive: number; supported: number; unsupported: number } }
        >
      }
      expect(site.selectedByBackend.kitty?.selected.sha256).toBe(fixture.runSha256)
      expect(site.stats.kitty).toMatchObject({ total: 2, yes: 1, no: 1 })
      expect(terminal?.params).toMatchObject({ generated: fixture.measuredAt, total: "2", yes: "1", no: "1" })
      expect(terminal?.params.runSha256).toBe(fixture.runSha256)
      const alternatives = JSON.parse(terminal!.params.otherRuns!) as PublicVersion[]
      expect(alternatives.map((run: { runId: string }) => run.runId)).toEqual(["kitty-clipboard-reviewed"])
      expect(alternatives[0]?.target.permissions).toBe("clipboard: read=deny,write=allow")
      const screenPage = terminalPaths.paths().find((page) => page.params.backendId === "screen")!
      const olderRuns = JSON.parse(screenPage.params.otherRuns!) as PublicVersion[]
      expect(olderRuns.map((run) => run.target.version)).toEqual(["4.9"])
      expect(terminal?.params.terminalType).toBe("app")
      expect(v1.results.kitty).toEqual({ "sgr.bold": "yes", "extensions.sixel": "no" })
      expect(v1.terminals.kitty?.score).toMatchObject({ total: 2, pass: 1 })
      expect(v1.methodology.contexts.kitty).toMatchObject({ contextKey: "app:kitty", runSha256: fixture.runSha256 })
      expect(v2.current["app:kitty"]?.sha256).toBe(fixture.runSha256)
      expect(v2.current["mux:tmux"]?.sha256).toBe(fixture.mux.sha256)
      expect(v1.terminals.tmux).toBeUndefined()
      expect(v1.results.tmux).toBeUndefined()
      expect(v2.current["app:kitty"]?.counts).toMatchObject({ conclusive: 2, supported: 1, unsupported: 1 })
      expect(analysis).toMatchObject({
        runSha256: fixture.runSha256,
        measuredAt: fixture.measuredAt,
        counts: { conclusive: 2, supported: 1, unsupported: 1 },
      })
      expect(analyses["features-index"]?.analysis).toContain("<strong>1</strong> feature")
      expect(analyses["baseline/core"]?.analysis).toContain("<strong>0</strong> of 2")
      expect(analyses["framework/ink"]?.analysis).toContain("<strong>0</strong> of 2")
      expect(analyses["sgr/38-2-truecolor-fg"]?.analysis).toContain("awaiting verified measurements")
      expect(analyses.cursor?.analysis).toContain("awaiting verified measurements")
      expect(analyses.vt220?.analysis).toContain("awaiting verified measurements")
      expect(analyses["baseline/modern"]?.analysis).toContain("awaiting verified measurements")
      expect(warnings).toContainEqual(expect.stringContaining("historical analysis snapshot is not current evidence"))
      expect(
        warnings.every(
          (message) =>
            message.includes("historical analysis snapshot is not current evidence") ||
            message.includes("no reviewed current conclusive results"),
        ),
      ).toBe(true)
    } finally {
      warning.mockRestore()
      rmSync(out, { recursive: true, force: true })
    }
  })

  it("names the canonical Legacy baseline for a measured legacy feature", () => {
    // Core-only fixtures would miss the generator's former fallback of every other baseline to Unicode.
    const warnings: string[] = []
    const warning = vi.spyOn(console, "warn").mockImplementation((message: unknown) => warnings.push(String(message)))
    const featureId = "modes.decsclm"
    const cells = fixture.selected.cells
    const results = fixture.selected.v1
    const bold = cells["sgr.bold"]
    if (!bold) throw new Error("Missing selected bold fixture cell")
    try {
      Object.assign(cells, {
        [featureId]: {
          ...bold,
          featureId,
          outcome: "unsupported",
          evidence: "behavior",
          conclusive: true,
          record: { assertions: [{ featureId, kind: "negative", expected: "smooth scroll", observed: "jump scroll" }] },
          chain: { ...bold.chain, method: "behavior" },
        },
      })
      Object.assign(results, { [featureId]: false })
      const analysis = generateAnalysis()["modes/decsclm-smooth-scroll"]?.analysis
      expect(analysis).toContain("Legacy")
      expect(analysis).not.toContain("Unicode")
      expect(warnings.every((message) => message.includes("no reviewed current conclusive results"))).toBe(true)
    } finally {
      warning.mockRestore()
      Reflect.deleteProperty(cells, featureId)
      Reflect.deleteProperty(results, featureId)
    }
  })

  it("uses the merged category/tag feature scope for analysis and unsupported gaps", () => {
    // Unicode's category-only tab-stop feature used to disappear when tag prose overwrote the merged page.
    const id = "unicode.tab-stops"
    const cells = fixture.selected.cells
    const results = fixture.selected.v1
    const bold = cells["sgr.bold"]
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      Object.assign(cells, { [id]: { ...bold, featureId: id, outcome: "unsupported", conclusive: true } })
      Object.assign(results, { [id]: false })
      const page = categoryPaths.paths().find((entry) => entry.params.id === "unicode")!
      const rows = JSON.parse(page.params.features!) as Array<{ id: string }>
      expect(rows.map((row) => row.id)).toContain(id)
      const prose = generateAnalysis().unicode!.analysis
      expect(prose).toContain(`covers ${page.params.featureCount} features`)
      expect(prose).toContain("Tab Stops")
      expect(prose).not.toContain("awaiting verified measurements")
    } finally {
      Reflect.deleteProperty(cells, id)
      Reflect.deleteProperty(results, id)
      warning.mockRestore()
    }
  })

  it("keeps a reviewed inconclusive target and its version visible without a score", () => {
    const site = probesLoader.load()
    const terminal = terminalPaths.paths().find((page) => page.params.id === "gnu-screen")
    expect(site.backends.map((backend) => backend.name)).toContain("screen")
    expect(site.selectedByBackend.screen?.selected.cells["sgr.bold"]?.outcome).toBe("inconclusive")
    expect(site.stats.screen).toMatchObject({ total: 0, yes: 0, no: 0 })
    expect(site.stats.screen?.pct).toBeNull()
    expect(terminal?.params).toMatchObject({
      generated: fixture.screen.measuredAt,
      runSha256: fixture.screen.sha256,
      pct: "",
    })
    expect(JSON.parse(terminal?.params.versions ?? "[]")).toEqual([
      expect.objectContaining({ version: fixture.screen.target.version, pct: null }),
      expect.objectContaining({ version: "4.9", pct: 50 }),
    ])
    const comparison = comparePaths
      .paths()
      .find(
        (page) =>
          [page.params.termAId, page.params.termBId].includes("screen") &&
          [page.params.termAId, page.params.termBId].includes("kitty"),
      )
    expect(comparison?.params[comparison.params.termAId === "screen" ? "termATotal" : "termBTotal"]).toBe("0")
    expect(comparison?.params.comparableScope).toBe("false")
    const core = baselinePaths.paths().find((page) => page.params.id === "core")
    expect(JSON.parse(core?.params.scores ?? "[]")).toContainEqual(
      expect.objectContaining({ name: "screen", total: 0, pct: null }),
    )
    const bold = featurePaths.paths().find((page) => page.params.featureId === "sgr.bold")
    expect(bold?.params).toMatchObject({ yesCount: "2", totalCount: "2" })
  })

  it("limits comparison claims to the same recorded scope and jointly conclusive evidence method", () => {
    const data = loadProbes()
    const kitty = data.selectedByBackend.kitty?.selected
    const screen = data.selectedByBackend.screen?.selected
    const tmux = data.selectedByBackend.tmux?.selected
    const bold = kitty?.cells["sgr.bold"]
    if (!screen || !tmux || !bold) throw new Error("Missing comparison fixture cells")

    const mixed = comparePaths
      .paths()
      .find(
        (page) =>
          [page.params.termAId, page.params.termBId].includes("screen") &&
          [page.params.termAId, page.params.termBId].includes("kitty"),
      )
    expect(mixed?.params.comparableScope).toBe("false")
    expect(mixed?.params.differ).toBe("")
    expect(mixed?.params.termAKind).toBeDefined()
    expect(mixed?.params.termBKind).toBeDefined()

    const originalScreen = structuredClone(screen)
    const originalTmux = structuredClone(tmux)
    try {
      screen.target.mux = tmux.target.mux
      screen.cells["sgr.bold"] = { ...structuredClone(bold), outcome: "unsupported", conclusive: true }
      tmux.cells["sgr.bold"] = { ...structuredClone(bold), outcome: "supported", conclusive: true }
      screen.cells["extensions.sixel"] = {
        ...structuredClone(bold),
        featureId: "extensions.sixel",
        outcome: "unsupported",
        evidence: "parser-state",
      }
      tmux.cells["extensions.sixel"] = {
        ...structuredClone(bold),
        featureId: "extensions.sixel",
        outcome: "supported",
        evidence: "query",
      }
      const pair = comparePaths
        .paths()
        .find(
          (page) =>
            [page.params.termAId, page.params.termBId].includes("screen") &&
            [page.params.termAId, page.params.termBId].includes("tmux"),
        )
      expect(pair?.params.comparableScope).toBe("true")
      expect(pair?.params.jointConclusive).toBe("1")
      expect(pair?.params.differ).toBe("1")
      const rows = JSON.parse(pair?.params.categories ?? "[]") as Array<{
        features: Array<{ id: string; comparable: boolean }>
      }>
      const cells = rows.flatMap((category) => category.features)
      expect(cells.find((cell) => cell.id === "sgr.bold")?.comparable).toBe(true)
      expect(cells.find((cell) => cell.id === "extensions.sixel")?.comparable).toBe(false)

      screen.target.os = null
      const unknownOsPair = comparePaths
        .paths()
        .find(
          (page) =>
            [page.params.termAId, page.params.termBId].includes("screen") &&
            [page.params.termAId, page.params.termBId].includes("tmux"),
        )
      expect(unknownOsPair?.params.comparableScope).toBe("false")
    } finally {
      Object.assign(screen, originalScreen)
      Object.assign(tmux, originalTmux)
    }
  })

  it("separates conclusive baseline rate from full catalog coverage", () => {
    const site = probesLoader.load()
    const catalog = site.baselines.core?.length ?? 0
    expect(catalog).toBeGreaterThan(1)
    expect(site.baselineStats.kitty?.core).toMatchObject({
      total: 1,
      yes: 1,
      pct: 100,
      catalog,
      supported: 1,
      unsupported: 0,
      inconclusive: 0,
      errors: 0,
      untested: catalog - 1,
    })
    expect(site.baselineStats.screen?.core).toMatchObject({
      total: 0,
      yes: 0,
      pct: null,
      catalog,
      supported: 0,
      unsupported: 0,
      inconclusive: 1,
      errors: 0,
      untested: catalog - 1,
    })
    const core = baselinePaths.paths().find((page) => page.params.id === "core")
    const scores = JSON.parse(core?.params.scores ?? "[]") as Array<Record<string, unknown>>
    expect(scores.find((score) => score.name === "kitty")).toMatchObject({
      version: fixture.selected.target.version,
      catalog,
      supported: 1,
      untested: catalog - 1,
      pct: 100,
    })
    const screenBold = fixture.screen.cells["sgr.bold"] as SelectedCell
    if (!screenBold) throw new Error("Missing screen error-count fixture cell")
    const originalScreenBold = structuredClone(screenBold)
    try {
      screenBold.outcome = "error"
      screenBold.reason = "collector-error"
      expect(probesLoader.load().baselineStats.screen?.core).toMatchObject({
        total: 0,
        supported: 0,
        unsupported: 0,
        inconclusive: 0,
        errors: 1,
        untested: catalog - 1,
      })
    } finally {
      Object.assign(screenBold, originalScreenBold)
      if (originalScreenBold.reason === undefined) delete screenBold.reason
    }
  })

  it("keeps unscoped annotations out of feature analysis while retaining reviewed selected notes", () => {
    const warnings: string[] = []
    const warning = vi.spyOn(console, "warn").mockImplementation((message: unknown) => warnings.push(String(message)))
    const annotations = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "content", "annotations.json"), "utf8"),
    ) as Record<string, { note: string }>
    const unscoped = annotations["kitty:extensions.sixel"]?.note
    if (!unscoped) throw new Error("Missing Kitty sixel annotation fixture")
    const cell = fixture.selected.cells["extensions.sixel"] as SelectedCell
    const original = structuredClone(cell)
    try {
      const unreviewed = generateAnalysis()["extensions/sixel-graphics"]?.analysis
      expect(unreviewed).not.toContain(unscoped)
      expect(unreviewed).toContain("No conclusive support among")
      expect(unreviewed).toContain("Not supported by:")
      cell.note = "Reviewed Kitty sixel observation note"
      cell.chain.correctionId = "reviewed-sixel"
      expect(probesLoader.load().selectedByBackend.kitty?.selected.cells["extensions.sixel"]?.note).toBe(
        "Reviewed Kitty sixel observation note",
      )
      const reviewed = generateAnalysis()["extensions/sixel-graphics"]?.analysis
      expect(reviewed).not.toContain(unscoped)
      expect(reviewed).not.toContain("Reviewed Kitty sixel observation note")
      expect(warnings.every((message) => message.includes("no reviewed current conclusive results"))).toBe(true)
    } finally {
      warning.mockRestore()
      Object.assign(cell, original)
      if (original.note === undefined) delete cell.note
      if (original.chain.correctionId === undefined) Reflect.deleteProperty(cell.chain, "correctionId")
    }
  })

  it("uses selected public notes across routes without promoting unscoped annotations", () => {
    const data = loadProbes()
    const reviewed = data.selectedByBackend.kitty?.selected.cells["sgr.bold"]
    const inconclusive = data.selectedByBackend.screen?.selected.cells["sgr.bold"]
    if (!reviewed || !inconclusive) throw new Error("Missing selected bold cells in parity fixture")
    const originalNote = reviewed.note
    const originalInconclusiveNote = inconclusive.note
    const originalBoldAnnotation = data.annotations["kitty:sgr.bold"]
    const originalSixelAnnotation = data.annotations["kitty:extensions.sixel"]
    const originalScreenAnnotation = data.annotations["screen:sgr.bold"]
    reviewed.note = "Reviewed Kitty bold note"
    inconclusive.note = "Reviewed screen inconclusive note"
    data.annotations["kitty:sgr.bold"] = {
      note: "Unscoped conflicting bold annotation",
      url: "https://example.org/unscoped-implementation",
    }
    data.annotations["kitty:extensions.sixel"] = { note: "Unreviewed sixel annotation" }
    data.annotations["screen:sgr.bold"] = { note: "Unscoped screen annotation" }

    const rowNote = (rows: string, featureId: string, backendName: string): string | undefined =>
      (JSON.parse(rows) as Array<{ id: string; results: Record<string, { note: string }> }>).find(
        (row) => row.id === featureId,
      )?.results[backendName]?.note

    try {
      const categories = categoryPaths.paths()
      const baselines = baselinePaths.paths()
      const terminals = terminalPaths.paths()
      const features = featurePaths.paths()
      const comparison = comparePaths
        .paths()
        .find(
          (entry) =>
            [entry.params.termAId, entry.params.termBId].includes("kitty") &&
            [entry.params.termAId, entry.params.termBId].includes("screen"),
        )
      const comparisonRows = JSON.parse(comparison?.params.categories ?? "[]") as Array<{
        features: Array<{ id: string; noteA: string; noteB: string }>
      }>
      const terminalNote = (backendName: string, featureId: string): string | undefined => {
        const page = terminals.find((entry) => entry.params.backendId === backendName)
        const groups = JSON.parse(page?.params.categories ?? "[]") as Array<{
          features: Array<{ id: string; note: string }>
        }>
        return groups.flatMap((group) => group.features).find((row) => row.id === featureId)?.note
      }
      for (const [backendName, featureId, categoryId, tagId, baselineId, expected] of [
        ["kitty", "sgr.bold", "sgr", "ecma-48", "core", "Reviewed Kitty bold note"],
        ["kitty", "extensions.sixel", "extensions", "sixel", "rich", ""],
        ["screen", "sgr.bold", "sgr", "ecma-48", "core", "Reviewed screen inconclusive note"],
      ] as const) {
        const category = categories.find((page) => page.params.id === categoryId)
        const tag = categories.find((page) => page.params.id === tagId)
        const baseline = baselines.find((page) => page.params.id === baselineId)
        const feature = features.find((page) => page.params.featureId === featureId)
        const featureRows = JSON.parse(feature?.params.backendResults ?? "[]") as Array<{ name: string; note: string }>
        const comparisonRow = comparisonRows.flatMap((group) => group.features).find((row) => row.id === featureId)
        expect(rowNote(category?.params.features ?? "[]", featureId, backendName)).toBe(expected)
        expect(rowNote(tag?.params.features ?? "[]", featureId, backendName)).toBe(expected)
        expect(rowNote(baseline?.params.features ?? "[]", featureId, backendName)).toBe(expected)
        expect(featureRows.find((row) => row.name === backendName)?.note).toBe(expected)
        expect(comparison?.params.termAId === backendName ? comparisonRow?.noteA : comparisonRow?.noteB).toBe(expected)
        expect(terminalNote(backendName, featureId)).toBe(expected)
      }
      expect(data.results.screen?.["sgr.bold"]).toBeUndefined()
      const bold = features.find((page) => page.params.featureId === "sgr.bold")
      const boldResults = JSON.parse(bold?.params.backendResults ?? "[]") as Array<Record<string, unknown>>
      expect(boldResults.find((row) => row.name === "kitty")).not.toHaveProperty("url")
      expect(data.annotations["kitty:sgr.bold"]?.note).toBe("Unscoped conflicting bold annotation")
      expect(data.annotations["kitty:sgr.bold"]?.url).toBe("https://example.org/unscoped-implementation")
      expect(data.annotations["kitty:extensions.sixel"]?.note).toBe("Unreviewed sixel annotation")
      expect(data.annotations["screen:sgr.bold"]?.note).toBe("Unscoped screen annotation")
    } finally {
      if (originalNote === undefined) delete reviewed.note
      else reviewed.note = originalNote
      if (originalInconclusiveNote === undefined) delete inconclusive.note
      else inconclusive.note = originalInconclusiveNote
      if (originalBoldAnnotation === undefined) delete data.annotations["kitty:sgr.bold"]
      else data.annotations["kitty:sgr.bold"] = originalBoldAnnotation
      if (originalSixelAnnotation === undefined) delete data.annotations["kitty:extensions.sixel"]
      else data.annotations["kitty:extensions.sixel"] = originalSixelAnnotation
      if (originalScreenAnnotation === undefined) delete data.annotations["screen:sgr.bold"]
      else data.annotations["screen:sgr.bold"] = originalScreenAnnotation
    }
  })
})

it("binds native parser page analysis to its selected run despite sharing an app route slug", () => {
  // Ghostty's native parser uses /terminals/ghostty; the unmeasured app has its own analysis placeholder.
  const native = structuredClone(fixture.selected) as unknown as SelectedVersion
  native.target = { ...native.target, kind: "headless", id: "ghostty-native" }
  const targets = vi
    .spyOn(currentResults, "compatibilityTargets")
    .mockReturnValue(new Map([["ghostty-native", { contextKey: "headless:ghostty-native", selected: native }]]))
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
  let probes: ReturnType<typeof vi.spyOn> | undefined
  let analysis: ReturnType<typeof vi.spyOn> | undefined
  try {
    const data = loadFullProbes()
    const generated = generateAnalysis()
    probes = vi.spyOn(probeData, "loadProbes").mockReturnValue(data)
    analysis = vi.spyOn(probeData, "loadAnalysis").mockReturnValue(generated)
    expect(generated["terminals/ghostty"]?.analysis).toContain("awaiting verified measurements")
    const page = terminalPaths.paths().find((entry) => entry.params.backendId === "ghostty-native")
    expect(page?.params).toMatchObject({
      id: "ghostty",
      terminalType: "headless",
      runSha256: fixture.runSha256,
      generated: fixture.measuredAt,
      analysisDate: "2026-09-28",
      total: "2",
      yes: "1",
      no: "1",
    })
    expect(page?.params.analysis).not.toContain("awaiting verified measurements")
    expect(page?.params.analysis).toContain("(1/2)")
    // Missing or stale analysis must not silently fall back to the app placeholder.
    delete generated["terminals/ghostty-native"]
    expect(() => terminalPaths.paths()).toThrow(/ghostty-native.*selected run.*aaaaaaaa/)
    // The inverse collision must not attribute a measured app's analysis to an unmeasured parser.
    const app = structuredClone(native)
    app.target = { ...app.target, kind: "app", id: "ghostty" }
    app.sha256 = "b".repeat(64)
    targets.mockReturnValue(new Map([["ghostty", { contextKey: "app:ghostty", selected: app }]]))
    analysis.mockReturnValue(generateAnalysis())
    native.counts = { ...native.counts, conclusive: 0, supported: 0, unsupported: 0 }
    native.v1 = {}
    targets.mockReturnValue(new Map([["ghostty-native", { contextKey: "headless:ghostty-native", selected: native }]]))
    probes.mockReturnValue(loadFullProbes())
    const unmeasured = terminalPaths.paths().find((entry) => entry.params.backendId === "ghostty-native")
    expect(unmeasured?.params).toMatchObject({
      total: "0",
      analysis: "",
      analysisDate: "",
      runSha256: fixture.runSha256,
    })
  } finally {
    probes?.mockRestore()
    analysis?.mockRestore()
    warning.mockRestore()
    targets.mockRestore()
  }
})
