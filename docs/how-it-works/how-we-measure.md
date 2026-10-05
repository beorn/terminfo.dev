---
title: How we measure
description: How a probe run works, for real terminal apps and for terminal engines, and where the lab stops
prev:
  text: How it works
  link: /how-it-works/
next:
  text: How to read a result
  link: /how-it-works/how-to-read-a-result
---

[How it works](/how-it-works/) › How we measure

# How we measure

We test terminal apps for real. The app runs in a virtual display in our lab, and for each probe (one scripted test per feature) we capture the screen before and after, together with the app's replies and its cursor position. Terminal engines, the parsing cores inside terminals such as xterm.js or libvterm, have no window to capture. Termless, our headless harness, drives only those, and we read their cells, cursor and modes instead. An engine result says what the engine did, not what a desktop app draws.

Every current result comes from such a run, made in our lab or [contributed](/how-it-works/contribute-a-run) and passed through the same review. The [home page](/) shows what we cover now; each terminal's page names the version, configuration and run behind its results.

## What one run does

1. **Probe.** The bytes to send and the check to make. The probe set is frozen and named by a hash, so every run says exactly which tests ran.
2. **Run.** The terminal starts fresh: default configuration, fixed window size and font (see Test environment on any result). Each probe sends its bytes, then reads the reply, measures the cursor or takes its two screenshots. In an engine, we read the engine's state instead.
3. **Result.** One file per run, named by its SHA-256. It stores the measurement time, the terminal's own identity reply, the hash of the binary that ran, every raw reply and every screenshot, and it is never edited.
4. **Review.** A reviewer reads the file and the original screenshots, decides what the site may show, and may change the grade. The review records a name and a reason, and the recorded grade stays visible. Screenshot results start Inconclusive until a reviewer confirms them ([How to read a result](/how-it-works/how-to-read-a-result)).
5. **Publish.** Site, API and CLI show the same reviewed run. A site rebuild is not a new measurement; a result's time is when it was measured.

A terminal may have one run per permission setting (clipboard access, for example). The home page shows the default; the terminal's page lists the others under "Version and configuration".

## Where the lab stops

- Terminal apps not yet set up in the lab. The [home page](/) shows which have a current result; older runs stay in the API as history.
- Multiplexers such as tmux and GNU Screen, remote sessions, non-default configurations or fonts.
- Features that need a person: text reflow on resize, font ligatures, a paste you start yourself.

For those, see [Contribute a run](/how-it-works/contribute-a-run).
