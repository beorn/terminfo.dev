/**
 * @failure Linux collections throw because TERMINFO_DISPOSABLE_RECEIPT coexists with the clipboard receipt.
 * @level l1
 * @consumer collectProbeRun owner selection used by linux-container-run.sh
 * @testonly none
 */
import { createHash } from "node:crypto"
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

/**
 * A receipt the parser accepts, so the refusal under test is the one the collector makes and not a parse error.
 * Its shape is the fixture ordinary-open-run.test.ts proves the parser against, field for field.
 */
function ordinaryOpenReceipt(runId: string): string {
  const nonce = "nonce-" + runId + "-b7d1"
  const path = join(directory, "ordinary-open-" + runId + ".json")
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      kind: "ordinary-open-app",
      runId,
      collectedAt: "2026-11-13T19:00:00Z",
      subject: {
        id: "iterm2",
        bundleId: "com.googlecode.iterm2",
        version: "3.5.14",
        executableInBundle: "iTerm.app/Contents/MacOS/iTerm2",
      },
      ancestry: {
        appPid: 4711,
        chain: [
          { pid: 4802, executable: "bun" },
          { pid: 4790, executable: "zsh" },
          { pid: 4711, executable: "iTerm2" },
        ],
      },
      nonce: { value: nonce, sha256: createHash("sha256").update(nonce).digest("hex") },
      witness: { command: "pbpaste", exit: 0, matched: true },
      baselineRestore: { length: 12, sha256: "a".repeat(64), restored: true },
      signature: { teamId: "H7H8Q7M5B0", signingIdentifier: "com.googlecode.iterm2" },
    }),
  )
  return path
}

/** An owned terminal whose only claim is its kind, which is all the one-proof-per-run refusal reads. */
const ownedTerminalFixture = {
  clipboard: undefined,
  summary: "{}",
  dispose: async () => {},
  geometryAtGrant: { status: "measured", rows: 24, cols: 80 },
  geometrySource: "fixture",
  readGeometry: async () => ({ status: "measured", rows: 24, cols: 80 }),
}

/**
 * All three START refusals of an ordinary-open run, driven through the collector that makes them (@cto carry 2):
 * the pair with a disposable receipt, the pair with an owned terminal, and a receipt from another run. Each must
 * refuse loudly and name itself before any row is produced, and the last one proves the run's own id is the one the
 * receipt is bound against — under that id the same receipt gets past the binding and stops on the platform.
 */
test("ordinary-open START refusals hold through collectProbeRun, each named", async () => {
  const receiptRun = "d".repeat(32)
  const thisRun = "e".repeat(32)
  vi.resetModules()
  vi.doMock("./owned-terminal.ts", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./owned-terminal.ts")>()),
    createOwnedTerminal: async () => ownedTerminalFixture,
  }))
  const { collectProbeRun: collect } = await import("./serve.ts")
  const previousRun = process.env.TERMINFO_RUN_ID
  const previousProvenance = process.env.TERMINFO_RUNTIME_PROVENANCE
  // The earlier test leaves both receipts behind, and one of these arms reads TERMINFO_RUN_ID itself.
  delete process.env.TERMINFO_CLIPBOARD_FIXTURE_RECEIPT
  delete process.env.TERMINFO_DISPOSABLE_RECEIPT
  process.env.TERMINFO_RUN_ID = thisRun
  process.env.TERMINFO_ORDINARY_OPEN_RECEIPT = ordinaryOpenReceipt(receiptRun)
  try {
    // An owned terminal and an ordinary-open receipt are two proofs of the same thing.
    process.env.TERMINFO_CLIPBOARD_FIXTURE_RECEIPT = clipboard
    await expect(collect({ ids: ["device.xtversion"] })).rejects.toThrow(
      /is set on a run that owns its terminal \(linux\)/,
    )
    delete process.env.TERMINFO_CLIPBOARD_FIXTURE_RECEIPT
    // Provenance is only meaningful with an owner, and it refuses first when it has none.
    delete process.env.TERMINFO_RUNTIME_PROVENANCE
    // A disposable runner's receipt is a different machine, and the pair has no meaning.
    process.env.TERMINFO_DISPOSABLE_RECEIPT = disposable
    await expect(collect({ ids: ["device.xtversion"] })).rejects.toThrow(
      /Both TERMINFO_ORDINARY_OPEN_RECEIPT and TERMINFO_DISPOSABLE_RECEIPT are set/,
    )
    delete process.env.TERMINFO_DISPOSABLE_RECEIPT
    // A receipt from another run names both ids, so a launcher can see which file it handed over.
    await expect(collect({ ids: ["device.xtversion"] })).rejects.toThrow(
      new RegExp("belongs to run " + receiptRun + ", this run is " + thisRun),
    )
    // The same receipt under its own run id is bound, then refuses on the platform: the id reached the binding.
    process.env.TERMINFO_RUN_ID = receiptRun
    await expect(collect({ ids: ["device.xtversion"] })).rejects.toThrow(
      /an ordinary-open receipt grades a macOS app, and this run measures linux/,
    )
  } finally {
    delete process.env.TERMINFO_ORDINARY_OPEN_RECEIPT
    delete process.env.TERMINFO_DISPOSABLE_RECEIPT
    delete process.env.TERMINFO_CLIPBOARD_FIXTURE_RECEIPT
    if (previousRun === undefined) delete process.env.TERMINFO_RUN_ID
    else process.env.TERMINFO_RUN_ID = previousRun
    if (previousProvenance === undefined) delete process.env.TERMINFO_RUNTIME_PROVENANCE
    else process.env.TERMINFO_RUNTIME_PROVENANCE = previousProvenance
    vi.doUnmock("./owned-terminal.ts")
  }
})
