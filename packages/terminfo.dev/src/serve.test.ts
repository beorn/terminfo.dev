/**
 * @failure An unrelated local process or web page can make the daemon emit terminal control bytes.
 * @level l3
 * @consumer Real-terminal daemon HTTP clients
 */
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

let child: ChildProcess | undefined
let home: string | undefined

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
  it("requires its private token and refuses cross-origin mutation", async () => {
    home = mkdtempSync(join(tmpdir(), "terminfo-serve-"))
    child = spawn(
      process.execPath,
      ["-e", `import { startDaemon } from "./packages/terminfo.dev/src/serve.ts"; await startDaemon()`],
      {
        cwd: join(import.meta.dirname, "../../.."),
        env: { ...process.env, HOME: home, TERM: "dumb", TERM_PROGRAM: "" },
        stdio: ["pipe", "ignore", "pipe"],
      },
    )
    let registration!: { port: number; token?: string }
    await vi.waitFor(
      () => {
        const files = readdirSync(join(home!, ".terminfo-dev/daemons"))
        expect(files).toHaveLength(1)
        registration = JSON.parse(readFileSync(join(home!, ".terminfo-dev/daemons", files[0]!), "utf8"))
      },
      { timeout: 2000 },
    )
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
})
