---
outline: [2, 3]
prev: false
next: false
---

# Terminal Detection

<p class="page-tagline">How applications discover what your terminal can do</p>

*This page is under construction.*

Applications need to know what the terminal supports before using advanced features. The traditional approach (terminfo/TERM) is insufficient for modern capabilities. Runtime probing is the alternative.

## Detection Methods

- **$TERM**: Set by the terminal. Most terminals lie and say `xterm-256color` regardless of capabilities.
- **$COLORTERM**: Heuristic for truecolor support. `truecolor` or `24bit` if supported.
- **DA1** (Primary Device Attributes): Query the terminal for its identity. Response varies by terminal.
- **DECRPM** (Mode Report): Query whether a specific DEC private mode is supported.
- **XTVERSION**: Query the terminal's name and version string.

## Why terminfo Is Not Enough

The terminfo database maps terminal names to capabilities — but it has no vocabulary for Kitty keyboard protocol, OSC 8 hyperlinks, semantic prompts, synchronized output, or Sixel graphics. These features are invisible to terminfo-based applications.

That's why terminfo.dev probes behavior directly.
