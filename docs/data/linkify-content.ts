/**
 * Build-time content linkification for terminfo.dev — wraps known entity names
 * in HTML links. Used by [id].paths.ts to linkify descriptions before passing
 * to Vue templates.
 *
 * Loads entities from content/*.json through vitepress-enrich and delegates
 * replacement to the shared entity engine.
 */
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createLinkifier, loadTerminfoEntities } from "vitepress-enrich"
import type { GlossaryEntity } from "vitepress-enrich"

const __dirname = dirname(fileURLToPath(import.meta.url))
const contentDir = join(__dirname, "..", "..", "content")

let _entities: GlossaryEntity[] | null = null
let _defaultLinkify: ((text: string) => string) | null = null

function loadEntities(): GlossaryEntity[] {
  if (_entities) return _entities
  _entities = loadTerminfoEntities(contentDir)
  return _entities
}

/**
 * Linkify plain text content — wraps known entity names in <a> tags.
 * Safe for use with v-html. Skips text already inside HTML tags.
 */
export function linkifyContent(text: string): string {
  if (!_defaultLinkify) {
    _defaultLinkify = createLinkifier(loadEntities())
  }
  return _defaultLinkify!(text)
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
  const filtered = loadEntities().filter((e) => !e.href || !excludeHrefs.has(e.href))
  const linkify = createLinkifier(filtered)
  return linkify(stripped)
}
