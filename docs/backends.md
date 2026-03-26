---
outline: deep
---

# Parser Backends

<p class="page-tagline">Standalone terminal libraries and app parser engines, tested without a GUI</p>

<div class="beginner-intro">
<p>Parser backends are terminal emulator cores tested in isolation — no window, no renderer, just the escape sequence parser and state machine. They come in two forms: <strong>standalone libraries</strong> are embeddable terminal emulators (xterm.js powers VS Code), while <strong>app parser backends</strong> are the VT parsers extracted from full terminal applications like Ghostty and Kitty, tested in headless mode. Both are probed through <a href="https://termless.dev">Termless</a>, our headless terminal testing framework.</p>
</div>

## Parser Testing vs Real Terminal Testing

Parser backend probes test whether the **library correctly parses and processes escape sequences**. When a probe sends `ESC[1m` (bold) and the parser's internal state reflects "bold is active," that's a pass. This differs from app terminal testing, which also verifies visual rendering, font support, and OS integration.

A parser pass means **"the parser understands this sequence"** — not "it renders correctly on screen." A real terminal test confirms the full stack: parser, renderer, font fallback, and compositor all working together.

This distinction matters in practice. A library might correctly parse Kitty keyboard protocol sequences but the app embedding it might not wire up the key events. Or a library might handle Sixel parsing but the host application has no image rendering pipeline.

| Dimension       | Parser Backend Test            | App Terminal Test                       |
| --------------- | ------------------------------ | --------------------------------------- |
| What runs       | Library parser + state machine | Full terminal application               |
| What's verified | Internal state changes         | Visual output + behavior                |
| Speed           | Milliseconds (in-process)      | Seconds (launches app, sends sequences) |
| A "pass" means  | Parser accepts the sequence    | Feature works end-to-end                |
| Example         | xterm.js parses `CSI ? 2026 h` | VS Code enables synchronized output     |

## Why This Matters

If you're building a terminal-based application, the underlying backend determines your feature floor. It doesn't matter that Kitty supports the Kitty keyboard protocol if your app embeds xterm.js and xterm.js doesn't parse it — your users won't get that feature regardless of their outer terminal.

Backend testing reveals these constraints:

- **Framework authors** can check whether their terminal library supports the features they need before committing to it.
- **Library authors** can verify their parser against the full feature matrix and identify gaps.
- **App developers** embedding a terminal (Electron apps, web IDEs, VS Code extensions) can see exactly which escape sequences their chosen library handles.

## Standalone Libraries

Embeddable terminal emulator libraries -- these **are** the terminal. They don't have a GUI; applications embed them to provide terminal functionality. xterm.js powers VS Code's integrated terminal, web-based IDEs, and countless Electron apps.

<div class="backend-grid">

<a class="backend-card" href="/terminals/xterm-js">
  <div class="backend-header">
    <span class="backend-name">xterm.js</span>
    <span class="backend-lang">TypeScript</span>
  </div>
  <p class="backend-desc">The most widely deployed terminal emulator. Powers VS Code, Cursor, Hyper, and most web-based terminals. Its feature support defines the capability floor for millions of developers.</p>
</a>

<a class="backend-card" href="/terminals/vterm-js">
  <div class="backend-header">
    <span class="backend-name">vterm.js</span>
    <span class="backend-lang">TypeScript</span>
  </div>
  <p class="backend-desc">Full-featured terminal emulator targeting 100% feature support. Built for correctness — a reference implementation for modern terminal behavior.</p>
</a>

<a class="backend-card" href="/terminals/vt100-js">
  <div class="backend-header">
    <span class="backend-name">vt100.js</span>
    <span class="backend-lang">TypeScript</span>
  </div>
  <p class="backend-desc">Lightweight VT100/VT220-era emulator. Covers the core terminal baseline without modern extensions — useful as a compatibility reference point.</p>
</a>

</div>

## App Parser Backends

Full terminal applications whose VT parser can be tested headlessly. These are the same parsers that run inside the GUI app, but exercised without the renderer, font stack, or window system. Headless testing isolates parser correctness from rendering behavior.

<div class="backend-grid">

<a class="backend-card" href="/terminals/alacritty">
  <div class="backend-header">
    <span class="backend-name">Alacritty</span>
    <span class="backend-lang">Rust</span>
  </div>
  <p class="backend-desc">The VTE-based parser from the minimal, GPU-accelerated Rust terminal. Also tested as an app terminal — <a href="/terminals/alacritty" class="dual-link">see app results</a>.</p>
</a>

<a class="backend-card" href="/terminals/wezterm">
  <div class="backend-header">
    <span class="backend-name">WezTerm</span>
    <span class="backend-lang">Rust</span>
  </div>
  <p class="backend-desc">The termwiz parser from WezTerm's terminal + multiplexer. Also tested as an app terminal — <a href="/terminals/wezterm" class="dual-link">see app results</a>.</p>
</a>

<a class="backend-card" href="/terminals/kitty">
  <div class="backend-header">
    <span class="backend-name">Kitty</span>
    <span class="backend-lang">C / Python</span>
  </div>
  <p class="backend-desc">The parser behind the Kitty keyboard protocol, graphics protocol, and other innovations. Also tested as an app terminal — <a href="/terminals/kitty" class="dual-link">see app results</a>.</p>
</a>

<a class="backend-card" href="/terminals/ghostty">
  <div class="backend-header">
    <span class="backend-name">Ghostty</span>
    <span class="backend-lang">Zig</span>
  </div>
  <p class="backend-desc">Ghostty's from-scratch Zig parser, tested independently of the GPU renderer. Also tested as an app terminal — <a href="/terminals/ghostty" class="dual-link">see app results</a>.</p>
</a>

</div>

## How Testing Works

Parser probes run through [Termless](https://termless.dev), a headless terminal testing framework (think Playwright, but for terminals). Each probe:

1. **Creates a headless terminal instance** from the backend library
2. **Writes escape sequences** to the terminal's input stream
3. **Reads back terminal state** — cursor position, cell attributes, mode flags, response strings
4. **Asserts correctness** — did the parser interpret the sequence as specified?

This runs in-process, without any GUI, window, or PTY. A full probe suite across all backends completes in seconds.

```
Probe: "SGR bold"
  → Write: \x1b[1mHello\x1b[0m
  → Read cell(0,0): text="H", bold=true
  → Read cell(0,5): text=" ", bold=false
  → Result: pass
```

## App Terminal Overlap

The four app parser backends — Alacritty, WezTerm, Kitty, Ghostty — are also tested as full app terminals. When both parser and app results exist, the terminal's page shows both.

The two test types answer different questions:

- **Parser results** confirm parser correctness. Does the parser understand the sequence?
- **App results** confirm the full stack. Does the feature actually work when a user types in the terminal?

In most cases these agree. Where they diverge, it's informative: a parser pass with an app fail usually means the parser handles the sequence but the renderer or event pipeline doesn't expose it. A parser fail with an app pass is rarer and typically means the app has special-case handling outside the core parser.

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

.backend-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  margin: 1.5em 0 2em;
}

@media (max-width: 768px) {
  .backend-grid {
    grid-template-columns: 1fr;
  }
}

.backend-card {
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

.backend-card:hover {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
}

.backend-card:hover .backend-name {
  color: var(--vp-c-brand-1) !important;
}

.backend-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.backend-name {
  font-weight: 700;
  font-size: 1em;
  transition: color 0.2s ease;
}

.backend-lang {
  margin-left: auto;
  font-size: 0.8em;
  color: var(--vp-c-text-3);
  font-weight: 600;
  flex-shrink: 0;
}

.backend-desc {
  font-size: 0.85em;
  color: var(--vp-c-text-2);
  margin: 0;
  line-height: 1.5;
}

.backend-desc .dual-link {
  color: var(--vp-c-brand-1);
  font-weight: 600;
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
