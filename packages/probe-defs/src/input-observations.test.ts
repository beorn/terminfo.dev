/**
 * @failure A declared key/mouse mode or responsive CPR was reported as generated input-event encoding.
 * @level l0
 * @consumer Headless and app input probe observations.
 * @testonly none
 */
import { expect, test } from "vitest"
import { inputProbes } from "./input.ts"
import type { TermContext, TermlessContext } from "./types.ts"

const eventInputIds = [
  "input.modify-other-keys",
  "input.modify-other-keys-3",
  "input.pixel-mouse",
  "input.urxvt-mouse",
  "input.x10-mouse",
  "input.button-event-mouse",
] as const

function headless(declared: boolean, fed: string[]): TermlessContext {
  const unexpected = (method: string): never => {
    throw new Error(`Unexpected ${method} in input observation`)
  }
  return {
    cols: 80,
    feed(sequence) {
      fed.push(sequence)
    },
    feedCapture: () => unexpected("feedCapture"),
    getCell: () => unexpected("getCell"),
    getCursor: () => unexpected("getCursor"),
    getMode: () => declared,
    getText: () => unexpected("getText"),
    getScrollback: () => unexpected("getScrollback"),
    getTitle: () => unexpected("getTitle"),
    reset: () => unexpected("reset"),
    capabilities: {
      truecolor: false,
      kittyKeyboard: false,
      kittyGraphics: false,
      sixel: false,
      osc8Hyperlinks: false,
      semanticPrompts: false,
      reflow: false,
      unicode: "unknown",
      extensions: new Set(declared ? ["modifyOtherKeys"] : []),
    },
  }
}

function app(events: string[]): TermContext {
  const unexpected = (method: string): never => {
    throw new Error(`Unexpected ${method} in input observation`)
  }
  return {
    rows: 24,
    cols: 80,
    write(sequence) {
      events.push(sequence)
    },
    queryCursorPosition: async () => unexpected("queryCursorPosition"),
    measureRenderedWidth: async () => unexpected("measureRenderedWidth"),
    query: async () => unexpected("query"),
    queryWithSentinel: async () => unexpected("queryWithSentinel"),
    queryOutcome: async () => unexpected("queryOutcome"),
    queryWithSentinelOutcome: async () => unexpected("queryWithSentinelOutcome"),
    queryMode: async () => unexpected("queryMode"),
  }
}

test.each(eventInputIds)("%s declines a support claim without generated events and encoded reports", async (id) => {
  const definition = inputProbes.find((candidate) => candidate.id === id)
  if (!definition?.term || !definition.termless) throw new Error(`Missing input callbacks for ${id}`)
  for (const declared of [false, true]) {
    const fed: string[] = []
    const headlessResult = definition.termless(headless(declared, fed))
    expect(fed).toEqual([])
    expect(headlessResult.pass).toBe(false)
    expect(headlessResult.observation).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "legacy",
    })
    expect(headlessResult.response).toContain(String(declared))
    expect(headlessResult.assertions ?? []).toEqual([])

    const writes: string[] = []
    const appResult = await definition.term(app(writes))
    expect(writes).toEqual([])
    expect(appResult.pass).toBe(false)
    expect(appResult.observation).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "none",
    })
    expect(appResult.note).toMatch(/event.*report/i)
    expect(appResult.assertions ?? []).toEqual([])
  }
})
