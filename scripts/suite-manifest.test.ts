/**
 * @failure Suite verification accepts wrong applicable probes or text declarations, a manifest carries half its provenance, or a development build rejects its derived suite.
 * @level l1
 * @consumer Current suite verification and collection
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/** vendor/terminfo.dev/packages/probes/** vendor/terminfo.dev/packages/terminfo.dev/src/**
 * @reach fs-read vendor/terminfo.dev/test-fixtures/** (the checked-in receipt and round the behavior case reads)
 * @testonly none
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "vitest"
import { parseSuiteManifest } from "@terminfo/run-parser"
import {
  derivedSuiteManifest,
  probeSuiteSnapshot,
  uncommittedCollectorDirt,
  type ProbeSuiteSnapshot,
} from "../packages/admin/versions.ts"
import { parseDisposableReceipt, readDisposableReceipt } from "../packages/terminfo.dev/src/disposable-receipt.ts"
import { getTrustedSuiteReceipt } from "../packages/terminfo.dev/src/serve.ts"

/** Verbatim copy of a linux-xvfb-container receipt the round carried (#30764 M4 P1b). */
const LINUX_RECEIPT_FIXTURE = "070448f8377ad6e3dfae0579235fb402.json"
import { verifySuiteManifest } from "../packages/admin/suite-manifest.ts"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const temporaryPaths: string[] = []
afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true })
})
const temp = (prefix: string): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryPaths.push(directory)
  return directory
}

const snapshotOf = (probeHash: string): ProbeSuiteSnapshot => ({
  probeHash,
  adapterVersion: "1.0.0",
  catalogIds: ["fixture.catalogue"],
  catalogEntrySha256: { "fixture.catalogue": "a".repeat(64) },
  probes: { term: [], lib: [], mux: [] },
  sourcePaths: [],
})

test("the declared manifest carries only the derived record", () => {
  const manifest = derivedSuiteManifest(probeSuiteSnapshot())
  expect(Object.keys(manifest).sort()).toEqual([
    "adapterVersion",
    "catalogEntrySha256",
    "catalogIds",
    "probeHash",
    "probes",
    "schemaVersion",
    "textClaims",
    "textQualification",
  ])
})

// Same-hash declarations must not grant character evidence to an attribute-only probe.
// Parser validity alone cannot establish parity with the executable suite's declarations.
test("current suite verification rejects altered text declarations", () => {
  const snapshot: ProbeSuiteSnapshot = {
    probeHash: "c".repeat(12),
    adapterVersion: "1.0.0",
    catalogIds: ["attributes", "character"],
    catalogEntrySha256: { attributes: "a".repeat(64), character: "b".repeat(64) },
    probes: { term: ["character", "attributes"], lib: [], mux: ["character", "attributes"] },
    sourcePaths: [],
    textClaims: ["character"],
    textQualification: { version: 1, recipe: "macos-text-cells-v1" },
  }
  const valid = derivedSuiteManifest(snapshot)
  const path = join(temp("terminfo-suite-text-declarations-"), `${snapshot.probeHash}.json`)
  writeFileSync(path, JSON.stringify(valid))
  expect(verifySuiteManifest(path, snapshot)).toEqual(valid)
  const changes = [
    { textClaims: undefined },
    { textClaims: [] },
    { textClaims: ["attributes", "character"] },
    { textQualification: undefined },
    { textQualification: { version: 2, recipe: "macos-text-cells-v1" } },
    { textQualification: { version: 1, recipe: "another-recipe" } },
  ]
  for (const change of changes) {
    const altered = { ...valid, ...change }
    writeFileSync(path, JSON.stringify(altered))
    expect(() => verifySuiteManifest(path, snapshot), JSON.stringify(change)).toThrow(/Suite text .* mismatch/)
  }
  // Old snapshots have no opt-in declarations; they still verify without these optional fields.
  const { textClaims: _claims, textQualification: _spec, ...historical } = snapshot
  const legacy = derivedSuiteManifest(historical)
  writeFileSync(path, JSON.stringify(legacy))
  expect(verifySuiteManifest(path, historical)).toEqual(legacy)
  expect(() => verifySuiteManifest(path, snapshot)).toThrow(/Suite text .* mismatch/)
  writeFileSync(path, JSON.stringify(valid))
  expect(() => verifySuiteManifest(path, historical)).toThrow(/Suite text .* mismatch/)
})

/** A manifest is legacy-complete (both) or new-minimal (neither); a half pair refuses by name. */
test("the parser accepts both provenance shapes and refuses a partial pair", () => {
  const base = {
    schemaVersion: 4 as const,
    probeHash: "a".repeat(12),
    adapterVersion: "1.0.0",
    probes: { term: ["x"], lib: [], mux: ["x"] },
  }
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

test("the source-tree collector uses the derived manifest", () => {
  const snapshot = probeSuiteSnapshot()
  const writerManifest = derivedSuiteManifest(snapshot)

  const prevHash = process.env.TERMINFO_PROBE_HASH
  const prevRev = process.env.TERMINFO_SOURCE_REVISION
  try {
    process.env.TERMINFO_SOURCE_REVISION = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim()
    process.env.TERMINFO_PROBE_HASH = "0".repeat(12)
    expect(() => getTrustedSuiteReceipt()).toThrow(/differs from TERMINFO_PROBE_HASH/)

    process.env.TERMINFO_PROBE_HASH = snapshot.probeHash
    const receipt = getTrustedSuiteReceipt()
    expect(receipt.manifest).toEqual(writerManifest)
  } finally {
    if (prevHash === undefined) delete process.env.TERMINFO_PROBE_HASH
    else process.env.TERMINFO_PROBE_HASH = prevHash
    if (prevRev === undefined) delete process.env.TERMINFO_SOURCE_REVISION
    else process.env.TERMINFO_SOURCE_REVISION = prevRev
  }
})

test("a receipt without manifestSha256 verifies", () => {
  // Verbatim copy of the round's receipt (#30764 M4 P1b): content/receipts leaves on Friday.
  const linuxReceiptPath = join(REPO_ROOT, "test-fixtures", "receipts", LINUX_RECEIPT_FIXTURE)
  const existing = readDisposableReceipt(linuxReceiptPath)
  expect(existing.kind).toBe("linux-xvfb-container")

  const raw = JSON.parse(readFileSync(linuxReceiptPath, "utf8")) as {
    runnerArtifact: { build: Record<string, unknown> }
  }
  expect(raw.runnerArtifact.build.manifestSha256).toMatch(/^[0-9a-f]{64}$/)
  delete raw.runnerArtifact.build.manifestSha256
  delete raw.runnerArtifact.build.suiteState
  const withoutManifestDigest = parseDisposableReceipt(`${JSON.stringify(raw, null, 2)}\n`)
  expect(withoutManifestDigest.kind).toBe("linux-xvfb-container")
  expect(withoutManifestDigest.identity).toEqual(existing.identity)
})

/**
 * 28029 (T7): a development checkout DERIVES its own suite declaration so the collector can read it,
 * and commits that ONE declaration at the RC freeze act — never per probe change. RED BEFORE: the
 * build listed `content/suites/<hash>.json` among its committed inputs, so the declaration the
 * previous build had just written made the next build refuse with "Cannot bundle an uncommitted CLI
 * collector", a declaration commit for every probe development change (13 commits / ~1 h one week).
 */
test("the derived in-development declaration is not uncommitted collector dirt (28029/T7)", () => {
  const directory = temp("terminfo-collector-dirt-")
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  git("init", "-q", "-b", "main")
  git("config", "user.email", "fixture@example.invalid")
  git("config", "user.name", "fixture")
  mkdirSync(join(directory, "scripts"), { recursive: true })
  writeFileSync(join(directory, "scripts", "build-cli.ts"), "// collector input\n")
  git("add", "scripts/build-cli.ts")
  git("commit", "-q", "-m", "one")
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD").trim())

  const snapshot = snapshotOf("a".repeat(12))
  expect(uncommittedCollectorDirt(directory, snapshot)).toBe("")

  // The previous development build derived and wrote this file untracked so the collector can read it.
  mkdirSync(join(directory, "content", "suites"), { recursive: true })
  writeFileSync(join(directory, "content", "suites", `${snapshot.probeHash}.json`), "{}\n")
  expect(uncommittedCollectorDirt(directory, snapshot)).toBe("")

  // A changed committed input is still dirt, so the check still means what it says.
  writeFileSync(join(directory, "scripts", "build-cli.ts"), "// collector input, developed\n")
  expect(uncommittedCollectorDirt(directory, snapshot)).toContain("scripts/build-cli.ts")
})
