---
outline: [2, 3]
prev: false
next: false
---

# Terminal Detection

<p class="page-tagline">How applications discover what your terminal can do</p>

<div class="beginner-intro">
<p>Applications need to know terminal capabilities before using advanced features. But there's no reliable universal method. The ecosystem uses a mix of environment variables, query-response sequences, and databases — each with significant blind spots. Understanding these mechanisms explains why feature detection is hard and why terminfo.dev takes the approach it does.</p>
</div>

## The Problem

When a TUI application starts, it faces a fundamental question: what can this terminal do? Can it render truecolor? Does it support the Kitty keyboard protocol? Will OSC 8 hyperlinks work, or will they spew garbage? The application needs answers before it writes its first escape sequence, because sending an unsupported sequence can corrupt the display or confuse the user.

There is no single reliable mechanism for answering these questions. The traditional approach — reading `$TERM` and looking up capabilities in the terminfo database — was designed for a world where terminals were physical hardware with fixed feature sets. In that world, knowing you had a VT100 told you everything you needed to know. Today, terminal emulators are software that gets updated monthly, adds features via configuration, and often supports capabilities that no database tracks.

The result is a patchwork of detection methods. Applications check environment variables, query the terminal with escape sequences, consult databases, and sometimes just guess. Each method has trade-offs between reliability, coverage, and speed. Most applications use several methods together, falling back from one to the next.

## $TERM

The `$TERM` environment variable is the oldest and most widely used detection mechanism. The terminal emulator sets it before launching the shell, and it identifies the terminal type — in theory. Applications pass this value to the terminfo database to look up capabilities: does this terminal support 256 colors? Does it have an alternate screen? What sequence moves the cursor?

The problem is that almost every modern terminal sets `$TERM` to `xterm-256color`, regardless of what it actually is. Ghostty, Kitty, iTerm2, Alacritty, WezTerm — they all default to `xterm-256color`. This isn't laziness; it's self-defense. When Ghostty tried using its own `$TERM` value (`ghostty`) during its beta period, too many applications broke because they string-match on "xterm" and reject anything else. The ncurses `tput` utility, Python's `curses` module, and countless shell scripts assume `$TERM` starts with "xterm" or is in a small list of known values.

So `$TERM` tells you almost nothing about the actual terminal. It tells you "this terminal wants to be treated like xterm with 256 colors," which is a lowest-common-denominator claim. It says nothing about truecolor, nothing about Kitty keyboard protocol, nothing about synchronized output, nothing about hyperlinks. The variable that was designed to solve terminal detection has become part of the problem.

::: tip The $TERM lie — every terminal pretends to be xterm-256color
Ghostty, Kitty, iTerm2, Alacritty, WezTerm, and most other modern terminals all default to `$TERM=xterm-256color`. This means `$TERM` tells you the terminal wants basic xterm compatibility — not what it actually supports. Kitty does ship a `xterm-kitty` terminfo entry and encourages setting `$TERM=xterm-kitty`, but many remote servers don't have this entry installed, so SSH sessions break. The "just use your own TERM value" approach doesn't scale when every server needs the terminfo entry pre-installed.
:::

## $COLORTERM

`$COLORTERM` is a non-standard environment variable that indicates truecolor (24-bit color) support. When set to `truecolor` or `24bit`, it tells applications they can use full RGB colors via SGR sequences like `ESC[38;2;R;G;Bm`. Most modern terminals set this variable, and libraries like `chalk`, `colorette`, and `termcolor` check it.

The variable emerged organically — no standard body defined it. The [termstandard/colors](https://github.com/termstandard/colors) community project documented the convention and encouraged terminal emulators to adopt it. Today it's the most reliable way to detect truecolor support, simply because there was broad enough adoption to make it useful.

But `$COLORTERM` is a one-trick pony. It covers exactly one question — "does this terminal support 24-bit color?" — and nothing else. It says nothing about underline styles, cursor shapes, clipboard access, graphics protocols, keyboard protocols, or any of the other features that distinguish modern terminals from each other. And because it's not standardized, there's no equivalent convention for other capabilities. Some terminals set additional custom environment variables (Kitty sets `TERM_PROGRAM=kitty`, WezTerm sets `TERM_PROGRAM=WezTerm`), but there's no universal convention.

## terminfo/termcap

The terminfo database (and its predecessor, termcap) is the traditional solution to terminal capability detection. It's a compiled database that maps terminal names (from `$TERM`) to capability strings. When an application calls `tput colors` or uses the ncurses library, it's querying terminfo. The database contains entries for cursor movement sequences, color support, screen clearing, line insertion, and hundreds of other capabilities. It's maintained by Thomas Dickey alongside ncurses and has been the backbone of terminal application development since the 1980s.

The limitation is coverage. terminfo's vocabulary was designed for the features of DEC VT terminals and early xterm. It has capability entries for basic colors, cursor movement, line editing, and screen modes — but no entries for Kitty keyboard protocol, OSC 8 hyperlinks, synchronized output (DEC mode 2026), semantic prompts (OSC 133), Sixel graphics, Kitty graphics, styled underlines (curly, dotted, dashed), OSC 52 clipboard access, or any of the other features that define modern terminal applications. These features are invisible to terminfo.

This isn't a fixable gap. Adding new capabilities to terminfo requires defining them in the database schema, updating the ncurses source, getting the change accepted upstream, waiting for distributions to pick up the new version, and then waiting for terminal emulators to ship matching entries. That pipeline takes years per capability. Modern terminal features ship in months. The result is that the database perpetually lags behind the terminals it describes, and the most interesting capabilities — the ones that differentiate terminals from each other — are the ones terminfo can't represent.

## DA1 (Primary Device Attributes)

DA1 is an escape sequence query: the application sends `CSI c` (or `CSI 0 c`) and the terminal responds with a list of capability flags. The response format is `CSI ? Ps ; Ps ; ... c`, where each `Ps` is a numeric code indicating a supported feature class. For example, a response of `CSI ? 62 ; 1 ; 2 ; 6 ; 7 ; 8 ; 9 c` says "I'm a VT220-class terminal that supports these attribute groups."

In practice, DA1 is more useful for identifying the terminal than for detecting specific features. The response format dates back to DEC hardware, and the numeric codes map to broad categories (132-column mode, printer port, Sixel graphics, national replacement character sets) rather than individual features. Modern terminals include DA1 responses for compatibility, but the values they report are inconsistent. Some terminals report capabilities they don't actually support; others omit capabilities they do support. The "VT level" number (62 = VT220, 64 = VT420, 65 = VT520) is aspirational at best.

DA1's real value in modern detection is as a **sentinel**. Because nearly every terminal responds to DA1, applications can send an unsupported query followed by a DA1 query. If the terminal doesn't understand the first query, it ignores it — but it still responds to DA1. By checking whether the first query got a response before the DA1 response arrives, the application can infer whether the feature is supported. This "query + DA1 fallback" pattern (used by [terminal-colorsaurus](https://github.com/bash/terminal-colorsaurus) and others) is one of the more reliable runtime detection techniques.

## DECRPM (Mode Report)

DECRPM — DEC Private Mode Report — is the best general-purpose mechanism for probing individual terminal features at runtime. The application sends `CSI ? Pm $ p` (where `Pm` is a private mode number), and the terminal responds with `CSI ? Pm ; Ps $ y`, where `Ps` indicates the mode status: **1** = set, **2** = reset, **0** = not recognized.

This is powerful because many modern features are controlled via DEC private modes. Bracketed paste mode (2004), mouse tracking modes (1000/1002/1003/1006), focus tracking (1004), alternate screen (1049), synchronized output (2026), and grapheme clustering (2027) all have mode numbers. By sending a DECRPM query for each mode, an application can determine at runtime whether the terminal supports it — and it gets back a definitive answer, not a heuristic.

The limitation is that not all terminals support DECRPM itself. Older terminals and some lightweight emulators ignore the query entirely, producing no response (which the application must handle with a timeout or a DA1 sentinel). Additionally, DECRPM only covers features that are mode-toggled — it can't detect capabilities like OSC 8 hyperlinks, Kitty graphics, or styled underlines that don't have a corresponding mode number. For those features, other query mechanisms (or direct behavioral probing) are needed. Despite these limitations, DECRPM is the closest thing to a universal feature-detection API that terminals offer.

## XTVERSION

XTVERSION is a query sequence (`CSI > 0 q`) that asks the terminal to report its name and version string. The terminal responds with `DCS > | name(version) ST` — for example, `DCS > | Ghostty(1.1.0) ST` or `DCS > | tmux 3.5 ST`. This gives the application the exact identity of the terminal, which can be mapped to a known feature set.

XTVERSION was introduced by xterm and has been adopted by most major terminals: Ghostty, Kitty, iTerm2, WezTerm, foot, contour, and tmux all respond. Terminal.app and some older emulators do not. When it works, it's the most precise identification mechanism available — the application knows exactly what terminal and version it's talking to, which means it can look up capabilities in a table rather than probing each one individually.

The trade-off is that XTVERSION requires the application to maintain a mapping from terminal name+version to capabilities. This is essentially recreating a terminfo-style database, but with finer granularity (per-version rather than per-terminal-type). Libraries like [terminal-colorsaurus](https://github.com/bash/terminal-colorsaurus) and detection routines in fish shell use XTVERSION as a first pass — if the terminal identifies itself, the application can skip the slower per-feature probing. When XTVERSION fails (no response), the application falls back to DECRPM and DA1.

## Runtime Probing

Runtime probing is the approach that terminfo.dev takes — and it's the most reliable method for determining what a terminal actually supports. Instead of trusting a database entry, an environment variable, or a self-reported identity, runtime probing sends the actual escape sequence and checks whether the terminal handles it correctly.

The simplest form of runtime probing uses cursor position: the application saves the cursor position, sends an escape sequence (for example, a wide emoji character), queries the cursor position again, and checks whether the cursor moved the expected distance. If the terminal correctly handled the emoji as two columns wide, the cursor will be at the right position. If not, the application knows the terminal doesn't support that feature. More sophisticated probes use DECRPM queries, OSC response parsing, and DA1 sentinels.

This is what [Termless](https://termless.dev) does with headless backends — it instantiates a terminal emulator in-process, writes escape sequences, and reads back the terminal state programmatically. It's also what the `npx terminfo.dev` CLI does with real terminals — it sends probes over the PTY and reads the responses. The results are ground truth: not what a database says should work, not what an environment variable claims, but what the terminal actually did when presented with the sequence. This behavioral approach is why terminfo.dev can track features that terminfo has no vocabulary for.

::: info Why terminfo.dev probes directly instead of using terminfo
The terminfo database has no capability entries for most modern features — Kitty keyboard protocol, OSC 8 hyperlinks, styled underlines, synchronized output, semantic prompts, Sixel graphics, clipboard access, and dozens more are invisible to terminfo. Even for features it does track, the database reflects what a terminal *should* support based on its `$TERM` value, not what it *actually* does. Runtime probing gives ground truth: send the sequence, check the result. That's why every data point on this site comes from an actual probe, not a database lookup. See [Why not terminfo?](/about#why-not-terminfo) for the full rationale.
:::

## Comparing Detection Methods

| Method | Reliability | Coverage | Speed | Requires Response | Works Over SSH |
|--------|-------------|----------|-------|-------------------|----------------|
| **$TERM** | Low — almost everything lies | Legacy features only (via terminfo) | Instant | No | Yes |
| **$COLORTERM** | Medium — widely adopted for color | Truecolor only | Instant | No | Depends on forwarding |
| **terminfo** | Medium — accurate for what it tracks | Legacy features only | Instant (cached) | No | Yes (if entry installed) |
| **DA1** | Medium — useful as sentinel | Terminal class, not specific features | Fast (~ms) | Yes | Yes |
| **DECRPM** | High — definitive answer | Mode-toggled features only | Fast (~ms) | Yes | Yes |
| **XTVERSION** | High — exact identity | All features (via lookup table) | Fast (~ms) | Yes | May report mux instead |
| **Runtime probe** | Highest — ground truth | Any observable behavior | Slow (~100ms per probe) | Yes | Yes |

## What Developers Should Do

For maximum compatibility, use a layered detection strategy. Start with the fast, zero-round-trip checks: `$TERM` and `$COLORTERM` give you a baseline. If `$COLORTERM` is `truecolor` or `24bit`, you can safely use 24-bit RGB colors. If `$TERM` ends with `-256color`, you have 256-color support. These checks cost nothing and cover the most common questions.

For specific features, probe at runtime. Send a DECRPM query for modes you care about (synchronized output, bracketed paste, focus tracking) and check the response. If you need the terminal's identity, try XTVERSION first — if it responds, you know exactly what you're working with and can enable features accordingly. Use DA1 as a sentinel for queries that might not get a response.

Most importantly, **degrade gracefully**. Don't assume that `xterm-256color` means full xterm compatibility — it almost certainly doesn't. Don't assume that a missing DECRPM response means "not supported" — the terminal might not support DECRPM itself. Always have a fallback path: if truecolor isn't available, fall back to 256 colors; if styled underlines aren't supported, use a basic underline; if the Kitty keyboard protocol isn't available, use traditional key encoding. The terminal ecosystem is heterogeneous, and the applications that work best are the ones that adapt to whatever the terminal actually provides.

---

<p class="back-link">
  <a href="/fundamentals">&#8592; Back to Fundamentals</a>
</p>

<style>
.beginner-intro {
  background: var(--vp-c-bg-soft);
  border-radius: 8px;
  padding: 1em 1.25em;
  margin-bottom: 1.5em;
  font-size: 0.95em;
  line-height: 1.6;
}

.page-tagline {
  font-size: 1.15em;
  color: var(--vp-c-text-2);
  margin-top: -0.5em;
  margin-bottom: 1.5em;
}

.back-link {
  margin-top: 2em;
  font-size: 0.9em;
}

.back-link a {
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.back-link a:hover {
  text-decoration: underline;
}
</style>
