/**
 * @failure The six XT stack probes grade a headless engine on DA1 responsiveness instead of the
 *   saved/restored state, or grade a backend that reports no attributes, palette or wrap state as a
 *   negative.
 * @level l1
 * @consumer Headless Modes observations for the six XT stack cells on every termless engine (#30700).
 * @testonly none
 */
import { expect, test } from "vitest"
import { modesProbes } from "./modes.ts"
import type { TermlessContext } from "./types.ts"

type Rgb = { r: number; g: number; b: number }

interface ScreenOptions {
  cols?: number
  rows?: number
  /** The backend implements XTPUSHSGR/XTPOPSGR. */
  sgrStack?: boolean
  /** The backend implements XTSAVE/XTRESTORE. */
  modeStack?: boolean
  /** The backend implements XTPUSHCOLORS/XTPOPCOLORS. */
  colorStack?: boolean
  /** The backend reports bold and italic on its cells. */
  attributes?: boolean
  /** The backend applies OSC 4 palette redefinitions. */
  osc4?: boolean
  /** The backend can turn auto-wrap off. */
  wrapOff?: boolean
  /** Output the backend emits for every stack operation (a misbehaving engine). */
  stackOutput?: string
}

const DEFAULT_INDEX_1: Rgb = { r: 205, g: 0, b: 0 }
const TOKEN = /\x1b\][^\x07]*\x07|\x1b\[[0-9;?#]*[A-Za-z{}]|[^\x1b]/gu

/** A tiny parser with exactly the state the six stack fixtures write and read back. */
function fakeScreen(options: ScreenOptions = {}) {
  const cols = options.cols ?? 8
  const rows = options.rows ?? 3
  const sgrStack = options.sgrStack ?? true
  const modeStack = options.modeStack ?? true
  const colorStack = options.colorStack ?? true
  const attributes = options.attributes ?? true
  const osc4 = options.osc4 ?? true
  const wrapOff = options.wrapOff ?? true
  const stackOutput = options.stackOutput ?? ""
  const blank = () => ({ char: " ", bold: false, italic: false, fg: null as Rgb | null })
  let cells = Array.from({ length: rows }, () => Array.from({ length: cols }, blank))
  const palette = new Map<number, Rgb>([[1, { ...DEFAULT_INDEX_1 }]])
  const sgrSaved: Array<{ bold: boolean; italic: boolean }> = []
  const paletteSaved: Array<Map<number, Rgb>> = []
  let bold = false
  let italic = false
  let fgIndex: number | null = null
  let autoWrap = true
  let savedWrap: boolean | null = null
  let cursor = { x: 0, y: 0 }
  let pendingWrap = false
  const feeds: string[] = []

  const put = (char: string) => {
    if (pendingWrap) {
      if (autoWrap) cursor = { x: 0, y: Math.min(cursor.y + 1, rows - 1) }
      else cursor = { ...cursor, x: cols - 1 }
      pendingWrap = false
    }
    const fg = fgIndex === null ? null : { ...(palette.get(fgIndex) ?? { r: 0, g: 0, b: 0 }) }
    const row = cells[cursor.y]
    if (!row) throw new Error("cursor row off the grid")
    row[cursor.x] = { char, bold, italic, fg }
    if (cursor.x === cols - 1) pendingWrap = true
    else cursor = { ...cursor, x: cursor.x + 1 }
  }
  const parseRgb = (osc: string): Rgb => {
    const [r = "0", g = "0", b = "0"] = osc.slice(osc.indexOf("rgb:") + 4, -1).split("/")
    return { r: parseInt(r, 16), g: parseInt(g, 16), b: parseInt(b, 16) }
  }
  const apply = (token: string): string => {
    switch (token) {
      case "\x1b[0m":
        bold = italic = false
        fgIndex = null
        return ""
      case "\x1b[1m":
        bold = true
        return ""
      case "\x1b[3m":
        italic = true
        return ""
      case "\x1b[38;5;1m":
        fgIndex = 1
        return ""
      case "\x1b[2J":
        cells = Array.from({ length: rows }, () => Array.from({ length: cols }, blank))
        return ""
      case "\x1b[1;1H":
      case "\x1b[H":
        cursor = { x: 0, y: 0 }
        pendingWrap = false
        return ""
      case "\x1b[?7h":
        autoWrap = true
        return ""
      case "\x1b[?7l":
        if (wrapOff) autoWrap = false
        return ""
      case "\x1b[?7s":
        if (modeStack) savedWrap = autoWrap
        return stackOutput
      case "\x1b[?7r":
        if (modeStack && savedWrap !== null) autoWrap = savedWrap
        return stackOutput
      case "\x1b[#{":
        if (sgrStack) sgrSaved.push({ bold, italic })
        return stackOutput
      case "\x1b[#}": {
        const saved = sgrStack ? sgrSaved.pop() : undefined
        if (saved) ({ bold, italic } = saved)
        return stackOutput
      }
      case "\x1b[#P":
        if (colorStack) paletteSaved.push(new Map(palette))
        return stackOutput
      case "\x1b[#Q": {
        const saved = colorStack ? paletteSaved.pop() : undefined
        if (saved) {
          palette.clear()
          for (const [index, rgb] of saved) palette.set(index, rgb)
        }
        return stackOutput
      }
      case "\x1b]104\x07":
        palette.set(1, { ...DEFAULT_INDEX_1 })
        return ""
      default:
        if (token.startsWith("\x1b]4;1;")) {
          if (osc4) palette.set(1, parseRgb(token))
          return ""
        }
        if (token.startsWith("\x1b")) throw new Error(`unmodelled sequence ${JSON.stringify(token)}`)
        put(token)
        return ""
    }
  }
  const feedCapture = (text: string): string => {
    feeds.push(text)
    return (text.match(TOKEN) ?? []).map(apply).join("")
  }
  const context = {
    cols,
    feed: (text: string) => {
      feedCapture(text)
    },
    feedCapture,
    getCell: (row: number, col: number) => {
      const cell = cells[row]?.[col]
      if (!cell) throw new Error(`out-of-grid read ${row},${col}`)
      return attributes ? { ...cell } : { ...cell, bold: false, italic: false }
    },
    getMode: (mode: string) => (mode === "autoWrap" ? autoWrap : null),
    getScrollback: () => ({ viewportOffset: 0, totalLines: rows, screenLines: rows }),
  } as unknown as TermlessContext
  return {
    context,
    feeds,
    depth: () => sgrSaved.length + paletteSaved.length,
    wrap: () => autoWrap,
  }
}

function headless(id: string) {
  const definition = modesProbes.find((item) => item.id === id)
  if (!definition?.termless) throw new Error(`Missing headless callback for ${id}`)
  return definition.termless
}

const SGR = ["modes.xtpushsgr", "modes.xtpopsgr"] as const
const MODE = ["modes.xtsave", "modes.xtrestore"] as const
const COLOR = ["modes.xtpushcolors", "modes.xtpopcolors"] as const
const ALL = [...SGR, ...MODE, ...COLOR] as const

test.each(ALL)("%s grades a working roundtrip supported from cells, never from DA1", (id) => {
  const screen = fakeScreen()
  const result = headless(id)(screen.context)
  expect(result.pass, id).toBe(true)
  expect(result.observation, id).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(result.assertions?.[0]?.kind, id).toBe("positive")
  expect(screen.feeds.join(""), id).not.toContain("\x1b[c")
  expect(screen.depth(), id).toBe(0)
  expect(screen.wrap(), id).toBe(true)
  expect(screen.feeds.at(-1), id).toMatch(/\x1b\[2J\x1b\[H$/u)
})

test.each([
  [SGR[0], { sgrStack: false }],
  [SGR[1], { sgrStack: false }],
  [MODE[0], { modeStack: false }],
  [MODE[1], { modeStack: false }],
  [COLOR[0], { colorStack: false }],
  [COLOR[1], { colorStack: false }],
] as const)("%s grades an ignored push/pop unsupported once its controls are calibrated", (id, options) => {
  const screen = fakeScreen(options)
  const result = headless(id)(screen.context)
  expect(result.pass, id).toBe(false)
  expect(result.observation, id).toMatchObject({ outcome: "unsupported", evidence: "parser-state" })
  expect(result.assertions?.[0]?.kind, id).toBe("negative")
  expect(screen.depth(), id).toBe(0)
  expect(screen.wrap(), id).toBe(true)
})

test.each([
  [SGR[0], { attributes: false }, "bold and italic"],
  [SGR[1], { attributes: false }, "bold and italic"],
  [MODE[0], { wrapOff: false }, "auto-wrap"],
  [MODE[1], { wrapOff: false }, "auto-wrap"],
  [COLOR[0], { osc4: false }, "OSC 4"],
  [COLOR[1], { osc4: false }, "OSC 4"],
] as const)("%s records a readback that cannot calibrate %o as no observable (TEST TODO)", (id, options, need) => {
  const screen = fakeScreen(options)
  const result = headless(id)(screen.context)
  expect(result.pass, id).toBe(false)
  expect(result.observation, id).toBeUndefined()
  expect(result.notTested, id).toEqual({
    reason: "no-semantic-observable",
    noObservable: expect.stringContaining(need),
  })
  expect(result.note, id).toContain(need)
  expect(result.assertions, id).toBeUndefined()
  expect(screen.depth(), id).toBe(0)
  expect(screen.wrap(), id).toBe(true)
})

test.each([
  [SGR[0], { cols: 2 }, "three columns"],
  [MODE[0], { rows: 1 }, "two rows"],
  [COLOR[0], { cols: 1 }, "two columns"],
] as const)("%s stays inconclusive on an undersized grid %o before any bytes", (id, options, need) => {
  const screen = fakeScreen(options)
  const result = headless(id)(screen.context)
  expect(result.pass, id).toBe(false)
  expect(result.observation, id).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "parser-state",
  })
  expect(result.observation?.note, id).toContain(need)
  expect(result.assertions, id).toBeUndefined()
  expect(screen.feeds, id).toEqual([])
})

test.each(ALL)("%s keeps a stack operation that answers as an invalid reply and still pops its push", (id) => {
  const screen = fakeScreen({ stackOutput: "\x1b[?62;22c" })
  const result = headless(id)(screen.context)
  expect(result.pass, id).toBe(false)
  expect(result.response, id).toBe("\x1b[?62;22c")
  expect(result.observation, id).toMatchObject({
    outcome: "inconclusive",
    reason: "invalid-reply",
    note: "Unexpected output during stack operation",
  })
  expect(screen.depth(), id).toBe(0)
  expect(screen.wrap(), id).toBe(true)
})
