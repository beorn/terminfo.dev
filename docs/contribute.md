---
title: Contribute Results
description: Test your terminal and add it to the terminfo.dev database
---

# Contribute Results

Don't see your terminal on terminfo.dev? Test it and submit results in under a minute.

## Quick Start

**With Node.js/Bun:**

```bash
npx terminfo.dev submit
```

**Without Node.js (just curl):**

```bash
curl -sL terminfo.dev/probe | sh
```

Both run all probes against your current terminal, detect which terminal you're using, and submit the results.

## Step by Step

### 1. Test your terminal

Run the probes in your terminal:

```bash
npx terminfo.dev probe here
```

You'll see a live scorecard showing which features your terminal supports. Results are color-coded: green for pass, red for fail.

### 2. Check detection

Verify your terminal was detected correctly:

```bash
npx terminfo.dev detect
```

This shows the terminal name, version, and platform that will be attached to your results.

### 3. Submit

Submit your results to terminfo.dev:

```bash
npx terminfo.dev submit
```

This creates a pull request on GitHub with your terminal's probe results. Once merged, your terminal appears on the site.

## What Gets Tested

The CLI runs the same probes used on the site — currently testing 161 features across categories like SGR text styling, cursor control, mouse tracking, clipboard, and Unicode handling. Each probe sends escape sequences to your terminal and checks the response.

## Requirements

- **Node.js 18+** or **Bun** (for `npx`)
- A terminal you want to test (run the command inside it)
- GitHub account (for submitting via PR)

## JSON Output

For CI or custom integrations:

```bash
npx terminfo.dev probe here --json > my-terminal.json
```

## Already Tested Terminals

We currently have results for:

**App terminals**: Ghostty, iTerm2, Kitty, VS Code, Warp, Terminal.app, Cursor, Alacritty, WezTerm

**Headless backends**: vterm.js, xterm.js, Alacritty, Ghostty, Kitty, WezTerm, vt100.js

**Multiplexers**: tmux, GNU Screen

Missing yours? Run `npx terminfo.dev submit` and help grow the database.
