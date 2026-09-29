import { describe, expect, test } from "vitest"
import { ALL_PROBES, type TermlessContext, type TermContext } from "./index.ts"

function probe(id: string) {
  const found = ALL_PROBES.find((p) => p.id === id)
  if (!found) throw new Error(`missing probe ${id}`)
  return found
}

function context(overrides: Partial<TermlessContext>): TermlessContext {
  return {
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

function terminalContext(overrides: Partial<TermContext>): TermContext {
  return {
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
  if (!geometry.termless || !geometry.term) throw new Error("Sixel geometry requires both callbacks")
  const headless = geometry.termless
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
      terminalContext({
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
      expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
      expect(result.assertions?.[0]).toMatchObject({ kind: "positive", observed: raw })
    }
    expect(geometry.termWrites).toBe("query")
  })

  test("a valid-looking frame after the DA1 sentinel cannot be promoted from raw bytes", async () => {
    const raw = "\x1b[?62;52;c\x1b[?2;0;640;480S"
    const result = await fromTerminal(raw, true)
    expect(result).toMatchObject({ pass: false, response: raw })
    expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "no-response", evidence: "query" })
    expect(result.assertions).toBeUndefined()
  })

  test("a geometry frame before DA1 supports while preserving the full raw trace", async () => {
    const frame = "\x1b[?2;0;640;480S"
    const raw = `${frame}\x1b[?62;52;c`
    const result = await fromTerminal(raw)
    expect(result).toMatchObject({ pass: true, response: raw })
    expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
    expect(result.assertions?.[0]).toMatchObject({ kind: "positive", observed: frame })
  })

  test("protocol failure, color count, malformed dimensions, zero geometry, and silence stay inconclusive", async () => {
    for (const [raw, reason] of [
      ["\x1b[?2;3;0S", "insufficient-evidence"],
      ["\x1b[?1;0;256S", "no-response"],
      ["\x1b[?2;0;640S", "invalid-reply"],
      ["\x1b[?2;0;0;480S", "insufficient-evidence"],
      ["", "no-response"],
    ] as const) {
      for (const result of [fromHeadless(raw), await fromTerminal(raw)]) {
        expect(result).toMatchObject({ pass: false, response: raw })
        expect(result.observation).toMatchObject({ outcome: "inconclusive", reason, evidence: "query" })
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

  function linkedContext(links: readonly (string | null | undefined)[], declared = true): TermlessContext {
    const base = context({})
    return context({
      capabilities: { ...base.capabilities, osc8Hyperlinks: declared },
      getCell(_row, col) {
        const link = links[col]
        return {
          ...base.getCell(0, col),
          char: "ALINKZ"[col] ?? "",
          ...(link !== undefined && { hyperlink: link }),
        }
      },
    })
  }

  test("four exact URI cells bracketed by unlinked controls establish support", () => {
    const p = probe("extensions.osc8")
    if (!p.termless) throw new Error("OSC 8 needs headless callback")
    const result = p.termless(linkedContext(positions))
    expect(result.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
    expect(result.assertions?.[0]).toMatchObject({ kind: "positive" })
    // The headless batch admits parser-state conclusions only when the exact
    // assertion observation is the immutable raw response for this feature.
    expect(result.assertions?.[0]?.observed).toBe(result.response)
  })

  test("wrong URI or link leaking past close is unsupported with measured mismatch", () => {
    const p = probe("extensions.osc8")
    if (!p.termless) throw new Error("OSC 8 needs headless callback")
    for (const links of [
      [null, uri, "https://wrong.example", uri, uri, null],
      [null, uri, uri, uri, uri, uri],
    ]) {
      const result = p.termless(linkedContext(links))
      expect(result.observation).toMatchObject({ outcome: "unsupported", evidence: "parser-state" })
      expect(result.assertions?.[0]).toMatchObject({ kind: "negative" })
      expect(result.assertions?.[0]?.observed).toBe(result.response)
    }
  })

  test("missing link metadata is inconclusive, but a true declaration with absent field is an error", () => {
    const p = probe("extensions.osc8")
    if (!p.termless) throw new Error("OSC 8 needs headless callback")
    const unreported = p.termless(linkedContext(Array(6).fill(undefined), false))
    expect(unreported.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(() => p.termless?.(linkedContext(Array(6).fill(undefined), true))).toThrow(/OSC 8.*metadata.*declared/i)
  })

  test("application CPR consumption remains inconclusive", async () => {
    const p = probe("extensions.osc8")
    if (!p.term) throw new Error("OSC 8 needs application callback")
    const result = await p.term(terminalContext({ queryCursorPosition: async () => ({ row: 1, col: 7 }) }))
    expect(result.observation).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "consumed",
    })
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
    if (!p.term || !p.termless) throw new Error("Reflow needs both callbacks")
    for (const declared of [true, false]) {
      const writes: string[] = []
      const headless = p.termless(
        context({
          capabilities: { ...context({}).capabilities, reflow: declared },
          feed(sequence) {
            writes.push(sequence)
          },
        }),
      )
      const terminal = await p.term(
        terminalContext({
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
      for (const [result, evidence] of [
        [headless, "legacy"],
        [terminal, "none"],
      ] as const) {
        expect(result.pass).toBe(false)
        expect(result.observation).toMatchObject({
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence,
        })
        expect(result.note).toMatch(/controlled resize|readback/i)
      }
      expect(headless.response).toContain(String(declared))
    }
  })

  test("OSC 66 measures width and scale rather than treating consumption as support", async () => {
    const p = probe("extensions.osc66-text-sizing")
    if (!p.term || !p.termless) throw new Error("OSC 66 needs both probe methods")
    // CPR 1→3→5 captured from Kitty 0.46.2; ignored OSC leaves all three at 1.
    for (const [positions, expected] of [
      [[1, 1, 1], false],
      [[1, 3, 5], true],
      [[1, 3, 3], false],
    ] as const) {
      const written: string[] = []
      let index = 0
      const term = await p.term(
        terminalContext({
          write(text) {
            written.push(text)
          },
          queryCursorPosition: async () => ({ row: 1, col: positions[index++] ?? 1 }),
        }),
      )
      expect(term.pass).toBe(expected)
      expect(term.observation).toMatchObject({ outcome: expected ? "supported" : "unsupported", evidence: "behavior" })
      expect(written).toContain("\x1b]66;w=2; \x07")
      expect(written).toContain("\x1b]66;s=2; \x07")
      index = 0
      const headless = p.termless(
        context({
          getCursor() {
            return { x: (positions[index++] ?? 1) - 1, y: 0, visible: true, style: "block" }
          },
        }),
      )
      expect(headless.pass).toBe(expected)
      expect(headless.observation).toMatchObject({
        outcome: expected ? "supported" : "unsupported",
        evidence: "parser-state",
      })
    }
    const missingWrites: string[] = []
    let missingQueries = 0
    const missing = await p.term(
      terminalContext({
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
    expect(missing.observation).toMatchObject({
      outcome: "inconclusive",
      reason: "no-response",
    })
  })

  test("OSC 66 requires a measured home cursor before either protocol write", async () => {
    const p = probe("extensions.osc66-text-sizing")
    if (!p.term || !p.termless) throw new Error("OSC 66 needs both callbacks")
    for (const baseline of [
      { row: 1, col: 2 },
      { row: 2, col: 1 },
    ]) {
      const writes: string[] = []
      let queries = 0
      const terminal = await p.term(
        terminalContext({
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
      const headless = p.termless(
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

  test("OSC 5522 detects protocol support with DECRQM, without reading the clipboard", async () => {
    const p = probe("extensions.osc5522-clipboard")
    if (!p.term || !p.termless) throw new Error("OSC 5522 needs both probe methods")
    // The protocol explicitly treats Ps=0 and Ps=4 as unsupported.
    for (const ps of [2, 0, 1, 3, 4]) {
      const response = `\x1b[?5522;${ps}$y`
      const expected = ps > 0 && ps < 4
      const headless = p.termless(
        context({
          feedCapture(text) {
            return text === "\x1b[?5522$p" ? response : ""
          },
        }),
      )
      expect(headless.pass).toBe(expected)
      const term = await p.term(
        terminalContext({
          queryWithSentinel: async (sequence, pattern) =>
            sequence === "\x1b[?5522$p" ? response.match(pattern) : null,
          queryWithSentinelOutcome: async (sequence, pattern) => ({
            match: sequence === "\x1b[?5522$p" ? response.match(pattern) : null,
            reason: "reply",
            raw: response,
            rawBase64: btoa(response),
          }),
        }),
      )
      expect(term.pass).toBe(expected)
      expect(term.response).toBe(response)
      expect(term.observation).toMatchObject({ outcome: expected ? "supported" : "unsupported", evidence: "query" })
    }
    expect((await p.term(terminalContext({}))).pass).toBe(false)
  })

  // OSC 52 previously passed on any substring or on unrelated CPR, and left live clipboard writes behind.
  // No existing protocol test covers these three callbacks or the collector's no-clipboard policy.
  test("OSC 52 requires a complete nonce roundtrip in headless mode and never touches a live clipboard", async () => {
    for (const id of ["extensions.osc52-clipboard", "extensions.osc52-write", "extensions.osc52-read"]) {
      const p = probe(id)
      if (!p.termless || !p.term) throw new Error(`${id} needs both callbacks`)

      const sent: string[] = []
      const headless = p.termless(
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
      expect(headless.observation).toMatchObject({ outcome: "supported", evidence: "query" })

      for (const reply of [
        "\x1b[1;1R", // Unrelated CPR cannot prove a clipboard write.
        "\x1b]52;c;d3Jvbmc=\x07", // A valid but different clipboard value is not the nonce.
        "\x1b]52;p;d3Jvbmc=\x07", // The primary selection is not c.
        "\x1b]52;c;not-base64!\x07",
        "\x1b]52;c;d3Jvbmc=\x1b", // ESC alone is not a complete ST.
        "",
      ]) {
        const result = p.termless(context({ feedCapture: () => reply }))
        expect(result.observation?.outcome, `${id}: ${JSON.stringify(reply)}`).toBe("inconclusive")
        expect(result.pass).toBe(false)
      }

      const liveWrites: string[] = []
      const live = await p.term(
        terminalContext({
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
      expect(live.observation).toMatchObject({ outcome: "inconclusive", reason: "policy-refused" })
      expect(live.note).toMatch(/collector|owned clipboard/i)
    }
  })

  // An owned fixture measures write and read independently; an echoed OSC frame alone cannot prove a write.
  test("owned live OSC 52 checks independent clipboard state and complete canonical query replies", async () => {
    const written: string[] = []
    let clipboard = "baseline"
    const fixture = {
      readText: async () => clipboard,
      writeText: async (text: string) => {
        clipboard = text
      },
    }
    const withClipboardFixture: NonNullable<TermContext["withClipboardFixture"]> = async (work) => work(fixture)
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
        terminalContext({
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
        evidence: id === "extensions.osc52-write" ? "behavior" : "query",
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
        terminalContext({
          withClipboardFixture,
          queryOutcome: async () => ({
            match: null,
            reason: "timeout",
            raw,
            rawBase64: Buffer.from(raw).toString("base64"),
          }),
        }),
      )
      expect(result.observation?.outcome, JSON.stringify(raw)).toBe("inconclusive")
    }
    const uncorrelated = await read.term(
      terminalContext({
        withClipboardFixture,
        queryOutcome: async () => {
          const raw = `\x1b]52;c;${btoa(clipboard)}\x07`
          return { match: null, reason: "timeout", raw, rawBase64: Buffer.from(raw).toString("base64") }
        },
      }),
    )
    expect(uncorrelated.observation).toMatchObject({ outcome: "inconclusive", reason: "invalid-reply" })
    let captured = false
    const prompt = await read.term(
      terminalContext({
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

  // A rejected query used to skip the pop and leak this probe's keyboard mode into later probes.
  test("Kitty keyboard probes pop their own stack entry after a reply, no reply, or query error", async () => {
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
      for (const outcome of ["reply", "no-reply", "error"] as const) {
        const writes: string[] = []
        const failure = new Error(`${id}: query failed`)
        const ctx = terminalContext({
          write(text) {
            writes.push(text)
          },
          queryWithSentinel: async (sequence) => {
            writes.push(sequence)
            if (outcome === "error") throw failure
            return outcome === "reply" ? ["\x1b[?31u", "31"] : null
          },
          queryWithSentinelOutcome: async (sequence) => {
            writes.push(sequence)
            if (outcome === "error") throw failure
            const raw = outcome === "reply" ? "\x1b[?31u" : ""
            return {
              match: outcome === "reply" ? [raw, "31"] : null,
              reason: outcome === "reply" ? "reply" : "sentinel",
              raw,
              rawBase64: btoa(raw),
            }
          },
          queryCursorPosition: async () => {
            if (outcome === "error") throw failure
            return outcome === "reply" ? { row: 1, col: 1 } : null
          },
        })

        if (outcome === "error") await expect(p.term(ctx)).rejects.toBe(failure)
        else expect((await p.term(ctx)).pass, `${id}: ${outcome}`).toBe(outcome === "reply")
        expect(writes, `${id}: ${outcome}`).toEqual([`\x1b[>${flags}u\x1b[?u`, "\x1b[<u"])
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
      const result = await p.term(
        terminalContext({
          queryWithSentinelOutcome: async (sequence, pattern) => {
            const push = /\x1b\[>(\d+)u/.exec(sequence)
            expect(Number(push?.[1]) & 24).toBe(24) // Associated text requires all-keys mode too.
            return { match: raw.match(pattern), reason: "reply", raw, rawBase64: btoa(raw) }
          },
        }),
      )
      expect(result.observation).toMatchObject({ outcome, evidence: "query" })
      expect(result.assertions?.[0]?.observed).toContain(String(flags))
    }
    const timeout = await p.term(terminalContext({}))
    expect(timeout.observation).toMatchObject({ outcome: "inconclusive", reason: "timeout" })
  })

  test("CSI-u recognition requires acknowledged flags, not a responsive cursor", async () => {
    const p = probe("input.csi-u")
    if (!p.term || !p.termless) throw new Error("CSI-u needs both callbacks")
    for (const [raw, outcome] of [
      ["\x1b[?1u", "supported"],
      ["\x1b[?0u", "unsupported"],
      ["", "inconclusive"],
    ] as const) {
      const result = await p.term(
        terminalContext({
          queryWithSentinelOutcome: async (_sequence, pattern) => ({
            match: raw.match(pattern),
            reason: raw ? "reply" : "sentinel",
            raw,
            rawBase64: btoa(raw),
          }),
        }),
      )
      expect(result.observation).toMatchObject({ outcome, evidence: "query" })
      expect(p.termless(context({ feedCapture: () => raw })).observation?.outcome).toBe(outcome)
    }
  })

  test("notification detection checks the echoed query identifier and advertised title payload", async () => {
    const p = probe("extensions.osc99-kitty-notify")
    if (!p.term) throw new Error("missing notification callback")
    for (const [replyKind, outcome] of [
      ["valid", "supported"],
      ["wrong-id", "inconclusive"],
      ["missing-title", "inconclusive"],
      ["silence", "inconclusive"],
    ] as const) {
      const result = await p.term(
        terminalContext({
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
      expect(result.observation).toMatchObject({ outcome, evidence: "query" })
      if (outcome === "supported") expect(result.assertions?.[0]?.observed).toContain("title,body")
    }
  })

  test("OSC 21 validates the requested foreground reply and never falls back to cursor consumption", async () => {
    const p = probe("extensions.osc21-kitty-color")
    if (!p.term || !p.termless) throw new Error("OSC 21 needs both callbacks")
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
        terminalContext({
          queryWithSentinelOutcome: async (_sequence, pattern) => ({
            match: raw.match(pattern),
            reason: raw ? "reply" : "sentinel",
            raw,
            rawBase64: btoa(raw),
          }),
        }),
      )
      expect(result.observation).toMatchObject({ outcome, evidence: "query" })
      expect(p.termless(context({ feedCapture: () => raw })).observation?.outcome).toBe(outcome)
    }
  })

  test("graphics upload and placement require their own acknowledgements and clean up only the allocated image", async () => {
    for (const kind of ["transmit", "display"]) {
      const p = probe(`extensions.kitty-graphics.${kind}`)
      if (!p.term || !p.termless) throw new Error("missing graphics callback")
      const silent = await p.term(terminalContext({}))
      expect(silent.pass).toBe(false) // A normal CPR must not turn an ignored APC into support.
      expect(silent.observation?.outcome).toBe("inconclusive")
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
          terminalContext({
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
          evidence: "query",
        })
        if (outcome === "accepted") expect(writes.join("")).toContain("a=d,d=I,i=745")
        else expect(writes).toEqual([]) // No acknowledged ownership; never delete an unrelated image.
        expect(p.termless(context({ feedCapture: responseTo })).observation?.outcome).toBe(result.observation?.outcome)
      }
    }
    const display = probe("extensions.kitty-graphics.display")
    if (!display.term) throw new Error("missing display callback")
    const writes: string[] = []
    const failure = new Error("placement query failed")
    await expect(
      display.term(
        terminalContext({
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
      terminalContext({
        queryWithSentinelOutcome: async (sequence, pattern) => {
          expect(sequence).toContain("a=q")
          const id = /(?:G|,)i=(\d+)/.exec(sequence)?.[1]
          expect(id).toBeDefined()
          const raw = `\x1b_Gi=${id};OK\x1b\\`
          return { match: raw.match(pattern), reason: "reply", raw, rawBase64: btoa(raw) }
        },
      }),
    )
    expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
    const silent = await p.term(terminalContext({ queryCursorPosition: async () => ({ row: 9, col: 9 }) }))
    expect(silent.observation).toMatchObject({ outcome: "inconclusive", reason: "timeout" })
  })
})

describe("partial probe automation candidates", () => {
  test("modes.decsclm verifies the DEC private mode through DECRPM", () => {
    const p = probe("modes.decsclm")
    expect(p.termless).toBeTypeOf("function")

    const seen: string[] = []
    const result = p.termless!(
      context({
        feed(text) {
          seen.push(text)
        },
        feedCapture(text) {
          seen.push(text)
          return "\x1b[?4;1$y"
        },
      }),
    )

    expect(result.pass).toBe(true)
    expect(seen).toEqual(["\x1b[?4h", "\x1b[?4$p", "\x1b[?4l"])
  })

  test("device.dsr-996-color-scheme verifies the color-scheme response", () => {
    const p = probe("device.dsr-996-color-scheme")
    expect(p.termless).toBeTypeOf("function")

    const result = p.termless!(
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

  test("OSC 113/114 reset probes verify pointer color reset through query responses", () => {
    const cases = [
      {
        id: "extensions.osc113-reset-pointer-fg",
        expected: "\x1b]13;?\x07",
        response: "\x1b]13;rgb:ffff/ffff/ffff\x1b\\",
      },
      {
        id: "extensions.osc114-reset-pointer-bg",
        expected: "\x1b]14;?\x07",
        response: "\x1b]14;rgb:0000/0000/0000\x1b\\",
      },
    ]

    for (const c of cases) {
      const p = probe(c.id)
      expect(p.termless).toBeTypeOf("function")
      const feed: string[] = []
      const capture: string[] = []
      const result = p.termless!(
        context({
          feed(text) {
            feed.push(text)
          },
          feedCapture(text) {
            capture.push(text)
            return c.response
          },
        }),
      )
      expect(result.pass).toBe(true)
      expect(capture).toEqual([c.expected])
      expect(feed.length).toBeGreaterThan(0)
    }
  })

  test("OSC 30001/30101 probes verify color stack restore behavior", () => {
    for (const id of ["extensions.osc30001-color-stack-push", "extensions.osc30101-color-stack-pop"]) {
      const p = probe(id)
      expect(p.termless).toBeTypeOf("function")
      let current = "rgb:1010/2020/3030"
      const stack: string[] = []
      const result = p.termless!(
        context({
          feed(sequence) {
            if (sequence.includes("]30001")) stack.push(current)
            else if (sequence.includes("]30101")) current = stack.pop() ?? current
            else current = /\x1b\]10;(rgb:[a-f\d/]+)/i.exec(sequence)?.[1] ?? current
          },
          feedCapture(sequence) {
            expect(sequence).toBe("\x1b]10;?\x07")
            return `\x1b]10;${current}\x1b\\`
          },
        }),
      )
      expect(result.pass).toBe(true)
      expect(result.observation).toMatchObject({ outcome: "supported", evidence: "behavior" })
      expect(current).toBe("rgb:1010/2020/3030")
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
          terminalContext({
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
          terminalContext({
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
        terminalContext({
          write: (sequence) => noReplyWrites.push(sequence),
          queryWithSentinelOutcome: async () => {
            const raw = "\x1b]10;rgb:1010/2020/3030\x1b\\"
            return { match: null, reason: "timeout", raw, rawBase64: btoa(raw) }
          },
        }),
      )
      expect(noReply.observation?.outcome).toBe("inconclusive")
      expect(noReplyWrites).toEqual([])
    }
  })

  test("mode 2031 requires its own DECRPM recognition, not a separate color-scheme query", async () => {
    const p = probe("modes.color-scheme-reporting")
    for (const [state, outcome] of [
      ["set", "supported"],
      ["reset", "supported"],
      ["unknown", "unsupported"],
      [null, "inconclusive"],
    ] as const) {
      const result = await p.term!(
        terminalContext({
          queryMode: async (mode) => {
            expect(mode).toBe(2031)
            return state
          },
          queryWithSentinel: async () => ["\x1b[?997;1n", "1"],
        }),
      )
      expect(result.observation).toMatchObject({ outcome, evidence: "query" })
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
        terminalContext({
          queryWithSentinelOutcome: async (sequence, pattern) => {
            expect(sequence).toBe("\x1b[?996n")
            return { match: raw.match(pattern), reason: "reply", raw, rawBase64: btoa(raw) }
          },
        }),
      )
      expect(result.observation).toMatchObject({ outcome, evidence: "query" })
    }
  })

  test("semantic prompt OSC consumption and CPR do not claim prompt integration", async () => {
    for (const id of [
      "extensions.semantic-prompts",
      "extensions.osc133-a",
      "extensions.osc133-d",
      "extensions.osc-633-vscode",
      "extensions.osc633-a",
    ]) {
      const result = await probe(id).term!(terminalContext({ queryCursorPosition: async () => ({ row: 1, col: 2 }) }))
      expect(result.observation).toMatchObject({
        outcome: "inconclusive",
        evidence: "consumed",
        reason: "insufficient-evidence",
      })
    }
    expect(
      (await probe("extensions.semantic-prompts").term!(terminalContext({ queryCursorPosition: async () => null })))
        .observation,
    ).toMatchObject({ outcome: "inconclusive", reason: "no-response" })
    for (const id of ["extensions.osc133-a", "extensions.osc633-a"]) {
      const result = probe(id).termless!(context({ getCell: () => ({ ...context({}).getCell(0, 0), char: "X" }) }))
      expect(result.observation).toMatchObject({
        outcome: "inconclusive",
        evidence: "consumed",
        reason: "insufficient-evidence",
      })
    }
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
      expect(p.termless).toBeTypeOf("function")
      const result = p.termless!(
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
    expect(p.termless).toBeTypeOf("function")

    let scrollReads = 0
    const fed: string[] = []
    const result = p.termless!(
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
