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

import { detectTerminal } from "./detect.ts"
import { ALL_PROBES, type ProbeResult } from "./probes/index.ts"
import { withRawMode } from "./tty.ts"

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
    console.log(`\x1b[1mterminfo\x1b[0m — terminal feature testing for terminfo.dev\n`)
    console.log(
      `Detected: \x1b[1m${terminal.name}\x1b[0m${terminal.version ? ` ${terminal.version}` : ""} on ${terminal.os}${terminal.osVersion ? ` ${terminal.osVersion}` : ""}`,
    )
    console.log(`Running ${ALL_PROBES.length} probes...\n`)
  }

  // Save/restore screen state
  process.stdout.write("\x1b7") // save cursor
  process.stdout.write("\x1b[?1049h") // alt screen
  process.stdout.write("\x1b[2J\x1b[H") // clear + home

  const results: Record<string, boolean> = {}
  const notes: Record<string, string> = {}
  const responses: Record<string, string> = {}
  let passed = 0
  let failed = 0

  await withRawMode(async () => {
    for (const probe of ALL_PROBES) {
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
  })

  // Restore screen
  process.stdout.write("\x1b[?1049l") // exit alt screen
  process.stdout.write("\x1b8") // restore cursor

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

  // Show categories
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
    console.log(`${color}${cat}\x1b[0m (${catPassed}/${probes.length})`)
    for (const p of probes) {
      const icon = p.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"
      const note = p.note ? ` \x1b[2m— ${p.note}\x1b[0m` : ""
      console.log(`  ${icon} ${p.name}${note}`)
    }
  }

  console.log(`\n\x1b[2mSubmit results to terminfo.dev: npx terminfo --submit\x1b[0m`)
  console.log(`\x1b[2mJSON output: npx terminfo --json\x1b[0m`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
