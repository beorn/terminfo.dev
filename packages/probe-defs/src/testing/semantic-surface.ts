/**
 * One semantic headless surface for the candidate-2 group contracts (#28023 Erase, #28024 Reset).
 *
 * #28453 leaves the headless model to the group, so a group that needs a terminal supplies one. Two
 * groups needing the same terminal share ONE implementation rather than each reinventing the fake:
 * this surface really performs the operations the Erase and Reset probes exercise - EL 0/1/2, ED
 * 0/1/2/3, ECH, DECSED with DECSCA protection, DECSTBM with a real scrollback count, SGR attributes,
 * RIS, DECSTR, DECALN and DECCKM - so a row reads "supported" only when the probe's own expectation
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
}

function blankCell(attributes: Attributes): SurfaceCell {
  return { char: " ", decscaProtected: false, ...attributes }
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

  const blankRow = (): SurfaceCell[] => Array.from({ length: cols }, () => blankCell(NO_ATTRIBUTES))

  const clear = (): void => {
    grid = Array.from({ length: rows }, blankRow)
    cursorX = 0
    cursorY = 0
    regionTop = 0
    regionBottom = rows - 1
    scrolled = 0
  }
  clear()

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

  const put = (char: string): void => {
    if (cursorX >= cols) {
      cursorX = 0
      lineFeed()
    }
    const target = grid[cursorY]
    if (target) target[cursorX] = { char, decscaProtected: protecting, ...attributes }
    cursorX += 1
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
      const char = text[index]
      if (char === "\x1b") {
        const rest = text.slice(index)
        const escape = /^\x1b#8/u.exec(rest)
        if (escape) {
          decaln()
          index += escape[0].length
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
        index += 1
        continue
      }
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
      put(char ?? " ")
      index += 1
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
        wide: false,
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
