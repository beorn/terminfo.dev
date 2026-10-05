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

/**
 * The probe ran and retained raw state, but this environment exposes no applicable observable for
 * the claim. This is a coverage/applicability record, never a fifth measurement outcome.
 */
export function notTestedResult(noObservable: string, state: object): ProbeResult {
  return {
    pass: false,
    response: JSON.stringify(state),
    note: noObservable,
    notTested: { reason: "no-semantic-observable", noObservable },
  }
}

/** Selective erase must remove unprotected cells and retain a protected control. */
export function selectiveEraseResult(ctx: TermlessContext, sequence: string, rectangular: boolean): ProbeResult {
  const expected = "DECSCA-protected P survives while selective erase clears ABCD"
  if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 6) {
    return parserStateResult(null, expected, { cols: ctx.cols }, "Need six measured columns")
  }
  try {
    ctx.feed('\x1b[1;1H\x1b[1"qP\x1b[0"qABCDZ')
    const before = Array.from({ length: 6 }, (_, col) => ctx.getCell(0, col).char)
    if (before.join("") !== "PABCDZ") {
      return parserStateResult(null, expected, { before }, "Selective erase seed was not measured")
    }
    ctx.feed(sequence)
    const after = Array.from({ length: 6 }, (_, col) => ctx.getCell(0, col).char)
    const controlsValid = after[0] === "P" && (!rectangular || after[5] === "Z")
    return parserStateResult(
      controlsValid ? after.slice(1, rectangular ? 5 : 6).every(isBlank) : null,
      expected,
      { before, after },
      controlsValid ? undefined : "Protection or outside-rectangle control failed; cannot attribute selective erase",
    )
  } finally {
    ctx.feed('\x1b[0"q')
  }
}

/** CPR cannot establish changed cells, styling, or scrollback contents. */
export function unmeasuredCellResult(position: { row: number; col: number } | null, feature: string): ProbeResult {
  return {
    pass: false,
    ...(position && { response: `${position.row};${position.col}` }),
    note: position ? `Cursor response does not measure ${feature}` : `No cursor response after ${feature}`,
    observation: {
      outcome: "inconclusive",
      reason: position ? "insufficient-evidence" : "no-response",
      evidence: "query",
    },
  }
}

/**
 * SGR probe — feed SGR sequence + "X", verify cell attribute (termless) or cursor position (term).
 *
 * A capture fixture renders at row 3 column 3; a smaller measured terminal clamps CUP or
 * wraps/scrolls the sample, so the shared guard refuses before any bytes.
 *
 * Termless: positive cell state establishes parser support. Adapters may omit
 * attributes or collapse styles, so a mismatch cannot establish non-support.
 * Term: cursor advance only proves the sequence was consumed, not that its style rendered.
 */
export const SGR_CAPTURE_MIN_ROWS = 3
export const SGR_CAPTURE_MIN_COLS = 34

/** Refuse an SGR capture fixture before any bytes when the measured geometry is too small. */
export function sgrCaptureTooSmall(ctx: TermContext, feature = "SGR capture"): ProbeResult | undefined {
  if (!ctx.capture) return undefined
  const { rows, cols } = ctx
  if (
    Number.isSafeInteger(rows) &&
    Number.isSafeInteger(cols) &&
    rows >= SGR_CAPTURE_MIN_ROWS &&
    cols >= SGR_CAPTURE_MIN_COLS
  ) {
    return undefined
  }
  return {
    pass: false,
    observation: {
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "none",
      note: `${feature} needs at least ${SGR_CAPTURE_MIN_ROWS}x${SGR_CAPTURE_MIN_COLS}, measured ${rows}x${cols}`,
    },
  }
}

/** Render a control screen and a target screen and return both frames as inconclusive pixel evidence. */
export async function sgrCaptureFrames(
  ctx: TermContext,
  control: string,
  target: string,
  targetLabel: string,
  meta: Record<string, unknown> = {},
  note = "Control and target pixels captured; visual interpretation requires review",
  controlLabel = `${targetLabel} control`,
): Promise<ProbeResult> {
  if (!ctx.capture) throw new Error(`${targetLabel}: SGR pixel capture requires a capture callback`)
  ctx.write(control)
  const controlFrame = await ctx.capture({ role: "control", label: controlLabel })
  ctx.write(target)
  const targetFrame = await ctx.capture({ role: "target", label: targetLabel })
  return {
    pass: false,
    response: JSON.stringify({ ...meta, control: controlFrame.label, target: targetFrame.label }),
    observation: {
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "pixels",
      screenshotRef: targetFrame.ref,
      frames: [controlFrame, targetFrame],
      note,
    },
  }
}

export function sgrProbe(
  id: string,
  sequence: string,
  check: (cell: ReturnType<TermlessContext["getCell"]>) => boolean | null,
  noObservableWhen?: (cell: ReturnType<TermlessContext["getCell"]>) => string | null,
): ProbeDefinition {
  return {
    id,
    termNeedsGeometry: true,
    termObservationEvidence: "consumed",
    termless(ctx) {
      ctx.feed(sequence + "X")
      const cell = ctx.getCell(0, 0)
      if (cell.char === "X") {
        const noObservable = noObservableWhen?.(cell)
        if (noObservable) return notTestedResult(noObservable, cell)
      }
      const measured = cell.char === "X" && check(cell) === true
      return parserStateResult(
        measured ? true : null,
        `${id}: attribute applied to the rendered X cell`,
        cell,
        cell.char !== "X"
          ? "No rendered X cell to evaluate"
          : measured
            ? undefined
            : "Cell readback cannot distinguish unsupported styling from unreported attributes or collapsed styles; a negative needs rendering review",
      )
    },
    async term(ctx) {
      if (ctx.capture) {
        const refusal = sgrCaptureTooSmall(ctx, "SGR fixture")
        if (refusal) return refusal
        const sample = "AaBb 0123456789 - terminal text"
        try {
          return await sgrCaptureFrames(
            ctx,
            "\x1b[0m\x1b[2J\x1b[3;3H" + sample,
            "\x1b[0m\x1b[2J\x1b[3;3H" + sequence + sample,
            id,
            { sample, startRow: 3, startCol: 3, sampleCells: sample.length },
            undefined,
            "Unstyled text sample",
          )
        } finally {
          ctx.write("\x1b[0m")
        }
      }
      const rows = ctx.rows
      const cols = ctx.cols
      if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < 1 || cols < 2) {
        return {
          pass: false,
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            evidence: "none",
            note: `SGR fixture needs at least 1x2, measured ${rows}x${cols}`,
          },
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

    termlessObservationEvidence: "parser-state",
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
  setupExpected?: { row: number; col: number },
): ProbeDefinition {
  const inconclusive = (
    origin: object | null,
    setupPosition: object | null,
    final: object | null,
    evidence: ObservationEvidence,
    reason: "no-response" | "insufficient-evidence",
    note: string,
  ): ProbeResult => ({
    pass: false,
    response: JSON.stringify({ origin, setup: setupPosition, final }),
    note,
    observation: { outcome: "inconclusive", reason, evidence, note },
  })
  return {
    id,
    termNeedsGeometry: true,
    termObservationEvidence: "query",
    termless(ctx) {
      ctx.feed("\x1b[1;1H")
      const origin = ctx.getCursor()
      if (origin.x !== 0 || origin.y !== 0) {
        return inconclusive(
          origin,
          null,
          null,
          "parser-state",
          "insufficient-evidence",
          `Cursor origin measured ${origin.y};${origin.x}, expected 0;0`,
        )
      }
      if (setup) ctx.feed(setup)
      const setupPosition = setup ? ctx.getCursor() : origin
      if (setup && !setupExpected) {
        return inconclusive(
          origin,
          setupPosition,
          null,
          "parser-state",
          "insufficient-evidence",
          "Cursor setup has no expected position",
        )
      }
      const wantedSetup = setupExpected ?? { row: 0, col: 0 }
      if (setupPosition.x !== wantedSetup.col || setupPosition.y !== wantedSetup.row) {
        return inconclusive(
          origin,
          setupPosition,
          null,
          "parser-state",
          "insufficient-evidence",
          `Cursor setup measured ${setupPosition.y};${setupPosition.x}, expected ${wantedSetup.row};${wantedSetup.col}`,
        )
      }
      ctx.feed(move)
      const final = ctx.getCursor()
      return parserStateResult(
        final.x === expected.col && final.y === expected.row,
        `cursor row=${expected.row}, col=${expected.col} (0-based) after ${JSON.stringify(move)}`,
        { origin, setup: setupPosition, final },
      )
    },
    async term(ctx) {
      const minRows = Math.max(1, expected.row + 1, (setupExpected?.row ?? 0) + 1)
      const minCols = Math.max(1, expected.col + 1, (setupExpected?.col ?? 0) + 1)
      if (ctx.rows < minRows || ctx.cols < minCols) {
        const note = `Cursor fixture needs at least ${minRows} rows and ${minCols} columns; measured ${ctx.rows}x${ctx.cols}`
        return {
          pass: false,
          note,
          observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none", note },
        }
      }
      ctx.write("\x1b[1;1H")
      const origin = await ctx.queryCursorPosition()
      if (!origin) return inconclusive(null, null, null, "query", "no-response", "No cursor reply at origin")
      if (origin.row !== 1 || origin.col !== 1) {
        return inconclusive(
          origin,
          null,
          null,
          "query",
          "insufficient-evidence",
          `Cursor origin measured ${origin.row};${origin.col}, expected 1;1`,
        )
      }
      if (setup) ctx.write(setup)
      const setupPosition = setup ? await ctx.queryCursorPosition() : origin
      if (!setupPosition) return inconclusive(origin, null, null, "query", "no-response", "No cursor reply after setup")
      if (setup && !setupExpected) {
        return inconclusive(
          origin,
          setupPosition,
          null,
          "query",
          "insufficient-evidence",
          "Cursor setup has no expected position",
        )
      }
      const wantedSetup = setupExpected ?? { row: 0, col: 0 }
      if (setupPosition.row !== wantedSetup.row + 1 || setupPosition.col !== wantedSetup.col + 1) {
        return inconclusive(
          origin,
          setupPosition,
          null,
          "query",
          "insufficient-evidence",
          `Cursor setup measured ${setupPosition.row};${setupPosition.col}, expected ${wantedSetup.row + 1};${wantedSetup.col + 1}`,
        )
      }
      ctx.write(move)
      const final = await ctx.queryCursorPosition()
      if (!final) {
        return inconclusive(origin, setupPosition, null, "query", "no-response", "No cursor reply after movement")
      }
      const response = JSON.stringify({ origin, setup: setupPosition, final })
      const pass = final.row === expected.row + 1 && final.col === expected.col + 1
      return {
        pass,
        response,
        ...(pass
          ? {}
          : { note: `Cursor measured ${final.row};${final.col}, expected ${expected.row + 1};${expected.col + 1}` }),
        observation: { outcome: pass ? "supported" : "unsupported", evidence: "query" },
        assertions: [
          {
            kind: pass ? "positive" : "negative",
            expected: `cursor row=${expected.row + 1}, col=${expected.col + 1} after ${JSON.stringify(move)}`,
            observed: response,
          },
        ],
      }
    },

    termlessObservationEvidence: "parser-state",
  }
}

/**
 * DECRPM mode probe. Responsiveness after enabling a mode does not prove that mode,
 * and blindly disabling it could change a mode the user already had enabled.
 */
export function decrpmModeProbe(
  id: string,
  modeNum: number,
  termlessFn: ((ctx: TermlessContext) => ProbeResult) | null,
): ProbeDefinition {
  return {
    id,
    termWrites: "query",
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
      observation: {
        outcome: "inconclusive",
        reason: "no-response",
        evidence: "query",
        note: "No DECRPM response",
      },
    }
  }
  if (state === "unknown") {
    return {
      pass: false,
      note: `DECRPM mode ${modeNum}: not recognized; mode behavior unmeasured`,
      response: state,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "query",
        note: `DECRPM mode ${modeNum}: not recognized; mode behavior unmeasured`,
      },
    }
  }
  return {
    pass: true,
    note: `DECRPM mode ${modeNum}: ${state}`,
    response: state,
    observation: { outcome: "supported", evidence: "query" },
    assertions: [
      {
        kind: "positive",
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

/** Feature support is independent of whether an observer can inspect link metadata. */
export function readHyperlinkMetadata(
  available: boolean,
  readLink: TermlessContext["getHyperlinkAt"],
  row: number,
  col: number,
  backendName: string,
): string | null | undefined {
  if (!available) return undefined
  if (typeof readLink !== "function") {
    throw new Error(`${backendName} declares OSC 8 metadata but has no getHyperlinkAt method at ${row},${col}`)
  }
  const hyperlink = readLink(row, col)
  if (hyperlink !== null && typeof hyperlink !== "string") {
    throw new Error(`${backendName} declares OSC 8 metadata but returned an invalid value at ${row},${col}`)
  }
  return hyperlink
}
