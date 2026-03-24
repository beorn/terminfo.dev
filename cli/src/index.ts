#!/usr/bin/env bun
/**
 * terminfo CLI — test your terminal's feature support.
 *
 * Runs probes against the real terminal you're using (not a headless library),
 * shows results, and optionally submits them to terminfo.dev.
 *
 * @example
 * ```bash
 * npx terminfo          # Run all probes
 * npx terminfo --json   # Output JSON results
 * npx terminfo --submit # Submit results to terminfo.dev
 * ```
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { detectTerminal } from "./detect.ts"
import { ALL_PROBES } from "./probes/index.ts"
import { withRawMode } from "./tty.ts"
import { submitResults } from "./submit.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Load feature slugs from features.json for OSC 8 hyperlinks */
function loadFeatureSlugs(): Record<string, string> {
  // Try repo-local path first, then npm-installed path
  const candidates = [
    join(__dirname, "..", "..", "features.json"),       // repo: cli/src/ -> features.json
    join(__dirname, "..", "..", "..", "features.json"),  // npm: node_modules/terminfo.dev/src/ -> features.json
  ]
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
  return {} // fallback: featureSlug() will use id.replaceAll(".", "-")
}

/** OSC 8 hyperlink — clickable link in supporting terminals */
function link(url: string, text: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`
}

interface ResultEntry {
  terminal: string
  terminalVersion: string
  os: string
  osVersion: string
  source: "community"
  generated: string
  results: Record<string, boolean>
  notes: Record<string, string>
  responses: Record<string, string>
}

async function main() {
  const args = process.argv.slice(2)
  const jsonMode = args.includes("--json")
  const submitMode = args.includes("--submit")

  // Detect terminal
  const terminal = detectTerminal()

  if (!jsonMode) {
    console.log(`\x1b[1mterminfo.dev\x1b[0m — can your terminal do that?\n`)
    console.log(`  Terminal:  \x1b[1m${terminal.name}\x1b[0m${terminal.version ? ` ${terminal.version}` : ""}`)
    console.log(`  Platform:  ${terminal.os}${terminal.osVersion ? ` ${terminal.osVersion}` : ""}`)
    console.log(`  Probes:    ${ALL_PROBES.length} features across ${new Set(ALL_PROBES.map(p => p.id.split(".")[0])).size} categories`)
    console.log(`  Website:   https://terminfo.dev`)
    console.log(``)
    console.log(`\x1b[2mResults are compared against ${ALL_PROBES.length} terminal features from the`)
    console.log(`ECMA-48, VT100/VT510, xterm, and Kitty specifications.`)
    console.log(`Run with --submit to contribute your results to the database.\x1b[0m\n`)
    console.log(`Running probes...`)
  }

  const results: Record<string, boolean> = {}
  const notes: Record<string, string> = {}
  const responses: Record<string, string> = {}
  let passed = 0
  let failed = 0

  await withRawMode(async () => {
    // Enter alt screen inside raw mode so all probe output stays contained
    process.stdout.write("\x1b[?1049h") // alt screen
    process.stdout.write("\x1b[2J\x1b[H") // clear + home

    for (const probe of ALL_PROBES) {
      // Clear screen before each probe to prevent leaking output
      process.stdout.write("\x1b[2J\x1b[H")
      try {
        const result = await probe.run()
        results[probe.id] = result.pass
        if (result.note) notes[probe.id] = result.note
        if (result.response) responses[probe.id] = result.response
        if (result.pass) passed++
        else failed++
      } catch (err) {
        results[probe.id] = false
        notes[probe.id] = `error: ${err instanceof Error ? err.message : String(err)}`
        failed++
      }
    }

    // Exit alt screen while still in raw mode
    process.stdout.write("\x1b[?1049l")
  })

  const total = ALL_PROBES.length
  const pct = Math.round((passed / total) * 100)

  const entry: ResultEntry = {
    terminal: terminal.name,
    terminalVersion: terminal.version,
    os: terminal.os,
    osVersion: terminal.osVersion,
    source: "community",
    generated: new Date().toISOString(),
    results,
    notes,
    responses,
  }

  if (jsonMode) {
    console.log(JSON.stringify(entry, null, 2))
    return
  }

  // Display results
  console.log(`\n\x1b[1mResults: ${passed}/${total} (${pct}%)\x1b[0m\n`)

  // Show categories with OSC 8 hyperlinks
  const slugs = loadFeatureSlugs()
  const categories = new Map<string, Array<{ id: string; name: string; pass: boolean; note?: string }>>()
  for (const probe of ALL_PROBES) {
    const cat = probe.id.split(".")[0]!
    if (!categories.has(cat)) categories.set(cat, [])
    categories.get(cat)!.push({
      id: probe.id,
      name: probe.name,
      pass: results[probe.id] ?? false,
      note: notes[probe.id],
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
      const cat = p.id.split(".")[0]!
      const featureLink = link(`https://terminfo.dev/${cat}/${slug}`, p.name)
      console.log(`  ${icon} ${featureLink}${note}`)
    }
  }

  if (submitMode) {
    console.log(`\nSubmitting results to terminfo.dev...`)
    const url = await submitResults(entry)
    if (url) {
      console.log(`\x1b[32m✓ Issue created:\x1b[0m ${url}`)
    }
  } else {
    console.log(`\n\x1b[2mSubmit results to terminfo.dev: npx terminfo --submit\x1b[0m`)
    console.log(`\x1b[2mJSON output: npx terminfo --json\x1b[0m`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
