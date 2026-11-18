/**
 * @failure A long probe collection looks like a hung socket, so a stock client's own timers decide whether the run is alive.
 * @level l3
 * @consumer Real-terminal daemon HTTP clients (Node and Bun)
 * @testonly none
 * @reach fs-walk <fixture-only: /tmp/terminfo-probe-stream-*>
 */
import { execFileSync } from "node:child_process"
import { createServer, type Server } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { once } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { openProbeResponse } from "./probe-stream.ts"
import { stripProbeKeepalivePrefix } from "./daemon-client.ts"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function listening(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("test server has no port")
  return address.port
}

// Requirement (34753 condition 4): real headers and the first body byte leave before the collection
// finishes, and a newline follows on the declared interval while it keeps running.
it("34753 streams headers and a keepalive byte while a collection is still running", async () => {
  const arrivals: Array<{ at: number; chunk: string }> = []
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json")
    const stream = openProbeResponse(res, "run-under-test", 30)
    stream.admitted()
    await new Promise((resolve) => setTimeout(resolve, 150))
    res.end(JSON.stringify({ schemaVersion: 4, ok: true }))
    stream.release()
  })
  const port = await listening(server)
  cleanups.push(
    () => server.closeAllConnections(),
    () => {
      server.close()
    },
  )

  const started = Date.now()
  const response = await fetch(`http://127.0.0.1:${port}/probe`)
  const headersAt = Date.now() - started
  const reader = response.body!.getReader()
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value).toString("utf8")
    arrivals.push({ at: Date.now() - started, chunk })
    text += chunk
  }
  // Headers and one body byte arrive while the collection still has ~150 ms to run.
  expect(headersAt).toBeLessThan(120)
  expect(arrivals.length).toBeGreaterThan(2)
  expect(arrivals[0]!.chunk).toBe("\n")
  expect(arrivals.at(-1)!.at).toBeGreaterThanOrEqual(140)
  // Only leading JSON whitespace; the document itself is untouched.
  expect(text).toMatch(/^\n+\{"schemaVersion":4,"ok":true\}$/)
  expect(JSON.parse(text)).toEqual({ schemaVersion: 4, ok: true })
})

// Requirement (34753 condition 3): a client that leaves mid-collection aborts the run.
it("34753 aborts the collection when the client leaves mid-run", async () => {
  const observed: Array<{ aborted: boolean; writableEnded: boolean }> = []
  let released: () => void = () => {}
  const reached = new Promise<void>((resolve) => (released = resolve))
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json")
    const stream = openProbeResponse(res, "run-under-test", 20)
    stream.admitted()
    res.on("close", () => {
      observed.push({ aborted: stream.signal.aborted, writableEnded: res.writableEnded })
      released()
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    stream.release()
  })
  const port = await listening(server)
  cleanups.push(
    () => server.closeAllConnections(),
    () => {
      server.close()
    },
  )

  const controller = new AbortController()
  const leaving = fetch(`http://127.0.0.1:${port}/probe`, { signal: controller.signal })
    .then((response) => response.arrayBuffer())
    .then(
      () => "resolved",
      () => "aborted",
    )
  setTimeout(() => controller.abort(), 60)
  expect(await leaving).toBe("aborted")
  await reached
  expect(observed).toEqual([{ aborted: true, writableEnded: false }])
})

// Requirement (34753 condition 3, second half): a normal end never creates a cancellation.
it("34753 never aborts a response that completed normally", async () => {
  const observed: Array<{ aborted: boolean; writableEnded: boolean }> = []
  let seen: () => void = () => {}
  const closed = new Promise<void>((resolve) => (seen = resolve))
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json")
    const stream = openProbeResponse(res, "run-under-test", 20)
    stream.admitted()
    res.on("close", () => {
      observed.push({ aborted: stream.signal.aborted, writableEnded: res.writableEnded })
      seen()
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    res.end(JSON.stringify({ schemaVersion: 4, ok: true }))
    stream.release()
  })
  const port = await listening(server)
  cleanups.push(
    () => server.closeAllConnections(),
    () => {
      server.close()
    },
  )

  const response = await fetch(`http://127.0.0.1:${port}/probe`)
  expect(JSON.parse(await response.text())).toEqual({ schemaVersion: 4, ok: true })
  await closed
  expect(observed).toEqual([{ aborted: false, writableEnded: true }])
})

// Requirement (34753 condition 1): the duplicate reservation refuses before any header, because it is
// the draft's own `wx` creation that admits the request.
it("34753 refuses a duplicate run before anything streams", async () => {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-probe-stream-"))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const previous = process.env.TERMINFO_CAPTURE_DIRECTORY
  process.env.TERMINFO_CAPTURE_DIRECTORY = directory
  cleanups.push(() => {
    if (previous === undefined) delete process.env.TERMINFO_CAPTURE_DIRECTORY
    else process.env.TERMINFO_CAPTURE_DIRECTORY = previous
  })
  const { probeSuiteSnapshot } = await import("../../admin/versions.ts")
  const snapshot = probeSuiteSnapshot(join(import.meta.dirname, "../../.."))
  const restoreEnv = (key: string, value: string): void => {
    const before = process.env[key]
    process.env[key] = value
    cleanups.push(() => {
      if (before === undefined) delete process.env[key]
      else process.env[key] = before
    })
  }
  restoreEnv("TERMINFO_PROBE_HASH", snapshot.probeHash)
  restoreEnv(
    "TERMINFO_SOURCE_REVISION",
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: join(import.meta.dirname, "../../..") })
      .toString()
      .trim(),
  )
  const { collectProbeRun } = await import("./serve.ts")
  let admitted = 0
  await collectProbeRun({ ids: [], captureRunId: "duplicate-run", onAdmitted: () => (admitted += 1) })
  expect(admitted).toBe(1)
  admitted = 0
  await expect(
    collectProbeRun({ ids: [], captureRunId: "duplicate-run", onAdmitted: () => (admitted += 1) }),
  ).rejects.toMatchObject({ code: "EEXIST" })
  expect(admitted).toBe(0)
})

// Requirement (34753 condition 3): a client that leaves stops the batch itself. The signal is checked
// between rows, so a cancelled run never starts another probe after the response is gone, and the
// AbortError reaches the caller loudly instead of becoming a success-shaped draft.
it("34753 an aborted signal stops the batch before another probe runs", async () => {
  const { ALL_PROBES, runProbeBatch } = await import("./probes/unified.ts")
  const controller = new AbortController()
  controller.abort()
  const failure = await runProbeBatch({ ids: [ALL_PROBES[0]!.id], signal: controller.signal }).catch(
    (error: unknown) => error,
  )
  expect(failure).toMatchObject({ name: "AbortError" })
})

// Requirement (34753 condition 5): only the four JSON whitespace bytes are transport, and stripping
// them leaves a body whose digest matches the payload the daemon meant to send.
it("34753 strips only the leading JSON whitespace transport prefix", () => {
  const payload = Buffer.from('{"schemaVersion":4}')
  expect(stripProbeKeepalivePrefix(Buffer.concat([Buffer.from("\n\n\t\r "), payload]))).toEqual(payload)
  expect(stripProbeKeepalivePrefix(payload)).toEqual(payload)
  // A BOM, interior whitespace and trailing bytes are payload, never transport.
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), payload])
  expect(stripProbeKeepalivePrefix(bom)).toEqual(bom)
  const interior = Buffer.from('{"schemaVersion": 4}')
  expect(stripProbeKeepalivePrefix(interior)).toEqual(interior)
  expect(stripProbeKeepalivePrefix(Buffer.from("\n\n"))).toEqual(Buffer.alloc(0))
})
