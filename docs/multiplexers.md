---
outline: deep
---

# Terminal Multiplexers

<p class="page-tagline">The invisible layer between your terminal and your shell — and the features it swallows</p>

<div class="beginner-intro">
<p>Terminal multiplexers like <strong>tmux</strong> and <strong>GNU Screen</strong> sit between your terminal emulator and your shell, creating virtual sessions that persist when you disconnect. They intercept and relay escape sequences in both directions — and that relay is where things get interesting. Not every feature survives the trip. This page explains what multiplexers do, what they break, and how terminfo.dev measures the damage.</p>
</div>

## What Multiplexers Do

A multiplexer creates a **virtual terminal** inside your real terminal. When you run `tmux`, your shell isn't talking to Ghostty or iTerm2 anymore — it's talking to tmux's internal terminal emulator. Tmux then translates that output into escape sequences that your real terminal understands.

This indirection gives you powerful features:

- **Session persistence** — detach from a session, close your laptop, SSH back in, reattach. Your processes never noticed you left.
- **Window management** — multiple shells in one terminal, split panes, tabs, all managed by the multiplexer.
- **Remote pairing** — multiple users can attach to the same tmux session simultaneously.

The cost? Every escape sequence your application sends must now pass through an intermediary that may not understand it.

```
┌─────────────────────────────────────────────────┐
│  Terminal Emulator (Ghostty, iTerm2, etc.)       │
│  ┌───────────────────────────────────────────┐   │
│  │  Multiplexer (tmux, screen)               │   │
│  │  ┌─────────────────────────────────────┐   │   │
│  │  │  Shell / Application (vim, htop)    │   │   │
│  │  └─────────────────────────────────────┘   │   │
│  └───────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

Without a multiplexer, escape sequences travel one hop: app to terminal. With one, they travel two: app to multiplexer, multiplexer to terminal. The multiplexer must parse, understand, and re-emit every sequence — or decide to drop it.

## The Pass-Through Problem

A multiplexer must **understand** an escape sequence to relay it correctly. When tmux encounters `ESC[1m` (bold), it knows exactly what to do — update its internal state and forward the appropriate sequence to the outer terminal. But when it encounters an escape sequence it doesn't recognize, it has three options:

1. **Drop it silently** — the application never knows the sequence was lost
2. **Pass it through verbatim** — hope the outer terminal handles it (risky, may cause state corruption)
3. **Buffer and mangle it** — partially parse the sequence and emit something incorrect

This is why an application might work perfectly in Ghostty but break inside `tmux`. The terminal supports the feature; the multiplexer in between doesn't.

::: tip The TERM variable clue
When you're inside tmux, `$TERM` is typically set to `tmux-256color` or `screen-256color` — not your outer terminal's value. This tells applications they're talking to a multiplexer's virtual terminal, not the real thing. Applications can use this to adjust their behavior, but many don't.
:::

## What We Test

terminfo.dev runs the same probe suite through each multiplexer and compares results to direct terminal testing. The probe launches the multiplexer with a test daemon inside, sends escape sequences through the full stack (outer terminal + multiplexer + inner application), and measures what comes back.

The difference between direct results and multiplexer results reveals exactly which features each mux strips, mangles, or correctly relays.

For example, if Ghostty scores 97% on direct testing but only 78% when running through tmux, those missing 19 percentage points represent features that tmux doesn't pass through — even though the terminal supports them.

## Common Casualties

Certain categories of features are reliably lost when passing through a multiplexer:

### Kitty Keyboard Protocol

The Kitty keyboard protocol (`CSI > 1 u`) provides unambiguous key reporting — distinguishing `Ctrl+I` from `Tab`, reporting key release events, and providing modifier information that traditional terminals can't express. Tmux has partial support via its `extended-keys` option, but the full protocol (progressive enhancement flags, associated text) is not relayed. Screen has no support at all.

### Graphics Protocols

Inline images are one of the hardest things to proxy. Sixel graphics require the multiplexer to understand pixel-level rendering — tmux added Sixel support in version 3.4, but GNU Screen hasn't. Kitty's graphics protocol, which uses a different mechanism (base64-encoded data via APC sequences), faces similar challenges.

### OSC Sequences

Operating System Commands like OSC 52 (clipboard access) and OSC 8 (hyperlinks) are partially supported. Tmux can relay clipboard operations but may interfere with hyperlink sequences. The behavior depends heavily on the multiplexer version and configuration.

### Focus Reporting

Focus events (`CSI ? 1004 h`) tell applications when the terminal window gains or loses focus. Multiplexers complicate this because the "focus" concept becomes ambiguous — does it mean the outer terminal has focus, or the multiplexer pane? Tmux supports focus events with the `focus-events` option, but the semantics differ from direct terminal focus.

### Synchronized Output

The synchronized output mode (`CSI ? 2026 h`) prevents screen tearing during rapid updates. Multiplexers that don't understand this mode may drop the begin/end markers, causing the exact flickering the protocol was designed to prevent.

## Multiplexers

<div class="mux-grid">
  <a class="mux-card" href="/terminals/tmux">
    <div class="mux-header">
      <span class="mux-name">tmux</span>
      <span class="mux-year">2007</span>
    </div>
    <p class="mux-desc">The dominant multiplexer. Active development, growing protocol support. Added Sixel graphics in 3.4, partial Kitty keyboard via <code>extended-keys</code>. Highly configurable with a rich plugin ecosystem.</p>
  </a>
  <a class="mux-card" href="/terminals/gnu-screen">
    <div class="mux-header">
      <span class="mux-name">GNU Screen</span>
      <span class="mux-year">1987</span>
    </div>
    <p class="mux-desc">The original multiplexer — session persistence before tmux existed. Still maintained, but slower to adopt modern terminal features. No Sixel, no Kitty keyboard, limited OSC support.</p>
  </a>
</div>

## Practical Advice for Developers

If you're building a terminal application, multiplexer compatibility is not optional — a significant portion of your users will be running inside tmux.

### Test Both Ways

Always test your application with and without a multiplexer. A feature that works in a bare terminal may silently fail through tmux. Your CI should include both direct and multiplexer test runs if you depend on modern terminal features.

### Detect Multiplexer Presence

```bash
# Check if running inside tmux
if [ -n "$TMUX" ]; then
  echo "Inside tmux"
fi

# Check TERM_PROGRAM for the outer terminal
# (tmux sets TERM_PROGRAM to "tmux", original terminal is in TERM_PROGRAM saved by tmux)
echo "$TERM_PROGRAM"

# Check for any multiplexer via TERM
case "$TERM" in
  screen*|tmux*) echo "Inside a multiplexer" ;;
esac
```

### Use Tmux Passthrough Mode

For features that tmux doesn't understand natively, you can bypass its filtering with the passthrough escape sequence:

```bash
# Send an escape sequence directly to the outer terminal, bypassing tmux
printf '\ePtmux;\e\e]8;;https://example.com\a Link \e\e]8;;\a\e\\'

# Generic format: wrap the sequence in DCS tmux; ... ST
# Every ESC inside must be doubled
```

Enable passthrough in tmux config:

```bash
# ~/.tmux.conf
set -g allow-passthrough on
```

::: warning
Passthrough sends raw escape sequences to the outer terminal without tmux's knowledge. This can cause state desynchronization — tmux won't know about mode changes or cursor position changes made via passthrough. Use it for fire-and-forget sequences (hyperlinks, notifications), not for stateful operations.
:::

### Degrade Gracefully

When you detect a multiplexer, fall back to features the multiplexer supports rather than silently breaking:

```typescript
function supportsKittyKeyboard(): boolean {
  // Kitty keyboard is unreliable through multiplexers
  if (process.env.TMUX || process.env.STY) return false
  // ... probe the terminal directly
}
```

### Version Awareness

Multiplexer capabilities change across versions. Tmux 3.4 added Sixel support that 3.2 doesn't have. If you're targeting a specific multiplexer feature, check the version:

```bash
# Get tmux version
tmux -V
# => tmux 3.5a

# Get screen version
screen --version
# => Screen version 5.0.1 (GNU) ...
```

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

.mux-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  margin: 1.5em 0 2em;
}

@media (max-width: 768px) {
  .mux-grid {
    grid-template-columns: 1fr;
  }
}

.mux-card {
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

.mux-card:hover {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
}

.mux-card:hover .mux-name {
  color: var(--vp-c-brand-1) !important;
}

.mux-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.mux-name {
  font-weight: 700;
  font-size: 1.05em;
  transition: color 0.2s ease;
}

.mux-year {
  margin-left: auto;
  font-size: 0.8em;
  color: var(--vp-c-text-3);
  font-weight: 600;
}

.mux-desc {
  font-size: 0.85em;
  color: var(--vp-c-text-2);
  margin: 0;
  line-height: 1.5;
}

.mux-desc code {
  font-size: 0.85em;
  background: var(--vp-c-bg-alt);
  padding: 1px 4px;
  border-radius: 3px;
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
