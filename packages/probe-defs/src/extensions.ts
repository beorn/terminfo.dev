import { randomUUID } from "node:crypto"
import type { ProbeDefinition, ProbeResult, TermlessContext, TermContext, TerminalQueryOutcome } from "./types.ts"
import { parserStateResult, probe, unmeasuredCellResult } from "./helpers.ts"

function queryOnly(definition: ProbeDefinition): ProbeDefinition {
  return { ...definition, termWrites: "query" }
}

/** Bind a complete reply from this query; a prefix or unrelated output is not a result. */
function oscReplyResult(raw: string, frame: string | null, expected: string, prefix: RegExp): ProbeResult {
  if (frame) {
    return {
      pass: true,
      response: raw,
      observation: { outcome: "supported", evidence: "query" },
      assertions: [{ kind: "positive", expected, observed: frame }],
    }
  }
  return {
    pass: false,
    response: raw,
    observation: {
      outcome: "inconclusive",
      reason: prefix.test(raw) ? "invalid-reply" : "no-response",
      evidence: "query",
    },
  }
}

function unverifiedEffect(note: string, response?: string): ProbeResult {
  return {
    pass: false,
    ...(response !== undefined && { response }),
    note,
    observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "consumed", note },
  }
}

function sixelDa1Result(raw: string, frame: string | null): ProbeResult {
  const match = frame ? /\x1b\[\?([0-9]+(?:;[0-9]+)*)c/.exec(frame) : null
  if (!match) {
    return {
      pass: false,
      response: raw,
      observation: {
        outcome: "inconclusive",
        reason: raw.includes("\x1b[?") ? "invalid-reply" : "no-response",
        evidence: "query",
      },
    }
  }
  const advertised = (match[1]?.split(";") ?? []).includes("4")
  return {
    pass: advertised,
    response: raw,
    observation: { outcome: advertised ? "supported" : "unsupported", evidence: "query" },
    assertions: [
      {
        kind: advertised ? "positive" : "negative",
        expected: "Complete DA1 advertises Sixel attribute 4",
        observed: match[0],
      },
    ],
  }
}

/** A read of current Sixel geometry; protocol failure and silence never establish a negative. */
function sixelGeometryResult(raw: string, frame: string | null, missingReason: "no-response" | "timeout"): ProbeResult {
  const reply = frame ? /\x1b\[\?2;([0-9]+);([0-9;]*)S/.exec(frame) : null
  if (!reply) {
    const malformed = frame !== null
    const note = malformed ? "Malformed Sixel geometry response" : "No Sixel geometry response for item 2"
    return {
      pass: false,
      response: raw,
      note,
      observation: {
        outcome: "inconclusive",
        evidence: "query",
        reason: malformed ? "invalid-reply" : missingReason,
        note,
      },
    }
  }
  const status = Number(reply[1])
  if (status !== 0) {
    const validFailure = status === 1 || status === 2 || status === 3
    const note = validFailure
      ? `Sixel geometry query reported protocol status ${status}`
      : `Unknown Sixel geometry protocol status ${reply[1]}`
    return {
      pass: false,
      response: raw,
      note,
      observation: {
        outcome: "inconclusive",
        evidence: "query",
        reason: validFailure ? "insufficient-evidence" : "invalid-reply",
        note,
      },
    }
  }
  const dimensions = reply[2]?.split(";") ?? []
  const width = Number(dimensions[0])
  const height = Number(dimensions[1])
  if (
    dimensions.length !== 2 ||
    dimensions.some((value) => !/^[0-9]+$/.test(value)) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height)
  ) {
    const note = "Successful Sixel geometry response lacked two numeric pixel dimensions"
    return {
      pass: false,
      response: raw,
      note,
      observation: { outcome: "inconclusive", evidence: "query", reason: "invalid-reply", note },
    }
  }
  if (width === 0 || height === 0) {
    const note = `Sixel geometry reported ${width}×${height} pixels; usable dimensions were not established`
    return {
      pass: false,
      response: raw,
      note,
      observation: { outcome: "inconclusive", evidence: "query", reason: "insufficient-evidence", note },
    }
  }
  const note = `Current Sixel geometry reported as ${width}×${height} pixels`
  return {
    pass: true,
    response: raw,
    note,
    observation: { outcome: "supported", evidence: "query", note },
    assertions: [
      {
        kind: "positive",
        expected: "XTSMGRAPHICS item 2 read returns status 0 and two positive pixel dimensions",
        observed: reply[0],
      },
    ],
  }
}

/** OSC color query probe — feedCapture + regex (termless), sentinel query (term). */
function oscColorQueryProbe(id: string, oscCode: number): ProbeDefinition {
  const querySeq = `\x1b]${oscCode};?\x07`
  const pattern = new RegExp(`\\x1b\\]${oscCode};rgb:[0-9a-f]{1,4}/[0-9a-f]{1,4}/[0-9a-f]{1,4}(?:\\x07|\\x1b\\\\)`, "i")
  const prefix = new RegExp(`\\x1b\\]${oscCode};`)
  return {
    ...queryOnly(
      probe(
        id,
        (ctx) => {
          const raw = ctx.feedCapture(querySeq)
          return oscReplyResult(raw, pattern.exec(raw)?.[0] ?? null, `Complete OSC ${oscCode} color reply`, prefix)
        },
        async (ctx) => {
          const reply = await ctx.queryWithSentinelOutcome(querySeq, pattern)
          return oscReplyResult(
            reply.raw,
            reply.reason === "reply" ? (reply.match?.[0] ?? null) : null,
            `Complete OSC ${oscCode} color reply`,
            prefix,
          )
        },
        "query",
      ),
    ),
    termlessObservationEvidence: "query",
  }
}

function oscSimpleQueryProbe(
  id: string,
  query: string,
  pattern: RegExp,
  prefix: RegExp,
  expected: string,
): ProbeDefinition {
  return {
    ...queryOnly(
      probe(
        id,
        (ctx) => {
          const raw = ctx.feedCapture(query)
          return oscReplyResult(raw, pattern.exec(raw)?.[0] ?? null, expected, prefix)
        },
        async (ctx) => {
          const reply = await ctx.queryWithSentinelOutcome(query, pattern)
          return oscReplyResult(
            reply.raw,
            reply.reason === "reply" ? (reply.match?.[0] ?? null) : null,
            expected,
            prefix,
          )
        },
        "query",
      ),
    ),
    termlessObservationEvidence: "query",
  }
}

function colorResetProbe(setCode: number, resetCode: number, index?: number): ProbeDefinition["termless"] {
  const indexPart = index === undefined ? "" : `${index};`
  const query = `\x1b]${setCode};${indexPart}?\x07`
  const replyPattern = new RegExp(
    `\\x1b\\]${setCode};${indexPart}(rgb:[0-9a-f]{1,4}/[0-9a-f]{1,4}/[0-9a-f]{1,4})(?:\\x07|\\x1b\\\\)`,
    "i",
  )
  return (ctx) => {
    const originalRaw = ctx.feedCapture(query)
    const original = replyPattern.exec(originalRaw)?.[1]
    if (!original) {
      return oscReplyResult(originalRaw, null, `OSC ${setCode} color before reset`, new RegExp(`\\x1b\\]${setCode};`))
    }
    const requested = probeForeground(original)
    let mustReset = false
    try {
      ctx.feed(`\x1b]${setCode};${indexPart}${requested}\x07`)
      mustReset = true
      const changedRaw = ctx.feedCapture(query)
      const changed = replyPattern.exec(changedRaw)?.[1]
      ctx.feed(`\x1b]${resetCode}${index === undefined ? "" : `;${index}`}\x07`)
      mustReset = false
      const restoredRaw = ctx.feedCapture(query)
      const restored = replyPattern.exec(restoredRaw)?.[1]
      const response = JSON.stringify({ originalRaw, changedRaw, restoredRaw })
      if (!changed || !restored || !sameRgb(changed, requested)) {
        return {
          pass: false,
          response,
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            evidence: "query",
            note: "Color mutation or readback control was not established",
          },
        }
      }
      const pass = sameRgb(restored, original)
      return {
        pass,
        response,
        observation: { outcome: pass ? "supported" : "unsupported", evidence: "behavior" },
        assertions: [
          {
            kind: pass ? "positive" : "negative",
            expected: `OSC ${resetCode} restores the prior OSC ${setCode} color after a verified change`,
            observed: response,
          },
        ],
      }
    } finally {
      if (mustReset) ctx.feed(`\x1b]${resetCode}${index === undefined ? "" : `;${index}`}\x07`)
    }
  }
}

const foregroundQuery = "\x1b]10;?\x07"
const foregroundReply = /\x1b\]10;(rgb:[a-f\d]{1,4}\/[a-f\d]{1,4}\/[a-f\d]{1,4})(?:\x07|\x1b\\)/i
const colorPush = "\x1b]30001\x1b\\"
const colorPop = "\x1b]30101\x1b\\"

function foregroundValue(response: string): string | null {
  return foregroundReply.exec(response)?.[1] ?? null
}

function sameRgb(left: string, right: string): boolean {
  const channels = (color: string) =>
    color
      .slice(4)
      .split("/")
      .map((channel) => Math.round((parseInt(channel, 16) / (16 ** channel.length - 1)) * 65535))
  const actual = channels(left)
  const expected = channels(right)
  return actual.every((channel, index) => channel === expected[index])
}

function sameRgbCells(left: { r: number; g: number; b: number }, right: { r: number; g: number; b: number }): boolean {
  return left.r === right.r && left.g === right.g && left.b === right.b
}

function probeForeground(before: string): string {
  return sameRgb(before, "rgb:aa/bb/cc") ? "rgb:12/34/56" : "rgb:aa/bb/cc"
}

function colorStackResult(before: string, requested: string, changed: string, restored: string): ProbeResult {
  const changedAsRequested = sameRgb(changed, requested)
  const restoredOriginal = sameRgb(restored, before)
  const pass = changedAsRequested && restoredOriginal
  const response = JSON.stringify({ before, changed, restored })
  const note = pass
    ? "Foreground changed and color-stack pop restored its original value"
    : "Foreground change or stack restoration was not observed"
  return {
    pass,
    response,
    note,
    observation: { outcome: pass ? "supported" : "unsupported", evidence: "behavior", note },
    assertions: [
      {
        kind: pass ? "positive" : "negative",
        expected: "Changed foreground and restored original after color-stack pop",
        observed: response,
      },
    ],
  }
}

function promptConsumptionResult(consumed: boolean | null): ProbeResult {
  const note =
    consumed === null
      ? "No cursor reply after semantic prompt marker"
      : consumed
        ? "Marker was consumed; shell prompt integration was not observed"
        : "Marker consumption was not confirmed; shell prompt integration was not observed"
  return {
    pass: false,
    note,
    observation: {
      outcome: "inconclusive",
      evidence: consumed === null ? "query" : "consumed",
      reason: consumed === null ? "no-response" : "insufficient-evidence",
      note,
    },
  }
}

function colorStackError(evidence: "query" | "behavior", action: string, error: unknown): ProbeResult {
  if (!(error instanceof Error)) throw error
  const note = `${action} (${evidence}) failed: ${error.name}: ${error.message}`
  return { pass: false, note, observation: { outcome: "error", reason: "collector-error", evidence, note } }
}

function colorStackProbe(): ProbeDefinition["termless"] {
  return (ctx) => {
    let result: ProbeResult | undefined
    let primaryError: unknown
    const queryForeground = (action: string): string | ProbeResult | null => {
      let response: string
      try {
        response = ctx.feedCapture(foregroundQuery)
      } catch (error) {
        primaryError = error
        return colorStackError("query", action, error)
      }
      return foregroundValue(response)
    }
    const feed = (sequence: string, action: string): ProbeResult | undefined => {
      try {
        ctx.feed(sequence)
        return undefined
      } catch (error) {
        primaryError = error
        return colorStackError("behavior", action, error)
      }
    }
    const before = queryForeground("Original foreground query")
    if (before !== null && typeof before !== "string") return before
    if (!before) {
      return {
        pass: false,
        note: "No original OSC 10 foreground reply",
        observation: { outcome: "inconclusive", evidence: "query", reason: "no-response" },
      }
    }
    let pushed = false
    let unexpectedlyFailed = false
    const requested = probeForeground(before)
    try {
      result = feed(colorPush, "Color-stack push")
      if (result !== undefined) return result
      pushed = true
      result = feed(`\x1b]10;${requested}\x07`, "Foreground mutation")
      if (result !== undefined) return result
      const changed = queryForeground("Foreground query after mutation")
      if (changed !== null && typeof changed !== "string") {
        result = changed
        return result
      }
      result = feed(colorPop, "Color-stack pop")
      if (result !== undefined) return result
      pushed = false
      const restored = queryForeground("Foreground query after pop")
      if (restored !== null && typeof restored !== "string") {
        result = restored
        return result
      }
      result =
        !changed || !restored
          ? {
              pass: false,
              note: "No OSC 10 reply after changing or popping color",
              observation: { outcome: "inconclusive", evidence: "query", reason: "no-response" },
            }
          : colorStackResult(before, requested, changed, restored)
      return result
    } catch (error) {
      unexpectedlyFailed = true
      primaryError = error
      throw error
    } finally {
      const cleanupFailures: Array<{ action: string; error: unknown }> = []
      try {
        if (pushed) ctx.feed(colorPop)
      } catch (error) {
        cleanupFailures.push({ action: "Color-stack cleanup pop", error })
      } finally {
        try {
          ctx.feed(`\x1b]10;${before}\x07`)
        } catch (error) {
          cleanupFailures.push({ action: "Foreground cleanup restore", error })
        }
      }
      if (cleanupFailures.length > 0) {
        const cleanupNote = cleanupFailures
          .map(({ action, error }) =>
            error instanceof Error
              ? `${action} (behavior) failed: ${error.name}: ${error.message}`
              : `${action} (behavior) threw unexpectedly: ${String(error)}`,
          )
          .join("; ")
        const primaryNote = unexpectedlyFailed
          ? `Color-stack callback threw unexpectedly: ${primaryError instanceof Error ? `${primaryError.name}: ${primaryError.message}` : String(primaryError)}`
          : result?.observation?.outcome === "error"
            ? result.note
            : undefined
        const note = primaryNote ? `${primaryNote}; ${cleanupNote}` : cleanupNote
        if (unexpectedlyFailed || cleanupFailures.some(({ error }) => !(error instanceof Error))) {
          throw new AggregateError(
            [
              ...(unexpectedlyFailed || result?.observation?.outcome === "error" ? [primaryError] : []),
              ...cleanupFailures.map(({ error }) => error),
            ],
            note,
            { cause: primaryError },
          )
        }
        if (result) {
          const evidence = result.observation?.outcome === "error" ? result.observation.evidence : "behavior"
          result.pass = false
          result.note = note
          result.observation = { outcome: "error", reason: "collector-error", evidence, note }
          delete result.response
          delete result.assertions
        }
      }
    }
  }
}

async function colorStackTermProbe(ctx: Parameters<NonNullable<ProbeDefinition["term"]>>[0]): Promise<ProbeResult> {
  const originalReply = await ctx.queryWithSentinelOutcome(foregroundQuery, foregroundReply)
  const before = foregroundValue(originalReply.match?.[0] ?? "")
  if (!before) return unansweredQuery(originalReply, "No original OSC 10 foreground reply; color stack was not changed")
  let pushed = false
  const requested = probeForeground(before)
  try {
    ctx.write(colorPush)
    pushed = true
    ctx.write(`\x1b]10;${requested}\x07`)
    const changedReply = await ctx.queryWithSentinelOutcome(foregroundQuery, foregroundReply)
    const changed = foregroundValue(changedReply.match?.[0] ?? "")
    if (!changed) return unansweredQuery(changedReply, "No OSC 10 reply after changing foreground")
    ctx.write(colorPop)
    pushed = false
    const restoredReply = await ctx.queryWithSentinelOutcome(foregroundQuery, foregroundReply)
    const restored = foregroundValue(restoredReply.match?.[0] ?? "")
    if (!restored) return unansweredQuery(restoredReply, "No OSC 10 reply after color-stack pop")
    return colorStackResult(before, requested, changed, restored)
  } finally {
    try {
      if (pushed) ctx.write(colorPop)
    } finally {
      ctx.write(`\x1b]10;${before}\x07`)
    }
  }
}

function osc720ScrollProbe(): ProbeDefinition["termless"] {
  return (ctx) => {
    for (let i = 0; i < 30; i++) ctx.feed(`scroll-${i}\r\n`)
    const before = ctx.getScrollback()
    if (before.totalLines <= before.screenLines || before.viewportOffset <= 0) {
      return parserStateResult(
        null,
        "OSC 720 moves the scrollback viewport up",
        { before },
        "No scrollback viewport available",
      )
    }
    ctx.feed("\x1b]720\x07")
    const after = ctx.getScrollback()
    const pass = after.viewportOffset < before.viewportOffset
    return parserStateResult(pass, "OSC 720 moves the scrollback viewport up", { before, after })
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
  return { ...definition, termObservationEvidence: "query", termlessObservationEvidence: "query" }
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

function graphicsQueryResult(
  response: string,
  imageId: number,
  acceptedNote = "Graphics query accepted RGB pixel data; visible rendering was not tested",
): ProbeResult {
  const match = new RegExp(`\\x1b_Gi=${imageId};([^\\x1b]+)\\x1b\\\\`).exec(response)
  if (!match) {
    return unansweredQuery(
      { match: null, reason: "sentinel", raw: response, rawBase64: btoa(response) },
      "No matching graphics query reply; image rendering was not tested",
    )
  }
  const pass = match[1] === "OK"
  const note = pass ? acceptedNote : `Graphics query returned ${match[1]}; no support conclusion`
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

function imageTransferRequest(imageNumber: number): string {
  // I requests a new image; a fixed i would overwrite somebody else's image.
  return `\x1b_Ga=t,f=24,s=1,v=1,t=d,I=${imageNumber};/wAA\x1b\\`
}

function allocatedImageResult(response: string, imageNumber: number): { imageId: number | null; result: ProbeResult } {
  const match = new RegExp(`\\x1b_Gi=(\\d+),I=${imageNumber};([^\\x1b]+)\\x1b\\\\`).exec(response)
  const imageId = match ? Number(match[1]) : 0
  if (!match || imageId < 1 || imageId > 0xffffffff) {
    return {
      imageId: null,
      result: unansweredQuery(
        { match: null, reason: "sentinel", raw: response, rawBase64: btoa(response) },
        "No matching image allocation reply; no image ownership or transmission conclusion",
      ),
    }
  }
  const pass = match[2] === "OK"
  const note = pass
    ? "RGB image transmission acknowledged; display was not tested"
    : `Image transmission returned ${match[2]}; no support conclusion`
  return {
    imageId: pass ? imageId : null,
    result: {
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
        assertions: [
          {
            kind: "positive" as const,
            expected: `A fresh image ID and I=${imageNumber};OK acknowledge the transmitted RGB pixel`,
            observed: match[0],
          },
        ],
      }),
    },
  }
}

function kittyImageTransferProbe(id: string, display: boolean): ProbeDefinition {
  const newNumber = () => (Number.parseInt(globalThis.crypto.randomUUID().slice(0, 8), 16) % 0xfffffffe) + 1
  return {
    ...probe(
      id,
      (ctx) => {
        const imageNumber = newNumber()
        let imageId: number | null = null
        try {
          const uploaded = allocatedImageResult(ctx.feedCapture(imageTransferRequest(imageNumber)), imageNumber)
          imageId = uploaded.imageId
          if (!imageId || !display) return uploaded.result
          const response = ctx.feedCapture(`\x1b_Ga=p,i=${imageId},c=2,r=1,C=1\x1b\\`)
          return graphicsQueryResult(response, imageId, "Image placement acknowledged; visible pixels were not tested")
        } finally {
          if (imageId) ctx.feed(`\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`)
        }
      },
      async (ctx) => {
        const imageNumber = newNumber()
        let imageId: number | null = null
        try {
          const reply = await ctx.queryWithSentinelOutcome(
            imageTransferRequest(imageNumber),
            new RegExp(`\\x1b_Gi=(\\d+),I=${imageNumber};([^\\x1b]+)\\x1b\\\\`),
          )
          if (!reply.match) {
            return unansweredQuery(
              reply,
              "No matching image allocation reply; no image ownership or transmission conclusion",
            )
          }
          const uploaded = allocatedImageResult(reply.match[0] ?? "", imageNumber)
          imageId = uploaded.imageId
          if (!imageId || !display) return uploaded.result
          const placement = await ctx.queryWithSentinelOutcome(
            `\x1b_Ga=p,i=${imageId},c=2,r=1,C=1\x1b\\`,
            new RegExp(`\\x1b_Gi=${imageId};([^\\x1b]+)\\x1b\\\\`),
          )
          if (!placement.match) {
            return unansweredQuery(placement, "No matching placement reply; visible pixels were not tested")
          }
          return graphicsQueryResult(
            placement.match[0] ?? "",
            imageId,
            "Image placement acknowledged; visible pixels were not tested",
          )
        } finally {
          // Free only the image the terminal explicitly allocated for this probe.
          if (imageId) ctx.write(`\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`)
        }
      },
      "query",
    ),
    termlessObservationEvidence: "query",
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

/** Only an isolated headless backend may receive this disposable OSC 52 nonce. */
function headlessClipboardRoundtrip(ctx: TermlessContext): ProbeResult {
  const nonce = `terminfo-osc52-${randomUUID()}`
  const encoded = btoa(nonce)
  ctx.feed(`\x1b]52;c;${encoded}\x07`)
  const response = ctx.feedCapture("\x1b]52;c;?\x07")
  const frames = response.matchAll(/\x1b\]52;c;([^\x07\x1b]*)(?:\x07|\x1b\\)/g)
  let sawCompleteFrame = false
  let sawInvalidFrame = false
  for (const frame of frames) {
    sawCompleteFrame = true
    const data = frame[1] ?? ""
    try {
      if (btoa(atob(data)) !== data) {
        sawInvalidFrame = true
        continue
      }
      if (atob(data) === nonce) {
        const note = "Isolated backend returned the exact OSC 52 clipboard nonce"
        return {
          pass: true,
          response,
          note,
          observation: { outcome: "supported", evidence: "query", note },
          assertions: [
            { kind: "positive", expected: "OSC 52 c query returns the exact written nonce", observed: frame[0] },
          ],
        }
      }
    } catch {
      sawInvalidFrame = true
    }
  }
  const reason =
    sawInvalidFrame || (response.length > 0 && !sawCompleteFrame)
      ? "invalid-reply"
      : sawCompleteFrame
        ? "insufficient-evidence"
        : "no-response"
  const note =
    reason === "invalid-reply"
      ? "No complete, canonical OSC 52 c reply was received from the isolated backend"
      : reason === "insufficient-evidence"
        ? "OSC 52 c replied with data other than the written nonce"
        : "No OSC 52 c query response from the isolated backend"
  return {
    pass: false,
    response,
    note,
    observation: { outcome: "inconclusive", reason, evidence: "query", note },
  }
}

function liveClipboardNotTested(): ProbeResult {
  const note = "Collector policy: no owned disposable clipboard with verified restoration; OSC 52 was not sent"
  return {
    pass: false,
    note,
    observation: { outcome: "inconclusive", reason: "policy-refused", evidence: "none", note },
  }
}

const osc52Reply = /\x1b\]52;c;([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)/

function clipboardQueryResult(outcome: TerminalQueryOutcome, expected: string): ProbeResult {
  const frame = osc52Reply.exec(outcome.raw)
  if (!frame || outcome.reason !== "reply" || !outcome.match) {
    const reason = outcome.raw ? "invalid-reply" : "no-response"
    return {
      pass: false,
      observation: { outcome: "inconclusive", reason, evidence: "query", note: "No complete OSC 52 c reply" },
    }
  }
  const encoded = frame[1] ?? ""
  let decoded: string
  try {
    decoded = atob(encoded)
    if (btoa(decoded) !== encoded) throw new Error("Noncanonical base64")
  } catch {
    return { pass: false, observation: { outcome: "inconclusive", reason: "invalid-reply", evidence: "query" } }
  }
  const pass = decoded === expected
  return {
    pass,
    response: frame[0],
    observation: {
      outcome: pass ? "supported" : "inconclusive",
      ...(!pass && { reason: "insufficient-evidence" as const }),
      evidence: "query",
    },
    ...(pass && {
      assertions: [
        { kind: "positive" as const, expected: "OSC 52 c returns the independently written nonce", observed: frame[0] },
      ],
    }),
  }
}

async function liveClipboardProbe(ctx: TermContext, kind: "write" | "read" | "roundtrip"): Promise<ProbeResult> {
  if (!ctx.withClipboardFixture) return liveClipboardNotTested()
  return ctx.withClipboardFixture(async (fixture) => {
    if (kind !== "read") {
      const nonce = `terminfo-osc52-${randomUUID()}`
      ctx.write(`\x1b]52;c;${btoa(nonce)}\x07`)
      // A reply on the same TTY confirms the terminal processed the preceding write.
      // The independent clipboard read below is still the evidence of its effect.
      const cursor = await ctx.queryCursorPosition()
      if (!cursor) {
        return {
          pass: false,
          observation: {
            outcome: "inconclusive",
            reason: "no-response",
            evidence: "behavior",
            note: "No cursor reply after OSC 52 write; clipboard contents were not measured",
          },
        }
      }
      const measured = await fixture.readText()
      if (measured !== nonce) {
        return {
          pass: false,
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            evidence: "behavior",
            note: "Independent clipboard read did not equal the OSC 52 write nonce",
          },
        }
      }
      if (kind === "write") {
        return {
          pass: true,
          observation: { outcome: "supported", evidence: "behavior" },
          assertions: [
            { kind: "positive", expected: "Independent clipboard text equals OSC 52 write nonce", observed: measured },
          ],
        }
      }
    }
    const nonce = `terminfo-osc52-${randomUUID()}`
    await fixture.writeText(nonce)
    const outcome = await ctx.queryOutcome("\x1b]52;c;?\x07", osc52Reply)
    const result = clipboardQueryResult(outcome, nonce)
    if (!outcome.raw && ctx.capture && result.observation) {
      const frame = await ctx.capture({ role: "target", label: "Clipboard query after no response" })
      return {
        ...result,
        observation: {
          ...result.observation,
          screenshotRef: frame.ref,
          note: "No OSC 52 reply; retained the visible window for prompt/no-prompt review without automatic interaction",
        },
      }
    }
    return result
  })
}

export const extensionsProbes: ProbeDefinition[] = [
  // Truecolor — capability flag (termless) or SGR parse check (term)
  {
    ...probe(
      "extensions.truecolor",
      (ctx) => {
        // Use the same independent controls and two RGB samples as sgr.fg.truecolor.
        const first = { r: 255, g: 128, b: 0 }
        const second = { r: 17, g: 97, b: 201 }
        ctx.feed("C\x1b[31mA\x1b[34mB\x1b[38;2;255;128;0mX\x1b[38;2;17;97;201mY")
        const baseline = ctx.getCell(0, 0)
        const controlFirst = ctx.getCell(0, 1)
        const controlSecond = ctx.getCell(0, 2)
        const targetFirst = ctx.getCell(0, 3)
        const targetSecond = ctx.getCell(0, 4)
        const state = { baseline, controlFirst, controlSecond, targetFirst, targetSecond }
        const expected = "Two distinct direct-RGB foreground samples match their requested values"
        const same = (a: typeof first | null, b: typeof first) =>
          a !== null && a !== undefined && a.r === b.r && a.g === b.g && a.b === b.b
        if (
          baseline.char !== "C" ||
          controlFirst.char !== "A" ||
          controlSecond.char !== "B" ||
          targetFirst.char !== "X" ||
          targetSecond.char !== "Y" ||
          !targetFirst.fg ||
          !targetSecond.fg
        ) {
          return parserStateResult(null, expected, state, "RGB targets or controls were not exposed")
        }
        if (!controlSecond.fg || same(controlSecond.fg, first)) {
          return parserStateResult(null, expected, state, "The preceding color can mimic an ignored RGB request")
        }
        if (same(targetFirst.fg, first) && same(targetSecond.fg, second)) {
          return parserStateResult(true, expected, state)
        }
        if (controlFirst.fg && !sameRgbCells(controlFirst.fg, controlSecond.fg)) {
          return parserStateResult(false, expected, state)
        }
        return parserStateResult(null, expected, state, "Independent color-channel calibration was absent")
      },
      async (ctx) => {
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("\x1b[38;2;255;0;128mX\x1b[0m")
        const pos = await ctx.queryCursorPosition()
        if (!pos) return unverifiedEffect("No cursor response; RGB color was not measured")
        return unverifiedEffect(
          pos.col === 2
            ? "SGR was consumed; RGB cell color was not measured"
            : `Cursor at col ${pos.col}; RGB color was not measured`,
        )
      },
    ),
    termlessObservationEvidence: "parser-state",
  },

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
  {
    ...queryOnly(
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
    ),
    termlessObservationEvidence: "query",
  },

  // Transmission and placement acknowledgements are separate from rendered pixels.
  kittyImageTransferProbe("extensions.kitty-graphics.transmit", false),
  kittyImageTransferProbe("extensions.kitty-graphics.display", true),

  probe(
    "extensions.kitty-graphics.animation",
    (ctx) => {
      const note = "Declared Kitty graphics capability does not establish timed animation playback"
      return {
        pass: false,
        response: JSON.stringify({ declared: ctx.capabilities.kittyGraphics === true }),
        note,
        observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "legacy", note },
      }
    },
    () => {
      const note = "No timed frame playback or pixel readback for Kitty animation"
      return Promise.resolve<ProbeResult>({
        pass: false,
        note,
        observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none", note },
      })
    },
  ),

  probe(
    "extensions.kitty-graphics.unicode-placeholders",
    (ctx) => {
      const note = "Declared Kitty graphics capability does not establish Unicode placeholder rendering"
      return {
        pass: false,
        response: JSON.stringify({ declared: ctx.capabilities.kittyGraphics === true }),
        note,
        observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "legacy", note },
      }
    },
    () => {
      const note = "No pixel and placeholder-cell readback for Kitty Unicode placeholders"
      return Promise.resolve<ProbeResult>({
        pass: false,
        note,
        observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none", note },
      })
    },
  ),

  // Sixel — rendering remains unmeasured without pixel readback.
  probe(
    "extensions.sixel",
    (ctx) => {
      const note = "Declared Sixel capability does not establish rendered pixels"
      return {
        pass: false,
        response: JSON.stringify({ declared: ctx.capabilities.sixel === true }),
        note,
        observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "legacy", note },
      }
    },
    () => {
      const note = "No pixel readback for Sixel rendering"
      return Promise.resolve<ProbeResult>({
        pass: false,
        note,
        observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none", note },
      })
    },
  ),

  // OSC 8 — hyperlinks
  {
    ...probe(
      "extensions.osc8",
      (ctx) => {
        const uri = "https://example.com/osc8-proof"
        ctx.feed(`\x1b[1;1H\x1b[2KA\x1b]8;;${uri}\x07LINK\x1b]8;;\x07Z`)
        const cells = Array.from({ length: 6 }, (_, col) => ctx.getCell(0, col))
        const expectedChars = "ALINKZ"
        const links = cells.map((cell) =>
          cell.hyperlink !== undefined ? { reported: true, uri: cell.hyperlink } : { reported: false },
        )
        const response = JSON.stringify({ chars: cells.map((cell) => cell.char), links })
        if (ctx.capabilities.osc8Hyperlinks && links.some((link) => !link.reported)) {
          throw new Error("OSC 8 link metadata declared available but absent from a measured cell")
        }
        const reported = links.every((link) => link.reported)
        const charsMatch = cells.every((cell, index) => cell.char === expectedChars[index])
        if (!reported || !charsMatch || cells.slice(1, 5).some((cell) => cell.hyperlink === null)) {
          return {
            pass: false,
            response,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "parser-state",
              note: !reported ? "Backend did not report OSC 8 link metadata" : "Linked text was not observable",
            },
          }
        }
        const expected = JSON.stringify({
          chars: [...expectedChars],
          links: [null, uri, uri, uri, uri, null].map((link) => ({ reported: true, uri: link })),
        })
        const observed = response
        const pass = observed === expected
        return {
          pass,
          response,
          observation: {
            outcome: pass ? "supported" : "unsupported",
            evidence: "parser-state",
            ...(!pass && { note: "OSC 8 cell URI differs from the exact requested link or leaked past close" }),
          },
          assertions: [{ kind: pass ? "positive" : "negative", expected, observed }],
        }
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 1 || ctx.cols < 7) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `OSC 8 fixture needs at least 1x7, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("A\x1b]8;;https://example.com/osc8-proof\x07LINK\x1b]8;;\x07Z")
        const pos = await ctx.queryCursorPosition()
        if (!pos) {
          return {
            pass: false,
            note: "No cursor response",
            observation: { outcome: "inconclusive", reason: "no-response", evidence: "consumed" },
          }
        }
        return {
          pass: false,
          response: `${pos.row};${pos.col}`,
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            evidence: "consumed",
            note: "Cursor movement cannot verify OSC 8 link metadata or click behavior",
          },
        }
      },
      "consumed",
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  // Current wrapping and a declared backend capability do not measure reflow after resize.
  probe(
    "extensions.reflow",
    (ctx) => {
      const note = "No controlled resize and cell-content readback to measure reflow"
      return {
        pass: false,
        response: JSON.stringify({ declaredReflow: ctx.capabilities.reflow === true }),
        note,
        observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "legacy", note },
      }
    },
    () => {
      const note = "No controlled resize and cell-content readback to measure reflow"
      return Promise.resolve<ProbeResult>({
        pass: false,
        note,
        observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none", note },
      })
    },
  ),

  // Semantic prompts (OSC 133)
  probe(
    "extensions.semantic-prompts",
    (ctx) => {
      const note = "Declared semantic-prompt capability does not establish shell prompt integration"
      return {
        pass: false,
        response: JSON.stringify({ declared: ctx.capabilities.semanticPrompts === true }),
        note,
        observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "legacy", note },
      }
    },
    () => {
      const note = "No shell prompt integration metadata or behavior readback for OSC 133"
      return Promise.resolve<ProbeResult>({
        pass: false,
        note,
        observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none", note },
      })
    },
  ),

  // OSC 2 — window title
  {
    ...probe(
      "extensions.osc2-title",
      (ctx) => {
        ctx.feed("\x1b]2;Test Title\x07")
        const title = ctx.getTitle()
        return parserStateResult(title === "Test Title", "OSC 2 sets the exact requested window title", { title })
      },
      async (ctx) => {
        ctx.write("\x1b]2;terminfo-test\x07")
        const pos = await ctx.queryCursorPosition()
        ctx.write("\x1b]2;\x07") // reset title
        return unverifiedEffect(
          pos
            ? "Cursor answered; changed window title was not read back"
            : "No cursor response; window title was not read back",
        )
      },
    ),
    termlessObservationEvidence: "parser-state",
  },

  // OSC 0 — icon name and title
  {
    ...probe(
      "extensions.osc0-icon-title",
      (ctx) => {
        const before = ctx.getTitle()
        ctx.feed("\x1b]0;My Title\x07")
        const after = ctx.getTitle()
        const note = "Title readback does not establish OSC 0 icon-name behavior"
        return {
          pass: false,
          response: JSON.stringify({ before, after }),
          note,
          observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "parser-state", note },
        }
      },
      () => {
        const note = "No icon-name and window-title readback for OSC 0"
        return Promise.resolve<ProbeResult>({
          pass: false,
          note,
          observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none", note },
        })
      },
    ),
    termlessObservationEvidence: "parser-state",
  },

  // OSC 52 — clipboard
  {
    ...probe(
      "extensions.osc52-clipboard",
      headlessClipboardRoundtrip,
      (ctx) => liveClipboardProbe(ctx, "roundtrip"),
      "behavior",
    ),
    termlessObservationEvidence: "query",
  },

  // OSC 52 write — set clipboard (most terminals support this)
  {
    ...probe(
      "extensions.osc52-write",
      headlessClipboardRoundtrip,
      (ctx) => liveClipboardProbe(ctx, "write"),
      "behavior",
    ),
    termlessObservationEvidence: "query",
  },

  // OSC 52 read — query clipboard back (fewer terminals support this)
  {
    ...probe("extensions.osc52-read", headlessClipboardRoundtrip, (ctx) => liveClipboardProbe(ctx, "read"), "query"),
    termlessObservationEvidence: "query",
  },

  // OSC 10 — foreground color query
  oscColorQueryProbe("extensions.osc10-fg-color", 10),

  // OSC 11 — background color query
  oscColorQueryProbe("extensions.osc11-bg-color", 11),

  // OSC 7 — current working directory
  probe(
    "extensions.osc7-cwd",
    (ctx) => {
      const note = "Declared OSC 7 capability does not establish working-directory metadata delivery"
      return {
        pass: false,
        response: JSON.stringify({ declared: ctx.capabilities.extensions.has("osc7") }),
        note,
        observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "legacy", note },
      }
    },
    () => {
      const note = "No working-directory metadata readback for OSC 7"
      return Promise.resolve<ProbeResult>({
        pass: false,
        note,
        observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none", note },
      })
    },
  ),

  // OSC 633 — VS Code shell integration
  probe(
    "extensions.osc-633-vscode",
    (ctx) => {
      const note = "Declared semantic-prompt capability does not establish VS Code OSC 633 shell integration"
      return {
        pass: false,
        response: JSON.stringify({ declared: ctx.capabilities.semanticPrompts === true }),
        note,
        observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "legacy", note },
      }
    },
    () => {
      const note = "No VS Code shell integration metadata or behavior readback for OSC 633"
      return Promise.resolve<ProbeResult>({
        pass: false,
        note,
        observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none", note },
      })
    },
  ),

  // OSC 133 sub-commands — semantic prompt markers (FinalTerm)
  // Each probe sends the marker followed by "X" and verifies "X" landed at cell (0,0),
  // proving the OSC sequence was silently consumed (not printed literally).

  // OSC 133;A — prompt start (FTCS_PROMPT)
  {
    ...probe(
      "extensions.osc133-a",
      (ctx) => {
        ctx.feed("\x1b]133;A\x07X")
        // Verify the OSC sequence was consumed and "X" landed at column 0.
        const cell = ctx.getCell(0, 0)
        return promptConsumptionResult(cell.char === "X")
      },
      async (ctx) => {
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("\x1b]133;A\x07X")
        const pos = await ctx.queryCursorPosition()
        return promptConsumptionResult(pos === null ? null : pos.col === 2)
      },
    ),
    termlessObservationEvidence: "consumed",
  },

  // OSC 133;B — command start (FTCS_COMMAND_START)
  {
    ...probe(
      "extensions.osc133-b",
      (ctx) => {
        ctx.feed("\x1b]133;B\x07X")
        const cell = ctx.getCell(0, 0)
        return promptConsumptionResult(cell.char === "X")
      },
      async (ctx) => {
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("\x1b]133;B\x07X")
        const pos = await ctx.queryCursorPosition()
        return promptConsumptionResult(pos === null ? null : pos.col === 2)
      },
    ),
    termlessObservationEvidence: "consumed",
  },

  // OSC 133;C — command executed (FTCS_COMMAND_EXECUTED)
  {
    ...probe(
      "extensions.osc133-c",
      (ctx) => {
        ctx.feed("\x1b]133;C\x07X")
        const cell = ctx.getCell(0, 0)
        return promptConsumptionResult(cell.char === "X")
      },
      async (ctx) => {
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("\x1b]133;C\x07X")
        const pos = await ctx.queryCursorPosition()
        return promptConsumptionResult(pos === null ? null : pos.col === 2)
      },
    ),
    termlessObservationEvidence: "consumed",
  },

  // OSC 133;D — command finished with exit code (FTCS_COMMAND_FINISHED)
  {
    ...probe(
      "extensions.osc133-d",
      (ctx) => {
        ctx.feed("\x1b]133;D;0\x07X")
        const cell = ctx.getCell(0, 0)
        return promptConsumptionResult(cell.char === "X")
      },
      async (ctx) => {
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("\x1b]133;D;0\x07X")
        const pos = await ctx.queryCursorPosition()
        return promptConsumptionResult(pos === null ? null : pos.col === 2)
      },
    ),
    termlessObservationEvidence: "consumed",
  },

  // OSC 133;P — properties (Cwd, CmdLine, etc.)
  {
    ...probe(
      "extensions.osc133-p",
      (ctx) => {
        ctx.feed("\x1b]133;P;Cwd=/tmp\x07X")
        const cell = ctx.getCell(0, 0)
        return promptConsumptionResult(cell.char === "X")
      },
      async (ctx) => {
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("\x1b]133;P;Cwd=/tmp\x07X")
        const pos = await ctx.queryCursorPosition()
        return promptConsumptionResult(pos === null ? null : pos.col === 2)
      },
    ),
    termlessObservationEvidence: "consumed",
  },

  // OSC 633 sub-commands — VS Code shell integration markers
  // VS Code's parallel namespace to OSC 133, with VS Code-specific extensions (E, P).

  // OSC 633;A — prompt start (mirrors 133;A)
  {
    ...probe(
      "extensions.osc633-a",
      (ctx) => {
        ctx.feed("\x1b]633;A\x07X")
        const cell = ctx.getCell(0, 0)
        return promptConsumptionResult(cell.char === "X")
      },
      async (ctx) => {
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("\x1b]633;A\x07X")
        const pos = await ctx.queryCursorPosition()
        return promptConsumptionResult(pos === null ? null : pos.col === 2)
      },
    ),
    termlessObservationEvidence: "consumed",
  },

  // OSC 633;B — prompt end (mirrors 133;B)
  {
    ...probe(
      "extensions.osc633-b",
      (ctx) => {
        ctx.feed("\x1b]633;B\x07X")
        const cell = ctx.getCell(0, 0)
        return promptConsumptionResult(cell.char === "X")
      },
      async (ctx) => {
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("\x1b]633;B\x07X")
        const pos = await ctx.queryCursorPosition()
        return promptConsumptionResult(pos === null ? null : pos.col === 2)
      },
    ),
    termlessObservationEvidence: "consumed",
  },

  // OSC 633;C — pre-execution (mirrors 133;C)
  {
    ...probe(
      "extensions.osc633-c",
      (ctx) => {
        ctx.feed("\x1b]633;C\x07X")
        const cell = ctx.getCell(0, 0)
        return promptConsumptionResult(cell.char === "X")
      },
      async (ctx) => {
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("\x1b]633;C\x07X")
        const pos = await ctx.queryCursorPosition()
        return promptConsumptionResult(pos === null ? null : pos.col === 2)
      },
    ),
    termlessObservationEvidence: "consumed",
  },

  // OSC 633;D — command finished with exit code (mirrors 133;D)
  {
    ...probe(
      "extensions.osc633-d",
      (ctx) => {
        ctx.feed("\x1b]633;D;0\x07X")
        const cell = ctx.getCell(0, 0)
        return promptConsumptionResult(cell.char === "X")
      },
      async (ctx) => {
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("\x1b]633;D;0\x07X")
        const pos = await ctx.queryCursorPosition()
        return promptConsumptionResult(pos === null ? null : pos.col === 2)
      },
    ),
    termlessObservationEvidence: "consumed",
  },

  // OSC 633;E — set commandline with verification nonce (unique to OSC 633)
  {
    ...probe(
      "extensions.osc633-e",
      (ctx) => {
        ctx.feed("\x1b]633;E;ls -la;nonce123\x07X")
        const cell = ctx.getCell(0, 0)
        return promptConsumptionResult(cell.char === "X")
      },
      async (ctx) => {
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("\x1b]633;E;ls -la;nonce123\x07X")
        const pos = await ctx.queryCursorPosition()
        return promptConsumptionResult(pos === null ? null : pos.col === 2)
      },
    ),
    termlessObservationEvidence: "consumed",
  },

  // OSC 633;P — VS Code-specific properties (Cwd, IsWindows, git status)
  {
    ...probe(
      "extensions.osc633-p",
      (ctx) => {
        ctx.feed("\x1b]633;P;Cwd=/tmp\x07X")
        const cell = ctx.getCell(0, 0)
        return promptConsumptionResult(cell.char === "X")
      },
      async (ctx) => {
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("\x1b]633;P;Cwd=/tmp\x07X")
        const pos = await ctx.queryCursorPosition()
        return promptConsumptionResult(pos === null ? null : pos.col === 2)
      },
    ),
    termlessObservationEvidence: "consumed",
  },

  // OSC 9 — desktop notifications
  probe(
    "extensions.notifications",
    (ctx) => {
      const note = "Declared OSC 9 capability does not establish desktop notification delivery"
      return {
        pass: false,
        response: JSON.stringify({ declared: ctx.capabilities.extensions.has("osc9") }),
        note,
        observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "legacy", note },
      }
    },
    () => {
      const note = "No desktop notification delivery readback for OSC 9"
      return Promise.resolve<ProbeResult>({
        pass: false,
        note,
        observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none", note },
      })
    },
  ),

  // OSC 1337 — iTerm2 inline images
  probe(
    "extensions.iterm2-images",
    (ctx) => {
      const note = "Declared iTerm2 image capability does not establish rendered image pixels"
      return {
        pass: false,
        response: JSON.stringify({ declared: ctx.capabilities.extensions.has("iterm2Images") }),
        note,
        observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "legacy", note },
      }
    },
    () => {
      const note = "No pixel readback for iTerm2 inline image rendering"
      return Promise.resolve<ProbeResult>({
        pass: false,
        note,
        observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none", note },
      })
    },
  ),

  // OSC 1337 ReportCellSize — query cell dimensions in pixels
  oscSimpleQueryProbe(
    "extensions.osc1337-cellsize",
    "\x1b]1337;ReportCellSize\x07",
    /\x1b\]1337;ReportCellSize=[1-9][0-9]*(?:\.[0-9]+)?;[1-9][0-9]*(?:\.[0-9]+)?(?:\x07|\x1b\\)/,
    /\x1b\]1337;ReportCellSize=/,
    "Complete OSC 1337 ReportCellSize reply with two positive dimensions",
  ),

  // OSC 1337 RequestCapabilities — query terminal capabilities
  oscSimpleQueryProbe(
    "extensions.osc1337-capabilities",
    "\x1b]1337;RequestCapabilities\x07",
    /\x1b\]1337;Capabilities=[^\x07\x1b]*(?:\x07|\x1b\\)/,
    /\x1b\]1337;Capabilities=/,
    "Complete OSC 1337 Capabilities reply",
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
      return unmeasuredCellResult(pos, "OSC 9;4 progress display")
    },
  ),

  // OSC 66 — text sizing protocol (Kitty, sets text scale/cell width)
  {
    ...probe(
      "extensions.osc66-text-sizing",
      (ctx) => {
        ctx.feed("\x1b[1;1H\x1b[2K\r")
        const before = { ...ctx.getCursor() }
        if (before.x !== 0 || before.y !== 0) {
          const note = `OSC 66 baseline cursor did not reach home: ${before.y};${before.x}`
          return {
            pass: false,
            response: JSON.stringify({ row: before.y, col: before.x }),
            note,
            observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "parser-state", note },
          }
        }
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
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 1 || ctx.cols < 5) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `OSC 66 fixture needs at least 1x5, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
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
        if (before.row !== 1 || before.col !== 1) {
          const note = `OSC 66 baseline cursor did not reach home: ${before.row};${before.col}`
          return {
            pass: false,
            response: JSON.stringify(before),
            note,
            observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "behavior", note },
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
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  // OSC 5522 — advanced clipboard (Kitty protocol, MIME-aware paste events)
  {
    ...queryOnly(
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
    ),
    termlessObservationEvidence: "query",
  },

  // OSC 1 — icon name
  {
    ...probe(
      "extensions.osc1-icon",
      (ctx) => {
        const before = ctx.getTitle()
        ctx.feed("\x1b]1;test-icon\x07")
        const after = ctx.getTitle()
        const note = "Title readback does not establish OSC 1 icon-name behavior"
        return {
          pass: false,
          response: JSON.stringify({ before, after }),
          note,
          observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "parser-state", note },
        }
      },
      () => {
        const note = "No icon-name readback for OSC 1"
        return Promise.resolve<ProbeResult>({
          pass: false,
          note,
          observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none", note },
        })
      },
    ),
    termlessObservationEvidence: "parser-state",
  },

  // OSC 4 — color palette query for index 0.
  oscSimpleQueryProbe(
    "extensions.osc4-palette",
    "\x1b]4;0;?\x07",
    /\x1b\]4;0;rgb:[0-9a-f]{1,4}\/[0-9a-f]{1,4}\/[0-9a-f]{1,4}(?:\x07|\x1b\\)/i,
    /\x1b\]4;0;/,
    "Complete OSC 4 index-0 color reply",
  ),

  // OSC 5 — special color query for index 0.
  oscSimpleQueryProbe(
    "extensions.osc5-special-color",
    "\x1b]5;0;?\x07",
    /\x1b\]5;0;rgb:[0-9a-f]{1,4}\/[0-9a-f]{1,4}\/[0-9a-f]{1,4}(?:\x07|\x1b\\)/i,
    /\x1b\]5;0;/,
    "Complete OSC 5 index-0 color reply",
  ),

  // OSC 12 — cursor color query
  oscColorQueryProbe("extensions.osc12-cursor-color", 12),

  // OSC 104 — reset color palette
  probe("extensions.osc104-reset-palette", colorResetProbe(4, 104, 0), async (ctx) => {
    ctx.write("\x1b[1;1H\x1b[2K")
    ctx.write("\x1b]104\x07") // reset all palette colors
    const pos = await ctx.queryCursorPosition()
    return unverifiedEffect(
      pos ? "Cursor answered; palette restoration was not measured" : "No cursor response after OSC 104",
    )
  }),

  // OSC 110 — reset foreground color
  probe("extensions.osc110-reset-fg", colorResetProbe(10, 110), async (ctx) => {
    ctx.write("\x1b[1;1H\x1b[2K")
    ctx.write("\x1b]110\x07")
    const pos = await ctx.queryCursorPosition()
    return unverifiedEffect(
      pos ? "Cursor answered; foreground restoration was not measured" : "No cursor response after OSC 110",
    )
  }),

  // OSC 111 — reset background color
  probe("extensions.osc111-reset-bg", colorResetProbe(11, 111), async (ctx) => {
    ctx.write("\x1b[1;1H\x1b[2K")
    ctx.write("\x1b]111\x07")
    const pos = await ctx.queryCursorPosition()
    return unverifiedEffect(
      pos ? "Cursor answered; background restoration was not measured" : "No cursor response after OSC 111",
    )
  }),

  // OSC 112 — reset cursor color
  probe("extensions.osc112-reset-cursor", colorResetProbe(12, 112), async (ctx) => {
    ctx.write("\x1b[1;1H\x1b[2K")
    ctx.write("\x1b]112\x07")
    const pos = await ctx.queryCursorPosition()
    return unverifiedEffect(
      pos ? "Cursor answered; cursor-color restoration was not measured" : "No cursor response after OSC 112",
    )
  }),

  // OSC 117 — reset highlight background
  {
    ...probe(
      "extensions.osc117-reset-highlight-bg",
      (ctx) => {
        // Verify the reset sequence is consumed without producing visible output
        ctx.feed("\x1b]117\x07X")
        const cell = ctx.getCell(0, 0)
        return parserStateResult(
          null,
          "OSC 117 restores the highlight background color",
          { cell },
          "Printed X does not expose highlight background",
        )
      },
      async (ctx) => {
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("\x1b]117\x07")
        const pos = await ctx.queryCursorPosition()
        return unverifiedEffect(
          pos ? "Cursor answered; highlight background was not read back" : "No cursor response after OSC 117",
        )
      },
    ),
    termlessObservationEvidence: "parser-state",
  },

  // OSC 119 — reset highlight foreground
  {
    ...probe(
      "extensions.osc119-reset-highlight-fg",
      (ctx) => {
        // Verify the reset sequence is consumed without producing visible output
        ctx.feed("\x1b]119\x07X")
        const cell = ctx.getCell(0, 0)
        return parserStateResult(
          null,
          "OSC 119 restores the highlight foreground color",
          { cell },
          "Printed X does not expose highlight foreground",
        )
      },
      async (ctx) => {
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("\x1b]119\x07")
        const pos = await ctx.queryCursorPosition()
        return unverifiedEffect(
          pos ? "Cursor answered; highlight foreground was not read back" : "No cursor response after OSC 119",
        )
      },
    ),
    termlessObservationEvidence: "parser-state",
  },

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
      return unmeasuredCellResult(pos, "OSC 22 pointer shape")
    },
  ),

  // Query capabilities without displaying a notification or requiring desktop access.
  queryOnly(
    probe(
      "extensions.osc99-kitty-notify",
      null, // Desktop notification delivery is outside a headless parser's scope.
      async (ctx) => {
        const id = globalThis.crypto.randomUUID()
        const reply = await ctx.queryWithSentinelOutcome(
          `\x1b]99;i=${id}:p=?;\x1b\\`,
          new RegExp(`\\x1b\\]99;i=${id}:p=\\?;([^\\x07\\x1b]*)(?:\\x07|\\x1b\\\\)`),
        )
        if (!reply.match) {
          return unansweredQuery(reply, "No matching notification query reply; OS display was not tested")
        }
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
  ),

  // OSC 777 — rxvt-unicode notifications
  probe(
    "extensions.osc777-notify",
    null, // Headless: no way to detect notification support (silently consumed)
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]777;notify;test;body\x07")
      const pos = await ctx.queryCursorPosition()
      return unmeasuredCellResult(pos, "OSC 777 notification delivery")
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
      return unmeasuredCellResult(pos, "OSC 666 terminal property")
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
      return unmeasuredCellResult(pos, "OSC 3008 systemd context")
    },
  ),

  // OSC 113 — reset pointer fg color
  probe("extensions.osc113-reset-pointer-fg", colorResetProbe(13, 113), async (ctx) => {
    ctx.write("\x1b[1;1H\x1b[2K")
    ctx.write("\x1b]113\x07")
    const pos = await ctx.queryCursorPosition()
    return unverifiedEffect(
      pos ? "Cursor answered; pointer foreground restoration was not measured" : "No cursor response after OSC 113",
    )
  }),

  // OSC 114 — reset pointer bg color
  probe("extensions.osc114-reset-pointer-bg", colorResetProbe(14, 114), async (ctx) => {
    ctx.write("\x1b[1;1H\x1b[2K")
    ctx.write("\x1b]114\x07")
    const pos = await ctx.queryCursorPosition()
    return unverifiedEffect(
      pos ? "Cursor answered; pointer background restoration was not measured" : "No cursor response after OSC 114",
    )
  }),

  // OSC 21 — require the actual foreground reply, never a subsequent CPR.
  {
    ...queryOnly(
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
    ),
    termlessObservationEvidence: "query",
  },

  // OSC 30001 — Kitty color stack push
  probe("extensions.osc30001-color-stack-push", colorStackProbe(), colorStackTermProbe, "behavior"),

  // OSC 30101 — Kitty color stack pop
  probe("extensions.osc30101-color-stack-pop", colorStackProbe(), colorStackTermProbe, "behavior"),

  // OSC 176 — foot Wayland app-id
  probe(
    "extensions.osc176-app-id",
    null, // Headless: app-id is a Wayland window-manager concept, not in the cell grid
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]176;terminfo-test\x07")
      const pos = await ctx.queryCursorPosition()
      return unmeasuredCellResult(pos, "OSC 176 Wayland app-id")
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
      return unmeasuredCellResult(pos, "OSC 555 screen flash")
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
      return unmeasuredCellResult(pos, "OSC 440 audio playback")
    },
  ),

  // OSC 7770 — mintty font size query/set
  oscSimpleQueryProbe(
    "extensions.osc7770-font-size",
    "\x1b]7770;?\x07",
    /\x1b\]7770;[0-9]+(?:\x07|\x1b\\)/,
    /\x1b\]7770;/,
    "Complete OSC 7770 font-size reply",
  ),

  // OSC 7777 — mintty font + window size (zoom)
  oscSimpleQueryProbe(
    "extensions.osc7777-font-window-size",
    "\x1b]7777;?\x07",
    /\x1b\]7777;[0-9]+(?:\x07|\x1b\\)/,
    /\x1b\]7777;/,
    "Complete OSC 7777 window-size reply",
  ),

  // OSC 701 — rxvt-unicode locale query/set
  oscSimpleQueryProbe(
    "extensions.osc701-locale",
    "\x1b]701;?\x07",
    /\x1b\]701;[A-Za-z0-9_.-]+(?:\x07|\x1b\\)/,
    /\x1b\]701;/,
    "Complete OSC 701 locale reply",
  ),

  // OSC 702 — rxvt-unicode version query
  oscSimpleQueryProbe(
    "extensions.osc702-version",
    "\x1b]702\x07",
    /\x1b\]702;[^\x07\x1b]+(?:\x07|\x1b\\)/,
    /\x1b\]702;/,
    "Complete OSC 702 version reply",
  ),

  // OSC 710 — rxvt-unicode set normal font
  probe(
    "extensions.osc710-font-normal",
    null, // Headless: font selection is not observable in the cell grid
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]710;fixed\x07")
      const pos = await ctx.queryCursorPosition()
      return unmeasuredCellResult(pos, "OSC 710 font selection")
    },
  ),

  // OSC 720 — rxvt-unicode scroll view up
  {
    ...probe("extensions.osc720-scroll-up", osc720ScrollProbe(), async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]720\x07")
      const pos = await ctx.queryCursorPosition()
      return unverifiedEffect(
        pos ? "Cursor answered; scrollback viewport was not measured" : "No cursor response after OSC 720",
      )
    }),
    termlessObservationEvidence: "parser-state",
  },

  // OSC 776 — rxvt-unicode cell size report
  oscSimpleQueryProbe(
    "extensions.osc776-cell-size",
    "\x1b]776\x07",
    /\x1b\]776;[0-9]+;[0-9]+;[0-9]+(?:\x07|\x1b\\)/,
    /\x1b\]776;/,
    "Complete OSC 776 cell-size reply",
  ),

  // Sixel support advertised in DA1 response (attribute 4)
  {
    ...queryOnly(
      probe(
        "extensions.sixel-da1",
        (ctx) => {
          const raw = ctx.feedCapture("\x1b[c")
          return sixelDa1Result(raw, /\x1b\[\?[0-9]+(?:;[0-9]+)*c/.exec(raw)?.[0] ?? null)
        },
        async (ctx) => {
          const reply = await ctx.queryOutcome("\x1b[c", /\x1b\[\?[0-9]+(?:;[0-9]+)*c/)
          return sixelDa1Result(reply.raw, reply.reason === "reply" ? (reply.match?.[0] ?? null) : null)
        },
        "query",
      ),
    ),
    termlessObservationEvidence: "query",
  },

  // XTSMGRAPHICS item 2 reads current Sixel geometry in pixels; item 1 is only color registers.
  {
    ...queryOnly(
      probe(
        "extensions.sixel-geometry-report",
        (ctx) => {
          const raw = ctx.feedCapture("\x1b[?2;1;0S")
          const frame = /\x1b\[\?2;[0-9;]*S/.exec(raw)?.[0] ?? null
          return sixelGeometryResult(raw, frame, "no-response")
        },
        async (ctx) => {
          const reply = await ctx.queryWithSentinelOutcome("\x1b[?2;1;0S", /\x1b\[\?2;[0-9;]*S/, 1000)
          const frame = reply.reason === "reply" ? (reply.match?.[0] ?? null) : null
          return sixelGeometryResult(reply.raw, frame, reply.reason === "timeout" ? "timeout" : "no-response")
        },
        "query",
      ),
    ),
    termlessObservationEvidence: "query",
  },
]
