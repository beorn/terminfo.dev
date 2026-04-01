#!/usr/bin/env bun
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
import { hyperlink } from "@silvery/ansi"
import { isTTY } from "silvery/ui/cli"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { detectTerminal } from "./detect.ts"
import { ALL_PROBES } from "./probes/unified.ts"
import { withRawMode, drainStdin } from "./tty.ts"
import { submitResults } from "./submit.ts"
import { DetectView } from "./views/DetectView.tsx"
import { TestResults, PostTestStatus, SubmitNudge, SubmitResult } from "./views/TestResults.tsx"
import type { ProbeResults } from "./types.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Load feature slugs from features.json for OSC 8 hyperlinks */
function loadFeatureSlugs(): Record<string, string> {
  const candidates = [
    join(__dirname, "..", "..", "content", "features.json"), // from cli/src/ -> content/
    join(__dirname, "..", "..", "..", "content", "features.json"), // fallback
  ]
  for (const path of candidates) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, any>
      delete raw.$comment
      const slugs: Record<string, string> = {}
      for (const [id, meta] of Object.entries(raw)) {
        slugs[id] = (meta as any).slug ?? id.replace(/\./g, "/")
      }
      return slugs
    } catch {
      // try next
    }
  }
  return {}
}

async function runProbes(): Promise<ProbeResults> {
  const terminal = detectTerminal()
  const results: Record<string, boolean> = {}
  const notes: Record<string, string> = {}
  const responses: Record<string, string> = {}
  let passed = 0
  const total = ALL_PROBES.length

  // Save cursor + scroll position, run probes, restore
  process.stdout.write("\x1b7") // save cursor (DECSC)

  await withRawMode(async () => {
    for (const probe of ALL_PROBES) {
      try {
        const result = await probe.run()
        results[probe.id] = result.pass
        if (result.note) notes[probe.id] = result.note
        if (result.response) responses[probe.id] = result.response
        if (result.pass) passed++
      } catch (err) {
        results[probe.id] = false
        notes[probe.id] = `error: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    await drainStdin(1000)
  })

  // Restore terminal state completely
  process.stdout.write("\x1b8") // restore cursor (DECRC)
  process.stdout.write("\x1bc") // RIS — full terminal reset

  const probes = ALL_PROBES.map((p) => ({ id: p.id, name: p.name }))
  return { terminal, results, notes, responses, passed, total, probes }
}

function formatResultsJson(data: ProbeResults) {
  return JSON.stringify(
    {
      terminal: data.terminal.name,
      terminalVersion: data.terminal.version,
      os: data.terminal.os,
      osVersion: data.terminal.osVersion,
      source: "community",
      generated: new Date().toISOString(),
      results: data.results,
      notes: data.notes,
      responses: data.responses,
    },
    null,
    2,
  )
}

/** Check terminal status: "new" (not in census), "changed" (results differ), "unchanged" */
async function checkTerminalStatus(
  name: string,
  version: string,
  os: string,
  results: Record<string, boolean>,
): Promise<"new" | "changed" | "unchanged"> {
  try {
    const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, "-")
    const ver = (version || "unknown").replace(/[^a-z0-9.-]/g, "-")
    const filename = `${slug}-${ver}-${os}.json`
    const url = `https://raw.githubusercontent.com/beorn/terminfo.dev/main/content/probes-apps/${filename}`
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
    if (res.status === 404) return "new"

    const existing = (await res.json()) as { results?: Record<string, boolean> }
    if (!existing.results) return "changed"

    for (const [key, val] of Object.entries(results)) {
      if (existing.results[key] !== val) return "changed"
    }
    for (const key of Object.keys(existing.results)) {
      if (!(key in results)) return "changed"
    }
    return "unchanged"
  } catch {
    return "new" // network error — assume new
  }
}

/**
 * Prompt user for Y/n via readline.
 * Returns true if user chose yes, false otherwise.
 */
async function askYesNo(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline")
  return new Promise<boolean>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(`  ${question} `, (answer) => {
      rl.close()
      const ans = answer.trim().toLowerCase()
      if (ans === "")
        resolve(true) // default yes
      else resolve(ans === "y" || ans === "yes")
    })
  })
}

/**
 * Prompt user for text input via readline.
 */
async function askText(question: string, defaultValue: string): Promise<string> {
  const { createInterface } = await import("node:readline")
  return new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const prompt = defaultValue ? `  ${question} [${defaultValue}]: ` : `  ${question}: `
    rl.question(prompt, (answer) => {
      rl.close()
      resolve(answer.trim() || defaultValue)
    })
  })
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
  .version("4.0.0")

program.addHelpText(
  "after",
  `
Examples:
  $ npx terminfo.dev test          Test this terminal
  $ npx terminfo.dev test --json   Machine-readable output
  $ npx terminfo.dev submit        Test + submit to terminfo.dev
  $ npx terminfo.dev detect        What terminal am I in?
`,
)

// ── test ──

program
  .command("test [daemon]")
  .description("Test this terminal's feature support")
  .option("--json", "Output results as JSON")
  .option("--serve", "Start daemon for remote testing")
  .option("-p, --port <port>", "Port for --serve", uint)
  .option("--all", "Test all running daemons")
  .action(async (daemon: string | undefined, opts) => {
    // --serve: start daemon mode
    if (opts.listen) {
      const { startDaemon } = await import("./serve.ts")
      await startDaemon(opts.port ?? 0)
      return
    }

    // --all or specific daemon: test remote daemons
    if (opts.all || daemon) {
      const { listDaemons } = await import("./serve.ts")
      const daemons = listDaemons()

      let targets = daemons
      if (daemon) {
        targets = daemons.filter(
          (d) =>
            d.terminal.toLowerCase() === daemon.toLowerCase() ||
            d.terminal.toLowerCase().includes(daemon.toLowerCase()),
        )
        if (targets.length === 0) {
          console.error(`No daemon found matching "${daemon}".`)
          if (daemons.length > 0) {
            console.error(`Running: ${daemons.map((d) => d.terminal).join(", ")}`)
          } else {
            console.error(`No daemons running. Start one: terminfo test --serve`)
          }
          throw new Error(`No daemon found matching "${daemon}"`)
        }
      }

      if (targets.length === 0) {
        console.log("No daemons found.")
        console.log("Start a daemon in each terminal: terminfo test --serve")
        return
      }

      console.log(`\nterminfo.dev — testing ${targets.length} terminal(s)\n`)

      for (const d of targets) {
        const label = `${d.terminal}${d.terminalVersion ? ` ${d.terminalVersion}` : ""}`
        process.stdout.write(`  ${label.padEnd(25)} `)

        try {
          const res = await fetch(`http://127.0.0.1:${d.port}/probe`, { signal: AbortSignal.timeout(120000) })
          if (!res.ok) {
            console.log(`- HTTP ${res.status}`)
            continue
          }
          const data = (await res.json()) as any
          const passed = Object.values(data.results).filter((v: any) => v).length
          const total = Object.keys(data.results).length
          const pct = Math.round((passed / total) * 100)
          console.log(`${passed}/${total} (${pct}%)`)

          const { mkdirSync, writeFileSync } = await import("node:fs")
          const dir = "content/probes-apps"
          mkdirSync(dir, { recursive: true })
          const name = data.terminal.toLowerCase().replace(/[^a-z0-9-]/g, "-")
          const ver = (data.terminalVersion || "unknown").replace(/[^a-z0-9.-]/g, "-")
          writeFileSync(`${dir}/${name}-${ver}-${data.os}.json`, JSON.stringify(data, null, 2))
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes("ECONNREFUSED")) {
            console.log("- not running (stale daemon file)")
          } else {
            console.log(`- ${msg}`)
          }
        }
      }

      console.log("\nResults saved to content/probes-apps/")
      return
    }

    // Default: test this terminal inline
    const data = await runProbes()
    if (opts.json) {
      console.log(formatResultsJson(data))
      return
    }

    const slugs = loadFeatureSlugs()
    await printView(<TestResults data={data} slugs={slugs} />)

    // Check if this terminal is already in the census
    const status = await checkTerminalStatus(data.terminal.name, data.terminal.version, data.terminal.os, data.results)

    const terminalLabel = `${data.terminal.name}${data.terminal.version ? ` ${data.terminal.version}` : ""}`

    if (status === "unchanged") {
      await printView(<PostTestStatus status="unchanged" terminalLabel={terminalLabel} />)
      return
    }

    // Show submit prompt
    if (!isTTY()) {
      await printView(<SubmitNudge isNew={status === "new"} terminalLabel={terminalLabel} />)
      return
    }

    await printView(<PostTestStatus status={status} terminalLabel={terminalLabel} />)

    const submitLabel = status === "new" ? "Submit to terminfo.dev? [Y/n]" : "Submit updated results? [Y/n]"
    const shouldSubmit = await askYesNo(submitLabel)

    if (shouldSubmit) {
      const url = await submitResults({
        terminal: data.terminal.name,
        terminalVersion: data.terminal.version,
        os: data.terminal.os,
        osVersion: data.terminal.osVersion,
        results: data.results,
        notes: data.notes,
        responses: data.responses,
        generated: new Date().toISOString(),
        cliVersion: "4.0.0",
        probeCount: ALL_PROBES.length,
      })
      if (url) {
        await printView(<SubmitResult url={url} hasVersion={!!data.terminal.version} />)
      }
    }
  })

// ── submit ──

program
  .command("submit")
  .description("Test all features and submit results to terminfo.dev via GitHub issue")
  .option("--terminal-name <name>", "Override detected terminal name")
  .option("--terminal-version <version>", "Override detected terminal version")
  .action(async (opts) => {
    const terminal = detectTerminal()
    let name = opts.terminalName ?? terminal.name
    let version = opts.terminalVersion ?? terminal.version

    const categoryCount = new Set(ALL_PROBES.map((p) => p.id.split(".")[0])).size
    await printView(<HelpView terminal={terminal} featureCount={ALL_PROBES.length} categoryCount={categoryCount} />)

    name = await askText("Terminal name", name)
    version = await askText("Terminal version", version || "unknown")
    if (version === "unknown") version = ""

    if (!version) {
      console.log(`\n  No version detected. Try: ${name} --version or check About menu.`)
      version = await askText("Terminal version", "")
      if (!version) {
        console.log("\n  Cannot submit without a version.")
        throw new Error("Cannot submit without a terminal version")
      }
    }

    console.log(`\n  Testing ${name} ${version} on ${terminal.os}...\n`)

    const data = await runProbes()
    const slugs = loadFeatureSlugs()
    await printView(<TestResults data={data} slugs={slugs} />)

    const url = await submitResults({
      terminal: name,
      terminalVersion: version,
      os: data.terminal.os,
      osVersion: data.terminal.osVersion,
      results: data.results,
      notes: data.notes,
      responses: data.responses,
      generated: new Date().toISOString(),
      cliVersion: "4.0.0",
      probeCount: ALL_PROBES.length,
    })
    if (url) {
      await printView(<SubmitResult url={url} hasVersion={!!version} />)
    }
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
