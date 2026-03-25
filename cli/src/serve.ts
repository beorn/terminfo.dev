/**
 * Daemon mode — run inside a terminal, accept remote probe commands.
 *
 * Usage: npx terminfo.dev serve
 *
 * Starts an HTTP server that accepts probe requests. Run this in each
 * terminal you want to test, then use `terminfo.dev test-all` or
 * curl to run probes remotely.
 *
 * Discovery: writes terminal info + port to ~/.terminfo-dev/daemons/
 * so clients can find all running daemons automatically.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { mkdirSync, writeFileSync, unlinkSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { detectTerminal } from "./detect.ts"
import { ALL_PROBES } from "./probes/index.ts"
import { withRawMode, drainStdin } from "./tty.ts"

const DAEMON_DIR = join(homedir(), ".terminfo-dev", "daemons")

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
        const data = JSON.parse(readFileSync(join(DAEMON_DIR, f), "utf-8"))
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

  // Run all probes once synchronously, then serve results
  // For live probing, we need the server to run probes on-demand in the terminal context
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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
          probeCount: ALL_PROBES.length,
        }),
      )
      return
    }

    if (url.pathname === "/probe") {
      // Run all probes in this terminal
      console.log(`\x1b[2m[${new Date().toISOString()}] Running ${ALL_PROBES.length} probes...\x1b[0m`)

      const results: Record<string, boolean> = {}
      const notes: Record<string, string> = {}
      const responses: Record<string, string> = {}

      await withRawMode(async () => {
        for (const probe of ALL_PROBES) {
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
      console.log(`\x1b[32m✓\x1b[0m ${passed}/${total} (${Math.round((passed / total) * 100)}%)`)

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
      const probe = ALL_PROBES.find((p) => p.id === probeId)
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

    // Default: show help
    res.end(
      JSON.stringify({
        endpoints: {
          "/info": "Terminal info",
          "/probe": "Run all probes",
          "/probe/single?id=sgr.bold": "Run single probe",
        },
        terminal: terminal.name,
        version: terminal.version,
      }),
    )
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

    console.log(`\x1b[33m⚠ Security warning: this opens an HTTP server on localhost:${actualPort}`)
    console.log(`  Any local process can trigger terminal escape sequences via this server.`)
    console.log(`  Only run this on trusted machines. Stop with Ctrl+C when done.\x1b[0m\n`)
    console.log(`\x1b[1mterminfo.dev\x1b[0m daemon running\n`)
    console.log(`  Terminal:  \x1b[1m${terminal.name}\x1b[0m ${terminal.version}`)
    console.log(`  Port:      \x1b[1m${actualPort}\x1b[0m`)
    console.log(`  Probes:    ${ALL_PROBES.length}`)
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
