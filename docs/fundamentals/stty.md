---
outline: [2, 3]
prev: false
next: false
---

# Terminal Modes & stty

<p class="page-tagline">Raw mode, canonical mode, and the kernel TTY discipline</p>

<div class="beginner-intro">
<p>The <code>stty</code> command controls how the kernel's TTY line discipline processes bytes flowing between your terminal and your application. It doesn't configure the terminal emulator — it configures the kernel layer that sits <em>between</em> the terminal and the application. Understanding <code>stty</code> explains why TUI apps feel different from the shell prompt, why password prompts hide your typing, and why a crashed program can leave your terminal garbled.</p>
</div>

## What stty Controls

The `stty` command configures the kernel's **TTY line discipline** — a driver that sits between the terminal emulator and the application, transforming bytes in both directions. When you type a character, it passes through the line discipline before the application sees it. When the application writes output, it passes through the line discipline before the terminal emulator renders it. See [TTY Architecture](/fundamentals/tty-architecture) for where the line discipline fits in the overall terminal stack.

The line discipline is responsible for echo (showing what you type), line editing (backspace and kill-line), signal generation (Ctrl+C), newline translation, and flow control. `stty` is the user-space tool that reads and writes the kernel's termios settings — the flags that control all of these behaviors.

This distinction matters: `stty` does not control what the terminal emulator does with escape sequences, how it renders colors, or what font it uses. It controls the kernel layer — the one that decides whether to buffer input until Enter, whether to echo characters back, and whether Ctrl+C should generate a signal. Terminal emulator configuration (fonts, themes, keybindings) lives in the emulator's own settings. The line discipline is lower level than that.

## Canonical (Cooked) Mode

Canonical mode is the default. When you open a terminal and get a shell prompt, the line discipline is in canonical mode. In this mode, input is **line-buffered** — the kernel collects characters until you press Enter, then delivers the entire line to the application at once. The application doesn't see individual keystrokes; it sees complete lines.

While the line is being assembled, the line discipline provides basic line editing. Backspace removes the last character. Ctrl+U kills the entire line. Ctrl+W deletes the previous word. These work at the kernel level — the shell hasn't received any input yet when you're editing the line. This is why line editing feels the same in every application that uses canonical mode, regardless of whether you're running `cat`, `python`, or a simple C program reading from stdin.

Canonical mode is appropriate for applications that process input line by line — shells, scripting language REPLs, and simple interactive programs. The kernel handles the tedious work of line editing, and the application receives clean, complete lines. The tradeoff is that the application never sees individual keystrokes, can't respond to arrow keys or function keys, and can't update the display in real time.

## Raw Mode

In raw mode, every byte is delivered to the application **immediately**, with no processing by the line discipline. There's no buffering, no echo, no line editing, and no signal characters. The application receives the exact bytes that the terminal emulator sent, and the terminal emulator displays only what the application explicitly writes.

TUI applications — vim, htop, less, top, tmux — switch to raw mode on startup and restore canonical mode on exit. This gives them full control: they can respond to every keypress, handle arrow keys and function keys, draw anywhere on the screen, and manage their own display. When vim shows your cursor moving as you press arrow keys, that's vim reading raw bytes, interpreting them, and writing escape sequences to reposition the cursor — the kernel is not involved.

Technically, "raw mode" is not a single flag but a collection of termios settings. The `stty raw` command disables input processing (`icanon`), echo (`echo`), signal generation (`isig`), and output processing (`opost`), among others. The POSIX function `cfmakeraw()` sets the canonical combination. Applications typically use `tcgetattr()` to save the current settings, call `cfmakeraw()` to switch to raw mode, and call `tcsetattr()` with the saved settings on exit to restore the terminal.

## Echo

Echo controls whether typed characters appear on screen. In canonical mode, the kernel's line discipline handles echo — when you press a key, the line discipline writes that character back to the terminal emulator so you can see it. The application hasn't done anything yet; the kernel is providing the visual feedback.

In raw mode, echo is disabled. The application is fully responsible for deciding what appears on screen. When you type a character in vim, vim decides whether to insert it, use it as a command, or ignore it. vim writes the appropriate screen updates itself. If nothing wrote the character to the screen, you wouldn't see it.

The `stty -echo` command disables echo independently of other line discipline settings. This is how password prompts work: the shell (or `sudo`, or `ssh`) disables echo, reads your password in canonical mode (you still get line editing, so backspace works), then re-enables echo. The characters you type are delivered to the application normally — they just aren't displayed. This is simpler and more secure than raw mode, because the application still gets the convenience of line buffering.

## Signal Characters

The kernel's TTY line discipline recognizes certain input bytes as **signal characters** and converts them to process signals. These signals are sent to the entire foreground process group — not just the process reading from the terminal, but all processes in the group. See [Control Characters](/fundamentals/control-characters) for the full C0 table including these bytes.

<div class="signal-table-wrapper">
<table class="signal-table">
<thead><tr><th>Keystroke</th><th>Byte</th><th>Signal</th><th>Default Action</th><th>stty Name</th></tr></thead>
<tbody>
<tr><td>Ctrl+C</td><td><code>0x03</code> (ETX)</td><td>SIGINT</td><td>Terminate process</td><td><code>intr</code></td></tr>
<tr><td>Ctrl+Z</td><td><code>0x1A</code> (SUB)</td><td>SIGTSTP</td><td>Suspend (stop) process</td><td><code>susp</code></td></tr>
<tr><td>Ctrl+\</td><td><code>0x1C</code> (FS)</td><td>SIGQUIT</td><td>Terminate with core dump</td><td><code>quit</code></td></tr>
<tr><td>Ctrl+D</td><td><code>0x04</code> (EOT)</td><td><em>(not a signal)</em></td><td>EOF — signals end of input</td><td><code>eof</code></td></tr>
</tbody>
</table>
</div>

These signals are generated by the **kernel TTY driver**, not by the terminal emulator. The terminal emulator just sends bytes — it has no concept of SIGINT or SIGTSTP. The line discipline intercepts the bytes and generates the signals. This is why Ctrl+C works even when the application is stuck in an infinite loop and not reading input — the signal comes from the kernel, delivered asynchronously.

Ctrl+D is technically not a signal character — it doesn't generate a process signal. Instead, in canonical mode, the line discipline treats it as "end of input." If the line buffer is empty, it causes `read()` to return 0 (EOF). If there's text in the buffer, it flushes the buffer to the application without waiting for Enter. In raw mode, Ctrl+D is just byte 0x04 with no special meaning.

::: tip Ctrl+C doesn't kill processes — the kernel sends SIGINT based on stty settings
The terminal emulator knows nothing about process management. When you press Ctrl+C, the emulator writes byte 0x03 to the PTY master. The kernel line discipline recognizes 0x03 as the `intr` character (configurable via `stty intr`), and sends SIGINT to the foreground process group. The process can catch SIGINT and handle it gracefully (saving files, cleaning up), ignore it entirely, or let the default handler terminate it. In raw mode, the line discipline doesn't intercept 0x03 at all — it's delivered to the application as a normal byte.
:::

## Common stty Commands

<div class="command-table-wrapper">
<table class="command-table">
<thead><tr><th>Command</th><th>What It Does</th></tr></thead>
<tbody>
<tr><td><code>stty raw</code></td><td>Switch to raw mode. Disables line buffering, echo, signal characters, and output processing. Every byte passes through unmodified.</td></tr>
<tr><td><code>stty -raw</code></td><td>Switch back to canonical (cooked) mode. Re-enables line buffering and input processing. Note: doesn't restore all settings — use <code>stty sane</code> for a full reset.</td></tr>
<tr><td><code>stty -echo</code></td><td>Disable echo. Characters you type are not displayed. Used by password prompts. Pair with <code>stty echo</code> to re-enable.</td></tr>
<tr><td><code>stty sane</code></td><td>Reset all settings to sensible defaults. The nuclear recovery option — fixes garbled terminals after a crashed program.</td></tr>
<tr><td><code>stty -a</code></td><td>Display all current line discipline settings. Shows every flag, every special character mapping, and the terminal dimensions.</td></tr>
<tr><td><code>stty size</code></td><td>Print the terminal dimensions as <code>rows cols</code> (e.g., <code>50 120</code>). Many scripts use this to detect terminal size.</td></tr>
<tr><td><code>stty erase ^H</code></td><td>Set the erase (backspace) character to Ctrl+H (0x08). Some terminals send DEL (0x7F) for backspace; this remaps it.</td></tr>
</tbody>
</table>
</div>

You can also inspect individual settings: `stty -a | grep icanon` tells you whether canonical mode is active. The output format varies by platform — Linux shows flag names in a flat list; macOS groups them by category.

## Why TUI Apps Use Raw Mode

TUI applications need raw mode for four fundamental reasons:

**Immediate input.** In canonical mode, the application doesn't receive any input until the user presses Enter. A text editor needs to respond to every keypress — inserting characters, moving the cursor, triggering commands. Raw mode delivers each byte as soon as the terminal emulator sends it, enabling real-time interaction.

**Custom signal handling.** In canonical mode, Ctrl+C kills the process immediately (via SIGINT). A TUI application needs to handle Ctrl+C itself — vim might use it to cancel an operation, htop might use it to quit gracefully after confirmation. Raw mode delivers Ctrl+C as byte 0x03, and the application decides what to do with it. The application can still install a SIGINT handler as a safety net (for when the OS sends it for other reasons), but the normal code path processes 0x03 as a regular input byte.

**Display control.** In canonical mode, the kernel echoes typed characters to the screen, and the application has no control over where they appear. A TUI application needs to control every pixel — drawing status bars, syntax highlighting, scroll regions. Raw mode disables echo so only the application's explicit output appears on screen. The application writes [escape sequences](/fundamentals/control-characters) to position the cursor, set colors, and clear areas.

**Escape sequence parsing.** Terminal input for special keys (arrow keys, function keys, mouse events) arrives as multi-byte escape sequences — for example, the up arrow is typically `ESC [ A` (three bytes: 0x1B, 0x5B, 0x41). In canonical mode, the line discipline might interpret parts of these sequences as control characters. Raw mode delivers the raw bytes so the application can parse the complete sequence.

## The "stty sane" Trick

If your terminal is garbled — characters don't echo, Enter doesn't work, the display is corrupted — the most likely cause is a TUI application that crashed without restoring canonical mode. The terminal is stuck in raw mode, and the line discipline isn't doing its normal processing.

The fix is to type `stty sane` and press Enter. You won't see what you're typing (echo is off), and Enter might not appear to do anything visually, but the command will execute if you can get the shell to read it. `stty sane` resets all line discipline settings to reasonable defaults: canonical mode on, echo on, signal characters enabled, output processing enabled.

If `stty sane` doesn't fully fix things (rare but possible), the `reset` command goes further — it also sends terminal initialization sequences to the terminal emulator, clearing the alternate screen buffer, resetting colors, and restoring the default character set. Between the two, `reset` is the heavier hammer.

::: details What happens when a TUI app crashes without restoring terminal state
When a TUI application starts, it saves the current terminal settings with `tcgetattr()`, then switches to raw mode with `cfmakeraw()` + `tcsetattr()`. It typically also enters the alternate screen buffer (via the `smcup` escape sequence) so the TUI doesn't pollute the shell's scrollback. On clean exit, it restores the saved settings and leaves the alternate screen.

When the application crashes (segfault, uncaught exception, `kill -9`), none of the cleanup code runs. The terminal is left in whatever state the application set:

- **Raw mode still active** — the line discipline isn't buffering or echoing, so you type blind
- **Alternate screen still active** — you're looking at the TUI's last frame, not your shell. Some terminals detect this and switch back automatically; others don't
- **Terminal modes altered** — mouse reporting, bracketed paste, application cursor keys, or other modes the TUI enabled may still be on
- **Character set switched** — if the app used DEC Special Graphics, you might see line-drawing characters instead of ASCII

The fix cascade: (1) `stty sane` restores the line discipline, (2) `reset` also sends terminal reset sequences, (3) closing and reopening the terminal tab starts fresh. Well-written TUI frameworks install signal handlers for SIGTERM, SIGINT, and SIGHUP that attempt cleanup, and use `atexit()` handlers as a last resort. But `kill -9` cannot be caught, so there's always a crash scenario that leaves the terminal dirty.
:::

---

<p class="back-link">
  <a href="/fundamentals">&#8592; Back to Fundamentals</a>
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

.signal-table-wrapper,
.command-table-wrapper {
  overflow-x: auto;
  margin: 1.5em 0;
}

.signal-table,
.command-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88em;
}

.signal-table th,
.signal-table td,
.command-table th,
.command-table td {
  padding: 6px 10px;
  border: 1px solid var(--vp-c-divider);
  text-align: left;
}

.signal-table th,
.command-table th {
  background: var(--vp-c-bg-soft);
  font-weight: 600;
}

.signal-table code,
.command-table code {
  font-size: 0.9em;
  background: var(--vp-c-bg-soft);
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
