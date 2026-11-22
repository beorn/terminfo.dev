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

<script setup>
// #37761: the one home of what each bar category means; every bar's popover reads the same lines.
import { RESULT_CATEGORIES } from '../data/result-categories.ts'
</script>

[How it works](/how-it-works/) › How to read a result

# How to read a result

A result is Supported, Unsupported or Untestable. It states the outcome, then the evidence or the reason, as in "Supported: verified in screenshot" or "Unsupported: verified in terminal response". A page that shows a single result may name what was checked: "Supported: underline shows in screenshot", "Supported: bracketed paste reported in terminal response". A result we haven't decided is left blank: the cell shows "—" with no label, and its hover reads "No result yet". A blank is not Unsupported, and it is left out of the support counts.

## Supported and Unsupported: verified in …

Supported: the effect happened. Unsupported: the same kind of test showed it did not. The second half names the evidence and the limit of the claim.

- **… verified in screenshot** — before-and-after screenshots of the real app, compared by a pixel check in the same run. Only that moment, version and configuration; nothing outside the frames.
- **… verified in terminal response** — the terminal's reply to our query. Not how the feature looks or behaves.
- **… verified in measured behavior** — a measured effect, such as the cursor moving two cells after one emoji. Not how it looked.
- **… verified in engine state** — the cells, cursor or modes of a terminal engine run without a window. Not what a desktop app draws.
- **… verified in input test** — an input action during the test and what followed. Only what that input tried.

## Assertion types and decisions

An observation's **assertion type** says what kind of evidence the probe read: `query_reply`, `buffer_state`, `screenshot`, `input_bytes`, `clipboard` or `process_environment`. The last reads an allowlisted export in the terminal's child with matching launch, run, process and TTY controls; it does not describe the collector parent's environment. The decision rule says what that evidence establishes. A query reply, an engine-state reader, a terminal text-buffer readback and a screen capture answer different questions; they are not a ranked ladder. For example, reading a changed and restored color value can decide a color-reset claim, while a claim about the rendered color needs appropriate image evidence.

A successful capture does not itself establish the visual effect; only a same-run pixel check decides it. Missing authorization or a tool we have not built yet can leave a required test unstarted; other evidence does not turn that missing measurement into Unsupported or Untestable.

<span id="untestable-probe-todo-and-probe-invalid" aria-hidden="true"></span>

## Untestable and blank results {#untestable-and-blank-results}

**Untestable** carries an explicit reason: **passed to the app**, **no way**, **no setup**, or **no observer**. A generic hook can pass an app-job command to the app without implementing its effect; real library state or a typed notification store can still establish Supported. A tap on a library-job command may instead say **no way to tell**, and an effect the library keeps nothing of its own for may say **app**. An effect that shows outside what the run captures says **no observer**: OSC 9;4 progress appears in a title bar, tab bar or taskbar, so a run that captures only the window cannot tell an ignored command from a consumed one. A step that can only be measured after an earlier step, such as leaving the alternate screen after entering it, reads Untestable (**no setup**) when the same run read that earlier step Unsupported; its reason names the earlier step and its result, and the earlier step keeps its own result. Missing controls or an undeclared engine identity leave the result blank. A **blank** result is one we haven't decided: the test has not run, or it ran and could not produce a valid result. A blank describes our test, not the terminal.

A result is left blank when:

- **no usable reply, or no reply in time** — the query was sent, but no result arrived before the deadline and no documented negative reply established Unsupported.
- **the reply was not in the expected form** — we cannot derive Supported or Unsupported from a reply we cannot parse.
- **permission stopped the query from starting** — nothing was measured.
- **a permission test did not produce a valid result** — a denial reads Unsupported only when the test established a documented negative result.
- **the probe was not sent** — the run skipped this probe, for example because it would change the terminal's state; we send such probes only to a disposable test terminal.
- **the terminal accepted the query, but nothing visible changed** — the required observation did not settle the claim; a negative check we have validated can establish Unsupported instead.
- **the attempt did not establish a result** — a reply, measurement or engine state was recorded, but proves nothing either way.
- **screenshots await a pixel check** — the screenshots were taken, but no same-run pixel check decided the effect in them.
- **the measured contexts disagree** — two contexts that measured the same release decided differently.

## Other feature results

- **No reviewed evidence** — an old result without evidence is left blank; it does not establish a current status.
- **The test did not complete** — the result is left blank; this describes the attempt, not the terminal.
- **Untestable** — the admitted result names why this context cannot decide the feature: passed to the app, no way, no setup, or no observer.
- **No test in the selected run** — the result is left blank. This does not mean Unsupported.
- **No reviewed run for this terminal yet** — the result is left blank; see [Contribute a run](/how-it-works/contribute-a-run).

## A terminal's bar {#a-terminals-bar}

Each terminal's bar sorts its features into these groups. Hover, tap or focus a part of the bar to list the features in it, each linked to its result.

<ul class="result-list bar-categories">
  <li v-for="category in RESULT_CATEGORIES" :key="category.id"><span class="result-row"><span class="result-mark" aria-hidden="true">{{ category.mark }}</span><span><strong>{{ category.label }}</strong> — {{ category.meaning }}</span></span></li>
</ul>

## Result history

A collapsible section at the bottom of the result details, next to the assertionType:

- **Result history** — the recorded result and the **evidence presentation approval**: the approval to show this result's own screenshots or raw reply. Without it, the page shows no images and says so.
- **Screenshots** — the two frames, each with capture time, SHA-256 and a link to the original.
- **Technical details · raw trace** — the raw bytes.
- **Current probe guidance** — what the probe tests today; a description, not evidence.
- **Test environment** — terminal, version, OS, configuration, measurement time, run ID and the run file's SHA-256, which your browser tests when it loads the evidence.
