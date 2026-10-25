/**
 * @failure Retained A/B traces change bytes or lose source binding on disk; unknown versions silently become replayable; retained PNG references lose their original bytes.
 * @level l1
 * @consumer The admitted private stored-trace experiment, with its immutable A/B corpus and source exports
 * @reach fs-read /hh/var/@dev10/30922/*-r1/** /hh/var/@dev10/30923/decorated/3f3a74eefb79b8b9953865b636a9d7c8/raw/**
 * @reach fs-read /hh/var/@dev10/30924/storage-r1/source-{a,b}/call-log.ts
 * @reach fs-walk <fixture-only: retained C outputs and the explicitly selected runner temporary root>
 * @testonly readStoredTrace: private storage experiment; no production caller is admitted by this slice
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterAll, beforeAll, expect, test } from "vitest"
import { verifyRetainedArtifact } from "../../packages/admin/run-admission.ts"
import { readStoredTrace } from "./stored-trace.ts"

const evidence = "/hh/var/@dev10/30924/storage-r1"
const corpusA = "/hh/var/@dev10/30922"
const corpusB = "/hh/var/@dev10/30923/decorated/3f3a74eefb79b8b9953865b636a9d7c8/raw"
const engines = ["xtermjs", "ghostty", "vt100", "vt220", "vterm", "libvterm"]
const observers = [
  ["device.tertiary-da", "f3a73ef17f8cad58ad21c98c56ff289bb451ba105fabc52ba51d84d6fea175a8"],
  ["erase.screen.scrollback", "dec3bca130e012d4b984dd27df551da8fc38f050fb4e93375efa015df78803bd"],
  ["extensions.font-ligatures", "d8f93f4bb0109d6a387e93eb2af4372bae58f4d722f2295ede24747e41535a49"],
] as const
const pngs = [
  "72c68ce974efb270a021d81efb006e3b1de004421a56874a58ae777e546bfecf",
  "dd90962e9e3f667cb295aea1e2495e98f64eed2a4e5c6432546d862e4a1e6be7",
]
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
type Recorder = { dialect: "a" | "b"; IncompleteReplay: new (message: string) => Error }
type AFixture = { source: Record<string, unknown>; log: { version?: unknown } }
type DraftFixture = {
  runId: string
  sourceRevision: string
  provenance: { runtime: { suiteHash: string } }
  results: Array<{ featureId: string; status: string }>
}
let recorderA: Recorder
let recorderB: Recorder
let output: string

beforeAll(async () => {
  expect(tmpdir()).toBe("/tmp/km-vitest-3001/run-30924-storage-r2")
  expect(process.env.KM_VITEST_RUN_ROOT).toBe(tmpdir())
  expect(process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe("0")
  output = mkdtempSync(join(evidence, "roundtrip-"))
  writeFileSync(
    join(output, "runtime-before.json"),
    JSON.stringify({
      at: new Date().toISOString(),
      tmpdir: tmpdir(),
      cache: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
      command: ["du", "-sk", tmpdir()],
      temporaryAllocation: execFileSync("du", ["-sk", tmpdir()], { encoding: "utf8" }),
    }),
  )
  const sourceA = join(evidence, "source-a/call-log.ts")
  const sourceB = join(evidence, "source-b/call-log.ts")
  expect(sha256(readFileSync(sourceA))).toBe("4c8caf5c000ffffdfd267e8424a7095515e16fafcc9a29593c40571fcbde0ca0")
  expect(sha256(readFileSync(sourceB))).toBe("e59ec7d4b8020b55b48e01478faccac4afa4ff6b3b68e3c2cbf65f09df9fde68")
  recorderA = { dialect: "a", ...(await import(pathToFileURL(sourceA).href)) }
  recorderB = { dialect: "b", ...(await import(pathToFileURL(sourceB).href)) }
})

afterAll(() => {
  if (!output) return
  writeFileSync(
    join(output, "runtime-after.json"),
    JSON.stringify({
      at: new Date().toISOString(),
      tmpdir: tmpdir(),
      cache: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
      command: ["du", "-sk", tmpdir()],
      temporaryAllocation: execFileSync("du", ["-sk", tmpdir()], { encoding: "utf8" }),
    }),
  )
})

test("retains all 1515 source-bound traces and both referenced PNGs byte-for-byte on disk", () => {
  const receipts: Array<{
    source: string
    destination: string
    bytes: number
    sha256: string
    rereadSha256: string
    calls: number
  }> = []
  const roundtrip = (source: string, destination: string, recorder: Recorder) => {
    const original = readFileSync(source)
    const loaded = readStoredTrace(source, recorder)
    writeFileSync(destination, loaded.serialized, { flag: "wx" })
    const reread = readFileSync(destination)
    expect(reread.equals(original), source).toBe(true)
    expect(sha256(reread), source).toBe(sha256(original))
    expect(readStoredTrace(destination, recorder).document, source).toEqual(JSON.parse(original.toString("utf8")))
    receipts.push({
      source,
      destination,
      bytes: original.length,
      sha256: sha256(original),
      rereadSha256: sha256(reread),
      calls: loaded.document.log.calls.length,
    })
  }
  for (const engine of engines) {
    const originalRun = join(corpusA, `${engine}-r1`)
    const destinationRun = join(output, "a", `${engine}-r1`)
    mkdirSync(join(destinationRun, "traces"), { recursive: true })
    copyFileSync(join(originalRun, "identity.json"), join(destinationRun, "identity.json"))
    const names = readdirSync(join(originalRun, "traces")).sort()
    expect(names.length, engine).toBe(252)
    for (const name of names) {
      roundtrip(join(originalRun, "traces", name), join(destinationRun, "traces", name), recorderA)
    }
  }
  expect(receipts.length).toBe(1512)
  expect(receipts.reduce((total, receipt) => total + receipt.bytes, 0)).toBe(7542561)
  expect(receipts.reduce((total, receipt) => total + receipt.calls, 0)).toBe(16934)
  const destinationB = join(output, "b/raw")
  mkdirSync(join(destinationB, "spike-b"), { recursive: true })
  copyFileSync(join(corpusB, "v3-run.draft.json"), join(destinationB, "v3-run.draft.json"))
  for (const [feature, digest] of observers) {
    const source = join(corpusB, "spike-b", `${feature}.json`)
    expect(sha256(readFileSync(source))).toBe(digest)
    roundtrip(source, join(destinationB, "spike-b", `${feature}.json`), recorderB)
  }
  expect(receipts.length).toBe(1515)
  const draft = JSON.parse(readFileSync(join(corpusB, "v3-run.draft.json"), "utf8")) as DraftFixture
  expect(draft.results.find((result) => result.featureId === "extensions.font-ligatures")?.status).toBe("test-todo")
  mkdirSync(join(destinationB, "artifacts"))
  const screenshots = pngs.map((digest) => {
    const ref = `sha256:${digest}`
    expect(JSON.stringify(draft)).toContain(ref)
    const source = join(corpusB, "artifacts", `${digest}.png`)
    const destination = join(destinationB, "artifacts", `${digest}.png`)
    const bytes = readFileSync(source)
    verifyRetainedArtifact("screenshot", bytes, ref, source)
    writeFileSync(destination, bytes, { flag: "wx" })
    const reread = readFileSync(destination)
    verifyRetainedArtifact("screenshot", reread, ref, destination)
    expect(reread.equals(readFileSync(source))).toBe(true)
    return { source, destination, ref, bytes: bytes.length, sha256: sha256(bytes) }
  })
  writeFileSync(join(output, "roundtrips.json"), JSON.stringify({ traces: receipts, screenshots }, null, 2), {
    flag: "wx",
  })
})

test("rejects literal unknown versions before provenance and rejects missing, foreign or unmatched sources", () => {
  const originalPath = join(corpusA, "xtermjs-r1/traces/device.primary-da.json")
  const original = readFileSync(originalPath)
  const directoryA = join(output, "negative-a")
  mkdirSync(join(directoryA, "traces"), { recursive: true })
  copyFileSync(join(corpusA, "xtermjs-r1/identity.json"), join(directoryA, "identity.json"))
  const failures: Array<{ path: string; reason: string }> = []
  const refuse = (path: string, recorder: Recorder, reason: string) => {
    let caught: unknown
    try {
      readStoredTrace(path, recorder)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(recorder.IncompleteReplay)
    expect((caught as Error).message).toBe(`Incomplete: ${reason}`)
    failures.push({ path, reason: (caught as Error).message })
  }
  for (const [name, version] of [
    ["version-2", 2],
    ["string-version", "1"],
    ["missing-version", undefined],
  ] as const) {
    const changed = JSON.parse(original.toString("utf8")) as AFixture
    changed.log.version = version
    if (name !== "version-2") changed.source.terminfoRevision = "foreign"
    const path = join(directoryA, "traces", `${name}.json`)
    writeFileSync(path, `${JSON.stringify(changed)}\n`, { flag: "wx" })
    refuse(path, recorderA, `unknown trace version ${JSON.stringify(version) ?? "undefined"}`)
  }
  const foreignA = JSON.parse(original.toString("utf8")) as AFixture
  foreignA.source.collectorSha256 = "foreign"
  const foreignPath = join(directoryA, "traces/foreign-source.json")
  writeFileSync(foreignPath, `${JSON.stringify(foreignA)}\n`, { flag: "wx" })
  refuse(foreignPath, recorderA, `unknown trace provenance: ${foreignPath}`)
  for (const variant of ["missing-draft", "unmatched-run", "foreign-revision", "foreign-suite"]) {
    const path = join(output, variant, "spike-b/device.tertiary-da.json")
    mkdirSync(dirname(path), { recursive: true })
    copyFileSync(join(corpusB, "spike-b/device.tertiary-da.json"), path)
    const draft = JSON.parse(readFileSync(join(corpusB, "v3-run.draft.json"), "utf8")) as DraftFixture
    if (variant === "unmatched-run") draft.runId = "foreign"
    if (variant === "foreign-revision") draft.sourceRevision = "foreign"
    if (variant === "foreign-suite") draft.provenance.runtime.suiteHash = "foreign"
    if (variant !== "missing-draft") {
      writeFileSync(join(dirname(dirname(path)), "v3-run.draft.json"), JSON.stringify(draft), { flag: "wx" })
    }
    refuse(path, recorderB, `unknown trace provenance: ${path}`)
  }
  expect(readFileSync(originalPath).equals(original)).toBe(true)
  writeFileSync(join(output, "negative-cases.json"), JSON.stringify(failures, null, 2), { flag: "wx" })
})
