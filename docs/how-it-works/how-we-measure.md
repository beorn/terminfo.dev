---
title: How we measure
description: How a run works, for real terminal apps and for terminal engines, and where the lab stops
prev:
  text: How it works
  link: /how-it-works/
next:
  text: How to read a result
  link: /how-it-works/how-to-read-a-result
---

[How it works](/how-it-works/) › How we measure

# How we measure

We test terminal apps for real. The app runs in a virtual display in our lab, and each probe makes the test its feature needs: a reply, cursor measurement or, for visual effects, before-and-after screenshots. Terminal engines, the parsing cores inside terminals such as xterm.js or libvterm, have no window to capture. Termless, our headless test tool, drives only those, and we read their cells, cursor and modes instead. An engine result says what the engine did, not what a desktop app draws.

Every current result comes from such a run, made in our lab or [contributed](/how-it-works/contribute-a-run) and recorded under the same result model. The [home page](/) shows what we cover now; each terminal's page names the version, configuration and run behind its results.

A probe collects evidence as one of six **assertion types**: `query_reply`, the terminal's answer to a query; `buffer_state`, the cells, cursor and modes read from the engine, or the state an app's own public reader reports (iTerm2's prompt marks through its API); `screenshot`, captured pixels; `input_bytes`, the bytes an app received for an OS input event; `clipboard`, what an OSC 52 write put on the clipboard; or `process_environment`, an allowlisted export observed in the terminal's child with matching launch and run controls. What the probe read is separate from the rule that judges it. A reply can establish a reported value; it cannot establish how a glyph or image was rendered.

Every app is measured at its shipped defaults. An observer-only switch is allowed when it changes nothing the terminal renders or sends to the application. A setting that changes behaviour is not. Turning on iTerm2's API server (`EnableAPIServer`) is such a switch: it only lets the probe read state iTerm2 already holds. Because it changes nothing being measured, it is not part of the configuration that names a terminal's context; the run records it as an observer switch beside that configuration.

An **observation** is what the probe recorded. An **assertion** compares expected with actual. The **result** is the reported conclusion. These meanings apply when the decision comes from a valid same-run automatic comparison.

## What one run does

1. **Probe.** The bytes to send and the test to make. The probe set is frozen and named by a hash, so each run names the scheduled tests and records its measurements and coverage.
2. **Run.** The lab uses a fresh terminal with a recorded configuration, window size and font; permission settings can differ between runs (see Test environment). Each probe sends its bytes, then reads the reply, measures behavior or captures frames for a visual test. In an engine, we read the engine's state instead.
3. **Result.** Each current run records the measurement time, target version and configuration, a result for each probe, retained raw replies, assertions and screenshot references. Historical raw files retain their original format. Images are separate artifacts. Identity evidence depends on the target: app provenance can include executable hashes, while engine records identify the loaded source or binary. Missing identity evidence is not filled in. Stored run bytes are not edited.
4. **Finalize.** Automatic comparisons record their results. A criterion with no same-run pixel check, or an image test that cannot produce a valid result, is left blank: a result we haven't decided ([How to read a result](/how-it-works/how-to-read-a-result)).
5. **Publish.** Site, API and CLI show selected stored results. A site rebuild is not a new measurement; a result's time is when it was measured.

Only same-run checks decide a result; no review of retained evidence changes it. Collection, storing a run and selecting results for the site are separate steps.

A terminal may have one run per permission setting (clipboard access, for example). The home page shows the default; the terminal's page lists the others under "Version and configuration".

## Where the lab stops

- Terminal apps not yet set up in the lab. The [home page](/) shows which have a current result; older runs stay in the API as history.
- Multiplexers such as tmux and GNU Screen, remote sessions, non-default configurations or fonts.
- Features that need a person: text reflow on resize, font ligatures, a paste you start yourself.

For those, see [Contribute a run](/how-it-works/contribute-a-run).
