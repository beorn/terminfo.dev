/**
 * @failure Collection loses or misbinds persisted evidence, or publishes invalid bytes.
 * @level l1
 * @consumer Corpus placement and stored-run readers
 * @testonly none
 * @reach fs-read vendor/terminfo.dev/content/features.json vendor/terminfo.dev/content/suites/**
 * @reach fs-walk <fixture-only: isolated collection and content directories>
 */
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import { initializeRunDraft, type CapturedRunDraft } from "@terminfo/probe-defs"
import { finalizeCollectedDraft } from "../packages/terminfo.dev/src/capture-writer.ts"
import { parseSuiteManifest, parseRun, parseJsonStrict } from "@terminfo/run-parser"
import { parseOuterLaunchRecord, serializeOuterLaunchRecord } from "../packages/admin/src/outer-launch.ts"
import { loadStoredRuns, placeCollectedRun } from "../packages/admin/corpus-placement.ts"
import { writeCollectedRun } from "../packages/admin/src/collected-run.ts"
import { derivedSuiteManifest, probeSuiteSnapshot } from "../packages/admin/versions.ts"

const dirs: string[] = []
afterEach(() => {
  // raw-delete-allow: dirs contains only fixture directories created by this test's mkdtempSync.
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
function muxSpecimen() {
  const path = join(import.meta.dirname, "../content/probes-mux/tmux-3.8-linux-ea920f3547c0e7f0ced0f80b277f2939.json")
  const historicalPath = join(import.meta.dirname, "../content/suites/4b01b0117e18.json")
  const historical = parseSuiteManifest(historicalPath, readFileSync(historicalPath, "utf8"))
  const run = parseRun(
    path,
    readFileSync(path, "utf8"),
    historical.catalogIds!,
    new Map([[historical.probeHash, historical]]),
  )
  if (!run.outerApp?.provenance || !run.sourceRevision) throw new Error("Mux specimen lacks native outer proof")
  return {
    ...run,
    sourceRevision: run.sourceRevision,
    outerApp: { ...run.outerApp, provenance: run.outerApp.provenance },
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "terminfo-placement-"))
  dirs.push(dir)
  const content = join(dir, "content")
  mkdirSync(content)
  copyFileSync(join(import.meta.dirname, "../content/features.json"), join(content, "features.json"))
  for (const name of ["probes-apps", "probes-libs", "probes-mux"]) mkdirSync(join(content, name))
  const currentManifest = { ...derivedSuiteManifest(probeSuiteSnapshot()), schemaVersion: 4 as const }
  const subject = {
    kind: "lib" as const,
    id: "xtermjs",
    version: "6.0.0",
    os: "linux",
    osVersion: null,
    outerTerminal: null,
    mux: null,
    config: null,
    permissions: null,
  }
  const draft = initializeRunDraft({
    runId: "fixture-run",
    sourceRevision: "a".repeat(40),
    manifest: currentManifest,
    source: { kind: "live" },
    intendedSubject: subject,
  })
  Object.assign(draft, {
    subject,
    identity: "verified",
    measuredAt: "2026-10-21T05:00:00.000Z",
    origin: { kind: "collector" },
    runtimeIdentity: {
      kind: "js",
      adapterVersion: "0.10.2",
      termlessRevision: "4b39770c169ec393cfd6ec7f59110e91c9c9d0c5",
      resolvedPath: "node_modules/@xterm/headless/lib-headless/xterm-headless.js",
      integrity: {
        kind: "registry",
        lockIntegrity:
          "sha512-5Yj1QINYCyzrZtf8OFIHi47iQtI+0qYFPHmouEfG8dHNxbZ9Tb9YGSuLcsEwj9Z+OL75GJqPyJbyoFer80a2Hw==",
      },
      runtimeFormat: "js",
      engineVersion: "6.0.0",
    },
  })
  const run = finalizeCollectedDraft(draft as CapturedRunDraft)
  const source = join(dir, "run.json")
  const save = () => writeFileSync(source, JSON.stringify(run))
  save()
  return { dir, content, manifest: currentManifest, run, source, save }
}

// Accepted: placement must retain exact run bytes and its trusted suite, and reads must bind them.
// The retired admission tests never call the collection writer or reload what it actually persisted.
test("persists and reloads exact bytes, idempotently, refusing conflicts", () => {
  const f = fixture()
  const bytes = readFileSync(f.source)
  const destination = placeCollectedRun(f.source, f.manifest, f.content)
  expect(destination).toBe(join(f.content, "probes-libs", "xtermjs-6.0.0-linux-fixture-run.json"))
  expect(readFileSync(destination)).toEqual(bytes)
  expect(readFileSync(join(f.content, "suites", `${f.manifest.probeHash}.json`), "utf8")).toBe(
    `${JSON.stringify(f.manifest, null, 2)}\n`,
  )
  expect(loadStoredRuns(f.content, f.manifest.catalogIds!)).toMatchObject([
    { runId: "fixture-run", sha256: hash(bytes) },
  ])
  expect(placeCollectedRun(f.source, f.manifest, f.content)).toBe(destination)
  writeFileSync(destination, "different")
  expect(() => placeCollectedRun(f.source, f.manifest, f.content)).toThrow(/different collected run/)
  expect(readFileSync(destination, "utf8")).toBe("different")
})

// Stored suite filenames must identify their actual manifest; valid content under a wrong name is not trustworthy.
test("stored corpus refuses a suite filed under another hash", () => {
  const f = fixture()
  mkdirSync(join(f.content, "suites"))
  writeFileSync(join(f.content, "suites", "wrong.json"), JSON.stringify(f.manifest))
  expect(() => loadStoredRuns(f.content, f.manifest.catalogIds!)).toThrow(/suite filename does not match/)
})

// The writer must bind all suite facts to the executable suite; same-hash parser acceptance
// alone cannot detect an altered adapter version supplied by a corrupted receipt.
test.each(["adapter", "catalog", "entry-hash", "term", "lib", "mux", "text-claims", "text-qualification"] as const)(
  "refuses a trusted suite with altered %s before writing",
  (field) => {
    const f = fixture()
    const altered = structuredClone(f.manifest)
    if (field === "adapter") altered.adapterVersion = "999.0.0"
    if (field === "catalog") altered.catalogIds = [...altered.catalogIds!].reverse()
    if (field === "entry-hash") altered.catalogEntrySha256![altered.catalogIds![0]!] = "f".repeat(64)
    if (field === "term" || field === "lib" || field === "mux") {
      altered.probes[field] = [...altered.probes[field]].reverse()
    }
    if (field === "text-claims") altered.textClaims = []
    if (field === "text-qualification") altered.textQualification = { version: 1, recipe: "other" }
    expect(() => placeCollectedRun(f.source, altered, f.content)).toThrow(/Suite .* mismatch|textQualification/)
    expect(existsSync(join(f.content, "suites"))).toBe(false)
    expect(existsSync(join(f.content, "probes-libs", "xtermjs-6.0.0-linux-fixture-run.json"))).toBe(false)
  },
)

// Existing library identity validation must reject dirty source provenance at the actual writer;
// term-side dirty-provenance cases do not reach this library-specific refusal.
test.each([true, false])("library source cleanTree=%s", (cleanTree) => {
  const f = fixture()
  const identity = f.run.runtimeIdentity
  if (!identity || identity.kind !== "js") throw new Error("Expected JavaScript runtime fixture")
  identity.integrity = {
    kind: "source",
    repository: "https://github.com/example/engine",
    revision: "a".repeat(40),
    treeOid: "b".repeat(40),
    cleanTree,
  }
  f.save()
  if (cleanTree) {
    expect(readFileSync(placeCollectedRun(f.source, f.manifest, f.content))).toEqual(readFileSync(f.source))
  } else {
    expect(() => placeCollectedRun(f.source, f.manifest, f.content)).toThrow(/runtime-identity-unverified/)
    expect(existsSync(join(f.content, "suites"))).toBe(false)
  }
})

// The default corpus writer must refuse a detached or default branch before it writes.
// Isolated content-dir tests do not exercise the checkout that owns the default corpus.
test.each(["main", "detached", "task"] as const)("default corpus checks %s checkout", (branch) => {
  const f = fixture()
  const repo = join(f.dir, "checkout")
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" })
  git("init", "-q", "-b", "main")
  git("config", "user.email", "fixture@example.invalid")
  git("config", "user.name", "fixture")
  writeFileSync(join(repo, "fixture"), "fixture")
  git("add", "fixture")
  git("commit", "-q", "-m", "fixture")
  if (branch === "detached") git("checkout", "--detach", "-q")
  if (branch === "task") git("checkout", "-q", "-b", "task/fixture")
  const previousGitDir = process.env.GIT_DIR
  const previousGitWorkTree = process.env.GIT_WORK_TREE
  const previousProbeHash = process.env.TERMINFO_PROBE_HASH
  const previousRevision = process.env.TERMINFO_SOURCE_REVISION
  process.env.GIT_DIR = join(repo, ".git")
  process.env.GIT_WORK_TREE = repo
  delete process.env.TERMINFO_PROBE_HASH
  delete process.env.TERMINFO_SOURCE_REVISION
  const output = vi.spyOn(console, "log").mockImplementation(() => {})
  try {
    const expected =
      branch === "main"
        ? /default branch/
        : branch === "detached"
          ? /HEAD is detached/
          : /Current collection requires TERMINFO_/
    expect(() => writeCollectedRun(f.run, f.source)).toThrow(expected)
  } finally {
    output.mockRestore()
    if (previousGitDir === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = previousGitDir
    if (previousGitWorkTree === undefined) delete process.env.GIT_WORK_TREE
    else process.env.GIT_WORK_TREE = previousGitWorkTree
    if (previousProbeHash === undefined) delete process.env.TERMINFO_PROBE_HASH
    else process.env.TERMINFO_PROBE_HASH = previousProbeHash
    if (previousRevision === undefined) delete process.env.TERMINFO_SOURCE_REVISION
    else process.env.TERMINFO_SOURCE_REVISION = previousRevision
  }
})

// Invalid collection or a conflicting suite must not leave a run or artifacts behind.
// Existing parser tests cannot observe placement's ordering and filesystem side effects.
test.each(["malformed", "invalid-utf8", "foreign-suite", "conflicting-suite", "identity"] as const)(
  "refuses %s before placement",
  (fault) => {
    const f = fixture()
    if (fault === "malformed") writeFileSync(f.source, "{")
    if (fault === "invalid-utf8") writeFileSync(f.source, Buffer.from([0xff]))
    if (fault === "foreign-suite") {
      f.run.probeHash = "000000000000"
      f.save()
    }
    if (fault === "identity") {
      f.run.identity = "disputed"
      f.save()
    }
    if (fault === "conflicting-suite") {
      mkdirSync(join(f.content, "suites"))
      writeFileSync(join(f.content, "suites", `${f.manifest.probeHash}.json`), "different")
    }
    expect(() => placeCollectedRun(f.source, f.manifest, f.content)).toThrow()
    expect(existsSync(join(f.content, "probes-libs", "xtermjs-6.0.0-linux-fixture-run.json"))).toBe(false)
    expect(existsSync(join(f.content, "artifacts"))).toBe(false)
  },
)

// Accepted: cited screenshot and text bytes are verified and copied before a run becomes visible.
// Prior tests exercised the standalone artifact helper, so they could miss writer ordering.
test.each(["valid", "missing", "wrong-hash", "not-png", "invalid-utf8", "bom-text", "conflict"] as const)(
  "retained artifacts: %s",
  (fault) => {
    const f = fixture()
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
    const text = Buffer.from(
      fault === "invalid-utf8" ? [0xff] : fault === "bom-text" ? [0xef, 0xbb, 0xbf, 0x68] : [0x68, 0x69],
    )
    const pngHash = hash(png)
    const textHash = hash(text)
    f.run.screenshotRefs = [`sha256:${pngHash}`]
    f.run.textSnapshotRefs = [`sha256:${textHash}`]
    f.save()
    mkdirSync(join(f.dir, "artifacts"))
    if (fault !== "missing") {
      writeFileSync(join(f.dir, "artifacts", `${pngHash}.png`), fault === "wrong-hash" ? "wrong" : png)
    }
    if (fault === "not-png") {
      const nonPng = Buffer.from("not png")
      f.run.screenshotRefs = [`sha256:${hash(nonPng)}`]
      writeFileSync(join(f.dir, "artifacts", `${hash(nonPng)}.png`), nonPng)
      f.save()
    }
    writeFileSync(join(f.dir, "artifacts", `${textHash}.txt`), text)
    if (fault === "conflict") {
      mkdirSync(join(f.content, "artifacts"))
      writeFileSync(join(f.content, "artifacts", `${textHash}.txt`), "different")
    }
    if (fault === "valid") {
      const destination = placeCollectedRun(f.source, f.manifest, f.content)
      expect(readFileSync(join(f.content, "artifacts", `${pngHash}.png`))).toEqual(png)
      expect(readFileSync(join(f.content, "artifacts", `${textHash}.txt`))).toEqual(text)
      expect(readFileSync(destination)).toEqual(readFileSync(f.source))
      expect(placeCollectedRun(f.source, f.manifest, f.content)).toBe(destination)
    } else {
      const errors = {
        missing: /does not exist/,
        "wrong-hash": /hashes to/,
        "not-png": /not a PNG/,
        "invalid-utf8": /not exact UTF-8/,
        "bom-text": /not exact UTF-8/,
        conflict: /different text-snapshot/,
      }
      expect(() => placeCollectedRun(f.source, f.manifest, f.content)).toThrow(errors[fault])
      expect(existsSync(join(f.content, "suites"))).toBe(false)
      expect(existsSync(join(f.content, "probes-libs", "xtermjs-6.0.0-linux-fixture-run.json"))).toBe(false)
      expect(existsSync(join(f.content, "artifacts", `${pngHash}.png`))).toBe(false)
    }
  },
)

// Accepted: measured identity and clean provenance are factual placement constraints.
// Parser-only cases do not reach the writer's identity/provenance decisions.
test.each([
  "valid",
  "wrong-version",
  "disputed",
  "dirty",
  "missing-receipt",
  "receipt-hash",
  "uncited-receipt",
] as const)("terminal identity and receipt: %s", (fault) => {
  const f = fixture()
  const subject = {
    kind: "term" as const,
    id: "kitty",
    version: "0.46.2",
    os: "macos",
    osVersion: null,
    outerTerminal: null,
    mux: null,
    config: null,
    permissions: null,
  }
  const draft = initializeRunDraft({
    runId: "term-run",
    sourceRevision: "a".repeat(40),
    manifest: f.manifest,
    source: { kind: "live" },
    intendedSubject: subject,
  })
  Object.assign(draft, {
    subject,
    identity: fault === "disputed" ? "disputed" : "verified",
    measuredAt: "2026-10-21T05:00:00.000Z",
    origin: { kind: "collector" },
    rawReplies: {
      "device.primary-da": "\u001b[?62;52;c",
      "collector.xtversion": `\u001bP>|kitty(${fault === "wrong-version" ? "9.0" : "0.46.2"})\u001b\\\u001b[?62;52;c`,
    },
  })
  const run = finalizeCollectedDraft(draft as CapturedRunDraft)
  if (fault === "dirty") {
    // The current mux specimen retains the measured native outer terminal provenance.
    const specimen = muxSpecimen()
    run.provenance = specimen.outerApp.provenance
    run.provenance!.runtime.sourceRevision = "a".repeat(40)
    run.provenance!.runtime.suiteHash = f.manifest.probeHash
    run.provenance!.runtime.cleanTree = false
    run.provenance!.executable.version = "kitty 0.46.2"
  }
  if (fault === "missing-receipt" || fault === "receipt-hash") {
    run.rawReplies["collector.disposableOwnership"] = JSON.stringify({
      kind: "linux-xvfb-container",
      receiptSha256: "a".repeat(64),
    })
    if (fault === "receipt-hash") writeFileSync(join(f.dir, "host-measured.json"), "{}")
  }
  if (fault === "uncited-receipt") {
    run.rawReplies["collector.disposableOwnership"] = JSON.stringify({ kind: "linux-xvfb-container" })
  }
  writeFileSync(f.source, JSON.stringify(run))
  if (fault === "valid") {
    expect(readFileSync(placeCollectedRun(f.source, f.manifest, f.content))).toEqual(readFileSync(f.source))
  } else {
    const errors = {
      "wrong-version": /identity-replies-mismatch/,
      disputed: /identity-disputed/,
      dirty: /native-provenance-dirty/,
      "missing-receipt": /does not exist beside the run/,
      "receipt-hash": /hashes to/,
      "uncited-receipt": /no sha256 receiptSha256/,
    }
    expect(() => placeCollectedRun(f.source, f.manifest, f.content)).toThrow(errors[fault])
    expect(existsSync(join(f.content, "suites"))).toBe(false)
  }
})

// Accepted: Linux completion must bind the final run, host, container, capture and HTTP bytes.
// Parser coverage alone cannot detect missing or changed files beside the source run.
test.each([
  "valid",
  "alacritty-clean",
  "alacritty-dirty",
  "placeholder-receipt",
  "wrong-target",
  "missing-completion",
  "malformed-completion",
  "wrong-run",
  "changed-final",
  "changed-host",
  "missing-container",
  "changed-container",
  "missing-capture",
  "changed-capture",
  "missing-http",
  "changed-http",
] as const)("Linux completion custody: %s", (fault) => {
  const f = fixture()
  const base = join(import.meta.dirname, "../test-fixtures")
  const specimen = muxSpecimen()
  const alacritty = fault === "alacritty-clean" || fault === "alacritty-dirty"
  const subject = alacritty
    ? { ...specimen.outerApp.subject, id: "alacritty", version: "0.17.0" }
    : specimen.outerApp.subject
  const draft = initializeRunDraft({
    runId: "linux-run",
    sourceRevision: specimen.sourceRevision,
    manifest: f.manifest,
    source: { kind: "live" },
    intendedSubject: subject,
  })
  specimen.outerApp.provenance.runtime.suiteHash = f.manifest.probeHash
  if (alacritty) {
    specimen.outerApp.provenance.runtime.cleanTree = fault === "alacritty-clean"
    specimen.outerApp.provenance.executable.version = "alacritty 0.17.0"
  }
  const originalHost = readFileSync(join(base, "receipts/dfd4cd08416fb5f3be3eaeed5acce782.json"))
  const hostDocument = parseJsonStrict("host fixture", originalHost.toString("utf8"))
  if (!record(hostDocument) || !record(hostDocument.runtime) || !record(hostDocument.declaredTarget)) {
    throw new Error("Invalid host fixture")
  }
  if (fault === "placeholder-receipt") hostDocument.runtime.imageId = `sha256:${"0".repeat(64)}`
  if (fault === "wrong-target") hostDocument.declaredTarget.id = "wezterm"
  if (alacritty) {
    hostDocument.declaredTarget.id = "alacritty"
    hostDocument.declaredTarget.version = "0.17.0"
  }
  const host =
    fault === "placeholder-receipt" || fault === "wrong-target" || alacritty
      ? Buffer.from(JSON.stringify(hostDocument))
      : originalHost
  const citation = { kind: "linux-xvfb-container", receiptSha256: hash(host) }
  writeFileSync(join(f.dir, "host-measured.json"), host)
  const capture = Buffer.from("retained original capture")
  const captureHash = hash(capture)
  Object.assign(draft, {
    subject,
    identity: "verified",
    measuredAt: specimen.measuredAt,
    origin: { kind: "collector" },
    provenance: specimen.outerApp.provenance,
    rawReplies: {
      "device.primary-da": alacritty ? "\u001b[?6c" : specimen.outerApp.rawReplies["device.primary-da"],
      "collector.xtversion": alacritty ? "\u001b[?6c" : specimen.outerApp.rawReplies["collector.xtversion"],
      "collector.disposableOwnership": JSON.stringify(citation),
      "collector.httpResponseSha256": captureHash,
    },
  })
  const run = finalizeCollectedDraft(draft as CapturedRunDraft)
  const bytes = Buffer.from(JSON.stringify(run))
  writeFileSync(f.source, bytes)
  const container = Buffer.from(JSON.stringify({ probeRun: { runId: run.runId, sha256: captureHash } }))
  writeFileSync(join(f.dir, "container-receipt.json"), container)
  writeFileSync(join(f.dir, "v3-capture.json"), capture)
  mkdirSync(join(f.dir, "http-responses"))
  writeFileSync(join(f.dir, "http-responses", captureHash), capture)
  const completion = {
    probeRun: { runId: run.runId, sha256: hash(bytes) },
    receiptInputs: { hostSha256: hash(host), containerSha256: hash(container) },
  }
  const receipt = join(f.dir, "run-receipt.json")
  writeFileSync(receipt, JSON.stringify(completion))
  if (fault === "missing-completion") rmSync(receipt)
  if (fault === "malformed-completion") writeFileSync(receipt, "{broken")
  if (fault === "wrong-run") {
    completion.probeRun.runId = "different-run"
    writeFileSync(receipt, JSON.stringify(completion))
  }
  if (fault === "changed-final") {
    completion.probeRun.sha256 = "0".repeat(64)
    writeFileSync(receipt, JSON.stringify(completion))
  }
  if (fault === "changed-host") {
    completion.receiptInputs.hostSha256 = "0".repeat(64)
    writeFileSync(receipt, JSON.stringify(completion))
  }
  if (fault === "missing-container") rmSync(join(f.dir, "container-receipt.json"))
  if (fault === "changed-container") writeFileSync(join(f.dir, "container-receipt.json"), "{}")
  if (fault === "missing-capture") rmSync(join(f.dir, "v3-capture.json"))
  if (fault === "changed-capture") writeFileSync(join(f.dir, "v3-capture.json"), "changed")
  if (fault === "missing-http") rmSync(join(f.dir, "http-responses", captureHash))
  if (fault === "changed-http") writeFileSync(join(f.dir, "http-responses", captureHash), "changed")
  if (fault === "valid" || fault === "alacritty-clean") {
    expect(readFileSync(placeCollectedRun(f.source, f.manifest, f.content))).toEqual(bytes)
  } else {
    if (fault === "missing-completion") {
      expect(() => placeCollectedRun(f.source, f.manifest, f.content)).toThrow(/remain private until Phase 3/)
    }
    const errors = {
      "placeholder-receipt": /imageId is a placeholder/,
      "alacritty-dirty": /identity-replies-mismatch/,
      "wrong-target": /receipt declares target/,
      "missing-completion": /missing run-receipt/,
      "malformed-completion": /Cannot read Linux completion receipt/,
      "wrong-run": /does not bind probeRun/,
      "changed-final": /does not bind probeRun/,
      "changed-host": /does not bind receiptInputs.hostSha256/,
      "missing-container": /original custody inputs/,
      "changed-container": /original custody inputs/,
      "missing-capture": /original custody inputs/,
      "changed-capture": /original capture bytes/,
      "missing-http": /retained HTTP bytes/,
      "changed-http": /retained HTTP bytes/,
    }
    expect(() => placeCollectedRun(f.source, f.manifest, f.content)).toThrow(errors[fault])
    expect(existsSync(join(f.content, "suites"))).toBe(false)
  }
})

// Accepted: mux placement requires an identified outer app and attached custody, not just mux replies.
// The old assessor-only cases cannot prove the actual writer refuses before writing.
test.each(["missing-outer", "wrong-outer", "missing-attachment", "invalid-attachment"] as const)(
  "mux custody: %s",
  (fault) => {
    const f = fixture()
    const subject = {
      kind: "mux" as const,
      id: "tmux",
      version: "3.6",
      os: "macos",
      osVersion: null,
      outerTerminal: "kitty",
      mux: "tmux",
      config: null,
      permissions: null,
    }
    const draft = initializeRunDraft({
      runId: "mux-run",
      sourceRevision: "a".repeat(40),
      manifest: f.manifest,
      source: { kind: "live" },
      intendedSubject: subject,
    })
    const kitty = {
      kind: "term" as const,
      id: "kitty",
      version: "0.46.2",
      os: "macos",
      osVersion: null,
      outerTerminal: null,
      mux: null,
      config: null,
      permissions: null,
    }
    Object.assign(draft, {
      subject,
      identity: "verified",
      measuredAt: "2026-10-21T05:00:00.000Z",
      origin: { kind: "collector" },
      rawReplies: {
        "device.primary-da": "\u001b[?1;2;4c",
        "collector.xtversion": "\u001bP>|tmux 3.6\u001b\\\u001b[?1;2;4c",
        ...(fault === "invalid-attachment"
          ? { "collector.terminalOwnership": JSON.stringify({ muxAttachment: {} }) }
          : {}),
      },
    })
    if (fault !== "missing-outer") {
      draft.outerApp = {
        subject: kitty,
        rawReplies: {
          "device.primary-da": "\u001b[?62;52;c",
          "collector.xtversion": `\u001bP>|kitty(${fault === "wrong-outer" ? "9.0" : "0.46.2"})\u001b\\\u001b[?62;52;c`,
        },
      }
    }
    writeFileSync(f.source, JSON.stringify(finalizeCollectedDraft(draft as CapturedRunDraft)))
    const errors = {
      "missing-outer": /outer-app-proof-missing/,
      "wrong-outer": /outer-app-identity-mismatch/,
      "missing-attachment": /mux-attachment-missing/,
      "invalid-attachment": /mux-attachment-invalid/,
    }
    expect(() => placeCollectedRun(f.source, f.manifest, f.content)).toThrow(errors[fault])
    expect(existsSync(join(f.content, "suites"))).toBe(false)
  },
)

// Accepted: a mux attachment must join the retained outer launch to this run and executable.
// Missing-proof tests do not distinguish a valid join from a writer that accepts any attachment.
// The parser's admitted Screen binary line includes a build date; placement joins its proved
// version to the normalized subject. The tmux journey alone cannot expose that representation gap.
test.each([
  ["tmux", "valid"],
  ["tmux", "wrong-capture"],
  ["tmux", "wrong-owner"],
  ["screen", "valid"],
  ["screen", "wrong-version"],
  ["screen", "missing-outer-launch"],
] as const)("Darwin %s attachment join: %s", (mux, fault) => {
  const f = fixture()
  const launchRunId = "12".repeat(16)
  const executablePath = "/Applications/kitty.app/Contents/MacOS/kitty"
  const bootId = "A1B2C3D4-1111-2222-3333-444455556666"
  const outerTerminal = { pid: 55770, startedAtEpochSeconds: 1792678806 }
  const digest = (s: string) => hash(Buffer.from(s))
  const launch = serializeOuterLaunchRecord({
    launchRunId,
    executablePath,
    outerTerminal,
    bootId,
    marker: { flag: "--config", value: `/tmp/kitty-${launchRunId}.conf` },
    identityFile: { path: "/tmp/run/owner-tty.txt", sha256: digest("owner tty") },
    runFileSha256: digest("run config"),
    autoUpdate: {
      key: "SUEnableAutomaticChecks",
      value: "0",
      plistPath: "/tmp/run/preferences.plist",
      plistSha256: digest("preferences"),
    },
  })
  const hop = (
    pid: number,
    ppid: number,
    uid: number,
    startedAtEpochSeconds: number,
    path: string,
    ttyRdev: number | null,
  ) => ({ pid, ppid, uid, startedAtEpochSeconds, executablePath: path, ttyRdev })
  const attachment = {
    platform: "darwin",
    mux,
    bootId,
    receiptSha256: digest(launch),
    launchRunId,
    captureRunId: fault === "wrong-capture" ? "34".repeat(16) : "56".repeat(16),
    preflightCollector: { pid: 95, startedAtEpochSeconds: 1792678700 },
    outerShell: { pid: 55772, startedAtEpochSeconds: 1792678807, ttyRdev: 268435456 },
    outerTerminal,
    collector: { pid: 55803, startedAtEpochSeconds: 1792678808, ttyRdev: 268435459 },
    attachedClient: { pid: 55802, startedAtEpochSeconds: 1792678808, ttyRdev: 268435456 },
    chain: [
      hop(55803, 55800, 501, 1792678808, "/Users/codi/.bun/bin/bun", 268435459),
      hop(55800, 55772, 501, 1792678808, "/usr/local/bin/tmux", 268435456),
      hop(55772, 55771, 501, 1792678807, "/bin/bash", 268435456),
      hop(55771, 55770, 0, 1792678807, "/usr/bin/login", 268435456),
      hop(55770, 55757, 501, 1792678806, executablePath, null),
    ],
    executable: { path: "/usr/local/bin/tmux", sha256: digest("tmux"), version: "3.6" },
    config: { path: "/tmp/run/tmux.conf", sha256: digest("") },
    socketPath: "/tmp/run/mux.sock",
    session: "owned",
  }
  if (mux === "screen") {
    const kernelHop = (pid: number, ppid: number, uid: number, path: string, tty: number | null, kernel = path) => ({
      ...hop(pid, ppid, uid, 1792678808, path, tty),
      kernelExecutable: kernel,
      kernelExecutableReader: "proc_pidpath" as const,
      kernelExecutableError: null,
      kernelExecutableAttempts: [{ reader: "proc_pidpath", result: kernel.length, error: null }],
    })
    Object.assign(attachment, {
      outerShell: { pid: 55772, startedAtEpochSeconds: 1792678808, ttyRdev: 268435456 },
      outerTerminal: { pid: 55770, startedAtEpochSeconds: 1792678808 },
      attachedClient: { pid: 55802, startedAtEpochSeconds: 1792678808, ttyRdev: 268435456 },
      chain: [
        kernelHop(55803, 55804, 501, "/Users/codi/.bun/bin/bun", 268435459),
        kernelHop(55804, 55800, 0, "login", 268435459, "/usr/bin/login"),
        kernelHop(55800, 55802, 501, "/usr/bin/SCREEN", null, "/usr/bin/screen"),
        kernelHop(55802, 55772, 501, "/usr/bin/screen", 268435456),
        kernelHop(55772, 55771, 501, "/bin/bash", 268435456),
        kernelHop(55771, 55770, 0, "/usr/bin/login", 268435456),
        kernelHop(55770, 55757, 501, executablePath, null),
      ],
      executable: {
        path: "/usr/bin/screen",
        sha256: digest("screen"),
        version: "Screen version 4.00.03 (FAU) 23-Oct-06",
      },
    })
  }
  const subject = {
    kind: "mux" as const,
    id: mux,
    version: mux === "screen" ? (fault === "wrong-version" ? "4.00.04" : "4.00.03") : "3.6",
    os: "macos",
    osVersion: null,
    outerTerminal: "kitty",
    mux,
    config: attachment.config.path,
    permissions: null,
  }
  const kitty = {
    kind: "term" as const,
    id: "kitty",
    version: "0.46.2",
    os: "macos",
    osVersion: null,
    outerTerminal: null,
    mux: null,
    config: null,
    permissions: null,
  }
  const draft = initializeRunDraft({
    runId: "56".repeat(16),
    sourceRevision: "a".repeat(40),
    manifest: f.manifest,
    source: { kind: "live" },
    intendedSubject: subject,
  })
  Object.assign(draft, {
    subject,
    identity: "verified",
    measuredAt: "2026-10-21T05:00:00.000Z",
    origin: { kind: "collector" },
    rawReplies: {
      "device.primary-da": "\u001b[?1;2;4c",
      "collector.xtversion": "\u001bP>|tmux 3.6\u001b\\\u001b[?1;2;4c",
      "collector.terminalOwnership": JSON.stringify({ muxAttachment: attachment }),
    },
    outerApp: {
      subject: kitty,
      rawReplies: {
        "device.primary-da": "\u001b[?62;52;c",
        "collector.xtversion": "\u001bP>|kitty(0.46.2)\u001b\\\u001b[?62;52;c",
        "collector.outerLaunch": fault === "wrong-owner" ? `${launch} ` : launch,
      },
    },
  })
  if (mux === "screen") {
    const screenDraft = draft as CapturedRunDraft
    screenDraft.rawReplies["device.primary-da"] = "\u001b[?1;2c"
    screenDraft.rawReplies["collector.xtversion"] = "\u001b[?1;2c"
    screenDraft.rawReplies["collector.da2"] =
      `\u001b[>83;${fault === "wrong-version" ? "40004" : "40003"};0c\u001b[?1;2c`
    const screenLaunch = serializeOuterLaunchRecord({
      ...parseOuterLaunchRecord(launch),
      outerTerminal: attachment.outerTerminal,
    })
    attachment.receiptSha256 = digest(screenLaunch)
    screenDraft.rawReplies["collector.terminalOwnership"] = JSON.stringify({ muxAttachment: attachment })
    if (fault === "missing-outer-launch") delete screenDraft.outerApp!.rawReplies["collector.outerLaunch"]
    else screenDraft.outerApp!.rawReplies["collector.outerLaunch"] = screenLaunch
  }
  writeFileSync(f.source, JSON.stringify(finalizeCollectedDraft(draft as CapturedRunDraft)))
  if (fault === "valid") {
    expect(readFileSync(placeCollectedRun(f.source, f.manifest, f.content))).toEqual(readFileSync(f.source))
  } else {
    expect(() => placeCollectedRun(f.source, f.manifest, f.content)).toThrow(
      fault === "missing-outer-launch"
        ? /has no collector\.outerLaunch reply/
        : /mux-attachment-invalid|Darwin mux receipt refused/,
    )
    expect(existsSync(join(f.content, "suites"))).toBe(false)
  }
})

// Accepted: filenames must come from safe subject/run components and only current records are placed.
// Parser tests cannot observe the writer's destination check and no-write guarantee.
test.each(["unsafe-run-id", "unsafe-version", "old-schema"] as const)("refuses %s", (fault) => {
  const f = fixture()
  if (fault === "unsafe-run-id") f.run.runId = "../escape"
  if (fault === "unsafe-version") {
    f.run.subject.version = "../escape"
    if (!f.run.runtimeIdentity) throw new Error("missing runtime fixture")
    f.run.runtimeIdentity.engineVersion = "../escape"
  }
  if (fault === "old-schema") Object.assign(f.run, { schemaVersion: 3 })
  f.save()
  expect(() => placeCollectedRun(f.source, f.manifest, f.content)).toThrow(
    fault === "old-schema" ? /schema-4/ : /unsafe collected|intendedSubject/,
  )
  expect(existsSync(join(f.content, "suites"))).toBe(false)
})

const hostedMacApps = [
  {
    id: "cmux",
    version: "0.65.2",
    path: "/Applications/cmux.app/Contents/MacOS/cmux",
    engine: "ghostty 1.3.2-HEAD-+cb1ef70",
  },
  {
    id: "cursor",
    version: "3.25.9",
    path: "/Applications/Cursor.app/Contents/MacOS/Cursor",
    engine: "xterm.js 6.1.0-beta.304",
  },
  {
    id: "com.microsoft.VSCode",
    version: "1.142.0",
    path: "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
    engine: "xterm.js 6.1.0-beta.304",
  },
] as const

// Accepted: embedded-engine replies require the cited hosted Mac launch, matching app and version.
// Existing app path parser tests cannot witness placement's join with run and receipt.
test.each(hostedMacApps)("hosted Mac $id binds launch, target, runner and exact version", (app) => {
  for (const fault of [
    "valid",
    "darwin",
    "no-receipt",
    "shared",
    "wrong-hash",
    "copied-launch",
    "wrong-version",
    "missing-da",
    "other-app",
    "unknown-app",
    "runner-os",
  ] as const) {
    const f = fixture()
    const digest = (s: string) => hash(Buffer.from(s))
    const subject = {
      kind: "term" as const,
      id: app.id,
      version: app.version,
      os: fault === "darwin" ? "Darwin" : "macos",
      osVersion: null,
      outerTerminal: null,
      mux: null,
      config: null,
      permissions: null,
    }
    const launch = {
      bundlePath: app.path.slice(0, app.path.indexOf("/Contents/")),
      cfBundleShortVersionString: app.version,
      cfBundleVersion: "1",
      executablePath:
        fault === "other-app"
          ? app.id === "cursor"
            ? hostedMacApps[2].path
            : hostedMacApps[1].path
          : fault === "unknown-app"
            ? "/Applications/Unknown.app/Contents/MacOS/unknown"
            : app.path,
      executableSha256: "a1".repeat(32),
      sourceArtifact: { path: "/tmp/installer.zip", sha256: "b2".repeat(32) },
    }
    const sample = {
      machineIdSha256: digest("mac-machine"),
      productUuidSha256: digest("mac-image"),
      bootIdSha256: digest("mac-boot"),
    }
    const host = {
      schemaVersion: 1,
      kind: "github-hosted-runner",
      runId: digest("mac-run").slice(0, 32),
      collectedAt: "2026-10-07T06:00:00Z",
      job: {
        repository: "beorn/terminfo.dev",
        workflow: "collect",
        workflowRef: "collect.yml@main",
        githubRunId: "37583024982",
        githubRunAttempt: "1",
        job: "collect",
        jobId: "27833",
      },
      runner: {
        environment: "github-hosted",
        name: "runner-27833",
        os: fault === "runner-os" ? "Linux" : "macOS",
        arch: "ARM64",
        imageOS: "fixture",
        imageVersion: "1",
        trackingId: digest("27833"),
      },
      vm: { identityAtJobStart: sample, identityAtCollection: sample },
      appLaunch: launch,
    }
    const hostBytes = JSON.stringify(host)
    writeFileSync(join(f.dir, "host-measured.json"), hostBytes)
    const citation = JSON.stringify({
      kind: host.kind,
      receiptSha256: fault === "wrong-hash" ? "c3".repeat(32) : digest(hostBytes),
    })
    const draft = initializeRunDraft({
      runId: "mac-run",
      sourceRevision: "a".repeat(40),
      manifest: f.manifest,
      source: { kind: "live" },
      intendedSubject: subject,
    })
    Object.assign(draft, {
      subject: { ...subject, version: fault === "wrong-version" ? "9.9.9" : app.version },
      identity: "verified",
      measuredAt: "2026-10-21T05:00:00.000Z",
      origin: {
        kind: "collector",
        appLaunch: fault === "copied-launch" ? { ...launch, executableSha256: "d4".repeat(32) } : launch,
      },
      rawReplies: {
        "device.primary-da": fault === "missing-da" ? "" : "\u001b[?1;2c",
        "collector.xtversion": `\u001bP>|${app.engine}\u001b\\${fault === "missing-da" ? "" : "\u001b[?1;2c"}`,
        ...(fault === "no-receipt"
          ? {}
          : { "collector.disposableOwnership": fault === "shared" ? JSON.stringify({ kind: "shared" }) : citation }),
      },
    })
    writeFileSync(f.source, JSON.stringify(finalizeCollectedDraft(draft as CapturedRunDraft)))
    if (fault === "valid" || fault === "darwin") {
      expect(readFileSync(placeCollectedRun(f.source, f.manifest, f.content))).toEqual(readFileSync(f.source))
    } else {
      const errors = {
        "no-receipt": /requires a cited github-hosted-runner/,
        shared: /requires a cited github-hosted-runner/,
        "wrong-hash": /hashes to/,
        "copied-launch": /origin.appLaunch.executableSha256 differs/,
        "wrong-version": /identity-replies-mismatch/,
        "missing-da": /identity-replies-mismatch/,
        "other-app": /identifies.*not requested/,
        "unknown-app": /executable/,
        "runner-os": /Darwin runner/,
      }
      expect(() => placeCollectedRun(f.source, f.manifest, f.content)).toThrow(errors[fault])
      expect(existsSync(join(f.content, "suites"))).toBe(false)
    }
  }
})

// Accepted: Linux mux custody joins attachment, retained clipboard receipt, outer preflight and provenance.
// Darwin join and the clipboard adapter's own tests cannot exercise this writer's Linux joins.
test.each(["valid", "clipboard-hash", "preflight", "config"] as const)("Linux mux custody join: %s", (fault) => {
  const f = fixture()
  const base = join(import.meta.dirname, "../test-fixtures")
  const specimen = muxSpecimen()
  const draft = initializeRunDraft({
    runId: specimen.runId,
    sourceRevision: specimen.sourceRevision,
    manifest: f.manifest,
    source: { kind: "live" },
    intendedSubject: specimen.subject,
  })
  const outer = structuredClone(specimen.outerApp)
  outer.provenance.runtime.suiteHash = f.manifest.probeHash
  const replies: Record<string, string> = {}
  for (const key of [
    "device.primary-da",
    "device.secondary-da",
    "collector.xtversion",
    "collector.terminalOwnership",
    "collector.clipboardFixture",
  ]) {
    const value = specimen.rawReplies[key]
    if (value === undefined) throw new Error(`Mux specimen is missing ${key}`)
    replies[key] = value
  }
  const clipboard = parseJsonStrict("clipboard fixture", replies["collector.clipboardFixture"]!)
  if (!record(clipboard)) throw new Error("Invalid clipboard fixture")
  if (fault === "clipboard-hash") clipboard.receiptSha256 = "0".repeat(64)
  if (fault === "preflight") outer.rawReplies["collector.preflightIdentity"] = JSON.stringify({ pid: 1 })
  if (fault === "config") outer.provenance.fixture.config = "different"
  replies["collector.clipboardFixture"] = JSON.stringify(clipboard)
  const host = Buffer.from("{}")
  replies["collector.disposableOwnership"] = JSON.stringify({ kind: "shared" })
  writeFileSync(join(f.dir, "host-measured.json"), host)
  const capture = Buffer.from("retained original mux capture")
  const captureHash = hash(capture)
  replies["collector.httpResponseSha256"] = captureHash
  Object.assign(draft, {
    subject: specimen.subject,
    outerApp: outer,
    identity: specimen.identity,
    measuredAt: specimen.measuredAt,
    origin: specimen.origin,
    rawReplies: replies,
  })
  const run = finalizeCollectedDraft(draft as CapturedRunDraft)
  const bytes = Buffer.from(JSON.stringify(run))
  writeFileSync(f.source, bytes)
  const container = Buffer.from(JSON.stringify({ probeRun: { runId: run.runId, sha256: captureHash } }))
  writeFileSync(join(f.dir, "container-receipt.json"), container)
  writeFileSync(join(f.dir, "v3-capture.json"), capture)
  mkdirSync(join(f.dir, "http-responses"))
  writeFileSync(join(f.dir, "http-responses", captureHash), capture)
  writeFileSync(
    join(f.dir, "run-receipt.json"),
    JSON.stringify({
      probeRun: { runId: run.runId, sha256: hash(bytes) },
      receiptInputs: { hostSha256: hash(host), containerSha256: hash(container) },
    }),
  )
  if (fault === "valid") expect(readFileSync(placeCollectedRun(f.source, f.manifest, f.content))).toEqual(bytes)
  else {
    expect(() => placeCollectedRun(f.source, f.manifest, f.content)).toThrow(/mux-attachment-invalid/)
    expect(existsSync(join(f.content, "suites"))).toBe(false)
  }
})

// Accepted: shared Mac Warp/iTerm captures may use measured protocol identity without a receipt,
// but an absent or wrong version cannot identify them. Hosted-app tests require different evidence.
test.each([
  {
    id: "warp",
    version: "v0.2026.10.14.08.27.stable_01",
    da1: "\u001b[?62c",
    reply: "Warp(v0.2026.10.14.08.27.stable_01)",
  },
  { id: "iterm2", version: "3.6.11", da1: "\u001b[?64;1;2c", reply: "iTerm2 3.6.11" },
] as const)("shared $id requires its own measured version", (app) => {
  for (const fault of ["absent", "shared", "wrong-version", "unknown-id"] as const) {
    const f = fixture()
    const subject = {
      kind: "term" as const,
      id: fault === "unknown-id" ? "unknown-host" : app.id,
      version: fault === "wrong-version" ? "9.9.9" : app.version,
      os: "macos",
      osVersion: null,
      outerTerminal: null,
      mux: null,
      config: null,
      permissions: null,
    }
    const draft = initializeRunDraft({
      runId: "shared-run",
      sourceRevision: "a".repeat(40),
      manifest: f.manifest,
      source: { kind: "live" },
      intendedSubject: subject,
    })
    Object.assign(draft, {
      subject,
      identity: "verified",
      measuredAt: "2026-10-21T05:00:00.000Z",
      origin: { kind: "collector" },
      rawReplies: {
        "device.primary-da": app.da1,
        "collector.xtversion": `\u001bP>|${app.reply}\u001b\\${app.da1}`,
        ...(fault === "shared" ? { "collector.disposableOwnership": JSON.stringify({ kind: "shared" }) } : {}),
      },
    })
    writeFileSync(f.source, JSON.stringify(finalizeCollectedDraft(draft as CapturedRunDraft)))
    if (fault === "absent" || fault === "shared") {
      expect(readFileSync(placeCollectedRun(f.source, f.manifest, f.content))).toEqual(readFileSync(f.source))
    } else {
      expect(() => placeCollectedRun(f.source, f.manifest, f.content)).toThrow(
        fault === "unknown-id" ? /identity-no-profile/ : /identity-replies-mismatch/,
      )
      expect(existsSync(join(f.content, "suites"))).toBe(false)
    }
  }
})
