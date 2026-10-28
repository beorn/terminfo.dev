/**
 * Lay out a throwaway repository root that runs the real `terminfo report` command,
 * so the test reads the same copy → select → render → stdout path a piped run does.
 */
function stageRepo(root: string): void {
  const source = join(import.meta.dirname, "..", "..", "..")
  const admin = join(root, "packages", "admin")
  mkdirSync(join(admin, "src"), { recursive: true })
  mkdirSync(join(root, "content", "probes-apps"), { recursive: true })
  mkdirSync(join(root, "content", "probes-libs"))
  mkdirSync(join(root, "content", "probes-mux"))
  mkdirSync(join(root, "content", "suites"))
  // The published exclusion list is archived data since #30759 AC3; these fixtures hold no
  // legacy refusals, so the archive is present and empty rather than absent.
  writeFileSync(join(root, "content", "archived-exclusions.json"), JSON.stringify({ archivedExclusions: [] }))
  copyFileSync(join(source, "packages", "admin", "src", "report.ts"), join(admin, "src", "report.ts"))
  copyFileSync(join(source, "packages", "admin", "report.tsx"), join(admin, "report.tsx"))
  symlinkSync(join(source, "packages", "admin", "versions.ts"), join(admin, "versions.ts"))
  symlinkSync(join(source, "packages", "admin", "parse.ts"), join(admin, "parse.ts"))
  symlinkSync(join(source, "packages", "admin", "suite-manifest.ts"), join(admin, "suite-manifest.ts"))
  symlinkSync(join(source, "packages", "admin", "node_modules"), join(admin, "node_modules"), "dir")
  symlinkSync(join(source, "node_modules"), join(root, "node_modules"), "dir")
  symlinkSync(join(source, "docs"), join(root, "docs"), "dir")
  writeFileSync(
    join(root, "run.ts"),
    'import { handleReport } from "./packages/admin/src/report.ts"; await handleReport()\n',
  )
}

/**
 * @failure Report promotes newer unverified booleans and renders absent cells as unsupported.
 * @level l2
 * @consumer Admin CLI report readers comparing selected terminal observations.
 * @testonly none
 */
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { probeSuiteSnapshot } from "../versions.ts"
import { loadCurrentResults } from "../../../docs/data/current-results.ts"
import { parseSuiteManifest } from "@terminfo/run-parser"
import { ENVIRONMENT_GROUP_IDS } from "@terminfo/probe-defs"

test("report renders reviewed outcomes and missing cells without promoting legacy history", () => {
  const root = mkdtempSync(join(tmpdir(), "terminfo-report-"))
  try {
    stageRepo(root)

    const snapshot = probeSuiteSnapshot()
    // A small synthetic suite exercises the real selection/report boundary, not collector suite coverage.
    const measuredFeatures = ["cursor.position", "sgr.bold", "extensions.query", "modes.autowrap", "sgr.italic"]
    const fixtureFeatures = [...measuredFeatures, ...ENVIRONMENT_GROUP_IDS]
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
        probes: {
          term: fixtureFeatures.slice(0, 4),
          lib: fixtureFeatures.slice(0, 4),
          mux: fixtureFeatures.slice(0, 4),
        },
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
      rawReplies: {
        "device.primary-da": "\x1b[?62;52;c",
        "device.xtversion": "kitty(0.46.2)",
        "cursor.position": "measured-cursor",
        "sgr.bold": "measured-style",
      },
      assertions: [
        {
          featureId: "cursor.position",
          assertionType: "buffer_state",
          kind: "positive",
          rawReplyRef: "cursor.position",
          expected: "x=2",
          observed: '{"x":2}',
        },
        {
          featureId: "sgr.bold",
          assertionType: "buffer_state",
          kind: "negative",
          rawReplyRef: "sgr.bold",
          expected: "bold=true",
          observed: '{"bold":false}',
        },
      ],
      screenshotRefs: [],
      results: fixtureFeatures.map((featureId, index) => {
        const attempt = { scope: "probe", startedAt: "2026-09-28T12:00:00.000Z" }
        const status =
          index >= measuredFeatures.length
            ? "test-todo"
            : index === 0
              ? "supported"
              : index === 1
                ? "unsupported"
                : index === 4
                  ? "test-todo"
                  : "test-failure"
        return {
          featureId,
          status,
          attempt: status === "test-todo" ? { scope: "none" } : attempt,
          tests:
            status === "test-todo"
              ? []
              : [
                  {
                    id: "criterion",
                    status,
                    attempt,
                    ...(index < 2 && { assertionRefs: [index], rawReplyRef: featureId }),
                  },
                ],
          ...(index < 2 && { assertionType: "buffer_state", rawReplyRef: featureId }),
          ...(index === 2 && { reason: "timeout" }),
          ...(index === 3 && { reason: "collector-error" }),
          ...(index >= 4 && { reason: "Missing implementation" }),
        }
      }),
    }
    const runPath = join(root, "content", "probes-apps", "reviewed.json")
    const runBytes = JSON.stringify(run)
    writeFileSync(runPath, runBytes)
    const inconclusiveRun = {
      ...run,
      runId: "reviewed-kitty-inconclusive",
      subject: { ...run.subject, config: "isolated" },
      measuredAt: "2026-09-28T13:00:00.000Z",
      rawReplies: { "device.primary-da": "\x1b[?62;52;c", "device.xtversion": "kitty(0.46.2)" },
      assertions: [],
      results: run.results.map(({ featureId }) => ({
        featureId,
        status: "test-todo",
        attempt: { scope: "none" },
        tests: [],
        reason: "Missing implementation",
      })),
    }
    const inconclusivePath = join(root, "content", "probes-apps", "inconclusive.json")
    const inconclusiveBytes = JSON.stringify(inconclusiveRun)
    writeFileSync(inconclusivePath, inconclusiveBytes)
    const review = (id: string, runId: string, bytes: string, sourcePath: string) => ({
      id,
      runId,
      runSha256: createHash("sha256").update(bytes).digest("hex"),
      reviewer: "reviewer",
      reason: "checked captured identity",
      scope: {
        subject: { kind: "term", id: "kitty" },
        versions: [run.subject.version, run.subject.version],
        suites: [run.suiteId, run.suiteId],
      },
      sources: [sourcePath],
      supersedes: [],
      verifiesIdentity: true,
      reviewed: true,
    })
    writeFileSync(
      join(root, "content", "interpretations.json"),
      JSON.stringify([
        review("review-kitty", run.runId, runBytes, runPath),
        review("review-kitty-inconclusive", inconclusiveRun.runId, inconclusiveBytes, inconclusivePath),
      ]),
    )
    writeFileSync(
      join(root, "content", "probes-libs", "newer-unverified.json"),
      JSON.stringify({
        backend: "kitty",
        version: "9.9.9",
        generated: "2027-01-01T00:00:00.000Z",
        results: { "cursor.position": true, "sgr.italic": false },
      }),
    )

    const projection = loadCurrentResults(join(root, "content")).projection
    const reviewed = Object.values(projection.current).find((selected) => selected.runId === run.runId)
    expect(reviewed, JSON.stringify(projection.exclusions)).toBeDefined()
    expect(Object.values(projection.current).map((selected) => selected.runId)).toContain(inconclusiveRun.runId)
    expect(reviewed?.counts).toEqual({ supported: 1, unsupported: 1, untestable: 0, "test-todo": 1, "test-failure": 2 })

    const invoke = () =>
      spawnSync(process.execPath, [join(root, "run.ts")], { cwd: root, encoding: "utf8", timeout: 15_000 })
    const selected = invoke()
    expect(selected.error).toBeUndefined()
    expect(selected.status, selected.stdout + selected.stderr).toBe(0)
    const plain = selected.stdout.replace(/\x1b\[[0-9;]*m/g, "")
    const contexts = [...plain.matchAll(/(C\d+): term:kitty 0\.46\.2 — run (reviewed-kitty(?:-inconclusive)?)/g)]
    expect(contexts).toHaveLength(2)
    const labelFor = (runId: string) => contexts.find((match) => match[2] === runId)?.[1]
    const normal = labelFor("reviewed-kitty")
    const allInconclusive = labelFor("reviewed-kitty-inconclusive")
    expect(normal).toBeDefined()
    expect(allInconclusive).toBeDefined()
    expect(normal).not.toBe(allInconclusive)
    const matrix = plain.split("Feature comparison")[1]?.split("Observation reasons and notes")[0]
    expect(matrix).toBeDefined()
    expect(matrix).toContain("YES Supported · NO Unsupported · UNTEST Untestable · TODO TEST TODO · FAIL TEST FAILURE")
    const labels = contexts.map((match) => match[1])
    const stateRow = (id: string) => {
      const line = matrix?.split("\n").find((row) => row.trimStart().startsWith(id))
      expect(line, `missing matrix row ${id}`).toBeDefined()
      const tokens = line?.match(/\b(?:YES|NO|UNTEST|TODO|FAIL)\b/g)
      expect(tokens, `states for ${id}`).toHaveLength(2)
      return Object.fromEntries(labels.map((label, index) => [label, tokens?.[index]]))
    }
    expect(stateRow("cursor.position")).toMatchObject({ [normal!]: "YES", [allInconclusive!]: "TODO" })
    expect(stateRow("sgr.bold")).toMatchObject({ [normal!]: "NO", [allInconclusive!]: "TODO" })
    expect(stateRow("extensions.query")).toMatchObject({ [normal!]: "FAIL", [allInconclusive!]: "TODO" })
    expect(stateRow("modes.autowrap")).toMatchObject({ [normal!]: "FAIL", [allInconclusive!]: "TODO" })
    expect(stateRow("sgr.italic")).toMatchObject({ [normal!]: "TODO", [allInconclusive!]: "TODO" })
    expect(plain).toContain(`${normal} extensions.query: timeout`)
    expect(plain).toContain(`${normal} modes.autowrap: collector-error`)
    expect(plain).toContain("1/5 Supported / all (20%)")
    expect(plain).toContain("0/5 Supported / all (0%)")
    expect(plain).not.toContain("NaN")
    expect(plain).toContain("Excluded runs:")
    expect(plain).not.toContain("9.9.9")

    // AC1/2/3: the existing selected-only report cannot show a private capture or absent contexts.
    // Use the same real reader/CLI fixture, without adding a test-only production seam.
    copyFileSync(join(import.meta.dirname, "../../../content/terminals.json"), join(root, "content/terminals.json"))
    const draftPath = join(root, "baseline.draft.json")
    const { sealedAt: _sealedAt, ...captured } = run
    writeFileSync(draftPath, JSON.stringify({ ...captured, runId: "baseline-kitty", identity: "unverified" }))
    execFileSync("git", ["init", "-q", root])
    execFileSync("git", ["-C", root, "add", "content"])
    execFileSync("git", [
      "-C",
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "report inputs",
    ])
    writeFileSync(
      join(root, "run.ts"),
      'import { handleReport } from "./packages/admin/src/report.ts"; await handleReport({ scoreboard: process.argv.slice(2) })\n',
    )
    const baseline = () =>
      spawnSync(process.execPath, [join(root, "run.ts"), draftPath], { cwd: root, encoding: "utf8", timeout: 15_000 })
    const first = baseline()
    expect(first.status, first.stderr).toBe(0)
    expect(first.stdout).toContain("Not a pass, not an admission")
    expect(first.stdout).toContain("kitty/macos | measured-unpublished")
    expect(first.stdout).toContain("baseline/unreviewed")
    expect(first.stdout).toContain("no pass")
    expect(first.stdout).toContain("baseline-kitty")
    expect(first.stdout).toContain(run.probeHash)
    expect(first.stdout).toContain(run.sourceRevision)
    expect(first.stdout).toContain(createHash("sha256").update(readFileSync(draftPath)).digest("hex"))
    expect(first.stdout).toContain("ghostty/linux | to-measure")
    expect(first.stdout).toContain("origin/live absent")
    expect(baseline().stdout).toBe(first.stdout)
    expect(JSON.parse(readFileSync(draftPath, "utf8"))).toMatchObject({ identity: "unverified" })

    // AC1/3: immutable pass records, rather than raw captures, own freeze ordering and deferrals.
    // The earlier raw journey cannot detect loss of the batch's carried route or pass identity.
    const newerSuite = "aaaaaaaaaaaa"
    const suitePath = join(root, "content", "suites", `${snapshot.probeHash}.json`)
    const manifest = parseSuiteManifest(suitePath, readFileSync(suitePath, "utf8"))
    writeFileSync(
      join(root, "content", "suites", `${newerSuite}.json`),
      JSON.stringify({
        ...manifest,
        probeHash: newerSuite,
        freeze: { release: "next-candidate", at: "2026-09-29T00:00:00.000Z" },
      }),
    )
    const nextDraft = join(root, "next.draft.json")
    writeFileSync(
      nextDraft,
      JSON.stringify({
        ...captured,
        runId: "next-kitty",
        identity: "unverified",
        suiteId: newerSuite,
        probeHash: newerSuite,
      }),
    )
    const passPath = (
      name: string,
      suite: string,
      rawRun: string,
      deferrals: unknown[],
      context = { kind: "term", id: "kitty", os: "macos" },
      admittedPath?: string,
    ) => {
      const directory = join(root, name)
      mkdirSync(directory)
      const path = join(directory, "pass.json")
      writeFileSync(
        path,
        JSON.stringify({
          mode: "admit",
          freeze: { id: suite, release: suite === newerSuite ? "next-candidate" : "candidate2", deferrals },
          directory,
          probeHash: suite,
          sourceRevision: run.sourceRevision,
          inputSha256: {},
          catalogIds: fixtureFeatures,
          complete: false,
          errors: [],
          contexts: [
            {
              context,
              status: admittedPath ? "admitted" : "classified",
              rawRun,
              ...(admittedPath && { admittedPath }),
            },
            { context: { kind: "term", id: "ghostty", os: "linux" }, status: "not-started" },
          ],
        }),
      )
      return path
    }
    const olderPass = passPath("older-pass", snapshot.probeHash, draftPath, [])
    const newerPass = passPath("newer-pass", newerSuite, nextDraft, [
      {
        context: "ghostty/linux",
        routeIssue: "@si/terminfo/hosted-route",
        reason: "hosted runner follow-up",
      },
    ])
    const passes = spawnSync(process.execPath, [join(root, "run.ts"), newerPass, olderPass], {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
    })
    expect(passes.status, passes.stderr).toBe(0)
    const kittyRow = passes.stdout.split("\n").find((line) => line.startsWith("| kitty/macos |"))
    expect(kittyRow).toContain(`| measured-unpublished | ${newerSuite}`)
    expect(kittyRow).toContain("next-kitty")
    expect(kittyRow).toContain(`earlier pass ${snapshot.probeHash}`)
    expect(passes.stdout).toContain("ghostty/linux | deferred")
    expect(passes.stdout).toContain("hosted runner follow-up")
    expect(passes.stdout).toContain("@si/terminfo/hosted-route")
    expect(passes.stdout).toContain("selected at")
    expect(passes.stdout).toContain("live unproven")
    expect(passes.stdout).not.toContain("| published |")

    // AC1/4: a pass's path reference cannot transfer one terminal's measurement to another context.
    const misroutedPass = passPath("misrouted-pass", newerSuite, nextDraft, [], {
      kind: "term",
      id: "ghostty",
      os: "macos",
    })
    const misrouted = spawnSync(process.execPath, [join(root, "run.ts"), misroutedPass], {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
    })
    expect(misrouted.status, misrouted.stderr).toBe(0)
    const misroutedRow = misrouted.stdout.split("\n").find((line) => line.startsWith("| ghostty/macos |"))
    expect(misroutedRow).toContain("measured-unpublished")
    expect(misroutedRow).toContain("not validated")
    expect(misroutedRow).toContain("declared ghostty/macos; recorded kitty/macos")

    // AC3: a live source marker alone is insufficient. Publication needs the selected content revision.
    const completeRun = {
      ...run,
      rawReplies: { ...run.rawReplies, ...Object.fromEntries(measuredFeatures.map((id) => [id, '{"value":true}'])) },
      assertions: measuredFeatures.map((featureId) => ({
        featureId,
        assertionType: "buffer_state",
        kind: "positive",
        rawReplyRef: featureId,
        expected: "value=true",
        observed: '{"value":true}',
      })),
      results: fixtureFeatures.map((featureId, index) =>
        index >= measuredFeatures.length
          ? run.results[index]!
          : {
              featureId,
              status: "supported",
              assertionType: "buffer_state",
              rawReplyRef: featureId,
              attempt: { scope: "probe", startedAt: run.measuredAt },
              tests: [
                {
                  id: "criterion",
                  status: "supported",
                  assertionRefs: [index],
                  rawReplyRef: featureId,
                  attempt: { scope: "probe", startedAt: run.measuredAt },
                },
              ],
            },
      ),
    }
    const completeBytes = JSON.stringify(completeRun)
    writeFileSync(runPath, completeBytes)
    const completeIsolated = { ...completeRun, runId: inconclusiveRun.runId, subject: inconclusiveRun.subject }
    const isolatedBytes = JSON.stringify(completeIsolated)
    writeFileSync(inconclusivePath, isolatedBytes)
    const interpretationsPath = join(root, "content", "interpretations.json")
    writeFileSync(
      interpretationsPath,
      JSON.stringify([
        review("review-kitty", completeRun.runId, completeBytes, runPath),
        review("review-kitty-inconclusive", completeIsolated.runId, isolatedBytes, inconclusivePath),
      ]),
    )
    execFileSync("git", ["-C", root, "add", "content"])
    execFileSync("git", [
      "-C",
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "selected content",
    ])
    execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/live", "HEAD"])
    const scoreboard = () =>
      spawnSync(process.execPath, [join(root, "run.ts")], { cwd: root, encoding: "utf8", timeout: 15_000 })
    const published = scoreboard()
    expect(published.status, published.stderr).toBe(0)
    expect(published.stdout).toContain("kitty/macos | published")
    expect(published.stdout).toContain("graded 5: supported=5")
    // A real pass points to both its private capture and the admitted selected bytes; neither path is synthesized.
    const admittedDraftPath = join(root, "admitted-capture.draft.json")
    const { sealedAt: _admittedSeal, ...admittedDraft } = completeRun
    writeFileSync(admittedDraftPath, JSON.stringify(admittedDraft))
    const admittedPass = passPath("admitted-pass", snapshot.probeHash, admittedDraftPath, [], undefined, runPath)
    const admittedReport = spawnSync(process.execPath, [join(root, "run.ts"), admittedPass], {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
    })
    expect(admittedReport.status, admittedReport.stderr).toBe(0)
    const admittedRow = admittedReport.stdout.split("\n").find((line) => line.startsWith("| kitty/macos |"))
    expect(admittedRow).toContain(`| published | ${snapshot.probeHash}`)
    expect(admittedRow).toContain(runPath)
    expect(admittedRow).toContain(admittedDraftPath)
    expect(admittedRow).toContain(createHash("sha256").update(completeBytes).digest("hex"))
    expect(admittedRow).toContain("reviewed-pass; publication proven")
    expect(admittedRow).toContain("raw catalog 14: supported=5")
    expect(admittedRow).toContain("test-todo=9")
    const sealedPass = passPath("sealed-pass", snapshot.probeHash, runPath, [], undefined, runPath)
    const sealedReport = spawnSync(process.execPath, [join(root, "run.ts"), sealedPass], {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
    })
    expect(sealedReport.status, sealedReport.stderr).toBe(0)
    expect(sealedReport.stdout).toContain(`kitty/macos | published | ${snapshot.probeHash}`)
    const foreignAdmission = passPath("foreign-admission", snapshot.probeHash, draftPath, [], undefined, runPath)
    const foreignReport = spawnSync(process.execPath, [join(root, "run.ts"), foreignAdmission], {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
    })
    expect(foreignReport.status).not.toBe(0)
    expect(foreignReport.stderr).toContain("does not identify captured run")
    const featuresPath = join(root, "content", "features.json")
    const featuresBytes = readFileSync(featuresPath, "utf8")
    writeFileSync(featuresPath, `${featuresBytes}\n`)
    const dirty = scoreboard()
    expect(dirty.status, dirty.stderr).toBe(0)
    expect(dirty.stdout).toContain("kitty/macos | measured-unpublished")
    expect(dirty.stdout).toContain("content differs from HEAD")
    writeFileSync(featuresPath, featuresBytes)

    // AC2/3: one census row must retain every selected runtime configuration and its own counts.
    // A complete configuration must not hide a second selected configuration's recorded failures.
    writeFileSync(runPath, runBytes)
    writeFileSync(
      interpretationsPath,
      JSON.stringify([
        review("review-kitty", run.runId, runBytes, runPath),
        review("review-kitty-inconclusive", completeIsolated.runId, isolatedBytes, inconclusivePath),
      ]),
    )
    execFileSync("git", ["-C", root, "add", "content"])
    execFileSync("git", [
      "-C",
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "mixed selected configurations",
    ])
    execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/live", "HEAD"])
    const mixed = scoreboard()
    expect(mixed.status, mixed.stderr).toBe(0)
    const mixedRow = mixed.stdout.split("\n").find((line) => line.startsWith("| kitty/macos |"))
    expect(mixedRow).toContain("measured-unpublished")
    expect(mixedRow).toContain("reviewed-kitty-inconclusive")
    expect(mixedRow).toContain("supported=5")
    expect(mixedRow).toContain("supported=1")
    expect(mixedRow).toContain("test-failure=2")
    // The explicit pass must not hide a second selected configuration when it matches admitted bytes.
    const mixedPass = passPath("mixed-admitted", snapshot.probeHash, inconclusivePath, [], undefined, inconclusivePath)
    const mixedReport = spawnSync(process.execPath, [join(root, "run.ts"), mixedPass], {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
    })
    expect(mixedReport.status, mixedReport.stderr).toBe(0)
    const mixedPassRow = mixedReport.stdout.split("\n").find((line) => line.startsWith("| kitty/macos |"))
    expect(mixedPassRow).toContain("| measured-unpublished |")
    expect(mixedPassRow).toContain("test-failure=2")
    expect(mixedPassRow).toContain("supported=5")

    // The canonical reader owns suiteRelation; the view must retain an older selected configuration as stale.
    const oldSuite = "bbbbbbbbbbbb"
    const { freeze: _freeze, ...oldDeclaration } = manifest
    writeFileSync(
      join(root, "content", "suites", `${oldSuite}.json`),
      JSON.stringify({ ...oldDeclaration, probeHash: oldSuite }),
    )
    const oldRun = {
      ...run,
      runId: "older-kitty",
      suiteId: oldSuite,
      probeHash: oldSuite,
      subject: { ...run.subject, config: "older-suite" },
    }
    const oldPath = join(root, "content", "probes-apps", "older.json")
    const oldBytes = JSON.stringify(oldRun)
    writeFileSync(oldPath, oldBytes)
    const oldReview = review("review-older-kitty", oldRun.runId, oldBytes, oldPath)
    writeFileSync(
      interpretationsPath,
      JSON.stringify([
        review("review-kitty", run.runId, runBytes, runPath),
        review("review-kitty-inconclusive", completeIsolated.runId, isolatedBytes, inconclusivePath),
        { ...oldReview, scope: { ...oldReview.scope, suites: [oldSuite, oldSuite] } },
      ]),
    )
    execFileSync("git", ["-C", root, "add", "content"])
    execFileSync("git", [
      "-C",
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "retain older selected configuration",
    ])
    execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/live", "HEAD"])
    const stale = scoreboard()
    expect(stale.status, stale.stderr).toBe(0)
    const staleRow = stale.stdout.split("\n").find((line) => line.startsWith("| kitty/macos |"))
    expect(staleRow).toContain("| stale |")
    expect(staleRow).toContain("older-kitty")
    expect(staleRow).toContain(`older suite ${oldSuite}`)
    expect(staleRow).toContain("reviewed-kitty-inconclusive")

    writeFileSync(
      join(root, "run.ts"),
      'import { handleReport } from "./packages/admin/src/report.ts"; await handleReport()\n',
    )

    const corruptPath = join(root, "content", "probes-libs", "corrupt.json")
    writeFileSync(corruptPath, "{")
    const corrupt = invoke()
    expect(corrupt.error).toBeUndefined()
    expect(corrupt.status, corrupt.stdout + corrupt.stderr).not.toBe(0)
    expect(corrupt.stdout + corrupt.stderr).toContain(corruptPath)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// @failure A piped report loses its tail: the feature matrix or the sections after it are
// clipped, so the command exits 0 with an apparently complete report missing its counts.
// @level l2 @consumer Terminfo administration reports read through a pipe (#30909).
test("a long report keeps every row and its last section on a pipe", () => {
  const root = mkdtempSync(join(tmpdir(), "terminfo-report-long-"))
  try {
    stageRepo(root)
    const snapshot = probeSuiteSnapshot()
    const featureCount = 300
    const fixtureFeatures = Array.from(
      { length: featureCount },
      (_, index) => `fixture.feature-${String(index).padStart(3, "0")}`,
    )
    writeFileSync(
      join(root, "content", "features.json"),
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
        probeHash: snapshot.probeHash,
        sourceRevision: "1".repeat(40),
        generatedAt: "2026-09-28T00:00:00.000Z",
        freeze: { release: "candidate2", at: "2026-09-28T00:00:00.000Z" },
        adapterVersion: snapshot.adapterVersion,
        catalogIds: fixtureFeatures,
        probes: { app: fixtureFeatures, headless: [], mux: [] },
      }),
    )
    const run = {
      schemaVersion: 3,
      sealedAt: "2026-09-28T12:00:01.000Z",
      intendedContext: { kind: "app", id: "kitty", version: "0.46.2" },
      runId: "long-kitty",
      target: {
        kind: "app",
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
      results: fixtureFeatures.map((featureId) => ({
        featureId,
        status: "test-todo",
        attempt: { scope: "none" },
        checks: [],
        reason: "Missing implementation",
      })),
    }
    const runPath = join(root, "content", "probes-apps", "long.json")
    const runBytes = JSON.stringify(run)
    writeFileSync(runPath, runBytes)
    writeFileSync(
      join(root, "content", "interpretations.json"),
      JSON.stringify([
        {
          id: "review-long",
          runId: run.runId,
          runSha256: createHash("sha256").update(runBytes).digest("hex"),
          reviewer: "reviewer",
          reason: "checked captured identity",
          scope: {
            target: { kind: "app", id: "kitty" },
            versions: [run.target.version, run.target.version],
            suites: [run.suiteId, run.suiteId],
          },
          sources: [runPath],
          supersedes: [],
          verifiesIdentity: true,
          reviewed: true,
        },
      ]),
    )

    const invoked = spawnSync(process.execPath, [join(root, "run.ts")], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    })
    expect(invoked.error).toBeUndefined()
    expect(invoked.status, invoked.stdout + invoked.stderr).toBe(0)
    const plain = invoked.stdout.replace(/\x1b\[[0-9;]*m/g, "")
    const lastFeature = fixtureFeatures[fixtureFeatures.length - 1]!
    const rows = fixtureFeatures.filter((id) => plain.split("\n").some((line) => line.trimStart().startsWith(id)))
    expect(rows).toHaveLength(featureCount)
    const tail = plain.slice(plain.indexOf(lastFeature))
    expect(tail).toContain("Observation reasons and notes")
    expect(tail).toContain("Excluded runs:")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
