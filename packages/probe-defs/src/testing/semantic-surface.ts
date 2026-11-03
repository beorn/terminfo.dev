/**
 * One semantic headless surface for the candidate-2 group contracts (#28023 Erase, #28024 Reset).
 *
 * #28453 leaves the headless model to the group, so a group that needs a terminal supplies one. Two
 * groups needing the same terminal share ONE implementation rather than each reinventing the fake:
 * this surface really performs the operations the Erase, Reset, Text, Editing, Character Sets and
 * Unicode probes exercise - EL 0/1/2, ED 0/1/2/3, ECH, DECSED with DECSCA protection, DECSTBM with a
 * real scrollback count, SGR attributes, RIS, DECSTR, DECALN, DECCKM, the text primitives (CR, BS,
 * IND, NEL, RI and the HT/HTS/TBC/CHT/CBT tab family), grapheme-aware writing (a wide cluster claims
 * two columns and a combining mark rides its base), the character-set family (SI/SO selecting G0/G1,
 * ESC ( and ESC ) designation and the DEC Special Graphics mapping) and the editing family (ICH, DCH,
 * IL, DL, REP, SL, SR, DECIC, DECDC, DECFRA, DECERA, DECSERA, DECCRA, DECCARA, DECRARA and the
 * DECRQCRA reply) - so a row reads "supported" only when the probe's own expectation agrees with a
 * terminal that really does the thing.
 *
 * `mutations` injects one named fault so a group can prove its binding is not a stamp: "el-noop"
 * makes EL inert (the Erase group's negative control), "ris-noop" makes RIS inert (Reset's),
 * "charset-noop" leaves a G0/G1 designation unmapped (Character Sets'), and "ht-noop" freezes HT
 * (Unicode's tab-stops control). Scrollback adds "scrollregion-noop" (DECSTBM set and reset inert)
 * and "altscreen-noop" (ESC[?1049h/l inert) so its three newly decided rows prove their binding.
 * Erase's two attribute rows add "decsca-noop" (a selective erase takes the protected cell too) and
 * "el-default-bg" (EL drops the current background), the frames @chief ruled are measured negatives
 * rather than unnamed unknowns (2026-10-11T22:58Z).
 *
 * @fakes @terminfo/probe-defs
 */
import type { LibProbeSource, ModeState } from "../types.ts"
import type { HeadlessModel } from "./group-harness.ts"

type Rgb = { readonly r: number; readonly g: number; readonly b: number }

/** The standard SGR 40-47 background table; enough for SGR 42 (green) and the default 49. */
const STANDARD_BG: readonly Rgb[] = [
  { r: 0, g: 0, b: 0 },
  { r: 170, g: 0, b: 0 },
  { r: 0, g: 170, b: 0 },
  { r: 170, g: 85, b: 0 },
  { r: 0, g: 0, b: 170 },
  { r: 170, g: 0, b: 170 },
  { r: 0, g: 170, b: 170 },
  { r: 170, g: 170, b: 170 },
]

/** The standard SGR 30-37 foreground table. */
const STANDARD_FG: readonly Rgb[] = [
  { r: 0, g: 0, b: 0 },
  { r: 170, g: 0, b: 0 },
  { r: 0, g: 170, b: 0 },
  { r: 170, g: 85, b: 0 },
  { r: 0, g: 0, b: 170 },
  { r: 170, g: 0, b: 170 },
  { r: 0, g: 170, b: 170 },
  { r: 170, g: 170, b: 170 },
]

/** The bright SGR 90-97 / 100-107 (and 256-colour 8-15) table. */
const BRIGHT_PALETTE: readonly Rgb[] = [
  { r: 85, g: 85, b: 85 },
  { r: 255, g: 85, b: 85 },
  { r: 85, g: 255, b: 85 },
  { r: 255, g: 255, b: 85 },
  { r: 85, g: 85, b: 255 },
  { r: 255, g: 85, b: 255 },
  { r: 85, g: 255, b: 255 },
  { r: 255, g: 255, b: 255 },
]

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const

/** Resolve a 0-255 xterm palette index to its canonical RGB value. */
function palette256(index: number): Rgb | null {
  if (!Number.isInteger(index) || index < 0 || index > 255) return null
  if (index < 8) return STANDARD_FG[index] ?? null
  if (index < 16) return BRIGHT_PALETTE[index - 8] ?? null
  if (index < 232) {
    const offset = index - 16
    const r = CUBE_LEVELS[Math.floor(offset / 36)] ?? 0
    const g = CUBE_LEVELS[Math.floor((offset % 36) / 6)] ?? 0
    const b = CUBE_LEVELS[offset % 6] ?? 0
    return { r, g, b }
  }
  const level = 8 + (index - 232) * 10
  return { r: level, g: level, b: level }
}

type UnderlineStyle = SurfaceCellState["underline"]

interface Attributes {
  bold: boolean
  dim: boolean
  italic: boolean
  underline: UnderlineStyle
  underlineColor: Rgb | null
  blink: boolean
  inverse: boolean
  hidden: boolean
  strikethrough: boolean
  overline: boolean
  fg: Rgb | null
  bg: Rgb | null
}

const NO_ATTRIBUTES: Attributes = {
  bold: false,
  dim: false,
  italic: false,
  underline: null,
  underlineColor: null,
  blink: false,
  inverse: false,
  hidden: false,
  strikethrough: false,
  overline: false,
  fg: null,
  bg: null,
}

interface SurfaceCell extends Attributes {
  char: string
  decscaProtected: boolean
  /** A two-column lead cell (CJK, emoji, ZWJ sequence or regional-indicator pair). */
  wide?: boolean
}

function blankCell(attributes: Attributes): SurfaceCell {
  return { char: " ", decscaProtected: false, ...attributes }
}

/** Tab stops every eight columns from column nine, the conventional layout. */
function defaultTabStops(cols: number): Set<number> {
  const stops = new Set<number>()
  for (let col = 8; col < cols; col += 8) stops.add(col)
  return stops
}

const VS15 = 0xfe0e
const VS16 = 0xfe0f
const ZWJ = 0x200d

function isCombining(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f)
  )
}

function isRegionalIndicator(code: number): boolean {
  return code >= 0x1f1e6 && code <= 0x1f1ff
}

/** East Asian Wide/Fullwidth and emoji, the code points that claim two columns. */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

/** The character set a G0 or G1 designation selects. */
type CharsetSet = "ascii" | "dec-special"

/**
 * The DEC Special Graphics set: the ASCII 0x60-0x7e range maps to the VT100 line-drawing glyphs, so a
 * `charsets.dec-special` or `charsets.dec-line-drawing` row can measure the codepoint a designation
 * really produced (q is U+2500, l is U+250C, and so on) rather than a glyph's pixels.
 */
const DEC_SPECIAL_GRAPHICS: Readonly<Record<string, string>> = {
  "`": "\u25c6",
  a: "\u2592",
  b: "\u2409",
  c: "\u240c",
  d: "\u240d",
  e: "\u240a",
  f: "\u00b0",
  g: "\u00b1",
  h: "\u2424",
  i: "\u240b",
  j: "\u2518",
  k: "\u2510",
  l: "\u250c",
  m: "\u2514",
  n: "\u253c",
  o: "\u23ba",
  p: "\u23bb",
  q: "\u2500",
  r: "\u23bc",
  s: "\u23bd",
  t: "\u251c",
  u: "\u2524",
  v: "\u2534",
  w: "\u252c",
  x: "\u2502",
  y: "\u2264",
  z: "\u2265",
  "{": "\u03c0",
  "|": "\u2260",
  "}": "\u00a3",
  "~": "\u00b7",
}

/**
 * The grapheme cluster beginning at `start`: a base code point plus every combining mark, VS15/VS16,
 * ZWJ-continued scalar and second regional indicator that rides it. Decoding by code point, never by
 * UTF-16 unit, is what keeps a supplementary-plane scalar whole (#28021 text.wide.*).
 */
function nextGrapheme(text: string, start: number): { cluster: string; length: number } {
  let index = start
  let cluster = ""
  let first = true
  let regionalCount = 0
  let previousWasZwj = false
  while (index < text.length) {
    const code = text.codePointAt(index)
    if (code === undefined) break
    const size = code > 0xffff ? 2 : 1
    if (first) {
      cluster += String.fromCodePoint(code)
      regionalCount = isRegionalIndicator(code) ? 1 : 0
      first = false
      index += size
      continue
    }
    if (isCombining(code) || code === VS15 || code === VS16 || code === ZWJ) {
      cluster += String.fromCodePoint(code)
      previousWasZwj = code === ZWJ
      index += size
      continue
    }
    if (previousWasZwj) {
      cluster += String.fromCodePoint(code)
      previousWasZwj = false
      index += size
      continue
    }
    if (isRegionalIndicator(code) && regionalCount === 1) {
      cluster += String.fromCodePoint(code)
      regionalCount = 2
      index += size
      continue
    }
    break
  }
  return { cluster, length: index - start }
}

/** The measured column width of one cluster: emoji presentation, ZWJ and flag pairs are two. */
function clusterWidth(cluster: string): number {
  const codes = Array.from(cluster, (char) => char.codePointAt(0) ?? 0)
  if (codes.length === 0) return 0
  if (codes.includes(VS16)) return 2
  if (codes.includes(ZWJ)) return 2
  if (codes.length >= 2 && isRegionalIndicator(codes[0] ?? 0) && isRegionalIndicator(codes[1] ?? 0)) return 2
  const base = codes[0] ?? 0
  if (isCombining(base)) return 0
  return isWide(base) ? 2 : 1
}

const COLON_UNDERLINE_STYLES: Readonly<Record<number, { readonly mutation: string; readonly style: UnderlineStyle }>> =
  {
    0: { mutation: "sgr24-noop", style: null },
    1: { mutation: "underline-single-noop", style: "single" },
    2: { mutation: "underline-double-noop", style: "double" },
    3: { mutation: "underline-curly-noop", style: "curly" },
    4: { mutation: "underline-dotted-noop", style: "dotted" },
    5: { mutation: "underline-dashed-noop", style: "dashed" },
  }

/** Apply colon-delimited SGR subparameters (such as 4:0..4:5 underline styles). */
function applyColonSgr(attributes: Attributes, raw: string, mutations?: ReadonlySet<string>): Attributes {
  const parts = raw.split(":").map((part) => (part === "" ? 0 : Number(part)))
  if (parts[0] === 4) {
    const entry = COLON_UNDERLINE_STYLES[parts[1] ?? 1]
    if (entry && !mutations?.has(entry.mutation)) return { ...attributes, underline: entry.style }
  }
  return attributes
}

const SIMPLE_SGR_EFFECTS: Readonly<
  Record<number, { readonly mutation?: string; readonly patch: Partial<Attributes> }>
> = {
  0: { mutation: "sgr0-noop", patch: NO_ATTRIBUTES },
  1: { mutation: "bold-noop", patch: { bold: true } },
  2: { mutation: "faint-noop", patch: { dim: true } },
  3: { mutation: "italic-noop", patch: { italic: true } },
  4: { mutation: "underline-single-noop", patch: { underline: "single" } },
  5: { mutation: "blink-noop", patch: { blink: true } },
  7: { mutation: "inverse-noop", patch: { inverse: true } },
  8: { mutation: "hidden-noop", patch: { hidden: true } },
  9: { mutation: "strikethrough-noop", patch: { strikethrough: true } },
  21: { mutation: "underline-double-noop", patch: { underline: "double" } },
  22: { mutation: "sgr22-noop", patch: { bold: false, dim: false } },
  23: { mutation: "sgr23-noop", patch: { italic: false } },
  24: { mutation: "sgr24-noop", patch: { underline: null } },
  25: { patch: { blink: false } },
  27: { mutation: "sgr27-noop", patch: { inverse: false } },
  28: { patch: { hidden: false } },
  29: { patch: { strikethrough: false } },
  39: { mutation: "fg-default-noop", patch: { fg: null } },
  49: { mutation: "bg-default-noop", patch: { bg: null } },
  53: { mutation: "overline-noop", patch: { overline: true } },
  55: { patch: { overline: false } },
  59: { mutation: "sgr59-noop", patch: { underlineColor: null } },
}

function applyIndexedColor(
  attributes: Attributes,
  code: 38 | 48 | 58,
  index: number,
  mutations?: ReadonlySet<string>,
): Attributes {
  const color = palette256(index)
  if (!color) return attributes
  if (code === 38) return mutations?.has("fg-256-noop") ? attributes : { ...attributes, fg: color }
  if (code === 48) return mutations?.has("bg-256-noop") ? attributes : { ...attributes, bg: color }
  if (mutations?.has("underline-color-noop") || mutations?.has("underline-color-indexed-noop")) return attributes
  return { ...attributes, underlineColor: color }
}

function applyRgbColor(
  attributes: Attributes,
  code: 38 | 48 | 58,
  color: Rgb,
  mutations?: ReadonlySet<string>,
): Attributes {
  if (code === 38) return mutations?.has("fg-truecolor-noop") ? attributes : { ...attributes, fg: color }
  if (code === 48) return mutations?.has("bg-truecolor-noop") ? attributes : { ...attributes, bg: color }
  if (mutations?.has("underline-color-noop") || mutations?.has("underline-color-rgb-noop")) return attributes
  return { ...attributes, underlineColor: color }
}

function applyPaletteRange(attributes: Attributes, code: number, mutations?: ReadonlySet<string>): Attributes {
  if (code >= 30 && code <= 37 && !mutations?.has("fg-standard-noop")) {
    return { ...attributes, fg: STANDARD_FG[code - 30] ?? null }
  }
  if (code >= 40 && code <= 47 && !mutations?.has("bg-standard-noop")) {
    return { ...attributes, bg: STANDARD_BG[code - 40] ?? null }
  }
  if (code >= 90 && code <= 97 && !mutations?.has("fg-bright-noop")) {
    return { ...attributes, fg: BRIGHT_PALETTE[code - 90] ?? null }
  }
  if (code >= 100 && code <= 107 && !mutations?.has("bg-bright-noop")) {
    return { ...attributes, bg: BRIGHT_PALETTE[code - 100] ?? null }
  }
  return attributes
}

/** Apply SGR codes to an attribute set, the table `applySgr` and the rect attribute ops share. */
function applyCodes(attributes: Attributes, codes: readonly number[], mutations?: ReadonlySet<string>): Attributes {
  let next = attributes
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i] ?? 0
    if ((code === 38 || code === 48 || code === 58) && codes[i + 1] === 5) {
      next = applyIndexedColor(next, code, codes[i + 2] ?? -1, mutations)
      i += 2
      continue
    }
    if ((code === 38 || code === 48 || code === 58) && codes[i + 1] === 2) {
      next = applyRgbColor(next, code, { r: codes[i + 2] ?? 0, g: codes[i + 3] ?? 0, b: codes[i + 4] ?? 0 }, mutations)
      i += 4
      continue
    }
    const simple = SIMPLE_SGR_EFFECTS[code]
    if (simple) {
      if (!simple.mutation || !mutations?.has(simple.mutation)) next = { ...next, ...simple.patch }
      continue
    }
    next = applyPaletteRange(next, code, mutations)
  }
  return next
}

/** Reverse (toggle) the listed attribute codes in a set — DECRARA's per-cell effect. */
function reverseCodes(attributes: Attributes, codes: readonly number[], mutations?: ReadonlySet<string>): Attributes {
  let next = attributes
  for (const code of codes) {
    if (code === 1 && !mutations?.has("bold-noop")) next = { ...next, bold: !next.bold }
    else if (code === 2 && !mutations?.has("faint-noop")) next = { ...next, dim: !next.dim }
    else if (code === 3 && !mutations?.has("italic-noop")) next = { ...next, italic: !next.italic }
    else if (code === 4 && !mutations?.has("underline-single-noop")) {
      next = { ...next, underline: next.underline ? null : "single" }
    } else if (code === 5 && !mutations?.has("blink-noop")) next = { ...next, blink: !next.blink }
    else if (code === 7 && !mutations?.has("inverse-noop")) next = { ...next, inverse: !next.inverse }
    else if (code === 8 && !mutations?.has("hidden-noop")) next = { ...next, hidden: !next.hidden }
    else if (code === 9 && !mutations?.has("strikethrough-noop")) next = { ...next, strikethrough: !next.strikethrough }
    else if (code === 53 && !mutations?.has("overline-noop")) next = { ...next, overline: !next.overline }
  }
  return next
}

/** The cell shape `LibProbeSource.getCell` returns. */
export type SurfaceCellState = ReturnType<LibProbeSource["getCell"]>

export interface SemanticSurfaceOptions {
  readonly cols?: number
  readonly rows?: number
  /** Named faults, so a group's negative control can prove its binding can fail. */
  readonly mutations?: readonly string[]
}

/** A semantic headless surface plus the state reads the Reset probes need. */
export interface SemanticSurface extends HeadlessModel {
  getText(): string
  getMode(mode: string): ModeState
  reset(): void
}

export function createSemanticSurface(options: SemanticSurfaceOptions = {}): SemanticSurface {
  const cols = options.cols ?? 80
  const rows = options.rows ?? 24
  const mutations = new Set(options.mutations ?? [])
  let grid: SurfaceCell[][] = []
  let cursorX = 0
  let cursorY = 0
  let cursorVisible = true
  let cursorStyle: string | null = "block"
  let regionTop = 0
  let regionBottom = rows - 1
  let scrolled = 0
  let attributes: Attributes = NO_ATTRIBUTES
  let protecting = false
  let applicationCursor = false
  let originMode = false
  let autoWrap = true
  let reverseWrap = false
  let altScreen = false
  let savedGrid: SurfaceCell[][] | null = null
  let savedCursor: readonly [number, number] = [0, 0]
  let ansiSavedCursor: readonly [number, number] = [0, 0]
  let decSavedCursor: readonly [number, number] = [0, 0]
  let tabStops = defaultTabStops(cols)
  let charsetG0: CharsetSet = "ascii"
  let charsetG1: CharsetSet = "ascii"
  let activeCharset: "g0" | "g1" = "g0"
  let lastCluster = " "
  let lastWidth = 1
  let title = ""
  let iconLabel = ""
  let titleStack: string[] = []
  /** Bytes the surface owes a caller in reply to a query (DECRQCRA, DSR, DA, DECRQSS, XTWINOPS), read back by feedCapture. */
  let replies = ""

  const blankRow = (): SurfaceCell[] => Array.from({ length: cols }, () => blankCell(NO_ATTRIBUTES))

  const clear = (): void => {
    grid = Array.from({ length: rows }, blankRow)
    cursorX = 0
    cursorY = 0
    cursorVisible = true
    cursorStyle = "block"
    regionTop = 0
    regionBottom = rows - 1
    scrolled = 0
    originMode = false
    autoWrap = true
    reverseWrap = false
    altScreen = false
    savedGrid = null
    ansiSavedCursor = [0, 0]
    decSavedCursor = [0, 0]
    tabStops = defaultTabStops(cols)
    charsetG0 = "ascii"
    charsetG1 = "ascii"
    activeCharset = "g0"
    title = ""
    iconLabel = ""
    titleStack = []
    replies = ""
  }
  clear()

  /** The next owned stop to the right, or the right margin when none remains (#28021 text.tab). */
  const nextTabStop = (from: number): number => {
    let best = -1
    for (const stop of tabStops) if (stop > from && (best === -1 || stop < best)) best = stop
    return best === -1 ? cols - 1 : best
  }

  /** The nearest owned stop to the left (#28021 text.cbt). */
  const prevTabStop = (from: number): number => {
    let best = -1
    for (const stop of tabStops) if (stop < from && stop > best) best = stop
    return best === -1 ? 0 : best
  }

  /**
   * DECSACE's extent for the attribute changes DECCARA/DECRARA apply: Ps 0 and 1 are stream, Ps 2 is
   * rectangle. The surface starts at the DEC power-on default, stream (29817), and every row selects
   * the extent it means with DECSACE 0, 1 or 2 before its write — so one row's mode can never leak
   * into another's, and a row that forgets cannot inherit rectangle semantics it never asked for.
   */
  let attributeExtent: 0 | 1 = 0
  const clampCol = (col: number): number => (col < 0 ? 0 : col > cols - 1 ? cols - 1 : col)
  const cellAt = (row: number, col: number): SurfaceCell => grid[row]?.[col] ?? blankCell(NO_ATTRIBUTES)

  const lineFeed = (): void => {
    if (mutations.has("lf-noop")) return
    if (cursorY >= regionBottom) {
      grid.splice(regionTop, 1)
      grid.splice(regionBottom, 0, blankRow())
      // History accounting follows scrollUp: only a full-screen region pushes the line that leaves
      // the top into scrollback; an interior region discards it. Without this the DECSTBM reset row
      // could not be decided by a with-and-without-reset control pair on totalLines.
      if (regionTop === 0 && regionBottom === rows - 1) scrolled += 1
      return
    }
    cursorY += 1
  }

  /**
   * SU — scroll the region up by N, blanking the vacated bottom rows. A full-screen region retains
   * the lines that leave the top as scrollback history; an interior region loses them (the measured
   * control the scrollback.scroll-up probe asserts with `totalLines === screenLines`).
   */
  const scrollUp = (count: number): void => {
    const n = Math.min(count, regionBottom - regionTop + 1)
    grid.splice(regionTop, n)
    for (let i = 0; i < n; i++) grid.splice(regionBottom, 0, blankRow())
    if (regionTop === 0 && regionBottom === rows - 1) scrolled += n
  }

  /** SD — scroll the region down by N, blanking the vacated top rows; history is unchanged. */
  const scrollDown = (count: number): void => {
    const n = Math.min(count, regionBottom - regionTop + 1)
    grid.splice(regionBottom - n + 1, n)
    for (let i = 0; i < n; i++) grid.splice(regionTop, 0, blankRow())
  }

  /** HT — advance to the next owned tab stop. */
  const horizontalTab = (): void => {
    if (mutations.has("ht-noop")) return
    cursorX = nextTabStop(cursorX)
  }

  /** HTS — own the current column as a tab stop. */
  const setTabStop = (): void => {
    tabStops.add(cursorX)
  }

  /** IND — one row down, column unchanged. */
  const indexDown = (): void => {
    lineFeed()
  }

  /** NEL — one row down and back to column one. */
  const nextLine = (): void => {
    lineFeed()
    cursorX = 0
  }

  /** RI — one row up, scrolling the measured region down when already at its top. */
  const reverseIndex = (): void => {
    if (cursorY <= regionTop) {
      grid.splice(regionBottom, 1)
      grid.splice(regionTop, 0, blankRow())
      return
    }
    cursorY -= 1
  }

  /**
   * Write one grapheme cluster. A two-column cluster (CJK, an emoji presentation, a ZWJ sequence or
   * a regional-indicator pair) claims its lead cell and leaves an empty continuation beside it, so a
   * width probe reads the column the sentinel really landed in. A cluster that cannot fit wraps
   * first, exactly as a plain write does.
   */
  const writeCluster = (cluster: string, width: number): void => {
    if (width === 0) return
    if (cursorX + width > cols) {
      cursorX = 0
      lineFeed()
    }
    const target = grid[cursorY]
    if (target) {
      target[cursorX] = { char: cluster, decscaProtected: protecting, wide: width > 1, ...attributes }
      if (width > 1 && cursorX + 1 < cols) {
        target[cursorX + 1] = { char: "", decscaProtected: protecting, wide: false, ...attributes }
      }
    }
    cursorX += width
    lastCluster = cluster
    lastWidth = width
  }

  /** REP — repeat the immediately preceding graphic cluster at the cursor. */
  const repeatChar = (count: number): void => {
    for (let i = 0; i < Math.max(1, count); i++) writeCluster(lastCluster, lastWidth)
  }

  const clampRow = (row: number): number => (row < 0 ? 0 : row > rows - 1 ? rows - 1 : row)

  /** The clamped inclusive cell rectangle a VT420 Ps;Pl;Pb;Pr area operation names. */
  const rect = (params: readonly number[]): { top: number; left: number; bottom: number; right: number } => ({
    top: clampRow((params[0] ?? 1) - 1),
    left: clampCol((params[1] ?? 1) - 1),
    bottom: clampRow((params[2] ?? rows) - 1),
    right: clampCol((params[3] ?? cols) - 1),
  })

  const eachCellIn = (
    params: readonly number[],
    apply: (cell: SurfaceCell, row: number, col: number) => SurfaceCell | undefined,
  ): void => {
    const { top, left, bottom, right } = rect(params)
    for (let row = top; row <= bottom; row++) {
      for (let col = left; col <= right; col++) {
        const current = grid[row]?.[col] ?? blankCell(NO_ATTRIBUTES)
        const next = apply(current, row, col)
        if (next && grid[row]) grid[row]![col] = next
      }
    }
  }

  /**
   * The cells an attribute change covers under the DECSACE extent: the rectangle itself for extent 1,
   * and for extent 0 the reading-order span from its top-left cell to its bottom-right cell — the rest
   * of the top row, whole rows between, then the left part of the bottom row.
   */
  const eachCellInExtent = (
    params: readonly number[],
    apply: (cell: SurfaceCell, row: number, col: number) => SurfaceCell | undefined,
  ): void => {
    if (attributeExtent === 1) {
      eachCellIn(params, apply)
      return
    }
    const { top, left, bottom, right } = rect(params)
    for (let row = top; row <= bottom; row++) {
      const start = row === top ? left : 0
      const end = row === bottom ? right : cols - 1
      for (let col = start; col <= end; col++) {
        const current = grid[row]?.[col] ?? blankCell(NO_ATTRIBUTES)
        const next = apply(current, row, col)
        if (next && grid[row]) grid[row]![col] = next
      }
    }
  }

  /** ICH — insert blank cells at the cursor, shifting the rest of the row right. */
  const insertChars = (count: number): void => {
    if (mutations.has("ich-noop")) return
    const row = grid[cursorY]
    if (!row) return
    row.splice(cursorX, 0, ...Array.from({ length: Math.max(1, count) }, () => blankCell(NO_ATTRIBUTES)))
    row.length = cols
  }

  /** DCH — delete cells at the cursor, shifting the rest of the row left and blanking the tail. */
  const deleteChars = (count: number): void => {
    const row = grid[cursorY]
    if (!row) return
    row.splice(cursorX, Math.max(1, count))
    while (row.length < cols) row.push(blankCell(NO_ATTRIBUTES))
  }

  /** IL — insert blank rows at the cursor inside the scrolling region, shifting rows down. */
  const insertLines = (count: number): void => {
    const bottom = Math.min(regionBottom, rows - 1)
    for (let i = 0; i < Math.max(1, count); i++) {
      grid.splice(cursorY, 0, blankRow())
      grid.splice(bottom + 1, 1)
    }
  }

  /** DL — delete rows at the cursor inside the scrolling region, shifting rows up. */
  const deleteLines = (count: number): void => {
    const bottom = Math.min(regionBottom, rows - 1)
    for (let i = 0; i < Math.max(1, count); i++) {
      grid.splice(cursorY, 1)
      grid.splice(bottom, 0, blankRow())
    }
  }

  /** SL — shift every screen column left by `count`, blanking the right edge. */
  const shiftLeft = (count: number): void => {
    for (const row of grid) {
      row.splice(0, Math.max(1, count))
      while (row.length < cols) row.push(blankCell(NO_ATTRIBUTES))
    }
  }

  /** SR — shift every screen column right by `count`, blanking the left edge. */
  const shiftRight = (count: number): void => {
    const blanks = () => Array.from({ length: Math.max(1, count) }, () => blankCell(NO_ATTRIBUTES))
    for (const row of grid) {
      row.splice(0, 0, ...blanks())
      row.length = cols
    }
  }

  /** DECIC — insert blank columns at the cursor, shifting every row right. */
  const insertColumns = (count: number): void => {
    const blanks = () => Array.from({ length: Math.max(1, count) }, () => blankCell(NO_ATTRIBUTES))
    for (const row of grid) {
      row.splice(cursorX, 0, ...blanks())
      row.length = cols
    }
  }

  /** DECDC — delete columns at the cursor, shifting every row left and blanking the tail. */
  const deleteColumns = (count: number): void => {
    for (const row of grid) {
      row.splice(cursorX, Math.max(1, count))
      while (row.length < cols) row.push(blankCell(NO_ATTRIBUTES))
    }
  }

  /** DECFRA — fill the rectangle with the named code point. */
  const fillRect = (params: readonly number[]): void => {
    const char = String.fromCodePoint(params[0] ?? 0)
    eachCellIn(params.slice(1), () => ({ char, decscaProtected: false, ...NO_ATTRIBUTES }))
  }

  /** DECERA — blank the rectangle; DECSERA restricts that to unprotected cells. */
  const blankRect = (params: readonly number[], selective: boolean): void => {
    eachCellIn(params, (cell) =>
      selective && cell.decscaProtected ? undefined : { char: " ", decscaProtected: false, ...NO_ATTRIBUTES },
    )
  }

  /** DECCRA — copy the source rectangle to the destination top/left, source left intact. */
  const copyRect = (params: readonly number[]): void => {
    const source = rect(params)
    const destinationTop = clampRow((params[5] ?? 1) - 1)
    const destinationLeft = clampCol((params[6] ?? 1) - 1)
    const copy: SurfaceCell[][] = []
    for (let row = source.top; row <= source.bottom; row++) {
      const line: SurfaceCell[] = []
      for (let col = source.left; col <= source.right; col++) line.push(grid[row]?.[col] ?? blankCell(NO_ATTRIBUTES))
      copy.push(line)
    }
    copy.forEach((line, rowOffset) => {
      line.forEach((cell, colOffset) => {
        const row = destinationTop + rowOffset
        const col = destinationLeft + colOffset
        if (grid[row] && col < cols) grid[row]![col] = { ...cell }
      })
    })
  }

  /** DECCARA / DECRARA — set or reverse the listed attributes across the rectangle. */
  const changeRectAttributes = (params: readonly number[], reverse: boolean): void => {
    const codes = params.slice(4)
    eachCellInExtent(params, (cell) => ({
      ...cell,
      ...(reverse ? reverseCodes(cell, codes, mutations) : applyCodes(cell, codes, mutations)),
    }))
  }

  /** DECRQCRA — frame the rectangle's checksum reply the way checksumResult reads it. */
  const requestChecksum = (params: readonly number[]): void => {
    const id = params[0] ?? 0
    const { top, left, bottom, right } = rect(params.slice(2))
    let total = 0
    for (let row = top; row <= bottom; row++) {
      for (let col = left; col <= right; col++) {
        for (const char of cellAt(row, col).char) total = (total + char.charCodeAt(0)) & 0xffff
      }
    }
    replies += `\x1bP${id}!~${total.toString(16).toUpperCase().padStart(4, "0")}\x1b\\`
  }

  const eraseLine = (mode: number): void => {
    const row = grid[cursorY]
    if (!row) return
    const from = mode === 1 || mode === 2 ? 0 : cursorX
    const to = mode === 1 ? cursorX : cols - 1
    for (let col = from; col <= to && col < cols; col++) {
      const existing = row[col] ?? blankCell(NO_ATTRIBUTES)
      row[col] = {
        char: " ",
        decscaProtected: existing.decscaProtected,
        ...NO_ATTRIBUTES,
        bg: mutations.has("el-default-bg") ? null : attributes.bg,
      }
    }
  }

  const eraseDisplay = (mode: number): void => {
    if (mode === 3) {
      scrolled = 0
      return
    }
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const inside =
          mode === 0
            ? row > cursorY || (row === cursorY && col >= cursorX)
            : mode === 1
              ? row < cursorY || (row === cursorY && col <= cursorX)
              : true
        if (inside) grid[row]![col] = blankCell({ ...NO_ATTRIBUTES, bg: attributes.bg })
      }
    }
  }

  /** Selective erase (DECSED/DECSEL) skips every DECSCA-protected cell. */
  const selectiveErase = (): void => {
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (!cellAt(row, col).decscaProtected) {
          grid[row]![col] = { char: " ", decscaProtected: false, ...NO_ATTRIBUTES, bg: attributes.bg }
        }
      }
    }
  }

  const eraseChars = (count: number): void => {
    const row = grid[cursorY]
    if (!row) return
    for (let i = 0; i < count && cursorX + i < cols; i++) {
      row[cursorX + i] = { char: " ", decscaProtected: false, ...NO_ATTRIBUTES, bg: attributes.bg }
    }
  }

  const applySgr = (paramsRaw: string): void => {
    if (paramsRaw === "") {
      attributes = applyCodes(attributes, [0], mutations)
      return
    }
    const tokens = paramsRaw.split(";")
    for (let i = 0; i < tokens.length; i++) {
      const raw = tokens[i] ?? ""
      if (raw.includes(":")) {
        attributes = applyColonSgr(attributes, raw, mutations)
        continue
      }
      const code = raw === "" ? 0 : Number(raw)
      if ((code === 38 || code === 48 || code === 58) && tokens[i + 1] === "5") {
        attributes = applyCodes(attributes, [code, 5, Number(tokens[i + 2] ?? -1)], mutations)
        i += 2
        continue
      }
      if ((code === 38 || code === 48 || code === 58) && tokens[i + 1] === "2") {
        attributes = applyCodes(
          attributes,
          [code, 2, Number(tokens[i + 2] ?? 0), Number(tokens[i + 3] ?? 0), Number(tokens[i + 4] ?? 0)],
          mutations,
        )
        i += 4
        continue
      }
      attributes = applyCodes(attributes, [code], mutations)
    }
  }

  const softReset = (): void => {
    applicationCursor = false
    originMode = false
    autoWrap = true
    reverseWrap = false
    cursorVisible = true
    cursorStyle = "block"
    attributes = NO_ATTRIBUTES
    protecting = false
    charsetG0 = "ascii"
    charsetG1 = "ascii"
    activeCharset = "g0"
  }

  const ris = (): void => {
    if (mutations.has("ris-noop")) return
    softReset()
    clear()
  }

  /** DECALN: fill the whole measured grid with E and home the cursor. */
  const decaln = (): void => {
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) grid[row]![col] = { char: "E", decscaProtected: false, ...attributes }
    }
    cursorX = 0
    cursorY = 0
  }

  const moveCursorAbsolute = (paramsRaw: string, params: readonly number[]): void => {
    if (paramsRaw === "" && mutations.has("cup-home-noop")) return
    if (paramsRaw !== "" && paramsRaw !== "1;1" && mutations.has("cup-noop")) return
    const rawRow = (params[0] ?? 0) === 0 ? 1 : (params[0] ?? 1)
    const rawCol = (params[1] ?? 0) === 0 ? 1 : (params[1] ?? 1)
    const top = originMode ? regionTop : 0
    const bottom = originMode ? regionBottom : rows - 1
    const maxRows = bottom - top + 1
    if ((rawRow > maxRows || rawCol > cols) && mutations.has("cup-clamp-noop")) return
    cursorY = Math.min(bottom, Math.max(top, top + rawRow - 1))
    cursorX = clampCol(rawCol - 1)
  }

  const moveCursorVertical = (final: string, first: number): void => {
    const step = Math.max(1, first)
    const top = originMode ? regionTop : 0
    const bottom = originMode ? regionBottom : rows - 1
    if (final === "A") {
      if (mutations.has("cuu-noop")) return
      if (cursorY - step < top && mutations.has("cuu-clamp-noop")) return
      cursorY = Math.max(top, cursorY - step)
      return
    }
    if (final === "B") {
      if (mutations.has("cud-noop")) return
      if (cursorY + step > bottom && mutations.has("cud-clamp-noop")) return
      cursorY = Math.min(bottom, cursorY + step)
      return
    }
    if (final === "E" && !mutations.has("cnl-noop")) {
      cursorY = Math.min(bottom, cursorY + step)
      cursorX = 0
      return
    }
    if (final === "F" && !mutations.has("cpl-noop")) {
      cursorY = Math.max(top, cursorY - step)
      cursorX = 0
      return
    }
    if (final === "d" && !mutations.has("vpa-noop")) {
      cursorY = Math.min(bottom, Math.max(top, top + step - 1))
    }
  }

  const csiIntermediate = (intermediate: string, final: string, params: readonly number[], first: number): boolean => {
    if (intermediate === "") return false
    const count = Math.max(1, first)
    if (intermediate === '"' && final === "q") protecting = first !== 0 && !mutations.has("decsca-noop")
    else if (intermediate === "!" && final === "p") softReset()
    else if (intermediate === "$") {
      if (final === "x") fillRect(params)
      else if (final === "z" || final === "{") blankRect(params, final === "{")
      else if (final === "v") copyRect(params)
      else if (final === "r" || final === "t") changeRectAttributes(params, final === "t")
      else if (final === "p" && first === 7 && !mutations.has("decrpm-noop")) {
        replies += `\x1b[?7;${autoWrap ? 1 : 2}$y`
      }
    } else if (intermediate === "*") {
      if (final === "x") attributeExtent = first === 2 ? 1 : 0
      else if (final === "y") requestChecksum(params)
    } else if (intermediate === "'") {
      if (final === "}") insertColumns(count)
      else if (final === "~") deleteColumns(count)
    } else if (intermediate === "#") {
      if (final === "R" && !mutations.has("xtreportcolors-noop")) replies += "\x1b[0;1#Q"
    } else if (intermediate === " ") {
      if (final === "@") shiftLeft(count)
      else if (final === "A") shiftRight(count)
      else if (final === "q" && !mutations.has("decscusr-noop")) {
        cursorStyle = first === 5 || first === 6 ? "beam" : first === 3 || first === 4 ? "underline" : "block"
      }
    }
    return true
  }

  const toggleAltScreen = (entering: boolean): void => {
    if (mutations.has("altscreen-noop")) return
    if (entering && !altScreen) {
      savedGrid = grid
      savedCursor = [cursorX, cursorY]
      grid = Array.from({ length: rows }, blankRow)
      cursorX = 0
      cursorY = 0
      altScreen = true
      return
    }
    if (!entering && altScreen) {
      if (!savedGrid) throw new Error("semantic-surface: 1049l with no saved grid")
      grid = savedGrid
      savedGrid = null
      cursorX = savedCursor[0]
      cursorY = savedCursor[1]
      altScreen = false
    }
  }

  const csiPrivate = (final: string, first: number): void => {
    if (final === "J") {
      selectiveErase()
      return
    }
    if (final === "n") {
      if (first === 996 && !mutations.has("dsr-996-noop")) replies += "\x1b[?997;1n"
      return
    }
    if (final !== "h" && final !== "l") return
    const enable = final === "h"
    if (first === 1) applicationCursor = enable
    else if (first === 6) originMode = enable && !mutations.has("decom-noop")
    else if (first === 7) autoWrap = enable
    else if (first === 25) cursorVisible = enable ? true : mutations.has("dectcem-noop") ? cursorVisible : false
    else if (first === 45) reverseWrap = enable && !mutations.has("reverse-wrap-noop")
    else if (first === 1049) toggleAltScreen(enable)
  }

  const csiDevicePrefix = (prefix: string, final: string, first: number): boolean => {
    if (prefix === ">") {
      if (final === "c" && !mutations.has("secondary-da-noop")) replies += "\x1b[>0;49;1c"
      else if (final === "q" && first === 0 && !mutations.has("xtversion-noop")) {
        replies += "\x1bP>|kitty(0.49.1)\x1b\\"
      }
      return true
    }
    if (prefix === "=") {
      if (final === "c" && !mutations.has("tertiary-da-noop")) replies += "\x1bP!|1234ABCD\x1b\\"
      return true
    }
    return false
  }

  const windowOp = (first: number): void => {
    if (first === 14 && !mutations.has("xtwinops-14-noop")) replies += "\x1b[4;720;1280t"
    else if (first === 16 && !mutations.has("xtwinops-16-noop")) replies += "\x1b[6;16;8t"
    else if (first === 18 && !mutations.has("xtwinops-18-noop")) replies += `\x1b[8;${rows};${cols}t`
    else if (first === 20) replies += `\x1b]L${iconLabel}\x07`
    else if (first === 21) replies += `\x1b]l${mutations.has("xtwinops-21-noop") ? "" : title}\x07`
    else if (first === 22 && !mutations.has("xtwinops-22-noop")) titleStack.push(title)
    else if (first === 23 && !mutations.has("xtwinops-23-noop")) {
      const restored = titleStack.pop()
      if (restored !== undefined) title = restored
    }
  }

  const csi = (prefix: string, paramsRaw: string, intermediate: string, final: string): void => {
    const params = paramsRaw === "" ? [] : paramsRaw.split(";").map((raw) => (raw === "" ? 0 : Number(raw)))
    const first = params[0] ?? 0
    if (csiIntermediate(intermediate, final, params, first)) return
    if (prefix === "?") {
      csiPrivate(final, first)
      return
    }
    if (csiDevicePrefix(prefix, final, first)) return
    if (final === "H" || final === "f") {
      moveCursorAbsolute(paramsRaw, params)
      return
    }
    if (final === "A" || final === "B" || final === "E" || final === "F" || final === "d") {
      moveCursorVertical(final, first)
      return
    }
    switch (final) {
      case "C":
        if (!mutations.has("cuf-noop")) cursorX = clampCol(cursorX + Math.max(1, first))
        return
      case "D":
        if (!mutations.has("cub-noop")) cursorX = clampCol(cursorX - Math.max(1, first))
        return
      case "G":
        if (!mutations.has("cha-noop")) cursorX = clampCol((params[0] ?? 1) - 1)
        return
      case "`":
        if (!mutations.has("hpa-noop")) cursorX = clampCol(Math.max(1, first) - 1)
        return
      case "s":
        if (!mutations.has("ansi-save-noop")) ansiSavedCursor = [cursorX, cursorY]
        return
      case "u":
        if (!mutations.has("ansi-restore-noop")) [cursorX, cursorY] = ansiSavedCursor
        return
      case "c":
        if (first === 0) replies += mutations.has("primary-da-noop") ? "\x1b[?c" : "\x1b[?62;52;c"
        return
      case "n":
        if (first === 5 && !mutations.has("status-report-noop")) replies += "\x1b[0n"
        else if (first === 6) {
          replies += mutations.has("dsr-cpr-noop") ? "\x1b[1;1R" : `\x1b[${cursorY + 1};${cursorX + 1}R`
        }
        return
      case "t":
        windowOp(first)
        return
      case "K":
        if (!mutations.has("el-noop")) eraseLine(first)
        return
      case "J":
        eraseDisplay(first)
        return
      case "X":
        eraseChars(params[0] ?? 1)
        return
      case "@":
        insertChars(first)
        return
      case "P":
        deleteChars(first)
        return
      case "L":
        insertLines(first)
        return
      case "M":
        deleteLines(first)
        return
      case "S":
        scrollUp(first === 0 ? 1 : first)
        return
      case "T":
        scrollDown(first === 0 ? 1 : first)
        return
      case "b":
        repeatChar(first)
        return
      case "I":
        for (let count = 0; count < Math.max(1, first); count++) horizontalTab()
        return
      case "Z":
        for (let count = 0; count < Math.max(1, first); count++) cursorX = prevTabStop(cursorX)
        return
      case "g":
        if (first === 0) tabStops.delete(cursorX)
        else if (first === 3) tabStops.clear()
        return
      case "r":
        if (!mutations.has("scrollregion-noop")) {
          regionTop = clampRow((first === 0 ? 1 : first) - 1)
          const bottomRaw = (params[1] ?? 0) === 0 ? rows : (params[1] ?? rows)
          regionBottom = clampRow(bottomRaw - 1)
        }
        return
      case "m":
        applySgr(paramsRaw)
        return
      default:
        return
    }
  }

  const backspace = (): void => {
    if (mutations.has("bs-noop")) return
    if (cursorX > 0) {
      cursorX -= 1
      return
    }
    if (reverseWrap && autoWrap && cursorY > 0) {
      cursorY -= 1
      cursorX = cols - 1
    }
  }

  const consumeDcs = (payload: string): void => {
    if (payload === "$qm") {
      if (!mutations.has("decrqss-noop")) replies += "\x1bP1$r0m\x1b\\"
      return
    }
    if (payload === "+q544e") {
      if (!mutations.has("xtgettcap-noop")) replies += "\x1bP1+r544e=787465726d\x1b\\"
      return
    }
    if (payload.toLowerCase() === "+q7465726d4e616d65") {
      replies += mutations.has("xtgetxres-noop")
        ? "\x1bP0+R7465726d4e616d65\x1b\\"
        : "\x1bP1+R7465726d4e616d65=787465726d\x1b\\"
    }
  }

  const consumeOsc = (code: string, payload: string): void => {
    if (code === "1" && !mutations.has("xtwinops-20-noop")) iconLabel = payload
    else if (code === "2") title = payload
  }

  const consumeEscape = (rest: string): number => {
    const alignment = /^\x1b#8/u.exec(rest)
    if (alignment) {
      decaln()
      return alignment[0].length
    }
    if (rest.startsWith("\x1bc")) {
      ris()
      return 2
    }
    const dcs = /^\x1bP([^\x1b]*)\x1b\\/u.exec(rest)
    if (dcs) {
      consumeDcs(dcs[1] ?? "")
      return dcs[0].length
    }
    const osc = /^\x1b\]([12]);([^\x07\x1b]*)(?:\x07|\x1b\\)/u.exec(rest)
    if (osc) {
      consumeOsc(osc[1] ?? "", osc[2] ?? "")
      return osc[0].length
    }
    const match = /^\x1b\[([?<>=]?)([0-9;:]*)([\x20-\x2f]?)([\x40-\x7e])/u.exec(rest)
    if (match) {
      csi(match[1] ?? "", match[2] ?? "", match[3] ?? "", match[4] ?? "")
      return match[0].length
    }
    // The single-character C1 escapes: HTS, IND, NEL and RI (#28021 text.hts/index/next-line/…).
    const escape = rest[1]
    if (escape === "H") {
      setTabStop()
      return 2
    }
    if (escape === "D") {
      indexDown()
      return 2
    }
    if (escape === "E") {
      nextLine()
      return 2
    }
    if (escape === "M") {
      reverseIndex()
      return 2
    }
    if (escape === "7") {
      if (!mutations.has("decsc-noop")) decSavedCursor = [cursorX, cursorY]
      return 2
    }
    if (escape === "8") {
      ;[cursorX, cursorY] = decSavedCursor
      return 2
    }
    // The two-byte designations: ESC ( sets G0 and ESC ) sets G1. "0" is DEC Special Graphics;
    // every other final (B is US-ASCII) is treated as ASCII. #28025 charsets.* measure the result.
    if ((escape === "(" || escape === ")") && rest.length >= 3) {
      const designation = rest[2]
      const set: CharsetSet = designation === "0" && !mutations.has("charset-noop") ? "dec-special" : "ascii"
      if (escape === "(") charsetG0 = set
      else charsetG1 = set
      return 3
    }
    return 1
  }

  const feed = (text: string): void => {
    let index = 0
    while (index < text.length) {
      const rest = text.slice(index)
      if (rest.startsWith("\x1b")) {
        index += consumeEscape(rest)
        continue
      }
      const code = text.codePointAt(index) ?? 0
      const char = String.fromCodePoint(code)
      if (char === "\r") {
        cursorX = 0
        index += 1
        continue
      }
      if (char === "\n") {
        lineFeed()
        index += 1
        continue
      }
      if (char === "\x08") {
        backspace()
        index += 1
        continue
      }
      if (char === "\t") {
        horizontalTab()
        index += 1
        continue
      }
      // SI selects G0 and SO selects G1; a graphic character then renders through the selected set.
      if (char === "\x0f") {
        activeCharset = "g0"
        index += 1
        continue
      }
      if (char === "\x0e") {
        activeCharset = "g1"
        index += 1
        continue
      }
      const activeSet = activeCharset === "g0" ? charsetG0 : charsetG1
      const mapped = activeSet === "dec-special" ? DEC_SPECIAL_GRAPHICS[char] : undefined
      if (mapped !== undefined) {
        writeCluster(mapped, 1)
        index += 1
        continue
      }
      const grapheme = nextGrapheme(text, index)
      writeCluster(grapheme.cluster, clusterWidth(grapheme.cluster))
      index += grapheme.length
    }
  }

  const capture = (text: string): string => {
    replies = ""
    feed(text)
    const framed = replies
    replies = ""
    return framed
  }

  return {
    cols,
    feed,
    feedCapture: capture,
    queryWithSentinelOutcome(sequence: string, pattern: RegExp) {
      const reply = capture(sequence)
      const answer = capture("\x1b[c")
      const raw = reply + answer
      const rawBase64 = Buffer.from(raw).toString("base64")
      const match = pattern.exec(reply)
      if (match) return { match, reason: "reply" as const, raw, rawBase64 }
      if (/\x1b\[\?[0-9;]+c/u.test(answer)) {
        return {
          match: null,
          reason: "sentinel" as const,
          raw,
          rawBase64,
          sentinel: { atMs: 0, graceMs: 50 },
        }
      }
      return { match: null, reason: "timeout" as const, raw, rawBase64 }
    },
    getTitle() {
      return title
    },
    getCell(row: number, col: number): SurfaceCellState {
      const cell = cellAt(row, col)
      return {
        char: cell.char,
        bold: cell.bold,
        dim: cell.dim,
        italic: cell.italic,
        underline: cell.underline,
        underlineColor: cell.underlineColor,
        strikethrough: cell.strikethrough,
        inverse: cell.inverse,
        hidden: cell.hidden,
        blink: cell.blink,
        overline: cell.overline,
        fg: cell.fg,
        bg: cell.bg,
        wide: cell.wide === true,
      }
    },
    getCursor() {
      return { x: cursorX, y: cursorY, visible: cursorVisible, style: cursorStyle }
    },
    getScrollback() {
      return { viewportOffset: 0, totalLines: rows + scrolled, screenLines: rows }
    },
    getText() {
      return grid
        .map((row) =>
          row
            .map((cell) => cell.char)
            .join("")
            .replace(/\s+$/u, ""),
        )
        .join("\n")
    },
    getMode(mode: string) {
      if (mode === "applicationCursor") return applicationCursor
      if (mode === "altScreen") return altScreen
      if (mode === "autoWrap") return autoWrap
      return null
    },
    reset() {
      softReset()
      clear()
    },
  }
}
