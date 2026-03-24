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
  slug?: string
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

/** Convert feature dot-path ID to URL slug, using features.json slug if available */
export function featureSlug(id: string): string {
  const meta = loadFeaturesMeta()
  return meta[id]?.slug ?? id.replaceAll(".", "-")
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
  editing: "Editing",
  modes: "Modes",
  scrollback: "Scrollback",
  reset: "Reset",
  extensions: "Extensions",
  charsets: "Character Sets",
  device: "Device Status",
}

export function catLabel(cat: string): string {
  return categoryLabels[cat] ?? cat.charAt(0).toUpperCase() + cat.slice(1)
}

export const categoryDescriptions: Record<string, string> = {
  sgr: "Select Graphic Rendition (SGR) controls text styling: bold, italic, underline variants, colors, strikethrough, and other visual attributes. SGR sequences are the most commonly used escape codes — every TUI framework depends on them for rendering styled text. Support ranges from universal (bold, basic colors) to inconsistent (curly underline, hyperlinks).",
  cursor:
    "Cursor control sequences for positioning, visibility, shape, and save/restore operations. Correct cursor handling is essential for TUI applications that need precise text placement. Differences in DECSC/DECRC behavior and cursor shape support are common sources of cross-terminal bugs.",
  text: "Basic text output, wrapping, wide character handling (emoji, CJK), tabs, and line control. This category covers the fundamentals of terminal text rendering, including how terminals handle characters that occupy two columns (CJK ideographs, many emoji) and whether text reflows correctly when the terminal is resized.",
  erase:
    "Line and screen clearing operations for selective content removal. Erase sequences let applications clear portions of the screen or individual lines, optionally preserving or clearing character attributes. These sequences are heavily used by full-screen TUI applications during redraws.",
  editing:
    "Insert and delete operations for characters and lines. ICH, DCH, IL, and DL are core VT100/VT220 sequences used by virtually every full-screen terminal application (vim, tmux, less). They allow inserting blank space or removing content at the cursor position, shifting surrounding content to accommodate the change.",
  modes:
    "Terminal modes control global terminal behavior: alternate screen buffer, bracketed paste, mouse tracking, focus events, and auto-wrap. Mode support varies significantly across terminals — mouse tracking modes alone have four variants (X10, normal, button, any-event), and not all terminals implement focus reporting or all bracketed paste edge cases.",
  scrollback:
    "Scroll buffer behavior, reverse index, total line tracking, and alternate screen interaction. Scrollback handling is one of the least standardized areas of terminal emulation — terminals differ in buffer size limits, whether alternate screen content enters scrollback, and how reverse index interacts with scroll regions.",
  reset:
    "Terminal reset operations: SGR attribute reset, full terminal reset (RIS), and programmatic reset. Reset behavior determines how reliably an application can return the terminal to a known state. Differences in what RIS resets (cursor position, modes, scroll regions, character sets) can cause subtle bugs.",
  extensions:
    "Modern terminal extensions beyond the traditional VT specification: Kitty keyboard protocol, Kitty graphics protocol, sixel inline images, OSC 8 hyperlinks, text reflow on resize, and semantic prompt markers (OSC 133). These features represent the cutting edge of terminal capability and vary widely in adoption across terminals.",
  charsets:
    "Character set designation and invocation sequences from the VT100. The DEC Special Graphics set (activated with ESC ( 0) provides box-drawing characters used by legacy TUI applications for borders and frames. Modern terminals typically default to UTF-8, making explicit character set switching less common — but the DEC Special Graphics set remains widely used.",
  device:
    "Device attributes and status reporting sequences. Applications use DA1 (Device Attributes) to identify terminal type and capabilities, and DSR (Device Status Report) to query cursor position and terminal health. These query-response sequences are essential for terminal capability detection and are used by shell integration, TUI frameworks, and terminal multiplexers.",
}

export const tagLabels: Record<string, string> = {
  "ecma-48": "ECMA-48 Standard",
  vt100: "VT100",
  vt220: "VT220",
  vt510: "VT510",
  "dec-private-modes": "DEC Private Modes",
  "xterm-extensions": "Xterm Extensions",
  "kitty-extensions": "Kitty Extensions",
  osc: "Operating System Commands (OSC)",
  sixel: "Sixel Graphics",
  unicode: "Unicode",
}

export const tagUrls: Record<string, string> = {
  "ecma-48": "https://ecma-international.org/publications-and-standards/standards/ecma-48/",
  vt100: "https://vt100.net/docs/vt100-ug/",
  vt220: "https://vt100.net/docs/vt220-rm/contents.html",
  vt510: "https://vt100.net/docs/vt510-rm/contents.html",
  "dec-private-modes":
    "https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h3-Functions-using-CSI-_-ordered-by-the-final-character_s_",
  "xterm-extensions": "https://invisible-island.net/xterm/ctlseqs/ctlseqs.html",
  "kitty-extensions": "https://sw.kovidgoyal.net/kitty/protocol-extensions/",
  osc: "https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h3-Operating-System-Commands",
  sixel: "https://en.wikipedia.org/wiki/Sixel",
  unicode: "https://unicode.org/reports/tr11/",
}

export const tagDescriptions: Record<string, string> = {
  "ecma-48":
    "Features defined in the ECMA-48 standard (also known as ISO/IEC 6429 and ANSI X3.64). ECMA-48 defines the CSI (Control Sequence Introducer) grammar that all modern escape sequences use, including SGR (Select Graphic Rendition) for text styling, cursor movement (CUP, CUU, CUD, CUF, CUB), erase operations (EL, ED), and scroll control (SU, SD). First published in 1976 (5th edition 1991), the standard itself is frozen — but terminals continue to extend the SGR parameter space with vendor extensions (e.g., Kitty's underline variants SGR 4:3–4:5) that use ECMA-48's sub-parameter syntax without being part of the standard.",
  vt100:
    'Features from the DEC VT100 terminal (1978), the de facto standard for terminal emulation. The VT100 defined the escape sequence grammar (ESC [ for CSI), cursor addressing (CUP), scrolling regions (DECSTBM), and character sets that virtually every terminal emulates today. When a terminal calls itself "VT100-compatible," it means it supports this baseline. The VT series continued through VT220 (1983, added 8-bit controls), VT320 (1987), VT420 (1990), and VT510 (1993), each adding features — but VT100 remains the foundational compatibility target.',
  vt220:
    "Features from the DEC VT220 terminal (1983), which added insert/delete character operations (ICH, DCH), 8-bit control codes, user-defined keys, and national replacement character sets. The VT220's editing sequences (ICH, DCH, IL, DL) are fundamental to full-screen terminal applications — they allow inserting and deleting characters and lines without redrawing the entire screen. Modern terminals universally support VT220 editing operations.",
  vt510:
    "Features from the DEC VT510 (1993), the final terminal in DEC's VT series. The VT510 added cursor visibility control (DECTCEM), reverse video mode (DECSCNM), and scroll up/down commands (SU/SD). While no modern terminal implements the full VT510 specification, specific VT510 features like DECTCEM have become universal. The VT510 Reference Manual remains the most complete documentation of DEC escape sequences and is frequently cited as a primary reference for terminal implementors.",
  "dec-private-modes":
    'DEC private mode sequences toggle terminal behaviors using DECSET (CSI ? Pm h) to enable and DECRST (CSI ? Pm l) to disable. The "?" prefix marks them as private (vendor-defined), separate from ECMA-48\'s standard mode numbers. Originally defined by DEC for the VT series, this namespace has been extended by xterm and other terminals. Key modes include: cursor visibility (DECTCEM, ?25), auto-wrap (DECAWM, ?7), alternate screen (?1049), mouse tracking (?1000–1006), bracketed paste (?2004), and focus events (?1004). DEC private modes are the primary mechanism for feature negotiation between applications and terminals.',
  "xterm-extensions":
    "Extensions introduced by xterm, the reference X11 terminal emulator maintained by Thomas Dickey, and adopted as de facto standards across the ecosystem. xterm pioneered 256-color (SGR 38;5/48;5) and truecolor (SGR 38;2/48;2) support, the alternate screen buffer with cursor save (?1049), four mouse tracking modes (X10, normal, button-event, any-event), focus reporting (?1004), bracketed paste (?2004), OSC 8 hyperlinks, OSC 52 clipboard access, and text reflow on resize. The xterm control sequences document (ctlseqs) is the most comprehensive reference for modern terminal escape sequences.",
  "kitty-extensions":
    "Protocols introduced by the Kitty terminal emulator (Kovid Goyal). The Kitty keyboard protocol provides unambiguous, modifier-aware key reporting — solving longstanding terminal input limitations like distinguishing Ctrl+I from Tab and reporting key-up events. The Kitty graphics protocol enables inline image display via chunked base64 transfer. Kitty also defined extended underline styles (curly SGR 4:3, dotted SGR 4:4, dashed SGR 4:5) with underline colors (SGR 58). These extensions use ECMA-48's sub-parameter syntax (colon-separated) but are not part of the ECMA-48 standard. Adopted by Ghostty, WezTerm, foot, and other modern terminals.",
  osc: 'Operating System Command (OSC) sequences use the ESC ] format for out-of-band communication between applications and the terminal emulator. Unlike CSI sequences which control the terminal\'s display, OSC sequences communicate with the "operating system" (the terminal application itself). Key sequences: window title (OSC 0/2), clipboard access (OSC 52), hyperlinks (OSC 8), color palette queries (OSC 4/10/11), semantic prompt markers (OSC 133), and notification (OSC 9/777). The OSC namespace is open-ended — any terminal can define new numbers without conflicting with CSI-based control codes.',
  sixel:
    'Sixel is a bitmap graphics format originally developed by DEC for the VT240 (1983) and VT340 terminals. It encodes raster images as printable ASCII characters, where each character represents a 1×6 pixel column — hence the name "six pixels." The format uses DCS (Device Control String) sequences to transmit image data inline with text. Sixel was largely dormant until its revival in modern terminals (xterm, foot, WezTerm, mlterm, contour) as a way to display inline images using only standard escape sequences, without requiring a terminal-specific protocol like Kitty graphics.',
  unicode:
    'Unicode text handling tests whether terminals correctly calculate the display width of characters. East Asian characters (CJK ideographs) and many emoji occupy two terminal columns ("wide" or "fullwidth"), while most Latin/Cyrillic/Arabic characters occupy one. The Unicode Standard Annex #11 (UAX #11) defines width classes, but terminals must also handle combining characters, variation selectors, zero-width joiners, and emoji sequences — each of which can change the effective display width. Incorrect width calculation causes cursor positioning errors, text misalignment, and broken TUI layouts.',
}

export function tagLabel(tag: string): string {
  return tagLabels[tag] ?? tag.charAt(0).toUpperCase() + tag.slice(1).replace(/-/g, " ")
}
