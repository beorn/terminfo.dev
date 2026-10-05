---
title: Contribute a run
description: Run the probes on a setup we have not measured, and send us the raw result for review
prev:
  text: How to read a result
  link: /how-it-works/how-to-read-a-result
next: false
---

[How it works](/how-it-works/) › Contribute a run

# Contribute a run

We run the probes ourselves on everything our lab can hold ([How we measure](/how-it-works/how-we-measure)). If your terminal, OS or setup has no current result on the [home page](/), or you use tmux, GNU Screen, a remote session or a non-default configuration, you can run the probes and send us the result.

## Run the probes

You need Node.js 24 or newer. These commands use the released CLI 4.0.0; record its version with the run.

```bash
npx terminfo.dev@4.0.0 --version                         # record the CLI version
npx terminfo.dev@4.0.0 detect                            # check which terminal it sees
npx terminfo.dev@4.0.0 test --output /tmp/terminfo-run.json # save one raw run to a new file
npx terminfo.dev@4.0.0 submit /tmp/terminfo-run.json --draft /tmp/terminfo-draft.md
```

`test` sends the probes to your terminal and records the replies. It never sends a probe that would change your terminal's state; each such probe is recorded as "Inconclusive: we did not send it", so the run stays complete. Leave your terminal's permissions as they are; clipboard access stays off.

`submit --draft` writes two files and posts nothing: the draft issue at the path you gave, and next to it an exact copy of the raw run named `<sha256>.json`.

## Send it

Read both files. Then open an issue yourself at [github.com/beorn/terminfo.dev/issues](https://github.com/beorn/terminfo.dev/issues): paste the draft as the issue text, attach the `<sha256>.json` file (not the `--output` file), and keep the consent line the draft contains:

> I dedicate these results to the public domain (CC0 1.0) so terminfo.dev can publish them under any license.

We publish a contributed run only with that line. Add to the issue:

- terminal and version, OS version, configuration, font and window size;
- whether tmux, Screen or a remote connection is involved;
- what you expected and what happened;
- for a visual claim, the original screenshot showing only the test window, with no private text.

## What happens next

1. **Identity.** The terminal's own reply inside the run, and its version, must match the terminal you name.
2. **Scope.** A partial run is kept as history, not shown as current support. Missing probes are not failures.
3. **Evidence.** Each result is graded by its evidence, with the same rules as a lab run. A screenshot claim needs the original image.
4. **Review.** A reviewer writes a named, reasoned interpretation. Your raw file stays unchanged and is retained with the review.

An accepted, complete run can become the current result for its recorded setup, with its run ID and measurement time. Older runs stay in the API as history. Review and requests for missing evidence belong in your submission issue, which retains your contribution and discussion.
