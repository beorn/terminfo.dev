#!/usr/bin/env bun
import { readRawDaemonProbeResponse, requestDaemonProbe } from "./daemon-client.ts"
/**
 * terminfo.dev CLI — can your terminal do that?
 *
 * npm-published CLI for end users. Supports inline testing, daemon mode,
 * offline contribution drafts, and terminal detection.
 *
 * @example
 * ```bash
 * npx terminfo.dev                     # show help
 * npx terminfo.dev test                # test this terminal
 * npx terminfo.dev test --json > raw.json # one raw run; TTY stdin, controls on /dev/tty
 * npx terminfo.dev test --output /tmp/terminfo-run.json # private raw file
 * npx terminfo.dev test --serve       # start daemon for remote testing
 * npx terminfo.dev submit /tmp/terminfo-run.json --draft /tmp/terminfo-draft.md # offline draft + raw attachment
 * npx terminfo.dev detect              # what terminal am I in?
 * ```
 */

import React from "react"
import { openSync, writeFileSync } from "node:fs"
import { isAbsolute } from "node:path"
import { WriteStream } from "node:tty"
import { Command, uint } from "@silvery/commander"
import { renderString } from "silvery"
import { version as packageVersion } from "../package.json" with { type: "json" }
import { detectTerminal } from "./detect.ts"
import { ALL_PROBES } from "./probes/unified.ts"
import { DetectView } from "./views/DetectView.tsx"
import { decodeCollectorRun } from "../../../docs/data/selected-results.ts"
import { createDraft } from "./submit.ts"

/** Collect the same explicit v2 run as the daemon endpoint. */
async function runProbes(out?: NodeJS.WriteStream) {
  const { collectProbeRun, getTrustedSuiteReceipt } = await import("./serve.ts")
  const run = await collectProbeRun(out ? { out } : {})
  return { run, receipt: getTrustedSuiteReceipt() }
}

function outputPath(path: string): string {
  if (!isAbsolute(path)) throw new Error(`Raw --output must be an absolute file path: ${path}`)
  return path
}

function openControllingTTY(): WriteStream {
  if (process.platform === "win32") throw new Error("JSON/file collection requires a proved Windows controlling TTY")
  if (!process.stdin.isTTY) throw new Error("JSON/file collection requires interactive TTY stdin for probe replies")
  let fd: number
  try {
    fd = openSync("/dev/tty", "w")
  } catch (error) {
    throw new Error(
      `Cannot open controlling /dev/tty before probing: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return new WriteStream(fd)
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
  ["$ npx terminfo.dev test --json > raw.json", "One raw run; TTY input, controls on /dev/tty"],
  ["$ npx terminfo.dev test --output /tmp/terminfo-run.json", "Private raw file at an absolute path"],
  [
    "$ npx terminfo.dev submit /tmp/terminfo-run.json --draft /tmp/terminfo-draft.md",
    "Offline draft and adjacent raw attachment; nothing is sent",
  ],
  ["$ npx terminfo.dev detect", "What terminal am I in?"],
])

// ── test ──

program
  .command("test")
  .description("Test this terminal's feature support")
  .argument("[daemon]", "Daemon name to test")
  .option("--json", "Write one raw JSON run to stdout (inline probes require interactive TTY)")
  .option("--output <file>", "Write exact raw JSON to an absolute file")
  .option("--serve", "Start daemon for remote testing")
  .option("-p, --port <port>", "Port for --serve", uint)
  .option("--all", "Unavailable: collecting multiple daemons is refused")
  .actionMerged(
    async (opts: {
      daemon?: string
      json?: boolean
      output?: string
      serve?: boolean
      port?: number
      all?: boolean
    }) => {
      if (opts.json && opts.output) throw new Error("Choose --json or --output for one raw run")
      if (opts.output) outputPath(opts.output)
      if (opts.all) throw new Error("Collecting multiple daemons is unavailable; test one named daemon with --output")
      if (opts.serve && (opts.json || opts.output || opts.daemon)) {
        throw new Error("--serve cannot be combined with raw output or a daemon target")
      }
      // --serve: start daemon mode
      if (opts.serve) {
        const { startDaemon } = await import("./serve.ts")
        startDaemon(opts.port ?? 0)
        return
      }

      // One named daemon: retain its exact response bytes at an explicit destination.
      if (opts.daemon) {
        if (!opts.json && !opts.output)
          throw new Error("Daemon collection requires --json or an absolute --output file")
        const { listDaemons } = await import("./serve.ts")
        const daemons = listDaemons()
        const selectedName = opts.daemon.toLowerCase()
        const targets = daemons.filter(
          (d) => d.terminal.toLowerCase() === selectedName || d.terminal.toLowerCase().includes(selectedName),
        )
        if (targets.length !== 1) {
          throw new Error(`Daemon target "${opts.daemon}" matched ${targets.length} registrations; name exactly one`)
        }
        const daemon = targets[0]
        if (!daemon) throw new Error("Selected daemon registration disappeared")
        const decoded = await readRawDaemonProbeResponse(await requestDaemonProbe(daemon))
        if (opts.output) {
          writeFileSync(opts.output, decoded.raw, { flag: "wx", mode: 0o600 })
          console.error(
            `Raw run ${decoded.run.runId} saved to ${opts.output}; SHA256 ${decoded.sha256}; identity unverified`,
          )
        } else {
          process.stdout.write(decoded.raw)
          console.error(`Raw run ${decoded.run.runId}; SHA256 ${decoded.sha256}; identity unverified`)
        }
        return
      }

      // Default: collect an unreviewed v2 run in this terminal.
      const out = opts.json || opts.output ? openControllingTTY() : undefined
      let collected: Awaited<ReturnType<typeof runProbes>>
      try {
        collected = await runProbes(out)
      } finally {
        if (out)
          await new Promise<void>((resolve) => {
            out.end(resolve)
          })
      }
      const raw = `${JSON.stringify(collected.run)}\n`
      const decoded = decodeCollectorRun(
        "inline collector",
        raw,
        collected.receipt.manifest,
        collected.receipt.collectorRevision,
      )
      if (opts.output) {
        writeFileSync(opts.output, raw, { flag: "wx", mode: 0o600 })
        console.error(
          `Raw run ${decoded.run.runId} saved to ${opts.output}; SHA256 ${decoded.sha256}; identity unverified`,
        )
        return
      }
      if (opts.json) {
        process.stdout.write(raw)
        console.error(`Raw run ${decoded.run.runId}; SHA256 ${decoded.sha256}; identity unverified`)
        return
      }
      const data = decoded.run
      console.log(
        `${data.target.id} ${data.target.version}: ${data.observations.length}/${ALL_PROBES.length} explicit observations`,
      )
      console.log(
        `Run ${data.runId} is unreviewed${data.suiteComplete ? "" : " and partial"}; use --json for raw evidence.`,
      )
    },
  )

// ── submit ──

program
  .command("submit")
  .description("Prepare an offline draft and adjacent raw attachment from one unreviewed v2 run; nothing is sent")
  .argument("<raw>", "Exact raw JSON file from test --output")
  .option("--draft <file>", "Write an offline Markdown draft")
  .actionMerged(async (opts: { raw: string; draft?: string }) => {
    if (!opts.draft) throw new Error("submit requires --draft <file>; no run was posted")
    const { getTrustedSuiteReceipt } = await import("./serve.ts")
    const result = createDraft(opts.raw, opts.draft, { ...getTrustedSuiteReceipt(), cliVersion: packageVersion })
    console.log(`Offline draft ${opts.draft}; raw attachment ${result.attachmentPath}; SHA256 ${result.sha256}`)
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
