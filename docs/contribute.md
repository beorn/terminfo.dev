---
title: Test Your Terminal
description: Test your terminal and contribute reproducible evidence, with clear limits on what each probe can establish
---

# Test Your Terminal

Help measure what your terminal does. A probe can establish a particular behavior in a particular version and configuration; it cannot certify every part of a feature.

```bash
npx terminfo.dev
```

This shows the available commands. Run `npx terminfo.dev detect` to see the detected terminal. The current source's `test` command records one unreviewed run; `submit RAW --draft FILE` prepares an offline contribution draft. Neither command posts a result. Check the installed CLI's `--version` and `--help`: the corrected package is still being verified and older published versions may differ.

`npx` comes with [Node.js](https://nodejs.org/en/download). A fresh terminal window keeps test output separate but does not by itself make that window a disposable test environment. Record whether tmux, Screen or a remote connection is involved.

## Other Commands

```bash
npx terminfo.dev test --json > raw.json                        # One raw run on stdout
npx terminfo.dev test --output /tmp/terminfo-run.json         # New private file at an absolute path
npx terminfo.dev submit /tmp/terminfo-run.json --draft /tmp/terminfo-draft.md # Offline draft and adjacent raw attachment
npx terminfo.dev detect         # Check what terminal was detected
npx terminfo.dev --version      # Record the CLI version
```

For inline `test --json` or `test --output`, stdin must be an interactive terminal; probe controls go to `/dev/tty`, separate from the raw JSON. `--output` refuses an existing file. A draft does not create a GitHub issue or grant publication consent.

In an ordinary terminal, the CLI can run reviewed query checks. Checks that change terminal state require a verified disposable test environment. Without one, the CLI records them as **inconclusive (policy-refused)** before those checks write anything; it does not report them as unsupported. You do not need to loosen terminal permissions. Default clipboard access stays off.

## What a probe can establish

| Method            | Evidence                                                                    | Limit                                                                                             |
| ----------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Query             | The exact reply to a protocol query, such as a mode report                  | Recognizing a mode does not prove every behavior associated with it.                              |
| Behavior          | A measured effect, such as the cursor moving by two cells after text output | Cursor movement cannot establish the shape, color or placement of the rendered glyphs.            |
| Parser state      | Cells, attributes or replies read from a headless engine through Termless   | An engine's state is not a screenshot of its desktop application.                                 |
| Pixels            | A screenshot of the actual terminal running a specified fixture             | A still image establishes only the visible property at that moment, in that environment.          |
| Interaction       | Recorded input and its resulting events or visible behavior                 | Keyboard, mouse, focus and permissions need the relevant action; enabling a mode is insufficient. |
| Consumed sequence | A later reply shows that the terminal continued processing input            | This alone cannot distinguish implementing a sequence from silently ignoring it.                  |

A PNG generated from a Termless cell grid illustrates the headless state; it is not a capture of the terminal application. Claims about rendered pixels require a capture of the actual app and a stated visual assertion.

For example, [Kitty's keyboard query](https://sw.kovidgoyal.net/kitty/keyboard-protocol/#detection-of-support-for-this-protocol) reports protocol state; key-event encoding needs input tests. A [graphics query](https://sw.kovidgoyal.net/kitty/graphics-protocol/#querying-support-and-available-transmission-mediums) and an actual image capture answer different questions. The [xterm control-sequence reference](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html) defines many of the replies used by these probes.

**No reply is inconclusive.** A feature may be unsupported, blocked by a multiplexer or permission, queried incorrectly, or slower than the collection deadline. A policy refusal is also inconclusive, but means the check was deliberately not run in this environment. An explicit negative reply or failed behavioral assertion is stronger evidence. A collection error describes the test run; it is not a terminal failure.

## Reading results

We are correcting older probes and results that treated sequence consumption or a missing reply as a conclusive support result. Historical booleans without the necessary evidence remain unverified; a new label cannot reconstruct evidence that was never captured.

The model being introduced keeps outcome and method together: **supported**, **unsupported**, **inconclusive** or **collection error**, accompanied by the specific assertion and evidence. **Not tested** means there is no applicable observation. Documentation can describe an implementation, but is separate from a measured result. Older scorecards do not yet express all of these distinctions.

Suite completeness and support are different. A complete suite has a recorded outcome for every scheduled probe, including policy refusals and collection errors; it does not mean every check was attempted or produced conclusive evidence. Support asks which measured behaviors worked. An older submission with fewer probes contributes useful history without making its missing features failures. Our target is trustworthy measurements of the stated scope, rather than 100% support from every terminal.

## Contributing screenshots and reproductions

Use `submit RAW --draft FILE` to prepare a local draft and an adjacent content-addressed copy of the exact raw JSON. Review both files before choosing whether to post a GitHub issue; draft creation sends nothing and does not grant consent. A contribution should include:

- The terminal and version, OS version, relevant configuration, font and window size.
- The CLI version, exact command or small reproduction, raw output, run ID and measurement time. Bind screenshots to that same run, fixture and terminal version.
- The behavior you expected, what happened, and whether it repeats in a fresh window.
- For a visual claim, the original screenshot of the test window and the property it demonstrates. A cropped detail can help, but include the full original too.
- For a timing or input issue, the actions and a short recording or event trace.

Capture only the test window and check that attachments contain no private text. Keep an unexpected or failed capture alongside a successful retry; the difference may reveal a test problem or a terminal bug.

## Where the data comes from

Controlled runs and community submissions should use the same versioned probe definitions. Older published CLI packages lag the source suite, so record the version and measured scope rather than assuming the counts match. The community census is not a separate standard of terminal support. Submission alone does not verify a result.

**Reports from the old 111-probe suite need fresh measurements.** We retain those reports as history, but their booleans cannot establish current support. We will rerun accessible terminals ourselves and link the verified results, naming any version or configuration differences. Where we need a contributor's setup, we will provide an exact version and command after the corrected CLI has been verified and released. Keep the original report linked to the new results; missing features are not failures.

The audit trail should let a reader follow a result to its source submission or controlled run, exact terminal or engine identity, probe revision, measurement time, raw replies or image, and any reviewed correction. Captured originals must be retained; corrections explain their scope, reason, sources and reviewer. Missing historical evidence cannot be recovered from a boolean. A page rebuild is not a new measurement.

See [About](/about) for the distinction between terminal apps, headless engines and multiplexers.

## Source Code

Everything is [open source](https://github.com/beorn/terminfo.dev) — code under MIT, data under CC BY 4.0:

- [CLI source](https://github.com/beorn/terminfo.dev/tree/main/packages/terminfo.dev) — what `npx` runs
- [Probe definitions](https://github.com/beorn/terminfo.dev/tree/main/packages/probe-defs) — the shared feature tests
- [npm package](https://www.npmjs.com/package/terminfo.dev) — `terminfo.dev` on npm

Missing your terminal? A reproducible contribution is welcome even when the result is inconclusive.
