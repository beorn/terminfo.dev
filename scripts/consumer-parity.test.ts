/**
 * @failure Site, API and analysis disagree about an admitted run, or an unscoped annotation leaks into selected notes or generated commentary.
 * @level l2
 * @consumer Site matrix, terminal paths, v1/v2 API and generated analysis.
 * @testonly none
 */
import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync, cpSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SelectedCell } from "../docs/data/selected-results.ts"
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
        "headless:kitty": [{ ...alternateKitty, target: { ...target, kind: "headless" } }],
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
import terminalPaths from "../docs/terminals/[id].paths.ts"
import comparePaths from "../docs/compare/[id].paths.ts"
import baselinePaths from "../docs/baseline/[id].paths.ts"
import categoryPaths from "../docs/[id].paths.ts"
import featurePaths from "../docs/[category]/[id].paths.ts"
import { generateApi } from "./generate-api.ts"
import { generateAnalysis } from "./generate-analysis.ts"

describe("selected-run consumer parity", () => {
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

      delete cell.chain.correctionId
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
      if (original.chain.correctionId === undefined) delete cell.chain.correctionId
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
