#!/usr/bin/env bun
/**
 * Validate terminfo.dev content data for consistency and completeness.
 *
 * Usage: bun scripts/validate.ts
 * Exit code: 1 if any errors, 0 otherwise
 */

import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { verifyTerminalIdentity } from "../packages/terminfo.dev/src/identity-guard.ts"
import { loadCategories } from "../docs/data/categories.ts"

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
    probeStatus?: string
    [key: string]: unknown
  }
>

const VALID_PROBE_STATUSES = new Set(["automated", "partial", "manual", "unprobed"])
const MIN_FEATURE_BODY_LENGTH = 260

const standards = loadJson(join(contentDir, "standards.json")) as Record<
  string,
  { label: string; [key: string]: unknown }
>

const categories = loadCategories(contentDir)

const terminals = loadJson(join(contentDir, "terminals.json")) as Record<
  string,
  {
    label: string
    slug: string
    description?: string
    body?: string
    headlessBackends?: string[]
    manifestBackend?: string
    [key: string]: unknown
  }
>

const platforms = loadJson(join(contentDir, "platforms.json")) as Record<
  string,
  {
    label?: string
    slug?: string
    tagline?: string
    description?: string
    appTerminalIds?: string[]
    parserBackendIds?: string[]
    multiplexerIds?: string[]
    untrackedTerminals?: Array<{ label?: string; url?: string; type?: string; note?: string }>
    notes?: string[]
    sources?: Array<{ label?: string; url?: string }>
    [key: string]: unknown
  }
>

const annotations = loadJson(join(contentDir, "annotations.json")) as Record<string, { note: string; result?: string }>

// Baseline metadata is a required input even though this validator has no baseline-specific checks.
void loadJson(join(contentDir, "baselines.json"))

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
const platformKeys = new Set(Object.keys(platforms).filter((k) => k !== "$comment"))
const knownPlatformKeys = new Set(["macos", "linux", "windows"])

// Remove the $comment key if present
featureIds.delete("$comment")

let errors = 0
let warnings = 0

// ---------------------------------------------------------------------------
// ERRORS
// ---------------------------------------------------------------------------

heading("Errors (block deploy)")

type ProbeFile = {
  file: string
  dir: "probes-apps" | "probes-libs" | "probes-mux"
  backendName?: string
  data: {
    schemaVersion?: number
    terminal?: string
    backend?: string
    target?: unknown
    responses?: Record<string, string>
    results?: Record<string, boolean>
  }
}

// Parse every measured input once before producing any derived validation summary.
const probeFiles: ProbeFile[] = []
for (const [dir, files] of [
  ["probes-apps", probeAppsFiles],
  ["probes-libs", probeLibsFiles],
  ["probes-mux", probeMuxFiles],
] as const) {
  for (const file of files) {
    try {
      const data = loadJson(join(contentDir, dir, file))
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("expected a JSON object")
      }
      const probe = data as ProbeFile["data"]
      if (probe.schemaVersion !== undefined && probe.schemaVersion !== 2) {
        throw new Error(`unsupported schemaVersion ${String(probe.schemaVersion)}`)
      }
      if (
        probe.schemaVersion === undefined &&
        (probe.results === null || typeof probe.results !== "object" || Array.isArray(probe.results))
      ) {
        throw new Error("legacy probe results must be a JSON object")
      }
      if (probe.schemaVersion === undefined && probe.responses !== undefined) {
        const responses: unknown = probe.responses
        if (
          responses === null ||
          typeof responses !== "object" ||
          Array.isArray(responses) ||
          !Object.values(responses as Record<string, unknown>).every((value) => typeof value === "string")
        ) {
          throw new Error("legacy identity responses must be string values in a JSON object")
        }
      }
      let backendName: string | undefined
      if (probe.schemaVersion === 2) {
        const target = probe.target
        if (target === null || typeof target !== "object" || Array.isArray(target)) {
          throw new Error("v2 target must be a JSON object")
        }
        const expectedKind = dir === "probes-libs" ? "headless" : dir === "probes-apps" ? "app" : "mux"
        if ((target as Record<string, unknown>).kind !== expectedKind) {
          throw new Error(`v2 target.kind must be "${expectedKind}" in ${dir}`)
        }
        const id = (target as Record<string, unknown>).id
        if (typeof id !== "string" || id.trim().length === 0) {
          throw new Error("v2 target.id must be a nonempty string")
        }
        backendName = id
      } else {
        backendName = dir === "probes-libs" ? (probe.backend ?? probe.terminal) : (probe.terminal ?? probe.backend)
      }
      probeFiles.push({ file, dir, backendName, data: probe })
    } catch (cause) {
      error(
        `Probe file "${dir}/${file}" could not be parsed: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
      errors++
    }
  }
}
if (errors > 0) process.exit(1)

const probeBackends = new Set<string>()
for (const { backendName } of probeFiles) {
  if (backendName) probeBackends.add(backendName)
}

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
    const catPrefix = id.split(".")[0] ?? ""
    let catSlugs = slugsByCategory.get(catPrefix)
    if (!catSlugs) {
      catSlugs = new Map()
      slugsByCategory.set(catPrefix, catSlugs)
    }
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
    const prefix = id.split(".")[0] ?? ""
    if (!categoryKeys.has(prefix)) {
      error(`Feature "${id}" has category prefix "${prefix}" not found in categories.json`)
      errors++
      found = true
    }
  }
  if (!found) info("All feature category prefixes match categories.json")
}

// 4b. Invalid probeStatus values
{
  let found = false
  for (const [id, feat] of Object.entries(features)) {
    if (id === "$comment") continue
    if (feat.probeStatus !== undefined && !VALID_PROBE_STATUSES.has(feat.probeStatus)) {
      error(
        `Feature "${id}" has invalid probeStatus "${feat.probeStatus}" (must be one of: ${[...VALID_PROBE_STATUSES].join(", ")})`,
      )
      errors++
      found = true
    }
  }
  if (!found) info("All feature probeStatus values are valid")
}

// 4c. Duplicate feature names (same display name, different IDs)
{
  let found = false
  const nameToId = new Map<string, string>()
  for (const [id, feat] of Object.entries(features)) {
    if (id === "$comment") continue
    const name = feat.name
    if (!name) continue
    if (nameToId.has(name)) {
      error(`Duplicate feature name "${name}": "${nameToId.get(name)}" and "${id}" — merge or rename`)
      errors++
      found = true
    } else {
      nameToId.set(name, id)
    }
  }
  if (!found) info("No duplicate feature names")
}

// 4d. Terminals missing description or body
{
  let found = false
  for (const [id, term] of Object.entries(terminals)) {
    const missing: string[] = []
    if (!term.label) missing.push("label")
    if (!term.slug) missing.push("slug")
    const desc = term.description ?? ""
    const body = term.body ?? ""
    if (desc.length < 10) missing.push("description")
    if (body.length < 20) missing.push("body")
    if (missing.length > 0) {
      error(`Terminal "${id}" (${term.label}) missing content: ${missing.join(", ")}`)
      errors++
      found = true
    }
  }
  if (!found) info("All terminals have description and body content")
}

// 4e. Platform pages reference valid terminal metadata
{
  let found = false
  const terminalKeys = new Set(Object.keys(terminals))

  for (const [id, platform] of Object.entries(platforms)) {
    if (id === "$comment") continue
    const missing: string[] = []
    if (!knownPlatformKeys.has(id)) missing.push("known platform id")
    if (!platform.label) missing.push("label")
    if (!platform.slug) missing.push("slug")
    if (platform.slug && platform.slug !== id) missing.push("slug must match id")
    if (!platform.tagline) missing.push("tagline")
    if (!platform.description) missing.push("description")
    if (!Array.isArray(platform.appTerminalIds)) missing.push("appTerminalIds")
    if (!Array.isArray(platform.parserBackendIds)) missing.push("parserBackendIds")
    if (!Array.isArray(platform.multiplexerIds)) missing.push("multiplexerIds")
    if (!Array.isArray(platform.sources) || platform.sources.length === 0) missing.push("sources")

    if (missing.length > 0) {
      error(`Platform "${id}" missing or invalid fields: ${missing.join(", ")}`)
      errors++
      found = true
    }

    const seen = new Set<string>()
    for (const section of ["appTerminalIds", "parserBackendIds", "multiplexerIds"] as const) {
      for (const terminalId of platform[section] ?? []) {
        if (!terminalKeys.has(terminalId)) {
          error(`Platform "${id}" ${section} references unknown terminal "${terminalId}"`)
          errors++
          found = true
        }
        if (seen.has(terminalId)) {
          error(`Platform "${id}" lists terminal "${terminalId}" more than once`)
          errors++
          found = true
        }
        seen.add(terminalId)
      }
    }

    for (const gap of platform.untrackedTerminals ?? []) {
      const gapMissing: string[] = []
      if (!gap.label) gapMissing.push("label")
      if (!gap.url) gapMissing.push("url")
      if (!gap.type) gapMissing.push("type")
      if (!gap.note) gapMissing.push("note")
      if (gap.url && !/^https?:\/\//.test(gap.url)) gapMissing.push("absolute url")
      if (gapMissing.length > 0) {
        error(
          `Platform "${id}" has invalid untracked terminal "${gap.label ?? "(missing label)"}": ${gapMissing.join(", ")}`,
        )
        errors++
        found = true
      }
    }

    for (const source of platform.sources ?? []) {
      const sourceMissing: string[] = []
      if (!source.label) sourceMissing.push("label")
      if (!source.url) sourceMissing.push("url")
      if (source.url && !/^https?:\/\//.test(source.url)) sourceMissing.push("absolute url")
      if (sourceMissing.length > 0) {
        error(`Platform "${id}" has invalid source "${source.label ?? "(missing label)"}": ${sourceMissing.join(", ")}`)
        errors++
        found = true
      }
    }
  }

  for (const id of knownPlatformKeys) {
    if (!platformKeys.has(id)) {
      error(`Missing platform page metadata for "${id}"`)
      errors++
      found = true
    }
  }

  if (!found) info("All platform page metadata is valid")
}

// 4f. Probe files terminal identity verification
{
  let found = false
  let verifiedCount = 0
  let uncheckedCount = 0

  for (const { file, dir, data } of probeFiles) {
    if (dir === "probes-libs") continue
    const term = data.terminal || data.backend
    if (!term) continue
    if (data.schemaVersion === undefined && data.responses === undefined) {
      warn(`Probe file "${dir}/${file}" has no captured identity responses (legacy history; unverified)`)
      warnings++
      uncheckedCount++
      continue
    }
    const check = verifyTerminalIdentity(term, data.responses, data.results)
    if (!check.checked) {
      info(`Probe file "${dir}/${file}" has no identity profile for "${term}"`)
      uncheckedCount++
    } else if (!check.ok) {
      error(`Probe file "${dir}/${file}" failed terminal identity check: ${check.reason}`)
      errors++
      found = true
    } else {
      verifiedCount++
    }
  }
  if (!found) {
    info(
      `Probe terminal identity guards: ${verifiedCount} verified, ${uncheckedCount} unchecked (missing replies or no rule)`,
    )
  }
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
    if (term.manifestBackend) knownBackends.add(term.manifestBackend)
  }

  let count = 0
  for (const { file, dir, backendName, data } of probeFiles) {
    // A v2 run states its target (kind + id) and is checked against the catalog by section 8b below;
    // this looser name check covers legacy runs, whose backend naming predates the catalog.
    if (data.schemaVersion === 2) continue
    if (backendName && !knownBackends.has(backendName)) {
      warn(`Probe file "${dir}/${file}" references "${backendName}" — no matching terminal in terminals.json`)
      warnings++
      count++
    }
  }
  if (count === 0) info("All legacy probe files match a terminal in terminals.json")
}

// 8b. Every v2 run names a target declared in terminals.json
{
  // compatibilityTargets (docs/data/current-results.ts) derives every published v1 and site key from
  // (target.kind, target.id) against terminals.json alone, and throws "Undeclared compatibility target"
  // for a current run it cannot name. Admitting a run before its target is declared is what turned
  // main red on app:xterm (27892), so an undeclared v2 target is an error here, before any consumer reads it.
  const declaredKinds = new Map<string, Set<string>>()
  const declare = (id: string, kind: string): void => {
    const kinds = declaredKinds.get(id) ?? new Set<string>()
    kinds.add(kind)
    declaredKinds.set(id, kinds)
  }
  for (const [id, term] of Object.entries(terminals)) {
    if (term.historical === true) continue
    if (typeof term.kind !== "string") continue
    declare(id, term.kind)
    for (const backend of term.headlessBackends ?? []) declare(backend, "headless")
  }

  let count = 0
  for (const { file, dir, data } of probeFiles) {
    if (data.schemaVersion !== 2) continue
    const target = data.target as { kind?: unknown; id?: unknown } | undefined
    const kind = target?.kind
    const id = target?.id
    if (typeof kind !== "string" || typeof id !== "string") continue
    if (!declaredKinds.get(id)?.has(kind)) {
      error(`Probe file "${dir}/${file}" targets undeclared ${kind}:${id} - terminals.json declares no such target`)
      errors++
      count++
    }
  }
  if (count === 0) info("Every v2 run names a target declared in terminals.json")
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

// 10. Features with stub body text
{
  let count = 0
  for (const [id, feat] of Object.entries(features)) {
    if (id === "$comment") continue
    const body = (feat.body ?? "").trim()
    if (body.length > 0 && body.length < MIN_FEATURE_BODY_LENGTH) {
      warn(`Feature "${id}" body is brief (${body.length} chars, target >= ${MIN_FEATURE_BODY_LENGTH})`)
      warnings++
      count++
    }
  }
  if (count === 0) info(`All feature bodies are at least ${MIN_FEATURE_BODY_LENGTH} chars`)
}

// 11. Features missing probe description
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

// 12. Annotations referencing nonexistent features or backends
{
  // Build set of all backends from probe files + terminals.json
  const allBackends = new Set<string>()
  for (const [id, term] of Object.entries(terminals)) {
    allBackends.add(id)
    for (const b of term.headlessBackends ?? []) {
      allBackends.add(b)
    }
    if (term.manifestBackend) allBackends.add(term.manifestBackend)
  }

  // Also add backends found in probe data (e.g. "ghostty-native")
  for (const backend of probeBackends) allBackends.add(backend)

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

// 13. Tag/category ID collisions
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

// 14. Feature counts
{
  const featureCount = featureIds.size
  info(`Total features: ${featureCount}`)

  const perCategory = new Map<string, number>()
  for (const id of featureIds) {
    const prefix = id.split(".")[0] ?? ""
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

  // Probe status distribution (default: automated)
  const statusCounts: Record<string, number> = {
    automated: 0,
    partial: 0,
    manual: 0,
    unprobed: 0,
  }
  for (const [id, feat] of Object.entries(features)) {
    if (id === "$comment") continue
    const status = feat.probeStatus ?? "automated"
    statusCounts[status] = (statusCounts[status] ?? 0) + 1
  }
  info(
    `Probe status: ${statusCounts.automated} automated, ${statusCounts.partial} partial, ${statusCounts.manual} manual, ${statusCounts.unprobed} unprobed`,
  )
}

// 15. Terminal counts
{
  const termCount = Object.keys(terminals).length
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

// 16. Annotation coverage
{
  // Count total failure results across all probe files
  let totalFailures = 0
  let annotatedFailures = 0

  // v2 runs store observations, not legacy boolean results; this coverage only counts legacy failures.
  for (const { file, dir, data } of probeFiles) {
    if (data.schemaVersion !== undefined) continue
    if (!data.results) throw new Error(`Probe file "${dir}/${file}" lost required legacy results after inventory`)
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
  }

  const pct = totalFailures > 0 ? ((annotatedFailures / totalFailures) * 100).toFixed(1) : "N/A"
  info(`Legacy annotation coverage: ${annotatedFailures}/${totalFailures} failures annotated (${pct}%)`)
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
