---
outline: [2, 3]
prev: false
next: false
---

# TTY Architecture

<p class="page-tagline">PTY, kernel TTY discipline, shell, terminal emulator</p>

<div class="beginner-intro">
<p>A "terminal" is not one thing — it's a stack of components connected by a kernel abstraction called a pseudo-terminal (PTY). Understanding this stack explains why Ctrl+C works even when the application is frozen, why SSH feels like a local terminal, and why tmux can detach sessions.</p>
</div>

## The Terminal Stack

Every terminal session involves these components, connected through the kernel:

<div class="architecture-diagram">
<pre>
┌─────────────────────────────────┐
│  Terminal Emulator              │  Ghostty, Kitty, iTerm2, Terminal.app
│  (renders text, captures keys)  │  Converts keystrokes → bytes
│  Display ← GPU rendering       ││ Parses escape sequences → pixels
└─────────────────────────────────┘
               │ PTY master fd
               │ (read/write bytes)
┌──────────────┴──────────────────┐
│  Kernel PTY + Line Discipline   │  Echo, line editing, signals
│  (transforms input ↔ output)    │  Ctrl+C → SIGINT, Ctrl+Z → SIGTSTP
└─────────────────────────────────┘
               │ PTY slave fd
               │ (/dev/pts/N)
┌──────────────┴──────────────────┐
│  Shell or Application           │  bash, zsh, vim, htop
│  (reads stdin, writes stdout)   │  Sends escape sequences for TUI rendering
└─────────────────────────────────┘
</pre>
</div>

## What a PTY Is

A **pseudo-terminal** (PTY) is a pair of virtual devices created by the kernel:

- **PTY master** — the terminal emulator's end. It reads what the application writes and writes what the user types.
- **PTY slave** — the application's end. It looks like a real serial terminal to the application (providing `/dev/pts/N` or `/dev/ttyp*`).

The PTY is what makes terminal emulators possible. Without it, applications would need to talk directly to hardware. With it, the application thinks it's connected to a physical terminal, and the terminal emulator can be any program — a GUI app, a web browser tab (via xterm.js), or even another terminal (tmux).

When a terminal emulator starts, it:

1. Calls `posix_openpt()` (or `openpty()`) to create a PTY pair
2. Forks a child process (the shell)
3. Sets the PTY slave as the child's stdin, stdout, and stderr
4. Reads from the PTY master to get the shell's output
5. Writes to the PTY master to send the user's keystrokes

::: info Why it's called "pseudo"
Real terminals were physical devices connected via serial cables — the DEC VT100 plugged into a RS-232 port. A PTY creates a virtual equivalent: the PTY slave behaves exactly like a serial terminal device, but the other end is a user-space program instead of a physical device. The kernel doesn't know the difference.
:::

## The Kernel TTY Line Discipline

Between the PTY master and slave sits the **line discipline** — a kernel-level transformer that processes both input and output. It's the reason terminals feel "smart" even before any shell is running.

The line discipline handles:

**Input processing (terminal → application):**

- **Echo** — when you type, the line discipline writes the character back to the terminal so you can see it (the application hasn't done anything yet)
- **Line editing** — backspace, Ctrl+U (kill line), Ctrl+W (delete word) are handled by the line discipline in canonical mode
- **Signal generation** — Ctrl+C → SIGINT, Ctrl+Z → SIGTSTP, Ctrl+\\ → SIGQUIT
- **Line buffering** — in canonical mode, input isn't delivered to the application until you press Enter

**Output processing (application → terminal):**

- **Newline translation** — LF (0x0A) is translated to CR+LF so the cursor returns to column 1. Controlled by the `onlcr` stty flag.
- **Tab expansion** — optionally converts tabs to spaces
- **Flow control** — Ctrl+S pauses output, Ctrl+Q resumes (XON/XOFF)

::: tip Why Ctrl+C works on frozen programs
When you press Ctrl+C, the terminal emulator writes byte 0x03 to the PTY master. The **kernel line discipline** intercepts it before the application ever sees it, and sends SIGINT to the entire foreground process group. This is why Ctrl+C works even when the application is stuck in an infinite loop and not reading input — the signal comes from the kernel, not the application.
:::

## TUI Apps Bypass the Line Discipline

Interactive applications like vim, htop, and less need to:

- Receive every keypress immediately (not wait for Enter)
- Handle Ctrl+C themselves (not let the kernel kill them)
- Control exactly what appears on screen (not have the kernel echo input)

They do this by switching to **raw mode** — disabling the line discipline's input processing. See [stty & Line Discipline](/fundamentals/stty) for the details.

In raw mode:

- Every byte is delivered to the application immediately
- No echo, no line editing, no signal generation
- The application is fully responsible for its own display
- Ctrl+C is just byte 0x03 — the application decides what to do with it

This is why exiting a TUI application that crashes can leave your terminal in a broken state — it was in raw mode, and the cleanup code (restoring canonical mode) never ran. The fix is `stty sane` or `reset`.

## Why SSH Works

SSH creates a terminal session across a network by adding a PTY layer on the remote machine:

<div class="architecture-diagram">
<pre>
LOCAL                              REMOTE
┌────────────────┐                ┌─────────────────────────┐
│ Terminal        │                │ Shell (bash)            │
│ Emulator        │                │ reads from PTY slave    │
└───────┬────────┘                └──────────┬──────────────┘
        │ PTY                                │ PTY (remote)
┌───────┴────────┐                ┌──────────┴──────────────┐
│ ssh client     │◄──TCP/SSH──────│ sshd                    │
│ (raw mode)     │────tunnel──────││ (allocates remote PTY) ││
└────────────────┘                └─────────────────────────┘
</pre>
</div>

The ssh client puts the local terminal into raw mode (so the local line discipline doesn't interfere) and tunnels all bytes over the encrypted connection. The SSH server allocates a PTY on the remote machine and connects it to the remote shell. The remote line discipline handles Ctrl+C, echo, and line editing. To the remote shell, it looks like a normal terminal session.

This is why terminal escape sequences work over SSH — they're just bytes flowing through the tunnel. The remote application emits escape sequences as bytes, which flow through the SSH tunnel back to the **local** terminal emulator, which parses and renders them. The remote PTY and line discipline handle input buffering, echo, and signals — not escape sequence rendering.

## Why tmux and screen Add a Layer

Terminal multiplexers insert an **extra PTY** between the terminal emulator and the shell:

<div class="architecture-diagram">
<pre>
┌────────────────────┐
│ Terminal Emulator   │
└────────┬───────────┘
         │ PTY 1
┌────────┴───────────┐
│ tmux server        │  ← Maintains its own virtual terminal buffer
│ (virtual terminal) │  ← Re-renders content to the outer PTY
└────────────────────┘
         │ PTY 2
┌────────┴───────────┐
│ Shell / Application │
└────────────────────┘
</pre>
</div>

The tmux server is both a PTY master (for the shell) and a terminal emulator (parsing escape sequences from the shell, maintaining a screen buffer). It then re-renders that buffer as escape sequences to the outer terminal.

This double-PTY architecture is why:

- **Sessions persist** when you disconnect — the tmux server keeps the inner PTY alive
- **Some escape sequences don't pass through** — tmux must understand and re-emit every escape sequence, and it doesn't support all of them (notably, some modern protocols like Kitty graphics)
- **There's a latency cost** — every byte takes an extra hop through tmux's terminal emulator

::: info Multiplexer pass-through
terminfo.dev tests multiplexer compatibility separately — see the multiplexer results to check which features pass through tmux and screen correctly, and which ones get lost or mangled.
:::

## Process Groups and Job Control

The kernel's TTY subsystem also manages **process groups** — the mechanism behind job control (`fg`, `bg`, Ctrl+Z):

- Each terminal session has a **session leader** (usually the shell)
- The session has one **foreground process group** — the one that receives keyboard signals and can read from the terminal
- Background processes that try to read from the terminal get stopped with SIGTTIN
- Ctrl+Z sends SIGTSTP to the foreground process group, suspending it
- `fg` moves a process group to the foreground; `bg` lets it continue in the background

This is why `Ctrl+Z` works universally — it's handled by the kernel, not the application. And it's why background processes can write to the terminal but can't read from it (they'd compete with the foreground process for input).

## Key Takeaways

| Component                | Responsibility                                                     | Examples                     |
| ------------------------ | ------------------------------------------------------------------ | ---------------------------- |
| Terminal emulator        | Render text, capture input, parse escape sequences                 | Ghostty, Kitty, iTerm2       |
| PTY (kernel)             | Virtual serial device pair connecting emulator to application      | `/dev/pts/N`                 |
| Line discipline (kernel) | Echo, line editing, signals, newline translation                   | `stty` controls its behavior |
| Shell                    | Command interpretation, job control, prompt display                | bash, zsh, fish              |
| Application              | Whatever it does — TUI rendering, file editing, process monitoring | vim, htop, less              |

The terminal emulator and the application never communicate directly. Everything flows through the PTY and the line discipline. This indirection is what makes the entire system work — any terminal emulator can host any application, any application can run in any terminal, and the kernel provides the glue.

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

.architecture-diagram {
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 1em 1.5em;
  margin: 1.5em 0;
  overflow-x: auto;
}

.architecture-diagram pre {
  margin: 0;
  font-size: 0.85em;
  line-height: 1.5;
  color: var(--vp-c-text-1);
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
