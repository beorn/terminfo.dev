#!/usr/bin/env bun
import { readRetainedDaemonProbeResponse, requestDaemonProbe, finalizeCollectedDraft } from "./daemon-client.ts"
/**
 * terminfo.dev CLI — can your terminal do that?
 *
 * npm-published CLI for end users. Supports inline testing, daemon mode,
 * offline contribution drafts, and terminal detection.
 *
 * @example
 * ```bash
 * npx terminfo.dev                     # show help
 * npx terminfo.dev test                # record available terminal observations
 * npx terminfo.dev test --json > raw.json # one raw run; TTY stdin, controls on /dev/tty
 * npx terminfo.dev test --output /tmp/terminfo-run.json # private raw file
 * npx terminfo.dev test --serve       # start daemon for remote testing
 * npx terminfo.dev submit /tmp/terminfo-run.json --draft /tmp/terminfo-draft.md # offline draft + raw attachment
 * npx terminfo.dev detect              # what terminal am I in?
 * ```
 */

import React from "react"
import { readFileSync, writeFileSync } from "node:fs"
import { isAbsolute } from "node:path"
import { Command, uint, json } from "@silvery/commander"
import { collectorIds } from "@terminfo/probe-defs"
import { renderString } from "silvery"
import { version as packageVersion } from "../package.json" with { type: "json" }
import { detectTerminal } from "./detect.ts"
import { ALL_PROBES } from "./probes/unified.ts"
import {
  aggregateCurrentResults,
  currentCoverageSentence,
  currentSupportedShare,
} from "../../../docs/data/release-scope.ts"
import { DetectView } from "./views/DetectView.tsx"
import { decodeCollectorRun, decodeCollectorDraft } from "@terminfo/run-parser"
import { createDraft } from "./submit.ts"
import { probeOutputStream } from "./probe-output.ts"
import { getCliSuiteProbeHash } from "./serve.ts"

/** Collect the same current draft as the daemon endpoint; finalization follows all enrichment. */
async function runProbes(out?: NodeJS.WriteStream, ids?: string[]) {
  const { collectProbeRun, getTrustedSuiteReceipt } = await import("./serve.ts")
  const run = await collectProbeRun({ ...(out && { out }), ...(ids !== undefined && { ids }) })
  const receipt = getTrustedSuiteReceipt()
  return { ...decodeCollectorDraft("inline collector", `${JSON.stringify(run)}\n`, receipt.manifest, receipt.collectorRevision), receipt }
}

function outputPath(path: string): string {
  if (!isAbsolute(path)) throw new Error(`Raw --output must be an absolute file path: ${path}`)
  return path
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
  .description(`Can your terminal do that? — record available tests across ${ALL_PROBES.length} feature definitions`)
  .version(`${packageVersion} (${getCliSuiteProbeHash()})`)

program.addHelpSection("Examples:", [
  ["$ npx terminfo.dev test", "Record available tests; other tests may be refused"],
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
  .description("Record terminal observations; state-changing tests require a verified test environment")
  .argument("[daemon]", "Daemon name to test")
  .option("--json", "Write one raw JSON run to stdout (inline probes require interactive TTY)")
  .option("--output <file>", "Write exact raw JSON to an absolute file")
  .option("--probe-ids <json>", "Exact probe IDs as a JSON array; [] executes none", json)
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
      probeIds?: unknown
    }) => {
      const probeIds = opts.probeIds === undefined ? undefined : collectorIds(opts.probeIds, "--probe-ids")
      if (opts.json && opts.output) throw new Error("Choose --json or --output for one raw run")
      if (opts.output) outputPath(opts.output)
      if (opts.all) throw new Error("Collecting multiple daemons is unavailable; test one named daemon with --output")
      if (opts.serve && (opts.json || opts.output || opts.daemon)) {
        throw new Error("--serve cannot be combined with raw output or a daemon target")
      }
      // --serve: start daemon mode
      if (opts.serve) {
        const { startDaemon } = await import("./serve.ts")
        if (probeIds !== undefined) process.env.TERMINFO_PROBE_IDS = JSON.stringify(probeIds)
        startDaemon(opts.port ?? 0)
        return
      }

      // One named daemon: retain its exact response bytes at an explicit destination.
      if (opts.daemon) {
        if (!opts.json && !opts.output) {
          throw new Error("Daemon collection requires --json or an absolute --output file")
        }
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
        const retained = await readRetainedDaemonProbeResponse(await requestDaemonProbe(daemon, undefined, probeIds))
        if (retained.kind === "empty-selection") {
          const raw = readFileSync(retained.path, "utf8")
          if (opts.output) writeFileSync(opts.output, raw, { flag: "wx", mode: 0o600 })
          else process.stdout.write(raw)
          console.error(`Empty selection draft ${retained.run.runId}${opts.output ? ` saved to ${opts.output}` : ""}; SHA256 ${retained.sha256}; no probes executed`)
          return
        }
        const captured = finalizeCollectedDraft(retained.run)
        const raw = `${JSON.stringify(captured)}\n`
        const { getTrustedSuiteReceipt } = await import("./serve.ts")
        const receipt = getTrustedSuiteReceipt()
        const decoded = (captured.sealedAt === undefined ? decodeCollectorDraft : decodeCollectorRun)(
          "daemon final writer",
          raw,
          receipt.manifest,
          receipt.collectorRevision,
        )
        if ("kind" in decoded && decoded.kind === "empty-selection") throw new Error("Empty selection where a capture was required")
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

      // Default: collect the current execution contract in this terminal.
      const out = probeIds?.length === 0 ? undefined : probeOutputStream(opts)
      let collected: Awaited<ReturnType<typeof runProbes>>
      try {
        collected = await runProbes(out, probeIds)
      } finally {
        // Only close a stream we opened: when --output probes this process's own stdout, ending it
        // would close the terminal we were launched in.
        if (out && out !== process.stdout) {
          await new Promise<void>((resolve) => {
            out.end(resolve)
          })
        }
      }
      if (collected.kind === "empty-selection") {
        if (opts.output) writeFileSync(opts.output, collected.raw, { flag: "wx", mode: 0o600 })
        else if (opts.json) process.stdout.write(collected.raw)
        const message = `Empty selection draft ${collected.run.runId}${opts.output ? ` saved to ${opts.output}` : ""}; SHA256 ${collected.sha256}; no probes executed`
        if (opts.json || opts.output) console.error(message)
        else console.log(message)
        return
      }
      const captured = finalizeCollectedDraft(collected.run)
      const raw = `${JSON.stringify(captured)}\n`
      const decoded = (captured.sealedAt === undefined ? decodeCollectorDraft : decodeCollectorRun)(
        "inline collector",
        raw,
        collected.receipt.manifest,
        collected.receipt.collectorRevision,
      )
      if ("kind" in decoded && decoded.kind === "empty-selection") throw new Error("Empty selection where a capture was required")
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
      const aggregate = aggregateCurrentResults(data.results, collected.receipt.manifest.catalogIds ?? [])
      console.log(`${data.subject.id} ${data.subject.version}: ${currentSupportedShare(aggregate)}`)
      console.log(currentCoverageSentence(aggregate, collected.receipt.manifest.catalogIds))
      console.log(
        `Run ${data.runId}: ${"sealedAt" in data ? "sealed" : "required review pending; unsealed draft"}; ${aggregate.complete ? "complete" : "incomplete"}; identity unverified.`,
      )
    },
  )

// ── submit ──

program
  .command("submit")
  .description("Prepare an offline contribution and exact raw attachment; nothing is sent")
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
