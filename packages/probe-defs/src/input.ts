import type { ProbeDefinition } from "./types.ts"
import { probe } from "./helpers.ts"

/** Mouse input probe — enable mode, check getMode (termless) or cursor response (term), disable. */
function mouseInputProbe(id: string, modeCode: number, modeName: string, label: string): ProbeDefinition {
  const enableSeq = `\x1b[?${modeCode}h`
  const disableSeq = `\x1b[?${modeCode}l`
  return probe(
    id,
    (ctx) => {
      ctx.feed(enableSeq)
      const pass = ctx.getMode(modeName) === true
      ctx.feed(disableSeq)
      return { pass }
    },
    async (ctx) => {
      ctx.write(enableSeq)
      const pos = await ctx.queryCursorPosition()
      ctx.write(disableSeq)
      return {
        pass: pos !== null,
        note: pos ? undefined : `No cursor response after enabling ${label}`,
      }
    },
  )
}

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

  mouseInputProbe("input.pixel-mouse", 1016, "pixelMouse", "pixel mouse"),
  mouseInputProbe("input.urxvt-mouse", 1015, "mouseTracking", "urxvt mouse"),
  mouseInputProbe("input.x10-mouse", 9, "mouseTracking", "X10 mouse"),

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

  mouseInputProbe("input.button-event-mouse", 1002, "mouseTracking", "button-event mouse"),
]
