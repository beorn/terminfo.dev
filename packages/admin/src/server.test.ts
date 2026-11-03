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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
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
import * as placement from "../corpus-placement.ts"
import * as collection from "./collected-run.ts"
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
  vi.unstubAllEnvs()
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

// Exercise the real daemon transport/parser with a schema-4 draft whose source revision is not trusted.
it("retains current-format HTTP bytes privately and refuses a collector revision mismatch", async () => {
  const manifest = {
    schemaVersion: 4 as const,
    probeHash: "abcdef123456",
    sourceRevision: "a".repeat(40),
    generatedAt: "2026-10-25T00:00:00.000Z",
    adapterVersion: "test",
    catalogIds: ["sgr.bold"],
    probes: { term: ["sgr.bold"], lib: [], mux: [] },
  } satisfies ProbeSuiteManifest
  const run: CapturedRunDraft = {
    ...initializeRunDraft({
      source: { kind: "live" },
      runId: "1234567890abcdef1234567890abcdef",
      sourceRevision: manifest.sourceRevision,
      manifest,
      intendedSubject: { kind: "term", id: "kitty", version: "0.49.1" },
    }),
    subject: {
      kind: "term",
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
  fixtures.raw = JSON.stringify(run)
  fixtures.receipt = {
    manifest,
    collectorRevision: "b".repeat(40),
  }
  await expect(handleServer("kitty", {})).rejects.toThrow(/collector draft differs from trusted suite\/source/)
  expect(saveDaemonProbeRun).not.toHaveBeenCalled()
  const digest = createHash("sha256").update(fixtures.raw).digest("hex")
  expect(readFileSync(join(fixtures.home!, ".terminfo-dev", "http-responses", digest), "utf8")).toBe(fixtures.raw)
  expect(existsSync(join(fixtures.home!, "collected"))).toBe(false)
  expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("written to content"))
})

it("preserves server --start without writing a run", async () => {
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
  ["retain", false],
  ["default", false],
  ["default", false, true],
  ["harness", false],
  ["harness", false, true],
  ["retain", false, true],
  ["here", false, true],
] as const)(
  "preserves %s coverage and collection custody (environment=%s, review=%s)",
  async (command, environment, pending: boolean = false) => {
    const manifest = {
      schemaVersion: 4 as const,
      probeHash: "abcdef123456",
      sourceRevision: "a".repeat(40),
      generatedAt: "2026-10-25T00:00:00.000Z",
      adapterVersion: "test",
      catalogIds: ["sgr.bold", ...(environment ? ENVIRONMENT_GROUP_IDS : [])],
      catalogEntrySha256: { "sgr.bold": "b".repeat(64) },
      probes: { term: [], lib: [], mux: [] },
    } satisfies ProbeSuiteManifest
    const run: CapturedRunDraft = {
      ...initializeRunDraft({
        source: { kind: "live" },
        runId: "1234567890abcdef1234567890abcdef",
        sourceRevision: manifest.sourceRevision,
        manifest,
        intendedSubject: { kind: "term", id: "kitty", version: "0.49.1" },
      }),
      subject: {
        kind: "term",
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
    if (pending) {
      run.rawReplies["sgr.bold"] = "reply"
      run.assertions = [
        {
          featureId: "sgr.bold",
          kind: "positive",
          assertionType: "query_reply",
          expected: "reply",
          observed: "reply",
          rawReplyRef: "sgr.bold",
        },
      ]
      run.results[0] = {
        featureId: "sgr.bold",
        status: "test-todo",
        reason: "Independent review pending",
        assertionType: "query_reply",
        rawReplyRef: "sgr.bold",
        attempt: { scope: "probe", startedAt: run.measuredAt },
        tests: [
          {
            id: "capture",
            status: "supported",
            assertionRefs: [0],
            attempt: { scope: "probe", startedAt: run.measuredAt },
          },
          { id: "review", status: "test-todo", reason: "Independent review pending", attempt: { scope: "none" } },
        ],
      }
    }
    const assertDraft = (saved: CapturedRunDraft) => {
      expect(saved).not.toHaveProperty("sealedAt")
      if (pending) expect(saved.results[0]!.tests.find((test) => test.id === "review")?.status).toBe("test-todo")
    }
    fixtures.receipt = { manifest, collectorRevision: manifest.sourceRevision }
    fixtures.raw = JSON.stringify(run)
    vi.spyOn(collection, "writeCollectedRun").mockReturnValue(join(fixtures.home!, "private.draft.json"))
    vi.spyOn(sourceEnvironment, "ensureSourceSuiteEnvironment").mockReturnValue({
      TERMINFO_PROBE_HASH: manifest.probeHash,
      TERMINFO_SOURCE_REVISION: manifest.sourceRevision,
    })
    vi.mocked(collector.collectProbeRun).mockResolvedValue(run)

    // Default collection must reach placement even for a draft; the old gate skipped it.
    if (command === "retain" || command === "default") {
      const response = join(fixtures.home!, "response")
      writeFileSync(response, fixtures.raw)
      if (command === "retain") {
        const saved = collection.retainCollectedRun(run, response, undefined, join(fixtures.home!, "private"))
        assertDraft(JSON.parse(readFileSync(saved, "utf8")) as CapturedRunDraft)
        expect(readFileSync(join(fixtures.home!, "private", "response"), "utf8")).toBe(fixtures.raw)
      } else {
        // Exercise the default writer from an actual authoring branch, independent of the CI checkout.
        const checkout = join(fixtures.home!, "checkout")
        mkdirSync(checkout)
        execFileSync("git", ["init", "-q", "-b", "task/fixture"], { cwd: checkout, stdio: "pipe" })
        execFileSync(
          "git",
          [
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "user.name=fixture",
            "commit",
            "--allow-empty",
            "-qm",
            "fixture",
          ],
          { cwd: checkout, stdio: "pipe" },
        )
        vi.stubEnv("GIT_DIR", join(checkout, ".git"))
        vi.stubEnv("GIT_WORK_TREE", checkout)
        vi.mocked(collection.writeCollectedRun).mockRestore()
        const place = vi.spyOn(placement, "placeCollectedRun").mockImplementation(() => {
          throw new Error("placement reached")
        })
        expect(() => collection.writeCollectedRun(run, response)).toThrow("placement reached")
        const saved = place.mock.calls[0]![0]
        expect(JSON.parse(readFileSync(saved, "utf8"))).not.toHaveProperty("sealedAt")
        expect(place).toHaveBeenCalledWith(saved, manifest)
      }
      return
    }
    if (command === "harness") {
      const argv = process.argv
      const path = join(fixtures.home!, "harness.json")
      try {
        process.argv = [argv[0]!, "app-harness.ts", path]
        vi.resetModules()
        await import("../app-harness.ts")
        assertDraft(JSON.parse(readFileSync(path, "utf8")) as CapturedRunDraft)
        expect(existsSync(`${path}.done`)).toBe(true)
      } finally {
        process.argv = argv
      }
      return
    }
    if (command === "server") await handleServer("kitty", {})
    else {
      if (pending) {
        await handleHere({ json: true })
        assertDraft(JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)![0])) as CapturedRunDraft)
        vi.mocked(console.log).mockClear()
      }
      await handleHere({})
      expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toContain("identity unverified")
      expect(vi.mocked(console.log).mock.calls.flat().join(" ")).not.toContain("required review pending")
    }

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
  },
)
