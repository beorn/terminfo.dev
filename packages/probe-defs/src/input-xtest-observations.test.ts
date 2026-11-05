/**
 * @failure XTEST or catalog input probes publish unsupported, skip same-run delivery control, omit interaction action, or grade Tab as a throw.
 * @level l0
 * @consumer App collector OS-level key/click/wheel injection, prompt click events and modifyOtherKeys observations.
 * @testonly none
 */
import { expect, test } from "vitest"
import { inputProbes } from "./input.ts"
import { modesProbes } from "./modes.ts"
import { extensionsProbes } from "./extensions.ts"
import type { LibKeyEvent, LibMouseEvent, LibProbeSource, ProbeCallbackResult, TermProbeSource } from "./types.ts"
import { readResponse } from "../../terminfo.dev/src/tty.ts"
import { isDeclaredUntestable } from "./helpers.ts"

const xtestIds = ["input.xtest-key", "input.xtest-click", "input.xtest-wheel"] as const

// Native MOK needs a controlled transition, not merely an extended key report.
// App-input fixtures and declaration checks cannot catch a vacuous native encoder.
test.each([
  ["input.modify-other-keys", 2],
  ["input.modify-other-keys-3", 3],
] as const)("%s measures native off/on/reset and rejects vacuous controls", (id, level) => {
  for (const form of ["tilde", "u"] as const) {
    for (const behavior of [
      "working",
      "disabled",
      "noop",
      "broken",
      "constant",
      "equivalent",
      "wrong",
      "control-change",
    ] as const) {
      const feeds: string[] = []
      let mode = 0
      const ctx: LibProbeSource = {
        ...libMouseSource({ extensions: ["key-encoding"] }),
        backendName: "libvterm",
        feed(text) {
          feeds.push(text)
          const value = text.match(/^\x1b\[>4;(\d)m$/)?.[1]
          if (value !== undefined) mode = Number(value)
        },
        encodeKey(event) {
          if (behavior === "noop" || (behavior === "broken" && event.key === "a")) return new Uint8Array()
          let bytes = event.key === "ArrowUp" ? "\x1b[A" : event.ctrl ? "\x01" : event.key
          if (behavior === "control-change" && event.key === "a" && event.ctrl && mode === level) {
            bytes = "\x1b[27;5;97~"
          }
          if (event.key === "i") {
            bytes = event.ctrl ? "\t" : "i"
            if (
              ((behavior === "working" || behavior === "wrong") && mode === level) ||
              behavior === "constant" ||
              behavior === "equivalent" ||
              behavior === "control-change"
            ) {
              const modifier = event.ctrl ? 5 : 1
              bytes = form === "tilde" ? `\x1b[27;${modifier};105~` : `\x1b[105;${modifier}u`
              if (behavior === "equivalent") {
                bytes = mode === level ? `\x1b[27;${modifier};105~` : `\x1b[105;${modifier}u`
              }
              if (behavior === "wrong") bytes = `\x1b[106;${modifier}u`
            }
          }
          return new TextEncoder().encode(bytes)
        },
      }
      const result = probe(id).lib!(ctx)
      const outcome =
        behavior === "working" || behavior === "control-change"
          ? "supported"
          : behavior === "wrong"
            ? "unsupported"
            : undefined
      expect(result.observation?.outcome, `${form}/${behavior}`).toBe(outcome)
      if (outcome) {
        expect(
          result.assertions?.every(
            (assertion) => assertion.kind === (outcome === "supported" ? "positive" : "negative"),
          ),
        ).toBe(true)
      }
      expect(feeds.at(-1)).toBe("\x1b[>4;0m")
      if (behavior === "working") {
        expect(probe(id).libAssertionType).toBe("input_bytes")
        const observed = JSON.parse(result.response!) as {
          off: { ctrlI: { bytes: number[] } }
          reset: { ctrlI: { bytes: number[] } }
          on: { ctrlI: { event: { key: string; ctrl: boolean } } }
        }
        expect(observed.off.ctrlI.bytes).toEqual([9])
        expect(observed.reset.ctrlI.bytes).toEqual([9])
        expect(observed.on.ctrlI.event).toEqual({ key: "i", ctrl: true })
        expect(result.assertions?.some((entry) => entry.kind === "positive")).toBe(true)
      } else if (!outcome) {
        expect(result.notTested?.noObservable).toMatch(/control|unchanged|discriminator/)
      }
    }
  }
  const failure = new Error("native key encoder failed")
  const feeds: string[] = []
  const ctx = {
    ...libMouseSource(),
    backendName: "libvterm",
    feed: (s: string) => feeds.push(s),
    encodeKey() {
      throw failure
    },
  }
  expect(() => probe(id).lib!(ctx)).toThrow(failure)
  expect(feeds.at(-1)).toBe("\x1b[>4;0m")
})

// The operator-approved interface absence is distinct from an encoder not yet wired to the probe.
// Existing generic headless/app cases do not protect this per-library declaration boundary.
test.each(["input.modify-other-keys", "input.modify-other-keys-3"])(
  "%s declares only checked key-encoder absences Untestable",
  (id) => {
    for (const backendName of ["alacritty", "vt100", "vt220", "vt100-rust", "xterm"]) {
      const result = probe(id).lib!({ ...libMouseSource({ extensions: [] }), backendName })
      expect(isDeclaredUntestable(result), backendName).toBe(true)
      expect(result.tests?.[0]?.reason).toMatch(/(?:public key-event|key-event-to-byte) encoder/)
      expect(result.observation).toBeUndefined()
    }
    for (const backendName of ["libvterm", "ghostty", "ghostty-native", "wezterm", "kitty", "vterm", "unknown"]) {
      const result = probe(id).lib!({ ...libMouseSource({ extensions: [] }), backendName })
      expect(isDeclaredUntestable(result), backendName).toBe(false)
    }
  },
)

// Fixed per-capture review reasons must reach the real callbacks, without grading at callback time.
// Existing input fixtures checked absence of observations, not this retained review contract.
// Five libraries export no public key-event encoder: their input.xtest-key cell is declared Untestable (operator Nov 4
// 16:55), and its reason names the missing export.
test.each([
  ["vt100", /vt100\.js 0\.10\.1 exports createVt100Screen/],
  ["vt220", /vt220\.js 0\.10\.1 exports createVt220Screen/],
  ["xterm", /@xterm\/headless 6\.0\.0 exports Terminal/],
  ["alacritty", /alacritty_terminal 0\.26\.0 exposes/],
  ["vt100-rust", /vt100 crate 0\.16\.2 exposes/],
])("input.xtest-key on %s reads declared Untestable with the missing export", (backendName, reason) => {
  const definition = inputProbes.find((entry) => entry.id === "input.xtest-key")!
  const result = definition.lib!({ kind: "live", backendName } as unknown as LibProbeSource)
  expect(result.criterionBranch).toBe("headless-observable-review")
  expect(result.tests).toEqual([
    { id: "declared-untestable", status: "untestable", reason: expect.stringMatching(reason) },
  ])
})

// Libraries that export a key encoder are not declared; they keep the review until a route is measured.
test.each(["libvterm", "ghostty", "ghostty-native", "wezterm", "kitty"])(
  "input.xtest-key on %s keeps its review",
  (backendName) => {
    const definition = inputProbes.find((entry) => entry.id === "input.xtest-key")!
    const result = definition.lib!({ kind: "live", backendName } as unknown as LibProbeSource)
    expect(result.criterionBranch).toBe("os-input-review")
    expect(result.tests?.[0]).toMatchObject({ id: "review", status: "probe-todo" })
  },
)

// #32308 (@cto e4f1c5bd): a bound library key encoder grades input.xtest-key only after its plain-a control.
// The review cases above pass no encoder, so they cannot catch a grade from a failed control or a dropped ctrl.
test.each([
  ["passes control and encodes ctrl+a", "a", "\x01", "supported"],
  ["passes control but drops ctrl", "a", "a", "unsupported"],
  ["fails the plain-a control", "", "\x01", undefined],
] as const)("input.xtest-key library encoder %s", (_name, plain, ctrlA, outcome) => {
  // The collector admits an undeclared library assertion type, so the measured result alone cannot pin this.
  expect(probe("input.xtest-key").libAssertionType).toBe("input_bytes")
  const encoder = new TextEncoder()
  const calls: unknown[] = []
  const result = probe("input.xtest-key").lib!({
    kind: "live",
    backendName: "libvterm",
    encodeKey(event: LibKeyEvent) {
      calls.push(event)
      return encoder.encode(event.ctrl ? ctrlA : plain)
    },
  } as unknown as LibProbeSource)
  expect(result.observation?.outcome).toBe(outcome)
  if (outcome === undefined) {
    expect(calls).toEqual([{ key: "a" }])
    expect(result.notTested).toBeDefined()
    return
  }
  expect(calls).toEqual([{ key: "a" }, { key: "a", ctrl: true }])
  expect(JSON.parse(result.response!)).toEqual({
    control: "a",
    controlBytes: [97],
    report: ctrlA,
    reportBytes: [...encoder.encode(ctrlA)],
  })
  expect(result.assertions?.[0]).toMatchObject({ action: "xtest-key:ctrl+a", assertionType: "input_bytes" })
})

test.each(["input.xtest-key", "extensions.clipboard-paste"])(
  "%s retains its named missing library input observation",
  (id) => {
    const definition = [...inputProbes, ...extensionsProbes].find((entry) => entry.id === id)!
    const result = definition.lib!({ kind: "live" } as LibProbeSource)
    expect(result.observation).toBeUndefined()
    expect(result.criterionBranch).toBe(id === "extensions.clipboard-paste" ? "paste-encoding" : "os-input-review")
    expect(result.tests).toEqual([
      {
        id: "review",
        status: "probe-todo",
        reason:
          id === "extensions.clipboard-paste"
            ? expect.stringContaining("paste-encoding extension unavailable; native paste interface not observed")
            : "Lib arm: the engine consumes bytes and has no input surface; host input encoding is measured in the terminal arm.",
      },
    ])
  },
)

test.each([
  "input.xtest-key",
  "input.xtest-click",
  "input.xtest-wheel",
  "input.button-event-mouse",
  "input.pixel-mouse",
  "input.urxvt-mouse",
  "input.x10-mouse",
  "input.modify-other-keys",
  "input.modify-other-keys-3",
  "extensions.clipboard-paste",
  "modes.application-keypad",
  "modes.alt-scroll-1007",
])("%s names real-surface injection only when the input path is missing", async (id) => {
  const definition = [...inputProbes, ...extensionsProbes, ...modesProbes].find((entry) => entry.id === id)!
  for (const missing of ["input", "readInput"] as const) {
    const context = term({
      input: { injectKey: async () => {}, injectClick: async () => {} },
      readInput: async () => null,
    })
    context[missing] = undefined
    const result = await definition.term!(context)
    expect(result.observation).toBeUndefined()
    expect(result.notTested?.noObservable).toBe("real-surface input injection (XTEST/CGEvent)")
  }
})

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
    cellSize?: { width: number; height: number } | null
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
    queryWithSentinelOutcome: async (sequence) => {
      if (script.cellSize === null) return { match: null, reason: "sentinel", raw: "", rawBase64: "" }
      const { width, height } = script.cellSize ?? { width: 16, height: 16 }
      const raw =
        sequence === "\x1b[16t"
          ? `\x1b[6;${height};${width}t`
          : sequence === "\x1b[14t"
            ? `\x1b[4;${height * 24};${width * 80}t`
            : undefined
      if (raw === undefined) throw new Error(`Unexpected geometry query ${JSON.stringify(sequence)}`)
      return { match: raw.match(/\x1b\[\d+;(\d+);(\d+)t/), reason: "reply", raw, rawBase64: "" }
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
    backendName: "scripted-model",
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
    noObservable:
      id === "input.xtest-key"
        ? expect.stringMatching(/XTEST|OS-level/i)
        : "adapter binding scripted-model: mouse-encoding extension unavailable",
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

// The published delivery criterion accepts legacy Ctrl+A as well as its extended encodings.
// The old positive covered only CSI u, while a negative incorrectly rejected the C0 byte.
test.each(["\x01", "\x1b[27;5;97~", "\x1b[97;5u"])(
  "input.xtest-key records ctrl+a report %j after plain-a control",
  async (report) => {
    const writes: string[] = []
    const { ctx, keys } = inputAndRead({ keys: { a: "a", "ctrl+a": report } }, writes)
    const result = (await probe("input.xtest-key").term!(ctx)) as ProbeCallbackResult
    expect(keys).toEqual(["a", "ctrl+a"])
    expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "input_bytes" })
    expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "xtest-key:ctrl+a" })
    const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
    expect(observed).toMatchObject({ control: "a", report })
  },
)

// Existing delivery tests accepted any modified key; these reports deny the exact ctrl+a claim.
test.each(["\x1b[27;1;97~", "\x1b[98;5u", "\x1b[27;5;98~", "\x1b[97;2u"])(
  "input.xtest-key rejects the wrong encoding %j after a successful delivery control",
  async (report) => {
    const { ctx, keys } = inputAndRead({ keys: { a: "a", "ctrl+a": report } })
    const result = await probe("input.xtest-key").term!(ctx)
    expect(keys).toEqual(["a", "ctrl+a"])
    expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "input_bytes" })
    expect(result.assertions?.[0]).toMatchObject({ kind: "negative" })
    expect(JSON.parse(result.response!)).toMatchObject({ control: "a", report })
  },
)

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
    backendName: "scripted-model",
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
    noObservable: "Native key-encoding route is not qualified for this library",
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

// Both criteria name an exact injected modifier; existing cases covered only the right modifier or bare fallback.
test.each([
  ["input.modify-other-keys", "ctrl+i", "\x1b[27;1;105~"],
  ["input.modify-other-keys", "ctrl+i", "\x1b[105;2u"],
  ["input.modify-other-keys-3", "i", "\x1b[27;5;105~"],
  ["input.modify-other-keys-3", "i", "\x1b[105;5u"],
] as const)("%s rejects wrong modifier for %j in report %j", async (id, key, report) => {
  const writes: string[] = []
  const { ctx, keys } = inputAndRead({ keys: { a: "a", [key]: report } }, writes)
  const result = await probe(id).term!(ctx)
  expect(keys).toEqual(["a", key])
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "input_bytes" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "negative" })
  expect(JSON.parse(result.response!)).toMatchObject({ control: "a", report })
  expect(writes.at(-1)).toBe("\x1b[>4;0m")
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
    backendName: "scripted-model",
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
    noObservable: "Native key-encoding route is not qualified for this library",
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

test.each([
  ["CSI A", "\x1b[A"],
  ["SS3 A", "\x1bOA"],
] as const)(
  "modes.alt-scroll-1007 records supported interaction when wheel under 1007 reports %s",
  async (form, report) => {
    const writes: string[] = []
    const control = "\x1b[<0;10;5M"
    const { ctx, clicks } = inputAndRead({ clickReports: [control, report] }, writes)
    const result = (await modeProbe("modes.alt-scroll-1007").term!(ctx)) as ProbeCallbackResult
    expect(clicks).toEqual([1, 4])
    expect(writes.join("")).toContain("\x1b[?1049h")
    expect(writes.join("")).toContain("\x1b[?1007h")
    expect(writes.join("")).toContain("\x1b[?1007l")
    expect(writes.join("")).toContain("\x1b[?1049l")
    expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "input_bytes" })
    expect(result.observation?.note).toContain(form)
    expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "alt-scroll-1007:4" })
    expect(result.assertions?.[0]?.expected).toContain(`as ${form}`)
    const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
    expect(observed).toMatchObject({ mode: "1007", control, report })
  },
)

test.each(["\x1b[<64;10;5M", "\x1b[B", "\x1bOB"])(
  "modes.alt-scroll-1007 rejects unrelated report %s",
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
    backendName: "scripted-model",
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
    noObservable: "adapter binding scripted-model: mouse-encoding extension unavailable",
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

// Distinctness alone also accepts shifted cell coordinates and pixels in an adjacent cell.
test.each([
  ["\x1b[<0;73;65M", "supported"],
  ["\x1b[<0;80;80M", "supported"],
  ["\x1b[<0;11;6M", "unsupported"],
  ["\x1b[<0;72;65M", "unsupported"],
  ["\x1b[<0;81;65M", "unsupported"],
  ["\x1b[<0;73;64M", "unsupported"],
  ["\x1b[<0;73;81M", "unsupported"],
] as const)("input.pixel-mouse measures the predicted pixel box for %j", async (report, outcome) => {
  const { ctx } = inputAndRead({
    clickReports: ["\x1b[<0;10;5M", report],
    cellSize: { width: 8, height: 16 },
  })
  const result = await probe("input.pixel-mouse").term!(ctx)
  expect(result.observation).toMatchObject({ outcome, assertionType: "input_bytes" })
  expect(result.assertions?.[0]?.kind).toBe(outcome === "supported" ? "positive" : "negative")
})

test("input.pixel-mouse keeps missing cell geometry as named coverage without a feature verdict", async () => {
  const writes: string[] = []
  const { ctx, clicks } = inputAndRead({ clickReports: ["\x1b[<0;10;5M", "\x1b[<0;80;80M"], cellSize: null }, writes)
  const result = await probe("input.pixel-mouse").term!(ctx)
  expect(result.notTested).toMatchObject({ noObservable: expect.stringContaining("no cell geometry") })
  expect(result.observation).toBeUndefined()
  expect(result.assertions ?? []).toEqual([])
  expect(clicks).toEqual([1])
  expect(writes).not.toContain("\x1b[?1016h")
})

// Acceptance: an invalid delivery control cannot qualify pixel support or feature absence.
// The existing pixel-box cases all used a valid button-1 cell control.
test.each([
  ["zero x", "\x1b[<0;0;5M", "\x1b[<0;0;80M"],
  ["zero y", "\x1b[<0;10;0M", "\x1b[<0;80;0M"],
  ["off-grid x", "\x1b[<0;81;5M", "\x1b[<0;648;80M"],
  ["off-grid y", "\x1b[<0;10;25M", "\x1b[<0;80;400M"],
  ["unsafe coordinate", "\x1b[<0;9007199254740992;5M", "\x1b[<0;72057594037927936;80M"],
  ["wheel event", "\x1b[<64;10;5M", "\x1b[<0;80;80M"],
] as const)("input.pixel-mouse retains an unqualified %s delivery control", async (_name, control, report) => {
  const writes: string[] = []
  const { ctx, clicks } = inputAndRead({ clickReports: [control, report], cellSize: { width: 8, height: 16 } }, writes)
  const result = await probe("input.pixel-mouse").term!(ctx)
  expect(result.notTested?.noObservable).toMatch(/delivery control/i)
  expect(JSON.parse(result.response!)).toMatchObject({ control })
  expect(result.observation).toBeUndefined()
  expect(result.assertions ?? []).toEqual([])
  expect(clicks).toEqual([1])
  expect(writes).not.toContain("\x1b[?1016h")
  expect(writes.join("")).toContain("\x1b[?1000l")
  expect(writes.join("")).toContain("\x1b[?1006l")
})

// Acceptance: wheel bytes cannot decide a button-1 click; retain the bytes and mode cleanup.
test("input.pixel-mouse retains a wheel target without a button-1 feature verdict", async () => {
  const writes: string[] = []
  const control = "\x1b[<0;10;5M"
  const report = "\x1b[<64;80;80M"
  const { ctx } = inputAndRead({ clickReports: [control, report], cellSize: { width: 8, height: 16 } }, writes)
  const result = await probe("input.pixel-mouse").term!(ctx)
  expect(result.notTested?.noObservable).toMatch(/button-1/i)
  expect(JSON.parse(result.response!)).toMatchObject({ control, report })
  expect(result.observation).toBeUndefined()
  expect(result.assertions ?? []).toEqual([])
  expect(writes.join("")).toContain("\x1b[?1016l")
  expect(writes.join("")).toContain("\x1b[?1000l")
  expect(writes.join("")).toContain("\x1b[?1006l")
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
    backendName: "scripted-model",
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
    noObservable: "adapter binding scripted-model: mouse-encoding extension unavailable",
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
    backendName: "scripted-model",
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
    noObservable: "adapter binding scripted-model: mouse-encoding extension unavailable",
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
    backendName: "scripted-model",
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
    noObservable: "adapter binding scripted-model: mouse-encoding extension unavailable",
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
  const { ctx, clicks } = inputAndRead({ clickReports: ["\x1b[<0;10;5M", "", "\x1b[<0;10;5M"] }, writes)
  const result = await probe("input.kitty-click-events").term!(ctx)
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "input_bytes" })
  expect(result.assertions).toEqual([expect.objectContaining({ kind: "positive", action: "kitty-click-events:1" })])
  expect(clicks).toEqual([1, 1, 1])
  const marker = writes.find((write) => write.includes("\x1b]133;A;click_events=1"))
  expect(marker).toBe("\x1b[5;1H\x1b]133;A;click_events=1\x07$ " + " ".repeat(8))
  expect(writes.at(-1)).toContain("\x1b]133;B\x07\x1b[5;1H\x1b[2K")
  expect(writes.some((write) => write.includes("\x1b[?1049h"))).toBe(false)
})

// A matching generic mouse report is not evidence that the marked prompt owns the event.
// The existing coordinate-mismatch control cannot catch a mouse mode that keeps reporting.
test("input.kitty-click-events rejects ordinary mouse reports before the prompt is marked", async () => {
  const { ctx } = inputAndRead({ clicks: { 1: "\x1b[<0;10;5M" } }, [])
  const result = await probe("input.kitty-click-events").term!(ctx)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    assertionType: "input_bytes",
  })
  expect(result.assertions).toBeUndefined()
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
  const { ctx } = inputAndRead({ clickReports: ["\x1b[<0;10;5M", "", "\x1b[<2;30;9M"] }, [])
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
    backendName: "scripted-model",
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

// @cto cac2b8dc K3: a shared-encoder adapter returns its coverage placeholder before encodeMouse.
test.each([
  [
    "ghostty",
    "not-tested",
    "shared core encoder carries no prompt state; ghostty WASM core 5714ed07 parses OSC 133 A click_events at src/terminal/osc.zig:1535-1554 into prompt_start.click_events (:74), while the WASM binding does not forward click_events (termless 2719cfd ghostty-wasm-api.patch:624-627) and a headless library run has no pointer surface; #30936",
  ],
  // A former source-negative site: PROBE TODO with no same-path control, never a source citation (#32246).
  ["alacritty", "not-tested", "observation not decided: no same-path control in this run"],
  // A former source-negative site: PROBE TODO with no same-path control, never a source citation (#32246).
  ["vt100-rust", "not-tested", "observation not decided: no same-path control in this run"],
  ["xtermjs", "unsupported", null],
] as const)(
  "input.kitty-click-events library arm on %s: shared-encoder limit reads %s",
  (backendName, expected, noObservable) => {
    let modesOn = false
    const base = libMouseSource({
      encodeMouse: (event) =>
        modesOn ? sgrBytes(0, event.x + 1, event.y + 1, event.action === "release" ? "m" : "M") : null,
    })
    const ctx: LibProbeSource = {
      ...base,
      backendName,
      feed(text: string) {
        if (text.includes("?1000h")) modesOn = true
        if (text.includes("?1000l")) modesOn = false
      },
    }
    const result = probe("input.kitty-click-events").lib!(ctx)
    if (expected === "not-tested") {
      expect(result).toEqual({
        pass: false,
        response: JSON.stringify({ storedClickEvents: false }),
        note: noObservable,
        notTested: { reason: "no-semantic-observable", noObservable },
      })
    } else {
      expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "input_bytes" })
      expect(result.assertions?.[0]).toMatchObject({ kind: "negative", action: "kitty-click-events:1" })
    }
  },
)

// #32246 (operator 2026-11-03): the auditedOscEngine qualification is gone. An identity that once qualified a review
// branch (@cto bbf6f77f) now reads the same PROBE TODO record as a stale one; no source review is pended.
const qualifiedSharedEncoderIdentities = [
  [
    "ghostty",
    "ghostty WASM core 5714ed07 parses OSC 133 A click_events at src/terminal/osc.zig:1535-1554",
    {
      kind: "js",
      runtimeFormat: "wasm",
      engineVersion: "0.4.0",
      adapterVersion: "0.10.2",
      termlessRevision: "f736cce493439cf9d651297c2a920cb61fa05fb5",
      resolvedPath: "/fixture/ghostty/index.js",
      integrity: {
        kind: "source",
        repository: "git@github.com:beorn/termless.git",
        revision: "f736cce493439cf9d651297c2a920cb61fa05fb5",
        treeOid: "d5302357ba7d86ae224d0b72acefb045e2fe5d81",
        cleanTree: true,
      },
      loadedBinary: {
        path: "/fixture/ghostty.wasm",
        sha256: "3c2398d5c537d9c10e86b0af69311977927fcdbe4738618df194cedbdd22574d",
      },
      adapterSources: [
        { path: "packages/ghostty/src/index.ts", blobOid: "f4b9d9f3e13cc515b23abc739cab21bf971e8585" },
        { path: "packages/ghostty/src/backend.ts", blobOid: "560146d5f929f31a8f973f809d97f91cf0e23fd6" },
      ],
    },
    {
      loadedBinary: { sha256: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f" },
    },
  ],
  [
    "alacritty",
    "alacritty_terminal 0.26.0",
    {
      kind: "native",
      engineVersion: "0.26.0",
      adapterVersion: "0.10.2",
      termlessRevision: "2f73fc28027b7d483e504e08edc64d1837935816",
      loadedBinary: {
        path: "/relocated/alacritty.node",
        sha256: "9839e138d9e6f13e84adc3022f67964f0451e2e6416294952e22286412994f61",
      },
      provenance: {
        sha256: "9839e138d9e6f13e84adc3022f67964f0451e2e6416294952e22286412994f61",
        sourceCommit: "2f73fc28027b7d483e504e08edc64d1837935816",
        buildHash: "343c00e0db2bed851505ada4645b7b667ab78a0485a4ca71f9eaa4e5d8dead39",
        lockSha256: "1f89f2579b7d786a116d8fefb8267c4af076bd3a3893adcf14b00c4466740497",
        toolchain: "retained build receipt",
      },
      adapterSources: [
        { path: "packages/alacritty/src/index.ts", blobOid: "b4154cbd6ef4a83ce2cbf3dcf26ff13d645efd05" },
        { path: "packages/alacritty/src/backend.ts", blobOid: "27b78b1264cd5d2ed72705ba36c9735b29e874c5" },
        { path: "packages/alacritty/native/src/lib.rs", blobOid: "1779ff4f042f7f285ab3d396da039408b492be10" },
        { path: "src/load-native.ts", blobOid: "34e142550085450ab02138184626716ad0d6b546" },
      ],
    },
    {
      loadedBinary: { sha256: "0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e" },
      provenance: { sha256: "0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e" },
    },
  ],
  [
    "vt100-rust",
    "vt100 0.16.2",
    {
      kind: "native",
      engineVersion: "0.16.2",
      adapterVersion: "0.10.2",
      termlessRevision: "f736cce493439cf9d651297c2a920cb61fa05fb5",
      loadedBinary: {
        path: "/fixture/native",
        sha256: "84a5b6a3a40a7c16c6bae8b64534b730403df911498bb34bded68c3a17e2d408",
      },
      provenance: {
        sha256: "84a5b6a3a40a7c16c6bae8b64534b730403df911498bb34bded68c3a17e2d408",
        sourceCommit: "286fddf6632e43ccd62f9050be41ec7b2908e43e",
        buildHash: "30b232d295488042b0d6164e881e319dea8d7fae06ac766b3b568fd4832bf074",
        lockSha256: "4cf037e4efa648ca41d08b30ef5c4ce7ada29ad61fcad45a7d1aa97bf55391c6",
        toolchain: "retained build provenance",
      },
      adapterSources: [
        { path: "packages/vt100-rust/src/index.ts", blobOid: "3ddb74f3ae1f79bb356952103853232f69211268" },
        { path: "packages/vt100-rust/src/backend.ts", blobOid: "9b3477c0fedf8586430781e8f4d17019569af98b" },
      ],
    },
    {
      loadedBinary: { sha256: "0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d" },
      provenance: { sha256: "0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d" },
    },
  ],
] as const

test.each(qualifiedSharedEncoderIdentities)(
  "input.kitty-click-events library arm on %s: a formerly qualified identity (%s) and a stale one read the same PROBE TODO",
  (backendName, citationMarker, identity, stale) => {
    let modesOn = false
    const source = (runtimeIdentity: unknown): LibProbeSource => {
      const base = libMouseSource({
        encodeMouse: (event) =>
          modesOn ? sgrBytes(0, event.x + 1, event.y + 1, event.action === "release" ? "m" : "M") : null,
      })
      return {
        ...base,
        backendName,
        runtimeIdentity,
        feed(text: string) {
          if (text.includes("?1000h")) modesOn = true
          if (text.includes("?1000l")) modesOn = false
        },
      } as LibProbeSource
    }

    const formerlyQualified = probe("input.kitty-click-events").lib!(source({ ...identity }))
    const staleResult = probe("input.kitty-click-events").lib!(source({ ...identity, ...stale }))
    for (const result of [formerlyQualified, staleResult]) {
      expect(result.criterionBranch, backendName).toBeUndefined()
      expect(result.tests, backendName).toBeUndefined()
      expect(result.observation, backendName).toBeUndefined()
      expect(result.notTested?.reason).toBe("no-semantic-observable")
      expect(result.response).toBe(JSON.stringify({ storedClickEvents: false }))
    }
    expect(staleResult).toEqual(formerlyQualified)
    // Ghostty keeps its shared-encoder coverage limit; the former source-negative engines name no citation.
    if (backendName === "ghostty") expect(formerlyQualified.note).toContain(citationMarker)
    else expect(formerlyQualified.note).toBe("observation not decided: no same-path control in this run")
  },
)

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

// @failure A vterm input cell is graded from a source audit, or its outcome depends on source provenance (#32246).
// @consumer The four registered library callbacks; existing app and foreign mouse paths stay covered above.
// Every vterm identity, exact or drifted, reads the same PROBE TODO record: no same-path control in this run.
test.each(
  ["input.modify-other-keys", "input.modify-other-keys-3", "input.xtest-key", "input.kitty-click-events"].flatMap(
    (id) =>
      ["exact", "drift", "dirty", "foreign", "moved-path", "other-version", "other-format"].map(
        (identityCase) => [id, identityCase] as const,
      ),
  ),
)("%s keeps the %s vterm identity PROBE TODO, never source-graded", (id, identityCase) => {
  const runtimeIdentity = {
    kind: "js",
    ...(identityCase === "other-format"
      ? { runtimeFormat: "wasm" as const, loadedBinary: { path: "fixture.wasm", sha256: "0".repeat(64) } }
      : { runtimeFormat: "js" as const }),
    engineVersion: identityCase === "other-version" ? "unreviewed" : "0.10.1",
    adapterVersion: "0.10.2",
    termlessRevision: "a871f0e580e1b02fb5dbb7ed854f6de623e7858e",
    resolvedPath: identityCase === "moved-path" ? "other/vterm/index.ts" : "vendor/vterm/packages/vterm/src/index.ts",
    integrity: {
      kind: "source",
      repository: identityCase === "foreign" ? "git@example.test:foreign/engine.git" : "git@github.com:beorn/vterm.git",
      revision: "67dd3960746766ed47e2bb4b2ced6503a78549cc",
      treeOid: identityCase === "drift" ? "0".repeat(40) : "e9d67d4b4ba7cb4caf0d0824b3b272c10e4b229e",
      cleanTree: identityCase !== "dirty",
    },
  } as const satisfies NonNullable<LibProbeSource["runtimeIdentity"]>
  const source = { ...libMouseSource({ extensions: [] }), backendName: "vterm", runtimeIdentity }
  const result = probe(id).lib!(source)
  expect(result).toEqual({
    pass: false,
    response: JSON.stringify(id === "input.kitty-click-events" ? { storedClickEvents: false } : { input: false }),
    note: "observation not decided: no same-path control in this run",
    notTested: {
      reason: "no-semantic-observable",
      noObservable: "observation not decided: no same-path control in this run",
    },
  })
})
