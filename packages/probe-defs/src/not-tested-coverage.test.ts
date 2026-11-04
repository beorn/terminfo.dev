/**
 * @failure A headless probe with no applicable observable reports a measurement, or drops its named coverage.
 * @level l1
 * @consumer Headless collector coverage records for the 165-row not-tested slice.
 * @reach Runs each scheduled headless callback against a minimal context.
 * @testonly none
 */
import { expect, test } from "vitest"
import { NO_SAME_PATH_CONTROL } from "./helpers.ts"
import { ALL_PROBES, SEMANTIC_PROMPT_SOURCE_REVIEW } from "./index.ts"
import type { LibProbeSource } from "./types.ts"

// Remaining headless features whose raw state is measurable but whose claim is not.
// DECRPM mode-state criteria grade the engine's own reply in modes-observations.test.ts.
const notTestedFeatures = ["extensions.osc1-icon", "sgr.overline"]

const context = (): LibProbeSource =>
  ({
    cols: 80,
    rows: 24,
    capabilities: { extensions: new Set<string>() },
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
    "extensions.osc7-cwd",
    "Declared OSC 7 capability does not establish working-directory metadata delivery",
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
      getMode: (mode: string) => (mode === "applicationCursor" ? null : false),
      getCell: (_row: number, col: number) => ({ char: "ALINKZ"[col] }),
    } as unknown as LibProbeSource
    const result = definition.lib(source)
    expect(result.notTested).toEqual({ reason: "no-semantic-observable", noObservable })
    expect(JSON.parse(result.response!)).toEqual(state)
    expect(result.criterionBranch).toBe("headless-observable-review")
    expect(result.tests).toEqual([
      {
        id: "review",
        status: "test-todo",
        reason: `Headless observable review required: ${noObservable}`,
      },
    ])
    expect(result.observation).toBeUndefined()
    expect(result.assertions).toBeUndefined()
  },
)

// S8 requires a missing DECRPM reply to retain its named review and both measured phases.
// The presentation table cannot exercise this protocol arm; positive mode tests supply valid replies.
test("modes.decsclm retains missing DECRPM coverage and measured state for required review", () => {
  const definition = ALL_PROBES.find((probe) => probe.id === "modes.decsclm")
  if (!definition?.lib) throw new Error("missing headless modes.decsclm")
  const result = definition.lib(context())
  expect(result.notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable: "DECRPM reply to CSI ? 4 $ p",
  })
  expect(JSON.parse(result.response!)).toEqual({
    setReply: "$y",
    resetReply: "$y",
    setMode: false,
    resetMode: false,
    insertBefore: false,
    insertAfter: false,
  })
  expect(result.criterionBranch).toBe("os-input-review")
  expect(result.tests).toEqual([
    {
      id: "review",
      status: "test-todo",
      reason: "The adapter delivered no DECRPM reply from the engine, so this run cannot decide it",
    },
  ])
  expect(result.observation).toBeUndefined()
  expect(result.assertions).toBeUndefined()
})

// S8 retains an unchanged non-null DECKPAM pair as criterion TODO, never missing coverage or a grade.
// The generic no-observable table cannot express it; mode tests do not exercise this minimal source.
test("modes.application-keypad retains its unchanged measured state as a named criterion TODO", () => {
  const definition = ALL_PROBES.find((probe) => probe.id === "modes.application-keypad")
  if (!definition?.lib) throw new Error("missing headless modes.application-keypad")
  const result = definition.lib(context())
  expect(result.notTested).toBeUndefined()
  expect(JSON.parse(result.response!)).toEqual({ setMode: false, resetMode: false })
  expect(result.pass).toBe(false)
  expect(result.tests).toEqual([
    { id: "criterion", status: "test-todo", reason: "DECKPAM state pair: set false, reset false" },
  ])
  expect(result.observation).toEqual({
    outcome: "inconclusive",
    assertionType: "buffer_state",
    reason: "insufficient-evidence",
    note: "DECKPAM state pair: set false, reset false; keypad key encoding unmeasured; mode state measured",
  })
  expect(result.note).toBe(result.observation?.note)
  expect(result.assertions).toBeUndefined()
})

const headlessStateFeatures = [
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
  // Seedless SGR59/default-color cases are named TODOs, covered by sgr-contract.test.ts.
  [
    "sgr.selective-reset.italic",
    ["C", "X", "Y"],
    "sgr.selective-reset.italic: measured setup attributes clear on Y and unrelated attributes remain set",
    "compound reset not decided: italic and bold not shown at setup; every claimed facet must be seeded and read",
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
    "extensions.truecolor",
    ["C", "A", "B", "X", "Y"],
    "Two distinct direct-RGB foreground samples match their requested values",
    "independent foreground color controls (SGR 31 and 34) distinguishable in the headless readback",
  ],
  [
    "erase.el-with-attrs",
    ["X", "X", "X", "X", "X"],
    null, // Unpainted setup cannot establish an erase claim.
    "PreconditionFailed: precondition failed: seed cells not painted (expected bg at",
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

test.each(headlessStateFeatures)(
  "%s distinguishes failed setup from unexposed headless colour/reset/buffer state",
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
    if (expected === null) {
      expect(result.notTested).toBeUndefined()
      expect(result.criterionBranch).toBeUndefined()
      expect(result.tests).toEqual([
        { id: "criterion", status: "test-failure", reason: expect.stringContaining(reason) },
      ])
      expect(result.observation).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      return
    }
    // #32246: a painted setup whose target state is unexposed has no same-path control in this run, so the cell
    // is the TEST TODO coverage record; no source review decides it and no negative assertion is emitted.
    const noObservable =
      id === "sgr.selective-reset.italic"
        ? "compound reset not decided: italic and bold not shown at setup; a reset needs at least one shown set facet and every preserved facet shown"
        : NO_SAME_PATH_CONTROL
    expect(result.notTested).toEqual({ reason: "no-semantic-observable", noObservable })
    expect(result.criterionBranch).toBeUndefined()
    expect(result.tests).toBeUndefined()
    expect(result.observation).toBeUndefined()
    expect(result.assertions).toBeUndefined()
    expect((result.response ?? "").length).toBeGreaterThan(0)
  },
)

test("the 2 remaining headless not-tested features emit named coverage from measured state", () => {
  expect(notTestedFeatures).toHaveLength(2)
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
  ["extensions.osc633-e", "\x1b]633;E;ls -la;nonce123\x07", "OSC 633;E commandline-with-nonce mark registration"],
] as const

test("the 9 headless C154 semantic-mark features emit named coverage only after recorded home/marker/control writes and qualified cursor reads", () => {
  // osc633-d and osc633-p read their own reader routes (#32247), covered in extensions-contract.test.ts.
  expect(c154SemanticMarkFeatures).toHaveLength(9)
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
        reason: expect.stringMatching(/OSC 133 \/ 633 mark was consumed but this reader exposes no mark or zone state/),
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
