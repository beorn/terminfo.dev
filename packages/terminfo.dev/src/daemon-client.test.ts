/**
 * @failure A probe run can attach to or stop another daemon that registered nearby in time.
 * @level l3
 * @consumer App and mux real-terminal collectors
 * @testonly none
 * @reach fs-walk /tmp/terminfo-owned-*
 */
import { createServer, type Server } from "node:http"
import { createHash } from "node:crypto"
import { once } from "node:events"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { ProbeRun as CollectedProbeRun, ProbeSuiteManifest } from "@terminfo/probe-defs"
import {
  createProbeRun,
  findOwnedDaemon,
  readRawDaemonProbeResponse,
  readRetainedDaemonProbeResponse,
  removeProbeRun,
  requestDaemonProbe,
  saveDaemonProbeRun,
  stopOwnedDaemon,
} from "./daemon-client.ts"

const trustedReceipt = {
  manifest: {
    probeHash: "abcdef123456",
    sourceRevision: "b".repeat(40),
    generatedAt: "2026-09-28T00:00:00.000Z",
    adapterVersion: "3.3.1",
    probes: { app: ["device.primary-da"], headless: ["device.primary-da"], mux: ["device.primary-da"] },
  } satisfies ProbeSuiteManifest,
  collectorRevision: "a".repeat(40),
}

function collectorRun(): CollectedProbeRun {
  return {
    schemaVersion: 2,
    runId: "1234567890abcdef1234567890abcdef",
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
    suiteId: trustedReceipt.manifest.probeHash,
    probeHash: trustedReceipt.manifest.probeHash,
    suiteComplete: false,
    sourceRevision: trustedReceipt.collectorRevision,
    measuredAt: "2026-09-28T12:00:00.000Z",
    origin: { kind: "collector" },
    rawReplies: {},
    assertions: [],
    screenshotRefs: [],
    observations: [],
    ungradedDiagnostics: {},
  }
}

let server: Server | undefined
let root: string | undefined
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((err) => (err ? reject(err) : resolve())))
  if (root) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
  server = undefined
  root = undefined
})

it("writes one immutable v2 capture and refuses a mismatched intended version", () => {
  root = mkdtempSync(join(tmpdir(), "terminfo-owned-"))
  const run: CollectedProbeRun = {
    schemaVersion: 2,
    runId: "1234567890abcdef1234567890abcdef",
    target: {
      kind: "app",
      id: "kitty",
      version: "0.49.1",
      os: "macos",
      osVersion: "15",
      outerTerminal: null,
      mux: null,
      config: null,
      permissions: null,
    },
    identity: "unverified",
    suiteId: "abcdef123456",
    probeHash: "abcdef123456",
    suiteComplete: false,
    sourceRevision: "a".repeat(40),
    measuredAt: "2026-09-28T00:00:00.000Z",
    origin: { kind: "collector" },
    rawReplies: { "device.primary-da": "\x1b[?62;4c" },
    assertions: [],
    screenshotRefs: [],
    observations: [],
    ungradedDiagnostics: {},
  }
  const dir = join(root, "runs")
  expect(() => saveDaemonProbeRun(run, dir, { kind: "app", id: "kitty", version: "0.48.0" })).toThrow(
    /Measured version/,
  )
  const path = saveDaemonProbeRun(run, dir, { kind: "app", id: "kitty", version: "0.49.1" })
  const saved = JSON.parse(readFileSync(path, "utf8")) as CollectedProbeRun
  expect(saved.rawReplies["device.primary-da"]).toBe("\x1b[?62;4c")
  expect(() => saveDaemonProbeRun(run, dir, { kind: "app", id: "kitty", version: "0.49.1" })).toThrow()
})

it("selects only the launched run and checks /info before returning its token", async () => {
  root = mkdtempSync(join(tmpdir(), "terminfo-owned-"))
  const daemonDir = join(root, "daemons")
  mkdirSync(daemonDir)
  const seen: string[] = []
  server = createServer((req, res) => {
    seen.push(req.url ?? "")
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ runId: "ours", pid: 222, terminal: "kitty", terminalVersion: "0.49.1" }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("fixture did not bind")
  const token = "a".repeat(64)
  writeFileSync(
    join(daemonDir, "other.json"),
    JSON.stringify({
      runId: "other",
      pid: 111,
      port: address.port,
      token: "b".repeat(64),
      terminal: "kitty",
      terminalVersion: "0.49.1",
    }),
  )
  writeFileSync(
    join(daemonDir, "ours.json"),
    JSON.stringify({
      runId: "ours",
      pid: 222,
      port: address.port,
      token,
      terminal: "kitty",
      terminalVersion: "0.49.1",
    }),
  )
  const owned = await findOwnedDaemon("ours", daemonDir, "kitty", 100)
  expect(owned?.registration.pid).toBe(222)
  expect(owned?.registration.token).toBe(token)
  expect(owned?.filepath).toBe(join(daemonDir, "ours.json"))
  expect(seen).toEqual(["/info"])
})

it("refuses a wrong listener before sending the private token", async () => {
  root = mkdtempSync(join(tmpdir(), "terminfo-owned-"))
  const daemonDir = join(root, "daemons")
  mkdirSync(daemonDir)
  server = createServer((_req, res) =>
    res.end(JSON.stringify({ runId: "other", pid: 222, terminal: "kitty", terminalVersion: "0.49.1" })),
  )
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("fixture did not bind")
  writeFileSync(
    join(daemonDir, "ours.json"),
    JSON.stringify({
      runId: "ours",
      pid: 222,
      port: address.port,
      token: "a".repeat(64),
      terminal: "kitty",
      terminalVersion: "0.49.1",
    }),
  )
  await expect(findOwnedDaemon("ours", daemonDir, "kitty", 100)).rejects.toThrow(/identity.*mismatch/i)
})

it("signals and removes only the owned registration, leaving a peer untouched", async () => {
  root = mkdtempSync(join(tmpdir(), "terminfo-owned-"))
  const daemonDir = join(root, "daemons")
  mkdirSync(daemonDir)
  const own = join(daemonDir, "ours.json")
  const peer = join(daemonDir, "peer.json")
  server = createServer((_req, res) =>
    res.end(JSON.stringify({ runId: "ours", pid: 222, terminal: "kitty", terminalVersion: "0.49.1" })),
  )
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("fixture did not bind")
  const registration = {
    runId: "ours",
    pid: 222,
    port: address.port,
    token: "a".repeat(64),
    terminal: "kitty",
    terminalVersion: "0.49.1",
  }
  writeFileSync(own, JSON.stringify(registration))
  writeFileSync(peer, JSON.stringify({ ...registration, runId: "peer", pid: 333 }))
  const signal = vi.spyOn(process, "kill").mockImplementation(() => true)
  await stopOwnedDaemon({ filepath: own, registration })
  expect(signal).toHaveBeenCalledExactlyOnceWith(222, "SIGTERM")
  expect(readdirSync(daemonDir)).toEqual(["peer.json"])
  expect((JSON.parse(readFileSync(peer, "utf8")) as { pid: number }).pid).toBe(333)
})

it("does not signal a PID when its listener no longer matches the owned run", async () => {
  root = mkdtempSync(join(tmpdir(), "terminfo-owned-"))
  const daemonDir = join(root, "daemons")
  mkdirSync(daemonDir)
  server = createServer((_req, res) =>
    res.end(JSON.stringify({ runId: "another-run", pid: 222, terminal: "kitty", terminalVersion: "0.49.1" })),
  )
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("fixture did not bind")
  const filepath = join(daemonDir, "ours.json")
  const registration = {
    runId: "ours",
    pid: 222,
    port: address.port,
    token: "a".repeat(64),
    terminal: "kitty",
    terminalVersion: "0.49.1",
  }
  writeFileSync(filepath, JSON.stringify(registration))
  const signal = vi.spyOn(process, "kill").mockImplementation(() => true)
  await expect(stopOwnedDaemon({ filepath, registration })).rejects.toThrow(/identity.*mismatch/i)
  expect(signal).not.toHaveBeenCalled()
  expect(readdirSync(daemonDir)).toEqual(["ours.json"])
})

it("does not disclose the bearer token to a listener with another run identity", async () => {
  const seen: Array<{ path: string; authorization: string | undefined }> = []
  server = createServer((req, res) => {
    seen.push({ path: req.url ?? "", authorization: req.headers.authorization })
    res.end(JSON.stringify({ runId: "other", pid: 222, terminal: "kitty", terminalVersion: "0.49.1" }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("fixture did not bind")
  const registration = {
    runId: "ours",
    pid: 222,
    port: address.port,
    token: "a".repeat(64),
    terminal: "kitty",
    terminalVersion: "0.49.1",
  }
  await expect(requestDaemonProbe(registration)).rejects.toThrow(/identity.*mismatch/i)
  expect(seen).toEqual([{ path: "/info", authorization: undefined }])
})

// The Mac owner assertion must arrive before probing; existing token tests do
// not detect a client silently dropping the assertion and issuing an ordinary GET.
it("sends the attributed owner assertion only after verifying the private daemon", async () => {
  const owner = {
    asserter: "terminfo-admin" as const,
    launchRunId: "a".repeat(32),
    workerPid: 222,
    windowId: 791,
    tabTty: "/dev/ttys004",
    intendedVersion: "2.15",
  }
  const seen: Array<{ path: string; method: string; authorization: string | undefined; body: string }> = []
  server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      seen.push({
        path: req.url ?? "",
        method: req.method ?? "",
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString(),
      })
      res.end(JSON.stringify({ runId: owner.launchRunId, pid: 222, terminal: "terminal-app", terminalVersion: "2.15" }))
    })().catch((error: unknown) => res.destroy(error instanceof Error ? error : new Error(String(error))))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("fixture did not bind")
  const registration = {
    runId: owner.launchRunId,
    pid: 222,
    port: address.port,
    token: "b".repeat(64),
    terminal: "terminal-app",
    terminalVersion: "2.15",
  }
  await requestDaemonProbe(registration, owner)
  expect(seen.map(({ path, method }) => ({ path, method }))).toEqual([
    { path: "/info", method: "GET" },
    { path: "/probe", method: "POST" },
  ])
  expect(seen[0]?.authorization).toBeUndefined()
  expect(seen[1]?.authorization).toBe(`Bearer ${registration.token}`)
  expect(JSON.parse(seen[1]!.body)).toEqual({ terminalAppOwner: owner })
  expect(seen[1]!.body).not.toContain(registration.token)
})

it("refuses the old boolean daemon payload instead of upgrading it to v2 observations", async () => {
  const legacy = new Response(
    JSON.stringify({
      terminal: "kitty",
      terminalVersion: "0.49.1",
      os: "macos",
      osVersion: "25.4",
      generated: "2026-09-28T00:00:00.000Z",
      results: { "device.primary-da": true },
    }),
  )
  root = mkdtempSync(join(tmpdir(), "terminfo-owned-"))
  await expect(
    readRetainedDaemonProbeResponse(legacy, { directory: join(root, "http-responses"), receipt: trustedReceipt }),
  ).rejects.toThrow(/v2|schema|boolean/i)
})

it("retains exact daemon HTTP bytes and refuses invalid UTF-8 before parsing", async () => {
  const raw = `${JSON.stringify(collectorRun())}\r\n`
  const decoded = await readRawDaemonProbeResponse(new Response(raw), trustedReceipt)
  expect(decoded.raw).toBe(raw)
  expect(decoded.sha256).toBe(createHash("sha256").update(raw).digest("hex"))
  await expect(readRawDaemonProbeResponse(new Response(Buffer.from([0xff])), trustedReceipt)).rejects.toThrow(/UTF-8/i)
})

// The admin's second serialization cannot reconstruct the authenticated HTTP entity body.
it("retains authenticated exact response bytes before intended-version refusal", async () => {
  const privateRoot = mkdtempSync(join(tmpdir(), "terminfo-owned-"))
  root = privateRoot
  const privateDir = join(privateRoot, "http-responses")
  const token = "private-bearer-token"
  const run = collectorRun()
  const raw = `${JSON.stringify(run)}\r\n`
  const seen: Array<{ path: string; authorization: string | undefined }> = []
  server = createServer((req, res) => {
    seen.push({ path: req.url ?? "", authorization: req.headers.authorization })
    if (req.url === "/info") {
      res.end(JSON.stringify({ runId: run.runId, pid: 222, terminal: "kitty", terminalVersion: "0.49.1" }))
    } else res.end(raw)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("fixture did not bind")
  const response = await requestDaemonProbe({
    runId: run.runId,
    pid: 222,
    port: address.port,
    token,
    terminal: "kitty",
    terminalVersion: "0.49.1",
  })
  const retained = await readRetainedDaemonProbeResponse(response, { directory: privateDir, receipt: trustedReceipt })
  const sha = createHash("sha256").update(raw).digest("hex")
  expect(seen).toEqual([
    { path: "/info", authorization: undefined },
    { path: "/probe", authorization: `Bearer ${token}` },
  ])
  expect(retained.sha256).toBe(sha)
  expect(retained.path).toBe(join(privateDir, sha))
  expect(readFileSync(retained.path, "utf8")).toBe(raw)
  const launch = createProbeRun()
  removeProbeRun(launch)
  expect(readFileSync(retained.path, "utf8")).toBe(raw)
  expect(readFileSync(retained.path, "utf8")).not.toContain(token)
  expect(lstatSync(privateDir).mode & 0o077).toBe(0)
  expect(lstatSync(retained.path).mode & 0o077).toBe(0)
  expect(retained.run.rawReplies["collector.httpResponseSha256"]).toBe(sha)
  expect(() =>
    saveDaemonProbeRun(retained.run, join(privateRoot, "runs"), { kind: "app", id: "kitty", version: "0.48.0" }),
  ).toThrow(/Measured version/)
  expect(readdirSync(privateRoot).sort()).toEqual(["http-responses"])
  await readRetainedDaemonProbeResponse(new Response(raw), { directory: privateDir, receipt: trustedReceipt })
  expect(readFileSync(retained.path, "utf8")).toBe(raw)
})

it("refuses permissive stores, symlinks and conflicting bytes before returning an enriched run", async () => {
  root = mkdtempSync(join(tmpdir(), "terminfo-owned-"))
  const dir = join(root, "http-responses")
  mkdirSync(dir, { mode: 0o755 })
  const valid = `${JSON.stringify(collectorRun())}\r\n`
  await expect(
    readRetainedDaemonProbeResponse(new Response(valid), { directory: dir, receipt: trustedReceipt }),
  ).rejects.toThrow(/directory.*mode|private/i)
  expect(readdirSync(dir)).toEqual([])
  const decoded = await readRawDaemonProbeResponse(new Response(valid), trustedReceipt)
  chmodSync(dir, 0o700)
  const path = join(dir, decoded.sha256)
  symlinkSync(join(root, "missing"), path)
  await expect(
    readRetainedDaemonProbeResponse(new Response(valid), { directory: dir, receipt: trustedReceipt }),
  ).rejects.toThrow(/symbolic link|symlink/i)
  rmSync(path)
  writeFileSync(path, "wrong bytes", { mode: 0o600 })
  await expect(
    readRetainedDaemonProbeResponse(new Response(valid), { directory: dir, receipt: trustedReceipt }),
  ).rejects.toThrow(/different bytes/)
  writeFileSync(path, valid)
  chmodSync(path, 0o644)
  await expect(
    readRetainedDaemonProbeResponse(new Response(valid), { directory: dir, receipt: trustedReceipt }),
  ).rejects.toThrow(/private ordinary file/)

  const publicDir = join(root, "public")
  mkdirSync(publicDir)
  const linkedConfig = join(root, "linked-config")
  symlinkSync(publicDir, linkedConfig)
  await expect(
    readRetainedDaemonProbeResponse(new Response(valid), {
      directory: join(linkedConfig, "http-responses"),
      receipt: trustedReceipt,
    }),
  ).rejects.toThrow(/symbolic link/)
  expect(existsSync(join(publicDir, "http-responses"))).toBe(false)
})
