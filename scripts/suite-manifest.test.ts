/**
 * @failure A suite declaration can be overwritten with new metadata or a wrong applicable probe set; a manifest may carry half of the legacy provenance; the composed-tree check may go red because the tree's own suite is uncited; a declare may run on a commit origin/main already holds; or a development build may demand a declaration commit for the derived in-development suite.
 * @level l1
 * @consumer Current probe suite manifest producer, admission, and deploy validation
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/ vendor/terminfo.dev/packages/probes/ vendor/terminfo.dev/packages/terminfo.dev/src/
 * @reach fs-walk <fixture-only: mkdtempSync Git repos prove the declare guard and the cited-manifest gate>
 * @testonly none
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "vitest"
import { parseSuiteManifest } from "@terminfo/run-parser"
import { probeSuiteSnapshot, type ProbeSuiteSnapshot } from "../packages/admin/versions.ts"
import { parseDisposableReceipt, readDisposableReceipt } from "../packages/terminfo.dev/src/disposable-receipt.ts"
import { getTrustedSuiteReceipt } from "../packages/terminfo.dev/src/serve.ts"
import {
  assertDeclareIsAuthoring,
  checkCitedSuiteManifests,
  declareCurrentSuiteManifest,
  derivedSuiteManifest,
  freezeCurrentSuiteManifest,
  frozenSuiteIdFor,
  persistSuiteManifest,
  suiteManifestMode,
  uncommittedCollectorDirt,
  verifySuiteManifest,
} from "./suite-manifest.ts"

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

/** A checkout one commit ahead of origin/main: the state a declaration is allowed to author in. */
const authoringRepo = (prefix: string): string => {
  const directory = temp(prefix)
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  git("init", "-q", "-b", "main")
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
  const snapshot = snapshotOf(undeclared)
  expect(() => assertDeclareIsAuthoring(directory, undeclared)).toThrow(/origin\/main/)
  expect(() => assertDeclareIsAuthoring(directory, undeclared)).toThrow(
    new RegExp(`Suite ${undeclared} cannot be declared or admitted on this checkout`),
  )
  expect(() => assertDeclareIsAuthoring(directory, undeclared)).toThrow(/admit-run\.ts --for/)
  expect(() => declareCurrentSuiteManifest(directory, snapshot)).toThrow(/origin\/main/)

  writeFileSync(join(directory, "b.txt"), "two\n")
  git("add", "b.txt")
  git("commit", "-q", "-m", "two")
  expect(() => assertDeclareIsAuthoring(directory)).not.toThrow()
  const declared = declareCurrentSuiteManifest(directory, snapshot)
  expect(declared.status).toBe("created")
  expect(existsSync(declared.path)).toBe(true)
})

test("a freeze act writes the release pointer on a suite that admission already declared", () => {
  const directory = authoringRepo("terminfo-suite-freeze-")
  const snapshot = snapshotOf("b".repeat(12))
  // Admission declares a suite without claiming it as any release's current one; the freeze is a
  // SEPARATE later act on that same manifest, which is the transition this test exists for.
  expect(derivedSuiteManifest(snapshot).freeze).toBeUndefined()
  const declared = declareCurrentSuiteManifest(directory, snapshot)
  expect(declared.status).toBe("created")

  const at = "2026-10-17T21:12:41.181Z"
  const frozen = freezeCurrentSuiteManifest(directory, "candidate4", { snapshot, at })
  expect(frozen.status).toBe("frozen")
  // A caller can pin the instant, so the record is a pure function of its inputs.
  expect(parseSuiteManifest(declared.path, readFileSync(declared.path, "utf8")).freeze).toEqual({
    release: "candidate4",
    at,
  })
  expect(frozen.suiteId).toBe(snapshot.probeHash)
  expect(frozenSuiteIdFor(join(directory, "content"), "candidate4")).toBe(snapshot.probeHash)
  // Idempotent: freezing the same release again writes nothing and still resolves.
  expect(freezeCurrentSuiteManifest(directory, "candidate4", { snapshot, at }).status).toBe("existing")
})

test("a second claimant fails before any write and leaves the registry bytes unchanged", () => {
  const directory = authoringRepo("terminfo-suite-two-claimants-")
  const first = snapshotOf("c".repeat(12))
  const second = snapshotOf("d".repeat(12))
  expect(freezeCurrentSuiteManifest(directory, "candidate4", { snapshot: first }).suiteId).toBe(first.probeHash)
  const registry = join(directory, "content", "suites")
  const names = readdirSync(registry).sort()
  const bytes = names.map((name) => readFileSync(join(registry, name), "utf8"))
  // Fail-now: the reader's own scan runs before the write, so the refusal names the existing claimant
  // and NOT ONE BYTE changes — no second declaration file appears.
  expect(() => freezeCurrentSuiteManifest(directory, "candidate4", { snapshot: second })).toThrow(
    new RegExp(`2 suite manifests claim release "candidate4": ${first.probeHash}, ${second.probeHash}`),
  )
  expect(readdirSync(registry).sort()).toEqual(names)
  expect(names.map((name) => readFileSync(join(registry, name), "utf8"))).toEqual(bytes)
})

test("re-freezing a suite for another release cannot leave the old one with no suite", () => {
  const directory = authoringRepo("terminfo-suite-move-freeze-")
  const snapshot = snapshotOf("a".repeat(12))
  expect(freezeCurrentSuiteManifest(directory, "candidate2", { snapshot }).suiteId).toBe(snapshot.probeHash)
  const registry = join(directory, "content", "suites")
  const names = readdirSync(registry).sort()
  const bytes = names.map((name) => readFileSync(join(registry, name), "utf8"))
  // The write would leave candidate2 with zero suites. That is the reader's own zero-claimant state,
  // so the same refusal fires here, before any byte moves, and names both releases and the suite.
  expect(() => freezeCurrentSuiteManifest(directory, "candidate4", { snapshot })).toThrow(
    /no suite manifest declares freeze\.release "candidate2" would remain/,
  )
  expect(readdirSync(registry).sort()).toEqual(names)
  expect(names.map((name) => readFileSync(join(registry, name), "utf8"))).toEqual(bytes)
  expect(frozenSuiteIdFor(join(directory, "content"), "candidate2")).toBe(snapshot.probeHash)
})

test("a move that would leave the old release with two claimants is refused before any write", () => {
  const directory = authoringRepo("terminfo-suite-move-freeze-crowded-")
  const at = "2026-10-17T21:12:41.181Z"
  const a = snapshotOf("a".repeat(12))
  const b = snapshotOf("b".repeat(12))
  const c = snapshotOf("c".repeat(12))
  // A registry that already carries two claimants is unreadable; the writer must still refuse to make
  // it worse, and the two-claimants-to-one repair must remain a write this check allows.
  const claim = (snapshot: ProbeSuiteSnapshot): void => {
    const path = join(directory, "content", "suites", `${snapshot.probeHash}.json`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(derivedSuiteManifest(snapshot, { release: "candidate2", at }), null, 2)}\n`)
  }
  for (const snapshot of [a, b, c]) claim(snapshot)
  const registry = join(directory, "content", "suites")
  const names = readdirSync(registry).sort()
  const bytes = names.map((name) => readFileSync(join(registry, name), "utf8"))
  // Moving one suite out leaves candidate2 with two claimants: the reader's own two-claimant refusal,
  // evaluated before the write, so not one byte changes.
  expect(() => freezeCurrentSuiteManifest(directory, "candidate4", { snapshot: a })).toThrow(
    new RegExp(`2 suite manifests would claim release "candidate2": ${b.probeHash}, ${c.probeHash}`),
  )
  expect(readdirSync(registry).sort()).toEqual(names)
  expect(names.map((name) => readFileSync(join(registry, name), "utf8"))).toEqual(bytes)
  // With one claimant removed out of band, the same move leaves exactly one and succeeds.
  rmSync(join(registry, `${c.probeHash}.json`))
  const frozen = freezeCurrentSuiteManifest(directory, "candidate4", { snapshot: a })
  expect(frozen.suiteId).toBe(a.probeHash)
  expect(frozenSuiteIdFor(join(directory, "content"), "candidate2")).toBe(b.probeHash)
})

test("the declaration API cannot write a release claim, so no writer bypasses the checked act", () => {
  const directory = authoringRepo("terminfo-suite-no-bypass-")
  const first = snapshotOf("e".repeat(12))
  const second = snapshotOf("f".repeat(12))
  // Admission declares; it has no way to claim a release. If it could, it would be a second write
  // path around the claimant scan the freeze act performs.
  expect(declareCurrentSuiteManifest(directory, first).status).toBe("created")
  expect(declareCurrentSuiteManifest(directory, second).status).toBe("created")
  for (const snapshot of [first, second]) {
    const path = join(directory, "content", "suites", `${snapshot.probeHash}.json`)
    expect(parseSuiteManifest(path, readFileSync(path, "utf8")).freeze).toBeUndefined()
  }
  // Two declarations, and the registry still refuses the release: nothing claimed it on the way past.
  expect(() => frozenSuiteIdFor(join(directory, "content"), "candidate4")).toThrow(
    /no suite manifest declares freeze\.release "candidate4"/,
  )
})

test("the freeze verb is its own mode, and --check still parses as before", () => {
  expect(suiteManifestMode(["--check"])).toBe("check")
  expect(suiteManifestMode(["--freeze", "candidate4"])).toBe("freeze")
  expect(suiteManifestMode(["--freeze"])).toBe("usage")
  expect(suiteManifestMode(["--freeze", " "])).toBe("usage")
  expect(suiteManifestMode([])).toBe("usage")
  expect(suiteManifestMode(["--check", "extra"])).toBe("usage")
})

test("the source-tree collector derives the same manifest that the admission writer persists", () => {
  const snapshot = probeSuiteSnapshot()
  const directory = temp("terminfo-serve-writer-parity-")
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  git("init", "-q", "-b", "main")
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
    // A freeze act adds metadata the writer cannot derive, so the receipt is the derived declaration
    // plus that release's committed freeze record, carried verbatim rather than dropped.
    const committedPath = join(REPO_ROOT, "content", "suites", `${snapshot.probeHash}.json`)
    const committed = existsSync(committedPath)
      ? parseSuiteManifest(committedPath, readFileSync(committedPath, "utf8"))
      : undefined
    expect(receipt.manifest).toEqual(
      committed?.freeze ? { ...writerManifest, freeze: committed.freeze } : writerManifest,
    )
  } finally {
    if (prevHash === undefined) delete process.env.TERMINFO_PROBE_HASH
    else process.env.TERMINFO_PROBE_HASH = prevHash
    if (prevRev === undefined) delete process.env.TERMINFO_SOURCE_REVISION
    else process.env.TERMINFO_SOURCE_REVISION = prevRev
  }
})

test("committed disposable receipts verify unchanged and new receipts without manifestSha256 verify", () => {
  const receiptsDir = join(REPO_ROOT, "content", "receipts")
  const receiptFiles = readdirSync(receiptsDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
  expect(receiptFiles.length).toBeGreaterThan(0)
  let linuxReceiptPath: string | undefined
  for (const file of receiptFiles) {
    const path = join(receiptsDir, file)
    const parsed = readDisposableReceipt(path)
    if (parsed.kind === "linux-xvfb-container" && !linuxReceiptPath) linuxReceiptPath = path
  }
  expect(linuxReceiptPath).toBeDefined()
  const existing = readDisposableReceipt(linuxReceiptPath!)
  expect(existing.kind).toBe("linux-xvfb-container")

  const raw = JSON.parse(readFileSync(linuxReceiptPath!, "utf8")) as {
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
