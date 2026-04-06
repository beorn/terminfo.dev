#!/usr/bin/env bun
/**
 * Validate terminfo.dev content data for consistency and completeness.
 *
 * Usage: bun scripts/validate.ts
 * Exit code: 1 if any errors, 0 otherwise
 */

import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, basename } from "node:path"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RED = "\x1b[31m"
const YELLOW = "\x1b[33m"
const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"
const RESET = "\x1b[0m"

function error(msg: string) {
  console.log(`  ${RED}ERROR${RESET} ${msg}`)
}

function warn(msg: string) {
  console.log(`  ${YELLOW}WARN${RESET}  ${msg}`)
}

function info(msg: string) {
  console.log(`  ${DIM}INFO${RESET}  ${msg}`)
}

function heading(title: string) {
  console.log(`\n${BOLD}${title}${RESET}`)
}

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"))
}

function listJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
}

// ---------------------------------------------------------------------------
// Load data
// ---------------------------------------------------------------------------

const contentDir = join(import.meta.dir, "..", "content")

const features = loadJson(join(contentDir, "features.json")) as Record<
  string,
  {
    name?: string
    slug?: string
    baseline?: string
    tags?: string[]
    body?: string
    probe?: string
    [key: string]: unknown
  }
>

const standards = loadJson(join(contentDir, "standards.json")) as Record<
  string,
  { label: string; [key: string]: unknown }
>

const categories = loadJson(join(contentDir, "categories.json")) as Record<
  string,
  { label: string; order: number; [key: string]: unknown }
>

const terminals = loadJson(join(contentDir, "terminals.json")) as Record<
  string,
  {
    label: string
    slug: string
    headlessBackends?: string[]
    [key: string]: unknown
  }
>

const annotations = loadJson(join(contentDir, "annotations.json")) as Record<string, { note: string; result?: string }>

const baselines = loadJson(join(contentDir, "baselines.json")) as Record<
  string,
  { label: string; [key: string]: unknown }
>

// Probe result files
const probeAppsDir = join(contentDir, "probes-apps")
const probeLibsDir = join(contentDir, "probes-libs")
const probeMuxDir = join(contentDir, "probes-mux")

const probeAppsFiles = listJsonFiles(probeAppsDir)
const probeLibsFiles = listJsonFiles(probeLibsDir)
const probeMuxFiles = listJsonFiles(probeMuxDir)

// Derived sets
const featureIds = new Set(Object.keys(features))
const standardKeys = new Set(Object.keys(standards))
const categoryKeys = new Set(Object.keys(categories))
const validTags = new Set([...standardKeys, ...categoryKeys])
const baselineKeys = new Set(Object.keys(baselines))

// Remove the $comment key if present
featureIds.delete("$comment")

let errors = 0
let warnings = 0

// ---------------------------------------------------------------------------
// ERRORS
// ---------------------------------------------------------------------------

heading("Errors (block deploy)")

// 1. Features with unknown tags
{
  let found = false
  for (const [id, feat] of Object.entries(features)) {
    if (id === "$comment") continue
    const tags = feat.tags ?? []
    for (const tag of tags) {
      if (!validTags.has(tag)) {
        error(`Feature "${id}" has unknown tag "${tag}" (not in standards.json or categories.json)`)
        errors++
        found = true
      }
    }
  }
  if (!found) info("All feature tags are valid")
}

// 2. Features missing required fields
{
  let found = false
  for (const [id, feat] of Object.entries(features)) {
    if (id === "$comment") continue
    const missing: string[] = []
    if (!feat.name) missing.push("name")
    if (!feat.slug) missing.push("slug")
    if (feat.baseline === undefined || feat.baseline === null) missing.push("baseline")
    if (missing.length > 0) {
      error(`Feature "${id}" missing required fields: ${missing.join(", ")}`)
      errors++
      found = true
    }
  }
  if (!found) info("All features have required fields")
}

// 3. Duplicate slugs within same category
{
  let found = false
  const slugsByCategory = new Map<string, Map<string, string>>()
  for (const [id, feat] of Object.entries(features)) {
    if (id === "$comment") continue
    const catPrefix = id.split(".")[0]!
    if (!slugsByCategory.has(catPrefix)) slugsByCategory.set(catPrefix, new Map())
    const catSlugs = slugsByCategory.get(catPrefix)!
    const slug = feat.slug
    if (slug && catSlugs.has(slug)) {
      error(`Duplicate slug "${slug}" in category "${catPrefix}": "${catSlugs.get(slug)}" and "${id}"`)
      errors++
      found = true
    } else if (slug) {
      catSlugs.set(slug, id)
    }
  }
  if (!found) info("No duplicate slugs within categories")
}

// 4. Category prefix mismatch
{
  let found = false
  for (const [id] of Object.entries(features)) {
    if (id === "$comment") continue
    const prefix = id.split(".")[0]!
    if (!categoryKeys.has(prefix)) {
      error(`Feature "${id}" has category prefix "${prefix}" not found in categories.json`)
      errors++
      found = true
    }
  }
  if (!found) info("All feature category prefixes match categories.json")
}

// ---------------------------------------------------------------------------
// WARNINGS
// ---------------------------------------------------------------------------

heading("Warnings (fix soon)")

// 5. Features with empty/missing tags
{
  let count = 0
  for (const [id, feat] of Object.entries(features)) {
    if (id === "$comment") continue
    if (!feat.tags || feat.tags.length === 0) {
      warn(`Feature "${id}" has no tags — won't appear on any standards page`)
      warnings++
      count++
    }
  }
  if (count === 0) info("All features have tags")
}

// 6. OSC features missing "osc" tag
{
  let count = 0
  for (const [id, feat] of Object.entries(features)) {
    if (id === "$comment") continue
    const name = (feat.name ?? "").toLowerCase()
    const slug = (feat.slug ?? "").toLowerCase()
    const isOsc = name.includes("osc") || slug.includes("osc") || id.toLowerCase().includes("osc")
    if (isOsc) {
      const tags = feat.tags ?? []
      if (!tags.includes("osc")) {
        warn(`Feature "${id}" appears to be OSC-related but missing "osc" tag`)
        warnings++
        count++
      }
    }
  }
  if (count === 0) info("All OSC features have the osc tag")
}

// 7. Terminals with no probe data
{
  // Collect all backend names from probe files
  const probeBackends = new Set<string>()

  // Apps: filename pattern is <terminal>-<version>-<os>.json; key field is "terminal"
  for (const f of probeAppsFiles) {
    try {
      const data = loadJson(join(probeAppsDir, f)) as { terminal?: string }
      if (data.terminal) probeBackends.add(data.terminal)
    } catch {}
  }

  // Libs: filename pattern is <backend>-<version>.json; key field is "backend"
  for (const f of probeLibsFiles) {
    try {
      const data = loadJson(join(probeLibsDir, f)) as { backend?: string }
      if (data.backend) probeBackends.add(data.backend)
    } catch {}
  }

  // Mux: filename pattern is <terminal>-<version>-<os>.json; key field is "terminal"
  for (const f of probeMuxFiles) {
    try {
      const data = loadJson(join(probeMuxDir, f)) as { terminal?: string }
      if (data.terminal) probeBackends.add(data.terminal)
    } catch {}
  }

  let count = 0
  for (const [id, term] of Object.entries(terminals)) {
    const backends = term.headlessBackends ?? []
    // A terminal has probe data if its ID or any of its headlessBackends appears in probe results
    const hasProbe = probeBackends.has(id) || backends.some((b) => probeBackends.has(b))
    if (!hasProbe) {
      warn(`Terminal "${id}" (${term.label}) has no probe data files`)
      warnings++
      count++
    }
  }
  if (count === 0) info("All terminals have probe data")
}

// 8. Probe data files with no matching terminal
{
  // Build a set of all known backend identifiers from terminals.json
  const knownBackends = new Set<string>()
  for (const [id, term] of Object.entries(terminals)) {
    knownBackends.add(id)
    for (const b of term.headlessBackends ?? []) {
      knownBackends.add(b)
    }
  }

  // Also add slug and manifestBackend if present
  for (const [, term] of Object.entries(terminals)) {
    if (term.slug) knownBackends.add(term.slug)
    if ((term as any).manifestBackend) knownBackends.add((term as any).manifestBackend)
  }

  let count = 0
  const allProbeFiles = [
    ...probeAppsFiles.map((f) => ({ file: f, dir: "probes-apps" })),
    ...probeLibsFiles.map((f) => ({ file: f, dir: "probes-libs" })),
    ...probeMuxFiles.map((f) => ({ file: f, dir: "probes-mux" })),
  ]

  for (const { file, dir } of allProbeFiles) {
    try {
      const fullPath = join(contentDir, dir, file)
      const data = loadJson(fullPath) as { terminal?: string; backend?: string }
      const backendName = data.terminal ?? data.backend
      if (backendName && !knownBackends.has(backendName)) {
        warn(`Probe file "${dir}/${file}" references "${backendName}" — no matching terminal in terminals.json`)
        warnings++
        count++
      }
    } catch {}
  }
  if (count === 0) info("All probe files match a terminal in terminals.json")
}

// 9. Features missing body text
{
  let count = 0
  for (const [id, feat] of Object.entries(features)) {
    if (id === "$comment") continue
    if (!feat.body || feat.body.trim().length === 0) {
      warn(`Feature "${id}" has no body text`)
      warnings++
      count++
    }
  }
  if (count === 0) info("All features have body text")
}

// 10. Features missing probe description
{
  let count = 0
  for (const [id, feat] of Object.entries(features)) {
    if (id === "$comment") continue
    if (!feat.probe || (feat.probe as string).trim().length === 0) {
      warn(`Feature "${id}" has no probe description`)
      warnings++
      count++
    }
  }
  if (count === 0) info("All features have probe descriptions")
}

// 11. Annotations referencing nonexistent features or backends
{
  // Build set of all backends from probe files + terminals.json
  const allBackends = new Set<string>()
  for (const [id, term] of Object.entries(terminals)) {
    allBackends.add(id)
    for (const b of term.headlessBackends ?? []) {
      allBackends.add(b)
    }
    if ((term as any).manifestBackend) allBackends.add((term as any).manifestBackend)
  }

  // Also add backends found in probe data (e.g. "ghostty-native")
  for (const f of probeLibsFiles) {
    try {
      const data = loadJson(join(probeLibsDir, f)) as { backend?: string }
      if (data.backend) allBackends.add(data.backend)
    } catch {}
  }
  for (const f of probeAppsFiles) {
    try {
      const data = loadJson(join(probeAppsDir, f)) as { terminal?: string }
      if (data.terminal) allBackends.add(data.terminal)
    } catch {}
  }
  for (const f of probeMuxFiles) {
    try {
      const data = loadJson(join(probeMuxDir, f)) as { terminal?: string }
      if (data.terminal) allBackends.add(data.terminal)
    } catch {}
  }

  let count = 0
  for (const key of Object.keys(annotations)) {
    const colonIdx = key.indexOf(":")
    if (colonIdx === -1) {
      warn(`Annotation key "${key}" doesn't follow "backend:feature" format`)
      warnings++
      count++
      continue
    }
    const backend = key.slice(0, colonIdx)
    const featureId = key.slice(colonIdx + 1)

    if (!allBackends.has(backend)) {
      warn(`Annotation "${key}" references unknown backend "${backend}"`)
      warnings++
      count++
    }
    if (!featureIds.has(featureId)) {
      warn(`Annotation "${key}" references unknown feature "${featureId}"`)
      warnings++
      count++
    }
  }
  if (count === 0) info("All annotations reference valid backends and features")
}

// 12. Tag/category ID collisions
{
  let count = 0
  for (const key of standardKeys) {
    if (categoryKeys.has(key) && key !== "unicode") {
      warn(`ID "${key}" appears in both standards.json and categories.json (collision)`)
      warnings++
      count++
    }
  }
  if (count === 0) info("No tag/category ID collisions (except known: unicode)")
}

// ---------------------------------------------------------------------------
// INFO
// ---------------------------------------------------------------------------

heading("Info (summary)")

// 13. Feature counts
{
  const featureCount = featureIds.size
  info(`Total features: ${featureCount}`)

  const perCategory = new Map<string, number>()
  for (const id of featureIds) {
    const prefix = id.split(".")[0]!
    perCategory.set(prefix, (perCategory.get(prefix) ?? 0) + 1)
  }
  const catEntries = [...perCategory.entries()].sort(
    (a, b) => (categories[a[0]]?.order ?? 99) - (categories[b[0]]?.order ?? 99),
  )
  for (const [cat, cnt] of catEntries) {
    info(`  ${cat}: ${cnt} features`)
  }

  const perTag = new Map<string, number>()
  for (const [id, feat] of Object.entries(features)) {
    if (id === "$comment") continue
    for (const tag of feat.tags ?? []) {
      perTag.set(tag, (perTag.get(tag) ?? 0) + 1)
    }
  }
  const tagEntries = [...perTag.entries()].sort((a, b) => b[1] - a[1])
  info(`Features per tag:`)
  for (const [tag, cnt] of tagEntries) {
    info(`  ${tag}: ${cnt}`)
  }
}

// 14. Terminal counts
{
  const termCount = Object.keys(terminals).length
  const probeBackends = new Set<string>()
  for (const f of probeAppsFiles) {
    try {
      const data = loadJson(join(probeAppsDir, f)) as { terminal?: string }
      if (data.terminal) probeBackends.add(data.terminal)
    } catch {}
  }
  for (const f of probeLibsFiles) {
    try {
      const data = loadJson(join(probeLibsDir, f)) as { backend?: string }
      if (data.backend) probeBackends.add(data.backend)
    } catch {}
  }
  for (const f of probeMuxFiles) {
    try {
      const data = loadJson(join(probeMuxDir, f)) as { terminal?: string }
      if (data.terminal) probeBackends.add(data.terminal)
    } catch {}
  }

  let withProbe = 0
  let withoutProbe = 0
  for (const [id, term] of Object.entries(terminals)) {
    const backends = term.headlessBackends ?? []
    const hasProbe = probeBackends.has(id) || backends.some((b) => probeBackends.has(b))
    if (hasProbe) withProbe++
    else withoutProbe++
  }

  info(`Total terminals: ${termCount}`)
  info(`  With probe data: ${withProbe}`)
  info(`  Without probe data: ${withoutProbe}`)
  info(`Probe files: ${probeAppsFiles.length} apps, ${probeLibsFiles.length} libs, ${probeMuxFiles.length} mux`)
}

// 15. Annotation coverage
{
  // Count total failure results across all probe files
  let totalFailures = 0
  let annotatedFailures = 0

  const allProbeFiles = [
    ...probeAppsFiles.map((f) => join(probeAppsDir, f)),
    ...probeLibsFiles.map((f) => join(probeLibsDir, f)),
    ...probeMuxFiles.map((f) => join(probeMuxDir, f)),
  ]

  for (const filePath of allProbeFiles) {
    try {
      const data = loadJson(filePath) as {
        terminal?: string
        backend?: string
        results: Record<string, boolean>
      }
      const backendName = data.terminal ?? data.backend ?? ""
      for (const [featureId, result] of Object.entries(data.results)) {
        if (result === false) {
          totalFailures++
          const annotationKey = `${backendName}:${featureId}`
          if (annotations[annotationKey]) {
            annotatedFailures++
          }
        }
      }
    } catch {}
  }

  const pct = totalFailures > 0 ? ((annotatedFailures / totalFailures) * 100).toFixed(1) : "N/A"
  info(`Annotation coverage: ${annotatedFailures}/${totalFailures} failures annotated (${pct}%)`)
  info(`Total annotations: ${Object.keys(annotations).length}`)
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log()
if (errors > 0) {
  console.log(
    `${RED}${BOLD}${errors} error${errors === 1 ? "" : "s"}${RESET}, ${YELLOW}${warnings} warning${warnings === 1 ? "" : "s"}${RESET}`,
  )
} else if (warnings > 0) {
  console.log(`${DIM}0 errors${RESET}, ${YELLOW}${warnings} warning${warnings === 1 ? "" : "s"}${RESET}`)
} else {
  console.log(`${DIM}0 errors, 0 warnings${RESET}`)
}

process.exit(errors > 0 ? 1 : 0)
