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
 * (Unicode's tab-stops control).
 *
 * @fakes @terminfo/probe-defs
 */
import type { TermlessContext } from "../types.ts"
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

interface Attributes {
  bold: boolean
  dim: boolean
  italic: boolean
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

/** Apply SGR codes to an attribute set, the table `applySgr` and the rect attribute ops share. */
function applyCodes(attributes: Attributes, codes: readonly number[]): Attributes {
  let next = attributes
  for (const code of codes) {
    if (code === 0) next = NO_ATTRIBUTES
    else if (code === 1) next = { ...next, bold: true }
    else if (code === 2) next = { ...next, dim: true }
    else if (code === 3) next = { ...next, italic: true }
    else if (code === 5) next = { ...next, blink: true }
    else if (code === 7) next = { ...next, inverse: true }
    else if (code === 8) next = { ...next, hidden: true }
    else if (code === 9) next = { ...next, strikethrough: true }
    else if (code === 22) next = { ...next, bold: false, dim: false }
    else if (code === 23) next = { ...next, italic: false }
    else if (code === 25) next = { ...next, blink: false }
    else if (code === 27) next = { ...next, inverse: false }
    else if (code === 28) next = { ...next, hidden: false }
    else if (code === 29) next = { ...next, strikethrough: false }
    else if (code === 39) next = { ...next, fg: null }
    else if (code === 49) next = { ...next, bg: null }
    else if (code === 53) next = { ...next, overline: true }
    else if (code === 55) next = { ...next, overline: false }
    else if (code >= 40 && code <= 47) next = { ...next, bg: STANDARD_BG[code - 40] ?? null }
    else if (code >= 30 && code <= 37) next = { ...next, fg: STANDARD_FG[code - 30] ?? null }
  }
  return next
}

/** Reverse (toggle) the listed attribute codes in a set — DECRARA's per-cell effect. */
function reverseCodes(attributes: Attributes, codes: readonly number[]): Attributes {
  let next = attributes
  for (const code of codes) {
    if (code === 1) next = { ...next, bold: !next.bold }
    else if (code === 2) next = { ...next, dim: !next.dim }
    else if (code === 3) next = { ...next, italic: !next.italic }
    else if (code === 5) next = { ...next, blink: !next.blink }
    else if (code === 7) next = { ...next, inverse: !next.inverse }
    else if (code === 8) next = { ...next, hidden: !next.hidden }
    else if (code === 9) next = { ...next, strikethrough: !next.strikethrough }
    else if (code === 53) next = { ...next, overline: !next.overline }
  }
  return next
}

/** The cell shape `TermlessContext.getCell` returns. */
export type SurfaceCellState = ReturnType<TermlessContext["getCell"]>

export interface SemanticSurfaceOptions {
  readonly cols?: number
  readonly rows?: number
  /** Named faults, so a group's negative control can prove its binding can fail. */
  readonly mutations?: readonly string[]
}

/** A semantic headless surface plus the state reads the Reset probes need. */
export interface SemanticSurface extends HeadlessModel {
  getText(): string
  getMode(mode: string): boolean
  reset(): void
}

export function createSemanticSurface(options: SemanticSurfaceOptions = {}): SemanticSurface {
  const cols = options.cols ?? 80
  const rows = options.rows ?? 24
  const mutations = new Set(options.mutations ?? [])
  let grid: SurfaceCell[][] = []
  let cursorX = 0
  let cursorY = 0
  let regionTop = 0
  let regionBottom = rows - 1
  let scrolled = 0
  let attributes: Attributes = NO_ATTRIBUTES
  let protecting = false
  let applicationCursor = false
  let tabStops = defaultTabStops(cols)
  let charsetG0: CharsetSet = "ascii"
  let charsetG1: CharsetSet = "ascii"
  let activeCharset: "g0" | "g1" = "g0"
  let lastCluster = " "
  let lastWidth = 1
  /** Bytes the surface owes a caller in reply to a query (DECRQCRA), read back by feedCapture. */
  let replies = ""

  const blankRow = (): SurfaceCell[] => Array.from({ length: cols }, () => blankCell(NO_ATTRIBUTES))

  const clear = (): void => {
    grid = Array.from({ length: rows }, blankRow)
    cursorX = 0
    cursorY = 0
    regionTop = 0
    regionBottom = rows - 1
    scrolled = 0
    tabStops = defaultTabStops(cols)
    charsetG0 = "ascii"
    charsetG1 = "ascii"
    activeCharset = "g0"
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

  const clampCol = (col: number): number => (col < 0 ? 0 : col > cols - 1 ? cols - 1 : col)
  const cellAt = (row: number, col: number): SurfaceCell => grid[row]?.[col] ?? blankCell(NO_ATTRIBUTES)

  const lineFeed = (): void => {
    if (mutations.has("lf-noop")) return
    if (cursorY >= regionBottom) {
      grid.splice(regionTop, 1)
      grid.splice(regionBottom, 0, blankRow())
      scrolled += 1
      return
    }
    cursorY += 1
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
    eachCellIn(params, (cell) => ({
      ...cell,
      ...(reverse ? reverseCodes(cell, codes) : applyCodes(cell, codes)),
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
      row[col] = { char: " ", decscaProtected: existing.decscaProtected, ...NO_ATTRIBUTES, bg: attributes.bg }
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

  const applySgr = (params: readonly number[]): void => {
    attributes = applyCodes(attributes, params.length === 0 ? [0] : params)
  }

  const softReset = (): void => {
    applicationCursor = false
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

  const csi = (prefix: string, paramsRaw: string, intermediate: string, final: string): void => {
    const params = paramsRaw === "" ? [] : paramsRaw.split(";").map((raw) => (raw === "" ? 0 : Number(raw)))
    const first = params[0] ?? 0
    if (intermediate === '"' && final === "q") {
      protecting = first !== 0
      return
    }
    if (intermediate === "!") {
      if (final === "p") softReset()
      return
    }
    if (intermediate === "$") {
      if (final === "x") fillRect(params)
      else if (final === "z") blankRect(params, false)
      else if (final === "{") blankRect(params, true)
      else if (final === "v") copyRect(params)
      else if (final === "r") changeRectAttributes(params, false)
      else if (final === "t") changeRectAttributes(params, true)
      return
    }
    if (intermediate === "*") {
      // DECSACE selects the attribute-change extent (no cell effect); DECRQCRA frames a checksum reply.
      if (final === "y") requestChecksum(params)
      return
    }
    if (intermediate === "'") {
      if (final === "}") insertColumns(first === 0 ? 1 : first)
      else if (final === "~") deleteColumns(first === 0 ? 1 : first)
      return
    }
    if (intermediate === " ") {
      if (final === "@") shiftLeft(first === 0 ? 1 : first)
      else if (final === "A") shiftRight(first === 0 ? 1 : first)
      return
    }
    if (prefix === "?") {
      if (final === "h" && first === 1) applicationCursor = true
      else if (final === "l" && first === 1) applicationCursor = false
      else if (final === "J") selectiveErase()
      return
    }
    switch (final) {
      case "H":
      case "f":
        cursorY = clampCol((params[0] ?? 1) - 1)
        cursorX = clampCol((params[1] ?? 1) - 1)
        return
      case "G":
        cursorX = clampCol((params[0] ?? 1) - 1)
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
        regionTop = clampCol((params[0] ?? 1) - 1)
        regionBottom = clampCol((params[1] ?? rows) - 1)
        return
      case "m":
        applySgr(params)
        return
      default:
        return
    }
  }

  const feed = (text: string): void => {
    let index = 0
    while (index < text.length) {
      const rest = text.slice(index)
      if (rest.startsWith("\x1b")) {
        const alignment = /^\x1b#8/u.exec(rest)
        if (alignment) {
          decaln()
          index += alignment[0].length
          continue
        }
        if (rest.startsWith("\x1bc")) {
          ris()
          index += 2
          continue
        }
        const match = /^\x1b\[([?<>]?)([0-9;]*)([\x20-\x2f]?)([\x40-\x7e])/u.exec(rest)
        if (match) {
          csi(match[1] ?? "", match[2] ?? "", match[3] ?? "", match[4] ?? "")
          index += match[0].length
          continue
        }
        // The single-character C1 escapes: HTS, IND, NEL and RI (#28021 text.hts/index/next-line/…).
        const escape = rest[1]
        if (escape === "H") {
          setTabStop()
          index += 2
          continue
        }
        if (escape === "D") {
          indexDown()
          index += 2
          continue
        }
        if (escape === "E") {
          nextLine()
          index += 2
          continue
        }
        if (escape === "M") {
          reverseIndex()
          index += 2
          continue
        }
        // The two-byte designations: ESC ( sets G0 and ESC ) sets G1. "0" is DEC Special Graphics;
        // every other final (B is US-ASCII) is treated as ASCII. #28025 charsets.* measure the result.
        if ((escape === "(" || escape === ")") && rest.length >= 3) {
          const designation = rest[2]
          const set: CharsetSet = designation === "0" && !mutations.has("charset-noop") ? "dec-special" : "ascii"
          if (escape === "(") charsetG0 = set
          else charsetG1 = set
          index += 3
          continue
        }
        index += 1
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
        if (!mutations.has("bs-noop")) cursorX = Math.max(0, cursorX - 1)
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

  return {
    cols,
    feed,
    feedCapture(text: string): string {
      replies = ""
      feed(text)
      const framed = replies
      replies = ""
      return framed
    },
    getCell(row: number, col: number): SurfaceCellState {
      const cell = cellAt(row, col)
      return {
        char: cell.char,
        bold: cell.bold,
        dim: cell.dim,
        italic: cell.italic,
        underline: null,
        underlineColor: null,
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
      return { x: cursorX, y: cursorY, visible: true, style: null }
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
      return mode === "applicationCursor" ? applicationCursor : false
    },
    reset() {
      softReset()
      clear()
    },
  }
}
