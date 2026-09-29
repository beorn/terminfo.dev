---
title: Test Your Terminal
description: Test your terminal and contribute reproducible evidence, with clear limits on what each probe can establish
---

# Test Your Terminal

Help measure what your terminal does. A probe can establish a particular behavior in a particular version and configuration; it cannot certify every part of a feature.

```bash
npx terminfo.dev
```

This shows your detected terminal and available commands. Run `test` to see your scorecard, or `submit` to send results for review through a GitHub issue.

`npx` comes with [Node.js](https://nodejs.org/en/download). Use a fresh terminal window for testing, and record whether tmux, Screen or a remote connection is involved.

## Other Commands

```bash
npx terminfo.dev test --json    # Machine-readable output
npx terminfo.dev detect         # Check what terminal was detected
npx terminfo.dev --version      # Record the CLI version
```

## What a probe can establish

| Method            | Evidence                                                                    | Limit                                                                                             |
| ----------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Query             | The exact reply to a protocol query, such as a mode report                  | Recognizing a mode does not prove every behavior associated with it.                              |
| Behavior          | A measured effect, such as the cursor moving by two cells after text output | Cursor movement cannot establish the shape, color or placement of the rendered glyphs.            |
| Parser state      | Cells, attributes or replies read from a headless engine through Termless   | An engine's state is not a screenshot of its desktop application.                                 |
| Pixels            | A screenshot of the actual terminal running a specified fixture             | A still image establishes only the visible property at that moment, in that environment.          |
| Interaction       | Recorded input and its resulting events or visible behavior                 | Keyboard, mouse, focus and permissions need the relevant action; enabling a mode is insufficient. |
| Consumed sequence | A later reply shows that the terminal continued processing input            | This alone cannot distinguish implementing a sequence from silently ignoring it.                  |

For example, [Kitty's keyboard query](https://sw.kovidgoyal.net/kitty/keyboard-protocol/#detection-of-support-for-this-protocol) reports protocol state; key-event encoding needs input tests. A [graphics query](https://sw.kovidgoyal.net/kitty/graphics-protocol/#querying-support-and-available-transmission-mediums) and an actual image capture answer different questions. The [xterm control-sequence reference](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html) defines many of the replies used by these probes.

**No reply is inconclusive.** A feature may be unsupported, blocked by a multiplexer or permission, queried incorrectly, or slower than the collection deadline. An explicit negative reply or failed behavioral assertion is stronger evidence. A collection error describes the test run; it is not a terminal failure.

## Reading results

We are correcting older probes and results that treated sequence consumption or a missing reply as a conclusive support result. Historical booleans without the necessary evidence remain unverified; a new label cannot reconstruct evidence that was never captured.

The model being introduced keeps outcome and method together: **supported**, **unsupported**, **inconclusive** or **collection error**, accompanied by the specific assertion and evidence. **Not tested** means there is no applicable observation. Documentation can describe an implementation, but is separate from a measured result. Older scorecards do not yet express all of these distinctions.

Coverage and support are different. Coverage asks how much of the intended suite was measured; support asks which measured behaviors worked. An older submission with fewer probes contributes useful history without making its missing features failures. Our target is complete, trustworthy measurements of the stated scope, rather than 100% support from every terminal.

## Contributing screenshots and reproductions

Use `submit` to contribute through the existing GitHub issue flow. Include:

- The terminal and version, OS version, relevant configuration, font and window size.
- The CLI version, exact command or small reproduction, and raw output.
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
