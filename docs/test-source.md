---
title: How the Test Script Works
---

# How the Test Script Works

This page explains what happens when you run `curl -sL terminfo.dev/test | sh`. The script is ~180 lines of POSIX shell — you can read every line below.

## What it does, in plain language

1. **Detects your terminal** by reading environment variables (`$TERM_PROGRAM`, `$GHOSTTY_RESOURCES_DIR`, etc.)
2. **Saves your terminal state** so it can restore everything when done — even if interrupted
3. **Switches to the alternate screen** so your scrollback isn't affected
4. **Runs 34 feature checks** — each one sends an escape sequence and reads the response
5. **Restores your terminal** to exactly how it was before
6. **Prints JSON results** to stdout

It does NOT write files, install software, or make network requests.

## How a feature check works

Every check follows the same pattern — send a query, read the response:

```sh
# Example: check if your terminal supports truecolor
# Send: ESC[38;2;255;0;128m  (set text color to RGB pink)
# Then: ESC[6n  (ask "where is the cursor?")
# If the terminal responds with cursor position, it understood the color sequence
printf '\033[38;2;255;0;128m\033[6n' > /dev/tty
response=$(dd bs=64 count=1 < /dev/tty)
```

The script uses a technique called **DA1 sentinel** — it sends the feature query AND a Device Attributes request (`ESC[c`) together. If only the DA1 response comes back, the feature isn't supported. This avoids waiting for timeouts on unsupported features.

## The full script

<details>
<summary>Click to expand (~180 lines of shell)</summary>

```sh
<!--@include: ./public/test-->
```

</details>

## Want to contribute?

Run the script and submit your results:

```bash
npx terminfo.dev submit
```

[Back to the Contribute page](/contribute)
