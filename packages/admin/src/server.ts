/**
 * Server probe mechanism — daemon mode for real terminal probing.
 *
 * --start: run a daemon in the current terminal (accepts HTTP probe requests)
 * --all:   probe all running daemons
 * <name>:  probe a specific daemon
 * bare:    list running daemons
 */

import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  readRetainedDaemonProbeResponse,
  requestDaemonProbe,
  saveDaemonProbeRun,
} from "terminfo.dev/src/daemon-client.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..", "..", "..")

export async function handleServer(
  daemon: string | undefined,
  opts: { start?: boolean; port?: number; all?: boolean },
): Promise<void> {
  if (opts.start) {
    // Start daemon in this terminal
    const { startDaemon } = await import("terminfo.dev/src/serve.ts")
    startDaemon(opts.port ?? 0)
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
  const failures: string[] = []
  let saved = 0

  for (const d of targets) {
    const label = `${d.terminal}${d.terminalVersion ? ` ${d.terminalVersion}` : ""}`

    try {
      const res = await requestDaemonProbe(d)
      const retained = await readRetainedDaemonProbeResponse(res)
      console.log(`  Retained private HTTP response ${retained.path}; SHA256 ${retained.sha256}`)
      const data = retained.run
      const observed = data.observations.length
      const total = observed + Object.keys(data.ungradedDiagnostics ?? {}).length
      console.log(`  ${label.padEnd(25)} ${observed}/${total} explicit observations (unreviewed)`)

      const { verifyTerminalIdentity } = await import("terminfo.dev/src/identity-guard.ts")
      const identityCheck = verifyTerminalIdentity(data.target.id, data.rawReplies)
      const run = {
        ...data,
        rawReplies: { ...data.rawReplies, "collector.identityCheck": JSON.stringify(identityCheck) },
      }
      const dir = join(ROOT, "content", "probes-apps")
      saveDaemonProbeRun(run, dir)
      saved++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      failures.push(`${label}: ${msg}`)
      if (msg.includes("ECONNREFUSED")) {
        console.error(`  ${label.padEnd(25)} not running (stale daemon file)`)
      } else {
        console.error(`  ${label.padEnd(25)} ${msg}`)
      }
    }
  }

  if (saved > 0) console.log(`\n${saved} result(s) saved to content/probes-apps/`)
  if (failures.length > 0) throw new Error(`Daemon collection failed: ${failures.join("; ")}`)
}
