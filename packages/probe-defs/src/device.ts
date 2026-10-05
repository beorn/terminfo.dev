import type { ProbeDefinition, ProbeResult, TerminalQueryOutcome } from "./types.ts"
import { parserStateResult, probe } from "./helpers.ts"

/** These patterns match complete answers to the specific query, not arbitrary consumed output. */
interface DeviceReply {
  id: string
  query: string
  valid: RegExp
  malformed: RegExp
  expected: string
  refusal?: RegExp
  /** A complete, well-formed answer to this query whose payload is not the expected one. */
  contradicts?: RegExp
  note?: (frame: string) => string | undefined
  direct?: boolean
}

function deviceReplyResult(
  spec: DeviceReply,
  raw: string,
  matchedFrame: string | null,
  reason: TerminalQueryOutcome["reason"],
): ProbeResult {
  // A frame that appears after a DA1 response is late sentinel output, not this query's answer.
  const da1At = raw.search(/\x1b\[\?[0-9;]*c/)
  if (matchedFrame && da1At !== -1 && raw.indexOf(matchedFrame) > da1At) matchedFrame = null
  const valid = matchedFrame ? spec.valid.exec(matchedFrame) : null
  if (valid?.[0]) {
    const note = spec.note?.(valid[0])
    return {
      pass: true,
      response: raw,
      ...(note && { note }),
      observation: { outcome: "supported", evidence: "query", ...(note && { note }) },
      assertions: [{ kind: "positive", expected: spec.expected, observed: valid[0] }],
    }
  }
  const refusal = matchedFrame ? spec.refusal?.exec(matchedFrame) : null
  if (refusal?.[0]) {
    return {
      pass: false,
      response: raw,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "query",
        note: "Requested setting or name refused; other settings or names unmeasured",
      },
    }
  }
  // A complete, surfaced answer whose payload contradicts the expectation is a measured negative.
  // matchedFrame is never a frame that arrived after the DA1 sentinel, so late output cannot be graded.
  const contradiction = matchedFrame ? (spec.contradicts?.exec(matchedFrame) ?? null) : null
  if (contradiction?.[0]) {
    return {
      pass: false,
      response: raw,
      observation: { outcome: "unsupported", evidence: "query" },
      assertions: [{ kind: "negative", expected: spec.expected, observed: contradiction[0] }],
    }
  }
  // Raw bytes remain available for diagnostics, but a frame after DA1 cannot establish a result.
  const hasCompleteUnmatchedFrame =
    spec.valid.test(raw) || spec.refusal?.test(raw) === true || spec.contradicts?.test(raw) === true
  const missingReason =
    !hasCompleteUnmatchedFrame && spec.malformed.test(raw)
      ? "invalid-reply"
      : reason === "timeout"
        ? "timeout"
        : "no-response"
  return {
    pass: false,
    response: raw,
    observation: { outcome: "inconclusive", reason: missingReason, evidence: "query" },
  }
}

/** Every complete answer shape this query accepts: the expected frame, a refusal, or a contradiction. */
function answerPattern(spec: DeviceReply): RegExp {
  const sources = [spec.valid.source, spec.refusal?.source, spec.contradicts?.source].filter(
    (source): source is string => source !== undefined,
  )
  return new RegExp(sources.join("|"), spec.valid.flags)
}

function deviceQuery(spec: DeviceReply): ProbeDefinition {
  const responsePattern = answerPattern(spec)
  const definition = probe(
    spec.id,
    (ctx) => {
      const raw = ctx.feedCapture(spec.query)
      return deviceReplyResult(spec, raw, responsePattern.exec(raw)?.[0] ?? null, "sentinel")
    },
    async (ctx) => {
      // Primary DA1 answers its own direct query; all other device queries use DA1 as a sentinel.
      const outcome = spec.direct
        ? await ctx.queryOutcome(spec.query, responsePattern)
        : await ctx.queryWithSentinelOutcome(spec.query, responsePattern)
      const matchedFrame = outcome.reason === "reply" ? (outcome.match?.[0] ?? null) : null
      return deviceReplyResult(spec, outcome.raw, matchedFrame, outcome.reason)
    },
    "query",
  )
  return { ...definition, termWrites: "query", termlessObservationEvidence: "query" }
}

const iconLabelReply: DeviceReply = {
  id: "device.xtwinops-20",
  query: "\x1b[20t",
  valid: /\x1b\]Ltest-icon(?:\x07|\x1b\\)/,
  malformed: /\x1b\]L/,
  // A complete, terminated OSC L frame is a measured negative when its whole payload is not the
  // exact label; the payload class keeps the match on one frame so it cannot span a truncated starter.
  contradicts: /\x1b\]L[^\x07\x1b]*(?:\x07|\x1b\\)/,
  expected: "OSC 1 + CSI 20 t round trip returns the exact icon label",
}

const windowTitleReply: DeviceReply = {
  id: "device.xtwinops-21",
  query: "\x1b[21t",
  valid: /\x1b\]ltest-title(?:\x07|\x1b\\)/,
  malformed: /\x1b\]l/,
  expected: "CSI 21 t returns the exact window title set by OSC 2",
}

export const deviceProbes: ProbeDefinition[] = [
  deviceQuery({
    id: "device.primary-da",
    query: "\x1b[c",
    // Kitty includes a trailing empty parameter: CSI ? 62 ; 52 ; c.
    valid: /\x1b\[\?[0-9]+(?:;[0-9]+)*;?c/,
    malformed: /\x1b\[\?/,
    expected: "complete DA1 CSI ? numeric attributes c",
    direct: true, // DA1 is also the normal sentinel; it must be queried directly.
  }),
  deviceQuery({
    id: "device.status-report",
    query: "\x1b[5n",
    valid: /\x1b\[(?:0|3)n/,
    malformed: /\x1b\[[0-9]*n/,
    expected: "complete DSR 5 status 0 (ready) or 3 (malfunction)",
    note: (frame) => (frame === "\x1b[3n" ? "Terminal reports malfunction" : undefined),
  }),
  deviceQuery({
    id: "device.secondary-da",
    query: "\x1b[>c",
    valid: /\x1b\[>[0-9]+;[0-9]+;[0-9]+c/,
    malformed: /\x1b\[>/,
    expected: "complete DA2 CSI > three numeric fields c",
  }),
  deviceQuery({
    id: "device.tertiary-da",
    query: "\x1b[=c",
    valid: /\x1bP!\|[0-9A-Fa-f]{8}\x1b\\/,
    malformed: /\x1bP!\|/,
    expected: "complete DECRPTUI DCS !| followed by four hexadecimal pairs and ST",
  }),
  deviceQuery({
    id: "device.decrqss",
    query: "\x1bP$qm\x1b\\",
    valid: /\x1bP1\$r[0-9:;]*m\x1b\\/,
    refusal: /\x1bP0\$r\x1b\\/,
    malformed: /\x1bP[01]\$r/,
    expected: "complete DECRQSS status 1 SGR parameters ending m and ST",
  }),
  deviceQuery({
    id: "device.xtgettcap",
    query: "\x1bP+q544e\x1b\\",
    valid: /\x1bP1\+r544e=(?:[0-9A-Fa-f]{2})+\x1b\\/i,
    refusal: /\x1bP0\+r\x1b\\/,
    malformed: /\x1bP[01]\+r/,
    expected: "complete XTGETTCAP status 1 for TN with even-length hex value and ST",
  }),
  deviceQuery({
    id: "device.decrpm",
    query: "\x1b[?7$p",
    valid: /\x1b\[\?7;[1-4]\$y/,
    refusal: /\x1b\[\?7;0\$y/,
    malformed: /\x1b\[\?[0-9]+;[0-9]*\$y|\x1b\[\?7(?:;|\$)/,
    expected: "complete DECRPM for DECAWM mode 7 with recognized state 1–4",
  }),
  deviceQuery({
    id: "device.xtversion",
    query: "\x1b[>0q",
    valid: /\x1bP>\|[\x20-\x7e]+\x1b\\/,
    malformed: /\x1bP>\|/,
    expected: "complete XTVERSION DCS >| printable name/version ST",
  }),
  probe(
    "device.term-features",
    null,
    () => {
      // Inherited process environment does not authenticate the current terminal.
      const advertised = typeof process !== "undefined" && !!process.env.TERM_FEATURES
      return Promise.resolve<ProbeResult>({
        pass: false,
        note: advertised ? "TERM_FEATURES advertised; source unverified" : "TERM_FEATURES not advertised",
        observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "legacy" },
      })
    },
    "legacy",
  ),

  // DSR ?996 — color-scheme query: CSI ? 996 n → CSI ? 997 ; Ps n
  {
    ...probe(
      "device.dsr-996-color-scheme",
      (ctx) => {
        const response = ctx.feedCapture("\x1b[?996n")
        const match = /\x1b\[\?997;([12])n/.exec(response)
        if (!match?.[0]) {
          return {
            pass: false,
            note: "No valid DSR ?997 color-scheme response",
            response,
            observation: {
              outcome: "inconclusive",
              evidence: "query",
              reason: response.includes("\x1b[?997;") ? "invalid-reply" : "no-response",
            },
          }
        }
        return {
          pass: true,
          note: match[1] === "1" ? "dark" : "light",
          response,
          observation: {
            outcome: "supported",
            evidence: "query",
            note: "Current scheme queried; unsolicited change events were not tested",
          },
          assertions: [
            { kind: "positive", expected: "DSR ?996 yields complete DSR ?997;1n or ?997;2n", observed: match[0] },
          ],
        }
      },
      async (ctx) => {
        const reply = await ctx.queryWithSentinelOutcome("\x1b[?996n", /\x1b\[\?997;([12])n/)
        const match = reply.match
        if (!match?.[0]) {
          return {
            pass: false,
            note: "No valid DSR ?997 color-scheme response",
            response: reply.raw,
            observation: {
              outcome: "inconclusive",
              evidence: "query",
              reason: reply.raw.includes("\x1b[?997;")
                ? "invalid-reply"
                : reply.reason === "timeout"
                  ? "timeout"
                  : "no-response",
            },
          }
        }
        return {
          pass: true,
          note: match[1] === "1" ? "dark" : "light",
          response: match[0],
          observation: {
            outcome: "supported",
            evidence: "query",
            note: "Current scheme queried; unsolicited change events were not tested",
          },
          assertions: [
            { kind: "positive", expected: "DSR ?996 yields complete DSR ?997;1n or ?997;2n", observed: match[0] },
          ],
        }
      },
      "query",
    ),
    termWrites: "query",

    termlessObservationEvidence: "query",
  },

  // XTWINOPS 14 — report window size in pixels: CSI 14 t → CSI 4 ; H ; W t
  deviceQuery({
    id: "device.xtwinops-14",
    query: "\x1b[14t",
    valid: /\x1b\[4;[1-9][0-9]*;[1-9][0-9]*t/,
    malformed: /\x1b\[4;/,
    expected: "CSI 14 t returns a complete CSI 4;positive-height;positive-width t frame",
  }),

  // XTWINOPS 16 — report cell size in pixels: CSI 16 t → CSI 6 ; H ; W t
  deviceQuery({
    id: "device.xtwinops-16",
    query: "\x1b[16t",
    valid: /\x1b\[6;[1-9][0-9]*;[1-9][0-9]*t/,
    malformed: /\x1b\[6;/,
    expected: "CSI 16 t returns a complete CSI 6;positive-height;positive-width t frame",
  }),

  // XTWINOPS 18 — report text area size in chars: CSI 18 t → CSI 8 ; rows ; cols t
  deviceQuery({
    id: "device.xtwinops-18",
    query: "\x1b[18t",
    valid: /\x1b\[8;[1-9][0-9]*;[1-9][0-9]*t/,
    malformed: /\x1b\[8;/,
    expected: "CSI 18 t returns a complete CSI 8;positive-rows;positive-columns t frame",
  }),

  // XTWINOPS 20 — report icon label: CSI 20 t → OSC L label ST
  // Set icon label via OSC 1, then query with CSI 20 t and verify response.
  {
    ...probe(
      "device.xtwinops-20",
      (ctx) => {
        ctx.feed("\x1b]1;test-icon\x07")
        const raw = ctx.feedCapture(iconLabelReply.query)
        return deviceReplyResult(iconLabelReply, raw, answerPattern(iconLabelReply).exec(raw)?.[0] ?? null, "sentinel")
      },
      async (ctx) => {
        ctx.write("\x1b]1;test-icon\x07")
        const reply = await ctx.queryWithSentinelOutcome(iconLabelReply.query, answerPattern(iconLabelReply))
        return deviceReplyResult(
          iconLabelReply,
          reply.raw,
          reply.reason === "reply" ? (reply.match?.[0] ?? null) : null,
          reply.reason,
        )
      },
    ),
    termlessObservationEvidence: "query",
  },

  // XTWINOPS 21 — report window title: CSI 21 t → OSC l title ST
  // Set a known title via OSC 2, then query to verify it's reported back.
  {
    ...probe(
      "device.xtwinops-21",
      (ctx) => {
        ctx.feed("\x1b]2;test-title\x07")
        const raw = ctx.feedCapture(windowTitleReply.query)
        return deviceReplyResult(windowTitleReply, raw, windowTitleReply.valid.exec(raw)?.[0] ?? null, "sentinel")
      },
      async (ctx) => {
        ctx.write("\x1b]2;test-title\x07")
        const reply = await ctx.queryWithSentinelOutcome(windowTitleReply.query, windowTitleReply.valid)
        return deviceReplyResult(
          windowTitleReply,
          reply.raw,
          reply.reason === "reply" ? (reply.match?.[0] ?? null) : null,
          reply.reason,
        )
      },
    ),
    termlessObservationEvidence: "query",
  },

  // XTWINOPS 22 — push title/icon stack: CSI 22 ; 0 t
  // A successful push/pop round trip establishes both operations; failure cannot identify either.
  {
    ...probe(
      "device.xtwinops-22",
      (ctx) => {
        ctx.feed("\x1b]2;pushed-title\x07")
        const original = ctx.getTitle()
        ctx.feed("\x1b[22;0t") // push
        ctx.feed("\x1b]2;new-title\x07") // overwrite
        const changed = ctx.getTitle()
        ctx.feed("\x1b[23;0t")
        const restored = ctx.getTitle()
        return parserStateResult(
          original === "pushed-title" && changed === "new-title" && restored === "pushed-title" ? true : null,
          "XTWINOPS 22 preserves the old title on its stack after a different title is set",
          { original, changed, restored },
          original !== "pushed-title" || changed !== "new-title"
            ? "Title setup was not observable"
            : restored !== "pushed-title"
              ? "Title push/pop did not restore the old title; the failing operation is unknown"
              : undefined,
        )
      },
      async (ctx) => {
        ctx.write("\x1b]2;pushed-title\x07")
        ctx.write("\x1b[22;0t") // push
        ctx.write("\x1b]2;new-title\x07") // overwrite
        const pos = await ctx.queryCursorPosition()
        return {
          pass: false,
          note: pos
            ? "Cursor answered after title push; title stack was not measured"
            : "No DSR response after title push",
          observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "consumed" },
        }
      },
    ),
    termlessObservationEvidence: "parser-state",
  },

  // XTWINOPS 23 — pop title/icon stack: CSI 23 ; 0 t (no response, partial)
  {
    ...probe(
      "device.xtwinops-23",
      (ctx) => {
        ctx.feed("\x1b]2;pushed-title\x07")
        const original = ctx.getTitle()
        ctx.feed("\x1b[22;0t")
        ctx.feed("\x1b]2;new-title\x07")
        const changed = ctx.getTitle()
        ctx.feed("\x1b[23;0t")
        const restored = ctx.getTitle()
        return parserStateResult(
          original === "pushed-title" && changed === "new-title" && restored === "pushed-title" ? true : null,
          "XTWINOPS 23 restores the title saved before a different title was set",
          { original, changed, restored },
          original !== "pushed-title" || changed !== "new-title"
            ? "Title setup was not observable"
            : restored !== "pushed-title"
              ? "Title push/pop did not restore the old title; the failing operation is unknown"
              : undefined,
        )
      },
      async (ctx) => {
        ctx.write("\x1b[22;0t") // push first so we have something to pop
        ctx.write("\x1b[23;0t")
        const pos = await ctx.queryCursorPosition()
        return {
          pass: false,
          note: pos
            ? "Cursor answered after title pop; restored title was not measured"
            : "No DSR response after title pop",
          observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "consumed" },
        }
      },
    ),
    termlessObservationEvidence: "parser-state",
  },

  // XTREPORTCOLORS — report color/graphics capabilities: CSI # R → CSI Pm # Q
  // Added in xterm patch 400; updated in patches 401/402 (2025).
  deviceQuery({
    id: "device.xtreportcolors",
    query: "\x1b[#R",
    valid: /\x1b\[[0-9;]*#Q/,
    malformed: /\x1b\[[0-9;]*#|#Q/,
    expected: "CSI # R returns a complete CSI Pm # Q frame",
  }),

  // XTGETXRES — query xterm resource value: DCS + Q Pt ST → DCS response
  // Added in xterm; documented in patches 401/402 (2025).
  deviceQuery({
    id: "device.xtgetxres",
    // "termName" is encoded as two hex digits per character, per XTGETXRES.
    query: "\x1bP+Q7465726d4e616d65\x1b\\",
    valid: /\x1bP1\+R7465726d4e616d65=[0-9A-Fa-f]+\x1b\\/i,
    refusal: /\x1bP0\+R7465726d4e616d65\x1b\\/i,
    malformed: /\x1bP[01]\+R/,
    expected: "XTGETXRES returns a complete status-1 termName resource value",
  }),
]
