/**
 * @failure A headless probe with no applicable observable reports a measurement, or drops its named coverage.
 * @level l1
 * @consumer Headless collector coverage records for the 165-row not-tested slice.
 * @reach Runs each scheduled headless callback against a minimal context.
 * @testonly none
 */
import { expect, test } from "vitest"
import { ALL_PROBES } from "./index.ts"
import type { TermlessContext } from "./types.ts"

// The 15 scheduled headless features whose raw state is measurable but whose claim is not.
const notTestedFeatures = [
  "extensions.osc0-icon-title",
  "extensions.osc1-icon",
  "extensions.osc117-reset-highlight-bg",
  "extensions.osc119-reset-highlight-fg",
  "modes.application-cursor",
  "modes.application-keypad",
  "modes.bracketed-paste",
  "modes.focus-tracking",
  "modes.mouse-all",
  "modes.mouse-sgr",
  "modes.mouse-tracking",
  "modes.reverse-video",
  "modes.synchronized-output",
  "modes.utf8-mouse-1005",
  "sgr.overline",
]

const context = (): TermlessContext =>
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
  }) as unknown as TermlessContext

test("the 15 headless not-tested features emit named coverage from measured state", () => {
  expect(notTestedFeatures).toHaveLength(15)
  for (const id of notTestedFeatures) {
    const definition = ALL_PROBES.find((probe) => probe.id === id)
    if (!definition?.termless) throw new Error(`missing headless ${id}`)
    const result = definition.termless(context())
    expect(result.notTested, id).toEqual({ reason: "no-semantic-observable", noObservable: expect.any(String) })
    expect((result.notTested?.noObservable ?? "").trim().length, id).toBeGreaterThan(0)
    expect((result.response ?? "").length, id).toBeGreaterThan(0)
    expect(result.observation, id).toBeUndefined()
    expect(result.assertions, id).toBeUndefined()
  }
})
