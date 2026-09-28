/**
 * Thin probe server — TTY I/O only, no bundled probe logic.
 *
 * Usage: npx terminfo.dev serve
 *
 * Starts an HTTP server that accepts probe requests. Run this in each
 * terminal you want to test, then use `terminfo.dev test-all` or
 * curl to run probes remotely.
 *
 * Probes are loaded dynamically on each request — the server never needs
 * restarting when probe definitions change on disk.
 *
 * Discovery: writes terminal info + port to ~/.terminfo-dev/daemons/
 * so clients can find all running daemons automatically.
 */

import { createStyle } from "@silvery/ansi"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { mkdirSync, writeFileSync, unlinkSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { detectTerminal } from "./detect.ts"
import { withRawMode, drainStdin } from "./tty.ts"

const s = createStyle()

const DAEMON_DIR = join(homedir(), ".terminfo-dev", "daemons")

/** Resolve the absolute path to the probes module (once, at startup). */
const PROBES_PATH = require.resolve("./probes/unified.ts")

/**
 * Dynamically load probes, busting the module cache so that changes
 * on disk are picked up without restarting the server.
 */
async function loadProbes() {
  delete require.cache[PROBES_PATH]
  const mod = await import("./probes/unified.ts")
  return mod.ALL_PROBES as import("./probes/unified.ts").Probe[]
}

interface DaemonInfo {
  pid: number
  port: number
  terminal: string
  terminalVersion: string
  os: string
  osVersion: string
  started: string
  token: string
}

function register(info: DaemonInfo): string {
  mkdirSync(DAEMON_DIR, { recursive: true, mode: 0o700 })
  const filename = `${info.terminal}-${info.pid}.json`
  const filepath = join(DAEMON_DIR, filename)
  writeFileSync(filepath, JSON.stringify(info, null, 2), { flag: "wx", mode: 0o600 })
  return filepath
}

function unregister(filepath: string) {
  try {
    unlinkSync(filepath)
  } catch {}
}

export function listDaemons(): DaemonInfo[] {
  try {
    const files = readdirSync(DAEMON_DIR).filter((f) => f.endsWith(".json"))
    const daemons: DaemonInfo[] = []
    for (const f of files) {
      try {
        const data = JSON.parse(readFileSync(join(DAEMON_DIR, f), "utf-8")) as DaemonInfo
        daemons.push(data)
      } catch {}
    }
    return daemons
  } catch {
    return []
  }
}

export async function startDaemon(port = 0): Promise<void> {
  const terminal = detectTerminal()
  const token = randomBytes(32).toString("hex")

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      res.setHeader("Content-Type", "application/json")

      const url = new URL(req.url ?? "/", `http://localhost`)
      const mutatesTTY = url.pathname === "/probe" || url.pathname === "/probe/single" || url.pathname === "/query"
      if (mutatesTTY) {
        const supplied = req.headers.authorization?.replace(/^Bearer /, "") ?? ""
        const expected = Buffer.from(token)
        const actual = Buffer.from(supplied)
        const authorized = actual.length === expected.length && timingSafeEqual(actual, expected)
        const origin = req.headers.origin
        const sameOrigin = !origin || origin === `http://${req.headers.host}`
        if (!authorized || !sameOrigin) {
          res.statusCode = 403
          res.end(JSON.stringify({ error: "TTY mutation requires this daemon's token and same origin" }))
          return
        }
      }

      if (url.pathname === "/info") {
        res.end(
          JSON.stringify({
            terminal: terminal.name,
            terminalVersion: terminal.version,
            os: terminal.os,
            osVersion: terminal.osVersion,
            probes: "dynamic",
          }),
        )
        return
      }

      if (url.pathname === "/probe") {
        const probes = await loadProbes()
        console.log(s.dim(`[${new Date().toISOString()}] Running ${probes.length} probes...`))

        const results: Record<string, boolean> = {}
        const notes: Record<string, string> = {}
        const responses: Record<string, string> = {}

        await withRawMode(async () => {
          for (const probe of probes) {
            process.stdout.write("\x1b[0m\x1b[2J\x1b[H")
            try {
              const result = await probe.run()
              results[probe.id] = result.pass
              if (result.note) notes[probe.id] = result.note
              if (result.response) responses[probe.id] = result.response
            } catch (err) {
              results[probe.id] = false
              notes[probe.id] = `error: ${err instanceof Error ? err.message : String(err)}`
            }
          }
          process.stdout.write("\x1b[0m\x1b[2J\x1b[H")
          await drainStdin(1000)
        })

        const passed = Object.values(results).filter((v) => v).length
        const total = Object.keys(results).length
        console.log(`${s.green("+")} ${passed}/${total} (${Math.round((passed / total) * 100)}%)`)

        res.end(
          JSON.stringify({
            terminal: terminal.name,
            terminalVersion: terminal.version,
            os: terminal.os,
            osVersion: terminal.osVersion,
            source: "daemon",
            generated: new Date().toISOString(),
            results,
            notes,
            responses,
          }),
        )
        return
      }

      if (url.pathname === "/probe/single") {
        const probeId = url.searchParams.get("id")
        if (!probeId) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: "Missing ?id= parameter" }))
          return
        }
        const probes = await loadProbes()
        const probe = probes.find((p) => p.id === probeId)
        if (!probe) {
          res.statusCode = 404
          res.end(JSON.stringify({ error: `Unknown probe: ${probeId}` }))
          return
        }

        await withRawMode(async () => {
          process.stdout.write("\x1b[0m\x1b[2J\x1b[H")
          try {
            const result = await probe.run()
            process.stdout.write("\x1b[0m\x1b[2J\x1b[H")
            await drainStdin(500)
            res.end(JSON.stringify({ id: probeId, ...result }))
          } catch (err) {
            process.stdout.write("\x1b[0m\x1b[2J\x1b[H")
            await drainStdin(500)
            res.end(JSON.stringify({ id: probeId, pass: false, note: String(err) }))
          }
        })
        return
      }

      if (url.pathname === "/query" && req.method === "POST") {
        // Execute raw escape sequence commands in this terminal
        // POST body: { commands: [{ write: "\\x1b[6n", read: "\\x1b\\[(\\d+);(\\d+)R", timeout?: 1000 }, ...] }
        try {
          const body = await readBody(req)
          const { commands } = JSON.parse(body) as {
            commands: Array<{ write?: string; read?: string; timeout?: number; measure?: string }>
          }
          if (!Array.isArray(commands)) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: "commands must be an array" }))
            return
          }
          if (
            commands.length > 64 ||
            commands.some(
              (cmd) =>
                typeof cmd !== "object" ||
                cmd === null ||
                (cmd.write !== undefined && (typeof cmd.write !== "string" || cmd.write.length > 16384)) ||
                (cmd.measure !== undefined && (typeof cmd.measure !== "string" || cmd.measure.length > 16384)) ||
                (cmd.read !== undefined && (typeof cmd.read !== "string" || cmd.read.length > 512)) ||
                (cmd.timeout !== undefined &&
                  (!Number.isInteger(cmd.timeout) || cmd.timeout < 1 || cmd.timeout > 5000)),
            )
          ) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: "commands exceed count, size, or timeout limits" }))
            return
          }

          const results: Array<{ response?: string | null; width?: number | null; error?: string }> = []

          await withRawMode(async () => {
            process.stdout.write("\x1b[0m\x1b[2J\x1b[H")
            for (const cmd of commands) {
              try {
                if (cmd.measure) {
                  // Measure rendered width of a string
                  const { measureRenderedWidth } = await import("./tty.ts")
                  const width = await measureRenderedWidth(cmd.measure)
                  results.push({ width })
                } else if (cmd.write && cmd.read) {
                  // Write sequence, read response
                  const { query } = await import("./tty.ts")
                  const match = await query(unescapeSequence(cmd.write), new RegExp(cmd.read), cmd.timeout ?? 1000)
                  results.push({ response: match ? match[0] : null })
                } else if (cmd.write) {
                  // Just write, no response expected
                  process.stdout.write(unescapeSequence(cmd.write))
                  results.push({ response: "ok" })
                } else {
                  results.push({ error: "command needs write, read, or measure" })
                }
              } catch (err) {
                results.push({ error: err instanceof Error ? err.message : String(err) })
              }
            }
            process.stdout.write("\x1b[0m\x1b[2J\x1b[H")
            await drainStdin(500)
          })
          console.log(s.dim(`[${new Date().toISOString()}] Executed ${commands.length} commands`))
          res.end(JSON.stringify({ terminal: terminal.name, results }))
        } catch (err) {
          res.statusCode = err instanceof RangeError ? 413 : 400
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
        }
        return
      }

      // Default: show help
      res.end(
        JSON.stringify({
          endpoints: {
            "/info": "Terminal info",
            "/probe": "Run all probes (dynamically loaded)",
            "/probe/single?id=sgr.bold": "Run single probe",
            "/query": "POST — execute raw escape sequence commands",
          },
          terminal: terminal.name,
          version: terminal.version,
        }),
      )
    })().catch((err) => {
      console.error("Probe daemon request failed:", err)
      if (res.headersSent) res.destroy(err instanceof Error ? err : new Error(String(err)))
      else {
        res.statusCode = 500
        res.end(JSON.stringify({ error: "Probe daemon request failed" }))
      }
    })
  })

  server.listen(port, "127.0.0.1", () => {
    const addr = server.address()
    if (!addr || typeof addr === "string") return
    const actualPort = addr.port

    const info: DaemonInfo = {
      pid: process.pid,
      port: actualPort,
      terminal: terminal.name,
      terminalVersion: terminal.version,
      os: terminal.os,
      osVersion: terminal.osVersion,
      started: new Date().toISOString(),
      token,
    }

    const filepath = register(info)

    console.log(s.yellow(`! Probe daemon listening on localhost:${actualPort}; stop with Ctrl+C when done.\n`))
    console.log(`${s.bold("terminfo.dev")} daemon running\n`)
    console.log(`  Terminal:  ${s.bold(terminal.name)} ${terminal.version}`)
    console.log(`  Port:      ${s.bold(String(actualPort))}`)
    console.log(`  Probes:    dynamic (loaded on each request)`)
    console.log(``)
    console.log(`  Test:   use the registered daemon token to authorize /probe`)
    console.log(`  Info:   curl http://localhost:${actualPort}/info`)
    console.log(`  Single: /probe/single?id=sgr.bold (token required)`)

    // Clean up on exit
    const cleanup = () => {
      unregister(filepath)
      server.close()
      process.exit(0)
    }
    process.on("SIGINT", cleanup)
    process.on("SIGTERM", cleanup)
  })
}

/** Read full request body */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > 65536) {
        reject(new RangeError("Query body exceeds 64 KiB"))
      } else chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString()))
    req.on("error", reject)
  })
}

/** Convert \\x1b notation to actual escape characters */
function unescapeSequence(s: string): string {
  return s
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\e/g, "\x1b")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
}
