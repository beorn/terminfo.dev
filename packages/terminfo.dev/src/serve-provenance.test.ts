/**
 * @failure A provenance-only or nonvisual capture run seals a claimed ELF without verifying its owned process.
 * @level l1
 * @consumer collectProbeRun Linux app admission before probe callbacks.
 * @testonly none
 */
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { ALL_PROBES } from "./probes/unified.ts"

const environment = {
  TERMINFO_CAPTURE_DIRECTORY: process.env.TERMINFO_CAPTURE_DIRECTORY,
  TERMINFO_CLIPBOARD_FIXTURE_RECEIPT: process.env.TERMINFO_CLIPBOARD_FIXTURE_RECEIPT,
  TERMINFO_RUNTIME_PROVENANCE: process.env.TERMINFO_RUNTIME_PROVENANCE,
  TERMINFO_PROBE_HASH: process.env.TERMINFO_PROBE_HASH,
  TERMINFO_SOURCE_REVISION: process.env.TERMINFO_SOURCE_REVISION,
  DISPLAY: process.env.DISPLAY,
}
const directory = mkdtempSync(join(tmpdir(), "terminfo-serve-provenance-"))
const receipt = join(directory, "runtime-provenance.json")
let collectProbeRun: (options: { ids?: string[] }) => Promise<unknown>

beforeAll(async () => {
  vi.stubGlobal("__TERMINFO_BUNDLED_SUITE__", {
    manifest: {
      probeHash: "a".repeat(12),
      sourceRevision: "b".repeat(40),
      generatedAt: "2026-09-28T00:00:00Z",
      adapterVersion: "test",
      probes: { app: ALL_PROBES.map((probe) => probe.id).sort(), headless: [], mux: [] },
    },
    collectorRevision: "b".repeat(40),
  })
  vi.resetModules()
  ;({ collectProbeRun } = await import("./serve.ts"))
  for (const key of [
    "TERMINFO_CAPTURE_DIRECTORY",
    "TERMINFO_CLIPBOARD_FIXTURE_RECEIPT",
    "TERMINFO_PROBE_HASH",
    "TERMINFO_SOURCE_REVISION",
  ] as const) {
    delete process.env[key]
  }
  process.env.TERMINFO_RUNTIME_PROVENANCE = receipt
  process.env.DISPLAY = ":test"
})

afterAll(() => {
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.unstubAllGlobals()
  rmSync(directory, { recursive: true, force: true })
})

// 27875: the frame-less controlled-Linux capture exists so a probe that needs a frame fails by
// name in its own result, instead of reaching an absent callback.
test("the frame-less controlled-Linux capture fails by name", async () => {
  const { frameUnavailableCapture } = await import("./serve.ts")
  const thrown = await frameUnavailableCapture()({
    featureId: "cursor.shape",
    role: "target",
    label: "frame-less",
  }).catch((error: unknown) => error)
  expect(thrown).toBeInstanceOf(Error)
  expect((thrown as Error).name).toBe("FrameUnavailable")
  expect((thrown as Error).message).toContain("no capture directory")
})

test("provenance without owned capture or clipboard refuses before selecting any callback", async () => {
  writeFileSync(receipt, JSON.stringify({ executable: { path: process.execPath, sha256: "0".repeat(64) } }))
  await expect(collectProbeRun({ ids: [] })).rejects.toThrow("requires owned capture or clipboard")
})

test.each(["C:\\artifacts\\terminfo-run.exe", "C:/artifacts/terminfo-run.exe", "D:\\Program Files\\app.exe"])(
  "provenance accepts valid Windows drive-letter path %s as absolute",
  async (windowsPath) => {
    writeFileSync(receipt, JSON.stringify({ executable: { path: windowsPath, sha256: "0".repeat(64) } }))
    process.env.TERMINFO_CAPTURE_DIRECTORY = join(directory, "frames")
    try {
      // Passes measuredExecutable check; fails later on executable digest or existence check
      await expect(collectProbeRun({ ids: [] })).rejects.not.toThrow(
        "Runtime provenance has invalid measured executable",
      )
    } finally {
      delete process.env.TERMINFO_CAPTURE_DIRECTORY
    }
  },
)

test("provenance rejects relative path", async () => {
  writeFileSync(receipt, JSON.stringify({ executable: { path: "relative/path/app.exe", sha256: "0".repeat(64) } }))
  process.env.TERMINFO_CAPTURE_DIRECTORY = join(directory, "frames")
  try {
    await expect(collectProbeRun({ ids: [] })).rejects.toThrow("Runtime provenance has invalid measured executable")
  } finally {
    delete process.env.TERMINFO_CAPTURE_DIRECTORY
  }
})

test.runIf(process.platform === "linux")(
  "a nonvisual capture selection still verifies the owned executable before callbacks",
  async () => {
    const path = realpathSync(`/proc/${process.pid}/exe`)
    const actual = createHash("sha256").update(readFileSync(path)).digest("hex")
    writeFileSync(
      receipt,
      JSON.stringify({ executable: { path, sha256: actual.replace(/^./, actual[0] === "0" ? "1" : "0") } }),
    )
    process.env.TERMINFO_CAPTURE_DIRECTORY = join(directory, "frames")
    await expect(collectProbeRun({ ids: [] })).rejects.toThrow("executable digest mismatch")
  },
)
