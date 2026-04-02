/**
 * Build-time content linkification for terminfo.dev — wraps known entity names
 * in HTML links. Used by [id].paths.ts to linkify descriptions before passing
 * to Vue templates.
 *
 * Loads entities from content/*.json and delegates to vitepress-enrich.
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createLinkifier } from "vitepress-enrich"
import type { GlossaryEntity } from "vitepress-enrich"

const __dirname = dirname(fileURLToPath(import.meta.url))
const contentDir = join(__dirname, "..", "..", "content")

let _entities: GlossaryEntity[] | null = null
let _defaultLinkify: ((text: string) => string) | null = null

function loadEntities(): GlossaryEntity[] {
  if (_entities) return _entities

  const entities: GlossaryEntity[] = []

  // Glossary terms
  try {
    const raw = JSON.parse(readFileSync(join(contentDir, "glossary.json"), "utf-8")) as Record<string, any>
    for (const [key, entry] of Object.entries(raw)) {
      if (!entry.link) continue
      entities.push({
        term: key,
        href: entry.link,
        tooltip: `${entry.expansion} — ${entry.description}`,
      })
    }
  } catch {}

  // Terminals
  try {
    const raw = JSON.parse(readFileSync(join(contentDir, "terminals.json"), "utf-8")) as Record<string, any>
    for (const [, t] of Object.entries(raw)) {
      if (!t.label || !t.slug || t.label.length < 3) continue
      entities.push({
        term: t.label,
        href: `/terminals/${t.slug}`,
        tooltip: t.description,
      })
    }
  } catch {}

  // Frameworks
  try {
    const raw = JSON.parse(readFileSync(join(contentDir, "frameworks.json"), "utf-8")) as Record<string, any>
    for (const [id, f] of Object.entries(raw)) {
      if (!f.label || f.label.length < 3) continue
      entities.push({
        term: f.label,
        href: `/framework/${id}`,
      })
    }
  } catch {}

  // Standards
  try {
    const raw = JSON.parse(readFileSync(join(contentDir, "standards.json"), "utf-8")) as Record<string, any>
    for (const [id, s] of Object.entries(raw)) {
      if (!s.label || s.label.length < 3) continue
      entities.push({
        term: s.label,
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
        term: b.label,
        href: `/baseline/${id}`,
      })
    }
  } catch {}

  // Categories
  try {
    const raw = JSON.parse(readFileSync(join(contentDir, "categories.json"), "utf-8")) as Record<string, any>
    for (const [id, c] of Object.entries(raw)) {
      if (!c.label || c.label.length < 4) continue
      entities.push({
        term: c.label,
        href: `/${id}`,
      })
    }
  } catch {}

  _entities = entities
  return entities
}

/**
 * Linkify plain text content — wraps known entity names in <a> tags.
 * Safe for use with v-html. Skips text already inside HTML tags.
 */
export function linkifyContent(text: string): string {
  if (!_defaultLinkify) {
    _defaultLinkify = createLinkifier(loadEntities())
  }
  return _defaultLinkify(text)
}

/**
 * Strip existing self-links from pre-linkified HTML content.
 * Converts `<a href="/path" ...>text</a>` back to plain `text`
 * for any href in the exclude set.
 */
function stripSelfLinks(html: string, excludeHrefs: Set<string>): string {
  return html.replace(/<a\s+href="([^"]+)"[^>]*>([^<]*)<\/a>/g, (match, href, text) =>
    excludeHrefs.has(href) ? text : match,
  )
}

/**
 * Linkify content with self-link exclusion — prevents circular links
 * on a page about the given entity. Pass the page's own href(s) to exclude.
 * Also strips pre-existing self-links from already-linkified content
 * (e.g., analysis.json entries generated before self-link prevention).
 */
export function linkifyContentExcluding(text: string, excludeHrefs: Set<string>): string {
  const stripped = stripSelfLinks(text, excludeHrefs)
  const linkify = createLinkifier(loadEntities(), { excludeHrefs })
  return linkify(stripped)
}
