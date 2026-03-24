#!/usr/bin/env bun
/**
 * terminfo.dev CLI — can your terminal do that?
 *
 * Test your terminal's feature support and contribute results to terminfo.dev.
 *
 * @example
 * ```bash
 * npx terminfo.dev           # Show terminal info + help
 * npx terminfo.dev probe     # Run all probes
 * npx terminfo.dev submit    # Run probes + submit results
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
  const candidates = [join(__dirname, "..", "..", "features.json"), join(__dirname, "..", "..", "..", "features.json")]
  for (const path of candidates) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8"))
      delete raw.$comment
      const slugs: Record<string, string> = {}
      for (const [id, entry] of Object.entries(raw) as [string, any][]) {
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

  await withRawMode(async () => {
    process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H")
    for (const probe of ALL_PROBES) {
      process.stdout.write("\x1b[2J\x1b[H")
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
    // Reset all SGR attributes + drain pending responses before exiting alt screen
    process.stdout.write("\x1b[0m\x1b[2J\x1b[H")
    await drainStdin(500)
    process.stdout.write("\x1b[?1049l")
  })

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
      const icon = p.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"
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
  .name("terminfo.dev")
  .description("Can your terminal do that? — test terminal feature support and contribute to terminfo.dev")
  .version("1.1.0")

program
  .command("probe")
  .description("Run all probes against your terminal and display results")
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
    console.log(`\n\x1b[2mContribute these results: \x1b[0m\x1b[1mnpx terminfo.dev submit\x1b[0m`)
  })

program
  .command("submit")
  .description("Run all probes and submit results to terminfo.dev via GitHub issue")
  .option("--terminal-name <name>", "Override detected terminal name")
  .option("--terminal-version <version>", "Override detected terminal version")
  .action(async (opts) => {
    // Confirm details BEFORE probes (stdin is still clean)
    const terminal = detectTerminal()
    const name = opts.terminalName ?? terminal.name
    const version = opts.terminalVersion ?? terminal.version

    printHeader(terminal)
    console.log(``)
    console.log(`  Will submit results for \x1b[1m${name}${version ? ` ${version}` : ""}\x1b[0m on ${terminal.os}`)
    if (!version) {
      console.log(`  \x1b[33m⚠ No version detected. Use --terminal-version to specify.\x1b[0m`)
    }

    const { createInterface } = await import("node:readline")
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const proceed = await new Promise<string>((resolve) => {
      rl.question(`\n  Press Enter to run probes and submit (or Ctrl+C to cancel) `, (answer) => {
        rl.close()
        resolve(answer)
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
      cliVersion: "1.6.0",
      probeCount: ALL_PROBES.length,
    })
    if (url) {
      console.log(`\x1b[32m✓ Issue created:\x1b[0m ${link(url, url)}`)
    }
  })

// Default action: show terminal info + help
program.action(() => {
  const terminal = detectTerminal()
  printHeader(terminal)
  console.log(``)
  console.log(`\x1b[2mTest your terminal against ${ALL_PROBES.length} features from the ECMA-48,`)
  console.log(`VT100/VT510, xterm, and Kitty specifications. Results can be`)
  console.log(`submitted to the community database at terminfo.dev.\x1b[0m`)
  console.log(``)
  console.log(`Commands:`)
  console.log(`  \x1b[1mprobe\x1b[0m    Run all probes and display results`)
  console.log(`  \x1b[1msubmit\x1b[0m   Run probes and submit to terminfo.dev`)
  console.log(``)
  console.log(`Options:`)
  console.log(`  \x1b[1m--json\x1b[0m   Output results as JSON (with probe command)`)
  console.log(`  \x1b[1m--help\x1b[0m   Show this help`)
})

program.parse()
