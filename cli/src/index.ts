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

  // Build category data for report
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

  // Render with silvery
  const { renderReport } = await import("./report.tsx")
  const output = await renderReport({
    terminal: terminal.name,
    terminalVersion: terminal.version,
    os: terminal.os,
    osVersion: terminal.osVersion,
    probeCount: total,
    categoryCount: new Set(ALL_PROBES.map(p => p.id.split(".")[0])).size,
    passed,
    total,
    categories,
    slugs,
    submitMode,
  })
  console.log(output)

  if (submitMode) {
    console.log(`\nSubmitting results to terminfo.dev...`)
    const url = await submitResults(entry)
    if (url) {
      console.log(`\x1b[32m✓ Issue created:\x1b[0m ${url}`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
