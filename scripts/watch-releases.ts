#!/usr/bin/env bun
/**
 * Watch for new releases of tracked terminals.
 *
 * Reads content/probes-apps/ to find the latest probed terminal app version,
 * then scans complete, bounded GitHub/Codeberg feeds for the newest stable
 * version eligible at the one-calendar-month UTC cutoff.
 *
 * Usage:
 *   bun scripts/watch-releases.ts            # Human-readable report
 *   bun scripts/watch-releases.ts --json     # JSON output
 *   bun scripts/watch-releases.ts --at 2026-09-28T20:00:00Z
 *   bun scripts/watch-releases.ts --latest   # Current repair only; no month delay
 *   bun scripts/watch-releases.ts --update   # Catalog hint only; does not probe or publish
 *
 * Set GITHUB_TOKEN env var for higher rate limits (60 req/hr → 5000 req/hr).
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, "..")
const contentDir = join(rootDir, "content")
const terminalsPath = join(contentDir, "terminals.json")
const probesAppsDir = join(contentDir, "probes-apps")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReleaseSource {
  terminal: string
  label: string
  apiUrl: string
  type: "github" | "github-tags" | "codeberg"
}

export interface ReleaseCandidate {
  version: string
  tag: string
  publishedAt: string | null
  sourceUrl: string
  channel: "stable" | "prerelease" | "fork" | "unknown"
  excluded: string[]
}

interface ReleaseResult {
  terminal: string
  label: string
  currentVersion: string | null
  latestVersion: string | null
  latestDate: string | null
  sourceUrl: string | null
  cutoff: string
  policy: "monthly" | "latest"
  candidates: ReleaseCandidate[]
  isNewer: boolean
  error: string | null
}

// ---------------------------------------------------------------------------
// Release sources — terminals with known GitHub/Codeberg repos
// ---------------------------------------------------------------------------

const RELEASE_SOURCES: ReleaseSource[] = [
  {
    terminal: "kitty",
    label: "Kitty",
    apiUrl: "https://api.github.com/repos/kovidgoyal/kitty/releases",
    type: "github",
  },
  {
    terminal: "ghostty",
    label: "Ghostty",
    apiUrl: "https://api.github.com/repos/ghostty-org/ghostty/tags",
    type: "github-tags",
  },
  {
    terminal: "wezterm",
    label: "WezTerm",
    apiUrl: "https://api.github.com/repos/wez/wezterm/releases",
    type: "github",
  },
  {
    terminal: "foot",
    label: "foot",
    apiUrl: "https://codeberg.org/api/v1/repos/dnkl/foot/releases",
    type: "codeberg",
  },
  {
    terminal: "alacritty",
    label: "Alacritty",
    apiUrl: "https://api.github.com/repos/alacritty/alacritty/releases",
    type: "github",
  },
  {
    terminal: "com.microsoft.terminal",
    label: "Windows Terminal",
    apiUrl: "https://api.github.com/repos/microsoft/terminal/releases",
    type: "github",
  },
  {
    terminal: "mintty",
    label: "mintty",
    apiUrl: "https://api.github.com/repos/mintty/mintty/releases",
    type: "github",
  },
  {
    terminal: "contour",
    label: "Contour",
    apiUrl: "https://api.github.com/repos/contour-terminal/contour/releases",
    type: "github",
  },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip leading "v" from version tags (e.g. "v1.3.1" → "1.3.1"). */
function normalizeVersion(tag: string): string {
  return tag.replace(/^v/, "")
}

/**
 * Compare two semver-ish version strings.
 * Returns: -1 if a < b, 0 if equal, 1 if a > b.
 * Handles formats like "1.3.1", "0.46.2", "1.22.10.0".
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((s) => (/^\d+$/.test(s) ? Number(s) : s))
  const pb = b.split(/[.-]/).map((s) => (/^\d+$/.test(s) ? Number(s) : s))
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0
    const vb = pb[i] ?? 0
    if (typeof va === "number" && typeof vb === "number") {
      if (va < vb) return -1
      if (va > vb) return 1
    } else {
      const sa = String(va)
      const sb = String(vb)
      if (sa < sb) return -1
      if (sa > sb) return 1
    }
  }
  return 0
}

/** Subtract one calendar month in UTC, clamping a missing target day. */
export function calendarMonthCutoff(runAt: Date): Date {
  if (Number.isNaN(runAt.getTime())) throw new Error("Invalid scheduled UTC run time")
  const year = runAt.getUTCFullYear()
  const month = runAt.getUTCMonth()
  const targetYear = month === 0 ? year - 1 : year
  const targetMonth = month === 0 ? 11 : month - 1
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(runAt.getUTCDate(), lastDay),
      runAt.getUTCHours(),
      runAt.getUTCMinutes(),
      runAt.getUTCSeconds(),
      runAt.getUTCMilliseconds(),
    ),
  )
}

function parseUtcInstant(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value)
  if (!match) throw new Error("Scheduled run time must be an ISO UTC instant ending in Z")
  const date = new Date(value)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new Error("Scheduled UTC run time is not a real calendar instant")
  }
  return date
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function publicationTime(value: unknown, source: ReleaseSource, tag: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== "string") throw new Error(source.terminal + ": invalid publication time for " + tag)
  const parsed = parseUtcInstant(value)
  return parsed.toISOString()
}

function parseCandidate(source: ReleaseSource, raw: unknown): ReleaseCandidate {
  if (!isRecord(raw)) throw new Error(source.terminal + ": malformed release record")
  const tag = source.type === "github-tags" ? raw.name : raw.tag_name
  if (typeof tag !== "string" || tag.trim() === "") {
    throw new Error(source.terminal + ": release record has no tag")
  }
  const version = normalizeVersion(tag)
  const fork = /(?:^|[.+-])fork(?:[.+-]|$)/i.test(version)
  const prereleaseTag = /(?:^|[.+-])(alpha|beta|rc|pre|dev|nightly|tip)(?:[.+-]|$)/i.test(version)
  const stableTag = /^\d+(?:\.\d+){1,3}$/.test(version) || /^\d{8}-\d{6}-[0-9a-f]+$/i.test(version)
  let channel: ReleaseCandidate["channel"] = "stable"
  if (fork) channel = "fork"
  else if (prereleaseTag || raw.prerelease === true) channel = "prerelease"
  else if (!stableTag) channel = "unknown"
  if (source.type !== "github-tags" && (typeof raw.draft !== "boolean" || typeof raw.prerelease !== "boolean")) {
    throw new Error(source.terminal + ": release " + tag + " lacks draft/prerelease flags")
  }
  const publishedAt = source.type === "github-tags" ? null : publicationTime(raw.published_at, source, tag)
  const excluded: string[] = []
  if (raw.draft === true) excluded.push("draft")
  if (channel !== "stable") excluded.push(channel + " channel")
  if (publishedAt === null)
    excluded.push(source.type === "github-tags" ? "undated tag feed" : "missing publication time")
  const sourceUrl =
    source.type === "github-tags"
      ? source.apiUrl.replace("api.github.com/repos/", "github.com/").replace(/\/tags$/, "/releases/tag") +
        "/" +
        encodeURIComponent(tag)
      : raw.html_url
  if (typeof sourceUrl !== "string" || !/^https:\/\//.test(sourceUrl)) {
    throw new Error(source.terminal + ": release " + tag + " lacks a source URL")
  }
  return { version, tag, publishedAt, sourceUrl, channel, excluded }
}

/** Scan every page, including an empty terminal page; never stop on date order. */
export async function fetchReleaseFeed(
  source: ReleaseSource,
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch,
  maxPages = 20,
): Promise<ReleaseCandidate[]> {
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error("maxPages must be positive")
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "terminfo.dev/watch-releases" }
  const token = process.env.GITHUB_TOKEN
  if (token && source.type !== "codeberg") headers.Authorization = "Bearer " + token
  const candidates: ReleaseCandidate[] = []
  const seen = new Set<string>()
  for (let page = 1; page <= maxPages + 1; page++) {
    const url = new URL(source.apiUrl)
    url.searchParams.set("page", String(page))
    url.searchParams.set(source.type === "codeberg" ? "limit" : "per_page", "100")
    const res = await fetcher(url.toString(), { headers })
    if (!res.ok) {
      throw new Error(source.terminal + ": release page " + page + " returned HTTP " + res.status)
    }
    let data: unknown
    try {
      data = await res.json()
    } catch (error) {
      throw new Error(source.terminal + ": malformed JSON on release page " + page + ": " + String(error))
    }
    if (!Array.isArray(data)) throw new Error(source.terminal + ": release page " + page + " is not an array")
    if (data.length > 100) throw new Error(source.terminal + ": release page " + page + " exceeded requested limit")
    if (data.length === 0) return candidates
    if (page > maxPages) throw new Error(source.terminal + ": release feed incomplete after " + maxPages + " pages")
    for (const raw of data) {
      const candidate = parseCandidate(source, raw)
      if (seen.has(candidate.tag)) throw new Error(source.terminal + ": repeated release tag " + candidate.tag)
      seen.add(candidate.tag)
      candidates.push(candidate)
    }
  }
  throw new Error(source.terminal + ": release feed did not terminate")
}

export function selectEligibleRelease(
  candidates: ReleaseCandidate[],
  cutoff: Date,
): { selected: ReleaseCandidate | null; candidates: ReleaseCandidate[] } {
  const cutoffMs = cutoff.getTime()
  const withDisposition = candidates.map((candidate) => {
    const excluded = [...candidate.excluded]
    if (candidate.publishedAt && Date.parse(candidate.publishedAt) > cutoffMs) {
      excluded.push("published after cutoff")
    }
    return { ...candidate, excluded }
  })
  const eligible = withDisposition.filter((candidate) => candidate.excluded.length === 0)
  eligible.sort(
    (a, b) => compareVersions(b.version, a.version) || Date.parse(b.publishedAt!) - Date.parse(a.publishedAt!),
  )
  return { selected: eligible[0] ?? null, candidates: withDisposition }
}

/**
 * Find the latest probed app version. A Termless backend or library version is
 * a different identity and cannot establish the installed terminal app version.
 */
function findCurrentVersion(terminalId: string): string | null {
  const versions: string[] = []
  const files = readdirSync(probesAppsDir)
  for (const file of files) {
    if (!file.endsWith(".json")) continue
    // File format: terminal-version-platform.json or terminal-version.json
    if (!file.startsWith(terminalId + "-")) continue
    const path = join(probesAppsDir, file)
    let data: unknown
    try {
      data = JSON.parse(readFileSync(path, "utf-8"))
    } catch (error) {
      throw new Error("Invalid probe result " + path + ": " + String(error))
    }
    if (!isRecord(data)) throw new Error("Invalid probe result object " + path)
    const version = data.terminalVersion ?? data.version
    if (typeof version !== "string" || version === "") throw new Error("Missing probe version in " + path)
    versions.push(version)
  }

  if (versions.length === 0) return null

  // Return the highest version
  versions.sort(compareVersions)
  return versions[versions.length - 1]!
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  let jsonOutput = false
  let updateMode = false
  let latestMode = false
  let runAt = new Date()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--json") jsonOutput = true
    else if (arg === "--update") updateMode = true
    else if (arg === "--latest") latestMode = true
    else if (arg === "--at") {
      const value = args[++i]
      if (!value) throw new Error("--at requires an ISO UTC instant")
      runAt = parseUtcInstant(value)
    } else throw new Error("Unknown argument: " + arg)
  }
  if (jsonOutput && updateMode) throw new Error("--json and --update cannot be combined")
  const policy = latestMode ? "latest" : "monthly"
  const cutoff = latestMode ? runAt : calendarMonthCutoff(runAt)

  const results: ReleaseResult[] = []

  // Fetch all release pages for each source, even if API pages are out of date order.
  const promises = RELEASE_SOURCES.map(async (source): Promise<ReleaseResult> => {
    try {
      const currentVersion = findCurrentVersion(source.terminal)
      const selection = selectEligibleRelease(await fetchReleaseFeed(source), cutoff)
      const selected = selection.selected
      const isNewer =
        currentVersion !== null && selected !== null && compareVersions(currentVersion, selected.version) < 0

      return {
        terminal: source.terminal,
        label: source.label,
        currentVersion,
        latestVersion: selected?.version ?? null,
        latestDate: selected?.publishedAt ?? null,
        sourceUrl: selected?.sourceUrl ?? null,
        cutoff: cutoff.toISOString(),
        policy,
        candidates: selection.candidates,
        isNewer,
        error: null,
      }
    } catch (err) {
      return {
        terminal: source.terminal,
        label: source.label,
        currentVersion: null,
        latestVersion: null,
        latestDate: null,
        sourceUrl: null,
        cutoff: cutoff.toISOString(),
        policy,
        candidates: [],
        isNewer: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  })

  results.push(...(await Promise.all(promises)))

  // --json output
  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2))
    if (results.some((r) => r.error)) process.exitCode = 1
    return
  }

  // Human-readable output
  console.log()
  console.log(`  Release Watch — run ${runAt.toISOString()}, ${policy} cutoff ${cutoff.toISOString()}`)
  console.log()

  const labelWidth = Math.max(...results.map((r) => r.label.length))
  const curWidth = Math.max(...results.map((r) => (r.currentVersion ?? "unknown").length), "current:".length)
  const latWidth = Math.max(...results.map((r) => (r.latestVersion ?? "none").length), "eligible:".length)

  let hasNew = false
  for (const r of results) {
    const label = r.label.padEnd(labelWidth)
    const cur = (r.currentVersion ?? "unknown").padEnd(curWidth)
    const lat = (r.latestVersion ?? "none").padEnd(latWidth)

    let status: string
    if (r.error) {
      status = `⚠ ${r.error}`
    } else if (r.latestVersion === null) {
      const reasons = [...new Set(r.candidates.flatMap((candidate) => candidate.excluded))]
      status = `⚠ no eligible dated stable release (${reasons.join(", ") || "empty feed"})`
    } else if (r.currentVersion === null) {
      status = `  (not tracked locally)`
    } else if (r.isNewer) {
      status = `← NEW`
      hasNew = true
    } else {
      status = `✓ up to date`
    }

    console.log(`  ${label}  current: ${cur}  eligible: ${lat}  ${status}`)
  }

  console.log()
  const failures = results.filter((r) => r.error)
  if (failures.length > 0) {
    process.exitCode = 1
    if (updateMode) throw new Error("Refusing catalog update: " + failures.length + " release source(s) failed")
  }

  // This is only a catalog hint. A real probe and review remain separate.
  if (updateMode) {
    const newReleases = results.filter((r) => r.isNewer && r.latestVersion && r.latestDate && r.sourceUrl)
    if (newReleases.length === 0) {
      console.log("  No eligible new releases to record in terminals.json.")
      console.log()
      return
    }

    const raw = readFileSync(terminalsPath, "utf-8")
    const terminals: unknown = JSON.parse(raw)
    if (!isRecord(terminals)) throw new Error("Invalid terminals.json root object")

    for (const r of newReleases) {
      const terminal = terminals[r.terminal]
      if (!isRecord(terminal)) throw new Error("Missing catalog terminal " + r.terminal)
      terminal.latestRelease = {
        version: r.latestVersion,
        date: r.latestDate!.slice(0, 10),
        sourceUrl: r.sourceUrl,
        cutoff: r.cutoff,
        policy: r.policy,
        checkedAt: runAt.toISOString(),
      }
    }

    writeFileSync(terminalsPath, JSON.stringify(terminals, null, 2) + "\n")
    console.log(`  Recorded ${newReleases.length} eligible release hint(s) in terminals.json:`)
    for (const r of newReleases) {
      console.log(`    ${r.label}: ${r.currentVersion} → ${r.latestVersion}`)
    }
    console.log()
  } else if (hasNew) {
    console.log("  Run with --update to record eligible release hints in terminals.json")
    console.log()
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal:", err)
    process.exitCode = 1
  })
}
