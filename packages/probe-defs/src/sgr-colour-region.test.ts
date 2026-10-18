/**
 * @failure The 11 sgr.* colour rows on an owned-capture run all return the generic
 *   "Control and target pixels captured; visual interpretation requires review" and stay
 *   inconclusive on every context, although each row's own catalogue probe already names a
 *   discriminator that needs no absolute palette: the styled cells must differ from the neutral
 *   baseline AND from a second, different colour in the same family. A capture arm that keeps the
 *   generic review note for a row it can decide, or that grades "the frames differ" as support
 *   without that second colour, is the bug this test pins.
 * @level l1
 * @consumer The capture arms of the 11 sgr.* colour rows on owned Linux app contexts.
 * @testonly none
 */
import { expect, test } from "vitest"
import { sgrProbes } from "./sgr.ts"
import type {
  CaptureCells,
  CapturePixelGeometry,
  CaptureRequest,
  CaptureRectangle,
  ObservationFrame,
  TermContext,
} from "./types.ts"

const ROWS = 24
const COLS = 80
const GEOMETRY: CapturePixelGeometry = { cellWidth: 8, cellHeight: 16, textWidth: 640, textHeight: 384 }
const RECTANGLE: CaptureRectangle = { x: 0, y: 0, width: 640, height: 384 }

/** The 11 colour rows whose termless arm already demands a distinct-colour reference. */
const COLOUR_IDS = [
  "sgr.underline.color",
  "sgr.underline-color-indexed",
  "sgr.underline-color-rgb",
  "sgr.fg.standard",
  "sgr.bg.standard",
  "sgr.fg.bright",
  "sgr.bg.bright",
  "sgr.fg.256",
  "sgr.bg.256",
  "sgr.fg.truecolor",
  "sgr.bg.truecolor",
] as const

/** Rows that must stay inconclusive BY NAME: one frame cannot separate a blink phase, and the two
 * reset rows have no reference independent of the reset under test. */
const REVIEW_IDS = ["sgr.blink", "sgr.reset", "sgr.selective-reset.bold"] as const

interface Palette {
  name: string
  standard: readonly string[]
  bright: readonly string[]
  indexed: (index: number) => string
}

/** The two Linux contexts the retained evidence covers, with the colours they actually rendered. */
const PALETTES: readonly Palette[] = [
  {
    name: "wezterm/linux",
    standard: kindOf("wezterm", "standard"),
    bright: kindOf("wezterm", "bright"),
    indexed: (index) => indexOf("wezterm", index),
  },
  {
    name: "alacritty/linux",
    standard: kindOf("alacritty", "standard"),
    bright: kindOf("alacritty", "bright"),
    indexed: (index) => indexOf("alacritty", index),
  },
]

function kindOf(theme: string, kind: "standard" | "bright"): readonly string[] {
  const palette =
    theme === "wezterm"
      ? {
          rest: "178,178,178",
          red: "204,85,85",
          green: "85,204,85",
          blue: "85,85,204",
          brightRed: "255,85,85",
          brightGreen: "85,255,85",
          brightBlue: "85,85,255",
        }
      : {
          rest: "216,216,216",
          red: "172,66,66",
          green: "66,172,66",
          blue: "66,66,172",
          brightRed: "197,85,85",
          brightGreen: "85,197,85",
          brightBlue: "85,85,197",
        }
  return kind === "standard"
    ? [palette.rest, palette.red, palette.green, palette.rest, palette.blue, palette.rest, palette.rest, palette.rest]
    : [
        palette.rest,
        palette.brightRed,
        palette.brightGreen,
        palette.rest,
        palette.brightBlue,
        palette.rest,
        palette.rest,
        palette.rest,
      ]
}

function indexOf(theme: string, index: number): string {
  if (index === 67) return "95,135,175"
  if (index === 173) return "215,135,95"
  if (index === 5) return theme === "wezterm" ? "204,85,204" : "170,117,159"
  return `index-${index}`
}

type Mode = "render" | "ignore" | "collapse"

interface Ink {
  fg: string
  bg: string
  underlineColour: string
  underline: boolean
}

interface Cell extends Ink {
  char: string
}

function paintColour(mode: Mode, kind: "fg" | "bg" | "underline", colour: string): string {
  if (mode === "ignore") return "default"
  if (mode === "collapse") return "one-colour"
  return `${kind}:${colour}`
}

function applySgr(ink: Ink, params: readonly number[], mode: Mode, palette: Palette): Ink {
  const next: Ink = { ...ink }
  let index = 0
  while (index < params.length) {
    const param = params[index] ?? 0
    if (param === 0) {
      next.fg = "default"
      next.bg = "default"
      next.underlineColour = "default"
      next.underline = false
      index += 1
      continue
    }
    if (param === 4) {
      next.underline = true
      index += 1
      continue
    }
    if (param === 24) {
      next.underline = false
      index += 1
      continue
    }
    if (param === 39) {
      next.fg = "default"
      index += 1
      continue
    }
    if (param === 49) {
      next.bg = "default"
      index += 1
      continue
    }
    if (param === 59) {
      next.underlineColour = "default"
      index += 1
      continue
    }
    if (param >= 30 && param <= 37) {
      next.fg = paintColour(mode, "fg", `standard-${param - 30}@${palette.standard[param - 30]}`)
      index += 1
      continue
    }
    if (param >= 40 && param <= 47) {
      next.bg = paintColour(mode, "bg", `standard-${param - 40}@${palette.standard[param - 40]}`)
      index += 1
      continue
    }
    if (param >= 90 && param <= 97) {
      next.fg = paintColour(mode, "fg", `bright-${param - 90}@${palette.bright[param - 90]}`)
      index += 1
      continue
    }
    if (param >= 100 && param <= 107) {
      next.bg = paintColour(mode, "bg", `bright-${param - 100}@${palette.bright[param - 100]}`)
      index += 1
      continue
    }
    if (param === 38 || param === 48 || param === 58) {
      const slot = param === 38 ? "fg" : param === 48 ? "bg" : "underline"
      const modeParam = params[index + 1]
      if (modeParam === 5) {
        const entry = palette.indexed(params[index + 2] ?? 0)
        const colour = paintColour(mode, slot, `index-${params[index + 2]}@${entry}`)
        if (slot === "fg") next.fg = colour
        else if (slot === "bg") next.bg = colour
        else next.underlineColour = colour
        index += 3
        continue
      }
      if (modeParam === 2) {
        const rgb = `${params[index + 2]},${params[index + 3]},${params[index + 4]}`
        const colour = paintColour(mode, slot, `rgb-${rgb}`)
        if (slot === "fg") next.fg = colour
        else if (slot === "bg") next.bg = colour
        else next.underlineColour = colour
        index += 5
        continue
      }
    }
    index += 1
  }
  return next
}

interface Screen {
  grid: Cell[][]
  row: number
  col: number
  ink: Ink
}

function blankScreen(): Screen {
  const cell: Cell = { char: " ", fg: "default", bg: "default", underlineColour: "default", underline: false }
  return {
    grid: Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => ({ ...cell }))),
    row: 0,
    col: 0,
    ink: { fg: "default", bg: "default", underlineColour: "default", underline: false },
  }
}

const CONTROL = /^\x1b\[([0-9;:?]*)([@-~])/

/** Paint one write onto the fake screen. The probe only ever writes CUP, ED and SGR, so everything
 * else is ignored rather than guessed at. */
function paint(screen: Screen, write: string, mode: Mode, palette: Palette): void {
  let rest = write
  while (rest.length > 0) {
    const control = CONTROL.exec(rest)
    if (control) {
      const params = (control[1] ?? "")
        .split(/[;:]/)
        .filter((part) => part.length > 0)
        .map(Number)
      const final = control[2]
      if (final === "H" || final === "f") {
        screen.row = Math.max(0, (params[0] ?? 1) - 1)
        screen.col = Math.max(0, (params[1] ?? 1) - 1)
      } else if (final === "J" && (params[0] ?? 0) === 2) {
        const blank: Cell = { char: " ", fg: "default", bg: "default", underlineColour: "default", underline: false }
        for (const row of screen.grid) row.fill(blank)
        screen.ink = { fg: "default", bg: "default", underlineColour: "default", underline: false }
        screen.row = 0
        screen.col = 0
      } else if (final === "m") {
        screen.ink = applySgr(screen.ink, params, mode, palette)
      }
      rest = rest.slice(control[0].length)
      continue
    }
    const char = rest[0] ?? ""
    const row = screen.grid[screen.row]
    if (row && screen.col < COLS) {
      row[screen.col] = { ...screen.ink, char }
    }
    screen.col += 1
    if (screen.col >= COLS) {
      screen.col = 0
      screen.row = Math.min(ROWS - 1, screen.row + 1)
    }
    rest = rest.slice(1)
  }
}

function cellText(cell: Cell | undefined): string {
  if (!cell) return "outside"
  return `${cell.char}${cell.fg}${cell.bg}${cell.underlineColour}${cell.underline ? "u" : ""}`
}

function regionDigest(grid: Cell[][], region: CaptureCells): string {
  const cells: string[] = []
  for (let row = region.top; row <= region.bottom; row += 1) {
    for (let col = region.left; col <= region.right; col += 1) {
      cells.push(cellText(grid[row - 1]?.[col - 1]))
    }
  }
  return `${region.top},${region.left},${region.bottom},${region.right}|${cells.join("|")}`
}

function wholeDigest(grid: Cell[][]): string {
  const cells: string[] = []
  for (const row of grid) for (const cell of row) if (cell.char !== " ") cells.push(cellText(cell))
  return `frame|${cells.join("|")}`
}

interface ColourTerminal {
  ctx: TermContext
  writes: string[]
}

/**
 * A terminal that renders SGR colour into the screen so a capture can read it back: `render`
 * honours every colour, `ignore` leaves the ink at its default, and `collapse` paints every colour
 * with one and the same value — the fixture a rule that only compares "the frames differ" passes.
 */
function colourTerminal(mode: Mode, palette: Palette): ColourTerminal {
  const screen = blankScreen()
  const writes: string[] = []
  let reads = 0
  const capture = async (request: CaptureRequest): Promise<ObservationFrame> => {
    reads += 1
    const digests = {
      region: request.cells ? regionDigest(screen.grid, request.cells) : undefined,
      whole: wholeDigest(screen.grid),
    }
    return {
      role: request.role,
      label: request.label,
      capturedAt: reads,
      ref: `sha256:${String(reads).repeat(64)}`,
      pixelsDigest: digests.whole,
      ...(digests.region === undefined ? {} : { regionDigest: digests.region, regionRectangle: RECTANGLE }),
    }
  }
  const ctx: TermContext = {
    rows: ROWS,
    cols: COLS,
    captureKind: "pixels",
    captureGeometry: { geometry: GEOMETRY, source: "measured by complete raster calibration" },
    capture,
    write(text) {
      writes.push(text)
      paint(screen, text, mode, palette)
    },
    queryCursorPosition: async () => ({ row: screen.row + 1, col: screen.col + 1 }),
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
  }
  return { ctx, writes }
}

async function run(id: string, ctx: TermContext) {
  const definition = sgrProbes.find((candidate) => candidate.id === id)
  if (!definition?.term) throw new Error(`${id}: no term arm in sgrProbes`)
  return definition.term(ctx)
}

for (const id of COLOUR_IDS) {
  for (const palette of PALETTES) {
    test(`${id} is decided from pixels on ${palette.name}`, async () => {
      const { ctx } = colourTerminal("render", palette)
      const result = await run(id, ctx)
      expect(result.observation?.note ?? "").not.toContain("visual interpretation requires review")
      expect(result.observation?.outcome).toBe("supported")
      expect(result.observation?.evidence).toBe("pixels")
      expect(result.pass).toBe(true)
      expect(result.observation?.frames?.length ?? 0).toBeGreaterThanOrEqual(2)
    })
  }
}

for (const id of COLOUR_IDS) {
  test(`${id} is never supported by a terminal that ignores colour`, async () => {
    const { ctx } = colourTerminal("ignore", PALETTES[0] as Palette)
    const result = await run(id, ctx)
    expect(result.observation?.outcome).not.toBe("supported")
    expect(result.pass).toBe(false)
  })
}

for (const id of COLOUR_IDS) {
  test(`${id} is never supported when two colours render the same`, async () => {
    const { ctx } = colourTerminal("collapse", PALETTES[0] as Palette)
    const result = await run(id, ctx)
    expect(result.observation?.outcome).not.toBe("supported")
    expect(result.pass).toBe(false)
  })
}

for (const id of REVIEW_IDS) {
  test(`${id} stays inconclusive by name, never graded from colour pixels`, async () => {
    const { ctx } = colourTerminal("render", PALETTES[0] as Palette)
    const result = await run(id, ctx)
    expect(result.observation?.outcome).toBe("inconclusive")
    expect(result.observation?.note ?? "").toMatch(/review|blink|reference/i)
    expect(result.pass).toBe(false)
  })
}

/** The fixture is the whole test's evidence: prove it separates two colours, and that each negative
 * mode collapses exactly what it claims to. */
test("the colour fixture renders red and blue apart, and collapses them when it should", async () => {
  const cells: CaptureCells = { top: 3, left: 3, bottom: 3, right: 3 }
  const read = async (mode: Mode, sequence: string): Promise<string> => {
    const { ctx } = colourTerminal(mode, PALETTES[0] as Palette)
    ctx.write("\x1b[0m\x1b[2J\x1b[3;3H")
    ctx.write(sequence)
    const frame = await ctx.capture?.({ role: "target", label: mode, cells, pixelGeometry: GEOMETRY })
    return frame?.regionDigest ?? "missing"
  }
  const red = await read("render", "\x1b[31mX")
  const blue = await read("render", "\x1b[34mX")
  const neutral = await read("render", "X")
  expect(red).not.toBe(blue)
  expect(red).not.toBe(neutral)
  expect(blue).not.toBe(neutral)
  expect(await read("ignore", "\x1b[31mX")).toBe(await read("ignore", "\x1b[34mX"))
  expect(await read("collapse", "\x1b[31mX")).toBe(await read("collapse", "\x1b[34mX"))
})
