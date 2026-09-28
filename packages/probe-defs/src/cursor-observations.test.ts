/**
 * @failure A plausible cursor reply or a near-bottom row is credited as the named cursor behavior without a matching position observation.
 * @level l1
 * @consumer Headless and app cursor results projected into terminal support cells
 * @testonly none
 */
import { expect, test } from "vitest"
import { cursorProbes } from "./cursor.ts"
import type { TermContext, TermlessContext } from "./types.ts"

function byId(id: string) {
  const probe = cursorProbes.find((value) => value.id === id)
  if (!probe?.termless || !probe.term) throw new Error(`missing cursor callbacks for ${id}`)
  return probe
}

function app(position: { row: number; col: number } | null): TermContext {
  return {
    write() {},
    queryCursorPosition: async () => position,
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
    cols: 80,
  }
}

function headless(x: number, y: number, rows = 24, reply = ""): TermlessContext {
  return {
    cols: 80,
    feed() {},
    feedCapture: () => reply,
    getCell: () => ({
      char: "",
      bold: false,
      dim: false,
      italic: false,
      underline: false,
      underlineColor: null,
      strikethrough: false,
      inverse: false,
      hidden: false,
      blink: false,
      fg: null,
      bg: null,
      wide: false,
    }),
    getCursor: () => ({ x, y, visible: true, style: null }),
    getMode: () => false,
    getText: () => "",
    getScrollback: () => ({ viewportOffset: 0, totalLines: rows, screenLines: rows }),
    getTitle: () => "",
    reset() {},
    capabilities: {
      truecolor: false,
      kittyKeyboard: false,
      kittyGraphics: false,
      sixel: false,
      osc8Hyperlinks: false,
      semanticPrompts: false,
      reflow: false,
      unicode: "unknown",
      extensions: new Set(),
    },
  }
}

test("cursor save/restore records the mismatched position and a missing app reply stays inconclusive", async () => {
  const probe = byId("cursor.ansi-save")
  const headlessResult = probe.termless!(headless(4, 2))
  expect(headlessResult.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(headlessResult.assertions).toMatchObject([{ kind: "positive", observed: headlessResult.response }])

  const wrong = await probe.term!(app({ row: 2, col: 4 }))
  expect(wrong.observation).toMatchObject({ outcome: "unsupported", evidence: "query" })
  expect(wrong.assertions).toMatchObject([{ kind: "negative", observed: wrong.response }])
  expect((await probe.term!(app(null))).observation).toMatchObject({ outcome: "inconclusive", reason: "no-response" })
})

test("bottom-row cursor result uses measured headless height and does not guess an app height", async () => {
  const probe = byId("cursor.cud-past-bottom")
  const supported = probe.termless!(headless(0, 29, 30))
  expect(supported.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  const wrong = probe.termless!(headless(0, 23, 30))
  expect(wrong.observation).toMatchObject({ outcome: "unsupported", evidence: "parser-state" })
  expect(wrong.assertions).toMatchObject([{ kind: "negative", observed: wrong.response }])
  expect((await probe.term!(app({ row: 20, col: 1 }))).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
  })
})

test("DSR position report distinguishes a valid wrong coordinate from malformed input", () => {
  const probe = byId("cursor.position-report")
  const misleading = probe.termless!(headless(0, 0, 24, "noise3;5R"))
  expect(misleading.observation).toMatchObject({ outcome: "inconclusive", reason: "invalid-reply", evidence: "query" })
  expect(misleading.assertions).toBeUndefined()
  const wrong = probe.termless!(headless(0, 0, 24, "\x1b[3;6R"))
  expect(wrong.observation).toMatchObject({ outcome: "unsupported", evidence: "query" })
  expect(wrong.assertions).toMatchObject([{ kind: "negative", observed: wrong.response }])
  expect(probe.termless!(headless(0, 0, 24, "\x1b[3;5R")).observation).toMatchObject({
    outcome: "supported",
    evidence: "query",
  })
  expect(probe.termless!(headless(0, 0)).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "no-response",
  })
})

test("DECOM reports relative CPR but only absolute headless state proves the physical row", async () => {
  const probe = byId("cursor.cup-scroll-region")
  expect(probe.termless!(headless(0, 4)).observation).toMatchObject({
    outcome: "supported",
    evidence: "parser-state",
  })
  expect(probe.termless!(headless(0, 0)).observation).toMatchObject({
    outcome: "unsupported",
    evidence: "parser-state",
  })

  // DEC VT510 DECOM and CPR: https://vt100.net/mirror/mds-199909/cd3/term/vt510rmb.pdf
  // CPR row 1 is relative to the top margin. Ignoring DECOM can also produce 1;1.
  const writes: string[] = []
  const context = app({ row: 1, col: 1 })
  context.write = (data) => writes.push(data)
  expect((await probe.term!(context)).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "query",
  })
  expect(writes.slice(-2)).toEqual(["\x1b[?6l", "\x1b[r"])
  expect((await probe.term!(app({ row: 5, col: 1 }))).observation).toMatchObject({
    outcome: "unsupported",
    evidence: "query",
  })

  const failing = app(null)
  const cleanup: string[] = []
  failing.write = (data) => cleanup.push(data)
  failing.queryCursorPosition = async () => {
    throw new Error("query failed")
  }
  await expect(probe.term!(failing)).rejects.toThrow("query failed")
  expect(cleanup.slice(-2)).toEqual(["\x1b[?6l", "\x1b[r"])
})
