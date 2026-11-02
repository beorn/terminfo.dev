# Probe definitions and collected evidence

`@terminfo/probe-defs` defines term feature probes, their observations and the shared run model. Start at the [exports and probe registry](src/index.ts); [types.ts](src/types.ts) owns the record types.

This describes the implemented system. Callbacks still perform live I/O and evaluate it together. The private viprobe package supplies the ordered record/read/replay core. Both TTY recording owners derive their legacy display events from validated call logs. The selected eleven-probe erase runner captures actual xterm.js effects once and reasserts them twice offline with task-owned checks, bound artifact provenance and domain reporting. Its artifacts remain under the fixed private `~/.terminfo-dev/replays` root, with a separate directory per attempt. The wider collector migration and reassert CLI remain unfinished under recorder #30932; no stored grades or current admission change.

## Vocabulary and current code

- **Probe subject**: the exact terminal app, emulator library or multiplexer being probed, at a recorded path, OS and version. `ProbeSubject.kind` is `term`, `lib` or `mux`.
- **Term feature**: one terminal behaviour being tested, identified by `featureId`, with one `ProbeDefinition` supplying lib and/or term paths. A mux uses the term path.
- **Probe source**: where answers come from. Existing collectors supply `live` answers. Schema 4 also retains a `trace` artifact reference and its capture run, suite and source revision; the offline runner must validate those bindings against retained artifact bytes before replay.
- **Probe trace**: everything one probe run did and saw, entry by entry, including referenced files. Current collectors retain subsets, not a complete replayable record.
- **Test**: one required condition of a probe, with its own status and assertion references. `ProbeTestResult` is stored; `ProbeTestInput` is supplied by a callback.
- **Assertion**: one expected-versus-observed comparison. `ProbeAssertion` carries positive/negative polarity independently of its `assertionType`.
- **Probe result**: one probe on one subject, with its status, tests, assertions and retained evidence. Stored `ProbeResult` and callback `ProbeCallbackResult` are separate shapes.

The five assertion types classify the deciding observation: `query_reply` reads a query reply; `buffer_state` reads cells, cursor or modes; `screenshot` reads captured pixels; `input_bytes` reads bytes received for an OS input event; `clipboard` reads what an OSC 52 write put on the clipboard. Probe setup and feed writes retain their existing order and bytes; they are not a sixth assertion type.

Status names remain supported, unsupported, untestable, TEST TODO and TEST FAILURE. The last two retain code values `test-todo` and `test-failure`; this vocabulary change does not change status or publication behavior.

The collection owner's frozen `CollectionPass.freeze.deferrals` records each carried context with its `routeIssue` and `reason`.
`release1-collection --collect --admit --frozen-suite <id> --deferrals <json-file>` reads that explicit array before collection.
Deferred contexts remain named in the pass census with their reason and no new measurement; existing context status values are unchanged.
Failed hosted collection retains its original delegated draft as failure custody when canonical `run.json` is absent.
Only a source-, suite-, run- and selection-bound collector attempt with a recorded start establishes execution;
a job-start marker alone does not. A nonzero collector exit reports `failed`, with its exit code and log path.
This custody never supplies grades or bypasses canonical validation, review or admission.
An admitting pass is complete only when every non-deferred declared context is complete and admitted, with no pass errors.
The read-only admin `report --scoreboard <inputs...>` accepts explicit raw captures or pass files/directories, preserves pass identities,
and uses the canonical selected-results reader and local `origin/live` revision to distinguish selection from proven publication.

Device query criteria name the state actually reported. XTREPORTCOLORS (`CSI # R`)
reports the palette-stack current entry and stored palette count as two
nonnegative decimal fields, retaining the existing optional DEC-private `?`
reply prefix. XTWINOPS 14 (`CSI 14 t`) reports text-area pixels; the outer-window
query is `CSI 14;2 t`. These criteria establish query replies, without measuring
palette push/pop effects or graphics capabilities.

## From definition to recorded result

Linux and Darwin pixel collectors share the complete-raster calibration in
[`capture-calibration.ts`](../terminfo.dev/src/capture-calibration.ts). Before the first probe callback,
one calibration witnesses the grid origin and every cell pitch, then confirms identical surface and cursor restoration.
The batch carries that measured origin and geometry into every cell crop; changing screen content cannot move them.
An unmeasurable witness or changed geometry is recorded as a named refusal, never replaced by frame-colour centring.

**A definition is executable, not a saved result.** `ProbeDefinition` identifies a feature and supplies either or both callback arms:

- `lib(ctx)` is synchronous and reads a `LibProbeSource` backed by a headless engine.
- `term(ctx)` is asynchronous and uses a `TermProbeSource` for real-terminal I/O and any available owned capture, clipboard or input facilities.
- A null arm has no implementation for that route. Ownership, geometry, text-readback and assertion-type declarations constrain the arms that do exist.

Library `getMode` returns `boolean | null`: null names an unavailable adapter readback,
not a reset state or a terminal-support verdict. Callbacks retain it explicitly.

OSC52 write/roundtrip callbacks retain qualified read-sentinel silence as a named TEST TODO
when no clipboard-state witness is wired; a read negative cannot measure the write.
OSC5522 detection checks the current library DECRQM sibling-query family after qualified target
silence. Qualified silence from every control names an unmet detection prerequisite as TEST TODO,
retaining each raw window. Any control reply leaves target silence as TEST FAILURE; complete,
on-time target Ps0 remains Unsupported. Unqualified, malformed and late target replies keep
their existing criteria. Historical captures and selected results are unchanged.

Region-readback fixtures address the active screen with CUP. Their library reads translate each
screen row into the retained buffer using one coherent `totalLines - screenLines` origin per frame,
independent of the scrolled viewport. Invalid or insufficient extents retain named inconclusive
evidence; they never establish an engine negative.

Library `getSemanticMarks` and `getSixelImages` are optional copied-state readers.
The collector forwards each only when its extension is declared and the method is callable;
absence is not an empty array. The same `getSemanticMarks` reader serves `semantic-marks`
(prompt/command/output starts at their screen positions when inserted) and
`semantic-command-end` (command-end entries with the exact raw status string and no coordinates).
Engines exposing both kinds declare both keys. Start and end probes use their respective
declarations; a command-end-only reader never decides positional start support.
OSC133D requires two newly appended entries carrying distinct injected raw statuses,
stable earlier history and the existing cell/cursor consumption controls.
The reader does not expose bounded zones. Sixel records contain raw payloads and
DCS start positions; storage does not establish raster rendering or cell geometry.

The library alternate-scroll, reverse-video, synchronized-output,
colour-scheme-reporting and DECSCLM cells use the existing DECRPM helper's opt-in
`requireReadback` criterion. Supported requires Ps1 after set, Ps2 after reset and
agreeing `getMode` readings. Ps0/2/4 after set is an engine negative. A null or
mismatched adapter reading retains a criterion TEST TODO named
`adapter binding <backend.name> <mode>`; the name is display-only and never selects
a status or route. Existing other DECRPM criteria retain their prior readings.
Application-keypad instead measures `ESC =` / `ESC >` (DECKPAM/DECKPNM) with
`applicationKeypad` true then false, without DECRQM. Null readings stay named
adapter-binding TODO; other non-null pairs stay criterion TODO naming both states.
Keypad encoding and wheel-to-cursor-key translation remain unmeasured.
Private4 additionally requires non-null ANSI `insertMode` readings before and after
set and checks that they do not change; an observed
flip is engine conflation, independently of its reply (the existing private4 issue32002).
Presentation remains unmeasured for reverse-video/synchronized-output, the actual
scheme-change report remains unmeasured for2031, and smooth-scroll presentation
remains unmeasured in the library arm. DECSSCLS feeds `CSI 9 SP p` plus a marker and
retains screen text and cursor state. Consumption without visible effect requires an
independent source review (pending TEST FAILURE); leaked sequence text is a measured
negative, and a changed grid or misplaced marker stays inconclusive. Consumption does
not prove handling or scroll-speed presentation. A source that stores speed without
readback remains a TEST TODO tool gap when reviewed. Application criteria are unchanged.

Both source interfaces carry `readonly kind: ProbeSourceKind` directly. Current runs retain exactly `source: { kind: "live" }` or `{ kind: "trace", trace: { path, sha256 }, captureRunId, captureSuiteId, captureSourceRevision }`. The trace path is relative to the artifact store and contains no parent segment; its SHA256 and capture identities are required. Initialization, sealing and the canonical reader validate and preserve this union without a schema bump. Call-log format/version remain inside the referenced artifact. Historical schema 2/3 bytes and readers are unchanged. This source declaration grants no capture, admission or publication.

`termAssertionType` and `libAssertionType` declare a retained deciding-observation class. An explicit null means the callback runs without a typed deciding observable; undefined is temporarily undeclared (#28801). Neither means the callback arm itself is absent, and neither becomes a null observation or assertion type.

`ALL_PROBES` collects the category definitions. A current `ProbeSuiteManifest` explicitly carries schema version 4 and separates complete `catalogIds` membership from the callback schedules in `probes.term`, `probes.lib` and `probes.mux`. Historical declarations normalize their schedules on read while retaining their original absent schema marker.

The [shared execution helpers](src/helpers.ts) initialize every catalog member as `test-todo` with no attempt, then record only the work actually performed.

Library SGR 39/49/59 resets without a distinct colored setup retain their actual cell state on a
named `headless-observable-review` TEST TODO row. That missing prerequisite cannot establish a
reset negative. Compound attribute resets with unshown setup attributes retain a named
`source-negative-review` TEST FAILURE until the complete criterion is reviewed; a partial reset
does not decide the whole claim. Other source-negative style reviews keep their existing failures.

TERM_FEATURES means a terminal program's export into its child environment. Its library arm performs
no I/O and retains a `headless-observable-review` row with the API boundary and audited adapter blob for
per-engine source review. Only a non-author Untestable decision can discharge it; it creates no
observation or assertion. The application arm remains TEST TODO until terminal-owned child readback exists.

Source audits match the shared evidence identity and declared adapter source blobs, not global
Termless revisions or host filesystem locators. Raw replies and observed payloads do not embed
runtime identities; the record's allowlisted identity is their sole carrier. WASM engine identity
uses the loaded binary digest, while wrapper repository/tree metadata remains provenance.

The current libvterm v0.3.3 source audits bind WASM `3d67045b`, adapter blob
`eb513ccd` and loader blob `1e784be8`. Its OSC52 selection callbacks and native
reverse-property observation do not add retained history, a title stack or other
OSC handlers. History and absent-OSC qualification use those exact artifact and
adapter pins; title-stack absence also retains the previously audited `7ebe1b99`
binary entry. Historical capture records keep the identities they measured.

The pinned vterm 0.10.1 library arms for OSC 9, 22, 176, 440, 555, 666, 710, 777 and 3008 feed their exact commands and a cell-X
consumption control. A rendered X retains `source-negative-review`, its actual fed/cell state and a
negative buffer-state assertion for independent review of the target implementation at sourcebd3d32ae.
The control proves parser consumption, not a target effect; target state remains explicitly unexposed.
The vt100 0.10.1 arms use the same nine commands and control only at their independently audited
source identity (revisionbd3d32ae, package tree1eaac257, vt100 entry path). Its handleOSC switch
at screen.ts:504-520 has cases0/1/2 only. The OSC9 notification-sink citation is specific to the
vterm entry; vt100 records its own absent-handler citation. These paths retain a pending source
review, never an automatic grade or a measured target effect.
The vt220 0.10.1 arms qualify the same nine commands at revision67dd3960746766ed47e2bb4b2ced6503a78549cc, package
treefc6ff58f and the vt220 entry path. Its screen.ts:700-715 handleOSC returns
without a semicolon and otherwise handles only cases0/1/2. Its OSC9 records the
generic absent-handler citation, never vterm's notification-sink citation.
Other identities keep named coverage, and a missing X grants no source-review negative.
Vterm's OSC 9 specifically names its notification sink and lack of progress subcode/state
interpretation; it never claims that the OSC 9 handler is absent. The other audited codes
retain their absent-case source reasons. A decision still requires independent review bound
to a fresh exact-run capture; these qualifiers do not approve old captures or application arms.

The same helper covers @xterm/headless6.0.0 OSC9/22/176/440/555/666/710/777/3008 at its audited registry integrity and adapter0.10.2.
It retains the bundle/map and adapter citations plus the executing runtime identity for independent source review.
The bundle hashes are audit evidence, not fields in the runtime identity; the embedder hook must also be checked at the captured Termless source.

GhosttyNative1.3.1 uses that existing native qualifier for OSC176/440/555/666/710/3008
at the audited5a8030c0 artifact, Termless2d974173 and exact source/build/lock provenance.
The first five commands are parser-rejected at core332b2aef; OSC3008 is parsed as
context_signal, then dropped by the generic stream selected through Terminal.vtStream.
Its reason preserves that distinction. The exact runtime and rendered-X control retain
negative buffer-state assertions with pending source review, never an automatic grade.
A different tuple, missing X, or OSC22/777/9 receives no such assertion from this entry.
Historical captures stay unchanged; fresh emitted rows need new independent decisions.

Alacritty0.26.0 uses the same native qualifier at the audited32d76284 artifact,
Termless2d974173 and exact source/build/lock provenance for
OSC9/17/19/22/117/119/176/440/555/666/710/777/3008.
The pinned vte0.15.0 dispatcher has no cases for twelve of these codes.
OSC22 is parsed into set_mouse_cursor_icon, whose empty Handler default is not
overridden by alacritty_terminal0.26.0 Term; its review reason states that distinction.
Private per-entry reasons also preserve the existing vterm9 and Ghostty3008 text.
Nine command callbacks and two paired highlight resets retain pending independent
buffer-state source review only with the qualified identity and rendered X.
Direct OSC17/19 queries keep their reply route; OSC8/1/7/1337 remain outside this entry.
This qualifier does not approve historical captures or grade a target effect.

Wezterm0.1.0-fork.5 uses the same native qualifier at artifact0f56a805,
Termless2d974173 and exact source/build/lock provenance. Its numeric membership is
OSC22/176/440/555/633/666/710/720/3008, absent from the pinned parser's osc_entries.
The private literal133;D selector records the parsed CommandStatus arm that does nothing;
it never selects133A/B/C/P. OSC9 progress and777 notifications remain outside this entry.
Seven ordinary callbacks,133D, six633 members and the633 aggregate retain pending
buffer-state source reviews with rendered X. The aggregate cites whole-opcode absence,
not member decisions. Only the seven D/633 member declarations change from null to
buffer_state; other identities retain their existing untyped semantic-review route.
OSC720 enters this source route only when productViewport is declared absent and no
scrollViewport control exists. Contradictory declarations and measured viewport paths
retain their existing checks. The reason names parser absence, screen/history ownership
and the wrapper's no-op viewport. All sixteen routes require fresh independent decisions;
none automatically grades a target or changes historical captures or application arms.

The two highlight resets (OSC 17/117 and 19/119) query the initial colour first.
A real colour reply follows the measured reset criterion. Only an empty initial
reply at an audited xterm.js or Alacritty identity can enter source review, and both set and
reset codes must belong to the same audited entry. The callback feeds the exact
set/reset commands and an X control, retaining the query, reply, runtime and
control state as buffer-state source evidence. The measured reply route remains
query-reply evidence; these two lib arms stay temporarily undeclared under #28801
because a single assertion-type declaration cannot state both routes.
A rendered X retains a negative assertion
and pending source review, never automatic Unsupported. A missing X retains no
negative assertion or review; other identities keep the named prerequisite failure.

OSC99 capability detection has both library and term query arms. They share the nonce/title
criterion and never display a notification. Unqualified library capture silence stays inconclusive;
only the existing qualified sentinel path can establish a negative reply result. Current artifact
source audits retain their own parser/reply-path citations. Viewport hold on output measures the
library viewport through the existing scroll control and absolute position/extents. Each independent
ordinary/synchronized phase resets the main buffer, observes its numbered seed, requires history,
exact retention and a bottom baseline, then calibrates the first inward sign (-1 before +1) without
changing extents. Exactly one retained new marker row witnesses hold at the same anchor, snap to the
new bottom, or bottom-relative motion: the absolute viewport offset advances by exactly one from its
anchor, keeping its distance from bottom. Marker readability is checked only after a verified return
to bottom. Both phases must qualify: both bottom-relative outcomes are negative with the reason
"viewport kept its distance from bottom instead of its anchor"; one bottom-relative outcome mixed
with any other outcome is inconclusive. Otherwise either qualified snap is negative and both holds
are positive. Failed controls and every other drift withhold a verdict. Missing history or scroll
control/state names coverage; operational and cleanup errors propagate. Retained buffer-state evidence has baseline, anchor,
control, ordinary and synchronized keys. The exact DECSET 2026 bytes exercise output inside that
block without claiming painting support. The app coverage callback performs no I/O and stays TEST
TODO because it has no live terminal UI scroll actuator; its manual UI recipe remains in the catalog.

The optional library capability `productViewport: { available: false, reason }` explicitly declares
that the library subject has no product viewport; an absent declaration means undeclared. The
collector omits the probe source's scroll control for that declaration. Before any phase action or
OSC720 history I/O, the viewport-hold and OSC720 callbacks retain the declaration and exact reason plus
`runtimeIdentity` (null when missing), and select `headless-observable-review` with named scroll-control
coverage. They create no measurements or assertions and stay TEST TODO until independent per-engine source review
decides Untestable with the same reason. Missing runtime identity bars that source-based decision.
A declaration of absence paired with a present scroll control is an inconclusive apparatus
contradiction, with no review row. An undeclared missing scroll control keeps ordinary named coverage.
Scripted callback tests cover these branches and the exact two-phase arithmetic independently of
engine versions; historical captures and grades are unchanged.

ED3 and the two history-count library callbacks share an internal libvterm0.3.3 source/API review.
It requires both the exact clean libvterm package tree and the loaded WASM hash, with the declared
source repository, runtime format and versions. That branch performs no history reads or writes:
the adapter reports screen extent, while retained history belongs to an embedding application.
It retains the runtime and source citations for required independent review, without deciding
Untestable or a negative. Matching-tree and unknown-engine identities keep their existing criteria.

The libvterm history and four audited vterm geometry callbacks report a changed source tree as
`criterion` TEST FAILURE: `source identity drift: expected <oid>, read <oid>`.
A known engine matches identity kind, runtime format, source repository, engine version and exact
repository-relative entry path. The entry path distinguishes vterm, vt100 and vt220 within their shared repository/version.
Tree drift is checked before clean-tree, adapter, binary and revision qualifiers; those keep their existing roles when the tree matches.
History fails before stub I/O; geometry retains its actual query and reply before reporting drift, whatever the reply shape.

**Callback and stored shapes are different.** Follow these names in [types.ts](src/types.ts):

- `ProbeCallbackResult` has three arms: a measured `observation`; `notTested` coverage naming a missing semantic observable; or execution-only, nonempty TODO/FAILURE `tests`, each with a mandatory reason. Execution-only callbacks have no observation, assertions or coverage. Callbacks can select a criterion branch.
- `Observation` records an outcome and required `assertionType`. `ProbeAssertion` records the independently positive/negative predicate, required `assertionType`, expected state and retained observed evidence.
- `ProbeResult` stores the feature's execution status, attempt, required tests, selected criterion branch and evidence references. Its optional primary `assertionType` names only a retained observation; absence is not a sixth type. Legacy `pass` never grades it.
- `RunDraft` is a private schema-4 envelope: explicit source, run/suite identity, `intendedSubject`, measured `subject` when available, raw replies, assertions, artifact references and probe results. Subject kinds are `term`, `lib` and `mux`.
- `CapturedRunDraft` requires measured subject, identity, time and origin. `CurrentProbeRun` additionally has `sealedAt`; `ProbeRun` aliases this current shape. Historical reader outputs retain their schema marker, canonical names and an absent source. Their assertion type may remain absent when retained historical evidence cannot establish it.

The legacy callback `pass` still exists for the [diagnostic Vitest runner](../probes/run-unified.probe.ts), including the execution-only arm. Current collectors record observations/tests through `recordExecutedProbe`; even `pass: true` with an explicit FAILURE test stays failure. Cleanup #30929 removes `pass` from every arm.

A callback can mark explicit failure tests that need actual request evidence. An execution-only callback uses
`replyFailure`; a measured callback can retain a partial observation while marking its required-reply failure.
The callback-only `replyFailureTestIds` never enters a stored result or draft. After the callback returns,
the TTY or headless producer uses `withReplyFailureEvidence` to append escaped sent/received bytes and the
actual timeout or synchronous capture boundary to only those marked failure-test reasons. Readers find the
attempts in the stored criterion test's reason; the observation note and top-level summary stay unchanged. Grades, test IDs,
criterion branches, observations and assertions remain callback-owned. Missing request records remain
named failures; they do not prove that a producer is absent. Proved missing required capabilities or
identity-bound declarations retain named TODOs without markers. Malformed replies, sentinel negatives
and artifact-review branches keep their separate criteria and remain unmarked.

A region seed whose characters arrive without their painted background or inverse attribute fails the
claim's precondition. Live and replay retain the same `criterion` TEST FAILURE and `PreconditionFailed`
cause with expected cells and observed values; this is no negative assertion about the feature itself
and creates no source-review row. Replay preserves that callback-provided cause alongside its native checks.

The OSC 1 library criterion requires separate icon readback and a verified OSC 2 window-title control; an icon update must preserve that title. Missing icon readback remains coverage, while a failed title control is an execution failure. Both labels are restored after the attempt. Library OSC 117/119 resets reuse the color-reset helper's initial-query, distinct verified seed and reset-query sequence. Missing initial highlight readback or an unverified seed cannot establish reset support or absence; the original highlight color is restored after the attempt.

The OSC 7 and notification library criteria use optional `getCwd` and
`getNotifications` readers from the backend's `osc-metadata` extension. OSC 7
retains two successive exact URI readbacks and restores the original URI,
including null for an unset slot. Notifications retain the original payloads
and require two distinct OSC 9 messages to append in order without changing
that prefix. The collector gives each probe its own disposable backend, so
notification messages cannot leak into another probe. These are `buffer_state`
observations of parser metadata, not a filesystem operation, OS notification
or OSC 9;4 progress measurement. Missing readers keep the existing
`headless-observable-review` tool gap; getter errors propagate.

## Evidence, capture and assertion

The library reflow callback uses the optional `LibProbeSource.resize` control; every production
source forwards it directly to the existing required backend operation, regardless of the declared
reflow capability. A hand-built source without the member keeps the named no-I/O TODO. Initialized
`cols` retains its original meaning; it is not post-resize geometry. Fresh ASCII wrap controls qualify
the actual width effects through cells, because adapter dimensions can merely mirror a request.
The main-screen fixture seeds an 18-character line and distinct CRLF lines before each resize,
verifies the cursor is parked below them, and measures growth12→20 and shrink20→12 independently.
The line starts soft-wrapped for growth and unwrapped for shrink. Ordered feeds, requested sizes
and actual cell/cursor/scrollback reads remain in the existing response JSON. Exact reflowed layouts
supply positive main-phase buffer-state assertions. Preserved physical rows on growth and the same
rows clipped to 12 columns on shrink supply negative assertions. Failed controls, unexpected cells or
boundaries, and conflicting positive/negative phases retain required FAILURE tests. Finally restores
the initial dimensions and resets the source, attempting both operations and preserving all causes.

The same callback measures retained-history growth and shrink in independently reset buffers.
The soft line and explicit CRLF rows are followed by twice the screen height in uniquely numbered
hard witnesses, without a final newline. Coherent counts bound every absolute-buffer read by the
fed rows plus screen height; invalid extents retain their counts without allocating from them.
Before resize, all target rows must remain in history and the complete seeded layout must match.
No retained history and an evicted or incompletely retained target have distinct named TODO reasons
without assertions, after the surviving rows match the expected fed tail. A corrupt short buffer
is invalid evidence, not unavailable coverage. After resize, complete reflow supplies a positive assertion; exact physical-row
preservation/clipping supplies a negative only with every hard witness and blank tail conserved.
Neither complete model is a named invalid phase, including ambiguous loss or eviction. The destructive
width control follows target readback on the same resized state, reading the active screen at H+s;
history matching has no viewport-position predicate.

Alternate-screen growth and shrink reuse the seeded 1049 roundtrip used by the mode probes.
The sparse target and its post-resize width control stay in the same alternate buffer; target cells
are read before the destructive control. A reflow assertion requires complete target cells, hard
boundaries and blank tails, actual buffer identity, and primary restoration in that same roundtrip.
Unknown identity and a measured entry that leaves the primary active have distinct named TODOs:
`alternate buffer identity unavailable` and `alternate buffer not entered`. Neither is a reflow
negative. Corrupt setup, inconsistent identity, failed controls/restoration and unmatched layouts
retain invalid phase evidence. A failed marker or readback before the measurement slot stays invalid,
even when buffer identity is false or unavailable. Before the slot, only a clean failed-entry observation
can yield an identity or no-entry TODO.
Slot errors retain their cause while measured/final leaves run;
outer cleanup independently attempts alternate exit, initial-width restoration and reset.

The library criterion requires main-screen growth/shrink and retained-history growth/shrink.
Each required row cites only its own phase's assertions; the existing mixed-main criterion cites
only main assertions. The shared finalizer gives required failures precedence over TODOs, then
measured negatives, then support. Main reflow with retained physical history is Unsupported;
missing qualified history remains TODO, and corrupt tails or unmatched layouts remain failures.
The reason names the graded phases and their results.

Alternate-screen phases retain their statuses, positive/negative assertions and raw response but
do not decide the grade: full-screen apps redraw on resize, and intentional physical-row preservation
there does not negate main-screen or history reflow. The reason reports alternate results as not graded.
Invalid alternate evidence stays visible without vetoing the graded phases; cleanup failures still error.

Supported reasons state: "ASCII reflow measured on main screen and retained history; wide characters,
cursor on a wrapped line and terminal-app resize unmeasured". No broader coverage is inferred, and
the separate terminal-app arm remains TODO. Private apparatus results grant no exact-run decision,
seal or admission; the native absolute-row consumer hold remains with independent batch review.

A default-config observation is not engine capability absence. Libvterm0.3 exposes
`vterm_screen_enable_reflow`, disabled unless the embedder enables it, and the current adapter
retains no history, keeping this criterion TODO. Its one future qualification route installs
scrollback callbacks, enables reflow and records the setting with the next adapter re-pin.
A source review of default-off behavior cannot replace that recorded enablement. This slice changes no adapter.

The Linux Kitty/Ghostty launcher pins one exact font file for the entire run, with no fallback face,
through a private fontconfig directory. Its receipt retains that file's SHA256, launch arguments and HarfBuzz glyph
sequences for `!= -> => <= ==` with liga/calt on and off. A glyph-ID difference proves source-face
capability independently of the renderer; position differences alone do not. The collector retains
the validated `fixture.font` bytes as `collector.fontSource` for every non-mux Linux run selecting the
font review, including plain receipts from other launchers. The existing review test references the
key so the current capture binding includes its hash. With this proof, spaced-control and contiguous
target frames decide Supported or Unsupported by review. Missing or inconclusive proof leaves
Test TODO naming `#32062 font control` and its proof state; it writes no typed review and never means
Untestable on a pixel arm. Signing checks the bound receipt; there is no code gate for that review.
This does not change earlier captures or xterm's rendering pin.

Callbacks currently perform I/O and judge it in the same implementation. There is no general persisted callback transcript or independently replayable assertion API supplied by this package.

The five `AssertionType` values classify an actually retained deciding observation: `query_reply`, `buffer_state`, `screenshot`, `input_bytes` and `clipboard`. Pixel versus text-cells capture payloads and positive versus negative assertion polarity remain separate facts. An OSC 52 write decided by independent clipboard readback is `clipboard`; paste decided by `readInput` is `input_bytes`, including its existing control/report envelope and performed action.

The XTEST key criterion requires the ctrl+a modified-key encoding after its plain-a delivery
control; a bare control byte or another modified key does not meet it. Pixel mouse reporting
uses the existing terminal-reported cell geometry to predict the pixel box of the control
click's cell and retains that geometry with the target report. Missing cell geometry stays
named TEST TODO. The two scroll-region recipes seed and preserve a nonblank marker immediately
above the requested top row. The insert/replace query criterion requires set then reset
(Ps 1 then 2); permanent-state replies retain their numeric readings and fail that toggle claim.

The twelve real-surface input term criteria retain genuine input measurements. Only an absent
`input` or `readInput` facility selects the named TODO `real-surface input injection (XTEST/CGEvent)`.
The seven host-input library rows (`input.xtest-key`, `input.xtest-click`, `input.xtest-wheel`,
`input.button-event-mouse`, `input.pixel-mouse`, `input.urxvt-mouse`, `input.x10-mouse`) and
`extensions.clipboard-paste` retain `os-input-review`, with reason
"Lib arm: the engine consumes bytes and has no input surface; host input encoding is measured in the terminal arm."
This remains a review TODO until an independent `applyCaptureDecision` binds Untestable to that
exact engine capture. There is no standing class rule, callback grade or change to earlier captures.

Four term mode criteria opt into `decrpmModeProbe`'s set check: reverse video 5, synchronized output 2026,
DECSCLM 4 and color-scheme reporting 2031. Snapshot Ps 1/3 is Supported without mutation; Ps 0/4 is
Unsupported without mutation. Snapshot Ps 2 sends DECSET, queries again and restores DECRST:
Ps 1/3 is Supported; a retained Ps 2 is Unsupported with "recognized but DECSET refused (mode kept reset)".
No reply is TODO "no DECRPM reply"; an attempted set still restores the reset snapshot.
These callbacks require the existing disposable-terminal authority. Their limitation is
"presentation (tearing, scroll cadence, inverted frame) unmeasured; protocol measured".
Every other mode keeps the default recognition-only path.

DECSSCLS is CSI Ps SP p, not a DEC mode: its term criterion still requires timed screenshots.
Its library arm stays `headless-observable-review` with null assertion type and reason
"presentation speed: headless engines paint no frames and expose no scroll-speed state".
Only the same independently bound per-capture decision route can grade that library cell Untestable.

Reset-family capture recipes can supply an optional `RegionReadback.setupReference`: an independently
authored full setup, painted behind the existing witness. The seed must match it before any verdict.
Companion rows also compare a neutral ignored frame against the expected preserved attribute; missing
setup or an inseparable reference stays inconclusive. Recipes without the member keep four frames.
A qualified baseline followed by a complete but unqualified SGR setup report may use this existing
independent capture path for the six eligible reset rows. The response retains both query phases and
the capture response, and the note names the deciding instrument. Malformed setup, failed baseline,
final-phase results and the three multi-attribute reference refusals keep their existing behavior.

**Headless evidence** comes through [headless-batch.ts](../probes/headless-batch.ts). It retains callback `response` values as raw replies, not every probe-source call or every engine-state read.

The OSC 10, 11, 12 and 4 index-0 initial-colour queries preserve their ordinary reply and sentinel paths.
Without a qualified sentinel path, an empty initial reply runs a disposable set/query/reset/query control,
retaining every write and reply, including setter/reset acknowledgements. Only an exact seeded-colour
reply, empty acknowledgements and an empty reset query select `color-readback-review`: the initial value
is embedder-owned and still missing. A seeded reply never proves initial/default-colour support.
Other control outcomes retain criterion FAILURE. Independent review must bind to the capture run's own
suite manifest and raw evidence; this callback grants neither automatic Untestable nor support.

For the OSC 104 library reset with an unanswered initial OSC 4 index-0 query, indexed cells provide
an independent reset witness. The callback retains a default D before setting, seeded S before and
after reset, and fresh F painted after reset, alongside the existing query controls and extra writes.
Exact glyphs and valid RGB must establish a default distinct from the verified aa/bb/cc seed.
Fresh F matching D proves reset; F remaining seeded is a controlled negative when S also remains seeded.
S records cell storage (resolved at read or at paint), so S remaining seeded with F restored still proves reset.
S restored with F seeded, a third fresh colour or missing post-reset readings require independent review.
An answered post-reset query still reporting the seed contradicts a fresh cell restored to default and also requires review.
Missing S-after is conservatively reviewed even when F matches D; no storage reading is invented.
Sentinel negatives keep their original DA1 response, with optional indexed-cell controls retained in the assertion note.
Cell-decided results retain the original sentinel outcome and timing alongside their controls.
Missing default or seed controls retain the existing query/sentinel/review rules, never a reset negative.
The shared disposable reset still owns cleanup; operational errors propagate, preserving both causes
when cleanup also fails. Complete initial query paths and other reset features are unchanged.

OSC 110, 111 and 112 can instead read current engine defaults when the source
exposes the advertised `default-colors` getter. Each callback retains all three
slots and exact writes: baseline, distinct verified RGB seed, then reset. Target
restoration to the measured baseline, including null for unset, is a
`buffer_state` positive; a verified seed remaining after reset is negative.
Unverified seeds, getter failures, non-target slot changes or a third reset
color retain `color-readback-review` with the cause. Without the getter these
three callbacks keep their existing query path. When the `default-colors` getter
is exposed and the initial OSC 13 or 14 pointer-color query answers nothing, OSC
113 and 114 retain the query, empty reply and measured `fg`/`bg`/`cursor`
default-color state on `source-negative-review` without inventing pointer slots
or executing reset writes. Other color features are unchanged.

Cell `dim`, `italic`, `strikethrough` and `blink` readbacks are required `boolean | null`: null means the producer does not report that attribute, never a terminal-support claim. On a rendered X cell, their SGR probes retain the null or false state through `source-negative-review`, with a required review and a buffer-state assertion. A source-bound decision distinguishes an engine gap (Unsupported at that pin) from a binding gap: TEST TODO, named, until repaired and recaptured. Positive booleans retain their supported observation path. A missing X retains an inconclusive result without a deciding assertion. A rowless, unnamed inconclusive result keeps the writer default TEST FAILURE (callback defect); only an explicit named test or review row classifies its cause. It is not reclassified as missing-observable coverage. Stored captures remain unchanged.

The OSC 8 library criterion requires exact per-cell URI metadata, including unlinked controls.
An absent `hyperlinks` observer with valid fixture text retains named coverage (TEST TODO) and raw cell/link state,
identifying the loaded adapter path and Termless revision when measured runtime identity is available.
For the audited vt100/vt220 0.10.1 source tuples, libvterm 0.3.3 WASM tuple and vt100-rust 0.16.2
native tuple in `ABSENT_OSC_ENGINES`, the same ALINKZ fixture instead retains `source-negative-review`
and a negative buffer-state assertion. Qualification binds the source path, revision and clean package
tree, or the native build provenance; WASM/native tuples also bind the loaded artifact digest.
This is a pending independent source review, not an automatic Unsupported result. A different runtime
or broken text fixture cannot acquire that source assertion. Existing captures need a fresh run and
new exact-run decisions; this source change does not annotate retained captures.
Declared getters returning null report unlinked cells, so URI mismatches remain measured negatives; invalid declared getters still throw.

The declaration-only library checks (Kitty animation and Unicode placeholders, Sixel,
semantic prompts, OSC 633 and iTerm2 images), OSC 7 and notifications without their metadata readers, an unaudited absent OSC 8 URI observer,
the DECSCLM/2031 missing timing or host-event facilities, and the four rendering-limit checks
(font ligatures, DECSSCLS, reverse video and synchronized output) retain their existing coverage and raw
state on `headless-observable-review`. Each carries a required review naming its missing observable.
That branch and `reply-path-audit-review` admit only an independently bound Untestable decision;
source review establishes no rendered effect or measured negative. App callbacks and real-observable
paths keep their criteria. Existing captures acquire no new branch or review.

The collector forwards the run's measured `HeadlessRuntimeIdentity` through `LibProbeSource.runtimeIdentity`.
It identifies the loaded adapter source, engine integrity and any loaded binary; feature-capability versions
cannot substitute for it. Missing identity supplies no source-derived qualification.

The four vterm headless geometry queries (XTWINOPS 14/16, OSC 1337 ReportCellSize and OSC 776)
select required independent review only for complete zero-dimension replies from the audited clean
source revision and tree. That subject has no physical font/window geometry; zero is an unknown,
not a measured size. The callback retains query, raw reply, measured runtime identity and source citation
through the existing coverage/review shape. It remains TEST TODO until own-suite review determines
applicability. Other runtimes, malformed replies and positive dimensions retain their query criteria;
no historical result acquires a review or changes grade.

The optional sentinel member requires the executing adapter's `reply-delivery` extension. The single
comparer in [headless-identity.ts](../probes/headless-identity.ts) checks its audited source blobs and
registry integrity, clean source tree or loaded WASM/native digest against that measured runtime. A native
declaration requires a native identity and the exact loaded binary SHA256, then the same adapter-source checks. Versions are
diagnostic facts. Each initialized callback instance supplies its own declaration; the destroyed
preflight instance cannot authorize another instance. The existing identity owner measures again after
each actual instance initializes; a changed or unavailable identity prevents its callback. Per-feature
decisions retain that initialized instance's identity. `collector.replyPath` retains the shared
declaration and measured identity once, alongside each feature's eligibility result and named
withholding reason. Each distinct withholding reason is reported once per batch.

Source-backed collection requires an owned hh checkout with vendored Termless source. A dist-only
install without the imported source binding refuses collection loudly; silence stays inconclusive.
Libvterm currently withholds the declaration because engine output can truncate before the adapter
drains, even though its adapter now drains all queued output. Ghostty also declares no complete path.
The existing two captures, shared classifier, DA1 control and G1 late-byte grace still decide the read;
a delivery declaration never declares feature support. Sealed historical runs receive no new proof.

Conclusive library observations need nonempty raw evidence and matching positive/negative assertions. A direct buffer-state assertion must match the retained response; invalid claims become collector errors.

The `semantic-prompt-source-review` library branch is the approved source-only exception for OSC 133/633 marks.
An independently reviewed typed `CaptureDecision` names the parser arm and written or rejected mark state;
its immutable capture binding includes the loaded runtime and its own run identity. The canonical writer and
reader retain that decision as proof without inventing an observation, assertion type or assertion.
Missing runtime identity or a source-review row remains an error; ordinary observation reviews keep their
expected-versus-observed requirement. This exception does not admit terminal-app source reviews.

**Native evidence** comes through [probes/unified.ts](../terminfo.dev/src/probes/unified.ts). It retains writes, queries, ordered events and available capture/clipboard records separately from callback responses.

Most native raw-reply entries are serialized traces. Identity-query entries retain queried bytes and a separate `.trace`; a callback response, when supplied for a measurement, uses `.callbackResponse`.

Native execution can also change the recorded result: for example, a measured resize retains the callback observation but adds a failed geometry test. A callback conclusion is not the final run status. This migration classifies existing observations; probe writes retain their existing representation, order and bytes.

**Frames are evidence, not verdicts.** `ObservationFrame` distinguishes pixel frames from `text-cells` frames; pixel and cell rectangles/digests are not interchangeable.

Declared visual criteria use [region readback](src/region-readback.ts) to compare stable,
cell-aligned pixel crops against independently painted references behind a paint witness.
For each declared frame, the sentinel must complete a same-crop space→glyph→space→glyph
roundtrip with exact repeatable digests; an intermediate clear alone cannot qualify paint.
This relies on faithful current captures and ordered terminal paint, not arbitrary adapter replay
or compositor completion. Missing roundtrip returns retain `no freshness witness` review. Both initial stability captures remain in the result frames because response-backed assertions cite their cell and whole-image digests. A missing pixel geometry emits a required failure row naming the missing report, retaining attempted query evidence without a feature verdict.
Expected-change and expected-no-change claims have separate controls; an unchanged frame
without freshness evidence remains review TEST TODO. Each decided signal retains its own
assertion. Missing discriminators and unmeasured feature facets remain named review rows;
cursor-shape cell and blink-phase sampling belongs to #31812. Historical frames acquire no
new comparison or grade.

`TermProbeSource.capture` supplies owned pixel capture; `cells` is a separate terminal-text route for declared cell readback. [Region readback](src/region-readback.ts) and callbacks evaluate the resulting evidence.

The app exit/1047/insert-mode rows declare character readback and use that same region oracle.
Exit and 1047 paint primary then alternate markers; leaving the alternate is compared with a plainly
painted primary reference. Text reads use the existing character change criterion; pixel reads retain
their declared freshness checks. An unqualified entry leaves any failed exit roundtrip as named TODO,
never an exit negative. A restored primary marker still leaves exact 1047 clear-on-exit and 1049 saved
cursor/scrollback unmeasured. Same-1047 re-entry does not prove clearing. IRM keeps its query-first
positives and recognized negatives; only an undecided query reaches the existing insertion fixture.

**Timed and composited rows decide by pixels, never by an acknowledgement.** The kitty animation and
unicode-placeholder rows read `capture` and compare region digests as raw bytes; neither a `_G` reply nor
a first painted frame is evidence. Animation's observation is two target frames of one rectangle with no
write between them, taken only behind four controls of the same run: a client-driven frame selection that
must differ, a one-frame image that must hold still, a cursor-only capture that must leave the rectangle
alone, and a redraw that must change the screen outside it. Placeholders compare the placeholder rectangle
with the image composited over it against the same characters on the same foreground colour with the image
deleted, with an ordinary `a=p` placement of the same pixels — measured against a captured blank — as the
live control; this queue transmits quietly, so no acknowledgement exists to inherit. The placeholder row
adds two in-run pixel controls in place of the cell readback it used to require: a layout guard — the same
short ASCII written immediately right of the grid and captured with the row below it, byte-identical in both
states, so a terminal that reflows when the image arrives is inconclusive by name rather than graded on a
moved rectangle — and a same-image veto, which makes the with-image rectangle supported only when it is
pixel-identical to the ordinary placement of the same opaque image over the same cells. Where a run does
expose a cells adapter, unequal readbacks still veto to inconclusive before the table, and a text-only run
refuses by name before it.

The run retains screenshot/text references and assertion references. A captured frame does not by itself establish support, and a pending required review does not become an unsupported result.

## How execution becomes status

Observation outcomes are `supported`, `unsupported`, `inconclusive` and `error`. Recorded probe statuses are `supported`, `unsupported`, `untestable`, `test-todo` and `test-failure`.

[recordExecutedProbe](src/helpers.ts) uses explicit callback tests when valid. Diagnostics and errors retain precedence. Otherwise its default criterion preserves supported/unsupported observations and maps the other cases:

- Missing capture reported as `FrameUnavailable` becomes `test-todo`.
- Diagnostics and error observations become `test-failure`.
- Coverage becomes `test-todo`. Refusal and consumption without a deciding observation explicitly supply TODO tests; unanswered queries and errors explicitly supply FAILURE tests. No reply, clipboard value or frame is invented to satisfy a type.
- A measured inconclusive observation stays typed and defaults to `test-failure` unless an existing explicit criterion test selects a different status.

`finalizeProbeResult` folds the required tests in order: failure, pending or empty tests, reviewed impossibility, unsupported, then supported. `untestable` needs a review reference.

That order matters: a failed test wins over a pending one. Timeout or lack of an observable is not automatically evidence that a terminal lacks the feature; the probe's criterion must establish that. An execution-only TODO can follow real I/O and does not promise an empty trace; pre-I/O refusal fixtures separately prove their zero-byte behavior.

The headless OSC 52 read callback seeds an isolated nonce and accepts measured silence only through
an available, collector-qualified sentinel query member. Its retained raw response and measured sentinel
facts distinguish that negative from an unanswered capture. Malformed or unmatched replies remain
inconclusive; an exact canonical nonce reply is positive. The write and combined clipboard callbacks
keep their existing roundtrip requirement: a read negative never decides either write claim.

Feature-specific criteria keep those distinctions local.
The canonical Kitty graphics direct-RGB query grades a correlated printable reply as supported for
`OK` and unsupported for an error, retaining the exact message and protocol recognition in its assertion.
Missing, malformed and uncorrelated replies stay inconclusive. Placement, transmission and visible
rendering keep their separate criteria; a query refusal never establishes their support or absence.

OSC 5522 tests protocol detection only: a complete matching DECRPM 5522 Ps 0 or 4 is negative, and Ps 1/2/3 is positive.
Absent, malformed, unmatched, partial or unordered-late evidence is never a negative. A complete reply within the
measured sentinel grace window uses the shared DECRPM criterion with its ordering note: Ps 1/2/3 is positive,
Ps 4 is negative and Ps 0 is inconclusive. Later bytes outside the capture still fail at the collector.
The generic mode-behavior grader is unchanged.

Headless DECCOLM decides width from five re-seeded 133-X cell/cursor sweeps, including closed-?40 controls
before and after the enabled 80→132→80 transition (mirrored from an initial132). CSI18t only corroborates
the sweeps; disagreement is a named failure and silence does not erase measured width. Both gates must hold.
The deciding assertion retains the exact raw response; its width summary and any contradicting DECRPM Ps0/4
reading remain in the observation note. Supported carries a separate positive gate assertion; Unsupported
retains the gate condition in its compound negative and both readings in raw state, without a positive assertion.
The original mode width is restored in finally on readback/capture errors. No resize or new observable is manufactured.
Headless DECSCLM names smooth-scroll presentation as unmeasured in its mode-state criterion; headless2031 names its missing host palette actuator
and persistent event listener. Mode recognition or enabled metadata cannot decide those effects.

These run statuses are separate from the catalog's [probe-coverage labels](../../docs/data/probe-status.ts), such as `automated`, `partial` and `manual`, which describe the available test definitions.

## Collector routes and persistence

[Selected collection](../../docs/collect-selected-probes.md) describes explicit context/probe inputs and retained attempt outcomes.
The existing registry exports `resolveProbeIds`; collectors share its typed resolution rather than duplicate ID lookup.
Selection changes the callback schedule, while initialized drafts retain the full catalogue and the original suite hash.
The existing `collector.selection` and `collector.collectionAttempt` records retain intent, actual start and outcome.
`recordCollectorSelection` also labels untouched TODO rows outside that schedule as not selected; selected rows retain
their not-started reason. Repeated selection updates preserve attempted results and restore still-unstarted selected rows.
The canonical draft decoder distinguishes captured runs from explicitly empty initialized drafts; empty drafts contain no measured identity or emitted result.
It accepts the original initialized empty draft or that same draft annotated by the selection writer, without normalizing
either stored form. Any other changed row remains invalid; historical captures are not rewritten.

The five admin routes share definitions, but do not all execute or persist through the same path:

- **Headless:** [admin/src/termless.ts](../admin/src/termless.ts) calls [collect-headless.ts](../probes/collect-headless.ts), which runs isolated engine workers using `headless-batch.ts` and retains private runs.
- **App:** [admin/src/app.ts](../admin/src/app.ts) launches an owned terminal/daemon, requests collection and enriches its retained response with launch and identity evidence.
- **Server:** [admin/src/server.ts](../admin/src/server.ts) starts or contacts daemons. [serve.ts](../terminfo.dev/src/serve.ts) owns `collectProbeRun`, using the native unified batch.
- **Inline:** [admin/src/here.ts](../admin/src/here.ts) calls that same `collectProbeRun`, finalizes the draft and prints it or its summary. Printing a result is not admission.
- **Mux:** [admin/src/mux.ts](../admin/src/mux.ts) runs a daemon through the multiplexer, collects its response and supplies the intended mux configuration to the shared writer.

Multiplexer expectation declarations describe routing, not terminal support:

- **`pass-through`**: the bytes reach the outer terminal and its reply returns to the pane.
- **`mux-answered`**: the outcome the probe reads is decided inside tmux, either because tmux answers from its own state or because tmux's input parser consumes the query and emits nothing; in both the host terminal is never consulted.
- **`unresolved`**: the route is not established at the pin.

The [daemon client](../terminfo.dev/src/daemon-client.ts) retains HTTP responses. The [capture writer](../terminfo.dev/src/capture-writer.ts) finalizes enriched runs and writes immutable result snapshots.

The writer checks intended id/version against known measured values without replacing them, but sets `subject.kind` from the intended term/mux subject and retains `intendedSubject` separately. Both current source and suite version are explicit inputs; a historical declaration cannot silently become a live writer's manifest.

`sealRunDraft` requires complete measured identity and no pending required review; other `test-todo` results can remain in a sealed run.

Required reviews are applied before sealing. While a review remains pending, the writer keeps an unsealed `.draft.json`; once sealed, enrichment cannot change those result bytes.

The internal admin `review intake` and `review apply` commands reuse that writer for private review.
Intake reads only an explicitly named retained run, or the named context's `pass.contexts[].rawRun`,
with its trusted frozen suite and explicitly pinned Terminfo/Termless repositories.
An existing suite declaration is read through `readExplicitSuiteTarget`. For an unregistered private
run, intake executes the existing `getTrustedSuiteReceipt` producer from the named checkout at the
run's own source commit. That producer verifies the loaded suite, checkout revision and clean
collector inputs; no manifest is reconstructed from the run or written to the registry.
Intake and apply receipts name the chosen registry/source-receipt path, producer, pin and manifest SHA256.
Only measured pass rows (`pending-review`, `classified`, `admitted`) may supply `rawRun`.
The issuer edits the intake's `decisions` array: each entry holds exact canonical decision `source`
bytes, actual `startedAt`, their SHA256, and a `citations` index into that decision's `sources[]`.
Each Git citation renders exactly as `terminfo.dev@<40-hex-commit>:<repo-relative-path>:L<first>-L<last>`
(or `termless@...`); external citations render as `<portable-source-path> sha256:<file-sha256>`.
The external tree's absolute lookup `root` lives only in the private index, never in the decision.
The full citation must be the corresponding decision source string, so the retained decision is
independently re-verifiable without the index. Non-code references are explicitly classified and
are never reported as Git-verified. An absent external path reports `unverified: <path> (tree absent)`;
a present file requires its matching recorded SHA256. Required Git objects must resolve.
Apply verifies bindings, assertion prefixes, original raw values, result membership/order and
non-target rows, exact appended review records/assertions, and canonical readback. The writer finalizes
the private output when no required review remains; otherwise it retains a pending draft.
Selection, admission and publication operations are never invoked. Files are explicit absolute private outputs,
created exclusively with mode 0600; empty decisions produce only a no-op receipt. See `bun admin review --help`
and each subcommand's help for required inputs. The two real shadow comparisons remain required
before retiring manual review steps.

A reviewed capture decision may name `tool-gap` when the observable is buildable but its instrument is unbuilt.
Its required reason names the missing instrument and its owning issue. The existing applier replaces that
pending `review` test with a `criterion` TEST TODO, preserving the decision bytes and original capture evidence.
It creates no assertions. Other failed tests retain precedence; a tool gap is not an impossibility or a support grade.
The run can then seal, and its canonical reader and result counts retain `test-todo`.

A curated `tool-gap` overlay may also supersede an embedded `collector.review.*` decision on an exact
sealed `runId` and `runSha256`, for the same feature and scope. Supersession readers require that parsed
sealed run to resolve the target; missing runs or mismatched identities remain errors. The existing
per-run TODO projection shares its application with the console-host rule, so version tables, counts,
selected contexts and public results agree while the sealed source stays byte-identical. This cell-level
review grants no identity or community-submission approval, and implies no global withdrawal on future captures.

New capture decisions explicitly carry `evidence: { algorithm: "evidence-output-v1", sha256, projection }` beside
the original `captureSha256`. The projection binds subject kind/id/version/os, the loaded engine's stable
identity and native build provenance, that engine's `runtimeIdentity.adapterSources` path/blobOid pairs,
the whole raw feature entry's canonical SHA256, and the cell's original tests, assertions, raw bytes,
criterion, frames and host evidence. Object keys are sorted; array order, nulls and string bytes remain exact.
The catalog computes entry hashes during its existing parse; the suite manifest freezes them in
`catalogEntrySha256`. The reader uses that manifest, never the live catalog.

Every library backend declares the `adapter-sources` extension from its one adapter registry.
Reply-delivery declarations, when present, share that registry's same source array; identity alone grants no reply capability.
The collector verifies declared blobs against tracked imported source bytes once per runtime, then compares per-instance declarations.
Missing identity or stale declarations are named collector errors. Historical captures may omit this field.
Source engines bind repository and tree OID with `cleanTree: true`; dirty source leaves a review pending with a named reason.

Run ids, suite/source revisions, source-integrity commit revisions, global `termlessRevision`, filesystem locators, timestamps, attempt
envelopes and reviewer-derived assertions are provenance rather than equality inputs. For non-source-negative
cells, the projection also retains the structured reply-delivery declaration and only that feature's
qualification decision; its nested runtime identity is already bound by the stable identity above.
Source-negative cells retain the engine's adapter identity without including the global qualification map.
An absent adapter identity or historical manifest without entry hashes grants no new-key carry. Old decisions
remain under their original rule and are never promoted or rewritten.

Natural collection loads accepted decisions through the existing interpretations parser and supersession
chain, then supplies them to the same capture writer. One evidence match applies; matching decisions with
the same exact verdict and reason are recorded as duplicates. Conflicting matches or changed evidence leave
review pending, with named components in each context's `reviewBindings` report in `pass.json`.
A candidate that fails an application prerequisite is reported as refused; other cells can still carry.
The report records old-rule and new-rule results for every pending review cell. Original decision source strings,
capture raw values and assertion prefixes remain retained; each enriched pending draft is another immutable
snapshot in the existing output directory. Seal and admission remain separate checks.

[admit-collected-run.ts](../admin/src/admit-collected-run.ts) keeps the private response/run first. App and mux output-directory mode stops there; their default mode and the server route also attempt admission.

Admission is a separate operation owned by [run-admission.ts](../admin/run-admission.ts), exposed through [scripts/admit-run.ts](../../scripts/admit-run.ts). Pending review stays private, not admitted.

That owner checks the run, suite and cited artifacts before placing admitted content. A private collection, successful test or sealed result alone does not mean site data has been published.

## How a draft becomes a measured cell

`cells.json` is the remeasure instrument's own record of what it measured: one `engine -> featureId -> status` map, written
per run. It is **not** what the site publishes from — published coverage is projected from the accepted and admitted content
under `content/` — so a status here is a measurement, never an admission. A `draft.json` is not that map either, and neither a
draft nor a count of its results substitutes for it.

The projection is one row, one draft, statuses copied verbatim. The instrument reads `pass.json`; for each entry it takes the
engine from `context.id` and the draft from that row's own `rawRun`, then writes each result status into the cell for its
feature id, so a cell always states what the named draft said:

```ts
for (const result of draft.results) {
  engineCells[result.featureId] = result.status
  counts.set(result.status, (counts.get(result.status) ?? 0) + 1)
}
```

That loop is `readCells()` in `tools/terminfo-remeasure.ts` in the `hh` dev repo, not in this package: this package owns the
draft, the dev repo owns its projection.

Three rules follow, and each has cost a reader time:

- **A row that was not measured contributes no cells, whatever its draft says.** `unmeasured()` refuses a row whose status is not
  `pending-review`, `classified` or `admitted`, or whose `rawRun` is missing on disk. A draft left behind by a failed context is
  not evidence about a cell, and the instrument's line names that draft rather than a cell for exactly this reason.
- **`pass.json` (`contexts[].rawRun`) is the sole authority for which draft was graded; every reader resolves through
  `contexts[].rawRun` and refuses by name when it is missing.** Pre-resolution headless intermediates are written under
  `<pass>/first-pass/<engine>.draft.json` for forensics, and the pass directory's output set holds one identity-resolved
  draft per measured engine, the exact file `pass.json` names.
- **A recorded decision does not move a measured cell.** Decisions are applied by `applyCaptureDecision` in the
  [capture writer](../terminfo.dev/src/capture-writer.ts) while a run is finalized, so they shape the draft at capture time. A
  decision recorded after its draft was captured has no path back into that immutable draft. During natural collection,
  the pass finalizer now supplies accepted interpretations and the trusted current manifest to that same writer before
  assigning `rawRun`. Cells project from the resulting snapshot; an unmatched required source review stays `test-failure`.
  These remain private measurements, separate from admission and site status.

Worked example, from the run written 2026-10-31 06:34 UTC. `pass.json` holds 11 rows, all `pending-review`, each naming one
draft; `cells.json` holds those same 11 engines at 273 feature ids each. The directory also holds 11 `lib-*-unknown.draft.json`
files, so 22 drafts project to 11 engines rather than 22. Those 11 unprojected drafts happen to be status-identical to the
pinned ones the rows name, so choosing wrongly is harmless here; that is a property of this run, not a rule to rely on. Within a
draft there is nothing to disambiguate either: all 22 drafts carry 273 results over 273 distinct feature ids, so the loop above
never overwrites, and "several results per `featureId`" is not a live hazard.

Read status from `cells.json`. Counting results across draft files, or reading a draft whose row was refused, yields statuses no
cell carries — which is indistinguishable, at the time, from a regression. The 2026-10-30 ghostty case that motivated this
section is consistent with exactly that, and with reading another run's draft; neither run is on hand to separate the two, so it
stays open rather than being claimed as explained here.

The [execution and seal-boundary tests](src/execution-results.test.ts) exercise these distinctions without collecting new terminal data.

`measureRenderedWidth` returns a number or a named readback cause: `no-reply` with its step,
`control-mismatch` with its step and observed cursor, or `wrapped` with its observed cursor.
All width callbacks distinguish these before applying their numeric feature criterion: missing
readback is named TEST TODO; wrong controls and wrapping are named TEST FAILURE. A wrong numeric
ASCII control is also a fixture failure. Unknown transport kinds throw with the probe and kind
named. `/query` retains the same result in its `width` field. JSON preserves the cause fields.

The vt100/vt220 mode-family source review never infers mode absence from rejected DECRQM.
At revisionbd3d32ae, exact clean source/entry/package trees and audited adapter blobs qualify
the six absent private modes2004/1004/1003/1006/1000/1005, plus1007/2026/2031 and the SGR/color
stack commands. Each engine cites its own complete dispatcher and absent command case.
Its own set/reset or stack pair runs between rendered X marks: consumed commands and leaked
text retain different reasons, line and cursor state. This uses existing buffer-state
`source-negative-review` with a negative assertion, inconclusive observation and review TEST FAILURE;
it does not create a decision or automatically grade Unsupported. Missing X, moved line or
unqualified source remains named TODO. Actual DECRPM replies retain their original result.
Stored mode1 on both engines, and5/66 on vt100, remain held instrumentation TODO. The private
mixed-observable arms use the existing undeclared assertion type so query replies and reviewed
buffer state both survive actual collection. Other engines and terminal callbacks retain their behavior.

The exact-runtime source audit also covers highlight set/reset absence for vt100, vt220, libvterm and
vt100-rust. A silent query plus rendered X retains independent source review for OSC117/119; it
does not establish a measured reset negative. A missing OSC1 icon getter retains source review only
for pinned vt100, vt220, Alacritty and Ghostty WASM/native engines whose own dispatch discards the
icon name. Other missing icon observers retain their existing coverage result. The review keeps
the actual OSC1 stimulus and before/after title state; title behavior alone is not icon support.
