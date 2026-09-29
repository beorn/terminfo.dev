# About Terminfo.dev

## The Problem

If you build an app that runs in a terminal — a CLI tool, a text editor, a dashboard — you need to know what your users' terminals can actually do. Can they display colors? Do they support clickable links? Will emoji render correctly?

Terminal capabilities vary by version, configuration and environment. A protocol may be documented, recognized by a parser, or fully usable in an application; those are different claims.

**terminfo.dev is a terminal feature compatibility database.** Its current audit is adding a traceable connection between probe results, recorded evidence and reviewed corrections. The [measurement guide](/contribute#what-a-probe-can-establish) explains what each method can establish and where it stops.

## Why not terminfo?

The traditional [terminfo database](https://invisible-island.net/ncurses/man/terminfo.5.html), maintained by [Thomas Dickey](https://invisible-island.net/) alongside ncurses, describes terminal capabilities selected through names such as `$TERM`. It remains useful for applications choosing control sequences. It also supports extended capabilities; modern terminal features are not categorically impossible to describe in it.

terminfo.dev asks a complementary question: what did a specific test observe in a specific terminal version and environment? A database entry, a protocol query and a rendered result provide different evidence. None is a substitute for all the others.

## What Is Being Tested?

**[Terminal applications](/)** run the probe inside the actual application. Queries and cursor measurements observe protocol behavior; screenshots and input tests are needed for claims about rendering and interaction. An automated reply does not show everything the user sees.

**[Headless backends](/backends)** run the same feature definitions against emulator engines through [Termless](https://termless.dev). Depending on the adapter, a probe can inspect cells, attributes, cursor state or protocol replies. A headless result applies to that engine and adapter version. It does not establish that the desktop application renders or handles input correctly.

**[Multiplexers](/multiplexers)** run between an application and an outer terminal. Results depend on that whole path, including versions, configuration and passthrough settings. A failure through tmux or Screen is not automatically a failure of the outer terminal.

Controlled runs and community submissions are ways to collect these measurements. They should use the same versioned probe definitions. Older published CLI packages lag the source suite, so their coverage must be identified separately. A community submission needs identity, scope and evidence checks before it can support a published claim.

## Evidence and Corrections

The site is being audited for probes that overstate what they establish. In particular, a sequence being consumed is not proof of its effect, and no reply is not sufficient evidence of unsupported behavior. Older results without retained evidence cannot be retrospectively treated as verified.

A useful result states the measured outcome, method, terminal or engine identity, probe revision and measurement time. Reviewed corrections must retain the original evidence and explain what changed and why. The [contribution guide](/contribute#reading-results) explains the result vocabulary and how to submit a reproduction or screenshot.

Our target is complete, trustworthy measurements of the stated scope. Terminals and headless engines make different feature choices; a universal 100% support score is not the goal. Untested features, intentional exclusions and inconclusive measurements need explicit labels.

## Feature Categories

270+ features across 13 categories:

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

Features are tagged by their defining standard (13 standards). Each standard page includes a link to the canonical specification:

- [ECMA-48](/ecma-48) (ISO/IEC 6429) — the CSI grammar, SGR, cursor control, erase
- [VT100](/vt100) — DEC's foundational terminal (1978)
- [VT220](/vt220) — editing operations, 8-bit controls, national character sets (1983)
- [VT510](/vt510) — a late DEC VT reference terminal (1993)
- [DEC Private Modes](/dec-private-modes) — DECSET/DECRST mode toggles
- [Xterm Extensions](/xterm-extensions) — 256/truecolor, mouse, bracketed paste
- [Kitty Extensions](/kitty-extensions) — keyboard protocol, graphics, underline styles
- [iTerm2 Extensions](/iterm2) — inline images, shell integration
- [ConEmu Extensions](/conemu) — progress reporting (OSC 9;4)
- [VS Code Extensions](/vscode-extensions) — shell-integration sequences
- [OSC](/osc) — Operating System Commands (title, clipboard, prompts)
- [Sixel](/sixel) — DEC raster graphics
- [Unicode](/unicode) — wide character handling

## Limitations

- **Configuration matters.** Keybindings, permissions, fonts and enabled features can affect a result. Historical runs do not all record their configuration; do not assume they used defaults.
- **Specific versions, not all versions.** Probe results are from particular versions of each terminal and backend. Older or newer versions may differ. Check the terminal page and result context for the measured version.
- **Programs inside a terminal are a different target.** A terminal emulator provides the surface that ordinary terminal applications consume. Identify which layer a reproduction actually tests.
- **Visual claims need visual evidence.** Controlled screenshots, pixel checks or recordings can be automated, but protocol replies alone cannot establish glyph appearance, image placement or cursor blink timing.
- **Platform coverage is incomplete.** Current reviewed app results cover Kitty on Linux. Older macOS records remain historical; the corrected suite has not established app behavior on macOS or Windows. Headless engine results are separate from desktop-app measurements.
- **Headless evidence varies.** A cell-state assertion can prove an engine effect; a declared capability or consumed sequence cannot. Neither establishes rendering in the desktop application.
- **Multiplexer results depend on the outer terminal.** Multiplexer pass-through probes test what the multiplexer relays, but the outer terminal must also support the feature for it to work end-to-end.

## Changelog

### March 2026

- **90+ new features** added across all categories — from 62 to 153 features tracked
- New categories: **Editing** (ICH/DCH/IL/DL), **Character Sets** (DEC Special Graphics), **Device Status** (DA1/DSR)
- **Descriptive URL slugs** with standard numbers (e.g., `/sgr/4-4-dotted-underline`)
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

- **[Termless](https://termless.dev)** — the framework used for headless engine tests
- **[Silvery](https://silvery.dev)** — React TUI framework, the primary consumer of compatibility data
- **[Flexily](https://beorn.codes/flexily)** — layout engine used by Silvery
- **[Loggily](https://loggily.dev)** — structured logging used across all tools
- **[Contribute results](/contribute)** — test your terminal and add it to the database

## Built By

Created by [Bjørn Stabell](https://beorn.codes). terminfo.dev grew from the need to understand which terminal features could be safely relied upon when building [Silvery](https://silvery.dev) and other interactive terminal applications.

See [how probes work and what they can establish](/contribute#what-a-probe-can-establish) before relying on a result for an application decision.

---

Powered by [Termless](https://termless.dev) — Playwright for terminals.
