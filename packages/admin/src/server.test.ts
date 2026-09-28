/**
 * @failure Daemon clients omit authorization and report failed collection as success.
 * @level l2
 * @consumer private admin server command and the shared daemon request client
 * @testonly none
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createServer, type Server } from "node:http"
import { once } from "node:events"
import { handleServer } from "./server.ts"

const fixtures = vi.hoisted(() => ({
  daemons: [] as Array<{
    terminal: string
    terminalVersion: string
    port: number
    pid: number
    runId: string
    token?: string
  }>,
}))
vi.mock("terminfo.dev/src/serve.ts", () => ({ listDaemons: () => fixtures.daemons }))

let server: Server
let requests: Array<string | undefined>
beforeEach(async () => {
  requests = []
  server = createServer((req, res) => {
    requests.push(req.headers.authorization)
    if (req.url === "/info") {
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ runId: "fixture-run", pid: 123, terminal: "kitty", terminalVersion: "0.49.1" }))
      return
    }
    res.writeHead(req.headers.authorization === "Bearer fixture-token" ? 503 : 401)
    res.end("fixture collector unavailable")
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
