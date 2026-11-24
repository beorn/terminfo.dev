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
 *   5. CATALOGUE — the published catalogue is the public one (#37341 Q2, D6): the
 *                API's catalogIds and features name exactly the public ids, no page's
 *                readout counts over more positions than that, and the home page prints
 *                the readout over all of them (@cto f6a09e55).
 *
 * SOURCE is always checked; BUILD/SITEMAP/RENDERED/CATALOGUE are checked when dist/ exists.
 * In CI this runs right after `bun run build`, so all five layers are active. The built
 * output is `docs/.vitepress/dist`, or `<TERMINFO_SITE_OUT_DIR>/dist` when that is set.
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
import { loadFeatures } from "@terminfo/catalog"
import { parseJsonStrict } from "@terminfo/run-parser"
import { publicFeatureIds } from "../docs/data/public-features.ts"
import { siteDistDir } from "./site-out.ts"

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
  layer: "source" | "build" | "sitemap" | "rendered" | "catalogue"
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
  /** When true, also matched against ALL HTML attribute values (not just visible text / ARIA attributes). */
  readonly inAllAttributes?: boolean
}> = [
  { name: "PROBE TODO", pattern: /PROBE TODO/g, inScripts: true },
  { name: "PROBE INVALID", pattern: /PROBE INVALID/g, inScripts: true },
  { name: "PROBE CONFLICT", pattern: /PROBE CONFLICT/g, inScripts: true },
  { name: "NOT MEASURED", pattern: /NOT MEASURED/g, inScripts: true },
  { name: "Not measured yet", pattern: /not measured yet/gi, inScripts: true },
  { name: "manual by design", pattern: /manual[ -]by[ -]design/gi, inScripts: true },
  { name: "unstable version string", pattern: /\b\d+-unstable-\d{4}-\d{2}-\d{2}\b/g, inScripts: false },
  { name: "placeholder: not stored by this run", pattern: /not stored by this run/gi, inScripts: true },
  { name: "placeholder: not reviewed for publication", pattern: /not reviewed for publication/gi, inScripts: true },
  // #37631: public pages (including HTML attributes such as <option value="...">) must never carry launcher flags,
  // store/binary paths, permissions, mux or outer-terminal internals.
  { name: "launcher nice flag", pattern: /\bnice\s+-n\s+\d+\b/g, inScripts: false, inAllAttributes: true },
  { name: "nix store path", pattern: /\/nix\/store\/[a-z0-9]{10,}/g, inScripts: false, inAllAttributes: true },
  {
    name: "terminal binary path",
    pattern: /\/bin\/(?:kitty|xterm|alacritty|ghostty|wezterm|warp|tmux|screen)\b/gi,
    inScripts: false,
    inAllAttributes: true,
  },
  { name: "internal context permissions", pattern: /\bperms\s+[a-z0-9-]+/gi, inScripts: true, inAllAttributes: true },
  {
    name: "internal context mux/outer",
    pattern: /·\s*(?:mux|outer)\s+[a-z0-9._-]+/gi,
    inScripts: true,
    inAllAttributes: true,
  },
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

/** A page's search and link-preview description, which a reader meets in search results and shared links. */
const SEARCH_DESCRIPTION =
  /^<meta\b(?=[^>]*\s(?:name|property)\s*=\s*["'](?:description|og:description|twitter:description)["'])[^>]*\scontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i

const ANY_ATTRIBUTE = /\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const READ_ATTR_NAME = /^(?:title|data-tooltip|aria-label|alt)$/i

function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, name: string) => ENTITY[name] ?? " ")
}

/**
 * A built page's reader text: its visible text plus the read attribute values (@cto 97ba8eea D11) and its search
 * description, entities decoded. A state named only in script data or in another attribute is not counted.
 */
export function visibleText(html: string): string {
  return decodeEntities(
    html.replace(SCRIPT_OR_STYLE, " ").replace(TAG, (tag) => {
      const read = [...tag.matchAll(READ_ATTRIBUTE)].map((match) => match[1] ?? match[2] ?? "")
      const description = tag.match(SEARCH_DESCRIPTION)
      if (description) read.push(description[1] ?? description[2] ?? "")
      return " " + read.join(" ") + " "
    }),
  )
}

/** Non-read HTML attribute values outside `<script>`/`<style>`, entity-decoded (for host-path leak scanning, #37631). */
function extraAttributeValues(html: string): string {
  const values: string[] = []
  for (const tag of html.replace(SCRIPT_OR_STYLE, " ").matchAll(TAG)) {
    for (const attr of tag[0].matchAll(ANY_ATTRIBUTE)) {
      const name = attr[1]
      const val = attr[2] ?? attr[3]
      if (name && val && !READ_ATTR_NAME.test(name)) values.push(val)
    }
  }
  return decodeEntities(values.join(" "))
}

function countsIn(
  text: string,
  inScripts: boolean,
  versionText = text,
  attributeText = "",
): Array<{ name: string; count: number }> {
  return INTERNAL_STATE_TEXT.filter((needle) => !inScripts || needle.inScripts)
    .map((needle) => {
      const primary =
        (needle.name === "unstable version string" ? versionText : text).match(needle.pattern)?.length ?? 0
      const inAttrs =
        !inScripts && needle.inAllAttributes && attributeText ? (attributeText.match(needle.pattern)?.length ?? 0) : 0
      return { name: needle.name, count: primary + inAttrs }
    })
    .filter(({ count }) => count > 0)
}

/** One disclosure reducer; only the version policy retains ordinary closed reader content. */
function disclosureText(html: string, technicalOnly = false): string {
  let text = html.replace(SCRIPT_OR_STYLE, " ")
  let previous: string
  do {
    previous = text
    // Innermost first: a closed technical ancestor also hides an open child's provenance.
    text = text.replace(
      /<details\b((?:"[^"]*"|'[^']*'|[^'">])*)>((?:(?!<details\b)[\s\S])*?)<\/details>/gi,
      (_whole: string, attrs: string, body: string) => {
        const names = attrs.replace(/"[^"]*"|'[^']*'/g, "")
        const summary = body.match(/<summary\b[^>]*>[\s\S]*?<\/summary>/i)
        const ownSummary =
          summary &&
          !body
            .slice(0, summary.index)
            .replace(/<!--[\s\S]*?-->/g, "")
            .trim()
        const technical = ownSummary && visibleText(summary[0]).trim() === "Technical details"
        const shown = /(?:^|\s)open(?:\s|=|$)/i.test(names) || (technicalOnly && !technical)
        // A reduced child's summary stays readable, but cannot become its ancestor's own summary.
        const reader = visibleText("<details" + attrs + ">") + visibleText(shown ? body : (summary?.[0] ?? ""))
        return reader.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      },
    )
  } while (text !== previous)
  return visibleText(text)
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
    let publicJson = content
    if (isJson && rel.split(sep).join("/") === "api/v3/data.json") {
      const data = parseJsonStrict(full, content) as { working?: { run?: { id?: string; startedAt?: string } } }
      if (Object.hasOwn(data, "working")) {
        const stampPath = join(distDir, "build.json")
        const stamp = existsSync(stampPath)
          ? (parseJsonStrict(stampPath, readFileSync(stampPath, "utf8")) as {
              context?: string
              sourceCommit?: string
              githubRun?: unknown
              workingRun?: { id?: string; startedAt?: string }
            })
          : null
        const run = data.working?.run
        const internal =
          stamp?.context === "local" &&
          stamp.githubRun === null &&
          /^[a-f\d]{40}$/i.test(stamp.sourceCommit ?? "") &&
          typeof run?.id === "string" &&
          run.id.length > 0 &&
          Number.isFinite(Date.parse(run.startedAt ?? "")) &&
          stamp.workingRun?.id === run.id &&
          stamp.workingRun.startedAt === run.startedAt
        if (internal) {
          // Only this stamped private view is raw; the accepted projection is checked unchanged.
          const { working: _working, ...accepted } = data
          publicJson = JSON.stringify(accepted)
        } else {
          violations.push({
            layer: "rendered",
            path: `dist/${rel}`,
            reason: "public JSON contains an internal working view without a matching local build identity",
          })
        }
      }
    }
    let versionText = ""
    if (isPage) {
      // Raw measured versions belong in closed provenance; other internal labels keep their full scan.
      versionText = disclosureText(content, true)
      const technical =
        disclosureText(content).match(
          /\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b|\brun[-_][a-f\d]{8,64}\b|(?<![\w/])\b[a-f\d]{32,64}\b|\b(?:SHA-?256|run ID|suite ID|suite|source|capture)\s*[:=]?\s+[a-f\d]{8,64}\b|\bContext\s*\[\s*["'](?:term|lib|mux)["']/gi,
        ) ?? []
      if (technical.length) {
        violations.push({
          layer: "rendered",
          path: `dist/${rel}`,
          reason: `Page shows technical measurement metadata x${technical.length}: ${technical.slice(0, 3).join(", ")}; keep provenance in collapsed Technical details.`,
        })
      }
    }
    const undecided = isJson ? (publicJson.match(UNDECIDED_JSON_STATUS)?.length ?? 0) : 0
    const found = isJson
      ? undecided > 0
        ? [{ name: "undecided status value", count: undecided }]
        : []
      : isPage
        ? countsIn(visibleText(content), false, versionText, extraAttributeValues(content))
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
// Layer 5: CATALOGUE
// ---------------------------------------------------------------------------

/** The one readout (#37341 D2): "S supported · T of N tested". */
const READOUT = /(\d+) supported · (\d+) of (\d+) tested/g

const API_DATA = join("api", "v3", "data.json")

/**
 * The published catalogue is the public one (#37341 Q2, D6; @cto f6a09e55). The API's top-level catalogIds and features
 * name exactly `publicIds`, and each context's catalogIds names public ids only (@cto 87f47f5f). A readout on any
 * page counts over at most that many positions (a baseline row counts over its own, smaller list), with supported <=
 * tested <= positions. The home page prints at least one readout over the whole public catalogue. Each run receipt
 * (a context's sources, api/v3/runs) keeps every position its run measured (D132 B), so receipts are not read here.
 */
export function scanPublicCatalogue(distDir: string, publicIds: readonly string[]): Violation[] {
  const violations: Violation[] = []
  if (!existsSync(distDir)) return violations
  const want = [...publicIds].sort()
  const apiPath = join(distDir, API_DATA)
  if (!existsSync(apiPath)) {
    violations.push({
      layer: "catalogue",
      path: `dist/${API_DATA}`,
      reason: "missing, so the API's catalogue was not checked",
    })
  } else {
    const api = JSON.parse(readFileSync(apiPath, "utf-8")) as {
      catalogIds?: unknown
      features?: unknown
      contexts?: Record<string, { catalogIds?: unknown }>
    }
    const lists: Array<[string, unknown]> = [
      ["catalogIds", api.catalogIds],
      ["features", api.features && typeof api.features === "object" ? Object.keys(api.features) : api.features],
    ]
    for (const [field, value] of lists) {
      if (!Array.isArray(value)) {
        violations.push({ layer: "catalogue", path: `dist/${API_DATA}`, reason: `${field} is not a list of ids` })
        continue
      }
      const have = (value as unknown[]).map(String).sort()
      const extra = have.filter((id) => !want.includes(id))
      const missing = want.filter((id) => !have.includes(id))
      if (extra.length === 0 && missing.length === 0 && have.length === want.length) continue
      violations.push({
        layer: "catalogue",
        path: `dist/${API_DATA}`,
        reason: `${field} names ${have.length} ids, the public catalogue ${want.length}; not public: ${extra.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}`,
      })
    }
    const outside = new Map<string, string[]>()
    for (const [key, context] of Object.entries(api.contexts ?? {})) {
      if (!Array.isArray(context.catalogIds)) {
        outside.set(key, ["(catalogIds is not a list of ids)"])
        continue
      }
      const extra = (context.catalogIds as unknown[]).map(String).filter((id) => !want.includes(id))
      if (extra.length > 0) outside.set(key, extra)
    }
    if (outside.size > 0) {
      const named = [...outside].slice(0, 3).map(([key, ids]) => `${key} (${ids.join(", ")})`)
      violations.push({
        layer: "catalogue",
        path: `dist/${API_DATA}`,
        reason: `contexts.*.catalogIds names ids outside the public catalogue in ${outside.size} context(s): ${named.join("; ")}${outside.size > 3 ? "; and more" : ""}`,
      })
    }
  }
  let homeReadouts = 0
  walk(distDir, (full) => {
    if (!full.endsWith(".html")) return
    const rel = relative(distDir, full)
    const wrong: string[] = []
    for (const match of visibleText(readFileSync(full, "utf-8")).matchAll(READOUT)) {
      const [supported, tested, positions] = [match[1], match[2], match[3]].map(Number) as [number, number, number]
      if (positions > want.length || tested > positions || supported > tested) wrong.push(`"${match[0]}"`)
      else if (rel === "index.html" && positions === want.length) homeReadouts++
    }
    if (wrong.length > 0) {
      violations.push({
        layer: "catalogue",
        path: `dist/${rel}`,
        reason: `readout over more than the ${want.length}-position public catalogue, or with tested above positions: ${wrong.slice(0, 3).join(", ")}${wrong.length > 3 ? ` and ${wrong.length - 3} more` : ""}`,
      })
    }
  })
  if (homeReadouts === 0) {
    violations.push({
      layer: "catalogue",
      path: "dist/index.html",
      reason: `prints no readout "S supported · T of ${want.length} tested" over the whole public catalogue`,
    })
  }
  return violations
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export function checkPrivateLeak(docsDir: string, distDir: string = join(docsDir, ".vitepress", "dist")): Violation[] {
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

  const repoRoot = resolve(__dirname, "..")
  const distDir = process.argv[2] ? join(docsDir, ".vitepress", "dist") : siteDistDir(repoRoot)
  const builtNote = existsSync(distDir)
    ? `${DIM}(scanning source + built ${distDir} + sitemap + rendered text + public catalogue)${RESET}`
    : `${YELLOW}(no ${distDir} — source-only scan; run "bun run build" for full coverage)${RESET}`

  console.error(`${BOLD}check-private-leak${RESET} ${builtNote}`)

  const publicIds = publicFeatureIds(loadFeatures(join(repoRoot, "content")))
  const violations = [...checkPrivateLeak(docsDir, distDir), ...scanPublicCatalogue(distDir, publicIds)]

  if (violations.length === 0) {
    console.error(`${GREEN}✓${RESET} no internal/private content would be published`)
    process.exit(0)
  }

  console.error(`\n${RED}${BOLD}PRIVATE-CONTENT LEAK — ${violations.length} finding(s)${RESET}\n`)
  for (const v of violations) {
    console.error(`  ${RED}✗${RESET} [${v.layer}] ${BOLD}${v.path}${RESET}`)
    console.error(`      ${v.reason}`)
  }
  if (violations.some((v) => v.layer === "catalogue")) {
    console.error(
      `\n${YELLOW}The published catalogue is not the public one.${RESET} The API and every readout count the public` +
        ` positions only (publicFeatureIds, docs/data/public-features.ts); the nine environment positions stay out.\n`,
    )
  }
  if (violations.some((v) => v.layer !== "rendered" && v.layer !== "catalogue")) {
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
