---
outline: deep
---

# Terminals

<p class="page-tagline">Terminal emulators tested across three categories: app terminals, parser backends, and multiplexers</p>

<div class="beginner-intro">
<p>terminfo.dev tests terminal emulators across three categories. <strong>App terminals</strong> are the GUI applications you interact with daily. <strong>Parser backends</strong> are standalone libraries and app parser engines tested without a GUI (like xterm.js, which powers VS Code's integrated terminal). <strong>Multiplexers</strong> sit between your terminal and your shell, adding session persistence but filtering escape sequences along the way. We also document <strong>historical terminals</strong> that defined the standards every modern emulator builds on.</p>
</div>

## App Terminals

Standalone terminal applications tested on real hardware via automated probing. These results reflect the full stack: parser, renderer, font support, and OS integration.

<div class="term-grid">

<a class="term-card" href="/terminals/ghostty">
  <div class="term-header">
    <span class="term-name">Ghostty</span>
    <span class="term-tag">Zig</span>
  </div>
  <p class="term-desc">GPU-accelerated terminal by Mitchell Hashimoto. Excellent standards compliance, near the top of the feature matrix.</p>
</a>

<a class="term-card" href="/terminals/kitty">
  <div class="term-header">
    <span class="term-name">Kitty</span>
    <span class="term-tag">C / Python</span>
  </div>
  <p class="term-desc">GPU-accelerated terminal by Kovid Goyal. Pioneer of the Kitty keyboard and graphics protocols.</p>
</a>

<a class="term-card" href="/terminals/iterm2">
  <div class="term-header">
    <span class="term-name">iTerm2</span>
    <span class="term-tag">macOS</span>
  </div>
  <p class="term-desc">Feature-rich macOS terminal with split panes, profiles, and extensive customization. Native Cocoa app.</p>
</a>

<a class="term-card" href="/terminals/terminal-app">
  <div class="term-header">
    <span class="term-name">Terminal.app</span>
    <span class="term-tag">macOS</span>
  </div>
  <p class="term-desc">Apple's built-in macOS terminal. Ships with every Mac.</p>
</a>

<a class="term-card" href="/terminals/warp">
  <div class="term-header">
    <span class="term-name">Warp</span>
    <span class="term-tag">Rust</span>
  </div>
  <p class="term-desc">AI-powered terminal with blocks-based UI. Rust-based, GPU-accelerated.</p>
</a>

<a class="term-card" href="/terminals/alacritty">
  <div class="term-header">
    <span class="term-name">Alacritty</span>
    <span class="term-tag">Rust</span>
  </div>
  <p class="term-desc">GPU-accelerated minimal terminal. Pioneered GPU rendering for terminals in 2017.</p>
</a>

<a class="term-card" href="/terminals/wezterm">
  <div class="term-header">
    <span class="term-name">WezTerm</span>
    <span class="term-tag">Rust</span>
  </div>
  <p class="term-desc">Terminal emulator with built-in multiplexer, Lua configuration, and SSH domain support.</p>
</a>

<a class="term-card" href="/terminals/vs-code">
  <div class="term-header">
    <span class="term-name">VS Code</span>
    <span class="term-tag">xterm.js</span>
  </div>
  <p class="term-desc">Microsoft's code editor with integrated terminal. Uses xterm.js for terminal emulation.</p>
</a>

<a class="term-card" href="/terminals/cursor">
  <div class="term-header">
    <span class="term-name">Cursor</span>
    <span class="term-tag">xterm.js</span>
  </div>
  <p class="term-desc">AI code editor with integrated terminal. Based on VS Code, uses xterm.js.</p>
</a>

</div>

## Parser Backends

Terminal emulator parsers tested without rendering -- the parser and state machine in isolation. These include standalone libraries that power embedded terminals, and app parser engines from full terminals tested in headless mode. See [Parser Backends](/backends) for the full taxonomy and testing methodology.

<div class="term-grid">

<a class="term-card" href="/terminals/xterm-js">
  <div class="term-header">
    <span class="term-name">xterm.js</span>
    <span class="term-tag">TypeScript</span>
  </div>
  <p class="term-desc">The most widely deployed terminal emulator. Powers VS Code, Cursor, and countless web terminals.</p>
</a>

<a class="term-card" href="/terminals/vterm-js">
  <div class="term-header">
    <span class="term-name">vterm.js</span>
    <span class="term-tag">TypeScript</span>
  </div>
  <p class="term-desc">Full-featured terminal emulator targeting 100% of the terminfo.dev feature matrix.</p>
</a>

<a class="term-card" href="/terminals/vt100-js">
  <div class="term-header">
    <span class="term-name">vt100.js</span>
    <span class="term-tag">TypeScript</span>
  </div>
  <p class="term-desc">Lightweight VT100/VT220-era emulator. Zero dependencies, fast, ~58% feature coverage.</p>
</a>

</div>

## Multiplexers

Terminal multiplexers sit between your terminal and your shell, intercepting escape sequences. Not every feature survives the trip. See [Multiplexers](/multiplexers) for the full pass-through analysis.

<div class="term-grid">

<a class="term-card" href="/terminals/tmux">
  <div class="term-header">
    <span class="term-name">tmux</span>
    <span class="term-tag">2007</span>
  </div>
  <p class="term-desc">The most widely used terminal multiplexer. Session persistence, window management, pane splitting.</p>
</a>

<a class="term-card" href="/terminals/gnu-screen">
  <div class="term-header">
    <span class="term-name">GNU Screen</span>
    <span class="term-tag">1987</span>
  </div>
  <p class="term-desc">The original terminal multiplexer. Session persistence and detach/reattach since 1987.</p>
</a>

</div>

## Historical

Hardware terminals and early software emulators that defined the standards every modern terminal builds on. These are reference entries -- no automated probe data is available.

<div class="term-grid">

<a class="term-card" href="/terminals/vt52-historical">
  <div class="term-header">
    <span class="term-name">DEC VT52</span>
    <span class="term-tag">1975</span>
  </div>
  <p class="term-desc">DEC's pre-ANSI terminal. Proprietary escape sequences predating ECMA-48.</p>
</a>

<a class="term-card" href="/terminals/vt100-historical">
  <div class="term-header">
    <span class="term-name">DEC VT100</span>
    <span class="term-tag">1978</span>
  </div>
  <p class="term-desc">The terminal that defined terminal emulation. First popular ANSI X3.64 implementation.</p>
</a>

<a class="term-card" href="/terminals/vt220-historical">
  <div class="term-header">
    <span class="term-name">DEC VT220</span>
    <span class="term-tag">1983</span>
  </div>
  <p class="term-desc">Added editing operations (ICH/DCH/IL/DL) used by every TUI application today.</p>
</a>

<a class="term-card" href="/terminals/xterm-historical">
  <div class="term-header">
    <span class="term-name">xterm</span>
    <span class="term-tag">1984</span>
  </div>
  <p class="term-desc">The reference X11 terminal emulator. Maintained by Thomas Dickey since 1996.</p>
</a>

<a class="term-card" href="/terminals/vt510-historical">
  <div class="term-header">
    <span class="term-name">DEC VT510</span>
    <span class="term-tag">1993</span>
  </div>
  <p class="term-desc">Reference manual remains the most cited terminal specification.</p>
</a>

</div>

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

.term-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin: 1.5em 0 2em;
}

@media (max-width: 960px) {
  .term-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 640px) {
  .term-grid {
    grid-template-columns: 1fr;
  }
}

.term-card {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 16px;
  background: var(--vp-c-bg-soft);
  color: inherit;
  text-decoration: none !important;
  display: block;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
  cursor: pointer;
}

.term-card:hover {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
}

.term-card:hover .term-name {
  color: var(--vp-c-brand-1) !important;
}

.term-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.term-name {
  font-weight: 700;
  font-size: 1em;
  transition: color 0.2s ease;
}

.term-tag {
  margin-left: auto;
  font-size: 0.8em;
  color: var(--vp-c-text-3);
  font-weight: 600;
  flex-shrink: 0;
}

.term-desc {
  font-size: 0.85em;
  color: var(--vp-c-text-2);
  margin: 0;
  line-height: 1.5;
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
