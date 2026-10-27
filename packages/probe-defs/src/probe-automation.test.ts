import { describe, expect, test } from "vitest"
import { ALL_PROBES, type LibProbeSource, type TermProbeSource } from "./index.ts"

const OSC_SEMANTIC_MARK_CASES = [
  ["extensions.osc133-a", "\x1b]133;A\x07"],
  ["extensions.osc133-b", "\x1b]133;B\x07"],
  ["extensions.osc133-c", "\x1b]133;C\x07"],
  ["extensions.osc133-d", "\x1b]133;D;0\x07"],
  ["extensions.osc133-p", "\x1b]133;P;Cwd=/tmp\x07"],
  ["extensions.osc633-a", "\x1b]633;A\x07"],
  ["extensions.osc633-b", "\x1b]633;B\x07"],
  ["extensions.osc633-c", "\x1b]633;C\x07"],
  ["extensions.osc633-d", "\x1b]633;D;0\x07"],
  ["extensions.osc633-e", "\x1b]633;E;ls -la;nonce123\x07"],
  ["extensions.osc633-p", "\x1b]633;P;Cwd=/tmp\x07"],
] as const
const OSC_SEMANTIC_MARK_IDS = OSC_SEMANTIC_MARK_CASES.map(([id]) => id)

function probe(id: string) {
  const found = ALL_PROBES.find((p) => p.id === id)
  if (!found) throw new Error(`missing probe ${id}`)
  return found
}

function context(overrides: Partial<LibProbeSource>): LibProbeSource {
  return {
    kind: "live",
    cols: 80,
    feed() {},
    feedCapture() {
      return ""
    },
    getCell() {
      return {
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
      }
    },
    getCursor() {
      return { x: 0, y: 0, visible: true, style: "block" }
    },
    getMode() {
      return false
    },
    getText() {
      return ""
    },
    getScrollback() {
      return { viewportOffset: 0, totalLines: 24, screenLines: 24 }
    },
    getTitle() {
      return ""
    },
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
    ...overrides,
  }
}

function terminalSource(overrides: Partial<TermProbeSource>): TermProbeSource {
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

/**
 * @failure A color-register count, protocol failure, or DA1 responsiveness was reported as Sixel geometry.
 * @level l0
 * @consumer XTSMGRAPHICS item-2 callbacks in headless and real-terminal collectors.
 * @testonly none
 */
describe("Sixel geometry item-2 report", () => {
  const query = "\x1b[?2;1;0S"
  const geometry = probe("extensions.sixel-geometry-report")
  if (!geometry.lib || !geometry.term) throw new Error("Sixel geometry requires both callbacks")
  const headless = geometry.lib
  const terminal = geometry.term

  function fromHeadless(raw: string) {
    return headless(
      context({
        feedCapture(sequence) {
          expect(sequence).toBe(query)
          return raw
        },
      }),
    )
  }

  async function fromTerminal(raw: string, sentinelFirst = false) {
    return terminal(
      terminalSource({
        queryWithSentinelOutcome: async (sequence, pattern) => {
          expect(sequence).toBe(query)
          const match = sentinelFirst ? null : raw.match(pattern)
          return { match, reason: match ? "reply" : "sentinel", raw, rawBase64: Buffer.from(raw).toString("base64") }
        },
        queryCursorPosition: async () => {
          throw new Error("CPR cannot establish Sixel geometry")
        },
      }),
    )
  }

  test("binds a status-0 width and height reply as the exact query result", async () => {
    const raw = "\x1b[?2;0;640;480S"
    for (const result of [fromHeadless(raw), await fromTerminal(raw)]) {
      expect(result).toMatchObject({ pass: true, response: raw })
      expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
      expect(result.assertions?.[0]).toMatchObject({ kind: "positive", observed: raw })
    }
    expect(geometry.termWrites).toBe("query")
  })

  test("a valid-looking frame after the DA1 sentinel cannot be promoted from raw bytes", async () => {
    const raw = "\x1b[?62;52;c\x1b[?2;0;640;480S"
    const result = await fromTerminal(raw, true)
    expect(result).toMatchObject({ pass: false, response: raw })
    expect(result.observation).toMatchObject({
      outcome: "inconclusive",
      reason: "no-response",
      assertionType: "query_reply",
    })
    expect(result.assertions).toBeUndefined()
  })

  test("a geometry frame before DA1 supports while preserving the full raw trace", async () => {
    const frame = "\x1b[?2;0;640;480S"
    const raw = `${frame}\x1b[?62;52;c`
    const result = await fromTerminal(raw)
    expect(result).toMatchObject({ pass: true, response: raw })
    expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
    expect(result.assertions?.[0]).toMatchObject({ kind: "positive", observed: frame })
  })

  test("invalid Sixel replies retain query observations while silence records a named execution failure", async () => {
    for (const [raw, reason] of [
      ["\x1b[?2;3;0S", "insufficient-evidence"],
      ["\x1b[?1;0;256S", "no-response"],
      ["\x1b[?2;0;640S", "invalid-reply"],
      ["\x1b[?2;0;0;480S", "insufficient-evidence"],
      ["", "no-response"],
    ] as const) {
      for (const result of [fromHeadless(raw), await fromTerminal(raw)]) {
        expect(result).toMatchObject({ pass: false, response: raw })
        if (raw === "") {
          expect(result.observation).toBeUndefined()
          expect(result.tests).toMatchObject([
            expect.objectContaining({ status: "test-failure", reason: "No Sixel geometry response for item 2" }),
          ])
        } else {
          expect(result.observation).toMatchObject({ outcome: "inconclusive", reason, assertionType: "query_reply" })
        }
        expect(result.assertions).toBeUndefined()
      }
    }
  })
})

/**
 * @failure OSC 8 consumption or a capability flag was mistaken for linked-cell metadata.
 * @level l0
 * @consumer Unified headless and application OSC 8 observation.
 * @testonly none
 */
describe("OSC 8 link metadata observation", () => {
  const uri = "https://example.com/osc8-proof"
  const positions = [null, uri, uri, uri, uri, null] as const

  function linkedSource(links: readonly (string | null | undefined)[], declared = true): LibProbeSource {
    const base = context({})
    return Object.assign(
      context({
        capabilities: {
          ...base.capabilities,
          osc8Hyperlinks: true,
          extensions: new Set(declared ? ["hyperlinks"] : []),
        },
        getCell(_row, col) {
          const link = links[col]
          return {
            ...base.getCell(0, col),
            char: "ALINKZ"[col] ?? "",
            ...(link !== undefined && { hyperlink: link }),
          }
        },
      }),
      declared ? { getHyperlinkAt: (_row: number, col: number) => links[col] } : {},
    )
  }

  test("four exact URI cells bracketed by unlinked controls establish support", () => {
    const p = probe("extensions.osc8")
    if (!p.lib) throw new Error("OSC 8 needs headless callback")
    const result = p.lib(linkedSource(positions))
    expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
    expect(result.assertions?.[0]).toMatchObject({ kind: "positive" })
    // The headless batch admits parser-state conclusions only when the exact
    // assertion observation is the immutable raw response for this feature.
    expect(result.assertions?.[0]?.observed).toBe(result.response)
  })

  test("wrong URI or link leaking past close is unsupported with measured mismatch", () => {
    const p = probe("extensions.osc8")
    if (!p.lib) throw new Error("OSC 8 needs headless callback")
    for (const links of [
      [null, uri, "https://wrong.example", uri, uri, null],
      [null, uri, uri, uri, uri, uri],
    ]) {
      const result = p.lib(linkedSource(links))
      expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
      expect(result.assertions?.[0]).toMatchObject({ kind: "negative" })
      expect(result.assertions?.[0]?.observed).toBe(result.response)
    }
  })

  test("missing link metadata is inconclusive, but a true declaration with absent field is an error", () => {
    const p = probe("extensions.osc8")
    if (!p.lib) throw new Error("OSC 8 needs headless callback")
    const unreported = p.lib(linkedSource(Array(6).fill(undefined), false))
    expect(unreported.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(() => p.lib?.(linkedSource(Array(6).fill(undefined), true))).toThrow(/declares OSC 8 metadata/i)
  })

  // AC3: the published feature flag does not declare metadata exposure.
  test("a true feature flag with no metadata extension stays unreported", () => {
    const p = probe("extensions.osc8")
    if (!p.lib) throw new Error("OSC 8 needs headless callback")
    const result = p.lib(linkedSource(Array(6).fill(null), false))
    expect(result.observation).toMatchObject({ outcome: "inconclusive" })
    expect(JSON.parse(result.response ?? "")).toMatchObject({ links: Array(6).fill({ reported: false }) })
  })

  test("application CPR consumption remains inconclusive", async () => {
    const p = probe("extensions.osc8")
    if (!p.term) throw new Error("OSC 8 needs application callback")
    const result = await p.term(terminalSource({ queryCursorPosition: async () => ({ row: 1, col: 7 }) }))
    expect(result.observation).toBeUndefined()
    expect(result.assertions).toBeUndefined()
    expect(result.tests).toMatchObject([
      expect.objectContaining({
        status: "test-todo",
        reason: "Cursor movement cannot verify OSC 8 link metadata or click behavior",
      }),
    ])
  })
})

/**
 * @failure Reflow wrapping masquerades as resize support; ignored OSC sequences and misplaced OSC 66 baselines become false positives.
 * @level l0
 * @consumer Unified app and headless probe definitions.
 * @testonly none
 */
describe("Kitty protocol detection", () => {
  test("reflow declaration does not claim resize-time behavior without a controlled resize", async () => {
    const p = probe("extensions.reflow")
    if (!p.term || !p.lib) throw new Error("Reflow needs both callbacks")
    for (const declared of [true, false]) {
      const writes: string[] = []
      const headless = p.lib(
        context({
          capabilities: { ...context({}).capabilities, reflow: declared },
          feed(sequence) {
            writes.push(sequence)
          },
        }),
      )
      const terminal = await p.term(
        terminalSource({
          write(sequence) {
            writes.push(sequence)
          },
          queryWithSentinel: async () => {
            throw new Error("Reflow must not query size without a resize oracle")
          },
          queryCursorPosition: async () => {
            throw new Error("Reflow must not grade wrapping as resize reflow")
          },
        }),
      )
      expect(writes).toEqual([])
      // A declaration is not a measurement: the headless arm records coverage with the named
      // observable (@cto 2026-10-22, 30695-inconclusive-mapping-ruling), while the application arm
      // keeps its inconclusive observation. Neither callback performs a controlled resize.
      expect(headless.pass).toBe(false)
      expect(headless.observation).toBeUndefined()
      expect(headless.notTested).toMatchObject({ reason: "no-semantic-observable" })
      expect(headless.note).toMatch(/controlled resize|readback/i)
      expect(terminal.pass).toBe(false)
      expect(terminal.observation).toBeUndefined()
      expect(terminal.assertions).toBeUndefined()
      expect(terminal.tests).toMatchObject([
        expect.objectContaining({ status: "test-todo", reason: expect.any(String) }),
      ])
      expect(terminal.note).toMatch(/controlled resize|readback/i)
      expect(headless.response).toContain(String(declared))
    }
  })

  test("OSC 66 measures width and scale rather than treating consumption as support", async () => {
    const p = probe("extensions.osc66-text-sizing")
    if (!p.term || !p.lib) throw new Error("OSC 66 needs both probe methods")
    // CPR 1→3→5 captured from Kitty 0.46.2; ignored OSC leaves all three at 1.
    for (const [positions, expected] of [
      [[1, 1, 1], false],
      [[1, 3, 5], true],
      [[1, 3, 3], false],
    ] as const) {
      const written: string[] = []
      let index = 0
      const term = await p.term(
        terminalSource({
          write(text) {
            written.push(text)
          },
          queryCursorPosition: async () => ({ row: 1, col: positions[index++] ?? 1 }),
        }),
      )
      expect(term.pass).toBe(expected)
      expect(term.observation).toMatchObject({
        outcome: expected ? "supported" : "unsupported",
        assertionType: "query_reply",
      })
      expect(written).toContain("\x1b]66;w=2; \x07")
      expect(written).toContain("\x1b]66;s=2; \x07")
      index = 0
      const headless = p.lib(
        context({
          getCursor() {
            return { x: (positions[index++] ?? 1) - 1, y: 0, visible: true, style: "block" }
          },
        }),
      )
      expect(headless.pass).toBe(expected)
      expect(headless.observation).toMatchObject({
        outcome: expected ? "supported" : "unsupported",
        assertionType: "buffer_state",
      })
    }
    const missingWrites: string[] = []
    let missingQueries = 0
    const missing = await p.term(
      terminalSource({
        write(sequence) {
          missingWrites.push(sequence)
        },
        queryCursorPosition: async () => {
          missingQueries++
          return null
        },
      }),
    )
    expect(missingWrites).toEqual(["\x1b[1;1H\x1b[2K\r"])
    expect(missingQueries).toBe(1)
    expect(missing.observation).toBeUndefined()
    expect(missing.assertions).toBeUndefined()
    expect(missing.tests).toMatchObject([
      expect.objectContaining({ status: "test-failure", reason: "No baseline cursor response" }),
    ])
  })

  test("OSC 66 requires a measured home cursor before either protocol write", async () => {
    const p = probe("extensions.osc66-text-sizing")
    if (!p.term || !p.lib) throw new Error("OSC 66 needs both callbacks")
    for (const baseline of [
      { row: 1, col: 2 },
      { row: 2, col: 1 },
    ]) {
      const writes: string[] = []
      let queries = 0
      const terminal = await p.term(
        terminalSource({
          write(sequence) {
            writes.push(sequence)
          },
          queryCursorPosition: async () => {
            queries++
            return baseline
          },
        }),
      )
      expect(queries).toBe(1)
      expect(writes).toEqual(["\x1b[1;1H\x1b[2K\r"])
      expect(terminal.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
      expect(terminal.response).toContain(JSON.stringify(baseline))
      expect(terminal.assertions ?? []).toEqual([])
      const fed: string[] = []
      const headless = p.lib(
        context({
          feed(sequence) {
            fed.push(sequence)
          },
          getCursor() {
            return { x: baseline.col - 1, y: baseline.row - 1, visible: true, style: "block" }
          },
        }),
      )
      expect(fed).toEqual(["\x1b[1;1H\x1b[2K\r"])
      expect(headless.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
      expect(headless.response).toContain(JSON.stringify({ row: baseline.row - 1, col: baseline.col - 1 }))
      expect(headless.assertions ?? []).toEqual([])
    }
  })

  test.each([
    [0, false, "unsupported", undefined, "not recognized (Ps 0)"],
    [1, true, "supported", undefined, "set (Ps 1)"],
    [2, true, "supported", undefined, "reset (Ps 2)"],
    [3, true, "supported", undefined, "permanently set (Ps 3)"],
    [4, false, "unsupported", undefined, "permanently reset (Ps 4)"],
    [null, false, "inconclusive", "no-response", undefined],
  ] as const)("OSC 5522 Ps %s decides protocol detection on both arms", async (ps, pass, outcome, reason, reading) => {
    const p = probe("extensions.osc5522-clipboard")
    if (!p.term || !p.lib) throw new Error("OSC 5522 needs both probe methods")
    const response = ps === null ? "" : `\x1b[?5522;${ps}$y`
    const sentinel = "\x1b[?1;2c"
    const queries: string[] = []
    const headless = p.lib(
      context({
        feedCapture() {
          throw new Error("The installed headless outcome owns its full reply window")
        },
        queryWithSentinelOutcome(sequence, pattern) {
          queries.push(sequence)
          return {
            match: response.match(pattern),
            reason: ps === null ? "sentinel" : "reply",
            raw: response + sentinel,
            rawBase64: btoa(response + sentinel),
          }
        },
      }),
    )
    const term = await p.term(
      terminalSource({
        queryMode: async () => {
          throw new Error("OSC 5522 must retain the Ps, not its folded mode")
        },
        queryWithSentinel: async (sequence, pattern) => {
          queries.push(sequence)
          return sequence === "\x1b[?5522$p" ? response.match(pattern) : null
        },
        queryWithSentinelOutcome: async (sequence, pattern) => {
          queries.push(sequence)
          return {
            match: sequence === "\x1b[?5522$p" ? response.match(pattern) : null,
            reason: ps === null ? "timeout" : "reply",
            raw: response,
            rawBase64: btoa(response),
          }
        },
      }),
    )
    expect(queries).toEqual(["\x1b[?5522$p", "\x1b[?5522$p"])
    for (const result of [headless, term]) {
      expect(result.pass).toBe(pass)
      if (ps === null) {
        expect(result.observation).toBeUndefined()
        expect(result.assertions).toBeUndefined()
        expect(result.tests).toMatchObject([
          expect.objectContaining({ status: "test-failure", reason: expect.any(String) }),
        ])
      } else {
        expect(result.observation).toMatchObject({ outcome, assertionType: "query_reply" })
        expect(result.observation?.reason).toBe(reason)
      }
      expect(result.response).toBe(result === headless ? response + sentinel : reading)
      expect(result.assertions?.[0]?.observed).toBe(ps === null ? undefined : reading)
      if (ps !== null) expect(result.assertions?.[0]?.kind).toBe(pass ? "positive" : "negative")
    }
  })

  // Q16: retained bytes outside the matching reply window must never become a detector negative.
  // Happy-path Ps fixtures do not distinguish a valid target negative from a late frame in raw evidence.
  test.each([
    ["malformed", "\x1b[?5522;9$y", false],
    ["unmatched", "\x1b[?5523;4$y", false],
    ["partial", "\x1b[?5522;4$", false],
    ["late", "\x1b[?1;2c\x1b[?5522;4$y", true],
  ] as const)("OSC 5522 %s evidence stays nonnegative on both arms", async (_name, raw, late) => {
    const p = probe("extensions.osc5522-clipboard")
    if (!p.lib || !p.term) throw new Error("OSC 5522 needs both probe methods")
    const outcome = (pattern: RegExp) => ({
      match: raw.match(pattern),
      reason: "reply" as const,
      raw,
      rawBase64: btoa(raw),
      ...(late ? { sentinel: { atMs: 1, graceMs: 20 } } : {}),
    })
    const headless = p.lib(
      context({
        queryWithSentinelOutcome: (_sequence, pattern) => outcome(pattern),
      }),
    )
    const term = await p.term(
      terminalSource({
        queryWithSentinel: async (_sequence, pattern) => raw.match(pattern),
        queryWithSentinelOutcome: async (_sequence, pattern) => outcome(pattern),
      }),
    )
    for (const result of [headless, term]) {
      expect(result.observation?.outcome).not.toBe("unsupported")
      expect(result.assertions ?? []).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "negative" })]),
      )
    }
    expect(headless.response).toBe(raw)
  })

  // OSC 52 previously passed on any substring or on unrelated CPR, and left live clipboard writes behind.
  // No existing protocol test covers these three callbacks or the collector's no-clipboard policy.
  test("OSC 52 requires a complete nonce roundtrip in headless mode and never touches a live clipboard", async () => {
    for (const id of ["extensions.osc52-clipboard", "extensions.osc52-write", "extensions.osc52-read"]) {
      const p = probe(id)
      if (!p.lib || !p.term) throw new Error(`${id} needs both callbacks`)

      const sent: string[] = []
      const headless = p.lib(
        context({
          feed(text) {
            sent.push(text)
          },
          feedCapture(text) {
            expect(text).toBe("\x1b]52;c;?\x07")
            const encoded = /\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/.exec(sent.join(""))?.[1]
            if (!encoded) throw new Error("Probe never sent a clipboard nonce")
            return `\x1b]52;c;${encoded}\x1b\\`
          },
        }),
      )
      expect(headless.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })

      for (const reply of [
        "\x1b[1;1R", // Unrelated CPR cannot prove a clipboard write.
        "\x1b]52;c;d3Jvbmc=\x07", // A valid but different clipboard value is not the nonce.
        "\x1b]52;p;d3Jvbmc=\x07", // The primary selection is not c.
        "\x1b]52;c;not-base64!\x07",
        "\x1b]52;c;d3Jvbmc=\x1b", // ESC alone is not a complete ST.
        "",
      ]) {
        const result = p.lib(context({ feedCapture: () => reply }))
        if (reply === "") {
          expect(result.observation, `${id}: ${JSON.stringify(reply)}`).toBeUndefined()
          expect(result.assertions).toBeUndefined()
          expect(result.tests).toMatchObject([
            expect.objectContaining({
              status: "test-failure",
              reason: expect.stringContaining("No OSC 52 c query response"),
            }),
          ])
        } else {
          expect(result.observation?.outcome, `${id}: ${JSON.stringify(reply)}`).toBe("inconclusive")
        }
        expect(result.pass).toBe(false)
      }

      const liveWrites: string[] = []
      const live = await p.term(
        terminalSource({
          write(text) {
            liveWrites.push(text)
          },
          queryCursorPosition: async () => {
            throw new Error("OSC 52 live policy must not query")
          },
          queryWithSentinel: async () => {
            throw new Error("OSC 52 live policy must not read clipboard")
          },
          queryWithSentinelOutcome: async () => {
            throw new Error("OSC 52 live policy must not read clipboard")
          },
        }),
      )
      expect(liveWrites, id).toEqual([])
      expect(live.observation).toBeUndefined()
      expect(live.assertions).toBeUndefined()
      expect(live.tests).toMatchObject([
        expect.objectContaining({
          status: "test-todo",
          reason: "Collector policy: no owned disposable clipboard with verified restoration; OSC 52 was not sent",
        }),
      ])
      expect(live.note).toMatch(/collector|owned clipboard/i)
    }
  })

  // An owned fixture measures write and read independently; an echoed OSC frame alone cannot prove a write.
  test("owned live OSC 52 tests independent clipboard state and complete canonical query replies", async () => {
    const written: string[] = []
    let clipboard = "baseline"
    const fixture = {
      readText: async () => clipboard,
      writeText: async (text: string) => {
        clipboard = text
      },
    }
    const withClipboardFixture: NonNullable<TermProbeSource["withClipboardFixture"]> = async (work) => work(fixture)
    const queryOutcome = async (sequence: string) => {
      expect(sequence).toBe("\x1b]52;c;?\x07")
      const frame = `\x1b]52;c;${btoa(clipboard)}\x1b\\`
      return {
        match: [frame, btoa(clipboard)],
        reason: "reply" as const,
        raw: frame,
        rawBase64: Buffer.from(frame).toString("base64"),
      }
    }
    for (const id of ["extensions.osc52-write", "extensions.osc52-read", "extensions.osc52-clipboard"]) {
      written.length = 0
      clipboard = "baseline"
      const p = probe(id)
      if (!p.term) throw new Error(`${id} needs a live callback`)
      const result = await p.term(
        terminalSource({
          withClipboardFixture,
          write(text) {
            written.push(text)
            const match = /\x1b\]52;c;([^\x07\x1b]*)\x07/.exec(text)
            if (match) clipboard = atob(match[1] ?? "")
          },
          queryOutcome,
        }),
      )
      expect(result.observation, id).toMatchObject({
        outcome: "supported",
        assertionType: id === "extensions.osc52-write" ? "clipboard" : "query_reply",
      })
      expect(clipboard, id).not.toBe("baseline")
      expect(
        written.some((value) => value.startsWith("\x1b]52;c;")),
        id,
      ).toBe(id !== "extensions.osc52-read")
    }
    const read = probe("extensions.osc52-read")
    if (!read.term) throw new Error("read callback missing")
    for (const raw of ["\x1b[1;1R", "\x1b]52;p;d3Jvbmc=\x07", "\x1b]52;c;bad!\x07", "\x1b]52;c;d3Jvbmc=\x1b", ""]) {
      const result = await read.term(
        terminalSource({
          withClipboardFixture,
          queryOutcome: async () => ({
            match: null,
            reason: "timeout",
            raw,
            rawBase64: Buffer.from(raw).toString("base64"),
          }),
        }),
      )
      if (raw === "") {
        expect(result.observation).toBeUndefined()
        expect(result.assertions).toBeUndefined()
        expect(result.tests).toMatchObject([
          expect.objectContaining({ status: "test-failure", reason: "No complete OSC 52 c reply" }),
        ])
      } else {
        expect(result.observation?.outcome, JSON.stringify(raw)).toBe("inconclusive")
      }
    }
    const uncorrelated = await read.term(
      terminalSource({
        withClipboardFixture,
        queryOutcome: async () => {
          const raw = `\x1b]52;c;${btoa(clipboard)}\x07`
          return { match: null, reason: "timeout", raw, rawBase64: Buffer.from(raw).toString("base64") }
        },
      }),
    )
    expect(uncorrelated.observation).toEqual({
      outcome: "inconclusive",
      assertionType: "query_reply",
      reason: "invalid-reply",
      note: "No complete OSC 52 c reply",
    })
    expect(uncorrelated.assertions).toBeUndefined()
    expect(uncorrelated.tests).toBeUndefined()
    let captured = false
    const prompt = await read.term(
      terminalSource({
        withClipboardFixture,
        queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
        capture: async (request) => {
          captured = true
          expect(request).toEqual({ role: "target", label: "Clipboard query after no response" })
          return { ...request, capturedAt: 1, ref: `sha256:${"a".repeat(64)}` }
        },
      }),
    )
    expect(captured).toBe(true)
    expect(prompt.observation).toMatchObject({
      outcome: "inconclusive",
      reason: "no-response",
      screenshotRef: `sha256:${"a".repeat(64)}`,
    })
  })

  // The detection step (CSI ? u + DA1) is unmutating: an absent protocol returns before any push, so nothing is
  // popped. A push that is attempted and then fails must still be popped before the probe returns.
  test("Kitty keyboard probes detect protocol support before pushing, and pop only a push they made", async () => {
    const cases = [
      ["extensions.kitty-keyboard", 1],
      ["extensions.kitty-keyboard.disambiguate", 1],
      ["extensions.kitty-keyboard.report-events", 3],
      ["extensions.kitty-keyboard.report-alternate", 5],
      ["extensions.kitty-keyboard.report-all-keys", 9],
      ["extensions.kitty-keyboard.report-text", 25],
      ["input.csi-u", 1],
    ] as const

    for (const [id, flags] of cases) {
      const p = probe(id)
      if (!p.term) throw new Error(`${id} needs a TTY callback`)

      // DA1-only detection: unsupported, no push, no pop.
      {
        const writes: string[] = []
        const absentCtx = terminalSource({
          write(text) {
            writes.push(text)
          },
          queryWithSentinelOutcome: async (sequence) => {
            writes.push(sequence)
            const raw = "\x1b[?1;2c"
            return { match: null, reason: "sentinel", raw, rawBase64: btoa(raw) }
          },
        })
        const result = await p.term(absentCtx)
        expect(result.observation?.outcome, `${id}: absent`).toBe("unsupported")
        expect(writes, `${id}: absent`).toEqual(["\x1b[?u"])
      }

      // Flags answered: explicit push write, then the flag query, then pop even if the query throws.
      for (const outcome of ["reply", "error"] as const) {
        const writes: string[] = []
        let queryCall = 0
        const failure = new Error(`${id}: query failed`)
        const ctx = terminalSource({
          write(text) {
            writes.push(text)
          },
          queryWithSentinelOutcome: async (sequence) => {
            writes.push(sequence)
            queryCall++
            if (queryCall === 1) {
              const raw = "\x1b[?1u"
              return { match: [raw, "1"], reason: "reply", raw, rawBase64: btoa(raw) }
            }
            if (outcome === "error") throw failure
            const raw = "\x1b[?31u"
            return { match: [raw, "31"], reason: "reply", raw, rawBase64: btoa(raw) }
          },
        })

        if (outcome === "error") await expect(p.term(ctx)).rejects.toBe(failure)
        else expect((await p.term(ctx)).pass, `${id}: ${outcome}`).toBe(true)
        expect(writes, `${id}: ${outcome}`).toEqual(["\x1b[?u", `\x1b[>${flags}u`, "\x1b[?u", "\x1b[<u"])
      }
    }
  })

  test("Kitty probes pop only a push they actually wrote", async () => {
    const p = probe("extensions.kitty-keyboard")
    if (!p.term || !p.lib) throw new Error("missing keyboard callbacks")
    const lib = p.lib

    // Termless: the push feed throws before it is written -> no pop.
    {
      const feeds: string[] = []
      expect(() =>
        lib(
          context({
            feedCapture: () => "\x1b[?1u",
            feed(sequence) {
              feeds.push(sequence)
              if (sequence.startsWith("\x1b[>")) throw new Error("push failed")
            },
          }),
        ),
      ).toThrow(/push failed/)
      expect(feeds, "termless push failure").not.toContain("\x1b[<u")
    }

    // Termless: the push is written, then the flag query throws -> pop.
    {
      const feeds: string[] = []
      let captureCall = 0
      expect(() =>
        lib(
          context({
            feed(sequence) {
              feeds.push(sequence)
            },
            feedCapture() {
              captureCall++
              if (captureCall === 1) return "\x1b[?1u"
              throw new Error("query failed")
            },
          }),
        ),
      ).toThrow(/query failed/)
      expect(feeds, "termless post-push failure").toContain("\x1b[>1u")
      expect(feeds, "termless post-push failure").toContain("\x1b[<u")
    }

    // Term: the push write throws -> no pop; the push write succeeds then the flag query throws -> pop.
    for (const mode of ["push-write-throws", "query-throws"] as const) {
      const writes: string[] = []
      let queryCall = 0
      const ctx = terminalSource({
        write(sequence) {
          writes.push(sequence)
          if (mode === "push-write-throws" && sequence.startsWith("\x1b[>")) throw new Error("push failed")
        },
        queryWithSentinelOutcome: async () => {
          queryCall++
          if (queryCall === 1) {
            const raw = "\x1b[?1u"
            return { match: [raw, "1"], reason: "reply", raw, rawBase64: btoa(raw) }
          }
          throw new Error("query failed")
        },
      })
      if (mode === "push-write-throws") {
        await expect(p.term(ctx)).rejects.toThrow(/push failed/)
        expect(writes, `${mode} term`).not.toContain("\x1b[<u")
      } else {
        await expect(p.term(ctx)).rejects.toThrow(/query failed/)
        expect(writes, `${mode} term`).toContain("\x1b[>1u")
        expect(writes, `${mode} term`).toContain("\x1b[<u")
      }
    }
  })

  test("Kitty protocol detection reads flags, DA1-only negatives, and transport controls without a push", async () => {
    const p = probe("extensions.kitty-keyboard.report-text")
    if (!p.lib || !p.term) throw new Error("missing keyboard callbacks")

    const detections = [
      ["\x1b[?25u\x1b[?62;4c", "supported"], // flags + DA1
      ["\x1b[?25u", "supported"], // flags only, the no-DA1 control
      ["\x1b[?1;2c", "unsupported"], // DA1 only, the documented negative
      ["", "inconclusive"], // neither reply
      ["\x1b[?62;", "inconclusive"], // truncated DA1 is not a reply
      ["\x1b[?1;2c\x1b[?25u", "inconclusive"], // DA1 before flags, ambiguous ordering
      ["\x1b[?;u\x1b[?1;2c", "inconclusive"], // malformed flags (empty params) with DA1
      ["\x1b[?1;2u\x1b[?1;2c", "inconclusive"], // malformed flags (extra params) with DA1
      ["\x1b[?1:2u\x1b[?1;2c", "inconclusive"], // malformed flags (colon params) before DA1 — not the digits-only shape
      ["\x1b[?12", "inconclusive"], // truncated flags, no terminator
      ["\x1b[?12\x1b[?1;2c", "inconclusive"], // truncated flags before DA1
      ["\x00\x1b[?1;2c", "inconclusive"], // residual byte before an otherwise complete DA1
      ["\x1b[?1;2c\x07", "inconclusive"], // residual byte after an otherwise complete DA1
      ["\x1b[?1;2c\x1b[?1;2c", "inconclusive"], // duplicate DA1 — residual bytes around the first reply
    ] as const

    for (const [raw, outcome] of detections) {
      const captures: string[] = []
      const feeds: string[] = []
      const result = p.lib(
        context({
          feed(sequence) {
            feeds.push(sequence)
          },
          feedCapture(sequence) {
            captures.push(sequence)
            return raw
          },
        }),
      )
      if (raw === "") {
        expect(result.observation, `termless ${JSON.stringify(raw)}`).toBeUndefined()
        expect(result.assertions).toBeUndefined()
        expect(result.tests).toMatchObject([
          expect.objectContaining({
            status: "test-failure",
            reason: expect.stringContaining("No answer to the Kitty keyboard flags query"),
          }),
        ])
      } else {
        expect(result.observation?.outcome, `termless ${JSON.stringify(raw)}`).toBe(outcome)
      }
      expect(captures[0], `termless ${JSON.stringify(raw)}`).toBe("\x1b[?u\x1b[c")
      if (outcome !== "supported") {
        expect(captures, `termless ${JSON.stringify(raw)} query count`).toHaveLength(1)
        expect(feeds, `termless ${JSON.stringify(raw)} push count`).toEqual([])
      } else {
        expect(captures, `termless ${JSON.stringify(raw)}`).toEqual(["\x1b[?u\x1b[c", "\x1b[?u"])
        expect(feeds, `termless ${JSON.stringify(raw)}`).toEqual(["\x1b[>25u", "\x1b[<u"])
      }
    }

    for (const [raw, outcome] of detections) {
      const writes: string[] = []
      const result = await p.term(
        terminalSource({
          write(text) {
            writes.push(text)
          },
          queryWithSentinelOutcome: async (sequence, pattern) => {
            writes.push(sequence)
            const match = raw.match(pattern)
            const sentinel = /\x1b\[\?[0-9;]+c/.test(raw) && !match
            return {
              match: match ? [...match] : null,
              reason: match ? "reply" : sentinel ? "sentinel" : "timeout",
              raw,
              rawBase64: btoa(raw),
            }
          },
        }),
      )
      if (raw === "") {
        expect(result.observation).toBeUndefined()
        expect(result.assertions).toBeUndefined()
        expect(result.response).toBe("")
        expect(result.tests).toEqual([
          {
            id: "criterion",
            status: "test-failure",
            reason: "No answer to the Kitty keyboard flags query or the DA1 follow-up; no support conclusion",
          },
        ])
      } else {
        expect(result.observation, `term ${JSON.stringify(raw)}`).toMatchObject({
          outcome,
          assertionType: "query_reply",
        })
      }
      expect(writes[0], `term ${JSON.stringify(raw)}`).toBe("\x1b[?u")
      if (outcome !== "supported") {
        expect(writes, `term ${JSON.stringify(raw)} push/pop`).toEqual(["\x1b[?u"])
      } else {
        expect(writes, `term ${JSON.stringify(raw)}`).toEqual(["\x1b[?u", "\x1b[>25u", "\x1b[?u", "\x1b[<u"])
      }
    }
  })

  test("keyboard queries distinguish acknowledged flags from missing replies", async () => {
    const p = probe("extensions.kitty-keyboard.report-text")
    if (!p.term) throw new Error("missing keyboard callback")
    for (const [flags, outcome] of [
      [25, "supported"],
      [9, "unsupported"],
    ] as const) {
      const raw = `\x1b[?${flags}u`
      const writes: string[] = []
      const result = await p.term(
        terminalSource({
          write(sequence) {
            writes.push(sequence)
          },
          queryWithSentinelOutcome: async (_sequence, pattern) => ({
            match: raw.match(pattern),
            reason: "reply",
            raw,
            rawBase64: btoa(raw),
          }),
        }),
      )
      const push = writes.find((sequence) => sequence.startsWith("\x1b[>"))
      expect(Number(/\x1b\[>(\d+)u/.exec(push ?? "")?.[1]) & 24).toBe(24) // Associated text requires all-keys mode too.
      expect(result.observation).toMatchObject({ outcome, assertionType: "query_reply" })
      expect(result.assertions?.[0]?.observed).toContain(String(flags))
    }
    const timeout = await p.term(terminalSource({}))
    expect(timeout.observation).toBeUndefined()
    expect(timeout.assertions).toBeUndefined()
    expect(timeout.tests).toMatchObject([
      expect.objectContaining({
        status: "test-failure",
        reason: expect.stringContaining("No answer to the Kitty keyboard flags query"),
      }),
    ])
  })

  test("CSI-u recognition requires acknowledged flags, not a responsive cursor", async () => {
    const p = probe("input.csi-u")
    if (!p.term || !p.lib) throw new Error("CSI-u needs both callbacks")
    for (const [raw, outcome] of [
      ["\x1b[?1u", "supported"],
      ["\x1b[?0u", "unsupported"],
      ["", "inconclusive"],
    ] as const) {
      const result = await p.term(
        terminalSource({
          queryWithSentinelOutcome: async (_sequence, pattern) => ({
            match: raw.match(pattern),
            reason: raw ? "reply" : "sentinel",
            raw,
            rawBase64: btoa(raw),
          }),
        }),
      )
      if (raw === "") {
        expect(result.observation).toBeUndefined()
        expect(result.assertions).toBeUndefined()
        expect(result.tests).toMatchObject([
          expect.objectContaining({
            status: "test-failure",
            reason: expect.stringContaining("No answer to the Kitty keyboard flags query"),
          }),
        ])
      } else {
        expect(result.observation).toMatchObject({ outcome, assertionType: "query_reply" })
        expect(p.lib(context({ feedCapture: () => raw })).observation?.outcome).toBe(outcome)
      }
    }
  })

  test("notification detection tests the echoed query identifier and advertised title payload", async () => {
    const p = probe("extensions.osc99-kitty-notify")
    if (!p.term) throw new Error("missing notification callback")
    for (const [replyKind, outcome] of [
      ["valid", "supported"],
      ["wrong-id", "inconclusive"],
      ["missing-title", "inconclusive"],
      ["silence", "inconclusive"],
    ] as const) {
      const result = await p.term(
        terminalSource({
          write: () => {
            throw new Error("Support detection must not display a notification")
          },
          queryWithSentinelOutcome: async (sequence, pattern) => {
            const id = /\x1b\]99;i=([^:;]+):p=\?;/.exec(sequence)?.[1]
            if (!id) throw new Error("Missing notification capability query")
            const raw =
              replyKind === "silence"
                ? ""
                : `\x1b]99;i=${replyKind === "wrong-id" ? "unrelated" : id}:p=?;p=${replyKind === "missing-title" ? "body" : "title,body"}:o=always\x1b\\`
            return { match: raw.match(pattern), reason: "sentinel", raw, rawBase64: btoa(raw) }
          },
        }),
      )
      if (replyKind === "silence") {
        expect(result.observation).toBeUndefined()
        expect(result.assertions).toBeUndefined()
        expect(result.tests).toMatchObject([
          expect.objectContaining({
            status: "test-failure",
            reason: "No matching notification query reply; OS display was not tested",
          }),
        ])
      } else {
        expect(result.observation).toMatchObject({ outcome, assertionType: "query_reply" })
      }
      if (outcome === "supported") expect(result.assertions?.[0]?.observed).toContain("title,body")
    }
  })

  test("OSC 21 validates the requested foreground reply and never falls back to cursor consumption", async () => {
    const p = probe("extensions.osc21-kitty-color")
    if (!p.term || !p.lib) throw new Error("OSC 21 needs both callbacks")
    // The protocol explicitly permits an empty value for a dynamic/undefined color.
    for (const [body, outcome] of [
      ["foreground=rgb:ff/00/00", "supported"],
      ["foreground=", "supported"],
      ["background=rgb:ff/00/00", "inconclusive"],
      ["foreground=garbage", "inconclusive"],
      [null, "inconclusive"],
    ] as const) {
      const raw = body === null ? "" : `\x1b]21;${body}\x1b\\`
      const result = await p.term(
        terminalSource({
          queryWithSentinelOutcome: async (_sequence, pattern) => ({
            match: raw.match(pattern),
            reason: raw ? "reply" : "sentinel",
            raw,
            rawBase64: btoa(raw),
          }),
        }),
      )
      if (body === null) {
        expect(result.observation).toBeUndefined()
        expect(result.assertions).toBeUndefined()
        expect(result.tests).toMatchObject([
          expect.objectContaining({
            status: "test-failure",
            reason: "No OSC 21 reply; color rendering was not tested",
          }),
        ])
      } else {
        expect(result.observation).toMatchObject({ outcome, assertionType: "query_reply" })
        expect(p.lib(context({ feedCapture: () => raw })).observation?.outcome).toBe(outcome)
      }
    }
  })

  test("graphics upload and placement require their own acknowledgements and clean up only the allocated image", async () => {
    for (const kind of ["transmit", "display"]) {
      const p = probe(`extensions.kitty-graphics.${kind}`)
      if (!p.term || !p.lib) throw new Error("missing graphics callback")
      const silent = await p.term(terminalSource({}))
      expect(silent.pass).toBe(false) // A normal CPR must not turn an ignored APC into support.
      expect(silent.observation).toBeUndefined()
      expect(silent.assertions).toBeUndefined()
      expect(silent.tests).toMatchObject([
        expect.objectContaining({ status: "test-failure", reason: expect.any(String) }),
      ])
      for (const outcome of ["accepted", "rejected", "wrong-id"] as const) {
        const writes: string[] = []
        const responseTo = (sequence: string): string => {
          if (sequence.includes("a=t,")) {
            const number = /,I=(\d+)/.exec(sequence)?.[1]
            if (!number) throw new Error("Upload must request a fresh image rather than overwrite a fixed image ID")
            return `\x1b_Gi=745,I=${outcome === "wrong-id" ? "0" : number};${outcome === "rejected" ? "EINVAL:invalid image" : "OK"}\x1b\\`
          }
          if (sequence.includes("a=p,")) return "\x1b_Gi=745;OK\x1b\\"
          throw new Error(`Unexpected graphics request ${JSON.stringify(sequence)}`)
        }
        const result = await p.term(
          terminalSource({
            write: (sequence) => {
              writes.push(sequence)
            },
            queryWithSentinelOutcome: async (sequence, pattern) => {
              const raw = responseTo(sequence)
              return { match: raw.match(pattern), reason: "reply", raw, rawBase64: btoa(raw) }
            },
          }),
        )
        expect(result.observation).toMatchObject({
          outcome: outcome === "accepted" ? "supported" : "inconclusive",
          assertionType: "query_reply",
        })
        if (outcome === "accepted") expect(writes.join("")).toContain("a=d,d=I,i=745")
        else expect(writes).toEqual([]) // No acknowledged ownership; never delete an unrelated image.
        expect(p.lib(context({ feedCapture: responseTo })).observation?.outcome).toBe(result.observation?.outcome)
      }
    }
    const display = probe("extensions.kitty-graphics.display")
    if (!display.term) throw new Error("missing display callback")
    const writes: string[] = []
    const failure = new Error("placement query failed")
    await expect(
      display.term(
        terminalSource({
          write: (sequence) => {
            writes.push(sequence)
          },
          queryWithSentinelOutcome: async (sequence, pattern) => {
            if (sequence.includes("a=p,")) throw failure
            const number = /,I=(\d+)/.exec(sequence)?.[1]
            const raw = `\x1b_Gi=745,I=${number};OK\x1b\\`
            return { match: raw.match(pattern), reason: "reply", raw, rawBase64: btoa(raw) }
          },
        }),
      ),
    ).rejects.toBe(failure)
    expect(writes.join("")).toContain("a=d,d=I,i=745")
  })

  test("graphics detection uses the protocol query and never infers pixels from cursor movement", async () => {
    const p = probe("extensions.kitty-graphics")
    if (!p.term) throw new Error("missing graphics callback")
    const result = await p.term(
      terminalSource({
        queryWithSentinelOutcome: async (sequence, pattern) => {
          expect(sequence).toContain("a=q")
          const id = /(?:G|,)i=(\d+)/.exec(sequence)?.[1]
          expect(id).toBeDefined()
          const raw = `\x1b_Gi=${id};OK\x1b\\`
          return { match: raw.match(pattern), reason: "reply", raw, rawBase64: btoa(raw) }
        },
      }),
    )
    expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
    const silent = await p.term(terminalSource({ queryCursorPosition: async () => ({ row: 9, col: 9 }) }))
    expect(silent.observation).toBeUndefined()
    expect(silent.assertions).toBeUndefined()
    expect(silent.tests).toMatchObject([
      expect.objectContaining({
        status: "test-failure",
        reason: "No matching graphics query reply; image rendering was not tested",
      }),
    ])
  })
})

/**
 * @failure Declared capabilities, title-only changes, and CPR responsiveness became full graphics, notification, icon, CWD, or shell-integration support claims.
 * @level l0
 * @consumer Headless and application extension callbacks.
 * @testonly none
 */
describe("extensions without a complete behavior oracle", () => {
  const declaredIds = [
    "extensions.kitty-graphics.animation",
    "extensions.kitty-graphics.unicode-placeholders",
    "extensions.sixel",
    "extensions.reflow",
    "extensions.semantic-prompts",
    "extensions.osc7-cwd",
    "extensions.osc-633-vscode",
    "extensions.notifications",
    "extensions.iterm2-images",
  ] as const
  const noOracleAppIds = [
    "extensions.kitty-graphics.animation",
    "extensions.kitty-graphics.unicode-placeholders",
    "extensions.sixel",
    "extensions.semantic-prompts",
    "extensions.osc-633-vscode",
    "extensions.osc7-cwd",
    "extensions.notifications",
    "extensions.iterm2-images",
    "extensions.osc1-icon",
  ] as const

  test("true and false declarations remain diagnostics, never support conclusions", () => {
    for (const declared of [true, false]) {
      const base = context({})
      const capabilities = {
        ...base.capabilities,
        kittyGraphics: declared,
        sixel: declared,
        reflow: declared,
        semanticPrompts: declared,
        extensions: new Set(declared ? ["osc7", "osc9", "iterm2Images"] : []),
      }
      for (const id of declaredIds) {
        const callback = probe(id).lib
        if (!callback) throw new Error(`${id} needs a headless callback`)
        const result = callback(context({ capabilities }))
        expect(result.pass, id).toBe(false)
        // An engine declaration is coverage, not an attempted measurement: the arm names the
        // missing observable so the recorder grades TEST TODO instead of a failed test
        // (@cto 2026-10-22, 30695-inconclusive-mapping-ruling).
        expect(result.observation, id).toBeUndefined()
        expect(result.notTested, id).toMatchObject({ reason: "no-semantic-observable" })
        expect(result.notTested?.noObservable, id).toBe(result.note)
        const recorded = JSON.parse(result.response ?? "null") as Record<string, boolean>
        expect(Object.values(recorded), id).toContain(declared)
        expect(result.assertions ?? [], id).toEqual([])
      }
    }
  })

  test("a title change cannot establish icon-name support", () => {
    for (const id of ["extensions.osc1-icon"]) {
      const callback = probe(id).lib
      if (!callback) throw new Error(`${id} needs a headless callback`)
      for (const after of ["original", "test-icon My Title"]) {
        let fed = false
        const result = callback(
          context({
            feed() {
              fed = true
            },
            getTitle() {
              return fed ? after : "original"
            },
          }),
        )
        expect(result.pass, id).toBe(false)
        expect(result.observation, id).toBeUndefined()
        expect(result.notTested, id).toEqual({
          reason: "no-semantic-observable",
          noObservable: "icon-name state",
        })
        expect(JSON.parse(result.response ?? "null"), id).toEqual({ before: "original", after })
        expect(result.assertions ?? [], id).toEqual([])
      }
    }
  })

  test("application probes without a readback oracle do not mutate the terminal", async () => {
    for (const id of noOracleAppIds) {
      const callback = probe(id).term
      if (!callback) throw new Error(`${id} needs an application callback`)
      const writes: string[] = []
      const result = await callback(
        terminalSource({
          write(sequence) {
            writes.push(sequence)
          },
          queryCursorPosition: async () => {
            throw new Error(`${id} must not use CPR as its oracle`)
          },
        }),
      )
      expect(writes, id).toEqual([])
      expect(result.pass, id).toBe(false)
      expect(result.observation, id).toBeUndefined()
      expect(result.assertions, id).toBeUndefined()
      expect(result.tests, id).toMatchObject([
        expect.objectContaining({ status: "test-todo", reason: expect.any(String) }),
      ])
      expect(result.assertions ?? [], id).toEqual([])
    }
  })
})

/**
 * @failure Charset probes promoted a literal, blank, or arbitrary glyph without a measured ASCII fixture and exact target cells.
 * @level l0
 * @consumer Headless charset probe observations.
 * @testonly none
 */
describe("headless charset cell evidence", () => {
  const cases = [
    {
      id: "charsets.dec-special",
      minCols: 3,
      before: [..."qqq"],
      after: [..."q─q"],
      ignored: [..."qqq"],
      wrong: [..."q☃q"],
      trigger: "\x1b(0q",
      targetCol: 1,
      required: ["\x1b(0", "\x1b(B"],
    },
    {
      id: "charsets.utf8",
      minCols: 5,
      before: [..."Axy?Z"],
      after: ["A", "é", "世", "", "Z"],
      ignored: ["A", "x", "y", "?", "Z"],
      wrong: ["A", "é", "?", "", "Z"],
      trigger: "世",
      targetCol: 1,
      required: ["é", "世"],
    },
    {
      id: "charsets.g0-g1-switching",
      minCols: 5,
      before: [..."AlllZ"],
      after: [..."Al┌lZ"],
      ignored: [..."AlllZ"],
      wrong: [..."Al☃lZ"],
      trigger: "\x0e",
      targetCol: 1,
      required: ["\x1b(B", "\x1b)0", "\x0e", "\x0f", "\x1b)B"],
    },
    {
      id: "charsets.dec-line-drawing",
      minCols: 7,
      before: [..."jklmqxj"],
      after: [..."┘┐┌└─│j"],
      ignored: [..."jklmqxj"],
      wrong: [..."☃┐┌└─│j"],
      trigger: "\x1b(0jklmqx",
      targetCol: 0,
      required: ["\x1b(0", "\x1b(B"],
    },
  ] as const

  test("valid controls bind exact glyph support and ignored-target negatives to raw cells", () => {
    for (const item of cases) {
      const callback = probe(item.id).lib
      if (!callback) throw new Error(`${item.id} needs a headless callback`)
      for (const [after, outcome] of [
        [item.after, "supported"],
        [item.ignored, "unsupported"],
        [item.wrong, "unsupported"],
      ] as const) {
        const writes: string[] = []
        let applied = false
        let cursorX = 0
        let cursorY = 0
        const base = context({})
        const result = callback(
          context({
            feed(bytes) {
              writes.push(bytes)
              const cup = /^\x1b\[(\d+);(\d+)H$/.exec(bytes)
              if (cup) {
                cursorY = Number(cup[1]) - 1
                cursorX = Number(cup[2]) - 1
              }
              if (bytes.includes(item.trigger)) applied = true
            },
            getCursor() {
              return { x: cursorX, y: cursorY, visible: true, style: "block" }
            },
            getCell(row, col) {
              return { ...base.getCell(row, col), char: (applied ? after : item.before)[col] ?? "" }
            },
          }),
        )
        expect(result.observation, item.id).toMatchObject({ outcome, assertionType: "buffer_state" })
        expect(JSON.parse(result.response ?? "null"), item.id).toMatchObject({
          // The kind reads a GRID: one string[] per compared row, one entry per compared column.
          before: [item.before],
          after: [after],
          setup:
            item.id === "charsets.utf8"
              ? [
                  { x: 1, y: 0 },
                  { x: 2, y: 0 },
                ]
              : [{ x: item.targetCol, y: 0 }],
        })
        expect(result.assertions, item.id).toMatchObject([{ kind: outcome === "supported" ? "positive" : "negative" }])
        expect(result.assertions?.[0]?.observed, item.id).toBe(result.response)
        for (const bytes of item.required) expect(writes.join(""), item.id).toContain(bytes)
        if (item.id !== "charsets.utf8") expect(writes.at(-1), item.id).toBe("\x0f\x1b(B\x1b)B")
      }
    }
  })

  test("bad seed or broken ASCII control is inconclusive, and narrow geometry writes nothing", () => {
    for (const item of cases) {
      const callback = probe(item.id).lib
      if (!callback) throw new Error(`${item.id} needs a headless callback`)
      for (const badPhase of ["before", "after"] as const) {
        let applied = false
        let cursorX = 0
        const base = context({})
        const result = callback(
          context({
            feed(bytes) {
              const cup = /^\x1b\[1;(\d+)H$/.exec(bytes)
              if (cup) cursorX = Number(cup[1]) - 1
              if (bytes.includes(item.trigger)) applied = true
            },
            getCursor() {
              return { x: cursorX, y: 0, visible: true, style: "block" }
            },
            getCell(row, col) {
              const values: string[] = applied ? [...item.after] : [...item.before]
              if (badPhase === "before" && !applied) values[0] = "!"
              if (badPhase === "after" && applied) values[item.id === "charsets.dec-line-drawing" ? 6 : 0] = "!"
              return { ...base.getCell(row, col), char: values[col] ?? "" }
            },
          }),
        )
        expect(result.observation, `${item.id} ${badPhase}`).toMatchObject({
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          assertionType: "buffer_state",
        })
        expect(result.assertions ?? [], item.id).toEqual([])
      }
      const writes: string[] = []
      const narrow = callback(
        context({
          cols: item.minCols - 1,
          feed(bytes) {
            writes.push(bytes)
          },
        }),
      )
      expect(writes, item.id).toEqual([])
      expect(narrow.observation, item.id).toMatchObject({
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        assertionType: "buffer_state",
      })
      expect(JSON.parse(narrow.response ?? "null"), item.id).toMatchObject({ cols: item.minCols - 1 })
    }
    const switching = probe("charsets.g0-g1-switching").lib
    if (!switching) throw new Error("G0/G1 needs a headless callback")
    const writes: string[] = []
    const base = context({})
    let cursorX = 0
    expect(() =>
      switching(
        context({
          feed(bytes) {
            writes.push(bytes)
            if (bytes === "\x1b[1;2H") cursorX = 1
            if (bytes.includes("\x0e")) throw new Error("fixture feed failed")
          },
          getCursor() {
            return { x: cursorX, y: 0, visible: true, style: "block" }
          },
          getCell(row, col) {
            return { ...base.getCell(row, col), char: "AlllZ"[col] ?? "" }
          },
        }),
      ),
    ).toThrow("fixture feed failed")
    expect(writes.at(-1)).toBe("\x0f\x1b(B\x1b)B")
  })

  test("ignored target CUP stops before charset bytes instead of blaming the charset", () => {
    for (const item of cases) {
      const callback = probe(item.id).lib
      if (!callback) throw new Error(`${item.id} needs a headless callback`)
      const writes: string[] = []
      const base = context({})
      const wrongX = item.targetCol === 0 ? 1 : 0
      const result = callback(
        context({
          feed(bytes) {
            writes.push(bytes)
          },
          getCursor() {
            return { x: wrongX, y: 0, visible: true, style: "block" }
          },
          getCell(row, col) {
            return { ...base.getCell(row, col), char: item.before[col] ?? "" }
          },
        }),
      )
      expect(result.observation, item.id).toMatchObject({
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        assertionType: "buffer_state",
      })
      expect(JSON.parse(result.response ?? "null"), item.id).toMatchObject({ setup: [{ x: wrongX, y: 0 }] })
      expect(result.assertions ?? [], item.id).toEqual([])
      expect(writes.join(""), item.id).not.toContain(item.trigger)
    }

    const utf8 = probe("charsets.utf8").lib
    if (!utf8) throw new Error("UTF-8 needs a headless callback")
    const writes: string[] = []
    const base = context({})
    let cursorX = 0
    const second = utf8(
      context({
        feed(bytes) {
          writes.push(bytes)
          if (bytes === "\x1b[1;2H") cursorX = 1
          if (bytes === "\x1b[1;3H") cursorX = 1 // second CUP ignored
        },
        getCursor() {
          return { x: cursorX, y: 0, visible: true, style: "block" }
        },
        getCell(row, col) {
          return { ...base.getCell(row, col), char: "Axy?Z"[col] ?? "" }
        },
      }),
    )
    expect(second.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(JSON.parse(second.response ?? "null")).toMatchObject({
      setup: [
        { x: 1, y: 0 },
        { x: 1, y: 0 },
      ],
    })
    expect(writes.join("")).toContain("é")
    expect(writes.join("")).not.toContain("世")
    expect(second.assertions ?? []).toEqual([])
  })
})

describe("partial probe automation candidates", () => {
  // Q17: a mode-state reply cannot substitute for the absent presentation-timing observer.
  test("modes.decsclm names missing presentation timing instead of attempting a mode-state criterion", () => {
    const p = probe("modes.decsclm")
    if (!p.lib) throw new Error("Missing headless DECSCLM callback")
    const seen: string[] = []
    const result = p.lib(
      context({
        feed: (text) => seen.push(text),
        feedCapture: (text) => {
          seen.push(text)
          return "\x1b[?4;1$y"
        },
      }),
    )
    expect(result.notTested).toMatchObject({
      reason: "no-semantic-observable",
      noObservable: expect.stringMatching(/presentation.*tim|scroll.*tim/i),
    })
    expect(result.observation).toBeUndefined()
    expect(result.assertions).toBeUndefined()
    expect(seen).toEqual([])
  })

  // Q17: enabled metadata cannot supply a host palette actuator or persistent unsolicited-event listener.
  // The native DECRPM recognition table below never exercises this library coverage boundary.
  test.each([true, false, null] as const)(
    "mode 2031 names missing palette-event observation despite metadata %s",
    (enabled) => {
      const p = probe("modes.color-scheme-reporting")
      if (!p.lib) throw new Error("Missing headless color-scheme callback")
      const seen: string[] = []
      const result = p.lib(context({ getMode: () => enabled as boolean, feed: (text) => seen.push(text) }))
      expect(result.notTested).toMatchObject({
        reason: "no-semantic-observable",
        noObservable: expect.stringMatching(/palette|color.scheme/i),
      })
      expect(result.observation).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      expect(seen).toEqual([])
    },
  )

  test("device.dsr-996-color-scheme verifies the color-scheme response", () => {
    const p = probe("device.dsr-996-color-scheme")
    expect(p.lib).toBeTypeOf("function")

    const result = p.lib!(
      context({
        feedCapture(text) {
          expect(text).toBe("\x1b[?996n")
          return "\x1b[?997;1n"
        },
      }),
    )

    expect(result.pass).toBe(true)
    expect(result.response).toBe("\x1b[?997;1n")
  })

  test("OSC 113/114 reset probes require original, changed, and restored color replies", () => {
    const cases = [
      {
        id: "extensions.osc113-reset-pointer-fg",
        expected: "\x1b]13;?\x07",
        set: 13,
        original: "\x1b]13;rgb:1010/2020/3030\x1b\\",
        changed: "\x1b]13;rgb:aaaa/bbbb/cccc\x1b\\",
        reset: "\x1b]113\x07",
      },
      {
        id: "extensions.osc114-reset-pointer-bg",
        expected: "\x1b]14;?\x07",
        set: 14,
        original: "\x1b]14;rgb:1010/2020/3030\x1b\\",
        changed: "\x1b]14;rgb:aaaa/bbbb/cccc\x1b\\",
        reset: "\x1b]114\x07",
      },
    ]

    for (const c of cases) {
      const p = probe(c.id)
      expect(p.lib).toBeTypeOf("function")
      const feed: string[] = []
      const capture: string[] = []
      const replies = [c.original, c.changed, c.original]
      const result = p.lib!(
        context({
          feed(text) {
            feed.push(text)
          },
          feedCapture(text) {
            capture.push(text)
            return replies.shift() ?? ""
          },
        }),
      )
      expect(result.pass).toBe(true)
      expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
      expect(result.assertions).toMatchObject([{ kind: "positive" }])
      expect(capture).toEqual([c.expected, c.expected, c.expected])
      expect(feed).toEqual([`\x1b]${c.set};rgb:aa/bb/cc\x07`, c.reset])
      expect(replies).toEqual([])
    }
  })

  function colorStackFixture(
    failedQuery?: number,
    failedFeed?: "mutation" | "pop" | "restore",
    queryError: unknown = new Error("foreground query unavailable"),
  ) {
    const original = "rgb:1010/2020/3030"
    let current = original
    const stack: string[] = []
    const writes: string[] = []
    let queries = 0
    let feedFailed = false
    const ctx = context({
      feed(sequence) {
        writes.push(sequence)
        const action = sequence.includes("]30101")
          ? "pop"
          : sequence.includes(`]10;${original}`)
            ? "restore"
            : sequence.includes("]10;")
              ? "mutation"
              : "push"
        if (!feedFailed && action === failedFeed) {
          feedFailed = true
          throw new Error(`${action} unavailable`)
        }
        if (sequence.includes("]30001")) stack.push(current)
        else if (sequence.includes("]30101")) current = stack.pop() ?? current
        else current = /\x1b\]10;(rgb:[a-f\d/]+)/i.exec(sequence)?.[1] ?? current
      },
      feedCapture(sequence) {
        expect(sequence).toBe("\x1b]10;?\x07")
        if (++queries === failedQuery) throw queryError
        return `\x1b]10;${current}\x1b\\`
      },
    })
    return { ctx, original, writes, foreground: () => current, stackDepth: () => stack.length }
  }

  test("OSC 30001/30101 probes verify color stack restore behavior", () => {
    for (const id of ["extensions.osc30001-color-stack-push", "extensions.osc30101-color-stack-pop"]) {
      const p = probe(id)
      expect(p.lib).toBeTypeOf("function")
      const fixture = colorStackFixture()
      const result = p.lib!(fixture.ctx)
      expect(result.pass).toBe(true)
      expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
      expect(fixture.foreground()).toBe(fixture.original)
      expect(fixture.stackDepth()).toBe(0)
    }
  })

  /**
   * @failure Operational color-stack failures lose their observing method or cleanup leaves a success/assertion behind.
   * @level l0
   * @consumer Headless collectors recording both unmarked OSC color-stack callbacks.
   * @testonly none
   */
  test.each([
    { action: "initial query", failedQuery: 1, assertionType: "query_reply" },
    { action: "foreground mutation", failedFeed: "mutation", assertionType: "query_reply" },
    { action: "query after mutation", failedQuery: 2, assertionType: "query_reply" },
    { action: "stack pop", failedFeed: "pop", assertionType: "query_reply" },
    { action: "query after pop", failedQuery: 3, assertionType: "query_reply" },
    { action: "cleanup restore", failedFeed: "restore", assertionType: "query_reply" },
    { action: "query and cleanup restore", failedQuery: 2, failedFeed: "restore", assertionType: "query_reply" },
    { action: "query and cleanup pop", failedQuery: 2, failedFeed: "pop", assertionType: "query_reply" },
  ] as const)("color-stack $action failures retain their method and named diagnostics", (row) => {
    for (const id of ["extensions.osc30001-color-stack-push", "extensions.osc30101-color-stack-pop"]) {
      const fixture = colorStackFixture(
        "failedQuery" in row ? row.failedQuery : undefined,
        "failedFeed" in row ? row.failedFeed : undefined,
      )
      const definition = probe(id)
      expect(definition.libAssertionType).toBeUndefined()
      const result = definition.lib!(fixture.ctx)
      expect(result.pass).toBe(false)
      expect(result.observation).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      expect(result.tests).toMatchObject([
        expect.objectContaining({ status: "test-failure", reason: expect.stringContaining("failed: Error:") }),
      ])
      expect(result.note).toContain("Error:")
      expect(result.response).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      if ("failedQuery" in row) expect(result.note).toContain("foreground query unavailable")
      if ("failedFeed" in row) expect(result.note).toContain(`${row.failedFeed} unavailable`)
      if (row.action.startsWith("query and cleanup")) {
        expect(result.note).toContain("cleanup")
        expect(result.note).toContain("behavior")
      }
      expect(fixture.foreground()).toBe(fixture.original)
      if (row.action === "initial query") expect(fixture.writes).toEqual([])
      else expect(fixture.writes.at(-1)).toBe(`\x1b]10;${fixture.original}\x07`)
      if (row.action === "query and cleanup pop") {
        expect(fixture.writes.some((sequence) => sequence.includes("]30101"))).toBe(true)
      } else expect(fixture.stackDepth()).toBe(0)
    }
  })

  /**
   * @failure A cleanup error replaces an unexpected primary throw and is falsely graded.
   * @level l0
   * @consumer Headless collectors leaving unexpected callback throws ungraded.
   * @testonly none
   */
  test("unexpected color-stack throws remain ungraded and survive a cleanup failure", () => {
    const primary = "unexpected query adapter throw"
    for (const id of ["extensions.osc30001-color-stack-push", "extensions.osc30101-color-stack-pop"]) {
      const fixture = colorStackFixture(2, "restore", primary)
      let caught: unknown
      try {
        probe(id).lib!(fixture.ctx)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(AggregateError)
      if (!(caught instanceof AggregateError)) throw new Error("expected both callback and cleanup failures")
      expect(caught.errors).toContain(primary)
      expect(caught.message).toContain(primary)
      expect(caught.message).toContain("restore unavailable")
      expect(fixture.writes.some((sequence) => sequence.includes("]30101"))).toBe(true)
      expect(fixture.writes.at(-1)).toBe(`\x1b]10;${fixture.original}\x07`)
    }
  })

  // A CPR after an ignored OSC is not a color-stack reply; the original foreground must survive errors too.
  test("Kitty color-stack probes require a changed and restored foreground without leaking probe color", async () => {
    for (const id of ["extensions.osc30001-color-stack-push", "extensions.osc30101-color-stack-pop"]) {
      for (const [original, stackWorks] of [
        ["rgb:1010/2020/3030", true],
        ["rgb:1010/2020/3030", false],
        ["rgb:aaaa/bbbb/cccc", true],
      ] as const) {
        let current: string = original
        const stack: string[] = []
        const writes: string[] = []
        const result = await probe(id).term!(
          terminalSource({
            write(sequence) {
              writes.push(sequence)
              if (sequence.includes("]30001")) {
                if (stackWorks) stack.push(current)
              } else if (sequence.includes("]30101")) {
                if (stackWorks) current = stack.pop() ?? current
              } else {
                const set = /\x1b\]10;(rgb:[a-f\d/]+)(?:\x07|\x1b\\)/i.exec(sequence)
                if (set) current = set[1] ?? current
              }
            },
            queryWithSentinelOutcome: async (sequence, pattern) => {
              expect(sequence).toBe("\x1b]10;?\x07")
              const raw = `\x1b]10;${current}\x1b\\`
              return { match: raw.match(pattern), reason: "reply", raw, rawBase64: btoa(raw) }
            },
          }),
        )
        expect(result.observation?.outcome).toBe(stackWorks ? "supported" : "unsupported")
        expect(current).toBe(original)
        expect(writes.some((sequence) => sequence.includes("]30001"))).toBe(true)
        expect(writes.some((sequence) => sequence.includes("]30101"))).toBe(true)
      }

      const writes: string[] = []
      let queries = 0
      await expect(
        probe(id).term!(
          terminalSource({
            write(sequence) {
              writes.push(sequence)
            },
            queryWithSentinelOutcome: async (_sequence, pattern) => {
              if (++queries === 2) throw new Error("query failed after color change")
              const raw = "\x1b]10;rgb:1010/2020/3030\x1b\\"
              return { match: raw.match(pattern), reason: "reply", raw, rawBase64: btoa(raw) }
            },
          }),
        ),
      ).rejects.toThrow("query failed after color change")
      expect(writes.some((sequence) => sequence.includes("]30101"))).toBe(true)
      expect(writes.some((sequence) => sequence.includes("]10;rgb:1010/2020/3030"))).toBe(true)

      const noReplyWrites: string[] = []
      const noReply = await probe(id).term!(
        terminalSource({
          write: (sequence) => noReplyWrites.push(sequence),
          queryWithSentinelOutcome: async () => {
            const raw = "\x1b]10;rgb:1010/2020/3030\x1b\\"
            return { match: null, reason: "timeout", raw, rawBase64: btoa(raw) }
          },
        }),
      )
      expect(noReply.observation).toEqual({
        outcome: "inconclusive",
        assertionType: "query_reply",
        reason: "timeout",
        note: "No original OSC 10 foreground reply; color stack was not changed",
      })
      expect(noReply.response).toBe("\x1b]10;rgb:1010/2020/3030\x1b\\")
      expect(noReply.assertions).toBeUndefined()
      expect(noReply.tests).toBeUndefined()
      expect(noReplyWrites).toEqual([])
    }
  })

  test("mode 2031 requires its own DECRPM recognition, not a separate color-scheme query", async () => {
    const p = probe("modes.color-scheme-reporting")
    for (const [ps, outcome] of [
      [1, "supported"],
      [2, "supported"],
      [3, "supported"],
      [4, "unsupported"],
      [0, "unsupported"],
      [null, "inconclusive"],
    ] as const) {
      const result = await p.term!(
        terminalSource({
          queryMode: async () => {
            throw new Error("the 2031 arm reads Ps through queryWithSentinel, never the folded word (#30557)")
          },
          queryWithSentinel: async (sequence, pattern) => {
            if (sequence === "\x1b[?2031$p") return ps === null ? null : pattern.exec(`\x1b[?2031;${ps}$y`)
            return ["\x1b[?997;1n", "1"]
          },
        }),
      )
      if (ps === null) {
        expect(result.observation).toBeUndefined()
        expect(result.assertions).toBeUndefined()
        expect(result.tests).toMatchObject([
          expect.objectContaining({
            status: "test-failure",
            reason: "No DECRPM 2031 reply; update events were not tested",
          }),
        ])
      } else {
        expect(result.observation, `Ps ${ps}`).toMatchObject({ outcome, assertionType: "query_reply" })
      }
      if (ps === 4) {
        expect(result.assertions, "Ps 4").toMatchObject([
          { kind: "negative", expected: "DECRPM mode 2031 can be set", observed: "permanently reset (Ps 4)" },
        ])
      }
    }
  })

  test("DSR 996 accepts only complete 997 dark/light replies", async () => {
    const p = probe("device.dsr-996-color-scheme")
    for (const [raw, outcome] of [
      ["\x1b[?997;1n", "supported"],
      ["\x1b[?997;2n", "supported"],
      ["\x1b[?997;9n", "inconclusive"],
      ["\x1b[?997;1", "inconclusive"],
    ] as const) {
      const result = await p.term!(
        terminalSource({
          queryWithSentinelOutcome: async (sequence, pattern) => {
            expect(sequence).toBe("\x1b[?996n")
            return { match: raw.match(pattern), reason: "reply", raw, rawBase64: btoa(raw) }
          },
        }),
      )
      expect(result.observation).toMatchObject({ outcome, assertionType: "query_reply" })
    }
  })

  test("semantic prompt OSC consumption and CPR do not claim prompt integration", async () => {
    // Constant 1;2 CPR for every read must never qualify as a measured home / target / control sequence.
    for (const id of OSC_SEMANTIC_MARK_IDS) {
      const result = await probe(id).term!(terminalSource({ queryCursorPosition: async () => ({ row: 1, col: 2 }) }))
      expect(result.notTested).toBeUndefined()
      expect(result.observation).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      expect(result.tests).toMatchObject([
        expect.objectContaining({
          status: "test-todo",
          reason: "Marker consumption was not confirmed; shell prompt integration was not observed",
        }),
      ])
    }
    for (const id of OSC_SEMANTIC_MARK_IDS) {
      const result = await probe(id).term!(terminalSource({ queryCursorPosition: async () => null }))
      expect(result.notTested).toBeUndefined()
      expect(result.observation).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      expect(result.tests).toMatchObject([
        expect.objectContaining({ status: "test-failure", reason: "No cursor reply after semantic prompt marker" }),
      ])
    }
    for (const id of OSC_SEMANTIC_MARK_IDS) {
      // Constant 1;1 CPR: target never advances from home, so consumption is false and no coverage is claimed.
      const result = await probe(id).term!(terminalSource({ queryCursorPosition: async () => ({ row: 1, col: 1 }) }))
      expect(result.notTested).toBeUndefined()
      expect(result.observation).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      expect(result.tests).toMatchObject([
        expect.objectContaining({
          status: "test-todo",
          reason: "Marker consumption was not confirmed; shell prompt integration was not observed",
        }),
      ])
    }
    for (const id of OSC_SEMANTIC_MARK_IDS) {
      // Consumed-but-unqualified: home 1;1 -> target 1;2 advances, but control stays 1;2 instead of returning to 1;1.
      const reads = [
        { row: 1, col: 1 },
        { row: 1, col: 2 },
        { row: 1, col: 2 },
      ]
      let read = 0
      const result = await probe(id).term!(terminalSource({ queryCursorPosition: async () => reads[read++] ?? null }))
      expect(read).toBe(3)
      expect(result.notTested).toBeUndefined()
      expect(result.observation).toBeUndefined()
      expect(result).toMatchObject({
        tests: [
          expect.objectContaining({
            status: "test-todo",
            reason: "Marker was consumed; shell prompt integration was not observed",
          }),
        ],
      })
    }
    const noPromptMetadata = await probe("extensions.semantic-prompts").term!(
      terminalSource({ queryCursorPosition: async () => null }),
    )
    expect(noPromptMetadata.observation).toBeUndefined()
    expect(noPromptMetadata.tests).toEqual([
      {
        id: "criterion",
        status: "test-todo",
        reason: "No shell prompt integration metadata or behavior readback for OSC 133",
      },
    ])
    for (const id of OSC_SEMANTIC_MARK_IDS) {
      // Qualified cursor movement (0,0 -> 1,0 -> 0,0) with empty or non-X cell: consumed && keeps this inconclusive.
      for (const char of ["", "-"]) {
        const reads = [
          { x: 0, y: 0, visible: true, style: "block" as const },
          { x: 1, y: 0, visible: true, style: "block" as const },
          { x: 0, y: 0, visible: true, style: "block" as const },
        ]
        let read = 0
        const base = context({})
        const result = probe(id).lib!(
          context({
            getCursor: () => reads[read++] ?? reads[2]!,
            getCell(row, col) {
              return { ...base.getCell(row, col), char }
            },
          }),
        )
        expect(read, `${id} char=${JSON.stringify(char)}`).toBe(3)
        expect(result.notTested, `${id} char=${JSON.stringify(char)}`).toBeUndefined()
        expect(result.observation, `${id} char=${JSON.stringify(char)}`).toBeUndefined()
        expect(result, `${id} char=${JSON.stringify(char)}`).toMatchObject({
          tests: [
            expect.objectContaining({
              status: "test-todo",
              reason: "Marker consumption was not confirmed; shell prompt integration was not observed",
            }),
          ],
        })
      }
    }
    for (const id of OSC_SEMANTIC_MARK_IDS) {
      // Constant cursor (0,0) with cell.char === "X": consumed is true, but cursor motion is unqualified.
      const result = probe(id).lib!(context({ getCell: () => ({ ...context({}).getCell(0, 0), char: "X" }) }))
      expect(result.notTested).toBeUndefined()
      expect(result.observation).toBeUndefined()
      expect(result).toMatchObject({
        tests: [
          expect.objectContaining({
            status: "test-todo",
            reason: "Marker was consumed; shell prompt integration was not observed",
          }),
        ],
      })
    }
  })

  test("semantic prompt app callbacks record named not-tested coverage for a measured home/target/control sequence", async () => {
    const marks = new Set<string>()
    for (const [id, sequence] of OSC_SEMANTIC_MARK_CASES) {
      const writes: string[] = []
      const reads = [
        { row: 1, col: 1 },
        { row: 1, col: 2 },
        { row: 1, col: 1 },
      ]
      let read = 0
      const result = await probe(id).term!(
        terminalSource({
          write: (data) => {
            writes.push(data)
          },
          queryCursorPosition: async () => reads[read++] ?? null,
        }),
      )
      expect(writes, id).toEqual(["\x1b[1;1H\x1b[2K", `${sequence}X`, "\x1b[1;1H"])
      expect(read, id).toBe(3)
      expect(result.observation, id).toBeUndefined()
      expect(result.assertions ?? [], id).toHaveLength(0)
      expect(result.notTested, id).toMatchObject({ reason: "no-semantic-observable" })
      expect((result.notTested?.noObservable ?? "").trim().length, id).toBeGreaterThan(0)
      expect(JSON.parse(result.response ?? "{}"), id).toEqual({
        home: reads[0],
        target: reads[1],
        control: reads[2],
      })
      marks.add(result.notTested!.noObservable)
    }
    expect(marks.size).toBe(OSC_SEMANTIC_MARK_IDS.length)
  })

  test("mintty and rxvt query probes verify typed OSC responses", () => {
    const cases = [
      ["extensions.osc7770-font-size", "\x1b]7770;?\x07", "\x1b]7770;12\x1b\\"],
      ["extensions.osc7777-font-window-size", "\x1b]7777;?\x07", "\x1b]7777;12\x1b\\"],
      ["extensions.osc701-locale", "\x1b]701;?\x07", "\x1b]701;en_US.UTF-8\x1b\\"],
      ["extensions.osc702-version", "\x1b]702\x07", "\x1b]702;vterm.js;vterm;0;2\x1b\\"],
      ["extensions.osc776-cell-size", "\x1b]776\x07", "\x1b]776;8;17;14\x1b\\"],
    ] as const

    for (const [id, expected, response] of cases) {
      const p = probe(id)
      expect(p.lib).toBeTypeOf("function")
      const result = p.lib!(
        context({
          feedCapture(text) {
            expect(text).toBe(expected)
            return response
          },
        }),
      )
      expect(result.pass).toBe(true)
    }
  })

  test("OSC 720 verifies scrollback viewport movement", () => {
    const p = probe("extensions.osc720-scroll-up")
    expect(p.lib).toBeTypeOf("function")

    let scrollReads = 0
    const fed: string[] = []
    const result = p.lib!(
      context({
        feed(text) {
          fed.push(text)
        },
        getScrollback() {
          scrollReads++
          return scrollReads === 1
            ? { viewportOffset: 1, totalLines: 4, screenLines: 3 }
            : { viewportOffset: 0, totalLines: 4, screenLines: 3 }
        },
      }),
    )

    expect(result.pass).toBe(true)
    expect(fed).toContain("\x1b]720\x07")
  })
})
