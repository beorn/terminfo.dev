# Probe definitions and collected evidence

`@terminfo/probe-defs` defines term feature probes, their observations and the shared run model. Start at the [exports and probe registry](src/index.ts); [types.ts](src/types.ts) owns the record types.

This describes the implemented system. Callbacks still perform live I/O and evaluate it together. The private viprobe package supplies the ordered record/read/replay core. Both TTY recording owners derive their legacy display events from validated call logs. The selected eleven-probe erase runner captures actual xterm.js effects once and reasserts them twice offline with task-owned checks, bound artifact provenance and domain reporting. Its artifacts remain under the fixed private `~/.terminfo-dev/replays` root, with a separate directory per attempt. The wider collector migration and reassert CLI remain unfinished under recorder #30932; no stored results change.

## Vocabulary and current code

- **Probe subject**: the exact terminal app, emulator library or multiplexer being probed, at a recorded path, OS and version. `ProbeSubject.kind` is `term`, `lib` or `mux`.
- **Term feature**: one terminal behaviour being tested, identified by `featureId`, with one `ProbeDefinition` supplying lib and/or term paths. A mux uses the term path.
- **Probe source**: where answers come from. Existing collectors supply `live` answers. Schema 4 also retains a `trace` artifact reference and its capture run, suite and source revision; the offline runner must validate those bindings against retained artifact bytes before replay.
- **Probe trace**: everything one probe run did and saw, entry by entry, including referenced files. Current collectors retain subsets, not a complete replayable record.
- **Test**: one required condition of a probe, with its own status and assertion references. `ProbeTestResult` is stored; `ProbeTestInput` is supplied by a callback.
- **Assertion**: one expected-versus-observed comparison. `ProbeAssertion` carries positive/negative polarity independently of its `assertionType`.
- **Probe result**: one probe on one subject, with its status, tests, assertions and retained evidence. Stored `ProbeResult` and callback `ProbeCallbackResult` are separate shapes.

The five assertion types classify the deciding observation: `query_reply` reads a query reply; `buffer_state` reads cells, cursor or modes; `screenshot` reads captured pixels; `input_bytes` reads bytes received for an OS input event; `clipboard` reads what an OSC 52 write put on the clipboard. Probe setup and feed writes retain their existing order and bytes; they are not a sixth assertion type.

The five probe-result labels are Supported, Unsupported, Untestable, PROBE TODO and PROBE INVALID. Their code values are `supported`, `unsupported`, `untestable`, `probe-todo` and `probe-invalid`. Immutable stored runs retain their original `test-todo` and `test-failure` words; the run reader decodes those as `probe-todo` and `probe-invalid` without rewriting the stored bytes. A missing same-run control is a reason under PROBE TODO, not an additional status.

A feature result answers one feature on one subject from its current probes. Source never decides it. Supported/Unsupported disagreement between any valid non-source probes is PROBE CONFLICT (`probe-conflict`), naming those probes, regardless of strength. Otherwise the strongest decided probe wins; Untestable alone cannot conflict with a decided answer. With no decided probe, invalid takes precedence over todo, then all-untestable. A conflict counts as open and tier 2 when there is no todo. The [feature-result calculator](../../docs/data/release-scope.ts) replaces the old report-only minimum-method findings.

Callback observation outcomes are `supported`, `unsupported`, `inconclusive` and `error`, not five result statuses.
The [writer and finalizer](src/helpers.ts) fold explicit tests and diagnostics into the result:
a supported observation can still have a failed or pending required test; an inconclusive observation alone
does not establish Untestable. Without explicit tests, a diagnostic or a conclusive outcome, named
missing-observable coverage defaults to PROBE TODO; rowless inconclusive without that coverage defaults
to PROBE INVALID. Untestable goes through `declaredUntestableResult`; `isDeclaredUntestable` is the only form the finalizer and run reader admit. Its reason names the cause: **passed to the app**, **no way**, or **no setup** (and the more specific **no way to tell** or **app** where applicable). The operator's per-kind declarations remain, including OSC720 on libvterm and WezTerm, whose libraries keep history without their own scrolling window. Any other untestable test folds to PROBE TODO.

For library results, a feature is the library's job unless the app-job table in [extensions.ts](src/extensions.ts) assigns it to the app. A real state reading or typed notification store can establish Supported. A generic handoff of an app-job command is Untestable (passed to the app), even when its payload is intact. Libvterm and vt100-rust qualify their report in this cell's run: a made-up OSC and the target are reported, while a handled title command applies without a report. Xterm.js and vterm.js generic taps require their declared engine identity; a different engine identity remains Open. Missing report controls also remain Open. Library-job negatives keep `unhandledSequenceVerdict`; these are Unsupported when the library reports the target with its same-run controls.
Highlight reset cannot be decided without an initial colour reading. When the DA1 control completes but
OSC 17 or 19 supplies no initial colour, the library callback checks the existing unhandled report first.
For the approved reset/colour-stack no-setup route, a silent setup query with its own qualified DA1
control and no target report returns the existing declared Untestable result with the no-setup cause.
A missing control or ambiguous target report stays Open; verified seeded-colour effects keep their
existing result. This route adds no post-collection classification or dependency on another cell.
Alacritty's audited OSC 110/111/112 route compares its initial silent default with a verified
seeded colour reply: unknown OSC 7110 must preserve that seed, then the reset must restore
the initial silence. Those same-run query replies establish Supported without inventing a default RGB value.
Other missing initial readings record a named PROBE TODO; broken or untrustworthy
measurement remains PROBE INVALID. Silence alone does not establish Unsupported.
The [legacy presentation keys](../../docs/data/release-scope.ts) are a different shape:
The `FeatureResultDisplayState` value `inconclusive` denotes Untestable (reached only by the declared route above), `error` denotes PROBE INVALID and `untested` denotes
PROBE TODO; `supported` and `unsupported` retain their corresponding labels. Do not substitute callback outcomes for these keys.

No result is answered from source code (operator 2026-11-03). Source is read only to troubleshoot a probe; it never sets a cell. A probe result comes only from what the probe saw in that run. Unsupported needs an observed negative plus a passing same-path control in the same run; no reply counts as Unsupported only when a control reply came back on the same path in that run. With no passing control the cell is PROBE TODO with reason `observation not decided: no same-path control in this run` (below, "the no-control reason"); this includes a zero-byte reply on a loaded artifact. PROBE INVALID means the probe or harness broke or got data it cannot trust. Untestable has the explicit route above; otherwise a probe whose setup has no observable for every subject of a kind reads PROBE TODO, and source never sets it per engine. A probe never implements the feature itself.

Every former source-review or source-negative site now returns PROBE TODO with a named cause: the no-control reason where no control ran, otherwise the missing prerequisite or observable it names. The run reader reads a stored cell carrying a source-answer `reviewRef` or the `source-negative-review` / `reply-path-audit-review` branch as PROBE TODO with reason `source answer no longer counts (operator 2026-11-03)`, except a stored app/mux screenshot review, which reads `stored visual review not re-admitted: needs a same-run pixel check`; stored files stay unchanged.

SGR attribute negatives require a rendered target and a same-run bold cell control. Underline style negatives require both exact `single` readback and a non-single style other than the target reading back as itself: curly for the double target, double for the other targets. Missing nullable attributes and on/off readers normalized to `single` stay open. Bright/indexed colour negatives require an ordinary-red control on the same colour reader and targets unchanged from the neutral baseline; different nondefault colours remain inconclusive. Existing positive effects witness their own reader. When an attribute field is unreported, a DECRQSS alternative qualifies only after this probe reads a status-1 SGR `m` bold control; a facility or DECSTBM reply does not qualify it. The exact issued input strings and control/target evidence are retained together. These library controls do not change app-arm criteria.

Headless DEC-mode queries use the existing sentinel reader when the collector has qualified reply delivery.
Their retained captures include the target query and its separate DA1 control. DA1 responsiveness proves
transport only: without the criterion's own DECRPM reply, these mode results retain their named PROBE TODO.
Application-cursor and reverse-video opt into a public-state criterion when DECRPM is absent:
reset false, set true, reset false, an unknown mode leaves the state unchanged, and the other
flag stays unchanged throughout. Cursor-key encoding and reverse-video presentation remain unmeasured.
The seventeen DEC1 mode/mouse definitions also consult the existing unhandled report after an
undecided prior arm. DECAWM off must read false and add no entry, then one exact own command
must add one or more new entries all carrying that command's code. Explicit multi-code targets
still require their exact ordered list. Its cleanup reset follows the verdict. No source identity
selects either criterion.

Alacritty's pixel-mouse and urxvt-mouse arms instead qualify the engine's DECRQM reader: mode1006 must
change from Ps2 after reset to Ps1 after set, while unknown9999 and target1016 or1015 before/after
set answer Ps0. That controlled target negative reads Unsupported; a missing or inconsistent
control stays PROBE TODO. Both mouse encoding modes reset on exit. The existing audited
Alacritty declaration route also covers DECSACE's CSI extent, OSC9;4 progress without a
progress reader, and OSC133 prompt click-events state; shared Termless encoder bytes do
not establish a library implementation.

External release and publication remain held until the actual full Phase 1.4 merge and their existing authorization.

Terminal tiers describe progress: 0 missing, 1 incomplete, 2 broken and 3 done. These are distinct from the former Release 1 query/reply group and from color depth. This terminology defines no thresholds and changes no status computation.

The existing [completeness helper](../../docs/data/release-scope.ts) uses the supplied scored catalogue positions:
empty means tier 0; any PROBE TODO means tier 1, even alongside failures; otherwise a PROBE INVALID means
tier 2; otherwise tier 3. The helper itself does not verify full catalogue membership.
The numerical support share is Supported divided by all scored catalogue positions, not results done divided by total.
The [nine exact environment IDs](src/environment-groups.ts) remain visible but excluded from scoring,
the denominator and completeness tiers. The [admin report's](../admin/report.tsx) literal `N/M` means
manual-by-design, NOT MEASURED for their PROBE TODO rows; it is not a numerical fraction or a sixth stored status.
An [OS row's inherited or reference source](../../docs/os/%5Bid%5D.paths.ts) can supply its displayed counts;
those are the source's results, not an independent measurement of that app and OS.

[Catalog coverage](../../docs/data/probe-status.ts) is separate again: automated, partial, manual,
undeclared or unprobed. A catalog manual/partial override takes precedence; otherwise the existing
definition, callback-arm and assertion-declaration checks determine coverage. These labels neither decide
a result nor establish that both positive and negative controls exist. Overrides and result statuses stay unchanged.

Collection retains measured records. External release and publication remain held until the actual full Phase 1.4 merge and their existing authorization.

`release1-collection --collect --development --output <private-directory>` retains private collection and its actual attempts.
The pass records private attempts, custody and coverage.
Failed hosted collection retains its original delegated draft as failure custody when canonical `run.json` is absent.
Only a source-, suite-, run- and selection-bound collector attempt with a recorded start establishes execution;
a job-start marker alone does not. A nonzero collector exit reports `failed`, with its exit code and log path.
This custody never supplies support conclusions or bypasses canonical validation.
The private eight-app cohort uses serial one-context calls and the existing hosted collector's recorded active-run skip.
Its typed cohort dispatch input gives each macOS workflow run a run-unique concurrency group; legacy cancellation is unchanged.
A foreign dispatch racing the preflight can overlap on its independent hosted runner, but cannot cancel the cohort or be canceled by it.
Artifacts remain bound to their own run ID. Job intervals retained after either watch outcome are execution time, not billed minutes or CPU/RSS;
missing timing stays explicitly unavailable, and timing-query failure never suppresses artifact custody.
The read-only admin `report --scoreboard <inputs...>` accepts explicit raw captures or pass files/directories, preserves pass identities,
and uses the canonical selected-results reader and local `origin/live` revision to distinguish selection from proven publication.

Device query criteria name the state actually reported. XTREPORTCOLORS (`CSI # R`)
reports the palette-stack current entry and stored palette count as two
nonnegative decimal fields, retaining the existing optional DEC-private `?`
reply prefix. XTWINOPS 14 (`CSI 14 t`) reports text-area pixels; the outer-window
query is `CSI 14;2 t`. These criteria establish query replies, without measuring
palette push/pop effects or graphics capabilities.

The Kitty library OSC 22 pointer criterion uses its existing `?__current__` reply:
read the incoming shape, qualify a distinct shape control, set `pointer`, read it
back, and restore the incoming shape. Missing replies or an unqualified control
retain PROBE TODO. Other libraries retain their existing path; the app criterion
still requires pointer appearance outside the cell grid.

Kitty 0.49.2's own parser rejection can decide the scoped OSC 176/440/555/666/710
cells after their individual payload adds one or more matching reports and a handled
OSC 2 title control adds none. Delivered OSC 9 remains separate and adds no rejection.
DECSSCLS uses the reported modifier-plus-final code ` p`, without rebuilding a parameter,
and a same-run bold control. The existing D2 registry consumer supplies these six routes;
shell and colour-reset rows reuse their existing report consumer. Silence decides nothing.

The XTWINOPS 22/23 library callbacks run separate pop and push fixtures. The pop
fixture saves title A, sets B and restores A; the push fixture sets A then B,
saves, sets C and restores B. They retain the incoming title plus each fixture's
original, changed and restored readings, and restore the incoming title on exit.
Both IDs grade the joint round trip: both fixtures restoring their own pushed
titles reads Supported; qualified OSC 2 controls followed by non-restoration reads
Unsupported with `push/pop round trip does not restore`. This does not identify
which primitive is missing. Failed title controls retain the named PROBE TODO cause.
OSC 0 remains a conjunction: a controlled title failure disproves it, while title
success alone cannot prove an unobserved icon clause. Both clauses must be observed
for Supported; a complete exact-payload reply remains positive evidence. Where the icon half
is an audited declared absence, the combined feature reads Untestable with that cause.

The existing Ghostty web declaration cohort uses engine0.4.0 plus its measured WASM digest
and clean source tree, independently of adapter version. It also covers OSC133a–d and the
semantic lifecycle, OSC0's icon half, OSC1, OSC22 and the OSC52 round trip as public-interface
absences. OSC52 write is the app's job: the package parses it but drops the clipboard request.
Existing public readers, measured results and genuine rejection reports keep precedence.
Its eight colour-reset refusals use the shared scalar report verdict: one or more new entries
must all carry the target code after the unchanged handled-title control. Silence decides nothing.

The XTPUSHSGR/XTPOPSGR library callbacks retain both real post-pop fixtures.
When the reader cannot calibrate italic, a passing bold on/off control and both
fixtures remaining plain establish only the joint push/pop negative; its reason
retains the unobservable italic clause. Other limited readings remain PROBE TODO.
Supported still requires the complete bold-and-italic control and restoration.

The left/right-margin library arm measures wrapping rather than ICH or mode metadata.
With DECAWM explicitly on, a placement control witnesses row2,column3 and an
unbounded ABCDE write witnesses row1,column7. Under margins3–6 the same write
must wrap E to2;3; only E at1;7 with2;3 blank gives the calibrated negative.
Other outcomes stay PROBE TODO. Cleanup resets margins and DECLRMM and restores
the incoming reported DECAWM state, or the explicitly established on state.

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

The reflow callback retains optional `getReflowState()` instance evidence as
`response.reflowSetting`, independently of `declaredReflow`. An absent reader means
not reported: the response omits the setting, without inferring false or using the
capability declaration. The setting does not decide the measured resize phases.

Library `getMode` returns `boolean | null`: null names an unavailable adapter readback,
not a reset state or a terminal-support result. Callbacks retain it explicitly.
Library `cell.hidden: null` means conceal is not reported; missing cell observables retain their named PROBE TODO cause without deciding terminal support.

OSC52 write/roundtrip callbacks retain qualified read-sentinel silence as a named PROBE TODO
when no clipboard-state witness is wired; a read negative cannot measure the write.
Reset and colour-stack effects use the approved no-setup declaration above only when their own
setup query is silent, its control answers and no target report exists. Kitty transfer/display and
other silent effect readings stay PROBE TODO even if DA1 answers. Effect absence needs an answered same-probe state
control and an observed comparison. Existing own-state readers and answered unchanged-state
comparisons continue to decide results; query features retain their own reply criteria.
OSC5522 detection checks the current library DECRQM sibling-query family after qualified target
silence. Qualified silence from every control names an unmet detection prerequisite as PROBE TODO,
retaining each raw window. Any control reply leaves target silence as PROBE INVALID; complete,
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

The optional `semantic-cells` extension exposes `getCellSemanticType(row, col)` as
`prompt`, `input` or `output` from the stored cell. OSC133 A/B/C/P share one
consumer: write text after each handled letter and unknown Z, check the target's
type transition, inert Z and retained earlier cells. A target no-op is Unsupported
only when another handled letter moves the type; failed controls remain Open.
Coordinates follow `getCell`; invalid coordinates throw. This reader supplies no
mark history or command end and cannot decide OSC133 D or the full lifecycle.

The library alternate-scroll, reverse-video, synchronized-output,
colour-scheme-reporting and DECSCLM cells use the existing DECRPM helper's opt-in
`requireReadback` criterion. Supported requires Ps1 after set, Ps2 after reset and
agreeing `getMode` readings. Reverse-video additionally admits the no-reply public-state
criterion above. Ps0/2/4 after set is an engine negative. A null or
mismatched adapter reading retains a criterion PROBE TODO named
`adapter binding <backend.name> <mode>`; the name is display-only and never selects
a status or route. Existing other DECRPM criteria retain their prior readings.
Application-keypad instead measures `ESC =` / `ESC >` (DECKPAM/DECKPNM) with
`applicationKeypad` true then false, without DECRQM. Null readings stay named
adapter-binding PROBE TODO; other non-null pairs stay criterion PROBE TODO naming both states.
Keypad encoding remains unmeasured. The application `modes.alt-scroll-1007` arm measures
wheel-to-cursor-key translation from either CSI A or SS3 A and records the observed form;
the library arm leaves that translation unmeasured.
Private4 additionally requires non-null ANSI `insertMode` readings before and after
set and checks that they do not change; an observed
flip is engine conflation, independently of its reply (the existing private4 issue32002).
Presentation remains unmeasured for reverse-video/synchronized-output, the actual
scheme-change report remains unmeasured for2031, and smooth-scroll presentation
remains unmeasured in the library arm. DECSSCLS feeds `CSI 9 SP p` plus a marker and
retains screen text and cursor state. Consumption without visible effect is PROBE TODO; leaked sequence text is a measured
negative, and a changed grid or misplaced marker stays inconclusive. Consumption does
not prove handling or scroll-speed presentation. Application criteria are unchanged.

Both source interfaces carry `readonly kind: ProbeSourceKind` directly. Current runs retain exactly `source: { kind: "live" }` or `{ kind: "trace", trace: { path, sha256 }, captureRunId, captureSuiteId, captureSourceRevision }`. The trace path is relative to the artifact store and contains no parent segment; its SHA256 and capture identities are required. Initialization and the canonical reader validate this union; the collection writer currently implements live sources. Call-log format/version remain inside the referenced artifact. The current run reader accepts schema 4. This source declaration grants no capture or publication.

`termAssertionType` and `libAssertionType` declare a retained deciding-observation class. An explicit null means the callback runs without a typed deciding observable; undefined is temporarily undeclared (#28801). Neither means the callback arm itself is absent, and neither becomes a null observation or assertion type.

The library declaration also accepts an inline `{ when, then, otherwise }` descriptor. Each branch is a nonempty set of distinct existing assertion classes. The headless collector evaluates the pure `when` predicate exactly once before the callback, using identity and getter presence without I/O, then requires the returned observation class to belong to that selected set. A thrown or non-boolean predicate is a collector error. The descriptor is never serialized: retained observations, assertions and results still carry one scalar class. Scalar, null and undefined declarations keep their existing meanings; application declarations remain scalar.

`ALL_PROBES` collects the category definitions. A current `ProbeSuiteManifest` explicitly carries schema version 4 and separates complete `catalogIds` membership from the callback schedules in `probes.term`, `probes.lib` and `probes.mux`. Historical declarations normalize their schedules on read while retaining their original absent schema marker.

The [shared execution helpers](src/helpers.ts) initialize every catalog member as `probe-todo` with no attempt, then record only the work actually performed.

Library SGR 39/49/59 resets without a distinct colored setup retain their actual cell state on a
named `headless-observable-review` PROBE TODO row. That missing prerequisite cannot establish a
reset negative. Compound attribute resets with unshown setup attributes are PROBE TODO; a partial reset
does not decide the whole claim.

TERM_FEATURES means a terminal program's export into its child environment. Its library arm performs
no I/O and records PROBE TODO: a library context spawns no application child to receive the environment export.
It creates no observation or assertion. The application arm remains PROBE TODO until terminal-owned child readback exists.

Raw replies and observed payloads do not embed
runtime identities; the record's allowlisted identity is their sole carrier. WASM engine identity
uses the loaded binary digest, while wrapper repository/tree metadata remains provenance.

Headless collection checks loaded native artifacts against their receipts before probes and collects observed
buffers and replies. A silence-dependent cell with no same-path control is PROBE TODO with the
no-control reason and its raw response. Hourly measurement calls the existing `collectHeadlessRuns`
entry point and reads its `collection.json` through the canonical run parser, without importing review selection.
App/hosted collection keeps its existing driver.

Several OSC callbacks in [extensions.ts](src/extensions.ts) feed their exact commands
and a rendered-X consumption control, retaining fed/cell state. The control proves parser
consumption, not a target effect; target state remains unexposed, so the cell is PROBE TODO
with the no-control reason.

The two highlight resets (OSC 17/117 and 19/119) query the initial colour first.
A real colour reply follows the measured reset criterion. An empty initial reply is
PROBE TODO with the no-control reason. The measured reply route remains
query-reply evidence; these two lib arms stay temporarily undeclared under #28801
because a single assertion-type declaration cannot state both routes.

OSC99 capability detection has both library and term query arms. They share the nonce/title
criterion and never display a notification. Unqualified library capture silence stays inconclusive;
only the existing qualified sentinel path can establish a negative reply result. Viewport hold on output measures the
library viewport through the existing scroll control and absolute position/extents. Each independent
ordinary/synchronized phase resets the main buffer, observes its numbered seed, requires history,
exact retention and a bottom baseline, then calibrates the first inward sign (-1 before +1) without
changing extents. Exactly one retained new marker row witnesses hold at the same anchor, snap to the
new bottom, or bottom-relative motion: the absolute viewport offset advances by exactly one from its
anchor, keeping its distance from bottom. Marker readability is checked only after a verified return
to bottom. Both phases must qualify: both bottom-relative outcomes are negative with the reason
"viewport kept its distance from bottom instead of its anchor"; one bottom-relative outcome mixed
with any other outcome is inconclusive. Otherwise either qualified snap is negative and both holds
are positive. Failed controls and every other drift withhold a support conclusion. Missing history or scroll
control/state names coverage; operational and cleanup errors propagate. Retained buffer-state evidence has baseline, anchor,
control, ordinary and synchronized keys. The exact DECSET 2026 bytes exercise output inside that
block without claiming painting support. The app arm uses existing owned wheel input and whole-window
pixel capture in one fresh Linux Ghostty job. Its optional input-fixture wheel bound carries pinned
configuration/application provenance; until that bound is justified from the pinned application, the job
omits it and the callback returns named PROBE TODO before I/O. The configuration sets only wheel movement,
never output-scroll policy. Separate ordinary/synchronized phases require key delivery, unique anchors,
a same-run DA1 inertness check at the anchor and parse witness before two equal output frames,
constructed-tail bottom equality after all downward inputs, and a second verified restore after the
comparison scroll. Once an upward notch is attempted, cleanup also attempts a return to bottom on every
exit. Both qualified holds are positive;
a qualified snap or bottom-relative motion is negative. Any unqualified phase withholds the result;
capture/harness errors fail. Complete pixel digests
use the existing ED3 frame comparator without masks or container-ref equality. Other application contexts
retain the catalog manual recipe. No production capture or result is supplied by this implementation.

The optional library capability `productViewport: { available: false, reason }` explicitly declares
that the library subject has no product viewport; an absent declaration means undeclared. The
collector omits the probe source's scroll control for that declaration. Before any phase action or
OSC720 history I/O, the viewport-hold and OSC720 callbacks retain the declaration and exact reason plus
`runtimeIdentity` (null when missing). Their shared declared-absence branch reads Untestable only for
libvterm 0.3.3 and WezTerm 0.1.0-fork.5, retaining the declared reason and library version.
Missing or other identities retain `headless-observable-review` with named scroll-control coverage;
neither route claims a measured scroll result.
A declaration of absence paired with a present scroll control is an inconclusive apparatus
contradiction, with no review row. An undeclared missing scroll control keeps ordinary named coverage.
Scripted callback tests cover these branches and the exact two-phase arithmetic independently of
engine versions; historical captures and results are unchanged.

For libvterm 0.3.3, ED3 and the two history-count library callbacks perform no history reads or
writes: the adapter reports screen extent, while retained history belongs to an embedding application.
Other identities keep their existing criteria.

**Callback and stored shapes are different.** Follow these names in [types.ts](src/types.ts):

- `ProbeCallbackResult` has three arms: a measured `observation`; `notTested` coverage naming a missing semantic observable; or execution-only, nonempty PROBE TODO/PROBE INVALID `tests`, each with a mandatory reason. Execution-only callbacks have no observation, assertions or coverage. Callbacks can select a criterion branch.
- `Observation` records an outcome and required `assertionType`. `ProbeAssertion` records the independently positive/negative predicate, required `assertionType`, expected state and retained observed evidence.
- `ProbeResult` stores the feature's execution status, attempt, required tests, selected criterion branch and evidence references. Its optional primary `assertionType` names only a retained observation; absence is not a sixth type. Legacy `pass` never decides it.
- `RunDraft` is a private schema-4 envelope: explicit source, run/suite identity, `intendedSubject`, measured `subject` when available, raw replies, assertions, artifact references and probe results. Subject kinds are `term`, `lib` and `mux`.
- `CapturedRunDraft` and `CurrentRun` require measured subject, identity, time and origin; `Run` aliases the current shape. Historical stored bytes are immutable. A historical `sealedAt` field is ignored for current parsing and selection.

The legacy callback `pass` still exists for the [diagnostic Vitest runner](../probes/run-unified.probe.ts), including the execution-only arm. Current collectors record observations/tests through `recordExecutedProbe`; even `pass: true` with an explicit PROBE INVALID test stays failure. Cleanup #30929 removes `pass` from every arm.

A callback can mark explicit failure tests that need actual request evidence. An execution-only callback uses
`replyFailure`; a measured callback can retain a partial observation while marking its required-reply failure.
The callback-only `replyFailureTestIds` never enters a stored result or draft. After the callback returns,
the TTY or headless producer uses `withReplyFailureEvidence` to append escaped sent/received bytes and the
actual timeout or synchronous capture boundary to only those marked failure-test reasons. Readers find the
attempts in the stored criterion test's reason; the observation note and top-level summary stay unchanged. Callback conclusions, test IDs,
criterion branches, observations and assertions remain callback-owned. Missing request records remain
named failures; they do not prove that a producer is absent. Proved missing required capabilities or
identity-bound declarations retain named PROBE TODO results without markers. Malformed replies, sentinel negatives
and artifact-review branches keep their separate criteria and remain unmarked.

A region seed whose characters arrive without their painted background or inverse attribute fails the
claim's precondition. Live and replay retain the same `criterion` PROBE INVALID and `PreconditionFailed`
cause with expected cells and observed values; this is no negative assertion about the feature itself. Replay preserves that callback-provided cause alongside its native checks.

The OSC 1 library criterion requires separate icon readback and a verified OSC 2 window-title control; an icon update must preserve that title. Missing icon readback remains coverage, while a failed title control is an execution failure. Both labels are restored after the attempt. Library OSC 117/119 resets reuse the color-reset helper's initial-query, distinct verified seed and reset-query sequence. Missing initial highlight readback or an unverified seed cannot establish reset support or absence; the original highlight color is restored after the attempt.

The OSC 7 and notification library criteria use optional `getCwd` and
`getNotifications` readers from the backend's `osc-metadata` extension. OSC 7
requires both target values to equal the expected URLs after WHATWG URL
serialization; the raw values are retained. They are equal under the WHATWG URL
Standard, which the Rust url crate also implements. The same-reader control uses
that comparison; restoring the original value remains exact, including null for
an unset slot. Notifications retain the original payloads
and require two distinct OSC 9 messages to append in order without changing
that prefix. The collector gives each probe its own disposable backend, so
notification messages cannot leak into another probe. These are `buffer_state`
observations of parser metadata, not a filesystem operation, OS notification
or OSC 9;4 progress measurement. Missing readers keep the existing
`headless-observable-review` tool gap; getter errors propagate. Notifications
instead use the operator's declared Untestable route when neither notification
nor toast reader exists and the measured source matches the audited VT100.js
0.10.1/0.11.0/0.12.0/0.13.0, VT220.js 0.10.1/0.11.0/0.12.0/0.13.0 or Alacritty 0.26.0 profile. The shared identity qualifier
in `extensions.ts` checks exact clean source trees or native provenance and
adapter blobs. Changed or unknown profiles remain PROBE TODO. This declares
public-interface absence, not DEC hardware or desktop-notification support.
OSC 7 uses that same identity qualifier when its Cwd reader is absent, with its
own working-directory interface-absence reason. A supplied Cwd reader always
runs the existing measured criterion; a missing reader on any other identity
remains PROBE TODO.

An engine's own unhandled-sequence report (`getUnhandledSequences`) decides a state or reply cell
Unsupported only with same-run controls: a handled sequence adds no entry while its own reader
shows it applied, then the target adds its exact code or an explicitly named ordered list of codes.
List length, kind, code and order must all match; no prefix, sorting or deduplication qualifies. Every length is
compared exactly, so a bounded history that rolled decides nothing rather than a wrong grade. The
primary control is OSC 2 with the title reader; an engine that handles no OSC — VT100.js and
VT220.js — reports OSC 2 as an ignored entry and never sets the title, and that same run lets SGR 1
with a bold cell qualify instead. Only the named shell, colour-reset and eight SGR cells (blink,
faint, italic, strikethrough and the four underline styles) may move; delivery cells, a decided
outcome, a missing member and any other code keep their own path, except for the exact vt100-rust
cohort below and the following DEC colour/setup slice.

Libvterm R1 uses that same report verdict for DECSSCLS and Kitty image transmit/display,
with a handled OSC 2/title control. Its public CSI fallback retains native normalized parameters
and the final byte; its APC fallback retains only the initial payload byte (`G`), without image
payloads. Handled DECSCUSR changes cursor shape and adds no report; made-up APC is also unhandled
because libvterm handles no APC. At libvterm 0.3.3, palette push/pop and DECSACE instead use the
existing no-way declaration: `on_csi` drops `#` and `*` before the public fallback and has no other
hook. That absence is keyed on the engine version, independently of the adapter's Wasm build.
The rebuilt artifact adds its own source-audit cohort; earlier audit entries stay unchanged.

On VT100.js and VT220.js, standard, bright and default foreground/background colours and OSC 2 use
their own one-entry report with the handled SGR 1/bold control. OSC 2 never uses an OSC fallback whose
control would itself be the target. Indexed colours use the probe's own `38;5;173` / `48;5;173` payload
with SGR 0 cleanup; direct RGB and the truecolor extension use `38;2;17;97;201` / `48;2;17;97;201`.
The engines report each unhandled operand in order; handled operands do not create entries.
OSC 633 P's number-only rejection also decides Unsupported: its payload was not delivered.
On VT100.js and VT220.js, the OSC52 clipboard roundtrip and write arms also consult this existing OSC
report verdict after an undecided body. An exact own OSC52 write rejection and the
same-run handled control establish Unsupported; the read arm and other libraries retain
their existing criteria. A decided clipboard reader always takes precedence.

For EL with background attributes, XTWINOPS 22/23, alternate-screen exit and italic selective reset,
rejection of the setup itself with the passing SGR 1 control makes the dependent claim Untestable
in that run. Target rejection, a version literal, a failed control or missing report cannot establish
that prerequisite absence. Existing decided results retain precedence.
Without the qualified setup report, those five dependent claims remain PROBE TODO.
DECSACE alone is declared Untestable at DEC engine 0.13.1, whose public Screen API has no extent state/effect reader; other
versions retain the existing criterion. VT220 bold selective reset remains outside this slice.

Operator D2 and the November 5 11:16 ruling add 34 cells; the M-1 scope adds ten state cells,
for 44 only at the audited vt100 crate 0.16.2 native provenance and adapter profile.
One `ALL_PROBES` decorator uses the same verdict helper;
OSC 2/title controls OSC targets and SGR 1/bold controls CSI targets. Exact normalized codes were
measured from that addon. A changed identity, failed control, missing member, unmatched code or
already decided result retains its previous path. The additional IDs are:

- `cursor.position-report`; `device.decrpm`, `device.dsr-996-color-scheme`, `device.primary-da`,
  `device.secondary-da`, `device.status-report`, `device.tertiary-da`, `device.xtreportcolors`,
  `device.xtversion`, `device.xtwinops-14`, `device.xtwinops-16`, `device.xtwinops-18`,
  `device.xtwinops-20`, `device.xtwinops-21`; `editing.decrqcra`; `modes.decsscls`.
- `extensions.sixel-da1`, `extensions.sixel-geometry-report`, `extensions.osc10-fg-color`,
  `extensions.osc11-bg-color`, `extensions.osc12-cursor-color`, `extensions.osc1337-capabilities`,
  `extensions.osc1337-cellsize`, `extensions.osc17-highlight-bg`, `extensions.osc19-highlight-fg`,
  `extensions.osc21-kitty-color`, `extensions.osc4-palette`, `extensions.osc5-special-color`,
  `extensions.osc701-locale`, `extensions.osc702-version`, `extensions.osc776-cell-size`,
  `extensions.osc7770-font-size`, `extensions.osc7777-font-window-size`, `extensions.osc99-kitty-notify`.
- `modes.alt-scroll-1007`, `modes.color-scheme-reporting`, `modes.decsclm`, `modes.reverse-video`,
  `modes.synchronized-output`, `modes.xtpushcolors`, `modes.xtpopcolors`, `modes.xtrestore`,
  `modes.xtsave`, `modes.focus-tracking`.

For the M-1 cells, the deciding observation is the library reporting the mode or stack write
as unhandled with the SGR 1/bold control. Failed palette and wrap calibration remains evidence;
the report verdict does not claim those effect readers calibrated successfully.

Alacritty D2 uses the same registry consumer and existing audited native 0.26.0
profile to declare 23 exact-version public-interface absences: OSC 777, the twelve
OSC 133/633 and semantic-prompt rows, resets 113/114/117/119, and OSC
176/3008/440/555/666/710. Each reason names the library/parser version and missing
public effect. The underlying VTE 0.15.0 dispatcher has no matching handler and
Alacritty's public events provide no rejection report. A supplied real reader,
an already decided result or an unknown profile retains its original path.
Blink, OSC 22 pointer, OSC 1 icon and DECSSCLS remain outside this declaration cut.

The `vterm` D2 slice shares the same private helper (`declaredD2InterfaceAbsence`)
with the named `"vterm-d2"` cohort (`vterm.js 0.13.1`, clean source tree
`3d58d29a8265aafd928e0736dde6723e2bac2007`) to declare nine exact-version
public-interface absences: `modes.decsscls`, `extensions.osc9-progress`,
`extensions.osc22-pointer`, `extensions.osc133-d`, `extensions.osc633-d`,
`extensions.osc633-e`, `extensions.semantic-prompts`,
`extensions.osc-633-vscode`, and `input.kitty-click-events`. Because `vterm`
exposes `getSemanticMarks` for start zones (`extensions.osc133-a`, `b`, and `c`
stay Supported; `extensions.osc133-p` stays Unsupported), reader precedence
checks the `semantic-command-end` capability alongside `getUnhandledSequences`
and decided outcomes; the six host-effect OSCs stay held.

Ghostty native D2 shares that helper for six semantic interface absences: OSC 1,
resets 113/114/117/119, and DECSSCLS. Its cohort requires backend `ghostty-native`,
a native Ghostty 1.3.1 runtime, source `332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28`
and lock `3ec775507556db01d08055836b26183f629a9cbb0b5802a1566661e95988d74a`;
addon hashes and adapter blobs do not select this source-level declaration.
Recognition-only parsed commands do not observe those semantic effects. A real
icon reader, unhandled report or decided result retains its existing path.
OSC 22 has public engine pointer-shape state and stays outside these declarations.

WezTerm D2 uses the same private registry helper with a separate `wezterm-d2`
cohort: native tattoy-wezterm-term 0.1.0-fork.5, audited binary, source, lock and
four adapter blobs. It declares ten public-interface absences: pointer resets
OSC 113/114, OSC 22 pointer shape, DECSSCLS presentation speed, and the six host
effects OSC 176/3008/440/555/666/710. Resets 113/114 have recognized empty handler
arms, no pointer colours in the public palette and no query reply; their
`PaletteChanged` event carries no value. OSC 22 and DECSSCLS have no handler;
their opt-in log-facade trace is off in this embedding. The six host-effect
reasons state that the public library has no host delivery route. Public reports
and already decided results win; unknown identities retain their original path.
The default OSC-absence cohort and every other library retain their existing paths.

The twelve proposed Untestable declarations remain outside this negative-only cut pending
operator wording approval: DECRQSS, XTGETTCAP, XTGETXRES, the Kitty graphics query/transmit
cells, and OSC 22, 176, 3008, 440, 555, 666 and 710 retain their prior paths. OSC52 read also
retains its public host-request path; no reply is invented. Other libraries and every terminal
arm retain their existing paths.

## Evidence, capture and assertion

The library reflow callback uses the optional `LibProbeSource.resize` control; every production
source forwards it directly to the existing required backend operation, regardless of the declared
reflow capability. A hand-built source without the member keeps the named no-I/O PROBE TODO. Initialized
`cols` retains its original meaning; it is not post-resize geometry. Fresh ASCII wrap controls qualify
the actual width effects through cells, because adapter dimensions can merely mirror a request.
The main-screen fixture seeds an 18-character line and distinct CRLF lines before each resize,
verifies the cursor is parked below them, and measures growth12→20 and shrink20→12 independently.
The line starts soft-wrapped for growth and unwrapped for shrink. Ordered feeds, requested sizes
and actual cell/cursor/scrollback reads remain in the existing response JSON. Exact reflowed layouts
supply positive main-phase buffer-state assertions. Preserved physical rows on growth and the same
rows clipped to 12 columns on shrink supply negative assertions. Failed controls, unexpected cells or
boundaries, and conflicting positive/negative phases retain required PROBE INVALID tests. Finally restores
the initial dimensions and resets the source, attempting both operations and preserving all causes.

The same callback measures retained-history growth and shrink in independently reset buffers.
The soft line and explicit CRLF rows are followed by twice the screen height in uniquely numbered
hard witnesses, without a final newline. Coherent counts bound every absolute-buffer read by the
fed rows plus screen height; invalid extents retain their counts without allocating from them.
Before resize, all target rows must remain in history and the complete seeded layout must match.
No retained history and an evicted or incompletely retained target have distinct named PROBE TODO reasons
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
Unknown identity and a measured entry that leaves the primary active have distinct named PROBE TODO results:
`alternate buffer identity unavailable` and `alternate buffer not entered`. Neither is a reflow
negative. Corrupt setup, inconsistent identity, failed controls/restoration and unmatched layouts
retain invalid phase evidence. A failed marker or readback before the measurement slot stays invalid,
even when buffer identity is false or unavailable. Before the slot, only a clean failed-entry observation
can yield an identity or no-entry PROBE TODO.
Slot errors retain their cause while measured/final leaves run;
outer cleanup independently attempts alternate exit, initial-width restoration and reset.

Saved-cursor placement across a resize remains ungraded: it cannot veto alternate reflow evidence.
The resizing roundtrip retains both cursor readings in its raw phase JSON and still requires
identity, primary-span restoration, no leak and clear checks. It performs no reference replay.
Ordinary no-resize 1049 keeps its saved-cursor equality check.

The library criterion requires main-screen growth/shrink and retained-history growth/shrink.
Each required row cites only its own phase's assertions; the existing mixed-main criterion cites
only main assertions. The shared finalizer gives required failures precedence over PROBE TODO results, then
measured negatives, then support. Main reflow with retained physical history is Unsupported;
missing qualified history remains PROBE TODO, and corrupt tails or unmatched layouts remain failures.
The reason names the required phases and their results.

Alternate-screen phases retain their statuses, positive/negative assertions and raw response but
do not decide the probe result: full-screen apps redraw on resize, and intentional physical-row preservation
there does not negate main-screen or history reflow. The reason reports alternate results as excluded from the support decision.
Invalid alternate evidence stays visible without vetoing the required phases; cleanup failures still error.

Supported reasons state: "ASCII reflow measured on main screen and retained history; wide characters,
cursor on a wrapped line and terminal-app resize unmeasured". No broader coverage is inferred, and
the separate terminal-app arm remains PROBE TODO. Private apparatus results grant no exact-run decision,
corpus placement; the native absolute-row consumer hold remains with independent batch review.

The libvterm adapter retains native history, enables `vterm_screen_enable_reflow` and records that
setting. Libvterm is checked against the same main-screen and retained-history criterion; the recorded
setting alone never establishes support. A default-config source observation is not engine
capability absence and cannot replace the observed criterion.

The Linux Kitty/Ghostty launcher pins one exact font file for the entire run, with no fallback face,
through a private fontconfig directory. Its receipt retains that file's SHA256, launch arguments and HarfBuzz glyph
sequences for `!= -> => <= ==` with liga/calt on and off. A glyph-ID difference proves source-face
capability independently of the renderer; position differences alone do not. The collector retains
the validated `fixture.font` bytes as `collector.fontSource` for every non-mux Linux run selecting the
font review, including plain receipts from other launchers. The retained receipt and spaced-control and
target frames are kept with the result, but no same-run check derives a support conclusion from them. Missing or inconclusive proof leaves PROBE TODO naming
`#32062 font control` and its proof state; it does not establish Untestable on a pixel arm.
This does not change earlier captures or xterm's rendering pin.

Callbacks currently perform I/O and judge it in the same implementation. There is no general persisted callback transcript or independently replayable assertion API supplied by this package.

The five `AssertionType` values classify an actually retained deciding observation: `query_reply`, `buffer_state`, `screenshot`, `input_bytes` and `clipboard`. Pixel versus text-cells capture payloads and positive versus negative assertion polarity remain separate facts. An OSC 52 write decided by independent clipboard readback is `clipboard`; paste decided by `readInput` is `input_bytes`, including its existing control/report envelope and performed action.

The XTEST key criterion requires the ctrl+a modified-key encoding after its plain-a delivery
control; a bare control byte or another modified key does not meet it. Pixel mouse reporting
uses the existing terminal-reported cell geometry to predict the pixel box of the control
click's cell and retains that geometry with the target report. Missing cell geometry stays
named PROBE TODO. The two scroll-region recipes seed and preserve a nonblank marker immediately
above the requested top row. The insert/replace query criterion requires set then reset
(Ps 1 then 2); permanent-state replies retain their numeric readings and fail that toggle claim.

The twelve real-surface input term criteria retain genuine input measurements. Only an absent
`input` or `readInput` facility selects the named PROBE TODO `real-surface input injection (XTEST/CGEvent)`.
The seven host-input library rows (`input.xtest-key`, `input.xtest-click`, `input.xtest-wheel`,
`input.button-event-mouse`, `input.pixel-mouse`, `input.urxvt-mouse`, `input.x10-mouse`)
retain `os-input-review`, with reason
"Lib arm: the engine consumes bytes and has no input surface; host input encoding is measured in the terminal arm."
These remain review PROBE TODO rows; earlier captures stay unchanged.

`LibProbeSource.encodeKey` is exposed only for the same backend instance's declared `key-encoding`
extension. It returns the library encoder's bytes in that instance's current modes; the legacy
host-backed `encodeKey` method alone does not qualify. A declared extension without its function
is a binding error, and native encoding failures propagate without substituting host bytes.
The two native modifyOtherKeys callbacks sample plain a, Ctrl+a, Ctrl+i, bare i and ArrowUp
with the mode reset, requested, then reset again. They retain event fields, exact bytes and a
separate recovery CPR. Same-path controls must pass in every phase. The target is extended
Ctrl+i for level 2 and extended bare i for level 3; both CSI-u and CSI-27 forms are compared
by logical codepoint and modifier. No logical mode transition in the fixed key list, target silence or failed reset/control evidence
remains a named PROBE TODO, except a qualified unchanged-byte negative: cursor-key mode
must change ArrowUp from CSI A to SS3 A and back, both before MOK and after reset.
With those controls, the ordinary delivery controls and recovery CPR passing, an unchanged
sample whose off form differs from the required level encoding establishes Unsupported.
Level 2 first checks Ctrl+a against codepoint 97/modifier 5, then Ctrl+i; level 3 checks
plain i against codepoint 105/modifier 1. The record names that absence key and retains
both cursor controls. An already-target off form is never negative evidence.
Native exceptions propagate after the reset command in `finally`.
The reviewed Ghostty-web 0.4.0 MOK2/MOK3 cells are declared Untestable: its public encoder
cannot receive parsed MOK state, and no level-3 selector exists. Ghostty-native 1.3.1 MOK3
is also declared Untestable because its public options carry only the state-2 boolean.
These criterion-specific declarations do not declare either library's XTEST key interface absent.

`extensions.clipboard-paste` uses the same backend instance’s declared `paste-encoding`
extension. Its native encoder returns actual input bytes without consuming pending replies or emitting
paste bytes through response callbacks. The probe reads incoming mode 2004 through the existing
mode getter or, when that getter is unavailable, a native DECRPM query. Query replies and DA1 controls
are retained; missing or failed same-feed DA1 and unavailable readback stay PROBE TODO without
changing modes. DECRPM Ps1/Ps3 read on and Ps2/Ps4 read off; actual native controls decide permanent
modes too. Ps3 with an always-framed encoder fails the off controls and stays TODO; Ps4 with qualified
raw output is Unsupported. Restoration must re-query the same Ps. It samples the incoming
paste behavior, checks two fresh nonces with mode 2004 reset and two with it set, then restores and
verifies both the incoming mode and behavior. Exact raw payloads with mode reset qualify the control. Both framed payloads
with mode set establish Supported; both raw payloads establish Unsupported. Silent, malformed or
inconsistent bytes stay inconclusive. Captures retain the bytes and ordered calls. An absent encoder
stays named PROBE TODO, except the three approved public API absences: `alacritty_terminal` 0.26.0
`Term`, `vt100` 0.16.2 `Screen`/`Parser`, and `@xterm/headless` 6.0.0 `Terminal` expose mode state but
no native paste encoder, so those libraries record Untestable. Their reasons name the specific public surface. A provided encoder is always measured first. The app arm keeps its existing OS-input recipe.

Four term mode criteria opt into `decrpmModeProbe`'s set check: reverse video 5, synchronized output 2026,
DECSCLM 4 and color-scheme reporting 2031. Snapshot Ps 1/3 is Supported without mutation; Ps 0/4 is
Unsupported without mutation. Snapshot Ps 2 sends DECSET, queries again and restores DECRST:
Ps 1/3 is Supported. For synchronized output 2026, a retained Ps 2 is PROBE INVALID:
the reset reply cannot establish an enabled update, and rendered effect remains unmeasured.
For the other three modes, a retained Ps 2 is Unsupported with "recognized but DECSET refused (mode kept reset)".
No reply is PROBE TODO "no DECRPM reply"; an attempted set still restores the reset snapshot.
These callbacks require the existing disposable-terminal authority. Their limitation is
"presentation (tearing, scroll cadence, inverted frame) unmeasured; protocol measured".
Every other mode keeps the default recognition-only path.

DECSSCLS is CSI Ps SP p, not a DEC mode: its term criterion still requires timed screenshots.
Its library arm stays `headless-observable-review` with null assertion type and reason
"presentation speed: headless engines paint no frames and expose no scroll-speed state".
The missing presentation-speed observable remains PROBE TODO.

Reset-family capture recipes can supply an optional `RegionReadback.setupReference`: an independently
authored full setup, painted behind the existing witness. The seed must match it before any support conclusion.
Companion rows also compare a neutral ignored frame against the expected preserved attribute; missing
setup or an inseparable reference stays inconclusive. Recipes without the member keep four frames.
A qualified baseline followed by a complete but unqualified SGR setup report may use this existing
independent capture path for the six eligible reset rows. The response retains both query phases and
the capture response, and the note names the deciding instrument. Malformed setup, failed baseline
and the three multi-attribute reference refusals keep their existing behavior.
Without a deciding independent capture, an omitted setup attribute retains named PROBE TODO coverage
and both raw query phases, just as an omitted final attribute does; it is not a broken measurement.
With an owned colour, reset-family or blink oracle, valid final SGR state replies and named
missing-observable results use its same-run pixel controls; the unchanged DECRQSS reply stays in
the note. Plain style rows without an owned oracle retain their DECRQSS decision and named cause.
Malformed replies and failed baseline/setup controls keep their failures; independent setup
capture keeps its existing eligibility. A valid state reply and different pixel result measure
different properties, not a conflict.
State-only `extensions.truecolor` has no registered visual oracle and keeps its DECRQSS criterion
even when the context also supplies capture.

**Headless evidence** comes through [headless-batch.ts](../probes/headless-batch.ts). It retains callback `response` values as raw replies, not every probe-source call or every engine-state read.

The OSC 10, 11, 12 and 4 index-0 initial-colour queries preserve their ordinary reply and sentinel paths.
Without a qualified sentinel path, an empty initial reply runs a disposable set/query/reset/query control,
retaining every write and reply, including setter/reset acknowledgements. Only an exact seeded-colour
reply, empty acknowledgements and an empty reset query select `color-readback-review`: the initial value
is embedder-owned and still missing. A seeded reply never proves initial/default-colour support.
Other control outcomes retain criterion PROBE INVALID. The retained run identifies its suite and raw evidence; this callback grants neither automatic Untestable nor support.

For the OSC 104 library reset with an unanswered initial OSC 4 index-0 query, indexed cells provide
an independent reset witness. The callback retains a default D before setting, seeded S before and
after reset, and fresh F painted after reset, alongside the existing query controls and extra writes.
Exact glyphs and valid RGB must establish a default distinct from the verified aa/bb/cc seed.
Fresh F matching D proves reset; F remaining seeded is a controlled negative when S also remains seeded.
S records cell storage (resolved at read or at paint), so S remaining seeded with F restored still proves reset.
S restored with F seeded, a third fresh colour or missing post-reset readings are PROBE TODO with that cause named.
An answered post-reset query still reporting the seed contradicts a fresh cell restored to default and is also PROBE TODO.
Missing S-after stays PROBE TODO even when F matches D; no storage reading is invented.
Sentinel negatives keep their original DA1 response, with optional indexed-cell controls retained in the assertion note.
Cell-decided results retain the original sentinel outcome and timing alongside their controls.
Missing default or seed controls retain the existing query and sentinel rules, never a reset negative.
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
default-color state as PROBE TODO with the no-control reason, without inventing pointer slots
or executing reset writes. Other color features are unchanged.

Cell `dim`, `italic`, `strikethrough` and `blink` readbacks are required `boolean | null`: null means the producer does not report that attribute, never a terminal-support claim. On a rendered X cell, their SGR probes retain the null or false state as PROBE TODO with the no-control reason; an unreported value never becomes a measured negative. Positive booleans retain their supported observation path. A missing X retains an inconclusive result without a deciding assertion. A rowless, unnamed inconclusive result keeps the writer default PROBE INVALID (callback defect); only an explicit named test or review row classifies its cause. It is not reclassified as missing-observable coverage. Stored captures remain unchanged.

The OSC 8 library criterion requires exact per-cell URI metadata, including unlinked controls.
An absent `hyperlinks` observer with valid fixture text retains named coverage (PROBE TODO) and raw cell/link state,
identifying the loaded adapter path and Termless revision when measured runtime identity is available.
Declared getters returning null report unlinked cells, so URI mismatches remain measured negatives; invalid declared getters still throw.

The declaration-only library checks (Kitty animation and Unicode placeholders, Sixel,
semantic prompts, OSC 633 and iTerm2 images), OSC 7 and notifications without their metadata readers, an absent OSC 8 URI observer,
and checks lacking timing, host-event or rendering facilities retain their existing coverage and raw
state on `headless-observable-review`. Without an explicit declared Untestable
route, each is PROBE TODO naming its missing observable; the source-qualified
notification exceptions above use that existing declaration route.
Measured mode state is separate from unmeasured presentation, including scroll cadence, inverted frames
and tearing. App callbacks and real-observable
paths keep their criteria. Existing captures acquire no new branch or review.

The collector forwards the run's measured `HeadlessRuntimeIdentity` through `LibProbeSource.runtimeIdentity`.
It identifies the loaded adapter source, engine integrity and any loaded binary; feature-capability versions
cannot substitute for it.

For the four headless geometry queries (XTWINOPS 14/16, OSC 1337 ReportCellSize and OSC 776),
a complete zero-dimension reply has no same-path control in the run, so it is PROBE TODO with the
no-control reason: zero is an unknown, not a measured size. The callback retains query, raw reply and
measured runtime identity. Malformed replies and positive dimensions retain their query criteria.

The headless collector qualifies reply delivery with a fresh CPR path control once per engine and run.
The first probe pass keeps its query and separate DA1 control. Only a possible silence-based negative
repeats on two fresh instances with CUP/CPR brackets: first without a grace wait, then with the configured
grace window. A no-wait assertion states that no grace wait occurred; configured windows are not elapsed-time evidence.
Matching replies decide themselves. Missing or wrong controls and late bytes retain named PROBE TODO;
disagreement between fresh passes is PROBE INVALID, with all raw control, query and repeat evidence retained.

A recipe probe takes the host route when its measured runtime is native, and takes the control
otherwise. A callback-owned TODO keeps its reason and tests
and does not repeat; control findings remain in raw metadata. The existing identity owner still measures
each initialized callback instance; a changed or unavailable identity prevents its callback.
Per-feature decisions retain that instance's identity. The existing Alacritty, Kitty and WezTerm cohort
retains host recipes and query/cause records; a private collector list preserves this validation scope.
Ghostty Native and vt100-rust keep the native route without these records. The reader requires every
decision's recipe binding when any is present.
Historical native declarations still trigger the same strict validation, without rewriting stored runs.
`collector.replyPath` retains measured identity and decisions; no adapter delivery declaration or comparer
authorizes a silence-based negative. Adapter source and native artifact receipt checks remain independent.
Termless public types remain until their separate removal. Live collection keeps DA1.

Source-backed collection requires an owned hh checkout with vendored Termless source. A dist-only
install without the imported source binding refuses collection loudly; silence stays inconclusive.
A delivery declaration never declares feature support. Historical runs receive no new proof.

Conclusive library observations need nonempty raw evidence and matching positive/negative assertions. A direct buffer-state assertion must match the retained response; invalid claims become collector errors.

The `semantic-prompt-source-review` library branch for OSC 133/633 marks does not invent mark observations
or assertions. [Its callback](src/extensions.ts) distinguishes declared metadata with no reader from the
former source-review fallback, which is PROBE TODO with the no-control reason.

**Native evidence** comes through [probes/unified.ts](../terminfo.dev/src/probes/unified.ts). It retains writes, queries, ordered events and available capture/clipboard records separately from callback responses.

Most native raw-reply entries are serialized traces. Identity-query entries retain queried bytes and a separate `.trace`; a callback response, when supplied for a measurement, uses `.callbackResponse`.

Native execution can also change the recorded result: for example, a measured resize retains the callback observation but adds a failed geometry test. A callback conclusion is not the final run status. This migration classifies existing observations; probe writes retain their existing representation, order and bytes.

**Frames supply evidence; they do not decide support.** `ObservationFrame` distinguishes pixel frames from `text-cells` frames; pixel and cell rectangles/digests are not interchangeable.

Declared visual criteria use [region readback](src/region-readback.ts) to compare stable,
cell-aligned pixel crops against independently painted references behind a paint witness.
For each declared frame, the sentinel must complete a same-crop space→glyph→space→glyph
roundtrip with exact repeatable digests; an intermediate clear alone cannot qualify paint.
This relies on faithful current captures and ordered terminal paint, not arbitrary adapter replay
or compositor completion. Missing roundtrip returns retain `no freshness witness` review. Both initial stability captures remain in the result frames because response-backed assertions cite their cell and whole-image digests. A missing pixel geometry emits a required failure row naming the missing report, retaining attempted query evidence without a support conclusion.
Expected-change and expected-no-change claims have separate controls; an unchanged frame
without freshness evidence remains review PROBE TODO. Each decided signal retains its own
assertion. Missing discriminators and unmeasured feature facets remain named review rows;
cursor-shape cell and blink-phase sampling belongs to #31812. Historical frames acquire no
new comparison or support conclusion.

`TermProbeSource.capture` supplies owned pixel capture; `cells` is a separate terminal-text route for declared cell readback. [Region readback](src/region-readback.ts) and callbacks evaluate the resulting evidence.

The app exit/1047/insert-mode rows declare character readback and use that same region oracle.
Exit and 1047 paint primary then alternate markers; leaving the alternate is compared with a plainly
painted primary reference. Text reads use the existing character change criterion; pixel reads retain
their declared freshness checks. An unqualified entry leaves any failed exit roundtrip as named PROBE TODO,
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
states, so a terminal that reflows when the image arrives is inconclusive by name rather than judged on a
moved rectangle — and a same-image veto, which makes the with-image rectangle supported only when it is
pixel-identical to the ordinary placement of the same opaque image over the same cells. Where a run does
expose a cells adapter, unequal readbacks still veto to inconclusive before the table, and a text-only run
refuses by name before it.

The run retains screenshot/text references and assertion references. A captured frame does not by itself establish support; only a same-run pixel check decides it, and a capture without one stays PROBE TODO, never Unsupported.

## How execution becomes status

Observation outcomes are `supported`, `unsupported`, `inconclusive` and `error`. Recorded probe statuses are `supported`, `unsupported`, `untestable`, `probe-todo` and `probe-invalid`.

[recordExecutedProbe](src/helpers.ts) uses explicit callback tests when valid. Diagnostics and errors retain precedence. Otherwise its default criterion preserves supported/unsupported observations and maps the other cases:

- Missing capture reported as `FrameUnavailable` becomes `probe-todo`.
- Diagnostics and error observations become `probe-invalid`.
- Coverage becomes `probe-todo`. Refusal and consumption without a deciding observation explicitly supply PROBE TODO tests; unanswered queries and errors explicitly supply PROBE INVALID tests. No reply, clipboard value or frame is invented to satisfy a type.
- A measured inconclusive observation stays typed and defaults to `probe-invalid` unless an existing explicit criterion test selects a different status.

`finalizeProbeResult` folds the required tests in order: failure, pending or empty tests, unsupported, then supported. A test marked untestable folds to PROBE TODO unless the result is the declared form (`isDeclaredUntestable`), which reads Untestable. Collection finalization records Windows console-host prerequisites before that fold. The canonical run reader decodes the stored result without folding its tests again, except that a stored source-answer cell reads as PROBE TODO (see above); content validation uses that same reader.

That order matters: a failed test wins over a pending one. Timeout or lack of an observable is not automatically evidence that a terminal lacks the feature; the probe's criterion must establish that. An execution-only PROBE TODO can follow real I/O and does not promise an empty trace; pre-I/O refusal fixtures separately prove their zero-byte behavior.

For new app and mux results, every member of the existing `sgrProbes`
registry (including colors and resets) requires a screenshot for that feature in the same run. The shared
`finalizeSgrResult` applies this requirement in the native batch writer before checkpointing.
Only the result's own screenshot reference matched to a non-text-cells frame in that probe's captures counts;
a batch-wide reference or an assertion labelled screenshot does not. A missing frame retains a pending `visual` test with
reason `visual effect not observed in this run` when a Supported or Unsupported result lacks that evidence.
Existing pending and failure results retain their causes; a screenshot never establishes support by presence alone.
Library SGR results retain their existing cell-state criterion results, including through headless checkpointing
and library replay. They describe the effect on observed cells; they do not establish a rendered pixel effect.
Ghostty web 0.4.0's canvas draws double, curly, dotted and dashed underline styles as a single line.
The Termless backend registry still owns the optional `rendering` product declaration: `render-capable` or
`parser-only`, with cited sources beside its values. This finalizer no longer reads those declarations.
Kitty remains undeclared because its internal Screen bridge has no separate public library contract establishing
this boundary. The current synchronous library route captures no pixels.
No new capture API or pixel predicate is supplied here. Historical run bytes and reader interpretation stay unchanged.

The headless OSC 52 read callback seeds an isolated nonce and accepts measured silence only through
an available, collector-qualified sentinel query member. Its retained raw response and measured sentinel
facts distinguish that negative from an unanswered capture. Malformed or unmatched replies remain
inconclusive; an exact canonical nonce reply is positive. The write and combined clipboard callbacks
keep their existing roundtrip requirement: a read negative never decides either write claim.

Feature-specific criteria keep those distinctions local.
The canonical Kitty graphics direct-RGB query classifies a correlated printable reply as supported for
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
`recordCollectorSelection` also labels untouched PROBE TODO rows outside that schedule as not selected; selected rows retain
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

Controlled mux collection consumes the single `OwnedTerminal.muxAttachmentProof` in
[owned-terminal.ts](../terminfo.dev/src/owned-terminal.ts); the clipboard adapter is Linux-only.
The Darwin process-owner route extends the existing ancestry reader with C-locale/UTC birth seconds,
UID, controlling TTY and kernel executable observations, then parses the complete attachment through
the existing proof parser. Ownership is asserted against the proved attached client while the collector
binds its own pane PTY. The outer process collector retains `collector.preflightIdentity` before mux
attachment; the inner collector joins that retained identity and hashes the exact `collector.outerLaunch`
bytes. Darwin Screen retains its full measured version line; the parser's one admitted version supplies
both normalized subject joins. These source paths do not establish native qualification or authorize a
capture, corpus placement or publication.

The owned Linux tmux launcher extends its existing collector-registration poll with one
metadata query per poll to the recorded socket and run session. Before calibration,
both the window name and pane command must be `bun`; the existing poll bound and sleep
stay unchanged. This readiness observation does not qualify pixels: complete-frame
calibration and restoration still decide whether the native capture can proceed.

Multiplexer expectation declarations describe routing, not terminal support:

- **`pass-through`**: the bytes reach the outer terminal and its reply returns to the pane.
- **`mux-answered`**: the outcome the probe reads is decided inside tmux, either because tmux answers from its own state or because tmux's input parser consumes the query and emits nothing; in both the host terminal is never consulted.
- **`unresolved`**: the route is not established at the pin.

The [daemon client](../terminfo.dev/src/daemon-client.ts) retains HTTP responses. The [capture writer](../terminfo.dev/src/capture-writer.ts) finalizes enriched runs and writes immutable result snapshots.

The writer checks intended id/version against known measured values without replacing them, but sets `subject.kind` from the intended term/mux subject and retains `intendedSubject` separately. Both current source and suite version are explicit inputs; a historical declaration cannot silently become a live writer's manifest.

The capture writer retains measured identity and recorded result statuses. Private diagnostic collection preserves its response and normalized snapshot outside the source repository.

A missing instrument remains PROBE TODO with its reason; it does not establish a support conclusion. The cited suite manifest retains catalogue entry hashes in `catalogEntrySha256`.

Every library backend declares the `adapter-sources` extension from its one adapter registry.
Reply-delivery declarations, when present, share that registry's same source array; identity alone grants no reply capability.
The collector verifies declared blobs against tracked imported source bytes once per runtime, then compares per-instance declarations.
Missing identity or stale declarations are named collector errors. Historical captures may omit this field.
Source engines bind repository and tree OID with `cleanTree: true`; dirty source stays PROBE TODO with a named reason.

[collected-run.ts](../admin/src/collected-run.ts) retains the private response and normalized run first. Explicit app and mux `--output` stops there. Default app, mux and server collection also calls [corpus-placement.ts](../admin/corpus-placement.ts), which checks the run, trusted suite and cited artifacts before placing them under `content/`. Release collection remains private. Collection does not authorize external release or publication; those remain held until the actual full Phase 1.4 merge and their existing authorization.

## How a collected run becomes a measured cell

The remeasure instrument reads `collection.json` from the headless collector, parses each named run against its suite, and copies each recorded `featureId` and status into `cells.json` or `cells.partial.json`. Failed engines are reported as refusals; an empty capture contributes no cells. The instrument records the suite for each engine and keeps incomplete output separate. These private measurements do not publish the site.

New headless collections retain the producer's existing schema 4 suite declaration once, before workers start, at `suites/<probeHash>.json` inside their private output directory. Their `collection.json` names it through `suiteManifest`. The working-run reader supplies this confined file explicitly to the canonical raw-capture reader, so the original run and probe evidence remains readable after the executable suite changes. A declared manifest that is missing, malformed or misfiled fails loudly; it never falls back to another declaration. Legacy collections without the field retain their existing committed/current-suite trust and unreadable banner.

Only the working-run reader supplies this private manifest input. It reads raw, unreviewed evidence; selected results, public results, release scope and admission never consume it. No accepted result, corpus placement or publication authority follows from retaining the declaration. Old captures without a retained declaration are not reconstructed or rewritten.

`measureRenderedWidth` returns a number or a named readback cause: `no-reply` with its step,
`control-mismatch` with its step and observed cursor, or `wrapped` with its observed cursor.
All width callbacks distinguish these before applying their numeric feature criterion: missing
readback is named PROBE TODO; wrong controls and wrapping are named PROBE INVALID. A wrong numeric
ASCII control is also a fixture failure. Unknown transport kinds throw with the probe and kind
named. `/query` retains the same result in its `width` field. JSON preserves the cause fields.

The mode-family source wrapper in [helpers.ts](src/helpers.ts) never infers mode absence from rejected
DECRQM. Qualified set/reset or stack commands run between rendered-X controls; consumed commands and
leaked text retain different reasons, line and cursor state. Missing X, moved lines and unqualified source
remain named PROBE TODO; actual DECRPM replies retain their result. Held instrumentation and mixed query-reply /
buffer-state declaration limits remain callback-specific, not claims about every engine.

The library mouse source wrappers in [input.ts](src/input.ts) likewise retain command/control state,
not measured mouse-event bytes. In [extensions.ts](src/extensions.ts), a silent highlight query plus
rendered X is not a measured reset negative. A qualified source route for a missing OSC1 icon observer
retains the actual stimulus and before/after title state; title behavior alone is not icon support.
Other missing observers keep their existing coverage result.

The Vterm input source wrapper retains raw state as PROBE TODO, without a deciding
input observation or assertion: the callback performs no input event and supplies no measured input negative.
Terminal criteria are unchanged.
