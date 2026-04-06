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
  // Headless emulators rarely store an icon label, so this is a partial probe.
  probe(
    "device.xtwinops-20",
    (ctx) => {
      const response = ctx.feedCapture("\x1b[20t")
      // Accept any non-empty response (OSC L ... ST or similar)
      if (response.length > 0) return { pass: true, response, note: "Backend produced response" }
      return { pass: false, note: "No response (icon label not stored)" }
    },
    async (ctx) => {
      const match = await ctx.queryWithSentinel("\x1b[20t", /\x1b\]L([^\x07\x1b]*)(?:\x07|\x1b\\)/, 1000)
      if (match) return { pass: true, response: match[0], note: `icon label: ${match[1]}` }
      return { pass: false, note: "No XTWINOPS 20 response (terminal may refuse for security)" }
    },
  ),

  // XTWINOPS 21 — report window title: CSI 21 t → OSC l title ST
  // Many terminals refuse for security; partial probe.
  probe(
    "device.xtwinops-21",
    (ctx) => {
      const response = ctx.feedCapture("\x1b[21t")
      if (response.length > 0) return { pass: true, response, note: "Backend produced response" }
      return { pass: false, note: "No response (title not stored)" }
    },
    async (ctx) => {
      const match = await ctx.queryWithSentinel("\x1b[21t", /\x1b\]l([^\x07\x1b]*)(?:\x07|\x1b\\)/, 1000)
      if (match) return { pass: true, response: match[0], note: `title: ${match[1]}` }
      return { pass: false, note: "No XTWINOPS 21 response (terminal may refuse for security)" }
    },
  ),

  // XTWINOPS 22 — push title/icon stack: CSI 22 ; 0 t (no response, partial)
  probe(
    "device.xtwinops-22",
    (ctx) => {
      // Capture any output during the push (should be empty), then verify the
      // terminal still responds to a follow-up query.
      ctx.feedCapture("\x1b[22;0t")
      const probeResponse = ctx.feedCapture("\x1b[c")
      return {
        pass: /\x1b\[\?[0-9;]+c/.test(probeResponse),
        note: /\x1b\[\?[0-9;]+c/.test(probeResponse)
          ? "Sequence consumed; terminal responsive"
          : "Terminal unresponsive after push",
      }
    },
    async (ctx) => {
      ctx.write("\x1b[22;0t")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No DSR response after push" }
      return { pass: true, note: "Sequence consumed; terminal responsive" }
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
]
