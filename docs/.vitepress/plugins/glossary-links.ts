/**
 * Terminfo.dev glossary plugin — loads entities from content/*.json files
 * and delegates to vitepress-enrich for auto-linking.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type MarkdownIt from "markdown-it"
import { glossaryPlugin, loadEcosystemGlossary } from "vitepress-enrich"
import type { GlossaryEntity } from "vitepress-enrich"

const GENERIC_PAGES = new Set(["/glossary", "/features", "/standards", "/about"])

function loadEntities(contentDir: string): GlossaryEntity[] {
  const entities: GlossaryEntity[] = []

  // 1. Glossary terms (all terms, no length filter — curated)
  try {
    const raw = JSON.parse(readFileSync(join(contentDir, "glossary.json"), "utf-8")) as Record<
      string,
      { expansion: string; description: string; link?: string }
    >
    for (const [key, entry] of Object.entries(raw)) {
      if (!entry.link) continue
      const isGeneric = GENERIC_PAGES.has(entry.link)
      entities.push({
        term: key,
        href: isGeneric ? undefined : entry.link,
        tooltip: `${entry.expansion} — ${entry.description}`,
      })
    }
  } catch {}

  // 2. Terminals
  try {
    const raw = JSON.parse(readFileSync(join(contentDir, "terminals.json"), "utf-8")) as Record<
      string,
      { label?: string; slug?: string; description?: string }
    >
    for (const [, t] of Object.entries(raw)) {
      if (!t.label || !t.slug || t.label.length < 3) continue
      entities.push({
        term: t.label,
        href: `/terminals/${t.slug}`,
        tooltip: t.description || `${t.label} terminal emulator`,
      })
    }
  } catch {}

  // 3. Frameworks
  try {
    const raw = JSON.parse(readFileSync(join(contentDir, "frameworks.json"), "utf-8")) as Record<
      string,
      { label?: string; description?: string }
    >
    for (const [id, f] of Object.entries(raw)) {
      if (!f.label || f.label.length < 3) continue
      entities.push({
        term: f.label,
        href: `/framework/${id}`,
        tooltip: f.description || `${f.label} TUI framework`,
      })
    }
  } catch {}

  // 4. Standards
  try {
    const raw = JSON.parse(readFileSync(join(contentDir, "standards.json"), "utf-8")) as Record<
      string,
      { label?: string; description?: string }
    >
    for (const [id, s] of Object.entries(raw)) {
      if (!s.label || s.label.length < 3) continue
      entities.push({
        term: s.label,
        href: `/${id}`,
        tooltip: s.description?.slice(0, 150) || s.label,
      })
    }
  } catch {}

  // 5. Categories
  try {
    const raw = JSON.parse(readFileSync(join(contentDir, "categories.json"), "utf-8")) as Record<
      string,
      { label?: string; description?: string }
    >
    for (const [id, c] of Object.entries(raw)) {
      if (!c.label || c.label.length < 4) continue
      entities.push({
        term: c.label,
        href: `/${id}`,
        tooltip: c.description?.slice(0, 150) || c.label,
      })
    }
  } catch {}

  // 6. Baselines
  try {
    const raw = JSON.parse(readFileSync(join(contentDir, "baselines.json"), "utf-8")) as Record<
      string,
      { label?: string; tagline?: string }
    >
    for (const [id, b] of Object.entries(raw)) {
      if (!b.label || b.label.length < 4) continue
      entities.push({
        term: b.label,
        href: `/baseline/${id}`,
        tooltip: b.tagline || `${b.label} baseline`,
      })
    }
  } catch {}

  return entities
}

/**
 * Terminfo.dev glossary plugin — loads entities from content/*.json
 * and uses vitepress-enrich for the auto-linking engine.
 */
export function glossaryLinksPlugin(md: MarkdownIt, contentDir: string): void {
  const entities = [...loadEntities(contentDir), ...loadEcosystemGlossary({ exclude: ["terminfo.dev"] })]
  glossaryPlugin(md, { entities })
}
