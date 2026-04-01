---
title: Contribute Results
description: Test your terminal and add it to the terminfo.dev database
---

# Contribute Results

Don't see your terminal on terminfo.dev? Test it and submit results in under a minute.

## Quick Start

```bash
npx terminfo.dev submit
```

That's it. Tests 133 features and submits the results.

::: details Don't have Node.js?

**Install Node.js** (one of these):

```bash
# macOS (Homebrew)
brew install node

# macOS/Linux (nvm — recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
nvm install 22

# Windows
# Download from https://nodejs.org (LTS version)

# Any platform (Volta — fast)
curl https://get.volta.sh | bash
volta install node
```

Then run:

```bash
npx terminfo.dev submit
```

`npx` comes with Node.js — no separate install needed.

:::

## What It Does

1. **Detects your terminal** — name, version, OS
2. **Tests 133 features** — escape sequences, colors, mouse, keyboard, clipboard, Unicode
3. **Shows a live scorecard** — green for pass, red for fail
4. **Submits to terminfo.dev** — creates a GitHub issue with your results

Nothing is installed permanently. Nothing is written to disk. Terminal state is fully restored after testing.

## Other Commands

```bash
# Just test (no submit)
npx terminfo.dev test

# Machine-readable output
npx terminfo.dev test --json

# Check what terminal was detected
npx terminfo.dev detect
```

## Source Code

Everything is open source:

- [CLI source](https://github.com/beorn/terminfo.dev/tree/main/cli) — what `npx` runs
- [Probe definitions](https://github.com/beorn/terminfo.dev/tree/main/packages/probes) — the actual feature tests
- [npm package](https://www.npmjs.com/package/terminfo.dev) — `terminfo.dev` on npm

## Already Tested

**App terminals**: Ghostty, iTerm2, Kitty, VS Code, Warp, Terminal.app, Cursor, Alacritty, WezTerm

**Headless backends**: vterm.js, xterm.js, Alacritty, Ghostty, Kitty, WezTerm, vt100.js

**Multiplexers**: tmux, GNU Screen

Missing yours? `npx terminfo.dev submit`
