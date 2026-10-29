/**
 * @failure Linux collections throw because TERMINFO_DISPOSABLE_RECEIPT coexists with the clipboard receipt.
 * @level l1
 * @consumer collectProbeRun owner selection used by linux-container-run.sh
 * @testonly none
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { loadFeatures } from "@terminfo/catalog"
import { ALL_PROBES } from "./probes/unified.ts"

const environment = {
  TERMINFO_CLIPBOARD_FIXTURE_RECEIPT: process.env.TERMINFO_CLIPBOARD_FIXTURE_RECEIPT,
  TERMINFO_DISPOSABLE_RECEIPT: process.env.TERMINFO_DISPOSABLE_RECEIPT,
  TERMINFO_RUNTIME_PROVENANCE: process.env.TERMINFO_RUNTIME_PROVENANCE,
  TERMINFO_CAPTURE_DIRECTORY: process.env.TERMINFO_CAPTURE_DIRECTORY,
  TERMINFO_PROBE_HASH: process.env.TERMINFO_PROBE_HASH,
  TERMINFO_SOURCE_REVISION: process.env.TERMINFO_SOURCE_REVISION,
}
// The disabled observer still checkpoints its draft through private custody; isolate that owner.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => directory,
}))
const directory = mkdtempSync(join(tmpdir(), "terminfo-linux-dual-receipt-"))
const provenance = join(directory, "runtime-provenance.json")
const clipboard = join(directory, "clipboard-fixture.json")
const disposable = join(directory, "host-measured.json")
let collectProbeRun: (options: { ids?: string[] }) => Promise<unknown>

beforeAll(async () => {
  vi.stubGlobal("__TERMINFO_BUNDLED_SUITE__", {
    manifest: {
      schemaVersion: 4 as const,
      probeHash: "a".repeat(12),
      sourceRevision: "b".repeat(40),
      generatedAt: "2026-10-10T00:00:00Z",
      adapterVersion: "test",
      catalogIds: Object.keys(loadFeatures(join(import.meta.dirname, "../../..", "content"))).sort(),
      probes: { term: ALL_PROBES.map((probe) => probe.id).sort(), lib: [], mux: [] },
    },
    collectorRevision: "b".repeat(40),
  })
  vi.resetModules()
  ;({ collectProbeRun } = await import("./serve.ts"))
  for (const key of [
    "TERMINFO_CAPTURE_DIRECTORY",
    "TERMINFO_CLIPBOARD_FIXTURE_RECEIPT",
    "TERMINFO_DISPOSABLE_RECEIPT",
    "TERMINFO_PROBE_HASH",
    "TERMINFO_SOURCE_REVISION",
  ] as const) {
    delete process.env[key]
  }
  writeFileSync(provenance, JSON.stringify({ executable: { path: process.execPath, sha256: "0".repeat(64) } }))
  writeFileSync(clipboard, "{}")
  writeFileSync(disposable, "{}")
  process.env.TERMINFO_RUNTIME_PROVENANCE = provenance
})

afterAll(() => {
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.unstubAllGlobals()
  // raw-delete-allow: standalone component repository whose CI installs without hh's workspace, so removely is unavailable; directory is this test's own mkdtemp scratch root
  rmSync(directory, { recursive: true, force: true })
})

test("Linux clipboard plus disposable receipts do not refuse as dual owners", async () => {
  process.env.TERMINFO_CLIPBOARD_FIXTURE_RECEIPT = clipboard
  process.env.TERMINFO_DISPOSABLE_RECEIPT = disposable
  await expect(collectProbeRun({ ids: ["device.xtversion"] })).rejects.not.toThrow(
    "Collection cannot have both Linux and hosted Darwin owners",
  )
})
