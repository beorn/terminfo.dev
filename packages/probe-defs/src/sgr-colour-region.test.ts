/**
 * @failure The 11 sgr.* colour rows on an owned-capture run all return the generic
 *   "Control and target pixels captured; visual interpretation requires review" and stay
 *   inconclusive on every context, although each row's own catalogue probe already names a
 *   discriminator that needs no absolute palette: the styled sample must differ from the neutral
 *   sample AND from a named sibling that a terminal lacking exactly the claimed capability would
 *   paint identically. A capture arm that keeps the generic review note for a row it can decide,
 *   that grades "the frames differ" as support, that accepts a sibling it cannot separate (a
 *   terminal quantising truecolour to 256, 256 to 16, or bright to normal), or that decides colour
 *   unsupported, is the bug this test pins.
 *   The quantisation fixtures model a terminal, so the model itself is proved: every palette entry
 *   is distinct, and each sibling pair collapses identically on BOTH modelled palettes. A pair that
 *   collapses only because two different entries share one placeholder colour is an alias, not a
 *   measurement, and the fixture must not credit it.
 * @level l1
 * @consumer The capture arms of the 11 sgr.* colour rows on owned Linux app contexts.
 * @testonly none
 */
import { expect, test } from "vitest"
import { sgrProbes } from "./sgr.ts"
import { COLOUR_CAPTURE, colourCaptureVerdict } from "./sgr-colour-capture.ts"
import { captureRegionVerdict } from "./region-readback.ts"
import type {
  CaptureCells,
  CapturePixelGeometry,
  CaptureRequest,
  CaptureRectangle,
  ObservationFrame,
  TermProbeSource,
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
  // Every entry is distinct: the quantiser fixtures compare entries, so two names for one colour
  // would let a pair collapse for the wrong reason. The reds and the default foreground are the
  // colours the retained runs actually rendered; the rest are the fixture's own palette.
  const palette =
    theme === "wezterm"
      ? {
          standard: [
            "0,0,0",
            "204,85,85",
            "85,204,85",
            "204,204,85",
            "85,85,204",
            "204,85,204",
            "85,204,204",
            "178,178,178",
          ],
          bright: [
            "102,102,102",
            "255,85,85",
            "85,255,85",
            "255,255,85",
            "85,85,255",
            "255,85,255",
            "85,255,255",
            "255,255,255",
          ],
        }
      : {
          standard: [
            "0,0,0",
            "172,66,66",
            "66,172,66",
            "172,172,66",
            "66,66,172",
            "170,117,159",
            "66,172,172",
            "216,216,216",
          ],
          bright: [
            "127,127,127",
            "197,85,85",
            "85,197,85",
            "197,197,85",
            "85,85,197",
            "197,85,197",
            "85,197,197",
            "255,255,255",
          ],
        }
  return kind === "standard" ? palette.standard : palette.bright
}

function indexOf(theme: string, index: number): string {
  if (index === 67) return "95,135,175"
  if (index === 173) return "215,135,95"
  if (index === 4) return theme === "wezterm" ? "85,85,204" : "66,66,172"
  if (index === 5) return theme === "wezterm" ? "204,85,204" : "170,117,159"
  if (index === 164) return "215,0,215"
  return `index-${index}`
}

/**
 * How the fake terminal renders colour. The last three model the terminals a row's sibling must
 * exclude, so a rule that cannot separate them refuses instead of passing.
 */
type Mode =
  | "render"
  | "ignore"
  | "collapse"
  | "quantize-truecolor"
  | "quantize-256"
  | "collapse-bright"
  | "deferred-paint"

/** A colour SGR, as opposed to a reset, a CUP or the SGR 4 underline seed the colour rows qualify. */
const COLOUR_SGR = /\x1b\[(?:3[0-7]|4[0-7]|9[0-7]|10[0-7]|(?:38|48|58);[25];)/

interface ColourRequest {
  family: "standard" | "bright" | "index" | "rgb"
  index?: number
  rgb?: readonly [number, number, number]
}

interface Ink {
  fg: string
  bg: string
  underlineColour: string
  underline: boolean
}

interface Cell extends Ink {
  char: string
}

/** The xterm 16-colour palette the quantisation modes measure against. */
const XTERM16: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [205, 0, 0],
  [0, 205, 0],
  [205, 205, 0],
  [0, 0, 238],
  [205, 0, 205],
  [0, 205, 205],
  [229, 229, 229],
  [127, 127, 127],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [92, 92, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
]

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const

function nearestCubeLevel(value: number): number {
  return CUBE_LEVELS.reduce((best, level) => (Math.abs(level - value) < Math.abs(best - value) ? level : best), 0)
}

function distance(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
}

/** The entry a terminal that quantises truecolour to the xterm-256 palette would paint. */
function nearest256(rgb: readonly [number, number, number]): string {
  const cube: readonly [number, number, number] = [
    nearestCubeLevel(rgb[0]),
    nearestCubeLevel(rgb[1]),
    nearestCubeLevel(rgb[2]),
  ]
  const average = (rgb[0] + rgb[1] + rgb[2]) / 3
  const greyStep = Math.max(0, Math.min(23, Math.round((average - 8) / 10)))
  const greyValue = 8 + 10 * greyStep
  const grey: readonly [number, number, number] = [greyValue, greyValue, greyValue]
  const chosen = distance(rgb, cube) <= distance(rgb, grey) ? cube : grey
  return `${chosen[0]},${chosen[1]},${chosen[2]}`
}

/** The canonical xterm-256 RGB of an index: what a quantiser measures, never its theme skin. */
function canonical256(index: number): readonly [number, number, number] {
  if (index < 16) return XTERM16[index] ?? [0, 0, 0]
  if (index >= 232) {
    const level = 8 + 10 * (index - 232)
    return [level, level, level]
  }
  const n = index - 16
  const level = (position: number): number => CUBE_LEVELS[position] ?? 0
  return [level(Math.floor(n / 36)), level(Math.floor((n % 36) / 6)), level(n % 6)]
}

/** The 16-colour ENTRY a terminal that quantises 256 colours picks: entries 0-15 stay themselves. */
function nearest16Index(index: number): number {
  const requested = canonical256(index)
  let best = 0
  for (let candidate = 1; candidate < XTERM16.length; candidate += 1) {
    if (distance(requested, XTERM16[candidate] ?? [0, 0, 0]) < distance(requested, XTERM16[best] ?? [0, 0, 0])) {
      best = candidate
    }
  }
  return best
}

/** The 16-colour entry a terminal that quantises 256 colours would paint, as the palette's own RGB. */
function nearest16(palette: Palette, index: number): string {
  const best = nearest16Index(index)
  return best < 8 ? (palette.standard[best] ?? "outside") : (palette.bright[best - 8] ?? "outside")
}

function resolve(
  mode: Mode,
  palette: Palette,
  channel: "fg" | "bg" | "underline",
  request: ColourRequest,
  suppressColour: boolean,
): string {
  if (mode === "ignore" || suppressColour) return "default"
  if (mode === "collapse") return "one-colour"
  let rendered: string
  switch (request.family) {
    case "standard":
      rendered = palette.standard[request.index ?? 0] ?? "outside"
      break
    case "bright":
      rendered =
        mode === "collapse-bright"
          ? (palette.standard[request.index ?? 0] ?? "outside")
          : (palette.bright[request.index ?? 0] ?? "outside")
      break
    case "index":
      rendered = mode === "quantize-256" ? nearest16(palette, request.index ?? 0) : palette.indexed(request.index ?? 0)
      break
    case "rgb": {
      const rgb = request.rgb ?? [0, 0, 0]
      rendered = mode === "quantize-truecolor" ? nearest256(rgb) : `${rgb[0]},${rgb[1]},${rgb[2]}`
      break
    }
  }
  return `${channel}:${rendered}`
}

function applySgr(ink: Ink, params: readonly number[], mode: Mode, palette: Palette, suppressColour: boolean): Ink {
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
      next.fg = resolve(mode, palette, "fg", { family: "standard", index: param - 30 }, suppressColour)
      index += 1
      continue
    }
    if (param >= 40 && param <= 47) {
      next.bg = resolve(mode, palette, "bg", { family: "standard", index: param - 40 }, suppressColour)
      index += 1
      continue
    }
    if (param >= 90 && param <= 97) {
      next.fg = resolve(mode, palette, "fg", { family: "bright", index: param - 90 }, suppressColour)
      index += 1
      continue
    }
    if (param >= 100 && param <= 107) {
      next.bg = resolve(mode, palette, "bg", { family: "bright", index: param - 100 }, suppressColour)
      index += 1
      continue
    }
    if (param === 38 || param === 48 || param === 58) {
      const channel = param === 38 ? "fg" : param === 48 ? "bg" : "underline"
      const modeParam = params[index + 1]
      if (modeParam === 5) {
        const colour = resolve(
          mode,
          palette,
          channel,
          { family: "index", index: params[index + 2] ?? 0 },
          suppressColour,
        )
        if (channel === "fg") next.fg = colour
        else if (channel === "bg") next.bg = colour
        else next.underlineColour = colour
        index += 3
        continue
      }
      if (modeParam === 2) {
        const colour = resolve(
          mode,
          palette,
          channel,
          {
            family: "rgb",
            rgb: [params[index + 2] ?? 0, params[index + 3] ?? 0, params[index + 4] ?? 0],
          },
          suppressColour,
        )
        if (channel === "fg") next.fg = colour
        else if (channel === "bg") next.bg = colour
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

function blankCell(): Cell {
  return { char: " ", fg: "default", bg: "default", underlineColour: "default", underline: false }
}

function blankScreen(): Screen {
  return {
    grid: Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => blankCell())),
    row: 0,
    col: 0,
    ink: { fg: "default", bg: "default", underlineColour: "default", underline: false },
  }
}

const CONTROL = /^\x1b\[([0-9;:?]*)([@-~])/

/** Paint one write onto the fake screen. The probe only writes CUP, ED and SGR, so everything else
 * is ignored rather than guessed at. */
function paint(screen: Screen, write: string, mode: Mode, palette: Palette, suppressColour: boolean): void {
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
        for (const row of screen.grid) row.fill(blankCell())
        screen.ink = { fg: "default", bg: "default", underlineColour: "default", underline: false }
        screen.row = 0
        screen.col = 0
      } else if (final === "m") {
        screen.ink = applySgr(screen.ink, params, mode, palette, suppressColour)
      }
      rest = rest.slice(control[0].length)
      continue
    }
    const char = rest[0] ?? ""
    const row = screen.grid[screen.row]
    if (row && screen.col < COLS) {
      // The underline colour is visible only under an underline, so a fixture that dropped its
      // underline seed would paint nothing and could not pass.
      row[screen.col] = {
        ...screen.ink,
        underlineColour: screen.ink.underline ? screen.ink.underlineColour : "default",
        char,
      }
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
  ctx: TermProbeSource
  writes: string[]
}

/**
 * A terminal that renders SGR colour into the screen so a capture can read it back. `render`
 * honours every colour; `ignore` leaves the ink at its default; `collapse` paints every colour with
 * one value; the three quantisation modes model the terminals a row's sibling must exclude.
 */
function colourTerminal(mode: Mode, palette: Palette, geometry = { rows: ROWS, cols: COLS }): ColourTerminal {
  const screen = blankScreen()
  const writes: string[] = []
  let reads = 0
  let frame = 0
  let firstColourFrame: number | undefined
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
  const ctx: TermProbeSource = {
    kind: "live",
    rows: geometry.rows,
    cols: geometry.cols,
    captureKind: "pixels",
    captureGeometry: { geometry: GEOMETRY, source: "measured by complete raster calibration" },
    capture,
    write(text) {
      writes.push(text)
      if (text.includes("\x1b[2J")) frame += 1
      // A deferred-paint terminal renders the FIRST frame that paints a colour neutral and the
      // second one normally. That is the one model that reaches the oracle's "after equals seed"
      // branch without also making the seed equal the expected frame, which the oracle names
      // inconclusive before it ever compares the post-sequence frame.
      // The DECRQSS readback paints the sequence on an uncleared screen before the run begins; only
      // a colour painted into a cleared frame is one of the oracle's compared frames.
      const firstColourPaint = firstColourFrame === undefined && frame > 0 && COLOUR_SGR.test(text)
      if (firstColourPaint) firstColourFrame = frame
      paint(screen, text, mode, palette, mode === "deferred-paint" && firstColourPaint)
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

async function run(id: string, ctx: TermProbeSource) {
  const definition = sgrProbes.find((candidate) => candidate.id === id)
  if (!definition?.term) throw new Error(`${id}: no term arm in sgrProbes`)
  return definition.term(ctx)
}

for (const id of COLOUR_IDS) {
  for (const palette of PALETTES) {
    test(`${id} is decided from pixels on ${palette.name}`, async () => {
      const { ctx } = colourTerminal("render", palette)
      const result = await run(id, ctx)
      const note = result.observation?.note ?? ""
      expect(note).not.toContain("visual interpretation requires review")
      expect(result.observation?.outcome).toBe("supported")
      expect(result.observation?.assertionType).toBe("screenshot")
      expect(result.pass).toBe(true)
      expect(result.observation?.frames?.length ?? 0).toBeGreaterThanOrEqual(2)
      expect(note).toContain("neutral sample")
      expect(note).toContain("sibling")
      expect(note).toContain("not interpreted")
      expect(note.toLowerCase()).not.toContain("reference")
    })
  }
}

for (const id of COLOUR_IDS) {
  test(`${id} downgrades the oracle's measured negative to inconclusive, with no negative assertion`, async () => {
    // The oracle's "after equals seed" branch is a measured negative its own table publishes as
    // unsupported. A colour row cannot tell an ignored sequence from one painted identically to the
    // reference, so this path must not publish that as unsupported, and must not keep the negative
    // assertion that named it.
    const spec = COLOUR_CAPTURE[id]
    if (!spec) throw new Error(`${id}: no colour capture row`)
    const oracle = await captureRegionVerdict(
      colourTerminal("deferred-paint", PALETTES[0] as Palette).ctx,
      id,
      spec,
      true,
    )
    // The fixture must actually reach the negative branch, or the routing below proves nothing.
    expect(oracle?.observation?.outcome).toBe("unsupported")
    expect(oracle?.assertions?.[0]?.kind).toBe("negative")
    const result = await run(id, colourTerminal("deferred-paint", PALETTES[0] as Palette).ctx)
    expect(result.observation?.outcome).toBe("inconclusive")
    expect(result.observation?.note ?? "").toContain("does not decide unsupported")
    expect(result.observation?.note ?? "").toContain("ignores the colour")
    expect(result.assertions).toBeUndefined()
    expect(result.pass).toBe(false)
  })
}

test("the rgb-underline rows refuse a terminal below 1x2 before any byte", async () => {
  // These two rows were on the generic SGR fixture before the colour capture row took them, and that
  // fixture refused a terminal it could not park the sample in with evidence "none" — never after
  // the DECRQSS readback had already written the sequence.
  for (const id of ["sgr.underline.color", "sgr.underline-color-rgb"] as const) {
    const captured = colourTerminal("render", PALETTES[0] as Palette, { rows: 1, cols: 1 })
    const onCapture = await run(id, captured.ctx)
    expect(onCapture).toMatchObject({
      observation: undefined,
      tests: [expect.objectContaining({ status: "test-todo", reason: expect.any(String) })],
    })
    // The generic 1x2 floor is checked first on both arms, exactly as it was before these rows moved
    // onto the capture row; the 3x34 capture guard is the stricter floor behind it.
    expect(onCapture.observation?.note ?? "").toContain("SGR fixture needs at least 1x2, measured 1x1")
    expect(captured.writes).toEqual([])

    const plain = colourTerminal("render", PALETTES[0] as Palette, { rows: 1, cols: 1 })
    const onTerm = await run(id, { ...plain.ctx, capture: undefined, captureKind: undefined })
    expect(onTerm).toMatchObject({
      observation: undefined,
      tests: [expect.objectContaining({ status: "test-todo", reason: expect.any(String) })],
    })
    expect(onTerm.observation?.note ?? "").toContain("SGR fixture needs at least 1x2, measured 1x1")
    expect(plain.writes).toEqual([])
  }
})

test("the colour verdict drops the oracle's negative assertion and keeps the frames it measured", () => {
  // The mapping is pinned directly as well, so a revert of the drop shows up without depending on
  // the fixture reaching the branch: the reader records every assertion it is handed.
  const frames: ObservationFrame[] = [
    { kind: "pixels", role: "control", label: "seed", capturedAt: 1, ref: "sha256:seed", pixelsDigest: "d" },
  ]
  const downgraded = colourCaptureVerdict("sgr.fg.standard", {
    pass: false,
    response: "seed=1 after=1 expected=2",
    observation: {
      outcome: "unsupported",
      assertionType: "screenshot",
      screenshotRef: "sha256:abc",
      frames,
    },
    assertions: [
      {
        assertionType: "screenshot",
        kind: "negative",
        expected: "sgr.fg.standard: equals the expected frame",
        observed: "1",
      },
    ],
  })
  expect(downgraded.observation?.outcome).toBe("inconclusive")
  expect(downgraded.observation?.reason).toBe("insufficient-evidence")
  expect(downgraded.observation?.note ?? "").toContain("does not decide unsupported")
  expect(downgraded.observation?.screenshotRef).toBe("sha256:abc")
  expect(downgraded.observation?.frames).toBe(frames)
  expect(downgraded.response).toBe("seed=1 after=1 expected=2")
  expect(downgraded.assertions).toBeUndefined()
  expect(downgraded.pass).toBe(false)
})

for (const id of COLOUR_IDS) {
  test(`${id} is inconclusive by name on a terminal that ignores colour`, async () => {
    const { ctx } = colourTerminal("ignore", PALETTES[0] as Palette)
    const result = await run(id, ctx)
    expect(result.observation?.outcome).toBe("inconclusive")
    expect(result.observation?.note ?? "").not.toBe("")
    expect(result.pass).toBe(false)
  })
}

for (const id of COLOUR_IDS) {
  test(`${id} is inconclusive by name when two colours render the same`, async () => {
    const { ctx } = colourTerminal("collapse", PALETTES[0] as Palette)
    const result = await run(id, ctx)
    expect(result.observation?.outcome).toBe("inconclusive")
    expect(result.observation?.note ?? "").not.toBe("")
    expect(result.pass).toBe(false)
  })
}

const QUANTISATION: ReadonlyArray<{ ids: readonly string[]; mode: Mode; cause: string }> = [
  {
    ids: ["sgr.fg.truecolor", "sgr.bg.truecolor", "sgr.underline-color-rgb"],
    mode: "quantize-truecolor",
    cause: "quantises truecolour to the xterm-256 palette",
  },
  {
    ids: ["sgr.fg.256", "sgr.bg.256", "sgr.underline-color-indexed"],
    mode: "quantize-256",
    cause: "quantises 256 colours to the 16-colour palette",
  },
  {
    ids: ["sgr.fg.bright", "sgr.bg.bright"],
    mode: "collapse-bright",
    cause: "paints bright as its normal counterpart",
  },
]

for (const { ids, mode, cause } of QUANTISATION) {
  for (const id of ids) {
    for (const palette of PALETTES) {
      test(`${id} cannot be separated on ${palette.name} by a terminal that ${cause}`, async () => {
        const { ctx } = colourTerminal(mode, palette)
        const result = await run(id, ctx)
        expect(result.observation?.outcome).toBe("inconclusive")
        expect(result.observation?.note ?? "").toMatch(/cannot separate|read the same cells/i)
        expect(result.pass).toBe(false)
      })
    }
  }
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

/** The fixture is the whole test's assertionType: prove it separates the pairs it claims to, and that
 * each negative mode collapses exactly the pair its row's sibling is meant to exclude. */
test("the modelled 256-to-16 quantiser keeps entries 0-15 and sends others to their nearest entry", () => {
  // The fixture stands in for a real 16-colour terminal, so the quantiser is asserted on ENTRIES, not
  // on rendered pixels that a palette alias could make equal for the wrong reason.
  for (let index = 0; index < 16; index += 1) expect(nearest16Index(index)).toBe(index)
  expect(nearest16Index(67)).toBe(8)
  expect(nearest16Index(164)).toBe(nearest16Index(5))
})

test("the colour fixture separates colours, and collapses the sibling pairs it should", async () => {
  const cells: CaptureCells = { top: 3, left: 3, bottom: 3, right: 3 }
  const read = async (mode: Mode, sequence: string, palette: Palette): Promise<string> => {
    const { ctx } = colourTerminal(mode, palette)
    ctx.write("\x1b[0m\x1b[2J\x1b[3;3H")
    ctx.write(sequence)
    const frame = await ctx.capture?.({ role: "target", label: mode, cells, pixelGeometry: GEOMETRY })
    return frame?.regionDigest ?? "missing"
  }
  /** The row's own two frames, painted on the fixture, so the pair under test is the pair it ships. */
  const readFrame = async (mode: Mode, writes: string, palette: Palette): Promise<string> => {
    const { ctx } = colourTerminal(mode, palette)
    ctx.write(writes)
    const frame = await ctx.capture?.({ role: "target", label: mode, cells, pixelGeometry: GEOMETRY })
    return frame?.regionDigest ?? "missing"
  }
  for (const palette of PALETTES) {
    // No two entries may share a colour: a collapse caused by two names for one colour proves nothing.
    expect(new Set([...palette.standard, ...palette.bright]).size).toBe(16)
    const red = await read("render", "\x1b[31mX", palette)
    const blue = await read("render", "\x1b[34mX", palette)
    const neutral = await read("render", "X", palette)
    expect(red).not.toBe(blue)
    expect(red).not.toBe(neutral)
    expect(blue).not.toBe(neutral)
    expect(await read("render", "\x1b[91mX", palette)).not.toBe(red)
    expect(await read("render", "\x1b[90mX", palette)).not.toBe(await read("render", "\x1b[38;5;67mX", palette))
    expect(await read("render", "\x1b[38;2;255;135;0mX", palette)).not.toBe(
      await read("render", "\x1b[38;2;255;128;0mX", palette),
    )
    expect(await read("ignore", "\x1b[31mX", palette)).toBe(await read("ignore", "\x1b[34mX", palette))
    expect(await read("collapse", "\x1b[31mX", palette)).toBe(await read("collapse", "\x1b[34mX", palette))
    expect(await read("collapse-bright", "\x1b[91mX", palette)).toBe(
      await read("collapse-bright", "\x1b[31mX", palette),
    )
    // Each negative mode collapses exactly the pair the row ships as its sibling.
    for (const { ids, mode } of QUANTISATION) {
      for (const id of ids) {
        const spec = COLOUR_CAPTURE[id]
        if (spec?.expected === undefined || spec.ignored === undefined) {
          throw new Error(`${id}: the colour row must name both the expected and the ignored frame`)
        }
        expect(await readFrame(mode, spec.expected, palette)).toBe(await readFrame(mode, spec.ignored, palette))
      }
    }
    // An underline colour paints nothing without SGR 4 in the same frame: the seed is load-bearing.
    expect(await read("render", "\x1b[58;2;255;0;128mX", palette)).toBe(await read("render", "X", palette))
  }
})
