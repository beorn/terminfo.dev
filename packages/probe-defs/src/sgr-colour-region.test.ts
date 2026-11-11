/**
 * @failure The 11 sgr.* colour rows on an owned-capture run all return the generic
 *   "Control and target pixels captured; no same-run pixel check decides the visual effect" and stay
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
import { expect, test, vi } from "vitest"
import { sgrProbes } from "./sgr.ts"
import { COLOUR_CAPTURE, colourCaptureCallbackResult } from "./sgr-colour-capture.ts"
import { captureRegionCallbackResult } from "./region-readback.ts"
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

/** Colour-only captures cannot qualify a blink period or an independent reset-rendition crop. */
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
  | "ignore-58"
  | "frozen"

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
  blink: boolean
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
      next.blink = false
      index += 1
      continue
    }
    if (param === 5) {
      next.blink = true
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
    if (param === 58 && mode === "ignore-58") {
      // This terminal does not know SGR 58, so it does not consume the sub-parameters: the walker
      // continues into them, reaches the literal 0 of `58;2;255;0;128`, and resets the rendition —
      // which drops the row's `\x1b[4m` seed and leaves plain text. Screen 5.0.2 behaves this way.
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
  return { char: " ", fg: "default", bg: "default", underlineColour: "default", underline: false, blink: false }
}

function blankScreen(): Screen {
  return {
    grid: Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => blankCell())),
    row: 0,
    col: 0,
    ink: { fg: "default", bg: "default", underlineColour: "default", underline: false, blink: false },
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
        screen.ink = { fg: "default", bg: "default", underlineColour: "default", underline: false, blink: false }
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
  return `${cell.char}${cell.fg}${cell.bg}${cell.underlineColour}${cell.underline ? "u" : ""}${cell.blink ? "k" : ""}`
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
  // A capture that never repaints: the arm's own paint witness must refuse it. Freezing after the
  // first read is what makes a "stale expected frame" reachable in a fixture, so the test can prove
  // a frame nothing painted is never read as a measured negative.
  let frozenGrid: Cell[][] | undefined
  const capture = async (request: CaptureRequest): Promise<ObservationFrame> => {
    reads += 1
    if (mode === "frozen" && frozenGrid === undefined) {
      frozenGrid = screen.grid.map((row) => row.map((cell) => ({ ...cell })))
    }
    const visible = frozenGrid ?? screen.grid
    const digests = {
      region: request.cells ? regionDigest(visible, request.cells) : undefined,
      whole: wholeDigest(visible),
    }
    return {
      role: request.role,
      label: request.label,
      capturedAt: reads,
      ref: `sha256:${String(reads).repeat(64)}`,
      pixelsDigest: digests.whole,
      ...(digests.region === undefined ? {} : { regionDigest: digests.region, regionRectangle: RECTANGLE }),
      // The modelled arm holds the whole screen, so a same-shot control region is a second crop
      // of this same grid state (#33117).
      ...(request.controlCells
        ? { controlRegionDigest: regionDigest(visible, request.controlCells), controlRegionRectangle: RECTANGLE }
        : {}),
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
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
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

// A protocol reply cannot replace these same-run neutral/sibling pixel controls. Existing cases
// only exercised silent DECRQSS, so they missed the early return that bypassed the colour oracle.
test.each(["0", "0;38;2;255;128;0", "0;38;2;255;128;1"])(
  "DECRQSS %s does not bypass the truecolour pixel oracle",
  async (reply) => {
    for (const mode of ["render", "ignore"] as const) {
      const { ctx } = colourTerminal(mode, PALETTES[0] as Palette)
      const previous = ctx.queryWithSentinelOutcome
      ctx.queryWithSentinelOutcome = async (sequence, pattern) => {
        if (sequence !== "\x1bP$qm\x1b\\") return previous(sequence, pattern)
        const raw = `\x1bP1$r${reply}m\x1b\\`
        return { match: [raw, reply], reason: "reply", raw, rawBase64: Buffer.from(raw).toString("base64") }
      }
      const result = await run("sgr.fg.truecolor", ctx)
      expect(result.observation?.assertionType, mode).toBe("screenshot")
      expect(result.observation?.outcome, mode).toBe(mode === "render" ? "supported" : "inconclusive")
      expect(result.observation?.frames?.length ?? 0, mode).toBeGreaterThanOrEqual(2)
      expect(result.observation?.note, mode).toContain("DECRQSS")
      expect(result.observation?.note, mode).toContain(reply)
    }
  },
)

for (const id of COLOUR_IDS) {
  for (const palette of PALETTES) {
    test(`${id} is decided from pixels on ${palette.name}`, async () => {
      const { ctx } = colourTerminal("render", palette)
      const result = await run(id, ctx)
      const note = result.observation?.note ?? ""
      expect(note).not.toContain("no same-run pixel check decides the visual effect")
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
    const oracle = await captureRegionCallbackResult(
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
    expect(result.observation?.note ?? "").toContain("these frames alone do not decide unsupported")
    expect(result.observation?.note ?? "").toContain("ignores the colour")
    expect(result.assertions).toBeUndefined()
    expect(result.pass).toBe(false)
    expect(result.tests).toContainEqual(
      expect.objectContaining({
        id: "review",
        status: "probe-todo",
        reason: "colour oracle cannot distinguish ignored from identical paint against the current reference",
      }),
    )
  })
}

test("the rgb-underline rows refuse a terminal below 1x2 before any byte", async () => {
  // These two rows were on the generic SGR fixture before the colour capture row took them, and that
  // fixture refused a terminal it could not park the sample in with evidence "none" — never after
  // the DECRQSS readback had already written the sequence.
  for (const id of ["sgr.underline.color", "sgr.underline-color-rgb"] as const) {
    const captured = colourTerminal("render", PALETTES[0] as Palette, { rows: 1, cols: 1 })
    const onCapture = await run(id, captured.ctx)
    expect(onCapture.observation).toBeUndefined()
    expect(onCapture).toMatchObject({
      tests: [
        expect.objectContaining({ status: "probe-todo", reason: "SGR fixture needs at least 1x2, measured 1x1" }),
      ],
    })
    // The generic 1x2 floor is checked first on both arms, exactly as it was before these rows moved
    // onto the capture row; the 3x34 capture guard is the stricter floor behind it.
    expect(onCapture.tests?.[0]?.reason ?? "").toContain("SGR fixture needs at least 1x2, measured 1x1")
    expect(captured.writes).toEqual([])

    const plain = colourTerminal("render", PALETTES[0] as Palette, { rows: 1, cols: 1 })
    const onTerm = await run(id, { ...plain.ctx, capture: undefined, captureKind: undefined })
    expect(onTerm.observation).toBeUndefined()
    expect(onTerm).toMatchObject({
      tests: [
        expect.objectContaining({ status: "probe-todo", reason: "SGR fixture needs at least 1x2, measured 1x1" }),
      ],
    })
    expect(onTerm.tests?.[0]?.reason ?? "").toContain("SGR fixture needs at least 1x2, measured 1x1")
    expect(plain.writes).toEqual([])
  }
})

test("the colour verdict drops the oracle's negative assertion and keeps the frames it measured", () => {
  // The mapping is pinned directly as well, so a revert of the drop shows up without depending on
  // the fixture reaching the branch: the reader records every assertion it is handed.
  const frames: ObservationFrame[] = [
    { kind: "pixels", role: "control", label: "seed", capturedAt: 1, ref: "sha256:seed", pixelsDigest: "d" },
  ]
  const downgraded = colourCaptureCallbackResult("sgr.fg.standard", {
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
  expect(downgraded.observation?.note ?? "").toContain("these frames alone do not decide unsupported")
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
    ids: ["sgr.fg.256", "sgr.bg.256"],
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

/**
 * @failure A colour row that asks only that the expected frame differ from the seed accepts a
 *   terminal which painted NO colour at all. A terminal that does not implement SGR 58 but walks
 *   the SGR parameter list code by code reaches the literal 0 inside `58;2;255;0;128` and resets
 *   the rendition, so the row's `\x1b[4m` seed underline is dropped and the styled sample renders
 *   as plain text. That plain frame still differs from the underlined seed, so the arm published
 *   SUPPORTED for an underline colour the terminal never painted. Screen 5.0.2 did exactly this on
 *   the Linux app runs of 2026-11-10 and the published map carried the false positive; xterm 411
 *   shows the same digest signature (bytes not replayed). The 0 in the test colour is what exposes
 *   such a walker: a colour with no 0 component would let the walker stop at 2 (dim) and still
 *   differ from both references, which is why 255;0;128 stays in the fixture.
 * @level l1
 * @consumer The capture arm of sgr.underline.color on owned app contexts.
 * @testonly none
 */
/**
 * @failure The witness negative: the seed frame shows the underline painting, the terminal runs the
 *   sequence, and the expected frame equals plain text. That is a measured negative with a positive
 *   witness in the same run, so the row must grade unsupported rather than stay undecided forever.
 *   The reason must name what was compared — the sequence, and that the underline was visible in the
 *   seed (@cto 4ed6bddf condition 2).
 * @level l1
 * @consumer The capture arm of the three underline-colour rows on owned app contexts.
 * @testonly none
 */
test("sgr.underline.color is unsupported when the seed shows the underline and plain text is what the sequence paints", async () => {
  const { ctx } = colourTerminal("ignore-58", PALETTES[0] as Palette)
  const result = await run("sgr.underline.color", ctx)
  expect(result.observation?.outcome).toBe("unsupported")
  expect(result.observation?.note ?? "").toContain("painted nothing for SGR 58;2;255;0;128")
  expect(result.observation?.note ?? "").toContain("the underline was visible in the seed frame of this run")
  expect(result.pass).toBe(false)
  // #33054: the witness is the structured union member, not prose spread over expected/observed/note.
  const assertion = result.assertions?.[0]
  const witness = assertion?.witness
  if (witness?.kind !== "colour-no-attribute-witness") throw new Error("the negative carries no no-attribute witness")
  expect(witness.rowId).toBe("sgr.underline.color")
  expect(witness.encoding).toBe("58;2;255;0;128")
  expect(witness.frames.expected).toBe(witness.frames.noAttribute)
  expect(witness.frames.seed).not.toBe(witness.frames.noAttribute)
  expect(assertion?.observed).toBe(witness.frames.expected)
  const compared = (result.observation?.frames ?? []).filter((frame) => frame.regionDigest === witness.frames.seed)
  expect(compared.length).toBeGreaterThan(0)
  for (const frame of compared) expect(frame.regionRectangle).toEqual(witness.rectangle)
})

/**
 * @failure Freshness (@cto 4ed6bddf condition 1): a frame nothing painted must never be read as a
 *   measured negative. Tonight's Warp finding was a reader that trusted a stale frame; here the
 *   capture never repaints, so the arm's paint witness must refuse before any digest comparison, and
 *   the row must read inconclusive even though its frames would otherwise look like the witness
 *   negative.
 * @level l1
 * @consumer Every capture-region row, through the shared freshness gate.
 * @testonly none
 */
test("a stale capture reads inconclusive, never unsupported, on the underline-colour row", async () => {
  const { ctx } = colourTerminal("frozen", PALETTES[0] as Palette)
  const result = await run("sgr.underline.color", ctx)
  expect(result.observation?.outcome).toBe("inconclusive")
  expect(result.observation?.note ?? "").not.toContain("painted nothing for SGR")
  expect(result.pass).toBe(false)
}, 30000)

/**
 * @failure A terminal that paints a DIFFERENT attribute for the underline-colour sequence (here
 *   blink, the shape screen produces) must not read as support, and must not read as the witness
 *   negative either: the frames separate, but nothing in them says the colour was painted. It stays
 *   inconclusive, which is what it reads today.
 * @level l1
 * @consumer sgr.underline-color-indexed on owned app contexts.
 * @testonly none
 */
test("a terminal that paints blink for the underline-colour sequence stays inconclusive", async () => {
  const { ctx } = colourTerminal("ignore-58", PALETTES[0] as Palette)
  const result = await run("sgr.underline-color-indexed", ctx)
  expect(result.observation?.outcome).toBe("inconclusive")
  expect(result.pass).toBe(false)
})

/**
 * @failure A multiplexer is captured through its outer terminal, so the same frames cannot say which
 *   of the two dropped the sequence. The witness negative must not be published for a mux while this
 *   arm has no outer control (@cto 4ed6bddf): the row stays inconclusive and its note names the
 *   multiplexer and the missing control, and no cross-run lookup stands in for one.
 * @level l1
 *   The indexed/reset pair must reach the same owner, including reset's independent-reference
 *   capture; an inconclusive observation without explicit pending tests publishes probe-invalid.
 * @consumer The underline-colour family on owned multiplexer contexts.
 * @testonly none
 */
test.each([
  "sgr.underline.color",
  "sgr.underline-color-rgb",
  "sgr.underline-color-indexed",
  "sgr.underline-color-reset",
])("a multiplexer stays inconclusive on %s and says why", async (id) => {
  for (const mux of ["screen", "tmux"] as const) {
    const { ctx } = colourTerminal("ignore-58", PALETTES[0] as Palette)
    const result = await run(id, { ...ctx, mux })
    expect(result.tests?.[0]).toMatchObject({ id: "review", status: "probe-todo" })
    expect(result.observation?.outcome).toBe("inconclusive")
    expect(result.observation?.note ?? "").toContain("cannot separate it from its outer terminal")
    expect(result.pass).toBe(false)
    expect(result.tests?.some((test) => test.status === "unsupported")).toBe(false)
  }
})

/**
 * @failure Routing reset captures through the colour owner must preserve non-mux negatives and
 *   broken mux captures, rather than converting either to a pending colour comparison.
 * @level l1
 * @consumer The reset capture callback's shared colour result boundary.
 * @testonly none
 */
test("the colour owner preserves non-mux reset negatives and broken mux captures", () => {
  for (const mux of [undefined, "screen"] as const) {
    const broken = mux !== undefined
    const result = colourCaptureCallbackResult(
      "sgr.underline-color-reset",
      {
        pass: false,
        observation: {
          outcome: broken ? "error" : "unsupported",
          assertionType: "screenshot",
          note: broken ? "capture failed" : "reset left the coloured underline unchanged",
        },
        tests: [{ id: "criterion", status: broken ? "probe-invalid" : "unsupported" }],
      },
      { mux },
    )
    expect(result.observation?.outcome).toBe(broken ? "error" : "unsupported")
    expect(result.tests?.[0]?.status).toBe(broken ? "probe-invalid" : "unsupported")
  }
})

for (const id of REVIEW_IDS) {
  test(`${id} is never graded from the colour-only fixture`, async () => {
    const { ctx } = colourTerminal("render", PALETTES[0] as Palette)
    if (id !== "sgr.blink") {
      // These rows now own an independent rendition reference. This colour fixture supplies
      // whole-window metadata, not the requested reset crop, so the collector must fail loudly.
      await expect(run(id, ctx)).rejects.toThrow(/requires actual pixel.*matching cell-sized crop metadata/)
      return
    }
    // sgr.blink samples on its requested temporal schedule; fake timers keep that wall out of
    // this test, and the fixture's own capturedAt counter stays the achieved series it grades.
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] })
    const pending = run(id, ctx)
    await vi.runAllTimersAsync()
    const result = await pending.finally(() => vi.useRealTimers())
    if (id === "sgr.blink") {
      // Steady colour pixels under a read counter never achieve the blink gate's span: open as
      // capture too slow to decide blink (#33117), inconclusive and never a colour grade.
      expect(result.observation).toMatchObject({
        outcome: "inconclusive",
        assertionType: "screenshot",
        reason: "insufficient-evidence",
        note: expect.stringContaining("capture too slow to decide blink"),
      })
      expect(result.observation?.frames?.length).toBeGreaterThanOrEqual(5)
      expect(result.assertions).toMatchObject([
        { kind: "positive", assertionType: "screenshot", observed: expect.any(String) },
      ])
    } else {
      expect(result.observation).toBeUndefined()
      expect(result.tests).toMatchObject([
        {
          id: "criterion",
          status: "probe-invalid",
          reason: expect.stringContaining("no independent reference exists for a multi-attribute reset"),
        },
      ])
    }
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
  // Index 164 shares index 5's 16-colour entry, so it cannot decide the indexed underline row.
  expect(nearest16Index(164)).toBe(nearest16Index(5))
  expect(nearest16Index(4)).toBe(4)
  expect(nearest16Index(4)).not.toBe(nearest16Index(5))
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
    // The indexed underline sibling is a different 16-colour entry, so a 16-colour terminal can separate it.
    const indexed = COLOUR_CAPTURE["sgr.underline-color-indexed"]
    if (indexed?.expected === undefined || indexed.ignored === undefined) {
      throw new Error("sgr.underline-color-indexed must name both frames")
    }
    expect(indexed.ignored).toContain("\x1b[58;5;4m")
    expect(await readFrame("quantize-256", indexed.expected, palette)).not.toBe(
      await readFrame("quantize-256", indexed.ignored, palette),
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
