#!/usr/bin/env bun
/**
 * Candidate triage for terminfo.dev's discovery pipeline.
 *
 * Candidates are radar findings that a human has reviewed and proposed as
 * future features. They live in content/candidates.json with a status field
 * (pending_review / approved / rejected). Approved candidates can be merged
 * into content/features.json via the `merge` command.
 *
 * Usage:
 *   bun scripts/candidates.ts list
 *   bun scripts/candidates.ts promote <radar-id>
 *   bun scripts/candidates.ts approve <feature-id>
 *   bun scripts/candidates.ts reject <feature-id> <reason>
 *   bun scripts/candidates.ts merge
 *
 * Exit codes:
 *   0  success
 *   1  user error (bad args, unknown id, duplicate, etc.)
 *   2  file/io error
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createInterface } from "node:readline"

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, "..")
const contentDir = join(rootDir, "content")
const radarPath = join(contentDir, "radar.jsonl")
const candidatesPath = join(contentDir, "candidates.json")
const featuresPath = join(contentDir, "features.json")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Citation {
  url: string
  title?: string
  published: string
  accessed: string
  snippet: string
}

interface Finding {
  id: string
  type: string
  title: string
  description: string
  citations: Citation[]
  relevance_score: number
  suggested_action: string
  discovered: string
  discoverer: string
  query_id: string
  dismissed?: { reason: string; at: string }
}

type CandidateStatus = "pending_review" | "approved" | "rejected"

interface Candidate {
  name: string
  slug: string
  proposed_tags: string[]
  proposed_baseline: string
  sequence: string
  source_url: string
  source_published: string
  evidence: string[]
  promoted_from_radar: string[]
  status: CandidateStatus
  reviewed: string
  reviewer_notes: string
}

type CandidatesFile = Record<string, Candidate>

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const RED = "\x1b[31m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const BLUE = "\x1b[34m"
const CYAN = "\x1b[36m"

const STATUS_COLOR: Record<CandidateStatus, string> = {
  pending_review: YELLOW,
  approved: GREEN,
  rejected: RED,
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T
  } catch (err) {
    console.error(`${RED}error${RESET} cannot parse ${path}: ${(err as Error).message}`)
    process.exit(2)
  }
}

function writeJson(path: string, data: unknown): void {
  try {
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n")
  } catch (err) {
    console.error(`${RED}error${RESET} cannot write ${path}: ${(err as Error).message}`)
    process.exit(2)
  }
}

function loadCandidates(): CandidatesFile {
  return readJson<CandidatesFile>(candidatesPath, {})
}

function loadRadar(): Finding[] {
  if (!existsSync(radarPath)) {
    console.error(`${RED}error${RESET} radar file not found: ${radarPath}`)
    process.exit(2)
  }
  const raw = readFileSync(radarPath, "utf-8")
  const byId = new Map<string, Finding>()
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed) as Finding
      if (!obj.id) continue
      const existing = byId.get(obj.id)
      if (existing) {
        byId.set(obj.id, { ...existing, ...obj, dismissed: obj.dismissed ?? existing.dismissed })
      } else {
        byId.set(obj.id, obj)
      }
    } catch {
      // Skip malformed lines
    }
  }
  return [...byId.values()]
}

// ---------------------------------------------------------------------------
// Interactive prompt
// ---------------------------------------------------------------------------

function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const suffix = defaultValue ? ` ${DIM}[${defaultValue}]${RESET}` : ""
  return new Promise((resolve) => {
    rl.question(`${CYAN}?${RESET} ${question}${suffix} `, (answer) => {
      rl.close()
      resolve(answer.trim() || defaultValue || "")
    })
  })
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdList(): void {
  const candidates = loadCandidates()
  const entries = Object.entries(candidates)
  if (entries.length === 0) {
    console.log(`${DIM}no candidates yet${RESET}`)
    return
  }

  const byStatus = new Map<CandidateStatus, [string, Candidate][]>()
  for (const [id, c] of entries) {
    const list = byStatus.get(c.status) ?? []
    list.push([id, c])
    byStatus.set(c.status, list)
  }

  const order: CandidateStatus[] = ["pending_review", "approved", "rejected"]

  console.log()
  console.log(`${BOLD}candidates${RESET}  ${entries.length} total`)
  console.log()

  for (const status of order) {
    const list = byStatus.get(status)
    if (!list || list.length === 0) continue
    list.sort((a, b) => a[0].localeCompare(b[0]))
    const color = STATUS_COLOR[status]
    console.log(`${BOLD}${color}${status}${RESET}  (${list.length})`)
    for (const [id, c] of list) {
      console.log(`  ${BOLD}${id}${RESET}  ${c.name}`)
      console.log(
        `    ${DIM}slug=${c.slug}  baseline=${c.proposed_baseline}  tags=[${c.proposed_tags.join(", ")}]${RESET}`,
      )
      if (c.sequence) console.log(`    ${DIM}sequence:${RESET} ${c.sequence}`)
      if (c.source_url) console.log(`    ${DIM}source:${RESET} ${BLUE}${c.source_url}${RESET}`)
      if (c.reviewer_notes) console.log(`    ${DIM}notes:${RESET} ${c.reviewer_notes}`)
    }
    console.log()
  }
}

async function cmdPromote(args: string[]): Promise<void> {
  const radarId = args[0]
  if (!radarId) {
    console.error(`${RED}error${RESET} usage: candidates.ts promote <radar-id>`)
    process.exit(1)
  }

  const findings = loadRadar()
  const matches = findings.filter((f) => f.id === radarId || f.id.startsWith(radarId))
  if (matches.length === 0) {
    console.error(`${RED}error${RESET} no radar finding with id: ${radarId}`)
    process.exit(1)
  }
  if (matches.length > 1) {
    console.error(`${RED}error${RESET} ambiguous id ${radarId}, matches:`)
    for (const f of matches) console.error(`  ${f.id}  ${f.title}`)
    process.exit(1)
  }
  const finding = matches[0]!

  console.log()
  console.log(`${BOLD}promoting${RESET}  ${finding.id}  ${finding.title}`)
  console.log(`${DIM}${finding.description.slice(0, 200)}${RESET}`)
  if (finding.citations[0]) {
    console.log(`${DIM}source: ${BLUE}${finding.citations[0].url}${RESET}`)
  }
  console.log()

  const defaultName = finding.title
  const defaultSlug = slugify(finding.title)
  const defaultUrl = finding.citations[0]?.url ?? ""
  const defaultPublished = finding.citations[0]?.published ?? "unknown"

  const featureId = await prompt("feature id (e.g. extensions.xtreportcolors)")
  if (!featureId) {
    console.error(`${RED}error${RESET} feature id is required`)
    process.exit(1)
  }

  const candidates = loadCandidates()
  if (candidates[featureId]) {
    console.error(`${RED}error${RESET} candidate already exists with id: ${featureId}`)
    process.exit(1)
  }

  const name = await prompt("name", defaultName)
  const slug = await prompt("slug", defaultSlug)
  const tagsRaw = await prompt("tags (comma-separated)", "")
  const baseline = await prompt("baseline (core/modern/rich/unicode)", "modern")
  const sequence = await prompt("sequence (e.g. ESC ] 8 ; ; URL BEL)", "")
  const sourceUrl = await prompt("source url", defaultUrl)
  const sourcePublished = await prompt("source published date", defaultPublished)
  const reviewerNotes = await prompt("reviewer notes (optional)", "")

  const proposed_tags = tagsRaw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)

  const now = new Date().toISOString().slice(0, 10)
  const candidate: Candidate = {
    name,
    slug,
    proposed_tags,
    proposed_baseline: baseline,
    sequence,
    source_url: sourceUrl,
    source_published: sourcePublished,
    evidence: [finding.id],
    promoted_from_radar: [finding.id],
    status: "pending_review",
    reviewed: now,
    reviewer_notes: reviewerNotes,
  }

  candidates[featureId] = candidate
  writeJson(candidatesPath, candidates)

  console.log()
  console.log(`${GREEN}promoted${RESET}  ${featureId}`)
  console.log(`${DIM}status: pending_review${RESET}`)
}

function cmdApprove(args: string[]): void {
  const featureId = args[0]
  if (!featureId) {
    console.error(`${RED}error${RESET} usage: candidates.ts approve <feature-id>`)
    process.exit(1)
  }
  const candidates = loadCandidates()
  const candidate = candidates[featureId]
  if (!candidate) {
    console.error(`${RED}error${RESET} no candidate with id: ${featureId}`)
    process.exit(1)
  }
  candidate.status = "approved"
  candidate.reviewed = new Date().toISOString().slice(0, 10)
  writeJson(candidatesPath, candidates)
  console.log(`${GREEN}approved${RESET}  ${featureId}  ${candidate.name}`)
}

function cmdReject(args: string[]): void {
  const featureId = args[0]
  const reason = args.slice(1).join(" ").trim()
  if (!featureId || !reason) {
    console.error(`${RED}error${RESET} usage: candidates.ts reject <feature-id> <reason>`)
    process.exit(1)
  }
  const candidates = loadCandidates()
  const candidate = candidates[featureId]
  if (!candidate) {
    console.error(`${RED}error${RESET} no candidate with id: ${featureId}`)
    process.exit(1)
  }
  candidate.status = "rejected"
  candidate.reviewed = new Date().toISOString().slice(0, 10)
  candidate.reviewer_notes = candidate.reviewer_notes
    ? `${candidate.reviewer_notes} | rejected: ${reason}`
    : `rejected: ${reason}`
  writeJson(candidatesPath, candidates)
  console.log(`${RED}rejected${RESET}  ${featureId}  ${candidate.name}`)
  console.log(`${DIM}reason: ${reason}${RESET}`)
}

function cmdMerge(): void {
  const candidates = loadCandidates()
  const features = readJson<Record<string, unknown>>(featuresPath, {})

  const approved = Object.entries(candidates).filter(([, c]) => c.status === "approved")
  if (approved.length === 0) {
    console.log(`${DIM}no approved candidates to merge${RESET}`)
    return
  }

  let added = 0
  let skipped = 0
  for (const [featureId, c] of approved) {
    if (features[featureId]) {
      console.log(`${YELLOW}skip${RESET}  ${featureId}  already in features.json`)
      skipped++
      continue
    }
    features[featureId] = {
      name: c.name,
      slug: c.slug,
      url: c.source_url,
      tags: c.proposed_tags,
      body: c.reviewer_notes || `Promoted from radar finding(s) ${c.promoted_from_radar.join(", ")}.`,
      probe: "Manual verification required — no automated probe available.",
      probeStatus: "unprobed",
      baseline: c.proposed_baseline,
      sequence: c.sequence,
    }
    added++
    console.log(`${GREEN}added${RESET}  ${featureId}  ${c.name}`)
  }

  if (added > 0) {
    writeJson(featuresPath, features)
  }

  console.log()
  console.log(`${BOLD}merge complete${RESET}`)
  console.log(`  added    ${GREEN}${added}${RESET}`)
  console.log(`  skipped  ${YELLOW}${skipped}${RESET}`)
  console.log()
  console.log(`${DIM}candidates.json preserved for audit — approved entries remain there.${RESET}`)
}

function usage(): void {
  console.log(`${BOLD}candidates${RESET}  triage tool for content/candidates.json

${BOLD}usage${RESET}
  bun scripts/candidates.ts list
  bun scripts/candidates.ts promote <radar-id>
  bun scripts/candidates.ts approve <feature-id>
  bun scripts/candidates.ts reject <feature-id> <reason>
  bun scripts/candidates.ts merge

${BOLD}flow${RESET}
  1. explore.ts writes findings to radar.jsonl
  2. radar.ts list / show / dismiss for triage
  3. candidates.ts promote <radar-id> to propose a feature
  4. candidates.ts approve / reject after review
  5. candidates.ts merge to copy approved entries into features.json
`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const [, , cmd, ...rest] = process.argv

async function main(): Promise<void> {
  switch (cmd) {
    case "list":
      cmdList()
      break
    case "promote":
      await cmdPromote(rest)
      break
    case "approve":
      cmdApprove(rest)
      break
    case "reject":
      cmdReject(rest)
      break
    case "merge":
      cmdMerge()
      break
    case "help":
    case "--help":
    case "-h":
    case undefined:
      usage()
      break
    default:
      console.error(`${RED}error${RESET} unknown command: ${cmd}`)
      usage()
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(`${RED}error${RESET} ${(err as Error).message}`)
  process.exit(1)
})
