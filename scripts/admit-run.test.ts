/**
 * @failure A run can be admitted against a suite this tree does not run, so its manifest is computed from the wrong probe-defs; or a concurrent admission of the same run can overwrite different bytes; or the run can be misnamed; or the ownership receipt a run cites can go unread, so a hand-typed identity that nothing measured is admitted beside the run it claims to authorize.
 * @level l1
 * @consumer The one declare-and-admit entry point (27859)
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/ vendor/terminfo.dev/packages/probes/
 * @reach fs-walk <fixture-only: mkdtempSync run, destination, and Git authoring directories>
 * @testonly none
 */
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import * as suiteManifest from "../packages/admin/suite-manifest.ts"
import * as versions from "../packages/admin/versions.ts"
import {
  decodeHistoricalCollectorRun,
  retainCaptureBinding,
  parseJsonStrict,
  parseRun,
  parseSuiteManifest,
} from "@terminfo/run-parser"
import { initializeRunDraft, type CapturedRunDraft } from "@terminfo/probe-defs"
import { saveDaemonProbeRun } from "../packages/terminfo.dev/src/daemon-client.ts"
import { probeSuiteSnapshot } from "../packages/admin/versions.ts"
import {
  admitRun,
  assessRunAdmission,
  placeOwnershipReceipt,
  placeRun,
  placeRetainedArtifacts,
  planAdmission,
} from "./admit-run.ts"
import { object } from "./interpretations.ts"
import { parseDisposableReceipt } from "../packages/terminfo.dev/src/disposable-receipt.ts"
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
  git("init", "-q", "-b", "task/fixture")
  git("config", "user.email", "fixture@example.invalid")
  git("config", "user.name", "fixture")
  writeFileSync(join(directory, "fixture.txt"), "main\n")
  git("add", "fixture.txt")
  git("commit", "-q", "-m", "main fixture")
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD").trim())
  const assertAuthoring = suiteManifest.assertDeclareIsAuthoring
  // A fresh branch at origin/main authors the commit admission writes (30163); the same commit on the
  // default branch does not. The guard is the real one, pointed at this fixture.
  expect(() => assertAuthoring(directory)).not.toThrow()
  git("switch", "-q", "-C", "main")
  expect(() => assertAuthoring(directory)).toThrow(/default branch/)
  git("switch", "-q", "task/fixture")
  vi.spyOn(suiteManifest, "assertDeclareIsAuthoring").mockImplementation((_root, hash) =>
    assertAuthoring(directory, hash),
  )
}

/** The release a suite's own manifest freezes; two releases are declared now, so the suite names one. */
function declaredRelease(suiteHash: string): string {
  const suites = join(import.meta.dirname, "..", "content", "suites")
  const path = join(suites, `${suiteHash}.json`)
  const manifest = parseSuiteManifest(path, readFileSync(path, "utf8"))
  if (!manifest.freeze) throw new Error(`Suite ${suiteHash} declares no release freeze in ${suites}`)
  return manifest.freeze.release
}

/** The suite candidate 2's freeze declares today, so a pointer move cannot strand these fixtures. */
function currentCandidate2Release(): string {
  return declaredRelease(frozenSuiteIdFor(join(import.meta.dirname, "..", "content"), "candidate2"))
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
  // The specimen predates probes defined since it was captured, so membership under the live suite
  // is completed with named not-tested rows rather than borrowing a measurement nobody took.
  const live = probeSuiteSnapshot()
  const liveSuite = live.probeHash
  complete.provenance.runtime.suiteHash = liveSuite
  if (!Array.isArray(complete.observations) || !Array.isArray(complete.notTested)) {
    throw new Error("Admission fixture has no observations or notTested list")
  }
  if (!object(complete.rawReplies)) throw new Error("Admission fixture has no raw replies")
  const covered = new Set<string>()
  for (const item of [...complete.observations, ...complete.notTested]) {
    if (object(item) && typeof item.featureId === "string") covered.add(item.featureId)
  }
  for (const featureId of live.probes.app.filter((id) => !covered.has(id))) {
    complete.rawReplies[featureId] = `fixture: the retained specimen predates ${featureId}`
    complete.notTested.push({
      featureId,
      reason: "no-semantic-observable",
      noObservable: "the retained specimen predates this probe, so nothing observed it",
      rawReplyRef: featureId,
    })
  }
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
  const snapshot = probeSuiteSnapshot()
  const decoded = decodeHistoricalCollectorRun(source, raw, derivedSuiteManifest(snapshot), document.sourceRevision)
  const {
    observations: _observations,
    notTested: _notTested,
    ungradedDiagnostics: _diagnostics,
    suiteComplete: _complete,
    ...metadata
  } = decoded.run
  const staged = saveDaemonProbeRun(
    {
      ...metadata,
      schemaVersion: 3,
      intendedContext: { kind: metadata.target.kind, id: metadata.target.id },
      results: snapshot.catalogIds.map((featureId) => ({
        featureId,
        status: "test-todo",
        attempt: { scope: "none" },
        checks: [],
        reason: "Synthetic fresh TODO fixture; no old observation upgraded",
      })),
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
  // The fixture run is re-stamped onto the live snapshot, which candidate2's freeze declares.
  const release = currentCandidate2Release()
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
  // The fixture run is re-stamped onto the live snapshot, which candidate2's freeze declares.
  const release = currentCandidate2Release()
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
  // The specimen's own suite predates three probes this branch defined, so the fixture-only
  // not-tested rows added above sit outside it; keep exactly the specimen's own membership.
  const foreignPath = join(import.meta.dirname, "..", "content", "suites", `${foreignSuite}.json`)
  const foreignIds = new Set(parseSuiteManifest(foreignPath, readFileSync(foreignPath, "utf8")).probes.app)
  if (!Array.isArray(document.notTested)) throw new Error("Synthetic frozen-suite fixture lacks notTested")
  document.notTested = document.notTested.filter(
    (row) => object(row) && typeof row.featureId === "string" && foreignIds.has(row.featureId),
  )
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

  const alacrittyReceipt = {
    platform: "win32" as const,
    executablePath: String.raw`D:\a\_temp\alacritty\alacritty.exe`,
    productVersion: "0.17.0",
    executableSha256: "5ad70ddc5c2a2bfe84084a2c4c73558e9360914f035a902d7a69277be7249f1f",
    sourceArtifact: {
      kind: "portable-exe" as const,
      path: String.raw`D:\a\_temp\measurement-artifacts\Alacritty-v0.17.0-portable.exe`,
      sha256: "5ad70ddc5c2a2bfe84084a2c4c73558e9360914f035a902d7a69277be7249f1f",
    },
    mesaRenderer: {
      upstream: "https://github.com/mmozeiko/build-mesa",
      version: "26.2.5",
      archivePath: String.raw`D:\a\_temp\measurement-artifacts\mesa-llvmpipe-x64-26.2.5.7z`,
      archiveSha256: "d1b713ca2a7fba47a50c058099f13c435ddb76a16a422c334e4d787f9755a31d",
      dlls: [
        {
          name: "opengl32.dll",
          path: String.raw`D:\a\_temp\alacritty\opengl32.dll`,
          sha256: "8ddc061ee752fff06ae682de0ac2e010926d76a93c1aecc4c206adee771856e1",
        },
      ],
    },
  }
  const alacrittyDir = temp("terminfo-alacritty-win-launch-")
  const alacrittyHost = { ...hostedReceipt("Windows", "1005"), appLaunch: alacrittyReceipt }
  const alacrittyOwnership = ownershipBesideRun(join(alacrittyDir, "run.json"), alacrittyHost)
  const alacrittyMeasured = {
    ...run,
    target: { ...run.target, id: "alacritty", version: "0.17.0", os: "windows" },
    origin: { ...run.origin, appLaunch: alacrittyReceipt },
    rawReplies: {
      ...run.rawReplies,
      "collector.xtversion": "\x1b[?61;6;7;21;22;23;24;28;32;42c",
      "device.primary-da": "\x1b[?61;6;7;21;22;23;24;28;32;42c",
      "collector.disposableOwnership": alacrittyOwnership,
    },
  }
  const alacrittyEvidence = {
    receiptPath: join(alacrittyDir, "host-measured.json"),
    contentDir: alacrittyDir,
    mode: "placement" as const,
  }
  expect.soft(assessRunAdmission(alacrittyMeasured, [], alacrittyEvidence)).toMatchObject({
    accepted: true,
    identityAdmission: {
      rule: "alacritty",
      da1: "\x1b[?61;6;7;21;22;23;24;28;32;42c",
      executable: {
        version: "0.17.0",
        sha256: "5ad70ddc5c2a2bfe84084a2c4c73558e9360914f035a902d7a69277be7249f1f",
      },
    },
  })
  // Windows Alacritty without mesaRenderer, with Unix ?6c DA1, or with WindowsTerminal.exe path is refused at identityMatch.
  expect
    .soft(
      assessRunAdmission(
        {
          ...alacrittyMeasured,
          rawReplies: {
            ...alacrittyMeasured.rawReplies,
            "collector.xtversion": "\x1b[?6c",
            "device.primary-da": "\x1b[?6c",
          },
        },
        [],
        alacrittyEvidence,
      ),
    )
    .toMatchObject({ accepted: false, reason: "identity-replies-mismatch" })
  const withoutMesa = { ...alacrittyReceipt }
  delete (withoutMesa as { mesaRenderer?: unknown }).mesaRenderer
  expect
    .soft(
      assessRunAdmission(
        { ...alacrittyMeasured, origin: { ...alacrittyMeasured.origin, appLaunch: withoutMesa } },
        [],
        alacrittyEvidence,
      ),
    )
    .toMatchObject({ accepted: false, reason: "identity-replies-mismatch" })
  expect
    .soft(
      assessRunAdmission(
        {
          ...alacrittyMeasured,
          origin: {
            ...alacrittyMeasured.origin,
            appLaunch: { ...alacrittyReceipt, executablePath: String.raw`C:\runner\WindowsTerminal.exe` },
          },
        },
        [],
        alacrittyEvidence,
      ),
    )
    .toMatchObject({ accepted: false, reason: "identity-replies-mismatch" })
  // A receipt that measured every archive DLL beside alacritty.exe, not only the pinned opengl32.dll,
  // is refused by name even though opengl32.dll is present.
  const threeDllReceipt = {
    ...alacrittyReceipt,
    mesaRenderer: {
      ...alacrittyReceipt.mesaRenderer,
      dlls: [
        ...alacrittyReceipt.mesaRenderer.dlls,
        {
          name: "libgallium_wgl.dll",
          path: String.raw`D:\a\_temp\alacritty\libgallium_wgl.dll`,
          sha256: "e5".repeat(32),
        },
        { name: "libglapi.dll", path: String.raw`D:\a\_temp\alacritty\libglapi.dll`, sha256: "e6".repeat(32) },
      ],
    },
  }
  const threeDllDir = temp("terminfo-alacritty-win-three-dll-")
  const threeDllOwnership = ownershipBesideRun(join(threeDllDir, "run.json"), {
    ...hostedReceipt("Windows", "1005"),
    appLaunch: threeDllReceipt,
  })
  expect
    .soft(
      assessRunAdmission(
        {
          ...alacrittyMeasured,
          origin: { ...alacrittyMeasured.origin, appLaunch: threeDllReceipt },
          rawReplies: { ...alacrittyMeasured.rawReplies, "collector.disposableOwnership": threeDllOwnership },
        },
        [],
        { ...alacrittyEvidence, receiptPath: join(threeDllDir, "host-measured.json"), contentDir: threeDllDir },
      ),
    )
    .toMatchObject({
      accepted: false,
      reason: "ownership-receipt-invalid",
      detail: expect.stringContaining(
        "appLaunch.mesaRenderer.dlls libgallium_wgl.dll, libglapi.dll, opengl32.dll is not exactly the Mesa3D set opengl32.dll",
      ),
    })
  // Linux Alacritty still requires VT102 \x1b[?6c and refuses ConPTY \x1b[?61; DA1.
  expect
    .soft(
      assessRunAdmission(
        {
          ...alacrittyMeasured,
          target: { ...alacrittyMeasured.target, os: "linux" },
        },
        [],
        alacrittyEvidence,
      ),
    )
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

test("an unsupported run schema refuses", () => {
  expect(() => planAdmission(runFixture({ schemaVersion: 1 }))).toThrow(/current schema 3 or historical schema 2/)
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

  expect(placeRetainedArtifacts(source, [ref], content)).toEqual({ created: 1, existing: 0 })
  expect(readFileSync(join(content, "artifacts", `${digest}.png`))).toEqual(png)
  expect(placeRetainedArtifacts(source, [ref], content)).toEqual({ created: 0, existing: 1 })

  const absent = `sha256:${"a".repeat(64)}`
  // AC1: preflight every cited artifact before any placement; the old loop wrote the first PNG.
  const unplacedContent = temp("terminfo-preflight-content-")
  expect(() => placeRetainedArtifacts(source, [ref, absent], unplacedContent)).toThrow(/does not exist beside the run/)
  expect(existsSync(join(unplacedContent, "artifacts", `${digest}.png`))).toBe(false)
  expect(() => placeRetainedArtifacts(source, [absent], content)).toThrow(/does not exist beside the run/)
  const wrong = digest.slice(0, 63) + (digest[63] === "a" ? "b" : "a")
  writeFileSync(join(source, "..", "artifacts", `${wrong}.png`), png)
  expect(() => placeRetainedArtifacts(source, [`sha256:${wrong}`], content)).toThrow(/hashes to/)

  const notPng = Buffer.from("not a png at all")
  const notPngDigest = createHash("sha256").update(notPng).digest("hex")
  writeFileSync(join(source, "..", "artifacts", `${notPngDigest}.png`), notPng)
  expect(() => placeRetainedArtifacts(source, [`sha256:${notPngDigest}`], content)).toThrow(/is not a PNG/)
})

test("admission carries a run's text snapshots as text, and refuses a missing or non-UTF-8 one", () => {
  const source = join(temp("terminfo-admit-text-"), "run.json")
  const content = temp("terminfo-admit-text-content-")
  const snapshot = Buffer.from("hello\nworld\n", "utf8")
  const digest = createHash("sha256").update(snapshot).digest("hex")
  const ref = `sha256:${digest}`
  mkdirSync(join(source, "..", "artifacts"), { recursive: true })
  writeFileSync(join(source, "..", "artifacts", `${digest}.txt`), snapshot)

  expect(placeRetainedArtifacts(source, [ref], content, "text-snapshot")).toEqual({ created: 1, existing: 0 })
  expect(readFileSync(join(content, "artifacts", `${digest}.txt`))).toEqual(snapshot)
  expect(placeRetainedArtifacts(source, [ref], content, "text-snapshot")).toEqual({ created: 0, existing: 1 })

  const absent = `sha256:${"b".repeat(64)}`
  const unplaced = temp("terminfo-admit-text-unplaced-")
  expect(() => placeRetainedArtifacts(source, [ref, absent], unplaced, "text-snapshot")).toThrow(
    /text snapshot .* does not exist beside the run/u,
  )
  expect(existsSync(join(unplaced, "artifacts", `${digest}.txt`))).toBe(false)

  const invalid = Buffer.from([0xff, 0xfe, 0x00])
  const invalidDigest = createHash("sha256").update(invalid).digest("hex")
  writeFileSync(join(source, "..", "artifacts", `${invalidDigest}.txt`), invalid)
  expect(() => placeRetainedArtifacts(source, [`sha256:${invalidDigest}`], content, "text-snapshot")).toThrow(
    /is not exact UTF-8/u,
  )

  const bom = Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0a])
  const bomDigest = createHash("sha256").update(bom).digest("hex")
  writeFileSync(join(source, "..", "artifacts", `${bomDigest}.txt`), bom)
  expect(() => placeRetainedArtifacts(source, [`sha256:${bomDigest}`], content, "text-snapshot")).toThrow(
    /is not exact UTF-8/u,
  )
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

// Existing admission fixtures start from already sealed historical evidence. They cannot prove the
// real command preserves an original draft, rejects a foreign typed decision, and seals before decode.
test("existing admission command resumes typed capture review and refuses a mismatched capture", () => {
  const directory = temp("terminfo-review-command-")
  const snapshot = probeSuiteSnapshot()
  const manifest = derivedSuiteManifest(snapshot)
  const featureId = manifest.catalogIds![0]!
  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: import.meta.dirname,
    encoding: "utf8",
  }).trim()
  const base = initializeRunDraft({
    runId: "review-command",
    sourceRevision,
    manifest,
    intendedContext: { kind: "app", id: "kitty", version: "1" },
  })
  const run: CapturedRunDraft = {
    ...base,
    target: {
      kind: "app",
      id: "kitty",
      version: "1",
      os: "macos",
      osVersion: null,
      outerTerminal: null,
      mux: null,
      config: null,
      permissions: null,
    },
    identity: "unverified",
    measuredAt: "2026-10-21T05:00:00.000Z",
    origin: { kind: "collector" },
  }
  run.results[0]!.checks = [
    { id: "review", status: "test-todo", attempt: { scope: "none" }, reason: "Required context review" },
  ]
  const capture = retainCaptureBinding(run, featureId)
  const source = join(directory, "original.draft.json")
  const original = JSON.stringify(run)
  writeFileSync(source, original)
  const decision = {
    id: "command-review",
    runId: run.runId,
    featureId,
    captureSha256: capture.sha256,
    decision: "untestable",
    reviewed: true,
    reviewer: "fixture-reviewer",
    reason: "This stream-only context cannot display the criterion's pixel target",
    scope: { target: { kind: "app", id: "kitty" }, versions: ["1", "1"], suites: [run.probeHash, run.probeHash] },
    sources: [capture.rawReplyRef],
    supersedes: [],
  }
  const review = join(directory, "decision.json")
  const final = join(directory, "kitty-1-macos-review-command.json")
  const invoke = () =>
    spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, "admit-run.ts"),
        "--for",
        source,
        "--review",
        review,
        "--review-started-at",
        "2026-10-21T05:01:00.000Z",
      ],
      { cwd: dirname(import.meta.dirname), encoding: "utf8" },
    )
  writeFileSync(review, JSON.stringify({ ...decision, captureSha256: "f".repeat(64) }))
  const rejected = invoke()
  expect(rejected.status).toBe(1)
  expect(rejected.stderr).toMatch(/capture digest mismatch/)
  expect(existsSync(final)).toBe(false)
  writeFileSync(review, JSON.stringify(decision))
  const resumed = invoke()
  // This synthetic unverified context is not admissible. Review/final-save must complete first,
  // and the ordinary admission owner must still refuse rather than publish it.
  expect(resumed.status).toBe(1)
  expect(resumed.stdout).toContain("Retained reviewed capture")
  expect(readFileSync(source, "utf8")).toBe(original)
  const parsed = parseRun(
    final,
    readFileSync(final, "utf8"),
    manifest.catalogIds!,
    new Map([[manifest.probeHash, manifest]]),
  )
  expect(parsed.runId).toBe(run.runId)
  expect(parsed.results?.[0]?.status).toBe("untestable")
})

// Existing completion mutations covered final-run/host identity only, and missed deleted or changed
// original capture/container/HTTP bytes after the final host-enriched schema-3 run was sealed.
test.each([
  "valid",
  "missing-container",
  "changed-container",
  "missing-capture",
  "changed-capture",
  "missing-http",
  "changed-http",
] as const)("current Linux admission resolves original custody inputs: %s", (fault) => {
  authoringFixture()
  const source = runFixture()
  const manifest = derivedSuiteManifest(probeSuiteSnapshot())
  const old = parseRun(
    source,
    readFileSync(source, "utf8"),
    manifest.catalogIds!,
    new Map([[manifest.probeHash, manifest]]),
  )
  if (!old.sourceRevision) throw new Error("Fixture lacks collector source")
  const draft = initializeRunDraft({
    runId: old.runId,
    sourceRevision: old.sourceRevision,
    manifest,
    intendedContext: old.target,
  })
  const capture = {
    ...draft,
    target: old.target,
    provenance: old.provenance,
    identity: old.identity,
    measuredAt: old.measuredAt,
    origin: old.origin,
    rawReplies: old.rawReplies,
    assertions: [],
    screenshotRefs: [],
  }
  const captureBytes = Buffer.from(JSON.stringify(capture))
  const captureSha = createHash("sha256").update(captureBytes).digest("hex")
  const directory = dirname(source)
  const capturePath = join(directory, "v3-capture.json")
  const containerPath = join(directory, "container-receipt.json")
  const http = join(directory, "http-responses", captureSha)
  writeFileSync(capturePath, captureBytes)
  const containerBytes = JSON.stringify({ probeRun: { path: "v3-capture.json", runId: old.runId, sha256: captureSha } })
  writeFileSync(containerPath, containerBytes)
  mkdirSync(dirname(http))
  writeFileSync(http, captureBytes)
  const final = {
    ...capture,
    sealedAt: "2026-10-21T05:02:00.000Z",
    rawReplies: { ...capture.rawReplies, "collector.httpResponseSha256": captureSha },
  }
  const bytes = JSON.stringify(final)
  writeFileSync(source, bytes)
  const completionPath = join(directory, "run-receipt.json")
  const completion = JSON.parse(readFileSync(completionPath, "utf8"))
  if (!object(completion) || !object(completion.probeRun) || !object(completion.receiptInputs)) {
    throw new Error("Missing completion fixture bindings")
  }
  completion.probeRun.sha256 = createHash("sha256").update(bytes).digest("hex")
  completion.receiptInputs.containerSha256 = createHash("sha256").update(containerBytes).digest("hex")
  writeFileSync(completionPath, JSON.stringify(completion))
  const destination = join(temp("terminfo-custody-dest-"), "content", "run.json")
  if (fault === "missing-container") rmSync(containerPath)
  if (fault === "changed-container") writeFileSync(containerPath, "{}")
  if (fault === "missing-capture") rmSync(capturePath)
  if (fault === "changed-capture") writeFileSync(capturePath, "{}")
  if (fault === "missing-http") rmSync(http)
  if (fault === "changed-http") writeFileSync(http, "{}")
  if (fault === "valid") expect(planAdmission(source, destination).runId).toBe(old.runId)
  else {
    expect(() => planAdmission(source, destination)).toThrow(
      /original custody inputs|original capture bytes|retained HTTP bytes/,
    )
  }
  expect(existsSync(destination)).toBe(false)
})
