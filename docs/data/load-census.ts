/**
 * Shared census data loader for dynamic route generators.
 *
 * Loads data from census.data.ts at build time and provides
 * helper functions for slug generation and category labels.
 */
import censusLoader from "./census.data"
import type { CensusData } from "./census.data"

export type { CensusData }

let _cached: CensusData | null = null

export function loadCensus(): CensusData {
  if (!_cached) _cached = censusLoader.load()
  return _cached
}

/** Convert feature dot-path ID to URL slug: "sgr.underline.curly" -> "sgr-underline-curly" */
export function featureSlug(id: string): string {
  return id.replaceAll(".", "-")
}

/** Convert URL slug back to feature ID: "sgr-underline-curly" -> "sgr.underline.curly" */
export function slugToFeatureId(slug: string, features: CensusData["features"]): string | undefined {
  // Direct match first (replace hyphens with dots)
  const candidate = slug.replaceAll("-", ".")
  if (features.some((f) => f.id === candidate)) return candidate

  // Ambiguous case: try all features and match by slug
  return features.find((f) => featureSlug(f.id) === slug)?.id
}

export const categoryLabels: Record<string, string> = {
  sgr: "SGR (Text Styling)",
  cursor: "Cursor",
  text: "Text",
  erase: "Erase",
  modes: "Modes",
  scrollback: "Scrollback",
  reset: "Reset",
  extensions: "Extensions",
}

export function catLabel(cat: string): string {
  return categoryLabels[cat] ?? cat.charAt(0).toUpperCase() + cat.slice(1)
}

export const categoryDescriptions: Record<string, string> = {
  sgr: "Select Graphic Rendition (SGR) controls text styling: bold, italic, underline variants, colors, strikethrough, and other visual attributes.",
  cursor: "Cursor control sequences for positioning, visibility, and save/restore operations.",
  text: "Basic text output, wrapping, wide character handling (emoji, CJK), tabs, and line control.",
  erase: "Line and screen clearing operations for selective content removal.",
  modes: "Terminal modes including alternate screen, bracketed paste, mouse/focus tracking, and auto-wrap.",
  scrollback: "Scroll buffer behavior, reverse index, total line tracking, and alternate screen interaction.",
  reset: "Terminal reset operations: SGR attribute reset, full terminal reset (RIS), and programmatic reset.",
  extensions: "Modern terminal extensions: kitty keyboard/graphics, sixel, OSC 8 hyperlinks, text reflow, semantic prompts.",
}
