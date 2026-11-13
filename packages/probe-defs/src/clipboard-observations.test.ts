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
  type PasteRoute,
  type ProbeCallbackResult,
  type TermProbeSource,
} from "./index.ts"
import { recordExecutedProbe, withReplyFailureEvidence } from "./helpers.ts"
import { createSemanticSurface } from "./testing/semantic-surface.ts"

// routes-16 row 1 (32472): vt100 0.16.2 keeps no clipboard and hands the read to paste_from_clipboard,
// so the only witness is the backend's paste selector changing on this run's read.
const CLIPBOARD_HANDOFF_REASON =
  "Untestable (passed to the app): the library sent no reply and handed this read to the app through its clipboard callback, seen in this run."

function clipboardHandoffSource(options: {
  readonly selection: "absent-to-c" | "absent-to-p" | "always-c" | "never-set"
  readonly replies?: boolean
  readonly silence?: "sentinel" | "timeout" | "timeout-with-bytes"
}) {
  let selector: string | undefined = options.selection === "always-c" ? "c" : undefined
  let asked = 0
  const source = {
    feed: () => undefined,
    feedCapture: () => "",
    queryWithSentinelOutcome: () => {
      asked += 1
      if (options.selection === "absent-to-c") selector = "c"
      if (options.selection === "absent-to-p") selector = "p"
      return options.replies
        ? {
            match: ["\x1b]52;c;dGVybWxlYXNz"],
            reason: "reply" as const,
            raw: "\x1b]52;c;dGVybWxlYXNz\x07",
            rawBase64: "",
            sentinel: { atMs: 3, graceMs: 250 },
          }
        : {
            match: null,
            reason: options.silence?.startsWith("timeout") ? ("timeout" as const) : ("sentinel" as const),
            raw:
              options.silence === "timeout"
                ? ""
                : options.silence === "timeout-with-bytes"
                  ? "partial"
                  : "\x1b[?62;22c",
            rawBase64: "",
            sentinel: { atMs: 3, graceMs: 250 },
          }
    },
    getClipboardState: () => ({ writes: [], ...(selector === undefined ? {} : { pasteSelector: selector }) }),
  } as unknown as LibProbeSource
  return { source, asked: () => asked }
}

// R3: an observed typed request remains a handoff when the app-owned DA1 sentinel never answers.
test.each(
  ["extensions.osc52-read", "extensions.osc52-clipboard"].flatMap((id) =>
    (["sentinel", "timeout"] as const).map((silence) => [id, silence] as const),
  ),
)("%s reads passed to the app on %s when the engine's own paste selector goes absent -> c", (id, silence) => {
  const callback = ALL_PROBES.find((item) => item.id === id)!.lib!
  const handoff = clipboardHandoffSource({ selection: "absent-to-c", silence })
  const result = callback(handoff.source)
  expect(handoff.asked()).toBeGreaterThan(0)
  expect(result.tests?.[0]).toMatchObject({ status: "untestable", reason: CLIPBOARD_HANDOFF_REASON })
  // Only the absent -> c movement witnesses the handoff: already set, never set, another selector and
  // an engine that answers all keep the existing verdict.
  for (const control of [
    clipboardHandoffSource({ selection: "always-c", silence }).source,
    clipboardHandoffSource({ selection: "never-set", silence }).source,
    clipboardHandoffSource({ selection: "absent-to-p", silence }).source,
    clipboardHandoffSource({ selection: "absent-to-c", replies: true, silence }).source,
    clipboardHandoffSource({ selection: "absent-to-c", silence: "timeout-with-bytes" }).source,
  ]) {
    expect(callback(control).tests?.[0]?.status, id).not.toBe("untestable")
  }
})

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
      baseline: "baseline",
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

  test("a fixture that returns baseline twice after CPR and then the nonce decides supported", async () => {
    let queued = ""
    let reads = 0
    const result = await writeProbe()(
      termSource({
        write(sequence) {
          queued = writtenNonce(sequence)
        },
        queryCursorPosition: async () => ({ row: 1, col: 1 }),
        withClipboardFixture: async (work) =>
          work({
            baseline: "baseline",
            writeDeadlineMs: 100,
            writePollMs: 5,
            readText: async () => {
              reads += 1
              return reads <= 2 ? "baseline" : queued
            },
            writeText: async () => {},
          }),
      }),
    )
    expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "clipboard" })
    expect(reads).toBe(3)
    expect(result.assertions).toEqual([
      {
        assertionType: "clipboard",
        kind: "positive",
        expected: "Independent clipboard text equals OSC 52 write nonce",
        observed: queued,
      },
    ])
  })

  test("a terminal that answers CPR and leaves the owned baseline unchanged through the deadline decides write unsupported while roundtrip remains inconclusive", async () => {
    const events: string[] = []
    let reads = 0
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
            baseline: "baseline",
            writeDeadlineMs: 25,
            writePollMs: 5,
            readText: async () => {
              reads += 1
              events.push("independent-read")
              return "baseline"
            },
            writeText: async () => {},
          }),
      }),
    )
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(events.slice(0, 2)).toEqual(["osc-write", "cpr"])
    expect(events.slice(2).every((event) => event === "independent-read")).toBe(true)
    expect(result.observation).toMatchObject({
      outcome: "unsupported",
      assertionType: "clipboard",
      note: "OSC 52 bytes went to the run's own session PTY and the selection still held the run's own sentinel unchanged through the post-CPR deadline: the application did not write under this configuration",
    })
    expect(result.assertions).toEqual([
      {
        assertionType: "clipboard",
        kind: "negative",
        expected: "Independent clipboard text equals OSC 52 write nonce",
        observed: "baseline",
      },
    ])

    const roundtripEvents: string[] = []
    const roundtripCallback = ALL_PROBES.find((item) => item.id === "extensions.osc52-clipboard")?.term
    if (!roundtripCallback) throw new Error("OSC 52 roundtrip callback is missing")
    const roundtripResult = await roundtripCallback(
      termSource({
        write(sequence) {
          writtenNonce(sequence)
          roundtripEvents.push("osc-write")
        },
        queryCursorPosition: async () => {
          roundtripEvents.push("cpr")
          return { row: 1, col: 1 }
        },
        withClipboardFixture: async (work) =>
          work({
            baseline: "baseline",
            writeDeadlineMs: 25,
            writePollMs: 5,
            readText: async () => {
              roundtripEvents.push("independent-read")
              return "baseline"
            },
            writeText: async () => {},
          }),
      }),
    )
    expect(roundtripEvents.slice(0, 2)).toEqual(["osc-write", "cpr"])
    expect(roundtripResult.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(roundtripResult.assertions).toBeUndefined()
  })

  test("mux OSC 52 read and roundtrip decide unsupported on sentinel silence and unchanged baseline only under default set-clipboard", async () => {
    const readCallback = ALL_PROBES.find((item) => item.id === "extensions.osc52-read")?.term
    const roundtripCallback = ALL_PROBES.find((item) => item.id === "extensions.osc52-clipboard")?.term
    if (!readCallback || !roundtripCallback) throw new Error("OSC 52 callbacks are missing")

    for (const mux of ["tmux", "screen"] as const) {
      const sentinelCalls: string[] = []
      const readResult = await readCallback(
        termSource({
          mux,
          capture: async () => {
            throw new Error("mux sentinel read must not capture a desktop prompt screenshot")
          },
          queryWithSentinelOutcome: async (sequence) => {
            sentinelCalls.push(sequence)
            return {
              raw: "\x1b[?1;2c",
              rawBase64: Buffer.from("\x1b[?1;2c").toString("base64"),
              match: null,
              reason: "sentinel",
            }
          },
          withClipboardFixture: async (work) =>
            work({
              baseline: "baseline",
              ...(mux === "tmux" && { tmuxSetClipboard: "external" }),
              readText: async () => "baseline",
              writeText: async () => {},
            }),
        }),
      )
      expect(sentinelCalls).toEqual(["\x1b]52;c;?\x07"])
      expect(readResult.observation).toMatchObject({
        outcome: "unsupported",
        assertionType: "query_reply",
        note: expect.stringContaining(mux === "tmux" ? "set-clipboard=external" : "mux=screen"),
      })
      expect(readResult.assertions).toEqual([
        expect.objectContaining({
          assertionType: "query_reply",
          kind: "negative",
        }),
      ])

      const roundtripResult = await roundtripCallback(
        termSource({
          mux,
          write(sequence) {
            writtenNonce(sequence)
          },
          queryCursorPosition: async () => ({ row: 1, col: 1 }),
          withClipboardFixture: async (work) =>
            work({
              baseline: "baseline",
              ...(mux === "tmux" && { tmuxSetClipboard: "external" }),
              writeDeadlineMs: 25,
              writePollMs: 5,
              readText: async () => "baseline",
              writeText: async () => {},
            }),
        }),
      )
      expect(roundtripResult.observation).toMatchObject({
        outcome: "unsupported",
        assertionType: "clipboard",
        note: expect.stringContaining(mux === "tmux" ? "set-clipboard=external" : "mux=screen"),
      })
      expect(roundtripResult.assertions).toEqual([
        expect.objectContaining({
          assertionType: "clipboard",
          kind: "negative",
          observed: "baseline",
        }),
      ])
    }

    const nonDefaultTmuxRead = await readCallback(
      termSource({
        mux: "tmux",
        queryWithSentinelOutcome: async () => ({
          raw: "\x1b[?1;2c",
          rawBase64: Buffer.from("\x1b[?1;2c").toString("base64"),
          match: null,
          reason: "sentinel",
        }),
        withClipboardFixture: async (work) =>
          work({
            baseline: "baseline",
            tmuxSetClipboard: "on",
            readText: async () => "baseline",
            writeText: async () => {},
          }),
      }),
    )
    expect(nonDefaultTmuxRead.observation).toMatchObject({
      outcome: "inconclusive",
      reason: "no-response",
      assertionType: "query_reply",
      note: expect.stringContaining("set-clipboard=on"),
    })
    expect(nonDefaultTmuxRead.assertions).toBeUndefined()

    const nonDefaultTmuxRoundtrip = await roundtripCallback(
      termSource({
        mux: "tmux",
        write(sequence) {
          writtenNonce(sequence)
        },
        queryCursorPosition: async () => ({ row: 1, col: 1 }),
        withClipboardFixture: async (work) =>
          work({
            baseline: "baseline",
            tmuxSetClipboard: "off",
            writeDeadlineMs: 25,
            writePollMs: 5,
            readText: async () => "baseline",
            writeText: async () => {},
          }),
      }),
    )
    expect(nonDefaultTmuxRoundtrip.observation).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      assertionType: "clipboard",
      note: expect.stringContaining("set-clipboard=off"),
    })
    expect(nonDefaultTmuxRoundtrip.assertions).toBeUndefined()

    const timeoutMuxRead = await readCallback(
      termSource({
        mux: "screen",
        queryWithSentinelOutcome: async () => ({
          raw: "",
          rawBase64: "",
          match: null,
          reason: "timeout",
        }),
        withClipboardFixture: async (work) =>
          work({
            baseline: "baseline",
            readText: async () => "baseline",
            writeText: async () => {},
          }),
      }),
    )
    expect(timeoutMuxRead.tests?.[0]?.status).toBe("probe-invalid")
  })

  // @cto 41cd2559 condition 5: a pasteboard that holds a value this run wrote neither as its
  // baseline nor as its payload cannot be graded - the selection is no longer attributable - so it
  // refuses the sample by name instead of reading as "did not write".
  test.each([
    {
      label: "empty",
      value: "",
      expectedLength: 0,
      expectedSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
    {
      label: "foreign text",
      value: "foreign-selection",
      expectedLength: 17,
      expectedSha256: "f09cfdf97ba152527dcb4eb9dc5341e60a589b00a40f8ab41c6d4bc39961775c",
    },
  ])(
    "$label clipboard value after CPR is probe-invalid with length and sha256",
    async ({ value, expectedLength, expectedSha256 }) => {
      let reads = 0
      const result = await writeProbe()(
        termSource({
          write(sequence) {
            writtenNonce(sequence)
          },
          queryCursorPosition: async () => ({ row: 1, col: 1 }),
          withClipboardFixture: async (work) =>
            work({
              baseline: "baseline",
              writeDeadlineMs: 100,
              writePollMs: 5,
              readText: async () => {
                reads += 1
                return value
              },
              writeText: async () => {},
            }),
        }),
      )
      expect(reads).toBe(1)
      const reason = `Independent clipboard read returned neither the OSC 52 write nonce nor the run's own baseline (length=${expectedLength}, sha256=${expectedSha256})`
      expect(result.observation).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      expect(result.tests).toEqual([{ id: "criterion", status: "probe-invalid", reason }])
    },
  )

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

/** The route the collector gives the four Ctrl+Shift+V Apps; xterm's is PRIMARY with Shift+Insert. */
const CLIPBOARD_PASTE: PasteRoute = { selection: "clipboard", key: "ctrl+shift+v", binding: "fixture binding" }
const PRIMARY_PASTE: PasteRoute = { selection: "primary", key: "shift+Insert", binding: "fixture binding" }

/** Paste tests run with the collector's default route unless a fixture names its own. */
function pasteTerm(overrides: Partial<TermProbeSource> = {}): TermProbeSource {
  const fixture = overrides.withClipboardFixture
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
    ...(fixture && {
      withClipboardFixture: (work: Parameters<typeof fixture>[0]) =>
        fixture((owned) => work({ paste: CLIPBOARD_PASTE, ...owned })),
    }),
  })
}

function pasteAndRead(
  script: {
    control?: string | null
    paste?: "controlled" | "bracketed" | "raw" | "silent"
    incomingMode?: boolean
    route?: PasteRoute
  },
  writes: string[] = [],
): { ctx: TermProbeSource; keys: string[]; clipboardWrites: string[] } {
  const keys: string[] = []
  const clipboardWrites: string[] = []
  let clipboard = ""
  let primary = "primary-selection-control"
  const seedsPrimary = script.route?.selection === "primary"
  const pending: string[] = []
  let listening = false
  const surface = createSemanticSurface({ cols: 80, rows: 24 })
  if (script.incomingMode) surface.feed("\x1b[?2004h")
  const ctx = pasteTerm({
    queryMode: async (modeNumber) => {
      if (modeNumber !== 2004) throw new Error(`Unexpected paste mode ${modeNumber}`)
      const mode = surface.getMode("bracketedPaste")
      return mode === null ? "unknown" : mode ? "set" : "reset"
    },
    write(text) {
      writes.push(text)
      surface.feed(text)
    },
    withClipboardFixture: async (work) =>
      work({
        ...(script.route && { paste: script.route }),
        readText: async () => (seedsPrimary ? primary : clipboard),
        writeText: async (text) => {
          if (seedsPrimary) primary = text
          else clipboard = text
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
        // X11 PRIMARY and CLIPBOARD are distinct: Ctrl+Shift+V pastes CLIPBOARD, Shift+Insert PRIMARY.
        const pasted = key === "ctrl+shift+v" ? clipboard : key === "shift+Insert" ? primary : null
        if (pasted !== null) {
          if (script.paste === "bracketed" || (script.paste === "controlled" && surface.getMode("bracketedPaste"))) {
            pending.push(`\x1b[200~${pasted}\x1b[201~`)
          } else if (script.paste === "controlled") pending.push(pasted)
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

// Ask 3: a mode recognition reply cannot replace the same-run paste effect.
// Reuse the owned OS clipboard fixture; the semantic terminal parses actual 2004 writes.
test.each([null, 0] as const)("App bracketed paste uses controlled effects after DECRPM %s", async (ps) => {
  const definition = ALL_PROBES.find((entry) => entry.id === "modes.bracketed-paste")
  if (!definition?.term) throw new Error("Missing App bracketed-paste callback")
  for (const [paste, expected] of [
    ["controlled", "supported"],
    ["raw", "unsupported"],
    ["bracketed", "probe-todo"],
  ] as const) {
    const { ctx } = pasteAndRead({ paste })
    const source = {
      ...ctx,
      queryWithSentinel: async (_query: string, pattern: RegExp) => (ps === 0 ? pattern.exec("\x1b[?2004;0$y") : null),
    }
    const result = await definition.term(source)
    const recorded = recordExecutedProbe({
      featureId: definition.id,
      attempt: { scope: "probe", startedAt: new Date().toISOString() },
      tests: result.tests,
      observation: result.observation ? { featureId: definition.id, ...result.observation } : undefined,
      assertions: (result.assertions ?? []).map((assertion) => ({ featureId: definition.id, ...assertion })),
    })
    expect(recorded.status, paste).toBe(expected)
    if (ps === 0 && expected === "supported") expect(result.note).toContain("Ps 0")
  }
})

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
    expect.objectContaining({
      status: "probe-todo",
      reason: expect.stringContaining("has no hook for sending pastes"),
    }),
  ])
  expect(headless.notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable: expect.stringContaining("has no hook for sending pastes"),
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

test.each(["controlled", "silent"] as const)(
  "clipboard paste restores enabled incoming mode after %s input",
  async (paste) => {
    const writes: string[] = []
    const { ctx } = pasteAndRead({ paste, incomingMode: true }, writes)
    if (paste === "silent") await expect(pasteProbe().term!(ctx)).rejects.toThrow(/paste/i)
    else await pasteProbe().term!(ctx)
    expect(await ctx.queryMode(2004)).toBe("set")
    expect(writes.at(-1)).toBe("\x1b[?2004h")
  },
)

test.each([null, "unknown"] as const)(
  "clipboard paste leaves unreadable incoming mode %s untouched",
  async (incomingMode) => {
    const writes: string[] = []
    const { ctx, keys, clipboardWrites } = pasteAndRead({ paste: "controlled" }, writes)
    ctx.queryMode = async () => incomingMode
    const result = await pasteProbe().term!(ctx)
    expect(result.notTested?.noObservable).toContain("DECRPM 2004")
    expect(writes).toEqual([])
    expect(keys).toEqual([])
    expect(clipboardWrites).toEqual([])
  },
)

test("clipboard paste on a verified disposable session sets 2004 blind when queryMode(2004) is null, restores 2004l, and still refuses unknown", async () => {
  const writes: string[] = []
  const { ctx, clipboardWrites } = pasteAndRead({ paste: "controlled" }, writes)
  const originalFixture = ctx.withClipboardFixture!
  ctx.queryMode = async () => null
  ctx.withClipboardFixture = (work) => originalFixture((fixture) => work({ ...fixture, disposableSession: true }))
  const result = await pasteProbe().term!(ctx)
  const nonce = clipboardWrites[0] ?? ""
  expect(result.observation).toMatchObject({
    outcome: "supported",
    assertionType: "input_bytes",
    note: expect.stringContaining("set blind"),
  })
  expect(writes.at(-1)).toBe("\x1b[?2004l")
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({
    mode: "clipboard-paste",
    modeSetup: "blind-disposable-2004-reset",
    report: `\x1b[200~${nonce}\x1b[201~`,
  })

  const silentWrites: string[] = []
  const silent = pasteAndRead({ paste: "silent" }, silentWrites)
  const silentOrig = silent.ctx.withClipboardFixture!
  silent.ctx.queryMode = async () => null
  silent.ctx.withClipboardFixture = (work) => silentOrig((fixture) => work({ ...fixture, disposableSession: true }))
  await expect(pasteProbe().term!(silent.ctx)).rejects.toThrow(/paste|silent/i)
  expect(silentWrites.at(-1)).toBe("\x1b[?2004l")

  const unknownWrites: string[] = []
  const unknown = pasteAndRead({ paste: "controlled" }, unknownWrites)
  const unknownOrig = unknown.ctx.withClipboardFixture!
  unknown.ctx.queryMode = async () => "unknown"
  unknown.ctx.withClipboardFixture = (work) => unknownOrig((fixture) => work({ ...fixture, disposableSession: true }))
  const unknownResult = await pasteProbe().term!(unknown.ctx)
  expect(unknownResult.notTested?.noObservable).toContain("DECRPM 2004")
  expect(unknownWrites).toEqual([])
})

test.each([null, "reset"] as const)(
  "clipboard paste rejects unverified incoming-mode restore %s",
  async (restoredMode) => {
    const { ctx } = pasteAndRead({ paste: "controlled", incomingMode: true })
    let reads = 0
    ctx.queryMode = async () => (++reads === 1 ? "set" : restoredMode)
    await expect(pasteProbe().term!(ctx)).rejects.toThrow(/restoration verification failed/)
  },
)

test("extensions.clipboard-paste reads the seeded CLIPBOARD rather than the distinct PRIMARY selection", async () => {
  const writes: string[] = []
  const { ctx, clipboardWrites } = pasteAndRead({ paste: "controlled" }, writes)
  const result = (await pasteProbe().term!(ctx)) as ProbeCallbackResult
  expect(clipboardWrites).toHaveLength(1)
  const nonce = clipboardWrites[0] ?? ""
  expect(nonce.length).toBeGreaterThan(0)
  expect(writes.join("")).toContain("\x1b[?2004h")
  expect(writes.join("")).toContain("\x1b[?2004l")
  expect(writes.join("")).not.toContain("\x1b]52;")
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "input_bytes" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "clipboard-paste:clipboard:ctrl+shift+v" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({
    mode: "clipboard-paste",
    control: "a",
    report: `\x1b[200~${nonce}\x1b[201~`,
  })
})

// #32164: xterm's default paste reads PRIMARY with Shift+Insert. The collector's route decides both; the probe
// seeds the route's selection, presses the route's key, and says so in its evidence.
test("extensions.clipboard-paste seeds and presses the route the collector chose (xterm: PRIMARY, Shift+Insert)", async () => {
  const { ctx, keys, clipboardWrites } = pasteAndRead({ paste: "controlled", route: PRIMARY_PASTE })
  const result = (await pasteProbe().term!(ctx)) as ProbeCallbackResult
  expect(keys).toEqual(["a", "shift+Insert", "shift+Insert", "shift+Insert"])
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "input_bytes" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "clipboard-paste:primary:shift+Insert" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({
    selection: "primary",
    key: "shift+Insert",
    report: `\x1b[200~${clipboardWrites[0]}\x1b[201~`,
  })
})

test("extensions.clipboard-paste without a reviewed route presses nothing and is not tested", async () => {
  const keys: string[] = []
  const ctx = termSource({
    queryMode: async () => "reset",
    withClipboardFixture: async (work) =>
      work({
        readText: async () => "",
        writeText: async () => {
          throw new Error("no route: the selection must stay untouched")
        },
      }),
    input: {
      injectKey: async (key) => {
        keys.push(key)
      },
      injectClick: async () => {},
    },
    readInput: async () => null,
  })
  const result = (await pasteProbe().term!(ctx)) as ProbeCallbackResult
  expect(keys).toEqual([])
  expect(JSON.stringify(result)).toContain("a reviewed default paste route for this App")
})

test("extensions.clipboard-paste records unsupported interaction when paste arrives as the raw nonce", async () => {
  const writes: string[] = []
  const { ctx, keys, clipboardWrites } = pasteAndRead({ paste: "raw" }, writes)
  const result = (await pasteProbe().term!(ctx)) as ProbeCallbackResult
  expect(keys).toEqual(["a", "ctrl+shift+v", "ctrl+shift+v", "ctrl+shift+v"])
  const nonce = clipboardWrites[0] ?? ""
  expect(writes.join("")).toContain("\x1b[?2004h")
  expect(writes.join("")).toContain("\x1b[?2004l")
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "input_bytes" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "negative", action: "clipboard-paste:clipboard:ctrl+shift+v" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ mode: "clipboard-paste", control: "a", report: nonce })
})

test("extensions.clipboard-paste throws when paste is silent after delivery control, and still resets 2004", async () => {
  const writes: string[] = []
  const { ctx, keys } = pasteAndRead({ paste: "silent" }, writes)
  await expect(pasteProbe().term!(ctx)).rejects.toThrow(/paste|silent/i)
  expect(keys).toEqual(["a", "ctrl+shift+v"])
  expect(writes.join("")).not.toContain("\x1b[?2004h")
  expect(writes.join("")).toContain("\x1b[?2004l")
  expect(writes.join("")).not.toContain("\x1b]52;")
})

// Native encoder observations must distinguish framing support from a dead or malformed actuator.
function nativePasteModel(
  options: {
    initial?: boolean
    supports?: boolean
    fixed?: boolean
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
      if (sequence === "\x1b[?2004h") {
        if (!options.fixed) enabled = true
      } else if (sequence === "\x1b[?2004l") {
        if (!options.fixed) enabled = false
      } else throw new Error(`Unexpected paste stimulus ${JSON.stringify(sequence)}`)
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
    expect(result.assertions?.[0]?.action).toBe("native paste with 2004 off, on, then restored")
  })

  test("qualified raw output is unsupported and is sensitive to the disabled feature", () => {
    const model = nativePasteModel({ supports: false })
    const result = pasteProbe().lib!(model.ctx)
    expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "input_bytes" })
    expect(result.assertions?.[0]?.kind).toBe("negative")
    expect(model.calls).toHaveLength(6)
    expect(model.calls.every((call) => call.raw === call.text)).toBe(true)
  })

  test("provided xterm native encoder is measured before the declared absence branch", () => {
    const model = nativePasteModel()
    const result = pasteProbe().lib!({ ...model.ctx, backendName: "xterm" })
    expect(result.observation?.outcome).toBe("supported")
    expect(result.tests?.some((test) => test.status === "untestable")).not.toBe(true)
  })

  test("unknown backend without an encoder remains TODO", () => {
    const model = nativePasteModel()
    delete model.ctx.encodePaste
    const result = pasteProbe().lib!(model.ctx)
    expect(result.tests).toMatchObject([
      { status: "probe-todo", reason: expect.stringContaining("has no hook for sending pastes") },
    ])
    expect(result.observation).toBeUndefined()
    expect(model.feeds).toEqual([])
  })

  test("unknown native mode query replies never permit raw-output inference or mutation", () => {
    for (const raw of ["", "\x1b[?2004;0$y", "\x1b[?2004;9$y"]) {
      const model = nativePasteModel({ initial: true, supports: false })
      model.ctx.getMode = () => null
      model.ctx.feedCapture = () => raw
      const result = pasteProbe().lib!(model.ctx)
      expect(result.tests).toMatchObject([{ status: "probe-todo" }])
      expect(result.observation?.outcome).toBe("inconclusive")
      expect(model.feeds).toEqual([])
      expect(model.calls).toEqual([])
      expect(model.enabled()).toBe(true)
    }
  })

  // CTO 790b6741 supersedes the earlier permanent-mode refusal: measured controls decide.
  test.each([3, 4])("permanent DECRPM Ps%s is decided by the actual native controls", (ps) => {
    const initial = ps === 3
    const model = nativePasteModel({ initial, fixed: true })
    model.ctx.getMode = () => null
    const raw = `\x1b[?2004;${ps}$y\x1b[?1;2c`
    model.ctx.feedCapture = () => raw
    const result = pasteProbe().lib!(model.ctx)
    expect(result.observation?.outcome).toBe(ps === 4 ? "unsupported" : "inconclusive")
    expect(model.feeds).toEqual(
      ps === 4 ? ["\x1b[?2004l", "\x1b[?2004h", "\x1b[?2004l"] : ["\x1b[?2004l", "\x1b[?2004h"],
    )
    expect(model.calls).toHaveLength(ps === 4 ? 6 : 4)
    expect(model.enabled()).toBe(initial)
    const evidence = JSON.parse(result.response!) as { modeReads: Array<{ raw: string; ps: number }> }
    expect(evidence.modeReads).toMatchObject([
      { raw, ps },
      { raw, ps },
    ])
    if (ps === 3) {
      expect(result.assertions).toBeUndefined()
      const stored = recordExecutedProbe({
        featureId: "extensions.clipboard-paste",
        tests: result.tests,
        assertions: [],
        attempt: { scope: "probe", startedAt: "2026-11-05T03:20:00.000Z" },
      })
      expect(stored.status).toBe("probe-todo")
      expect(stored.reason).toBe("Native paste raw controls did not both qualify; enabled framing cannot be decided")
    } else expect(result.assertions?.[0]?.kind).toBe("negative")
  })

  test.each(["feedCapture", "sentinel"] as const)("%s mode query needs same-feed DA1 before any mutation", (route) => {
    for (const ps of [1, 2]) {
      const model = nativePasteModel({ initial: ps === 1 })
      model.ctx.getMode = () => null
      const raw = `\x1b[?2004;${ps}$y`
      if (route === "feedCapture") {
        model.ctx.feedCapture = (sequence) => {
          expect(sequence).toBe("\x1b[?2004$p\x1b[c")
          return raw
        }
      } else {
        model.ctx.queryWithSentinelOutcome = (sequence) => {
          expect(sequence).toBe("\x1b[?2004$p")
          return { raw, rawBase64: btoa(raw), match: [raw, String(ps)], reason: "reply" }
        }
      }
      const result = pasteProbe().lib!(model.ctx)
      expect(result.tests).toMatchObject([{ status: "probe-todo", reason: expect.stringContaining("DA1") }])
      expect(result.assertions).toBeUndefined()
      expect(model.feeds).toEqual([])
      expect(model.calls).toEqual([])
      expect(model.enabled()).toBe(ps === 1)
      expect(result.response).toContain(JSON.stringify(raw).slice(1, -1))
    }
  })

  test("restoration query must return the original DECRPM Ps", () => {
    const model = nativePasteModel()
    model.ctx.getMode = () => null
    let read = 0
    model.ctx.feedCapture = () => `\x1b[?2004;${read++ === 0 ? 2 : 4}$y\x1b[?1;2c`
    expect(() => pasteProbe().lib!(model.ctx)).toThrow(/restoration/i)
  })

  test.each(["reply", "timeout"] as const)(
    "sentinel mode-query fallback retains the %s outcome and control",
    (reason) => {
      const model = nativePasteModel({ initial: true, supports: false })
      model.ctx.getMode = () => null
      const raw = "\x1b[?2004;1$y\x1b[?1;2c"
      model.ctx.queryWithSentinelOutcome = () => ({
        raw,
        rawBase64: btoa(raw),
        match: ["\x1b[?2004;1$y", "1"],
        reason,
      })
      const result = pasteProbe().lib!(model.ctx)
      if (reason === "timeout") {
        expect(result.tests).toMatchObject([{ status: "probe-todo" }])
        expect(model.feeds).toEqual([])
        expect(model.calls).toEqual([])
      } else {
        expect(result.observation?.outcome).toBe("unsupported")
        expect(model.calls).toHaveLength(6)
      }
      expect(model.enabled()).toBe(true)
      const evidence = JSON.parse(result.response!) as {
        modeReads: Array<{ raw: string; control: string; outcome: { reason: string } }>
      }
      expect(
        evidence.modeReads.every(
          (read) => read.raw === raw && read.control === "\x1b[?1;2c" && read.outcome.reason === reason,
        ),
      ).toBe(true)
    },
  )

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
    const stored = recordExecutedProbe({
      featureId: "extensions.clipboard-paste",
      tests: result.tests,
      assertions: [],
      attempt: { scope: "probe", startedAt: "2026-11-05T02:17:00.000Z" },
    })
    expect(stored.status).toBe("probe-todo")
    expect(stored.reason).toContain("mode readback is unavailable")
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
      if (phase === "on") {
        const stored = recordExecutedProbe({
          featureId: "extensions.clipboard-paste",
          tests: result.tests,
          assertions: [],
          attempt: { scope: "probe", startedAt: "2026-11-05T03:20:00.000Z" },
        })
        expect(stored.status).toBe("probe-invalid")
      }
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

// #33145 (@cto 70645b74): on an X selection, xterm and Alacritty stamp their OSC 52 claim with their last
// input-event time, so a terminal that never saw input loses the selection to the harness's own xclip owner.
// A fixture that offers a real key event gets it before every write and roundtrip, inside a PTY read that
// refuses the sample if the press reached the application as bytes.
describe("real key event before the OSC 52 write", () => {
  const silent = { match: null, reason: "timeout" as const, raw: "", rawBase64: "" }
  function keyedSource(options: {
    readonly events: string[]
    readonly outcome?: typeof silent | { match: string[]; reason: "reply"; raw: string; rawBase64: string }
    readonly pressFails?: boolean
    readonly noReadInjected?: boolean
  }): TermProbeSource {
    let clipboard = "baseline"
    let queued = ""
    const fixture: ClipboardFixture = {
      baseline: "baseline",
      writeDeadlineMs: 20,
      writePollMs: 5,
      readText: async () => clipboard,
      writeText: async (text) => {
        clipboard = text
      },
      realKeyEvent: async () => {
        options.events.push("key")
        if (options.pressFails) throw new Error("Real key event before the OSC 52 write failed: getwindowfocus is 1")
      },
    }
    return termSource({
      write(sequence) {
        options.events.push("osc-write")
        queued = writtenNonce(sequence)
      },
      queryCursorPosition: async () => {
        clipboard = queued
        return { row: 1, col: 1 }
      },
      ...(!options.noReadInjected && {
        readInjected: async (_pattern: RegExp, _timeoutMs: number, inject: () => Promise<void>) => {
          options.events.push("pty-armed")
          await inject()
          return options.outcome ?? silent
        },
      }),
      withClipboardFixture: async (work) => work(fixture),
    })
  }
  const term = (id: string) => ALL_PROBES.find((item) => item.id === id)!.term!

  test.each(["extensions.osc52-write", "extensions.osc52-clipboard"])(
    "%s presses inside the PTY read before the OSC 52 write",
    async (id) => {
      const events: string[] = []
      await term(id)(keyedSource({ events }))
      expect(events.slice(0, 3)).toEqual(["pty-armed", "key", "osc-write"])
    },
  )

  test("a passing write does not mention the press", async () => {
    const result = await writeProbe()(keyedSource({ events: [] }))
    expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "clipboard" })
    expect(JSON.stringify(result)).not.toMatch(/key event|press/i)
  })

  test("osc52-read gets no press", async () => {
    const events: string[] = []
    await term("extensions.osc52-read")(keyedSource({ events }))
    expect(events).not.toContain("key")
  })

  test("bytes on the PTY across the press refuse the sample as probe-invalid and send no OSC 52", async () => {
    const events: string[] = []
    const raw = "\x1b[57441;2u"
    const result = await writeProbe()(
      keyedSource({
        events,
        outcome: { match: [raw], reason: "reply", raw, rawBase64: Buffer.from(raw).toString("base64") },
      }),
    )
    expect(events).not.toContain("osc-write")
    expect(result.tests?.[0]).toMatchObject({
      status: "probe-invalid",
      reason: expect.stringMatching(/^Real key event before the OSC 52 write put 10 bytes into the application/),
    })
  })

  test("a failed focus or XTEST press is a named probe-invalid", async () => {
    const events: string[] = []
    const result = await writeProbe()(keyedSource({ events, pressFails: true }))
    expect(events).not.toContain("osc-write")
    expect(result.tests?.[0]).toMatchObject({
      status: "probe-invalid",
      reason: "Real key event before the OSC 52 write failed: getwindowfocus is 1",
    })
  })

  test("a source that cannot read the PTY across the press refuses instead of pressing blind", async () => {
    const events: string[] = []
    const result = await writeProbe()(keyedSource({ events, noReadInjected: true }))
    expect(events).toEqual([])
    expect(result.tests?.[0]).toMatchObject({
      status: "probe-invalid",
      reason: expect.stringMatching(/needs the PTY read/),
    })
  })
})

// #33145 read leg (@cto 7fd99ad2): a terminal may answer OSC 52 read from its own earlier write for a moment after
// another client takes the selection. The roundtrip re-queries only while the reply is the probe's OWN earlier
// nonce, bounded by the write deadline; the settled reply decides, and the row says how long it took.
describe("roundtrip read leg settles a stale own-nonce reply", () => {
  function roundtripSource(replyFor: (asked: number, own: string, written: string) => string): {
    source: TermProbeSource
    asked: () => number
  } {
    let clipboard = "baseline"
    let own = ""
    let written = ""
    let asked = 0
    const reply = (value: string) => {
      const raw = `\x1b]52;c;${btoa(value)}\x1b\\`
      return { match: [raw, btoa(value)], reason: "reply" as const, raw, rawBase64: "" }
    }
    const source = termSource({
      write(sequence) {
        own = writtenNonce(sequence)
      },
      queryCursorPosition: async () => {
        clipboard = own
        return { row: 1, col: 1 }
      },
      queryOutcome: async () => {
        asked += 1
        return reply(replyFor(asked, own, written))
      },
      withClipboardFixture: async (work) =>
        work({
          baseline: "baseline",
          writeDeadlineMs: 60,
          writePollMs: 5,
          readText: async () => clipboard,
          writeText: async (text) => {
            clipboard = text
            written = text
          },
        }),
    })
    return { source, asked: () => asked }
  }
  const roundtrip = () => ALL_PROBES.find((item) => item.id === "extensions.osc52-clipboard")!.term!

  test("own earlier nonce twice, then the written nonce: supported, and the row records the re-queries", async () => {
    const { source, asked } = roundtripSource((n, own, written) => (n <= 2 ? own : written))
    const result = await roundtrip()(source)
    expect(asked()).toBe(3)
    expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
    expect(result.observation?.note).toMatch(
      /^OSC 52 read returned the probe's own earlier write nonce for \d+ ms before the independently written nonce \(2 re-queries; replies at \+\d+ms own, \+\d+ms own, \+\d+ms written\)$/,
    )
  })

  test("own earlier nonce through the deadline: named inconclusive with a test row, not unsupported", async () => {
    const { source, asked } = roundtripSource((_n, own) => own)
    const result = await roundtrip()(source)
    expect(asked()).toBeGreaterThan(1)
    expect(result.observation).toMatchObject({ outcome: "inconclusive", assertionType: "query_reply" })
    expect(result.tests?.[0]).toMatchObject({
      status: "probe-todo",
      reason: expect.stringMatching(/^OSC 52 reply carried own earlier nonce for \d+ ms \(\d+ re-queries\)$/),
    })
  })

  test("any other wrong value decides at once with its named inconclusive", async () => {
    const { source, asked } = roundtripSource(() => "someone-else")
    const result = await roundtrip()(source)
    expect(asked()).toBe(1)
    expect(result.tests?.[0]).toMatchObject({
      status: "probe-todo",
      reason: expect.stringMatching(
        /^OSC 52 reply carried a value other than the independently written nonce \(length=12, sha256=[0-9a-f]{64}\)$/,
      ),
    })
  })
})

// @cto 2026-11-13: a read's feature is the query, so the read leg carries a control. No control reply is a named
// probe-todo (nothing measured the channel); a control reply with a silent query is unsupported (the feature is
// absent in this configuration); and a profile reading names its profile and exact setting so it can never be read
// as the default configuration a person gets when they open the app.
describe("OSC 52 read leg control and profile naming", () => {
  function readCallback() {
    const found = ALL_PROBES.find((item) => item.id === "extensions.osc52-read")?.term
    if (!found) throw new Error("OSC 52 read callback is missing")
    return found
  }

  test("no control reply is probe-todo naming the control, never unsupported", async () => {
    const result = await readCallback()(
      termSource({
        queryCursorPosition: async () => undefined,
        withClipboardFixture: async (work) =>
          work({ baseline: "baseline", readText: async () => "baseline", writeText: async () => {} }),
      }),
    )
    expect(result.tests?.[0]).toMatchObject({
      status: "probe-todo",
      reason: "cursor-position control before the OSC 52 read",
    })
    expect(result.observation?.outcome).not.toBe("unsupported")
  })

  test("control answered and the query silent with a pinned deny default is unsupported, and names no profile", async () => {
    const result = await readCallback()(
      termSource({
        withClipboardFixture: async (work) =>
          work({
            baseline: "baseline",
            readText: async () => "baseline",
            writeText: async () => {},
            readDefault: { posture: "deny", source: "app docs, pinned version" },
          }),
      }),
    )
    expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "query_reply" })
    expect(result.assertions?.[0]).toMatchObject({ kind: "negative" })
    expect(result.observation?.note).toBe("cursor-position control answered; OSC 52 c returned no reply")
  })

  test("an ask default grades the same silence as probe-todo naming the unanswered prompt", async () => {
    const result = await readCallback()(
      termSource({
        withClipboardFixture: async (work) =>
          work({
            baseline: "baseline",
            readText: async () => "baseline",
            writeText: async () => {},
            readDefault: { posture: "ask", source: "app docs, pinned version" },
          }),
      }),
    )
    expect(result.tests?.[0]).toMatchObject({
      status: "probe-todo",
      reason: "default asks the user; the prompt was not answered",
    })
    expect(result.observation?.outcome).not.toBe("unsupported")
  })

  test("a read-granting profile grades silence unsupported even with no pinned default, and names the profile", async () => {
    const result = await readCallback()(
      termSource({
        withClipboardFixture: async (work) =>
          work({
            baseline: "baseline",
            readText: async () => "baseline",
            writeText: async () => {},
            readProfile: { profile: "allow", setting: "ghostty --clipboard-read=allow" },
          }),
      }),
    )
    expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "query_reply" })
    expect(result.assertions?.[0]).toMatchObject({ kind: "negative" })
    expect(result.observation?.note).toContain("allow: ghostty --clipboard-read=allow")
  })

  test("an unpinned default grades the same silence as probe-todo naming the missing citation", async () => {
    const result = await readCallback()(
      termSource({
        withClipboardFixture: async (work) =>
          work({ baseline: "baseline", readText: async () => "baseline", writeText: async () => {} }),
      }),
    )
    expect(result.tests?.[0]).toMatchObject({
      status: "probe-todo",
      reason: expect.stringContaining("default not established"),
    })
  })

  test("a version refusal names both versions and never grades unsupported", async () => {
    const result = await readCallback()(
      termSource({
        withClipboardFixture: async (work) =>
          work({
            baseline: "baseline",
            readText: async () => "baseline",
            writeText: async () => {},
            readDefaultRefusal: "default not established: this tree cites kitty 0.49.2, this run measured 0.49.1",
          }),
      }),
    )
    expect(result.tests?.[0]).toMatchObject({
      status: "probe-todo",
      reason: expect.stringContaining("this tree cites kitty 0.49.2, this run measured 0.49.1"),
    })
    expect(result.observation?.outcome).not.toBe("unsupported")
  })

  test("a deny-read profile grades its own configured refusal, naming write-clipboard only", async () => {
    const result = await readCallback()(
      termSource({
        withClipboardFixture: async (work) =>
          work({
            baseline: "baseline",
            readText: async () => "baseline",
            writeText: async () => {},
            readProfile: { profile: "deny-read", setting: "kitty -o clipboard_control=write-clipboard" },
          }),
      }),
    )
    expect(result.tests?.[0]).toMatchObject({
      status: "probe-todo",
      reason: "deny-read profile: refusal configured by this run; grades nothing about the default",
    })
    expect(result.observation?.outcome).not.toBe("unsupported")
  })

  test("an answered query passes and its note carries the profile and exact setting", async () => {
    let seeded = ""
    const result = await readCallback()(
      termSource({
        queryOutcome: async () => {
          const raw = `\x1b]52;c;${btoa(seeded)}\x07`
          return { match: [raw, btoa(seeded)], reason: "reply" as const, raw, rawBase64: "" }
        },
        withClipboardFixture: async (work) =>
          work({
            baseline: "baseline",
            readText: async () => "baseline",
            writeText: async (text) => {
              seeded = text
            },
            readProfile: { profile: "allow", setting: "kitty clipboard_control=write-clipboard read-clipboard" },
          }),
      }),
    )
    expect(result.pass).toBe(true)
    expect(result.observation?.note).toContain("allow: kitty clipboard_control=write-clipboard read-clipboard")
  })
})
