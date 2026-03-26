---
outline: [2, 3]
prev: false
next: false
---

# How Terminals Work

<p class="page-tagline">The architecture behind every terminal session</p>

<div class="beginner-intro">
<p>Before escape sequences and feature matrices, there's a stack of systems that make terminals work: control characters from the 1960s, a kernel driver that transforms input, a pseudo-terminal that connects your shell to your emulator, and a detection mechanism that tells applications what the terminal can do.</p>
</div>

## The Stack

Every terminal session involves the same layers, whether you're running `ls` in a basic prompt or building a full TUI application. Understanding these layers explains why things work the way they do — and why some things don't work at all.

<div class="fundamentals-grid">
  <a class="fundamentals-card fundamentals-card-link" href="/fundamentals/control-characters">
    <div class="fundamentals-header">
      <span class="fundamentals-icon">⌃</span>
      <span class="fundamentals-name">Control Characters</span>
    </div>
    <p class="fundamentals-tagline">C0 control codes and ASCII — the 33 bytes that aren't text</p>
    <p class="fundamentals-desc">The non-printable bytes (0x00–0x1F, 0x7F) that predate escape sequences. Backspace, Tab, Line Feed, Carriage Return, Bell — and ESC, the character that started everything.</p>
  </a>

  <a class="fundamentals-card fundamentals-card-link" href="/fundamentals/tty-architecture">
    <div class="fundamentals-header">
      <span class="fundamentals-icon">⇅</span>
      <span class="fundamentals-name">TTY Architecture</span>
    </div>
    <p class="fundamentals-tagline">PTY, kernel TTY discipline, shell, terminal emulator</p>
    <p class="fundamentals-desc">The pseudo-terminal pair, the kernel line discipline that sits between your shell and your terminal, and why SSH and tmux add extra layers.</p>
  </a>

  <a class="fundamentals-card fundamentals-card-link" href="/fundamentals/stty">
    <div class="fundamentals-header">
      <span class="fundamentals-icon">⚙</span>
      <span class="fundamentals-name">stty & Line Discipline</span>
    </div>
    <p class="fundamentals-tagline">Raw mode, canonical mode, echo, signals</p>
    <p class="fundamentals-desc">The kernel's TTY line discipline transforms your input before the shell sees it. stty controls that transformation — and TUI apps bypass it entirely with raw mode.</p>
  </a>

  <a class="fundamentals-card fundamentals-card-link" href="/fundamentals/term-detection">
    <div class="fundamentals-header">
      <span class="fundamentals-icon">🔍</span>
      <span class="fundamentals-name">Terminal Detection</span>
    </div>
    <p class="fundamentals-tagline">$TERM, $COLORTERM, DA1, DECRPM, runtime probing</p>
    <p class="fundamentals-desc">How applications discover what the terminal supports — from unreliable environment variables to runtime escape sequence queries. Why static databases fall short.</p>
  </a>
</div>

## How These Layers Connect

When you press a key in a terminal, it flows through every layer before anything appears on screen:

1. The **terminal emulator** (Ghostty, Kitty, iTerm2) captures the keypress and writes the corresponding byte(s) to the PTY master
2. The **kernel TTY line discipline** may transform the input — echoing it back, generating signals (Ctrl+C → SIGINT), or buffering until Enter in canonical mode
3. The byte arrives at your **shell** (bash, zsh, fish) or **application** (vim, htop) via stdin
4. The application writes its response (text, escape sequences) to stdout
5. The line discipline passes the output through to the PTY
6. The **terminal emulator** parses the bytes, interprets escape sequences, and renders the result

Understanding this pipeline explains why `Ctrl+C` kills processes even when the application isn't listening for it (the kernel handles it), why `stty raw` changes everything (it disables the line discipline), and why `$TERM` is unreliable (it's just a string — the terminal doesn't enforce it).

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

.page-tagline {
  font-size: 1.15em;
  color: var(--vp-c-text-2);
  margin-top: -0.5em;
  margin-bottom: 1.5em;
}

.fundamentals-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  margin: 1.5em 0 2.5em;
}

@media (max-width: 768px) {
  .fundamentals-grid {
    grid-template-columns: 1fr;
  }
}

.fundamentals-card {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 16px;
  background: var(--vp-c-bg-soft);
}

.fundamentals-card-link,
.fundamentals-card-link:link,
.fundamentals-card-link:visited {
  color: inherit;
  text-decoration: none !important;
  display: block;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
  cursor: pointer;
}

.fundamentals-card-link:hover {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
}

.fundamentals-card-link:hover .fundamentals-name {
  color: var(--vp-c-brand-1) !important;
}

.fundamentals-card-link:hover,
.fundamentals-card-link:hover * {
  text-decoration: none !important;
}

.fundamentals-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}

.fundamentals-icon {
  font-size: 1.2em;
}

.fundamentals-name {
  font-weight: 700;
  font-size: 1em;
  transition: color 0.2s ease;
}

.fundamentals-tagline {
  font-size: 0.85em;
  color: var(--vp-c-text-2);
  margin: 0 0 8px;
  line-height: 1.4;
  font-style: italic;
}

.fundamentals-desc {
  font-size: 0.88em;
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
