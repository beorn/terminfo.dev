/**
 * One semantic headless surface for the candidate-2 group contracts (#28023 Erase, #28024 Reset).
 *
 * #28453 leaves the headless model to the group, so a group that needs a terminal supplies one. Two
 * groups needing the same terminal share ONE implementation rather than each reinventing the fake:
 * this surface really performs the operations the Erase, Reset and Text probes exercise - EL 0/1/2,
 * ED 0/1/2/3, ECH, DECSED with DECSCA protection, DECSTBM with a real scrollback count, SGR
 * attributes, RIS, DECSTR, DECALN, DECCKM, the text primitives (CR, BS, IND, NEL, RI and the
 * HT/HTS/TBC/CHT/CBT tab family) and grapheme-aware writing (a wide cluster claims two columns and a
 * combining mark rides its base) - so a row reads "supported" only when the probe's own expectation
 * agrees with a terminal that really does the thing.
 *
 * `mutations` injects one named fault so a group can prove its binding is not a stamp: "el-noop"
 * makes EL inert (the Erase group's negative control) and "ris-noop" makes RIS inert (Reset's).
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

  const blankRow = (): SurfaceCell[] => Array.from({ length: cols }, () => blankCell(NO_ATTRIBUTES))

  const clear = (): void => {
    grid = Array.from({ length: rows }, blankRow)
    cursorX = 0
    cursorY = 0
    regionTop = 0
    regionBottom = rows - 1
    scrolled = 0
    tabStops = defaultTabStops(cols)
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
    const codes = params.length === 0 ? [0] : params
    for (const code of codes) {
      if (code === 0) attributes = NO_ATTRIBUTES
      else if (code === 1) attributes = { ...attributes, bold: true }
      else if (code === 2) attributes = { ...attributes, dim: true }
      else if (code === 3) attributes = { ...attributes, italic: true }
      else if (code === 5) attributes = { ...attributes, blink: true }
      else if (code === 7) attributes = { ...attributes, inverse: true }
      else if (code === 8) attributes = { ...attributes, hidden: true }
      else if (code === 9) attributes = { ...attributes, strikethrough: true }
      else if (code === 22) attributes = { ...attributes, bold: false, dim: false }
      else if (code === 23) attributes = { ...attributes, italic: false }
      else if (code === 25) attributes = { ...attributes, blink: false }
      else if (code === 27) attributes = { ...attributes, inverse: false }
      else if (code === 28) attributes = { ...attributes, hidden: false }
      else if (code === 29) attributes = { ...attributes, strikethrough: false }
      else if (code === 39) attributes = { ...attributes, fg: null }
      else if (code === 49) attributes = { ...attributes, bg: null }
      else if (code === 53) attributes = { ...attributes, overline: true }
      else if (code === 55) attributes = { ...attributes, overline: false }
      else if (code >= 40 && code <= 47) attributes = { ...attributes, bg: STANDARD_BG[code - 40] ?? null }
      else if (code >= 30 && code <= 37) attributes = { ...attributes, fg: STANDARD_FG[code - 30] ?? null }
    }
  }

  const softReset = (): void => {
    applicationCursor = false
    attributes = NO_ATTRIBUTES
    protecting = false
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
      const grapheme = nextGrapheme(text, index)
      writeCluster(grapheme.cluster, clusterWidth(grapheme.cluster))
      index += grapheme.length
    }
  }

  return {
    cols,
    feed,
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
