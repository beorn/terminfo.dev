import type { ProbeDefinition, ProbeResult, TerminalQueryOutcome } from "./types.ts"
import { probe } from "./helpers.ts"

/** OSC color query probe — feedCapture + regex (termless), sentinel query (term). */
function oscColorQueryProbe(id: string, oscCode: number): ProbeDefinition {
  const querySeq = `\x1b]${oscCode};?\x07`
  const termlessPattern = new RegExp(`\\x1b\\]${oscCode};`)
  const termPattern = new RegExp(`\\x1b\\]${oscCode};([^\\x07\\x1b]+)[\\x07\\x1b]`)
  return probe(
    id,
    (ctx) => {
      const response = ctx.feedCapture(querySeq)
      const pass = termlessPattern.test(response)
      return { pass, note: pass ? undefined : `No OSC ${oscCode} response` }
    },
    async (ctx) => {
      const match = await ctx.queryWithSentinel(querySeq, termPattern)
      if (!match) return { pass: false, note: `No OSC ${oscCode} response` }
      return { pass: true, response: match[1] }
    },
  )
}

function oscQueryProbe(querySeq: string, responsePattern: RegExp, noResponseNote: string): ProbeDefinition["termless"] {
  return (ctx) => {
    const response = ctx.feedCapture(querySeq)
    const pass = responsePattern.test(response)
    return { pass, note: pass ? undefined : noResponseNote, response }
  }
}

function pointerColorResetProbe(
  setCode: 13 | 14,
  resetCode: 113 | 114,
  defaultPattern: RegExp,
): ProbeDefinition["termless"] {
  return (ctx) => {
    ctx.feed(`\x1b]${setCode};rgb:12/34/56\x07`)
    ctx.feed(`\x1b]${resetCode}\x07`)
    const response = ctx.feedCapture(`\x1b]${setCode};?\x07`)
    const pass = defaultPattern.test(response)
    return { pass, note: pass ? undefined : `OSC ${setCode} query did not report reset default`, response }
  }
}

function colorStackProbe(): ProbeDefinition["termless"] {
  return (ctx) => {
    const response = ctx.feedCapture(
      "\x1b]10;rgb:10/20/30\x07\x1b]30001\x07\x1b]10;rgb:aa/bb/cc\x07\x1b]30101\x07\x1b]10;?\x07",
    )
    const pass = /\x1b\]10;rgb:1010\/2020\/3030/.test(response)
    return { pass, note: pass ? undefined : "Color stack did not restore OSC 10 foreground", response }
  }
}

function osc720ScrollProbe(): ProbeDefinition["termless"] {
  return (ctx) => {
    for (let i = 0; i < 30; i++) ctx.feed(`scroll-${i}\r\n`)
    const before = ctx.getScrollback()
    if (before.totalLines <= before.screenLines || before.viewportOffset <= 0) {
      return {
        pass: false,
        note: `No scrollback to scroll (viewport=${before.viewportOffset}, total=${before.totalLines}, screen=${before.screenLines})`,
      }
    }
    ctx.feed("\x1b]720\x07")
    const after = ctx.getScrollback()
    const pass = after.viewportOffset < before.viewportOffset
    return {
      pass,
      note: pass
        ? `viewport ${before.viewportOffset}→${after.viewportOffset}`
        : `viewport did not move up (${before.viewportOffset}→${after.viewportOffset})`,
    }
  }
}

/** Kitty keyboard flag probe — push flags, query, check specific bit. */
export function kittyKeyboardFlagProbe(id: string, pushValue: number, flagBit: number): ProbeDefinition {
  const definition = probe(
    id,
    (ctx) => {
      try {
        return keyboardFlagsResult(ctx.feedCapture(`\x1b[>${pushValue}u\x1b[?u`), flagBit)
      } finally {
        ctx.feed("\x1b[<u")
      }
    },
    async (ctx) => {
      try {
        const reply = await ctx.queryWithSentinelOutcome(`\x1b[>${pushValue}u\x1b[?u`, /\x1b\[\?(\d+)u/)
        if (!reply.match) return unansweredQuery(reply, "No Kitty keyboard reply; key events were not tested")
        return keyboardFlagsResult(reply.match[0] ?? "", flagBit)
      } finally {
        ctx.write("\x1b[<u") // pop the mode pushed for this probe, even if the query fails
      }
    },
  )
  return { ...definition, termObservationEvidence: "query" }
}

function unansweredQuery(reply: TerminalQueryOutcome, note: string): ProbeResult {
  return {
    pass: false,
    response: reply.raw,
    note,
    observation: {
      outcome: "inconclusive",
      evidence: "query",
      reason: reply.reason === "timeout" ? "timeout" : "no-response",
      note,
    },
  }
}

function keyboardFlagsResult(response: string, flagBits: number): ProbeResult {
  const match = /\x1b\[\?(\d+)u/.exec(response)
  if (!match?.[1]) {
    return unansweredQuery(
      { match: null, reason: "sentinel", raw: response, rawBase64: btoa(response) },
      "No Kitty keyboard reply; key events were not tested",
    )
  }
  const flags = Number(match[1])
  const pass = (flags & flagBits) === flagBits
  const note = `Queried enhancement flags=${flags}; actual key press, repeat and release events were not tested`
  return {
    pass,
    response,
    note,
    observation: { outcome: pass ? "supported" : "unsupported", evidence: "query", note },
    assertions: [
      {
        kind: pass ? "positive" : "negative",
        expected: `Acknowledged flags include mask ${flagBits}`,
        observed: `flags=${flags}`,
      },
    ],
  }
}

function graphicsQueryResult(response: string, imageId: number): ProbeResult {
  const match = new RegExp(`\\x1b_Gi=${imageId};([^\\x1b]+)\\x1b\\\\`).exec(response)
  if (!match) {
    return unansweredQuery(
      { match: null, reason: "sentinel", raw: response, rawBase64: btoa(response) },
      "No matching graphics query reply; image rendering was not tested",
    )
  }
  const pass = match[1] === "OK"
  const note = pass
    ? "Graphics query accepted RGB pixel data; visible rendering was not tested"
    : `Graphics query returned ${match[1]}; no support conclusion`
  return {
    pass,
    response,
    note,
    observation: {
      outcome: pass ? "supported" : "inconclusive",
      evidence: "query",
      ...(!pass && { reason: "invalid-reply" as const }),
      note,
    },
    ...(pass && {
      assertions: [{ kind: "positive" as const, expected: `Graphics reply i=${imageId};OK`, observed: match[0] }],
    }),
  }
}

/** A query establishes recognition; this does not test changed colors or pixels. */
function kittyForegroundResult(response: string): ProbeResult {
  const match = /\x1b\]21;([^\x07\x1b]*)(?:\x07|\x1b\\)/.exec(response)
  if (!match) {
    return unansweredQuery(
      { match: null, reason: "sentinel", raw: response, rawBase64: btoa(response) },
      "No OSC 21 reply; color rendering was not tested",
    )
  }
  const values = match[1]?.split(";").filter((field) => field.startsWith("foreground=")) ?? []
  const value = values.length === 1 ? values[0]?.slice("foreground=".length) : undefined
  // Kitty replies with RGB. An empty value explicitly means a dynamic/undefined color.
  // Other encodings are left inconclusive rather than labelled unsupported.
  const pass = value === "" || (value !== undefined && /^rgb:[a-f\d]{1,4}\/[a-f\d]{1,4}\/[a-f\d]{1,4}$/i.test(value))
  const note = pass
    ? "Foreground query recognized; setting colors and visible rendering were not tested"
    : "OSC 21 replied without one verifiable foreground value; no support conclusion"
  return {
    pass,
    response,
    note,
    observation: { outcome: pass ? "supported" : "inconclusive", evidence: "query", note },
    ...(pass && {
      assertions: [
        {
          kind: "positive" as const,
          expected: "OSC 21 foreground query returns RGB or an explicitly undefined value",
          observed: match[0],
        },
      ],
    }),
  }
}

function textSizingResult(
  before: { row: number; col: number },
  width: { row: number; col: number },
  scale: { row: number; col: number },
  evidence: "behavior" | "parser-state",
): ProbeResult {
  const widthWorks = width.row === before.row && width.col === before.col + 2
  const scaleWorks = scale.row === width.row && scale.col === width.col + 2
  const pass = widthWorks && scaleWorks
  const note = `Cursor advance: width ${widthWorks ? "verified" : "not verified"}; scale ${scaleWorks ? "verified" : "not verified"}. Glyph appearance needs a visual check.`
  const response = JSON.stringify({ before, width, scale })
  return {
    pass,
    note,
    response,
    observation: { outcome: pass ? "supported" : "unsupported", evidence, note },
    assertions: [
      {
        kind: pass ? "positive" : "negative",
        expected: "Each OSC 66 width/scale sequence advances two columns without changing row",
        observed: response,
      },
    ],
  }
}

function clipboardProtocolResult(response: string): ProbeResult {
  const match = /\x1b\[\?5522;([0-4])\$y/.exec(response)
  if (!match) {
    return unansweredQuery(
      { match: null, reason: "sentinel", raw: response, rawBase64: btoa(response) },
      "No DECRPM response for mode 5522",
    )
  }
  const supported = match[1] !== "0" && match[1] !== "4"
  const note = supported ? "Protocol recognized; clipboard access permissions not tested" : "Mode 5522 not supported"
  return {
    pass: supported,
    note,
    response,
    observation: { outcome: supported ? "supported" : "unsupported", evidence: "query", note },
    assertions: [
      {
        kind: supported ? "positive" : "negative",
        expected: "DECRPM 5522 has Ps=1, 2 or 3; Ps=0 or 4 explicitly rejects support",
        observed: response,
      },
    ],
  }
}

export const extensionsProbes: ProbeDefinition[] = [
  // Truecolor — capability flag (termless) or SGR parse check (term)
  probe(
    "extensions.truecolor",
    (ctx) => ({ pass: ctx.capabilities.truecolor === true }),
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b[38;2;255;0;128mX\x1b[0m")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note:
          pos.col === 2
            ? undefined
            : `cursor at col ${pos.col}, expected 2 (truecolor sequence may have been printed literally)`,
      }
    },
  ),

  // Kitty keyboard protocol
  kittyKeyboardFlagProbe("extensions.kitty-keyboard", 1, 1),

  // Kitty keyboard: individual progressive enhancement flags
  // Each probe pushes+queries in a single write to avoid race conditions,
  // then pops after response is received.
  kittyKeyboardFlagProbe("extensions.kitty-keyboard.disambiguate", 1, 1), // Flag 1: DISAMBIGUATE
  kittyKeyboardFlagProbe("extensions.kitty-keyboard.report-events", 3, 2), // Flag 2: REPORT_EVENTS
  kittyKeyboardFlagProbe("extensions.kitty-keyboard.report-alternate", 5, 4), // Flag 4: REPORT_ALTERNATE
  kittyKeyboardFlagProbe("extensions.kitty-keyboard.report-all-keys", 9, 8), // Flag 8: REPORT_ALL_KEYS
  kittyKeyboardFlagProbe("extensions.kitty-keyboard.report-text", 25, 24), // REPORT_TEXT requires REPORT_ALL_KEYS.

  // The specified query action replies before the DA1 sentinel and stores no image.
  // A cursor movement is never evidence that pixels were rendered.
  probe(
    "extensions.kitty-graphics",
    (ctx) => graphicsQueryResult(ctx.feedCapture("\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\"), 31),
    async (ctx) => {
      const reply = await ctx.queryWithSentinelOutcome(
        "\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\",
        /\x1b_Gi=31;([^\x1b]+)\x1b\\/,
      )
      if (!reply.match) {
        return unansweredQuery(reply, "No matching graphics query reply; image rendering was not tested")
      }
      return graphicsQueryResult(reply.match[0] ?? "", 31)
    },
    "query",
  ),

  // Kitty graphics sub-probes — behavioral checks via cursor position + responsiveness
  probe(
    "extensions.kitty-graphics.transmit",
    (ctx) => ({ pass: ctx.capabilities.kittyGraphics === true }),
    async (ctx) => {
      const payload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
      ctx.write(`\x1b_Ga=t,f=100,s=1,v=1,t=d,i=999;${payload}\x1b\\`)
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 300)
      })
      const pos = await ctx.queryCursorPosition()
      ctx.write(`\x1b_Ga=d,d=i,i=999\x1b\\`)
      return { pass: pos !== null, note: pos ? undefined : "No response after transmit" }
    },
  ),

  probe(
    "extensions.kitty-graphics.display",
    (ctx) => ({ pass: ctx.capabilities.kittyGraphics === true }),
    async (ctx) => {
      const payload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
      ctx.write(`\x1b_Ga=t,f=100,s=1,v=1,t=d,i=998,q=1;${payload}\x1b\\`)
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200)
      })
      ctx.write("\x1b[1;1H")
      ctx.write(`\x1b_Ga=p,i=998\x1b\\`)
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 300)
      })
      const pos = await ctx.queryCursorPosition()
      ctx.write(`\x1b_Ga=d,d=i,i=998\x1b\\`)
      if (!pos) return { pass: false, note: "No response after display" }
      return {
        pass: pos.row > 1 || pos.col > 1,
        note: pos.row > 1 || pos.col > 1 ? undefined : "Display didn't render",
      }
    },
  ),

  probe(
    "extensions.kitty-graphics.animation",
    (ctx) => ({ pass: ctx.capabilities.kittyGraphics === true }),
    async (ctx) => {
      const payload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
      ctx.write(`\x1b_Ga=t,f=100,s=1,v=1,t=d,i=997,q=1;${payload}\x1b\\`)
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200)
      })
      ctx.write(`\x1b_Ga=f,i=997,q=1;${payload}\x1b\\`)
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200)
      })
      const pos = await ctx.queryCursorPosition()
      ctx.write(`\x1b_Ga=d,d=i,i=997\x1b\\`)
      return { pass: pos !== null, note: pos ? undefined : "No response after animation frame" }
    },
  ),

  probe(
    "extensions.kitty-graphics.unicode-placeholders",
    (ctx) => ({ pass: ctx.capabilities.kittyGraphics === true }),
    async (ctx) => {
      const payload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
      ctx.write("\x1b[1;1H")
      ctx.write(`\x1b_Ga=T,f=100,s=1,v=1,t=d,U=1,i=996;${payload}\x1b\\`)
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 300)
      })
      const pos = await ctx.queryCursorPosition()
      ctx.write(`\x1b_Ga=d,d=i,i=996\x1b\\`)
      if (!pos) return { pass: false, note: "No response after U=1" }
      return { pass: pos.row > 1 || pos.col > 1, note: pos.row > 1 || pos.col > 1 ? undefined : "U=1 didn't render" }
    },
  ),

  // Sixel (render test)
  probe(
    "extensions.sixel",
    (ctx) => ({ pass: ctx.capabilities.sixel === true }),
    async (ctx) => {
      ctx.write("\x1b[1;1H")
      ctx.write("\x1bPq#0;2;0;0;0~-~\x1b\\") // tiny 1x2 sixel
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after sixel" }
      const moved = pos.row > 1 || pos.col > 1
      return {
        pass: moved,
        note: moved ? undefined : "Sixel image didn't move cursor",
      }
    },
  ),

  // OSC 8 — hyperlinks
  probe(
    "extensions.osc8",
    (ctx) => ({ pass: ctx.capabilities.osc8Hyperlinks === true }),
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]8;;http://example.com\x07link\x1b]8;;\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 5,
        note: pos.col === 5 ? undefined : `cursor at col ${pos.col}, expected 5 (4 visible chars)`,
      }
    },
  ),

  // Reflow
  probe(
    "extensions.reflow",
    (ctx) => ({ pass: ctx.capabilities.reflow === true }),
    async (ctx) => {
      const sizeMatch = await ctx.queryWithSentinel("\x1b[18t", /\x1b\[8;(\d+);(\d+)t/)
      if (!sizeMatch?.[2]) return { pass: false, note: "No XTWINOPS 18 response (can't report size)" }
      const cols = parseInt(sizeMatch[2], 10)
      ctx.write("\x1b[1;1H\x1b[2J")
      const longLine = "W".repeat(cols + 5)
      ctx.write(longLine)
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.row === 2 && pos.col === 6,
        note: pos.row === 2 && pos.col === 6 ? undefined : `cursor at ${pos.row};${pos.col}, expected 2;6`,
      }
    },
  ),

  // Semantic prompts (OSC 133)
  probe(
    "extensions.semantic-prompts",
    (ctx) => ({ pass: ctx.capabilities.semanticPrompts === true }),
    async (ctx) => {
      ctx.write("\x1b]133;A\x07")
      const pos = await ctx.queryCursorPosition()
      return {
        pass: pos !== null,
        note: pos ? undefined : "No cursor response after OSC 133",
      }
    },
  ),

  // OSC 2 — window title
  probe(
    "extensions.osc2-title",
    (ctx) => {
      ctx.feed("\x1b]2;Test Title\x07")
      return { pass: ctx.getTitle().includes("Test Title") }
    },
    async (ctx) => {
      ctx.write("\x1b]2;terminfo-test\x07")
      const pos = await ctx.queryCursorPosition()
      ctx.write("\x1b]2;\x07") // reset title
      return { pass: pos !== null }
    },
  ),

  // OSC 0 — icon name and title
  probe(
    "extensions.osc0-icon-title",
    (ctx) => {
      ctx.feed("\x1b]0;My Title\x07")
      return { pass: ctx.getTitle().includes("My Title") }
    },
    async (ctx) => {
      ctx.write("\x1b]0;test-title\x07")
      const pos = await ctx.queryCursorPosition()
      ctx.write("\x1b]0;\x07") // reset
      return {
        pass: pos !== null,
        note: pos ? undefined : "No cursor response after OSC 0",
      }
    },
  ),

  // OSC 52 — clipboard
  probe(
    "extensions.osc52-clipboard",
    (ctx) => {
      // Set clipboard data, then query it back via feedCapture
      const testData = btoa("terminfo-test")
      ctx.feed(`\x1b]52;c;${testData}\x07`)
      const response = ctx.feedCapture("\x1b]52;c;?\x07")
      if (response.includes("52;c;")) return { pass: true }
      // Fallback: check if the sequence was at least consumed (title didn't change)
      return { pass: false, note: "No OSC 52 query response" }
    },
    async (ctx) => {
      const testData = btoa("terminfo-test")
      ctx.write(`\x1b]52;c;${testData}\x07`)
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No response after OSC 52" }
      return { pass: true }
    },
  ),

  // OSC 52 write — set clipboard (most terminals support this)
  probe(
    "extensions.osc52-write",
    (ctx) => {
      // Verify the write sequence is consumed without producing visible output
      ctx.feed(`\x1b]52;c;${btoa("test")}\x07X`)
      const cell = ctx.getCell(0, 0)
      return {
        pass: cell.char === "X",
        note: cell.char === "X" ? undefined : `cell at 0,0 is "${cell.char}", expected "X"`,
      }
    },
    async (ctx) => {
      const testData = btoa("terminfo-write-test")
      ctx.write(`\x1b]52;c;${testData}\x07`)
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No response after OSC 52 write" }
      return { pass: true }
    },
  ),

  // OSC 52 read — query clipboard back (fewer terminals support this)
  probe(
    "extensions.osc52-read",
    (ctx) => {
      const testData = btoa("terminfo-read-test")
      ctx.feed(`\x1b]52;c;${testData}\x07`)
      const response = ctx.feedCapture("\x1b]52;c;?\x07")
      return {
        pass: response.includes("52;c;"),
        note: response.includes("52;c;") ? undefined : "No OSC 52 query response",
      }
    },
    async (ctx) => {
      const testData = btoa("terminfo-read-test")
      ctx.write(`\x1b]52;c;${testData}\x07`)
      const match = await ctx.queryWithSentinel("\x1b]52;c;?\x07", /\x1b\]52;c;([^\x07\x1b]+)[\x07\x1b]/)
      if (!match) return { pass: false, note: "No OSC 52 read response" }
      return { pass: true, response: match[1]?.substring(0, 20) }
    },
  ),

  // OSC 10 — foreground color query
  oscColorQueryProbe("extensions.osc10-fg-color", 10),

  // OSC 11 — background color query
  oscColorQueryProbe("extensions.osc11-bg-color", 11),

  // OSC 7 — current working directory
  probe(
    "extensions.osc7-cwd",
    (ctx) => ({ pass: ctx.capabilities.extensions.has("osc7") }),
    async (ctx) => {
      ctx.write("\x1b]7;file:///tmp\x07")
      const pos = await ctx.queryCursorPosition()
      return { pass: pos !== null }
    },
  ),

  // OSC 633 — VS Code shell integration
  probe(
    "extensions.osc-633-vscode",
    (ctx) => ({ pass: ctx.capabilities.semanticPrompts === true }),
    async (ctx) => {
      ctx.write("\x1b]633;A\x07")
      ctx.write("\x1b]633;B\x07")
      ctx.write("\x1b]633;C\x07")
      ctx.write("\x1b]633;D;0\x07")
      const pos = await ctx.queryCursorPosition()
      return {
        pass: pos !== null,
        note: pos ? undefined : "No cursor response after OSC 633",
      }
    },
  ),

  // OSC 133 sub-commands — semantic prompt markers (FinalTerm)
  // Each probe sends the marker followed by "X" and verifies "X" landed at cell (0,0),
  // proving the OSC sequence was silently consumed (not printed literally).

  // OSC 133;A — prompt start (FTCS_PROMPT)
  probe(
    "extensions.osc133-a",
    (ctx) => {
      ctx.feed("\x1b]133;A\x07X")
      // Verify the OSC sequence was consumed and "X" landed at column 0.
      const cell = ctx.getCell(0, 0)
      return {
        pass: cell.char === "X",
        note: cell.char === "X" ? undefined : `cell at 0,0 is "${cell.char}", expected "X"`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]133;A\x07X")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 133;A" }
      // Cursor should be at col 2 (wrote 1 char "X" — OSC consumed)
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2 (OSC 133;A may not be consumed)`,
      }
    },
  ),

  // OSC 133;B — command start (FTCS_COMMAND_START)
  probe(
    "extensions.osc133-b",
    (ctx) => {
      ctx.feed("\x1b]133;B\x07X")
      const cell = ctx.getCell(0, 0)
      return {
        pass: cell.char === "X",
        note: cell.char === "X" ? undefined : `cell at 0,0 is "${cell.char}", expected "X"`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]133;B\x07X")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 133;B" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2 (OSC 133;B may not be consumed)`,
      }
    },
  ),

  // OSC 133;C — command executed (FTCS_COMMAND_EXECUTED)
  probe(
    "extensions.osc133-c",
    (ctx) => {
      ctx.feed("\x1b]133;C\x07X")
      const cell = ctx.getCell(0, 0)
      return {
        pass: cell.char === "X",
        note: cell.char === "X" ? undefined : `cell at 0,0 is "${cell.char}", expected "X"`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]133;C\x07X")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 133;C" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2 (OSC 133;C may not be consumed)`,
      }
    },
  ),

  // OSC 133;D — command finished with exit code (FTCS_COMMAND_FINISHED)
  probe(
    "extensions.osc133-d",
    (ctx) => {
      ctx.feed("\x1b]133;D;0\x07X")
      const cell = ctx.getCell(0, 0)
      return {
        pass: cell.char === "X",
        note: cell.char === "X" ? undefined : `cell at 0,0 is "${cell.char}", expected "X"`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]133;D;0\x07X")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 133;D" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2 (OSC 133;D may not be consumed)`,
      }
    },
  ),

  // OSC 133;P — properties (Cwd, CmdLine, etc.)
  probe(
    "extensions.osc133-p",
    (ctx) => {
      ctx.feed("\x1b]133;P;Cwd=/tmp\x07X")
      const cell = ctx.getCell(0, 0)
      return {
        pass: cell.char === "X",
        note: cell.char === "X" ? undefined : `cell at 0,0 is "${cell.char}", expected "X"`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]133;P;Cwd=/tmp\x07X")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 133;P" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2 (OSC 133;P may not be consumed)`,
      }
    },
  ),

  // OSC 633 sub-commands — VS Code shell integration markers
  // VS Code's parallel namespace to OSC 133, with VS Code-specific extensions (E, P).

  // OSC 633;A — prompt start (mirrors 133;A)
  probe(
    "extensions.osc633-a",
    (ctx) => {
      ctx.feed("\x1b]633;A\x07X")
      const cell = ctx.getCell(0, 0)
      return {
        pass: cell.char === "X",
        note: cell.char === "X" ? undefined : `cell at 0,0 is "${cell.char}", expected "X"`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]633;A\x07X")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 633;A" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2 (OSC 633;A may not be consumed)`,
      }
    },
  ),

  // OSC 633;B — prompt end (mirrors 133;B)
  probe(
    "extensions.osc633-b",
    (ctx) => {
      ctx.feed("\x1b]633;B\x07X")
      const cell = ctx.getCell(0, 0)
      return {
        pass: cell.char === "X",
        note: cell.char === "X" ? undefined : `cell at 0,0 is "${cell.char}", expected "X"`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]633;B\x07X")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 633;B" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2 (OSC 633;B may not be consumed)`,
      }
    },
  ),

  // OSC 633;C — pre-execution (mirrors 133;C)
  probe(
    "extensions.osc633-c",
    (ctx) => {
      ctx.feed("\x1b]633;C\x07X")
      const cell = ctx.getCell(0, 0)
      return {
        pass: cell.char === "X",
        note: cell.char === "X" ? undefined : `cell at 0,0 is "${cell.char}", expected "X"`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]633;C\x07X")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 633;C" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2 (OSC 633;C may not be consumed)`,
      }
    },
  ),

  // OSC 633;D — command finished with exit code (mirrors 133;D)
  probe(
    "extensions.osc633-d",
    (ctx) => {
      ctx.feed("\x1b]633;D;0\x07X")
      const cell = ctx.getCell(0, 0)
      return {
        pass: cell.char === "X",
        note: cell.char === "X" ? undefined : `cell at 0,0 is "${cell.char}", expected "X"`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]633;D;0\x07X")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 633;D" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2 (OSC 633;D may not be consumed)`,
      }
    },
  ),

  // OSC 633;E — set commandline with verification nonce (unique to OSC 633)
  probe(
    "extensions.osc633-e",
    (ctx) => {
      ctx.feed("\x1b]633;E;ls -la;nonce123\x07X")
      const cell = ctx.getCell(0, 0)
      return {
        pass: cell.char === "X",
        note: cell.char === "X" ? undefined : `cell at 0,0 is "${cell.char}", expected "X"`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]633;E;ls -la;nonce123\x07X")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 633;E" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2 (OSC 633;E may not be consumed)`,
      }
    },
  ),

  // OSC 633;P — VS Code-specific properties (Cwd, IsWindows, git status)
  probe(
    "extensions.osc633-p",
    (ctx) => {
      ctx.feed("\x1b]633;P;Cwd=/tmp\x07X")
      const cell = ctx.getCell(0, 0)
      return {
        pass: cell.char === "X",
        note: cell.char === "X" ? undefined : `cell at 0,0 is "${cell.char}", expected "X"`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]633;P;Cwd=/tmp\x07X")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 633;P" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2 (OSC 633;P may not be consumed)`,
      }
    },
  ),

  // OSC 9 — desktop notifications
  probe(
    "extensions.notifications",
    (ctx) => ({ pass: ctx.capabilities.extensions.has("osc9") }),
    async (ctx) => {
      ctx.write("\x1b]9;Test\x07")
      const pos = await ctx.queryCursorPosition()
      return {
        pass: pos !== null,
        note: pos ? undefined : "No cursor response after OSC 9",
      }
    },
  ),

  // OSC 1337 — iTerm2 inline images
  probe(
    "extensions.iterm2-images",
    (ctx) => ({ pass: ctx.capabilities.extensions.has("iterm2Images") }),
    async (ctx) => {
      ctx.write("\x1b]1337;File=inline=1:AAAA\x07")
      const pos = await ctx.queryCursorPosition()
      return {
        pass: pos !== null,
        note: pos ? undefined : "No cursor response after OSC 1337",
      }
    },
  ),

  // OSC 1337 ReportCellSize — query cell dimensions in pixels
  probe(
    "extensions.osc1337-cellsize",
    (ctx) => {
      const response = ctx.feedCapture("\x1b]1337;ReportCellSize\x07")
      const match = response.match(/\x1b\]1337;ReportCellSize=(\d+(?:\.\d+)?);(\d+(?:\.\d+)?)/)
      if (!match) return { pass: false, note: "No ReportCellSize response" }
      return { pass: true, note: `${match[1]}x${match[2]} pixels` }
    },
    async (ctx) => {
      const match = await ctx.queryWithSentinel(
        "\x1b]1337;ReportCellSize\x07",
        /\x1b\]1337;ReportCellSize=(\d+(?:\.\d+)?);(\d+(?:\.\d+)?)[\x07\x1b]/,
      )
      if (!match) return { pass: false, note: "No ReportCellSize response" }
      return { pass: true, note: `${match[1]}x${match[2]} pixels` }
    },
  ),

  // OSC 1337 RequestCapabilities — query terminal capabilities
  probe(
    "extensions.osc1337-capabilities",
    (ctx) => {
      const response = ctx.feedCapture("\x1b]1337;RequestCapabilities\x07")
      const match = response.match(/\x1b\]1337;Capabilities=([^\x07\x1b]*)/)
      if (!match) return { pass: false, note: "No Capabilities response" }
      return { pass: true, response: match[1] }
    },
    async (ctx) => {
      const match = await ctx.queryWithSentinel(
        "\x1b]1337;RequestCapabilities\x07",
        /\x1b\]1337;Capabilities=([^\x07\x1b]*)[\x07\x1b]/,
      )
      if (!match) return { pass: false, note: "No Capabilities response" }
      return { pass: true, response: match[1] }
    },
  ),

  // OSC 9;4 — progress bar (ConEmu protocol, adopted by Ghostty, iTerm2, Windows Terminal, etc.)
  probe(
    "extensions.osc9-progress",
    // Headless: no way to detect OSC 9;4 support (all backends silently consume unknown OSC)
    null,
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]9;4;1;50\x07") // set progress to 50%
      const pos = await ctx.queryCursorPosition()
      ctx.write("\x1b]9;4;0\x07") // clear progress
      if (!pos) return { pass: false, note: "No cursor response" }
      // If terminal consumed the OSC, cursor should still be at col 1
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`,
      }
    },
  ),

  // OSC 66 — text sizing protocol (Kitty, sets text scale/cell width)
  probe(
    "extensions.osc66-text-sizing",
    (ctx) => {
      ctx.feed("\x1b[1;1H\x1b[2K\r")
      const before = { ...ctx.getCursor() }
      ctx.feed("\x1b]66;w=2; \x07")
      const width = { ...ctx.getCursor() }
      ctx.feed("\x1b]66;s=2; \x07")
      const scale = { ...ctx.getCursor() }
      return textSizingResult(
        { row: before.y, col: before.x },
        { row: width.y, col: width.x },
        { row: scale.y, col: scale.x },
        "parser-state",
      )
    },
    async (ctx) => {
      // The protocol defines detection by cursor movement, not an OSC query.
      ctx.write("\x1b[1;1H\x1b[2K\r")
      const before = await ctx.queryCursorPosition()
      if (!before) {
        return {
          pass: false,
          observation: {
            outcome: "inconclusive",
            evidence: "behavior",
            reason: "no-response",
            note: "No baseline cursor response",
          },
        }
      }
      ctx.write("\x1b]66;w=2; \x07")
      const width = await ctx.queryCursorPosition()
      ctx.write("\x1b]66;s=2; \x07")
      const scale = await ctx.queryCursorPosition()
      if (!width || !scale) {
        return {
          pass: false,
          observation: {
            outcome: "inconclusive",
            evidence: "behavior",
            reason: "no-response",
            note: "Missing cursor response for text sizing",
          },
        }
      }
      return textSizingResult(before, width, scale, "behavior")
    },
    "behavior",
  ),

  // OSC 5522 — advanced clipboard (Kitty protocol, MIME-aware paste events)
  probe(
    "extensions.osc5522-clipboard",
    (ctx) => clipboardProtocolResult(ctx.feedCapture("\x1b[?5522$p")),
    async (ctx) => {
      const reply = await ctx.queryWithSentinelOutcome("\x1b[?5522$p", /\x1b\[\?5522;([0-4])\$y/)
      if (!reply.match) return unansweredQuery(reply, "No DECRPM response for mode 5522")
      return clipboardProtocolResult(reply.match[0] ?? "")
    },
    "query",
  ),

  // OSC 1 — icon name
  probe(
    "extensions.osc1-icon",
    (ctx) => {
      ctx.feed("\x1b]1;test-icon\x07")
      const title = ctx.getTitle()
      // Some backends set title on OSC 1, some only set icon name (not visible via getTitle)
      // If title changed or sequence was silently consumed, it passes
      return { pass: true, note: title.includes("test-icon") ? "title changed" : "consumed" }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]1;terminfo-icon-test\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 1" }
      // If cursor is at col 1, sequence was consumed (not printed literally)
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`,
      }
    },
  ),

  // OSC 4 — color palette query (needs index parameter, can't use generic helper)
  probe(
    "extensions.osc4-palette",
    (ctx) => {
      const response = ctx.feedCapture("\x1b]4;0;?\x07")
      const pass = /\x1b\]4;0;/.test(response)
      return { pass, note: pass ? undefined : "No OSC 4 response" }
    },
    async (ctx) => {
      const match = await ctx.queryWithSentinel("\x1b]4;0;?\x07", /\x1b\]4;0;([^\x07\x1b]+)[\x07\x1b]/)
      if (!match) return { pass: false, note: "No OSC 4 response" }
      return { pass: true, response: match[1] }
    },
  ),

  // OSC 5 — special color query (needs index parameter, can't use generic helper)
  probe(
    "extensions.osc5-special-color",
    (ctx) => {
      const response = ctx.feedCapture("\x1b]5;0;?\x07")
      const pass = /\x1b\]5;0;/.test(response)
      return { pass, note: pass ? undefined : "No OSC 5 response" }
    },
    async (ctx) => {
      const match = await ctx.queryWithSentinel("\x1b]5;0;?\x07", /\x1b\]5;0;([^\x07\x1b]+)[\x07\x1b]/)
      if (!match) return { pass: false, note: "No OSC 5 response" }
      return { pass: true, response: match[1] }
    },
  ),

  // OSC 12 — cursor color query
  oscColorQueryProbe("extensions.osc12-cursor-color", 12),

  // OSC 104 — reset color palette
  probe(
    "extensions.osc104-reset-palette",
    (ctx) => {
      // Set palette color 0 to red via OSC 4, then reset via OSC 104
      ctx.feed("\x1b]4;0;rgb:ff/00/00\x07")
      ctx.feed("\x1b]104;0\x07")
      // Verify reset was consumed by querying color 0 back
      const response = ctx.feedCapture("\x1b]4;0;?\x07")
      // If we get any OSC 4 response, the terminal supports the protocol
      const pass = /\x1b\]4;/.test(response)
      return { pass, note: pass ? undefined : "No OSC 4 query response (cannot verify reset)" }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]104\x07") // reset all palette colors
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 104" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1`,
      }
    },
  ),

  // OSC 110 — reset foreground color
  probe(
    "extensions.osc110-reset-fg",
    (ctx) => {
      ctx.feed("\x1b]110\x07")
      // Verify by querying foreground color — if OSC 10 responds, the terminal supports color management
      const response = ctx.feedCapture("\x1b]10;?\x07")
      const pass = /\x1b\]10;/.test(response)
      return { pass, note: pass ? undefined : "No OSC 10 response (cannot verify reset support)" }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]110\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 110" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1`,
      }
    },
  ),

  // OSC 111 — reset background color
  probe(
    "extensions.osc111-reset-bg",
    (ctx) => {
      ctx.feed("\x1b]111\x07")
      const response = ctx.feedCapture("\x1b]11;?\x07")
      const pass = /\x1b\]11;/.test(response)
      return { pass, note: pass ? undefined : "No OSC 11 response (cannot verify reset support)" }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]111\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 111" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1`,
      }
    },
  ),

  // OSC 112 — reset cursor color
  probe(
    "extensions.osc112-reset-cursor",
    (ctx) => {
      ctx.feed("\x1b]112\x07")
      const response = ctx.feedCapture("\x1b]12;?\x07")
      const pass = /\x1b\]12;/.test(response)
      return { pass, note: pass ? undefined : "No OSC 12 response (cannot verify reset support)" }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]112\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 112" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1`,
      }
    },
  ),

  // OSC 117 — reset highlight background
  probe(
    "extensions.osc117-reset-highlight-bg",
    (ctx) => {
      // Verify the reset sequence is consumed without producing visible output
      ctx.feed("\x1b]117\x07X")
      const cell = ctx.getCell(0, 0)
      return {
        pass: cell.char === "X",
        note: cell.char === "X" ? undefined : `cell at 0,0 is "${cell.char}", expected "X"`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]117\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 117" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1`,
      }
    },
  ),

  // OSC 119 — reset highlight foreground
  probe(
    "extensions.osc119-reset-highlight-fg",
    (ctx) => {
      // Verify the reset sequence is consumed without producing visible output
      ctx.feed("\x1b]119\x07X")
      const cell = ctx.getCell(0, 0)
      return {
        pass: cell.char === "X",
        note: cell.char === "X" ? undefined : `cell at 0,0 is "${cell.char}", expected "X"`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]119\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 119" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1`,
      }
    },
  ),

  // OSC 17 — highlight background color query
  oscColorQueryProbe("extensions.osc17-highlight-bg", 17),

  // OSC 19 — highlight foreground color query
  oscColorQueryProbe("extensions.osc19-highlight-fg", 19),

  // OSC 22 — pointer shape
  // Inherently partial: pointer shape is a visual-only effect on the mouse cursor,
  // not queryable or observable in the terminal cell grid.
  probe(
    "extensions.osc22-pointer",
    null, // Inherently partial: visual-only, no query mechanism
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]22;pointer\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 22" }
      // If terminal consumed the OSC, cursor should still be at col 1
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`,
      }
    },
  ),

  // Query capabilities without displaying a notification or requiring desktop access.
  probe(
    "extensions.osc99-kitty-notify",
    null, // Desktop notification delivery is outside a headless parser's scope.
    async (ctx) => {
      const id = globalThis.crypto.randomUUID()
      const reply = await ctx.queryWithSentinelOutcome(
        `\x1b]99;i=${id}:p=?;\x1b\\`,
        new RegExp(`\\x1b\\]99;i=${id}:p=\\?;([^\\x07\\x1b]*)(?:\\x07|\\x1b\\\\)`),
      )
      if (!reply.match) return unansweredQuery(reply, "No matching notification query reply; OS display was not tested")
      const payloadFields = reply.match[1]?.split(":").filter((field) => field.startsWith("p=")) ?? []
      const pass = payloadFields.length === 1 && payloadFields[0]?.slice(2).split(",").includes("title") === true
      const note = pass
        ? "Notification capabilities acknowledge title payloads; OS display, activation and close events were not tested"
        : "Notification reply does not advertise the required title payload; no support conclusion"
      return {
        pass,
        response: reply.match[0],
        note,
        observation: {
          outcome: pass ? "supported" : "inconclusive",
          evidence: "query",
          ...(!pass && { reason: "invalid-reply" as const }),
          note,
        },
        ...(pass && {
          assertions: [
            {
              kind: "positive" as const,
              expected: `OSC 99 echoes i=${id}, p=? and advertises p=title`,
              observed: reply.match[0] ?? "",
            },
          ],
        }),
      }
    },
    "query",
  ),

  // OSC 777 — rxvt-unicode notifications
  probe(
    "extensions.osc777-notify",
    null, // Headless: no way to detect notification support (silently consumed)
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]777;notify;test;body\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 777" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`,
      }
    },
  ),

  // OSC 666 — VTE termprop
  probe(
    "extensions.osc666-termprop",
    null, // Headless: no way to detect termprop support (silently consumed)
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]666;test-prop=value\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 666" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`,
      }
    },
  ),

  // OSC 3008 — systemd context
  probe(
    "extensions.osc3008-context",
    null, // Headless: no way to detect context support (silently consumed)
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]3008;type=test\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 3008" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`,
      }
    },
  ),

  // OSC 113 — reset pointer fg color
  probe(
    "extensions.osc113-reset-pointer-fg",
    pointerColorResetProbe(13, 113, /\x1b\]13;rgb:ffff\/ffff\/ffff/),
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]113\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 113" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`,
      }
    },
  ),

  // OSC 114 — reset pointer bg color
  probe(
    "extensions.osc114-reset-pointer-bg",
    pointerColorResetProbe(14, 114, /\x1b\]14;rgb:0000\/0000\/0000/),
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]114\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 114" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`,
      }
    },
  ),

  // OSC 21 — require the actual foreground reply, never a subsequent CPR.
  probe(
    "extensions.osc21-kitty-color",
    (ctx) => kittyForegroundResult(ctx.feedCapture("\x1b]21;foreground=?\x1b\\")),
    async (ctx) => {
      const reply = await ctx.queryWithSentinelOutcome(
        "\x1b]21;foreground=?\x1b\\",
        /\x1b\]21;([^\x07\x1b]*)(?:\x07|\x1b\\)/,
      )
      if (!reply.match) return unansweredQuery(reply, "No OSC 21 reply; color rendering was not tested")
      return kittyForegroundResult(reply.match[0] ?? "")
    },
    "query",
  ),

  // OSC 30001 — Kitty color stack push
  probe("extensions.osc30001-color-stack-push", colorStackProbe(), async (ctx) => {
    ctx.write("\x1b[1;1H\x1b[2K")
    ctx.write("\x1b]30001\x07")
    const pos = await ctx.queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response after OSC 30001" }
    return {
      pass: pos.col === 1,
      note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`,
    }
  }),

  // OSC 30101 — Kitty color stack pop
  probe("extensions.osc30101-color-stack-pop", colorStackProbe(), async (ctx) => {
    ctx.write("\x1b[1;1H\x1b[2K")
    // Push first so the pop has something to restore — both should be consumed.
    ctx.write("\x1b]30001\x07")
    ctx.write("\x1b]30101\x07")
    const pos = await ctx.queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response after OSC 30101" }
    return {
      pass: pos.col === 1,
      note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`,
    }
  }),

  // OSC 176 — foot Wayland app-id
  probe(
    "extensions.osc176-app-id",
    null, // Headless: app-id is a Wayland window-manager concept, not in the cell grid
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]176;terminfo-test\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 176" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`,
      }
    },
  ),

  // OSC 555 — foot screen flash (visual bell)
  probe(
    "extensions.osc555-flash",
    null, // Headless: visual bell is a UI animation, not in the cell grid
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]555\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 555" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`,
      }
    },
  ),

  // OSC 440 — mintty audio sound
  probe(
    "extensions.osc440-audio",
    null, // Headless: audio playback is not observable from the cell grid
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]440;bell.wav\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 440" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`,
      }
    },
  ),

  // OSC 7770 — mintty font size query/set
  probe(
    "extensions.osc7770-font-size",
    oscQueryProbe("\x1b]7770;?\x07", /\x1b\]7770;[0-9]+/, "No OSC 7770 font-size response"),
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]7770;?\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 7770" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`,
      }
    },
  ),

  // OSC 7777 — mintty font + window size (zoom)
  probe(
    "extensions.osc7777-font-window-size",
    oscQueryProbe("\x1b]7777;?\x07", /\x1b\]7777;[0-9]+/, "No OSC 7777 font/window-size response"),
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]7777;;\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 7777" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`,
      }
    },
  ),

  // OSC 701 — rxvt-unicode locale query/set
  probe(
    "extensions.osc701-locale",
    oscQueryProbe("\x1b]701;?\x07", /\x1b\]701;[A-Za-z0-9_.-]+/, "No OSC 701 locale response"),
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]701;?\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 701" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`,
      }
    },
  ),

  // OSC 702 — rxvt-unicode version query
  probe(
    "extensions.osc702-version",
    oscQueryProbe("\x1b]702\x07", /\x1b\]702;[^\x07\x1b]+/, "No OSC 702 version response"),
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]702\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 702" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`,
      }
    },
  ),

  // OSC 710 — rxvt-unicode set normal font
  probe(
    "extensions.osc710-font-normal",
    null, // Headless: font selection is not observable in the cell grid
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]710;fixed\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 710" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`,
      }
    },
  ),

  // OSC 720 — rxvt-unicode scroll view up
  probe("extensions.osc720-scroll-up", osc720ScrollProbe(), async (ctx) => {
    ctx.write("\x1b[1;1H\x1b[2K")
    ctx.write("\x1b]720\x07")
    const pos = await ctx.queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response after OSC 720" }
    return {
      pass: pos.col === 1,
      note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`,
    }
  }),

  // OSC 776 — rxvt-unicode cell size report
  probe(
    "extensions.osc776-cell-size",
    oscQueryProbe("\x1b]776\x07", /\x1b\]776;\d+;\d+;\d+/, "No OSC 776 cell-size response"),
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]776\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 776" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`,
      }
    },
  ),

  // Sixel support advertised in DA1 response (attribute 4)
  probe(
    "extensions.sixel-da1",
    (ctx) => {
      const response = ctx.feedCapture("\x1b[c")
      // DA1 response: CSI ? Ps ; Ps ; ... c — attribute 4 = sixel
      const pass = /;4[;c]/.test(response)
      return { pass, note: pass ? undefined : "DA1 response missing attribute 4 (sixel)" }
    },
    async (ctx) => {
      const match = await ctx.queryWithSentinel("\x1b[c", /\x1b\[\?([0-9;]+)c/)
      if (!match?.[1]) return { pass: false, note: "No DA1 response" }
      const attrs = match[1].split(";")
      const pass = attrs.includes("4")
      return { pass, note: pass ? `DA1 attrs: ${match[1]}` : `DA1 attrs: ${match[1]} (no sixel)` }
    },
  ),

  // Sixel geometry report — CSI ? Pi ; Pa ; Pv S → CSI ? Pi ; ... S
  // Added in xterm patch 402 (2025-06-22). xterm-only as of 2026.
  // Partial probe verifies the sequence is consumed without leaking literal characters.
  probe(
    "extensions.sixel-geometry-report",
    (ctx) => {
      // Read color register count: Pi=1, Pa=1 (read), Pv=0
      const response = ctx.feedCapture("\x1b[?1;1;0S")
      if (/\x1b\[\?1;[0-9;]+S/.test(response)) {
        return { pass: true, response, note: "Sixel geometry response received" }
      }
      // Verify sequence consumed (not printed literally) and terminal responsive
      const probeResponse = ctx.feedCapture("\x1b[c")
      return {
        pass: /\x1b\[\?[0-9;]+c/.test(probeResponse) && !response.includes("?1;1;0S"),
        note: /\x1b\[\?[0-9;]+c/.test(probeResponse)
          ? "Sequence consumed; terminal responsive (no sixel geometry response)"
          : "Terminal unresponsive after CSI ? 1 ; 1 ; 0 S",
      }
    },
    async (ctx) => {
      const match = await ctx.queryWithSentinel("\x1b[?1;1;0S", /\x1b\[\?1;([0-9;]+)S/, 1000)
      if (match) return { pass: true, response: match[0], note: `geometry: ${match[1]}` }
      // Verify the sequence didn't break the terminal — DSR should still respond.
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No response after sixel geometry query" }
      return { pass: false, note: "Sequence consumed but no sixel geometry response" }
    },
  ),
]
