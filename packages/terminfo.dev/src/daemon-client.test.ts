/**
 * @failure A probe run can attach to or stop another daemon that registered nearby in time.
 * @level l3
 * @consumer App and mux real-terminal collectors
 * @testonly none
 * @reach fs-walk /tmp/terminfo-owned-*
 */
import { createServer, type Server } from "node:http"
import { once } from "node:events"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { ProbeRun as CollectedProbeRun } from "@terminfo/probe-defs"
import {
  findOwnedDaemon,
  readDaemonProbeResponse,
  requestDaemonProbe,
  saveDaemonProbeRun,
  stopOwnedDaemon,
} from "./daemon-client.ts"

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

it("refuses the old boolean daemon payload instead of upgrading it to v2 observations", async () => {
  const legacy = new Response(
    JSON.stringify({
      terminal: "kitty",
      terminalVersion: "0.49.1",
      os: "macos",
      osVersion: "25.4",
      results: { "device.primary-da": true },
    }),
  )
  await expect(readDaemonProbeResponse(legacy)).rejects.toThrow(/v2|schema|boolean/i)
})
