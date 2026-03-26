---
outline: [2, 3]
prev: false
next: false
---

# Control Characters

<p class="page-tagline">The 33 bytes that aren't text — C0 control codes and ASCII</p>

<div class="beginner-intro">
<p>Before escape sequences existed, terminals had control characters — special bytes in the 0x00–0x1F range (plus 0x7F) that tell the terminal to <em>do</em> something instead of <em>displaying</em> something. They occupy the first 32 positions of ASCII plus DEL. Most are relics of teletypes and paper tape, but a few — ESC, BS, TAB, LF, CR, BEL — remain fundamental to how every terminal works today.</p>
</div>

## What C0 Controls Are

ASCII (American Standard Code for Information Interchange, 1963) defines 128 characters. The first 32 (0x00–0x1F) and the last one (0x7F, DEL) are **control characters** — they don't represent printable glyphs. Instead, they're instructions: ring the bell, move the carriage back, start a new line, escape from the normal character stream.

These 33 characters are called **C0 controls** (the "C" stands for "control," the "0" distinguishes them from the C1 control range at 0x80–0x9F). They were designed for electromechanical teletypes in the 1960s. Most have no effect in modern terminals, but the ones that do are essential.

## The Complete C0 Table

<div class="control-table-wrapper">
<table class="control-table">
<thead><tr><th>Hex</th><th>Dec</th><th>Ctrl</th><th>Caret</th><th>Name</th><th>Terminal Behavior</th></tr></thead>
<tbody>
<tr><td><code>00</code></td><td>0</td><td>Ctrl+@</td><td>^@</td><td>NUL</td><td>Ignored by most terminals. Padding character in legacy systems.</td></tr>
<tr><td><code>01</code></td><td>1</td><td>Ctrl+A</td><td>^A</td><td>SOH</td><td>No terminal effect. Used by tmux as the default prefix key.</td></tr>
<tr><td><code>02</code></td><td>2</td><td>Ctrl+B</td><td>^B</td><td>STX</td><td>No terminal effect. Used by screen as the default prefix key.</td></tr>
<tr><td><code>03</code></td><td>3</td><td>Ctrl+C</td><td>^C</td><td>ETX</td><td>No terminal effect. The <em>kernel TTY driver</em> sends SIGINT to the foreground process group.</td></tr>
<tr><td><code>04</code></td><td>4</td><td>Ctrl+D</td><td>^D</td><td>EOT</td><td>No terminal effect. Interpreted by the TTY driver as end-of-file in canonical mode.</td></tr>
<tr><td><code>05</code></td><td>5</td><td>Ctrl+E</td><td>^E</td><td>ENQ</td><td>Some terminals respond with an answerback string (configurable).</td></tr>
<tr><td><code>06</code></td><td>6</td><td>Ctrl+F</td><td>^F</td><td>ACK</td><td>No terminal effect.</td></tr>
<tr class="highlight-row"><td><code>07</code></td><td>7</td><td>Ctrl+G</td><td>^G</td><td>BEL</td><td>Plays a sound, flashes the title bar, or triggers a notification. Also used as an alternative string terminator for OSC sequences.</td></tr>
<tr class="highlight-row"><td><code>08</code></td><td>8</td><td>Ctrl+H</td><td>^H</td><td>BS</td><td>Move cursor back one column (backspace). Does not delete the character.</td></tr>
<tr class="highlight-row"><td><code>09</code></td><td>9</td><td>Ctrl+I</td><td>^I</td><td>HT</td><td>Horizontal tab — advance cursor to the next tab stop (default: every 8 columns).</td></tr>
<tr class="highlight-row"><td><code>0A</code></td><td>10</td><td>Ctrl+J</td><td>^J</td><td>LF</td><td>Line feed — move cursor down one line. In most terminals, also performs a carriage return (newline behavior).</td></tr>
<tr><td><code>0B</code></td><td>11</td><td>Ctrl+K</td><td>^K</td><td>VT</td><td>Vertical tab — treated as LF by most terminals.</td></tr>
<tr><td><code>0C</code></td><td>12</td><td>Ctrl+L</td><td>^L</td><td>FF</td><td>Form feed — treated as LF by most terminals. Shells often interpret it as "clear screen."</td></tr>
<tr class="highlight-row"><td><code>0D</code></td><td>13</td><td>Ctrl+M</td><td>^M</td><td>CR</td><td>Carriage return — move cursor to column 1 of the current line.</td></tr>
<tr><td><code>0E</code></td><td>14</td><td>Ctrl+N</td><td>^N</td><td>SO</td><td>Shift Out — switch to G1 character set (DEC Special Graphics on VT100).</td></tr>
<tr><td><code>0F</code></td><td>15</td><td>Ctrl+O</td><td>^O</td><td>SI</td><td>Shift In — switch back to G0 character set (ASCII).</td></tr>
<tr><td><code>10</code></td><td>16</td><td>Ctrl+P</td><td>^P</td><td>DLE</td><td>No terminal effect.</td></tr>
<tr><td><code>11</code></td><td>17</td><td>Ctrl+Q</td><td>^Q</td><td>DC1/XON</td><td>Resume transmission (software flow control). See <code>stty ixon</code>.</td></tr>
<tr><td><code>12</code></td><td>18</td><td>Ctrl+R</td><td>^R</td><td>DC2</td><td>No terminal effect.</td></tr>
<tr><td><code>13</code></td><td>19</td><td>Ctrl+S</td><td>^S</td><td>DC3/XOFF</td><td>Pause transmission (software flow control). See <code>stty ixon</code>.</td></tr>
<tr><td><code>14</code></td><td>20</td><td>Ctrl+T</td><td>^T</td><td>DC4</td><td>No terminal effect.</td></tr>
<tr><td><code>15</code></td><td>21</td><td>Ctrl+U</td><td>^U</td><td>NAK</td><td>No terminal effect. The TTY driver uses it to kill the current line in canonical mode.</td></tr>
<tr><td><code>16</code></td><td>22</td><td>Ctrl+V</td><td>^V</td><td>SYN</td><td>No terminal effect.</td></tr>
<tr><td><code>17</code></td><td>23</td><td>Ctrl+W</td><td>^W</td><td>ETB</td><td>No terminal effect. The TTY driver uses it to delete the previous word in canonical mode.</td></tr>
<tr><td><code>18</code></td><td>24</td><td>Ctrl+X</td><td>^X</td><td>CAN</td><td>Cancel/abort the current escape sequence. The terminal discards the incomplete sequence.</td></tr>
<tr><td><code>19</code></td><td>25</td><td>Ctrl+Y</td><td>^Y</td><td>EM</td><td>No terminal effect.</td></tr>
<tr><td><code>1A</code></td><td>26</td><td>Ctrl+Z</td><td>^Z</td><td>SUB</td><td>Treated as CAN (abort escape sequence) by most terminals. The TTY driver generates SIGTSTP (suspend).</td></tr>
<tr class="highlight-row"><td><code>1B</code></td><td>27</td><td>Ctrl+[</td><td>^[</td><td>ESC</td><td>Start of escape sequence — the most important control character. Everything on this site starts with this byte.</td></tr>
<tr><td><code>1C</code></td><td>28</td><td>Ctrl+\</td><td>^\</td><td>FS</td><td>No terminal effect. The TTY driver sends SIGQUIT.</td></tr>
<tr><td><code>1D</code></td><td>29</td><td>Ctrl+]</td><td>^]</td><td>GS</td><td>No terminal effect. Used by telnet as the escape character.</td></tr>
<tr><td><code>1E</code></td><td>30</td><td>Ctrl+^</td><td>^^</td><td>RS</td><td>No terminal effect.</td></tr>
<tr><td><code>1F</code></td><td>31</td><td>Ctrl+_</td><td>^_</td><td>US</td><td>No terminal effect.</td></tr>
<tr class="highlight-row"><td><code>7F</code></td><td>127</td><td>Ctrl+?</td><td>^?</td><td>DEL</td><td>Delete character. Historically: rubout on paper tape. Modern terminals often treat it the same as BS.</td></tr>
</tbody>
</table>
</div>

Highlighted rows are the control characters that have meaningful effects in modern terminal emulators.

## How Ctrl+Key Maps to Control Characters

The mapping is elegant and mathematical: **Ctrl+key produces the byte value of the key minus 64** (or equivalently, the key's ASCII value with bits 5 and 6 cleared).

- Ctrl+A = 0x41 (`A`) - 0x40 = 0x01 (SOH)
- Ctrl+C = 0x43 (`C`) - 0x40 = 0x03 (ETX)
- Ctrl+M = 0x4D (`M`) - 0x40 = 0x0D (CR, carriage return)
- Ctrl+[ = 0x5B (`[`) - 0x40 = 0x1B (ESC)

This is a hardware-level mapping — it happens in the terminal emulator before the byte reaches any software. This is also why **Ctrl+I and Tab are the same byte (0x09)**: the terminal has no way to distinguish them. It's not a bug; it's the fundamental design of ASCII.

::: info Ctrl+I and Tab are the same byte (0x09)
This is why you can't bind Ctrl+I and Tab to different actions in traditional terminals — they produce identical input. The [Kitty keyboard protocol](/kitty-extensions) solves this by reporting keys as symbolic events with modifiers, not as raw bytes. With the Kitty protocol, Ctrl+I and Tab are distinct events, and key-release events are reportable for the first time.
:::

## The Characters That Still Matter

Of the 33 control characters, only a handful have meaningful effects in modern terminals:

**ESC (0x1B)** — The gateway to everything else on this site. ESC followed by `[` starts a CSI (Control Sequence Introducer) sequence. ESC followed by `]` starts an OSC (Operating System Command). ESC alone with a letter is a simple escape command (like ESC 7 for DECSC cursor save). Every color change, cursor movement, and mode switch begins with this one byte.

**LF (0x0A)** — Line feed. Combined with CR, this is the newline operation. In most terminal configurations, LF alone performs both line-feed and carriage-return (controlled by the `onlcr` stty setting).

**CR (0x0D)** — Carriage return. Moves the cursor to column 1. In the raw output of `\r\n`, CR does the horizontal movement and LF does the vertical movement. Many terminal applications use CR alone to overwrite the current line (progress bars, spinners).

**BS (0x08)** — Backspace. Moves the cursor left one column but does not erase anything. To visually delete a character, applications send BS, Space, BS (move back, overwrite with space, move back again).

**HT (0x09)** — Horizontal tab. Advances to the next tab stop. Default tab stops are at columns 9, 17, 25, 33, ... (every 8 columns). Applications can set custom tab stops with the HTS escape sequence.

**BEL (0x07)** — The bell character. Originally rang a physical bell on teletypes. In modern terminals, it may play a system sound, flash the title bar ("visual bell"), or trigger a desktop notification. BEL also serves double duty as a string terminator in OSC sequences (as an alternative to the formal ST terminator, ESC \\).

**DEL (0x7F)** — The delete character. It's not in the 0x00–0x1F range — it's 0x7F, the last ASCII value. On paper tape, DEL was a character with all holes punched, used to "rub out" a mistake. In terminals, it's often mapped to the same function as BS.

::: tip Ctrl+C doesn't kill processes via the terminal
When you press Ctrl+C, the terminal emulator sends byte 0x03 (ETX) to the PTY. But the terminal doesn't interpret it — the **kernel TTY line discipline** intercepts it and sends SIGINT to the foreground process group. This is why Ctrl+C works even when the application isn't listening for input. It's also why it doesn't work in raw mode — raw mode disables the line discipline's signal generation. See [stty & Line Discipline](/fundamentals/stty) for details.
:::

## Relationship to ASCII

ASCII defines 128 characters in 7 bits (0x00–0x7F):

| Range | Count | What |
|-------|-------|------|
| 0x00–0x1F | 32 | C0 control characters |
| 0x20 | 1 | Space (technically a "graphic" character) |
| 0x21–0x7E | 94 | Printable characters (letters, digits, punctuation) |
| 0x7F | 1 | DEL (control character) |

The C1 control range (0x80–0x9F) was defined later by ECMA-48 for 8-bit character sets. It includes single-byte equivalents for common escape sequences — 0x9B is CSI (equivalent to ESC [), 0x9D is OSC (equivalent to ESC ]). In practice, C1 controls are almost never used because they conflict with UTF-8 encoding, where bytes 0x80–0xBF are continuation bytes. The 7-bit ESC-prefixed forms are universal.

::: info Why ESC is special
ESC (0x1B) isn't just another control character — it's the **meta-character** that extends the entire control vocabulary. One byte gives you 33 control functions. ESC followed by one or more bytes gives you thousands. The entire ECMA-48 escape sequence grammar, all DEC private modes, OSC commands, and modern protocol extensions are built on this one byte as the entry point. See [ECMA-48 features](/ecma-48) for the grammar ESC unlocks.
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

.control-table-wrapper {
  overflow-x: auto;
  margin: 1.5em 0;
}

.control-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88em;
}

.control-table th,
.control-table td {
  padding: 6px 10px;
  border: 1px solid var(--vp-c-divider);
  text-align: left;
}

.control-table th {
  background: var(--vp-c-bg-soft);
  font-weight: 600;
  position: sticky;
  top: 0;
}

.control-table code {
  font-size: 0.9em;
  background: var(--vp-c-bg-soft);
  padding: 1px 4px;
  border-radius: 3px;
}

.control-table .highlight-row {
  background: var(--vp-c-brand-soft);
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
