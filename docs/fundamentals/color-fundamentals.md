---
outline: [2, 3]
prev: false
next: false
---

# Color Fundamentals

<p class="page-tagline">ANSI 16, 256-color, truecolor, and the escape sequences that carry them</p>

<div class="beginner-intro">
<p>Terminals speak color through escape sequences. Three generations of color specs coexist: ANSI 16 (1980s), 256-color indexed (1990s), and truecolor (2000s). Each adds capability without breaking the last. Understanding which terminal supports which — and how applications negotiate down when needed — is the foundation of every modern TUI.</p>
</div>

## The three color generations

### ANSI 16

The original color model from the VT100 era. Sixteen named colors — 8 base plus 8 bright variants — accessed by `SGR` codes 30–37 (fg) and 40–47 (bg), plus 90–97 and 100–107 for the bright variants. These are **named slots**, not specific RGB values. Your terminal emulator chooses what "red" actually looks like; the same ANSI "red" is crimson in Solarized Dark, peach in Gruvbox, and tomato in default xterm.

```
\e[31m red text \e[0m              # normal red
\e[91m bright red text \e[0m       # bright red
\e[1;31m bold+red text \e[0m       # bold changes color on some terminals
```

The user's color scheme maps the 16 names to actual hex values. This is what makes ANSI 16 _portable_: you write "red" and the user's theme decides whether that's vivid or muted. It's also what makes it _unreliable_ if your app needs a specific shade — the same ANSI code renders differently everywhere.

### 256-color indexed

xterm introduced a 256-color palette in the 1990s: 16 ANSI (as above) + 216 RGB cube entries (6×6×6 with 51-unit steps) + 24 grayscale steps. Accessed via `\e[38;5;<n>m` for fg and `\e[48;5;<n>m` for bg.

```
\e[38;5;196m vivid red (cube)    \e[0m   # index 196 = #FF0000
\e[38;5;244m middle gray         \e[0m   # index 244
```

The RGB cube entries (16–231) map to fixed hex values — theme-independent. This is the cheapest way to get "specific color" without requiring truecolor. Index 16–231 formula: `16 + 36*r + 6*g + b` where `r,g,b ∈ 0..5`. Grayscale 232–255: evenly-spaced grays from near-black to near-white.

Terminals almost universally support 256-color (it's 30+ years old). Whether an application _uses_ it depends on `$TERM` (`*-256color` signals support) and `COLORTERM`.

### Truecolor (24-bit)

The modern standard: full 16.7M colors via `\e[38;2;<r>;<g>;<b>m` (fg) and `\e[48;2;<r>;<g>;<b>m` (bg). Each channel is 0–255. No palette, no indirection — the terminal renders exactly the RGB you send.

```
\e[38;2;255;87;34m #FF5722 \e[0m
```

Almost every modern terminal supports truecolor (Ghostty, Kitty, iTerm2, WezTerm, Alacritty, Windows Terminal, modern xterm, GNOME Terminal). See [24-bit truecolor](/extensions/24-bit-truecolor) for the per-terminal matrix.

## SGR vs OSC — two different escape families

Color delivery uses two escape-sequence families:

- **SGR (Select Graphic Rendition)** — inline character styling. Embedded in text output. The `\e[...m` codes above are SGR. Applied per-cell as the terminal parses the stream.
- **OSC (Operating System Command)** — out-of-band terminal queries and configuration. `\e]10;?\a` asks the terminal "what's your foreground color?"; the terminal replies with `\e]10;rgb:abcd/ef12/3456\a`. OSC sets the palette, not the content.

Your app emits SGR to color its output. Your terminal emits OSC responses when probed. The color scheme lives in OSC; the colored characters flow as SGR. Confusing these is a common source of bugs — see [Terminal Detection](/fundamentals/term-detection).

## The SGR attrs that aren't colors

SGR also carries **attrs** — bold, italic, underline, inverse, dim, strikethrough. These layer _on top of_ color and are independent of it. Universally supported attrs:

| Code | Attr             | Note                                                                |
| ---- | ---------------- | ------------------------------------------------------------------- |
| `1`  | bold             | Some terminals also brighten the color                              |
| `2`  | dim              | Uneven support — alpha-blend on some, intensity-reduction on others |
| `3`  | italic           | Truly italic if the font has an italic variant; slanted otherwise   |
| `4`  | underline        | Basic single underline                                              |
| `7`  | inverse          | Swaps fg + bg                                                       |
| `9`  | strikethrough    | Newer — check [terminal matrix](/text)                              |
| `22` | normal intensity | Turns off bold/dim                                                  |
| `23` | no italic        |                                                                     |
| `24` | no underline     |                                                                     |
| `27` | no inverse       |                                                                     |

Modern terminals add curly/dotted/dashed underlines, underline colors, and more — see [curly underline](/sgr/4-3-curly-underline).

## Portability: writing TUI code that works everywhere

Applications face a choice for each colored output:

1. **ANSI 16 always** — maximum compatibility, user's theme wins, can't pin specific shades. Old-school portability.
2. **Truecolor always** — modern, exact colors, degrades badly on old terminals (color fallback or mojibake).
3. **Tier-based rendering** — detect at startup, emit the best tier the terminal supports. The right answer for 2020s TUIs.

[silvery](https://silvery.dev) and modern frameworks use approach 3: design in semantic tokens (`$primary`, `$muted`, `$error`), detect the terminal's tier on startup, and let the framework pick ANSI 16 / 256 / truecolor at render time. See [Color Detection](/fundamentals/color-detection) for the detection mechanisms.

## See also

- [Color Schemes](/fundamentals/color-schemes) — the 22-slot user-configurable scheme
- [Color Detection](/fundamentals/color-detection) — `NO_COLOR`, `COLORTERM`, OSC probes
- [Truecolor compliance](/extensions/24-bit-truecolor) — per-terminal test results
- [256-color support](/sgr/38-5-256-color-fg) — baseline-tier compatibility
