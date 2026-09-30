#!/usr/bin/env bun
/**
 * Sync probeStatus in features.json from probe definitions.
 *
 * Logic:
 * - Explicit partial/manual/unprobed statuses remain reviewed metadata
 * - A default/automated feature with null termless callback becomes partial
 * - Explicit automated with a termless callback uses the default (remove the field)
 * - Features without probe definitions keep their current probeStatus
 *
 * Usage: bun scripts/sync-probe-status.ts [--dry-run]
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseJsonStrict } from "@terminfo/run-parser"
import { ALL_PROBES } from "../packages/probe-defs/src/index.ts"

const ROOT = import.meta.dirname ? join(import.meta.dirname, "..") : join(process.cwd())
const FEATURES_PATH = join(ROOT, "content/features.json")

const DIM = "\x1b[2m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
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
const parsed = parseJsonStrict(FEATURES_PATH, raw)
if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
  throw new Error(`${FEATURES_PATH}: expected a feature metadata object`)
}
for (const [id, feature] of Object.entries(parsed)) {
  if (id === "$comment") continue
  if (feature === null || typeof feature !== "object" || Array.isArray(feature)) {
    throw new Error(`${FEATURES_PATH}: ${id}: expected a feature metadata object`)
  }
}
const features = parsed as Record<string, Record<string, unknown>>

let downgraded = 0 // automated → partial (set probeStatus)
let normalized = 0 // explicit automated → implicit default
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

  const hasTermless = probeTermlessMap.get(id) === true
  if (currentStatus === "automated" && !hasTermless) {
    // Preserve the old default fallback when no headless callback exists.
    feature.probeStatus = "partial"
    downgraded++
    changes.push(`${YELLOW}${id}: automated → partial (termless callback is null)${RESET}`)
  } else if (feature.probeStatus === "automated" && hasTermless) {
    delete feature.probeStatus
    normalized++
    changes.push(`${DIM}${id}: removed explicit "automated" (is default)${RESET}`)
  } else {
    unchanged++
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
  `  ${GREEN}${normalized} normalized to default automated${RESET}, ` +
    `${YELLOW}${downgraded} set to partial${RESET}, ` +
    `${unchanged} unchanged, ` +
    `${DIM}${skipped} skipped (no probe def)${RESET}`,
)

// Verify counts
const totalWithProbes = Object.keys(features).filter((k) => k !== "$comment" && probeTermlessMap.has(k)).length
const finalStatuses = Object.entries(features)
  .filter(([id]) => id !== "$comment" && probeTermlessMap.has(id))
  .map(([, feature]) => feature.probeStatus ?? "automated")
const count = (status: string) => finalStatuses.filter((value) => value === status).length

console.log(
  `\n  ${DIM}Final: ${count("automated")} automated, ${count("partial")} partial, ${count("manual")} manual, ${count("unprobed")} unprobed (of ${totalWithProbes} with probes)${RESET}`,
)

// Write
if (changes.length > 0) {
  if (dryRun) {
    console.log(`\n  ${YELLOW}--dry-run: no changes written${RESET}`)
  } else {
    writeFileSync(FEATURES_PATH, JSON.stringify(features, null, 2) + "\n")
    console.log(`\n  ${GREEN}Written to ${FEATURES_PATH}${RESET}`)
  }
} else {
  console.log(`\n  ${DIM}No changes needed${RESET}`)
}
