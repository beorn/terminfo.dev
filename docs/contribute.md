---
title: Contribute Results
description: Test your terminal and add it to the terminfo.dev database
---

# Contribute Results

Don't see your terminal on terminfo.dev? Test it and submit results in under a minute.

## Quick Start

**With Node.js/Bun** (easiest — tests + submits in one step):

```bash
npx terminfo.dev submit
```

**Without Node.js — macOS/Linux:**

```bash
curl -sL terminfo.dev/test | sh
```

**Windows** (PowerShell — Git Bash, WSL, or Windows Terminal):

```bash
# Option 1: If you have Node.js
npx terminfo.dev submit

# Option 2: If you have Git Bash or WSL
curl -sL terminfo.dev/test | sh

# Option 3: Manual — paste results as a GitHub issue
# Run in your terminal, copy the JSON output, then open:
# https://github.com/beorn/terminfo.dev/issues/new?title=Terminal+results
```

::: tip What does this do?
The script runs a series of feature tests on your terminal — sending the same escape sequences that every TUI app sends — and reports which ones your terminal supports. It does **not** install anything, modify any files, or send data anywhere without asking. You can [read the full source code](https://github.com/beorn/terminfo.dev/blob/main/docs/public/test) before running it — it's a plain shell script.
:::

## How Feature Tests Work

Terminal apps communicate with your terminal using **escape sequences** — invisible control codes like `ESC[1m` (bold) or `ESC[6n` (ask cursor position). Every time you use vim, htop, or any TUI program, your terminal processes thousands of these.

The script does exactly the same thing:

1. **Sends a sequence** — e.g., `ESC[38;2;255;0;0m` (set text color to red)
2. **Asks the terminal** — "where is the cursor now?" (`ESC[6n`)
3. **Reads the response** — if the terminal responds, it understood the sequence
4. **Records pass/fail** — the sequence was either handled or ignored

Nothing is written to disk. No network requests are made (until you choose to submit). The script outputs a JSON scorecard to your terminal showing what your terminal supports.

**Example output:**

```
Testing: SGR bold (ESC[1m)... ✓
Testing: Truecolor (ESC[38;2;R;G;Bm)... ✓
Testing: Kitty keyboard (ESC[?u)... ✗ (no response)
Testing: Sixel graphics... ✗ (not supported)
```

## Step by Step

### 1. Run the tests

```bash
npx terminfo.dev test
```

You'll see a live scorecard showing which features your terminal supports — green for pass, red for fail. Currently tests 161 features across SGR text styling, cursor control, mouse tracking, clipboard, and Unicode.

### 2. Review results

Verify your terminal was detected correctly:

```bash
npx terminfo.dev detect
```

This shows the terminal name, version, and platform that will be attached to your results.

### 3. Submit

```bash
npx terminfo.dev submit
```

This creates a pull request on GitHub with your terminal's results. You can review the PR before it's merged. Once merged, your terminal appears on the site.

## What's Safe to Run?

The script is open source and does only three things:

1. Reads environment variables to detect your terminal (`$TERM_PROGRAM`, `$GHOSTTY_RESOURCES_DIR`, etc.)
2. Sends escape sequences and reads responses (the same ones every TUI app sends)
3. Prints JSON results to stdout

It does **not**:

- Write any files to disk
- Install any software
- Send data over the network (until you explicitly run `submit`)
- Modify your terminal settings (everything is restored after testing)

**Source code:**

- Shell script: [terminfo.dev/test](https://github.com/beorn/terminfo.dev/blob/main/docs/public/test) (what `curl | sh` runs — read it on GitHub)
- npm package: [terminfo.dev on npm](https://www.npmjs.com/package/terminfo.dev) (what `npx` runs)

## Submitting Without npx

If you can't use `npx`, you can submit results manually:

1. Run the test script (`curl -sL terminfo.dev/test | sh`)
2. Copy the JSON output
3. [Open a GitHub issue](https://github.com/beorn/terminfo.dev/issues/new?title=Terminal+results) and paste the JSON

We'll process it and add your terminal to the database.

## JSON Output

For CI or custom integrations:

```bash
npx terminfo.dev test --json > my-terminal.json
```

## Already Tested Terminals

We currently have results for:

**App terminals**: Ghostty, iTerm2, Kitty, VS Code, Warp, Terminal.app, Cursor, Alacritty, WezTerm

**Headless backends**: vterm.js, xterm.js, Alacritty, Ghostty, Kitty, WezTerm, vt100.js

**Multiplexers**: tmux, GNU Screen

Missing yours? Run `npx terminfo.dev submit` and help grow the database.
