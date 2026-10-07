/**
 * @failure A suite declaration can be overwritten with new metadata or a wrong applicable probe set; a manifest may carry half of the legacy provenance; the composed-tree check may go red because the tree's own suite is uncited; or a declare may run on a commit origin/main already holds.
 * @level l1
 * @consumer Current probe suite manifest producer, admission, and deploy validation
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/ vendor/terminfo.dev/packages/probes/ vendor/terminfo.dev/packages/terminfo.dev/src/
 * @reach fs-walk <fixture-only: mkdtempSync Git repos prove the declare guard and the cited-manifest gate>
 * @testonly none
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { parseSuiteManifest } from "@terminfo/run-parser"
import { probeSuiteSnapshot, type ProbeSuiteSnapshot } from "../packages/admin/versions.ts"
import {
  assertDeclareIsAuthoring,
  checkCitedSuiteManifests,
  derivedSuiteManifest,
  persistSuiteManifest,
  suiteManifestMode,
  verifySuiteManifest,
} from "./suite-manifest.ts"

const temporaryPaths: string[] = []
afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true })
})
const temp = (prefix: string): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryPaths.push(directory)
  return directory
}

test("a same-hash declaration stays immutable and mismatched membership fails loudly", () => {
  const directory = temp("terminfo-suite-manifest-")
  const snapshot = probeSuiteSnapshot()
  const path = join(directory, `${snapshot.probeHash}.json`)
  const first = {
    probeHash: snapshot.probeHash,
    sourceRevision: "a".repeat(40),
    generatedAt: "2026-09-28T00:00:00.000Z",
    adapterVersion: snapshot.adapterVersion,
    probes: snapshot.probes,
  }
  expect(persistSuiteManifest(path, first, snapshot)).toBe("created")
  const originalBytes = readFileSync(path, "utf8")
  const later = { ...first, sourceRevision: "b".repeat(40), generatedAt: "2026-09-29T00:00:00.000Z" }
  expect(persistSuiteManifest(path, later, snapshot)).toBe("existing")
  expect(readFileSync(path, "utf8")).toBe(originalBytes)
  expect(verifySuiteManifest(path, snapshot)).toEqual(first)

  writeFileSync(
    path,
    JSON.stringify({ ...first, probes: { ...first.probes, headless: first.probes.headless.slice(1) } }),
  )
  expect(() => persistSuiteManifest(path, later, snapshot)).toThrow(/headless|membership/)
})

/** A bare invocation may not declare: only `--check` is a public verb (27843 AC2 + 27859). */
test("only the explicit --check verb runs; a bare or --write invocation is usage", () => {
  expect(suiteManifestMode([])).toBe("usage")
  expect(suiteManifestMode(["--typo"])).toBe("usage")
  expect(suiteManifestMode(["--check", "extra"])).toBe("usage")
  expect(suiteManifestMode(["--write"])).toBe("usage")
  expect(suiteManifestMode(["--check"])).toBe("check")
})

/** The derived record is a pure function of the suite: no legacy provenance is ever written. */
test("the declared manifest carries only the derived record", () => {
  const manifest = derivedSuiteManifest(probeSuiteSnapshot())
  expect(Object.keys(manifest).sort()).toEqual(["adapterVersion", "probeHash", "probes"])
})

/** A manifest is legacy-complete (both) or new-minimal (neither); a half pair refuses by name. */
test("the parser accepts both provenance shapes and refuses a partial pair", () => {
  const base = { probeHash: "a".repeat(12), adapterVersion: "1.0.0", probes: { app: ["x"], headless: [], mux: ["x"] } }
  const legacy = parseSuiteManifest(
    "legacy.json",
    JSON.stringify({
      ...base,
      sourceRevision: "b".repeat(40),
      generatedAt: "2026-09-28T00:00:00.000Z",
    }),
  )
  expect(legacy.sourceRevision).toBe("b".repeat(40))
  const minimal = parseSuiteManifest("minimal.json", JSON.stringify(base))
  expect(minimal.sourceRevision).toBeUndefined()
  expect(minimal.generatedAt).toBeUndefined()
  expect(() => parseSuiteManifest("partial.json", JSON.stringify({ ...base, sourceRevision: "b".repeat(40) }))).toThrow(
    /both-or-neither/,
  )
  expect(() =>
    parseSuiteManifest("partial.json", JSON.stringify({ ...base, generatedAt: "2026-09-28T00:00:00.000Z" })),
  ).toThrow(/both-or-neither/)
  expect(() =>
    parseSuiteManifest(
      "bad.json",
      JSON.stringify({ ...base, generatedAt: "2026-09-28T00:00:00.000Z", sourceRevision: "nope" }),
    ),
  ).toThrow(/sourceRevision/)
  expect(() => parseSuiteManifest("unknown.json", JSON.stringify({ ...base, extra: 1 }))).toThrow(
    /unknown suite manifest field extra/,
  )
  expect(() => parseSuiteManifest("missing.json", JSON.stringify({ probeHash: "a".repeat(12) }))).toThrow(
    /missing suite manifest field/,
  )
})

const CITED = "a".repeat(12)
const COMPOSED = "b".repeat(12)
const snapshotOf = (probeHash: string): ProbeSuiteSnapshot => ({
  probeHash,
  adapterVersion: "1.0.0",
  probes: { app: [], headless: [], mux: [] },
  sourcePaths: [],
})

function citedFixture(): string {
  const directory = temp("terminfo-cited-")
  for (const dir of ["probes-apps", "probes-libs", "probes-mux"]) {
    mkdirSync(join(directory, "content", dir), { recursive: true })
  }
  mkdirSync(join(directory, "content", "suites"), { recursive: true })
  writeFileSync(
    join(directory, "content", "probes-apps", "kitty-0.49.2-linux-run1.json"),
    JSON.stringify({ schemaVersion: 2, probeHash: CITED }),
  )
  writeFileSync(
    join(directory, "content", "suites", `${CITED}.json`),
    JSON.stringify({ probeHash: CITED, adapterVersion: "1.0.0", probes: { app: [], headless: [], mux: [] } }),
  )
  return directory
}

/** The compose regression: a non-fast-forward merge produces a suite hash nobody cited. */
test("the composed-tree check is green when the tree's own suite is uncited", () => {
  const directory = citedFixture()
  // RED BEFORE: the old gate demanded the tree's own suite be declared, so a composed tree threw.
  expect(() =>
    verifySuiteManifest(join(directory, "content", "suites", `${COMPOSED}.json`), snapshotOf(COMPOSED)),
  ).toThrow(/Cannot read suite manifest/)
  // GREEN AFTER: nothing cites COMPOSED, so its absence is correct, not an error.
  expect(checkCitedSuiteManifests(directory, snapshotOf(COMPOSED))).toEqual({ cited: 1, manifests: 1 })
})

test("the check is red when a cited run has no committed declaration", () => {
  const directory = citedFixture()
  rmSync(join(directory, "content", "suites", `${CITED}.json`))
  expect(() => checkCitedSuiteManifests(directory, snapshotOf(COMPOSED))).toThrow(/no committed suite manifest/)
})

test("the check is red when a declaration is not named for the hash it declares", () => {
  const directory = citedFixture()
  writeFileSync(
    join(directory, "content", "suites", `${CITED}.json`),
    JSON.stringify({ probeHash: COMPOSED, adapterVersion: "1.0.0", probes: { app: [], headless: [], mux: [] } }),
  )
  expect(() => checkCitedSuiteManifests(directory, snapshotOf(COMPOSED))).toThrow(/not its filename/)
})

/**
 * The stray manifests in shared main came from a declare on a commit origin/main already held. The
 * refusal now names the undeclared suite and the cure (27864), so an operator sees a suite problem
 * and its fix, not a git problem.
 */
test("declaring refuses a checkout whose HEAD is already on origin/main and allows one that is not", () => {
  const directory = temp("terminfo-suite-manifest-git-")
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  git("init", "-q", "-b", "main")
  git("config", "user.email", "fixture@example.invalid")
  git("config", "user.name", "fixture")
  writeFileSync(join(directory, "a.txt"), "one\n")
  git("add", "a.txt")
  git("commit", "-q", "-m", "one")
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD").trim())

  const undeclared = "a".repeat(12)
  expect(() => assertDeclareIsAuthoring(directory, undeclared)).toThrow(/origin\/main/)
  expect(() => assertDeclareIsAuthoring(directory, undeclared)).toThrow(
    new RegExp(`Suite ${undeclared} is undeclared on this checkout`),
  )
  expect(() => assertDeclareIsAuthoring(directory, undeclared)).toThrow(/admit-run\.ts --for/)

  writeFileSync(join(directory, "b.txt"), "two\n")
  git("add", "b.txt")
  git("commit", "-q", "-m", "two")
  expect(() => assertDeclareIsAuthoring(directory)).not.toThrow()
})
