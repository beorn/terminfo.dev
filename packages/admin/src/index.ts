#!/usr/bin/env bun
/**
 * terminfo CLI — unified terminal capability testing.
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

import { Command } from "@silvery/commander"

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
  .argument("[selectors...]", "Backend selectors to probe")
  .description("Headless library probes via Termless backends")
  .option("--all", "Probe all backends")
  .option("-f, --force", "Re-run even if cached")
  .actionMerged(async (opts: { selectors: string[]; all?: boolean; force?: boolean }) => {
    const { runTermlessProbes } = await import("./termless.ts")
    await runTermlessProbes(opts.all ? [] : opts.selectors, opts)
  })

// ── probe server ──

probe
  .command("server")
  .argument("[daemon]", "Daemon name to probe")
  .description("Probe running daemon servers")
  .option("--start", "Start daemon in this terminal")
  .option("-p, --port <port>", "Port for --start", parseInt)
  .option("--all", "Probe all running daemons")
  .actionMerged(async (opts: { daemon?: string; start?: boolean; port?: number; all?: boolean }) => {
    const { handleServer } = await import("./server.ts")
    await handleServer(opts.daemon, opts)
  })

// ── probe app ──

probe
  .command("app")
  .argument("[terminal]", "Terminal app to probe")
  .description("Launch and probe macOS terminal apps")
  .option("--all", "Probe all installed terminals")
  .option("-f, --force", "Re-run even if cached")
  .actionMerged(async (opts: { terminal?: string; all?: boolean; force?: boolean }) => {
    const { handleApp } = await import("./app.ts")
    await handleApp(opts.terminal, opts)
  })

// ── probe mux ──

probe
  .command("mux")
  .argument("[multiplexer]", "Multiplexer to probe (tmux, screen)")
  .description("Probe through terminal multiplexers (tmux, screen)")
  .option("--all", "Probe through all installed multiplexers")
  .option("-f, --force", "Re-run even if cached")
  .actionMerged(async (opts: { multiplexer?: string; all?: boolean; force?: boolean }) => {
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

program
  .command("report")
  .description("Show saved probe results")
  .action(async () => {
    const { handleReport } = await import("./report.ts")
    await handleReport()
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
