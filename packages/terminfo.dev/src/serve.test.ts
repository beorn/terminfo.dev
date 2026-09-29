/**
 * @failure An unrelated local process or web page can make the daemon emit terminal control bytes.
 * @level l3
 * @consumer Real-terminal daemon HTTP clients
 * @testonly none
 * @reach fs-walk /tmp/terminfo-serve-*
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

let child: ChildProcess | undefined
let home: string | undefined
const packageRoot = join(import.meta.dirname, "../../..")

async function startTestDaemon() {
  home = mkdtempSync(join(tmpdir(), "terminfo-serve-"))
  child = spawn(
    process.execPath,
    ["-e", `import { startDaemon } from "./packages/terminfo.dev/src/serve.ts"; await startDaemon()`],
    {
      cwd: packageRoot,
      env: { ...process.env, HOME: home, TERM: "dumb", TERM_PROGRAM: "" },
      stdio: ["pipe", "ignore", "pipe"],
    },
  )
  let filename!: string
  let registration!: { port: number; token?: string; runId: string; pid: number }
  await vi.waitFor(
    () => {
      const files = readdirSync(join(home!, ".terminfo-dev/daemons"))
      expect(files).toHaveLength(1)
      filename = join(home!, ".terminfo-dev/daemons", files[0]!)
      registration = JSON.parse(readFileSync(filename, "utf8")) as typeof registration
    },
    { timeout: 2000 },
  )
  return { filename, registration }
}

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill()
    await new Promise<void>((resolve) => child!.once("exit", () => resolve()))
  }
  if (home) rmSync(home, { recursive: true, force: true })
  child = undefined
  home = undefined
})

describe("daemon HTTP boundary", () => {
  // Carrier validation precedes source-suite loading. The old endpoint ignored
  // these bodies and tried to probe; authentication coverage did not detect that.
  it("refuses malformed or mismatched owner assertions before collection", async () => {
    const { registration } = await startTestDaemon()
    const url = `http://127.0.0.1:${registration.port}/probe`
    const owner = {
      asserter: "terminfo-admin",
      launchRunId: registration.runId,
      workerPid: registration.pid,
      windowId: 791,
      tabTty: "/dev/ttys004",
      intendedVersion: "2.15",
    }
    const headers = { Authorization: `Bearer ${registration.token}`, "Content-Type": "application/json" }
    const unauthenticated = await fetch(url, { method: "POST", body: JSON.stringify({ terminalAppOwner: owner }) })
    expect(unauthenticated.status).toBe(403)
    for (const body of [
      "{malformed",
      JSON.stringify({ terminalAppOwner: null }),
      JSON.stringify({ terminalAppOwner: { ...owner, launchRunId: "f".repeat(32) } }),
      JSON.stringify({ terminalAppOwner: { ...owner, workerPid: registration.pid + 1 } }),
      JSON.stringify({ terminalAppOwner: { ...owner, token: registration.token } }),
      JSON.stringify({ unexpectedOwner: owner }),
    ]) {
      const response = await fetch(url, { method: "POST", headers, body })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: "Invalid or mismatched Terminal.app owner assertion" })
    }
  })

  it("refuses v2 collection without a declared source suite", async () => {
    const { registration } = await startTestDaemon()
    const response = await fetch(`http://127.0.0.1:${registration.port}/probe`, {
      headers: { Authorization: `Bearer ${registration.token}` },
    })
    expect(response.status).toBe(500)
    const body: unknown = await response.json()
    expect(body).toEqual({ error: "Probe daemon request failed" })
  })

  it("requires its private token and refuses cross-origin mutation", async () => {
    const { registration } = await startTestDaemon()
    const url = `http://127.0.0.1:${registration.port}/query`
    const body = JSON.stringify({ commands: [{ write: "test" }] })
    const unauth = await fetch(url, { method: "POST", body })
    expect(unauth.status).toBe(403)
    expect(registration.token).toMatch(/^[0-9a-f]{64}$/)
    const headers = { Authorization: `Bearer ${registration.token}` }
    const crossOrigin = await fetch(url, {
      method: "POST",
      body,
      headers: { ...headers, Origin: "https://evil.example" },
    })
    expect(crossOrigin.status).toBe(403)
    const authorized = await fetch(url, { method: "POST", body, headers })
    expect(authorized.status).toBe(200)
  }, 5000)

  it("names a malformed registration instead of silently omitting it", () => {
    home = mkdtempSync(join(tmpdir(), "terminfo-serve-"))
    const dir = join(home, ".terminfo-dev/daemons")
    mkdirSync(dir, { recursive: true })
    const badFile = join(dir, "bad.json")
    writeFileSync(badFile, "{broken")
    const result = spawnSync(
      process.execPath,
      ["-e", `import { listDaemons } from "./packages/terminfo.dev/src/serve.ts"; listDaemons()`],
      {
        cwd: packageRoot,
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(badFile)
  })

  it("reports failure to remove its own registration on shutdown", async () => {
    const { filename } = await startTestDaemon()
    const stderr: Buffer[] = []
    child!.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk))
    rmSync(filename)
    mkdirSync(filename)
    child!.kill("SIGTERM")
    const exitCode = await new Promise<number | null>((resolve) => child!.once("exit", resolve))
    expect(exitCode).toBe(1)
    expect(Buffer.concat(stderr).toString()).toContain(filename)
  }, 5000)
})
