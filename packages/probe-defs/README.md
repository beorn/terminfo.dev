# Probe definitions and collected evidence

`@terminfo/probe-defs` defines term feature probes, their observations and the shared run model. Start at the [exports and probe registry](src/index.ts); [types.ts](src/types.ts) owns the record types.

This describes the implemented system. Callbacks still perform live I/O and evaluate it together. The private viprobe package supplies the ordered record/read/replay core. Both TTY recording owners derive their legacy display events from validated call logs. The selected eleven-probe erase runner captures actual xterm.js effects once and reasserts them twice offline with task-owned checks, bound artifact provenance and domain reporting. Its artifacts remain under the fixed private `~/.terminfo-dev/replays` root, with a separate directory per attempt. The wider collector migration and reassert CLI remain unfinished under recorder #30932; no stored grades change.

## Vocabulary and current code

- **Probe subject**: the exact terminal app, emulator library or multiplexer being probed, at a recorded path, OS and version. `ProbeSubject.kind` is `term`, `lib` or `mux`.
- **Term feature**: one terminal behaviour being tested, identified by `featureId`, with one `ProbeDefinition` supplying lib and/or term paths. A mux uses the term path.
- **Probe source**: where answers come from. Existing collectors supply `live` answers. Schema 4 also retains a `trace` artifact reference and its capture run, suite and source revision; the offline runner must validate those bindings against retained artifact bytes before replay.
- **Probe trace**: everything one probe run did and saw, entry by entry, including referenced files. Current collectors retain subsets, not a complete replayable record.
- **Test**: one required condition of a probe, with its own status and assertion references. `ProbeTestResult` is stored; `ProbeTestInput` is supplied by a callback.
- **Assertion**: one expected-versus-observed comparison. `ProbeAssertion` carries positive/negative polarity independently of its `assertionType`.
- **Probe result**: one probe on one subject, with its status, tests, assertions and retained evidence. Stored `ProbeResult` and callback `ProbeCallbackResult` are separate shapes.

The five assertion types classify the deciding observation: `query_reply` reads a query reply; `buffer_state` reads cells, cursor or modes; `screenshot` reads captured pixels; `input_bytes` reads bytes received for an OS input event; `clipboard` reads what an OSC 52 write put on the clipboard. Probe setup and feed writes retain their existing order and bytes; they are not a sixth assertion type.

The five display labels are Supported, Unsupported, Untestable, Test to-do and Test failure. Their stored code values remain `supported`, `unsupported`, `untestable`, `test-todo` and `test-failure`; this vocabulary change does not change status or publication behavior. Pending review is a reason under Test to-do, not an additional status.

Callback observation outcomes are `supported`, `unsupported`, `inconclusive` and `error`, not five result statuses.
The [writer and finalizer](src/helpers.ts) fold explicit tests and diagnostics into the result:
a supported observation can still have a failed or pending required test; an inconclusive observation alone
does not establish Untestable. Without explicit tests, a diagnostic or a conclusive outcome, named
missing-observable coverage defaults to Test to-do; rowless inconclusive without that coverage defaults
to Test failure. Untestable still requires the implemented review reference.
Highlight reset cannot be decided without an initial colour reading. When the DA1 control completes but
OSC 17 or 19 supplies no initial colour, the callback records a named Test to-do; broken or untrustworthy
measurement remains Test failure. Silence alone does not establish Unsupported.
The [legacy presentation keys](../../docs/data/release-scope.ts) are a different shape:
The `CellState` value `inconclusive` denotes reviewed Untestable, `error` denotes Test failure and `untested` denotes
Test to-do; `supported` and `unsupported` retain their corresponding labels. Do not substitute callback outcomes for these keys.

New pending source reviews use the existing Test to-do status. Legacy captures retain their recorded source-negative review Test failure; readers accept both pending forms. Kept source answers live in [source-answers.json](src/source-answers.json), keyed by the exact subject kind, engine, version, OS and feature. Insert new entries in stable order by subject kind, engine ID, OS and feature ID, placing each new version after that feature group's last entry. Each original retains its own status, cited blobs and provenance. Originals with equal status and normalized citation sets share one entry without losing any original reference. The row's canonical tuple travels in the existing result/test `reviewRef`; the canonical reader requires that row, rather than embedded capture-decision bytes.

For new SGR 59 headless results, a sent SGR 58 seed with no stored underline colour offers `source-negative-review`. Unsupported requires a qualifying answer that cites the exact engine's own SGR 59 dispatch absence and its build provenance; a missing seed alone remains Test to-do. Seeded controls and stored `headless-observable-review` results keep their existing criteria.

The [shared source-answer resolver](src/source-answers.ts) evaluates each original independently. Own-version fallback applies only when the run has no revision fact for a cited repository. A named equal commit is unchanged; a named different commit requires equal path blobs at both revisions. Cross-version carry requires every cited blob of that original to match the measured runtime. Agreeing qualifiers apply; disagreeing qualifiers stay Test to-do. With no qualifier, a positively different blob gives Test to-do, including at the original version; otherwise pending work names its candidate and missing repository revision. The writer’s [Node I/O owner](../run-parser/src/source-answers.ts) throws for missing checkouts, wrong remotes or incomplete history. Genuine object absence in a complete repository stays pending. Registry integrity and a native wrapper commit do not establish engine blob identity. Static answers remain at their recorded version, labelled `reviewed at <engine version>, not re-verified`; no review date is inferred. The writer discharges only the review test; actual failed criterion tests retain precedence. The canonical parser validates referenced answer identity without re-resolving or regrading the recorded result.

Pending answers, external release and publication remain held until the actual full Phase 1.4 merge and their existing authorization.

Terminal tiers describe progress: 0 missing, 1 incomplete, 2 broken and 3 done. These are distinct from the former Release 1 query/reply group and from color depth. This terminology defines no thresholds and changes no status computation.

The existing [completeness helper](../../docs/data/release-scope.ts) uses the supplied graded positions:
empty means tier 0; any Test to-do means tier 1, even alongside failures; otherwise a Test failure means
tier 2; otherwise tier 3. The helper itself does not verify full catalogue membership.
The numerical support share is Supported divided by all graded positions, not results done divided by total.
The [nine exact environment IDs](src/environment-groups.ts) remain visible but excluded from grading,
the denominator and completeness tiers. The [admin report's](../admin/report.tsx) literal `N/M` means
manual-by-design, NOT MEASURED for their Test to-do rows; it is not a numerical fraction or a sixth stored status.
An [OS row's inherited or reference source](../../docs/os/%5Bid%5D.paths.ts) can supply its displayed counts;
those are the source's results, not an independent measurement of that app and OS.

[Catalog coverage](../../docs/data/probe-status.ts) is separate again: automated, partial, manual,
undeclared or unprobed. A catalog manual/partial override takes precedence; otherwise the existing
definition, callback-arm and assertion-declaration checks determine coverage. These labels neither grade
a result nor establish that both positive and negative controls exist. Overrides and result statuses stay unchanged.

Collection retains measured records and applies eligible kept source answers during finalization. Pending answers, external release and publication remain held until the actual full Phase 1.4 merge and their existing authorization.

`release1-collection --collect --development --output <private-directory>` retains private collection and its actual attempts.
The pass records private attempts, custody and coverage.
Failed hosted collection retains its original delegated draft as failure custody when canonical `run.json` is absent.
Only a source-, suite-, run- and selection-bound collector attempt with a recorded start establishes execution;
a job-start marker alone does not. A nonzero collector exit reports `failed`, with its exit code and log path.
This custody never supplies grades or bypasses canonical validation.
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
Every confirmation compares consecutive complete frames under one fixed deadline.
Calibration tries basic background colors, then reverse-video spaces if basic paint is not observed;
the chosen form and attempt outcomes are retained, and stripe colors come from the captured pixels.
Both forms missing leaves a named no-capture outcome; complete geometry and restoration checks still apply.
For a verified collector-launched disposable session on Darwin or Linux, including a Linux mux,
calibration explicitly sets cursor visibility before painting and restores that set state.
It does not infer the prior state from a launch default or DA1. The retained raster basis names the
explicit setup; identical restoration concerns surface pixels without a cursor-mode readback claim.
Sessions the collector did not launch require a reported original visibility and restore it unchanged.
Native capture-command failures during installation retain their primary command evidence and
secondary restoration failure in the named per-row no-adapter outcome, including native command deadline kills.
Terminal-query timeouts and apparatus errors without a native capture-command cause retain their existing failure behavior.

**A definition is executable, not a saved result.** `ProbeDefinition` identifies a feature and supplies either or both callback arms:

- `lib(ctx)` is synchronous and reads a `LibProbeSource` backed by a headless engine.
- `term(ctx)` is asynchronous and uses a `TermProbeSource` for real-terminal I/O and any available owned capture, clipboard or input facilities.
- A null arm has no implementation for that route. Ownership, geometry, text-readback and assertion-type declarations constrain the arms that do exist.

Library `getMode` returns `boolean | null`: null names an unavailable adapter readback,
not a reset state or a terminal-support verdict. Callbacks retain it explicitly.

OSC52 write/roundtrip callbacks retain qualified read-sentinel silence as a named Test to-do
when no clipboard-state witness is wired; a read negative cannot measure the write.
The audited xterm composition instead uses the fixed OSC52/rendered-X control after a clean
qualified read negative without a witness, retaining buffer-state `source-negative-review`
as Test to-do pending source review, never automatic Unsupported.
OSC5522 detection checks the current library DECRQM sibling-query family after qualified target
silence. Qualified silence from every control names an unmet detection prerequisite as Test to-do,
retaining each raw window. The exact reviewed VT100/VT220 source trees at vterm9e99e4d2 with
Termless25089207 can instead retain source-negative review when all fifteen windows contain only
their DA1 sentinel; the kept engine/adapter-source answer establishes Unsupported. No other
identity or observed reply enters that branch. Any control reply leaves target silence as Test failure; complete,
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
mismatched adapter reading retains a criterion Test to-do named
`adapter binding <backend.name> <mode>`; the name is display-only and never selects
a status or route. Existing other DECRPM criteria retain their prior readings.
Application-keypad instead measures `ESC =` / `ESC >` (DECKPAM/DECKPNM) with
`applicationKeypad` true then false, without DECRQM. Null readings stay named
adapter-binding Test to-do; other non-null pairs stay criterion Test to-do naming both states.
Keypad encoding and wheel-to-cursor-key translation remain unmeasured.
Private4 additionally requires non-null ANSI `insertMode` readings before and after
set and checks that they do not change; an observed
flip is engine conflation, independently of its reply (the existing private4 issue32002).
Presentation remains unmeasured for reverse-video/synchronized-output, the actual
scheme-change report remains unmeasured for2031, and smooth-scroll presentation
remains unmeasured in the library arm. DECSSCLS feeds `CSI 9 SP p` plus a marker and
retains screen text and cursor state. Consumption without visible effect requires an
source review (pending Test to-do); leaked sequence text is a measured
negative, and a changed grid or misplaced marker stays inconclusive. Consumption does
not prove handling or scroll-speed presentation. A source that stores speed without
readback remains a Test to-do tool gap when reviewed. Application criteria are unchanged.

Both source interfaces carry `readonly kind: ProbeSourceKind` directly. Current runs retain exactly `source: { kind: "live" }` or `{ kind: "trace", trace: { path, sha256 }, captureRunId, captureSuiteId, captureSourceRevision }`. The trace path is relative to the artifact store and contains no parent segment; its SHA256 and capture identities are required. Initialization and the canonical reader validate this union; the collection writer currently implements live sources. Call-log format/version remain inside the referenced artifact. The current run reader accepts schema 4. This source declaration grants no capture or publication.

`termAssertionType` and `libAssertionType` declare a retained deciding-observation class. An explicit null means the callback runs without a typed deciding observable; undefined is temporarily undeclared (#28801). Neither means the callback arm itself is absent, and neither becomes a null observation or assertion type.

The library declaration also accepts an inline `{ when, then, otherwise }` descriptor. Each branch is a nonempty set of distinct existing assertion classes. The headless collector evaluates the pure `when` predicate exactly once before the callback, using identity and getter presence without I/O, then requires the returned observation class to belong to that selected set. A thrown or non-boolean predicate is a collector error. The descriptor is never serialized: retained observations, assertions and results still carry one scalar class. Scalar, null and undefined declarations keep their existing meanings; application declarations remain scalar.

`ALL_PROBES` collects the category definitions. A current `ProbeSuiteManifest` explicitly carries schema version 4 and separates complete `catalogIds` membership from the callback schedules in `probes.term`, `probes.lib` and `probes.mux`. Historical declarations normalize their schedules on read while retaining their original absent schema marker.

The [shared execution helpers](src/helpers.ts) initialize every catalog member as `test-todo` with no attempt, then record only the work actually performed.

Library SGR 39/49/59 resets without a distinct colored setup retain their actual cell state on a
named `headless-observable-review` Test to-do row. That missing prerequisite cannot establish a
reset negative. Compound attribute resets with unshown setup attributes retain a named
`source-negative-review` Test to-do until the complete criterion is reviewed; a partial reset
does not decide the whole claim. Other source-negative style reviews keep their existing failures.

TERM_FEATURES means a terminal program's export into its child environment. Its library arm performs
no I/O and retains a `headless-observable-review` row with the API boundary and audited adapter blob for
per-engine source review. It creates no observation or assertion. The application arm remains Test to-do until terminal-owned child readback exists.

Source audits match the shared evidence identity and declared adapter source blobs, not global
Termless revisions or host filesystem locators. Raw replies and observed payloads do not embed
runtime identities; the record's allowlisted identity is their sole carrier. WASM engine identity
uses the loaded binary digest, while wrapper repository/tree metadata remains provenance.

Headless collection checks declared-versus-loaded native SHA before probes, independently of source-audit
membership. An unaudited binary still collects observed buffers and replies. A silence-dependent cell without
its binary's source audit retains TEST TODO with `no source audit for binary <sha12>` and its raw response;
it never borrows another binary's citation. Hourly measurement calls the existing `collectHeadlessRuns`
entry point and reads its `collection.json` through the canonical run parser, without importing review selection.
App/hosted collection keeps its existing driver.

The source-qualified OSC callbacks in [extensions.ts](src/extensions.ts) feed their exact commands
and a rendered-X consumption control, retaining fed/cell state and applicable buffer-state assertions.
The control proves parser consumption, not a target effect; target state remains explicitly unexposed.
A missing X supplies no source-derived negative, and unqualified identities keep their named coverage.
The callback-specific source reasons distinguish absent handlers, notification sinks and parsed-but-dropped
or ignored commands. Their source qualification is not a capability declaration or a measured target effect.
Retained source answers follow the shared resolver described above, not a new per-capture pin checklist.

The two highlight resets (OSC 17/117 and 19/119) query the initial colour first.
A real colour reply follows the measured reset criterion. Only an empty initial
reply at an audited xterm.js or Alacritty identity can enter source review, and both set and
reset codes must belong to the same audited entry. The callback feeds the exact
set/reset commands and an X control, retaining the query, reply, runtime and
control state as buffer-state source evidence. The measured reply route remains
query-reply evidence; these two lib arms stay temporarily undeclared under #28801
because a single assertion-type declaration cannot state both routes.
A rendered X retains the source-derived negative assertion, not a measured reset negative.
A missing X retains no negative assertion or review; other identities keep the named prerequisite failure.
Retained source answers use the shared resolver described above.

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
block without claiming painting support. The app coverage callback performs no I/O and stays
Test to-do because it has no live terminal UI scroll actuator; its manual UI recipe remains in the catalog.

The optional library capability `productViewport: { available: false, reason }` explicitly declares
that the library subject has no product viewport; an absent declaration means undeclared. The
collector omits the probe source's scroll control for that declaration. Before any phase action or
OSC720 history I/O, the viewport-hold and OSC720 callbacks retain the declaration and exact reason plus
`runtimeIdentity` (null when missing). The missing-observable branch selects `headless-observable-review`
with named scroll-control coverage, not a measured scroll result. OSC720 first checks its callback-specific
source-absence qualification when the viewport is declared absent and no scroll control exists;
that route retains its own source evidence. Retained source answers use the shared resolver described above.
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
`criterion` Test failure: `source identity drift: expected <oid>, read <oid>`.
A known engine matches identity kind, runtime format, source repository, engine version and exact
repository-relative entry path. The entry path distinguishes vterm, vt100 and vt220 within their shared repository/version.
Tree drift is checked before clean-tree, adapter, binary and revision qualifiers; those keep their existing roles when the tree matches.
History fails before stub I/O; geometry retains its actual query and reply before reporting drift, whatever the reply shape.

**Callback and stored shapes are different.** Follow these names in [types.ts](src/types.ts):

- `ProbeCallbackResult` has three arms: a measured `observation`; `notTested` coverage naming a missing semantic observable; or execution-only, nonempty Test to-do/Test failure `tests`, each with a mandatory reason. Execution-only callbacks have no observation, assertions or coverage. Callbacks can select a criterion branch.
- `Observation` records an outcome and required `assertionType`. `ProbeAssertion` records the independently positive/negative predicate, required `assertionType`, expected state and retained observed evidence.
- `ProbeResult` stores the feature's execution status, attempt, required tests, selected criterion branch and evidence references. Its optional primary `assertionType` names only a retained observation; absence is not a sixth type. Legacy `pass` never grades it.
- `RunDraft` is a private schema-4 envelope: explicit source, run/suite identity, `intendedSubject`, measured `subject` when available, raw replies, assertions, artifact references and probe results. Subject kinds are `term`, `lib` and `mux`.
- `CapturedRunDraft` and `CurrentProbeRun` require measured subject, identity, time and origin; `ProbeRun` aliases the current shape. Historical stored bytes are immutable. A historical `sealedAt` field is ignored for current parsing and selection.

The legacy callback `pass` still exists for the [diagnostic Vitest runner](../probes/run-unified.probe.ts), including the execution-only arm. Current collectors record observations/tests through `recordExecutedProbe`; even `pass: true` with an explicit Test failure test stays failure. Cleanup #30929 removes `pass` from every arm.

A callback can mark explicit failure tests that need actual request evidence. An execution-only callback uses
`replyFailure`; a measured callback can retain a partial observation while marking its required-reply failure.
The callback-only `replyFailureTestIds` never enters a stored result or draft. After the callback returns,
the TTY or headless producer uses `withReplyFailureEvidence` to append escaped sent/received bytes and the
actual timeout or synchronous capture boundary to only those marked failure-test reasons. Readers find the
attempts in the stored criterion test's reason; the observation note and top-level summary stay unchanged. Grades, test IDs,
criterion branches, observations and assertions remain callback-owned. Missing request records remain
named failures; they do not prove that a producer is absent. Proved missing required capabilities or
identity-bound declarations retain named Test to-do results without markers. Malformed replies, sentinel negatives
and artifact-review branches keep their separate criteria and remain unmarked.

A region seed whose characters arrive without their painted background or inverse attribute fails the
claim's precondition. Live and replay retain the same `criterion` Test failure and `PreconditionFailed`
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
`headless-observable-review` tool gap; getter errors propagate. For OSC 9
notifications without a reader, an existing exact-runtime absence audit and a
rendered sentinel instead retain `source-negative-review` as Test to-do,
pending source review. Vterm's progress-only OSC 9 audit cannot qualify a
notification negative; its missing notification reader remains a tool gap.

## Evidence, capture and assertion

The library reflow callback uses the optional `LibProbeSource.resize` control; every production
source forwards it directly to the existing required backend operation, regardless of the declared
reflow capability. A hand-built source without the member keeps the named no-I/O Test to-do. Initialized
`cols` retains its original meaning; it is not post-resize geometry. Fresh ASCII wrap controls qualify
the actual width effects through cells, because adapter dimensions can merely mirror a request.
The main-screen fixture seeds an 18-character line and distinct CRLF lines before each resize,
verifies the cursor is parked below them, and measures growth12→20 and shrink20→12 independently.
The line starts soft-wrapped for growth and unwrapped for shrink. Ordered feeds, requested sizes
and actual cell/cursor/scrollback reads remain in the existing response JSON. Exact reflowed layouts
supply positive main-phase buffer-state assertions. Preserved physical rows on growth and the same
rows clipped to 12 columns on shrink supply negative assertions. Failed controls, unexpected cells or
boundaries, and conflicting positive/negative phases retain required Test failure tests. Finally restores
the initial dimensions and resets the source, attempting both operations and preserving all causes.

The same callback measures retained-history growth and shrink in independently reset buffers.
The soft line and explicit CRLF rows are followed by twice the screen height in uniquely numbered
hard witnesses, without a final newline. Coherent counts bound every absolute-buffer read by the
fed rows plus screen height; invalid extents retain their counts without allocating from them.
Before resize, all target rows must remain in history and the complete seeded layout must match.
No retained history and an evicted or incompletely retained target have distinct named Test to-do reasons
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
Unknown identity and a measured entry that leaves the primary active have distinct named Test to-do results:
`alternate buffer identity unavailable` and `alternate buffer not entered`. Neither is a reflow
negative. Corrupt setup, inconsistent identity, failed controls/restoration and unmatched layouts
retain invalid phase evidence. A failed marker or readback before the measurement slot stays invalid,
even when buffer identity is false or unavailable. Before the slot, only a clean failed-entry observation
can yield an identity or no-entry Test to-do.
Slot errors retain their cause while measured/final leaves run;
outer cleanup independently attempts alternate exit, initial-width restoration and reset.

The library criterion requires main-screen growth/shrink and retained-history growth/shrink.
Each required row cites only its own phase's assertions; the existing mixed-main criterion cites
only main assertions. The shared finalizer gives required failures precedence over Test to-do results, then
measured negatives, then support. Main reflow with retained physical history is Unsupported;
missing qualified history remains Test to-do, and corrupt tails or unmatched layouts remain failures.
The reason names the graded phases and their results.

Alternate-screen phases retain their statuses, positive/negative assertions and raw response but
do not decide the grade: full-screen apps redraw on resize, and intentional physical-row preservation
there does not negate main-screen or history reflow. The reason reports alternate results as not graded.
Invalid alternate evidence stays visible without vetoing the graded phases; cleanup failures still error.

Supported reasons state: "ASCII reflow measured on main screen and retained history; wide characters,
cursor on a wrapped line and terminal-app resize unmeasured". No broader coverage is inferred, and
the separate terminal-app arm remains Test to-do. Private apparatus results grant no exact-run decision,
corpus placement; the native absolute-row consumer hold remains with independent batch review.

A default-config observation is not engine capability absence. Libvterm0.3 exposes
`vterm_screen_enable_reflow`, disabled unless the embedder enables it, and the current adapter
retains no history, keeping this criterion Test to-do. Its one future qualification route installs
scrollback callbacks, enables reflow and records the setting with the next adapter re-pin.
A source review of default-off behavior cannot replace that recorded enablement. This slice changes no adapter.

The Linux Kitty/Ghostty launcher pins one exact font file for the entire run, with no fallback face,
through a private fontconfig directory. Its receipt retains that file's SHA256, launch arguments and HarfBuzz glyph
sequences for `!= -> => <= ==` with liga/calt on and off. A glyph-ID difference proves source-face
capability independently of the renderer; position differences alone do not. The collector retains
the validated `fixture.font` bytes as `collector.fontSource` for every non-mux Linux run selecting the
font review, including plain receipts from other launchers. The retained receipt and spaced-control and
target frames supply the evidence for assessment. Missing or inconclusive proof leaves Test to-do naming
`#32062 font control` and its proof state; it does not establish Untestable on a pixel arm.
This does not change earlier captures or xterm's rendering pin.

Callbacks currently perform I/O and judge it in the same implementation. There is no general persisted callback transcript or independently replayable assertion API supplied by this package.

The five `AssertionType` values classify an actually retained deciding observation: `query_reply`, `buffer_state`, `screenshot`, `input_bytes` and `clipboard`. Pixel versus text-cells capture payloads and positive versus negative assertion polarity remain separate facts. An OSC 52 write decided by independent clipboard readback is `clipboard`; paste decided by `readInput` is `input_bytes`, including its existing control/report envelope and performed action.

The XTEST key criterion requires the ctrl+a modified-key encoding after its plain-a delivery
control; a bare control byte or another modified key does not meet it. Pixel mouse reporting
uses the existing terminal-reported cell geometry to predict the pixel box of the control
click's cell and retains that geometry with the target report. Missing cell geometry stays
named Test to-do. The two scroll-region recipes seed and preserve a nonblank marker immediately
above the requested top row. The insert/replace query criterion requires set then reset
(Ps 1 then 2); permanent-state replies retain their numeric readings and fail that toggle claim.

The twelve real-surface input term criteria retain genuine input measurements. Only an absent
`input` or `readInput` facility selects the named Test to-do `real-surface input injection (XTEST/CGEvent)`.
The seven host-input library rows (`input.xtest-key`, `input.xtest-click`, `input.xtest-wheel`,
`input.button-event-mouse`, `input.pixel-mouse`, `input.urxvt-mouse`, `input.x10-mouse`) and
`extensions.clipboard-paste` retain `os-input-review`, with reason
"Lib arm: the engine consumes bytes and has no input surface; host input encoding is measured in the terminal arm."
This remains a review Test to-do; there is no standing class rule, callback grade or change to earlier captures.

Four term mode criteria opt into `decrpmModeProbe`'s set check: reverse video 5, synchronized output 2026,
DECSCLM 4 and color-scheme reporting 2031. Snapshot Ps 1/3 is Supported without mutation; Ps 0/4 is
Unsupported without mutation. Snapshot Ps 2 sends DECSET, queries again and restores DECRST:
Ps 1/3 is Supported; a retained Ps 2 is Unsupported with "recognized but DECSET refused (mode kept reset)".
No reply is Test to-do "no DECRPM reply"; an attempted set still restores the reset snapshot.
These callbacks require the existing disposable-terminal authority. Their limitation is
"presentation (tearing, scroll cadence, inverted frame) unmeasured; protocol measured".
Every other mode keeps the default recognition-only path.

DECSSCLS is CSI Ps SP p, not a DEC mode: its term criterion still requires timed screenshots.
Its library arm stays `headless-observable-review` with null assertion type and reason
"presentation speed: headless engines paint no frames and expose no scroll-speed state".
The missing presentation-speed observable remains Test to-do.

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
Other control outcomes retain criterion Test failure. The retained run identifies its suite and raw evidence; this callback grants neither automatic Untestable nor support.

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

Cell `dim`, `italic`, `strikethrough` and `blink` readbacks are required `boolean | null`: null means the producer does not report that attribute, never a terminal-support claim. On a rendered X cell, their SGR probes retain the null or false state through `source-negative-review`, with a required review and a buffer-state assertion. An engine implementation gap and a binding gap are distinct; retained source answers use the shared resolver described above, without turning an unreported value into a measured negative. Positive booleans retain their supported observation path. A missing X retains an inconclusive result without a deciding assertion. A rowless, unnamed inconclusive result keeps the writer default Test failure (callback defect); only an explicit named test or review row classifies its cause. It is not reclassified as missing-observable coverage. Stored captures remain unchanged.

The OSC 8 library criterion requires exact per-cell URI metadata, including unlinked controls.
An absent `hyperlinks` observer with valid fixture text retains named coverage (Test to-do) and raw cell/link state,
identifying the loaded adapter path and Termless revision when measured runtime identity is available.
The callback-specific audited identities in [extensions.ts](src/extensions.ts) instead retain
`source-negative-review` and a negative buffer-state assertion for the same valid ALINKZ fixture.
Qualification binds source identity and applicable loaded-artifact evidence, not a capability version.
An unqualified runtime or broken text fixture cannot acquire that source assertion. Retained source answers
use the shared resolver described above; they do not create new measurements in stored captures.
Declared getters returning null report unlinked cells, so URI mismatches remain measured negatives; invalid declared getters still throw.

The declaration-only library checks (Kitty animation and Unicode placeholders, Sixel,
semantic prompts, OSC 633 and iTerm2 images), OSC 7 and notifications without their metadata readers, an unaudited absent OSC 8 URI observer,
and checks lacking timing, host-event or rendering facilities retain their existing coverage and raw
state on `headless-observable-review`. Each carries a required review naming its missing observable.
Measured mode state is separate from unmeasured presentation, including scroll cadence, inverted frames
and tearing. Retained source answers use the shared resolver described above;
source review establishes no rendered effect or measured negative. App callbacks and real-observable
paths keep their criteria. Existing captures acquire no new branch or review.

The collector forwards the run's measured `HeadlessRuntimeIdentity` through `LibProbeSource.runtimeIdentity`.
It identifies the loaded adapter source, engine integrity and any loaded binary; feature-capability versions
cannot substitute for it. Missing identity supplies no source-derived qualification.

The four vterm headless geometry queries (XTWINOPS 14/16, OSC 1337 ReportCellSize and OSC 776)
select required independent review only for complete zero-dimension replies from the audited clean
source revision and tree. That subject has no physical font/window geometry; zero is an unknown,
not a measured size. The callback retains query, raw reply, measured runtime identity and source citation
through the existing coverage/review shape. It remains Test to-do until own-suite review determines
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
a delivery declaration never declares feature support. Historical runs receive no new proof.

Conclusive library observations need nonempty raw evidence and matching positive/negative assertions. A direct buffer-state assertion must match the retained response; invalid claims become collector errors.

The `semantic-prompt-source-review` library branch for OSC 133/633 marks does not invent mark observations
or assertions. [Its callback](src/extensions.ts) distinguishes declared metadata with no reader from the
source-review fallback. Retained source answers follow the shared resolver described above; this library
source-only route does not establish terminal-app support or replace ordinary expected-versus-observed checks.

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
without freshness evidence remains review Test to-do. Each decided signal retains its own
assertion. Missing discriminators and unmeasured feature facets remain named review rows;
cursor-shape cell and blink-phase sampling belongs to #31812. Historical frames acquire no
new comparison or grade.

`TermProbeSource.capture` supplies owned pixel capture; `cells` is a separate terminal-text route for declared cell readback. [Region readback](src/region-readback.ts) and callbacks evaluate the resulting evidence.

The app exit/1047/insert-mode rows declare character readback and use that same region oracle.
Exit and 1047 paint primary then alternate markers; leaving the alternate is compared with a plainly
painted primary reference. Text reads use the existing character change criterion; pixel reads retain
their declared freshness checks. An unqualified entry leaves any failed exit roundtrip as named Test to-do,
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
- Coverage becomes `test-todo`. Refusal and consumption without a deciding observation explicitly supply Test to-do tests; unanswered queries and errors explicitly supply Test failure tests. No reply, clipboard value or frame is invented to satisfy a type.
- A measured inconclusive observation stays typed and defaults to `test-failure` unless an existing explicit criterion test selects a different status.

`finalizeProbeResult` folds the required tests in order: failure, pending or empty tests, reviewed impossibility, unsupported, then supported. `untestable` needs a review reference. Collection finalization records source-answer resolutions and Windows console-host prerequisites before that fold. The canonical run reader decodes the stored result without re-resolving source answers or folding its tests again; content validation uses that same reader.

That order matters: a failed test wins over a pending one. Timeout or lack of an observable is not automatically evidence that a terminal lacks the feature; the probe's criterion must establish that. An execution-only Test to-do can follow real I/O and does not promise an empty trace; pre-I/O refusal fixtures separately prove their zero-byte behavior.

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
`recordCollectorSelection` also labels untouched Test to-do rows outside that schedule as not selected; selected rows retain
their not-started reason. Repeated selection updates preserve attempted results and restore still-unstarted selected rows.
The canonical draft decoder distinguishes captured runs from explicitly empty initialized drafts; empty drafts contain no measured identity or emitted result.
It accepts the original initialized empty draft or that same draft annotated by the selection writer, without normalizing
either stored form. Any other changed row remains invalid; historical captures are not rewritten.

The five admin routes share definitions, but do not all execute or persist through the same path:

- **Headless:** [admin/src/termless.ts](../admin/src/termless.ts) calls [collect-headless.ts](../probes/collect-headless.ts), which runs isolated engine workers using `headless-batch.ts` and retains private runs.
- **App:** [admin/src/app.ts](../admin/src/app.ts) launches an owned terminal/daemon, requests collection and enriches its retained response with launch and identity evidence.
- **Server:** [admin/src/server.ts](../admin/src/server.ts) starts or contacts daemons. [serve.ts](../terminfo.dev/src/serve.ts) owns `collectProbeRun`, using the native unified batch.
- **Inline:** [admin/src/here.ts](../admin/src/here.ts) calls that same `collectProbeRun`, finalizes the draft and prints it or its summary. Printing a result does not place it in the corpus.
- **Mux:** [admin/src/mux.ts](../admin/src/mux.ts) runs a daemon through the multiplexer, collects its response and supplies the intended mux configuration to the shared writer.

Multiplexer expectation declarations describe routing, not terminal support:

- **`pass-through`**: the bytes reach the outer terminal and its reply returns to the pane.
- **`mux-answered`**: the outcome the probe reads is decided inside tmux, either because tmux answers from its own state or because tmux's input parser consumes the query and emits nothing; in both the host terminal is never consulted.
- **`unresolved`**: the route is not established at the pin.

The [daemon client](../terminfo.dev/src/daemon-client.ts) retains HTTP responses. The [capture writer](../terminfo.dev/src/capture-writer.ts) finalizes enriched runs and writes immutable result snapshots.

The writer checks intended id/version against known measured values without replacing them, but sets `subject.kind` from the intended term/mux subject and retains `intendedSubject` separately. Both current source and suite version are explicit inputs; a historical declaration cannot silently become a live writer's manifest.

The capture writer retains measured identity and recorded result statuses. Private diagnostic collection preserves its response and normalized snapshot outside the source repository. Pending answers remain held until the actual full Phase 1.4 merge and their existing authorization.

A missing instrument remains Test to-do with its reason; it does not establish a support grade. The cited suite manifest retains catalogue entry hashes in `catalogEntrySha256`.

Every library backend declares the `adapter-sources` extension from its one adapter registry.
Reply-delivery declarations, when present, share that registry's same source array; identity alone grants no reply capability.
The collector verifies declared blobs against tracked imported source bytes once per runtime, then compares per-instance declarations.
Missing identity or stale declarations are named collector errors. Historical captures may omit this field.
Source engines bind repository and tree OID with `cleanTree: true`; dirty source leaves a review pending with a named reason.

The collection writer resolves eligible kept source answers against the measured subject and source identity. It retains the recorded evidence and leaves unmatched work pending. Parsing validates source-answer references without resolving them again; presentation forwards the recorded-version label from the stored result.

[collected-run.ts](../admin/src/collected-run.ts) retains the private response and normalized run first. Explicit app and mux `--output` stops there. Default app, mux and server collection also calls [corpus-placement.ts](../admin/corpus-placement.ts), which checks the run, trusted suite and cited artifacts before placing them under `content/`. Release collection remains private. Collection does not authorize external release or publication; those and pending answers remain held until the actual full Phase 1.4 merge and their existing authorization.

## How a collected run becomes a measured cell

The remeasure instrument reads `collection.json` from the headless collector, parses each named run against its suite, and copies each recorded `featureId` and status into `cells.json` or `cells.partial.json`. Failed engines are reported as refusals; an empty capture contributes no cells. The instrument records the suite for each engine and keeps incomplete output separate. These private measurements do not publish the site.

`measureRenderedWidth` returns a number or a named readback cause: `no-reply` with its step,
`control-mismatch` with its step and observed cursor, or `wrapped` with its observed cursor.
All width callbacks distinguish these before applying their numeric feature criterion: missing
readback is named Test to-do; wrong controls and wrapping are named Test failure. A wrong numeric
ASCII control is also a fixture failure. Unknown transport kinds throw with the probe and kind
named. `/query` retains the same result in its `width` field. JSON preserves the cause fields.

The mode-family source wrapper in [helpers.ts](src/helpers.ts) never infers mode absence from rejected
DECRQM. Qualified set/reset or stack commands run between rendered-X controls; consumed commands and
leaked text retain different reasons, line and cursor state. Missing X, moved lines and unqualified source
remain named Test to-do; actual DECRPM replies retain their result. Held instrumentation and mixed query-reply /
buffer-state declaration limits remain callback-specific, not claims about every engine.

The library mouse source wrappers in [input.ts](src/input.ts) likewise retain command/control state,
not measured mouse-event bytes. In [extensions.ts](src/extensions.ts), a silent highlight query plus
rendered X is not a measured reset negative. A qualified source route for a missing OSC1 icon observer
retains the actual stimulus and before/after title state; title behavior alone is not icon support.
Other missing observers keep their existing coverage result.

The Vterm input source wrapper retains raw state and its required source-review row, without a deciding
input observation or assertion: the callback performs no input event and supplies no measured input negative.
Source-identity drift failures, unqualified-identity results and the Kitty candidate boundary remain in the
existing callback. Retained answers use the shared resolver described above; terminal criteria are unchanged.
