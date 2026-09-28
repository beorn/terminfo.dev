#!/usr/bin/env bun
import { readDaemonProbeResponse, requestDaemonProbe, saveDaemonProbeRun } from "./daemon-client.ts"
/**
 * terminfo.dev CLI — can your terminal do that?
 *
 * npm-published CLI for end users. Supports inline testing, daemon mode,
 * submission, and terminal detection.
 *
 * @example
 * ```bash
 * npx terminfo.dev                     # show help
 * npx terminfo.dev test                # test this terminal
 * npx terminfo.dev test --json         # machine output
 * npx terminfo.dev test --serve       # start daemon for remote testing
 * npx terminfo.dev test --all          # test all running daemons
 * npx terminfo.dev submit              # test + submit to terminfo.dev
 * npx terminfo.dev detect              # what terminal am I in?
 * ```
 */

import React from "react"
import { Command, uint } from "@silvery/commander"
import { renderString } from "silvery"
import { version as packageVersion } from "../package.json" with { type: "json" }
import { detectTerminal } from "./detect.ts"
import { ALL_PROBES } from "./probes/unified.ts"
import { DetectView } from "./views/DetectView.tsx"

/** Collect the same explicit v2 run as the daemon endpoint. */
async function runProbes() {
  const { collectProbeRun } = await import("./serve.ts")
  return collectProbeRun()
}

/** Render a React view to stdout using silvery's renderString. */
async function printView(element: React.ReactElement): Promise<void> {
  const width = process.stdout.columns || 80
  const output = await renderString(element, { width })
  console.log(output)
}

// ── CLI ──

const program = new Command()
  .name("terminfo")
  .description(
    `Can your terminal do that? — test ${ALL_PROBES.length} terminal features and contribute to terminfo.dev`,
  )
  .version(packageVersion)

program.addHelpSection("Examples:", [
  ["$ npx terminfo.dev test", "Test this terminal"],
  ["$ npx terminfo.dev test --json", "Machine-readable output"],
  ["$ npx terminfo.dev submit", "Test + submit to terminfo.dev"],
  ["$ npx terminfo.dev detect", "What terminal am I in?"],
])

// ── test ──

program
  .command("test")
  .description("Test this terminal's feature support")
  .argument("[daemon]", "Daemon name to test")
  .option("--json", "Output results as JSON")
  .option("--serve", "Start daemon for remote testing")
  .option("-p, --port <port>", "Port for --serve", uint)
  .option("--all", "Test all running daemons")
  .actionMerged(async (opts: { daemon?: string; json?: boolean; serve?: boolean; port?: number; all?: boolean }) => {
    // --serve: start daemon mode
    if (opts.serve) {
      const { startDaemon } = await import("./serve.ts")
      startDaemon(opts.port ?? 0)
      return
    }

    // --all or specific daemon: test remote daemons
    if (opts.all || opts.daemon) {
      const { listDaemons } = await import("./serve.ts")
      const daemons = listDaemons()

      let targets = daemons
      if (opts.daemon) {
        const selectedName = opts.daemon.toLowerCase()
        targets = daemons.filter(
          (d) => d.terminal.toLowerCase() === selectedName || d.terminal.toLowerCase().includes(selectedName),
        )
        if (targets.length === 0) {
          console.error(`No daemon found matching "${opts.daemon}".`)
          if (daemons.length > 0) {
            console.error(`Running: ${daemons.map((d) => d.terminal).join(", ")}`)
          } else {
            console.error(`No daemons running. Start one: terminfo test --serve`)
          }
          throw new Error(`No daemon found matching "${opts.daemon}"`)
        }
      }

      if (targets.length === 0) {
        console.log("No daemons found.")
        console.log("Start a daemon in each terminal: terminfo test --serve")
        return
      }

      console.log(`\nterminfo.dev — testing ${targets.length} terminal(s)\n`)
      const failures: string[] = []
      let saved = 0

      for (const d of targets) {
        const label = `${d.terminal}${d.terminalVersion ? ` ${d.terminalVersion}` : ""}`
        process.stdout.write(`  ${label.padEnd(25)} `)

        try {
          const res = await requestDaemonProbe(d)
          const data = await readDaemonProbeResponse(res)
          const observed = data.observations.length
          const total = observed + Object.keys(data.ungradedDiagnostics ?? {}).length
          console.log(`${observed}/${total} explicit observations (unreviewed)`)

          const { verifyTerminalIdentity } = await import("./identity-guard.ts")
          const identityCheck = verifyTerminalIdentity(data.target.id, data.rawReplies)

          const dir = "content/probes-apps"
          saveDaemonProbeRun(
            {
              ...data,
              rawReplies: { ...data.rawReplies, "collector.identityCheck": JSON.stringify(identityCheck) },
            },
            dir,
          )
          saved++
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          failures.push(`${label}: ${msg}`)
          if (msg.includes("ECONNREFUSED")) {
            console.log("- not running (stale daemon file)")
          } else {
            console.log(`- ${msg}`)
          }
        }
      }

      if (saved > 0) console.log(`\n${saved} result(s) saved to content/probes-apps/`)
      if (failures.length > 0) throw new Error(`Daemon collection failed: ${failures.join("; ")}`)
      return
    }

    // Default: collect an unreviewed v2 run in this terminal.
    const data = await runProbes()
    if (opts.json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }
    console.log(
      `${data.target.id} ${data.target.version}: ${data.observations.length}/${ALL_PROBES.length} explicit observations`,
    )
    console.log(
      `Run ${data.runId} is unreviewed${data.suiteComplete ? "" : " and partial"}; use --json for raw evidence.`,
    )
  })

// ── submit ──

program
  .command("submit")
  .description("Submit reviewed terminal results")
  .action(() => {
    throw new Error(
      "Submitting a v2 partial run requires a reviewed submission path; use test --json to inspect raw evidence",
    )
  })

// ── detect ──

program
  .command("detect")
  .description("Detect current terminal")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const terminal = detectTerminal()

    if (opts.json) {
      console.log(JSON.stringify(terminal, null, 2))
      return
    }

    await printView(<DetectView terminal={terminal} />)
  })

program.parse()
