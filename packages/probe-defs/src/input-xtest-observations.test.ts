/**
 * @failure XTEST or catalog input probes publish unsupported, skip same-run delivery control, omit interaction action, or grade Tab as a throw.
 * @level l0
 * @consumer App collector OS-level key/click/wheel injection and modifyOtherKeys observations.
 * @testonly none
 */
import { expect, test } from "vitest"
import { inputProbes } from "./input.ts"
import { modesProbes } from "./modes.ts"
import type { ProbeResult, TermContext } from "./types.ts"

const xtestIds = ["input.xtest-key", "input.xtest-click", "input.xtest-wheel"] as const

function probe(id: string) {
  const definition = inputProbes.find((candidate) => candidate.id === id)
  if (!definition?.term || !definition.termless) throw new Error(`Missing input callbacks for ${id}`)
  return definition
}

function modeProbe(id: string) {
  const definition = modesProbes.find((candidate) => candidate.id === id)
  if (!definition?.term || !definition.termless) throw new Error(`Missing modes callbacks for ${id}`)
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
  script: {
    keys?: Record<string, string>
    clicks?: Record<number, string>
    clickReports?: string[]
    dragReports?: string[]
  },
  writes: string[] = [],
): { ctx: TermContext; keys: string[]; clicks: number[]; drags: number[] } {
  const keys: string[] = []
  const clicks: number[] = []
  const drags: number[] = []
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
        const queued = script.clickReports?.[clicks.length - 1]
        if (queued !== undefined) pending.push(queued)
        else {
          const reply = script.clicks?.[button]
          if (reply !== undefined) pending.push(reply)
        }
      },
      async injectDrag(button) {
        if (!listening) throw new Error("XTEST inject before stdin listen")
        drags.push(button)
        const queued = script.dragReports?.[drags.length - 1]
        if (queued !== undefined) pending.push(queued)
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
  return { ctx, keys, clicks, drags }
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

test("input.xtest-key records interaction after plain-a control then ctrl+a", async () => {
  const writes: string[] = []
  const { ctx, keys } = inputAndRead({ keys: { a: "a", "ctrl+a": "\x01" } }, writes)
  const result = (await probe("input.xtest-key").term!(ctx)) as ProbeResult
  expect(keys).toEqual(["a", "ctrl+a"])
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "interaction" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "xtest-key:ctrl+a" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ control: "a", report: "\x01" })
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

test("input.modify-other-keys is not tested without an OS XTEST adapter", async () => {
  const definition = probe("input.modify-other-keys")
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
      extensions: new Set(["modifyOtherKeys"]),
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

test("input.modify-other-keys aborts when plain a does not reach the app, and does not inject ctrl+i", async () => {
  const writes: string[] = []
  const { ctx, keys } = inputAndRead({ keys: {} }, writes)
  await expect(probe("input.modify-other-keys").term!(ctx)).rejects.toThrow(/delivery control|plain a/i)
  expect(keys).toEqual(["a"])
  expect(writes.join("")).toContain("\x1b[>4;2m")
  expect(writes.join("")).toContain("\x1b[>4;0m")
})

test.each([
  ["\x1b[27;5;105~", "xterm CSI 27;5;105~"],
  ["\x1b[105;5u", "CSI u 105;5u"],
] as const)("input.modify-other-keys records supported interaction for %s", async (report, label) => {
  const writes: string[] = []
  const { ctx, keys } = inputAndRead({ keys: { a: "a", "ctrl+i": report } }, writes)
  const result = (await probe("input.modify-other-keys").term!(ctx)) as ProbeResult
  expect(keys).toEqual(["a", "ctrl+i"])
  expect(writes.join("")).toContain("\x1b[>4;2m")
  expect(writes.join("")).toContain("\x1b[>4;0m")
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "interaction" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "modify-other-keys:ctrl+i" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed, label).toMatchObject({ mode: "modifyOtherKeys-2", control: "a", report })
})

test("input.modify-other-keys records unsupported interaction when ctrl+i still reports Tab", async () => {
  const writes: string[] = []
  const { ctx, keys } = inputAndRead({ keys: { a: "a", "ctrl+i": "\t" } }, writes)
  const result = (await probe("input.modify-other-keys").term!(ctx)) as ProbeResult
  expect(keys).toEqual(["a", "ctrl+i"])
  expect(writes.join("")).toContain("\x1b[>4;2m")
  expect(writes.join("")).toContain("\x1b[>4;0m")
  expect(result.observation).toMatchObject({ outcome: "unsupported", evidence: "interaction" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "negative", action: "modify-other-keys:ctrl+i" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ mode: "modifyOtherKeys-2", control: "a", report: "\t" })
})

test("input.modify-other-keys throws when ctrl+i is silent after delivery control, and still resets the mode", async () => {
  const writes: string[] = []
  const { ctx, keys } = inputAndRead({ keys: { a: "a" } }, writes)
  await expect(probe("input.modify-other-keys").term!(ctx)).rejects.toThrow(/ctrl\+i|modifyOtherKeys|silent/i)
  expect(keys).toEqual(["a", "ctrl+i"])
  expect(writes.join("")).toContain("\x1b[>4;2m")
  expect(writes.join("")).toContain("\x1b[>4;0m")
})

test("input.modify-other-keys-3 is not tested without an OS XTEST adapter", async () => {
  const definition = probe("input.modify-other-keys-3")
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
      extensions: new Set(["modifyOtherKeys"]),
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

test("input.modify-other-keys-3 aborts when plain a does not reach the app, does not enable mode 3, and does not inject i", async () => {
  const writes: string[] = []
  const { ctx, keys } = inputAndRead({ keys: {} }, writes)
  await expect(probe("input.modify-other-keys-3").term!(ctx)).rejects.toThrow(/delivery control|plain a/i)
  expect(keys).toEqual(["a"])
  expect(writes.join("")).not.toContain("\x1b[>4;3m")
  expect(writes.join("")).not.toContain("\x1b[>4;2m")
})

test.each([
  ["\x1b[27;1;105~", "xterm CSI 27;1;105~"],
  ["\x1b[105;1u", "CSI u 105;1u"],
] as const)("input.modify-other-keys-3 records supported interaction for unmodified i as %s", async (report, label) => {
  const writes: string[] = []
  const { ctx, keys } = inputAndRead({ keys: { a: "a", i: report } }, writes)
  const result = (await probe("input.modify-other-keys-3").term!(ctx)) as ProbeResult
  expect(keys).toEqual(["a", "i"])
  expect(writes.join("")).toContain("\x1b[>4;3m")
  expect(writes.join("")).toContain("\x1b[>4;0m")
  expect(writes.join("")).not.toContain("\x1b[>4;2m")
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "interaction" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "modify-other-keys-3:i" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed, label).toMatchObject({ mode: "modifyOtherKeys-3", control: "a", report })
})

test("input.modify-other-keys-3 records unsupported interaction when unmodified i still reports i", async () => {
  const writes: string[] = []
  const { ctx, keys } = inputAndRead({ keys: { a: "a", i: "i" } }, writes)
  const result = (await probe("input.modify-other-keys-3").term!(ctx)) as ProbeResult
  expect(keys).toEqual(["a", "i"])
  expect(writes.join("")).toContain("\x1b[>4;3m")
  expect(writes.join("")).toContain("\x1b[>4;0m")
  expect(result.observation).toMatchObject({ outcome: "unsupported", evidence: "interaction" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "negative", action: "modify-other-keys-3:i" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ mode: "modifyOtherKeys-3", control: "a", report: "i" })
})

test("input.modify-other-keys-3 throws when unmodified i is silent after delivery control, and still resets the mode", async () => {
  const writes: string[] = []
  const { ctx, keys } = inputAndRead({ keys: { a: "a" } }, writes)
  await expect(probe("input.modify-other-keys-3").term!(ctx)).rejects.toThrow(/unmodified i|modifyOtherKeys|silent/i)
  expect(keys).toEqual(["a", "i"])
  expect(writes.join("")).toContain("\x1b[>4;3m")
  expect(writes.join("")).toContain("\x1b[>4;0m")
})

test("modes.application-keypad is not tested without an OS XTEST adapter", async () => {
  const definition = modeProbe("modes.application-keypad")
  const writes: string[] = []
  const result = await definition.term!(term({ write: (text) => writes.push(text) }))
  expect(writes).toEqual([])
  expect(result.notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable: expect.stringMatching(/XTEST|OS-level/i),
  })
  expect(result.observation).toBeUndefined()
})

test("modes.application-keypad aborts when plain a does not reach the app, does not enable DECKPAM, and does not inject KP_5", async () => {
  const writes: string[] = []
  const { ctx, keys } = inputAndRead({ keys: {} }, writes)
  await expect(modeProbe("modes.application-keypad").term!(ctx)).rejects.toThrow(/delivery control|plain a/i)
  expect(keys).toEqual(["a"])
  expect(writes.join("")).not.toContain("\x1b=")
  expect(writes.join("")).not.toContain("\x1b>")
})

test("modes.application-keypad records supported interaction for KP_5 as SS3 u", async () => {
  const writes: string[] = []
  const { ctx, keys } = inputAndRead({ keys: { a: "a", KP_5: "\x1bOu" } }, writes)
  const result = (await modeProbe("modes.application-keypad").term!(ctx)) as ProbeResult
  expect(keys).toEqual(["a", "KP_5"])
  expect(writes.join("")).toContain("\x1b=")
  expect(writes.join("")).toContain("\x1b>")
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "interaction" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "application-keypad:KP_5" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ mode: "application-keypad", control: "a", report: "\x1bOu" })
})

test("modes.application-keypad records unsupported interaction when KP_5 still reports 5", async () => {
  const writes: string[] = []
  const { ctx, keys } = inputAndRead({ keys: { a: "a", KP_5: "5" } }, writes)
  const result = (await modeProbe("modes.application-keypad").term!(ctx)) as ProbeResult
  expect(keys).toEqual(["a", "KP_5"])
  expect(writes.join("")).toContain("\x1b=")
  expect(writes.join("")).toContain("\x1b>")
  expect(result.observation).toMatchObject({ outcome: "unsupported", evidence: "interaction" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "negative", action: "application-keypad:KP_5" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ mode: "application-keypad", control: "a", report: "5" })
})

test("modes.application-keypad throws when KP_5 is silent after delivery control, and still resets DECKPNM", async () => {
  const writes: string[] = []
  const { ctx, keys } = inputAndRead({ keys: { a: "a" } }, writes)
  await expect(modeProbe("modes.application-keypad").term!(ctx)).rejects.toThrow(/KP_5|keypad|silent/i)
  expect(keys).toEqual(["a", "KP_5"])
  expect(writes.join("")).toContain("\x1b=")
  expect(writes.join("")).toContain("\x1b>")
})

test("modes.alt-scroll-1007 is not tested without an OS XTEST adapter", async () => {
  const definition = modeProbe("modes.alt-scroll-1007")
  const writes: string[] = []
  const result = await definition.term!(term({ write: (text) => writes.push(text) }))
  expect(writes).toEqual([])
  expect(result.notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable: expect.stringMatching(/XTEST|OS-level|wheel/i),
  })
  expect(result.observation).toBeUndefined()
})

test("modes.alt-scroll-1007 aborts when the 1000+1006 control click does not reach the app, and does not enable 1007", async () => {
  const writes: string[] = []
  const { ctx, clicks } = inputAndRead({ clicks: {} }, writes)
  await expect(modeProbe("modes.alt-scroll-1007").term!(ctx)).rejects.toThrow(/delivery control|1000\+1006/i)
  expect(clicks).toEqual([1])
  expect(writes.join("")).toContain("\x1b[?1000h")
  expect(writes.join("")).toContain("\x1b[?1006h")
  expect(writes.join("")).not.toContain("\x1b[?1007h")
  expect(writes.join("")).not.toContain("\x1b[?1049h")
})

test("modes.alt-scroll-1007 records supported interaction when wheel under 1007 reports CSI A", async () => {
  const writes: string[] = []
  const control = "\x1b[<0;10;5M"
  const report = "\x1b[A"
  const { ctx, clicks } = inputAndRead({ clickReports: [control, report] }, writes)
  const result = (await modeProbe("modes.alt-scroll-1007").term!(ctx)) as ProbeResult
  expect(clicks).toEqual([1, 4])
  expect(writes.join("")).toContain("\x1b[?1049h")
  expect(writes.join("")).toContain("\x1b[?1007h")
  expect(writes.join("")).toContain("\x1b[?1007l")
  expect(writes.join("")).toContain("\x1b[?1049l")
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "interaction" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "alt-scroll-1007:4" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ mode: "1007", control, report })
})

test("modes.alt-scroll-1007 records unsupported interaction when wheel under 1007 still reports SGR", async () => {
  const writes: string[] = []
  const control = "\x1b[<0;10;5M"
  const report = "\x1b[<64;10;5M"
  const { ctx, clicks } = inputAndRead({ clickReports: [control, report] }, writes)
  const result = (await modeProbe("modes.alt-scroll-1007").term!(ctx)) as ProbeResult
  expect(clicks).toEqual([1, 4])
  expect(writes.join("")).toContain("\x1b[?1007h")
  expect(writes.join("")).toContain("\x1b[?1007l")
  expect(result.observation).toMatchObject({ outcome: "unsupported", evidence: "interaction" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "negative", action: "alt-scroll-1007:4" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ mode: "1007", control, report })
})

test("modes.alt-scroll-1007 throws when the 1007 wheel is silent after delivery control, and still resets 1007", async () => {
  const writes: string[] = []
  const { ctx, clicks } = inputAndRead({ clickReports: ["\x1b[<0;10;5M"] }, writes)
  await expect(modeProbe("modes.alt-scroll-1007").term!(ctx)).rejects.toThrow(/1007|alt-scroll|silent/i)
  expect(clicks).toEqual([1, 4])
  expect(writes.join("")).toContain("\x1b[?1007h")
  expect(writes.join("")).toContain("\x1b[?1007l")
  expect(writes.join("")).toContain("\x1b[?1049l")
})

test("input.pixel-mouse is not tested without an OS XTEST adapter", async () => {
  const definition = probe("input.pixel-mouse")
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

test("input.pixel-mouse aborts when the 1000+1006 control click does not reach the app, and does not enable 1016", async () => {
  const writes: string[] = []
  const { ctx, clicks } = inputAndRead({ clicks: {} }, writes)
  await expect(probe("input.pixel-mouse").term!(ctx)).rejects.toThrow(/delivery control|1000\+1006/i)
  expect(clicks).toEqual([1])
  expect(writes.join("")).toContain("\x1b[?1000h")
  expect(writes.join("")).toContain("\x1b[?1006h")
  expect(writes.join("")).not.toContain("\x1b[?1016h")
  expect(writes.join("")).not.toContain("\x1b[?1016l")
})

test("input.pixel-mouse records supported interaction when 1016 reports pixel coords distinct from the cell control", async () => {
  const writes: string[] = []
  const control = "\x1b[<0;10;5M"
  const report = "\x1b[<0;160;80M"
  const { ctx, clicks } = inputAndRead({ clickReports: [control, report] }, writes)
  const result = (await probe("input.pixel-mouse").term!(ctx)) as ProbeResult
  expect(clicks).toEqual([1, 1])
  expect(writes.join("")).toContain("\x1b[?1016h")
  expect(writes.join("")).toContain("\x1b[?1016l")
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "interaction" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "pixel-mouse:1" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ mode: "1016", control, report })
})

test("input.pixel-mouse records unsupported interaction when 1016 still reports the same cell coords", async () => {
  const writes: string[] = []
  const cell = "\x1b[<0;10;5M"
  const { ctx, clicks } = inputAndRead({ clickReports: [cell, cell] }, writes)
  const result = (await probe("input.pixel-mouse").term!(ctx)) as ProbeResult
  expect(clicks).toEqual([1, 1])
  expect(writes.join("")).toContain("\x1b[?1016h")
  expect(writes.join("")).toContain("\x1b[?1016l")
  expect(result.observation).toMatchObject({ outcome: "unsupported", evidence: "interaction" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "negative", action: "pixel-mouse:1" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ mode: "1016", control: cell, report: cell })
})

test("input.pixel-mouse throws when the 1016 click is silent after delivery control, and still resets 1016", async () => {
  const writes: string[] = []
  const { ctx, clicks } = inputAndRead({ clickReports: ["\x1b[<0;10;5M"] }, writes)
  await expect(probe("input.pixel-mouse").term!(ctx)).rejects.toThrow(/1016|pixel-mouse|silent/i)
  expect(clicks).toEqual([1, 1])
  expect(writes.join("")).toContain("\x1b[?1016h")
  expect(writes.join("")).toContain("\x1b[?1016l")
})

test("input.urxvt-mouse is not tested without an OS XTEST adapter", async () => {
  const definition = probe("input.urxvt-mouse")
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

test("input.urxvt-mouse aborts when the 1000+1006 control click does not reach the app, and does not enable 1015", async () => {
  const writes: string[] = []
  const { ctx, clicks } = inputAndRead({ clicks: {} }, writes)
  await expect(probe("input.urxvt-mouse").term!(ctx)).rejects.toThrow(/delivery control|1000\+1006/i)
  expect(clicks).toEqual([1])
  expect(writes.join("")).toContain("\x1b[?1000h")
  expect(writes.join("")).toContain("\x1b[?1006h")
  expect(writes.join("")).not.toContain("\x1b[?1015h")
  expect(writes.join("")).not.toContain("\x1b[?1015l")
})

test("input.urxvt-mouse records supported interaction when 1015 reports CSI btn;x;yM without <", async () => {
  const writes: string[] = []
  const control = "\x1b[<0;10;5M"
  const report = "\x1b[0;10;5M"
  const { ctx, clicks } = inputAndRead({ clickReports: [control, report] }, writes)
  const result = (await probe("input.urxvt-mouse").term!(ctx)) as ProbeResult
  expect(clicks).toEqual([1, 1])
  expect(writes.join("")).toContain("\x1b[?1015h")
  expect(writes.join("")).toContain("\x1b[?1015l")
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "interaction" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "urxvt-mouse:1" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ mode: "1015", control, report })
})

test("input.urxvt-mouse records unsupported interaction when 1015 still reports SGR with <", async () => {
  const writes: string[] = []
  const sgr = "\x1b[<0;10;5M"
  const { ctx, clicks } = inputAndRead({ clickReports: [sgr, sgr] }, writes)
  const result = (await probe("input.urxvt-mouse").term!(ctx)) as ProbeResult
  expect(clicks).toEqual([1, 1])
  expect(writes.join("")).toContain("\x1b[?1015h")
  expect(writes.join("")).toContain("\x1b[?1015l")
  expect(result.observation).toMatchObject({ outcome: "unsupported", evidence: "interaction" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "negative", action: "urxvt-mouse:1" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ mode: "1015", control: sgr, report: sgr })
})

test("input.urxvt-mouse throws when the 1015 click is silent after delivery control, and still resets 1015", async () => {
  const writes: string[] = []
  const { ctx, clicks } = inputAndRead({ clickReports: ["\x1b[<0;10;5M"] }, writes)
  await expect(probe("input.urxvt-mouse").term!(ctx)).rejects.toThrow(/1015|urxvt-mouse|silent/i)
  expect(clicks).toEqual([1, 1])
  expect(writes.join("")).toContain("\x1b[?1015h")
  expect(writes.join("")).toContain("\x1b[?1015l")
})

test("input.x10-mouse is not tested without an OS XTEST adapter", async () => {
  const definition = probe("input.x10-mouse")
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

test("input.x10-mouse aborts when the 1000+1006 control click does not reach the app, and does not enable 9", async () => {
  const writes: string[] = []
  const { ctx, clicks } = inputAndRead({ clicks: {} }, writes)
  await expect(probe("input.x10-mouse").term!(ctx)).rejects.toThrow(/delivery control|1000\+1006/i)
  expect(clicks).toEqual([1])
  expect(writes.join("")).toContain("\x1b[?1000h")
  expect(writes.join("")).toContain("\x1b[?1006h")
  expect(writes.join("")).not.toContain("\x1b[?9h")
  expect(writes.join("")).not.toContain("\x1b[?9l")
})

test("input.x10-mouse records supported interaction when mode 9 reports CSI M plus three bytes", async () => {
  const writes: string[] = []
  const control = "\x1b[<0;10;5M"
  const report = "\x1b[M\x20\x2a\x25"
  const { ctx, clicks } = inputAndRead({ clickReports: [control, report] }, writes)
  const result = (await probe("input.x10-mouse").term!(ctx)) as ProbeResult
  expect(clicks).toEqual([1, 1])
  expect(writes.join("")).toContain("\x1b[?9h")
  expect(writes.join("")).toContain("\x1b[?9l")
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "interaction" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "x10-mouse:1" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ mode: "9", control, report })
})

test("input.x10-mouse records unsupported interaction when mode 9 still reports SGR with <", async () => {
  const writes: string[] = []
  const sgr = "\x1b[<0;10;5M"
  const { ctx, clicks } = inputAndRead({ clickReports: [sgr, sgr] }, writes)
  const result = (await probe("input.x10-mouse").term!(ctx)) as ProbeResult
  expect(clicks).toEqual([1, 1])
  expect(writes.join("")).toContain("\x1b[?9h")
  expect(writes.join("")).toContain("\x1b[?9l")
  expect(result.observation).toMatchObject({ outcome: "unsupported", evidence: "interaction" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "negative", action: "x10-mouse:1" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ mode: "9", control: sgr, report: sgr })
})

test("input.x10-mouse throws when the mode 9 click is silent after delivery control, and still resets 9", async () => {
  const writes: string[] = []
  const { ctx, clicks } = inputAndRead({ clickReports: ["\x1b[<0;10;5M"] }, writes)
  await expect(probe("input.x10-mouse").term!(ctx)).rejects.toThrow(/9|x10-mouse|silent/i)
  expect(clicks).toEqual([1, 1])
  expect(writes.join("")).toContain("\x1b[?9h")
  expect(writes.join("")).toContain("\x1b[?9l")
})

test("input.button-event-mouse is not tested without an OS XTEST adapter", async () => {
  const definition = probe("input.button-event-mouse")
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

test("input.button-event-mouse is not tested when the adapter cannot drag", async () => {
  const writes: string[] = []
  const ctx = term({
    write(text) {
      writes.push(text)
    },
    input: { injectKey: async () => {}, injectClick: async () => {} },
    readInput: async () => {
      throw new Error("readInput should not run without injectDrag")
    },
  })
  const result = (await probe("input.button-event-mouse").term!(ctx)) as ProbeResult
  expect(writes).toEqual([])
  expect(result.notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable: expect.stringMatching(/drag|XTEST|OS-level/i),
  })
})

test("input.button-event-mouse aborts when the 1000+1006 control click does not reach the app, and does not enable 1002", async () => {
  const writes: string[] = []
  const { ctx, clicks, drags } = inputAndRead({ clicks: {} }, writes)
  await expect(probe("input.button-event-mouse").term!(ctx)).rejects.toThrow(/delivery control|1000\+1006/i)
  expect(clicks).toEqual([1])
  expect(drags).toEqual([])
  expect(writes.join("")).toContain("\x1b[?1000h")
  expect(writes.join("")).toContain("\x1b[?1006h")
  expect(writes.join("")).not.toContain("\x1b[?1002h")
  expect(writes.join("")).not.toContain("\x1b[?1002l")
})

test("input.button-event-mouse records supported interaction when 1002 reports SGR motion with Pb+32", async () => {
  const writes: string[] = []
  const control = "\x1b[<0;10;5M"
  const report = "\x1b[<32;12;5M"
  const { ctx, clicks, drags } = inputAndRead({ clickReports: [control], dragReports: [report] }, writes)
  const result = (await probe("input.button-event-mouse").term!(ctx)) as ProbeResult
  expect(clicks).toEqual([1])
  expect(drags).toEqual([1])
  expect(writes.join("")).toContain("\x1b[?1002h")
  expect(writes.join("")).toContain("\x1b[?1002l")
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "interaction" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "button-event-mouse:1" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ mode: "1002", control, report })
})

test("input.button-event-mouse records unsupported interaction when 1002 still reports press-only SGR", async () => {
  const writes: string[] = []
  const sgr = "\x1b[<0;10;5M"
  const { ctx, clicks, drags } = inputAndRead({ clickReports: [sgr], dragReports: [sgr] }, writes)
  const result = (await probe("input.button-event-mouse").term!(ctx)) as ProbeResult
  expect(clicks).toEqual([1])
  expect(drags).toEqual([1])
  expect(writes.join("")).toContain("\x1b[?1002h")
  expect(writes.join("")).toContain("\x1b[?1002l")
  expect(result.observation).toMatchObject({ outcome: "unsupported", evidence: "interaction" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "negative", action: "button-event-mouse:1" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ mode: "1002", control: sgr, report: sgr })
})

test("input.button-event-mouse throws when the 1002 drag is silent after delivery control, and still resets 1002", async () => {
  const writes: string[] = []
  const { ctx, clicks, drags } = inputAndRead({ clickReports: ["\x1b[<0;10;5M"] }, writes)
  await expect(probe("input.button-event-mouse").term!(ctx)).rejects.toThrow(/1002|button-event|silent/i)
  expect(clicks).toEqual([1])
  expect(drags).toEqual([1])
  expect(writes.join("")).toContain("\x1b[?1002h")
  expect(writes.join("")).toContain("\x1b[?1002l")
})
