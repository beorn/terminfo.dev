/**
 * Server probe mechanism — daemon mode for real terminal probing.
 *
 * --start: run a daemon in the current terminal (accepts HTTP probe requests)
 * --all:   probe all running daemons
 * <name>:  probe a specific daemon
 * bare:    list running daemons
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..", "..", "..")

export async function handleServer(
  daemon: string | undefined,
  opts: { start?: boolean; port?: number; all?: boolean },
): Promise<void> {
  if (opts.start) {
    // Start daemon in this terminal
    const { startDaemon } = await import("../terminfo.dev/src/serve.ts")
    await startDaemon(opts.port ?? 0)
    return
  }

  // Import daemon listing
  const { listDaemons } = await import("../terminfo.dev/src/serve.ts")
  const daemons = listDaemons()

  if (!opts.all && !daemon) {
    // Bare: list running daemons
    if (daemons.length === 0) {
      console.log(`\nNo daemons running.\n`)
      console.log(`Start one: \x1b[1mterminfo probe server --start\x1b[0m`)
      return
    }

    console.log(`\n\x1b[1m${daemons.length} daemon(s) running:\x1b[0m\n`)
    for (const d of daemons) {
      const label = `${d.terminal}${d.terminalVersion ? ` ${d.terminalVersion}` : ""}`
      console.log(`  ${label.padEnd(25)} port ${d.port}  (pid ${d.pid})`)
    }
    console.log(`\nProbe all: \x1b[1mterminfo probe server --all\x1b[0m`)
    return
  }

  // Filter daemons if a specific name was given
  let targets = daemons
  if (daemon) {
    targets = daemons.filter(
      (d) =>
        d.terminal.toLowerCase() === daemon.toLowerCase() || d.terminal.toLowerCase().includes(daemon.toLowerCase()),
    )
    if (targets.length === 0) {
      console.error(`No daemon found matching "${daemon}".`)
      if (daemons.length > 0) {
        console.error(`Running: ${daemons.map((d) => d.terminal).join(", ")}`)
      } else {
        console.error(`No daemons running. Start one: terminfo probe server --start`)
      }
      process.exit(1)
    }
  }

  if (targets.length === 0) {
    console.log(`\x1b[33mNo daemons found.\x1b[0m`)
    console.log(`Start a daemon in each terminal: \x1b[1mterminfo probe server --start\x1b[0m`)
    return
  }

  console.log(`\x1b[1mterminfo.dev\x1b[0m — testing ${targets.length} terminal(s)\n`)

  for (const d of targets) {
    const label = `${d.terminal}${d.terminalVersion ? ` ${d.terminalVersion}` : ""}`
    process.stdout.write(`  ${label.padEnd(25)} `)

    try {
      const res = await fetch(`http://127.0.0.1:${d.port}/probe`, { signal: AbortSignal.timeout(120000) })
      if (!res.ok) {
        console.log(`\x1b[31m✗ HTTP ${res.status}\x1b[0m`)
        continue
      }
      const data = (await res.json()) as any
      const passed = Object.values(data.results).filter((v: any) => v).length
      const total = Object.keys(data.results).length
      const pct = Math.round((passed / total) * 100)
      const color = pct >= 98 ? "\x1b[32m" : pct >= 90 ? "\x1b[33m" : "\x1b[31m"
      console.log(`${color}${passed}/${total} (${pct}%)\x1b[0m`)

      // Save results
      const dir = join(ROOT, "content", "probes-apps")
      mkdirSync(dir, { recursive: true })
      const name = data.terminal.toLowerCase().replace(/[^a-z0-9-]/g, "-")
      const ver = (data.terminalVersion || "unknown").replace(/[^a-z0-9.-]/g, "-")
      writeFileSync(`${dir}/${name}-${ver}-${data.os}.json`, JSON.stringify(data, null, 2))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes("ECONNREFUSED")) {
        console.log(`\x1b[31m✗ not running (stale daemon file)\x1b[0m`)
      } else {
        console.log(`\x1b[31m✗ ${msg}\x1b[0m`)
      }
    }
  }

  console.log(`\nResults saved to content/probes-apps/`)
}
