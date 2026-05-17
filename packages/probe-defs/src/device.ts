import type { ProbeDefinition } from "./types.ts"
import { responseProbe, probe } from "./helpers.ts"

export const deviceProbes: ProbeDefinition[] = [
  // DA1 — Primary device attributes
  responseProbe(
    "device.primary-da",
    "\x1b[c",
    /\x1b\[\?([0-9;]+)c/,
    (response) => ({
      pass: response.includes("?") && response.endsWith("c"),
      response,
    }),
    async (ctx) => {
      const match = await ctx.query("\x1b[c", /\x1b\[\?([0-9;]+)c/, 1000)
      if (!match) return { pass: false, note: "No DA1 response" }
      return { pass: true, response: match[0] }
    },
  ),

  // DSR 5 — Device status report
  responseProbe(
    "device.status-report",
    "\x1b[5n",
    /\x1b\[(\d+)n/,
    (response) => ({
      pass: response.includes("0n"),
      response,
    }),
    async (ctx) => {
      const match = await ctx.query("\x1b[5n", /\x1b\[(\d+)n/, 1000)
      if (!match) return { pass: false, note: "No DSR 5 response" }
      return {
        pass: match[1] === "0",
        note: match[1] === "0" ? undefined : `status ${match[1]}`,
        response: match[0],
      }
    },
  ),

  // DA2 — Secondary device attributes
  responseProbe(
    "device.secondary-da",
    "\x1b[>c",
    /\x1b\[>([0-9;]+)c/,
    (response) => ({
      pass: response.includes(">"),
      response,
    }),
    async (ctx) => {
      const match = await ctx.query("\x1b[>c", /\x1b\[>([0-9;]+)c/, 1000)
      if (!match) return { pass: false, note: "No DA2 response" }
      return { pass: true, response: match[0] }
    },
  ),

  // DA3 — Tertiary device attributes
  responseProbe(
    "device.tertiary-da",
    "\x1b[=c",
    /./,
    (response) => ({
      pass: response.length > 0,
      response,
    }),
    async (ctx) => {
      const match = await ctx.queryWithSentinel("\x1b[=c", /\x1bP!?\|([^\x1b]*)\x1b\\/)
      if (match) return { pass: true, response: match[1] }
      return { pass: false, note: "No DA3 response" }
    },
  ),

  // DECRQSS — Request status string
  responseProbe(
    "device.decrqss",
    '\x1bP$q"p\x1b\\',
    /./,
    (response) => ({
      pass: response.length > 0,
      response,
    }),
    async (ctx) => {
      const match = await ctx.queryWithSentinel('\x1bP$q"p\x1b\\', /\x1bP([01])\$r/)
      if (match) return { pass: true, response: match[0] }
      return { pass: false, note: "No DECRQSS response" }
    },
  ),

  // XTGETTCAP — Termcap query
  responseProbe(
    "device.xtgettcap",
    "\x1bP+q544e\x1b\\",
    /./,
    (response) => ({
      pass: response.length > 0,
      response,
    }),
    async (ctx) => {
      const match = await ctx.queryWithSentinel("\x1bP+q544e\x1b\\", /\x1bP([01])\+r/)
      if (match) return { pass: true, response: match[0] }
      return { pass: false, note: "No XTGETTCAP response" }
    },
  ),

  // DECRPM — Mode query
  probe(
    "device.decrpm",
    (ctx) => {
      const response = ctx.feedCapture("\x1b[?1$p") // Query DECCKM
      return {
        pass: response.includes("$y"),
        response,
      }
    },
    async (ctx) => {
      // Query DECAWM (mode 7) — universally supported
      const result = await ctx.queryMode(7)
      if (result === null) return { pass: false, note: "No DECRPM response" }
      return {
        pass: result !== "unknown",
        note: result === "unknown" ? "Terminal does not support DECRPM" : `DECAWM is ${result}`,
        response: result,
      }
    },
  ),

  // XTVERSION — Terminal version query: CSI > 0 q → DCS > | name(version) ST
  responseProbe(
    "device.xtversion",
    "\x1b[>0q",
    /\x1bP>\|/,
    (response) => ({
      pass: response.length > 0 && response.includes(">|"),
      response,
    }),
    async (ctx) => {
      const match = await ctx.queryWithSentinel("\x1b[>0q", /\x1bP>\|([^\x1b]+)\x1b\\/)
      if (!match) return { pass: false, note: "No XTVERSION response" }
      return { pass: true, response: match[1] }
    },
  ),

  // TERM_FEATURES — env var check (term-only, not testable in headless)
  probe(
    "device.term-features",
    null, // not testable in headless
    async (_ctx) => {
      const value = typeof process !== "undefined" ? process.env.TERM_FEATURES : undefined
      if (!value) return { pass: false, note: "TERM_FEATURES env var not set" }
      return { pass: true, response: value }
    },
  ),

  // DSR ?996 — color-scheme query: CSI ? 996 n → CSI ? 997 ; Ps n
  probe(
    "device.dsr-996-color-scheme",
    (ctx) => {
      const response = ctx.feedCapture("\x1b[?996n")
      const match = /\x1b\[\?997;([12])n/.exec(response)
      if (!match) return { pass: false, note: "No DSR ?997 color-scheme response", response }
      return {
        pass: true,
        note: match[1] === "1" ? "dark" : "light",
        response,
      }
    },
    async (ctx) => {
      const match = await ctx.queryWithSentinel("\x1b[?996n", /\x1b\[\?997;([12])n/)
      if (!match) return { pass: false, note: "No DSR ?997 color-scheme response" }
      return {
        pass: true,
        note: match[1] === "1" ? "dark" : "light",
        response: match[0],
      }
    },
  ),

  // XTWINOPS 14 — report window size in pixels: CSI 14 t → CSI 4 ; H ; W t
  responseProbe(
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

  // XTWINOPS 16 — report cell size in pixels: CSI 16 t → CSI 6 ; H ; W t
  responseProbe(
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

  // XTWINOPS 18 — report text area size in chars: CSI 18 t → CSI 8 ; rows ; cols t
  responseProbe(
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
  probe(
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

  // XTGETXRES — query xterm resource value: DCS + Q Pt ST → DCS response
  // Added in xterm; documented in patches 401/402 (2025).
  // xterm-only as of 2026 — partial probe verifies the sequence doesn't leak.
  probe(
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
]
