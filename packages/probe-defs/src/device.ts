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
]
