#!/usr/bin/env bun
/**
 * Open-ended ecosystem discovery for terminfo.dev.
 *
 * Runs deep research queries against GPT-5.4 to find new terminal standards,
 * emulators, protocols, and extensions that aren't yet tracked. Writes findings
 * to content/radar.jsonl as append-only evidence records with citations and dates.
 *
 * Usage:
 *   bun scripts/explore.ts                    # Run all queries
 *   bun scripts/explore.ts --query 1          # Run one specific query
 *   bun scripts/explore.ts --list             # List query templates
 *   bun scripts/explore.ts --dry-run          # Show queries without running
 *
 * Each finding requires:
 *   - citations with URL + published date + accessed date
 *   - a direct quote or paraphrase from the source
 *   - a suggested_action for human review
 *
 * Cost: ~$5 per deep query. 6 queries = ~$30.
 * Run weekly or monthly.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, "..")
const contentDir = join(rootDir, "content")
const radarPath = join(contentDir, "radar.jsonl")

interface Finding {
  id: string // hash of title + first citation URL
  type:
    | "new-terminal"
    | "new-protocol"
    | "new-version"
    | "ecosystem-signal"
    | "deprecation"
    | "spec-change"
  title: string
  description: string
  citations: {
    url: string
    title: string
    published: string // ISO date or "unknown"
    accessed: string // ISO date (run date)
    snippet: string
  }[]
  relevance_score: number // 0-10
  suggested_action: "add-to-sources" | "add-feature" | "investigate" | "track-release" | "ignore"
  discovered: string // ISO date
  discoverer: string // script@version
  query_id: string // which query template found it
}

const QUERY_TEMPLATES: { id: string; prompt: string; description: string }[] = [
  {
    id: "active-terminals",
    description: "Survey active terminal emulators and their recent releases",
    prompt: `Survey all active terminal emulator projects as of 2026. For each:
- Name, URL, maintainer
- Latest release version and date (must cite)
- Any unique features beyond xterm (cite the docs)
- Whether it supports modern protocols: Kitty keyboard, Kitty graphics, Sixel, OSC 8, OSC 133

Focus on terminals that had releases in the last 6 months. Include less-known projects
like: mlterm, terminology, cool-retro-term, upterm, Rio, Mosh, Hyper, Warp, Tabby,
Blink, Termius, iSH, a-shell, Zellij (multiplexer), Edex-UI, anything new.

For each finding, provide:
1. At least one citation URL
2. The publication date of each citation (or "unknown" if not visible)
3. A direct quote or paraphrase from the source

If you cannot cite a source, DO NOT include the finding. Do not generate findings
from memory — only from search results.

Output as structured findings suitable for a reference site's discovery pipeline.`,
  },
  {
    id: "new-protocols-2026",
    description: "New escape sequences, OSC numbers, and protocols proposed/implemented in 2025-2026",
    prompt: `What new terminal escape sequences, OSC numbers, or control protocols have been
proposed or implemented in 2025 or 2026? Search GitHub issues, blog posts, RFCs,
spec drafts, terminal release notes, and discussions on Lobste.rs / Hacker News.

Specifically look for:
- New OSC numbers (anything beyond what xterm ctlseqs patch 401 documents)
- New DEC private modes (beyond the ~2000-2100 range we already track)
- New CSI sequences
- New shell integration variants beyond OSC 133/633
- New notification protocols beyond OSC 9 / 99 / 777
- New image protocols
- Keyboard protocol extensions

For each finding:
- URL of primary source
- Publication date
- Direct quote or paraphrase
- Whether it's proposal-only, implemented, or adopted by multiple terminals

Only include findings with verifiable citations. If you cannot find a source,
exclude the finding.`,
  },
  {
    id: "xterm-recent-changes",
    description: "Changes to xterm ctlseqs and xterm releases",
    prompt: `What has changed in xterm ctlseqs (https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)
between patch 400 and the latest patch? What new patches have been released
in 2025-2026? What features were added or changed?

Also check xterm's release announcements and ChangeLog for any new escape
sequences, modes, or resources.

Provide:
- Patch numbers and dates
- Specific changes (quote the ctlseqs document where possible)
- URL to the changelog or patch announcement

Only include verifiable findings with citations.`,
  },
  {
    id: "spec-bodies",
    description: "Active proposals in terminal standards bodies",
    prompt: `Are there any active proposals, drafts, or discussions in terminal-related
standards bodies? Check:
- freedesktop.org terminal-wg (https://gitlab.freedesktop.org/terminal-wg/specifications)
- UAPI Group (https://uapi-group.org/specifications/)
- ECMA / ISO / ANSI (any updates to ECMA-48?)
- Unicode Consortium (terminal-related annexes)
- IETF RFCs mentioning terminal sequences
- W3C (any browser-terminal intersection)

For each finding:
- Organization and URL
- Current status (proposal/draft/active/abandoned)
- Date of last activity
- Direct quote from the spec/discussion

Include abandoned or stalled proposals too — they're still part of the landscape.`,
  },
  {
    id: "ecosystem-articles",
    description: "Terminal-related articles and discussions from influential sources",
    prompt: `What terminal-related articles, blog posts, or discussions have appeared
in 2025-2026 from influential sources? Check:
- Julia Evans (https://jvns.ca) - terminal articles
- Dan Luu (https://danluu.com)
- LWN.net terminal coverage
- Hacker News front-page terminal discussions
- Lobste.rs terminal stories
- Phoronix terminal benchmarks or news
- Mozilla / GNOME / KDE blog posts about terminals

Focus on articles that:
- Describe features terminfo.dev should track
- Compare terminals on specific capabilities
- Propose new protocols or best practices
- Discuss deprecations or compatibility issues

For each: URL, author, publication date, key quote.`,
  },
  {
    id: "vendor-changelogs",
    description: "Changelogs of tracked terminals in the last 6 months",
    prompt: `Check the changelogs of these terminals for changes in the last 6 months
(2025-10 through 2026-04):

- Kitty (https://sw.kovidgoyal.net/kitty/changelog/)
- Ghostty (https://github.com/ghostty-org/ghostty/releases)
- WezTerm (https://wezfurlong.org/wezterm/changelog.html)
- foot (https://codeberg.org/dnkl/foot/releases)
- Alacritty (https://github.com/alacritty/alacritty/releases)
- iTerm2 (https://iterm2.com/downloads.html)
- Windows Terminal (https://github.com/microsoft/terminal/releases)
- mintty (https://github.com/mintty/mintty/releases)
- Contour (https://github.com/contour-terminal/contour/releases)

For each terminal, list:
- Version number and release date
- New escape sequences or protocols added
- Protocols deprecated or behavior changes
- Direct quotes from the changelog

Only report what you can cite with a URL.`,
  },
]

function hashFinding(title: string, firstCitation: string): string {
  return createHash("sha256").update(`${title}|${firstCitation}`).digest("hex").slice(0, 12)
}

function loadExistingIds(): Set<string> {
  if (!existsSync(radarPath)) return new Set()
  const ids = new Set<string>()
  const lines = readFileSync(radarPath, "utf-8").split("\n").filter(Boolean)
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Finding
      ids.add(obj.id)
    } catch {}
  }
  return ids
}

async function runDeepQuery(queryPrompt: string, queryId: string): Promise<string> {
  const kmRoot = "/Users/beorn/Code/pim/km"
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "bun",
      ["llm", "--deep", "--model", "gpt-5.4", "-y", "--no-recover", queryPrompt],
      { cwd: kmRoot, stdio: ["pipe", "pipe", "inherit"] },
    )
    let output = ""
    proc.stdout?.on("data", (chunk) => (output += chunk.toString()))
    proc.on("close", (code) => {
      if (code === 0) resolve(output)
      else reject(new Error(`llm exited with code ${code}`))
    })
    proc.on("error", reject)
  })
}

function extractFindings(rawOutput: string, queryId: string): Finding[] {
  // The LLM output is free-form research prose. We parse citation URLs
  // from markdown links and structure them into findings.
  const now = new Date().toISOString().slice(0, 10)
  const findings: Finding[] = []

  // Extract markdown-style links with optional dates
  // We split the output into sections and treat each major heading as a potential finding
  const sections = rawOutput.split(/\n(?=#{1,4} )/)
  for (const section of sections) {
    const titleMatch = section.match(/^#{1,4} (.+)$/m)
    if (!titleMatch) continue
    const title = titleMatch[1]!.trim()

    // Extract URLs
    const urls = [...section.matchAll(/https?:\/\/[^\s)\]]+/g)].map((m) => m[0])
    if (urls.length === 0) continue

    // Extract snippets (first 2 sentences after the heading)
    const body = section.slice(titleMatch[0].length).trim()
    const snippet = body.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ").slice(0, 300)

    // Try to find a date in the section (YYYY-MM-DD, Month YYYY, etc.)
    const dateMatch = section.match(
      /\b(20\d\d-\d\d-\d\d|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d\d|20\d\d)\b/,
    )
    const published = dateMatch ? normalizeDate(dateMatch[0]) : "unknown"

    // Heuristic classification
    let type: Finding["type"] = "ecosystem-signal"
    if (/new\s+(?:version|release|patch)/i.test(title)) type = "new-version"
    else if (/\bOSC\b|\bCSI\b|\bDCS\b|protocol|escape/i.test(title)) type = "new-protocol"
    else if (/terminal\s+(?:emulator|app)/i.test(title)) type = "new-terminal"
    else if (/deprecat|removed/i.test(title)) type = "deprecation"
    else if (/xterm\s+patch/i.test(title)) type = "spec-change"

    const firstCitation = urls[0]!
    findings.push({
      id: hashFinding(title, firstCitation),
      type,
      title,
      description: snippet,
      citations: urls.slice(0, 3).map((url) => ({
        url,
        title: "",
        published,
        accessed: now,
        snippet: snippet.slice(0, 200),
      })),
      relevance_score: 5,
      suggested_action: "investigate",
      discovered: now,
      discoverer: "explore.ts@v1",
      query_id: queryId,
    })
  }

  return findings
}

function normalizeDate(raw: string): string {
  // ISO date passes through
  if (/^20\d\d-\d\d-\d\d$/.test(raw)) return raw
  // Year only
  if (/^20\d\d$/.test(raw)) return `${raw}-01-01`
  // Month YYYY
  const monthMatch = raw.match(/^(\w+)\s+(20\d\d)$/)
  if (monthMatch) {
    const months: Record<string, string> = {
      january: "01", february: "02", march: "03", april: "04",
      may: "05", june: "06", july: "07", august: "08",
      september: "09", october: "10", november: "11", december: "12",
    }
    const mo = months[monthMatch[1]!.toLowerCase()]
    if (mo) return `${monthMatch[2]}-${mo}-01`
  }
  return "unknown"
}

function appendFindings(findings: Finding[], existing: Set<string>): number {
  let added = 0
  if (!existsSync(contentDir)) mkdirSync(contentDir, { recursive: true })
  for (const f of findings) {
    if (existing.has(f.id)) continue
    appendFileSync(radarPath, JSON.stringify(f) + "\n", "utf-8")
    existing.add(f.id)
    added++
  }
  return added
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dry-run")
  const list = args.includes("--list")
  const queryArg = args.findIndex((a) => a === "--query")
  const singleQueryId = queryArg >= 0 ? args[queryArg + 1] : null

  if (list) {
    console.log("Available queries:\n")
    for (const q of QUERY_TEMPLATES) {
      console.log(`  ${q.id}`)
      console.log(`    ${q.description}`)
      console.log()
    }
    return
  }

  const queriesToRun = singleQueryId
    ? QUERY_TEMPLATES.filter((q) => q.id === singleQueryId)
    : QUERY_TEMPLATES

  if (queriesToRun.length === 0) {
    console.error(`Unknown query id: ${singleQueryId}`)
    console.error(`Run 'bun scripts/explore.ts --list' to see available queries.`)
    process.exit(1)
  }

  console.log(`\n🔭 Terminfo.dev Ecosystem Explorer`)
  console.log(`Running ${queriesToRun.length} ${queriesToRun.length === 1 ? "query" : "queries"}`)
  console.log(`Radar log: ${radarPath}`)
  console.log(`Cost estimate: ~$${queriesToRun.length * 5}\n`)

  if (dryRun) {
    console.log("DRY RUN — queries that would be sent:\n")
    for (const q of queriesToRun) {
      console.log(`=== ${q.id} ===`)
      console.log(q.prompt)
      console.log()
    }
    return
  }

  const existing = loadExistingIds()
  console.log(`Existing findings in radar: ${existing.size}\n`)

  let totalAdded = 0
  for (const q of queriesToRun) {
    console.log(`\n📡 Running query: ${q.id}`)
    console.log(`   ${q.description}`)
    const start = Date.now()
    try {
      const output = await runDeepQuery(q.prompt, q.id)
      const findings = extractFindings(output, q.id)
      const added = appendFindings(findings, existing)
      totalAdded += added
      const elapsed = Math.round((Date.now() - start) / 1000)
      console.log(`   ✓ ${findings.length} findings extracted, ${added} new (${elapsed}s)`)
    } catch (err) {
      console.error(`   ✗ Query failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log(`\n✨ Done. Added ${totalAdded} new findings to ${radarPath}`)
  console.log(`Review with: bun scripts/radar.ts list    (not yet implemented)`)
}

main().catch((err) => {
  console.error("Error:", err)
  process.exit(1)
})
