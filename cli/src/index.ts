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
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { detectTerminal } from "./detect.ts"
import { ALL_PROBES } from "./probes/unified.ts"
import { withRawMode, drainStdin } from "./tty.ts"
import { submitResults } from "./submit.ts"

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
  console.log(`\x1b[1m${siteLink}\x1b[0m — can your terminal do that?\n`)
  console.log(`  Terminal:  \x1b[1m${terminal.name}\x1b[0m${terminal.version ? ` ${terminal.version}` : ""}`)
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
  console.log(`  Score:     \x1b[1m${passed}/${total} (${pct}%)\x1b[0m\n`)

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
    const color = catPassed === probes.length ? "\x1b[32m" : catPassed > 0 ? "\x1b[33m" : "\x1b[31m"
    console.log(`${color}\x1b[1m${cat}\x1b[0m${color} ${catPassed}/${probes.length}\x1b[0m`)

    for (const p of probes) {
      const icon = p.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"
      const note = p.note && !p.pass ? ` \x1b[2m(${p.note})\x1b[0m` : ""
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
  console.log(`\x1b[2mTest your terminal against ${ALL_PROBES.length} features from the ECMA-48,`)
  console.log(`VT100/VT510, xterm, and Kitty specifications. Results can be`)
  console.log(`submitted to the community database at terminfo.dev.\x1b[0m`)
  console.log(``)
  console.log(`Commands:`)
  console.log(`  \x1b[1mtest\x1b[0m                  Test this terminal's feature support`)
  console.log(`  \x1b[1mtest --json\x1b[0m           Machine-readable output`)
  console.log(`  \x1b[1mtest --serve\x1b[0m         Start daemon for remote testing`)
  console.log(`  \x1b[1mtest --all\x1b[0m            Test all running daemons`)
  console.log(`  \x1b[1msubmit\x1b[0m                Test + submit results to terminfo.dev`)
  console.log(`  \x1b[1mdetect\x1b[0m                Detect current terminal`)
  console.log(``)
  console.log(`Options:`)
  console.log(`  \x1b[1m--help\x1b[0m     Show this help`)
  console.log(`  \x1b[1m--version\x1b[0m  Show version`)
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
        console.log(`\x1b[33mNo daemons found.\x1b[0m`)
        console.log(`Start a daemon in each terminal: \x1b[1mterminfo test --serve\x1b[0m`)
        return
      }

      console.log(`\x1b[1mterminfo.dev\x1b[0m — testing ${targets.length} terminal(s)\n`)

      for (const d of targets) {
        const label = `${d.terminal}${d.terminalVersion ? ` ${d.terminalVersion}` : ""}`
        process.stdout.write(`  ${label.padEnd(25)} `)

        try {
          const res = await fetch(`http://127.0.0.1:${d.port}/probe`, { signal: AbortSignal.timeout(120000) })
          if (!res.ok) {
            console.log(`\x1b[31m- HTTP ${res.status}\x1b[0m`)
            continue
          }
          const data = (await res.json()) as any
          const passed = Object.values(data.results).filter((v: any) => v).length
          const total = Object.keys(data.results).length
          const pct = Math.round((passed / total) * 100)
          const color = pct >= 98 ? "\x1b[32m" : pct >= 90 ? "\x1b[33m" : "\x1b[31m"
          console.log(`${color}${passed}/${total} (${pct}%)\x1b[0m`)

          const { mkdirSync, writeFileSync } = await import("node:fs")
          const dir = "content/probes-apps"
          mkdirSync(dir, { recursive: true })
          const name = data.terminal.toLowerCase().replace(/[^a-z0-9-]/g, "-")
          const ver = (data.terminalVersion || "unknown").replace(/[^a-z0-9.-]/g, "-")
          writeFileSync(`${dir}/${name}-${ver}-${data.os}.json`, JSON.stringify(data, null, 2))
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes("ECONNREFUSED")) {
            console.log(`\x1b[31m- not running (stale daemon file)\x1b[0m`)
          } else {
            console.log(`\x1b[31m- ${msg}\x1b[0m`)
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

    console.log(``)
    if (isNew) {
      console.log(`  \x1b[33;1m★ New terminal!\x1b[0m \x1b[1m${data.terminal.name}${data.terminal.version ? ` ${data.terminal.version}` : ""}\x1b[0m isn't on terminfo.dev yet.`)
      console.log(`  Help other developers by submitting your results:`)
      console.log(`  \x1b[1mnpx terminfo.dev submit\x1b[0m`)
    } else {
      console.log(`  \x1b[2mSubmit updated results: \x1b[0m\x1b[1mnpx terminfo.dev submit\x1b[0m`)
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
        rl.question(`  ${question} [\x1b[1m${defaultValue}\x1b[0m]: `, (answer) => {
          rl.close()
          resolve(answer.trim() || defaultValue)
        })
      })
    }

    name = await ask("Terminal name", name)
    version = await ask("Terminal version", version || "unknown")
    if (version === "unknown") version = ""

    if (!version) {
      console.log(`\n  \x1b[33m⚠ No version detected.\x1b[0m We need the version to accept submissions.`)
      console.log(`  Try: \x1b[1m${name} --version\x1b[0m or check your terminal's About menu.`)
      version = await ask("Terminal version", "")
      if (!version) {
        console.log(`\n  \x1b[31mCannot submit without a version. Exiting.\x1b[0m`)
        process.exit(1)
      }
    }

    console.log(`\n  Testing \x1b[1m${name} ${version}\x1b[0m on ${terminal.os}...\n`)

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
      console.log(`\x1b[32m+\x1b[0m Issue created: ${link(url, url)}`)
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

    console.log(`\n\x1b[1mterminfo detect\x1b[0m\n`)
    console.log(`  Terminal:  \x1b[1m${terminal.name}\x1b[0m${terminal.version ? ` ${terminal.version}` : ""}`)
    console.log(`  OS:        ${terminal.os} ${terminal.osVersion}`)
  })

program.parse()
