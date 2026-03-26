import type { ProbeDefinition } from "./types.ts"
import { probe } from "./helpers.ts"

export const inputProbes: ProbeDefinition[] = [
  probe(
    "input.modify-other-keys",
    (ctx) => ({ pass: ctx.capabilities.extensions.has("modifyOtherKeys") }),
    async (ctx) => {
      ctx.write("\x1b[>4;2m") // enable modifyOtherKeys mode 2
      const pos = await ctx.queryCursorPosition()
      ctx.write("\x1b[>4;0m") // disable
      return {
        pass: pos !== null,
        note: pos ? undefined : "No cursor response after enabling modifyOtherKeys",
      }
    },
  ),

  probe(
    "input.csi-u",
    (ctx) => ({ pass: ctx.capabilities.kittyKeyboard === true }),
    async (ctx) => {
      ctx.write("\x1b[>1u") // push CSI u level 1
      const pos = await ctx.queryCursorPosition()
      ctx.write("\x1b[<u") // pop
      return {
        pass: pos !== null,
        note: pos ? undefined : "No cursor response after enabling CSI u mode",
      }
    },
  ),

  probe(
    "input.pixel-mouse",
    (ctx) => {
      ctx.feed("\x1b[?1016h")
      const pass = ctx.getMode("pixelMouse") === true
      ctx.feed("\x1b[?1016l")
      return { pass }
    },
    async (ctx) => {
      ctx.write("\x1b[?1016h") // enable pixel mouse
      const pos = await ctx.queryCursorPosition()
      ctx.write("\x1b[?1016l") // disable
      return {
        pass: pos !== null,
        note: pos ? undefined : "No cursor response after enabling pixel mouse",
      }
    },
  ),

  probe(
    "input.urxvt-mouse",
    (ctx) => {
      ctx.feed("\x1b[?1015h")
      // Check if the backend recognizes this mode
      const pass = ctx.getMode("mouseTracking") === true
      ctx.feed("\x1b[?1015l")
      return { pass }
    },
    async (ctx) => {
      ctx.write("\x1b[?1015h") // enable urxvt mouse
      const pos = await ctx.queryCursorPosition()
      ctx.write("\x1b[?1015l") // disable
      return {
        pass: pos !== null,
        note: pos ? undefined : "No cursor response after enabling urxvt mouse",
      }
    },
  ),

  probe(
    "input.x10-mouse",
    (ctx) => {
      ctx.feed("\x1b[?9h")
      // Check if the backend recognizes X10 mouse mode
      const pass = ctx.getMode("mouseTracking") === true
      ctx.feed("\x1b[?9l")
      return { pass }
    },
    async (ctx) => {
      ctx.write("\x1b[?9h") // enable X10 mouse
      const pos = await ctx.queryCursorPosition()
      ctx.write("\x1b[?9l") // disable
      return {
        pass: pos !== null,
        note: pos ? undefined : "No cursor response after enabling X10 mouse",
      }
    },
  ),

  // modifyOtherKeys mode 3 — all keys send escape sequences (xterm patch 398)
  probe(
    "input.modify-other-keys-3",
    (ctx) => {
      // modifyOtherKeys 3 makes ALL keyboard input send escape sequences
      // Most headless backends don't differentiate between mode 2 and 3
      ctx.feed("\x1b[>4;3m")
      const pass = ctx.capabilities.extensions.has("modifyOtherKeys")
      ctx.feed("\x1b[>4;0m")
      return { pass, note: pass ? undefined : "modifyOtherKeys not supported" }
    },
    async (ctx) => {
      // Enable mode 3, verify terminal is responsive (it recognizes the sequence)
      ctx.write("\x1b[>4;3m")
      const pos = await ctx.queryCursorPosition()
      ctx.write("\x1b[>4;0m") // disable
      if (!pos) return { pass: false, note: "No cursor response after enabling modifyOtherKeys 3" }
      return { pass: true }
    },
  ),

  probe(
    "input.button-event-mouse",
    (ctx) => {
      ctx.feed("\x1b[?1002h")
      const pass = ctx.getMode("mouseTracking") === true
      ctx.feed("\x1b[?1002l")
      return { pass }
    },
    async (ctx) => {
      ctx.write("\x1b[?1002h") // enable button-event mouse
      const pos = await ctx.queryCursorPosition()
      ctx.write("\x1b[?1002l") // disable
      return {
        pass: pos !== null,
        note: pos ? undefined : "No cursor response after enabling button-event mouse",
      }
    },
  ),
]
