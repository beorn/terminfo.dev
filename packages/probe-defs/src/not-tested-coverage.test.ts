/**
 * @failure A headless probe with no applicable observable reports a measurement, or drops its named coverage.
 * @level l1
 * @consumer Headless collector coverage records for the 165-row not-tested slice.
 * @reach Runs each scheduled headless callback against a minimal context.
 * @testonly none
 */
import { expect, test } from "vitest"
import { ALL_PROBES, SEMANTIC_PROMPT_SOURCE_REVIEW } from "./index.ts"
import type { LibProbeSource } from "./types.ts"

// The 7 scheduled headless features whose raw state is measurable but whose claim is not. The seven DECRQM
// mode features left this list with #30543: their headless arm grades the engine's own DECRPM reply.
const notTestedFeatures = [
  "extensions.osc1-icon",
  "extensions.osc117-reset-highlight-bg",
  "extensions.osc119-reset-highlight-fg",
  "modes.application-keypad",
  "modes.reverse-video",
  "modes.synchronized-output",
  "sgr.overline",
]

const context = (): LibProbeSource =>
  ({
    cols: 80,
    rows: 24,
    capabilities: {},
    feed: () => {},
    feedCapture: () => "$y",
    getMode: () => false,
    getText: () => "",
    getTitle: () => "original",
    getCell: () => ({ char: "X" }),
    getCursor: () => ({ x: 0, y: 0, visible: true, style: null }),
    reset: () => {},
  }) as unknown as LibProbeSource

// These missing observables previously emitted coverage without the required review attachment.
// Declared capability flags do not establish rendering, delivery, timing or event behaviour.
const headlessObservableFeatures = [
  [
    "extensions.kitty-graphics.animation",
    "Declared Kitty graphics capability does not establish timed animation playback",
    { declared: true },
  ],
  [
    "extensions.kitty-graphics.unicode-placeholders",
    "Declared Kitty graphics capability does not establish Unicode placeholder rendering",
    { declared: true },
  ],
  ["extensions.sixel", "Declared Sixel capability does not establish rendered pixels", { declared: true }],
  [
    "extensions.semantic-prompts",
    "Declared semantic-prompt capability does not establish shell prompt integration",
    { declared: true },
  ],
  [
    "extensions.osc7-cwd",
    "Declared OSC 7 capability does not establish working-directory metadata delivery",
    { declared: true },
  ],
  [
    "extensions.osc-633-vscode",
    "Declared semantic-prompt capability does not establish VS Code OSC 633 shell integration",
    { declared: true },
  ],
  [
    "extensions.notifications",
    "Declared OSC 9 capability does not establish desktop notification delivery",
    { declared: true },
  ],
  [
    "extensions.iterm2-images",
    "Declared iTerm2 image capability does not establish rendered image pixels",
    { declared: true },
  ],
  ["modes.decsclm", "DECSCLM requires presentation timing capture", { presentation: false }],
  [
    "modes.color-scheme-reporting",
    "Mode 2031 requires a host palette actuator and persistent unsolicited-event listener",
    { paletteActuator: false, persistentListener: false },
  ],
  [
    "extensions.osc8",
    "Adapter (runtime identity unavailable) exposes no OSC 8 URI observer (getHyperlinkAt); link metadata unobservable",
    { chars: [..."ALINKZ"], links: Array.from({ length: 6 }, () => ({ reported: false })) },
  ],
  [
    "extensions.font-ligatures",
    "Font ligatures are renderer glyph shaping; the headless parser shapes no glyphs",
    { ligatureSample: "!= -> => <= ==" },
  ],
  [
    "modes.decsscls",
    "DECSSCLS controls presentation timing; the headless parser paints no frames",
    { presentation: false },
  ],
  ["modes.reverse-video", "rendered colors (pixels)", { mode: false }],
  ["modes.synchronized-output", "frame timing", { text: "" }],
  [
    "reset.soft",
    "the application-cursor mode (DECCKM) state in the headless getMode readback",
    { before: null, after: null },
  ],
] as const

test.each(headlessObservableFeatures)(
  "%s retains its missing observable and state for required review",
  (id, noObservable, state) => {
    const definition = ALL_PROBES.find((probe) => probe.id === id)
    if (!definition?.lib) throw new Error(`missing headless ${id}`)
    const source = {
      ...context(),
      capabilities: {
        kittyGraphics: true,
        sixel: true,
        semanticPrompts: true,
        extensions: new Set(["osc7", "osc9", "iterm2Images"]),
      },
      getMode: (mode: string) => (mode === "applicationCursor" ? (null as unknown as boolean) : false),
      getCell: (_row: number, col: number) => ({ char: "ALINKZ"[col] }),
    } as unknown as LibProbeSource
    const result = definition.lib(source)
    expect(result.notTested).toEqual({ reason: "no-semantic-observable", noObservable })
    expect(JSON.parse(result.response!)).toEqual(state)
    expect(result.criterionBranch).toBe("headless-observable-review")
    expect(result.tests).toEqual([
      { id: "review", status: "test-todo", reason: `Headless observable review required: ${noObservable}` },
    ])
    expect(result.observation).toBeUndefined()
    expect(result.assertions).toBeUndefined()
  },
)

const sourceNegativeBranchFeatures = [
  [
    "sgr.underline.color",
    ["A", "B", "X"],
    "sgr.underline.color: X has explicit rgb(255,0,128) underline distinct from the reset/default B cell",
    "the underline color field (cell.underlineColor): the headless readback reports none on a cell fed an explicit SGR 58 color",
  ],
  [
    "sgr.underline-color-indexed",
    ["A", "X", "B", "Y"],
    "SGR 58 index 5/4 underline colors match the opposite SGR 38 palette controls, not their same-foreground defaults",
    "the underline color field (cell.underlineColor): the headless readback reports none on a cell fed an explicit SGR 58 color",
  ],
  [
    "sgr.underline-color-reset",
    ["C", "X", "Y"],
    "X has explicit underline rgb(255,0,128); SGR 59 restores Y to the measured reset-state C color",
    "the underline color field (cell.underlineColor): the headless readback reports none on a cell fed an explicit SGR 58 color",
  ],
  [
    "sgr.selective-reset.italic",
    ["C", "X", "Y"],
    "sgr.selective-reset.italic: measured setup attributes clear on Y and unrelated attributes remain set",
    "italic and bold on the styled setup cell in the headless readback",
  ],
  [
    "sgr.fg.standard",
    ["C", "X", "Y"],
    "sgr.fg.standard: the two named colors select distinct exposed fg RGB values",
    "the fg color field in the headless readback (neutral, SGR 31 and SGR 34 cells all read no color)",
  ],
  [
    "sgr.fg.256",
    ["C", "A", "B", "X", "Y"],
    "sgr.fg.256: indices 67 and 173 match two independently observed canonical RGB cube references",
    "direct RGB fg readback matching the fed value (SGR 38;2 reference cells A and B)",
  ],
  [
    "sgr.fg.truecolor",
    ["C", "A", "B", "X", "Y"],
    "sgr.fg.truecolor: two distinct direct-RGB samples are exposed at their exact requested values",
    "independent fg color controls (SGR 31 and 34) distinguishable in the headless readback",
  ],
  [
    "sgr.fg.default",
    ["C", "X", "R"],
    "sgr.fg.default: reset R restores the measured C fg after a distinct colored X",
    "a colored fg setup cell (SGR 31) distinct from the default, and the reset cell's fg, in the headless readback",
  ],
  [
    "extensions.truecolor",
    ["C", "A", "B", "X", "Y"],
    "Two distinct direct-RGB foreground samples match their requested values",
    "independent foreground color controls (SGR 31 and 34) distinguishable in the headless readback",
  ],
  [
    "erase.el-with-attrs",
    ["X", "X", "X", "X", "X"],
    "EL carries the current background onto the erased cells",
    "erase.el-with-attrs: the seed's painted bg on the region cells in the headless readback (the seed characters arrived without it)",
  ],
  [
    "editing.decsace",
    [..."abcdefghijklmnop"],
    "DECSACE rectangle extent confines DECCARA to the 2x2 block; stream extent reaches the rest of the reading-order span",
    "DECCARA not honoured, extent unobservable",
  ],
  [
    "modes.left-right-margin",
    [..."ABCDEFGH"],
    "Left-right margin mode constrains horizontal operations: ICH at column 3 under DECSLRM 3;6 drops F at column 6 and leaves G and H in columns 7-8",
    "ICH shifting row 1 right from column 3 in the headless readback (control frame not calibrated)",
  ],
] as const

test.each(sourceNegativeBranchFeatures)(
  "%s routes unexposed headless colour/reset/buffer state to source-negative-review",
  (id, chars, expected, reason) => {
    const definition = ALL_PROBES.find((probe) => probe.id === id)
    if (!definition?.lib) throw new Error(`missing headless ${id}`)
    const result = definition.lib({
      ...context(),
      getScrollback: () => ({ screenLines: 24, totalLines: 24 }),
      getCell: (row: number, col: number) => ({
        char: (row === 0 ? chars[col] : row === 1 ? chars[8 + col] : undefined) ?? " ",
        fg: null,
        bg: null,
        bold: false,
        dim: null,
        italic: null,
        underline: false,
        underlineColor: null,
        inverse: false,
        strikethrough: false,
        blink: false,
        overline: false,
        hidden: false,
        wide: false,
      }),
    } as unknown as LibProbeSource)
    expect(result.pass).toBe(false)
    expect(result.notTested).toBeUndefined()
    expect(result.criterionBranch).toBe("source-negative-review")
    expect(result.tests).toEqual([{ id: "review", status: "test-failure", reason }])
    expect(result.observation).toEqual({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      assertionType: "buffer_state",
    })
    expect(result.assertions).toEqual([
      {
        assertionType: "buffer_state",
        kind: "negative",
        expected,
        observed: result.response!,
      },
    ])
  },
)

test("the 7 headless not-tested features emit named coverage from measured state", () => {
  expect(notTestedFeatures).toHaveLength(7)
  for (const id of notTestedFeatures) {
    const definition = ALL_PROBES.find((probe) => probe.id === id)
    if (!definition?.lib) throw new Error(`missing headless ${id}`)
    const result = definition.lib(context())
    expect(result.notTested, id).toEqual({ reason: "no-semantic-observable", noObservable: expect.any(String) })
    expect((result.notTested?.noObservable ?? "").trim().length, id).toBeGreaterThan(0)
    expect((result.response ?? "").length, id).toBeGreaterThan(0)
    expect(result.observation, id).toBeUndefined()
    expect(result.assertions, id).toBeUndefined()
  }
})

const c154SemanticMarkFeatures = [
  ["extensions.osc133-a", "\x1b]133;A\x07", "OSC 133;A prompt-start mark registration"],
  ["extensions.osc133-b", "\x1b]133;B\x07", "OSC 133;B command-start mark registration"],
  ["extensions.osc133-c", "\x1b]133;C\x07", "OSC 133;C command-executed mark registration"],
  ["extensions.osc133-d", "\x1b]133;D;0\x07", "OSC 133;D command-finished mark registration"],
  ["extensions.osc133-p", "\x1b]133;P;Cwd=/tmp\x07", "OSC 133;P properties mark registration"],
  ["extensions.osc633-a", "\x1b]633;A\x07", "OSC 633;A prompt-start mark registration"],
  ["extensions.osc633-b", "\x1b]633;B\x07", "OSC 633;B prompt-end mark registration"],
  ["extensions.osc633-c", "\x1b]633;C\x07", "OSC 633;C pre-execution mark registration"],
  ["extensions.osc633-d", "\x1b]633;D;0\x07", "OSC 633;D command-finished mark registration"],
  ["extensions.osc633-e", "\x1b]633;E;ls -la;nonce123\x07", "OSC 633;E commandline-with-nonce mark registration"],
  ["extensions.osc633-p", "\x1b]633;P;Cwd=/tmp\x07", "OSC 633;P properties mark registration"],
] as const

test("the 11 headless C154 semantic-mark features emit named coverage only after recorded home/marker/control writes and qualified cursor reads", () => {
  expect(c154SemanticMarkFeatures).toHaveLength(11)
  for (const [id, sequence, noObservable] of c154SemanticMarkFeatures) {
    const definition = ALL_PROBES.find((probe) => probe.id === id)
    if (!definition?.lib) throw new Error(`missing headless ${id}`)
    const fed: string[] = []
    const reads = [
      { x: 0, y: 0, visible: true, style: null },
      { x: 1, y: 0, visible: true, style: null },
      { x: 0, y: 0, visible: true, style: null },
    ]
    let read = 0
    const result = definition.lib({
      ...context(),
      feed: (text: string) => {
        fed.push(text)
      },
      getCursor: () => reads[read++] ?? reads[2]!,
    })
    expect(fed, id).toEqual(["\x1b[1;1H", `${sequence}X`, "\x1b[1;1H"])
    expect(read, id).toBe(3)
    expect(result.notTested, id).toEqual({ reason: "no-semantic-observable", noObservable })
    expect(result.criterionBranch, id).toBe(SEMANTIC_PROMPT_SOURCE_REVIEW)
    expect(result.tests, id).toEqual([
      {
        id: "review",
        status: "test-todo",
        reason: expect.stringMatching(/pinned engine source.*OSC 133.*633.*mark or zone state.*citation per cell/),
      },
    ])
    expect(JSON.parse(result.response ?? "{}"), id).toEqual({
      home: reads[0],
      target: reads[1],
      control: reads[2],
      cell: "X",
    })
    expect(result.observation, id).toBeUndefined()
    expect(result.assertions, id).toBeUndefined()
  }
})
