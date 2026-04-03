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
}

function register(info: DaemonInfo): string {
  mkdirSync(DAEMON_DIR, { recursive: true })
  const filename = `${info.terminal}-${info.pid}.json`
  const filepath = join(DAEMON_DIR, filename)
  writeFileSync(filepath, JSON.stringify(info, null, 2))
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

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      res.setHeader("Content-Type", "application/json")
      res.setHeader("Access-Control-Allow-Origin", "*")

      const url = new URL(req.url ?? "/", `http://localhost`)

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

        // Reset terminal after probes
        process.stdout.write("\x1bc")

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
        process.stdout.write("\x1bc")
        return
      }

      if (url.pathname === "/query" && req.method === "POST") {
        // Execute raw escape sequence commands in this terminal
        // POST body: { commands: [{ write: "\\x1b[6n", read: "\\x1b\\[(\\d+);(\\d+)R", timeout?: 1000 }, ...] }
        const body = await readBody(req)
        try {
          const { commands } = JSON.parse(body) as {
            commands: Array<{ write?: string; read?: string; timeout?: number; measure?: string }>
          }
          if (!Array.isArray(commands)) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: "commands must be an array" }))
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
          process.stdout.write("\x1bc")

          console.log(s.dim(`[${new Date().toISOString()}] Executed ${commands.length} commands`))
          res.end(JSON.stringify({ terminal: terminal.name, results }))
        } catch (err) {
          res.statusCode = 400
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
    })()
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
    }

    const filepath = register(info)

    console.log(s.yellow(`! Security warning: this opens an HTTP server on localhost:${actualPort}`))
    console.log(s.yellow(`  Any local process can trigger terminal escape sequences via this server.`))
    console.log(s.yellow(`  Only run this on trusted machines. Stop with Ctrl+C when done.\n`))
    console.log(`${s.bold("terminfo.dev")} daemon running\n`)
    console.log(`  Terminal:  ${s.bold(terminal.name)} ${terminal.version}`)
    console.log(`  Port:      ${s.bold(String(actualPort))}`)
    console.log(`  Probes:    dynamic (loaded on each request)`)
    console.log(``)
    console.log(`  Test:   curl http://localhost:${actualPort}/probe`)
    console.log(`  Info:   curl http://localhost:${actualPort}/info`)
    console.log(`  Single: curl http://localhost:${actualPort}/probe/single?id=sgr.bold`)

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
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
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
