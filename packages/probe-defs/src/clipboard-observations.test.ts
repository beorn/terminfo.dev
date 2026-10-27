/**
 * @failure OSC 52 write readback raced the terminal's processing of the same TTY stream, or OS
 *   clipboard paste is graded without a clipboard fixture, XTEST paste chord, delivery control, or
 *   bracketed-vs-raw encoding.
 * @level l0
 * @consumer Owned live clipboard probe callbacks and OS-level paste injection.
 * @testonly none
 */
import { describe, expect, test } from "vitest"
import { ALL_PROBES, type ClipboardFixture, type ProbeCallbackResult, type TermProbeSource } from "./index.ts"

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
    measureRenderedWidth: async () => null,
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

  test("missing CPR cannot authorize a positive read and still restores the owned fixture", async () => {
    const events: string[] = []
    let clipboard = "baseline"
    const result = await writeProbe()(
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
    expect(result.tests).toMatchObject([
      expect.objectContaining({
        status: "test-failure",
        reason: "No cursor reply after OSC 52 write; clipboard contents were not measured",
      }),
    ])
    expect(clipboard).toBe("baseline")
  })
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

test("extensions.clipboard-paste is not tested without an OS XTEST adapter", async () => {
  const definition = pasteProbe()
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
    noObservable: expect.stringMatching(/XTEST|OS-level|paste|clipboard/i),
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
