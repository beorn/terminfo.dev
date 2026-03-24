/**
 * Shared census data loader for dynamic route generators.
 *
 * Loads data from census.data.ts at build time and provides
 * helper functions for slug generation and category labels.
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import censusLoader from "./census.data"
import type { CensusData } from "./census.data"

export type { CensusData }

const __dirname = dirname(fileURLToPath(import.meta.url))

let _cached: CensusData | null = null

export function loadCensus(): CensusData {
  if (!_cached) _cached = censusLoader.load()
  return _cached
}

export interface FeatureMeta {
  name: string
  url?: string
  tags?: string[]
  group?: string
}

let _featuresMeta: Record<string, FeatureMeta> | null = null

/** Load features.json with tags and groups (richer than census featureDescriptions) */
export function loadFeaturesMeta(): Record<string, FeatureMeta> {
  if (!_featuresMeta) {
    try {
      const path = join(__dirname, "..", "..", "features.json")
      const raw = JSON.parse(readFileSync(path, "utf-8"))
      delete raw.$comment
      _featuresMeta = raw
    } catch {
      _featuresMeta = {}
    }
  }
  return _featuresMeta!
}

/** Get all unique tags from features.json */
export function getAllTags(): string[] {
  const meta = loadFeaturesMeta()
  const tags = new Set<string>()
  for (const entry of Object.values(meta)) {
    for (const tag of entry.tags ?? []) {
      tags.add(tag)
    }
  }
  return [...tags].sort()
}

/** Get feature IDs that have a given tag */
export function getFeaturesForTag(tag: string): string[] {
  const meta = loadFeaturesMeta()
  return Object.entries(meta)
    .filter(([_, entry]) => entry.tags?.includes(tag))
    .map(([id]) => id)
}

/** Convert feature dot-path ID to URL slug: "sgr.underline.curly" -> "sgr-underline-curly" */
export function featureSlug(id: string): string {
  return id.replaceAll(".", "-")
}

/**
 * Convert backend name to a URL-friendly terminal slug using the label.
 * ghostty-native -> ghostty, xtermjs -> xterm-js, ghostty (WASM) -> ghostty-wasm
 */
export function terminalSlug(name: string, meta: CensusData["meta"]): string {
  const label = (meta[name]?.label ?? name).toLowerCase()
  return label.replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "")
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

export const tagLabels: Record<string, string> = {
  "ecma-48": "ECMA-48 Standard",
  "vt100": "VT100",
  "vt510": "VT510",
  "dec-private-modes": "DEC Private Modes",
  "xterm-extensions": "Xterm Extensions",
  "kitty-extensions": "Kitty Extensions",
  "osc": "Operating System Commands (OSC)",
  "sixel": "Sixel Graphics",
  "unicode": "Unicode",
}

export const tagDescriptions: Record<string, string> = {
  "ecma-48": "Features defined in the ECMA-48 standard (also known as ISO/IEC 6429 and ANSI X3.64). These are the most fundamental terminal control sequences for cursor movement, text styling, and screen manipulation.",
  "vt100": "Features from the original DEC VT100 terminal (1978) and its successors. These sequences form the foundation of modern terminal emulation.",
  "vt510": "Features specific to the DEC VT510 terminal, extending the VT100 family with additional cursor control and display modes.",
  "dec-private-modes": "DEC private mode sequences (DECSET/DECRST) for terminal behavior control: alternate screen, cursor keys, mouse tracking, auto-wrap, and more.",
  "xterm-extensions": "Extensions introduced by xterm and widely adopted: 256-color and truecolor support, alternate screen buffer, mouse tracking, focus events, text reflow, and hyperlinks.",
  "kitty-extensions": "Extensions introduced by the Kitty terminal: enhanced keyboard protocol, graphics protocol for inline images, and extended underline styles.",
  "osc": "Operating System Command sequences for out-of-band communication: window titles, hyperlinks, semantic prompt markers.",
  "sixel": "Sixel graphics protocol for inline raster images in the terminal, originally from DEC terminals.",
  "unicode": "Unicode text handling: correct width calculation for CJK characters and emoji that occupy two terminal columns.",
}

export function tagLabel(tag: string): string {
  return tagLabels[tag] ?? tag.charAt(0).toUpperCase() + tag.slice(1).replace(/-/g, " ")
}
