/**
 * Custom markdown-it plugin for glossary/entity linking.
 * Replaces vitepress-plugin-glossary with correct longest-match-first,
 * every-occurrence linking, and support for inline formatting contexts.
 *
 * Renders: <a href="/path" class="hover-link" data-tooltip="expansion — description">term</a>
 * Uses existing CSS tooltip infrastructure (tooltip.css + glossary-links.css).
 *
 * Skips: code spans, code blocks, fences, existing links, headings.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type MarkdownIt from "markdown-it"
import type Token from "markdown-it/lib/token.mjs"

interface Entity {
  term: string
  pattern: RegExp
  href: string
  tooltip: string
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function buildEntityList(contentDir: string): Entity[] {
  const entities: Entity[] = []

  // 1. Glossary terms (all terms, no length filter — curated)
  try {
    const raw = JSON.parse(readFileSync(join(contentDir, "glossary.json"), "utf-8")) as Record<
      string,
      { expansion: string; description: string; link?: string }
    >
    for (const [key, entry] of Object.entries(raw)) {
      if (!entry.link) continue
      entities.push({
        term: key,
        pattern: new RegExp(`\\b${escapeRegex(key)}\\b`, "g"),
        href: entry.link,
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
        pattern: new RegExp(`\\b${escapeRegex(t.label)}\\b`, "g"),
        href: `/terminal/${t.slug}`,
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
        pattern: new RegExp(`\\b${escapeRegex(f.label)}\\b`, "g"),
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
        pattern: new RegExp(`\\b${escapeRegex(s.label)}\\b`, "g"),
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
        pattern: new RegExp(`\\b${escapeRegex(c.label)}\\b`, "g"),
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
        pattern: new RegExp(`\\b${escapeRegex(b.label)}\\b`, "g"),
        href: `/baseline/${id}`,
        tooltip: b.tagline || `${b.label} baseline`,
      })
    }
  } catch {}

  // Deduplicate: same term from multiple sources — first wins (glossary > terminals > ...)
  const seen = new Set<string>()
  const deduped: Entity[] = []
  for (const e of entities) {
    if (seen.has(e.term)) continue
    seen.add(e.term)
    deduped.push(e)
  }

  // Sort longest term first so "Kitty keyboard protocol" matches before "Kitty"
  deduped.sort((a, b) => b.term.length - a.term.length)

  return deduped
}

/**
 * Replace entity mentions in a text string with <a> tags.
 * Entities are processed longest-first; positions already matched are skipped.
 */
function replaceEntities(text: string, entities: Entity[]): string {
  // Collect all matches with positions
  const matches: Array<{ start: number; end: number; entity: Entity }> = []
  const occupied = new Set<number>()

  for (const entity of entities) {
    entity.pattern.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = entity.pattern.exec(text)) !== null) {
      const start = m.index
      const end = start + m[0].length
      let overlap = false
      for (let p = start; p < end; p++) {
        if (occupied.has(p)) {
          overlap = true
          break
        }
      }
      if (overlap) continue
      for (let p = start; p < end; p++) occupied.add(p)
      matches.push({ start, end, entity })
    }
  }

  if (matches.length === 0) return text

  // Apply in reverse order so offsets stay valid
  matches.sort((a, b) => b.start - a.start)
  let result = text
  for (const { start, end, entity } of matches) {
    const original = result.slice(start, end)
    const tooltip = entity.tooltip ? ` data-tooltip="${escapeAttr(entity.tooltip)}"` : ""
    result = result.slice(0, start) + `<a href="${entity.href}" class="hover-link"${tooltip}>${original}</a>` + result.slice(end)
  }
  return result
}

/**
 * Determine if a text token at index `idx` is inside a link or heading.
 * Walks backwards through inline children tokens to find open/close context.
 */
function isInsideLinkOrHeading(tokens: Token[], idx: number): { insideLink: boolean; insideHeading: boolean } {
  let insideLink = false
  let insideHeading = false

  for (let i = idx - 1; i >= 0; i--) {
    const t = tokens[i]
    if (t.type === "link_open") {
      insideLink = true
      break
    }
    if (t.type === "link_close") break
    if (t.type === "heading_open") {
      insideHeading = true
      break
    }
    if (t.type === "heading_close") break
  }

  return { insideLink, insideHeading }
}

/**
 * Replace entity mentions in raw HTML content (html_block tokens).
 * Skips text inside tags, <a>, <code>, <h1>–<h6>, and <script>/<style>.
 */
function replaceInHtml(html: string, entities: Entity[]): string {
  // Identify text regions outside HTML tags and skip zones
  const skipTags = /^<(a|code|h[1-6]|script|style|pre)\b/i
  const skipClose = /^<\/(a|code|h[1-6]|script|style|pre)>/i
  const textRegions: Array<{ start: number; end: number }> = []
  let i = 0
  let skipDepth = 0

  while (i < html.length) {
    if (html[i] === "<") {
      const tagEnd = html.indexOf(">", i)
      if (tagEnd === -1) break
      const tag = html.slice(i, tagEnd + 1)

      if (skipClose.test(tag)) {
        skipDepth = Math.max(0, skipDepth - 1)
      } else if (skipTags.test(tag)) {
        skipDepth++
      }
      i = tagEnd + 1
    } else {
      if (skipDepth === 0) {
        const nextTag = html.indexOf("<", i)
        const end = nextTag === -1 ? html.length : nextTag
        if (end > i) textRegions.push({ start: i, end })
        i = end
      } else {
        const nextTag = html.indexOf("<", i)
        i = nextTag === -1 ? html.length : nextTag
      }
    }
  }

  // Collect matches across text regions
  const matches: Array<{ start: number; end: number; entity: Entity }> = []
  const occupied = new Set<number>()

  for (const entity of entities) {
    for (const region of textRegions) {
      const segment = html.slice(region.start, region.end)
      entity.pattern.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = entity.pattern.exec(segment)) !== null) {
        const absStart = region.start + m.index
        const absEnd = absStart + m[0].length
        let overlap = false
        for (let p = absStart; p < absEnd; p++) {
          if (occupied.has(p)) { overlap = true; break }
        }
        if (overlap) continue
        for (let p = absStart; p < absEnd; p++) occupied.add(p)
        matches.push({ start: absStart, end: absEnd, entity })
      }
    }
  }

  if (matches.length === 0) return html

  matches.sort((a, b) => b.start - a.start)
  let result = html
  for (const { start, end, entity } of matches) {
    const original = result.slice(start, end)
    const tooltip = entity.tooltip ? ` data-tooltip="${escapeAttr(entity.tooltip)}"` : ""
    result = result.slice(0, start) + `<a href="${entity.href}" class="hover-link"${tooltip}>${original}</a>` + result.slice(end)
  }
  return result
}

export function glossaryLinksPlugin(md: MarkdownIt, contentDir: string) {
  const entities = buildEntityList(contentDir)

  // Override the core rule to process inline token children.
  // markdown-it inline tokens contain children: [text, em_open, text, em_close, text, ...]
  // We need to process text tokens within those children, respecting link/heading context.
  //
  // We override md.core.ruler to walk block tokens (paragraphs, etc.),
  // find their inline children, and replace text tokens that contain entity matches.
  md.core.ruler.push("glossary_links", (state) => {
    for (const blockToken of state.tokens) {
      // Process HTML blocks (tables, divs embedded in markdown)
      if (blockToken.type === "html_block" && blockToken.content) {
        blockToken.content = replaceInHtml(blockToken.content, entities)
        continue
      }

      // Only process inline tokens (paragraphs, list items, etc.)
      if (blockToken.type !== "inline" || !blockToken.children) continue

      // Check if this inline is inside a heading
      const blockIdx = state.tokens.indexOf(blockToken)
      let inHeading = false
      for (let i = blockIdx - 1; i >= 0; i--) {
        if (state.tokens[i].type === "heading_open") {
          inHeading = true
          break
        }
        if (state.tokens[i].type === "heading_close") break
      }
      if (inHeading) continue

      // Process children: find text tokens not inside links or code
      const children = blockToken.children
      const newChildren: Token[] = []

      let insideLink = false
      for (const child of children) {
        if (child.type === "link_open") {
          insideLink = true
          newChildren.push(child)
          continue
        }
        if (child.type === "link_close") {
          insideLink = false
          newChildren.push(child)
          continue
        }

        // Skip code_inline tokens and anything inside a link
        if (child.type === "code_inline" || insideLink) {
          newChildren.push(child)
          continue
        }

        // Only process text tokens
        if (child.type !== "text") {
          newChildren.push(child)
          continue
        }

        const replaced = replaceEntities(child.content, entities)
        if (replaced === child.content) {
          // No changes — keep original token
          newChildren.push(child)
          continue
        }

        // The replaced string contains HTML (<a> tags). We need to emit it
        // as an html_inline token so markdown-it renders it as raw HTML.
        const htmlToken = new state.Token("html_inline", "", 0)
        htmlToken.content = replaced
        newChildren.push(htmlToken)
      }

      blockToken.children = newChildren
    }
  })
}
