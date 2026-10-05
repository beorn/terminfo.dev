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

// The 15 scheduled headless features whose raw state is measurable but whose claim is not,
// plus the 11 OSC 133/633 semantic-mark features (C154, 26 total).
const notTestedFeatures = [
  "extensions.osc0-icon-title",
  "extensions.osc1-icon",
  "extensions.osc133-a",
  "extensions.osc133-b",
  "extensions.osc133-c",
  "extensions.osc133-d",
  "extensions.osc133-p",
  "extensions.osc633-a",
  "extensions.osc633-b",
  "extensions.osc633-c",
  "extensions.osc633-d",
  "extensions.osc633-e",
  "extensions.osc633-p",
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

const context = (): TermlessContext => {
  // Model the measured home / mark / control sequence against the real headless read shape:
  // CUP sets the position and a printable character written after the marker advances it.
  let cursor = { x: 0, y: 0, visible: true, style: null }
  return {
    cols: 80,
    rows: 24,
    capabilities: {},
    feed: (text: string) => {
      for (const match of text.matchAll(/\x1b\[(\d+);(\d+)H/g)) {
        cursor = { ...cursor, x: Number(match[2]) - 1, y: Number(match[1]) - 1 }
      }
      const printable = text.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
      if (printable.length > 0) cursor = { ...cursor, x: cursor.x + printable.length }
    },
    feedCapture: () => "$y",
    getMode: () => false,
    getText: () => "",
    getTitle: () => "original",
    getCell: () => ({ char: "X" }),
    getCursor: () => cursor,
    reset: () => {},
  } as unknown as TermlessContext
}

test("the 26 headless not-tested features emit named coverage from measured state", () => {
  expect(notTestedFeatures).toHaveLength(26)
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
