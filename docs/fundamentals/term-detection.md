---
outline: [2, 3]
prev: false
next: false
---

# Terminal Detection

<p class="page-tagline">How applications discover what your terminal can do</p>

<div class="beginner-intro">
<p>Applications need to know terminal capabilities before using advanced features. But there's no reliable universal method. The ecosystem uses a mix of environment variables, query-response sequences, and databases — each with significant blind spots. Understanding these mechanisms explains why feature detection is hard and why terminfo.dev takes the approach it does.</p>
</div>

## The Problem

When a TUI application starts, it faces a fundamental question: what can this terminal do? Can it render truecolor? Does it support the Kitty keyboard protocol? Will OSC 8 hyperlinks work, or will they spew garbage? The application needs answers before it writes its first escape sequence, because sending an unsupported sequence can corrupt the display or confuse the user.

There is no single reliable mechanism for answering these questions. The traditional approach reads `$TERM` and looks up a terminal description in the terminfo database. That description remains useful, but it may not cover an implementation's extensions or changes in configuration, and it does not measure what happens on the current terminal path.

The result is a patchwork of detection methods. Applications check environment variables, query the terminal with escape sequences, consult databases, and sometimes just guess. Each method has trade-offs between reliability, coverage, and speed. Most applications use several methods together, falling back from one to the next.

## $TERM

The `$TERM` environment variable names the terminal description an application should use. Applications pass it to terminfo to look up capabilities such as color counts, alternate-screen support, and cursor-movement sequences. A multiplexer may set its own value for programs running inside it. [ncurses terminfo(5)](https://invisible-island.net/ncurses/man/terminfo.5.html)

The name selects a description; it need not identify the application drawing the window or verify every operation in that description. For example, Kitty documents its `xterm-kitty` entry and how to make that entry available on a remote host. If an entry is absent there, database-based programs cannot use it as intended. [Kitty FAQ](https://sw.kovidgoyal.net/kitty/faq/)

So `$TERM` is a useful description selector, not an exhaustive capability test. Read the selected entry for what it declares, then use targeted queries or controlled checks when you need evidence about the current path.

::: tip $TERM selects a description, not an exhaustive feature test
Inside a multiplexer, `$TERM` usually describes the multiplexer. Over SSH, a database-based program needs the selected terminfo entry on the remote host. Kitty documents this installation problem and provides ways to copy its entry. [Kitty FAQ](https://sw.kovidgoyal.net/kitty/faq/)
:::

## $COLORTERM

`$COLORTERM` is a convention used to advertise truecolor (24-bit color) support. Values such as `truecolor` or `24bit` are useful hints that an application can try RGB color sequences such as `ESC[38;2;R;G;Bm`; they do not verify the rendered result through every intervening layer.

The [termstandard/colors](https://github.com/termstandard/colors) community project documents the convention. It is not the only way to describe direct color: ncurses also documents an extended `RGB` terminfo capability. An environment value can be absent, inherited, or stale. [ncurses user_caps(5)](https://invisible-island.net/ncurses/man/user_caps.5.html)

`$COLORTERM` concerns color only. It says nothing about underline styles, cursor shapes, clipboard access, graphics, or keyboard protocols. Other environment variables may hint at the launching application, but they are not a universal capability inventory.

## terminfo/termcap

The terminfo database (and its predecessor, termcap) is the traditional solution to terminal capability detection. It's a compiled database that maps terminal names (from `$TERM`) to capability strings. When an application calls `tput colors` or uses the ncurses library, it's querying terminfo. The database contains entries for cursor movement sequences, color support, screen clearing, line insertion, and hundreds of other capabilities. It's maintained by Thomas Dickey alongside ncurses and has been the backbone of terminal application development since the 1980s.

The limitation is the coverage of the selected entry and of the application reading it. Standard terminfo names do not describe every newer protocol, but ncurses supports user-defined Boolean, numeric, and string capabilities. Its documented extensions include `RGB` and mouse controls. [ncurses user_caps(5)](https://invisible-island.net/ncurses/man/user_caps.5.html)

Extended names still need a producer, an installed entry, and applications that understand them. Moreover, a terminfo entry describes expected behavior; it does not record what happened in a live check. This is why runtime observations complement the database rather than replace it. [ncurses terminfo(5)](https://invisible-island.net/ncurses/man/terminfo.5.html)

## DA1 (Primary Device Attributes)

DA1 is an escape sequence query: the application sends `CSI c` (or `CSI 0 c`) and the terminal responds with a list of capability flags. The response format is `CSI ? Ps ; Ps ; ... c`, where each `Ps` is a numeric code indicating a supported feature class. For example, a response of `CSI ? 62 ; 1 ; 2 ; 6 ; 7 ; 8 ; 9 c` says "I'm a VT220-class terminal that supports these attribute groups."

DA1 reports device-attribute codes, not an exact product identity. The codes describe broad categories such as 132-column mode, a printer port, or Sixel graphics; they do not verify those features' behavior in the current session. [xterm control sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)

DA1 can also serve as a **sentinel** after another query. A complete reply correlated to that query establishes only the property the reply reports, whether or not DA1 subsequently answers. If no matching reply arrives before the sentinel or deadline, the result is inconclusive; a missing or ambiguous DA1 reply cannot turn silence into evidence of non-support. [Kitty keyboard protocol detection](https://sw.kovidgoyal.net/kitty/keyboard-protocol/#detection-of-support-for-this-protocol)

## DECRPM (Mode Report)

DECRPM — DEC Private Mode Report — replies to a DECRQM request for one private mode. The application sends `CSI ? Pm $ p` (where `Pm` is the mode number), and the responding layer returns `CSI ? Pm ; Ps $ y`, where `Ps` indicates the reported mode status: **1** = set, **2** = reset, **3** = permanently set, **4** = permanently reset, **0** = not recognized. [xterm control sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)

Many features have private-mode numbers, including bracketed paste (2004), mouse tracking (1000/1002/1003/1006), focus tracking (1004), alternate screen (1049), and synchronized output (2026). A valid correlated reply reports whether the responding layer recognizes the requested mode and its current state. It does not by itself verify rendering or interaction associated with that mode.

No reply is inconclusive: the layer might not implement DECRQM, or the reply might not reach the application. DECRPM also cannot describe features without a corresponding private-mode query, such as OSC 8 hyperlinks or Kitty graphics. Those need other queries or controlled behavioral observations.

## XTVERSION

XTVERSION sends `CSI > 0 q` and, when implemented, returns `DCS > | text ST`. The text is supplied by the responding layer; its spelling and version format are implementation-specific. [xterm control sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)

The reply may identify an intermediate layer such as tmux rather than the outer graphical terminal. A name and version can guide a compatibility table, but that table predicts expected capabilities; it does not measure the installed configuration or the end-to-end path. [tmux manual](https://github.com/tmux/tmux/blob/master/tmux.1)

Using a version table requires maintaining its entries as implementations change. Where the behavior matters, a query or controlled test of that behavior provides narrower, stronger evidence. If no XTVERSION reply arrives, the result is inconclusive.

## Runtime Probing

Runtime probing asks what a terminal did in a specified test. A measured reply or effect can answer that test's question more directly than an environment variable or a database entry, but only for the behavior actually observed.

A width test can write a sample character and measure the cursor position afterward. The measured distance says how wide that sample was in that environment; a missing reply is inconclusive. Writing test content changes the terminal, so this check needs a verified disposable test environment. Other probes use DECRPM queries, OSC response parsing, and DA1 sentinels.

[Termless](https://termless.dev) instantiates a headless emulator and reads back its parser state. In an ordinary terminal, the `npx terminfo.dev` CLI runs reviewed queries and records state-changing checks as inconclusive unless a verified disposable test environment is available. A query reply establishes only the property it reports; rendering and interaction require their own observations.

::: info Why terminfo.dev probes directly instead of using terminfo
Terminfo describes capabilities associated with a `$TERM` entry, including [user-defined extensions in ncurses](https://invisible-island.net/ncurses/man/user_caps.5.html). Those descriptions do not record what happened in a particular test. Runtime observations complement them; unanswered or refused checks give no support conclusion. See [Why not terminfo?](/about#why-not-terminfo) for the full rationale.
:::

## Comparing Detection Methods

| Method            | What it provides                                                  | Important limit                                                       |
| ----------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| **$TERM**         | Name of the selected terminal description                         | May name a multiplexer or compatibility entry; not a live test        |
| **$COLORTERM**    | Conventional direct-color hint                                    | May be absent or stale; not a color-rendering test                    |
| **terminfo**      | Capabilities declared by an installed entry, including extensions | Entry and application must understand the capability; not a live test |
| **DA1**           | Reported device-attribute codes, or a sentinel reply              | Not exact product identity or proof of unrelated behavior             |
| **DECRPM**        | Reported recognition and state of one private mode                | Only the responding layer and requested mode; not behavioral proof    |
| **XTVERSION**     | Implementation-supplied name/version text when answered           | May identify an intermediate layer; a lookup predicts behavior        |
| **Runtime check** | Observation of one executed query or behavior                     | Scope is limited to the actual path and observation                   |

SSH can carry terminal input and output, but it does not guarantee that environment variables are forwarded or that a multiplexer passes a query to the outer terminal. [OpenSSH sshd_config(5)](https://man.openbsd.org/sshd_config); [tmux manual](https://github.com/tmux/tmux/blob/master/tmux.1)

## Secondary Environment Hints

Beyond `$TERM` and `$COLORTERM`, some terminals set additional environment variables that hint at which application launched the shell. They are not standardized and may be inherited by later processes.

| Variable                    | Set By                     | Value                                                                |
| --------------------------- | -------------------------- | -------------------------------------------------------------------- |
| **`TERM_PROGRAM`**          | Some terminal applications | Reported application name; may be inherited or overwritten           |
| **`TERM_PROGRAM_VERSION`**  | Some terminal applications | Reported version; a feature table based on it remains a prediction   |
| **`VTE_VERSION`**           | VTE-based terminals        | Encoded VTE version; suggests the launching terminal family          |
| **`KITTY_WINDOW_ID`**       | Kitty                      | Window identifier; suggests a Kitty-launched environment             |
| **`WT_SESSION`**            | Windows Terminal           | Session identifier; suggests a Windows Terminal-launched environment |
| **`GHOSTTY_RESOURCES_DIR`** | Ghostty                    | Resource path; suggests a Ghostty-launched environment               |
| **`ITERM_SESSION_ID`**      | iTerm2                     | Session identifier; suggests an iTerm2-launched environment          |

These variables are fast to check, but their presence is not a current-path capability test. A query such as XTVERSION or DECRQM asks the responding layer a narrower question; its reply must still be interpreted within that protocol.

::: warning Intermediate layers change what you can observe
SSH forwarding is configurable, while `$TERM` is sent with an allocated PTY. A multiplexer may overwrite, retain, or add environment variables and may answer or filter terminal queries. Neither an inherited variable nor a query reply automatically identifies the outer graphical terminal. [OpenSSH ssh_config(5)](https://man.openbsd.org/ssh_config); [tmux manual](https://github.com/tmux/tmux/blob/master/tmux.1)
:::

## Multiplexer and SSH Caveats

Terminal detection gets significantly harder when multiplexers (tmux, screen, Zellij) or SSH sessions sit between the application and the real terminal. Each layer can distort the signals that detection mechanisms rely on.

**tmux sets `$TERM` for its panes.** The value names the description tmux exposes to applications, rather than the outer terminal's description. That is the relevant interface for an application running in the pane. [tmux manual](https://github.com/tmux/tmux/blob/master/tmux.1)

**SSH forwards selected environment variables.** `SendEnv` and `AcceptEnv` control additional variables; with a requested PTY, `$TERM` is sent as part of the protocol. Do not assume variables such as `COLORTERM` or `TERM_PROGRAM` arrive unchanged. [OpenSSH ssh_config(5)](https://man.openbsd.org/ssh_config); [OpenSSH sshd_config(5)](https://man.openbsd.org/sshd_config)

**Nested sessions compound the problem.** An application running in tmux on a remote host sees the environment and terminal behavior exposed through both SSH and tmux. Neither the presence nor the absence of a particular environment variable establishes the outer terminal's identity.

**Query the exposed layer.** SSH carries terminal input and output, but tmux may answer, filter, or relay a query. A response describes the layer that answered it. tmux also documents a DCS passthrough mechanism controlled by `allow-passthrough`; it is not a promise that ordinary queries reach the outer terminal. [tmux manual](https://github.com/tmux/tmux/blob/master/tmux.1)

::: tip Detection strategy inside multiplexers

1. Check the selected `$TERM` entry for the interface exposed to your application.
2. Query a specific mode when the responding layer implements DECRQM; treat silence as inconclusive.
3. If you explicitly use tmux passthrough, check its `allow-passthrough` setting and validate the reply's origin. [tmux manual](https://github.com/tmux/tmux/blob/master/tmux.1)
   :::

## Practical Detection Recipes

Here are minimal, copy-pasteable examples for the most common detection tasks.

### Bash: check truecolor hints

```bash
hints_truecolor() {
  case "${COLORTERM-}" in
    truecolor|24bit) return 0 ;;
  esac
  # Fallback: check TERM for a direct-color description name
  case "$TERM" in
    *-direct|*-truecolor) return 0 ;;
  esac
  return 1
}

if hints_truecolor; then
  printf '\e[38;2;255;100;0mTruecolor requested\e[0m\n'
fi
```

### Python: query DA1 with timeout

This small example returns unparsed bytes. It does not verify that a complete DA1 reply arrived or establish support for another feature.

```python
import sys, os, select, termios, tty

def query_da1(timeout=0.5):
    """Send DA1, return response string or None."""
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        os.write(sys.stdout.fileno(), b'\x1b[c')  # DA1 query
        if select.select([fd], [], [], timeout)[0]:
            resp = b''
            while select.select([fd], [], [], 0.05)[0]:
                resp += os.read(fd, 256)
            return resp.decode('ascii', errors='replace')
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
    return None
```

### JavaScript (Node.js): collect environment hints

```js
function environmentHints() {
  const env = process.env
  return {
    truecolorHint: /^(truecolor|24bit)$/i.test(env.COLORTERM ?? ""),
    term: env.TERM ?? "unknown",
    program: env.TERM_PROGRAM ?? null,
    version: env.TERM_PROGRAM_VERSION ?? null,
    isTmux: "TMUX" in env,
    isSSH: "SSH_TTY" in env || "SSH_CLIENT" in env,
    kittyLaunchHint: "KITTY_WINDOW_ID" in env,
    color256DescriptionHint: /256color/.test(env.TERM ?? ""),
  }
}
```

The Bash and JavaScript examples inspect hints, not terminal behavior; the Python example returns unparsed query bytes. For one raw observation run in an interactive TTY, use `npx terminfo.dev test --json`. The `detect` command uses environment and local application metadata; it does not run the probe suite.

## What Developers Should Do

For maximum compatibility, use a layered detection strategy. Start with `$TERM` to select a terminal description and `$COLORTERM` as a color hint. Read the entry rather than inferring all of its capabilities from its name. If accurate color behavior matters, test it on the actual terminal path.

For specific features, ask a specific question. DECRQM can report whether the responding layer recognizes a private mode and its current state. XTVERSION can report that layer's name and version; a version table is a prediction, not a behavioral measurement. DA1 can help delimit unanswered queries, but a complete correlated reply establishes its scoped result even if DA1 never arrives.

Most importantly, **degrade gracefully**. Do not treat `xterm-256color` as full xterm compatibility or a missing DECRPM reply as proof of non-support. Keep fallbacks for color, underlines, and keyboard input when a capability is unknown or unavailable. Match each conclusion to what was actually declared or observed.

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
