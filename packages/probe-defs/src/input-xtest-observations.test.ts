/**
 * @failure XTEST or catalog input probes publish unsupported, skip same-run delivery control, omit interaction action, or grade Tab as a throw.
 * @level l0
 * @consumer App collector OS-level key/click/wheel injection, prompt click events and modifyOtherKeys observations.
 * @testonly none
 */
import { expect, test } from "vitest"
import { inputProbes } from "./input.ts"
import { modesProbes } from "./modes.ts"
import type { LibMouseEvent, LibProbeSource, ProbeCallbackResult, TermProbeSource } from "./types.ts"
import { readResponse } from "../../terminfo.dev/src/tty.ts"

const xtestIds = ["input.xtest-key", "input.xtest-click", "input.xtest-wheel"] as const

function probe(id: string) {
  const definition = inputProbes.find((candidate) => candidate.id === id)
  if (!definition?.term || !definition.lib) throw new Error(`Missing input callbacks for ${id}`)
  return definition
}

function modeProbe(id: string) {
  const definition = modesProbes.find((candidate) => candidate.id === id)
  if (!definition?.term || !definition.lib) throw new Error(`Missing modes callbacks for ${id}`)
  return definition
}

function term(overrides: Partial<TermProbeSource> = {}): TermProbeSource {
  return {
    kind: "live",
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
): { ctx: TermProbeSource; keys: string[]; clicks: number[]; drags: number[] } {
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
    readInput: async (pattern, _timeoutMs, inject) => {
      listening = true
      try {
        if (!inject) throw new Error("readInput requires the inject callback so stdin is already listening")
        await inject()
        const next = pending.shift()
        return next === undefined ? null : next.match(pattern)
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
  const headless = definition.lib!({
    kind: "live",
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
  const result = (await probe("input.xtest-key").term!(ctx)) as ProbeCallbackResult
  expect(keys).toEqual(["a", "ctrl+a"])
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "input_bytes" })
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
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "input_bytes" })
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
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "input_bytes" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "xtest-wheel:4" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ mode: "1000+1006", control: "\x1b[<0;10;10M", report: "\x1b[<64;10;10M" })
})

// Same transport, wrong event: delivery alone cannot establish the claimed button.
test.each([
  ["input.xtest-click", "\x1b[<64;10;10M"],
  ["input.xtest-wheel", "\x1b[<0;10;10M"],
])("%s rejects a different button's SGR report", async (id, report) => {
  const { ctx } = inputAndRead({ clickReports: ["\x1b[<0;10;10M", report] })
  const result = await probe(id).term!(ctx)
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "input_bytes" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "negative" })
})

test("input.modify-other-keys is not tested without an OS XTEST adapter", async () => {
  const definition = probe("input.modify-other-keys")
  const writes: string[] = []
  const headless = definition.lib!({
    kind: "live",
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
  const result = (await probe("input.modify-other-keys").term!(ctx)) as ProbeCallbackResult
  expect(keys).toEqual(["a", "ctrl+i"])
  expect(writes.join("")).toContain("\x1b[>4;2m")
  expect(writes.join("")).toContain("\x1b[>4;0m")
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "input_bytes" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "modify-other-keys:ctrl+i" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed, label).toMatchObject({ mode: "modifyOtherKeys-2", control: "a", report })
})

test("input.modify-other-keys records unsupported interaction when ctrl+i still reports Tab", async () => {
  const writes: string[] = []
  const { ctx, keys } = inputAndRead({ keys: { a: "a", "ctrl+i": "\t" } }, writes)
  const result = (await probe("input.modify-other-keys").term!(ctx)) as ProbeCallbackResult
  expect(keys).toEqual(["a", "ctrl+i"])
  expect(writes.join("")).toContain("\x1b[>4;2m")
  expect(writes.join("")).toContain("\x1b[>4;0m")
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "input_bytes" })
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
  const headless = definition.lib!({
    kind: "live",
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
  const result = (await probe("input.modify-other-keys-3").term!(ctx)) as ProbeCallbackResult
  expect(keys).toEqual(["a", "i"])
  expect(writes.join("")).toContain("\x1b[>4;3m")
  expect(writes.join("")).toContain("\x1b[>4;0m")
  expect(writes.join("")).not.toContain("\x1b[>4;2m")
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "input_bytes" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "modify-other-keys-3:i" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed, label).toMatchObject({ mode: "modifyOtherKeys-3", control: "a", report })
})

test("input.modify-other-keys-3 records unsupported interaction when unmodified i still reports i", async () => {
  const writes: string[] = []
  const { ctx, keys } = inputAndRead({ keys: { a: "a", i: "i" } }, writes)
  const result = (await probe("input.modify-other-keys-3").term!(ctx)) as ProbeCallbackResult
  expect(keys).toEqual(["a", "i"])
  expect(writes.join("")).toContain("\x1b[>4;3m")
  expect(writes.join("")).toContain("\x1b[>4;0m")
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "input_bytes" })
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
  const result = (await modeProbe("modes.application-keypad").term!(ctx)) as ProbeCallbackResult
  expect(keys).toEqual(["a", "KP_5"])
  expect(writes.join("")).toContain("\x1b=")
  expect(writes.join("")).toContain("\x1b>")
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "input_bytes" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "application-keypad:KP_5" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ mode: "application-keypad", control: "a", report: "\x1bOu" })
  expect(result.assertions?.[0]?.expected).toMatch(/SS3 u/)
})

// The real reader sees a byte stream, not one framed report per stdin chunk.
test.each([
  ["coalesced suffix", ["\x1bOu\x1b[12~"]],
  ["coalesced prefix", ["\x1b[15~\x1bOu"]],
  ["fragmented", ["\x1bO", "u\x1b[12~"]],
  ["separate chunks", ["\x1bOu", "\x1b[12~"]],
  ["coalesced OSC prefix", ["\x1b]lterm5\x1b\\\x1bOu"]],
  ["separate OSC prefix", ["\x1b]lterm5\x1b\\", "\x1bOu"]],
] as const)("modes.application-keypad reads SS3 u from %s through actual stdin", async (_label, chunks) => {
  const ctx = term({
    input: {
      async injectKey(key) {
        for (const bytes of key === "a" ? ["a"] : chunks) process.stdin.emit("data", Buffer.from(bytes))
      },
      async injectClick() {},
    },
    readInput: (pattern, timeout, inject) => readResponse(pattern, timeout ?? 1000, inject),
  })
  const result = await modeProbe("modes.application-keypad").term!(ctx)
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "input_bytes" })
  expect(JSON.parse(result.response ?? "null")).toMatchObject({ report: "\x1bOu" })
})

// The real input reader returns only regex matches: a digit inside another report is not KP_5.
test.each(["15", "\x1b[15~", "\x1b[<0;15;1M", "\x1b]lterm5\x1b\\", "\x1b]5;0;rgb:ffff/ffff/ffff\x07"])(
  "modes.application-keypad rejects unrelated input containing 5: %s",
  async (report) => {
    const { ctx } = inputAndRead({ keys: { a: "a", KP_5: report } })
    await expect(modeProbe("modes.application-keypad").term!(ctx)).rejects.toThrow(/KP_5/)
  },
)

test("modes.application-keypad records unsupported interaction when KP_5 still reports 5", async () => {
  const writes: string[] = []
  const { ctx, keys } = inputAndRead({ keys: { a: "a", KP_5: "5" } }, writes)
  const result = (await modeProbe("modes.application-keypad").term!(ctx)) as ProbeCallbackResult
  expect(keys).toEqual(["a", "KP_5"])
  expect(writes.join("")).toContain("\x1b=")
  expect(writes.join("")).toContain("\x1b>")
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "input_bytes" })
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
  const result = (await modeProbe("modes.alt-scroll-1007").term!(ctx)) as ProbeCallbackResult
  expect(clicks).toEqual([1, 4])
  expect(writes.join("")).toContain("\x1b[?1049h")
  expect(writes.join("")).toContain("\x1b[?1007h")
  expect(writes.join("")).toContain("\x1b[?1007l")
  expect(writes.join("")).toContain("\x1b[?1049l")
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "input_bytes" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "alt-scroll-1007:4" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ mode: "1007", control, report })
})

test.each(["\x1b[<64;10;5M", "\x1b[B", "\x1bOA", "\x1bOB"])(
  "modes.alt-scroll-1007 rejects non-CSI-A report %s",
  async (report) => {
    const writes: string[] = []
    const control = "\x1b[<0;10;5M"
    const { ctx, clicks } = inputAndRead({ clickReports: [control, report] }, writes)
    const result = (await modeProbe("modes.alt-scroll-1007").term!(ctx)) as ProbeCallbackResult
    expect(clicks).toEqual([1, 4])
    expect(writes.join("")).toContain("\x1b[?1007h")
    expect(writes.join("")).toContain("\x1b[?1007l")
    expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "input_bytes" })
    expect(result.assertions?.[0]).toMatchObject({ kind: "negative", action: "alt-scroll-1007:4" })
    const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
    expect(observed).toMatchObject({ mode: "1007", control, report })
  },
)

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
  const headless = definition.lib!({
    kind: "live",
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
  const result = (await probe("input.pixel-mouse").term!(ctx)) as ProbeCallbackResult
  expect(clicks).toEqual([1, 1])
  expect(writes.join("")).toContain("\x1b[?1016h")
  expect(writes.join("")).toContain("\x1b[?1016l")
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "input_bytes" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "pixel-mouse:1" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ mode: "1016", control, report })
})

test("input.pixel-mouse records unsupported interaction when 1016 still reports the same cell coords", async () => {
  const writes: string[] = []
  const cell = "\x1b[<0;10;5M"
  const { ctx, clicks } = inputAndRead({ clickReports: [cell, cell] }, writes)
  const result = (await probe("input.pixel-mouse").term!(ctx)) as ProbeCallbackResult
  expect(clicks).toEqual([1, 1])
  expect(writes.join("")).toContain("\x1b[?1016h")
  expect(writes.join("")).toContain("\x1b[?1016l")
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "input_bytes" })
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
  const headless = definition.lib!({
    kind: "live",
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
  const result = (await probe("input.urxvt-mouse").term!(ctx)) as ProbeCallbackResult
  expect(clicks).toEqual([1, 1])
  expect(writes.join("")).toContain("\x1b[?1015h")
  expect(writes.join("")).toContain("\x1b[?1015l")
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "input_bytes" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "urxvt-mouse:1" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ mode: "1015", control, report })
})

test("input.urxvt-mouse records unsupported interaction when 1015 still reports SGR with <", async () => {
  const writes: string[] = []
  const sgr = "\x1b[<0;10;5M"
  const { ctx, clicks } = inputAndRead({ clickReports: [sgr, sgr] }, writes)
  const result = (await probe("input.urxvt-mouse").term!(ctx)) as ProbeCallbackResult
  expect(clicks).toEqual([1, 1])
  expect(writes.join("")).toContain("\x1b[?1015h")
  expect(writes.join("")).toContain("\x1b[?1015l")
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "input_bytes" })
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
  const headless = definition.lib!({
    kind: "live",
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
  const result = (await probe("input.x10-mouse").term!(ctx)) as ProbeCallbackResult
  expect(clicks).toEqual([1, 1])
  expect(writes.join("")).toContain("\x1b[?9h")
  expect(writes.join("")).toContain("\x1b[?9l")
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "input_bytes" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "x10-mouse:1" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ mode: "9", control, report })
})

test("input.x10-mouse records unsupported interaction when mode 9 still reports SGR with <", async () => {
  const writes: string[] = []
  const sgr = "\x1b[<0;10;5M"
  const { ctx, clicks } = inputAndRead({ clickReports: [sgr, sgr] }, writes)
  const result = (await probe("input.x10-mouse").term!(ctx)) as ProbeCallbackResult
  expect(clicks).toEqual([1, 1])
  expect(writes.join("")).toContain("\x1b[?9h")
  expect(writes.join("")).toContain("\x1b[?9l")
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "input_bytes" })
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
  const headless = definition.lib!({
    kind: "live",
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
  const result = (await probe("input.button-event-mouse").term!(ctx)) as ProbeCallbackResult
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
  const result = (await probe("input.button-event-mouse").term!(ctx)) as ProbeCallbackResult
  expect(clicks).toEqual([1])
  expect(drags).toEqual([1])
  expect(writes.join("")).toContain("\x1b[?1002h")
  expect(writes.join("")).toContain("\x1b[?1002l")
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "input_bytes" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "button-event-mouse:1" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ mode: "1002", control, report })
})

test("input.button-event-mouse records unsupported interaction when 1002 still reports press-only SGR", async () => {
  const writes: string[] = []
  const sgr = "\x1b[<0;10;5M"
  const { ctx, clicks, drags } = inputAndRead({ clickReports: [sgr], dragReports: [sgr] }, writes)
  const result = (await probe("input.button-event-mouse").term!(ctx)) as ProbeCallbackResult
  expect(clicks).toEqual([1])
  expect(drags).toEqual([1])
  expect(writes.join("")).toContain("\x1b[?1002h")
  expect(writes.join("")).toContain("\x1b[?1002l")
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "input_bytes" })
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

test("input.kitty-click-events supports a prompt click report while mouse modes are off", async () => {
  const writes: string[] = []
  const { ctx, clicks } = inputAndRead({ clickReports: ["\x1b[<0;10;5M", "\x1b[<0;10;5M"] }, writes)
  const result = await probe("input.kitty-click-events").term!(ctx)
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "input_bytes" })
  expect(result.assertions).toEqual([expect.objectContaining({ kind: "positive", action: "kitty-click-events:1" })])
  expect(clicks).toEqual([1, 1])
  const marker = writes.find((write) => write.includes("\x1b]133;A;click_events=1"))
  expect(marker).toBe("\x1b[5;1H\x1b]133;A;click_events=1\x07$ " + " ".repeat(8))
  expect(writes.some((write) => write.includes("\x1b]133;B\x07\x1b[5;1H\x1b[2K"))).toBe(true)
  expect(writes.some((write) => write.includes("\x1b[?1049h"))).toBe(false)
})

test("input.kitty-click-events reports unsupported when a delivered click leaves the marked prompt silent", async () => {
  const { ctx } = inputAndRead({ clickReports: ["\x1b[<0;10;5M"] }, [])
  const result = await probe("input.kitty-click-events").term!(ctx)
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "input_bytes" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "negative", action: "kitty-click-events:1" })
})

test("input.kitty-click-events names the missing click injection instead of measuring", async () => {
  const result = await probe("input.kitty-click-events").term!(term())
  expect(result.notTested).toMatchObject({ reason: "no-semantic-observable" })
  expect(result.observation).toBeUndefined()
  expect(result.assertions).toBeUndefined()
})

test("input.kitty-click-events stays inconclusive when the report does not match the control click", async () => {
  const { ctx } = inputAndRead({ clickReports: ["\x1b[<0;10;5M", "\x1b[<2;30;9M"] }, [])
  const result = await probe("input.kitty-click-events").term!(ctx)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    assertionType: "input_bytes",
  })
  expect(result.assertions).toBeUndefined()
})

function sgrBytes(button: number, x: number, y: number, suffix: "M" | "m" = "M"): Uint8Array {
  const prefix = [String.fromCharCode(0x1b), "[", "<"].join("")
  return new TextEncoder().encode(`${prefix}${String(button)};${String(x)};${String(y)}${suffix}`)
}

function libMouseSource(
  overrides: {
    extensions?: Iterable<string>
    encodeMouse?: (event: LibMouseEvent) => Uint8Array | null
  } = {},
  feeds: string[] = [],
  events: LibMouseEvent[] = [],
): LibProbeSource {
  return {
    kind: "live",
    cols: 80,
    feed(text) {
      feeds.push(text)
    },
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
    ...(overrides.encodeMouse && {
      encodeMouse(event: LibMouseEvent) {
        events.push({ ...event })
        return overrides.encodeMouse!(event)
      },
    }),
    capabilities: {
      truecolor: false,
      kittyKeyboard: false,
      kittyGraphics: false,
      sixel: false,
      osc8Hyperlinks: false,
      semanticPrompts: false,
      reflow: false,
      unicode: "unknown",
      extensions: new Set(overrides.extensions ?? ["mouse-encoding"]),
    },
  }
}

test("input.kitty-click-events declares libAssertionType input_bytes and returns notTestedResult when capability is absent or undeclared", () => {
  const definition = probe("input.kitty-click-events")
  expect(definition.libAssertionType).toBe("input_bytes")

  const absent = definition.lib!(libMouseSource({ extensions: [] }))
  expect(absent.notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable: expect.stringMatching(/mouse-encoding/i),
  })
  expect(absent.observation).toBeUndefined()
  expect(absent.criterionBranch).toBeUndefined()

  const undeclaredMethod = definition.lib!(
    libMouseSource({
      extensions: [],
      encodeMouse: (event) => sgrBytes(0, event.x + 1, event.y + 1),
    }),
  )
  expect(undeclaredMethod.notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable: expect.stringMatching(/undeclared|mouse-encoding/i),
  })
  expect(undeclaredMethod.observation).toBeUndefined()
})

test("input.kitty-click-events library arm returns inconclusive when the 1000+1006 delivery control returns null and resets mouse modes", () => {
  const feeds: string[] = []
  const events: LibMouseEvent[] = []
  let modesOn = false
  let calls = 0
  const ctx = libMouseSource(
    {
      encodeMouse: (event) => {
        calls += 1
        if (calls === 1) return null
        return modesOn ? sgrBytes(0, event.x + 1, event.y + 1) : null
      },
    },
    feeds,
    events,
  )
  const origFeed = ctx.feed.bind(ctx)
  ctx.feed = (text: string) => {
    origFeed(text)
    if (text.includes("?1000h") && text.includes("?1006h")) modesOn = true
    if (text.includes("?1006l") && text.includes("?1000l")) modesOn = false
  }
  const result = probe("input.kitty-click-events").lib!(ctx)
  expect(events).toHaveLength(1)
  expect(modesOn).toBe(false)
  expect(feeds.at(-1)).toContain("?1006l")
  expect(feeds.at(-1)).toContain("?1000l")
  expect(ctx.encodeMouse!({ x: 4, y: 2, button: "left", action: "press" })).toBeNull()
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    assertionType: "input_bytes",
    note: expect.stringMatching(/delivery control/i),
  })
  expect(result.assertions).toBeUndefined()
})

test("input.kitty-click-events library arm throws when delivery control returns non-SGR bytes without coordinates and resets mouse modes", () => {
  const feeds: string[] = []
  const ctx = libMouseSource(
    {
      encodeMouse: () => new TextEncoder().encode("not-sgr"),
    },
    feeds,
  )
  expect(() => probe("input.kitty-click-events").lib!(ctx)).toThrow(/coordinates|delivery control/i)
  expect(feeds.at(-1)).toContain("?1006l")
  expect(feeds.at(-1)).toContain("?1000l")
})

test("input.kitty-click-events library arm returns inconclusive when the modes-off negative control outside the prompt still emits a report (C4)", () => {
  const feeds: string[] = []
  const events: LibMouseEvent[] = []
  const ctx = libMouseSource(
    {
      encodeMouse: (event) => sgrBytes(0, event.x + 1, event.y + 1, event.action === "release" ? "m" : "M"),
    },
    feeds,
    events,
  )
  const result = probe("input.kitty-click-events").lib!(ctx)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    assertionType: "input_bytes",
    note: expect.stringMatching(/mouse modes still active|outside/i),
  })
  expect(result.assertions).toBeUndefined()
  expect(feeds.some((chunk) => chunk.includes("133;B"))).toBe(true)
})

test("input.kitty-click-events library arm records unsupported when control passes, modes-off negative control is null, and prompt click is null", () => {
  const feeds: string[] = []
  const events: LibMouseEvent[] = []
  let modesOn = false
  const ctx = libMouseSource(
    {
      encodeMouse: (event) => {
        if (!modesOn) return null
        return sgrBytes(0, event.x + 1, event.y + 1, event.action === "release" ? "m" : "M")
      },
    },
    feeds,
    events,
  )
  const origFeed = ctx.feed.bind(ctx)
  ctx.feed = (text: string) => {
    origFeed(text)
    if (text.includes("?1000h")) modesOn = true
    if (text.includes("?1000l")) modesOn = false
  }
  const result = probe("input.kitty-click-events").lib!(ctx)
  expect(result.observation).toMatchObject({
    outcome: "unsupported",
    assertionType: "input_bytes",
  })
  expect(result.assertions?.[0]).toMatchObject({
    kind: "negative",
    action: "kitty-click-events:1",
    assertionType: "input_bytes",
  })
  expect(events.map((entry) => `${entry.action}:${String(entry.x)},${String(entry.y)}`)).toEqual([
    "press:4,2",
    "release:4,2",
    "press:4,3",
    "press:4,2",
  ])
})

test("input.kitty-click-events library arm returns inconclusive when the prompt click report does not correlate with the control cell or button", () => {
  let modesOn = false
  let promptRow = -1
  const ctx = libMouseSource({
    encodeMouse: (event) => {
      if (modesOn) {
        return sgrBytes(0, event.x + 1, event.y + 1, event.action === "release" ? "m" : "M")
      }
      if (event.y + 1 === promptRow && event.action === "press") {
        return sgrBytes(2, event.x + 9, event.y + 5, "M")
      }
      return null
    },
  })
  const origFeed = ctx.feed.bind(ctx)
  ctx.feed = (text: string) => {
    origFeed(text)
    if (text.includes("?1000h")) modesOn = true
    if (text.includes("?1000l")) modesOn = false
    if (text.includes("133;A;click_events=1")) promptRow = 3
  }
  const result = probe("input.kitty-click-events").lib!(ctx)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    assertionType: "input_bytes",
    note: expect.stringMatching(/correlate/i),
  })
  expect(result.assertions).toBeUndefined()
})

test("input.kitty-click-events library arm records supported when control passes, modes-off negative control is null, and prompt click correlates", () => {
  const feeds: string[] = []
  const events: LibMouseEvent[] = []
  let modesOn = false
  let promptRow = -1
  const ctx = libMouseSource(
    {
      encodeMouse: (event) => {
        if (modesOn) {
          return sgrBytes(0, event.x + 1, event.y + 1, event.action === "release" ? "m" : "M")
        }
        if (event.y + 1 === promptRow) {
          return sgrBytes(0, event.x + 1, event.y + 1, event.action === "release" ? "m" : "M")
        }
        return null
      },
    },
    feeds,
    events,
  )
  const origFeed = ctx.feed.bind(ctx)
  ctx.feed = (text: string) => {
    origFeed(text)
    if (text.includes("?1000h")) modesOn = true
    if (text.includes("?1000l")) modesOn = false
    if (text.includes("133;A;click_events=1")) promptRow = 3
    if (text.includes("133;B")) promptRow = -1
  }
  const result = probe("input.kitty-click-events").lib!(ctx)
  expect(result.observation).toMatchObject({
    outcome: "supported",
    assertionType: "input_bytes",
  })
  expect(result.assertions).toEqual([
    expect.objectContaining({
      kind: "positive",
      action: "kitty-click-events:1",
      assertionType: "input_bytes",
    }),
  ])
  expect(events.map((entry) => `${entry.action}:${String(entry.x)},${String(entry.y)}`)).toEqual([
    "press:4,2",
    "release:4,2",
    "press:4,3",
    "press:4,2",
    "release:4,2",
  ])
})
