import type { ProbeDefinition, ProbeResult, TermlessContext, TermContext } from "./types.ts"

/**
 * SGR probe — feed SGR sequence + "X", verify cell attribute (termless) or cursor position (term).
 *
 * Termless: check that the SGR sequence is parsed and applied to the cell.
 * Term: check that the SGR sequence is consumed (cursor advances by 1 char, not printed literally).
 */
export function sgrProbe(
  id: string,
  sequence: string,
  check: (cell: ReturnType<TermlessContext["getCell"]>) => boolean,
): ProbeDefinition {
  return {
    id,
    termless(ctx) {
      ctx.feed(sequence + "X")
      const cell = ctx.getCell(0, 0)
      return { pass: check(cell) }
    },
    async term(ctx) {
      ctx.write("\x1b[1;1H\x1b[2K") // clear line
      ctx.write(sequence + "X\x1b[0m")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      // Cursor should be at col 2 (wrote 1 char "X")
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
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
    termless(ctx) {
      ctx.feed(setup + move)
      const cursor = ctx.getCursor()
      // Termless is 0-based
      return {
        pass: cursor.x === expected.col && cursor.y === expected.row,
        note:
          cursor.x === expected.col && cursor.y === expected.row
            ? undefined
            : `got ${cursor.y};${cursor.x}, expected ${expected.row};${expected.col}`,
      }
    },
    async term(ctx) {
      ctx.write(setup)
      ctx.write(move)
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      // Term is 1-based
      const expRow = expected.row + 1
      const expCol = expected.col + 1
      return {
        pass: pos.row === expRow && pos.col === expCol,
        note:
          pos.row === expRow && pos.col === expCol
            ? undefined
            : `got ${pos.row};${pos.col}, expected ${expRow};${expCol}`,
        response: `${pos.row};${pos.col}`,
      }
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
 * Behavioral mode probe — enable mode, verify terminal is responsive, disable.
 * Uses DECRPM first (term), falls back to behavioral test.
 */
export function behavioralModeProbe(
  id: string,
  enableSeq: string,
  disableSeq: string,
  modeNum: number,
  termlessFn: ((ctx: TermlessContext) => ProbeResult) | null,
  termBehaviorFn?: (ctx: TermContext) => Promise<ProbeResult>,
): ProbeDefinition {
  return {
    id,
    termless: termlessFn,
    async term(ctx) {
      // Try DECRPM first
      const decrpmResult = await ctx.queryMode(modeNum)
      if (decrpmResult !== null && decrpmResult !== "unknown") {
        return {
          pass: true,
          note: `DECRPM: mode ${decrpmResult}`,
          response: decrpmResult,
        }
      }
      // Fall back to behavioral test
      ctx.write(enableSeq)
      const result = termBehaviorFn ? await termBehaviorFn(ctx) : await defaultBehaviorTest(ctx)
      ctx.write(disableSeq)
      return result
    },
  }
}

async function defaultBehaviorTest(ctx: TermContext): Promise<ProbeResult> {
  const pos = await ctx.queryCursorPosition()
  return {
    pass: pos !== null,
    note: pos ? "Behavioral: responsive after enable" : "No response",
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

/**
 * Simple probe — for probes that need custom logic on both sides.
 */
export function probe(
  id: string,
  termless: ((ctx: TermlessContext) => ProbeResult) | null,
  term: ((ctx: TermContext) => Promise<ProbeResult>) | null,
): ProbeDefinition {
  return { id, termless, term }
}
