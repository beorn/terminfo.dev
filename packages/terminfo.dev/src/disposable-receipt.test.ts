/**
 * @failure A forged, absent or wrong-kind receipt authorizes mutate+readback, or a valid one is refused at a leaf field.
 * @level l1
 * @consumer The collector's disposable-ownership gate, checked once before its first write.
 * @testonly none
 * @reach fs-walk /tmp/terminfo-disposable-receipts
 */
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { bindReceiptToRun, parseDisposableReceipt, readDisposableReceipt } from "./disposable-receipt.ts"

const digest = (seed: string) => createHash("sha256").update(seed).digest("hex")
const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

const envelope = { schemaVersion: 1, runId: "b".repeat(32), collectedAt: "2026-10-06T22:00:00Z" }

const identity = (seed: string) => ({
  machineIdSha256: digest(`${seed}-machine`),
  productUuidSha256: digest(`${seed}-uuid`),
  bootIdSha256: digest(`${seed}-boot`),
})

const linuxReceipt = () => ({
  ...envelope,
  kind: "linux-xvfb-container",
  runtime: {
    imageId: "sha256:" + digest("image"),
    imageTarSha256: digest("tar"),
    arch: "amd64",
    nixLockRevision: digest("nix").slice(0, 40),
    sourceRevision: "d".repeat(40),
    sourceTreeStatus: "clean",
    rootRevision: "e".repeat(40),
    suiteHash: "f".repeat(12),
  },
  runnerArtifact: { frozenRunnerSha256: digest("runner"), buildReceiptSha256: digest("build") },
  declaredTarget: { kind: "app", id: "kitty", version: "0.49.2", os: "linux" },
  preset: "current",
  clipboardProfile: "default",
})

const githubReceipt = () => ({
  ...envelope,
  kind: "github-hosted-runner",
  job: {
    repository: "beorn/terminfo.dev",
    workflow: "collect.yml",
    workflowRef: "beorn/terminfo.dev/.github/workflows/collect.yml@refs/heads/main",
    githubRunId: "1234567890",
    githubRunAttempt: "1",
    job: "collect",
    jobId: "987654321",
  },
  runner: {
    environment: "github-hosted",
    name: "GitHub Actions 12",
    os: "Linux",
    arch: "X64",
    imageOS: "ubuntu24",
    imageVersion: "20250901.1.0",
    trackingId: "a".repeat(32),
  },
  vm: { identityAtJobStart: identity("job"), identityAtCollection: identity("job") },
})

test("a well-formed container receipt parses and its digest is the exact bytes that were trusted", () => {
  const bytes = JSON.stringify(linuxReceipt(), null, 2)
  const receipt = parseDisposableReceipt(bytes)
  expect(receipt).toEqual({
    kind: "linux-xvfb-container",
    runId: envelope.runId,
    collectedAt: envelope.collectedAt,
    declaredTarget: { kind: "app", id: "kitty", os: "linux" },
    identity: {
      imageId: "sha256:" + digest("image"),
      imageTarSha256: digest("tar"),
      arch: "amd64",
      nixLockRevision: digest("nix").slice(0, 40),
      frozenRunnerSha256: digest("runner"),
      buildReceiptSha256: digest("build"),
    },
    sha256: createHash("sha256").update(bytes).digest("hex"),
  })
})

test("a well-formed hosted-runner receipt parses only when one machine served the whole job", () => {
  expect(parseDisposableReceipt(JSON.stringify(githubReceipt())).kind).toBe("github-hosted-runner")
  const moved = githubReceipt()
  moved.vm.identityAtCollection = identity("other")
  expect(() => parseDisposableReceipt(JSON.stringify(moved))).toThrow(/one machine must serve the whole job/)
})

test("a self-hosted or unknown runner environment can never authorize a write", () => {
  const selfHosted = githubReceipt()
  selfHosted.runner.environment = "self-hosted"
  expect(() => parseDisposableReceipt(JSON.stringify(selfHosted))).toThrow(/never assumed/)
  const unknown = { ...linuxReceipt(), kind: "a-person-s-laptop" }
  expect(() => parseDisposableReceipt(JSON.stringify(unknown))).toThrow(/unknown kind/)
})

test("every forgeable envelope field and leaf field is refused loudly", () => {
  const cases: Array<[string, RegExp]> = [
    ["not json at all", /is not JSON/],
    [JSON.stringify([1, 2, 3]), /must be a JSON object/],
    [JSON.stringify({ ...linuxReceipt(), schemaVersion: 2 }), /schemaVersion must be 1/],
    [JSON.stringify({ ...linuxReceipt(), runId: "A".repeat(32) }), /runId must be 32 lowercase hex/],
    [JSON.stringify({ ...linuxReceipt(), collectedAt: "yesterday" }), /collectedAt must be an RFC3339 UTC instant/],
    [JSON.stringify({ ...linuxReceipt(), runtime: undefined }), /runtime must be an object/],
  ]
  for (const [bytes, expected] of cases) {
    expect(() => parseDisposableReceipt(bytes), bytes.slice(0, 60)).toThrow(expected)
  }
  const noSuite = linuxReceipt()
  delete (noSuite.runtime as Record<string, unknown>).suiteHash
  expect(() => parseDisposableReceipt(JSON.stringify(noSuite))).toThrow(/suiteHash must be a non-empty string/)
  const shortDigest = linuxReceipt()
  shortDigest.runnerArtifact.frozenRunnerSha256 = "abc"
  expect(() => parseDisposableReceipt(JSON.stringify(shortDigest))).toThrow(/must be a sha256 digest/)
  const badProfile = { ...linuxReceipt(), clipboardProfile: "allow-everything" }
  expect(() => parseDisposableReceipt(JSON.stringify(badProfile))).toThrow(/clipboardProfile must be one of/)
  const noJobId = githubReceipt()
  delete (noJobId.job as Record<string, unknown>).jobId
  expect(() => parseDisposableReceipt(JSON.stringify(noJobId))).toThrow(/jobId must be a non-empty string/)
  const noTracking = githubReceipt()
  delete (noTracking.runner as Record<string, unknown>).trackingId
  expect(() => parseDisposableReceipt(JSON.stringify(noTracking))).toThrow(/trackingId must be a non-empty string/)
  const noVm = githubReceipt()
  delete (noVm as Record<string, unknown>).vm
  expect(() => parseDisposableReceipt(JSON.stringify(noVm))).toThrow(/vm must be an object/)
})

// 27874: the four receipts behind the reopened 27874 epic were hand-typed, and the fields nothing
// derived were all zeros — while this repo's own fixtures were placeholder-shaped too, which is how
// such an envelope passed. A placeholder is now refused by name, before any byte is written.
test("a placeholder identity is refused by name, never admitted as a measurement", () => {
  const zeroedImage = linuxReceipt()
  zeroedImage.runtime.imageId = "sha256:" + "0".repeat(64)
  expect(() => parseDisposableReceipt(JSON.stringify(zeroedImage))).toThrow(
    /imageId is a placeholder: one repeated character/,
  )
  const zeroedTar = linuxReceipt()
  zeroedTar.runtime.imageTarSha256 = "0".repeat(64)
  expect(() => parseDisposableReceipt(JSON.stringify(zeroedTar))).toThrow(
    /imageTarSha256 is a placeholder: one repeated character/,
  )
  const zeroedLock = linuxReceipt()
  zeroedLock.runtime.nixLockRevision = "0".repeat(40)
  expect(() => parseDisposableReceipt(JSON.stringify(zeroedLock))).toThrow(
    /nixLockRevision is a placeholder: one repeated character/,
  )
  const repeatedRunner = linuxReceipt()
  repeatedRunner.runnerArtifact.frozenRunnerSha256 = "a".repeat(64)
  expect(() => parseDisposableReceipt(JSON.stringify(repeatedRunner))).toThrow(
    /frozenRunnerSha256 is a placeholder: one repeated character/,
  )
})

test("an image identity must name its scheme and come from docker inspect", () => {
  const bareDigest = linuxReceipt()
  bareDigest.runtime.imageId = digest("image")
  expect(() => parseDisposableReceipt(JSON.stringify(bareDigest))).toThrow(/imageId must name its scheme/)
  const inventedArch = linuxReceipt()
  inventedArch.runtime.arch = "x86_64"
  expect(() => parseDisposableReceipt(JSON.stringify(inventedArch))).toThrow(/arch must be one of amd64, arm64/)
})

test("an absent receipt is loud at read time, never an empty object that reads as authorization", () => {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-disposable-receipts-"))
  directories.push(directory)
  expect(() => readDisposableReceipt(join(directory, "missing.json"))).toThrow(/unreadable at/)
  const path = join(directory, "receipt.json")
  writeFileSync(path, JSON.stringify(linuxReceipt()))
  expect(readDisposableReceipt(path).kind).toBe("linux-xvfb-container")
})

// 27874 part 2: consistent bytes for the WRONG terminal are still wrong. The run's own target is the
// binding side — never a value read back out of the receipt — and the check is loud by name.
test("a receipt binds only to the target it declares, and cannot bind to none", () => {
  const receipt = parseDisposableReceipt(JSON.stringify(linuxReceipt()))
  expect(receipt.declaredTarget).toEqual({ kind: "app", id: "kitty", os: "linux" })
  expect(() => bindReceiptToRun(receipt, { kind: "app", id: "kitty", os: "linux" }, "test")).not.toThrow()
  expect(() => bindReceiptToRun(receipt, { kind: "app", id: "wezterm", os: "linux" }, "test")).toThrow(
    /receipt declares target .*kitty.* but this run is .*wezterm/,
  )
  expect(() => bindReceiptToRun(receipt, { kind: "app", id: "kitty", os: "macos" }, "test")).toThrow(/os disagree/)
  expect(() => bindReceiptToRun(receipt, undefined, "test")).toThrow(/no run target was supplied to bind it to/)
})

// A kind that declares no target carries no target claim to bind; that absence is recorded, not faked.
test("a github-hosted receipt declares no target and is not refused for the absence", () => {
  const receipt = parseDisposableReceipt(JSON.stringify(githubReceipt()))
  expect(receipt.declaredTarget).toBeUndefined()
  expect(receipt.identity).toBeUndefined()
  expect(() => bindReceiptToRun(receipt, { kind: "app", id: "kitty", os: "linux" }, "test")).not.toThrow()
})
