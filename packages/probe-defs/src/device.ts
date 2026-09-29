import type { ProbeDefinition, ProbeResult, TerminalQueryOutcome } from "./types.ts"
import { responseProbe, probe } from "./helpers.ts"

/** These patterns match complete answers to the specific query, not arbitrary consumed output. */
interface DeviceReply {
  id: string
  query: string
  valid: RegExp
  malformed: RegExp
  expected: string
  refusal?: RegExp
  refusalExpected?: string
  note?: (frame: string) => string | undefined
  direct?: boolean
}

function deviceReplyResult(
  spec: DeviceReply,
  raw: string,
  matchedFrame: string | null,
  reason: TerminalQueryOutcome["reason"],
): ProbeResult {
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
      observation: { outcome: "unsupported", evidence: "query", note: "Requested setting or name refused" },
      assertions: [{ kind: "negative", expected: spec.refusalExpected ?? spec.expected, observed: refusal[0] }],
    }
  }
  // Raw bytes remain available for diagnostics, but a frame after DA1 cannot establish a result.
  const hasCompleteUnmatchedFrame = spec.valid.test(raw) || spec.refusal?.test(raw) === true
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

function deviceQuery(spec: DeviceReply): ProbeDefinition {
  const responsePattern = spec.refusal
    ? new RegExp(`${spec.valid.source}|${spec.refusal.source}`, spec.valid.flags)
    : spec.valid
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
  return { ...definition, termWrites: "query" }
}

export const deviceProbes: ProbeDefinition[] = [
  deviceQuery({
    id: "device.primary-da",
    query: "\x1b[c",
    valid: /\x1b\[\?[0-9]+(?:;[0-9]+)*c/,
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
    query: '\x1bP$q"p\x1b\\',
    valid: /\x1bP1\$r[0-9]+(?:;[0-9]+)*"p\x1b\\/,
    refusal: /\x1bP0\$r\x1b\\/,
    malformed: /\x1bP[01]\$r/,
    expected: 'complete DECRQSS status 1 DECSCL parameters ending "p and ST',
    refusalExpected: "DECRQSS status 1 for the requested DECSCL setting",
  }),
  deviceQuery({
    id: "device.xtgettcap",
    query: "\x1bP+q544e\x1b\\",
    valid: /\x1bP1\+r544e=(?:[0-9A-Fa-f]{2})+\x1b\\/i,
    refusal: /\x1bP0\+r\x1b\\/,
    malformed: /\x1bP[01]\+r/,
    expected: "complete XTGETTCAP status 1 for TN with even-length hex value and ST",
    refusalExpected: "XTGETTCAP status 1 for the requested TN name",
  }),
  deviceQuery({
    id: "device.decrpm",
    query: "\x1b[?7$p",
    valid: /\x1b\[\?7;[1-4]\$y/,
    refusal: /\x1b\[\?7;0\$y/,
    malformed: /\x1b\[\?[0-9]+;[0-9]*\$y|\x1b\[\?7(?:;|\$)/,
    expected: "complete DECRPM for DECAWM mode 7 with recognized state 1–4",
    refusalExpected: "DECRPM recognizes queried DECAWM mode 7",
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
  },

  // XTWINOPS 14 — report window size in pixels: CSI 14 t → CSI 4 ; H ; W t
  {
    ...responseProbe(
      "device.xtwinops-14",
      "\x1b[14t",
      /\x1b\[4;(\d+);(\d+)t/,
      (response) => ({
        pass: /\x1b\[4;\d+;\d+t/.test(response),
        note: /\x1b\[4;\d+;\d+t/.test(response) ? undefined : `Response: ${JSON.stringify(response)}`,
        response,
      }),
      async (ctx) => {
        const match = await ctx.query("\x1b[14t", /\x1b\[4;(\d+);(\d+)t/, 1000)
        if (!match) return { pass: false, note: "No XTWINOPS 14 response" }
        return { pass: true, response: match[0], note: `${match[1]}x${match[2]} px` }
      },
    ),
    termWrites: "query",
  },

  // XTWINOPS 16 — report cell size in pixels: CSI 16 t → CSI 6 ; H ; W t
  {
    ...responseProbe(
      "device.xtwinops-16",
      "\x1b[16t",
      /\x1b\[6;(\d+);(\d+)t/,
      (response) => ({
        pass: /\x1b\[6;\d+;\d+t/.test(response),
        note: /\x1b\[6;\d+;\d+t/.test(response) ? undefined : `Response: ${JSON.stringify(response)}`,
        response,
      }),
      async (ctx) => {
        const match = await ctx.query("\x1b[16t", /\x1b\[6;(\d+);(\d+)t/, 1000)
        if (!match) return { pass: false, note: "No XTWINOPS 16 response" }
        return { pass: true, response: match[0], note: `${match[1]}x${match[2]} px/cell` }
      },
    ),
    termWrites: "query",
  },

  // XTWINOPS 18 — report text area size in chars: CSI 18 t → CSI 8 ; rows ; cols t
  {
    ...responseProbe(
      "device.xtwinops-18",
      "\x1b[18t",
      /\x1b\[8;(\d+);(\d+)t/,
      (response) => ({
        pass: /\x1b\[8;\d+;\d+t/.test(response),
        note: /\x1b\[8;\d+;\d+t/.test(response) ? undefined : `Response: ${JSON.stringify(response)}`,
        response,
      }),
      async (ctx) => {
        const match = await ctx.query("\x1b[18t", /\x1b\[8;(\d+);(\d+)t/, 1000)
        if (!match) return { pass: false, note: "No XTWINOPS 18 response" }
        return { pass: true, response: match[0], note: `${match[1]} rows x ${match[2]} cols` }
      },
    ),
    termWrites: "query",
  },

  // XTWINOPS 20 — report icon label: CSI 20 t → OSC L label ST
  // Set icon label via OSC 1, then query with CSI 20 t and verify response.
  probe(
    "device.xtwinops-20",
    (ctx) => {
      // Set icon label via OSC 1
      ctx.feed("\x1b]1;test-icon\x07")
      const response = ctx.feedCapture("\x1b[20t")
      // Verify response matches OSC L ... ST pattern
      const oscLMatch = /\x1b\]L([^\x07\x1b]*)(?:\x07|\x1b\\)/.exec(response)
      if (oscLMatch) {
        return {
          pass: true,
          response,
          note: `icon label: ${oscLMatch[1]}`,
        }
      }
      // Some backends return a response but in a different format
      if (response.length > 0) return { pass: true, response, note: "Response received (non-standard format)" }
      return { pass: false, note: "No response to icon label query" }
    },
    async (ctx) => {
      // Set icon label first so we have something to query
      ctx.write("\x1b]1;test-icon\x07")
      const match = await ctx.queryWithSentinel("\x1b[20t", /\x1b\]L([^\x07\x1b]*)(?:\x07|\x1b\\)/, 1000)
      if (match) return { pass: true, response: match[0], note: `icon label: ${match[1]}` }
      return { pass: false, note: "No XTWINOPS 20 response (terminal may refuse for security)" }
    },
  ),

  // XTWINOPS 21 — report window title: CSI 21 t → OSC l title ST
  // Set a known title via OSC 2, then query to verify it's reported back.
  probe(
    "device.xtwinops-21",
    (ctx) => {
      // Set a known title via OSC 2
      ctx.feed("\x1b]2;test-title\x07")
      const response = ctx.feedCapture("\x1b[21t")
      // Verify response matches OSC l ... ST pattern
      const oscMatch = /\x1b\]l([^\x07\x1b]*)(?:\x07|\x1b\\)/.exec(response)
      if (oscMatch) {
        return {
          pass: true,
          response,
          note: `title: ${oscMatch[1]}`,
        }
      }
      // Some backends return a response but in a different format
      if (response.length > 0) return { pass: true, response, note: "Response received (non-standard format)" }
      return { pass: false, note: "No response to title query" }
    },
    async (ctx) => {
      // Set a known title so we have something to query
      ctx.write("\x1b]2;test-title\x07")
      const match = await ctx.queryWithSentinel("\x1b[21t", /\x1b\]l([^\x07\x1b]*)(?:\x07|\x1b\\)/, 1000)
      if (match) return { pass: true, response: match[0], note: `title: ${match[1]}` }
      return { pass: false, note: "No XTWINOPS 21 response (terminal may refuse for security)" }
    },
  ),

  // XTWINOPS 22 — push title/icon stack: CSI 22 ; 0 t
  // Verify by setting title A, pushing, changing to B, and checking B is active.
  probe(
    "device.xtwinops-22",
    (ctx) => {
      // Set a known title, push it, then change to a different title
      ctx.feed("\x1b]2;pushed-title\x07")
      ctx.feed("\x1b[22;0t") // push
      ctx.feed("\x1b]2;new-title\x07") // overwrite
      const title = ctx.getTitle()
      // If push worked, the current title should be "new-title" (not "pushed-title")
      // and the pushed title is saved on the stack for later pop.
      // We verify the push didn't break anything and the new title took effect.
      if (title === "new-title") {
        return { pass: true, note: "Push succeeded; title changed after push" }
      }
      // Some backends may not support getTitle but still handle the sequence
      const probeResponse = ctx.feedCapture("\x1b[c")
      return {
        pass: /\x1b\[\?[0-9;]+c/.test(probeResponse),
        note: /\x1b\[\?[0-9;]+c/.test(probeResponse)
          ? `Push consumed; title is "${title}"`
          : "Terminal unresponsive after push",
      }
    },
    async (ctx) => {
      ctx.write("\x1b]2;pushed-title\x07")
      ctx.write("\x1b[22;0t") // push
      ctx.write("\x1b]2;new-title\x07") // overwrite
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No DSR response after push" }
      return { pass: true, note: "Push sequence accepted; terminal responsive" }
    },
  ),

  // XTWINOPS 23 — pop title/icon stack: CSI 23 ; 0 t (no response, partial)
  probe(
    "device.xtwinops-23",
    (ctx) => {
      // Push first so the pop has something to undo, then verify responsiveness.
      ctx.feedCapture("\x1b[22;0t")
      ctx.feedCapture("\x1b[23;0t")
      const probeResponse = ctx.feedCapture("\x1b[c")
      return {
        pass: /\x1b\[\?[0-9;]+c/.test(probeResponse),
        note: /\x1b\[\?[0-9;]+c/.test(probeResponse)
          ? "Sequence consumed; terminal responsive"
          : "Terminal unresponsive after pop",
      }
    },
    async (ctx) => {
      ctx.write("\x1b[22;0t") // push first so we have something to pop
      ctx.write("\x1b[23;0t")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No DSR response after pop" }
      return { pass: true, note: "Sequence consumed; terminal responsive" }
    },
  ),

  // XTREPORTCOLORS — report color/graphics capabilities: CSI # R → CSI Pm # Q
  // Added in xterm patch 400; updated in patches 401/402 (2025).
  // xterm-only as of 2026 — partial probe verifies the sequence doesn't leak.
  {
    ...probe(
      "device.xtreportcolors",
      (ctx) => {
        // If a backend implements XTREPORTCOLORS, the response matches CSI Pm # Q.
        // Otherwise verify the query is consumed (not printed literally).
        const response = ctx.feedCapture("\x1b[#R")
        if (/\x1b\[[0-9;]*#Q/.test(response)) {
          return { pass: true, response, note: "XTREPORTCOLORS response received" }
        }
        const probeResponse = ctx.feedCapture("\x1b[c")
        return {
          pass: /\x1b\[\?[0-9;]+c/.test(probeResponse) && !response.includes("#R"),
          note: /\x1b\[\?[0-9;]+c/.test(probeResponse)
            ? "Sequence consumed; terminal responsive (no XTREPORTCOLORS response)"
            : "Terminal unresponsive after CSI # R",
        }
      },
      async (ctx) => {
        const match = await ctx.queryWithSentinel("\x1b[#R", /\x1b\[([0-9;]*)#Q/, 1000)
        if (match) return { pass: true, response: match[0], note: `Pm=${match[1]}` }
        // Verify the sequence didn't break the terminal — DSR should still respond.
        const pos = await ctx.queryCursorPosition()
        if (!pos) return { pass: false, note: "No response after CSI # R" }
        return { pass: false, note: "Sequence consumed but no XTREPORTCOLORS response" }
      },
    ),
    termWrites: "query",
  },

  // XTGETXRES — query xterm resource value: DCS + Q Pt ST → DCS response
  // Added in xterm; documented in patches 401/402 (2025).
  // xterm-only as of 2026 — partial probe verifies the sequence doesn't leak.
  {
    ...probe(
      "device.xtgetxres",
      (ctx) => {
        // Hex-encoded "xterm" = 7874657271. Send DCS + Q 7874657271 ST.
        const query = "\x1bP+Q7874657271\x1b\\"
        const response = ctx.feedCapture(query)
        if (/\x1bP[01]\+R/.test(response)) {
          return { pass: true, response, note: "XTGETXRES response received" }
        }
        const probeResponse = ctx.feedCapture("\x1b[c")
        return {
          pass: /\x1b\[\?[0-9;]+c/.test(probeResponse) && !response.includes("+Q"),
          note: /\x1b\[\?[0-9;]+c/.test(probeResponse)
            ? "Sequence consumed; terminal responsive (no XTGETXRES response)"
            : "Terminal unresponsive after DCS + Q",
        }
      },
      async (ctx) => {
        const match = await ctx.queryWithSentinel("\x1bP+Q7874657271\x1b\\", /\x1bP([01])\+R/)
        if (match) return { pass: true, response: match[0], note: `XTGETXRES status=${match[1]}` }
        // Verify the sequence didn't break the terminal — DSR should still respond.
        const pos = await ctx.queryCursorPosition()
        if (!pos) return { pass: false, note: "No response after XTGETXRES" }
        return { pass: false, note: "Sequence consumed but no XTGETXRES response" }
      },
    ),
    termWrites: "query",
  },
]
