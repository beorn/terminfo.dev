/**
 * @failure OSC 52 write readback raced the terminal's processing of the same TTY stream, or OS
 *   clipboard paste is graded without a clipboard fixture, XTEST paste chord, delivery control, or
 *   bracketed-vs-raw encoding.
 * @level l0
 * @consumer Owned live clipboard probe callbacks and OS-level paste injection.
 * @testonly none
 */
import { describe, expect, test } from "vitest"
import {
  ALL_PROBES,
  type ClipboardFixture,
  type LibProbeSource,
  type ProbeCallbackResult,
  type TermProbeSource,
} from "./index.ts"
import { recordExecutedProbe, withReplyFailureEvidence } from "./helpers.ts"

function writeProbe() {
  const probe = ALL_PROBES.find((item) => item.id === "extensions.osc52-write")
  if (!probe?.term) throw new Error("OSC 52 write callback is missing")
  return probe.term
}

function termSource(overrides: Partial<TermProbeSource>): TermProbeSource {
  return {
    kind: "live",
    write() {},
    queryCursorPosition: async () => ({ row: 1, col: 1 }),
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
    query: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinel: async () => null,
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
    cols: 80,
    rows: 24,
    ...overrides,
  }
}

function writtenNonce(sequence: string): string {
  const match = /\x1b\]52;c;([^\x07]+)\x07/.exec(sequence)
  if (!match?.[1]) throw new Error("Expected OSC 52 write frame")
  return atob(match[1])
}

describe("live OSC 52 write ordering", () => {
  test("independent read follows a correlated TTY processing checkpoint", async () => {
    const events: string[] = []
    let clipboard = "baseline"
    let queued = ""
    const fixture: ClipboardFixture = {
      readText: async () => {
        events.push("independent-read")
        return clipboard
      },
      writeText: async (text) => {
        clipboard = text
      },
    }
    const result = await writeProbe()(
      termSource({
        write(sequence) {
          events.push("osc-write")
          queued = writtenNonce(sequence)
        },
        queryCursorPosition: async () => {
          events.push("cpr")
          clipboard = queued
          return { row: 1, col: 1 }
        },
        withClipboardFixture: async (work) => {
          try {
            return await work(fixture)
          } finally {
            clipboard = "baseline"
            events.push("restore")
          }
        },
      }),
    )
    expect(events).toEqual(["osc-write", "cpr", "independent-read", "restore"])
    expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "clipboard" })
    expect(result.assertions?.[0]?.observed).toBe(queued)
    expect(clipboard).toBe("baseline")
  })

  test("a terminal that answers CPR but ignores OSC 52 remains inconclusive", async () => {
    const events: string[] = []
    const result = await writeProbe()(
      termSource({
        write(sequence) {
          writtenNonce(sequence)
          events.push("osc-write")
        },
        queryCursorPosition: async () => {
          events.push("cpr")
          return { row: 1, col: 1 }
        },
        withClipboardFixture: async (work) =>
          work({
            readText: async () => {
              events.push("independent-read")
              return "baseline"
            },
            writeText: async () => {},
          }),
      }),
    )
    expect(events).toEqual(["osc-write", "cpr", "independent-read"])
    expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(result.assertions).toBeUndefined()
  })

  test.each(["extensions.osc52-write", "extensions.osc52-clipboard"])(
    "%s retains missing CPR evidence without reading clipboard and restores the fixture",
    async (id) => {
      const events: string[] = []
      let clipboard = "baseline"
      const callback = ALL_PROBES.find((item) => item.id === id)?.term
      if (!callback) throw new Error(`Missing clipboard callback ${id}`)
      const result = await callback(
        termSource({
          write(sequence) {
            clipboard = writtenNonce(sequence)
            events.push("osc-write")
          },
          queryCursorPosition: async () => {
            events.push("cpr-missing")
            return null
          },
          withClipboardFixture: async (work) => {
            try {
              return await work({
                readText: async () => {
                  events.push("independent-read")
                  return clipboard
                },
                writeText: async (text) => {
                  clipboard = text
                },
              })
            } finally {
              clipboard = "baseline"
              events.push("restore")
            }
          },
        }),
      )
      expect(events).toEqual(["osc-write", "cpr-missing", "restore"])
      expect(result.observation).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      expect(result).toHaveProperty("replyFailureTestIds", ["criterion"])
      expect(result.tests).toMatchObject([
        expect.objectContaining({
          status: "probe-invalid",
          reason: expect.stringContaining(
            "no parsable cursor position reply; the public projection returned null and retained no bytes",
          ),
        }),
      ])
      const evidence = withReplyFailureEvidence(id, result, {
        producer: "TTY",
        attempts: [{ sequence: "\x1b[6n", received: "\x1b?", timeoutMs: 37, match: null, reason: "timeout" }],
      })
      const stored = recordExecutedProbe({
        featureId: id,
        tests: evidence.tests,
        assertions: [],
        attempt: { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" },
      })
      expect(stored.status).toBe("probe-invalid")
      expect(stored.reason).toContain('sent "\\u001b[6n"; received "\\u001b?"; timeout 37 ms')
      expect(stored).not.toHaveProperty("replyFailureTestIds")
      expect(clipboard).toBe("baseline")
    },
  )
})

function pasteProbe() {
  const probe = ALL_PROBES.find((item) => item.id === "extensions.clipboard-paste")
  if (!probe?.term || !probe.lib) throw new Error("Missing extension callbacks for extensions.clipboard-paste")
  return probe
}

function pasteTerm(overrides: Partial<TermProbeSource> = {}): TermProbeSource {
  return termSource({
    queryCursorPosition: async () => {
      throw new Error("Unexpected queryCursorPosition in paste observation")
    },
    query: async () => {
      throw new Error("Unexpected query in paste observation")
    },
    queryOutcome: async () => {
      throw new Error("Unexpected queryOutcome in paste observation")
    },
    queryWithSentinel: async () => {
      throw new Error("Unexpected queryWithSentinel in paste observation")
    },
    queryWithSentinelOutcome: async () => {
      throw new Error("Unexpected queryWithSentinelOutcome in paste observation")
    },
    queryMode: async () => {
      throw new Error("Unexpected queryMode in paste observation")
    },
    ...overrides,
  })
}

function pasteAndRead(
  script: { control?: string | null; paste?: "bracketed" | "raw" | "silent" },
  writes: string[] = [],
): { ctx: TermProbeSource; keys: string[]; clipboardWrites: string[] } {
  const keys: string[] = []
  const clipboardWrites: string[] = []
  let clipboard = ""
  const pending: string[] = []
  let listening = false
  const ctx = pasteTerm({
    write(text) {
      writes.push(text)
    },
    withClipboardFixture: async (work) =>
      work({
        readText: async () => clipboard,
        writeText: async (text) => {
          clipboard = text
          clipboardWrites.push(text)
        },
      }),
    input: {
      async injectKey(key) {
        if (!listening) throw new Error("XTEST inject before stdin listen")
        keys.push(key)
        if (key === "a") {
          if (script.control !== null && script.control !== undefined) pending.push(script.control)
          else if (script.control === undefined) pending.push("a")
          return
        }
        // X11 PRIMARY and CLIPBOARD are distinct; the fixture seeds only CLIPBOARD.
        const pasted = key === "ctrl+shift+v" ? clipboard : key === "shift+Insert" ? "primary-selection-control" : null
        if (pasted !== null) {
          if (script.paste === "bracketed") pending.push(`\x1b[200~${pasted}\x1b[201~`)
          else if (script.paste === "raw") pending.push(pasted)
        }
      },
      async injectClick() {
        throw new Error("Unexpected injectClick in paste observation")
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
  return { ctx, keys, clipboardWrites }
}

test("extensions.clipboard-paste keeps missing native paste encoding PROBE TODO while apps still need XTEST", async () => {
  const definition = pasteProbe()
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
  // CTO 8baca152: adapter absence does not authorize Untestable; those claims need
  // the operator's separate approval. The app arm retains its independent XTEST prerequisite.
  expect(headless.tests).toEqual([
    expect.objectContaining({ status: "probe-todo", reason: expect.stringMatching(/paste-encoding.*unavailable/i) }),
  ])
  expect(headless.notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable: expect.stringMatching(/paste-encoding.*unavailable/i),
  })
  expect(headless.observation).toBeUndefined()

  const result = await definition.term!(
    pasteTerm({
      write: (text) => writes.push(text),
      withClipboardFixture: async (work) =>
        work({
          readText: async () => {
            throw new Error("clipboard should not run without XTEST")
          },
          writeText: async () => {
            throw new Error("clipboard should not run without XTEST")
          },
        }),
    }),
  )
  expect(writes).toEqual([])
  expect(result.notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable: expect.stringMatching(/XTEST|OS-level|paste/i),
  })
  expect(result.observation).toBeUndefined()
})

test("extensions.clipboard-paste is not tested without an owned clipboard fixture", async () => {
  const writes: string[] = []
  const result = await pasteProbe().term!(
    pasteTerm({
      write: (text) => writes.push(text),
      input: { injectKey: async () => {}, injectClick: async () => {} },
      readInput: async () => {
        throw new Error("readInput should not run without a clipboard fixture")
      },
    }),
  )
  expect(writes).toEqual([])
  expect(result.notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable: expect.stringMatching(/clipboard/i),
  })
  expect(result.observation).toBeUndefined()
})

test("extensions.clipboard-paste aborts when the plain-a control does not reach the app, and does not enable 2004 or paste", async () => {
  const writes: string[] = []
  const { ctx, keys, clipboardWrites } = pasteAndRead({ control: null }, writes)
  await expect(pasteProbe().term!(ctx)).rejects.toThrow(/delivery control|plain a/i)
  expect(keys).toEqual(["a"])
  expect(clipboardWrites).toEqual([])
  expect(writes.join("")).not.toContain("\x1b[?2004h")
  expect(writes.join("")).not.toContain("\x1b]52;")
})

test("extensions.clipboard-paste reads the seeded CLIPBOARD rather than the distinct PRIMARY selection", async () => {
  const writes: string[] = []
  const { ctx, clipboardWrites } = pasteAndRead({ paste: "bracketed" }, writes)
  const result = (await pasteProbe().term!(ctx)) as ProbeCallbackResult
  expect(clipboardWrites).toHaveLength(1)
  const nonce = clipboardWrites[0] ?? ""
  expect(nonce.length).toBeGreaterThan(0)
  expect(writes.join("")).toContain("\x1b[?2004h")
  expect(writes.join("")).toContain("\x1b[?2004l")
  expect(writes.join("")).not.toContain("\x1b]52;")
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "input_bytes" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "clipboard-paste:ctrl+shift+v" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({
    mode: "clipboard-paste",
    control: "a",
    report: `\x1b[200~${nonce}\x1b[201~`,
  })
})

test("extensions.clipboard-paste records unsupported interaction when paste arrives as the raw nonce", async () => {
  const writes: string[] = []
  const { ctx, keys, clipboardWrites } = pasteAndRead({ paste: "raw" }, writes)
  const result = (await pasteProbe().term!(ctx)) as ProbeCallbackResult
  expect(keys).toEqual(["a", "ctrl+shift+v"])
  const nonce = clipboardWrites[0] ?? ""
  expect(writes.join("")).toContain("\x1b[?2004h")
  expect(writes.join("")).toContain("\x1b[?2004l")
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "input_bytes" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "negative", action: "clipboard-paste:ctrl+shift+v" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ mode: "clipboard-paste", control: "a", report: nonce })
})

test("extensions.clipboard-paste throws when paste is silent after delivery control, and still resets 2004", async () => {
  const writes: string[] = []
  const { ctx, keys } = pasteAndRead({ paste: "silent" }, writes)
  await expect(pasteProbe().term!(ctx)).rejects.toThrow(/paste|silent/i)
  expect(keys).toEqual(["a", "ctrl+shift+v"])
  expect(writes.join("")).toContain("\x1b[?2004h")
  expect(writes.join("")).toContain("\x1b[?2004l")
  expect(writes.join("")).not.toContain("\x1b]52;")
})

// Native encoder observations must distinguish framing support from a dead or malformed actuator.
function nativePasteModel(
  options: {
    initial?: boolean
    supports?: boolean
    sample?: (text: string, call: number, enabled: boolean) => string
  } = {},
) {
  let enabled = options.initial ?? false
  const feeds: string[] = []
  const calls: { text: string; enabled: boolean; raw: string }[] = []
  const ctx = {
    backendName: "scripted-model",
    getMode(mode: string) {
      if (mode !== "bracketedPaste") throw new Error(`Unexpected mode ${mode}`)
      return enabled
    },
    feed(sequence: string) {
      feeds.push(sequence)
      if (sequence === "\x1b[?2004h") enabled = true
      else if (sequence === "\x1b[?2004l") enabled = false
      else throw new Error(`Unexpected paste stimulus ${JSON.stringify(sequence)}`)
    },
    encodePaste(text: string) {
      const call = calls.length
      const raw =
        options.sample?.(text, call, enabled) ??
        (enabled && options.supports !== false ? `\x1b[200~${text}\x1b[201~` : text)
      calls.push({ text, enabled, raw })
      return new TextEncoder().encode(raw)
    },
  } as LibProbeSource
  return { ctx, feeds, calls, enabled: () => enabled }
}

describe("native clipboard paste encoding", () => {
  test.each([false, true])("qualifies framing and restores incoming 2004=%s", (initial) => {
    const model = nativePasteModel({ initial })
    const result = pasteProbe().lib!(model.ctx)
    expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "input_bytes" })
    expect(model.calls.map((call) => call.enabled)).toEqual([initial, false, false, true, true, initial])
    expect(new Set(model.calls.map((call) => call.text)).size).toBe(6)
    expect(model.feeds).toEqual(["\x1b[?2004l", "\x1b[?2004h", initial ? "\x1b[?2004h" : "\x1b[?2004l"])
    expect(model.enabled()).toBe(initial)
    const evidence = JSON.parse(result.response!) as {
      samples: Array<{ raw: string; bytes: number[] }>
      calls: Array<{ method: string; input: string }>
    }
    expect(evidence.samples).toHaveLength(6)
    expect(evidence.samples.map((sample: { raw: string }) => sample.raw)).toEqual(model.calls.map((call) => call.raw))
    expect(evidence.samples.map((sample: { bytes: number[] }) => sample.bytes)).toEqual(
      model.calls.map((call) => Array.from(new TextEncoder().encode(call.raw))),
    )
    expect(
      evidence.calls
        .filter((call: { method: string }) => call.method === "encodePaste")
        .map((call: { input: string }) => call.input),
    ).toEqual(model.calls.map((call) => call.text))
    expect(result.assertions?.[0]?.kind).toBe("positive")
  })

  test("qualified raw output is unsupported and is sensitive to the disabled feature", () => {
    const model = nativePasteModel({ supports: false })
    const result = pasteProbe().lib!(model.ctx)
    expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "input_bytes" })
    expect(result.assertions?.[0]?.kind).toBe("negative")
    expect(model.calls).toHaveLength(6)
    expect(model.calls.every((call) => call.raw === call.text)).toBe(true)
  })

  test("raw-only encoder preserves an incoming enabled mode", () => {
    const model = nativePasteModel({ initial: true, supports: false })
    const result = pasteProbe().lib!(model.ctx)
    expect(result.observation?.outcome).toBe("unsupported")
    expect(model.enabled()).toBe(true)
    expect(model.feeds.at(-1)).toBe("\x1b[?2004h")
    expect(model.calls.at(-1)?.enabled).toBe(true)
  })

  test("unknown actual mode readback never mutates state or grades raw output", () => {
    const model = nativePasteModel({ initial: true, supports: false })
    model.ctx.getMode = () => null
    const result = pasteProbe().lib!(model.ctx)
    expect(result.observation?.outcome).toBe("inconclusive")
    expect(result.assertions).toBeUndefined()
    expect(model.feeds).toEqual([])
    expect(model.enabled()).toBe(true)
  })

  test.each(["initial", "off", "on"] as const)("%s malformed or silent output never becomes unsupported", (phase) => {
    for (const raw of ["", "\x1b[200~wrong\x1b[201~"]) {
      const model = nativePasteModel({
        sample: (text, call, enabled) =>
          call === ({ initial: 0, off: 1, on: 3 }[phase] ?? -1) ? raw : enabled ? `\x1b[200~${text}\x1b[201~` : text,
      })
      const result = pasteProbe().lib!(model.ctx)
      expect(result.observation?.outcome).not.toBe("unsupported")
      expect(result.assertions).toBeUndefined()
      expect(result.response).toContain(JSON.stringify(raw).slice(1, -1))
      expect(model.enabled()).toBe(false)
      if (phase === "initial") expect(model.feeds).toEqual([])
    }
  })

  test("both raw controls must qualify before enabled samples", () => {
    const model = nativePasteModel({
      sample: (text, call, enabled) => (call === 2 ? "bad-control" : enabled ? `\x1b[200~${text}\x1b[201~` : text),
    })
    const result = pasteProbe().lib!(model.ctx)
    expect(result.assertions).toBeUndefined()
    expect(model.calls.map((call) => call.enabled)).toEqual([false, false, false, false])
    expect(model.feeds).toEqual(["\x1b[?2004l", "\x1b[?2004l"])
  })

  test("restoration mismatch is a loud failure", () => {
    const model = nativePasteModel({
      sample: (text, call, enabled) => (call === 5 ? "restore-broken" : enabled ? `\x1b[200~${text}\x1b[201~` : text),
    })
    expect(() => pasteProbe().lib!(model.ctx)).toThrow(/restor/i)
  })

  test("primary encoder failure and restoration failure are both preserved", () => {
    const model = nativePasteModel()
    const original = model.ctx.encodePaste!
    let call = 0
    model.ctx.encodePaste = (text) => {
      call++
      if (call === 2) throw new Error("primary paste failure")
      if (call === 3) throw new Error("cleanup paste failure")
      return original(text)
    }
    try {
      pasteProbe().lib!(model.ctx)
      throw new Error("Expected aggregate failure")
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors.map((item: Error) => item.message)).toEqual([
        "primary paste failure",
        "cleanup paste failure",
      ])
    }
  })
})
