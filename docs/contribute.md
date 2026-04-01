---
title: Test Your Terminal
description: Find out exactly what your terminal supports — 133 feature tests in under a minute
---

# Test Your Terminal

Find out exactly what your terminal supports — 133 features tested in under a minute.

```bash
npx terminfo.dev
```

This shows your detected terminal and available commands. Run `test` to see your scorecard, or `submit` to test and contribute results to the database.

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

Then run `npx terminfo.dev submit`. `npx` comes with Node.js.

:::

## Other Commands

```bash
npx terminfo.dev test --json    # Machine-readable output
npx terminfo.dev detect         # Check what terminal was detected
```

## Source Code

Everything is open source ([CC BY 4.0](https://github.com/beorn/terminfo.dev)):

- [CLI source](https://github.com/beorn/terminfo.dev/tree/main/cli) — what `npx` runs
- [Probe definitions](https://github.com/beorn/terminfo.dev/tree/main/packages/probes) — the feature tests
- [npm package](https://www.npmjs.com/package/terminfo.dev) — `terminfo.dev` on npm

## Already Tested

**App terminals**: Ghostty, iTerm2, Kitty, VS Code, Warp, Terminal.app, Cursor, Alacritty, WezTerm

**Headless backends**: vterm.js, xterm.js, Alacritty, Ghostty, Kitty, WezTerm, vt100.js

**Multiplexers**: tmux, GNU Screen

Missing yours? `npx terminfo.dev submit`
