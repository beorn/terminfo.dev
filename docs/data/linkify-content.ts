/**
 * Build-time content linkification — wraps known entity names in HTML links.
 * Used by [id].paths.ts to linkify descriptions before passing to Vue templates.
 *
 * Reads from content/*.json to build entity list. Reuses the same data
 * that the glossary plugin uses, but works on strings at build time
 * (not markdown at parse time).
 */
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const contentDir = join(__dirname, "..", "..", "content")

interface Entity {
  pattern: RegExp
  href: string
  title?: string
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

let _entities: Entity[] | null = null

function loadEntities(): Entity[] {
  if (_entities) return _entities
  const entities: Entity[] = []

  // Glossary terms (CSI, SGR, ECMA-48, CUP, etc. — no length filter, all curated)
  try {
    const raw = JSON.parse(readFileSync(join(contentDir, "glossary.json"), "utf-8")) as Record<string, any>
    for (const [key, entry] of Object.entries(raw)) {
      if (!entry.link) continue
      entities.push({
        pattern: new RegExp(`\\b${escapeRegex(key)}\\b`, "g"),
        href: entry.link,
        title: `${entry.expansion} — ${entry.description}`,
      })
    }
  } catch {}

  // Terminals
  try {
    const raw = JSON.parse(readFileSync(join(contentDir, "terminals.json"), "utf-8")) as Record<string, any>
    for (const [, t] of Object.entries(raw)) {
      if (!t.label || !t.slug || t.label.length < 4) continue
      entities.push({
        pattern: new RegExp(`\\b${escapeRegex(t.label)}\\b`, "g"),
        href: `/terminal/${t.slug}`,
        title: t.description,
      })
    }
  } catch {}

  // Frameworks
  try {
    const raw = JSON.parse(readFileSync(join(contentDir, "frameworks.json"), "utf-8")) as Record<string, any>
    for (const [id, f] of Object.entries(raw)) {
      if (!f.label || f.label.length < 4) continue
      entities.push({
        pattern: new RegExp(`\\b${escapeRegex(f.label)}\\b`, "g"),
        href: `/framework/${id}`,
      })
    }
  } catch {}

  // Standards
  try {
    const raw = JSON.parse(readFileSync(join(contentDir, "standards.json"), "utf-8")) as Record<string, any>
    for (const [id, s] of Object.entries(raw)) {
      if (!s.label || s.label.length < 4) continue
      entities.push({
        pattern: new RegExp(`\\b${escapeRegex(s.label)}\\b`, "g"),
        href: `/${id}`,
      })
    }
  } catch {}

  // Baselines
  try {
    const raw = JSON.parse(readFileSync(join(contentDir, "baselines.json"), "utf-8")) as Record<string, any>
    for (const [id, b] of Object.entries(raw)) {
      if (!b.label || b.label.length < 4) continue
      entities.push({
        pattern: new RegExp(`\\b${escapeRegex(b.label)}\\b`, "g"),
        href: `/baseline/${id}`,
      })
    }
  } catch {}

  // Sort longest patterns first
  entities.sort((a, b) => b.pattern.source.length - a.pattern.source.length)
  _entities = entities
  return entities
}

/**
 * Linkify plain text content — wraps known entity names in <a> tags.
 * Safe for use with v-html. Skips text already inside HTML tags.
 *
 * Uses a two-pass approach to avoid replacing inside generated attributes:
 * 1. Find all matches on the original text (collect offsets)
 * 2. Apply replacements in reverse order (so offsets stay valid)
 */
export function linkifyContent(text: string): string {
  if (!text) return text
  const entities = loadEntities()

  // First: identify text regions (outside HTML tags and <a>...</a> blocks)
  const textRegions: Array<{ start: number; end: number }> = []
  let i = 0
  while (i < text.length) {
    if (text[i] === "<") {
      const tagEnd = text.indexOf(">", i)
      if (tagEnd === -1) break
      const tag = text.slice(i, tagEnd + 1)
      if (tag.startsWith("<a ") || tag === "<a>") {
        const closeA = text.indexOf("</a>", tagEnd)
        i = closeA !== -1 ? closeA + 4 : tagEnd + 1
      } else {
        i = tagEnd + 1
      }
    } else {
      const nextTag = text.indexOf("<", i)
      const end = nextTag === -1 ? text.length : nextTag
      if (end > i) textRegions.push({ start: i, end })
      i = end
    }
  }

  // Second: collect all matches across text regions
  const matches: Array<{ start: number; end: number; href: string; title?: string }> = []
  const occupied = new Set<number>()

  for (const { pattern, href, title } of entities) {
    for (const region of textRegions) {
      const segment = text.slice(region.start, region.end)
      pattern.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = pattern.exec(segment)) !== null) {
        const absStart = region.start + m.index
        const absEnd = absStart + m[0].length
        // Check no overlap with previous matches
        let overlap = false
        for (let p = absStart; p < absEnd; p++) {
          if (occupied.has(p)) { overlap = true; break }
        }
        if (overlap) continue
        for (let p = absStart; p < absEnd; p++) occupied.add(p)
        matches.push({ start: absStart, end: absEnd, href, title })
      }
    }
  }

  // Third: apply in reverse order so offsets stay valid
  matches.sort((a, b) => b.start - a.start)
  let result = text
  for (const { start, end, href, title } of matches) {
    const original = result.slice(start, end)
    result = result.slice(0, start) + `<a href="${href}" class="hover-link">${original}</a>` + result.slice(end)
  }

  return result
}
