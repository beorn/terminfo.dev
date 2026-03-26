---
outline: [2, 3]
prev: false
next: false
---

<script setup>
import { ref, computed } from 'vue'
import { data } from './data/probes.data'

const categoryOrder = [
  'sgr', 'cursor', 'text', 'erase', 'editing', 'modes', 'scrollback',
  'reset', 'extensions', 'charsets', 'device', 'input', 'graphics', 'unicode'
]

const categoryLabels = data.categoryLabels ?? {}

const categoryMeta = {
  sgr: {
    icon: '🎨',
    tagline: '35 ways to style text, and terminals disagree on at least 5 of them',
  },
  cursor: {
    icon: '▮',
    tagline: '15 sequences for moving a blinking rectangle around a grid',
  },
  text: {
    icon: '📝',
    tagline: 'The fundamentals: output, wrapping, wide characters, tabs',
  },
  erase: {
    icon: '🧹',
    tagline: 'Surgical removal of characters, lines, and screens',
  },
  editing: {
    icon: '✂️',
    tagline: 'Insert and delete — the sequences that make vim possible',
  },
  modes: {
    icon: '⚙️',
    tagline: "The terminal's settings panel, controllable via escape sequences",
  },
  scrollback: {
    icon: '📜',
    tagline: 'The least standardized area of terminal emulation',
  },
  reset: {
    icon: '🔄',
    tagline: 'Returning the terminal to a known state',
  },
  extensions: {
    icon: '🚀',
    tagline: 'Where the standard ends and innovation begins',
  },
  charsets: {
    icon: '🔤',
    tagline: 'Box-drawing characters from the VT100 era',
  },
  device: {
    icon: '📡',
    tagline: 'How applications ask "who are you?" and "where am I?"',
  },
  input: {
    icon: '⌨️',
    tagline: 'Enhanced keyboard and mouse reporting beyond VT100',
  },
  graphics: {
    icon: '🖼️',
    tagline: 'Inline images: Sixel, Kitty graphics, and beyond',
  },
  unicode: {
    icon: '🌐',
    tagline: 'East Asian width, emoji, and the cursor alignment problem',
  },
}

// Get categories that actually have features in probe data
const activeCategories = computed(() => {
  return categoryOrder.filter(cat => {
    const features = data.categories[cat]
    return features && features.length > 0
  })
})

function catLabel(cat) {
  return categoryLabels[cat] ?? cat.charAt(0).toUpperCase() + cat.slice(1)
}

function featureCount(cat) {
  return (data.categories[cat] ?? []).length
}

// Find terminals with best score for a category
function topTerminals(cat, limit = 3) {
  const features = data.categories[cat] ?? []
  if (features.length === 0) return []

  const appBackends = data.backends.filter(b => b.type === 'app')
  const scores = appBackends.map(b => {
    const featureIds = features.map(f => f.id)
    const yes = featureIds.filter(id => data.results[b.name]?.[id] === 'yes').length
    return {
      name: data.meta[b.name]?.label ?? b.name,
      slug: data.meta[b.name]?.slug ?? b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      pct: Math.round((yes / featureIds.length) * 100),
    }
  }).sort((a, b) => b.pct - a.pct)

  // Return top terminals that score 100%, or the top N
  const perfect = scores.filter(s => s.pct === 100)
  if (perfect.length > 0 && perfect.length <= limit) return perfect
  return scores.slice(0, limit)
}

const totalFeatures = computed(() => data.features.length)
const totalCategories = computed(() => activeCategories.value.length)
</script>

# Terminal Features

<p class="page-tagline">{{ totalFeatures }} features across {{ totalCategories }} categories — tested on every major terminal</p>

## How Escape Sequences Work

Every terminal feature is an **escape sequence** — a special byte pattern that tells the terminal to do something other than display text. When a program writes `\x1b[1m`, it's not printing four characters; it's telling the terminal "make the following text bold." The terminal intercepts the pattern, changes its internal state, and displays subsequent characters accordingly.

The **CSI (Control Sequence Introducer)** `ESC [` (hex `1b 5b`) is the prefix for most sequences. What follows the CSI determines the operation: **SGR** (`m` suffix) for text styling, **CUP** (`H` suffix) for cursor positioning, **DECSET** (`?...h`) for enabling modes. Parameters are semicolon-separated numbers. Sub-parameters (colon-separated, from ECMA-48 but rarely used until Kitty adopted them) enable richer expressions like `4:3` for curly underline.

The beauty of the system is its simplicity: terminals only need to parse one grammar (ECMA-48's CSI format) to handle hundreds of features. The complexity lives in **which parameter values each terminal recognizes** — and that's exactly what terminfo.dev measures.

### Escape Sequences in Action

<div class="escape-examples">
<table>
  <thead><tr><th>Sequence</th><th>Renders</th><th>Feature</th></tr></thead>
  <tbody>
    <tr><td><code>ESC[1m</code>Hello<code>ESC[0m</code></td><td><strong>Hello</strong></td><td><a href="/sgr/sgr-1-bold">Bold (SGR 1)</a></td></tr>
    <tr><td><code>ESC[3m</code>Hello<code>ESC[0m</code></td><td><em>Hello</em></td><td><a href="/sgr/sgr-3-italic">Italic (SGR 3)</a></td></tr>
    <tr><td><code>ESC[4m</code>Hello<code>ESC[0m</code></td><td><u>Hello</u></td><td><a href="/sgr/sgr-4-underline">Underline (SGR 4)</a></td></tr>
    <tr><td><code>ESC[38;2;255;100;0m</code>Hello<code>ESC[0m</code></td><td><span style="color:#ff6400"><strong>Hello</strong></span></td><td><a href="/sgr/sgr-38-2-truecolor-fg">Truecolor</a></td></tr>
    <tr><td><code>ESC[5;10H</code></td><td><em>cursor jumps to row 5, col 10</em></td><td><a href="/cursor/cup-cursor-position">Cursor Position</a></td></tr>
    <tr><td><code>ESC[?1049h</code></td><td><em>screen clears</em></td><td><a href="/modes/modes-alt-screen-enter">Alternate Screen</a></td></tr>
    <tr><td><code>ESC[6n</code></td><td>terminal replies <code>ESC[24;80R</code></td><td><a href="/cursor/dsr-6-cursor-position-report">Cursor Report</a></td></tr>
    <tr><td><code>ESC[&gt;1u</code></td><td><em>keyboard sends unambiguous keys</em></td><td><a href="/extensions/extensions-kitty-keyboard">Kitty Keyboard</a></td></tr>
  </tbody>
</table>
</div>

## Categories

<div class="category-grid">
  <a v-for="cat in activeCategories" :key="cat" class="category-card category-card-link" :href="'/' + cat">
    <div class="category-header">
      <span class="category-icon">{{ categoryMeta[cat]?.icon ?? '📋' }}</span>
      <span class="category-name">{{ catLabel(cat) }}</span>
      <span class="category-count">{{ featureCount(cat) }} features</span>
    </div>
    <p v-if="categoryMeta[cat]?.tagline" class="category-tagline">{{ categoryMeta[cat]?.tagline }}</p>
    <div v-if="topTerminals(cat).length > 0" class="category-top">
      <span class="category-top-label">Top:</span>
      <span v-for="(t, i) in topTerminals(cat)" :key="t.name" class="category-top-terminal">{{ t.name }} ({{ t.pct }}%)<span v-if="i < topTerminals(cat).length - 1">, </span></span>
    </div>
  </a>
</div>

### SGR (Text Styling) — The Most Common Escape Codes

SGR (Select Graphic Rendition) sequences control every visual aspect of text: **bold**, **italic**, **underline** (5 styles including curly, dotted, and dashed), **256-color** and **truecolor** (24-bit RGB) foregrounds and backgrounds, **strikethrough**, **overline**, and **inverse video**. SGR uses the `m` suffix: `ESC[1m` for bold, `ESC[38;2;255;0;0m` for red truecolor foreground.

Support ranges from universal (bold, basic 8 colors) to inconsistent (curly underline with independent underline color, overline). The curly underline (`SGR 4:3`) is especially interesting — it uses ECMA-48's colon sub-parameter syntax that was largely ignored for decades until Kitty adopted it.

<p class="category-link"><a class="hover-link" href="/sgr">View SGR features &rarr;</a></p>

### Cursor — Positioning and Visibility

Cursor sequences handle **positioning** (CUP, CHA, CNL), **visibility** (DECTCEM), **shape** (DECSCUSR — block, underline, bar, blinking variants), and **save/restore** (DECSC/DECRC). The cursor position report (`DSR 6`) lets applications ask "where is the cursor?" — essential for terminal capability detection and shell integration.

Differences in DECSC/DECRC behavior (what exactly gets saved and restored) and cursor shape support are common sources of cross-terminal bugs in TUI applications.

<p class="category-link"><a class="hover-link" href="/cursor">View Cursor features &rarr;</a></p>

### Text — Output Fundamentals

The basics of terminal text: output, **wrapping** at line boundaries, **wide character** handling (emoji and CJK ideographs that occupy two columns), **tabs**, **backspace**, and line control (IND, NEL). These are the features that every terminal application depends on, even if it doesn't know it.

Wide character handling is deceptively hard. When an emoji occupies two columns, what happens when it's at the last column of a line? Different terminals wrap differently, and the wrong behavior breaks every TUI layout that renders near the right edge.

<p class="category-link"><a class="hover-link" href="/text">View Text features &rarr;</a></p>

### Erase — Surgical Content Removal

Line erase (EL 0/1/2), screen erase (ED 0/1/2/3), and character erase (ECH) allow applications to **clear portions of the screen** without redrawing everything. ED 3 (erase scrollback) is notable — it clears the scroll buffer, which is useful for security (clearing sensitive output) but not universally supported.

<p class="category-link"><a class="hover-link" href="/erase">View Erase features &rarr;</a></p>

### Editing — Insert and Delete

ICH, DCH, IL, and DL are the VT220 editing sequences that make **full-screen terminal applications practical**. Insert Character (ICH) pushes existing text right to make room; Delete Character (DCH) removes and shifts text left. Without these, every text change would require redrawing the entire line or screen.

These sequences are used by virtually every TUI application: vim, tmux, less, htop, every readline-based shell prompt. They're so fundamental they're easy to take for granted.

<p class="category-link"><a class="hover-link" href="/editing">View Editing features &rarr;</a></p>

### Modes — Terminal Behavior Toggles

Terminal modes toggle global behavior: **alternate screen buffer** (?1049), **bracketed paste** (?2004), **mouse tracking** (four variants: X10, normal, button-event, any-event), **focus events** (?1004), **auto-wrap** (?7), and **synchronized output** (?2026). Mode support varies significantly across terminals.

The alternate screen is what makes it possible to run vim, then exit and see your shell exactly as you left it. Bracketed paste prevents pasted text from being interpreted as keyboard commands. These aren't obscure features — they're what makes modern terminal usage safe and ergonomic.

<p class="category-link"><a class="hover-link" href="/modes">View Mode features &rarr;</a></p>

### Scrollback — The Least Standardized Area

Scroll buffer behavior, reverse index, total line tracking, and alternate screen interaction. Scrollback handling is one of the most inconsistent areas of terminal emulation — terminals differ in buffer size limits, whether alternate screen content enters scrollback, and how reverse index interacts with scroll regions.

<p class="category-link"><a class="hover-link" href="/scrollback">View Scrollback features &rarr;</a></p>

### Reset — Returning to Known State

SGR attribute reset (SGR 0), full terminal reset (RIS), soft reset (DECSTR), and programmatic reset. How reliably can an application return the terminal to a clean state? Differences in what RIS resets — cursor position, modes, scroll regions, character sets — can cause subtle bugs that only manifest when switching between applications.

<p class="category-link"><a class="hover-link" href="/reset">View Reset features &rarr;</a></p>

### Extensions — The Cutting Edge

Modern terminal extensions beyond the traditional VT specification: **Kitty keyboard protocol** (unambiguous key reporting), **Kitty graphics** and **Sixel** (inline images), **OSC 8 hyperlinks** (clickable links in terminal output), **text reflow** on resize, and **semantic prompt markers** (OSC 133). These features vary widely in adoption and represent the frontier of terminal capability.

<p class="category-link"><a class="hover-link" href="/extensions">View Extension features &rarr;</a></p>

### Character Sets — Box-Drawing from 1978

The DEC Special Graphics set (activated with `ESC ( 0`) provides **box-drawing characters** used by legacy TUI applications for borders and frames. Modern terminals default to UTF-8, making explicit character set switching rare — but the DEC Special Graphics set remains in active use by programs that need to work on the widest range of terminals.

<p class="category-link"><a class="hover-link" href="/charsets">View Character Set features &rarr;</a></p>

### Device Status — Terminal Identification

Applications use **DA1** (Device Attributes) to identify terminal type and capabilities, and **DSR** (Device Status Report) to query cursor position and terminal health. These query-response sequences are the foundation of terminal capability detection — TUI frameworks use them at startup to determine what features are available.

<p class="category-link"><a class="hover-link" href="/device">View Device Status features &rarr;</a></p>

### Input Protocols — Beyond VT100 Keyboard

Modern input protocols provide richer keyboard and mouse reporting than the VT100's original scheme. **Mouse tracking** comes in six variants (X10, normal, button-event, urxvt, SGR, pixel). **Keyboard enhancement** protocols (modifyOtherKeys, Kitty keyboard) provide modifier-aware key reporting and key release events — capabilities that were simply impossible in the original terminal model.

<p class="category-link"><a class="hover-link" href="/input">View Input Protocol features &rarr;</a></p>

### Unicode — The Width Problem

East Asian ambiguous character width, wide character wrapping, and tab stop behavior with mixed-width text. Getting Unicode right is essential for TUI applications to maintain proper **cursor alignment** across scripts and character sets. When a terminal miscalculates the width of an emoji or CJK character, everything to the right of it shifts — breaking layouts, misaligning columns, and corrupting displays.

<p class="category-link"><a class="hover-link" href="/unicode">View Unicode features &rarr;</a></p>

## How Features Get Tested

Every feature on terminfo.dev is tested by sending **actual escape sequences** to real terminals and measuring the response. There are no self-reported capability databases or spec-sheet claims — only observed behavior.

For **terminal applications** (Ghostty, iTerm2, Kitty, etc.), the community CLI (`npx terminfo.dev`) sends escape sequences to the real terminal and verifies behavior via cursor position reports, device attribute queries, and rendered width measurements. These results reflect what users actually experience.

For **headless backends** (xterm.js, vterm, Alacritty parser, etc.), [Termless](https://termless.dev) runs automated probes against headless terminal emulator libraries. Each probe sends an escape sequence and reads back the terminal state programmatically. A headless pass means the parser accepts the sequence — not necessarily that it renders correctly in the visual terminal.

The combination captures both dimensions: community probes test what users see, headless probes test parser correctness and help library authors verify conformance.

---

<p class="back-link">
  <a href="/">&#8592; Back to matrix</a>
</p>

<style>
.page-tagline {
  font-size: 1.15em;
  color: var(--vp-c-text-2);
  margin-top: -0.5em;
  margin-bottom: 1.5em;
}

.category-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  margin: 1.5em 0 2.5em;
}

@media (max-width: 768px) {
  .category-grid {
    grid-template-columns: 1fr;
  }
}

.category-card {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 16px;
  background: var(--vp-c-bg-soft);
}

.category-card-link,
.category-card-link:link,
.category-card-link:visited {
  color: inherit;
  text-decoration: none !important;
  display: block;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
  cursor: pointer;
}

.category-card-link:hover {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
}

.category-card-link:hover .category-name {
  color: var(--vp-c-brand-1) !important;
}

.category-card-link:hover,
.category-card-link:hover * {
  text-decoration: none !important;
}

.category-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.category-icon {
  font-size: 1.1em;
}

.category-name {
  font-weight: 700;
  font-size: 1em;
  transition: color 0.2s ease;
}

.category-count {
  margin-left: auto;
  font-size: 0.8em;
  color: var(--vp-c-text-3);
  font-weight: 600;
  flex-shrink: 0;
}

.category-tagline {
  font-size: 0.85em;
  color: var(--vp-c-text-2);
  margin: 0 0 8px;
  line-height: 1.4;
}

.category-top {
  font-size: 0.8em;
  color: var(--vp-c-text-3);
}

.category-top-label {
  font-weight: 600;
}

.category-top-terminal {
  /* inherit */
}

.category-link {
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
