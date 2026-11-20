// 34753: the public Node client against the daemon's real streaming owner, with stock undici timers and
// no dispatcher. A run whose collection outlasts the old silent-socket behaviour must still deliver
// headers early, a keepalive body chunk, and the final JSON document.
import { once } from "node:events"
import { writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join } from "node:path"
const { openProbeResponse } = await import(new URL("../probe-stream.ts", import.meta.url).href)
const { requestDaemonProbe } = await import(new URL("../daemon-client.ts", import.meta.url).href)

const runId = "d".repeat(32)
const collectMs = Number(process.env.PROBE_COLLECT_MS ?? 1500)
const keepaliveMs = Number(process.env.PROBE_KEEPALIVE_MS ?? 200)

const server = createServer(async (req, res) => {
  if (req.url === "/info") {
    res.end(JSON.stringify({ runId, pid: 222, terminal: "kitty", terminalVersion: "0.49.1" }))
    return
  }
  if (req.url !== "/probe") {
    res.statusCode = 404
    res.end()
    return
  }
  res.setHeader("Content-Type", "application/json")
  const stream = openProbeResponse(res, runId, keepaliveMs)
  try {
    // The daemon flushes headers and the first body byte once the run is admitted.
    stream.admitted()
    await new Promise((resolve) => setTimeout(resolve, collectMs))
    res.end(JSON.stringify({ schemaVersion: 4, ok: true }))
  } finally {
    stream.release()
  }
})
server.listen(0, "127.0.0.1")
await once(server, "listening")

const registration = {
  runId,
  pid: 222,
  port: server.address().port,
  token: "fixture-token",
  terminal: "kitty",
  terminalVersion: "0.49.1",
}
const out = { bunMemberPresent: typeof process.versions.bun === "string" }
try {
  const started = Date.now()
  const response = await requestDaemonProbe(registration)
  out.firstByteMs = Date.now() - started
  out.status = response.status
  const bytes = Buffer.from(await response.arrayBuffer())
  out.settleMs = Date.now() - started
  out.leadingWhitespace = bytes.toString("utf8").match(/^[\s]*/)[0].length
  out.body = JSON.parse(bytes.toString("utf8").trim())
  // A short signal must still interrupt the body AFTER headers arrived, so streaming never hides a
  // caller's own abort.
  const controller = new AbortController()
  const abortTimer = setTimeout(() => controller.abort(), 200)
  try {
    const streamed = await fetch(`http://127.0.0.1:${registration.port}/probe`, { signal: controller.signal })
    await streamed.arrayBuffer()
    out.shortSignal = "resolved"
  } catch (error) {
    out.shortSignal = error.name
  } finally {
    clearTimeout(abortTimer)
  }
} finally {
  server.closeAllConnections()
  server.close()
}
writeFileSync(join(process.env.HOME, "node-probe.json"), JSON.stringify(out))
