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

A result label states the outcome, then the evidence or the reason, as in "Supported: verified in screenshot" or "TEST FAILURE: the attempted query produced no usable result". A page that shows a single result may name what was checked: "Supported: underline shows in screenshot", "Supported: bracketed paste reported in terminal response". TEST TODO means required work remains, including an unattempted probe or a required review. TEST FAILURE means an attempted check broke or could not produce a valid result; a functioning oracle's documented negative result is Unsupported instead.

## Supported and Unsupported: verified in …

Supported: the effect happened. Unsupported: the same kind of check showed it did not. The second half names the evidence and the limit of the claim.

- **… verified in screenshot** — before-and-after screenshots of the real app, compared by a reviewer. Only that moment, version and configuration; nothing outside the frames.
- **… verified in terminal response** — the terminal's reply to our query. Not how the feature looks or behaves.
- **… verified in measured behavior** — a measured effect, such as the cursor moving two cells after one emoji. Not how it looked.
- **… verified in engine state** — the cells, cursor or modes of a terminal engine run without a window. Not what a desktop app draws.
- **… verified in input test** — an input action during the test and what followed. Only what that input tried.

## "Corrected after review"

Automated image checks can decide criteria with machine-readable comparisons. When a criterion requires independent visual review, only that result remains TEST TODO until the review is complete. The reviewer compares the frames and, where the effect is there, changes it to "Supported: verified in screenshot", with a name and a reason. The notice means the shown grade differs from the recorded one, not that a mistake was found.

## Untestable, TEST TODO and TEST FAILURE

**Untestable** means a reviewer established that this context cannot expose the feature. **TEST TODO** means required work remains, including an unattempted probe or a pending review. **TEST FAILURE** means an attempted check broke or could not produce a valid result; it describes the test, not the terminal.

- **TEST FAILURE: no usable reply** or **TEST FAILURE: no reply in time** — the query was attempted, but no result arrived before the deadline and no documented negative response established Unsupported.
- **TEST FAILURE: the reply was not in the expected form** — we do not grade a reply we cannot parse.
- **TEST TODO: permission prevented the query from starting** — no measurement was attempted.
- **TEST FAILURE: an attempted permission check did not produce a valid result** — a denial is a failure only when the attempted check did not establish a documented negative result.
- **TEST TODO: the probe was not sent** — the run skipped this probe, for example because it would change the terminal's state; we send such probes only to a disposable test terminal.
- **TEST FAILURE: the terminal accepted the query, but nothing visible changed** — this is a failure when the required observation did not resolve the claim; a validated negative oracle can establish Unsupported instead.
- **TEST FAILURE: the attempt did not establish a result** — a reply, measurement or engine state was recorded, but proves nothing either way.
- **TEST TODO: screenshots await review** — the screenshots were taken, but no reviewer has confirmed the effect in them; see "Corrected after review" above.

## No grade

- **TEST TODO: no reviewed evidence** — an old result without evidence does not establish a current status.
- **TEST FAILURE: the test did not complete** — this describes the attempt, not the terminal.
- **Untestable** — a reviewer confirmed this context has no observable that can measure the feature; the reviewed reason names what is unavailable.
- **TEST TODO** — no attempt or reviewed impossibility record covers this feature in the selected run. This does not mean Unsupported.
- **TEST TODO: no reviewed run for this terminal yet** — see [Contribute a run](/how-it-works/contribute-a-run).

## Review history

A collapsible section at the bottom of the result details, next to the evidence:

- **Review history** — the recorded result, who changed it and why, and the **Evidence publication check**: the approval to show this result's own screenshots or raw reply. Without it, the page shows no images and says so.
- **Screenshots** — the two frames, each with capture time, SHA-256 and a link to the original.
- **Technical details · raw trace** — the raw bytes.
- **Current probe guidance** — what the probe checks today; a description, not evidence.
- **Test environment** — terminal, version, OS, configuration, measurement time, run ID and the run file's SHA-256, which your browser checks when it loads the evidence.
