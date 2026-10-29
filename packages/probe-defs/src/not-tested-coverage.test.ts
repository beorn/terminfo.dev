/**
 * @failure A headless probe with no applicable observable reports a measurement, or drops its named coverage.
 * @level l1
 * @consumer Headless collector coverage records for the 165-row not-tested slice.
 * @reach Runs each scheduled headless callback against a minimal context.
 * @testonly none
 */
import { expect, test } from "vitest"
import { ALL_PROBES } from "./index.ts"
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
    expect(result.criterionBranch, id).toBe("semantic-prompt-source-review")
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
