---
title: How to read a result
description: What each result label means and cannot show, and what Result history is
prev:
  text: How we measure
  link: /how-it-works/how-we-measure
next:
  text: Contribute a run
  link: /how-it-works/contribute-a-run
---

[How it works](/how-it-works/) › How to read a result

# How to read a result

A result label states the outcome, then the evidence or the reason, as in "Supported: verified in screenshot" or "PROBE INVALID: the attempted query produced no usable result". A page that shows a single result may name what was checked: "Supported: underline shows in screenshot", "Supported: bracketed paste reported in terminal response". PROBE TODO means required work remains, including an unattempted probe or a missing observable. PROBE INVALID means an attempted test broke or could not produce a valid result; a functioning oracle's documented negative result is Unsupported instead.

## Supported and Unsupported: verified in …

Supported: the effect happened. Unsupported: the same kind of test showed it did not. The second half names the evidence and the limit of the claim.

- **… verified in screenshot** — before-and-after screenshots of the real app, compared by a pixel check in the same run. Only that moment, version and configuration; nothing outside the frames.
- **… verified in terminal response** — the terminal's reply to our query. Not how the feature looks or behaves.
- **… verified in measured behavior** — a measured effect, such as the cursor moving two cells after one emoji. Not how it looked.
- **… verified in engine state** — the cells, cursor or modes of a terminal engine run without a window. Not what a desktop app draws.
- **… verified in input test** — an input action during the test and what followed. Only what that input tried.

## Assertion types and decisions

An observation's **assertion type** says what kind of evidence the probe read: `query_reply`, `buffer_state`, `screenshot`, `input_bytes` or `clipboard`. The decision rule says what that evidence establishes. A query reply, an engine-state reader, a terminal text-buffer readback and a screen capture answer different questions; they are not a ranked ladder. For example, reading a changed and restored color value can decide a color-reset claim, while a claim about the rendered color needs appropriate image evidence.

A successful capture does not itself establish the visual effect; only a same-run pixel check decides it. Missing authorization or a tool we have not built yet can leave a required test unstarted; other evidence does not turn that missing measurement into Unsupported or Untestable.

## Untestable, PROBE TODO and PROBE INVALID

**Untestable** has no current route: no result reaches it until a per-kind declaration exists. **PROBE TODO** means required work remains, including an unattempted probe or a missing observable. **PROBE INVALID** means an attempted test broke or could not produce a valid result; it describes the test, not the terminal.

- **PROBE INVALID: no usable reply** or **PROBE INVALID: no reply in time** — the query was attempted, but no result arrived before the deadline and no documented negative response established Unsupported.
- **PROBE INVALID: the reply was not in the expected form** — we cannot derive a Supported or Unsupported probe result from a reply we cannot parse.
- **PROBE TODO: permission prevented the query from starting** — no measurement was attempted.
- **PROBE INVALID: an attempted permission test did not produce a valid result** — a denial is a failure only when the attempted test did not establish a documented negative result.
- **PROBE TODO: the probe was not sent** — the run skipped this probe, for example because it would change the terminal's state; we send such probes only to a disposable test terminal.
- **PROBE INVALID: the terminal accepted the query, but nothing visible changed** — this is a failure when the required observation did not resolve the claim; a validated negative oracle can establish Unsupported instead.
- **PROBE INVALID: the attempt did not establish a result** — a reply, measurement or engine state was recorded, but proves nothing either way.
- **PROBE TODO: screenshots await a pixel check** — the screenshots were taken, but no same-run pixel check decided the effect in them.

## Other feature results

- **PROBE TODO: no reviewed evidence** — an old result without evidence does not establish a current status.
- **PROBE INVALID: the test did not complete** — this describes the attempt, not the terminal.
- **Untestable** — this context has no observable that can measure the feature. No current route reaches it.
- **PROBE TODO** — no attempt covers this feature in the selected run. This does not mean Unsupported.
- **PROBE TODO: no reviewed run for this terminal yet** — see [Contribute a run](/how-it-works/contribute-a-run).

## Result history

A collapsible section at the bottom of the result details, next to the assertionType:

- **Result history** — the recorded result and the **evidence presentation approval**: the approval to show this result's own screenshots or raw reply. Without it, the page shows no images and says so.
- **Screenshots** — the two frames, each with capture time, SHA-256 and a link to the original.
- **Technical details · raw trace** — the raw bytes.
- **Current probe guidance** — what the probe tests today; a description, not evidence.
- **Test environment** — terminal, version, OS, configuration, measurement time, run ID and the run file's SHA-256, which your browser tests when it loads the evidence.
