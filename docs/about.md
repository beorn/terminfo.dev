# About Terminfo.dev

## The Problem

If you build an app that runs in a terminal — a CLI tool, a text editor, a dashboard — you need to know what your users' terminals can actually do. Can they display colors? Do they support clickable links? Will emoji render correctly?

Today, there's no reliable way to answer these questions. The traditional `terminfo` database is decades old and has no entries for modern features like keyboard protocols, graphics, or hyperlinks. Most terminals just report themselves as "xterm-256color" regardless of what they actually support.

**terminfo.dev fills this gap.** It's a feature compatibility database — like [caniuse.com](https://caniuse.com) but for terminal emulators instead of web browsers. Every result comes from automated testing: we send real escape sequences to real terminals and record what happens.

## Why not terminfo?

The site is named terminfo.dev, but it works differently from the traditional terminfo database.

**[terminfo](https://invisible-island.net/ncurses/terminfo.src.html)** (maintained by [Thomas Dickey](https://invisible-island.net/) alongside ncurses) is a compiled capability database: it maps terminal names to supported features. Applications query it via `$TERM` to discover what the terminal can do. This system works well for established features — but it has fundamental limitations for modern terminal capabilities:

- **No vocabulary for modern features.** terminfo has no capability entries for Kitty keyboard protocol, OSC 8 hyperlinks, semantic prompts (OSC 133), synchronized output, or Sixel/Kitty graphics. These features are invisible to terminfo-based applications.
- **Static, not observed.** terminfo entries describe what a terminal _should_ support, not what it _actually does_. Bugs, version differences, and configuration changes aren't captured.
- **`$TERM` is unreliable.** Most terminals set `$TERM` to `xterm-256color` regardless of their actual capabilities, because too many applications string-match on "xterm."

terminfo.dev takes a different approach: **probe the terminal directly** and report what actually works. The feature matrix on this site reflects observed behavior, not self-reported capabilities.

## Three Data Sources

**[Terminal Applications](/)** — tested on real terminals via the `npx terminfo.dev` community CLI or automated app launch probes. Each test sends escape sequences to the actual terminal and verifies behavior via cursor position reports, device attribute queries, and rendered width measurements. These results reflect what users actually experience. Currently 8 terminal apps tested: Ghostty, iTerm2, Kitty, Terminal.app, Warp, VS Code, Cursor, and cmux.

**[Headless Backends](/backends)** — tested via [Termless](https://termless.dev) against headless terminal emulator libraries. These test parser correctness — whether the library correctly parses and stores the escape sequence. A headless pass means "the parser accepts this" not "this renders correctly." Some features (like blink, cursor shape) may parse correctly but are not exposed through the library's API. Currently 7 headless backends tested (some with multiple versions).

**[Multiplexer Pass-Through](/multiplexers)** — tested by running probes through terminal multiplexers (tmux, GNU Screen) to measure which features each multiplexer correctly relays vs. strips or mishandles. Currently tmux and GNU Screen tested.

The site shows these as separate sections: real terminal results first (the primary data source), headless backend results second (useful for parser implementors and library authors), and multiplexer results third (useful for users who run tmux or screen).

## How Data Is Collected

### 1. Community CLI Probes (crowd-sourced)

Anyone can test their actual terminal application:

```bash
npx terminfo.dev probe     # Run 148 probes against your terminal
npx terminfo.dev submit    # Run probes + submit results
```

The CLI auto-detects your terminal (Ghostty, iTerm2, Kitty, Terminal.app, WezTerm, etc.) and version, then runs behavioral probes — sending escape sequences and verifying cursor position, mode responses (DECRPM), and OSC query responses. Results are submitted as GitHub issues and integrated into the database.

This is the same crowd-sourced model used by [caniuse.com](https://caniuse.com) for browser compatibility data.

### 2. Headless Library Probes (automated)

[Termless](https://termless.dev) runs automated probes against headless terminal emulator libraries (xterm.js, Ghostty, Alacritty, vterm.js, etc.) in CI. Each probe sends an ANSI escape sequence and reads back the terminal state programmatically. Results marked **partial** (~) indicate features the real terminal supports but the headless API doesn't expose.

### 3. Multiplexer Pass-Through Probes (automated)

Multiplexer probes launch tmux or GNU Screen with a probe daemon inside, then test which features pass through the multiplexer layer correctly. This reveals which escape sequences each multiplexer strips, mishandles, or faithfully relays to the outer terminal.

### Why All Three?

Community probes test **real terminal behavior** — does the actual application handle it? Headless probes test **parser correctness** — does the terminal engine understand the sequence? Multiplexer probes test **pass-through fidelity** — does the multiplexer preserve the feature? The combination gives accurate results: community probes capture what users actually see, headless probes catch parsing bugs and help library authors verify conformance, and multiplexer probes show what breaks when tmux or screen sits in the middle.

## Headless Backends Tested

| Backend            | Engine                       | Description                                                    |
| ------------------ | ---------------------------- | -------------------------------------------------------------- |
| **xterm.js**       | @xterm/headless              | The most widely used web terminal emulator (4 versions tested) |
| **Ghostty Native** | libghostty-vt (Zig)          | Native Ghostty via Zig N-API bindings                          |
| **vt100.js**       | Pure TypeScript              | Termless's built-in zero-dependency emulator                   |
| **vterm.js**       | Pure TypeScript              | Full-featured emulator targeting 100% coverage                 |
| **WezTerm**        | wezterm-term (napi-rs)       | Broadest protocol support: sixel, semantic prompts             |
| **Alacritty**      | alacritty_terminal (napi-rs) | Rust parser with strong reflow                                 |
| **Kitty**          | kitty (C, GPL source)        | Kitty's parser built from source                               |

## Feature Categories

153 features across 13 categories:

- **SGR** — Text styling: bold, italic, underline variants (5 styles + color), colors (standard, bright, 256, truecolor), strikethrough, overline, selective resets
- **Cursor** — Positioning (CUP, CHA, CNL), visibility (DECTCEM), shape (DECSCUSR), save/restore (DECSC), position report (DSR 6)
- **Text** — Basic output, wrapping, wide characters (emoji, CJK), tabs, backspace, index (IND), next line (NEL)
- **Erase** — Line erase (EL 0/1/2), screen erase (ED 0/1/2/3), character erase (ECH)
- **Editing** — Insert/delete characters (ICH/DCH), insert/delete lines (IL/DL), repeat character (REP)
- **Modes** — Alternate screen, bracketed paste, synchronized output, mouse tracking (basic/SGR/all-motion), focus tracking, origin mode, insert/replace mode, application keypad
- **Scrollback** — Scroll buffer, scroll regions (DECSTBM), scroll up/down (SU/SD), reverse index (RI)
- **Reset** — SGR reset, full reset (RIS), soft reset (DECSTR), programmatic reset
- **Extensions** — Kitty keyboard/graphics, sixel, OSC 8 hyperlinks, clipboard (OSC 52), color queries (OSC 10/11), window title, current directory (OSC 7), semantic prompts, text reflow, truecolor
- **Character Sets** — DEC Special Graphics, UTF-8 mode
- **Device Status** — Primary device attributes (DA1), device status report (DSR)
- **Input Protocols** — Mouse tracking modes (X10, normal, button-event, urxvt, SGR, pixel), keyboard enhancement protocols (modifyOtherKeys, Kitty keyboard)
- **Unicode** — East Asian ambiguous character width, wide character wrapping, tab stops with mixed-width text

## Standards Coverage

Features are tagged by their defining standard (10 standards). Each standard page includes a link to the canonical specification:

- [ECMA-48](/ecma-48) (ISO/IEC 6429) — the CSI grammar, SGR, cursor control, erase
- [VT100](/vt100) — DEC's foundational terminal (1978)
- [VT220](/vt220) — editing operations, 8-bit controls, national character sets (1983)
- [VT510](/vt510) — a late DEC VT reference terminal (1993)
- [DEC Private Modes](/dec-private-modes) — DECSET/DECRST mode toggles
- [Xterm Extensions](/xterm-extensions) — 256/truecolor, mouse, bracketed paste
- [Kitty Extensions](/kitty-extensions) — keyboard protocol, graphics, underline styles
- [OSC](/osc) — Operating System Commands (title, clipboard, prompts)
- [Sixel](/sixel) — DEC raster graphics
- [Unicode](/unicode) — wide character handling

## Limitations

- **Default configuration only.** Results reflect each terminal's out-of-the-box behavior. User configuration (custom keybindings, enabled/disabled features, modified settings) may change what a terminal supports.
- **Specific versions, not all versions.** Probe results are from particular versions of each terminal and backend. Older or newer versions may differ. The version tested is shown alongside each result.
- **Visual features cannot be fully automated.** Some capabilities — font rendering quality, glyph width consistency, cursor blink timing, color accuracy — require visual inspection and cannot be verified purely through escape sequence responses.
- **Single-platform app probes (macOS).** Terminal application probes are currently run on macOS only. Linux and Windows results are available through the community CLI (`npx terminfo.dev submit`) but are not yet part of the automated test matrix.
- **Headless != rendered.** A headless backend passing a probe means the parser accepts and stores the sequence correctly. It does not guarantee the feature renders correctly in the corresponding terminal application.
- **Multiplexer results depend on the outer terminal.** Multiplexer pass-through probes test what the multiplexer relays, but the outer terminal must also support the feature for it to work end-to-end.

## Changelog

### March 2026

- **90+ new features** added across all categories — from 62 to 153 features tracked
- New categories: **Editing** (ICH/DCH/IL/DL), **Character Sets** (DEC Special Graphics), **Device Status** (DA1/DSR)
- **Descriptive URL slugs** with standard numbers (e.g., `/sgr/sgr-4-4-dotted-underline`)
- **xterm.js underline variants** now reported accurately (reading internal extended attributes)
- **Standard specification links** on all tag pages (ECMA-48, VT100, VT510, xterm ctlseqs, Kitty)
- **Clickable support cells** throughout the site — every checkmark links to the feature detail page
- Updated tag descriptions with precise technical details

## Acknowledgments

Terminfo.dev builds on ideas and approaches from these projects:

- **[esctest2](https://github.com/ThomasDickey/esctest2)** (Thomas Dickey, George Nachman) — VT conformance test suite. Our edge-case probes are inspired by their comprehensive test cases.
- **[ucs-detect](https://github.com/jquast/ucs-detect)** (Jeff Quast) — Unicode terminal width testing. Our emoji ZWJ, regional indicator, and variation selector probes follow their cursor-position-based width measurement approach.
- **[terminal-colorsaurus](https://github.com/bash/terminal-colorsaurus)** — Terminal color detection. Our DA1 sentinel pattern (query + DA1 fallback for faster response detection) is adapted from their approach.
- **[notcurses](https://github.com/dankamongmen/notcurses)** (Nick Black) — TUI library with terminal capability detection. Their XTGETTCAP and graphics detection approaches inform our probe design.
- **[vttest](https://invisible-island.net/vttest/)** (Per Lindberg, Thomas Dickey) — The original VT100/VT220 terminal test utility, maintained since 1986.
- **[termstandard/colors](https://github.com/termstandard/colors)** — Community-maintained TrueColor terminal support list.

All probe code is original. No code was copied from these projects.

## Ecosystem

terminfo.dev is part of a suite of terminal development tools:

- **[Termless](https://termless.dev)** — the headless testing framework that powers all probe results
- **[Silvery](https://silvery.dev)** — React TUI framework, the primary consumer of compatibility data
- **[Flexily](https://beorn.codes/flexily)** — layout engine used by Silvery
- **[Loggily](https://beorn.codes/loggily)** — structured logging used across all tools
- **[Contribute results](/contribute)** — test your terminal and add it to the database

## Built By

Created by [Bjorn Stabell](https://beorn.codes), serial entrepreneur and open-source developer. terminfo.dev grew from the need to understand which terminal features could be safely relied upon when building [Silvery](https://silvery.dev) and [km](https://github.com/beorn/km).

The data is generated by automated testing via [Termless](https://termless.dev) — no self-reported capabilities, no guesswork. Every result comes from sending real escape sequences and observing real responses.

---

Powered by [Termless](https://termless.dev) — Playwright for terminals.
