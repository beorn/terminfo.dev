/**
 * @failure A suite declaration can be overwritten with new metadata or a wrong applicable probe set; a manifest may carry half of the legacy provenance; the composed-tree check may go red because the tree's own suite is uncited; a declare may run on a commit origin/main already holds; or a development build may demand a declaration commit for the derived in-development suite.
 * @level l1
 * @consumer Current probe suite manifest producer, admission, and deploy validation
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/ vendor/terminfo.dev/packages/probes/ vendor/terminfo.dev/packages/terminfo.dev/src/
 * @reach fs-walk <fixture-only: mkdtempSync Git repos prove the declare guard and the cited-manifest gate>
 * @testonly none
 */
import { execFileSync } from "node:child_process"
import {
  chmodSync,
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
import {
  assertDeclareIsAuthoring,
  checkCitedSuiteManifests,
  declareCurrentSuiteManifest,
  derivedSuiteManifest,
  freezeCurrentSuiteManifest,
  frozenSuiteIdFor,
  frozenSuiteLineage,
  moveReleasePointer,
  moveSummary,
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
  expect(Object.keys(manifest).sort()).toEqual([
    "adapterVersion",
    "probeHash",
    "probes",
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
    probes: { app: ["character", "attributes"], headless: [], mux: ["character", "attributes"] },
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

const declareFixture = (directory: string, probeHash: string): ProbeSuiteSnapshot => {
  const snapshot = snapshotOf(probeHash)
  if (!existsSync(join(directory, "content", "suites", `${probeHash}.json`))) {
    persistSuiteManifest(
      join(directory, "content", "suites", `${probeHash}.json`),
      derivedSuiteManifest(snapshot),
      snapshot,
    )
  }
  return snapshot
}

test("a pointer move records the suite it left, and each later move carries the whole lineage", () => {
  const directory = authoringRepo("terminfo-suite-pointer-lineage-")
  const contentDir = join(directory, "content")
  const first = snapshotOf("a".repeat(12))
  const second = declareFixture(directory, "b".repeat(12))
  const third = declareFixture(directory, "c".repeat(12))
  const firstAt = "2026-10-16T09:30:22.506Z"
  const secondAt = "2026-10-18T02:27:38.228Z"
  const thirdAt = "2026-10-18T03:00:00.000Z"
  expect(freezeCurrentSuiteManifest(directory, "candidate2", { snapshot: first, at: firstAt }).suiteId).toBe(
    first.probeHash,
  )
  const moved = moveReleasePointer(directory, "candidate2", { snapshot: second, at: secondAt })
  expect(moved).toEqual({
    status: "moved",
    from: first.probeHash,
    to: second.probeHash,
    path: join(contentDir, "suites", `${second.probeHash}.json`),
  })
  // The new record names its predecessor in the same write: the window it held the pointer, not just
  // its id, so the history is recorded rather than inferred from a pointer that can move again.
  expect(parseSuiteManifest(moved.path, readFileSync(moved.path, "utf8")).freeze).toEqual({
    release: "candidate2",
    at: secondAt,
    previous: [{ suite: first.probeHash, from: firstAt, until: secondAt }],
  })
  // A second move carries that list forward and appends the suite it leaves. Nothing walks another
  // manifest: the move deletes the old record, so a walk would lose the first suite here.
  moveReleasePointer(directory, "candidate2", { snapshot: third, at: thirdAt })
  const thirdPath = join(contentDir, "suites", `${third.probeHash}.json`)
  expect(parseSuiteManifest(thirdPath, readFileSync(thirdPath, "utf8")).freeze).toEqual({
    release: "candidate2",
    at: thirdAt,
    previous: [
      { suite: first.probeHash, from: firstAt, until: secondAt },
      { suite: second.probeHash, from: secondAt, until: thirdAt },
    ],
  })
  for (const left of [first, second]) {
    const path = join(contentDir, "suites", `${left.probeHash}.json`)
    expect(parseSuiteManifest(path, readFileSync(path, "utf8")).freeze).toBeUndefined()
  }
  expect(frozenSuiteIdFor(contentDir, "candidate2")).toBe(third.probeHash)
  expect(frozenSuiteLineage(contentDir, "candidate2")).toEqual([third.probeHash, second.probeHash, first.probeHash])
})

test("a same-release freeze after a move is a no-op and keeps the move-written lineage", () => {
  const directory = authoringRepo("terminfo-suite-pointer-refreeze-")
  const contentDir = join(directory, "content")
  const first = snapshotOf("a".repeat(12))
  const second = declareFixture(directory, "b".repeat(12))
  const firstAt = "2026-10-16T09:30:22.506Z"
  const movedAt = "2026-10-18T02:27:38.228Z"
  freezeCurrentSuiteManifest(directory, "candidate2", { snapshot: first, at: firstAt })
  moveReleasePointer(directory, "candidate2", { snapshot: second, at: movedAt })
  const path = join(contentDir, "suites", `${second.probeHash}.json`)
  const movedBytes = readFileSync(path, "utf8")
  // Re-running the ordinary freeze on the suite the pointer already names must return "existing": a
  // rewrite would drop `previous` and reset `at`, silently erasing the move that was just recorded.
  const again = freezeCurrentSuiteManifest(directory, "candidate2", {
    snapshot: second,
    at: "2026-10-18T04:00:00.000Z",
  })
  expect(again.status).toBe("existing")
  expect(readFileSync(path, "utf8")).toBe(movedBytes)
  expect(frozenSuiteLineage(contentDir, "candidate2")).toEqual([second.probeHash, first.probeHash])
})

test("a move onto a suite another release claims is refused before either claim changes", () => {
  const directory = authoringRepo("terminfo-suite-pointer-claimed-")
  const contentDir = join(directory, "content")
  const first = snapshotOf("a".repeat(12))
  const second = declareFixture(directory, "b".repeat(12))
  freezeCurrentSuiteManifest(directory, "candidate2", { snapshot: first, at: "2026-10-16T09:30:22.506Z" })
  freezeCurrentSuiteManifest(directory, "candidate4", { snapshot: second, at: "2026-10-17T09:00:00.000Z" })
  // One manifest carries one freeze: taking candidate4's suite would leave candidate4 with no suite.
  expect(() =>
    moveReleasePointer(directory, "candidate2", { snapshot: second, at: "2026-10-18T02:27:38.228Z" }),
  ).toThrow(/already declares freeze\.release "candidate4".*leave "candidate4" with no suite/)
  expect(frozenSuiteIdFor(contentDir, "candidate2")).toBe(first.probeHash)
  expect(frozenSuiteIdFor(contentDir, "candidate4")).toBe(second.probeHash)
})

test("a move back onto a suite already in the lineage is refused before the write", () => {
  const directory = authoringRepo("terminfo-suite-pointer-cycle-")
  const contentDir = join(directory, "content")
  const first = snapshotOf("a".repeat(12))
  const second = declareFixture(directory, "b".repeat(12))
  const third = declareFixture(directory, "c".repeat(12))
  freezeCurrentSuiteManifest(directory, "candidate2", { snapshot: first, at: "2026-10-16T09:30:22.506Z" })
  moveReleasePointer(directory, "candidate2", { snapshot: second, at: "2026-10-18T02:27:38.228Z" })
  moveReleasePointer(directory, "candidate2", { snapshot: third, at: "2026-10-18T03:00:00.000Z" })
  const thirdPath = join(contentDir, "suites", `${third.probeHash}.json`)
  const before = readFileSync(thirdPath, "utf8")
  // A repeat would leave a lineage the parser refuses, so it is refused before any byte moves.
  expect(() =>
    moveReleasePointer(directory, "candidate2", { snapshot: second, at: "2026-10-18T04:00:00.000Z" }),
  ).toThrow(/would repeat suite/)
  expect(readFileSync(thirdPath, "utf8")).toBe(before)
  expect(frozenSuiteIdFor(contentDir, "candidate2")).toBe(third.probeHash)
  expect(frozenSuiteLineage(contentDir, "candidate2")).toEqual([third.probeHash, second.probeHash, first.probeHash])
})

test("a move writes the new claim before it clears the old one, so a failed write strands no release", () => {
  const directory = authoringRepo("terminfo-suite-pointer-write-order-")
  const contentDir = join(directory, "content")
  const first = snapshotOf("a".repeat(12))
  const second = declareFixture(directory, "b".repeat(12))
  freezeCurrentSuiteManifest(directory, "candidate2", { snapshot: first, at: "2026-10-16T09:30:22.506Z" })
  const secondPath = join(contentDir, "suites", `${second.probeHash}.json`)
  // The new record's write is the crash boundary. Make it fail for real (the suite is not writable),
  // leaving the old claim as the only thing that could have changed: clearing it first would leave
  // the release with no suite at all, which every reader refuses.
  chmodSync(secondPath, 0o444)
  try {
    expect(() =>
      moveReleasePointer(directory, "candidate2", { snapshot: second, at: "2026-10-18T02:27:38.228Z" }),
    ).toThrow()
  } finally {
    chmodSync(secondPath, 0o644)
  }
  expect(frozenSuiteIdFor(contentDir, "candidate2")).toBe(first.probeHash)
  expect(parseSuiteManifest(secondPath, readFileSync(secondPath, "utf8")).freeze).toBeUndefined()
})

test("the parser refuses a freeze lineage that is not the carried list", () => {
  const base = { probeHash: "a".repeat(12), adapterVersion: "1.0.0", probes: { app: ["x"], headless: [], mux: ["x"] } }
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
  const base = { probeHash: own, adapterVersion: "1.0.0", probes: { app: ["x"], headless: [], mux: ["x"] } }
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

test("a move needs a pointer to move: a release no suite claims is refused and nothing is written", () => {
  const directory = authoringRepo("terminfo-suite-pointer-unclaimed-")
  const contentDir = join(directory, "content")
  const first = snapshotOf("a".repeat(12))
  const second = declareFixture(directory, "b".repeat(12))
  freezeCurrentSuiteManifest(directory, "candidate2", { snapshot: first, at: "2026-10-16T09:30:22.506Z" })
  const secondPath = join(contentDir, "suites", `${second.probeHash}.json`)
  const before = readFileSync(secondPath, "utf8")
  // A typo is not a first freeze: "candidat2" has no suite, so there is no pointer to move.
  expect(() =>
    moveReleasePointer(directory, "candidat2", { snapshot: second, at: "2026-10-18T02:27:38.228Z" }),
  ).toThrow(/no suite manifest declares freeze\.release "candidat2".*--freeze candidat2/)
  expect(readFileSync(secondPath, "utf8")).toBe(before)
})

test("a move whose instant precedes the freeze it ends is refused before any byte moves", () => {
  const directory = authoringRepo("terminfo-suite-pointer-backwards-")
  const contentDir = join(directory, "content")
  const first = snapshotOf("a".repeat(12))
  const second = declareFixture(directory, "b".repeat(12))
  freezeCurrentSuiteManifest(directory, "candidate2", { snapshot: first, at: "2026-10-18T02:27:38.228Z" })
  const secondPath = join(contentDir, "suites", `${second.probeHash}.json`)
  const before = readFileSync(secondPath, "utf8")
  // The window it would record ends before it starts: a record every reader refuses, so none is written.
  expect(() =>
    moveReleasePointer(directory, "candidate2", { snapshot: second, at: "2026-10-16T09:30:22.506Z" }),
  ).toThrow(/previous window/)
  expect(readFileSync(secondPath, "utf8")).toBe(before)
  expect(frozenSuiteIdFor(contentDir, "candidate2")).toBe(first.probeHash)
})

test("the move command says nothing moved when the pointer already names the suite", () => {
  const a = "a".repeat(12)
  const b = "b".repeat(12)
  expect(moveSummary("candidate2", { status: "existing", from: a, to: a, path: `/x/${a}.json` })).toBe(
    `Suite ${a}.json already declares freeze.release "candidate2"; nothing moved`,
  )
  expect(moveSummary("candidate2", { status: "moved", from: a, to: b, path: `/x/${b}.json` })).toBe(
    `Suite ${b}.json declares freeze.release "candidate2"; candidate2 moved off suite ${a} to ${b}`,
  )
})

test("a move onto the suite whose own record already declares the release writes nothing and says nothing moved", () => {
  const directory = authoringRepo("terminfo-suite-pointer-noop-")
  const suitesDir = join(directory, "content", "suites")
  const first = snapshotOf("a".repeat(12))
  declareFixture(directory, "b".repeat(12))
  freezeCurrentSuiteManifest(directory, "candidate2", { snapshot: first, at: "2026-10-16T09:30:22.506Z" })
  // The scan and the suite's own record agree, so the check in front of the no-op lets it through:
  // the existing result, no byte written, and the summary the command prints says nothing moved.
  const registry = (): string[][] =>
    readdirSync(suitesDir)
      .sort()
      .map((name) => [name, readFileSync(join(suitesDir, name), "utf8")])
  const before = registry()
  const moved = moveReleasePointer(directory, "candidate2", { snapshot: first, at: "2026-10-18T02:27:38.228Z" })
  expect(moved).toEqual({
    status: "existing",
    from: first.probeHash,
    to: first.probeHash,
    path: join(suitesDir, `${first.probeHash}.json`),
  })
  expect(registry()).toEqual(before)
  expect(moveSummary("candidate2", moved)).toBe(
    `Suite ${first.probeHash}.json already declares freeze.release "candidate2"; nothing moved`,
  )
})

test.each([
  { name: "no freeze, moving away", own: undefined, onto: "b" },
  { name: "no freeze, onto the claimed suite", own: undefined, onto: "a" },
  {
    name: "another release, onto the claimed suite",
    own: { release: "candidate4", at: "2026-10-17T09:00:00.000Z" },
    onto: "a",
  },
] as const)("a move refuses when the claim scan and the claimed suite's own record disagree ($name)", (variant) => {
  const directory = authoringRepo("terminfo-suite-pointer-disagree-")
  const contentDir = join(directory, "content")
  const suitesDir = join(contentDir, "suites")
  const first = snapshotOf("a".repeat(12))
  const second = declareFixture(directory, "b".repeat(12))
  freezeCurrentSuiteManifest(directory, "candidate2", { snapshot: first, at: "2026-10-16T09:30:22.506Z" })
  // The claim lives in a file not named for its suite, so the suite's own record carries no freeze or
  // another release. Moving away from it, or onto it as a would-be no-op, must refuse by name.
  const firstPath = join(suitesDir, `${first.probeHash}.json`)
  const claimed = readFileSync(firstPath, "utf8")
  writeFileSync(join(suitesDir, "misnamed.json"), claimed)
  const own = JSON.parse(claimed) as Record<string, unknown>
  if (variant.own === undefined) delete own.freeze
  else own.freeze = variant.own
  writeFileSync(firstPath, `${JSON.stringify(own, null, 2)}\n`)
  expect(frozenSuiteIdFor(contentDir, "candidate2")).toBe(first.probeHash)
  const registry = (): string[][] =>
    readdirSync(suitesDir)
      .sort()
      .map((name) => [name, readFileSync(join(suitesDir, name), "utf8")])
  const before = registry()
  const carries = variant.own === undefined ? "no freeze" : `freeze\\.release "${variant.own.release}"`
  expect(() =>
    moveReleasePointer(directory, "candidate2", {
      snapshot: variant.onto === "a" ? first : second,
      at: "2026-10-18T02:27:38.228Z",
    }),
  ).toThrow(new RegExp(`claim scan names suite a{12} for release "candidate2", but its record carries ${carries};`))
  expect(registry()).toEqual(before)
})

test("the parser refuses a gap between windows that are otherwise in order and end at the freeze", () => {
  const base = { probeHash: "a".repeat(12), adapterVersion: "1.0.0", probes: { app: ["x"], headless: [], mux: ["x"] } }
  const at = "2026-10-18T03:00:00.000Z"
  const first = { suite: "b".repeat(12), from: "2026-10-16T09:30:22.506Z", until: "2026-10-18T02:27:38.228Z" }
  // Each window runs forwards and the last ends at this freeze, but the second does not start where the
  // first ended: only the order rule can refuse it.
  const gapped = { suite: "c".repeat(12), from: "2026-10-18T02:40:00.000Z", until: at }
  const source = JSON.stringify({ ...base, freeze: { release: "candidate2", at, previous: [first, gapped] } })
  expect(() => parseSuiteManifest("x.json", source)).toThrow(/previous window for suite c{12}/)
})

test("an ordinary freeze checks the bytes it writes, so a bad instant never lands", () => {
  const directory = authoringRepo("terminfo-suite-freeze-bytes-")
  const second = declareFixture(directory, "b".repeat(12))
  const path = join(directory, "content", "suites", `${second.probeHash}.json`)
  const before = readFileSync(path, "utf8")
  expect(() => freezeCurrentSuiteManifest(directory, "candidate2", { snapshot: second, at: "2026-10-18" })).toThrow(
    /invalid suite freeze at/,
  )
  expect(readFileSync(path, "utf8")).toBe(before)
})

test("--move takes exactly one release, through the same parser as --freeze", () => {
  expect(suiteManifestMode(["--move", "candidate2"])).toBe("move")
  expect(suiteManifestMode(["--move"])).toBe("usage")
  expect(suiteManifestMode(["--move", " "])).toBe("usage")
  expect(suiteManifestMode(["--move", "candidate2", "extra"])).toBe("usage")
})

test("the live registry records the candidate2 pointer move it already made", () => {
  // The live registry carries both moves: the hand edit that put candidate2 on 67ad, and the
  // supported writer's --move onto c24025ea22fc (28018). The current record names every suite it
  // left and the window each held the pointer, so the lineage is recoverable from content alone
  // rather than only from the Git history of the hand edit.
  expect(frozenSuiteLineage(join(REPO_ROOT, "content"), "candidate2")).toEqual([
    "c24025ea22fc",
    "67ad1f1d1580",
    "68847e4d5355",
    "5753741410a9",
  ])
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

/**
 * 28018: the writer could only ever freeze the suite the collector builds NOW, so a ruling that names an
 * older suite the registry still carries had no expressible write. These rows pin the explicit target.
 */
const EXPLICIT_AT = "2026-10-18T21:00:00.000Z"

test("an explicit --suite freezes a suite the collector no longer builds, and the reader resolves it", () => {
  const directory = authoringRepo("terminfo-suite-explicit-freeze-")
  const live = snapshotOf("c".repeat(12))
  const older = snapshotOf("d".repeat(12))
  declareCurrentSuiteManifest(directory, live)
  declareCurrentSuiteManifest(directory, older)
  // The live snapshot is neither supplied nor consulted: the named suite IS the target.
  const frozen = freezeCurrentSuiteManifest(directory, "candidate2", { suite: older.probeHash, at: EXPLICIT_AT })
  expect(frozen.status).toBe("frozen")
  expect(frozen.suiteId).toBe(older.probeHash)
  expect(frozenSuiteIdFor(join(directory, "content"), "candidate2")).toBe(older.probeHash)
  expect(parseSuiteManifest(frozen.path, readFileSync(frozen.path, "utf8")).freeze).toEqual({
    release: "candidate2",
    at: EXPLICIT_AT,
  })
})

test("an explicit --suite refuses an unknown id, a malformed id and a record misfiled under another id", () => {
  const directory = authoringRepo("terminfo-suite-explicit-refuse-")
  const known = snapshotOf("e".repeat(12))
  declareCurrentSuiteManifest(directory, known)
  expect(() => freezeCurrentSuiteManifest(directory, "candidate2", { suite: "f".repeat(12) })).toThrow(
    /no suite manifest carries that id/,
  )
  expect(() => freezeCurrentSuiteManifest(directory, "candidate2", { suite: "not-a-suite" })).toThrow(
    /twelve lowercase hex/,
  )
  writeFileSync(
    join(directory, "content", "suites", `${known.probeHash}.json`),
    JSON.stringify({ probeHash: "1".repeat(12), adapterVersion: "1.0.0", probes: { app: [], headless: [], mux: [] } }),
  )
  expect(() => freezeCurrentSuiteManifest(directory, "candidate2", { suite: known.probeHash })).toThrow(
    /declares suite 111111111111, not eeeeeeeeeeee/,
  )
})

test("a move onto an explicitly named suite lands the pointer and releases the old claim", () => {
  const directory = authoringRepo("terminfo-suite-explicit-move-")
  const from = snapshotOf("2".repeat(12))
  const to = snapshotOf("3".repeat(12))
  declareCurrentSuiteManifest(directory, from)
  declareCurrentSuiteManifest(directory, to)
  freezeCurrentSuiteManifest(directory, "candidate2", { snapshot: from, at: EXPLICIT_AT })
  const moved = moveReleasePointer(directory, "candidate2", { suite: to.probeHash, at: EXPLICIT_AT })
  expect(moved).toMatchObject({ status: "moved", from: from.probeHash, to: to.probeHash })
  expect(frozenSuiteIdFor(join(directory, "content"), "candidate2")).toBe(to.probeHash)
  const old = JSON.parse(
    readFileSync(join(directory, "content", "suites", `${from.probeHash}.json`), "utf8"),
  ) as Record<string, unknown>
  expect(old.freeze).toBeUndefined()
  expect(parseSuiteManifest(moved.path, readFileSync(moved.path, "utf8")).freeze?.previous).toEqual([
    { suite: from.probeHash, from: EXPLICIT_AT, until: EXPLICIT_AT },
  ])
})

test("the mode parser accepts --suite only on a write verb and always requires its value", () => {
  expect(suiteManifestMode(["--freeze", "candidate2", "--suite", "a".repeat(12)])).toBe("freeze")
  expect(suiteManifestMode(["--move", "candidate2", "--suite", "a".repeat(12)])).toBe("move")
  expect(suiteManifestMode(["--freeze", "candidate2", "--suite"])).toBe("usage")
  expect(suiteManifestMode(["--check", "--suite", "a".repeat(12)])).toBe("usage")
  expect(suiteManifestMode(["--freeze", "candidate2", "--apply"])).toBe("usage")
})
