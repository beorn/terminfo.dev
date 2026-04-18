---
outline: [2, 3]
prev: false
next: false
---

# Color Detection

<p class="page-tagline">NO_COLOR, COLORTERM, OSC probes — how applications figure out what color to emit</p>

<div class="beginner-intro">
<p>Before emitting its first colored byte, a TUI must decide: is this terminal truecolor, 256-color, ANSI 16, or monochrome? Should I use color at all? Applications answer these with a stack of detection signals — environment variables, terminal queries, and explicit opt-outs. Getting the stack right is the difference between "looks great in every terminal" and "spews mojibake on SSH."</p>
</div>

## The detection stack

Modern applications consult signals in this order (highest priority first):

1. **Explicit app flags** — `--no-color`, `--color-tier=<tier>`, app-specific `SILVERY_COLOR`, `CLICOLOR_FORCE`
2. **`NO_COLOR`** (any value) → disable color entirely ([no-color.org](https://no-color.org))
3. **`TERM=dumb`** → disable color entirely
4. **Not a TTY** (`!isatty(stdout)`) → disable color (pipe-safe)
5. **`COLORTERM=truecolor` or `=24bit`** → enable truecolor
6. **`TERM=*-direct`** → truecolor (less common convention)
7. **`TERM=*-256color`** → 256-color
8. **`TERM` contains `xterm` / `screen` / `tmux` / `rxvt`** → ANSI 16
9. **Fallback** → ANSI 16 (or mono if in doubt)

This is a heuristic stack. Lower tiers are safer defaults; higher tiers require explicit signals.

## `NO_COLOR` — the universal opt-out

The [no-color.org](https://no-color.org) standard: if `NO_COLOR` is set to any non-empty value, applications MUST NOT add color to their output. This is an accessibility + user-preference feature, not a capability question. Honor it absolutely.

```sh
NO_COLOR=1 myapp     # no color
NO_COLOR= myapp      # empty → treated as unset (color OK)
```

Implementation: check `process.env.NO_COLOR` before anything else. If set, render mono-only. Applications that attempt to "override" NO_COLOR lose user trust.

## `COLORTERM` — the truecolor flag

Set by terminal emulators that support 24-bit color. Values:

- `truecolor` — canonical
- `24bit` — older alternative

Either value signals truecolor support. Modern terminals set it automatically. If it's unset, assume at most 256-color (the `*-256color` `$TERM` heuristic is a decent backup).

## `$TERM` — the baseline claim

`$TERM` tells you how the terminal wants to be *treated*, not what it actually is. See [Terminal Detection](/fundamentals/term-detection) for the full discussion. For color purposes, the practical rules:

| `$TERM` pattern | Tier inferred |
|-----------------|---------------|
| `dumb` | mono |
| `*-direct` | truecolor |
| `*-256color` | 256-color |
| `*xterm*`, `*screen*`, `*tmux*`, `rxvt*` | ANSI 16 (fallback: assume COLORTERM for truecolor) |
| empty | mono |

Most modern terminals ship `$TERM=xterm-256color` — the broadest compatibility setting — even when they support truecolor. `COLORTERM` is the truecolor signal; `$TERM` is the baseline floor.

## OSC probing — the authoritative check

Environment variables lie. Applications that really need to know can ask the terminal directly via OSC queries:

### OSC 10/11 — foreground/background

```
\e]10;?\a           # query foreground
\e]11;?\a           # query background
```

Response: `\e]10;rgb:abcd/ef12/3456\a` (each channel is 16-bit hex in most terminals). Timing out? The terminal probably doesn't support the query — degrade gracefully. See [OSC colors](/extensions/osc-colors) for the support matrix.

### OSC 4 — ANSI slots

```
\e]4;<index>;?\a    # query ANSI slot index (0–15 portable, 16–255 for 256-color)
```

Same response shape as OSC 10/11. Slot 0–15 are the ANSI palette.

### OSC 12 — cursor color

```
\e]12;?\a           # query cursor color (background under cursor)
```

### OSC 17/19 — selection

```
\e]17;?\a           # selection background
\e]19;?\a           # selection foreground
```

Less widely supported — iTerm2, Kitty, and Terminal.app do; many others drop the query silently.

### Practical probing

- Set a short timeout (100–200ms). Terminals that don't support a query won't respond — don't block on it forever.
- Run queries in parallel when possible (fire all OSC writes, then collect responses).
- Accept partial results: missing slots fall back to formulas (e.g., `cursorText = background` is universally safe).
- Put the terminal into raw mode for the probe; restore the prior mode after.

The [@silvery/theme-detect](https://npmjs.com/package/@silvery/theme-detect) library implements a full probe + fingerprint pipeline you can drop into any TUI.

## Degradation strategy

After detection, emit at the detected tier:

- **truecolor** — full 16.7M via `\e[38;2;r;g;bm`
- **256-color** — quantize hex to the 256-color cube's nearest index, emit `\e[38;5;Nm`
- **ANSI 16** — map to named slots, emit `\e[31m` / `\e[91m` / etc. Let the user's theme decide what "red" looks like.
- **mono** — strip color, rely on SGR attrs (bold, inverse, underline) for hierarchy

Your semantic token (`$error`) resolves to different concrete outputs depending on tier, but the *token* stays the same in your component code. That's the point of the abstraction.

## See also

- [Color Fundamentals](/fundamentals/color-fundamentals) — ANSI 16 / 256 / truecolor escape sequences
- [Color Schemes](/fundamentals/color-schemes) — the 22-slot user-configurable scheme
- [Terminal Detection](/fundamentals/term-detection) — broader detection mechanisms
- [OSC color queries](/extensions/osc-colors) — per-terminal support matrix
- [silvery.dev/guide/capability-tiers](https://silvery.dev/guide/capability-tiers) — silvery's detection + degradation implementation
