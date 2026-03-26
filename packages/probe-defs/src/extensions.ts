import type { ProbeDefinition } from "./types.ts"
import { capabilityProbe, probe } from "./helpers.ts"

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
  probe(
    "extensions.kitty-keyboard",
    (ctx) => ({ pass: ctx.capabilities.kittyKeyboard === true }),
    async (ctx) => {
      const match = await ctx.queryWithSentinel("\x1b[?u", /\x1b\[\?(\d+)u/)
      if (!match) return { pass: false, note: "No kitty keyboard response" }
      return { pass: true, response: `flags=${match[1]}` }
    },
  ),

  // Kitty graphics protocol
  probe(
    "extensions.kitty-graphics",
    (ctx) => ({ pass: ctx.capabilities.kittyGraphics === true }),
    async (ctx) => {
      const payload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
      const match = await ctx.queryWithSentinel(
        `\x1b_Ga=T,f=100,s=1,v=1,t=d;${payload}\x1b\\`,
        /\x1b_G([^\x1b]*)\x1b\\/,
      )
      if (match) return { pass: true, response: match[1] }
      return { pass: false, note: "No kitty graphics acknowledgment" }
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
      if (!sizeMatch) return { pass: false, note: "No XTWINOPS 18 response (can't report size)" }
      const cols = parseInt(sizeMatch[2]!, 10)
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

  // OSC 10 — foreground color query
  probe(
    "extensions.osc10-fg-color",
    (ctx) => {
      const response = ctx.feedCapture("\x1b]10;?\x07")
      const pass = /\x1b\]10;/.test(response)
      return { pass, note: pass ? undefined : "No OSC 10 response" }
    },
    async (ctx) => {
      const match = await ctx.queryWithSentinel("\x1b]10;?\x07", /\x1b\]10;([^\x07\x1b]+)[\x07\x1b]/)
      if (!match) return { pass: false, note: "No OSC 10 response" }
      return { pass: true, response: match[1] }
    },
  ),

  // OSC 11 — background color query
  probe(
    "extensions.osc11-bg-color",
    (ctx) => {
      const response = ctx.feedCapture("\x1b]11;?\x07")
      const pass = /\x1b\]11;/.test(response)
      return { pass, note: pass ? undefined : "No OSC 11 response" }
    },
    async (ctx) => {
      const match = await ctx.queryWithSentinel("\x1b]11;?\x07", /\x1b\]11;([^\x07\x1b]+)[\x07\x1b]/)
      if (!match) return { pass: false, note: "No OSC 11 response" }
      return { pass: true, response: match[1] }
    },
  ),

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
      // Check if backend responds to OSC 66 query (not just silently consuming)
      const response = ctx.feedCapture("\x1b]66;?\x07")
      const pass = /\x1b\]66;/.test(response)
      return { pass, note: pass ? undefined : "No OSC 66 query response" }
    },
    async (ctx) => {
      // Query current text sizing state
      const match = await ctx.queryWithSentinel("\x1b]66;?\x07", /\x1b\]66;([^\x07\x1b]*)[\x07\x1b]/)
      if (match) return { pass: true, response: match[1] }
      // Fallback: try setting and verify cursor didn't move (consumed)
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]66;s=2\x07")
      const pos = await ctx.queryCursorPosition()
      ctx.write("\x1b]66;s=1\x07") // reset
      if (!pos) return { pass: false, note: "No cursor response" }
      return { pass: pos.col === 1, note: pos.col === 1 ? "Consumed (no query)" : "Not recognized" }
    },
  ),

  // OSC 5522 — advanced clipboard (Kitty protocol, MIME-aware paste events)
  probe(
    "extensions.osc5522-clipboard",
    (ctx) => {
      // OSC 5522 is the kitty clipboard protocol. Query clipboard metadata.
      const response = ctx.feedCapture("\x1b]5522;?\x07")
      if (/\x1b\]5522;/.test(response)) return { pass: true, response }
      return { pass: false, note: "No OSC 5522 response" }
    },
    async (ctx) => {
      const match = await ctx.queryWithSentinel("\x1b]5522;?\x07", /\x1b\]5522;([^\x07\x1b]*)[\x07\x1b]/)
      if (match) return { pass: true, response: match[1] }
      return { pass: false, note: "No OSC 5522 response" }
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
      if (!match) return { pass: false, note: "No DA1 response" }
      const attrs = match[1]!.split(";")
      const pass = attrs.includes("4")
      return { pass, note: pass ? `DA1 attrs: ${match[1]}` : `DA1 attrs: ${match[1]} (no sixel)` }
    },
  ),
]
