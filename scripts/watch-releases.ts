#!/usr/bin/env bun
/**
 * Watch for new releases of tracked terminals.
 *
 * Reads content/probes-apps/ and content/probes-libs/ to find the latest
 * probed version of each terminal, then fetches the latest release from
 * GitHub/Codeberg to see if newer versions are available.
 *
 * Usage:
 *   bun scripts/watch-releases.ts            # Human-readable report
 *   bun scripts/watch-releases.ts --json     # JSON output
 *   bun scripts/watch-releases.ts --update   # Update terminals.json with new versions
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
const probesLibsDir = join(contentDir, "probes-libs")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReleaseSource {
  terminal: string
  label: string
  apiUrl: string
  type: "github" | "github-tags" | "codeberg"
}

interface ReleaseResult {
  terminal: string
  label: string
  currentVersion: string | null
  latestVersion: string | null
  latestDate: string | null
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
    apiUrl: "https://api.github.com/repos/kovidgoyal/kitty/releases/latest",
    type: "github",
  },
  {
    terminal: "ghostty",
    label: "Ghostty",
    apiUrl: "https://api.github.com/repos/ghostty-org/ghostty/tags?per_page=1",
    type: "github-tags",
  },
  {
    terminal: "wezterm",
    label: "WezTerm",
    apiUrl: "https://api.github.com/repos/wez/wezterm/releases/latest",
    type: "github",
  },
  {
    terminal: "foot",
    label: "foot",
    apiUrl: "https://codeberg.org/api/v1/repos/dnkl/foot/releases?limit=1",
    type: "codeberg",
  },
  {
    terminal: "alacritty",
    label: "Alacritty",
    apiUrl: "https://api.github.com/repos/alacritty/alacritty/releases/latest",
    type: "github",
  },
  {
    terminal: "com.microsoft.terminal",
    label: "Windows Terminal",
    apiUrl: "https://api.github.com/repos/microsoft/terminal/releases/latest",
    type: "github",
  },
  {
    terminal: "mintty",
    label: "mintty",
    apiUrl: "https://api.github.com/repos/mintty/mintty/releases/latest",
    type: "github",
  },
  {
    terminal: "contour",
    label: "Contour",
    apiUrl: "https://api.github.com/repos/contour-terminal/contour/releases/latest",
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

/**
 * Find the latest probed version for a terminal by scanning probe result files.
 * Checks both probes-apps/ and probes-libs/ directories.
 */
function findCurrentVersion(terminalId: string): string | null {
  const versions: string[] = []

  for (const dir of [probesAppsDir, probesLibsDir]) {
    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue
      // File format: terminal-version-platform.json or terminal-version.json
      if (!file.startsWith(terminalId + "-")) continue
      try {
        const data = JSON.parse(readFileSync(join(dir, file), "utf-8"))
        if (data.terminalVersion) {
          versions.push(data.terminalVersion)
        }
      } catch {
        // Skip unparseable files
      }
    }
  }

  if (versions.length === 0) return null

  // Return the highest version
  versions.sort(compareVersions)
  return versions[versions.length - 1]!
}

/**
 * Fetch the latest release from a GitHub or Codeberg API endpoint.
 */
async function fetchLatestRelease(source: ReleaseSource): Promise<{ version: string; date: string }> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "terminfo.dev/watch-releases",
  }

  const token = process.env.GITHUB_TOKEN
  if (token && (source.type === "github" || source.type === "github-tags")) {
    headers.Authorization = `Bearer ${token}`
  }

  const res = await fetch(source.apiUrl, { headers })

  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get("x-ratelimit-reset")
    const resetIn = reset ? Math.ceil((Number(reset) * 1000 - Date.now()) / 60000) : "?"
    throw new Error(`Rate limited (resets in ~${resetIn} min). Set GITHUB_TOKEN for higher limits.`)
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`)
  }

  const data = await res.json()

  if (source.type === "github-tags") {
    // Tags API returns an array of {name, ...} — no date info
    const tags = Array.isArray(data) ? data : [data]
    if (tags.length === 0) throw new Error("No tags found")
    return {
      version: normalizeVersion(tags[0].name),
      date: "", // Tags don't carry date info
    }
  }

  if (source.type === "codeberg") {
    // Codeberg returns an array
    const release = Array.isArray(data) ? data[0] : data
    if (!release) throw new Error("No releases found")
    return {
      version: normalizeVersion(release.tag_name),
      date: release.published_at ?? release.created_at,
    }
  }

  // GitHub returns a single object for /releases/latest
  return {
    version: normalizeVersion(data.tag_name),
    date: data.published_at ?? data.created_at,
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  const jsonOutput = args.includes("--json")
  const updateMode = args.includes("--update")

  const results: ReleaseResult[] = []

  // Fetch all releases in parallel
  const promises = RELEASE_SOURCES.map(async (source): Promise<ReleaseResult> => {
    const currentVersion = findCurrentVersion(source.terminal)

    try {
      const { version: latestVersion, date } = await fetchLatestRelease(source)
      const isNewer = currentVersion !== null ? compareVersions(currentVersion, latestVersion) < 0 : false

      return {
        terminal: source.terminal,
        label: source.label,
        currentVersion,
        latestVersion,
        latestDate: date,
        isNewer,
        error: null,
      }
    } catch (err) {
      return {
        terminal: source.terminal,
        label: source.label,
        currentVersion,
        latestVersion: null,
        latestDate: null,
        isNewer: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  })

  results.push(...(await Promise.all(promises)))

  // --json output
  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2))
    return
  }

  // Human-readable output
  const today = new Date().toISOString().slice(0, 10)
  console.log()
  console.log(`  Release Watch — ${today}`)
  console.log()

  const labelWidth = Math.max(...results.map((r) => r.label.length))
  const curWidth = Math.max(...results.map((r) => (r.currentVersion ?? "unknown").length), "current:".length)
  const latWidth = Math.max(...results.map((r) => (r.latestVersion ?? "error").length), "latest:".length)

  let hasNew = false
  for (const r of results) {
    const label = r.label.padEnd(labelWidth)
    const cur = (r.currentVersion ?? "unknown").padEnd(curWidth)
    const lat = (r.latestVersion ?? "error").padEnd(latWidth)

    let status: string
    if (r.error) {
      status = `⚠ ${r.error}`
    } else if (r.currentVersion === null) {
      status = `  (not tracked locally)`
    } else if (r.isNewer) {
      status = `← NEW`
      hasNew = true
    } else {
      status = `✓ up to date`
    }

    console.log(`  ${label}  current: ${cur}  latest: ${lat}  ${status}`)
  }

  console.log()

  // --update: write new versions into terminals.json
  if (updateMode) {
    const newReleases = results.filter((r) => r.isNewer && r.latestVersion)
    if (newReleases.length === 0) {
      console.log("  Nothing to update — all tracked terminals are current.")
      console.log()
      return
    }

    const raw = readFileSync(terminalsPath, "utf-8")
    const terminals = JSON.parse(raw)

    for (const r of newReleases) {
      if (terminals[r.terminal]) {
        terminals[r.terminal].latestRelease = {
          version: r.latestVersion,
          date: r.latestDate?.slice(0, 10) ?? null,
          checkedAt: new Date().toISOString(),
        }
      }
    }

    writeFileSync(terminalsPath, JSON.stringify(terminals, null, 2) + "\n")
    console.log(`  Updated terminals.json with ${newReleases.length} new version(s):`)
    for (const r of newReleases) {
      console.log(`    ${r.label}: ${r.currentVersion} → ${r.latestVersion}`)
    }
    console.log()
  } else if (hasNew) {
    console.log("  Run with --update to write new versions to terminals.json")
    console.log()
  }
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
