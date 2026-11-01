#!/usr/bin/env bun
/**
 * terminfo CLI — unified terminal feature testing.
 *
 * Four probe mechanisms:
 *   termless   Headless library probes via Termless backends (Vitest)
 *   server     Probe running daemons (HTTP servers in real terminals)
 *   app        Launch and probe macOS terminal apps (AppleScript)
 *   here       Probe this terminal inline (raw TTY I/O)
 *
 * @example
 * ```bash
 * terminfo                          # show help
 * terminfo probe                    # list probe mechanisms
 * terminfo probe termless --all     # run all headless probes
 * terminfo probe server --start     # start daemon in this terminal
 * terminfo probe app --all          # probe all installed terminals
 * terminfo probe here               # probe this terminal inline
 * terminfo report                   # show saved results
 * terminfo submit                   # probe + upload to terminfo.dev
 * terminfo status                   # config, cache, backends
 * terminfo detect                   # what terminal am I in?
 * ```
 */

import { Command, json } from "@silvery/commander"
import { collectorIds } from "@terminfo/probe-defs"
import { ensureSourceSuiteEnvironment } from "../versions.ts"
import type { IntakeOptions } from "./review.ts"

const program = new Command().name("terminfo").description("Terminal feature testing for terminfo.dev")

program.addHelpSection("Examples:", [
  ["$ terminfo probe termless --all", "Run all headless probes"],
  ["$ terminfo probe server --start", "Start daemon in this terminal"],
  ["$ terminfo probe app --all", "Probe all installed terminals"],
  ["$ terminfo probe here", "Probe this terminal inline"],
  ["$ terminfo report", "Show saved results"],
  ["$ terminfo submit", "Probe + upload to terminfo.dev"],
  ["$ terminfo status", "Config, cache, backends"],
  ["$ terminfo detect", "What terminal am I in?"],
])

// ── probe ──

const probe = program.command("probe").description("Run terminal probes (termless, server, app, mux, here)")

probe.addHelpSection("Examples:", [
  ["$ terminfo probe termless --all", "Probe all headless backends"],
  ["$ terminfo probe termless xtermjs", "Probe specific backend"],
  ["$ terminfo probe server --start", "Start daemon in this terminal"],
  ["$ terminfo probe server --all", "Probe all running daemons"],
  ["$ terminfo probe app ghostty", "Probe specific terminal app"],
  ["$ terminfo probe mux tmux", "Probe through tmux"],
  ["$ terminfo probe here", "Probe this terminal inline"],
])

// ── probe termless ──

probe
  .command("termless")
  .description("Headless library probes via Termless backends")
  .argument("[selectors...]", "Backend selectors to probe")
  .option("--all", "Probe all backends")
  .option("--probe-ids <json>", "Exact probe IDs as a JSON array; [] executes none", json)
  .option("-f, --force", "Re-run even if cached")
  .actionMerged(async (opts: { selectors: string[]; all?: boolean; force?: boolean; probeIds?: unknown }) => {
    const { runTermlessProbes } = await import("./termless.ts")
    const probeIds = opts.probeIds === undefined ? undefined : collectorIds(opts.probeIds, "--probe-ids")
    await runTermlessProbes(opts.all ? [] : opts.selectors, { ...opts, probeIds })
  })

// ── probe server ──

probe
  .command("server")
  .description("Probe running daemon servers")
  .argument("[daemon]", "Daemon name to probe")
  .option("--start", "Start daemon in this terminal")
  .option("-p, --port <port>", "Port for --start", parseInt)
  .option("--all", "Probe all running daemons")
  .actionMerged(async (opts: { daemon?: string; start?: boolean; port?: number; all?: boolean }) => {
    ensureSourceSuiteEnvironment()
    const { handleServer } = await import("./server.ts")
    await handleServer(opts.daemon, opts)
  })

// ── probe app ──

probe
  .command("app")
  .description("Launch and probe macOS terminal apps")
  .argument("[terminal]", "Terminal app to probe")
  .option("--all", "Probe all installed terminals")
  .option("-f, --force", "Re-run even if cached")
  .option("--output <directory>", "Retain the private development run without admission")
  .actionMerged(async (opts: { terminal?: string; all?: boolean; force?: boolean; output?: string }) => {
    ensureSourceSuiteEnvironment()
    const { handleApp } = await import("./app.ts")
    await handleApp(opts.terminal, opts)
  })

// ── probe mux ──

probe
  .command("mux")
  .description("Probe through terminal multiplexers (tmux, screen)")
  .argument("[multiplexer]", "Multiplexer to probe (tmux, screen)")
  .option("--output <directory>", "Retain raw runs and original HTTP responses privately, without admission")
  .option("--all", "Probe through all installed multiplexers")
  .option("-f, --force", "Re-run even if cached")
  .actionMerged(async (opts: { multiplexer?: string; all?: boolean; force?: boolean; output?: string }) => {
    ensureSourceSuiteEnvironment()
    const { handleMux } = await import("./mux.ts")
    await handleMux(opts.multiplexer, opts)
  })

// ── probe here ──

probe
  .command("here")
  .description("Probe this terminal inline")
  .option("--json", "Output results as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { handleHere } = await import("./here.ts")
    await handleHere(opts)
  })

// ── report ──

const review = program
  .command("review")
  .description("Review explicit retained captures; private files only, JSON stdout")
function reviewContext(value: string): IntakeOptions["context"] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (cause) {
    throw new Error("--context requires valid JSON", { cause })
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("kind" in parsed) ||
    typeof parsed.kind !== "string" ||
    !["term", "lib", "mux"].includes(parsed.kind) ||
    !("id" in parsed) ||
    typeof parsed.id !== "string" ||
    !parsed.id
  ) {
    throw new Error("--context requires kind, id and OS for term/mux")
  }
  const os = "os" in parsed ? parsed.os : undefined
  if ((os !== undefined && typeof os !== "string") || (parsed.kind !== "lib" && !os)) {
    throw new Error("--context requires kind, id and OS for term/mux")
  }
  return { ...parsed, kind: parsed.kind, id: parsed.id, ...(os === undefined ? {} : { os }) }
}
review.addHelpSection("Resources:", [
  [
    "intake",
    "Requires retained run/pass, explicit context, frozen registry or pinned-source receipt, and two pinned Git repositories",
  ],
  ["apply", "Requires issuer-edited intake; preserves exact decision bytes and always leaves output unsealed"],
  ["Empty scope", "No pending rows produces empty intake; no decisions produces a no-op receipt"],
  ["Failures", "Missing required inputs/citations fail on stderr; absent optional external sources report unverified"],
])
review
  .command("intake")
  .description("Write an issuer-editable citation index; no verdicts or timestamps are invented")
  .requiredOption("--input <path>", "Absolute retained run or pass.json path; never latest/glob")
  .requiredOption("--context <json>", "Explicit {kind,id,os} context (os required for term/mux)", reviewContext)
  .requiredOption(
    "--suite-root <path>",
    "Absolute suite-registry lookup repository; absent declaration uses the pinned-source receipt",
  )
  .requiredOption("--terminfo-repo <path>", "Absolute Terminfo source repository")
  .requiredOption("--terminfo-commit <sha>", "Full 40-hex pinned Terminfo commit")
  .requiredOption("--termless-repo <path>", "Absolute Termless source repository")
  .requiredOption("--termless-commit <sha>", "Full 40-hex pinned Termless commit")
  .requiredOption("--output <path>", "Absolute new private intake file outside source repositories")
  .actionMerged(async (opts: IntakeOptions) => {
    try {
      const { intakeReview } = await import("./review.ts")
      console.log(JSON.stringify(intakeReview(opts)))
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  })
review
  .command("apply")
  .description("Apply exact issuer decisions to a new immutable draft; no downstream operation")
  .requiredOption(
    "--intake <path>",
    "Absolute issuer-edited index with exact decision bytes, actual timestamp, SHA256 and citations",
  )
  .requiredOption("--output <directory>", "Absolute private draft directory outside source repositories")
  .requiredOption("--receipt <path>", "Absolute new private JSON receipt; missing required resources fail loudly")
  .actionMerged(async (opts: { intake: string; output: string; receipt: string }) => {
    try {
      const { applyReview } = await import("./review.ts")
      console.log(JSON.stringify(applyReview(opts)))
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  })

program
  .command("report")
  .description("Show saved probe results")
  .option(
    "--scoreboard <inputs...>",
    "Show context progress from explicit raw captures or collection pass files/directories",
    (value: string, previous: string[] = []) => [...previous, value],
  )
  .action(async (opts: { scoreboard?: string[] }) => {
    const { handleReport } = await import("./report.ts")
    await handleReport(opts)
  })

// ── submit ──

program
  .command("submit")
  .description("Probe and submit results to terminfo.dev")
  .option("--terminal-name <name>", "Override detected terminal name")
  .option("--terminal-version <version>", "Override detected terminal version")
  .action(async (opts: { terminalName?: string; terminalVersion?: string }) => {
    const { handleSubmit } = await import("./submit.ts")
    await handleSubmit(opts)
  })

// ── status ──

program
  .command("status")
  .description("Show config, cache, backends")
  .action(async () => {
    const { handleStatus } = await import("./status.ts")
    await handleStatus()
  })

// ── detect ──

program
  .command("detect")
  .description("Detect current terminal")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { handleDetect } = await import("./detect.ts")
    await handleDetect(opts)
  })

await program.parseAsync()
