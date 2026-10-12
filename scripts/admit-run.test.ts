/**
 * @failure A run can be admitted against a suite this tree does not run, so its manifest is computed from the wrong probe-defs; or a concurrent admission of the same run can overwrite different bytes; or the run can be misnamed; or the ownership receipt a run cites can go unread, so a hand-typed identity that nothing measured is admitted beside the run it claims to authorize.
 * @level l1
 * @consumer The one declare-and-admit entry point (27859)
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/ vendor/terminfo.dev/packages/probes/
 * @reach fs-walk <fixture-only: mkdtempSync run and destination directories>
 * @testonly none
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { parseJsonStrict, parseRun, parseSuiteManifest } from "@terminfo/run-parser"
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

const temporaryPaths: string[] = []
afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true })
})
const temp = (prefix: string): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryPaths.push(directory)
  return directory
}

function runFixture(overrides: Record<string, unknown> = {}): string {
  const directory = temp("terminfo-admit-")
  const path = join(directory, "run.json")
  // Planning now assesses the full run. Reuse a genuinely complete clean collection rather than
  // letting filename-only fixtures bypass the contract these callers must satisfy.
  const complete = parseJsonStrict(
    "complete clean admission fixture",
    readFileSync(
      join(
        import.meta.dirname,
        "..",
        "content",
        "probes-apps",
        "kitty-0.49.2-linux-dfd4cd08416fb5f3be3eaeed5acce782.json",
      ),
      "utf8",
    ),
  )
  if (!object(complete) || !object(complete.provenance) || !object(complete.provenance.runtime)) {
    throw new Error("Complete clean admission fixture has no runtime provenance")
  }
  complete.provenance.runtime.suiteHash = probeSuiteSnapshot().probeHash
  writeFileSync(
    path,
    JSON.stringify({
      ...complete,
      probeHash: probeSuiteSnapshot().probeHash,
      runId: "run1",
      ...overrides,
    }),
  )
  return path
}

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
  const measured = { ...run, origin: { ...run.origin, appLaunch: receipt } }
  expect(assessRunAdmission(measured)).toMatchObject({ accepted: true })
  for (const version of [`${receipt.productVersion} `, "1.21.2361.0"]) {
    expect(assessRunAdmission({ ...measured, target: { ...measured.target, version } })).toMatchObject({
      accepted: false,
      reason: "identity-replies-mismatch",
    })
  }
  expect(assessRunAdmission(run)).toMatchObject({ accepted: false, reason: "identity-replies-mismatch" })
})

test("a run is named from its own target and run id", () => {
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
