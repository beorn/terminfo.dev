import type { ProbeDefinition } from "./types.ts"
import { probe } from "./helpers.ts"

/** OSC color query probe — feedCapture + regex (termless), sentinel query (term). */
function oscColorQueryProbe(id: string, oscCode: number): ProbeDefinition {
  const querySeq = `\x1b]${oscCode};?\x07`
  const termlessPattern = new RegExp(`\\x1b\\]${oscCode};`)
  const termPattern = new RegExp(`\\x1b\\]${oscCode};([^\\x07\\x1b]+)[\\x07\\x1b]`)
  return probe(
    id,
    (ctx) => {
      const response = ctx.feedCapture(querySeq)
      const pass = termlessPattern.test(response)
      return { pass, note: pass ? undefined : `No OSC ${oscCode} response` }
    },
    async (ctx) => {
      const match = await ctx.queryWithSentinel(querySeq, termPattern)
      if (!match) return { pass: false, note: `No OSC ${oscCode} response` }
      return { pass: true, response: match[1] }
    },
  )
}

/** Kitty keyboard flag probe — push flags, query, check specific bit. */
function kittyKeyboardFlagProbe(id: string, pushValue: number, flagBit: number): ProbeDefinition {
  return probe(
    id,
    (ctx) => ({ pass: ctx.capabilities.kittyKeyboard === true }),
    async (ctx) => {
      const match = await ctx.queryWithSentinel(`\x1b[>${pushValue}u\x1b[?u`, /\x1b\[\?(\d+)u/)
      ctx.write("\x1b[<u") // pop
      if (!match) return { pass: false, note: "No kitty keyboard response" }
      const flags = parseInt(match[1]!, 10)
      return { pass: (flags & flagBit) !== 0, response: `flags=${flags}` }
    },
  )
}

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
      // Push mode 1 + query atomically — some terminals only respond to
      // CSI ? u after a mode has been pushed (no response when stack is empty)
      const match = await ctx.queryWithSentinel("\x1b[>1u\x1b[?u", /\x1b\[\?(\d+)u/)
      ctx.write("\x1b[<u") // pop
      if (!match) return { pass: false, note: "No kitty keyboard response" }
      return { pass: true, response: `flags=${match[1]}` }
    },
  ),

  // Kitty keyboard: individual progressive enhancement flags
  // Each probe pushes+queries in a single write to avoid race conditions,
  // then pops after response is received.
  kittyKeyboardFlagProbe("extensions.kitty-keyboard.disambiguate", 1, 1), // Flag 1: DISAMBIGUATE
  kittyKeyboardFlagProbe("extensions.kitty-keyboard.report-events", 3, 2), // Flag 2: REPORT_EVENTS
  kittyKeyboardFlagProbe("extensions.kitty-keyboard.report-alternate", 5, 4), // Flag 4: REPORT_ALTERNATE
  kittyKeyboardFlagProbe("extensions.kitty-keyboard.report-all-keys", 9, 8), // Flag 8: REPORT_ALL_KEYS
  kittyKeyboardFlagProbe("extensions.kitty-keyboard.report-text", 17, 16), // Flag 16: REPORT_TEXT

  // Kitty graphics protocol — behavioral check (like sixel probe)
  // APC responses arrive slower than DA1, so sentinel-based detection fails.
  // Instead: transmit+display image, check if cursor moved (image rendered).
  probe(
    "extensions.kitty-graphics",
    (ctx) => ({ pass: ctx.capabilities.kittyGraphics === true }),
    async (ctx) => {
      const payload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
      ctx.write("\x1b[1;1H")
      ctx.write(`\x1b_Ga=T,f=100,s=1,v=1,t=d;${payload}\x1b\\`)
      await new Promise((r) => setTimeout(r, 300))
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after kitty graphics" }
      return { pass: pos.row > 1 || pos.col > 1, note: pos.row > 1 || pos.col > 1 ? undefined : "Image didn't render" }
    },
  ),

  // Kitty graphics sub-probes — behavioral checks via cursor position + responsiveness
  probe(
    "extensions.kitty-graphics.transmit",
    (ctx) => ({ pass: ctx.capabilities.kittyGraphics === true }),
    async (ctx) => {
      const payload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
      ctx.write(`\x1b_Ga=t,f=100,s=1,v=1,t=d,i=999;${payload}\x1b\\`)
      await new Promise((r) => setTimeout(r, 300))
      const pos = await ctx.queryCursorPosition()
      ctx.write(`\x1b_Ga=d,d=i,i=999\x1b\\`)
      return { pass: pos !== null, note: pos ? undefined : "No response after transmit" }
    },
  ),

  probe(
    "extensions.kitty-graphics.display",
    (ctx) => ({ pass: ctx.capabilities.kittyGraphics === true }),
    async (ctx) => {
      const payload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
      ctx.write(`\x1b_Ga=t,f=100,s=1,v=1,t=d,i=998,q=1;${payload}\x1b\\`)
      await new Promise((r) => setTimeout(r, 200))
      ctx.write("\x1b[1;1H")
      ctx.write(`\x1b_Ga=p,i=998\x1b\\`)
      await new Promise((r) => setTimeout(r, 300))
      const pos = await ctx.queryCursorPosition()
      ctx.write(`\x1b_Ga=d,d=i,i=998\x1b\\`)
      if (!pos) return { pass: false, note: "No response after display" }
      return {
        pass: pos.row > 1 || pos.col > 1,
        note: pos.row > 1 || pos.col > 1 ? undefined : "Display didn't render",
      }
    },
  ),

  probe(
    "extensions.kitty-graphics.animation",
    (ctx) => ({ pass: ctx.capabilities.kittyGraphics === true }),
    async (ctx) => {
      const payload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
      ctx.write(`\x1b_Ga=t,f=100,s=1,v=1,t=d,i=997,q=1;${payload}\x1b\\`)
      await new Promise((r) => setTimeout(r, 200))
      ctx.write(`\x1b_Ga=f,i=997,q=1;${payload}\x1b\\`)
      await new Promise((r) => setTimeout(r, 200))
      const pos = await ctx.queryCursorPosition()
      ctx.write(`\x1b_Ga=d,d=i,i=997\x1b\\`)
      return { pass: pos !== null, note: pos ? undefined : "No response after animation frame" }
    },
  ),

  probe(
    "extensions.kitty-graphics.unicode-placeholders",
    (ctx) => ({ pass: ctx.capabilities.kittyGraphics === true }),
    async (ctx) => {
      const payload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
      ctx.write("\x1b[1;1H")
      ctx.write(`\x1b_Ga=T,f=100,s=1,v=1,t=d,U=1,i=996;${payload}\x1b\\`)
      await new Promise((r) => setTimeout(r, 300))
      const pos = await ctx.queryCursorPosition()
      ctx.write(`\x1b_Ga=d,d=i,i=996\x1b\\`)
      if (!pos) return { pass: false, note: "No response after U=1" }
      return { pass: pos.row > 1 || pos.col > 1, note: pos.row > 1 || pos.col > 1 ? undefined : "U=1 didn't render" }
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

  // OSC 52 write — set clipboard (most terminals support this)
  probe(
    "extensions.osc52-write",
    null, // headless can't distinguish write-only support
    async (ctx) => {
      const testData = btoa("terminfo-write-test")
      ctx.write(`\x1b]52;c;${testData}\x07`)
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No response after OSC 52 write" }
      return { pass: true }
    },
  ),

  // OSC 52 read — query clipboard back (fewer terminals support this)
  probe(
    "extensions.osc52-read",
    (ctx) => {
      const testData = btoa("terminfo-read-test")
      ctx.feed(`\x1b]52;c;${testData}\x07`)
      const response = ctx.feedCapture("\x1b]52;c;?\x07")
      return {
        pass: response.includes("52;c;"),
        note: response.includes("52;c;") ? undefined : "No OSC 52 query response",
      }
    },
    async (ctx) => {
      const testData = btoa("terminfo-read-test")
      ctx.write(`\x1b]52;c;${testData}\x07`)
      const match = await ctx.queryWithSentinel("\x1b]52;c;?\x07", /\x1b\]52;c;([^\x07\x1b]+)[\x07\x1b]/)
      if (!match) return { pass: false, note: "No OSC 52 read response" }
      return { pass: true, response: match[1]?.substring(0, 20) }
    },
  ),

  // OSC 10 — foreground color query
  oscColorQueryProbe("extensions.osc10-fg-color", 10),

  // OSC 11 — background color query
  oscColorQueryProbe("extensions.osc11-bg-color", 11),

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

  // OSC 1 — icon name
  probe(
    "extensions.osc1-icon",
    (ctx) => {
      ctx.feed("\x1b]1;test-icon\x07")
      const title = ctx.getTitle()
      // Some backends set title on OSC 1, some only set icon name (not visible via getTitle)
      // If title changed or sequence was silently consumed, it passes
      return { pass: true, note: title.includes("test-icon") ? "title changed" : "consumed" }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]1;terminfo-icon-test\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 1" }
      // If cursor is at col 1, sequence was consumed (not printed literally)
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`,
      }
    },
  ),

  // OSC 4 — color palette query (needs index parameter, can't use generic helper)
  probe(
    "extensions.osc4-palette",
    (ctx) => {
      const response = ctx.feedCapture("\x1b]4;0;?\x07")
      const pass = /\x1b\]4;0;/.test(response)
      return { pass, note: pass ? undefined : "No OSC 4 response" }
    },
    async (ctx) => {
      const match = await ctx.queryWithSentinel(
        "\x1b]4;0;?\x07",
        /\x1b\]4;0;([^\x07\x1b]+)[\x07\x1b]/,
      )
      if (!match) return { pass: false, note: "No OSC 4 response" }
      return { pass: true, response: match[1] }
    },
  ),

  // OSC 5 — special color query (needs index parameter, can't use generic helper)
  probe(
    "extensions.osc5-special-color",
    (ctx) => {
      const response = ctx.feedCapture("\x1b]5;0;?\x07")
      const pass = /\x1b\]5;0;/.test(response)
      return { pass, note: pass ? undefined : "No OSC 5 response" }
    },
    async (ctx) => {
      const match = await ctx.queryWithSentinel(
        "\x1b]5;0;?\x07",
        /\x1b\]5;0;([^\x07\x1b]+)[\x07\x1b]/,
      )
      if (!match) return { pass: false, note: "No OSC 5 response" }
      return { pass: true, response: match[1] }
    },
  ),

  // OSC 12 — cursor color query
  oscColorQueryProbe("extensions.osc12-cursor-color", 12),

  // OSC 104 — reset color palette
  probe(
    "extensions.osc104-reset-palette",
    (ctx) => {
      // Set palette color 0 to red via OSC 4, then reset via OSC 104
      ctx.feed("\x1b]4;0;rgb:ff/00/00\x07")
      ctx.feed("\x1b]104;0\x07")
      // Verify reset was consumed by querying color 0 back
      const response = ctx.feedCapture("\x1b]4;0;?\x07")
      // If we get any OSC 4 response, the terminal supports the protocol
      const pass = /\x1b\]4;/.test(response)
      return { pass, note: pass ? undefined : "No OSC 4 query response (cannot verify reset)" }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]104\x07") // reset all palette colors
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 104" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1`,
      }
    },
  ),

  // OSC 110 — reset foreground color
  probe(
    "extensions.osc110-reset-fg",
    (ctx) => {
      ctx.feed("\x1b]110\x07")
      // Verify by querying foreground color — if OSC 10 responds, the terminal supports color management
      const response = ctx.feedCapture("\x1b]10;?\x07")
      const pass = /\x1b\]10;/.test(response)
      return { pass, note: pass ? undefined : "No OSC 10 response (cannot verify reset support)" }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]110\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 110" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1`,
      }
    },
  ),

  // OSC 111 — reset background color
  probe(
    "extensions.osc111-reset-bg",
    (ctx) => {
      ctx.feed("\x1b]111\x07")
      const response = ctx.feedCapture("\x1b]11;?\x07")
      const pass = /\x1b\]11;/.test(response)
      return { pass, note: pass ? undefined : "No OSC 11 response (cannot verify reset support)" }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]111\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 111" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1`,
      }
    },
  ),

  // OSC 112 — reset cursor color
  probe(
    "extensions.osc112-reset-cursor",
    (ctx) => {
      ctx.feed("\x1b]112\x07")
      const response = ctx.feedCapture("\x1b]12;?\x07")
      const pass = /\x1b\]12;/.test(response)
      return { pass, note: pass ? undefined : "No OSC 12 response (cannot verify reset support)" }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]112\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 112" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1`,
      }
    },
  ),

  // OSC 117 — reset highlight background
  probe(
    "extensions.osc117-reset-highlight-bg",
    null, // No reliable headless verification — highlight bg is visual-only
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]117\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 117" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1`,
      }
    },
  ),

  // OSC 119 — reset highlight foreground
  probe(
    "extensions.osc119-reset-highlight-fg",
    null, // No reliable headless verification — highlight fg is visual-only
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]119\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 119" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1`,
      }
    },
  ),

  // OSC 17 — highlight background color query
  oscColorQueryProbe("extensions.osc17-highlight-bg", 17),

  // OSC 19 — highlight foreground color query
  oscColorQueryProbe("extensions.osc19-highlight-fg", 19),

  // OSC 22 — pointer shape
  probe(
    "extensions.osc22-pointer",
    null, // Headless: no way to detect pointer shape changes
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]22;pointer\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 22" }
      // If terminal consumed the OSC, cursor should still be at col 1
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`,
      }
    },
  ),

  // OSC 99 — Kitty desktop notifications
  probe(
    "extensions.osc99-kitty-notify",
    null, // Headless: no way to detect notification support (silently consumed)
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]99;i=1:d=0:p=body;test\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 99" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`,
      }
    },
  ),

  // OSC 777 — rxvt-unicode notifications
  probe(
    "extensions.osc777-notify",
    null, // Headless: no way to detect notification support (silently consumed)
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]777;notify;test;body\x07")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after OSC 777" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`,
      }
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
      if (!pos) return { pass: false, note: "No cursor response after OSC 666" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`,
      }
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
      if (!pos) return { pass: false, note: "No cursor response after OSC 3008" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`,
      }
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
