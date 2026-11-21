#!/usr/bin/env bun
/**
 * Guard: fail the build if internal/private content would be published.
 *
 * terminfo.dev is a PUBLIC website AND a PUBLIC source repo. Internal artifacts
 * — AI-generated reviews, IA/design notes, drafts, scratch — must never ship as
 * routes. This script is the gate that makes a `/reviews/` (or similar) page
 * impossible to publish silently.
 *
 * It tests FOUR layers:
 *   1. SOURCE  — no internal .md under docs/: forbidden path segments
 *                (reviews/internal/drafts/...), the `llm-meta` marker that AI
 *                review/enrichment output carries, or frontmatter that opts a
 *                page out of publication (private/draft: true, publish: false).
 *   2. BUILD   — no forbidden route directory in docs/.vitepress/dist/ (only
 *                checked when a build exists).
 *   3. SITEMAP — no forbidden path in dist/sitemap.xml.
 *   4. RENDERED — no internal state or placeholder text in what a reader sees:
 *                built page text, built scripts (client-rendered text), and
 *                undecided status values in public JSON (#37341).
 *
 * SOURCE is always checked; BUILD/SITEMAP/RENDERED are checked when dist/ exists.
 * In CI this runs right after `bun run build`, so all four layers are active.
 *
 * Exit code: 1 if any leak is found, 0 otherwise. 2 on usage error.
 *
 * Usage:
 *   bun scripts/check-private-leak.ts            # default docs/ + dist/
 *   bun scripts/check-private-leak.ts <docs-dir> # custom docs dir
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const RED = "\x1b[31m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"
const RESET = "\x1b[0m"

// ---------------------------------------------------------------------------
// Policy — what counts as "must never publish"
// ---------------------------------------------------------------------------

/**
 * Path segments that mark a directory/file as internal. A docs route whose path
 * contains any of these (e.g. `/reviews/...`) is a leak. Keep this in sync with
 * the `srcExclude` list in docs/.vitepress/config.ts.
 */
export const FORBIDDEN_SEGMENTS = ["reviews", "internal", "drafts", "private", "scratch", "wip"] as const

/** Substrings that mark file *content* as internal (AI review/enrichment output). */
export const FORBIDDEN_MARKERS = ["llm-meta"] as const

/** Frontmatter flags (key: value) that opt a page out of publication. */
const FRONTMATTER_OPT_OUT: Array<{ key: string; value: string }> = [
  { key: "private", value: "true" },
  { key: "draft", value: "true" },
  { key: "publish", value: "false" },
]

export interface Violation {
  layer: "source" | "build" | "sitemap" | "rendered"
  path: string
  reason: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walk(dir: string, onFile: (full: string) => void): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".vitepress" || name.startsWith(".git")) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, onFile)
    else onFile(full)
  }
}

function segmentsOf(relPath: string): string[] {
  return relPath.split(sep).filter(Boolean)
}

function firstForbiddenSegment(relPath: string): string | undefined {
  const segs = segmentsOf(relPath).map((s) => s.toLowerCase())
  return FORBIDDEN_SEGMENTS.find((f) => segs.includes(f))
}

/** Read the leading `--- ... ---` YAML frontmatter block (raw lines), if any. */
function frontmatterLines(content: string): string[] {
  if (!content.startsWith("---")) return []
  const end = content.indexOf("\n---", 3)
  if (end === -1) return []
  return content.slice(3, end).split("\n")
}

// ---------------------------------------------------------------------------
// Layer 1 — SOURCE scan (docs/**/*.md)
// ---------------------------------------------------------------------------

export function scanSources(docsDir: string): Violation[] {
  const violations: Violation[] = []
  if (!existsSync(docsDir)) return violations

  walk(docsDir, (full) => {
    if (!full.endsWith(".md")) return
    const rel = relative(docsDir, full)

    const seg = firstForbiddenSegment(rel)
    if (seg) {
      violations.push({
        layer: "source",
        path: `docs/${rel}`,
        reason: `internal path segment "${seg}/" — would publish as a route`,
      })
      return // one finding per file is enough
    }

    const content = readFileSync(full, "utf-8")

    const marker = FORBIDDEN_MARKERS.find((m) => content.includes(m))
    if (marker) {
      violations.push({
        layer: "source",
        path: `docs/${rel}`,
        reason: `contains internal marker "${marker}" (AI review/enrichment output)`,
      })
      return
    }

    const fm = frontmatterLines(content)
    for (const { key, value } of FRONTMATTER_OPT_OUT) {
      const re = new RegExp(`^\\s*${key}\\s*:\\s*${value}\\s*$`, "i")
      if (fm.some((l) => re.test(l))) {
        violations.push({
          layer: "source",
          path: `docs/${rel}`,
          reason: `frontmatter "${key}: ${value}" but file is under docs/ (would publish anyway)`,
        })
        return
      }
    }
  })

  return violations
}

// ---------------------------------------------------------------------------
// Layer 2 — BUILD scan (dist/**)
// ---------------------------------------------------------------------------

export function scanDist(distDir: string): Violation[] {
  const violations: Violation[] = []
  if (!existsSync(distDir)) return violations

  walk(distDir, (full) => {
    const rel = relative(distDir, full)
    const seg = firstForbiddenSegment(rel)
    if (seg && full.endsWith(".html")) {
      violations.push({
        layer: "build",
        path: `dist/${rel}`,
        reason: `built page under "${seg}/" — internal content reached the published site`,
      })
    }
  })

  return violations
}

// ---------------------------------------------------------------------------
// Layer 3 — SITEMAP scan (dist/sitemap.xml)
// ---------------------------------------------------------------------------

export function scanSitemap(distDir: string): Violation[] {
  const violations: Violation[] = []
  const sitemap = join(distDir, "sitemap.xml")
  if (!existsSync(sitemap)) return violations

  const xml = readFileSync(sitemap, "utf-8")
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1] ?? "")
  for (const loc of locs) {
    let path: string
    try {
      path = new URL(loc).pathname
    } catch {
      path = loc
    }
    const seg = segmentsOf(path)
      .map((s) => s.toLowerCase())
      .find((s) => (FORBIDDEN_SEGMENTS as readonly string[]).includes(s))
    if (seg) {
      violations.push({
        layer: "sitemap",
        path: loc,
        reason: `sitemap advertises an internal "${seg}/" route`,
      })
    }
  }

  return violations
}

// ---------------------------------------------------------------------------
// Layer 4 — RENDERED scan (internal states and placeholder text on public pages)
// ---------------------------------------------------------------------------

/**
 * Text the public site must never render (operator, Nov 20: internal states "should only be for our internal use";
 * an Unsupported must show "clear evidence"). @cpo/term 68db0b65, d0d3a1f3, f16a5a52; @cto b8e68da0 item 3.
 * Each pattern is matched in every built page's visible text (scripts, styles and tags removed). A pattern with
 * `inScripts` is also matched in the built JavaScript, which carries page chunks and client-rendered text such as
 * popovers that never reach the static HTML. Version strings are page text only: the bundled data holds the
 * measured package version, which is a fact, not a rendering.
 */
export const INTERNAL_STATE_TEXT: ReadonlyArray<{
  readonly name: string
  readonly pattern: RegExp
  readonly inScripts: boolean
}> = [
  { name: "PROBE TODO", pattern: /PROBE TODO/g, inScripts: true },
  { name: "PROBE INVALID", pattern: /PROBE INVALID/g, inScripts: true },
  { name: "PROBE CONFLICT", pattern: /PROBE CONFLICT/g, inScripts: true },
  { name: "NOT MEASURED", pattern: /NOT MEASURED/g, inScripts: true },
  { name: "manual by design", pattern: /manual[ -]by[ -]design/gi, inScripts: true },
  { name: "unstable version string", pattern: /\b\d+-unstable-\d{4}-\d{2}-\d{2}\b/g, inScripts: false },
  { name: "placeholder: not stored by this run", pattern: /not stored by this run/gi, inScripts: true },
  { name: "placeholder: not reviewed for publication", pattern: /not reviewed for publication/gi, inScripts: true },
]

/** Undecided statuses the public JSON must not carry (@cpo/term f16a5a52 Q4: decided results only). */
export const UNDECIDED_JSON_STATUS = /"probe-(?:todo|invalid|conflict)"/g

const SCRIPT_OR_STYLE = /<(script|style)\b[\s\S]*?<\/\1>/gi
const TAG = /<[^>]+>/g
const ENTITY: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
}

/**
 * Attributes whose values a reader meets: hover text (title, and data-tooltip, which summary-bars.css shows on
 * hover), the screen-reader name (aria-label) and image text (alt). Any other attribute is data, not read.
 */
const READ_ATTRIBUTE = /\s(?:title|data-tooltip|aria-label|alt)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi

/**
 * A built page's reader text: its visible text plus the read attribute values (@cto 97ba8eea D11), entities
 * decoded. A state named only in script data or in another attribute is not counted.
 */
export function visibleText(html: string): string {
  return html
    .replace(SCRIPT_OR_STYLE, " ")
    .replace(TAG, (tag) => {
      const read = [...tag.matchAll(READ_ATTRIBUTE)].map((match) => match[1] ?? match[2] ?? "")
      return " " + read.join(" ") + " "
    })
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, name: string) => ENTITY[name] ?? " ")
}

function countsIn(text: string, inScripts: boolean): Array<{ name: string; count: number }> {
  return INTERNAL_STATE_TEXT.filter((needle) => !inScripts || needle.inScripts)
    .map((needle) => ({ name: needle.name, count: text.match(needle.pattern)?.length ?? 0 }))
    .filter(({ count }) => count > 0)
}

export function scanRendered(distDir: string): Violation[] {
  const violations: Violation[] = []
  if (!existsSync(distDir)) return violations

  walk(distDir, (full) => {
    const rel = relative(distDir, full)
    const isPage = full.endsWith(".html")
    const isJson = full.endsWith(".json")
    if (!isPage && !isJson && !full.endsWith(".js")) return
    const content = readFileSync(full, "utf-8")
    const undecided = isJson ? (content.match(UNDECIDED_JSON_STATUS)?.length ?? 0) : 0
    const found = isJson
      ? undecided > 0
        ? [{ name: "undecided status value", count: undecided }]
        : []
      : isPage
        ? countsIn(visibleText(content), false)
        : countsIn(content, true)
    if (found.length === 0) return
    violations.push({
      layer: "rendered",
      path: `dist/${rel}`,
      reason: `${isPage ? "page text" : isJson ? "public JSON" : "built script"} shows internal state: ${found.map(({ name, count }) => `${name} x${count}`).join(", ")}`,
    })
  })

  return violations
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export function checkPrivateLeak(docsDir: string): Violation[] {
  const distDir = join(docsDir, ".vitepress", "dist")
  return [...scanSources(docsDir), ...scanDist(distDir), ...scanSitemap(distDir), ...scanRendered(distDir)]
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const defaultDocs = resolve(__dirname, "..", "docs")
  const docsDir = resolve(process.argv[2] ?? defaultDocs)

  if (!existsSync(docsDir)) {
    console.error(`${RED}ERROR${RESET} docs directory not found: ${docsDir}`)
    process.exit(2)
  }

  const distDir = join(docsDir, ".vitepress", "dist")
  const builtNote = existsSync(distDir)
    ? `${DIM}(scanning source + built dist + sitemap + rendered text)${RESET}`
    : `${YELLOW}(no dist/ — source-only scan; run "bun run build" for full coverage)${RESET}`

  console.error(`${BOLD}check-private-leak${RESET} ${builtNote}`)

  const violations = checkPrivateLeak(docsDir)

  if (violations.length === 0) {
    console.error(`${GREEN}✓${RESET} no internal/private content would be published`)
    process.exit(0)
  }

  console.error(`\n${RED}${BOLD}PRIVATE-CONTENT LEAK — ${violations.length} finding(s)${RESET}\n`)
  for (const v of violations) {
    console.error(`  ${RED}✗${RESET} [${v.layer}] ${BOLD}${v.path}${RESET}`)
    console.error(`      ${v.reason}`)
  }
  if (violations.some((v) => v.layer !== "rendered")) {
    console.error(
      `\n${YELLOW}Internal artifacts must not live under docs/.${RESET} Move them out of the` +
        ` published tree (e.g. a private location outside this repo) — they must never become routes.\n`,
    )
  }
  if (violations.some((v) => v.layer === "rendered")) {
    console.error(
      `\n${YELLOW}A public page shows an internal state.${RESET} An undecided result renders as a blank cell` +
        ` ("No result yet") and stays out of public JSON; evidence text comes from the evidence module, never a placeholder.\n`,
    )
  }
  process.exit(1)
}

if (import.meta.main) main()
