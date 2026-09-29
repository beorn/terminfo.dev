/**
 * @failure Report promotes newer unverified booleans and renders absent cells as unsupported.
 * @level l2
 * @consumer Admin CLI report readers comparing selected terminal observations.
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

test("report renders reviewed outcomes and missing cells without promoting legacy history", () => {
  const source = join(import.meta.dirname, "..", "..", "..")
  const root = mkdtempSync(join(tmpdir(), "terminfo-report-"))
  try {
    const admin = join(root, "packages", "admin")
    mkdirSync(join(admin, "src"), { recursive: true })
    mkdirSync(join(root, "content", "probes-apps"), { recursive: true })
    mkdirSync(join(root, "content", "probes-libs"))
    mkdirSync(join(root, "content", "probes-mux"))
    mkdirSync(join(root, "content", "suites"))
    copyFileSync(join(source, "packages", "admin", "src", "report.ts"), join(admin, "src", "report.ts"))
    copyFileSync(join(source, "packages", "admin", "report.tsx"), join(admin, "report.tsx"))
    symlinkSync(join(source, "packages", "admin", "versions.ts"), join(admin, "versions.ts"))
    symlinkSync(join(source, "packages", "admin", "parse.ts"), join(admin, "parse.ts"))
    symlinkSync(join(source, "packages", "admin", "node_modules"), join(admin, "node_modules"), "dir")
    symlinkSync(join(source, "node_modules"), join(root, "node_modules"), "dir")
    symlinkSync(join(source, "docs"), join(root, "docs"), "dir")
    writeFileSync(
      join(root, "run.ts"),
      'import { handleReport } from "./packages/admin/src/report.ts"; await handleReport()\n',
    )

    const snapshot = probeSuiteSnapshot()
    // A small synthetic suite exercises the real selection/report boundary, not collector suite coverage.
    const fixtureFeatures = ["cursor.position", "sgr.bold", "extensions.query", "modes.autowrap", "sgr.italic"]
    writeFileSync(
      join(root, "content", "features.json"),
      JSON.stringify(Object.fromEntries(fixtureFeatures.map((id) => [id, {}]))),
    )
    writeFileSync(
      join(root, "content", "suites", `${snapshot.probeHash}.json`),
      JSON.stringify({
        probeHash: snapshot.probeHash,
        sourceRevision: "1".repeat(40),
        generatedAt: "2026-09-28T00:00:00.000Z",
        adapterVersion: snapshot.adapterVersion,
        probes: {
          app: fixtureFeatures.slice(0, 4),
          headless: fixtureFeatures.slice(0, 4),
          mux: fixtureFeatures.slice(0, 4),
        },
      }),
    )
    const run = {
      schemaVersion: 2,
      runId: "reviewed-kitty",
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
      suiteComplete: true,
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
          kind: "positive",
          rawReplyRef: "cursor.position",
          expected: "x=2",
          observed: '{"x":2}',
        },
        {
          featureId: "sgr.bold",
          kind: "negative",
          rawReplyRef: "sgr.bold",
          expected: "bold=true",
          observed: '{"bold":false}',
        },
      ],
      screenshotRefs: [],
      observations: [
        {
          featureId: "cursor.position",
          outcome: "supported",
          evidence: "parser-state",
          rawReplyRef: "cursor.position",
        },
        { featureId: "sgr.bold", outcome: "unsupported", evidence: "parser-state", rawReplyRef: "sgr.bold" },
        { featureId: "extensions.query", outcome: "inconclusive", reason: "timeout", evidence: "query" },
        { featureId: "modes.autowrap", outcome: "error", reason: "collector-error", evidence: "query" },
      ],
    }
    const runPath = join(root, "content", "probes-apps", "reviewed.json")
    const runBytes = JSON.stringify(run)
    writeFileSync(runPath, runBytes)
    const inconclusiveRun = {
      ...run,
      runId: "reviewed-kitty-inconclusive",
      target: { ...run.target, config: "isolated" },
      measuredAt: "2026-09-28T13:00:00.000Z",
      rawReplies: { "device.primary-da": "\x1b[?62;52;c", "device.xtversion": "kitty(0.46.2)" },
      assertions: [],
      observations: run.observations.map(({ featureId }) => ({
        featureId,
        outcome: "inconclusive",
        reason: "timeout",
        evidence: "query",
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
        target: { kind: "app", id: "kitty" },
        versions: [run.target.version, run.target.version],
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
    expect(reviewed?.counts).toMatchObject({
      catalog: 5,
      tested: 4,
      notTested: 1,
      conclusive: 2,
      supported: 1,
      unsupported: 1,
    })

    const invoke = () =>
      spawnSync(process.execPath, [join(root, "run.ts")], { cwd: root, encoding: "utf8", timeout: 15_000 })
    const selected = invoke()
    expect(selected.error).toBeUndefined()
    expect(selected.status, selected.stdout + selected.stderr).toBe(0)
    const plain = selected.stdout.replace(/\x1b\[[0-9;]*m/g, "")
    const contexts = [...plain.matchAll(/(C\d+): app:kitty 0\.46\.2 — run (reviewed-kitty(?:-inconclusive)?)/g)]
    expect(contexts).toHaveLength(2)
    const labelFor = (runId: string) => contexts.find((match) => match[2] === runId)?.[1]
    const normal = labelFor("reviewed-kitty")
    const allInconclusive = labelFor("reviewed-kitty-inconclusive")
    expect(normal).toBeDefined()
    expect(allInconclusive).toBeDefined()
    expect(normal).not.toBe(allInconclusive)
    const matrix = plain.split("Feature comparison")[1]?.split("Observation reasons and notes")[0]
    expect(matrix).toBeDefined()
    expect(matrix).toContain("YES supported · NO unsupported · INC inconclusive · ERR error · NT not tested")
    const labels = contexts.map((match) => match[1])
    const stateRow = (id: string) => {
      const line = matrix?.split("\n").find((row) => row.trimStart().startsWith(id))
      expect(line, `missing matrix row ${id}`).toBeDefined()
      const tokens = line?.match(/\b(?:YES|NO|INC|ERR|NT)\b/g)
      expect(tokens, `states for ${id}`).toHaveLength(2)
      return Object.fromEntries(labels.map((label, index) => [label, tokens?.[index]]))
    }
    expect(stateRow("cursor.position")).toMatchObject({ [normal!]: "YES", [allInconclusive!]: "INC" })
    expect(stateRow("sgr.bold")).toMatchObject({ [normal!]: "NO", [allInconclusive!]: "INC" })
    expect(stateRow("extensions.query")).toMatchObject({ [normal!]: "INC", [allInconclusive!]: "INC" })
    expect(stateRow("modes.autowrap")).toMatchObject({ [normal!]: "ERR", [allInconclusive!]: "INC" })
    expect(stateRow("sgr.italic")).toMatchObject({ [normal!]: "NT", [allInconclusive!]: "NT" })
    expect(plain).toContain(`${normal} extensions.query: timeout`)
    expect(plain).toContain(`${normal} modes.autowrap: collector-error`)
    expect(plain).toContain("1/2 50%")
    expect(plain).toContain("no conclusive score")
    expect(plain).not.toContain("NaN")
    expect(plain).toContain("Ungraded history:")
    expect(plain).toContain("Excluded runs:")
    expect(plain.split("Ungraded history:")[0]).not.toContain("9.9.9")

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
