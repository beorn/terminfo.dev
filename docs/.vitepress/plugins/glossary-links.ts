/**
 * Terminfo.dev glossary plugin — loads entities from content/*.json files
 * and delegates to vitepress-enrich for auto-linking.
 */
import type MarkdownIt from "markdown-it"
import { glossaryPlugin, loadEcosystemGlossary } from "vitepress-enrich"
import { loadTerminfoEntities } from "../../data/linkify-content"

const GENERIC_PAGES = new Set(["/glossary", "/features", "/standards", "/about"])

/**
 * Terminfo.dev glossary plugin — loads entities from content/*.json
 * and uses vitepress-enrich for the auto-linking engine.
 */
export function glossaryLinksPlugin(md: MarkdownIt, _contentDir: string): void {
  const entities = [
    ...loadTerminfoEntities({ tooltipOnlyHrefs: GENERIC_PAGES }),
    ...loadEcosystemGlossary({ exclude: ["terminfo.dev"] }),
  ]
  glossaryPlugin(md, { entities })
}
