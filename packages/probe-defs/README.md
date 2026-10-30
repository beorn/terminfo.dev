# Probe definitions and collected evidence

`@terminfo/probe-defs` defines term feature probes, their observations and the shared run model. Start at the [exports and probe registry](src/index.ts); [types.ts](src/types.ts) owns the record types.

This describes the implemented system. Callbacks still perform live I/O and evaluate it together. The private viprobe package supplies the ordered record/read/replay core. Both TTY recording owners now derive their legacy display events from validated call logs. The selected eleven-probe erase runner reuses the existing region/history predicates through task-owned native checks and replays actual xterm.js effects offline. Artifact provenance, final domain mapping/reporting and delivery remain unfinished under recorder #30932; no stored grades or current admission change.

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

**A definition is executable, not a saved result.** `ProbeDefinition` identifies a feature and supplies either or both callback arms:

- `lib(ctx)` is synchronous and reads a `LibProbeSource` backed by a headless engine.
- `term(ctx)` is asynchronous and uses a `TermProbeSource` for real-terminal I/O and any available owned capture, clipboard or input facilities.
- A null arm has no implementation for that route. Ownership, geometry, text-readback and assertion-type declarations constrain the arms that do exist.

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
no I/O and retains a `headless-observable-review` row with the API boundary and loaded runtime for
per-engine source review. Only a non-author Untestable decision can discharge it; it creates no
observation or assertion. The application arm remains TEST TODO until terminal-owned child readback exists.

The pinned vterm 0.9.0 library arms for OSC 9, 22, 176, 440, 555, 666, 710, 777 and 3008 feed their exact commands and a cell-X
consumption control. A rendered X retains `source-negative-review`, its actual fed/cell state and a
negative buffer-state assertion for independent review of the target implementation at source53a9eb92.
The control proves parser consumption, not a target effect; target state remains explicitly unexposed.
The vt100 0.9.0 arms use the same nine commands and control only at their independently audited
source identity (revision53a9eb92, package tree5ffc7ad9, vt100 entry path). Its handleOSC switch
at screen.ts:504-520 has cases0/1/2 only. The OSC9 notification-sink citation is specific to the
vterm entry; vt100 records its own absent-handler citation. These paths retain a pending source
review, never an automatic grade or a measured target effect.
The vt220 0.9.0 arms qualify the same nine commands at revision53a9eb92, package
tree69366752 and the vt220 entry path. Its screen.ts:703-718 handleOSC returns
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
Untestable or a negative. Every other identity keeps its existing measured criterion.

**Callback and stored shapes are different.** Follow these names in [types.ts](src/types.ts):

- `ProbeCallbackResult` has three arms: a measured `observation`; `notTested` coverage naming a missing semantic observable; or execution-only, nonempty TODO/FAILURE `tests`, each with a mandatory reason. Execution-only callbacks have no observation, assertions or coverage. Callbacks can select a criterion branch.
- `Observation` records an outcome and required `assertionType`. `ProbeAssertion` records the independently positive/negative predicate, required `assertionType`, expected state and retained observed evidence.
- `ProbeResult` stores the feature's execution status, attempt, required tests, selected criterion branch and evidence references. Its optional primary `assertionType` names only a retained observation; absence is not a sixth type. Legacy `pass` never grades it.
- `RunDraft` is a private schema-4 envelope: explicit source, run/suite identity, `intendedSubject`, measured `subject` when available, raw replies, assertions, artifact references and probe results. Subject kinds are `term`, `lib` and `mux`.
- `CapturedRunDraft` requires measured subject, identity, time and origin. `CurrentProbeRun` additionally has `sealedAt`; `ProbeRun` aliases this current shape. Historical reader outputs retain their schema marker, canonical names and an absent source. Their assertion type may remain absent when retained historical evidence cannot establish it.

The legacy callback `pass` still exists for the [diagnostic Vitest runner](../probes/run-unified.probe.ts), including the execution-only arm. Current collectors record observations/tests through `recordExecutedProbe`; even `pass: true` with an explicit FAILURE test stays failure. Cleanup #30929 removes `pass` from every arm.

The OSC 1 library criterion requires separate icon readback and a verified OSC 2 window-title control; an icon update must preserve that title. Missing icon readback remains coverage, while a failed title control is an execution failure. Both labels are restored after the attempt. Library OSC 117/119 resets reuse the color-reset helper's initial-query, distinct verified seed and reset-query sequence. Missing initial highlight readback or an unverified seed cannot establish reset support or absence; the original highlight color is restored after the attempt.

## Evidence, capture and assertion

Callbacks currently perform I/O and judge it in the same implementation. There is no general persisted callback transcript or independently replayable assertion API supplied by this package.

The five `AssertionType` values classify an actually retained deciding observation: `query_reply`, `buffer_state`, `screenshot`, `input_bytes` and `clipboard`. Pixel versus text-cells capture payloads and positive versus negative assertion polarity remain separate facts. An OSC 52 write decided by independent clipboard readback is `clipboard`; paste decided by `readInput` is `input_bytes`, including its existing control/report envelope and performed action.

The XTEST key criterion requires the ctrl+a modified-key encoding after its plain-a delivery
control; a bare control byte or another modified key does not meet it. Pixel mouse reporting
uses the existing terminal-reported cell geometry to predict the pixel box of the control
click's cell and retains that geometry with the target report. Missing cell geometry stays
named TEST TODO. The two scroll-region recipes seed and preserve a nonblank marker immediately
above the requested top row. The insert/replace query criterion requires set then reset
(Ps 1 then 2); permanent-state replies retain their numeric readings and fail that toggle claim.

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
For the audited vt100/vt220 0.9.0 source tuples, libvterm 0.3.3 WASM tuple and vt100-rust 0.16.2
native tuple in `ABSENT_OSC_ENGINES`, the same ALINKZ fixture instead retains `source-negative-review`
and a negative buffer-state assertion. Qualification binds the source path, revision and clean package
tree, or the native build provenance; WASM/native tuples also bind the loaded artifact digest.
This is a pending independent source review, not an automatic Unsupported result. A different runtime
or broken text fixture cannot acquire that source assertion. Existing captures need a fresh run and
new exact-run decisions; this source change does not annotate retained captures.
Declared getters returning null report unlinked cells, so URI mismatches remain measured negatives; invalid declared getters still throw.

The eight declaration-only library checks (Kitty animation and Unicode placeholders, Sixel,
semantic prompts, OSC 7, OSC 633, notifications and iTerm2 images), an unaudited absent OSC 8 URI observer,
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

Source-backed collection runs from the hh root with vendored Termless source. A dist-only install
without the imported source binding loses sentinel eligibility loudly; silence stays inconclusive.
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
Headless DECSCLM names its missing presentation-timing capture; headless 2031 names its missing host palette actuator
and persistent event listener. Mode recognition or enabled metadata cannot decide those effects.

These run statuses are separate from the catalog's [probe-coverage labels](../../docs/data/probe-status.ts), such as `automated`, `partial` and `manual`, which describe the available test definitions.

## Collector routes and persistence

[Selected collection](../../docs/collect-selected-probes.md) describes explicit context/probe inputs and retained attempt outcomes.
The existing registry exports `resolveProbeIds`; collectors share its typed resolution rather than duplicate ID lookup.
Selection changes the callback schedule, while initialized drafts retain the full catalogue and the original suite hash.
The existing `collector.selection` and `collector.collectionAttempt` records retain intent, actual start and outcome.
The canonical draft decoder distinguishes captured runs from explicitly empty initialized drafts; empty drafts contain no measured identity or emitted result.

The five admin routes share definitions, but do not all execute or persist through the same path:

- **Headless:** [admin/src/termless.ts](../admin/src/termless.ts) calls [collect-headless.ts](../probes/collect-headless.ts), which runs isolated engine workers using `headless-batch.ts` and retains private runs.
- **App:** [admin/src/app.ts](../admin/src/app.ts) launches an owned terminal/daemon, requests collection and enriches its retained response with launch and identity evidence.
- **Server:** [admin/src/server.ts](../admin/src/server.ts) starts or contacts daemons. [serve.ts](../terminfo.dev/src/serve.ts) owns `collectProbeRun`, using the native unified batch.
- **Inline:** [admin/src/here.ts](../admin/src/here.ts) calls that same `collectProbeRun`, finalizes the draft and prints it or its summary. Printing a result is not admission.
- **Mux:** [admin/src/mux.ts](../admin/src/mux.ts) runs a daemon through the multiplexer, collects its response and supplies the intended mux configuration to the shared writer.

The [daemon client](../terminfo.dev/src/daemon-client.ts) retains HTTP responses. The [capture writer](../terminfo.dev/src/capture-writer.ts) finalizes enriched runs and writes immutable result snapshots.

The writer checks intended id/version against known measured values without replacing them, but sets `subject.kind` from the intended term/mux subject and retains `intendedSubject` separately. Both current source and suite version are explicit inputs; a historical declaration cannot silently become a live writer's manifest.

`sealRunDraft` requires complete measured identity and no pending required review; other `test-todo` results can remain in a sealed run.

Required reviews are applied before sealing. While a review remains pending, the writer keeps an unsealed `.draft.json`; once sealed, enrichment cannot change those result bytes.

[admit-collected-run.ts](../admin/src/admit-collected-run.ts) keeps the private response/run first. App and mux output-directory mode stops there; their default mode and the server route also attempt admission.

Admission is a separate operation owned by [run-admission.ts](../admin/run-admission.ts), exposed through [scripts/admit-run.ts](../../scripts/admit-run.ts). Pending review stays private, not admitted.

That owner checks the run, suite and cited artifacts before placing admitted content. A private collection, successful test or sealed result alone does not mean site data has been published.

The [execution and seal-boundary tests](src/execution-results.test.ts) exercise these distinctions without collecting new terminal data.

`measureRenderedWidth` returns a number or a named readback cause: `no-reply` with its step,
`control-mismatch` with its step and observed cursor, or `wrapped` with its observed cursor.
All width callbacks distinguish these before applying their numeric feature criterion: missing
readback is named TEST TODO; wrong controls and wrapping are named TEST FAILURE. A wrong numeric
ASCII control is also a fixture failure. Unknown transport kinds throw with the probe and kind
named. `/query` retains the same result in its `width` field. JSON preserves the cause fields.
