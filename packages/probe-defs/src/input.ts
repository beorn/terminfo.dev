import type { ProbeDefinition } from "./types.ts"
import { probe } from "./helpers.ts"

export const inputProbes: ProbeDefinition[] = [
  probe(
    "input.modify-other-keys",
    (ctx) => {
      ctx.feed("\x1b[>4;1m")
      ctx.feed("\x1b[>4;2m")
      return { pass: true }
    },
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
    (ctx) => {
      ctx.feed("\x1b[97u") // 'a' in CSI u encoding
      return { pass: true }
    },
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
      return { pass: true }
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
      return { pass: true }
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
      return { pass: true }
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

  probe(
    "input.button-event-mouse",
    (ctx) => {
      ctx.feed("\x1b[?1002h")
      return { pass: true }
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
