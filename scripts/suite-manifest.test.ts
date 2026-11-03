/**
 * @failure A suite declaration can be overwritten with new metadata or a wrong applicable probe set; a manifest may carry half of the legacy provenance; a declare may run on a commit origin/main already holds; or a development build may demand a declaration commit for the derived in-development suite.
 * @level l1
 * @consumer Current probe suite manifest producer, admission, and deploy validation
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/** vendor/terminfo.dev/packages/probes/** vendor/terminfo.dev/packages/terminfo.dev/src/**
 * @reach fs-walk <fixture-only: mkdtempSync Git repos prove the declaration authoring guard>
 * @reach fs-read vendor/terminfo.dev/test-fixtures/** (the checked-in receipt and round the behavior case reads)
 * @testonly none
 */
import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "vitest"
import { parseSuiteManifest } from "@terminfo/run-parser"
import { probeSuiteSnapshot, type ProbeSuiteSnapshot } from "../packages/admin/versions.ts"
import { parseDisposableReceipt, readDisposableReceipt } from "../packages/terminfo.dev/src/disposable-receipt.ts"
import { getTrustedSuiteReceipt } from "../packages/terminfo.dev/src/serve.ts"

/** Verbatim copy of a linux-xvfb-container receipt the round carried (#30764 M4 P1b). */
const LINUX_RECEIPT_FIXTURE = "070448f8377ad6e3dfae0579235fb402.json"
import {
  assertDeclareIsAuthoring,
  declareCurrentSuiteManifest,
  derivedSuiteManifest,
  persistSuiteManifest,
  uncommittedCollectorDirt,
  verifySuiteManifest,
} from "../packages/admin/suite-manifest.ts"

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

/** A checkout on a non-default branch, one commit ahead of origin/main: a declaration may author here. */
const authoringRepo = (prefix: string): string => {
  const directory = temp(prefix)
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  git("init", "-q", "-b", "task/fixture")
  git("config", "user.email", "fixture@example.invalid")
  git("config", "user.name", "fixture")
  writeFileSync(join(directory, "a.txt"), "one\n")
  git("add", "a.txt")
  git("commit", "-q", "-m", "one")
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD").trim())
  writeFileSync(join(directory, "b.txt"), "two\n")
  git("add", "b.txt")
  git("commit", "-q", "-m", "two")
  return directory
}

test("a same-hash declaration stays immutable and mismatched membership fails loudly", () => {
  const directory = temp("terminfo-suite-manifest-")
  const snapshot = probeSuiteSnapshot()
  const path = join(directory, `${snapshot.probeHash}.json`)
  const first = {
    ...derivedSuiteManifest(snapshot),
    sourceRevision: "a".repeat(40),
    generatedAt: "2026-09-28T00:00:00.000Z",
  }
  expect(persistSuiteManifest(path, first, snapshot)).toBe("created")
  const originalBytes = readFileSync(path, "utf8")
  const later = { ...first, sourceRevision: "b".repeat(40), generatedAt: "2026-09-29T00:00:00.000Z" }
  expect(persistSuiteManifest(path, later, snapshot)).toBe("existing")
  expect(readFileSync(path, "utf8")).toBe(originalBytes)
  expect(verifySuiteManifest(path, snapshot)).toEqual(first)

  writeFileSync(path, JSON.stringify({ ...first, probes: { ...first.probes, lib: first.probes.lib.slice(1) } }))
  expect(() => persistSuiteManifest(path, later, snapshot)).toThrow(/lib|membership/)
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
test("current suite verification and persistence reject altered text declarations", () => {
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
  expect(persistSuiteManifest(path, valid, snapshot)).toBe("created")
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
    expect(() => persistSuiteManifest(path, altered, snapshot), JSON.stringify(change)).toThrow(
      /Suite text .* mismatch/,
    )
    expect(() => persistSuiteManifest(path, valid, snapshot), JSON.stringify(change)).toThrow(/Suite text .* mismatch/)
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

/**
 * The stray manifests in shared main came from a declare on a commit origin/main already held. The
 * refusal names the undeclared suite and the cure (27864), so an operator sees a suite problem and
 * its fix, not a git problem. The authoring discriminator is the branch (30163): a fresh branch cut
 * at origin/main authors the commit the act creates, while the default branch and a detached HEAD
 * land the write on nobody's commit.
 */
test("declaring refuses the default branch and a detached HEAD, and allows a fresh named branch at origin/main", () => {
  const directory = temp("terminfo-suite-manifest-git-")
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  git("init", "-q", "-b", "main")
  git("config", "user.email", "fixture@example.invalid")
  git("config", "user.name", "fixture")
  writeFileSync(join(directory, "a.txt"), "one\n")
  git("add", "a.txt")
  git("commit", "-q", "-m", "one")
  const atOriginMain = git("rev-parse", "HEAD").trim()
  git("update-ref", "refs/remotes/origin/main", atOriginMain)

  const undeclared = "a".repeat(12)
  const snapshot = snapshotOf(undeclared)
  expect(() => assertDeclareIsAuthoring(directory, undeclared)).toThrow(/default branch \(main\)/)
  expect(() => assertDeclareIsAuthoring(directory, undeclared)).toThrow(
    new RegExp(`Suite ${undeclared} cannot be declared or admitted on this checkout`),
  )
  expect(() => assertDeclareIsAuthoring(directory, undeclared)).not.toThrow(/admit-run\.ts --for/)
  expect(() => assertDeclareIsAuthoring(directory, undeclared)).toThrow(/git switch -c task\/<name> origin\/main/)
  expect(() => declareCurrentSuiteManifest(directory, snapshot)).toThrow(/default branch/)

  git("checkout", "-q", "--detach", atOriginMain)
  expect(() => assertDeclareIsAuthoring(directory, undeclared)).toThrow(/detached/)
  expect(() => declareCurrentSuiteManifest(directory, snapshot)).toThrow(/detached/)

  // A clone cut from an author branch points origin/HEAD elsewhere; main stays a default branch.
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/task/other")
  git("switch", "-q", "main")
  expect(() => assertDeclareIsAuthoring(directory, undeclared)).toThrow(/default branch \(main\)/)

  git("switch", "-q", "-c", "task/fresh", "origin/main")
  expect(() => assertDeclareIsAuthoring(directory)).not.toThrow()
  const declared = declareCurrentSuiteManifest(directory, snapshot)
  expect(declared.status).toBe("created")
  expect(existsSync(declared.path)).toBe(true)
})

/**
 * origin/HEAD is optional, and `--quiet` reports an absent ref and a direct ref the same way: neither
 * names a remote default. main stays the default and a named task branch still authors (30163).
 */
test("declaring treats a non-symbolic origin/HEAD as naming no remote default", () => {
  const directory = authoringRepo("terminfo-suite-manifest-origin-head-direct-")
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  git("branch", "main", git("rev-parse", "HEAD").trim())
  git("update-ref", "refs/remotes/origin/HEAD", git("rev-parse", "HEAD").trim())
  expect(() => assertDeclareIsAuthoring(directory)).not.toThrow()
  git("switch", "-q", "main")
  expect(() => assertDeclareIsAuthoring(directory)).toThrow(/default branch \(main\)/)
})

/** Any other exit from the same read is a failure the guard never asked for, never a reason to admit. */
test("declaring throws and names the command when reading origin/HEAD fails unexpectedly", () => {
  const directory = authoringRepo("terminfo-suite-manifest-origin-head-corrupt-")
  writeFileSync(join(directory, ".git", "refs", "remotes", "origin", "HEAD"), "not a ref\n")
  expect(() => assertDeclareIsAuthoring(directory)).toThrow(
    /git symbolic-ref --quiet --short refs\/remotes\/origin\/HEAD/,
  )
  expect(() => assertDeclareIsAuthoring(directory)).toThrow(/exited /)
  expect(() => assertDeclareIsAuthoring(directory)).toThrow(directory)
})

test("the parser refuses a freeze lineage that is not the carried list", () => {
  const base = {
    schemaVersion: 4 as const,
    probeHash: "a".repeat(12),
    adapterVersion: "1.0.0",
    probes: { term: ["x"], lib: [], mux: ["x"] },
  }
  const entry = {
    suite: "b".repeat(12),
    from: "2026-10-16T09:30:22.506Z",
    until: "2026-10-18T02:27:38.228Z",
  }
  const withPrevious = (previous: unknown): string =>
    JSON.stringify({ ...base, freeze: { release: "candidate2", at: "2026-10-18T02:27:38.228Z", previous } })
  // The shape is one list of windows, so the old single pointer, an extra key, a bad instant and a
  // repeat all refuse by name rather than being coerced into a list.
  expect(() => parseSuiteManifest("x.json", withPrevious({ suite: entry.suite }))).toThrow(/previous lineage/)
  expect(() => parseSuiteManifest("x.json", withPrevious([{ ...entry, extra: true }]))).toThrow(/previous entry/)
  expect(() => parseSuiteManifest("x.json", withPrevious([{ ...entry, until: "yesterday" }]))).toThrow(/previous until/)
  expect(() => parseSuiteManifest("x.json", withPrevious([entry, { ...entry }]))).toThrow(/repeats suite/)
  expect(parseSuiteManifest("x.json", withPrevious([entry])).freeze?.previous).toEqual([entry])
})

test("the parser refuses a lineage that names the suite the record freezes, or windows out of order", () => {
  const own = "a".repeat(12)
  const base = {
    schemaVersion: 4 as const,
    probeHash: own,
    adapterVersion: "1.0.0",
    probes: { term: ["x"], lib: [], mux: ["x"] },
  }
  const at = "2026-10-18T03:00:00.000Z"
  const first = { suite: "b".repeat(12), from: "2026-10-16T09:30:22.506Z", until: "2026-10-18T02:27:38.228Z" }
  const second = { suite: "c".repeat(12), from: "2026-10-18T02:27:38.228Z", until: at }
  const withPrevious = (previous: unknown): string =>
    JSON.stringify({ ...base, freeze: { release: "candidate2", at, previous } })
  // A lineage naming the record's own suite would make the reader name it twice.
  expect(() => parseSuiteManifest("x.json", withPrevious([first, { ...second, suite: own }]))).toThrow(/repeats suite/)
  // Oldest first, each window starting where the one before it ended, the last ending at this freeze.
  expect(() => parseSuiteManifest("x.json", withPrevious([second, first]))).toThrow(/previous window/)
  const backwards = { ...first, from: first.until, until: first.from }
  expect(() => parseSuiteManifest("x.json", withPrevious([backwards, second]))).toThrow(/previous window/)
  expect(() => parseSuiteManifest("x.json", withPrevious([first]))).toThrow(/not at this freeze/)
  expect(parseSuiteManifest("x.json", withPrevious([first, second])).freeze?.previous).toEqual([first, second])
})

test("the parser refuses a gap between windows that are otherwise in order and end at the freeze", () => {
  const base = {
    schemaVersion: 4 as const,
    probeHash: "a".repeat(12),
    adapterVersion: "1.0.0",
    probes: { term: ["x"], lib: [], mux: ["x"] },
  }
  const at = "2026-10-18T03:00:00.000Z"
  const first = { suite: "b".repeat(12), from: "2026-10-16T09:30:22.506Z", until: "2026-10-18T02:27:38.228Z" }
  // Each window runs forwards and the last ends at this freeze, but the second does not start where the
  // first ended: only the order rule can refuse it.
  const gapped = { suite: "c".repeat(12), from: "2026-10-18T02:40:00.000Z", until: at }
  const source = JSON.stringify({ ...base, freeze: { release: "candidate2", at, previous: [first, gapped] } })
  expect(() => parseSuiteManifest("x.json", source)).toThrow(/previous window for suite c{12}/)
})

test("the source-tree collector derives the same manifest that the admission writer persists", () => {
  const snapshot = probeSuiteSnapshot()
  const directory = temp("terminfo-serve-writer-parity-")
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  git("init", "-q", "-b", "task/fixture")
  git("config", "user.email", "fixture@example.invalid")
  git("config", "user.name", "fixture")
  writeFileSync(join(directory, "a.txt"), "one\n")
  git("add", "a.txt")
  git("commit", "-q", "-m", "one")
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD").trim())
  writeFileSync(join(directory, "b.txt"), "two\n")
  git("add", "b.txt")
  git("commit", "-q", "-m", "two")

  const declared = declareCurrentSuiteManifest(directory, snapshot)
  const writerManifest = parseSuiteManifest(declared.path, readFileSync(declared.path, "utf8"))

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

test("committed disposable receipts verify unchanged", () => {
  const receiptsDir = join(REPO_ROOT, "content", "receipts")
  const receiptFiles = readdirSync(receiptsDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
  // The round is empty between the Friday delete and Saturday's admission (#30764 M4 P1): the guard
  // still proves every committed receipt parses, and keeps a non-.json placeholder in the folder.
  for (const file of receiptFiles) {
    const path = join(receiptsDir, file)
    expect(readDisposableReceipt(path).kind).toMatch(/^[a-z]/)
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

/**
 * 28018: the writer could only ever freeze the suite the collector builds NOW, so a ruling that names an
 * older suite the registry still carries had no expressible write. These rows pin the explicit target.
 */
const EXPLICIT_AT = "2026-10-18T21:00:00.000Z"
