/**
 * @failure Windows collection can attribute a run to an unmeasured executable or accept an invalid hosted Mesa receipt.
 * @level l1
 * @consumer Corpus placement of Windows terminal collection
 * @reach fs-read vendor/terminfo.dev/content/features.json vendor/terminfo.dev/content/suites/4b01b0117e18.json vendor/terminfo.dev/test-fixtures/probes-apps/windows-terminal-admission-current.json
 * @reach fs-walk <fixture-only: isolated run and content directories>
 * @testonly none
 */
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
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { parseSuiteManifest, parseRun, decodeCollectorDraft } from "@terminfo/run-parser"
import { placeCollectedRun } from "./corpus-placement.ts"
import { derivedSuiteManifest, probeSuiteSnapshot } from "./versions.ts"

const dirs: string[] = []
afterEach(() => {
  // raw-delete-allow: dirs contains only fixture directories created by this test's mkdtempSync.
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const root = join(import.meta.dirname, "../..")

// These are the same hosted measurement fields and app launches used by the retired admission tests.
function hostedReceipt(jobId: string) {
  const sample = {
    machineIdSha256: hash(`Windows-${jobId}-machine`),
    productUuidSha256: hash(`${jobId}-platform`),
    bootIdSha256: hash(`Windows-${jobId}-boot`),
  }
  return {
    schemaVersion: 1,
    kind: "github-hosted-runner",
    runId: hash(`Windows-${jobId}`).slice(0, 32),
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
      os: "Windows",
      arch: "X64",
      imageOS: "fixture",
      imageVersion: "1",
      trackingId: hash(jobId),
    },
    vm: { identityAtJobStart: { ...sample }, identityAtCollection: { ...sample } },
  }
}
const windowsLaunch = {
  platform: "win32",
  executablePath: String.raw`C:\runner\WindowsTerminal.exe`,
  productVersion: "1.23.20211.0",
  executableSha256: "c3".repeat(32),
  sourceArtifact: { kind: "portable-zip", path: String.raw`C:\runner\wt.zip`, sha256: "d4".repeat(32) },
}
const alacrittyLaunch = {
  platform: "win32",
  executablePath: String.raw`D:\a\_temp\alacritty\alacritty.exe`,
  productVersion: "0.17.0",
  executableSha256: "5ad70ddc5c2a2bfe84084a2c4c73558e9360914f035a902d7a69277be7249f1f",
  sourceArtifact: {
    kind: "portable-exe",
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
function fixture(alacritty = false) {
  const dir = mkdtempSync(join(tmpdir(), "terminfo-windows-placement-"))
  dirs.push(dir)
  const content = join(dir, "content")
  mkdirSync(content)
  copyFileSync(join(root, "content/features.json"), join(content, "features.json"))
  for (const name of ["probes-apps", "probes-libs", "probes-mux"]) mkdirSync(join(content, name))
  const manifestPath = join(root, "content/suites/4b01b0117e18.json")
  const historical = parseSuiteManifest(manifestPath, readFileSync(manifestPath, "utf8"))
  const manifest = derivedSuiteManifest(probeSuiteSnapshot())
  const specimenPath = join(root, "test-fixtures/probes-apps/windows-terminal-admission-current.json")
  const bytes = readFileSync(specimenPath, "utf8")
  const parsed = parseRun(specimenPath, bytes, historical.catalogIds!, new Map([[historical.probeHash, historical]]))
  if (!parsed.sourceRevision) throw new Error("Windows fixture has no source revision")
  const decoded = decodeCollectorDraft(specimenPath, bytes, historical, parsed.sourceRevision)
  if (decoded.kind !== "captured") throw new Error("Windows fixture is not captured")
  const launch = structuredClone(alacritty ? alacrittyLaunch : windowsLaunch)
  const launchWithMesa: typeof windowsLaunch & { mesaRenderer?: typeof alacrittyLaunch.mesaRenderer; argv?: string[] } =
    {
      ...launch,
      ...(alacritty ? { mesaRenderer: structuredClone(alacrittyLaunch.mesaRenderer) } : {}),
    }
  const run = {
    ...decoded.run,
    probeHash: manifest.probeHash,
    suiteId: manifest.probeHash,
    origin: {
      ...decoded.run.origin,
      appLaunch: launchWithMesa,
    },
  }
  if (alacritty) {
    run.subject = { ...run.subject, id: "alacritty", version: "0.17.0" }
    run.intendedSubject = { ...run.intendedSubject, id: "alacritty", version: "0.17.0" }
    run.rawReplies["collector.xtversion"] = "\x1b[?61;6;7;21;22;23;24;28;32;42c"
    run.rawReplies["device.primary-da"] = "\x1b[?61;6;7;21;22;23;24;28;32;42c"
  }
  const source = join(dir, "run.json")
  const cite = (appLaunch: unknown = launch, runnerOS = "Windows") => {
    const host = { ...hostedReceipt(alacritty ? "1005" : "1003"), appLaunch }
    host.runner.os = runnerOS
    const bytes = JSON.stringify(host)
    writeFileSync(join(dir, "host-measured.json"), bytes)
    run.rawReplies["collector.disposableOwnership"] = JSON.stringify({
      kind: host.kind,
      runId: host.runId,
      collectedAt: host.collectedAt,
      receiptSha256: hash(bytes),
    })
  }
  cite()
  return { run, source, content, manifest, launch, cite }
}

// Hosted placement must reject an OS without a ratified identity source; existing receipt
// parsing only validates that runner.os is nonempty, so an unrecognized value otherwise passes.
test.each(["Plan9", "constructor", "toString"])("rejects hosted runner OS %s", (os) => {
  const f = fixture()
  f.cite(f.launch, os)
  writeFileSync(f.source, JSON.stringify(f.run))
  expect(() => placeCollectedRun(f.source, f.manifest, f.content)).toThrow(/runner\.os.*no ratified identity/)
  expect(readdirSync(join(f.content, "probes-apps"))).toEqual([])
  expect(existsSync(join(f.content, "suites"))).toBe(false)
})

// Accepted: the recorded Windows executable, target, hosted receipt and measured launch must agree.
// Old assessor tests never exercised the actual writer or proved refusal leaves no corpus record.
test.each([
  "valid",
  "valid-argv",
  "argv-mismatch",
  "version",
  "version-and-launch",
  "digest",
  "path",
  "artifact",
  "missing",
  "shared",
  "target",
  "unknown",
] as const)("Windows hosted placement: %s", (fault) => {
  const f = fixture()
  if (fault === "valid-argv" || fault === "argv-mismatch") {
    f.run.origin.appLaunch.argv = ["C:\\invoked\\wt.exe", "--token=[redacted]", "value with spaces"]
    f.cite({ ...f.launch, argv: fault === "valid-argv" ? f.run.origin.appLaunch.argv : ["C:\\different\\wt.exe"] })
  }
  if (fault === "version" || fault === "version-and-launch") f.run.subject.version = "9.99.1"
  if (fault === "version-and-launch") f.run.origin.appLaunch.productVersion = "9.99.1"
  if (fault === "digest") f.run.origin.appLaunch.executableSha256 = "b7".repeat(32)
  if (fault === "path") f.run.origin.appLaunch.executablePath = String.raw`C:\other\WindowsTerminal.exe`
  if (fault === "artifact") f.run.origin.appLaunch.sourceArtifact.sha256 = "e5".repeat(32)
  if (fault === "missing") delete f.run.rawReplies["collector.disposableOwnership"]
  if (fault === "shared") f.run.rawReplies["collector.disposableOwnership"] = JSON.stringify({ kind: "shared" })
  if (fault === "target") {
    f.run.subject.os = "linux"
    f.run.intendedSubject.os = "linux"
  }
  if (fault === "unknown") {
    f.run.subject.version = "unknown"
    f.run.origin.appLaunch.productVersion = "unknown"
    f.cite(f.run.origin.appLaunch)
  }
  writeFileSync(f.source, JSON.stringify(f.run))
  if (fault === "valid" || fault === "valid-argv") {
    expect(readFileSync(placeCollectedRun(f.source, f.manifest, f.content))).toEqual(readFileSync(f.source))
  } else {
    const errors = {
      version: /identity-replies-mismatch/,
      "argv-mismatch": /appLaunch/,
      "version-and-launch": /origin\.appLaunch\.productVersion differs/,
      digest: /origin\.appLaunch\.executableSha256 differs/,
      path: /origin\.appLaunch\.executablePath differs/,
      artifact: /origin\.appLaunch\.sourceArtifact differs/,
      missing: /requires a cited github-hosted-runner/,
      shared: /requires a cited github-hosted-runner/,
      target: /identity-replies-mismatch/,
      unknown: /identity-replies-mismatch/,
    }
    expect(() => placeCollectedRun(f.source, f.manifest, f.content)).toThrow(errors[fault])
    expect(readdirSync(join(f.content, "probes-apps"))).toEqual([])
    expect(existsSync(join(f.content, "suites"))).toBe(false)
  }
})

// Accepted: Windows Alacritty must identify its measured executable and exactly the pinned Mesa DLL set.
// The retired assessor never exercised the placement preflight and its no-write guarantee.
test.each(["valid", "wrong-da", "missing-mesa", "wrong-executable", "extra-dll"] as const)(
  "Windows Alacritty Mesa placement: %s",
  (fault) => {
    const f = fixture(true)
    if (fault === "wrong-da") {
      f.run.rawReplies["collector.xtversion"] = "\x1b[?6c"
      f.run.rawReplies["device.primary-da"] = "\x1b[?6c"
    }
    if (fault === "missing-mesa") delete f.run.origin.appLaunch.mesaRenderer
    if (fault === "wrong-executable") f.run.origin.appLaunch.executablePath = String.raw`C:\runner\WindowsTerminal.exe`
    if (fault === "extra-dll") {
      f.run.origin.appLaunch.mesaRenderer!.dlls.push({
        name: "libglapi.dll",
        path: String.raw`D:\a\_temp\alacritty\libglapi.dll`,
        sha256: "e6".repeat(32),
      })
      f.cite(f.run.origin.appLaunch)
    }
    writeFileSync(f.source, JSON.stringify(f.run))
    if (fault === "valid") {
      expect(readFileSync(placeCollectedRun(f.source, f.manifest, f.content))).toEqual(readFileSync(f.source))
    } else {
      const error = fault === "extra-dll" ? /not exactly the Mesa3D set opengl32\.dll/ : /identity-replies-mismatch/
      expect(() => placeCollectedRun(f.source, f.manifest, f.content)).toThrow(error)
      expect(readdirSync(join(f.content, "probes-apps"))).toEqual([])
      expect(existsSync(join(f.content, "suites"))).toBe(false)
    }
  },
)
