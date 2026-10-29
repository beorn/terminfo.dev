/**
 * @failure Status counts unverified legacy booleans as current and silently skips corrupt saved runs.
 * @level l2
 * @consumer Admin CLI status readers comparing reviewed runs with saved archives.
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { probeSuiteSnapshot } from "../versions.ts"
import { loadCurrentResults } from "../../../docs/data/current-results.ts"

test("status separates reviewed current runs from newer legacy files and refuses malformed archives", () => {
  const source = join(import.meta.dirname, "..", "..", "..")
  const root = mkdtempSync(join(tmpdir(), "terminfo-status-"))
  try {
    const admin = join(root, "packages", "admin")
    mkdirSync(join(admin, "src"), { recursive: true })
    mkdirSync(join(root, "content", "probes-apps"), { recursive: true })
    mkdirSync(join(root, "content", "probes-libs"))
    mkdirSync(join(root, "content", "probes-mux"))
    mkdirSync(join(root, "content", "suites"))
    // The published exclusion list is archived data since #30759 AC3; these fixtures hold no
    // legacy refusals, so the archive is present and empty rather than absent.
    writeFileSync(join(root, "content", "archived-exclusions.json"), JSON.stringify({ archivedExclusions: [] }))
    copyFileSync(join(source, "packages", "admin", "src", "status.ts"), join(admin, "src", "status.ts"))
    symlinkSync(join(source, "packages", "admin", "versions.ts"), join(admin, "versions.ts"))
    symlinkSync(join(source, "packages", "admin", "parse.ts"), join(admin, "parse.ts"))
    symlinkSync(join(source, "packages", "admin", "node_modules"), join(admin, "node_modules"), "dir")
    symlinkSync(join(source, "packages", "terminfo.dev"), join(root, "packages", "terminfo.dev"), "dir")
    symlinkSync(join(source, "node_modules"), join(root, "node_modules"), "dir")
    symlinkSync(join(source, "docs"), join(root, "docs"), "dir")
    writeFileSync(
      join(root, "run.ts"),
      'import { handleStatus } from "./packages/admin/src/status.ts"; await handleStatus()\n',
    )

    const snapshot = probeSuiteSnapshot()
    // A small synthetic suite exercises the real selection/status boundary, not collector suite coverage.
    const fixtureFeatures = ["extensions.query", "cursor.position"]
    writeFileSync(
      join(root, "content", "features.json"),
      // @terminfo/catalog's one shape requires a full record per row; this fixture only reads the ids.
      JSON.stringify(
        Object.fromEntries(
          fixtureFeatures.map((id) => [
            id,
            { name: id, slug: id.replaceAll(".", "-"), body: "fixture", probe: "fixture", baseline: "supported" },
          ]),
        ),
      ),
    )
    writeFileSync(
      join(root, "content", "suites", `${snapshot.probeHash}.json`),
      JSON.stringify({
        schemaVersion: 4 as const,
        probeHash: snapshot.probeHash,
        sourceRevision: "1".repeat(40),
        generatedAt: "2026-09-28T00:00:00.000Z",
        freeze: { release: "candidate2", at: "2026-09-28T00:00:00.000Z" },
        adapterVersion: snapshot.adapterVersion,
        catalogIds: fixtureFeatures,
        probes: { term: ["extensions.query"], lib: ["extensions.query"], mux: ["extensions.query"] },
      }),
    )
    const run = {
      source: { kind: "live" },
      schemaVersion: 4,
      sealedAt: "2026-09-28T12:00:01.000Z",
      intendedSubject: { kind: "term", id: "kitty", version: "0.46.2" },
      runId: "reviewed-kitty",
      subject: {
        kind: "term",
        id: "kitty",
        version: "0.46.2",
        os: "macos",
        osVersion: "25.4.0",
        outerTerminal: null,
        mux: null,
        config: null,
        permissions: null,
      },
      identity: "verified",
      suiteId: snapshot.probeHash,
      probeHash: snapshot.probeHash,
      sourceRevision: "2".repeat(40),
      measuredAt: "2026-09-28T12:00:00.000Z",
      origin: { kind: "collector" },
      rawReplies: { "device.primary-da": "\x1b[?62;52;c", "device.xtversion": "kitty(0.46.2)" },
      assertions: [],
      screenshotRefs: [],
      results: [
        {
          featureId: "extensions.query",
          status: "test-failure",
          attempt: { scope: "probe", startedAt: "2026-09-28T12:00:00.000Z" },
          tests: [
            {
              id: "criterion",
              status: "test-failure",
              attempt: { scope: "probe", startedAt: "2026-09-28T12:00:00.000Z" },
              reason: "Query timed out",
            },
          ],
          reason: "Query timed out",
        },
        {
          featureId: "cursor.position",
          status: "test-todo",
          attempt: { scope: "none" },
          tests: [],
          reason: "Missing implementation",
        },
      ],
    }
    const runPath = join(root, "content", "probes-apps", "reviewed.json")
    const runBytes = JSON.stringify(run)
    writeFileSync(runPath, runBytes)
    writeFileSync(
      join(root, "content", "interpretations.json"),
      JSON.stringify([
        {
          id: "review-kitty",
          runId: run.runId,
          runSha256: createHash("sha256").update(runBytes).digest("hex"),
          reviewer: "reviewer",
          reason: "checked captured identity",
          scope: {
            subject: { kind: "term", id: "kitty" },
            versions: [run.subject.version, run.subject.version],
            suites: [run.suiteId, run.suiteId],
          },
          sources: [runPath],
          supersedes: [],
          verifiesIdentity: true,
          reviewed: true,
        },
      ]),
    )
    writeFileSync(
      join(root, "content", "probes-libs", "newer-unverified.json"),
      JSON.stringify({
        backend: "kitty",
        version: "9.9.9",
        generated: "2027-01-01T00:00:00.000Z",
        results: { "extensions.query": true, "cursor.position": false },
      }),
    )

    const projection = loadCurrentResults(join(root, "content")).projection
    expect(projection.contexts["term:kitty"], JSON.stringify(projection.exclusions)).toBeDefined()
    expect(projection.contexts["term:kitty"]?.counts).toEqual({
      supported: 0,
      unsupported: 0,
      untestable: 0,
      "test-todo": 1,
      "test-failure": 1,
    })

    const invoke = () =>
      spawnSync(process.execPath, [join(root, "run.ts")], { cwd: root, encoding: "utf8", timeout: 15_000 })
    const selected = invoke()
    expect(selected.error).toBeUndefined()
    expect(selected.status, selected.stdout + selected.stderr).toBe(0)
    expect(selected.stdout).toContain("reviewed-kitty")
    expect(selected.stdout).toContain("1 TEST TODO")
    expect(selected.stdout).toContain("1 TEST FAILURE")
    expect(selected.stdout).toContain("0/2 Supported / all")
    expect(selected.stdout).not.toContain("9.9.9")
    expect(selected.stdout).toContain("Archive libs: 1")

    const corruptPath = join(root, "content", "probes-libs", "corrupt.json")
    writeFileSync(corruptPath, "{")
    const corrupt = invoke()
    expect(corrupt.error).toBeUndefined()
    expect(corrupt.status, corrupt.stdout + corrupt.stderr).not.toBe(0)
    expect(corrupt.stdout + corrupt.stderr).toContain(corruptPath)

    rmSync(corruptPath)
    const catalogPath = join(root, "content", "features.json")
    writeFileSync(catalogPath, "{")
    const badCatalog = invoke()
    expect(badCatalog.error).toBeUndefined()
    expect(badCatalog.status, badCatalog.stdout + badCatalog.stderr).not.toBe(0)
    expect(badCatalog.stdout + badCatalog.stderr).toContain(catalogPath)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
