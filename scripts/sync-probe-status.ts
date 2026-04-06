#!/usr/bin/env bun
/**
 * Sync probeStatus in features.json from probe definitions.
 *
 * Logic:
 * - Non-null termless callback → "automated" (default — remove the field)
 * - Null termless callback → "partial"
 * - Features without probe definitions keep their current probeStatus
 *
 * Usage: bun scripts/sync-probe-status.ts [--dry-run]
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ALL_PROBES } from "../packages/probe-defs/src/index.ts"

const ROOT = import.meta.dirname ? join(import.meta.dirname, "..") : join(process.cwd())
const FEATURES_PATH = join(ROOT, "content/features.json")

const DIM = "\x1b[2m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const RED = "\x1b[31m"
const BOLD = "\x1b[1m"
const RESET = "\x1b[0m"

const dryRun = process.argv.includes("--dry-run")

// Build a map: probe ID → whether termless is non-null
const probeTermlessMap = new Map<string, boolean>()
for (const probe of ALL_PROBES) {
  probeTermlessMap.set(probe.id, probe.termless !== null)
}

// Read features.json
const raw = readFileSync(FEATURES_PATH, "utf-8")
const features = JSON.parse(raw) as Record<string, Record<string, unknown>>

let upgraded = 0 // partial → automated (remove probeStatus)
let downgraded = 0 // automated → partial (set probeStatus)
let unchanged = 0
let skipped = 0 // no probe definition (manual/unprobed — keep as-is)
const changes: string[] = []

for (const [id, feature] of Object.entries(features)) {
  if (id === "$comment") continue

  const hasProbe = probeTermlessMap.has(id)
  const currentStatus = (feature.probeStatus as string) ?? "automated"

  if (!hasProbe) {
    // No probe definition — keep current status (manual, unprobed, etc.)
    skipped++
    continue
  }

  const hasTermless = probeTermlessMap.get(id)!
  const targetStatus = hasTermless ? "automated" : "partial"

  if (currentStatus === targetStatus) {
    // Already correct — but clean up: if "automated" is explicit, remove it
    if (feature.probeStatus === "automated") {
      delete feature.probeStatus
      changes.push(`${DIM}${id}: removed explicit "automated" (is default)${RESET}`)
    }
    unchanged++
    continue
  }

  if (targetStatus === "automated" && currentStatus === "partial") {
    // Upgrade: probe now has termless → remove probeStatus field
    delete feature.probeStatus
    upgraded++
    changes.push(`${GREEN}${id}: partial → automated (termless callback added)${RESET}`)
  } else if (targetStatus === "partial" && currentStatus === "automated") {
    // Downgrade: probe has null termless → set partial
    feature.probeStatus = "partial"
    downgraded++
    changes.push(`${YELLOW}${id}: automated → partial (termless callback is null)${RESET}`)
  }
}

// Report
console.log(`\n${BOLD}Probe status sync${RESET}\n`)
console.log(`  Probe definitions: ${probeTermlessMap.size}`)
console.log(`  Features in JSON:  ${Object.keys(features).filter((k) => k !== "$comment").length}`)
console.log()

if (changes.length > 0) {
  console.log(`${BOLD}Changes:${RESET}`)
  for (const c of changes) console.log(`  ${c}`)
  console.log()
}

console.log(
  `  ${GREEN}${upgraded} upgraded to automated${RESET}, ` +
    `${YELLOW}${downgraded} set to partial${RESET}, ` +
    `${unchanged} unchanged, ` +
    `${DIM}${skipped} skipped (no probe def)${RESET}`,
)

// Verify counts
const totalWithProbes = Object.keys(features).filter((k) => k !== "$comment" && probeTermlessMap.has(k)).length
const automatedCount = Object.keys(features).filter(
  (k) => k !== "$comment" && probeTermlessMap.has(k) && probeTermlessMap.get(k) === true,
).length
const partialCount = Object.keys(features).filter(
  (k) => k !== "$comment" && probeTermlessMap.has(k) && probeTermlessMap.get(k) === false,
).length

console.log(
  `\n  ${DIM}Final: ${automatedCount} automated, ${partialCount} partial (of ${totalWithProbes} with probes)${RESET}`,
)

// Write
if (upgraded > 0 || downgraded > 0 || changes.length > 0) {
  if (dryRun) {
    console.log(`\n  ${YELLOW}--dry-run: no changes written${RESET}`)
  } else {
    writeFileSync(FEATURES_PATH, JSON.stringify(features, null, 2) + "\n")
    console.log(`\n  ${GREEN}Written to ${FEATURES_PATH}${RESET}`)
  }
} else {
  console.log(`\n  ${DIM}No changes needed${RESET}`)
}
