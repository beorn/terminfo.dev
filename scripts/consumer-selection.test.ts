import { finalizeCollectedDraft } from "../packages/terminfo.dev/src/capture-writer.ts"
/**
 * @failure Unreviewed runs become current scores, or refresh skips its release assessment and errors.
 * @level l2
 * @consumer Site data and JSON API use the canonical reviewed-run selector.
 * @reach fs-walk <fixture-only: walks temporary scratch fixtures for run selection>
 * @testonly none
 * @reach fs-walk vendor/terminfo.dev/content/probes-apps/** vendor/terminfo.dev/content/probes-mux/** vendor/terminfo.dev/content/probes-libs/**
 * @reach fs-read vendor/terminfo.dev/test-fixtures/** (the checked-in round the v3 run-reference parity case reads)
 */
import { describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { initializeRunDraft } from "@terminfo/probe-defs"
import { parseSuiteManifest } from "@terminfo/run-parser"
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import probesLoader from "../docs/data/probes.data.ts"
import { generateApi } from "./generate-api.ts"
import { loadAnalysis } from "../docs/data/load-probes.ts"
import terminalPaths from "../docs/terminals/[id].paths.ts"
import { compatibilitySubjects, loadCurrentResults } from "../docs/data/current-results.ts"
import { publicResults } from "../docs/data/public-results.ts"
import type { PublicVersion, PublicContextSummary } from "../docs/data/public-results.ts"
import { projectedContextKey, type SelectedProjection } from "../docs/data/selected-results.ts"
import type { CellState } from "../docs/data/release-scope.ts"
import { probeHash } from "../packages/admin/versions.ts"

/** One synthetic current run: only the target fields the selection rule reads. */
type StubRun = { subject: { kind: string; id: string; os?: string; permissions?: string | null } }

/**
 * Identity-only selection fixtures: each context has one original source and no scored cells.
 * Composition and scoring are exercised through real run documents in the other cases below.
 */
function stubProjection(current: Record<string, StubRun>, history: Record<string, unknown[]> = {}): SelectedProjection {
  const table: Record<string, Record<string, import("@terminfo/probe-defs").ProbeStatus>> = {}
  const contexts: Record<string, unknown> = {}
  const originals: Record<string, unknown[]> = { ...history }
  for (const [key, run] of Object.entries(current)) {
    const runId = `run:${key}`
    originals[key] = [{ ...run, runId, measuredAt: "2026-10-01T00:00:00Z", suiteId: "fixture", suiteRelation: "tree" }]
    table[runId] = {}
    contexts[key] = {
      contextKey: key,
      subject: run.subject,
      catalogIds: [],
      cells: {},
      missingIds: [],
      contributingRunIds: [runId],
      attempts: [],
      counts: {},
      score: { supported: 0, all: 0 },
      complete: true,
    }
  }
  return { contexts, history: originals, versions: originals, table, exclusions: [] } as unknown as SelectedProjection
}

/** A v3 run reference is the published run without its results; the payload carries no historical fields. */
interface RunReference extends Omit<PublicVersion, "results"> {
  url: string
  documentSha256: string
}

function writeCatalog(content: string): void {
  writeFileSync(
    join(content, "terminals.json"),
    readFileSync(join(import.meta.dirname, "..", "content", "terminals.json")),
  )
}

/**
 * A features.json fixture that satisfies @terminfo/catalog's one shape. The selection consumers
 * these tests police read only the catalog ids, so the record fields are inert placeholders.
 */
function featureCatalog(...ids: string[]): string {
  return JSON.stringify(
    Object.fromEntries(
      ids.map((id) => [
        id,
        { name: id, slug: id.replaceAll(".", "-"), body: "fixture", probe: "fixture", baseline: "supported" },
      ]),
    ),
  )
}

/** Canonical consumers read a run's cited suite without requiring a release freeze pointer. */
function writeSuite(content: string, probeHash: string): void {
  mkdirSync(join(content, "suites"), { recursive: true })
  writeFileSync(
    join(content, "suites", `${probeHash}.json`),
    JSON.stringify({
      schemaVersion: 4 as const,
      probeHash,
      adapterVersion: "4.0.0",
      catalogIds: ["sgr.bold"],
      probes: { term: [], lib: [], mux: [] },
    }),
  )
}

describe("consumer selection", () => {
  it("refuses failed discovery and corrupt retained radar records without changing prior findings", () => {
    const root = mkdtempSync(join(tmpdir(), "terminfo-discovery-errors-"))
    const source = join(import.meta.dirname, "..")
    try {
      mkdirSync(join(root, "scripts"))
      mkdirSync(join(root, "content"))
      mkdirSync(join(root, "bin"))
      for (const name of ["explore.ts", "radar.ts"]) {
        copyFileSync(join(source, "scripts", name), join(root, "scripts", name))
      }
      const radarPath = join(root, "content", "radar.jsonl")
      const retained = JSON.stringify({
        id: "retained",
        type: "new-protocol",
        query_id: "prior",
        discovered: "2026-09-29",
      })
      const valid = `${retained}\n\n`
      writeFileSync(radarPath, valid)
      const bunShim = join(root, "bin", "bun")
      writeFileSync(bunShim, "#!/bin/sh\nexit 23\n")
      chmodSync(bunShim, 0o755)
      const invoke = (name: "explore" | "radar") => {
        const args = name === "explore" ? ["--query", "active-terminals"] : ["stats"]
        return spawnSync(process.execPath, [join(root, "scripts", `${name}.ts`), ...args], {
          encoding: "utf8",
          env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
        })
      }

      writeFileSync(radarPath, "\n  \n")
      const emptyRadar = invoke("radar")
      expect(emptyRadar.status, emptyRadar.stderr).toBe(0)
      expect(emptyRadar.stdout).toContain("no findings")
      writeFileSync(radarPath, valid)
      const validRadar = invoke("radar")
      expect(validRadar.status, validRadar.stderr).toBe(0)
      expect(validRadar.stdout).toContain("total      1")
      const failedQuery = invoke("explore")
      expect(failedQuery.stderr).toContain("Query failed")
      expect(failedQuery.status, failedQuery.stdout + failedQuery.stderr).toBe(1)
      expect(readFileSync(radarPath, "utf8")).toBe(valid)

      for (const bad of ["{", "[]", "{}"] as const) {
        const previous = `${valid}${bad}\n`
        writeFileSync(radarPath, previous)
        for (const name of ["radar", "explore"] as const) {
          const result = invoke(name)
          expect(result.status, `${name} ${bad}: ${result.stdout}${result.stderr}`).not.toBe(0)
          expect(result.stderr).toContain(`${radarPath}:3:`)
          expect(readFileSync(radarPath, "utf8")).toBe(previous)
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("tests freshness without changing inventory and retains current captures", () => {
    const root = mkdtempSync(join(tmpdir(), "terminfo-freshness-"))
    const source = join(import.meta.dirname, "..")
    try {
      mkdirSync(join(root, "scripts"))
      mkdirSync(join(root, "content"))
      copyFileSync(join(source, "scripts", "sitefile.ts"), join(root, "scripts", "sitefile.ts"))
      symlinkSync(join(source, "docs"), join(root, "docs"), "dir")
      symlinkSync(join(source, "node_modules"), join(root, "node_modules"), "dir")
      for (const dir of ["probes-apps", "probes-mux", "probes-libs"]) mkdirSync(join(root, "content", dir))
      writeCatalog(join(root, "content"))
      writeFileSync(join(root, "content", "features.json"), featureCatalog("sgr.bold"))
      writeSuite(join(root, "content"), "deadbeefcafe")
      // The archived refusals are required content since #30759 AC3; an empty list is a real state.
      writeFileSync(join(root, "content", "archived-exclusions.json"), JSON.stringify({ archivedExclusions: [] }))
      // A current unverified TODO capture remains a recorded run, not a support claim.
      const kittyManifestPath = join(root, "content", "suites", "deadbeefcafe.json")
      const kittyManifest = parseSuiteManifest(kittyManifestPath, readFileSync(kittyManifestPath, "utf8"))
      const kittyDraft = initializeRunDraft({
        runId: "unreviewed-kitty",
        sourceRevision: "a".repeat(40),
        manifest: { ...kittyManifest, schemaVersion: 4 },
        source: { kind: "live" },
        intendedSubject: { kind: "term", id: "kitty" },
      })
      kittyDraft.subject = {
        kind: "term",
        id: "kitty",
        version: "0.46.2",
        os: "linux",
        osVersion: null,
        outerTerminal: null,
        mux: null,
        config: null,
        permissions: null,
      }
      kittyDraft.identity = "unverified"
      kittyDraft.measuredAt = new Date().toISOString()
      kittyDraft.origin = { kind: "collector" }
      writeFileSync(
        join(root, "content", "probes-apps", "kitty-current-todo.json"),
        JSON.stringify(finalizeCollectedDraft(kittyDraft as Parameters<typeof finalizeCollectedDraft>[0])),
      )
      // A nonempty selected lib run exposes an inventory join that still compares old headless kinds.
      const libSubject = {
        kind: "lib" as const,
        id: "xtermjs",
        version: "6.0.0",
        os: "linux",
        osVersion: null,
        outerTerminal: null,
        mux: null,
        config: null,
        permissions: null,
      }
      const libMeasuredAt = new Date().toISOString()
      const libAttempt = { scope: "probe", startedAt: libMeasuredAt }
      // Retained measured runtime identity only; no old result is upgraded.
      const libFixture = {
        runtimeIdentity: {
          kind: "js",
          adapterVersion: "0.10.2",
          termlessRevision: "4b39770c169ec393cfd6ec7f59110e91c9c9d0c5",
          resolvedPath:
            "node_modules/.bun/@xterm+headless@6.0.0/node_modules/@xterm/headless/lib-headless/xterm-headless.js",
          integrity: {
            kind: "registry",
            lockIntegrity:
              "sha512-5Yj1QINYCyzrZtf8OFIHi47iQtI+0qYFPHmouEfG8dHNxbZ9Tb9YGSuLcsEwj9Z+OL75GJqPyJbyoFer80a2Hw==",
          },
          runtimeFormat: "js",
          engineVersion: "6.0.0",
        },
      }
      const libBytes = JSON.stringify({
        schemaVersion: 4,
        source: { kind: "live" },
        runId: "freshness-library-run",
        suiteId: "deadbeefcafe",
        probeHash: "deadbeefcafe",
        sourceRevision: "a".repeat(40),
        intendedSubject: libSubject,
        subject: libSubject,
        identity: "verified",
        runtimeIdentity: libFixture.runtimeIdentity,
        measuredAt: libMeasuredAt,
        origin: { kind: "collector" },
        rawReplies: { "sgr.bold": "retained fixture failure" },
        assertions: [],
        screenshotRefs: [],
        results: [
          {
            featureId: "sgr.bold",
            status: "test-failure",
            reason: "Fixture oracle failed",
            attempt: libAttempt,
            rawReplyRef: "sgr.bold",
            tests: [{ id: "criterion", status: "test-failure", attempt: libAttempt, reason: "Fixture oracle failed" }],
          },
        ],
      })
      writeFileSync(join(root, "content", "probes-libs", "xtermjs-current.json"), libBytes)
      const suitePath = join(root, "content", "suites", "deadbeefcafe.json")
      const libSuite = JSON.parse(readFileSync(suitePath, "utf8")) as {
        catalogIds?: string[]
        probes: { lib: string[] }
      }
      libSuite.catalogIds = ["sgr.bold"]
      libSuite.probes.lib = ["sgr.bold"]
      writeFileSync(suitePath, JSON.stringify(libSuite))
      const lock = join(root, "scripts", "sitefile.lock.json")
      const before = '{"unchanged":"a check does not regenerate inventory"}\n'
      writeFileSync(lock, before)
      const check = spawnSync(process.execPath, [join(root, "scripts", "sitefile.ts"), "--check"], { encoding: "utf8" })
      expect(check.stderr).toBe("")
      expect(check.status).toBe(1)
      expect(check.stdout).not.toContain("kitty — no reviewed current measurement")
      expect(readFileSync(lock, "utf8")).toBe(before)
      const generate = spawnSync(process.execPath, [join(root, "scripts", "sitefile.ts")], { encoding: "utf8" })
      expect(generate.stderr).toBe("")
      expect(generate.status).toBe(0)
      const inventory = JSON.parse(readFileSync(lock, "utf8")) as {
        sources: Array<{ lastChecked: string | null }>
        terminals: Array<{
          terminalId: string
          kind: string
          contextKey: string | null
          contributingRunIds: string[]
          sources: Array<{ runId: string; sha256: string; version: string; measuredAt: string }>
          lastProbedVersions: string[]
        }>
      }
      expect(inventory.sources.every((entry) => entry.lastChecked === null)).toBe(true)
      expect(inventory.terminals.find((entry) => entry.terminalId === "kitty")).toMatchObject({
        lastProbedVersions: ["0.46.2"],
        sources: [expect.objectContaining({ runId: "unreviewed-kitty", version: "0.46.2" })],
      })
      expect(inventory.terminals.find((entry) => entry.terminalId === "alacritty")).toMatchObject({ kind: "lib" })
      expect(inventory.terminals.find((entry) => entry.terminalId === "xtermjs")).toMatchObject({
        kind: "lib",
        contextKey: projectedContextKey(libSubject, 1),
        contributingRunIds: ["freshness-library-run"],
        sources: [
          expect.objectContaining({
            runId: "freshness-library-run",
            sha256: createHash("sha256").update(libBytes).digest("hex"),
            version: "6.0.0",
            measuredAt: libMeasuredAt,
          }),
        ],
        lastProbedVersions: ["6.0.0"],
      })
      // The refresh command must preserve its child check's failure status.
      copyFileSync(join(source, "scripts", "update.ts"), join(root, "scripts", "update.ts"))
      writeFileSync(join(root, "scripts", "radar.ts"), 'console.log("radar fixture completed")\n')
      writeFileSync(join(root, "scripts", "explore.ts"), 'console.log("explore fixture completed")\n')
      writeFileSync(
        join(root, "scripts", "watch-releases.ts"),
        `
        import { writeFileSync } from "node:fs"
        writeFileSync("${join(root, "watch-args.json")}", JSON.stringify(process.argv.slice(2)))
        console.log(JSON.stringify([{ terminal: "kitty", disposition: "no-reviewed-current" }]))
        if (process.env.WATCH_FAIL === "1") process.exitCode = 1
      `,
      )
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          scripts: {
            sitefile: "bun scripts/sitefile.ts",
            radar: "bun scripts/radar.ts",
            explore: "bun scripts/explore.ts",
            "watch-releases": "bun scripts/watch-releases.ts",
          },
        }),
      )
      const started = Date.now()
      const update = spawnSync(process.execPath, [join(root, "scripts", "update.ts"), "--status"], { encoding: "utf8" })
      const finished = Date.now()
      expect(update.stdout).toContain("radar fixture completed")
      expect(update.stdout).toContain("PASS\u001b[0m  release-watch")
      const watchArgs = JSON.parse(readFileSync(join(root, "watch-args.json"), "utf8")) as string[]
      expect(watchArgs.slice(0, 2)).toEqual(["--json", "--at"])
      const runAt = watchArgs[2]
      expect(runAt).toBeDefined()
      expect(new Date(runAt!).toISOString()).toBe(runAt)
      expect(Date.parse(runAt!)).toBeGreaterThanOrEqual(started)
      expect(Date.parse(runAt!)).toBeLessThanOrEqual(finished)
      expect(update.stdout).toContain("1 step(s) failed")
      expect(update.status).toBe(1)
      const discover = spawnSync(process.execPath, [join(root, "scripts", "update.ts"), "--discover"], {
        encoding: "utf8",
      })
      expect(discover.stdout).toContain("PASS\u001b[0m  release-watch")
      expect(discover.stdout).toContain("explore fixture completed")
      expect(discover.status).toBe(1)
      const failedFull = spawnSync(process.execPath, [join(root, "scripts", "update.ts"), "--full", "--no-pause"], {
        encoding: "utf8",
        env: { ...process.env, WATCH_FAIL: "1" },
      })
      expect(failedFull.status).toBe(1)
      expect(failedFull.stdout).toContain("FAIL\u001b[0m  release-watch")
      expect(failedFull.stdout).not.toContain("Re-probe headless backends")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // Exercises the site, the generator and the projection together; a correctness check, not a latency one.
  it("resolves every v3 run reference to a digest-verified run document", () => {
    const out = mkdtempSync(join(tmpdir(), "terminfo-api-run-parity-"))
    try {
      // Exercise real current run references; display fixtures deliberately carry no admission grant.
      const contentDir = join(import.meta.dirname, "..", "content")
      const { dataPath } = generateApi(out, { contentDir })
      const projection = loadCurrentResults(contentDir).projection
      const expected = publicResults(projection, compatibilitySubjects(projection, contentDir)).projection
      const v3 = JSON.parse(readFileSync(dataPath, "utf8")) as {
        contexts: Record<string, PublicContextSummary & { sources: Record<string, RunReference> }>
        versions: Record<string, RunReference[]>
        history: Record<string, RunReference[]>
        exclusions: unknown[]
      }
      const assertGroup = (
        actual: Record<string, RunReference> | Record<string, RunReference[]>,
        // The expected side is the published projection itself: it has no url/documentSha256 yet.
        expectedGroup: Record<string, PublicVersion> | Record<string, PublicVersion[]>,
      ) => {
        expect(Object.keys(actual).sort()).toEqual(Object.keys(expectedGroup).sort())
        for (const [key, expectedValue] of Object.entries(expectedGroup)) {
          const actualValue = actual[key]
          const expectedVersions = Array.isArray(expectedValue) ? expectedValue : [expectedValue]
          const actualVersions = Array.isArray(actualValue) ? actualValue : [actualValue]
          expect(actualVersions).toHaveLength(expectedVersions.length)
          expectedVersions.forEach((version, index) => {
            const ref = actualVersions[index]
            if (!ref) throw new Error(`Missing run reference for ${version.runId}`)
            expect(ref).toMatchObject({
              runId: version.runId,
              subject: version.subject,
              measuredAt: version.measuredAt,
              suiteId: version.suiteId,
              probeHash: version.probeHash,
              suiteFreshness: version.suiteFreshness,
              sourceRevision: version.sourceRevision,
              sha256: version.sha256,
              counts: version.counts,
              url: `/api/v3/runs/${version.sha256}.json`,
            })
            const bytes = readFileSync(join(out, ref.url))
            expect(createHash("sha256").update(bytes).digest("hex")).toBe(ref.documentSha256)
            expect(JSON.parse(bytes.toString("utf8"))).toEqual(version)
          })
        }
      }
      expect(Object.keys(v3.contexts).sort()).toEqual(Object.keys(expected.contexts).sort())
      for (const [key, context] of Object.entries(expected.contexts)) {
        const actual = v3.contexts[key]
        expect(actual).toBeDefined()
        expect(actual?.cells).toEqual(context.cells)
        assertGroup(
          actual!.sources,
          Object.fromEntries(
            context.contributingRunIds.map((runId) => {
              const original = Object.values(expected.history)
                .flat()
                .find((run) => run.runId === runId)
              if (!original) throw new Error(`Missing original run ${runId}`)
              return [runId, original]
            }),
          ),
        )
      }
      assertGroup(v3.versions, expected.versions)
      assertGroup(v3.history, expected.history)
      expect(v3.exclusions).toEqual(expected.exclusions)
      expect(Object.keys(v3.contexts).length).toBeGreaterThan(0)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  }, 30_000)

  // @cto f71ed475: v1 is frozen bytes committed under docs/public/api/v1, not generator output.
  it("keeps the frozen v1 data and badge bytes on disk", () => {
    const v1Dir = join(import.meta.dirname, "..", "docs", "public", "api", "v1")
    const data = JSON.parse(readFileSync(join(v1Dir, "data.json"), "utf8")) as {
      version: number
      terminals: Record<string, { name: string }>
      results: Record<string, unknown>
    }
    expect(data.version).toBe(1)
    expect(Object.keys(data.terminals).length).toBeGreaterThan(0)
    expect(Object.keys(data.results).sort()).toEqual(Object.keys(data.terminals).sort())
    const badges = readdirSync(join(v1Dir, "badges")).filter((name) => name.endsWith(".svg"))
    // The set is frozen with the data: 14 released badges, one per released slug.
    expect(badges.length).toBe(14)
    for (const slug of Object.keys(data.terminals)) {
      expect(badges).toContain(`${slug}.svg`)
    }
    for (const badge of badges) {
      expect(readFileSync(join(v1Dir, "badges", badge), "utf8")).toContain("<svg")
    }
  })

  it("refuses a malformed required result with its path", () => {
    const content = mkdtempSync(join(tmpdir(), "terminfo-malformed-selection-"))
    try {
      writeFileSync(join(content, "features.json"), featureCatalog("sgr.bold"))
      writeSuite(content, "deadbeefcafe")
      for (const dir of ["probes-apps", "probes-mux", "probes-libs"]) mkdirSync(join(content, dir))
      writeFileSync(join(content, "probes-apps", "bad.json"), "{")
      expect(() => loadCurrentResults(content)).toThrow(/bad\.json: invalid JSON/)
    } finally {
      rmSync(content, { recursive: true, force: true })
    }
  })

  it("requires a reviewed default row for two exact contexts of one terminal", () => {
    const mac = { subject: { kind: "term", id: "kitty", os: "macos" } }
    const linux = { subject: { kind: "term", id: "kitty", os: "linux" } }
    const macKey = projectedContextKey(
      {
        kind: "term",
        id: "kitty",
        version: "0.48.2",
        os: "macos",
        osVersion: "26.6.2",
        outerTerminal: null,
        mux: null,
        config: null,
        permissions: null,
      },
      2,
    )
    const linuxKey = projectedContextKey(
      {
        kind: "term",
        id: "kitty",
        version: "0.49.2",
        os: "linux",
        osVersion: "7.0.0-34-generic",
        outerTerminal: null,
        mux: null,
        config: "/nix/store/kitty/bin/kitty",
        permissions: null,
      },
      2,
    )
    const projection = stubProjection({ [macKey]: mac, [linuxKey]: linux })
    const content = mkdtempSync(join(tmpdir(), "terminfo-context-selection-"))
    try {
      writeCatalog(content)
      expect(() => compatibilitySubjects(projection, content)).toThrow(/Ambiguous current term:kitty/)
      writeFileSync(
        join(content, "default-contexts.json"),
        JSON.stringify({
          defaultContext: {
            "term:kitty": {
              contextKey: linuxKey,
              reviewer: "reviewer",
              reason: "controlled Linux context selected for default view",
              sources: ["review://linux"],
            },
          },
        }),
      )
      expect(compatibilitySubjects(projection, content).get("kitty")?.contextKey).toBe(linuxKey)
    } finally {
      rmSync(content, { recursive: true, force: true })
    }
  })

  it("keeps same-named app and headless runs in distinct compatibility rows", () => {
    const app = { subject: { kind: "term", id: "kitty" } }
    const headless = { subject: { kind: "lib", id: "kitty" } }
    const library = { subject: { kind: "lib", id: "xtermjs" } }
    const projection = stubProjection(
      { "term:kitty": app, "lib:kitty": headless, "lib:xtermjs": library },
      { "term:kitty": [app], "lib:kitty": [headless], "lib:xtermjs": [library] },
    )
    const content = mkdtempSync(join(tmpdir(), "terminfo-kind-selection-"))
    try {
      writeCatalog(content)
      const rows = compatibilitySubjects(projection, content)
      expect(rows.get("kitty")?.selected.subject?.kind).toBe("term")
      expect(rows.get("headless-kitty")?.selected.subject?.kind).toBe("lib")
      expect(rows.get("xtermjs")?.selected.subject?.kind).toBe("lib")
      delete projection.contexts["term:kitty"]
      expect(compatibilitySubjects(projection, content).get("headless-kitty")?.contextKey).toBe("lib:kitty")
    } finally {
      rmSync(content, { recursive: true, force: true })
    }
  })

  it("keeps released headless keys when same-id app runs arrive", () => {
    const headlessWezterm = { subject: { kind: "lib", id: "wezterm" } }
    const appWezterm = { subject: { kind: "term", id: "wezterm" } }
    const headlessAlacritty = { subject: { kind: "lib", id: "alacritty" } }
    const appAlacritty = { subject: { kind: "term", id: "alacritty" } }
    const projection = stubProjection({
      "headless:wezterm": headlessWezterm,
      "app:wezterm": appWezterm,
      "headless:alacritty": headlessAlacritty,
      "app:alacritty": appAlacritty,
    })
    const content = mkdtempSync(join(tmpdir(), "terminfo-released-keys-"))
    try {
      writeCatalog(content)
      const rows = compatibilitySubjects(projection, content)
      expect(rows.get("wezterm")?.selected.subject?.kind).toBe("lib")
      expect(rows.get("app-wezterm")?.selected.subject?.kind).toBe("term")
      expect(rows.get("alacritty")?.selected.subject?.kind).toBe("lib")
      expect(rows.get("app-alacritty")?.selected.subject?.kind).toBe("term")
      delete projection.contexts["headless:wezterm"]
      expect(compatibilitySubjects(projection, content).get("app-wezterm")?.contextKey).toBe("app:wezterm")
    } finally {
      rmSync(content, { recursive: true, force: true })
    }
  })

  it("refuses a catalog edit that would change a released v1 key's meaning", () => {
    const content = mkdtempSync(join(tmpdir(), "terminfo-released-rename-"))
    try {
      writeCatalog(content)
      const catalog = JSON.parse(readFileSync(join(content, "terminals.json"), "utf8")) as Record<
        string,
        { headlessBackends: string[] }
      >
      const wezterm = catalog.wezterm
      if (!wezterm) throw new Error("Fixture lacks WezTerm")
      wezterm.headlessBackends = []
      writeFileSync(join(content, "terminals.json"), JSON.stringify(catalog))
      const projection = stubProjection({})
      expect(() => compatibilitySubjects(projection, content)).toThrow(/released key wezterm changed meaning from lib/)
    } finally {
      rmSync(content, { recursive: true, force: true })
    }
  })

  it("names the declared xterm app run as a compatibility target", () => {
    const appXterm = { subject: { kind: "term", id: "xterm" } }
    const projection = stubProjection({ "term:xterm": appXterm })
    const content = mkdtempSync(join(tmpdir(), "terminfo-xterm-target-"))
    try {
      writeCatalog(content)
      const rows = compatibilitySubjects(projection, content)
      expect(rows.get("xterm")?.contextKey).toBe("term:xterm")
      expect(rows.get("xterm")?.selected.subject?.kind).toBe("term")
    } finally {
      // raw-delete-allow: standalone component repository whose CI installs without hh's workspace, so removely is unavailable; content is this test's own mkdtemp scratch root
      rmSync(content, { recursive: true, force: true })
    }
  })
})
