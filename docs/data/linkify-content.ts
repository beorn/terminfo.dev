/**
 * Build-time content linkification for terminfo.dev — wraps known entity names
 * in HTML links. Used by [id].paths.ts to linkify descriptions before passing
 * to Vue templates.
 *
 * Loads entities from content/*.json and delegates to @bearly/vitepress-enrich.
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createLinkifier } from "@bearly/vitepress-enrich"
import type { GlossaryEntity } from "@bearly/vitepress-enrich"

const __dirname = dirname(fileURLToPath(import.meta.url))
const contentDir = join(__dirname, "..", "..", "content")

let _linkify: ((text: string) => string) | null = null

function loadEntities(): GlossaryEntity[] {
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
      if (!t.label || !t.slug || t.label.length < 4) continue
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
      if (!f.label || f.label.length < 4) continue
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
      if (!s.label || s.label.length < 4) continue
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

  return entities
}

/**
 * Linkify plain text content — wraps known entity names in <a> tags.
 * Safe for use with v-html. Skips text already inside HTML tags.
 */
export function linkifyContent(text: string): string {
  if (!_linkify) {
    _linkify = createLinkifier(loadEntities())
  }
  return _linkify(text)
}
