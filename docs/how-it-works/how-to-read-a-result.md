---
title: How to read a result
description: What each result label means and cannot show, and what "corrected after review" and Review history are
prev:
  text: How we measure
  link: /how-it-works/how-we-measure
next:
  text: Contribute a run
  link: /how-it-works/contribute-a-run
---

[How it works](/how-it-works/) › How to read a result

# How to read a result

Every result carries one label: the outcome, then the evidence or the reason, as in "Supported: verified in screenshot" or "Inconclusive: no reply". Each label on the site links to its entry here. A page that shows a single result may name what was checked: "Supported: underline shows in screenshot", "Supported: bracketed paste reported in terminal response". A missing reply is Inconclusive, never Unsupported.

## Supported and Unsupported: verified in …

Supported: the effect happened. Unsupported: the same kind of check showed it did not. The second half names the evidence and the limit of the claim.

- **… verified in screenshot** — before-and-after screenshots of the real app, compared by a reviewer. Only that moment, version and configuration; nothing outside the frames.
- **… verified in terminal response** — the terminal's reply to our query. Not how the feature looks or behaves.
- **… verified in measured behavior** — a measured effect, such as the cursor moving two cells after one emoji. Not how it looked.
- **… verified in engine state** — the cells, cursor or modes of a terminal engine run without a window. Not what a desktop app draws.
- **… verified in input test** — an input action during the test and what followed. Only what that input tried.

## "Corrected after review"

A program does not judge pictures, so every screenshot result is recorded as "Inconclusive: the screenshots alone do not settle it". A reviewer compares the two frames and, where the effect is there, changes it to "Supported: verified in screenshot", with a name and a reason. The notice means the shown grade differs from the recorded one, not that a mistake was found.

## Inconclusive

Inconclusive means we could not tell, not that the feature failed.

- **Inconclusive: no reply** and **Inconclusive: no reply in time** — the terminal may not know the query, or may ignore it.
- **Inconclusive: the reply was not in the expected form** — we do not grade a reply we cannot parse.
- **Inconclusive: the terminal refused permission** — it said no at run time, such as a denied clipboard read.
- **Inconclusive: we did not send it** — the run skipped this probe, for example because it would change the terminal's state; we send such probes only to a disposable test terminal.
- **Inconclusive: the terminal accepted it, but nothing visible changed** — the terminal kept working, but we saw no effect to grade. An ignored sequence also keeps working, so this cannot tell acting from ignoring.
- **Inconclusive: what we saw does not settle it** — a reply, measurement or engine state was recorded, but proves nothing either way.
- **Inconclusive: the screenshots alone do not settle it** — the screenshots were taken, but no reviewer has confirmed the effect in them; see "Corrected after review" above.

## No grade

- **Not graded: old result, kept without evidence** — a pass/fail from before we kept evidence; it cannot be graded now.
- **Probe error: our test failed** — nothing about the terminal.
- **Not tested: not in this run** — the run did not include this feature, for example because its probe came later. Not a deliberate skip, and not Unsupported.
- **No result: no reviewed run for this terminal yet** — see [Contribute a run](/how-it-works/contribute-a-run).

## Review history

A collapsible section at the bottom of the result details, next to the evidence:

- **Review history** — the recorded result, who changed it and why, and the **Evidence publication check**: the approval to show this result's own screenshots or raw reply. Without it, the page shows no images and says so.
- **Screenshots** — the two frames, each with capture time, SHA-256 and a link to the original.
- **Technical details · raw trace** — the raw bytes.
- **Current probe guidance** — what the probe checks today; a description, not evidence.
- **Test environment** — terminal, version, OS, configuration, measurement time, run ID and the run file's SHA-256, which your browser checks when it loads the evidence.
