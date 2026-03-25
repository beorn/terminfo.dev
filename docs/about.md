# About Terminfo.dev

**Terminfo.dev** is the "caniuse.com for terminal emulators" — a feature support
matrix showing which terminal capabilities are supported by each terminal backend,
based on automated testing rather than self-reported specs.

## How Data Is Collected

Data comes from two complementary sources:

### 1. Headless Library Probes (automated)

[Termless](https://termless.dev) runs 106 automated probes against headless terminal emulator libraries (xterm.js, Ghostty, Alacritty, etc.) in CI. Each probe sends an ANSI escape sequence and reads back the terminal state programmatically. Results marked **partial** (~) indicate features the real terminal supports but the headless API doesn't expose.

### 2. Community CLI Probes (crowd-sourced)

Anyone can test their actual terminal application:

```bash
npx terminfo.dev probe     # Run 100 probes against your terminal
npx terminfo.dev submit    # Run probes + submit results
```

The CLI auto-detects your terminal (Ghostty, iTerm2, Kitty, Terminal.app, WezTerm, etc.) and version, then runs behavioral probes — sending escape sequences and verifying cursor position, mode responses (DECRPM), and OSC query responses. Results are submitted as GitHub issues and integrated into the database.

This is the same crowd-sourced model used by [caniuse.com](https://caniuse.com) for browser compatibility data.

### Why Both?

Headless probes test **parser correctness** — does the terminal engine understand the sequence? Community probes test **real terminal behavior** — does the actual application handle it? The combination gives accurate results: headless catches parsing bugs, community probes catch API gaps and real-world differences.

## Backends Tested

| Backend            | Engine                       | Description                                        |
| ------------------ | ---------------------------- | -------------------------------------------------- |
| **xterm.js**       | @xterm/headless              | The most widely used web terminal emulator         |
| **Ghostty**        | ghostty-web WASM             | Mitchell Hashimoto's GPU-accelerated terminal      |
| **Ghostty Native** | libghostty-vt (Zig)          | Native Ghostty via Zig N-API bindings              |
| **vt100**          | Pure TypeScript              | Termless's built-in zero-dependency emulator       |
| **vt100-rust**     | Rust vt100 crate (napi-rs)   | Rust VT100 parser via native bindings              |
| **WezTerm**        | wezterm-term (napi-rs)       | Broadest protocol support: sixel, semantic prompts |
| **Alacritty**      | alacritty_terminal (napi-rs) | Rust parser with strong reflow                     |
| **libvterm**       | neovim/libvterm (WASM)       | Neovim's C VT parser via Emscripten                |
| **Kitty**          | kitty (C, GPL source)        | Kitty's parser built from source                   |
| **Peekaboo**       | OS automation                | Tests against a real terminal app (macOS)          |

## Feature Categories

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

## Standards Coverage

Features are tagged by their defining standard. Each standard page includes a link to the canonical specification:

- [ECMA-48](/ecma-48) (ISO/IEC 6429) — the CSI grammar, SGR, cursor control, erase
- [VT100](/vt100) — DEC's foundational terminal (1978)
- [VT510](/vt510) — the final DEC VT terminal (1993)
- [DEC Private Modes](/dec-private-modes) — DECSET/DECRST mode toggles
- [Xterm Extensions](/xterm-extensions) — 256/truecolor, mouse, bracketed paste
- [Kitty Extensions](/kitty-extensions) — keyboard protocol, graphics, underline styles
- [OSC](/osc) — Operating System Commands (title, clipboard, prompts)
- [Sixel](/sixel) — DEC raster graphics
- [Unicode](/unicode) — wide character handling

## Changelog

### March 2026

- **45+ new features** added across all categories — from 62 to 100+ features tested
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

Powered by [Termless](https://termless.dev) — Playwright for terminals.
