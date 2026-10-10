/**
 * @failure XTEST probes publish unsupported, skip same-run delivery control, or omit interaction action.
 * @level l0
 * @consumer App collector OS-level key/click/wheel injection observations.
 * @testonly none
 */
import { expect, test } from "vitest"
import { inputProbes } from "./input.ts"
import type { ProbeResult, TermContext } from "./types.ts"

const xtestIds = ["input.xtest-key", "input.xtest-click", "input.xtest-wheel"] as const

function probe(id: (typeof xtestIds)[number]) {
  const definition = inputProbes.find((candidate) => candidate.id === id)
  if (!definition?.term || !definition.termless) throw new Error(`Missing XTEST callbacks for ${id}`)
  return definition
}

function term(overrides: Partial<TermContext> = {}): TermContext {
  return {
    write() {},
    queryCursorPosition: async () => {
      throw new Error("Unexpected queryCursorPosition in XTEST observation")
    },
    measureRenderedWidth: async () => {
      throw new Error("Unexpected measureRenderedWidth in XTEST observation")
    },
    query: async () => {
      throw new Error("Unexpected query in XTEST observation")
    },
    queryOutcome: async () => {
      throw new Error("Unexpected queryOutcome in XTEST observation")
    },
    queryWithSentinel: async () => {
      throw new Error("Unexpected queryWithSentinel in XTEST observation")
    },
    queryWithSentinelOutcome: async () => {
      throw new Error("Unexpected queryWithSentinelOutcome in XTEST observation")
    },
    queryMode: async () => {
      throw new Error("Unexpected queryMode in XTEST observation")
    },
    cols: 80,
    rows: 24,
    ...overrides,
  }
}

function inputAndRead(
  script: { keys?: Record<string, string>; clicks?: Record<number, string> },
  writes: string[] = [],
): { ctx: TermContext; keys: string[]; clicks: number[] } {
  const keys: string[] = []
  const clicks: number[] = []
  const pending: string[] = []
  let listening = false
  const ctx = term({
    write(text) {
      writes.push(text)
    },
    input: {
      async injectKey(key) {
        if (!listening) throw new Error("XTEST inject before stdin listen")
        keys.push(key)
        const reply = script.keys?.[key]
        if (reply !== undefined) pending.push(reply)
      },
      async injectClick(button) {
        if (!listening) throw new Error("XTEST inject before stdin listen")
        clicks.push(button)
        const reply = script.clicks?.[button]
        if (reply !== undefined) pending.push(reply)
      },
    },
    readInput: async (_pattern, _timeoutMs, inject) => {
      listening = true
      try {
        if (!inject) throw new Error("readInput requires the inject callback so stdin is already listening")
        await inject()
        const next = pending.shift()
        return next === undefined ? null : [next]
      } finally {
        listening = false
      }
    },
  })
  return { ctx, keys, clicks }
}

test.each(xtestIds)("%s is not tested without an OS XTEST adapter", async (id) => {
  const definition = probe(id)
  const writes: string[] = []
  const headless = definition.termless!({
    cols: 80,
    feed() {},
    feedCapture() {
      return ""
    },
    getCell: () => {
      throw new Error("Unexpected getCell")
    },
    getCursor: () => {
      throw new Error("Unexpected getCursor")
    },
    getMode: () => false,
    getText: () => "",
    getScrollback: () => ({ viewportOffset: 0, totalLines: 24, screenLines: 24 }),
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
  })
  expect(headless.notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable: expect.stringMatching(/XTEST|OS-level/i),
  })
  expect(headless.observation).toBeUndefined()

  const result = await definition.term!(term({ write: (text) => writes.push(text) }))
  expect(writes).toEqual([])
  expect(result.notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable: expect.stringMatching(/XTEST|OS-level/i),
  })
  expect(result.observation).toBeUndefined()
})

test("input.xtest-key aborts when plain a does not reach the app, and does not inject the modified key", async () => {
  const { ctx, keys } = inputAndRead({ keys: {} })
  await expect(probe("input.xtest-key").term!(ctx)).rejects.toThrow(/delivery control|plain a/i)
  expect(keys).toEqual(["a"])
})

test("input.xtest-key records interaction after plain-a control then ctrl+shift+a", async () => {
  const writes: string[] = []
  const { ctx, keys } = inputAndRead({ keys: { a: "a", "ctrl+shift+a": "\x1b[27;6;65~" } }, writes)
  const result = (await probe("input.xtest-key").term!(ctx)) as ProbeResult
  expect(keys).toEqual(["a", "ctrl+shift+a"])
  expect(writes.some((text) => text.includes("\x1b[>4;2m"))).toBe(true)
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "interaction" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "xtest-key:ctrl+shift+a" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ control: "a", report: "\x1b[27;6;65~" })
})

test("input.xtest-click records interaction under 1000+1006 after a same-run control click", async () => {
  const writes: string[] = []
  const { ctx, clicks } = inputAndRead({ clicks: { 1: "\x1b[<0;1;1M" } }, writes)
  const result = await probe("input.xtest-click").term!(ctx)
  expect(clicks).toEqual([1, 1])
  expect(writes.join("")).toContain("\x1b[?1000h")
  expect(writes.join("")).toContain("\x1b[?1006h")
  expect(writes.join("")).toContain("\x1b[?1000l")
  expect(writes.join("")).toContain("\x1b[?1006l")
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "interaction" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "xtest-click:1" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ mode: "1000+1006", control: "\x1b[<0;1;1M", report: "\x1b[<0;1;1M" })
})

test("input.xtest-wheel aborts when the 1000+1006 control click does not reach the app", async () => {
  const { ctx, clicks } = inputAndRead({ clicks: {} })
  await expect(probe("input.xtest-wheel").term!(ctx)).rejects.toThrow(/delivery control|1000\+1006/i)
  expect(clicks).toEqual([1])
})

test("input.xtest-wheel records interaction under 1000+1006 after a control click", async () => {
  const writes: string[] = []
  const { ctx, clicks } = inputAndRead({ clicks: { 1: "\x1b[<0;10;10M", 4: "\x1b[<64;10;10M" } }, writes)
  const result = await probe("input.xtest-wheel").term!(ctx)
  expect(clicks).toEqual([1, 4])
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "interaction" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "xtest-wheel:4" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ mode: "1000+1006", control: "\x1b[<0;10;10M", report: "\x1b[<64;10;10M" })
})
