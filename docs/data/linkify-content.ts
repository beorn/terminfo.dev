/**
 * Build-time content linkification for terminfo.dev — wraps known entity names
 * in HTML links. Used by [id].paths.ts to linkify descriptions before passing
 * to Vue templates.
 *
 * Loads entities from content/*.json through vitepress-enrich and delegates
 * replacement to the shared entity engine.
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createLinkifier } from "vitepress-enrich"

interface GlossaryEntity {
  term: string
  href?: string
  tooltip?: string
}

interface GlossaryEntry {
  expansion?: string
  description?: string
  link?: string
}

interface FeatureEntry {
  name?: string
  slug?: string
  body?: string
  probe?: string
}

interface TerminalEntry {
  label?: string
  slug?: string
  description?: string
}

interface FrameworkEntry {
  label?: string
  description?: string
}

interface LabeledEntry {
  label?: string
  description?: string
  tagline?: string
}

interface TerminfoEntitiesOptions {
  tooltipOnlyHrefs?: Iterable<string>
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const contentDir = join(__dirname, "..", "..", "content")

let _entities: GlossaryEntity[] | null = null
let _defaultLinkify: ((text: string) => string) | null = null

function readContentJson<T>(name: string): Record<string, T> {
  try {
    return JSON.parse(readFileSync(join(contentDir, name), "utf-8")) as Record<string, T>
  } catch {
    return {}
  }
}

function cleanText(value: unknown): string {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function summarize(value: unknown, fallback: string | undefined): string {
  const text = cleanText(value) || cleanText(fallback)
  if (text.length <= 180) return text
  return `${text.slice(0, 177).trimEnd()}...`
}

function featureHref(id: string, entry: FeatureEntry): string {
  const category = id.split(".")[0] || id
  const slug = entry.slug ?? id.replaceAll(".", "-")
  return `/${category}/${slug}`
}

function parentheticalAliases(term: string): string[] {
  return [...term.matchAll(/\(([^()]+)\)/g)].map((match) => match[1]!.trim()).filter((alias) => alias.length >= 3)
}

function pushEntity(
  entities: GlossaryEntity[],
  term: string | undefined,
  href: string | undefined,
  tooltip: string,
  tooltipOnlyHrefs: Set<string>,
  minLength: number,
): void {
  const cleaned = term?.trim()
  if (!cleaned || cleaned.length < minLength) return
  entities.push({ term: cleaned, href: href && !tooltipOnlyHrefs.has(href) ? href : undefined, tooltip })
}

// CI installs vitepress-enrich from npm; keep the terminfo-specific loader local
// until that published package owns this export.
export function loadTerminfoEntities(options: TerminfoEntitiesOptions = {}): GlossaryEntity[] {
  const entities: GlossaryEntity[] = []
  const tooltipOnlyHrefs = new Set(options.tooltipOnlyHrefs ?? [])

  const glossary = readContentJson<GlossaryEntry>("glossary.json")
  for (const [term, entry] of Object.entries(glossary)) {
    if (!entry.link) continue
    const tooltip = entry.expansion
      ? `${entry.expansion}: ${cleanText(entry.description)}`
      : summarize(entry.description, term)
    pushEntity(entities, term, entry.link, tooltip, tooltipOnlyHrefs, 0)
  }

  const features = readContentJson<FeatureEntry>("features.json")
  for (const [id, entry] of Object.entries(features)) {
    if (!entry.name) continue
    const href = featureHref(id, entry)
    const tooltip = summarize(entry.body ?? entry.probe, entry.name)
    pushEntity(entities, entry.name, href, tooltip, tooltipOnlyHrefs, 3)
    for (const alias of parentheticalAliases(entry.name)) {
      pushEntity(entities, alias, href, tooltip, tooltipOnlyHrefs, 3)
    }
  }

  const terminals = readContentJson<TerminalEntry>("terminals.json")
  for (const entry of Object.values(terminals)) {
    pushEntity(
      entities,
      entry.label,
      entry.slug ? `/terminals/${entry.slug}` : undefined,
      summarize(entry.description, `${entry.label} terminal emulator`),
      tooltipOnlyHrefs,
      3,
    )
  }

  const frameworks = readContentJson<FrameworkEntry>("frameworks.json")
  for (const [id, entry] of Object.entries(frameworks)) {
    pushEntity(
      entities,
      entry.label,
      `/framework/${id}`,
      summarize(entry.description, `${entry.label} TUI framework`),
      tooltipOnlyHrefs,
      3,
    )
  }

  const standards = readContentJson<LabeledEntry>("standards.json")
  for (const [id, entry] of Object.entries(standards)) {
    pushEntity(entities, entry.label, `/${id}`, summarize(entry.description, entry.label ?? id), tooltipOnlyHrefs, 3)
  }

  const categories = readContentJson<LabeledEntry>("categories.json")
  for (const [id, entry] of Object.entries(categories)) {
    pushEntity(entities, entry.label, `/${id}`, summarize(entry.description, entry.label ?? id), tooltipOnlyHrefs, 4)
  }

  const baselines = readContentJson<LabeledEntry>("baselines.json")
  for (const [id, entry] of Object.entries(baselines)) {
    pushEntity(
      entities,
      entry.label,
      `/baseline/${id}`,
      summarize(entry.tagline ?? entry.description, `${entry.label} baseline`),
      tooltipOnlyHrefs,
      4,
    )
  }

  return entities
}

function loadEntities(): GlossaryEntity[] {
  if (_entities) return _entities
  _entities = loadTerminfoEntities()
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
