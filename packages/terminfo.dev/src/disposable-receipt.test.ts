/**
 * @failure A forged, absent or wrong-kind receipt authorizes mutate+readback, or a valid one is refused at a leaf field.
 * @level l1
 * @consumer The collector's disposable-ownership gate, checked once before its first write.
 * @testonly none
 * @reach fs-walk <fixture-only: /tmp/terminfo-disposable-receipts>
 */
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import {
  HOSTED_IDENTITY_SOURCES,
  bindReceiptToRun,
  parseDisposableReceipt,
  readDisposableReceipt,
  sampleOwnedHostIdentity,
  parseMuxAttachmentProof,
  parseLstart,
} from "./disposable-receipt.ts"

const digest = (seed: string) => createHash("sha256").update(seed).digest("hex")
const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

const envelope = { schemaVersion: 1, runId: "b".repeat(32), collectedAt: "2026-10-06T22:00:00Z" }

// A retained process snapshot is historical data, never a reason to query the current /proc tree.
// The existing host-receipt cases cannot catch silently discarded mux custody fields.
const linuxProof = () => {
  const process = (pid: number) => ({ pid, startTicks: String(1000 + pid) })
  return {
    platform: "linux" as const,
    mux: "tmux" as const,
    bootId: "11111111-2222-3333-4444-555555555555",
    receiptSha256: digest("fixture"),
    launchRunId: "12".repeat(16),
    captureRunId: "34".repeat(16),
    preflightCollector: process(95),
    outerShell: { ...process(92), ttyRdev: 34816 },
    outerTerminal: process(76),
    collector: { ...process(149), ttyRdev: 34817 },
    attachedClient: { ...process(148), ttyRdev: 34816 },
    chain: [149, 145, 92, 76].map((pid) => ({
      ...process(pid),
      executablePath: "/nix/store/mux/bin/tmux",
      ttyRdev: pid === 149 ? 34817 : 34816,
    })),
    executable: { path: "/nix/store/mux/bin/tmux", sha256: digest("tmux"), version: "3.7c" },
    config: { path: "/tmp/run/mux.conf", sha256: digest("") },
    socketPath: "/tmp/run/mux.sock",
    session: "owned",
  }
}

// A retained process snapshot is historical data, never a reason to query the current /proc tree.
// The existing host-receipt cases cannot catch silently discarded mux custody fields.
test("mux attachment preserves its measured chain and refuses malformed or mixed proof fields", () => {
  const proof = linuxProof()
  expect(parseMuxAttachmentProof(proof)).toEqual(proof)
  for (const chain of [
    proof.chain.filter((row) => row.pid !== 145),
    [proof.chain[0], proof.chain[2], proof.chain[1], proof.chain[3]],
  ]) {
    expect.soft(() => parseMuxAttachmentProof({ ...proof, chain })).toThrow(/mux attachment/)
  }
  for (const invalid of [
    { ...proof, extra: true },
    { ...proof, platform: "darwin" },
    { ...proof, mux: "other" },
    { ...proof, receiptSha256: "missing" },
    { ...proof, captureRunId: "missing" },
    { ...proof, collector: { ...proof.collector, pid: 0 } },
    { ...proof, collector: { ...proof.collector, startTicks: "1.5" } },
    { ...proof, attachedClient: { ...proof.attachedClient, ttyRdev: -1 } },
    { ...proof, chain: [] },
    { ...proof, executable: { ...proof.executable, path: "relative" } },
    { ...proof, executable: { ...proof.executable, version: "" } },
    { ...proof, collector: { ...proof.collector, startTicks: "9999" } },
    { ...proof, outerShell: { ...proof.outerShell, startTicks: "9999" } },
    { ...proof, collector: { ...proof.collector, ttyRdev: proof.outerShell.ttyRdev } },
    { ...proof, attachedClient: { ...proof.attachedClient, ttyRdev: proof.collector.ttyRdev } },
    { ...proof, chain: proof.chain.slice(1) },
    { ...proof, chain: [...proof.chain, proof.chain[0]] },
    {
      ...proof,
      chain: proof.chain.map((row) => (row.pid === 145 ? { ...row, executablePath: "/usr/bin/foreign" } : row)),
    },
  ]) {
    expect(() => parseMuxAttachmentProof(invalid)).toThrow(/mux attachment/)
  }
})

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
  declaredTarget: { kind: "term", id: "kitty", version: "0.49.2", os: "linux" },
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

/** The launch receipt a hosted macOS job measures from its own bundle and installer bytes (28216). */
const macosLaunch = () => ({
  bundlePath: "/Applications/iTerm.app",
  cfBundleShortVersionString: "3.6.11",
  cfBundleVersion: "3.6.11",
  executablePath: "/Applications/iTerm.app/Contents/MacOS/iTerm2",
  executableSha256: digest("iterm2-executable"),
  sourceArtifact: { path: "/Library/Caches/Homebrew/downloads/iterm2--3.6.11.zip", sha256: digest("iterm2-installer") },
})

test("a well-formed container receipt parses and its digest is the exact bytes that were trusted", () => {
  const bytes = JSON.stringify(linuxReceipt(), null, 2)
  const receipt = parseDisposableReceipt(bytes)
  expect(receipt).toEqual({
    kind: "linux-xvfb-container",
    runId: envelope.runId,
    collectedAt: envelope.collectedAt,
    declaredTarget: { kind: "term", id: "kitty", os: "linux" },
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

// 28216: the launch receipt the apparatus measured rides the receipt itself, validated by the ONE
// parser run-parser validates with, so the collector copies a parsed block instead of a second copy.
test("a hosted-runner receipt carries the measured launch block through the ONE parser", () => {
  const withLaunch = { ...githubReceipt(), appLaunch: macosLaunch() }
  expect(parseDisposableReceipt(JSON.stringify(withLaunch)).appLaunch).toEqual(macosLaunch())
  // Copied, never edited: a receipt that measured no launch carries none, and says so by absence.
  expect(parseDisposableReceipt(JSON.stringify(githubReceipt())).appLaunch).toBeUndefined()
})

test("a launch block the ONE parser refuses fails the whole receipt by name", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ ...macosLaunch(), executableSha256: "not-a-digest" }, /invalid appLaunch\.executableSha256/],
    [{ ...macosLaunch(), bundlePath: "Applications/iTerm.app" }, /bundle and executable paths must be absolute/],
    [{ ...macosLaunch(), cfBundleVersion: "" }, /missing appLaunch\.cfBundleVersion/],
    [
      { ...macosLaunch(), sourceArtifact: { path: "/tmp/iterm2.zip", sha256: "short" } },
      /invalid appLaunch\.sourceArtifact/,
    ],
    [
      { ...macosLaunch(), sourceArtifact: { kind: "invented", path: "/tmp/x", sha256: digest("x") } },
      /unknown appLaunch\.sourceArtifact kind/,
    ],
  ]
  for (const [broken, expected] of cases) {
    const receipt = { ...githubReceipt(), appLaunch: broken }
    expect(() => parseDisposableReceipt(JSON.stringify(receipt)), JSON.stringify(broken)).toThrow(expected)
  }
})

test("a self-hosted or unknown runner environment can never authorize a write", () => {
  const selfHosted = githubReceipt()
  selfHosted.runner.environment = "self-hosted"
  expect(() => parseDisposableReceipt(JSON.stringify(selfHosted))).toThrow(/never assumed/)
  const unknown = { ...linuxReceipt(), kind: "a-person-s-laptop" }
  expect(() => parseDisposableReceipt(JSON.stringify(unknown))).toThrow(/unknown kind/)
})

// A transport receipt records where a run started and what bytes it moved. It grants
// nothing, so it is refused BY NAME here rather than only as an unrecognized kind.
test("a transport receipt is refused by name and never authorizes a write", () => {
  const transport = {
    ...envelope,
    kind: "owned-app-transport",
    grants: "nothing",
    sourceRevision: "a".repeat(40),
    hostKeyFingerprint: "SHA256:fixture",
  }
  expect(() => parseDisposableReceipt(JSON.stringify(transport))).toThrow(
    /owned-app-transport records where a run started and grants nothing/,
  )
})

// 27910: existing missing-field tests allow a YAML job key to masquerade as a jobs-API id.
// All three API identity fields must instead contain decimal digits, with jobId naming the trap.
test("hosted job identity requires decimal API ids and refuses GITHUB_JOB by name", () => {
  for (const key of ["githubRunId", "githubRunAttempt", "jobId"] as const) {
    for (const invalid of ["collect", "1.5", "-1", " 123", "123\n"]) {
      const receipt = githubReceipt()
      receipt.job[key] = invalid
      expect(() => parseDisposableReceipt(JSON.stringify(receipt)), `${key}=${JSON.stringify(invalid)}`).toThrow(
        new RegExp(`${key} must be decimal digits`),
      )
    }
  }
  const yamlKey = githubReceipt()
  yamlKey.job.jobId = yamlKey.job.job
  expect(() => parseDisposableReceipt(JSON.stringify(yamlKey))).toThrow(/GITHUB_JOB is a YAML key/)
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
  expect(receipt.declaredTarget).toEqual({ kind: "term", id: "kitty", os: "linux" })
  expect(() => bindReceiptToRun(receipt, { kind: "term", id: "kitty", os: "linux" }, "test")).not.toThrow()
  expect(() => bindReceiptToRun(receipt, { kind: "term", id: "wezterm", os: "linux" }, "test")).toThrow(
    /receipt declares target .*kitty.* but this run is .*wezterm/,
  )
  expect(() => bindReceiptToRun(receipt, { kind: "term", id: "kitty", os: "macos" }, "test")).toThrow(/os disagree/)
  expect(() => bindReceiptToRun(receipt, undefined, "test")).toThrow(/no run target was supplied to bind it to/)
})

// A kind that declares no target carries no target claim to bind; that absence is recorded, not faked.
test("a github-hosted receipt declares no target and is not refused for the absence", () => {
  const receipt = parseDisposableReceipt(JSON.stringify(githubReceipt()))
  expect(receipt.declaredTarget).toBeUndefined()
  expect(receipt.identity).toBeUndefined()
  expect(() => bindReceiptToRun(receipt, { kind: "term", id: "kitty", os: "linux" }, "test")).not.toThrow()
})

test("HOSTED_IDENTITY_SOURCES Windows patterns match real-format lines and capture exact values", () => {
  const sources = HOSTED_IDENTITY_SOURCES.Windows.sources

  // NIC MAC pattern matches real format line
  const macRegex = new RegExp(sources.machineIdSha256.pattern)
  const macLine = "00-0D-3A-12-34-56"
  const macMatch = macRegex.exec(macLine)
  expect(macMatch).toBeDefined()
  expect(macMatch?.[1]).toBe("00-0D-3A-12-34-56")

  // SMBIOS UUID pattern matches uppercase UUID
  const uuidRegex = new RegExp(sources.productUuidSha256.pattern)
  const uuidLine = "E0CB6CD7-0A6B-B82C-6940-30E6359CD7FD"
  const uuidMatch = uuidRegex.exec(uuidLine)
  expect(uuidMatch).toBeDefined()
  expect(uuidMatch?.[1]).toBe("E0CB6CD7-0A6B-B82C-6940-30E6359CD7FD")

  // LastBootUpTime pattern matches ISO UTC string
  const bootRegex = new RegExp(sources.bootIdSha256.pattern)
  const bootLine = "2026-10-07T07:57:50.5000000Z"
  const bootMatch = bootRegex.exec(bootLine)
  expect(bootMatch).toBeDefined()
  expect(bootMatch?.[1]).toBe("2026-10-07T07:57:50.5000000Z")
})

test("an owned host is sampled for the os its caller names, with no hosted-runner label", () => {
  // The os is an argument, never RUNNER_OS, and a refusal names an owned host, not a hosted receipt.
  expect(() => sampleOwnedHostIdentity("Plan9")).toThrow(
    'Owned host identity has no source table for os "Plan9"; known entries are Linux, macOS, Windows',
  )
  let refusal = ""
  try {
    sampleOwnedHostIdentity("Linux")
  } catch (error) {
    refusal = (error as Error).message
  }
  expect(refusal).toBe("Owned host identity machineIdSha256: source /etc/machine-id has no command to measure it")
  expect(refusal).not.toMatch(/Hosted|hosted|RUNNER_OS/)
})

// D4 (@cto 6710987a, revised on f94cc5e0): the Darwin arm is the union's second member, parsed by the
// same positional tests, from r13's measured chain — including the GUI outer terminal, which has no TTY.
const darwinProof = () => {
  const hop = (
    pid: number,
    ppid: number,
    uid: number,
    startedAtEpochSeconds: number,
    executablePath: string,
    ttyRdev: number | null,
  ) => ({ pid, ppid, uid, startedAtEpochSeconds, executablePath, ttyRdev })
  const owner = 55770
  const login = 55771
  const shell = 55772
  const server = 55800
  const collector = 55803
  return {
    platform: "darwin" as const,
    mux: "tmux" as const,
    bootId: "A1B2C3D4-1111-2222-3333-444455556666",
    receiptSha256: digest("owner-launch-record"),
    launchRunId: "12".repeat(16),
    captureRunId: "34".repeat(16),
    preflightCollector: { pid: 95, startedAtEpochSeconds: 1792678700 },
    outerShell: { pid: shell, startedAtEpochSeconds: 1792678807, ttyRdev: 268435456 },
    outerTerminal: { pid: owner, startedAtEpochSeconds: 1792678806 },
    collector: { pid: collector, startedAtEpochSeconds: 1792678808, ttyRdev: 268435459 },
    attachedClient: { pid: 55802, startedAtEpochSeconds: 1792678808, ttyRdev: 268435456 },
    chain: [
      hop(collector, server, 501, 1792678808, "/Users/codi/.bun/bin/bun", 268435459),
      hop(server, shell, 501, 1792678808, "/usr/local/Cellar/tmux/3.7/bin/tmux", 268435456),
      hop(shell, login, 501, 1792678807, "/bin/bash", 268435456),
      hop(login, owner, 0, 1792678807, "/usr/bin/login", 268435456),
      hop(owner, 55757, 501, 1792678806, "/Applications/Ghostty.app/Contents/MacOS/ghostty", null),
    ],
    executable: { path: "/usr/local/Cellar/tmux/3.7/bin/tmux", sha256: digest("tmux"), version: "3.7" },
    config: { path: "/tmp/run/tmux.conf", sha256: digest("") },
    socketPath: "/tmp/run/mux.sock",
    session: "owned",
  }
}

test("the Darwin mux arm parses r13's measured chain and refuses each deviation by name", () => {
  const proof = darwinProof()
  expect(parseMuxAttachmentProof(proof)).toEqual(proof)
  const withHop = (pid: number, change: Record<string, unknown>) => ({
    ...proof,
    chain: proof.chain.map((hop) => (hop.pid === pid ? { ...hop, ...change } : hop)),
  })
  const cases: [unknown, RegExp][] = [
    // D4.3: the root hop is exactly one uid-0 /usr/bin/login under the outer terminal.
    [withHop(55771, { executablePath: "/bin/bash" }), /chain root hop is not \/usr\/bin\/login/],
    [withHop(55771, { uid: 501 }), /chain root hop is not uid 0/],
    // D4.4: a ppid break refuses wherever it sits — at the server, and at the shell under login.
    [withHop(55800, { ppid: 99999 }), /chain\[1\]\): ppid 99999 does not name the next process/],
    [withHop(55772, { ppid: 1 }), /chain\[2\]\): ppid 1 does not name the next process/],
    // The rows between collector and shell name the declared mux executable.
    [
      withHop(55800, { executablePath: "/usr/bin/foreign" }),
      /chain process 55800 does not name the declared mux executable/,
    ],
    // Identity is pid plus the birth second: the same pid at another second is another process.
    [
      { ...proof, outerShell: { ...proof.outerShell, startedAtEpochSeconds: 1792678808 } },
      /outer shell identity or TTY is absent immediately below the outer terminal/,
    ],
    // D4.5: the client sits on the shell's PTY; collector and shell name distinct PTYs.
    [
      { ...proof, attachedClient: { ...proof.attachedClient, ttyRdev: 268435459 } },
      /attached client TTY differs from outer shell/,
    ],
    [
      {
        ...proof,
        collector: { ...proof.collector, ttyRdev: 268435456 },
        chain: proof.chain.map((hop, index) => (index === 0 ? { ...hop, ttyRdev: 268435456 } : hop)),
      },
      /collector and outer shell must name distinct PTYs/,
    ],
    [{ ...proof, chain: proof.chain.slice(1) }, /chain collector identity or TTY differs from collector/],
    // @cto e5016c9f: the root allowance is one login hop. Every other row carries the collector's uid,
    // so a root-owned server or shell cannot ride it.
    [withHop(55800, { uid: 0 }), /chain\[1\]\): uid 0 is not the collector's uid 501/],
    [withHop(55772, { uid: 0 }), /chain\[2\]\): uid 0 is not the collector's uid 501/],
    // Only the measured outer terminal may have no TTY, and "no TTY" is never 0 or NODEV.
    [withHop(55772, { ttyRdev: null }), /chain\[2\]\): has no TTY/],
    [withHop(55770, { ttyRdev: 0xffffffff }), /chain\[4\]\): has no TTY/],
    [withHop(55770, { ttyRdev: 0 }), /chain\[4\]\): has no TTY/],
    [{ ...proof, outerShell: { ...proof.outerShell, ttyRdev: null } }, /outerShell\): has no TTY/],
    // A wrong-typed device is not a measured absence; the refusal points at the shape it needs.
    [withHop(55772, { ttyRdev: "ttys000" }), /chain\[2\]\): ttyRdev must be a device number or null/],
    // D3 birth seconds are whole seconds on every row, and a Linux-shaped row refuses.
    [withHop(55803, { startedAtEpochSeconds: 0 }), /chain\[0\]\): startedAtEpochSeconds must be a whole epoch second/],
    [
      withHop(55803, { startedAtEpochSeconds: undefined }),
      /chain\[0\]\): startedAtEpochSeconds must be a whole epoch second/,
    ],
    [
      { ...proof, chain: proof.chain.map((hop, index) => (index === 0 ? { ...hop, startTicks: "1234" } : hop)) },
      /chain\[0\]\): invalid fields/,
    ],
    [{ ...proof, extra: true }, /invalid fields/],
    [{ ...proof, platform: "windows" }, /platform must be linux or darwin/],
  ]
  for (const [invalid, refusal] of cases) {
    expect(() => parseMuxAttachmentProof(invalid), String(refusal)).toThrow(refusal)
  }
  // Linux gets no root allowance: the same Linux bytes with a login row inserted at [-2] refuse.
  const linux = linuxProof()
  const loginRow = { pid: 55771, startTicks: "9000", executablePath: "/usr/bin/login", ttyRdev: 34816 }
  const withLogin = { ...linux, chain: [...linux.chain.slice(0, -1), loginRow, linux.chain[linux.chain.length - 1]] }
  expect(() => parseMuxAttachmentProof(withLogin)).toThrow(
    /outer shell identity or TTY is absent immediately below the outer terminal/,
  )
})

// #30518 (@cto e29901ef, r14 measurement 2c1d269c): Screen's seven measured rows, child to parent.
// The backend is `/usr/bin/SCREEN` with no PTY and the frontend `/usr/bin/screen` owns ttys000, so the
// mux is proved by the kernel's executed path and never by argv0; the pane login is on the collector's
// own PTY and both uid-0 rows resolve to /usr/bin/login.
const screenProof = () => {
  const kernel = (
    path: string,
    error: string | null = null,
    reader: "proc_pidpath" | "KERN_PROCARGS2" | null = "proc_pidpath",
  ) => ({
    kernelExecutable: path,
    kernelExecutableReader: path === null ? null : reader,
    kernelExecutableError: error,
    kernelExecutableAttempts: [{ reader: reader ?? "proc_pidpath", result: path === null ? -1 : path.length, error }],
  })
  const hop = (
    pid: number,
    ppid: number,
    uid: number,
    startedAtEpochSeconds: number,
    executablePath: string,
    ttyRdev: number | null,
    executable: string,
  ) => ({ pid, ppid, uid, startedAtEpochSeconds, executablePath, ttyRdev, ...kernel(executable) })
  const owner = 40673
  const login = 40674
  const shell = 40675
  const client = 40703
  const server = 40704
  const paneLogin = 40705
  const collector = 40706
  const ttys003 = 268435459
  const ttys000 = 268435456
  return {
    platform: "darwin" as const,
    mux: "screen" as const,
    bootId: "A1B2C3D4-1111-2222-3333-444455556666",
    receiptSha256: digest("owner-launch-record"),
    launchRunId: "12".repeat(16),
    captureRunId: "34".repeat(16),
    preflightCollector: { pid: 95, startedAtEpochSeconds: 1792678700 },
    outerShell: { pid: shell, startedAtEpochSeconds: 1792678807, ttyRdev: ttys000 },
    outerTerminal: { pid: owner, startedAtEpochSeconds: 1792678806 },
    collector: { pid: collector, startedAtEpochSeconds: 1792678808, ttyRdev: ttys003 },
    attachedClient: { pid: client, startedAtEpochSeconds: 1792678806, ttyRdev: ttys000 },
    chain: [
      hop(collector, paneLogin, 501, 1792678808, "/Users/codi/.bun/bin/bun", ttys003, "/Users/codi/.bun/bin/bun"),
      hop(paneLogin, server, 0, 1792678808, "login", ttys003, "/usr/bin/login"),
      hop(server, client, 501, 1792678807, "/usr/bin/SCREEN", null, "/usr/bin/screen"),
      hop(client, shell, 501, 1792678806, "/usr/bin/screen", ttys000, "/usr/bin/screen"),
      hop(shell, login, 501, 1792678807, "/bin/bash", ttys000, "/bin/bash"),
      hop(login, owner, 0, 1792678805, "/usr/bin/login", ttys000, "/usr/bin/login"),
      hop(
        owner,
        40672,
        501,
        1792678806,
        "/Applications/Ghostty.app/Contents/MacOS/ghostty",
        null,
        "/Applications/Ghostty.app/Contents/MacOS/ghostty",
      ),
    ],
    executable: {
      path: "/usr/bin/screen",
      sha256: digest("screen"),
      version: "Screen version 4.00.03 (FAU) 23-Oct-06",
    },
    config: { path: "/tmp/run/screenrc", sha256: digest("") },
    socketPath: "/tmp/run/screen",
    session: "owned",
  }
}

// The seven rows r14 measured (chain-check.observation.json c6eaf865): R1-R4 hold, so the arm admits.
test("the Screen arm admits r14's seven measured rows", () => {
  const proof = screenProof()
  expect(parseMuxAttachmentProof(proof)).toEqual(proof)
})

test("the Screen arm refuses each R1-R4 departure by name, over kernel paths", () => {
  const proof = screenProof()
  const withRow = (pid: number, change: Record<string, unknown>) => ({
    ...proof,
    chain: proof.chain.map((hop) => (hop.pid === pid ? { ...hop, ...change } : hop)),
  })
  const cases: [unknown, RegExp][] = [
    // R1: the pane login is uid 0 under the server, on the collector's own PTY, and is the login program.
    [withRow(40705, { uid: 501 }), /chain\[1\].*pane login pid 40705 is uid 501, not 0/],
    [withRow(40705, { ttyRdev: 268435456 }), /chain\[1\].*pane login pid 40705 is not on the collector's TTY/],
    [
      withRow(40705, { kernelExecutable: "/bin/bash" }),
      /chain\[1\].*kernel path is \/bin\/bash, not \/usr\/bin\/login/,
    ],
    // A1: argv0 is not evidence. The pane login whose kernel read went unanswered refuses by name,
    // naming the reader and its errno, even though its argv0 is already `login`.
    [
      withRow(40705, {
        kernelExecutable: null,
        kernelExecutableReader: null,
        kernelExecutableError: "returned 0, errno 1",
      }),
      /chain\[1\].*pid 40705 has no kernel executable path \(reader did not answer: returned 0, errno 1\)/,
    ],
    // R3 (@cto): the group is one measurement, so its four fields must agree with each other.
    [
      withRow(40705, { kernelExecutable: null, kernelExecutableReader: "proc_pidpath" }),
      /kernelExecutableReader names a reader but no path/,
    ],
    [
      withRow(40705, {
        kernelExecutable: "/usr/bin/login",
        kernelExecutableError: "proc_pidpath: returned 0, errno 1",
      }),
      /a kernel executable path carries an error/,
    ],
    [
      withRow(40705, { kernelExecutable: null, kernelExecutableReader: null, kernelExecutableError: null }),
      /a kernel read with no path names neither a reader nor an error/,
    ],
    [
      withRow(40705, { kernelExecutable: "/usr/bin/login", kernelExecutableReader: null }),
      /a kernel executable path names no reader/,
    ],
    // R2: exactly two uid-0 rows, both the login program; a third root row is not an exception.
    [withRow(40675, { uid: 0 }), /uid-0 rows .*40705,40675.*; exactly the pane login and the root login/],
    [
      withRow(40674, { kernelExecutable: "/usr/bin/su" }),
      /chain\[5\].*root login pid 40674 kernel path is \/usr\/bin\/su, not \/usr\/bin\/login/,
    ],
    // R3: the backend owns no PTY, its parent is the frontend, and both are the kernel's own binary.
    [withRow(40704, { ttyRdev: 268435456 }), /chain\[2\].*server pid 40704 carries TTY 268435456/],
    [
      withRow(40704, { kernelExecutable: "/usr/bin/SCREEN" }),
      /chain\[2\].*mux pid 40704 kernel path is \/usr\/bin\/SCREEN, not \/usr\/bin\/screen/,
    ],
    [
      withRow(40703, { kernelExecutable: "/usr/local/bin/screen" }),
      /chain\[3\].*mux pid 40703 kernel path is \/usr\/local\/bin\/screen, not \/usr\/bin\/screen/,
    ],
    [withRow(40703, { ttyRdev: 268435459 }), /chain\[3\].*client pid 40703 is not on the outer shell's TTY/],
    // R2 (@cto): the shell row's TTY is the declared outer shell's, not a second opinion beside it.
    [
      { ...proof, outerShell: { ...proof.outerShell, ttyRdev: 268435458 } },
      /chain outer shell TTY differs from the declared outer shell/,
    ],
    // R4: the attachment IS the row measured as the server's parent - never a separate screen query.
    [
      { ...proof, attachedClient: { ...proof.attachedClient, pid: 40704 } },
      /the attached client is not the row the chain measured as the server's parent/,
    ],
    // The ppid walk refuses a break before any rule can misread it.
    [withRow(40704, { ppid: 99999 }), /chain\[2\].*ppid 99999 does not name the next process/],
    [withRow(40703, { ppid: 99999 }), /chain\[3\].*ppid 99999 does not name the next process/],
  ]
  for (const [invalid, refusal] of cases) {
    expect(() => parseMuxAttachmentProof(invalid), String(refusal)).toThrow(refusal)
  }
})

test("the Screen arm admits one version line and one chain length", () => {
  const proof = screenProof()
  const version = (text: string) => ({ ...proof, executable: { ...proof.executable, version: text } })
  expect(() => parseMuxAttachmentProof(version("Screen version 5.0.1 (GNU) 20-Aug-24"))).toThrow(
    /screen executable version is not the admitted 4\.00\.03 line/,
  )
  expect(() => parseMuxAttachmentProof(version("screen 4.00.03"))).toThrow(/not the admitted 4\.00\.03 line/)
  // The measured line survives a trailing build suffix on either stream.
  expect(parseMuxAttachmentProof(version("Screen version 4.00.03\r\n")).executable.version).toBe(
    "Screen version 4.00.03\r\n",
  )
  // R1 (@cto): argv0 tolerance stops at the Screen arm. The r13 tmux shell row that is not a path
  // refuses exactly as it did before this arm existed.
  expect(() =>
    parseMuxAttachmentProof({
      ...darwinProof(),
      chain: darwinProof().chain.map((hop) => (hop.pid === 55772 ? { ...hop, executablePath: "bash" } : hop)),
    }),
  ).toThrow(/chain\[2\]\): executablePath must be an absolute path/)
  // An eighth row is not the measured shape, even when every other rule would pass.
  const extra = {
    ...proof,
    chain: [
      ...proof.chain.slice(0, 5),
      { ...proof.chain[5], pid: 40707, ppid: 40674, executablePath: "/bin/zsh", kernelExecutable: "/bin/zsh" },
      ...proof.chain.slice(5),
    ],
  }
  extra.chain[4] = { ...extra.chain[4]!, ppid: 40707 }
  expect(() => parseMuxAttachmentProof(extra)).toThrow(/screen chain has 8 rows; the measured shape has 7/)
})

// D3 (@cto 72e4b60b): `parseLstart` is the only lstart reader, so each refusal is proved by its text.
test("the lstart reader takes one C-locale UTC line and refuses every other shape by name", () => {
  // macOS ps pads the day with a space; that is the measured form and it parses.
  expect(parseLstart("Fri Oct  2 18:07:34 2026\n")).toBe(Date.UTC(2026, 9, 2, 18, 7, 34) / 1000)
  expect(parseLstart("Thu Oct 22 18:07:34 2026    \n")).toBe(Date.UTC(2026, 9, 22, 18, 7, 34) / 1000)
  const notOneLine = /is not one C-locale "Www Mmm dd hh:mm:ss yyyy" line/
  const noRealSecond = /names no real UTC second/
  // A zero-padded day is a GNU-locale form, not the one ps emits here.
  expect(() => parseLstart("Fri Oct 02 18:07:34 2026\n")).toThrow(notOneLine)
  // A non-C locale names its months in its own words.
  expect(() => parseLstart("Do Okt 22 18:07:34 2026\n")).toThrow(notOneLine)
  expect(() => parseLstart("jeu. oct. 22 18:07:34 2026\n")).toThrow(notOneLine)
  // A date that does not exist, and a weekday that names another day.
  expect(() => parseLstart("Mon Feb 30 12:00:00 2026\n")).toThrow(noRealSecond)
  expect(() => parseLstart("Wed Oct 22 18:07:34 2026\n")).toThrow(noRealSecond)
  // Two instants in one read are not one lstart.
  expect(() => parseLstart("Thu Oct 22 18:07:34 2026\nThu Oct 22 18:07:34 2026\n")).toThrow(notOneLine)
})
