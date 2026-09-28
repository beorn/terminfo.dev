import type { ObservationEvidence, ProbeDefinition, ProbeResult, TermlessContext, TermContext } from "./types.ts"

/** Keep the serialized state alongside the exact assertion that used it. */
export function parserStateResult(pass: boolean | null, expected: string, state: object, note?: string): ProbeResult {
  const response = JSON.stringify(state)
  return {
    pass: pass === true,
    response,
    ...(note && { note }),
    observation: {
      outcome: pass === null ? "inconclusive" : pass ? "supported" : "unsupported",
      ...(pass === null && { reason: "insufficient-evidence" as const }),
      evidence: "parser-state",
      ...(note && { note }),
    },
    ...(pass !== null && {
      assertions: [{ kind: pass ? "positive" : "negative", expected, observed: response }],
    }),
  }
}

function measuredResult(
  actual: string | null,
  expected: string,
  evidence: ObservationEvidence,
  noResponseNote: string,
): ProbeResult {
  if (actual === null) {
    return {
      pass: false,
      note: noResponseNote,
      observation: { outcome: "inconclusive", reason: "no-response", evidence, note: noResponseNote },
    }
  }
  const pass = actual === expected
  return {
    pass,
    response: actual,
    ...(pass ? {} : { note: `got ${actual}, expected ${expected}` }),
    observation: { outcome: pass ? "supported" : "unsupported", evidence },
    assertions: [{ kind: pass ? "positive" : "negative", expected, observed: actual }],
  }
}

/**
 * SGR probe — feed SGR sequence + "X", verify cell attribute (termless) or cursor position (term).
 *
 * Termless: check actual cell state. A null predicate means the backend does not expose the attribute.
 * Term: cursor advance only proves the sequence was consumed, not that its style rendered.
 */
export function sgrProbe(
  id: string,
  sequence: string,
  check: (cell: ReturnType<TermlessContext["getCell"]>) => boolean | null,
): ProbeDefinition {
  return {
    id,
    termObservationEvidence: "consumed",
    termless(ctx) {
      ctx.feed(sequence + "X")
      const cell = ctx.getCell(0, 0)
      return parserStateResult(
        cell.char === "X" ? check(cell) : null,
        `${id}: attribute applied to the rendered X cell`,
        cell,
        cell.char === "X" ? undefined : "No rendered X cell to evaluate",
      )
    },
    async term(ctx) {
      if (ctx.capture) {
        try {
          ctx.write("\x1b[0m\x1b[2J\x1b[HX")
          const control = await ctx.capture({ role: "control", label: "Unstyled X" })
          ctx.write("\x1b[0m\x1b[2J\x1b[H" + sequence + "X")
          const target = await ctx.capture({ role: "target", label: id })
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "pixels",
              screenshotRef: target.ref,
              frames: [control, target],
              note: "Control and target pixels captured; visual interpretation requires review",
            },
          }
        } finally {
          ctx.write("\x1b[0m")
        }
      }
      ctx.write("\x1b[1;1H\x1b[2K") // clear line
      ctx.write(sequence + "X\x1b[0m")
      const pos = await ctx.queryCursorPosition()
      if (!pos) {
        return {
          pass: false,
          note: "No cursor response",
          observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" },
        }
      }
      // Cursor should be at col 2 (wrote 1 char "X")
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
        response: `${pos.row};${pos.col}`,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "consumed",
          note: "Cursor advance does not verify SGR styling",
        },
      }
    },
  }
}

/**
 * Cursor probe — move cursor, verify position.
 * Termless uses 0-based coordinates, term DSR uses 1-based.
 */
export function cursorProbe(
  id: string,
  setup: string,
  move: string,
  expected: { row: number; col: number },
): ProbeDefinition {
  return {
    id,
    termObservationEvidence: "query",
    termless(ctx) {
      ctx.feed(setup + move)
      const cursor = ctx.getCursor()
      // Termless is 0-based
      return parserStateResult(
        cursor.x === expected.col && cursor.y === expected.row,
        `cursor row=${expected.row}, col=${expected.col} (0-based) after ${JSON.stringify(move)}`,
        cursor,
      )
    },
    async term(ctx) {
      ctx.write(setup)
      ctx.write(move)
      const pos = await ctx.queryCursorPosition()
      // Term is 1-based
      const expRow = expected.row + 1
      const expCol = expected.col + 1
      return measuredResult(pos ? `${pos.row};${pos.col}` : null, `${expRow};${expCol}`, "query", "No cursor response")
    },
  }
}

/**
 * Mode probe — check mode via getMode (termless) or DECRPM (term).
 */
export function modeProbe(
  id: string,
  modeName: string,
  enableSeq: string,
  _disableSeq: string,
  modeNum: number,
): ProbeDefinition {
  return {
    id,
    termless(ctx) {
      ctx.feed(enableSeq)
      return { pass: ctx.getMode(modeName) === true }
    },
    async term(ctx) {
      const result = await ctx.queryMode(modeNum)
      if (result === null) return { pass: false, note: "No DECRPM response" }
      return {
        pass: result !== "unknown",
        note: result === "unknown" ? "Mode not recognized" : `Mode ${result}`,
        response: result,
      }
    },
  }
}

/**
 * DECRPM mode probe. Responsiveness after enabling a mode does not prove that mode,
 * and blindly disabling it could change a mode the user already had enabled.
 */
export function behavioralModeProbe(
  id: string,
  _enableSeq: string,
  _disableSeq: string,
  modeNum: number,
  termlessFn: ((ctx: TermlessContext) => ProbeResult) | null,
  _termBehaviorFn?: (ctx: TermContext) => Promise<ProbeResult>,
): ProbeDefinition {
  return {
    id,
    termObservationEvidence: "query",
    termless: termlessFn,
    async term(ctx) {
      return decrpmResult(await ctx.queryMode(modeNum), modeNum)
    },
  }
}

function decrpmResult(state: "set" | "reset" | "unknown" | null, modeNum: number): ProbeResult {
  if (state === null) {
    return {
      pass: false,
      note: "No DECRPM response",
      observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" },
    }
  }
  const recognized = state !== "unknown"
  return {
    pass: recognized,
    note: recognized ? `DECRPM mode ${modeNum}: ${state}` : `DECRPM mode ${modeNum}: not recognized`,
    response: state,
    observation: { outcome: recognized ? "supported" : "unsupported", evidence: "query" },
    assertions: [
      {
        kind: recognized ? "positive" : "negative",
        expected: `DECRPM mode ${modeNum} recognized (set or reset)`,
        observed: state,
      },
    ],
  }
}

/**
 * Response probe — send query, check response via feedCapture (termless) or query (term).
 */
export function responseProbe(
  id: string,
  sequence: string,
  expectedPattern: RegExp,
  termlessCheck?: (response: string) => ProbeResult,
  termQueryFn?: (ctx: TermContext) => Promise<ProbeResult>,
): ProbeDefinition {
  return {
    id,
    termless(ctx) {
      const response = ctx.feedCapture(sequence)
      if (termlessCheck) return termlessCheck(response)
      return {
        pass: expectedPattern.test(response),
        note: expectedPattern.test(response) ? undefined : `Response: ${JSON.stringify(response)}`,
        response,
      }
    },
    term: termQueryFn ?? null,
  }
}

/**
 * Capability probe — check capabilities flag (termless only, term=null).
 */
export function capabilityProbe(id: string, capName: keyof TermlessContext["capabilities"]): ProbeDefinition {
  return {
    id,
    termless(ctx) {
      const val = ctx.capabilities[capName]
      return { pass: val === true }
    },
    term: null,
  }
}

/**
 * Width probe — check rendered width of text.
 */
export function widthProbe(id: string, text: string, expectedWidth: number): ProbeDefinition {
  return {
    id,
    termless(ctx) {
      ctx.feed(text + "X")
      // Find X — it should be at column expectedWidth
      const cell = ctx.getCell(0, expectedWidth)
      return {
        pass: cell.char === "X",
        note: cell.char === "X" ? undefined : `char at col ${expectedWidth} is "${cell.char}", expected "X"`,
      }
    },
    async term(ctx) {
      const width = await ctx.measureRenderedWidth(text)
      if (width === null) return { pass: false, note: "Cannot measure width" }
      return {
        pass: width === expectedWidth,
        note: width === expectedWidth ? undefined : `width=${width}, expected ${expectedWidth}`,
      }
    },
  }
}

/** Check if a cell character is blank (empty or space). */
export function isBlank(char: string): boolean {
  return char === "" || char === " "
}

/**
 * Simple probe — for probes that need custom logic on both sides.
 */
export function probe(
  id: string,
  termless: ((ctx: TermlessContext) => ProbeResult) | null,
  term: ((ctx: TermContext) => Promise<ProbeResult>) | null,
  termObservationEvidence?: ObservationEvidence,
): ProbeDefinition {
  return { id, termless, term, ...(termObservationEvidence && { termObservationEvidence }) }
}
