---
outline: [2, 3]
prev: false
next: false
---

<script setup>
import { ref, computed } from 'vue'
import { data } from './data/probes.data'

// Load standards data at build time via VitePress data loader
// Standards metadata is already embedded in probe data via featureDescriptions tags

// Count features per standard tag
const standardOrder = [
  'ecma-48', 'vt100', 'vt220', 'sixel', 'vt510', 'dec-private-modes',
  'unicode', 'xterm-extensions', 'osc', 'kitty-extensions'
]

const standardsMeta = {
  'ecma-48': {
    label: 'ECMA-48 Standard',
    year: '1976',
    specUrl: 'https://ecma-international.org/publications-and-standards/standards/ecma-48/',
    tagline: 'The grammar that started everything',
  },
  'vt100': {
    label: 'VT100',
    year: '1978',
    specUrl: 'https://vt100.net/docs/vt100-ug/',
    tagline: 'The terminal that won',
  },
  'vt220': {
    label: 'VT220',
    year: '1983',
    specUrl: 'https://vt100.net/docs/vt220-rm/contents.html',
    tagline: 'Editing operations arrive',
  },
  'vt510': {
    label: 'VT510',
    year: '1993',
    specUrl: 'https://vt100.net/docs/vt510-rm/contents.html',
    tagline: "DEC's late VT reference",
  },
  'dec-private-modes': {
    label: 'DEC Private Modes',
    year: '1978+',
    specUrl: 'https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h3-Functions-using-CSI-_-ordered-by-the-final-character_s_',
    tagline: 'The negotiation protocol',
  },
  'xterm-extensions': {
    label: 'Xterm Extensions',
    year: '1996+',
    specUrl: 'https://invisible-island.net/xterm/ctlseqs/ctlseqs.html',
    tagline: "Thomas Dickey's 30-year legacy",
  },
  'osc': {
    label: 'Operating System Commands (OSC)',
    year: '1976+',
    specUrl: 'https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h3-Operating-System-Commands',
    tagline: 'Out-of-band communication',
  },
  'kitty-extensions': {
    label: 'Kitty Extensions',
    year: '2017',
    specUrl: 'https://sw.kovidgoyal.net/kitty/protocol-extensions/',
    tagline: 'The modern revolution',
  },
  'sixel': {
    label: 'Sixel Graphics',
    year: '1983',
    specUrl: 'https://en.wikipedia.org/wiki/Sixel',
    tagline: 'Inline graphics, revived',
  },
  'unicode': {
    label: 'Unicode',
    year: '1991+',
    specUrl: 'https://unicode.org/reports/tr11/',
    tagline: 'The width problem',
  },
}

function countFeaturesForTag(tag) {
  let count = 0
  for (const [id, desc] of Object.entries(data.featureDescriptions)) {
    if (desc.tags?.includes(tag)) count++
  }
  return count
}

// Compute average adoption per standard across app backends
function standardAdoption(tag) {
  const featureIds = Object.entries(data.featureDescriptions)
    .filter(([, desc]) => desc.tags?.includes(tag))
    .map(([id]) => id)
  if (featureIds.length === 0) return null

  const appBackends = data.backends.filter(b => b.type === 'app')
  if (appBackends.length === 0) return null

  let totalPct = 0
  for (const b of appBackends) {
    const relevant = featureIds.filter(id => data.results[b.name]?.[id] !== undefined)
    const yes = relevant.filter(id => data.results[b.name]?.[id] === 'yes').length
    totalPct += relevant.length > 0 ? Math.round((yes / relevant.length) * 100) : 0
  }
  return Math.round(totalPct / appBackends.length)
}

// Load analysis
const analysisKey = 'standards-index'
</script>

# Terminal Standards

<p class="page-tagline">50 years of terminal protocols — from teletypes to GPU-rendered emoji</p>

<div class="beginner-intro">
<p>There is no single terminal standard — what exists is layers. Some are formal standards (ECMA-48, Unicode), others are hardware reference manuals (VT100–VT510), implementation documents (xterm ctlseqs), or protocol proposals (Kitty extensions). All shaped how terminals work, with different levels of authority. See the <a href="/glossary">glossary</a> for acronyms.</p>
</div>

## The Layers of Terminal Standards

There is no single authoritative standard for modern terminals. What exists is a stack of layers, each building on the one before it, with increasing levels of vendor-specificity and decreasing levels of formal standardization.

At the base is **ECMA-48** (1976) — the grammar. It defines how escape sequences are structured: CSI, OSC, DCS, and the parameter syntax that every terminal speaks. Above that sits **DEC's VT series** (1978–1993) — the implementations that made the grammar real. The VT100 became so dominant that "ANSI terminal" effectively means "VT100-compatible." Then comes **xterm** (1996-present) — Thomas Dickey's three-decade project that extended the VT model with truecolor, mouse tracking, and clipboard access. Finally, **modern protocols** like the Kitty keyboard protocol and inline graphics (Kitty, Sixel) push terminals beyond what the original standards ever imagined.

The messy truth: most of what developers call "ANSI escape codes" aren't ANSI at all. ANSI withdrew their terminal standard (X3.64) in 1994. What we actually use is a patchwork of ECMA-48 grammar, DEC private extensions, xterm innovations, and modern protocol proposals — held together by decades of copy-the-leader compatibility.

### Example Sequences by Standard

<div class="escape-examples">
<table>
  <thead><tr><th>Standard</th><th>Example Sequence</th><th>Effect</th></tr></thead>
  <tbody>
    <tr><td><a href="/ecma-48">ECMA-48</a></td><td><code>ESC[1m</code>Bold<code>ESC[0m</code></td><td><strong>Bold</strong> — SGR text styling</td></tr>
    <tr><td><a href="/vt100">VT100</a></td><td><code>ESC[5;10H</code></td><td>Cursor to row 5, col 10</td></tr>
    <tr><td><a href="/vt220">VT220</a></td><td><code>ESC[2P</code></td><td>Delete 2 characters at cursor</td></tr>
    <tr><td><a href="/xterm-extensions">Xterm</a></td><td><code>ESC[38;2;255;0;0m</code>Red<code>ESC[0m</code></td><td><span style="color:red">Red</span> — truecolor</td></tr>
    <tr><td><a href="/kitty-extensions">Kitty</a></td><td><code>ESC[&gt;1u</code></td><td>Unambiguous keyboard mode</td></tr>
    <tr><td><a href="/osc">OSC</a></td><td><code>ESC]8;;url\x07</code>Link<code>ESC]8;;\x07</code></td><td>Hyperlinks</td></tr>
  </tbody>
</table>
</div>

## Standards

<div class="standards-grid">
  <a v-for="tag in standardOrder" :key="tag" class="standard-card standard-card-link" :href="'/' + tag">
    <div class="standard-header">
      <span class="standard-name">{{ standardsMeta[tag]?.label }}</span>
      <span class="standard-year">{{ standardsMeta[tag]?.year }}</span>
    </div>
    <p class="standard-tagline">{{ standardsMeta[tag]?.tagline }}</p>
    <div class="standard-stats">
      <span class="standard-feature-count">{{ countFeaturesForTag(tag) }} features</span>
      <span v-if="standardAdoption(tag) !== null" class="standard-adoption">{{ standardAdoption(tag) }}% avg. adoption</span>
    </div>
  </a>
</div>

### ECMA-48 (1976) — The Grammar That Started Everything {#ecma-48}

First published by ECMA International in 1976 (5th edition 1991), ECMA-48 defines the **CSI (Control Sequence Introducer)** grammar that every escape sequence uses. The `ESC [` prefix, the parameter syntax, the SGR (Select Graphic Rendition) codes for text styling — all of it flows from this one document. It also defines cursor movement (CUP, CUU, CUD), erase operations (EL, ED), and scroll control.

Here's the irony: developers universally call these "ANSI escape codes," but the ANSI standard (X3.64) that referenced this work was **withdrawn in 1994**. The surviving standard is ECMA-48, maintained by ECMA International. ISO/IEC 6429 is the ISO equivalent. None of them have been updated since 1991 — the standard is frozen, while terminals continue extending the parameter space with vendor innovations.

<p class="standard-link"><a class="hover-link" href="/ecma-48">View ECMA-48 features &rarr;</a></p>

::: info "ANSI escape codes" aren't ANSI
ANSI published the X3.64 terminal standard in 1979, then withdrew it in 1994 in favor of the international ECMA-48 / ISO 6429. The name "ANSI escape codes" persists from 1979 — referring to a standard that no longer exists. What we actually use is ECMA-48 grammar with decades of vendor extensions.
:::

### VT100 (1978) — The Terminal That Won {#vt100}

The DEC VT100 ran on an **Intel 8080 CPU with 3KB of RAM**, yet it defined terminal computing for the next five decades. It implemented the ECMA-48 escape grammar, adding scroll regions (DECSTBM), character sets, and the private mode namespace (`CSI ?`) that terminals still use today. When software says it's "VT100-compatible," it's promising support for a specific set of behaviors that this $1,800 box established in 1978.

The VT100's dominance wasn't accidental — DEC shipped it with the rising tide of Unix, VAX/VMS, and networking. Every competitor had to emulate it. That gravity persists: every terminal emulator today is, at its core, a VT100 emulator with extensions.

<p class="standard-link"><a class="hover-link" href="/vt100">View VT100 features &rarr;</a></p>

::: tip Why is your terminal 80 columns wide?
IBM's 80-column punch card format (1928) set the width for the IBM 3270 terminal (1971), which the DEC VT100 adopted in 1978. The 24-row default comes from fitting 1,920 characters (80 x 24) into early memory architectures. Nearly 50 years later, 80x24 remains the default terminal size.
:::

::: details VT100 in action
```bash
# Scroll region: lines 2-23 scroll, line 1 stays (status bar)
printf '\e[2;23r'
# Cursor to row 5, column 10
printf '\e[5;10H'
# Save cursor position
printf '\e7'
# Restore cursor position
printf '\e8'
```
:::

### VT220 (1983) — Editing Operations Arrive {#vt220}

The VT220 added the **insert/delete operations** (ICH, DCH, IL, DL) that make full-screen terminal applications practical. Without VT220 editing sequences, programs like vim and tmux would have to redraw the entire screen for every character insertion. The VT220 also introduced 8-bit control codes, user-defined keys, and national replacement character sets.

These editing sequences are so fundamental that it's hard to imagine terminals without them — but they weren't in the VT100. The jump from VT100 to VT220 was the jump from a display terminal to an interactive editing terminal.

<p class="standard-link"><a class="hover-link" href="/vt220">View VT220 features &rarr;</a></p>

::: details VT220 editing
```bash
# Insert 3 blank characters at cursor
printf '\e[3@'
# Delete 2 characters at cursor
printf '\e[2P'
# Insert a blank line
printf '\e[L'
```
:::

### VT510 (1993) — DEC's Late VT Reference {#vt510}

The VT510 was one of DEC's later VT models; the VT520 and VT525 followed before DEC was acquired by Compaq in 1998. No modern terminal implements the full VT510 spec, but specific features like **DECTCEM** (cursor visibility) and **DECSCNM** (reverse video) became universal. The VT510 Reference Manual remains the most cited document for terminal implementors — it's the closest thing to a comprehensive reference for DEC escape sequences.

<p class="standard-link"><a class="hover-link" href="/vt510">View VT510 features &rarr;</a></p>

### DEC Private Modes (1978+) — The Negotiation Protocol {#dec-modes}

DEC private modes use the **`?` prefix** in CSI sequences to toggle terminal behaviors: `CSI ? Pm h` (DECSET) to enable, `CSI ? Pm l` (DECRST) to disable. This namespace is the primary mechanism for feature negotiation between applications and terminals. Cursor visibility (?25), auto-wrap (?7), alternate screen (?1049), mouse tracking (?1000–1006), bracketed paste (?2004), focus events (?1004) — all controlled via DEC private modes.

The "private" designation means vendor-defined: any terminal can allocate new mode numbers without conflicting with ECMA-48's standard modes. This extensibility is why DEC private modes remain the backbone of terminal feature control.

<p class="standard-link"><a class="hover-link" href="/dec-private-modes">View DEC Private Modes features &rarr;</a></p>

::: details DEC modes in action
```bash
# Enable bracketed paste (your terminal wraps pasted text in markers)
printf '\e[?2004h'
# Enable mouse tracking (clicks reported to your app)
printf '\e[?1000h'
# Switch to alternate screen (vim, htop, less do this)
printf '\e[?1049h'
# Switch back
printf '\e[?1049l'
```
:::

### Xterm Extensions (1996+) — Thomas Dickey's 30-Year Legacy {#xterm}

**One person** — Thomas Dickey — maintains xterm, ncurses, AND the terminfo database. He's been doing it since 1996. The xterm control sequences document (ctlseqs) is the single most important reference for terminal developers, documenting not just xterm's behavior but the de facto standards the rest of the ecosystem follows.

Xterm became the reference for many widely deployed extensions, including **256-color** support, the **alternate screen buffer** with cursor save, four **mouse tracking modes**, **focus reporting**, **bracketed paste**, **OSC 8 hyperlinks**, and **OSC 52 clipboard access**. Most features that developers think of as "standard" were actually xterm innovations that other terminals copied.

<p class="standard-link"><a class="hover-link" href="/xterm-extensions">View Xterm Extension features &rarr;</a></p>

::: details One person maintains the terminal stack
Thomas Dickey has single-handedly maintained xterm, ncurses, and the terminfo database since 1996 — nearly 30 years. His xterm control sequences document (ctlseqs) is the de facto specification that every terminal implementor references. Most of what developers call "standard" terminal behavior was defined by one maintainer in one text file.
:::

### OSC — Operating System Commands (1976+) {#osc}

OSC (Operating System Command) sequences use `ESC ]` for communication between applications and the terminal as an application. Unlike CSI sequences that control the display, OSC sequences talk to the host: window title (OSC 0/2), clipboard access (OSC 52), hyperlinks (OSC 8), color palette queries (OSC 4/10/11), semantic prompt markers (OSC 133), and notification (OSC 9/777).

The OSC namespace is **open-ended** — any terminal can define new number codes without conflicting with CSI-based controls. This makes it the preferred extension point for modern terminal features that don't fit the CSI model.

<p class="standard-link"><a class="hover-link" href="/osc">View OSC features &rarr;</a></p>

### Kitty Extensions (2017) — The Modern Revolution {#kitty}

Kovid Goyal's Kitty terminal introduced protocols that solve fundamental limitations of the 1978-era terminal model. The **Kitty keyboard protocol** provides unambiguous, modifier-aware key reporting — solving a problem from 1978: `Ctrl+I` and `Tab` are the same byte (0x09) in traditional terminals. With the Kitty protocol, they're distinct events, and key-up events are reportable for the first time.

The **Kitty graphics protocol** enables inline image display via chunked base64 transfer. Kitty also defined **extended underline styles** (curly, dotted, dashed) with independent underline colors. These extensions have been adopted by Ghostty, WezTerm, foot, and other modern terminals — making them the closest thing to an emerging standard for next-generation terminal features.

<p class="standard-link"><a class="hover-link" href="/kitty-extensions">View Kitty Extension features &rarr;</a></p>

::: tip Why Kitty matters
Kitty significantly advanced terminal input by documenting key-release reporting and a comprehensive keyboard protocol. Earlier efforts like xterm's modifyOtherKeys and Leonerd's CSI u/fixterms addressed parts of this problem. Kitty's keyboard and graphics protocols are now adopted by Ghostty, WezTerm, foot, and others — making them the closest thing to an emerging standard for next-generation terminals.
:::

### Sixel (1983, Revived) — Inline Graphics {#sixel}

**Sixel graphics were designed for dot-matrix printers in 1983.** The format encodes raster images as printable ASCII characters, where each character represents a 1x6 pixel column — hence "six pixels." DEC included Sixel support in the VT240 and VT340 terminals for displaying charts and diagrams.

Sixel was largely dormant for decades until modern terminals (xterm, foot, WezTerm, mlterm, contour) revived it as a way to display inline images using only standard escape sequences — no terminal-specific protocol required. The Sixel vs. Kitty graphics debate is one of the liveliest in the terminal ecosystem: Sixel is older and more widely supported; Kitty graphics is more capable and purpose-built.

<p class="standard-link"><a class="hover-link" href="/sixel">View Sixel features &rarr;</a></p>

### Unicode (1991+) — The Width Problem {#unicode}

#### Before Unicode: The Character Set Wars

Before Unicode, every language needed its own character encoding — and they were mutually incompatible:

<div class="escape-examples">
<table>
<thead><tr><th>Encoding</th><th>Region</th><th>Characters</th><th>Bytes</th></tr></thead>
<tbody>
<tr><td><strong>ASCII</strong></td><td>US/UK</td><td>128 characters (A-Z, 0-9, symbols)</td><td>7-bit</td></tr>
<tr><td><strong>ISO 8859-1</strong> (Latin-1)</td><td>Western Europe</td><td>256 characters (adds àéñü etc.)</td><td>8-bit</td></tr>
<tr><td><strong>Shift-JIS</strong></td><td>Japan</td><td>~7,000 kanji + kana</td><td>1-2 bytes</td></tr>
<tr><td><strong>GB2312</strong></td><td>China</td><td>~6,700 simplified Chinese characters</td><td>2 bytes</td></tr>
<tr><td><strong>EUC-KR</strong></td><td>Korea</td><td>~2,350 hangul syllables + hanja</td><td>1-2 bytes</td></tr>
<tr><td><strong>KOI8-R</strong></td><td>Russia</td><td>Cyrillic alphabet</td><td>8-bit</td></tr>
</tbody>
</table>
</div>

A Japanese terminal couldn't display Chinese text. A German terminal couldn't display Russian. Emails between countries garbled characters. The web was a mess of `Content-Type: text/html; charset=iso-8859-1` headers that were wrong half the time.

Unicode solved this by assigning a unique number (code point) to every character in every writing system — currently over 149,000 characters across 161 scripts. <a href="https://en.wikipedia.org/wiki/UTF-8" target="_blank" rel="noopener">UTF-8</a> encodes these code points in 1–4 bytes, is backward-compatible with ASCII, and is now the dominant encoding on the web and in terminals.

::: info The Unix connection
Unicode emerged from the same world as Unix terminals. <a href="https://en.wikipedia.org/wiki/Joe_Becker_(Unicode)" target="_blank" rel="noopener">Joe Becker</a> (Xerox), <a href="https://en.wikipedia.org/wiki/Lee_Collins_(Unicode)" target="_blank" rel="noopener">Lee Collins</a> (Apple), and <a href="https://en.wikipedia.org/wiki/Mark_Davis_(Unicode)" target="_blank" rel="noopener">Mark Davis</a> (Apple) drafted the initial proposal in 1987. UTF-8 — the encoding that made Unicode practical — was designed by <a href="https://en.wikipedia.org/wiki/Rob_Pike" target="_blank" rel="noopener">Rob Pike</a> and <a href="https://en.wikipedia.org/wiki/Ken_Thompson" target="_blank" rel="noopener">Ken Thompson</a> (creators of Unix and Plan 9) on a placemat in a New Jersey diner in 1992. It was adopted by Plan 9, then Linux, then the web. The people who built Unix also built the encoding that terminals use today.
:::

#### The Width Problem

Unicode's challenge for terminals isn't character _encoding_ — UTF-8 is universal. The challenge is **width calculation**. East Asian characters (CJK ideographs) and many emoji occupy two terminal columns ("wide" or "fullwidth"), while most Latin/Cyrillic/Arabic characters occupy one. <a href="https://unicode.org/reports/tr11/" target="_blank" rel="noopener">UAX #11</a> defines width classes, but terminals must also handle combining characters, variation selectors, zero-width joiners, and emoji sequences.

Incorrect width calculation causes cursor positioning errors, text misalignment, and broken TUI layouts. It's one of the hardest problems in terminal emulation because the Unicode Standard keeps adding new characters, and terminals, libraries, and the C `wcwidth()` function all update at different rates.

::: details The width problem in practice
This table is supposed to be aligned — but depending on your terminal and font, the columns may be off:
```
Name        │ Status │ Score
────────────┼────────┼──────
Alice       │ ✓ done │ 98%
Bob         │ ✗ fail │ 42%
田中太郎    │ ✓ done │ 95%     ← CJK: each char = 2 columns
José García │ ✓ done │ 88%     ← combining accent (é) = 1 column? 2?
👨‍💻 DevBot   │ ~ wait │ 77%     ← emoji: 2 columns? more?
```
If your terminal calculates any character's width differently from the application, the `│` separators won't line up. This is the core problem: **every terminal, every font, and every TUI library must agree on every character's width** — and they don't.
:::

#### Powerline and Prompt Art

Unicode didn't just solve the character encoding problem — it enabled a new artform: **terminal prompt customization**.

The <a href="https://github.com/powerline/powerline" target="_blank" rel="noopener"><strong>Powerline</strong></a> project (2012) pioneered the use of custom Unicode glyphs to create visually striking shell prompts with angled separators, branch indicators, and status icons. These characters live in Unicode's Private Use Area (PUA, U+E000–U+F8FF) and require patched fonts to display.

<a href="https://www.nerdfonts.com/" target="_blank" rel="noopener"><strong>Nerd Fonts</strong></a> took this further by patching popular programming fonts (<a href="https://github.com/tonsky/FiraCode" target="_blank" rel="noopener">Fira Code</a>, <a href="https://www.jetbrains.com/lp/mono/" target="_blank" rel="noopener">JetBrains Mono</a>, Hack, <a href="https://typeof.net/Iosevka/" target="_blank" rel="noopener">Iosevka</a>) with thousands of additional glyphs: file type icons, git symbols, weather icons, and more. A modern shell prompt might use:

<div class="escape-examples">
<table>
<thead><tr><th>Glyph</th><th>Unicode</th><th>Use</th></tr></thead>
<tbody>
<tr><td> (U+E0B0)</td><td>U+E0B0</td><td>Powerline right arrow separator</td></tr>
<tr><td> (U+E0B2)</td><td>U+E0B2</td><td>Powerline left arrow separator</td></tr>
<tr><td> (U+E0A0)</td><td>U+E0A0</td><td>Git branch symbol</td></tr>
<tr><td> (U+F115)</td><td>U+F115</td><td>Folder icon (Nerd Font)</td></tr>
<tr><td> (U+F0E7)</td><td>U+F0E7</td><td>Lightning bolt (command duration)</td></tr>
</tbody>
</table>
</div>

Tools like <a href="https://starship.rs/" target="_blank" rel="noopener"><strong>Starship</strong></a>, <a href="https://github.com/romkatv/powerlevel10k" target="_blank" rel="noopener"><strong>Powerlevel10k</strong></a> (Zsh), <a href="https://ohmyposh.dev/" target="_blank" rel="noopener"><strong>Oh My Posh</strong></a>, and <a href="https://github.com/IlanCosman/tide" target="_blank" rel="noopener"><strong>Tide</strong></a> (Fish) build elaborate prompts that show git status, language versions, cloud context, and execution time — all using these custom glyphs. The result is that terminal prompts have become a form of personal expression, with developers sharing screenshots of their setups and customizing every detail.

::: tip Nerd Fonts and terminal compatibility
Powerline and Nerd Font glyphs are Private Use Area characters — they're not part of the Unicode standard and won't render without the right font. If you see boxes or question marks instead of arrows and icons, you need to install a Nerd Font and configure your terminal to use it.
:::

<p class="standard-link"><a class="hover-link" href="/unicode">View Unicode features &rarr;</a></p>

---

<p class="back-link">
  <a href="/">&#8592; Back to matrix</a>
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

.beginner-intro a {
  color: inherit;
  text-decoration: none;
  font-weight: 600;
}

.beginner-intro a:hover {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
}

.page-tagline {
  font-size: 1.15em;
  color: var(--vp-c-text-2);
  margin-top: -0.5em;
  margin-bottom: 1.5em;
}

.standards-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  margin: 1.5em 0 2.5em;
}

@media (max-width: 768px) {
  .standards-grid {
    grid-template-columns: 1fr;
  }
}

.standard-card {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 16px;
  background: var(--vp-c-bg-soft);
}

.standard-card-link,
.standard-card-link:link,
.standard-card-link:visited {
  color: inherit;
  text-decoration: none !important;
  display: block;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
  cursor: pointer;
}

.standard-card-link:hover {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
}

.standard-card-link:hover .standard-name {
  color: var(--vp-c-brand-1) !important;
}

.standard-card-link:hover,
.standard-card-link:hover * {
  text-decoration: none !important;
}

.standard-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}

.standard-name {
  font-weight: 700;
  font-size: 1em;
  transition: color 0.2s ease;
}

.standard-year {
  font-size: 0.85em;
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
}

.standard-tagline {
  font-size: 0.85em;
  color: var(--vp-c-text-2);
  margin: 0 0 8px;
  line-height: 1.4;
}

.standard-stats {
  display: flex;
  gap: 12px;
  font-size: 0.8em;
}

.standard-feature-count {
  color: var(--vp-c-text-3);
  font-weight: 600;
}

.standard-adoption {
  color: var(--vp-c-text-3);
}

.standard-link {
  margin-top: 0.5em;
  font-size: 0.9em;
}

/* Hover-links: look like normal text, reveal as links on hover */
.hover-link,
.hover-link:link,
.hover-link:visited {
  color: inherit !important;
  text-decoration: none !important;
  font-weight: inherit;
}

.hover-link:hover {
  color: var(--vp-c-brand-1) !important;
  text-decoration: underline !important;
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

.escape-examples table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9em;
  margin: 1.5em 0;
}

.escape-examples th,
.escape-examples td {
  padding: 8px 12px;
  border: 1px solid var(--vp-c-divider);
  text-align: left;
}

.escape-examples th {
  background: var(--vp-c-bg-soft);
  font-weight: 600;
}

.escape-examples code {
  font-size: 0.85em;
  background: var(--vp-c-bg-soft);
  padding: 1px 4px;
  border-radius: 3px;
}

.escape-examples td:nth-child(2) {
  font-size: 1.05em;
}

.escape-examples a {
  color: inherit;
  text-decoration: none;
}

.escape-examples a:hover {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
}
</style>
