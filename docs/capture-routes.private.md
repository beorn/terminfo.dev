# Capture routes

This repository-facing guide describes reusable capture mechanisms and their limits.
It distinguishes source policy, collector implementation and a measured native result.
One does not establish the others. The filename uses the existing private-page exclusion;
the source repository remains public, so host access details and private evidence stay elsewhere.

## Linux: reuse the existing apparatus

The collector already has owned terminal output, disposable-target binding, clipboard
transactions, input injection and raster acquisition. Extend those routes rather than
creating another provider for each terminal or interpreting coverage cells as source jobs.

| Existing implementation                                                  | Responsibility                                                             |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| [Batch collector](../packages/terminfo.dev/src/probes/unified.ts)        | Select probes and install eligible fixtures.                               |
| [Owned terminal](../packages/terminfo.dev/src/owned-terminal.ts)         | Verify capture/output custody; not authenticate an application name alone. |
| [Disposable receipt](../packages/terminfo.dev/src/disposable-receipt.ts) | Bind a declared target to the measured subject before writes.              |
| [Clipboard transaction](../packages/terminfo.dev/src/linux-clipboard.ts) | Read, control, restore and verify the OS clipboard baseline.               |
| [Input adapter](../packages/terminfo.dev/src/linux-input.ts)             | Supply input through the existing qualified input route.                   |
| [Clipboard callbacks](../packages/probe-defs/src/extensions.ts)          | Decide write, read, roundtrip and paste observations.                      |

The existing outer Kitty/Xclip transaction is one implementation, not separate clipboard
providers for Kitty, tmux and Screen. Its OS-selection restore does not establish that
every mux buffer or title state was restored.

## Default Linux paste and mux OSC52 routes

The batch collector enables the existing clipboard fixture under the `default` profile only
for verified owned Linux runs matching one of these routes:

- **Direct Linux apps (`term/<id>/linux` with matching `app/<id>/linux` disposable target and no `muxAttachmentProof`)**:
  - `extensions.osc52-write` on all five apps (`kitty`, `ghostty`, `alacritty`, `wezterm`, `xterm`).
  - `extensions.clipboard-paste` through each app's default paste action, from the selection that action reads (`LINUX_PASTE_ROUTES` in `unified.ts`, each entry citing its source binding at the pinned version): `Ctrl+Shift+V` from `CLIPBOARD` on `kitty`, `ghostty`, `alacritty` and `wezterm`; `Shift+Insert` from `PRIMARY` on `xterm` 411 (`charproc.c:15024`), whose run alone also owns, restores and verifies a `PRIMARY` baseline. The launch refuses any resource that could rebind it.
  - `extensions.osc52-read` and `extensions.osc52-clipboard` stay outside the default profile, so an unattended default run never meets an ask-first read prompt. They run under the read-allowed route below.
- **Verified Linux multiplexers (`mux/{tmux,screen}/linux` with matching `mux/<id>/linux` disposable target and matching `muxAttachmentProof`)**:
  - `extensions.clipboard-paste`, `modes.bracketed-paste`, `extensions.osc52-write`, `extensions.osc52-read`, and `extensions.osc52-clipboard`.
  - On verified disposable `screen` 5.0.2 (`ansi.c:1186-1188` implements `2004` without `DECRQM`), `extensions.clipboard-paste` sets and restores `CSI ? 2004 l` blind in `finally` and records that blind setup in the observation.
  - `modes.bracketed-paste` asks `DECRPM` first. With no usable reply, or `Ps 0`, it is decided by the same controlled paste read as `extensions.clipboard-paste`, with the same blind setup on Screen (#33058).
  - On `tmux` 3.8, `linux-clipboard.ts` reads `show-options -s -v set-clipboard`, snapshots `list-buffers -F "#{buffer_name}"`, deletes any callback-created paste buffers in `finally`, and verifies post-restore buffer state alongside OS `xclip` restoration; mux OSC52 negatives require default `set-clipboard=external` (`tmux`) or `screen` and record the measured setting.

The focused [routing tests](../packages/terminfo.dev/src/probes/unified.test.ts) use the
existing clipboard transaction with modeled input. They prove fixture selection and the
callback path, including zero OSC52 output. They do not measure a live Kitty/XTEST session.

## Read-allowed clipboard route

A run launched with `--clipboard-profile allow` passes each App its own clipboard-read setting,
read from the App's pinned version (`CLIPBOARD_ALLOW_ARGS` in `linux-clipboard.ts`, #33119):

| App       | Read-allowed launch args                                                                            |
| --------- | --------------------------------------------------------------------------------------------------- |
| kitty     | `-o clipboard_control=write-clipboard read-clipboard`                                               |
| ghostty   | `--clipboard-read=allow`                                                                            |
| alacritty | `-o terminal.osc52="CopyPaste"`                                                                     |
| xterm     | `-xrm '*disallowedWindowOps: GetChecksum,GetIconTitle,GetWinTitle,SetXprop'`                        |
| wezterm   | none: WezTerm has no read setting, so it runs as shipped and its result is measured, never declared |

`assertClipboardProfile` compares the terminal's actual argv, up to the collector's `bun`, with exactly
these args, and `clipboard-allow-args.test.ts` keeps the launcher equal to the table. The receipt records
`clipboard: read=allow,write=allow` (WezTerm: `read=no-setting,write=allow`). A `deny-read` profile exists
for Kitty only. Under any profile other than `default`, the collector installs the clipboard transaction for
every clipboard probe, including `extensions.osc52-read` and `extensions.osc52-clipboard`. Those results
describe that non-default context, never the default one.

## State a clipboard or title probe changes, and how it is put back

| State                                 | Changed by                                                                                                                          | Put back by                                                                                                                                                                                                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OS `CLIPBOARD` (xterm: `PRIMARY` too) | OSC 52 writes and paste setup                                                                                                       | `createClipboardTransaction`: ownership is checked before each read or write, the baseline is read back before the probe, and it is restored and read back at the end.                                                                                                                     |
| Selection owner                       | the pre-flight, when the baseline's helper is gone                                                                                  | The baseline is re-owned only when `readSelectionTaker` proves the taker is this run's own outer terminal (same pid as the receipt, a client window equal to the receipt window; #33693, #33968). Any other taker refuses the row as probe-invalid by name, and the note says who took it. |
| tmux paste buffers                    | the callback                                                                                                                        | `list-buffers` is snapshotted first; buffers the callback created are deleted in `finally` and the result is read back.                                                                                                                                                                    |
| Screen mode `2004`                    | blind paste setup                                                                                                                   | Restored blind in `finally`; the observation records the blind setup.                                                                                                                                                                                                                      |
| Incoming mode `2004`                  | `extensions.clipboard-paste`                                                                                                        | The mode is read first; if it was set, `CSI ? 2004 h` is written back at the end. An unreadable incoming mode is left untouched (#32607).                                                                                                                                                  |
| X input-event time                    | one real XTEST key press before an OSC 52 write (`pressRealKey`, #33145)                                                            | Nothing to restore: the press must reach the application as zero bytes. It runs inside a PTY read, and any byte that arrives refuses the sample by name.                                                                                                                                   |
| Window title                          | OSC 2 title probes and the XTWINOPS 22/23 fixture                                                                                   | The title is read before the probe and set back in `finally`, then read again; a mismatch throws an error naming both titles.                                                                                                                                                              |
| Icon title                            | any probe that writes OSC 0 or OSC 1; the XTWINOPS 22/23 fixture and the icon-label probe write an empty OSC 1 (`CLEAR_ICON_TITLE`) | **Not restored (known).** The fixture starts from a fixed empty icon title so a leftover one cannot hide its OSC 2 controls, and the icon-label probe ends on it (#33035). No reader for the prior icon title exists, so nothing is put back to it.                                        |

## OSC52 is a separate route

The default paste exception does not install a clipboard fixture for OSC52 write, read or
roundtrip probes. Source policy permitting an operation does not, by itself, change collector
eligibility, receipt meaning or the measured default context.

Kitty 0.49.2's qualified default source policy permits clipboard writes and asks for reads.
User paste reads the OS selection through a different path from an OSC52 read request.
Do not infer that paste must encounter the OSC52 read prompt, or silently switch permissions
to obtain a positive result. Nondefault permission controls describe a different context.

For any additional route, retain the actual application identity, selected operation,
default policy, independent observation and verified restoration. Report a missing route
or observer honestly rather than translating it into a measured absence of the feature.

## Multiplexer boundaries

The qualified source facts below are scoped to the inspected versions, not live-run grades.

| Context     | Distinction the route must preserve                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| tmux 3.8    | Default `set-clipboard=external` blocks ordinary inner OSC52 handling. `get-clipboard=buffer` reads mux buffer state, not the OS clipboard.      |
| tmux 3.8    | Pane-title handling and default outer-title propagation are separate. Enabled clipboard routes can also create or evict automatic buffers.       |
| Screen      | Ordinary OSC52 is not in the qualified dispatch allowlist. DCS forwarding is a separate transport, not proof of ordinary OSC52 support.          |
| Screen      | Stored title, hardstatus and the outer title are distinct state. The effective system configuration and terminal capabilities must be qualified. |
| Outer Kitty | Its clipboard transaction and cached title state do not prove what an attached inner mux accepted or what the OS window presents.                |

Declare the route actually used. Changing passthrough, permissions or system configuration
is a context change, not a repair of evidence collected under unchanged defaults.
Restoration covers every state the chosen operation can mutate, not just the OS selection;
the Linux states and their restore are listed above.

## Title: a deciding observer remains separate

The title criterion concerns the terminal window title, including its title-bar or tab
presentation. For an App that is the OS window; a stored application title is not automatically it.
For a mux subject the terminal under test is the mux, so the mux's own pane title is the deciding
target for its OSC 2 title rows. Whether the mux forwards that title to the outer window is a
different fact, a forwarding row, and is never decided from the pane title.
Select the deciding native target before implementing its observer.

A qualifying route needs an independent baseline read, a known control, the title operation,
an observation that distinguishes the control from the requested effect, and verified
restoration. Preserve title-stack, child-window, mux-format and outer-window distinctions.
An application's cached title getter alone is not an independent OS-window oracle.

The Linux owned adapter now exposes one optional public-title read through the existing
window receipt or mux attachment proof. The collector installs it only for the verified
run/output owner and retains raw reads and read errors. Direct Apps use `xdotool
getwindowname`; tmux reads its recorded session's pane title (`display-message -p '#{pane_title}'`);
Screen's own query (`-Q title`) needs passing controls and never falls back to the outer window.
tmux's forwarding of the pane title to the outer window is what the `set-titles` mux profile
is for; no forwarding result exists yet, because that profile's configuration was found inert (#33995).
The reader is installed for every probe that reads a title wherever the owned run has one (#33375);
no subject name chooses it. Only on Linux Ghostty does the absence of a title change decide
`extensions.osc7-cwd` (`titleAbsenceDecides`); elsewhere the OSC 7 arm's own OSC 2 controls qualify
the reading. Ghostty's launcher permits application titles; that launch change requires its
separately authorized before/after measurement.

The existing title callback and application source facts do not establish that this complete
native control/read/restore path has been implemented or measured. A real criterion or API
change uses the repository's existing review process; this guide introduces no new gate.

## Existing route entry points

These are implemented entry points, not a claim that every route has a measured run.
Extend the existing implementation rather than adding a second launcher.

| Route                                        | Existing implementation                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Linux apps, and tmux/Screen in the container | [Container runner](../scripts/linux-container-run.sh)                                                              |
| Hosted macOS apps                            | [macOS workflow](../.github/workflows/macos-measurement.yml) with the [app launcher](../packages/admin/src/app.ts) |
| Hosted Windows apps                          | [Windows workflow](../.github/workflows/windows-measurement.yml)                                                   |
| Mux wrapper that clears outer identity       | [Mux wrapper](../packages/admin/src/mux.ts)                                                                        |
| Headless engines                             | [Headless collector](../packages/probes/collect-headless.ts)                                                       |

Headless Kitty collection requires an absolute `KITTY_BINARY`. Its
[identity collector](../packages/probes/headless-identity.ts) checks x86_64 Linux,
the resolved Nix-store binary, closure/derivation metadata and declared-source proof.
Those checks do not establish which shell supplied the path or a measured capability result.

## Read retained runs

Start with `pass.json` → `contexts[].rawRun`, the [collection owner's recorded run path](../scripts/release1-collection.ts).
`pass-<x>/term-<app>-<os>.draft.json` can be a selection-only pass draft, with `collector.selection`
but no measured identity or assertions. Its missing DA1 does not establish that the run retained no DA1.
For Linux apps, the run is under `pass-<x>/linux/<app>/<hash>/raw/`, commonly `v3-run.draft.json`;
the recorded path can instead name `v3-run.json` or a retained producer draft after a failed HTTP response.
Read that run's `rawReplies`, including `device.primary-da` and `collector.xtversion`, for the identity evidence.

The [Linux launcher](../scripts/linux-container-run.sh) also retains `font.txt`, `da1-observation.json`,
`runtime-provenance.json` and receipts in `raw/`. Image hashes resolve through `raw/capture-hashes.txt`
to `raw/artifacts/<sha>.png`. A pass summary, a raw run and its receipts answer different questions;
reading them does not establish admission, a capability verdict or publication authority.

## Headless runtime prerequisites

In the owned hh layout, the existing `placeArtifacts` in root
`tools/terminfo-remeasure.ts` places retained addons whose receipt `nativeTreeOid`
matches the selected Termless native tree, including Ghostty's recorded lock.
Use the matching retained artifact before rebuilding; the checks below still apply.
When none matches, build from the selected Termless source using its declared package scripts.
From that checkout's [packages/alacritty](https://github.com/beorn/termless/blob/main/packages/alacritty/package.json),
[packages/wezterm](https://github.com/beorn/termless/blob/main/packages/wezterm/package.json) and
[packages/vt100-rust](https://github.com/beorn/termless/blob/main/packages/vt100-rust/package.json) directories,
run `bun run build:native`; from [packages/ghostty-native](https://github.com/beorn/termless/blob/main/packages/ghostty-native/package.json)
run `bash build/build.sh`.
These existing recipes produce the addon and its build receipt.
Retain the receipt with the loaded binary and check its `nativeTreeOid` against the selected package's native tree;
a package-version label alone does not identify the build.
Ghostty-native also retains the source `flake.lock` identified by the receipt's `lockSha256`.

Kitty uses its Python bridge rather than a `.node` addon.
Supply the absolute `KITTY_BINARY` from the host's declared Nix build;
the existing [identity collector](../packages/probes/headless-identity.ts) requires its resolved store path and derivation/source proof.
Prepare these prerequisites before the selected collection command; retain any failure as a named collection failure.

## Hosted macOS launch facts

These describe workflow and launcher code, not measured results.

- The default matrix declares nine rows: Terminal, iTerm2, Ghostty, Alacritty, WezTerm,
  Cursor, VS Code, Warp and cmux. The workflow exposes `context_matrix` and `probe_ids` inputs;
  each job's `timeout-minutes` is 35.
- The explicit iTerm2, editor, Warp and cmux installer downloads compare SHA-256 with
  declared pins. A mismatch reports expected and actual values and fails the job.
- Before launching iTerm2 3.6.11, the job configures remembered consent for terminal-initiated
  transfers and inline display: `NoSyncSuppressDownloadConfirmation=true` and
  `NoSyncSuppressDownloadConfirmation_selection=0` (Yes). The existing `launcher.log`
  records both exact settings commands and their outcomes. This describes the configured
  hosted target's consent policy, not iTerm2's default user configuration or accepted results.
- For Alacritty, Cursor, VS Code and cmux, the workflow exports the bundle's
  `CFBundleShortVersionString` as `TERMINFO_TARGET_VERSION`; it also checks that Alacritty's
  binary version agrees. The app launcher reads WezTerm's version from `wezterm --version`
  instead of its placeholder plist.

### Editors

- Cursor and VS Code launch through `prepareCliLaunch`, then `launchPreparedCli`. The prepared
  environment is in-memory spawn input only: never retain or log it.
- Cursor's bundle ID is `com.todesktop.230313mzl4w4u92`. It spawns `Contents/Resources/app/bin/cursor`
  with `--new-window --classic --skip-onboarding`, a private `--user-data-dir`, a private extensions
  directory and the fixture extension. Its settings configure the updater off; preparation
  seeds command-line prompt-dismissal state through `cursor-onboarding.ts`, without measuring
  the prompt's visible behavior.
- VS Code spawns `Contents/Resources/app/bin/code`; its GUI executable is `Contents/MacOS/Code`.
  Its canonical ID is `com.microsoft.VSCode`, not the Homebrew cask token `visual-studio-code`.
  Its settings configure AI, startup-editor and onboarding behavior; their visible effects
  are not measured here.
- Editor cleanup attempts to retain selected script, owner-TTY, fixture and log files,
  warning when files are missing. It invokes process close only with recorded ownership;
  unresolved ownership signals no process. This does not establish complete retention,
  successful GUI close or restoration of every mutated state.

### Warp and cmux

- Warp's bundle ID and defaults domain are `dev.warp.Warp-Stable`. The workflow checks the
  installed `CFBundleIdentifier` against it. The shared app definition has an empty `binaryPath`
  for Warp. The hosted workflow instead writes a launch configuration and spawns `stable`
  with its `warp://launch/<name>` URI; this is not a claim about every Warp capability.
- The workflow requires `HasCompletedOnboarding` to be absent before writing it with
  `-string true`. It writes `RestoreSession` with `-string false`, then reads back each value
  and its type. Those source steps do not establish current window behavior.
- It also writes `SnackbarEnabled` with `-string false` and reads back the value and its type
  (33000). This turns off the sticky command header, which otherwise covers grid rows 1-3 while
  probes run. It is a launch deviation from stock, so the receipt's `appLaunch.launchDeviation`
  states it, and only when this job's own setup record shows the readback as `false`. The key was
  read from the Warp binary. Only a hosted frame with rows 1-3 uncovered shows that it works.
- cmux takes its defaults domain from the installed bundle. The workflow writes
  `cmux.cloud.welcome.seenVersion` as the string `0.65.1` and reads back the value and its type.
  It also writes a Ghostty `initial-command` configuration. That onboarding step invokes one
  `open -a`; no welcome-window result is inferred.
- The cmux GUI identity check requires the exact executable `/Applications/cmux.app/Contents/MacOS/cmux`.

### App ancestor

The caller supplies collector-to-launchd ancestry to `requireHostedDarwinAppAncestor`.
The helper rejects another recognized hosted-terminal name and uses `findLast` to select
the last matching `comm` basename: the outermost matching ancestor in that order. cmux
additionally requires the exact GUI executable path. Warp's recognized name is `stable`.
The rows are unchanged; this selection alone proves neither window ownership nor launch causation.

### Proving a setup change before submit

A hosted Mac setup change is any change to the workflow or to a file a job loads before its first
probe: `.github/workflows/macos-measurement.yml`, the launcher
[app launcher](../packages/admin/src/app.ts), the [mux wrapper](../packages/admin/src/mux.ts),
the collector entry [serve.ts](../packages/terminfo.dev/src/serve.ts), and the checks it runs
before spawning anything — [clipboard-config.ts](../packages/terminfo.dev/src/clipboard-config.ts),
[identity-guard.ts](../packages/terminfo.dev/src/identity-guard.ts),
[capture-calibration.ts](../packages/terminfo.dev/src/capture-calibration.ts),
[darwin-capture.ts](../packages/terminfo.dev/src/darwin-capture.ts) and
[detect.ts](../packages/terminfo.dev/src/detect.ts) — including anything those import at startup.
A change outside that set needs no hosted run. A change inside it is shown only by a run: the
workflow is `workflow_dispatch` only, and nothing starts it on a pull request.

Run one engine on the branch, before submit, through the workflow's own matrix input:

```sh
gh workflow run macos-measurement.yml --ref <branch> \
  -f context_matrix='{"include":[{"id":"iterm2","bundle":"/Applications/iTerm.app"}]}'
```

Take the row's `id` and `bundle` from the default matrix above; its job is named `macOS <id>`.
One row costs one engine's runtime instead of nine — run `42495897885` ran the single `iterm2`
row on branch `task/32731-iterm-third-diagnostic-trial` in 87 seconds. Leave `sha` unset so the
run measures the branch head; when it is set, the run refuses a checkout that differs.

Read the outcome from the artifact, not from the job's exit status alone:

```sh
gh run view <run_id> --log-failed
gh run download <run_id> -n macos-<id>-<run_id>-<attempt> -D <dir>
```

The artifact unpacks the contents of `measurement-artifacts/` at its own root: `collector.log`,
`collector-exit`, `run.json`, `host-measured.json`, `job-start.json`, `launcher.log`, and
`artifacts/` with the capture's own files. `collector.log` carries the collector's stderr and this
command's phase markers — `phase=entry utc=… pid=… tty=…` first, then `phase=receipt-ready`,
`phase=run-id-parsed` and `phase=collector-invoked`, with `phase=collector-exited status=<n>`
last; `collector-exit` holds that same status as one line. Probe replies are written to stdout by
design (the owned-terminal arm binds stdout to the PTY), so they are not in this log. A run that
refused before its first probe leaves a non-zero `collector-exit`, the refusal text in
`collector.log`, and no probe replies in `run.json`. Reading the artifact this way shows what the
run did; it does not establish the engine's captured capability. Run `42927177306` (the single
`iterm2` row on branch `task/33013`) is the read of this path: `collector.log` went
`phase=entry utc=… pid=… tty=/dev/ttys000` → `phase=receipt-ready` → `phase=run-id-parsed` →
`phase=collector-invoked` → `phase=collector-exited status=0`, `collector-exit` held `0`, and the
log's last line named the raw run id, its SHA-256 and `identity unverified`.

## Retained macOS capture observations

These are scoped observations from retained November 2 captures, not current capability
grades, launch-policy guarantees or a cause established for every collection failure.

On the measured hosted iTerm2 3.6.11 build, the
[OSC 1337 inline-image probe](../packages/probe-defs/src/extensions.ts) was followed by an
"Allow Terminal-Initiated Display?" consent modal obscuring retained target frames.
The modal is a measured obstruction, not a proven cause of the full collection's outer
600-second wait. A later image/underline/blink diagnostic reproduced the obstruction and
completed; all three feature statuses remained PROBE TODO. Neither unfinished draft statuses
nor successful capture subtests establish accepted feature grades.

The retained Terminal.app post-repair capture refused the selected window image and the
region fallback through the Darwin window server. That raster acquisition refusal is not
evidence that Terminal.app lacks the probed capabilities.

These observations do not qualify the macOS multiplexer route. The hosted cmux app row
above is not mux measurement. Absence from a headless sample's selected engine set cannot
establish absence of historical, native-app or multiplexer captures; those populations remain
unqueried here.

## Windows console reads: ordering is not GUI paint

The existing [text adapter](../packages/terminfo.dev/src/serve.ts) installs only with an owned
cell reader and a retention directory. On Windows, `installTextCapture` awaits one plain
CPR (`CSI 6 n`) with a 700 ms query bound before each console read, using the existing
[selected-output query operation](../packages/terminfo.dev/src/tty.ts). No matched CPR means
a named refused read with the query reason and byte count, not a frame. Non-Windows keeps
its empty-write completion path. The strict compared-cell/stand-in checks remain unchanged.
The acknowledgement is the existing console-read ordering witness, not proof of GUI paint,
glyph rendering or text qualification.

Retained October 19 experiments reported stale early reads; a no-query idle read cleared in
one run, and a later post-query read cleared in another. Those sequences do not isolate causation.
The later development record counted 469 capture CPRs per Windows Terminal/Alacritty app;
469 × 700 ms = 328.3 s is a counterfactual timeout bound for that historical count, not a
current query count or measured batch duration. That record's WezTerm launch failed before
a window/collector with an OpenGL error; it supplies no successful WezTerm measurement.

## macOS text qualification remains separate

The existing [qualification collector](../packages/terminfo.dev/src/text-qualification.ts)
uses one run's full-grid control/target witnesses for mid-line gap, trailing gap, soft wrap,
prior scrollback and an empty last row after overflow. The [retained-byte assessment](../packages/probe-defs/src/text-qualification.ts)
requires the cited recipe/version and all five expected grids, not a stored pass flag.
The current writer requires a declared text claim, a macOS terminal subject and no console
host; Windows CPR does not satisfy that prerequisite. A Windows text-frame row retains a
text-qualification PROBE TODO, with existing required failures still taking precedence.

Preparation restores measured visibility/autowrap and verifies the reset blank grid through
the existing capture lifecycle; failure to prove it fails the run. This proves neither retained
history nor general session restoration. `CSI 2 J` does not clear history, and `CSI 3 J` is
not this cleanup's dependency. [Owner disposal](../packages/terminfo.dev/src/owned-terminal.ts)
revokes ownership and disposes clipboard state; it does not close an app or tab.

## Other platforms and retained work

Windows launch-policy prerequisites and the macOS multiplexer route are not extracted here
yet. The launch, console-ordering and text-qualification facts above do not complete the
remaining routes' capture or all-mutated-state restoration requirements. Do not reconstruct
missing launch instructions from historical plans or copy private host details into this
public source tree.

Operational owners, evidence custody, dated parks and runtime grants remain in their owning
work records. Documentation, source delivery and a unit-test result grant no native capture,
configuration change, grade application or publication. External release, publication and
pending answers remain held until the actual full Phase 1.4 merge and their existing authorization.
