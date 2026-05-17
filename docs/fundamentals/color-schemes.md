---
outline: [2, 3]
prev: false
next: false
---

# Color Schemes

<p class="page-tagline">The 22-slot user-configurable scheme every terminal exposes</p>

<div class="beginner-intro">
<p>A "color scheme" in terminal land has a precise shape: 16 ANSI slots plus foreground, background, cursor (× 2), and selection (× 2). 22 colors total. Every major emulator lets the user configure these, and nearly all expose them to applications via OSC queries. Understanding this shape is the foundation of "adopt the user's theme" TUI design.</p>
</div>

## The 22 slots

| Group        | Count | Slots                                                                                                 |
| ------------ | ----- | ----------------------------------------------------------------------------------------------------- |
| ANSI base    | 8     | black, red, green, yellow, blue, magenta, cyan, white                                                 |
| ANSI bright  | 8     | brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite |
| Default text | 2     | foreground, background                                                                                |
| Cursor       | 2     | cursorColor (bg of cursor cell), cursorText (char under cursor)                                       |
| Selection    | 2     | selectionBackground, selectionForeground                                                              |

This is the "scheme" layer — the raw hex values the terminal paints. It's theme-independent at the application level: your app doesn't know if these 22 values are "Dracula" or "Solarized Dark" — it just knows that slot 0 (black) is `#282A36` and slot 9 (brightRed) is `#FFB86C`.

## How applications use this

### Direct ANSI

The oldest pattern. Your app emits `\e[31m` (ANSI red) and the terminal paints whatever the user's "red" slot says. Zero coordination, perfect portability. The downside: you can't emphasize — "red" might be bright and vivid in one scheme, muted brown in another.

### Fixed hex (truecolor)

Emit exact colors via `\e[38;2;r;g;bm`. Total control, zero adaptation. The user's careful Solarized-Dark theme is now ignored because your status bar is `#FF5722` regardless.

### Detect + derive (modern TUI)

Query the terminal's 22 slots at startup (via OSC 10/11/4/12/17/19), then derive a theme that uses those exact colors for semantic roles. `$primary` resolves to the user's blue, `$error` to their red, `$muted` to a blend of their fg and bg. Your app looks _native_ on every terminal — like part of the terminal, not an intrusion.

This is what frameworks like [silvery](https://silvery.dev), modern [Ink](https://github.com/vadimdemedes/ink), and [Bubble Tea](https://github.com/charmbracelet/bubbletea) target. See [silvery.dev/guide/color-schemes](https://silvery.dev/guide/color-schemes) for one full implementation.

## Why 22 and not, say, 30

The count is locked by the OSC surface. Terminals expose exactly these slots via standard OSC queries:

- **OSC 10** — foreground
- **OSC 11** — background
- **OSC 12** — cursor color (background)
- **OSC 4;N** — ANSI slot N (0–15)
- **OSC 17** — selection background
- **OSC 19** — selection foreground

Nothing else is standard. `cursorText` is universally `= background` by convention (no query exists). Some terminals expose additional slots (bold color, URL color, match highlight) but those are vendor-specific and not part of the portable 22. See [OSC 10 foreground color queries](/extensions/osc-10-fg-color-query) for the per-terminal matrix.

## Cross-emulator consistency

All major terminals implement the 22-slot model. Where they differ:

- **Query support** — whether OSC 4/10/11/12/17/19 respond to `?` queries. Most do (see [terminfo.dev OSC matrix](/extensions/osc-4-color-palette)); older terminals may silently drop the query.
- **Default values** — every terminal ships a different "unless the user changes it" scheme. xterm's defaults differ from Terminal.app's, which differ from Windows Terminal's.
- **User-configurable scope** — some let users tweak slots live via menus; others require config-file edits and a restart.

What's consistent: the _shape_. Every emulator has 22 slots. Every emulator lets users configure them. Applications that target the shape (not specific values) are portable.

## The scheme vs. the theme

Two related-but-distinct ideas:

- **Scheme** — the 22-slot data. What the terminal exposes. Low-level.
- **Theme** — an application's semantic tokens (`$primary`, `$muted`, `$error`, `$border`, …) derived from a scheme. High-level.

The same scheme can drive many themes (one framework's `$primary` may be mapped to scheme's `brightBlue`; another's may be mapped to `primary`/`cursorColor`). Derivation rules are per-framework; the scheme is shared.

## See also

- [Color Fundamentals](/fundamentals/color-fundamentals) — ANSI 16 / 256 / truecolor basics
- [Color Detection](/fundamentals/color-detection) — probing the user's scheme
- [OSC palette queries](/extensions/osc-4-color-palette) — per-terminal OSC 4 support
- [OSC colors](/extensions/osc-10-fg-color-query) — per-terminal OSC 10/11/12 support
