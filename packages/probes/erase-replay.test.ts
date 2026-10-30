/**
 * @failure The real erase family omits observer calls or opens a backend while asserting a retained call log offline.
 * @level l2
 * @consumer Phase0 recorder runner for the eleven existing erase callbacks.
 * @reach captures real xterm.js once and executes the same family twice with native backend creation forbidden.
 * @testonly none
 */
import { createHash, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir, release } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { initializeRunDraft, sealRunDraft, type CapturedRunDraft } from "@terminfo/probe-defs"
import { derivedSuiteManifest } from "../admin/versions.ts"
import { headlessRuntimeIdentity } from "./headless-identity.ts"
import { HEADLESS_TERMINAL } from "./headless-terminal.ts"
import { readEraseCapture } from "./erase-capture.ts"
import { expect, test, vi } from "vitest"
import * as xterm from "@termless/xtermjs"
import { readCallLog } from "viprobe"
import { captureEraseCalls, replayEraseCalls } from "./erase-replay.ts"

test("real erase calls replay twice without opening a terminal backend", async (context) => {
  let latestStart: string | undefined
  const openedAt: Array<string | undefined> = []
  const dateString = Date.prototype.toISOString
  const start = Date.now()
  let tick = 0
  const clock = vi.spyOn(Date.prototype, "toISOString").mockImplementation(() => {
    latestStart = dateString.call(new Date(start + tick++))
    return latestStart
  })
  const createBackend = xterm.createXtermBackend
  const opened = vi.spyOn(xterm, "createXtermBackend").mockImplementation(() => {
    openedAt.push(latestStart)
    return createBackend()
  })
  let captured: ReturnType<typeof captureEraseCalls>
  try {
    captured = captureEraseCalls(context)
  } finally {
    clock.mockRestore()
    opened.mockRestore()
  }
  expect(openedAt).toHaveLength(11)
  for (const startedAt of openedAt) expect(startedAt).toEqual(expect.any(String))
  expect(captured.results.map((record) => Reflect.get(record, "startedAt"))).toEqual(openedAt)
  expect(captured.results.map(({ featureId }) => featureId)).toEqual([
    "erase.character",
    "erase.line.right",
    "erase.line.left",
    "erase.line.all",
    "erase.screen.below",
    "erase.screen.above",
    "erase.screen.all",
    "erase.selective",
    "erase.ed-scroll-region",
    "erase.el-with-attrs",
    "erase.screen.scrollback",
  ])
  for (const record of captured.results) {
    expect(record.checks.length, record.featureId).toBeGreaterThan(1)
    expect(
      record.checks.some(({ kind }) => kind === "precondition"),
      record.featureId,
    ).toBe(true)
    expect(record.checks.at(-1)?.kind, record.featureId).toBe("assertion")
    expect(record.checks.map(({ step }) => step)).toEqual(record.checks.map((_, index) => index + 1))
  }
  // Call-log canonicalization sorts object keys. Compare the structured diagnostic
  // evidence, not the incidental key order inside the legacy JSON strings.
  const evidence = (records: typeof captured.results) =>
    records.map(({ featureId, result, checks }) => ({
      featureId,
      checks,
      ...result,
      response: result.response === undefined ? undefined : JSON.parse(result.response),
      assertions: result.assertions?.map((assertion) => ({
        ...assertion,
        observed: JSON.parse(assertion.observed),
      })),
    }))
  expect(captured.results.at(-1)?.result.observation).toEqual({ outcome: "supported", assertionType: "buffer_state" })
  const bytes = JSON.stringify(captured.log)
  const paths: string[] = []
  readCallLog(JSON.parse(bytes), { onOperation: ({ path }) => paths.push(path) })
  for (const method of ["open", "getCell", "getCursor", "getScrollback", "feed", "close"]) {
    expect(
      paths.some((path) => path.endsWith("." + method)),
      method,
    ).toBe(true)
  }
  const manifest = derivedSuiteManifest()
  const runtimeIdentity = await headlessRuntimeIdentity("xtermjs", "@termless/xtermjs", "js")
  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    encoding: "utf8",
  }).trim()
  const subject = {
    kind: "lib" as const,
    id: "xtermjs",
    version: runtimeIdentity.engineVersion,
    os: process.platform,
    osVersion: release(),
    outerTerminal: null,
    mux: null,
    config: "default",
    permissions: null,
  }
  const draft: CapturedRunDraft = {
    ...initializeRunDraft({
      runId: randomUUID(),
      sourceRevision,
      manifest,
      source: { kind: "live" },
      intendedSubject: subject,
    }),
    subject,
    runtimeIdentity,
    identity: "verified",
    measuredAt: new Date().toISOString(),
    origin: { kind: "collector" },
  }
  draft.rawReplies["collector.callLog"] = bytes
  draft.rawReplies["collector.traceManifest"] = JSON.stringify({
    captureKind: "buffer_state",
    geometry: HEADLESS_TERMINAL,
    blobs: [],
  })
  const captureBytes = JSON.stringify(sealRunDraft(draft))
  const directory = mkdtempSync(join(tmpdir(), "erase-capture-binding-"))
  const path = draft.runId + ".json"
  writeFileSync(join(directory, path), captureBytes)
  const source = {
    kind: "trace" as const,
    trace: { path, sha256: createHash("sha256").update(captureBytes).digest("hex") },
    captureRunId: draft.runId,
    captureSuiteId: manifest.probeHash,
    captureSourceRevision: sourceRevision,
  }
  const expected = { manifest, sourceRevision, subject, runtimeIdentity, geometry: HEADLESS_TERMINAL }
  expect(() => readEraseCapture(directory, { ...source, captureRunId: "another-capture" }, expected)).toThrow()
  expect(() =>
    readEraseCapture(directory, source, { ...expected, subject: { ...subject, version: "wrong-version" } }),
  ).toThrow()
  expect(() => readEraseCapture(directory, { ...source, captureSuiteId: "another-suite" }, expected)).toThrow()
  expect(() => readEraseCapture(directory, { ...source, captureSourceRevision: "another-source" }, expected)).toThrow()
  expect(() =>
    readEraseCapture(directory, { ...source, trace: { ...source.trace, sha256: "0".repeat(64) } }, expected),
  ).toThrow(/SHA256/)
  expect(() =>
    readEraseCapture(directory, { ...source, trace: { ...source.trace, path: "../escape.json" } }, expected),
  ).toThrow(/relative path/)
  expect(() =>
    readEraseCapture(directory, source, {
      ...expected,
      runtimeIdentity: { ...runtimeIdentity, engineVersion: "different-runtime" },
    }),
  ).toThrow(/runtime binding/)
  const substituteRaw = (key: string, value: string) => {
    const replacement = structuredClone(sealRunDraft(draft))
    replacement.rawReplies[key] = value
    const replacementBytes = JSON.stringify(replacement)
    const replacementPath = randomUUID() + ".json"
    writeFileSync(join(directory, replacementPath), replacementBytes)
    return {
      ...source,
      trace: { path: replacementPath, sha256: createHash("sha256").update(replacementBytes).digest("hex") },
    }
  }
  expect(() =>
    readEraseCapture(
      directory,
      substituteRaw(
        "collector.traceManifest",
        JSON.stringify({
          captureKind: "buffer_state",
          geometry: { ...HEADLESS_TERMINAL, rows: 25 },
          blobs: [],
        }),
      ),
      expected,
    ),
  ).toThrow(/geometry/)
  expect(() =>
    readEraseCapture(
      directory,
      substituteRaw(
        "collector.traceManifest",
        JSON.stringify({
          captureKind: "buffer_state",
          geometry: HEADLESS_TERMINAL,
          blobs: [{ path: "missing.bin", sha256: "0".repeat(64) }],
        }),
      ),
      expected,
    ),
  ).toThrow(/ENOENT/)
  writeFileSync(join(directory, "bound.bin"), "bound bytes")
  expect(() =>
    readEraseCapture(
      directory,
      substituteRaw(
        "collector.traceManifest",
        JSON.stringify({
          captureKind: "buffer_state",
          geometry: HEADLESS_TERMINAL,
          blobs: [{ path: "bound.bin", sha256: "0".repeat(64) }],
        }),
      ),
      expected,
    ),
  ).toThrow(/SHA256/)
  const unknownLog = JSON.parse(bytes)
  if (unknownLog === null || typeof unknownLog !== "object" || Array.isArray(unknownLog)) {
    throw new Error("Captured call log is not an object")
  }
  Reflect.set(unknownLog, "version", 999)
  expect(() =>
    readEraseCapture(directory, substituteRaw("collector.callLog", JSON.stringify(unknownLog)), expected),
  ).toThrow(/version/)
  const open = vi.spyOn(xterm, "createXtermBackend").mockImplementation(() => {
    throw new Error("Offline erase replay opened a live backend")
  })
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(evidence(replayEraseCalls(readEraseCapture(directory, source, expected).log, context))).toEqual(
        evidence(captured.results),
      )
    }
    expect(open).not.toHaveBeenCalled()
  } finally {
    open.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})
