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
    const { startDaemon } = await import("terminfo.dev/src/serve.ts")
    await startDaemon(opts.port ?? 0)
    return
  }

  // Import daemon listing
  const { listDaemons } = await import("terminfo.dev/src/serve.ts")
  const daemons = listDaemons()

  if (!opts.all && !daemon) {
    // Bare: list running daemons
    if (daemons.length === 0) {
      console.log("\nNo daemons running.\n")
      console.log("Start one: terminfo probe server --start")
      return
    }

    console.log(`\n${daemons.length} daemon(s) running:\n`)
    for (const d of daemons) {
      const label = `${d.terminal}${d.terminalVersion ? ` ${d.terminalVersion}` : ""}`
      console.log(`  ${label.padEnd(25)} port ${d.port}  (pid ${d.pid})`)
    }
    console.log("\nProbe all: terminfo probe server --all")
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
      const running =
        daemons.length > 0
          ? `Running: ${daemons.map((d) => d.terminal).join(", ")}`
          : "No daemons running. Start one: terminfo probe server --start"
      throw new Error(`No daemon found matching "${daemon}". ${running}`)
    }
  }

  if (targets.length === 0) {
    console.log("No daemons found.")
    console.log("Start a daemon in each terminal: terminfo probe server --start")
    return
  }

  console.log(`terminfo.dev — testing ${targets.length} terminal(s)\n`)

  for (const d of targets) {
    const label = `${d.terminal}${d.terminalVersion ? ` ${d.terminalVersion}` : ""}`

    try {
      const res = await fetch(`http://127.0.0.1:${d.port}/probe`, { signal: AbortSignal.timeout(120000) })
      if (!res.ok) {
        console.error(`  ${label.padEnd(25)} HTTP ${res.status}`)
        continue
      }
      const data = (await res.json()) as any
      const passed = Object.values(data.results).filter((v: any) => v).length
      const total = Object.keys(data.results).length
      const pct = Math.round((passed / total) * 100)
      console.log(`  ${label.padEnd(25)} ${passed}/${total} (${pct}%)`)

      // Save results
      const dir = join(ROOT, "content", "probes-apps")
      mkdirSync(dir, { recursive: true })
      const name = data.terminal.toLowerCase().replace(/[^a-z0-9-]/g, "-")
      const ver = (data.terminalVersion || "unknown").replace(/[^a-z0-9.-]/g, "-")
      writeFileSync(`${dir}/${name}-${ver}-${data.os}.json`, JSON.stringify(data, null, 2))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes("ECONNREFUSED")) {
        console.error(`  ${label.padEnd(25)} not running (stale daemon file)`)
      } else {
        console.error(`  ${label.padEnd(25)} ${msg}`)
      }
    }
  }

  console.log("\nResults saved to content/probes-apps/")
}
