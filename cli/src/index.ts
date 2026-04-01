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

import { Command, uint } from "@silvery/commander"
import { createStyle } from "@silvery/ansi"
import { isTTY } from "silvery/ui/cli"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { detectTerminal } from "./detect.ts"
import { ALL_PROBES } from "./probes/unified.ts"
import { withRawMode, drainStdin } from "./tty.ts"
import { submitResults } from "./submit.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))

// Shared style instance — handles NO_COLOR, FORCE_COLOR, and terminal detection
const s = createStyle()

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

/** OSC 8 hyperlink */
function link(url: string, text: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`
}

interface ProbeResults {
  terminal: ReturnType<typeof detectTerminal>
  results: Record<string, boolean>
  notes: Record<string, string>
  responses: Record<string, string>
  passed: number
  total: number
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
  // RIS moves cursor to 1,1 — that's fine, we're about to print results

  return { terminal, results, notes, responses, passed, total: ALL_PROBES.length }
}

function printHeader(terminal: ReturnType<typeof detectTerminal>) {
  const siteLink = link("https://terminfo.dev", "terminfo.dev")
  console.log(`${s.bold(siteLink)} — can your terminal do that?\n`)
  console.log(`  Terminal:  ${s.bold(`${terminal.name}${terminal.version ? ` ${terminal.version}` : ""}`)}`)
  console.log(`  Platform:  ${terminal.os} ${terminal.osVersion}`)
  console.log(
    `  Features:  ${ALL_PROBES.length} across ${new Set(ALL_PROBES.map((p) => p.id.split(".")[0])).size} categories`,
  )
  console.log(`  Website:   ${link("https://terminfo.dev", "https://terminfo.dev")}`)
}

function printResults(data: ProbeResults) {
  const { passed, total } = data
  const pct = Math.round((passed / total) * 100)
  const slugs = loadFeatureSlugs()

  printHeader(data.terminal)
  console.log(`  Score:     ${s.bold(`${passed}/${total} (${pct}%)`)}\n`)

  const categories = new Map<string, Array<{ id: string; name: string; pass: boolean; note?: string }>>()
  for (const probe of ALL_PROBES) {
    const cat = probe.id.split(".")[0]!
    if (!categories.has(cat)) categories.set(cat, [])
    categories.get(cat)!.push({
      id: probe.id,
      name: probe.name,
      pass: data.results[probe.id] ?? false,
      note: data.notes[probe.id],
    })
  }

  for (const [cat, probes] of categories) {
    const catPassed = probes.filter((p) => p.pass).length
    const colorFn = catPassed === probes.length ? s.green : catPassed > 0 ? s.yellow : s.red
    console.log(`${colorFn(s.bold(cat))} ${colorFn(`${catPassed}/${probes.length}`)}`)

    for (const p of probes) {
      const icon = p.pass ? s.green("✓") : s.red("✗")
      const note = p.note && !p.pass ? ` ${s.dim(`(${p.note})`)}` : ""
      const slug = slugs[p.id]
      const fCat = p.id.split(".")[0]
      const featureLink = link(`https://terminfo.dev/${fCat}/${slug}`, p.name)
      console.log(`  ${icon} ${featureLink}${note}`)
    }
  }
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

/** Check if this terminal+version+OS combo is already in the terminfo.dev census */
async function checkIfNewTerminal(name: string, version: string, os: string): Promise<boolean> {
  try {
    const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, "-")
    const ver = (version || "unknown").replace(/[^a-z0-9.-]/g, "-")
    const filename = `${slug}-${ver}-${os}.json`
    const url = `https://raw.githubusercontent.com/beorn/terminfo.dev/main/content/probes-apps/${filename}`
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
    return res.status === 404
  } catch {
    return false // network error — don't show banner
  }
}

/**
 * Show interactive post-test prompt using silvery SelectList.
 * Returns true if user chose to submit, false otherwise.
 */
async function showSubmitPrompt(isNew: boolean, terminalLabel: string): Promise<boolean> {
  // Non-interactive: just print the nudge text
  if (!isTTY()) {
    if (isNew) {
      console.log(`\n  ${s.bold.yellow("★ New terminal!")} ${s.bold(terminalLabel)} isn't on terminfo.dev yet.`)
      console.log(`  Submit your results: ${s.bold("npx terminfo.dev submit")}`)
    } else {
      console.log(`\n  ${s.dim("Submit updated results:")} ${s.bold("npx terminfo.dev submit")}`)
    }
    return false
  }

  console.log("")

  if (isNew) {
    console.log(`  ${s.bold.yellow("★ New terminal!")} ${s.bold(terminalLabel)} isn't on terminfo.dev yet.`)
    console.log(`  ${s.dim("Help other developers by sharing your results:")}`)
  } else {
    console.log(`  ${s.dim("Your results can be submitted to terminfo.dev:")}`)
  }

  console.log("")

  const { createInterface } = await import("node:readline")

  const submitLabel = isNew ? "Submit to terminfo.dev? [Y/n]" : "Submit updated results? [y/N]"
  const defaultYes = isNew

  return new Promise<boolean>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(`  ${submitLabel} `, (answer) => {
      rl.close()
      const ans = answer.trim().toLowerCase()
      if (ans === "") resolve(defaultYes)
      else resolve(ans === "y" || ans === "yes")
    })
  })
}

// ── CLI ──

const program = new Command()
  .name("terminfo")
  .description("Can your terminal do that? — test terminal feature support and contribute to terminfo.dev")
  .version("4.0.0")

// ── Default action: show terminal info + help ──

program.action(() => {
  const terminal = detectTerminal()
  printHeader(terminal)
  console.log(``)
  console.log(`${s.dim("Test your terminal against " + ALL_PROBES.length + " features from the ECMA-48,")}`)
  console.log(`${s.dim("VT100/VT510, xterm, and Kitty specifications. Results can be")}`)
  console.log(`${s.dim("submitted to the community database at terminfo.dev.")}`)
  console.log(``)
  console.log(`Commands:`)
  console.log(`  ${s.bold("test")}                  Test this terminal's feature support`)
  console.log(`  ${s.bold("test --json")}           Machine-readable output`)
  console.log(`  ${s.bold("test --serve")}         Start daemon for remote testing`)
  console.log(`  ${s.bold("test --all")}            Test all running daemons`)
  console.log(`  ${s.bold("submit")}                Test + submit results to terminfo.dev`)
  console.log(`  ${s.bold("detect")}                Detect current terminal`)
  console.log(``)
  console.log(`Options:`)
  console.log(`  ${s.bold("--help")}     Show this help`)
  console.log(`  ${s.bold("--version")}  Show version`)
})

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
          process.exit(1)
        }
      }

      if (targets.length === 0) {
        console.log(s.yellow("No daemons found."))
        console.log(`Start a daemon in each terminal: ${s.bold("terminfo test --serve")}`)
        return
      }

      console.log(`${s.bold("terminfo.dev")} — testing ${targets.length} terminal(s)\n`)

      for (const d of targets) {
        const label = `${d.terminal}${d.terminalVersion ? ` ${d.terminalVersion}` : ""}`
        process.stdout.write(`  ${label.padEnd(25)} `)

        try {
          const res = await fetch(`http://127.0.0.1:${d.port}/probe`, { signal: AbortSignal.timeout(120000) })
          if (!res.ok) {
            console.log(s.red(`- HTTP ${res.status}`))
            continue
          }
          const data = (await res.json()) as any
          const passed = Object.values(data.results).filter((v: any) => v).length
          const total = Object.keys(data.results).length
          const pct = Math.round((passed / total) * 100)
          const colorFn = pct >= 98 ? s.green : pct >= 90 ? s.yellow : s.red
          console.log(colorFn(`${passed}/${total} (${pct}%)`))

          const { mkdirSync, writeFileSync } = await import("node:fs")
          const dir = "content/probes-apps"
          mkdirSync(dir, { recursive: true })
          const name = data.terminal.toLowerCase().replace(/[^a-z0-9-]/g, "-")
          const ver = (data.terminalVersion || "unknown").replace(/[^a-z0-9.-]/g, "-")
          writeFileSync(`${dir}/${name}-${ver}-${data.os}.json`, JSON.stringify(data, null, 2))
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes("ECONNREFUSED")) {
            console.log(s.red("- not running (stale daemon file)"))
          } else {
            console.log(s.red(`- ${msg}`))
          }
        }
      }

      console.log(`\nResults saved to content/probes-apps/`)
      return
    }

    // Default: test this terminal inline
    const data = await runProbes()
    if (opts.json) {
      console.log(formatResultsJson(data))
      return
    }
    printResults(data)

    // Check if this terminal is already in the census
    const isNew = await checkIfNewTerminal(data.terminal.name, data.terminal.version, data.terminal.os)

    const terminalLabel = `${data.terminal.name}${data.terminal.version ? ` ${data.terminal.version}` : ""}`
    const shouldSubmit = await showSubmitPrompt(isNew, terminalLabel)

    if (shouldSubmit) {
      console.log(`\n  Submitting to terminfo.dev...`)
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
        console.log(`${s.green("+")} Issue created: ${link(url, url)}`)
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

    printHeader(terminal)
    console.log(``)

    const { createInterface } = await import("node:readline")

    async function ask(question: string, defaultValue: string): Promise<string> {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      return new Promise((resolve) => {
        rl.question(`  ${question} [${s.bold(defaultValue)}]: `, (answer) => {
          rl.close()
          resolve(answer.trim() || defaultValue)
        })
      })
    }

    name = await ask("Terminal name", name)
    version = await ask("Terminal version", version || "unknown")
    if (version === "unknown") version = ""

    if (!version) {
      console.log(`\n  ${s.yellow("⚠ No version detected.")} We need the version to accept submissions.`)
      console.log(`  Try: ${s.bold(`${name} --version`)} or check your terminal's About menu.`)
      version = await ask("Terminal version", "")
      if (!version) {
        console.log(`\n  ${s.red("Cannot submit without a version. Exiting.")}`)
        process.exit(1)
      }
    }

    console.log(`\n  Testing ${s.bold(`${name} ${version}`)} on ${terminal.os}...\n`)

    const data = await runProbes()
    printResults(data)

    console.log(`\n  Submitting to terminfo.dev...`)
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
      console.log(`${s.green("+")} Issue created: ${link(url, url)}`)
    }
  })

// ── detect ──

program
  .command("detect")
  .description("Detect current terminal")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const terminal = detectTerminal()

    if (opts.json) {
      console.log(JSON.stringify(terminal, null, 2))
      return
    }

    console.log(`\n${s.bold("terminfo detect")}\n`)
    console.log(`  Terminal:  ${s.bold(`${terminal.name}${terminal.version ? ` ${terminal.version}` : ""}`)}`)
    console.log(`  OS:        ${terminal.os} ${terminal.osVersion}`)
  })

program.parse()
