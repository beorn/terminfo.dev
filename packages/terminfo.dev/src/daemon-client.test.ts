/**
 * @failure A probe run can attach to or stop another daemon that registered nearby in time.
 * @level l3
 * @consumer App and mux real-terminal collectors
 * @testonly none
 * @reach fs-walk <fixture-only: /tmp/terminfo-owned-*>
 */
import { createServer, type Server } from "node:http"
import { spawn } from "node:child_process"
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
import { parseRun } from "@terminfo/run-parser"
import type { CapturedRunDraft as CollectedProbeRun, ProbeSuiteManifest } from "@terminfo/probe-defs"
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
    schemaVersion: 4 as const,
    probeHash: "abcdef123456",
    sourceRevision: "b".repeat(40),
    generatedAt: "2026-09-28T00:00:00.000Z",
    adapterVersion: "3.3.1",
    catalogIds: ["device.primary-da"],
    probes: { term: ["device.primary-da"], lib: ["device.primary-da"], mux: ["device.primary-da"] },
  } satisfies ProbeSuiteManifest,
  collectorRevision: "a".repeat(40),
}

function collectorRun(): CollectedProbeRun {
  return {
    source: { kind: "live" },
    schemaVersion: 4,
    intendedSubject: { kind: "term", id: "kitty", version: "0.49.1" },
    runId: "1234567890abcdef1234567890abcdef",
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
    suiteId: trustedReceipt.manifest.probeHash,
    probeHash: trustedReceipt.manifest.probeHash,
    sourceRevision: trustedReceipt.collectorRevision,
    measuredAt: "2026-09-28T12:00:00.000Z",
    origin: { kind: "collector" },
    rawReplies: {},
    assertions: [],
    screenshotRefs: [],
    results: [
      {
        featureId: "device.primary-da",
        status: "test-todo",
        attempt: { scope: "none" },
        tests: [],
        reason: "Not implemented",
      },
    ],
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

it("keeps the Darwin editor IPC path short despite a long per-user temporary directory", () => {
  root = mkdtempSync(join(tmpdir(), "terminfo-owned-"))
  const longTemporaryDirectory = join(root, "darwin-per-user-cache-".repeat(3))
  mkdirSync(longTemporaryDirectory)
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!
  const previousTmpdir = process.env.TMPDIR
  let launch: ReturnType<typeof createProbeRun> | undefined
  try {
    Object.defineProperty(process, "platform", { value: "darwin" })
    process.env.TMPDIR = longTemporaryDirectory
    expect(tmpdir()).toBe(longTemporaryDirectory)
    launch = createProbeRun()
    // Cursor 3.25.9 derives this socket beneath user-data-dir; Darwin rejects long Unix socket paths.
    const socket = join(launch.directory, `cursor-${launch.id}`, "3.25-main.sock")
    expect(Buffer.byteLength(socket)).toBeLessThan(103)
    expect(launch.id).toMatch(/^[0-9a-f]{32}$/)
    // Ghostty's run file names the script unquoted, scoped to this run (#30518 D2).
    expect(launch.scriptPath).toBe(join(launch.directory, `serve-${launch.id}.sh`))
    expect(lstatSync(launch.directory).mode & 0o077).toBe(0)
  } finally {
    if (launch) removeProbeRun(launch)
    Object.defineProperty(process, "platform", platform)
    if (previousTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmpdir
  }
})

it("writes one immutable current capture and refuses a mismatched intended version", () => {
  root = mkdtempSync(join(tmpdir(), "terminfo-owned-"))
  const run: CollectedProbeRun = {
    source: { kind: "live" },
    schemaVersion: 4,
    intendedSubject: { kind: "term", id: "kitty", version: "0.49.1" },
    runId: "1234567890abcdef1234567890abcdef",
    subject: {
      kind: "term",
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
    sourceRevision: "a".repeat(40),
    measuredAt: "2026-09-28T00:00:00.000Z",
    origin: { kind: "collector" },
    rawReplies: { "device.primary-da": "\x1b[?62;4c" },
    assertions: [],
    screenshotRefs: [],
    results: collectorRun().results,
  }
  const dir = join(root, "runs")
  expect(() => saveDaemonProbeRun(run, dir, { kind: "term", id: "kitty", version: "0.48.0" })).toThrow(
    /Measured version/,
  )
  const path = saveDaemonProbeRun(run, dir, { kind: "term", id: "kitty", version: "0.49.1" })
  const saved = JSON.parse(readFileSync(path, "utf8")) as CollectedProbeRun
  expect(saved.rawReplies["device.primary-da"]).toBe("\x1b[?62;4c")
  expect(() => saveDaemonProbeRun(run, dir, { kind: "term", id: "kitty", version: "0.49.1" })).toThrow()
})

it("selects only the launched run and tests /info before returning its token", async () => {
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
  await requestDaemonProbe(registration, { terminalApp: owner })
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

// The HTTP status must survive a body-read failure; the network custody cases below cannot
// produce a Fetch stream error without aborting before the response headers arrive.
it("preserves the failed HTTP status when its original body cannot be read", async () => {
  const registration = {
    runId: "a".repeat(32),
    pid: 222,
    port: 12345,
    token: "fixture-token",
    terminal: "kitty",
    terminalVersion: "0.49.1",
  }
  const cause = new Error("fixture body interrupted")
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json(registration))
    .mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(cause)
          },
        }),
        { status: 502 },
      ),
    )
  const failure = await requestDaemonProbe(registration).catch((error: unknown) => error)
  expect(failure).toMatchObject({ status: 502, cause, message: expect.stringContaining("fixture body interrupted") })
  expect(failure).not.toHaveProperty("path")
  expect(failure).not.toHaveProperty("sha256")
})

// A failed response is evidence, not a ProbeRun: invalid UTF-8 must not discard its original bytes.
it.each([Buffer.from('{"error":"census failed"}\r\n'), Buffer.from([255, 0, 10])])(
  "retains failed daemon HTTP originals before rejecting collection (30412): %j",
  async (bytes) => {
    root = mkdtempSync(join(tmpdir(), "terminfo-owned-"))
    {
      const runId = "a".repeat(32)
      server = createServer((req, res) => {
        if (req.url === "/info") {
          res.end(JSON.stringify({ runId, pid: 222, terminal: "kitty", terminalVersion: "0.49.1" }))
        } else {
          res.statusCode = 500
          res.end(bytes)
        }
      })
      server.listen(0, "127.0.0.1")
      await once(server, "listening")
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("fixture did not bind")
      const requestFailure = async () => {
        const client = spawn(
          process.execPath,
          [
            "-e",
            String.raw`
          import {writeFileSync} from "node:fs"
          import {join} from "node:path"
          import {requestDaemonProbe} from "./packages/terminfo.dev/src/daemon-client.ts"
          try {await requestDaemonProbe({runId:"a".repeat(32),pid:222,port:Number(process.env.TERMINFO_TEST_PORT),
            token:"fixture-token",terminal:"kitty",terminalVersion:"0.49.1"})}
          catch(error){writeFileSync(join(process.env.HOME,"client-failure.json"),JSON.stringify({
            message:error.message,status:error.status,path:error.path,sha256:error.sha256}))}
        `,
          ],
          {
            cwd: join(import.meta.dirname, "../../.."),
            env: { ...process.env, HOME: root, USERPROFILE: root, TERMINFO_TEST_PORT: String(address.port) },
            stdio: ["ignore", "ignore", "pipe"],
          },
        )
        const stderr: Buffer[] = []
        client.stderr.on("data", (chunk) => stderr.push(chunk))
        const [code] = await once(client, "exit")
        expect(code, Buffer.concat(stderr).toString()).toBe(0)
        return JSON.parse(readFileSync(join(root!, "client-failure.json"), "utf8"))
      }
      const failure = await requestFailure()
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      const directory = join(root, ".terminfo-dev", "http-responses")
      const path = join(directory, sha256)
      expect(failure).toMatchObject({ status: 500, path, sha256 })
      expect(readFileSync(path)).toEqual(bytes)
      expect(lstatSync(directory).mode & 0o077).toBe(0)
      expect(lstatSync(path).mode & 0o077).toBe(0)
      // A failed custody write must not erase the HTTP status or claim that a receipt was written.
      chmodSync(directory, 0o755)
      const retentionFailure = await requestFailure()
      expect(retentionFailure).toMatchObject({
        status: 500,
        message: expect.stringContaining("cannot retain original response"),
      })
      expect(retentionFailure).not.toHaveProperty("path")
      expect(retentionFailure).not.toHaveProperty("sha256")
    }
  },
)

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
    saveDaemonProbeRun(retained.run, join(privateRoot, "runs"), { kind: "term", id: "kitty", version: "0.48.0" }),
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

it("sends the process owner as processOwner, refused when it names another daemon run or pid", async () => {
  const owner = {
    asserter: "terminfo-admin" as const,
    launchRunId: "c".repeat(32),
    workerPid: 222,
    provider: "kitty" as const,
    ownerPid: 900,
    executablePath: "/Applications/kitty.app/Contents/MacOS/kitty",
    marker: { flag: "--instance-group", value: `terminfo-${"c".repeat(32)}` },
    tty: "/dev/ttys004",
    intendedVersion: "0.44.0",
  }
  const seen: Array<{ path: string; method: string; body: string }> = []
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      seen.push({ path: req.url ?? "", method: req.method ?? "", body: Buffer.concat(chunks).toString() })
      res.end(JSON.stringify({ runId: owner.launchRunId, pid: 222, terminal: "kitty", terminalVersion: "0.44.0" }))
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
    terminal: "kitty",
    terminalVersion: "0.44.0",
  }
  try {
    await requestDaemonProbe(registration, { process: owner })
    expect(seen.map(({ path, method }) => ({ path, method }))).toEqual([
      { path: "/info", method: "GET" },
      { path: "/probe", method: "POST" },
    ])
    expect(JSON.parse(seen[1]!.body)).toEqual({ processOwner: owner })

    await expect(requestDaemonProbe({ ...registration, runId: "e".repeat(32) }, { process: owner })).rejects.toThrow(
      /kitty owner assertion differs from the selected daemon/,
    )
    await expect(requestDaemonProbe({ ...registration, pid: 223 }, { process: owner })).rejects.toThrow(
      /kitty owner assertion differs from the selected daemon/,
    )
  } finally {
    server.close()
  }
})

// Existing immutable-write tests never resumed a genuinely pending capture with typed review bytes.
it("resumes a retained pending capture through the final writer without changing the original draft", () => {
  root = mkdtempSync(join(tmpdir(), "terminfo-owned-"))
  const run = collectorRun()
  run.results[0]!.tests = [
    { id: "review", status: "test-todo", attempt: { scope: "none" }, reason: "Required context review pending" },
  ]
  const path = saveDaemonProbeRun(run, root)
  expect(path).toMatch(/draft.json$/)
  const original = readFileSync(path, "utf8")
  const pending = JSON.parse(original) as CollectedProbeRun
  const capture = pending.rawReplies["collector.capture.device.primary-da"]!
  const review = JSON.stringify({
    id: "context-review",
    runId: run.runId,
    featureId: "device.primary-da",
    captureSha256: createHash("sha256").update(capture).digest("hex"),
    decision: "untestable",
    reviewed: true,
    reviewer: "reviewer",
    reason: "This stream-only context cannot receive device-status replies",
    scope: {
      subject: { kind: "term", id: "kitty" },
      versions: ["0.49.1", "0.49.1"],
      suites: [run.probeHash, run.probeHash],
    },
    sources: ["collector.capture.device.primary-da"],
    supersedes: [],
  })
  const final = saveDaemonProbeRun(pending, root, undefined, {
    manifest: trustedReceipt.manifest,
    decisions: [{ source: review, startedAt: "2026-10-21T05:00:00.000Z" }],
    origin: () => undefined,
  })
  expect(final).not.toMatch(/draft.json$/)
  expect(readFileSync(path, "utf8")).toBe(original)
  const parsed = parseRun(
    final,
    readFileSync(final, "utf8"),
    ["device.primary-da"],
    new Map([[run.probeHash, trustedReceipt.manifest]]),
  )
  expect(parsed.runId).toBe(run.runId)
  expect(parsed.results?.[0]?.status).toBe("untestable")
  expect(parsed.rawReplies["collector.review.context-review"]).toBe(review)
})

// A single-review fixture always reached a sealed filename and missed the pending filename collision.
it("retains partial reviews as immutable snapshots, then seals the same logical run", () => {
  root = mkdtempSync(join(tmpdir(), "terminfo-owned-"))
  const run = collectorRun()
  run.results = ["device.primary-da", "device.secondary-da"].map((featureId) => ({
    featureId,
    status: "test-todo",
    attempt: { scope: "none" },
    tests: [
      { id: "review", status: "test-todo", attempt: { scope: "none" }, reason: "Required context review pending" },
    ],
    reason: "Required context review pending",
  }))
  const originalPath = saveDaemonProbeRun(run, root)
  const original = readFileSync(originalPath, "utf8")
  const pending = JSON.parse(original) as CollectedProbeRun
  const decision = (featureId: string, id: string) =>
    JSON.stringify({
      id,
      runId: run.runId,
      featureId,
      captureSha256: createHash("sha256")
        .update(pending.rawReplies["collector.capture." + featureId]!)
        .digest("hex"),
      decision: "untestable",
      reviewed: true,
      reviewer: "reviewer",
      reason: "This stream-only context cannot receive the criterion's device replies",
      scope: {
        subject: { kind: "term", id: "kitty" },
        versions: ["0.49.1", "0.49.1"],
        suites: [run.probeHash, run.probeHash],
      },
      sources: ["collector.capture." + featureId],
      supersedes: [],
    })
  const manifest = {
    ...trustedReceipt.manifest,
    catalogIds: ["device.primary-da", "device.secondary-da"],
    probes: { ...trustedReceipt.manifest.probes, term: ["device.primary-da", "device.secondary-da"] },
  }
  const partialPath = saveDaemonProbeRun(pending, root, undefined, {
    manifest,
    decisions: [{ source: decision("device.primary-da", "first-review"), startedAt: "2026-10-21T05:00:00.000Z" }],
    origin: () => undefined,
  })
  expect(partialPath).not.toBe(originalPath)
  expect(partialPath).toMatch(/\.[a-f0-9]{64}\.draft.json$/)
  const partial = readFileSync(partialPath, "utf8")
  const finalPath = saveDaemonProbeRun(JSON.parse(partial) as CollectedProbeRun, root, undefined, {
    manifest,
    decisions: [{ source: decision("device.secondary-da", "second-review"), startedAt: "2026-10-21T05:01:00.000Z" }],
    origin: () => undefined,
  })
  const parsed = parseRun(
    finalPath,
    readFileSync(finalPath, "utf8"),
    manifest.catalogIds,
    new Map([[manifest.probeHash, manifest]]),
  )
  expect(parsed.runId).toBe(run.runId)
  expect(parsed.results?.map((result) => result.status)).toEqual(["untestable", "untestable"])
  expect(readFileSync(originalPath, "utf8")).toBe(original)
  expect(readFileSync(partialPath, "utf8")).toBe(partial)
})

// B4/B5 and Amendment3: the old writer sealed an undecided FAILURE and never retained its binding.
// Existing TODO-review journeys do not expose that error or cross-cohort origin-file validation.
it("retains a failed source review, then reuses its sealed origin through a caller-trusted review batch", () => {
  root = mkdtempSync(join(tmpdir(), "terminfo-owned-"))
  const directory = root
  const manifest: ProbeSuiteManifest = {
    ...trustedReceipt.manifest,
    catalogIds: ["sgr.faint"],
    probes: { term: ["sgr.faint"], lib: ["sgr.faint"], mux: [] },
  }
  const raw = JSON.stringify({ original: { faint: false }, changed: { faint: false }, restored: { faint: false } })
  const make = (runId: string): CollectedProbeRun => ({
    ...collectorRun(),
    runId,
    rawReplies: { "sgr.faint": raw, "collector.collectionAttempt": JSON.stringify({ runId }) },
    assertions: [
      {
        featureId: "sgr.faint",
        kind: "positive",
        assertionType: "buffer_state",
        expected: "changed faint=true; restored faint=false",
        observed: raw,
        rawReplyRef: "sgr.faint",
      },
    ],
    results: [
      {
        featureId: "sgr.faint",
        status: "test-failure",
        criterionBranch: "source-negative-review",
        assertionType: "buffer_state",
        rawReplyRef: "sgr.faint",
        attempt: { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" },
        tests: [
          {
            id: "capture",
            status: "supported",
            attempt: { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" },
            assertionRefs: [0],
          },
          {
            id: "review",
            status: "test-failure",
            attempt: { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" },
            reason: "Source review required",
          },
        ],
      },
    ],
  })
  const originRun = make("source-origin")
  const pendingPath = saveDaemonProbeRun(originRun, directory)
  expect(pendingPath).toMatch(/\.draft\.json$/)
  const pendingBytes = readFileSync(pendingPath, "utf8")
  const pending = JSON.parse(pendingBytes) as CollectedProbeRun
  const decision = {
    id: "faint-source",
    runId: originRun.runId,
    featureId: "sgr.faint",
    captureSha256: createHash("sha256").update(pending.rawReplies["collector.capture.sgr.faint"]!).digest("hex"),
    decision: "unsupported",
    reviewed: true,
    reviewer: "fixture reviewer",
    reason: "Fixture source and captured state establish the negative",
    scope: {
      subject: { kind: "term", id: "kitty" },
      versions: ["0.49.1", "0.49.1"],
      suites: [manifest.probeHash, manifest.probeHash],
    },
    sources: ["fixture@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:state.ts:1-4"],
    supersedes: [],
  }
  const source = JSON.stringify(decision)
  const decisions = [{ source, startedAt: "2026-10-21T05:01:00.000Z" }]
  const originPath = saveDaemonProbeRun(pending, directory, undefined, { manifest, decisions, origin: () => undefined })
  const originBytes = readFileSync(originPath, "utf8")
  const origin = vi.fn((runId: string) => ({
    path: join(directory, `kitty-0.49.1-linux-${runId}.json`),
    source: originBytes,
  }))
  const reusedPath = saveDaemonProbeRun(make("source-current"), directory, undefined, { manifest, decisions, origin })
  const parsed = parseRun(
    reusedPath,
    readFileSync(reusedPath, "utf8"),
    manifest.catalogIds!,
    new Map([[manifest.probeHash, manifest]]),
  )
  expect(origin).toHaveBeenCalledWith("source-origin")
  expect(parsed.runId).toBe("source-current")
  expect(parsed.results?.[0]?.status).toBe("unsupported")
  expect(parsed.rawReplies["collector.review.faint-source"]).toBe(source)
  expect(parsed.rawReplies["collector.review.faint-source.capture"]).toBe(
    pending.rawReplies["collector.capture.sgr.faint"],
  )
  expect(readFileSync(pendingPath, "utf8")).toBe(pendingBytes)
  expect(readFileSync(originPath, "utf8")).toBe(originBytes)
})

// Amendment2/3: unavailable origins lapse without fabricating evidence; foreign suites never trigger origin I/O.
// The successful origin journey above cannot prove these writer-side short-circuit boundaries.
it("records an unavailable origin lapse and skips origin lookup for a foreign-suite decision", () => {
  root = mkdtempSync(join(tmpdir(), "terminfo-origin-boundary-"))
  const manifest: ProbeSuiteManifest = {
    ...trustedReceipt.manifest,
    catalogIds: ["sgr.faint"],
    probes: { term: ["sgr.faint"], lib: ["sgr.faint"], mux: [] },
  }
  const raw = JSON.stringify({ original: { faint: false }, changed: { faint: false }, restored: { faint: false } })
  const make = (runId: string, observation = raw): CollectedProbeRun => ({
    ...collectorRun(),
    runId,
    rawReplies: { "sgr.faint": observation, "collector.collectionAttempt": JSON.stringify({ runId }) },
    assertions: [
      {
        featureId: "sgr.faint",
        kind: "positive",
        assertionType: "buffer_state",
        expected: "changed faint=true; restored faint=false",
        observed: observation,
        rawReplyRef: "sgr.faint",
      },
    ],
    results: [
      {
        featureId: "sgr.faint",
        status: "test-failure",
        criterionBranch: "source-negative-review",
        assertionType: "buffer_state",
        rawReplyRef: "sgr.faint",
        attempt: { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" },
        tests: [
          {
            id: "capture",
            status: "supported",
            attempt: { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" },
            assertionRefs: [0],
          },
          {
            id: "review",
            status: "test-failure",
            attempt: { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" },
            reason: "Source review required",
          },
        ],
      },
    ],
  })
  const sourceRun = make("source-origin")
  const sourceDraft = saveDaemonProbeRun(sourceRun, root)
  const draft = JSON.parse(readFileSync(sourceDraft, "utf8")) as CollectedProbeRun
  const decision = {
    id: "faint-boundary",
    runId: sourceRun.runId,
    featureId: "sgr.faint",
    captureSha256: createHash("sha256").update(draft.rawReplies["collector.capture.sgr.faint"]!).digest("hex"),
    decision: "unsupported",
    reviewed: true,
    reviewer: "fixture reviewer",
    reason: "Fixture source and retained state establish the negative",
    scope: {
      subject: { kind: "term" as const, id: "kitty" },
      versions: ["0.49.1", "0.49.1"],
      suites: [manifest.probeHash, manifest.probeHash],
    },
    sources: ["fixture@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:state.ts:1-4"],
    supersedes: [],
  }
  const origin = vi.fn(() => undefined)
  const unavailable = make(
    "cohort-origin-gone",
    JSON.stringify({ original: { faint: true }, changed: { faint: true }, restored: { faint: true } }),
  )
  const unavailablePath = saveDaemonProbeRun(unavailable, root, undefined, {
    manifest,
    decisions: [{ source: JSON.stringify(decision), startedAt: "2026-10-21T05:01:00.000Z" }],
    origin,
  })
  const unavailableRun = JSON.parse(readFileSync(unavailablePath, "utf8")) as CollectedProbeRun
  expect(origin).toHaveBeenCalledWith("source-origin")
  expect(unavailableRun.results[0]?.status).toBe("test-failure")
  expect(unavailableRun.results[0]?.reason).toContain("origin binding text unavailable: run source-origin")

  const foreignOrigin = vi.fn(() => {
    throw new Error("foreign suite must not read an origin")
  })
  const foreign = { ...decision, scope: { ...decision.scope, suites: ["foreign-suite", "foreign-suite"] } }
  const foreignPath = saveDaemonProbeRun(make("cohort-foreign-suite"), root, undefined, {
    manifest,
    decisions: [{ source: JSON.stringify(foreign), startedAt: "2026-10-21T05:02:00.000Z" }],
    origin: foreignOrigin,
  })
  const foreignRun = JSON.parse(readFileSync(foreignPath, "utf8")) as CollectedProbeRun
  expect(foreignOrigin).not.toHaveBeenCalled()
  expect(foreignRun.results[0]?.status).toBe("test-failure")
  expect(foreignRun.results[0]?.reason).toContain("suite differ")
})
