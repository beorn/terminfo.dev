import { createHash } from "node:crypto"
/**
 * @failure Daemon clients omit authorization and report failed collection as success.
 * @level l2
 * @consumer private admin server command and the shared daemon request client
 * @testonly none
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createServer, type Server } from "node:http"
import { once } from "node:events"
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  ENVIRONMENT_GROUP_IDS,
  initializeRunDraft,
  type CapturedRunDraft,
  type ProbeSuiteManifest,
} from "@terminfo/probe-defs"
import { saveDaemonProbeRun } from "../../terminfo.dev/src/daemon-client.ts"
import * as collector from "../../terminfo.dev/src/serve.ts"
import * as admission from "./admit-collected-run.ts"
import * as sourceEnvironment from "../versions.ts"
import { handleServer } from "./server.ts"
import { handleHere } from "./here.ts"

const fixtures = vi.hoisted(() => ({
  home: undefined as string | undefined,
  raw: undefined as string | undefined,
  receipt: undefined as { manifest: ProbeSuiteManifest; collectorRevision: string } | undefined,
  daemons: [] as Array<{
    terminal: string
    terminalVersion: string
    port: number
    pid: number
    runId: string
    token?: string
  }>,
}))
vi.mock("../../terminfo.dev/src/serve.ts", () => ({
  listDaemons: () => fixtures.daemons,
  getTrustedSuiteReceipt: () => fixtures.receipt,
  collectProbeRun: vi.fn(),
  startDaemon: vi.fn(),
}))
vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>()
  return { ...original, homedir: () => fixtures.home ?? original.homedir() }
})
vi.mock("../../terminfo.dev/src/daemon-client.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../terminfo.dev/src/daemon-client.ts")>()
  return {
    ...original,
    saveDaemonProbeRun: vi.fn((run, directory, intended) => {
      // Exercise the real exclusive writer without ever letting a regression write the repository corpus.
      return original.saveDaemonProbeRun(run, join(fixtures.home!, "collected"), intended)
    }),
  }
})

let server: Server
let requests: Array<string | undefined>
beforeEach(async () => {
  fixtures.home = mkdtempSync(join(tmpdir(), "terminfo-admin-server-"))
  fixtures.raw = undefined
  requests = []
  server = createServer((req, res) => {
    requests.push(req.headers.authorization)
    if (req.url === "/info") {
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ runId: "fixture-run", pid: 123, terminal: "kitty", terminalVersion: "0.49.1" }))
      return
    }
    res.writeHead(req.headers.authorization === "Bearer fixture-token" ? (fixtures.raw ? 200 : 503) : 401)
    res.end(fixtures.raw ?? "fixture collector unavailable")
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("fixture did not bind TCP")
  fixtures.daemons = [
    {
      terminal: "kitty",
      terminalVersion: "0.49.1",
      port: address.port,
      pid: 123,
      runId: "fixture-run",
      token: "fixture-token",
    },
  ]
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  if (fixtures.home) rmSync(fixtures.home, { recursive: true, force: true })
  fixtures.home = undefined
  vi.mocked(saveDaemonProbeRun).mockClear()
  vi.restoreAllMocks()
})

// Real HTTP observes the credential independently; a fetch mock could bless a missing header.
it("authorizes the selected daemon and fails the command when collection fails", async () => {
  await expect(handleServer("kitty", {})).rejects.toThrow(/kitty.*HTTP 503/s)
  expect(requests).toEqual([undefined, "Bearer fixture-token"])
  expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("Results saved"))
})

it("refuses an old registration without a token before sending any terminal command", async () => {
  delete fixtures.daemons[0]!.token
  await expect(handleServer("kitty", {})).rejects.toThrow(/token.*restart/i)
  expect(requests).toEqual([])
})

// The daemon transport/parser and raw writer are real; the admission owner independently refuses
// this retained historical collection's dirty provenance. The old canonical save bypassed it.
it("retains historical HTTP bytes privately and refuses to treat them as the current collector contract", async () => {
  const root = join(import.meta.dirname, "../../..")
  fixtures.raw = readFileSync(
    join(root, "test-fixtures/probes-apps/kitty-0.49.2-linux-8c50df5834ccb938c208aa91467e9a2b.json"),
    "utf8",
  )
  const run = JSON.parse(fixtures.raw) as { probeHash: string; sourceRevision: string }
  fixtures.receipt = {
    manifest: JSON.parse(
      readFileSync(join(root, "content/suites", `${run.probeHash}.json`), "utf8"),
    ) as ProbeSuiteManifest,
    collectorRevision: run.sourceRevision,
  }
  await expect(handleServer("kitty", {})).rejects.toThrow(/schemaVersion 3 collector draft/)
  expect(saveDaemonProbeRun).not.toHaveBeenCalled()
  const digest = createHash("sha256").update(fixtures.raw).digest("hex")
  expect(readFileSync(join(fixtures.home!, ".terminfo-dev", "http-responses", digest), "utf8")).toBe(fixtures.raw)
  expect(existsSync(join(fixtures.home!, "collected"))).toBe(false)
  expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("admitted to content"))
})

it("preserves server --start without running admission", async () => {
  const { startDaemon } = await import("../../terminfo.dev/src/serve.ts")
  await handleServer(undefined, { start: true, port: 4567 })
  expect(startDaemon).toHaveBeenCalledWith(4567)
  expect(saveDaemonProbeRun).not.toHaveBeenCalled()
  expect(requests).toEqual([])
})

it.each([
  ["server", false],
  ["server", true],
  ["here", false],
  ["here", true],
] as const)("prints %s coverage from its own environment catalogue: %s", async (command, environment) => {
  const manifest = {
    probeHash: "abcdef123456",
    sourceRevision: "a".repeat(40),
    generatedAt: "2026-10-25T00:00:00.000Z",
    adapterVersion: "test",
    catalogIds: ["sgr.bold", ...(environment ? ENVIRONMENT_GROUP_IDS : [])],
    probes: { app: [], headless: [], mux: [] },
  } satisfies ProbeSuiteManifest
  const run: CapturedRunDraft = {
    ...initializeRunDraft({
      runId: "1234567890abcdef1234567890abcdef",
      sourceRevision: manifest.sourceRevision,
      manifest,
      intendedContext: { kind: "app", id: "kitty", version: "0.49.1" },
    }),
    target: {
      kind: "app",
      id: "kitty",
      version: "0.49.1",
      os: "linux",
      osVersion: null,
      outerTerminal: null,
      mux: null,
      config: null,
      permissions: null,
    },
    identity: "unverified",
    measuredAt: "2026-10-25T00:00:00.000Z",
    origin: { kind: "collector" },
  }
  fixtures.receipt = { manifest, collectorRevision: manifest.sourceRevision }
  fixtures.raw = JSON.stringify(run)
  vi.spyOn(admission, "admitCollectedRun").mockReturnValue(join(fixtures.home!, "private.draft.json"))
  vi.spyOn(sourceEnvironment, "ensureSourceSuiteEnvironment").mockReturnValue({
    TERMINFO_PROBE_HASH: manifest.probeHash,
    TERMINFO_SOURCE_REVISION: manifest.sourceRevision,
  })
  vi.mocked(collector.collectProbeRun).mockResolvedValue(run)

  if (command === "server") await handleServer("kitty", {})
  else await handleHere({})

  const clause = environment ? " · 9 environment groups manual by design (catalogue), ungraded" : ""
  const summary = vi
    .mocked(console.log)
    .mock.calls.map(([line]) => line)
    .find((line) => line.includes("TEST FAILURE"))
  const coverage = `0 Supported · 0 Unsupported · 0 Untestable · 1 TEST TODO · 0 TEST FAILURE${clause}`
  expect(summary).toBe(
    command === "server"
      ? `  ${"kitty 0.49.1".padEnd(25)} Not measured yet · ${coverage} (identity unverified)`
      : coverage,
  )
})
