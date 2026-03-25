#!/usr/bin/env bun
/**
 * terminfo.dev CLI — can your terminal do that?
 *
 * npm-published CLI for end users. Supports inline probing, daemon mode,
 * submission, and terminal detection.
 *
 * @example
 * ```bash
 * npx terminfo.dev                     # show help
 * npx terminfo.dev probe here          # probe this terminal
 * npx terminfo.dev probe here --json   # machine output
 * npx terminfo.dev probe server --start     # start daemon
 * npx terminfo.dev probe server --all       # probe all daemons
 * npx terminfo.dev submit              # probe + submit to terminfo.dev
 * npx terminfo.dev detect              # what terminal am I in?
 * ```
 */

import { Command } from "commander"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { detectTerminal } from "./detect.ts"
import { ALL_PROBES } from "./probes/index.ts"
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
      for (const [id, entry] of Object.entries(raw)) {
        slugs[id] = entry.slug ?? id.replaceAll(".", "-")
      }
      return slugs
    } catch {}
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
    `  Probes:    ${ALL_PROBES.length} features across ${new Set(ALL_PROBES.map((p) => p.id.split(".")[0])).size} categories`,
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
    const catLink = link(`https://terminfo.dev/${cat}`, cat)
    console.log(`${color}${catLink}\x1b[0m (${catPassed}/${probes.length})`)
    for (const p of probes) {
      const icon = p.pass ? "\x1b[32m+\x1b[0m" : "\x1b[31m-\x1b[0m"
      const note = p.note ? ` \x1b[2m— ${p.note}\x1b[0m` : ""
      const slug = slugs[p.id] ?? p.id.replaceAll(".", "-")
      const fCat = p.id.split(".")[0]!
      const featureLink = link(`https://terminfo.dev/${fCat}/${slug}`, p.name)
      console.log(`  ${icon} ${featureLink}${note}`)
    }
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
  console.log(`  \x1b[1mprobe here\x1b[0m            Probe this terminal inline`)
  console.log(`  \x1b[1mprobe here --json\x1b[0m     Machine-readable output`)
  console.log(`  \x1b[1mprobe server --start\x1b[0m  Start daemon for remote testing`)
  console.log(`  \x1b[1mprobe server --all\x1b[0m    Probe all running daemons`)
  console.log(`  \x1b[1msubmit\x1b[0m                Probe + submit to terminfo.dev`)
  console.log(`  \x1b[1mdetect\x1b[0m                Detect current terminal`)
  console.log(``)
  console.log(`Options:`)
  console.log(`  \x1b[1m--help\x1b[0m     Show this help`)
  console.log(`  \x1b[1m--version\x1b[0m  Show version`)
})

// ── probe ──

const probe = program
  .command("probe")
  .description("Run terminal probes")
  .action(() => {
    console.log(`\x1b[1mterminfo probe\x1b[0m — probe mechanisms\n`)
    console.log(`  \x1b[1mhere\x1b[0m        Probe this terminal inline`)
    console.log(`              \x1b[2m$ terminfo probe here\x1b[0m`)
    console.log(`              \x1b[2m$ terminfo probe here --json\x1b[0m\n`)
    console.log(`  \x1b[1mserver\x1b[0m      Start a daemon or probe running daemons`)
    console.log(`              \x1b[2m$ terminfo probe server --start\x1b[0m`)
    console.log(`              \x1b[2m$ terminfo probe server --all\x1b[0m`)
  })

// ── probe here ──

probe
  .command("here")
  .description("Probe this terminal inline")
  .option("--json", "Output results as JSON")
  .action(async (opts) => {
    const data = await runProbes()

    if (opts.json) {
      console.log(
        JSON.stringify(
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
        ),
      )
      return
    }

    printResults(data)
    console.log(`\n\x1b[2mSubmit results: \x1b[0m\x1b[1mterminfo submit\x1b[0m`)
  })

// ── probe server ──

const probeServer = probe
  .command("server [daemon]")
  .description("Start a daemon or probe running daemons")
  .option("--start", "Start daemon in this terminal")
  .option("-p, --port <port>", "Port for --start", parseInt)
  .option("--all", "Probe all running daemons")

probeServer.action(async (daemon: string | undefined, opts) => {
  if (opts.start) {
    const { startDaemon } = await import("./serve.ts")
    await startDaemon(opts.port ?? 0)
    return
  }

  const { listDaemons } = await import("./serve.ts")
  const daemons = listDaemons()

  if (!opts.all && !daemon) {
    // Bare: list running daemons
    if (daemons.length === 0) {
      console.log(`\nNo daemons running.\n`)
      console.log(`Start one: \x1b[1mterminfo probe server --start\x1b[0m`)
      return
    }

    console.log(`\n\x1b[1m${daemons.length} daemon(s) running:\x1b[0m\n`)
    for (const d of daemons) {
      const label = `${d.terminal}${d.terminalVersion ? ` ${d.terminalVersion}` : ""}`
      console.log(`  ${label.padEnd(25)} port ${d.port}  (pid ${d.pid})`)
    }
    console.log(`\nProbe all: \x1b[1mterminfo probe server --all\x1b[0m`)
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
      console.error(`No daemon found matching "${daemon}".`)
      if (daemons.length > 0) {
        console.error(`Running: ${daemons.map((d) => d.terminal).join(", ")}`)
      } else {
        console.error(`No daemons running. Start one: terminfo probe server --start`)
      }
      process.exit(1)
    }
  }

  if (targets.length === 0) {
    console.log(`\x1b[33mNo daemons found.\x1b[0m`)
    console.log(`Start a daemon in each terminal: \x1b[1mterminfo probe server --start\x1b[0m`)
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

      // Save results
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
})

// ── submit ──

program
  .command("submit")
  .description("Run all probes and submit results to terminfo.dev via GitHub issue")
  .option("--terminal-name <name>", "Override detected terminal name")
  .option("--terminal-version <version>", "Override detected terminal version")
  .action(async (opts) => {
    // Confirm details BEFORE probes (stdin is still clean)
    const terminal = detectTerminal()
    let name = opts.terminalName ?? terminal.name
    let version = opts.terminalVersion ?? terminal.version

    printHeader(terminal)
    console.log(``)

    // Let user confirm/edit terminal info before running probes
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

    console.log(``)
    console.log(`  Submitting as \x1b[1m${name}${version ? ` ${version}` : ""}\x1b[0m on ${terminal.os}`)

    const rl2 = createInterface({ input: process.stdin, output: process.stdout })
    await new Promise<void>((resolve) => {
      rl2.question(`  Press Enter to run probes (Ctrl+C to cancel) `, () => {
        rl2.close()
        resolve()
      })
    })

    // Now run probes (stdin goes to raw mode, no conflict)
    const data = await runProbes()
    printResults(data)

    console.log(`\nSubmitting results to terminfo.dev...`)
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
