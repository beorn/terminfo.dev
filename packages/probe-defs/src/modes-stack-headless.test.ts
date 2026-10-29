/**
 * @failure The six XT stack probes grade a headless engine on DA1 responsiveness instead of the
 *   saved/restored state, or grade a backend that reports no attributes, palette or wrap state as a
 *   negative; or the left/right margin probe grades mode metadata instead of an ICH its margins
 *   confine, or grades a backend whose ICH shows no shift as a negative.
 * @level l1
 * @consumer Headless Modes observations for the six XT stack cells and the left/right margin cell on
 *   every termless engine (#30700, #30702).
 * @testonly none
 */
import { expect, test } from "vitest"
import { modesProbes } from "./modes.ts"
import type { LibProbeSource } from "./types.ts"

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
  /** The backend implements DECLRMM (?69) and DECSLRM. */
  margins?: boolean
  /** The backend implements ICH. */
  insertChars?: boolean
}

const DEFAULT_INDEX_1: Rgb = { r: 205, g: 0, b: 0 }
const TOKEN = /\x1b\][^\x07]*\x07|\x1b\[[0-9;?#]*[A-Za-z{}@]|[^\x1b]/gu

/** A tiny parser with exactly the state the six stack fixtures and the margin fixture write and read back. */
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
  const margins = options.margins ?? true
  const insertChars = options.insertChars ?? true
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
  let leftRightMode = false
  let leftMargin = 0
  let rightMargin = cols - 1
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
      case "\x1b[?69h":
        if (margins) leftRightMode = true
        return ""
      case "\x1b[?69l":
        leftRightMode = false
        leftMargin = 0
        rightMargin = cols - 1
        return ""
      default: {
        if (token.startsWith("\x1b]4;1;")) {
          if (osc4) palette.set(1, parseRgb(token))
          return ""
        }
        const cup = /^\x1b\[(\d+);(\d+)H$/u.exec(token)
        if (cup) {
          cursor = { x: Number(cup[2]) - 1, y: Number(cup[1]) - 1 }
          pendingWrap = false
          return ""
        }
        // CSI Pl;Pr s is DECSLRM only under DECLRMM (it homes the cursor); otherwise it saves the cursor.
        const slrm = /^\x1b\[(\d*);?(\d*)s$/u.exec(token)
        if (slrm) {
          if (leftRightMode) {
            leftMargin = Number(slrm[1] || 1) - 1
            rightMargin = Number(slrm[2] || cols) - 1
            cursor = { x: 0, y: 0 }
            pendingWrap = false
          }
          return ""
        }
        const ich = /^\x1b\[(\d*)@$/u.exec(token)
        if (ich) {
          const row = cells[cursor.y]
          if (!row) throw new Error("cursor row off the grid")
          const inside = !leftRightMode || (cursor.x >= leftMargin && cursor.x <= rightMargin)
          if (insertChars && inside) {
            const end = leftRightMode ? rightMargin : cols - 1
            const count = Math.min(Number(ich[1] || 1), end - cursor.x + 1)
            for (let col = end; col >= cursor.x + count; col -= 1) row[col] = row[col - count] ?? blank()
            for (let col = cursor.x; col < cursor.x + count; col += 1) row[col] = blank()
          }
          return ""
        }
        if (token.startsWith("\x1b")) throw new Error(`unmodelled sequence ${JSON.stringify(token)}`)
        put(token)
        return ""
      }
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
  } as unknown as LibProbeSource
  return {
    context,
    feeds,
    depth: () => sgrSaved.length + paletteSaved.length,
    wrap: () => autoWrap,
    margins: () => ({ leftRightMode, leftMargin, rightMargin }),
  }
}

function headless(id: string) {
  const definition = modesProbes.find((item) => item.id === id)
  if (!definition?.lib) throw new Error(`Missing headless callback for ${id}`)
  return definition.lib
}

const SGR = ["modes.xtpushsgr", "modes.xtpopsgr"] as const
const MODE = ["modes.xtsave", "modes.xtrestore"] as const
const COLOR = ["modes.xtpushcolors", "modes.xtpopcolors"] as const
const ALL = [...SGR, ...MODE, ...COLOR] as const

test.each(ALL)("%s grades a working roundtrip supported from cells, never from DA1", (id) => {
  const screen = fakeScreen()
  const result = headless(id)(screen.context)
  expect(result.pass, id).toBe(true)
  expect(result.observation, id).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
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
  expect(result.observation, id).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
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
    assertionType: "buffer_state",
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

const MARGIN = "modes.left-right-margin"

test.each([
  ["honoured margins", "supported", {}, "AB CDEGH"],
  ["ignored margins", "unsupported", { margins: false }, "AB CDEFG"],
] as const)("%s grade %s from row 1's cells inside and outside DECSLRM 3;6", (_label, outcome, options, target) => {
  const screen = fakeScreen(options)
  const result = headless(MARGIN)(screen.context)
  expect(result.pass).toBe(outcome === "supported")
  expect(result.observation).toMatchObject({ outcome, assertionType: "buffer_state" })
  if (outcome === "unsupported") expect(result.observation?.note).toContain("shifted the whole row")
  expect(result.assertions?.[0]?.kind).toBe(outcome === "supported" ? "positive" : "negative")
  expect(JSON.parse(result.response ?? "{}")).toMatchObject({ seed: "ABCDEFGH", control: "AB CDEFG", target })
  expect(screen.feeds.join("")).toContain("\x1b[?69h\x1b[3;6s\x1b[1;3H\x1b[@")
  expect(screen.feeds.at(-1)).toBe("\x1b[s\x1b[?69l\x1b[0m\x1b[2J\x1b[H")
  expect(screen.margins()).toEqual({ leftRightMode: false, leftMargin: 0, rightMargin: 7 })
})

test("modes.left-right-margin routes a readback whose ICH shows no shift to source-negative-review", () => {
  const screen = fakeScreen({ insertChars: false })
  const result = headless(MARGIN)(screen.context)
  expect(result.pass).toBe(false)
  expect(result.notTested).toBeUndefined()
  expect(result.criterionBranch).toBe("source-negative-review")
  expect(result.tests).toEqual([
    {
      id: "review",
      status: "test-failure",
      reason: "ICH shifting row 1 right from column 3 in the headless readback (control frame not calibrated)",
    },
  ])
  expect(result.observation).toEqual({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    assertionType: "buffer_state",
  })
  expect(result.assertions).toEqual([
    {
      assertionType: "buffer_state",
      kind: "negative",
      expected:
        "Left-right margin mode constrains horizontal operations: ICH at column 3 under DECSLRM 3;6 drops F at column 6 and leaves G and H in columns 7-8",
      observed: result.response!,
    },
  ])
  expect(screen.feeds.join("")).not.toContain("\x1b[?69h")
  expect(screen.feeds.at(-1)).toBe("\x1b[?69l\x1b[0m\x1b[2J\x1b[H")
})

test("modes.left-right-margin stays inconclusive on a grid narrower than its eight-column seed, before any bytes", () => {
  const screen = fakeScreen({ cols: 7 })
  const result = headless(MARGIN)(screen.context)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    note: "Measured grid needs eight columns",
  })
  expect(result.assertions).toBeUndefined()
  expect(screen.feeds).toEqual([])
})
