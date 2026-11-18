import { once } from "node:events"
import { writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join } from "node:path"
const client = await import(new URL("../daemon-client.ts", import.meta.url).href)
const { NODE_PROBE_SOCKET_TIMEOUT_MS, nodeProbeFetch, requestDaemonProbe } = client

const runId = "d".repeat(32)
const serve = async (headersAfterMs, bodyAfterMs) => {
  const server = createServer((req, res) => {
    if (req.url === "/info") {
      res.end(JSON.stringify({ runId, pid: 222, terminal: "kitty", terminalVersion: "0.49.1" }))
      return
    }
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" })
      setTimeout(() => res.end(JSON.stringify({ ok: true })), bodyAfterMs)
    }, headersAfterMs)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return { server, port: server.address().port }
}
const out = { bunMemberPresent: typeof process.versions.bun === "string" }
const fast = await serve(100, 100)
const slow = await serve(1500, 0)
const init = { method: "GET", headers: {}, signal: AbortSignal.timeout(20_000) }
try {
  out.generousStatus = (
    await nodeProbeFetch(`http://127.0.0.1:${fast.port}/probe`, init, {
      headersTimeout: 5_000,
      bodyTimeout: 5_000,
    })
  ).status
  try {
    await nodeProbeFetch(`http://127.0.0.1:${slow.port}/probe`, init, { headersTimeout: 50, bodyTimeout: 50 })
    out.smallTimer = "resolved"
  } catch (error) {
    out.smallTimer = error.code ?? error.cause?.code ?? error.name
  }
  out.timersAboveSignal = NODE_PROBE_SOCKET_TIMEOUT_MS > 30 * 60_000
  const response = await requestDaemonProbe({
    runId,
    pid: 222,
    port: slow.port,
    token: "fixture-token",
    terminal: "kitty",
    terminalVersion: "0.49.1",
  })
  out.endToEndStatus = response.status
  out.endToEndBody = await response.json()
} finally {
  fast.server.closeAllConnections()
  slow.server.closeAllConnections()
  fast.server.close()
  slow.server.close()
}
writeFileSync(join(process.env.HOME, "node-probe.json"), JSON.stringify(out))
