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

## Default direct-Kitty paste

The batch collector enables the existing clipboard fixture for the default paste route
only when all of these conditions hold:

- The selected probe is `extensions.clipboard-paste`.
- Terminal output has passed the existing ownership verification.
- A clipboard adapter and clipboard verification are available.
- The measured subject is `term/kitty/linux`.
- A disposable receipt declares the matching target `app/kitty/linux`.
- Existing receipt binding has passed before writes.
- No mux attachment proof is present.

Every miss retains the previous eligibility behavior. In particular, a caller-supplied
Kitty subject or a targetless receipt does not enable this default exception. The existing
nondefault branch is unchanged; the exception introduces no global target requirement.

The paste callback retains its plain-key control, nonce-bearing text, Ctrl+Shift+V input,
bracketed-paste envelope and finally cleanup. The clipboard transaction retains baseline
restoration and verification. Missing input remains an unmeasured prerequisite; it is not
evidence that Kitty lacks paste support.

The focused [routing tests](../packages/terminfo.dev/src/probes/unified.test.ts) use the
existing clipboard transaction with modeled input. They prove fixture selection and the
callback path, including zero OSC52 output. They do not measure a live Kitty/XTEST session.

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
Restoration covers every state the chosen operation can mutate, not just the OS selection.

## Title: a deciding observer remains separate

The title criterion concerns the terminal window title, including its title-bar or tab
presentation. A stored application title or a mux pane title is not automatically that
presentation target. Select the deciding native target before implementing its observer.

A qualifying route needs an independent baseline read, a known control, the title operation,
an observation that distinguishes the control from the requested effect, and verified
restoration. Preserve title-stack, child-window, mux-format and outer-window distinctions.
An application's cached title getter alone is not an independent OS-window oracle.

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

## Hosted macOS launch facts

These describe workflow and launcher code, not measured results.

- The default matrix declares nine rows: Terminal, iTerm2, Ghostty, Alacritty, WezTerm,
  Cursor, VS Code, Warp and cmux. The workflow exposes `context_matrix` and `probe_ids` inputs;
  each job's `timeout-minutes` is 25.
- The explicit iTerm2, editor, Warp and cmux installer downloads compare SHA-256 with
  declared pins. A mismatch reports expected and actual values and fails the job.
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
