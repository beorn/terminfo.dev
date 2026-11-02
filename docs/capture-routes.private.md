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

## Other platforms and retained work

Mac and Windows launch mechanics are not qualified by this Linux-only extraction.
Their route-owner fact reads and the separate Warp/cmux extraction remain incomplete.
Do not reconstruct missing launch instructions from historical plans or copy private host
details into this public source tree.

Operational owners, evidence custody, dated parks and runtime grants remain in their owning
work records. Documentation, source delivery and a unit-test result grant no native capture,
configuration change, grade application, admission or publication. Existing live instructions
remain in force until the code that enforces them is actually removed.
