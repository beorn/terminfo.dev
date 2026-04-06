#!/usr/bin/env bun
/**
 * Check for broken internal links in the built VitePress site.
 *
 * Scans every .html file in docs/.vitepress/dist/, extracts all internal
 * hrefs (starting with "/" and not containing a scheme), normalizes each
 * link, and verifies it resolves to an actual file in the dist tree.
 *
 * Exit code: 1 if any broken links are found, 0 otherwise.
 *
 * Usage:
 *   bun scripts/check-404s.ts            # default dist dir
 *   bun scripts/check-404s.ts <dist-dir> # custom dist dir
 *
 * Intended to run in CI right after `bun run build`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
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
// Args
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))
const defaultDist = resolve(__dirname, "..", "docs", ".vitepress", "dist")
const distDir = resolve(process.argv[2] ?? defaultDist)

if (!existsSync(distDir)) {
  console.error(`${RED}ERROR${RESET} dist directory not found: ${distDir}`)
  console.error(`Run ${BOLD}bun run build${RESET} first.`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// Walk dist → gather all files (for lookup) and all HTML files (for scanning)
// ---------------------------------------------------------------------------

/** Every file that actually exists in the dist tree, as "/" rooted paths. */
const existingFiles = new Set<string>()
const htmlFiles: string[] = []

function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      walk(full)
    } else {
      const rel = "/" + relative(distDir, full).split(/[\\/]/).join("/")
      existingFiles.add(rel)
      if (rel.endsWith(".html")) htmlFiles.push(full)
    }
  }
}

walk(distDir)

// ---------------------------------------------------------------------------
// URL normalization & existence check
// ---------------------------------------------------------------------------

/**
 * Strip fragment and query, then decode. Returns null if the href should be
 * ignored entirely (external, mailto:, empty, fragment-only, etc.).
 */
function normalizeHref(href: string): string | null {
  if (!href) return null
  const trimmed = href.trim()
  if (!trimmed) return null
  if (trimmed.startsWith("#")) return null
  if (trimmed.startsWith("javascript:")) return null
  if (trimmed.startsWith("mailto:")) return null
  if (trimmed.startsWith("tel:")) return null
  if (trimmed.startsWith("data:")) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return null // http://, https://, etc.
  if (/^\/\//.test(trimmed)) return null // protocol-relative

  // Only absolute-rooted internal links (VitePress always emits these).
  // Relative links would require a base, which we don't track.
  if (!trimmed.startsWith("/")) return null

  let path = trimmed
  const hashAt = path.indexOf("#")
  if (hashAt !== -1) path = path.slice(0, hashAt)
  const qAt = path.indexOf("?")
  if (qAt !== -1) path = path.slice(0, qAt)

  try {
    path = decodeURI(path)
  } catch {
    // leave as-is if it's not valid URI-encoded
  }

  return path
}

/**
 * Resolve a normalized internal link to a file in dist. Returns true if any
 * of the candidates exist, false otherwise.
 *
 * Candidates for a link `/foo`:
 *   - /foo                 (direct file, e.g. /robots.txt)
 *   - /foo.html            (VitePress clean URL)
 *   - /foo/index.html      (directory index)
 *
 * For `/foo/` we also check /foo/index.html.
 */
function linkExists(link: string): boolean {
  if (link === "/" || link === "") {
    return existingFiles.has("/index.html")
  }

  // Exact file match (assets, /robots.txt, /sitemap.xml, etc.)
  if (existingFiles.has(link)) return true

  // Strip trailing slash variant
  if (link.endsWith("/")) {
    const noSlash = link.slice(0, -1)
    if (existingFiles.has(noSlash)) return true
    if (existingFiles.has(noSlash + ".html")) return true
    if (existingFiles.has(link + "index.html")) return true
    return false
  }

  // VitePress clean-URL: /foo → /foo.html
  if (existingFiles.has(link + ".html")) return true
  // Directory with index: /foo → /foo/index.html
  if (existingFiles.has(link + "/index.html")) return true

  return false
}

// ---------------------------------------------------------------------------
// Scan HTML for hrefs
// ---------------------------------------------------------------------------

interface Broken {
  source: string // relative path inside dist
  line: number
  target: string // the raw href
  normalized: string
}

const hrefRe = /href\s*=\s*"([^"]*)"/g

const broken: Broken[] = []
let totalLinks = 0
let totalChecked = 0
const uniqueBadTargets = new Set<string>()

for (const file of htmlFiles) {
  const contents = readFileSync(file, "utf-8")
  const relSource = relative(distDir, file)

  // Pre-compute line starts for line-number lookup
  const lineStarts: number[] = [0]
  for (let i = 0; i < contents.length; i++) {
    if (contents.charCodeAt(i) === 10 /* \n */) lineStarts.push(i + 1)
  }
  function lineFor(offset: number): number {
    // Binary search
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid]! <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }

  hrefRe.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = hrefRe.exec(contents)) !== null) {
    totalLinks++
    const raw = match[1] ?? ""
    const normalized = normalizeHref(raw)
    if (normalized === null) continue
    totalChecked++
    if (!linkExists(normalized)) {
      broken.push({
        source: relSource,
        line: lineFor(match.index),
        target: raw,
        normalized,
      })
      uniqueBadTargets.add(normalized)
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log(`${BOLD}Internal link check${RESET} — ${distDir}`)
console.log(
  `${DIM}Scanned ${htmlFiles.length} HTML files, ${totalLinks} total hrefs, ${totalChecked} internal links.${RESET}`,
)

if (broken.length === 0) {
  console.log(`${GREEN}OK${RESET} No broken internal links.`)
  process.exit(0)
}

// Group by normalized target for a readable summary
const byTarget = new Map<string, Broken[]>()
for (const b of broken) {
  const list = byTarget.get(b.normalized) ?? []
  list.push(b)
  byTarget.set(b.normalized, list)
}

console.log(
  `${RED}FAIL${RESET} ${broken.length} broken link${broken.length === 1 ? "" : "s"} to ${uniqueBadTargets.size} unique target${uniqueBadTargets.size === 1 ? "" : "s"}:`,
)
console.log()

const sortedTargets = [...byTarget.keys()].sort()
for (const target of sortedTargets) {
  const refs = byTarget.get(target)!
  console.log(`  ${BOLD}${target}${RESET} ${DIM}(${refs.length} reference${refs.length === 1 ? "" : "s"})${RESET}`)
  const shown = refs.slice(0, 5)
  for (const r of shown) {
    console.log(`    ${DIM}→${RESET} ${r.source}:${r.line}`)
  }
  if (refs.length > shown.length) {
    console.log(`    ${DIM}… ${refs.length - shown.length} more${RESET}`)
  }
}

console.log()
console.log(`${YELLOW}Hint:${RESET} add a page for the missing route, or fix the link source.`)

process.exit(1)
