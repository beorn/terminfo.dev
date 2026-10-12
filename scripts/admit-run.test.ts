/**
 * @failure A run can be admitted against a suite this tree does not run, so its manifest is computed from the wrong probe-defs; or a concurrent admission of the same run can overwrite different bytes; or the run can be misnamed; or the ownership receipt a run cites can go unread, so a hand-typed identity that nothing measured is admitted beside the run it claims to authorize.
 * @level l1
 * @consumer The one declare-and-admit entry point (27859)
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/ vendor/terminfo.dev/packages/probes/
 * @reach fs-walk <fixture-only: mkdtempSync run, destination, and Git authoring directories>
 * @testonly none
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import * as suiteManifest from "./suite-manifest.ts"
import * as versions from "../packages/admin/versions.ts"
import { decodeCollectorRun, parseJsonStrict, parseRun, parseSuiteManifest } from "@terminfo/run-parser"
import { saveDaemonProbeRun } from "terminfo.dev/src/daemon-client.ts"
import { probeSuiteSnapshot } from "../packages/admin/versions.ts"
import {
  admitRun,
  assessRunAdmission,
  placeOwnershipReceipt,
  placeRun,
  placeScreenshots,
  planAdmission,
} from "./admit-run.ts"
import { object } from "./interpretations.ts"
import { parseDisposableReceipt } from "terminfo.dev/src/disposable-receipt.ts"
import { derivedSuiteManifest } from "./suite-manifest.ts"
import { frozenSuiteIdFor } from "../docs/data/load-release-scope.ts"

const temporaryPaths: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true })
})
const temp = (prefix: string): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryPaths.push(directory)
  return directory
}

// Planning success must not depend on whether the test runner's checkout has already landed.
// Redirect only the existing authoring seam; the real guard sees real fixture ancestry.
function authoringFixture(): void {
  const directory = temp("terminfo-admission-authoring-")
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  git("init", "-q", "-b", "main")
  git("config", "user.email", "fixture@example.invalid")
  git("config", "user.name", "fixture")
  writeFileSync(join(directory, "fixture.txt"), "main\n")
  git("add", "fixture.txt")
  git("commit", "-q", "-m", "main fixture")
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD").trim())
  const assertAuthoring = suiteManifest.assertDeclareIsAuthoring
  expect(() => assertAuthoring(directory)).toThrow(/origin\/main/)
  writeFileSync(join(directory, "fixture.txt"), "authoring\n")
  git("add", "fixture.txt")
  git("commit", "-q", "-m", "authoring fixture")
  vi.spyOn(suiteManifest, "assertDeclareIsAuthoring").mockImplementation((_root, hash) =>
    assertAuthoring(directory, hash),
  )
}

function declaredRelease(): string {
  const suites = join(import.meta.dirname, "..", "content", "suites")
  const releases = readdirSync(suites).flatMap((name) => {
    if (!name.endsWith(".json")) return []
    const path = join(suites, name)
    const manifest = parseSuiteManifest(path, readFileSync(path, "utf8"))
    return manifest.freeze ? [manifest.freeze.release] : []
  })
  if (releases.length !== 1) throw new Error(`Expected one declared release in ${suites}, found ${releases.length}`)
  return releases[0]!
}

function runFixture(overrides: Record<string, unknown> = {}): string {
  const directory = temp("terminfo-admit-")
  const path = join(directory, "run.json")
  const content = join(import.meta.dirname, "..", "content")
  const original = join(content, "probes-apps", "kitty-0.49.2-linux-dfd4cd08416fb5f3be3eaeed5acce782.json")
  const originalBytes = readFileSync(original, "utf8")
  const complete = parseJsonStrict(original, originalBytes)
  if (
    !object(complete) ||
    typeof complete.probeHash !== "string" ||
    !object(complete.provenance) ||
    !object(complete.provenance.runtime)
  ) {
    throw new Error("Complete clean admission fixture has no runtime provenance")
  }
  const manifestPath = join(content, "suites", `${complete.probeHash}.json`)
  const manifest = parseSuiteManifest(manifestPath, readFileSync(manifestPath, "utf8"))
  const catalog = parseJsonStrict("feature catalog", readFileSync(join(content, "features.json"), "utf8"))
  if (!object(catalog)) throw new Error("Admission fixture catalog is not an object")
  const loaded = parseRun(
    original,
    originalBytes,
    Object.keys(catalog).filter((id) => !id.startsWith("$")),
    new Map([[manifest.probeHash, manifest]]),
  )
  const hostBytes = readFileSync(join(content, "receipts", `${loaded.runId}.json`))
  parseDisposableReceipt(hostBytes.toString("utf8"))
  const hostPath = join(directory, "host-measured.json")
  writeFileSync(hostPath, hostBytes)
  mkdirSync(join(directory, "artifacts"))
  for (const ref of loaded.screenshotRefs) {
    const filename = `${ref.slice("sha256:".length)}.png`
    copyFileSync(join(content, "artifacts", filename), join(directory, "artifacts", filename))
  }
  // Only this test run's ID/suite are synthetic. Ownership and PNG bytes remain the committed
  // specimen's genuine retained evidence; this fixture makes no claim to have run the live suite.
  const liveSuite = probeSuiteSnapshot().probeHash
  complete.provenance.runtime.suiteHash = liveSuite
  const fixture = { ...complete, suiteId: liveSuite, probeHash: liveSuite, runId: "run1", ...overrides }
  const bytes = JSON.stringify(fixture)
  writeFileSync(path, bytes)
  // Synthetic test-only composer output, not a production completion receipt or measured claim.
  const host = parseJsonStrict(hostPath, hostBytes.toString("utf8"))
  if (!object(host)) throw new Error("Admission fixture ownership receipt is not an object")
  writeFileSync(
    join(directory, "run-receipt.json"),
    JSON.stringify({
      ...host,
      probeRun: { path: "run.json", runId: fixture.runId, sha256: createHash("sha256").update(bytes).digest("hex") },
      receiptInputs: { hostSha256: createHash("sha256").update(hostBytes).digest("hex") },
    }),
  )
  return path
}

// AC3: the real daemon writer enriches/reserializes raw collector bytes. Its private output
// cannot borrow the composer's original byte binding, and refusal must name the supported cure.
test("daemon-saved enriched run names the launcher cure without content placement", () => {
  const source = runFixture()
  const raw = readFileSync(source, "utf8")
  const document = parseJsonStrict(source, raw)
  if (!object(document) || typeof document.sourceRevision !== "string") {
    throw new Error("Collector fixture lacks source revision")
  }
  const decoded = decodeCollectorRun(source, raw, derivedSuiteManifest(probeSuiteSnapshot()), document.sourceRevision)
  const staged = saveDaemonProbeRun(
    {
      ...decoded.run,
      rawReplies: { ...decoded.run.rawReplies, "collector.httpResponseSha256": decoded.sha256 },
    },
    dirname(source),
  )
  const content = join(temp("terminfo-daemon-cure-"), "content")
  const destination = join(content, "probes-apps", "run.json")
  let refusal: unknown
  try {
    planAdmission(staged, destination)
  } catch (error) {
    refusal = error
  }
  expect(refusal).toBeInstanceOf(Error)
  if (!(refusal instanceof Error)) throw new Error("Daemon-saved run was unexpectedly accepted")
  expect(refusal.message).toMatch(/collect through the launcher to produce an admissible run/)
  expect(refusal.message).toContain(
    "bash scripts/linux-container-run.sh --target kitty --preset current --clipboard-profile default <outdir>",
  )
  expect(existsSync(destination)).toBe(false)
  expect(existsSync(content)).toBe(false)
})

// Placement must prove that the host composer completed THIS raw run, before authoring anything.
test.each(["missing", "malformed", "wrong-hash", "wrong-probe-run", "wrong-host-hash"] as const)(
  "planning refuses %s Linux completion evidence before any placement",
  (fault) => {
    const source = runFixture()
    const receipt = join(dirname(source), "run-receipt.json")
    const destination = join(temp("terminfo-completion-dest-"), "run.json")
    if (fault === "missing") rmSync(receipt)
    else if (fault === "malformed") writeFileSync(receipt, "{broken")
    else {
      const completion = parseJsonStrict(receipt, readFileSync(receipt, "utf8"))
      if (!object(completion) || !object(completion.probeRun) || !object(completion.receiptInputs)) {
        throw new Error("Synthetic composer fixture lacks completion binding")
      }
      if (fault === "wrong-hash") completion.probeRun.sha256 = "0".repeat(64)
      if (fault === "wrong-probe-run") completion.probeRun.runId = "different-run"
      if (fault === "wrong-host-hash") completion.receiptInputs.hostSha256 = "0".repeat(64)
      writeFileSync(receipt, JSON.stringify(completion))
    }
    expect(() => planAdmission(source, destination)).toThrow(/run-receipt\.json/)
    expect(existsSync(destination)).toBe(false)
  },
)

test("release admission cannot relabel the current suite as the declared freeze", () => {
  const release = declaredRelease()
  const declared = frozenSuiteIdFor(join(import.meta.dirname, "..", "content"), release)
  // Keep the actual declaration reader; isolate a different current snapshot so the test remains
  // meaningful when Thursday's freeze later catches up with the live source tree.
  const current = declared === "fa".repeat(6) ? "fb".repeat(6) : "fa".repeat(6)
  const snapshot = vi
    .spyOn(versions, "probeSuiteSnapshot")
    .mockReturnValue({ ...probeSuiteSnapshot(), probeHash: current })
  try {
    const source = runFixture()
    const destination = join(temp("terminfo-release-authority-"), "content", "run.json")
    expect(() => planAdmission(source, destination, { release, frozenSuiteId: current })).toThrow(
      /declared frozen suite/,
    )
    expect(() => planAdmission(source, destination, { release })).toThrow(/declared frozen suite/)
    expect(existsSync(destination)).toBe(false)
  } finally {
    snapshot.mockRestore()
  }
})

// Requirement 3: admitRun must retain the declared release when it validates a plan again.
// If release is dropped, the declaration sentinel prevents any content write and exposes the bug.
test("admission replans against the plan's declared release before declaring or placing", () => {
  authoringFixture()
  const release = declaredRelease()
  const declared = frozenSuiteIdFor(join(import.meta.dirname, "..", "content"), release)
  const current = declared === "fa".repeat(6) ? "fb".repeat(6) : "fa".repeat(6)
  vi.spyOn(versions, "probeSuiteSnapshot").mockReturnValue({ ...probeSuiteSnapshot(), probeHash: current })
  const declaration = vi.spyOn(suiteManifest, "declareCurrentSuiteManifest").mockImplementation(() => {
    throw new Error("Unexpected declaration before release validation")
  })
  const destination = join(temp("terminfo-release-replan-"), "run.json")
  const plan = planAdmission(runFixture(), destination)
  expect(() => admitRun({ ...plan, release })).toThrow(/declared frozen suite/)
  expect(declaration).not.toHaveBeenCalled()
  expect(existsSync(destination)).toBe(false)
})

test("planning refuses run/tree/frozen-suite disagreement before placement", () => {
  const source = runFixture()
  const destination = join(temp("terminfo-frozen-dest-"), "run.json")
  expect(() => planAdmission(source, destination, { frozenSuiteId: "f".repeat(12) })).toThrow(/frozen suite/)
  expect(existsSync(destination)).toBe(false)
  const foreignSuite = "c3d1fbb77561"
  const document = parseJsonStrict(source, readFileSync(source, "utf8"))
  if (!object(document) || !object(document.provenance) || !object(document.provenance.runtime)) {
    throw new Error("Synthetic frozen-suite fixture lacks runtime provenance")
  }
  document.probeHash = foreignSuite
  document.suiteId = foreignSuite
  document.provenance.runtime.suiteHash = foreignSuite
  writeFileSync(source, JSON.stringify(document))
  expect(() => planAdmission(source, destination, { frozenSuiteId: foreignSuite })).toThrow(/this tree runs suite/)
  expect(existsSync(destination)).toBe(false)
})

test("planning refuses a missing cited ownership receipt before placement", () => {
  const source = runFixture()
  const destination = join(temp("terminfo-owner-dest-"), "run.json")
  rmSync(join(dirname(source), "host-measured.json"))
  const content = join(import.meta.dirname, "..", "content")
  const catalog = parseJsonStrict("feature catalog", readFileSync(join(content, "features.json"), "utf8"))
  if (!object(catalog)) throw new Error("Ownership fixture catalog is not an object")
  const manifest = derivedSuiteManifest(probeSuiteSnapshot())
  const loaded = parseRun(
    source,
    readFileSync(source, "utf8"),
    Object.keys(catalog).filter((id) => !id.startsWith("$")),
    new Map([[manifest.probeHash, manifest]]),
  )
  const assessment = assessRunAdmission(loaded, [], {
    receiptPath: join(dirname(source), "host-measured.json"),
    contentDir: content,
    mode: "placement",
  })
  expect(assessment).toMatchObject({
    accepted: false,
    reason: "ownership-receipt-missing",
    detail: expect.stringContaining("host-measured.json"),
  })
  if (assessment.accepted) throw new Error("Missing ownership receipt was unexpectedly accepted")
  expect(() => planAdmission(source, destination)).toThrow(`${source}: ${assessment.detail ?? assessment.reason}`)
  expect(existsSync(destination)).toBe(false)
})

// AC1 and the CTO's shared-checklist amendment: these real historical runs are complete for their
// own suites but record dirty collection provenance. Planning must preserve that refusal before
// adding placement's current-suite requirement. The helper-placement tests cannot see this bypass.
test.each(["8c50df5834ccb938c208aa91467e9a2b", "2912118b74039bf72ac84070921836ce"])(
  "planning refuses dirty historical collection %s before placement",
  (runId) => {
    const source = join(import.meta.dirname, "..", "content", "probes-apps", `kitty-0.49.2-linux-${runId}.json`)
    const destination = join(temp("terminfo-dirty-plan-"), "run.json")
    expect(() => planAdmission(source, destination)).toThrow(/native-provenance-dirty/)
    expect(existsSync(destination)).toBe(false)
  },
)

// AC1: Windows has no XTVERSION profile. The measured portable executable version must supply
// whole-run identity, and comparison is byte-exact; macOS parser cases cannot prove this decision.
test("Windows admission requires its measured executable version to match exactly", () => {
  const content = join(import.meta.dirname, "..", "content")
  const source = join(
    content,
    "probes-apps",
    "windows-terminal-1.23.20211.0-windows-5ce6e5804f4f8eb592f0b83c1f68e166.json",
  )
  const bytes = readFileSync(source, "utf8")
  const document = parseJsonStrict(source, bytes)
  if (!object(document) || typeof document.probeHash !== "string") throw new Error("Windows fixture has no suite")
  const manifestPath = join(content, "suites", `${document.probeHash}.json`)
  const manifest = parseSuiteManifest(manifestPath, readFileSync(manifestPath, "utf8"))
  const catalog = parseJsonStrict("feature catalog", readFileSync(join(content, "features.json"), "utf8"))
  if (!object(catalog)) throw new Error("Windows fixture catalog is not an object")
  const run = parseRun(
    source,
    bytes,
    Object.keys(catalog).filter((id) => !id.startsWith("$")),
    new Map([[manifest.probeHash, manifest]]),
  )
  const receipt = {
    platform: "win32" as const,
    executablePath: String.raw`C:\runner\WindowsTerminal.exe`,
    productVersion: run.target.version,
    executableSha256: "c3".repeat(32),
    sourceArtifact: { kind: "portable-zip" as const, path: String.raw`C:\runner\wt.zip`, sha256: "d4".repeat(32) },
  }
  const directory = temp("terminfo-measured-launch-")
  const host = { ...hostedReceipt("Windows", "1003"), appLaunch: receipt }
  const ownership = ownershipBesideRun(join(directory, "run.json"), host)
  const measured = {
    ...run,
    origin: { ...run.origin, appLaunch: receipt },
    rawReplies: { ...run.rawReplies, "collector.disposableOwnership": ownership },
  }
  const evidence = {
    receiptPath: join(directory, "host-measured.json"),
    contentDir: directory,
    mode: "placement" as const,
  }
  expect.soft(assessRunAdmission(measured, [], evidence)).toMatchObject({ accepted: true })
  // AC1: two internally matching copied fields cannot replace the cited measured receipt.
  // Native mutation probes passed this gap; the earlier single-field version cases could not see it.
  for (const changed of [
    {
      ...measured,
      target: { ...measured.target, version: "9.99.1" },
      origin: { ...measured.origin, appLaunch: { ...receipt, productVersion: "9.99.1" } },
    },
    {
      ...measured,
      origin: { ...measured.origin, appLaunch: { ...receipt, executableSha256: "b7".repeat(32) } },
    },
  ]) {
    expect.soft(assessRunAdmission(changed, [], evidence)).toMatchObject({
      accepted: false,
      reason: "ownership-receipt-app-launch-mismatch",
      detail: expect.stringMatching(/origin\.appLaunch\.(productVersion|executableSha256) differs/),
      identityAdmission: null,
    })
  }
  // Requirement 2: copied executable identity cannot stand without hosted evidence.
  for (const ownership of [undefined, JSON.stringify({ kind: "shared" })]) {
    const rawReplies: Record<string, string> = { ...measured.rawReplies }
    const changed = {
      ...measured,
      target: { ...measured.target, version: "9.99.1" },
      origin: { ...measured.origin, appLaunch: { ...receipt, productVersion: "9.99.1" } },
      rawReplies,
    }
    if (ownership === undefined) delete changed.rawReplies["collector.disposableOwnership"]
    else changed.rawReplies["collector.disposableOwnership"] = ownership
    expect.soft(assessRunAdmission(changed, [], evidence)).toMatchObject({
      accepted: false,
      reason: "windows-hosted-receipt-required",
      identityAdmission: null,
    })
  }
  // Receipt equality covers every measured launch field, not only the version and digest.
  for (const [field, appLaunch] of [
    ["executablePath", { ...receipt, executablePath: String.raw`C:\other\WindowsTerminal.exe` }],
    [
      "sourceArtifact",
      { ...receipt, sourceArtifact: { ...receipt.sourceArtifact, path: String.raw`C:\other\wt.zip` } },
    ],
    ["sourceArtifact", { ...receipt, sourceArtifact: { ...receipt.sourceArtifact, sha256: "e5".repeat(32) } }],
    [
      "platform",
      {
        bundlePath: "/Applications/Terminal.app",
        cfBundleShortVersionString: run.target.version,
        cfBundleVersion: "1",
        executablePath: receipt.executablePath,
        executableSha256: receipt.executableSha256,
        sourceArtifact: receipt.sourceArtifact,
      },
    ],
  ] as const) {
    expect
      .soft(assessRunAdmission({ ...measured, origin: { ...measured.origin, appLaunch } }, [], evidence))
      .toMatchObject({
        accepted: false,
        reason: field === "platform" ? "identity-replies-mismatch" : "ownership-receipt-app-launch-mismatch",
        ...(field === "platform" ? {} : { detail: expect.stringContaining(`origin.appLaunch.${field} differs`) }),
        identityAdmission: null,
      })
  }
  const unknownReceipt = { ...receipt, productVersion: "unknown" }
  const unknownDirectory = temp("terminfo-unknown-launch-")
  const unknownOwnership = ownershipBesideRun(join(unknownDirectory, "run.json"), {
    ...hostedReceipt("Windows", "1004"),
    appLaunch: unknownReceipt,
  })
  expect
    .soft(
      assessRunAdmission(
        {
          ...measured,
          target: { ...measured.target, version: "unknown" },
          origin: { ...measured.origin, appLaunch: unknownReceipt },
          rawReplies: { ...measured.rawReplies, "collector.disposableOwnership": unknownOwnership },
        },
        [],
        {
          receiptPath: join(unknownDirectory, "host-measured.json"),
          contentDir: unknownDirectory,
          mode: "placement",
        },
      ),
    )
    .toMatchObject({ accepted: false, reason: "identity-replies-mismatch" })
  for (const version of [`${receipt.productVersion} `, "1.21.2361.0"]) {
    expect
      .soft(assessRunAdmission({ ...measured, target: { ...measured.target, version } }, [], evidence))
      .toMatchObject({
        accepted: false,
        reason: "identity-replies-mismatch",
      })
  }
  expect
    .soft(assessRunAdmission(run, [], evidence))
    .toMatchObject({ accepted: false, reason: "identity-replies-mismatch" })
})

test("a run is named from its own target and run id", () => {
  authoringFixture()
  const into = join(temp("terminfo-admit-dest-"), "out.json")
  const plan = planAdmission(runFixture(), into)
  expect(plan.destination).toBe(into)
  expect(plan.target).toEqual({ kind: "app", id: "kitty", version: "0.49.2", os: "linux" })
  const defaultPlan = planAdmission(runFixture())
  expect(defaultPlan.destination.endsWith("content/probes-apps/kitty-0.49.2-linux-run1.json")).toBe(true)
})

test("a run with an unsafe filename component refuses", () => {
  expect(() => planAdmission(runFixture({ target: { kind: "app", id: "kit/ty", version: "1", os: "linux" } }))).toThrow(
    /unsafe target.id/,
  )
})

test("a run that is not schema v2 refuses", () => {
  expect(() => planAdmission(runFixture({ schemaVersion: 1 }))).toThrow(/not schema v2/)
})

/**
 * Condition 1: a manifest is computed only from the run's OWN suite. A run from another suite must
 * refuse by name, before any write, rather than compute `probes` from this tree's probe-defs.
 */
test("admission refuses a run whose suite this tree does not run", () => {
  authoringFixture()
  const plan = planAdmission(runFixture())
  const foreign = { ...plan, probeHash: "f".repeat(12) }
  expect(() => admitRun(foreign)).toThrow(/Admit from a tree at the run's suite/)
})

/** Concurrent admission of the same run is success; different bytes at the same name are loud. */
test("placing a run is exclusive and idempotent, and never overwrites different bytes", () => {
  const destination = join(temp("terminfo-admit-place-"), "kitty.json")
  expect(placeRun(destination, "one\n")).toBe("created")
  expect(readFileSync(destination, "utf8")).toBe("one\n")
  expect(placeRun(destination, "one\n")).toBe("existing")
  expect(() => placeRun(destination, "two\n")).toThrow(/Refusing to overwrite/)
})

/**
 * 27876: admission copied the run document but silently dropped the screenshots it cites, so
 * consumer-selection failed with "missing screenshot artifact" on main. The cited PNGs live in
 * `artifacts/` beside the run file; admission must carry them, or refuse by name.
 */
test("admission carries every screenshot the run cites, and refuses a missing or mismatched one", () => {
  const source = join(temp("terminfo-admit-shots-"), "run.json")
  const content = temp("terminfo-admit-content-")
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("pixels")])
  const digest = createHash("sha256").update(png).digest("hex")
  const ref = `sha256:${digest}`
  mkdirSync(join(source, "..", "artifacts"), { recursive: true })
  writeFileSync(join(source, "..", "artifacts", `${digest}.png`), png)

  expect(placeScreenshots(source, [ref], content)).toEqual({ created: 1, existing: 0 })
  expect(readFileSync(join(content, "artifacts", `${digest}.png`))).toEqual(png)
  expect(placeScreenshots(source, [ref], content)).toEqual({ created: 0, existing: 1 })

  const absent = `sha256:${"a".repeat(64)}`
  // AC1: preflight every cited artifact before any placement; the old loop wrote the first PNG.
  const unplacedContent = temp("terminfo-preflight-content-")
  expect(() => placeScreenshots(source, [ref, absent], unplacedContent)).toThrow(/does not exist beside the run/)
  expect(existsSync(join(unplacedContent, "artifacts", `${digest}.png`))).toBe(false)
  expect(() => placeScreenshots(source, [absent], content)).toThrow(/does not exist beside the run/)
  const wrong = digest.slice(0, 63) + (digest[63] === "a" ? "b" : "a")
  writeFileSync(join(source, "..", "artifacts", `${wrong}.png`), png)
  expect(() => placeScreenshots(source, [`sha256:${wrong}`], content)).toThrow(/hashes to/)

  const notPng = Buffer.from("not a png at all")
  const notPngDigest = createHash("sha256").update(notPng).digest("hex")
  writeFileSync(join(source, "..", "artifacts", `${notPngDigest}.png`), notPng)
  expect(() => placeScreenshots(source, [`sha256:${notPngDigest}`], content)).toThrow(/is not a PNG/)
})

// ---------------------------------------------------------------------------------------------
// 27874: the four hand-typed receipts went through admission because it recorded a digest and
// never opened the bytes. Admission now places the receipt beside the run and re-checks it.
// What these checks prove is CONSISTENCY, not ORIGIN; origin is the apparatus handoff.
// ---------------------------------------------------------------------------------------------

const KITTY_TARGET = { kind: "app", id: "kitty", os: "linux" }
const RECEIPT_RUN_ID = "9".repeat(32)

/** A container receipt shaped as the launcher writes it: docker-inspected identity, no placeholders. */
function baseReceipt() {
  return {
    schemaVersion: 1,
    kind: "linux-xvfb-container",
    runId: "a".repeat(32),
    collectedAt: "2026-10-06T22:00:00Z",
    runtime: {
      imageId: "sha256:3f263739c9bebf6e015166eb0aa9c62dd37baf47384391d87875158eeae0bc8d",
      imageTarSha256: "22ab7b15460795eb0c774b68f0d8c5f853d87597bacbffdd809e0fcac9130333",
      arch: "amd64",
      nixLockRevision: "f2e16882cd75b5180bf14f77740fcb8643b35c10",
      sourceRevision: "d".repeat(40),
      sourceTreeStatus: "clean",
      rootRevision: "e".repeat(40),
      suiteHash: "f".repeat(12),
    },
    runnerArtifact: {
      frozenRunnerSha256: "d0a6b28177cce4be5dc241fe53adc636cbfba8a60e9362b38e5ccf3c5074d4c6",
      buildReceiptSha256: "63648108c641030f0d0cc0ee7ba92d27cb4627dc1da5ba953f0bd632f4de2044",
    },
    declaredTarget: { kind: "app", id: "kitty", version: "0.49.2", os: "linux" },
    preset: "current",
    clipboardProfile: "default",
  }
}

/** Write the receipt beside the run as the launcher hands it (`host-measured.json`) and cite it. */
function ownershipBesideRun(source: string, receipt: unknown): string {
  const bytes = JSON.stringify(receipt)
  writeFileSync(join(source, "..", "host-measured.json"), bytes)
  return JSON.stringify({
    kind: (receipt as { kind: string }).kind,
    runId: (receipt as { runId: string }).runId,
    collectedAt: (receipt as { collectedAt: string }).collectedAt,
    receiptSha256: createHash("sha256").update(bytes).digest("hex"),
  })
}

/** Hosted identities are measured by the apparatus; these fixture digests model independent jobs. */
function hostedReceipt(os: "macOS" | "Linux" | "Windows", jobId: string) {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex")
  const sample = {
    machineIdSha256: hash(`${os}-${jobId}-machine`),
    productUuidSha256: hash(os === "macOS" ? "mac-image" : `${jobId}-platform`),
    bootIdSha256: hash(`${os}-${jobId}-boot`),
  }
  return {
    schemaVersion: 1,
    kind: "github-hosted-runner",
    runId: hash(`${os}-${jobId}`).slice(0, 32),
    collectedAt: "2026-10-07T06:00:00Z",
    job: {
      repository: "beorn/terminfo.dev",
      workflow: "collect",
      workflowRef: "collect.yml@main",
      githubRunId: "37583024982",
      githubRunAttempt: "1",
      job: "collect",
      jobId,
    },
    runner: {
      environment: "github-hosted",
      name: `runner-${jobId}`,
      os,
      arch: os === "Windows" ? "X64" : "ARM64",
      imageOS: "fixture",
      imageVersion: "1",
      trackingId: hash(jobId),
    },
    vm: { identityAtJobStart: { ...sample }, identityAtCollection: { ...sample } },
  }
}

// 27910 amendment 1: container-only admission tests cannot see hosted cross-job identity reuse.
test("hosted admission permits same jobs and fresh jobs, including Mac image constants", () => {
  for (const os of ["macOS", "Linux", "Windows"] as const) {
    const source = join(temp("terminfo-hosted-source-"), "run.json")
    const content = temp("terminfo-hosted-content-")
    const first = hostedReceipt(os, "1001")
    const target = { kind: "app", id: "fixture", os }
    const citation = ownershipBesideRun(source, first)
    expect(placeOwnershipReceipt(source, citation, "first", target, content).placed).toBe("created")
    expect(placeOwnershipReceipt(source, citation, "first", target, content).placed).toBe("existing")
    expect(placeOwnershipReceipt(source, citation, "same-job", target, content).placed).toBe("created")
    const fresh = hostedReceipt(os, "1002")
    if (os === "Linux" || os === "Windows") {
      fresh.vm.identityAtJobStart.bootIdSha256 = first.vm.identityAtJobStart.bootIdSha256
      fresh.vm.identityAtCollection = { ...fresh.vm.identityAtJobStart }
    }
    expect(placeOwnershipReceipt(source, ownershipBesideRun(source, fresh), "fresh", target, content).placed).toBe(
      "created",
    )
  }
})

test("hosted admission refuses OS-specific non-reuse witnesses before placement, naming both jobs", () => {
  for (const [os, fields] of [
    ["macOS", ["machineIdSha256", "bootIdSha256"]],
    ["Linux", ["machineIdSha256", "productUuidSha256"]],
    ["Windows", ["machineIdSha256", "productUuidSha256"]],
  ] as const) {
    for (const field of fields) {
      for (const differentRun of [false, true]) {
        const source = join(temp("terminfo-hosted-source-"), "run.json")
        const content = temp("terminfo-hosted-content-")
        const first = hostedReceipt(os, "1001")
        const target = { kind: "app", id: "fixture", os }
        placeOwnershipReceipt(source, ownershipBesideRun(source, first), "first", target, content)
        const repeat = hostedReceipt(os, "1002")
        if (differentRun) {
          repeat.job.githubRunId = "37583024983"
          repeat.job.jobId = "1001"
        }
        repeat.vm.identityAtJobStart[field] = first.vm.identityAtJobStart[field]
        repeat.vm.identityAtCollection = { ...repeat.vm.identityAtJobStart }
        expect(() =>
          placeOwnershipReceipt(source, ownershipBesideRun(source, repeat), "repeat", target, content),
        ).toThrow(new RegExp(`${field}.*37583024982/1001.*${repeat.job.githubRunId}/${repeat.job.jobId}`))
        expect(existsSync(join(content, "receipts", "repeat.json"))).toBe(false)
      }
    }
  }
})

test("hosted admission refuses untrusted runner.os prototype properties by name", () => {
  for (const maliciousOs of ["toString", "constructor", "valueOf"]) {
    const source = join(temp("terminfo-hosted-source-"), "run.json")
    const content = temp("terminfo-hosted-content-")
    const receipt = hostedReceipt("Windows", "1001")
    // An untrusted receipt carries an os the type forbids; write it past the type, as such a receipt arrives.
    Object.assign(receipt.runner, { os: maliciousOs })
    expect(() =>
      placeOwnershipReceipt(
        source,
        ownershipBesideRun(source, receipt),
        "untrusted-os",
        { kind: "app", id: "fixture", os: maliciousOs },
        content,
      ),
    ).toThrow(new RegExp(`runner\\.os "${maliciousOs}" has no ratified identity source/scope table`))
    expect(existsSync(join(content, "receipts", "untrusted-os.json"))).toBe(false)
  }
})

test("hosted admission reads every prior receipt and names corrupt history instead of skipping it", () => {
  const source = join(temp("terminfo-hosted-source-"), "run.json")
  const content = temp("terminfo-hosted-content-")
  mkdirSync(join(content, "receipts"))
  const corrupt = join(content, "receipts", "corrupt.json")
  writeFileSync(corrupt, "not JSON")
  expect(() =>
    placeOwnershipReceipt(
      source,
      ownershipBesideRun(source, hostedReceipt("macOS", "1001")),
      "new",
      { kind: "app", id: "fixture", os: "macOS" },
      content,
    ),
  ).toThrow(/corrupt.json/)
  expect(existsSync(join(content, "receipts", "new.json"))).toBe(false)
})

test("admission places the ownership receipt a run cites, exclusively and immutably", () => {
  const source = join(temp("terminfo-admit-receipt-"), "run.json")
  const content = temp("terminfo-admit-content-")
  const bytes = JSON.stringify(baseReceipt())
  const citation = ownershipBesideRun(source, baseReceipt())
  expect(placeOwnershipReceipt(source, citation, RECEIPT_RUN_ID, KITTY_TARGET, content).placed).toBe("created")
  expect(readFileSync(join(content, "receipts", `${RECEIPT_RUN_ID}.json`), "utf8")).toBe(bytes)
  expect(placeOwnershipReceipt(source, citation, RECEIPT_RUN_ID, KITTY_TARGET, content).placed).toBe("existing")
})

test("admission refuses a cited receipt that is missing, mismatched or uncited", () => {
  const source = join(temp("terminfo-admit-receipt-"), "run.json")
  const content = temp("terminfo-admit-content-")
  const bytes = JSON.stringify(baseReceipt())
  const cited = createHash("sha256").update(bytes).digest("hex")
  const citation = JSON.stringify({
    kind: "linux-xvfb-container",
    runId: "a".repeat(32),
    collectedAt: "2026-10-06T22:00:00Z",
    receiptSha256: cited,
  })
  expect(() => placeOwnershipReceipt(source, citation, RECEIPT_RUN_ID, KITTY_TARGET, content)).toThrow(
    /does not exist beside the run/,
  )
  const different = baseReceipt()
  different.collectedAt = "2026-10-06T23:00:00Z"
  writeFileSync(join(source, "..", "host-measured.json"), JSON.stringify(different))
  expect(() => placeOwnershipReceipt(source, citation, RECEIPT_RUN_ID, KITTY_TARGET, content)).toThrow(/hashes to/)
  expect(() =>
    placeOwnershipReceipt(
      source,
      JSON.stringify({ kind: "linux-xvfb-container" }),
      RECEIPT_RUN_ID,
      KITTY_TARGET,
      content,
    ),
  ).toThrow(/no sha256 receiptSha256/)
  expect(existsSync(join(content, "receipts", `${RECEIPT_RUN_ID}.json`))).toBe(false)
})

test("admission refuses the four hand-typed 27874 receipts by name", () => {
  const source = join(temp("terminfo-admit-receipt-"), "run.json")
  const content = temp("terminfo-admit-content-")
  const zeroed = baseReceipt()
  zeroed.runtime.imageId = "sha256:" + "0".repeat(64)
  zeroed.runtime.imageTarSha256 = "0".repeat(64)
  zeroed.runtime.nixLockRevision = "0".repeat(40)
  expect(() =>
    placeOwnershipReceipt(source, ownershipBesideRun(source, zeroed), RECEIPT_RUN_ID, KITTY_TARGET, content),
  ).toThrow(/imageId is a placeholder/)

  const inventedArch = baseReceipt()
  inventedArch.runtime.arch = "x86_64"
  expect(() =>
    placeOwnershipReceipt(source, ownershipBesideRun(source, inventedArch), RECEIPT_RUN_ID, KITTY_TARGET, content),
  ).toThrow(/arch must be one of amd64, arm64/)
  expect(existsSync(join(content, "receipts", `${RECEIPT_RUN_ID}.json`))).toBe(false)
})

test("admission refuses a receipt bound to another target, placing nothing", () => {
  const source = join(temp("terminfo-admit-receipt-"), "run.json")
  const content = temp("terminfo-admit-content-")
  const citation = ownershipBesideRun(source, baseReceipt())
  expect(() =>
    placeOwnershipReceipt(source, citation, RECEIPT_RUN_ID, { kind: "app", id: "wezterm", os: "linux" }, content),
  ).toThrow(/receipt declares target .*kitty.* this run is .*wezterm/)
  expect(existsSync(join(content, "receipts", `${RECEIPT_RUN_ID}.json`))).toBe(false)
})

test("a run collected against a shared terminal cites no receipt and places none", () => {
  const source = join(temp("terminfo-admit-receipt-"), "run.json")
  const content = temp("terminfo-admit-content-")
  expect(
    placeOwnershipReceipt(source, JSON.stringify({ kind: "shared" }), RECEIPT_RUN_ID, KITTY_TARGET, content),
  ).toEqual({
    placed: "none",
    detail: "collected against a shared terminal: it cites no receipt, so none is placed",
  })
  expect(placeOwnershipReceipt(source, undefined, RECEIPT_RUN_ID, KITTY_TARGET, content).placed).toBe("none")
})
