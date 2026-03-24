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
  sgr: "Select Graphic Rendition (SGR) controls text styling: bold, italic, underline variants, colors, strikethrough, and other visual attributes. SGR sequences are the most commonly used escape codes — every TUI framework depends on them for rendering styled text. Support ranges from universal (bold, basic colors) to inconsistent (curly underline, hyperlinks).",
  cursor: "Cursor control sequences for positioning, visibility, shape, and save/restore operations. Correct cursor handling is essential for TUI applications that need precise text placement. Differences in DECSC/DECRC behavior and cursor shape support are common sources of cross-terminal bugs.",
  text: "Basic text output, wrapping, wide character handling (emoji, CJK), tabs, and line control. This category covers the fundamentals of terminal text rendering, including how terminals handle characters that occupy two columns (CJK ideographs, many emoji) and whether text reflows correctly when the terminal is resized.",
  erase: "Line and screen clearing operations for selective content removal. Erase sequences let applications clear portions of the screen or individual lines, optionally preserving or clearing character attributes. These sequences are heavily used by full-screen TUI applications during redraws.",
  modes: "Terminal modes control global terminal behavior: alternate screen buffer, bracketed paste, mouse tracking, focus events, and auto-wrap. Mode support varies significantly across terminals — mouse tracking modes alone have four variants (X10, normal, button, any-event), and not all terminals implement focus reporting or all bracketed paste edge cases.",
  scrollback: "Scroll buffer behavior, reverse index, total line tracking, and alternate screen interaction. Scrollback handling is one of the least standardized areas of terminal emulation — terminals differ in buffer size limits, whether alternate screen content enters scrollback, and how reverse index interacts with scroll regions.",
  reset: "Terminal reset operations: SGR attribute reset, full terminal reset (RIS), and programmatic reset. Reset behavior determines how reliably an application can return the terminal to a known state. Differences in what RIS resets (cursor position, modes, scroll regions, character sets) can cause subtle bugs.",
  extensions: "Modern terminal extensions beyond the traditional VT specification: Kitty keyboard protocol, Kitty graphics protocol, sixel inline images, OSC 8 hyperlinks, text reflow on resize, and semantic prompt markers (OSC 133). These features represent the cutting edge of terminal capability and vary widely in adoption across terminals.",
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
  "ecma-48": "Features defined in the ECMA-48 standard (also known as ISO/IEC 6429 and ANSI X3.64). These are the most fundamental terminal control sequences for cursor movement, text styling, and screen manipulation. Published in 1976 and revised through 1998, ECMA-48 defines the CSI (Control Sequence Introducer) format used by nearly all modern escape sequences.",
  "vt100": "Features from the original DEC VT100 terminal (1978) and its successors (VT220, VT320, VT420). These sequences form the foundation of modern terminal emulation — virtually every terminal today describes itself as \"VT100-compatible.\" The VT100 established conventions for cursor addressing, scrolling regions, character sets, and the escape sequence grammar that all later standards built upon.",
  "vt510": "Features from the DEC VT510 terminal, the last in the VT series. The VT510 extended the VT100 family with additional cursor control, display modes, and character set handling. While few terminals implement the full VT510 specification, specific features like DECSCA (select character protection attribute) and enhanced cursor save/restore appear in modern emulators.",
  "dec-private-modes": "DEC private mode sequences use the DECSET (CSI ? Pm h) and DECRST (CSI ? Pm l) format for toggling terminal behaviors. These control critical features like alternate screen buffer, origin mode, auto-wrap, cursor visibility, and mouse tracking. The \"private\" designation (the ? prefix) distinguishes them from ECMA-48 standard modes and allows vendor-specific extensions without conflicting with the standard.",
  "xterm-extensions": "Extensions introduced by xterm, the reference X Window System terminal emulator, and widely adopted across the ecosystem. These include 256-color and truecolor (24-bit) SGR sequences, the alternate screen buffer with saved cursor, mouse tracking modes (X10, normal, button-event, any-event), focus events, OSC 8 hyperlinks, and OSC 52 clipboard access. Most modern terminals implement xterm extensions as a de facto standard.",
  "kitty-extensions": "Extensions introduced by the Kitty terminal emulator. The Kitty keyboard protocol provides unambiguous, modifier-aware key reporting that solves longstanding terminal input limitations (distinguishing Ctrl+I from Tab, reporting key release events). The Kitty graphics protocol enables inline image display via a chunked base64 transfer mechanism. Kitty also introduced extended underline styles (curly, dotted, dashed) with configurable colors. These protocols are adopted by Ghostty, WezTerm, foot, and other modern terminals.",
  "osc": "Operating System Command (OSC) sequences use the ESC ] format for out-of-band communication between applications and the terminal. Common OSC sequences set the window title (OSC 0/2), manipulate the clipboard (OSC 52), define hyperlinks (OSC 8), and mark semantic prompt regions (OSC 133). The OSC namespace is open-ended, allowing terminals to define new sequences without conflicting with CSI-based control codes.",
  "sixel": "Sixel is a bitmap graphics format originally developed by DEC for the VT240 and VT340 terminals. It encodes raster images as printable ASCII characters, where each character represents a 1x6 pixel column — hence the name \"six pixels.\" Sixel support has been revived in modern terminals (xterm, foot, WezTerm, mlterm) as a way to display inline images without requiring a proprietary protocol.",
  "unicode": "Unicode text handling tests whether terminals correctly calculate the display width of characters that occupy two terminal columns. CJK ideographs, many emoji (especially combined sequences like family emoji), and certain symbols are \"wide\" characters that take two cells. Incorrect width calculation causes text misalignment, cursor positioning errors, and broken TUI layouts — making this one of the most impactful compatibility issues in practice.",
}

export function tagLabel(tag: string): string {
  return tagLabels[tag] ?? tag.charAt(0).toUpperCase() + tag.slice(1).replace(/-/g, " ")
}
