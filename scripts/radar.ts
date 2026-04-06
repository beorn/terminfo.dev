#!/usr/bin/env bun
/**
 * Triage tool for terminfo.dev's discovery radar (content/radar.jsonl).
 *
 * The radar is an append-only log of ecosystem findings produced by
 * scripts/explore.ts. This CLI lets a human review, filter, dismiss, and
 * inspect findings before they're promoted to candidates (see candidates.ts).
 *
 * Usage:
 *   bun scripts/radar.ts list
 *   bun scripts/radar.ts list --type new-protocol
 *   bun scripts/radar.ts list --query xterm-recent-changes
 *   bun scripts/radar.ts show <id>
 *   bun scripts/radar.ts dismiss <id> <reason>
 *   bun scripts/radar.ts stats
 *
 * Exit codes:
 *   0  success
 *   1  user error (bad args, unknown id, etc.)
 *   2  file/io error (radar.jsonl missing or unreadable)
 */

import { readFileSync, appendFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, "..")
const radarPath = join(rootDir, "content", "radar.jsonl")

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
  type: "new-terminal" | "new-protocol" | "new-version" | "ecosystem-signal" | "deprecation" | "spec-change"
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
const MAGENTA = "\x1b[35m"
const CYAN = "\x1b[36m"

const TYPE_COLOR: Record<Finding["type"], string> = {
  "new-terminal": GREEN,
  "new-protocol": CYAN,
  "new-version": BLUE,
  "ecosystem-signal": MAGENTA,
  deprecation: RED,
  "spec-change": YELLOW,
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function loadFindings(): Finding[] {
  if (!existsSync(radarPath)) {
    console.error(`${RED}error${RESET} radar file not found: ${radarPath}`)
    process.exit(2)
  }
  let raw: string
  try {
    raw = readFileSync(radarPath, "utf-8")
  } catch (err) {
    console.error(`${RED}error${RESET} cannot read ${radarPath}: ${(err as Error).message}`)
    process.exit(2)
  }

  // Append-only log: later records can supersede earlier ones (e.g. dismissal).
  // We collapse to the latest record per id.
  const byId = new Map<string, Finding>()
  const lines = raw.split("\n").filter((l) => l.trim().length > 0)
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Finding
      if (!obj.id) continue
      const existing = byId.get(obj.id)
      if (existing) {
        // Merge: prefer later record's fields, but keep dismissed flag if either has it
        byId.set(obj.id, { ...existing, ...obj, dismissed: obj.dismissed ?? existing.dismissed })
      } else {
        byId.set(obj.id, obj)
      }
    } catch {
      // Skip malformed lines silently — radar is append-only and lossy by design.
    }
  }
  return [...byId.values()]
}

function appendRecord(finding: Finding): void {
  try {
    appendFileSync(radarPath, JSON.stringify(finding) + "\n")
  } catch (err) {
    console.error(`${RED}error${RESET} cannot write ${radarPath}: ${(err as Error).message}`)
    process.exit(2)
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function colorType(type: Finding["type"]): string {
  return `${TYPE_COLOR[type] ?? ""}${type}${RESET}`
}

function formatLine(f: Finding): string {
  const score = `${BOLD}${String(f.relevance_score).padStart(2)}${RESET}`
  const id = `${DIM}${f.id}${RESET}`
  const type = colorType(f.type)
  const title = f.dismissed ? `${DIM}${f.title}${RESET}` : f.title
  const dismissed = f.dismissed ? ` ${RED}[dismissed]${RESET}` : ""
  return `  ${score}  ${id}  ${type.padEnd(30)}  ${title}${dismissed}`
}

function showFinding(f: Finding): void {
  console.log()
  console.log(`${BOLD}${f.title}${RESET}`)
  console.log(`${DIM}${f.id}${RESET}  ${colorType(f.type)}  score=${f.relevance_score}`)
  console.log(`${DIM}query=${f.query_id}  discovered=${f.discovered}  discoverer=${f.discoverer}${RESET}`)
  if (f.dismissed) {
    console.log(`${RED}dismissed${RESET}  ${f.dismissed.at}  ${f.dismissed.reason}`)
  }
  console.log()
  console.log(`${BOLD}description${RESET}`)
  console.log(`  ${f.description}`)
  console.log()
  console.log(`${BOLD}suggested action${RESET}  ${f.suggested_action}`)
  console.log()
  console.log(`${BOLD}citations${RESET} (${f.citations.length})`)
  for (const [i, c] of f.citations.entries()) {
    console.log(`  ${DIM}[${i + 1}]${RESET} ${BLUE}${c.url}${RESET}`)
    console.log(`      ${DIM}published=${c.published}  accessed=${c.accessed}${RESET}`)
    if (c.snippet) {
      console.log(`      ${c.snippet}`)
    }
  }
  console.log()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdList(args: string[]): void {
  const findings = loadFindings()
  let filterType: string | undefined
  let filterQuery: string | undefined
  let includeDismissed = false

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--type") filterType = args[++i]
    else if (a === "--query") filterQuery = args[++i]
    else if (a === "--all" || a === "--with-dismissed") includeDismissed = true
    else {
      console.error(`${RED}error${RESET} unknown flag: ${a}`)
      process.exit(1)
    }
  }

  let filtered = findings
  if (filterType) filtered = filtered.filter((f) => f.type === filterType)
  if (filterQuery) filtered = filtered.filter((f) => f.query_id === filterQuery)
  if (!includeDismissed) filtered = filtered.filter((f) => !f.dismissed)

  if (filtered.length === 0) {
    console.log(`${DIM}no findings match${RESET}`)
    return
  }

  // Group by type, sort each group by relevance desc
  const byType = new Map<string, Finding[]>()
  for (const f of filtered) {
    const list = byType.get(f.type) ?? []
    list.push(f)
    byType.set(f.type, list)
  }

  const typeOrder: Finding["type"][] = [
    "new-terminal",
    "new-protocol",
    "new-version",
    "spec-change",
    "deprecation",
    "ecosystem-signal",
  ]

  console.log()
  console.log(`${BOLD}radar${RESET}  ${filtered.length} finding${filtered.length === 1 ? "" : "s"}`)
  if (filterType) console.log(`${DIM}filter: type=${filterType}${RESET}`)
  if (filterQuery) console.log(`${DIM}filter: query=${filterQuery}${RESET}`)
  console.log()

  for (const type of typeOrder) {
    const list = byType.get(type)
    if (!list || list.length === 0) continue
    list.sort((a, b) => b.relevance_score - a.relevance_score)
    console.log(`${BOLD}${colorType(type as Finding["type"])}${RESET}  (${list.length})`)
    for (const f of list) console.log(formatLine(f))
    console.log()
  }

  // Catch any extra type buckets we didn't anticipate
  for (const [type, list] of byType.entries()) {
    if (typeOrder.includes(type as Finding["type"])) continue
    list.sort((a, b) => b.relevance_score - a.relevance_score)
    console.log(`${BOLD}${type}${RESET}  (${list.length})`)
    for (const f of list) console.log(formatLine(f))
    console.log()
  }
}

function cmdShow(args: string[]): void {
  const id = args[0]
  if (!id) {
    console.error(`${RED}error${RESET} usage: radar.ts show <id>`)
    process.exit(1)
  }
  const findings = loadFindings()
  // Allow id prefix matching for convenience
  const matches = findings.filter((f) => f.id === id || f.id.startsWith(id))
  if (matches.length === 0) {
    console.error(`${RED}error${RESET} no finding with id: ${id}`)
    process.exit(1)
  }
  if (matches.length > 1) {
    console.error(`${RED}error${RESET} ambiguous id ${id}, matches:`)
    for (const f of matches) console.error(`  ${f.id}  ${f.title}`)
    process.exit(1)
  }
  showFinding(matches[0]!)
}

function cmdDismiss(args: string[]): void {
  const id = args[0]
  const reason = args.slice(1).join(" ").trim()
  if (!id || !reason) {
    console.error(`${RED}error${RESET} usage: radar.ts dismiss <id> <reason>`)
    process.exit(1)
  }
  const findings = loadFindings()
  const matches = findings.filter((f) => f.id === id || f.id.startsWith(id))
  if (matches.length === 0) {
    console.error(`${RED}error${RESET} no finding with id: ${id}`)
    process.exit(1)
  }
  if (matches.length > 1) {
    console.error(`${RED}error${RESET} ambiguous id ${id}, matches:`)
    for (const f of matches) console.error(`  ${f.id}  ${f.title}`)
    process.exit(1)
  }
  const finding = matches[0]!
  if (finding.dismissed) {
    console.log(`${YELLOW}already dismissed${RESET}  ${finding.id}  ${finding.dismissed.reason}`)
    return
  }
  const now = new Date().toISOString().slice(0, 10)
  const dismissed: Finding = { ...finding, dismissed: { reason, at: now } }
  appendRecord(dismissed)
  console.log(`${GREEN}dismissed${RESET}  ${finding.id}  ${finding.title}`)
  console.log(`${DIM}reason: ${reason}${RESET}`)
}

function cmdStats(): void {
  const findings = loadFindings()
  if (findings.length === 0) {
    console.log(`${DIM}no findings${RESET}`)
    return
  }

  const byType = new Map<string, number>()
  const byQuery = new Map<string, number>()
  const byDate = new Map<string, number>()
  let dismissed = 0
  let active = 0

  for (const f of findings) {
    byType.set(f.type, (byType.get(f.type) ?? 0) + 1)
    byQuery.set(f.query_id, (byQuery.get(f.query_id) ?? 0) + 1)
    byDate.set(f.discovered, (byDate.get(f.discovered) ?? 0) + 1)
    if (f.dismissed) dismissed++
    else active++
  }

  console.log()
  console.log(`${BOLD}radar stats${RESET}`)
  console.log(`  total      ${findings.length}`)
  console.log(`  active     ${GREEN}${active}${RESET}`)
  console.log(`  dismissed  ${RED}${dismissed}${RESET}`)
  console.log()

  console.log(`${BOLD}by type${RESET}`)
  const typeRows = [...byType.entries()].sort((a, b) => b[1] - a[1])
  for (const [type, count] of typeRows) {
    console.log(`  ${String(count).padStart(4)}  ${colorType(type as Finding["type"])}`)
  }
  console.log()

  console.log(`${BOLD}by query${RESET}`)
  const queryRows = [...byQuery.entries()].sort((a, b) => b[1] - a[1])
  for (const [query, count] of queryRows) {
    console.log(`  ${String(count).padStart(4)}  ${query}`)
  }
  console.log()

  console.log(`${BOLD}by date${RESET}`)
  const dateRows = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  for (const [date, count] of dateRows) {
    console.log(`  ${String(count).padStart(4)}  ${date}`)
  }
  console.log()
}

function usage(): void {
  console.log(`${BOLD}radar${RESET}  triage tool for content/radar.jsonl

${BOLD}usage${RESET}
  bun scripts/radar.ts list [--type <type>] [--query <query>] [--all]
  bun scripts/radar.ts show <id>
  bun scripts/radar.ts dismiss <id> <reason>
  bun scripts/radar.ts stats

${BOLD}types${RESET}
  new-terminal  new-protocol  new-version  ecosystem-signal  deprecation  spec-change

${BOLD}flags${RESET}
  --type <t>    filter list by finding type
  --query <q>   filter list by query_id (which explore query found it)
  --all         include dismissed findings in list output
`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const [, , cmd, ...rest] = process.argv

switch (cmd) {
  case "list":
    cmdList(rest)
    break
  case "show":
    cmdShow(rest)
    break
  case "dismiss":
    cmdDismiss(rest)
    break
  case "stats":
    cmdStats()
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
