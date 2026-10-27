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
