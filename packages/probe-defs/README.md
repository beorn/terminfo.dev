# Probe definitions and collected evidence

`@terminfo/probe-defs` defines term feature probes, their observations and the shared run model. Start at the [exports and probe registry](src/index.ts); [types.ts](src/types.ts) owns the record types.

This describes the implemented system. Callbacks still perform live I/O and evaluate it together. General ordered recording and replay belong to recorder #30932 and are not implemented here.

## Vocabulary and current code

- **Probe subject**: the exact terminal app, emulator library or multiplexer being probed, at a recorded path, OS and version. `ProbeSubject.kind` is `term`, `lib` or `mux`.
- **Term feature**: one terminal behaviour being tested, identified by `featureId`, with one `ProbeDefinition` supplying lib and/or term paths. A mux uses the term path.
- **Probe source**: where answers come from. `TermProbeSource` and `LibProbeSource` currently supply only `live` answers from the subject. A `trace` source remains future work.
- **Probe trace**: everything one probe run did and saw, entry by entry, including referenced files. Current collectors retain subsets, not a complete replayable record.
- **Test**: one required condition of a probe, with its own status and assertion references. `ProbeTestResult` is stored; `ProbeTestInput` is supplied by a callback.
- **Assertion**: one expected-versus-observed comparison. `ProbeAssertion` carries positive/negative polarity independently of its `assertionType`.
- **Probe result**: one probe on one subject, with its status, tests, assertions and retained evidence. Stored `ProbeResult` and callback `ProbeCallbackResult` are separate shapes.

The five assertion types classify the deciding observation: `query_reply` reads a query reply; `buffer_state` reads cells, cursor or modes; `screenshot` reads captured pixels; `input_bytes` reads bytes received for an OS input event; `clipboard` reads what an OSC 52 write put on the clipboard. Probe setup and feed writes retain their existing order and bytes; they are not a sixth assertion type.

Status names remain supported, unsupported, untestable, TEST TODO and TEST FAILURE. The last two retain code values `test-todo` and `test-failure`; this vocabulary change does not change status or publication behavior.

The collection owner's frozen `CollectionPass.freeze.deferrals` records each carried context with its `routeIssue` and `reason`.
`release1-collection --collect --admit --frozen-suite <id> --deferrals <json-file>` reads that explicit array before collection.
Deferred contexts remain named in the pass census with their reason and no new measurement; existing context status values are unchanged.
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

Both source interfaces carry `readonly kind: ProbeSourceKind` directly. The only implemented source kind is `live`; writer and reader reject `trace` by name until #30932 implements it. Runs retain `source: { kind: "live" }`, so adding trace later needs no schema bump.

`termAssertionType` and `libAssertionType` declare a retained deciding-observation class. An explicit null means the callback runs without a typed deciding observable; undefined is temporarily undeclared (#28801). Neither means the callback arm itself is absent, and neither becomes a null observation or assertion type.

`ALL_PROBES` collects the category definitions. A current `ProbeSuiteManifest` explicitly carries schema version 4 and separates complete `catalogIds` membership from the callback schedules in `probes.term`, `probes.lib` and `probes.mux`. Historical declarations normalize their schedules on read while retaining their original absent schema marker.

The [shared execution helpers](src/helpers.ts) initialize every catalog member as `test-todo` with no attempt, then record only the work actually performed.

OSC99 capability detection has both library and term query arms. They share the nonce/title
criterion and never display a notification. Unqualified library capture silence stays inconclusive;
only the existing qualified sentinel path can establish a negative reply result. Current artifact
source audits retain their own parser/reply-path citations. Viewport hold on output has a term
coverage callback naming our missing actuator forwarding and position readback, performs no I/O,
and stays TEST TODO. Its library arm remains null; this does not establish an engine limitation.

**Callback and stored shapes are different.** Follow these names in [types.ts](src/types.ts):

- `ProbeCallbackResult` has three arms: a measured `observation`; `notTested` coverage naming a missing semantic observable; or execution-only, nonempty TODO/FAILURE `tests`, each with a mandatory reason. Execution-only callbacks have no observation, assertions or coverage. Callbacks can select a criterion branch.
- `Observation` records an outcome and required `assertionType`. `ProbeAssertion` records the independently positive/negative predicate, required `assertionType`, expected state and retained observed evidence.
- `ProbeResult` stores the feature's execution status, attempt, required tests, selected criterion branch and evidence references. Its optional primary `assertionType` names only a retained observation; absence is not a sixth type. Legacy `pass` never grades it.
- `RunDraft` is a private schema-4 envelope: explicit source, run/suite identity, `intendedSubject`, measured `subject` when available, raw replies, assertions, artifact references and probe results. Subject kinds are `term`, `lib` and `mux`.
- `CapturedRunDraft` requires measured subject, identity, time and origin. `CurrentProbeRun` additionally has `sealedAt`; `ProbeRun` aliases this current shape. Historical reader outputs retain their schema marker, canonical names and an absent source. Their assertion type may remain absent when retained historical evidence cannot establish it.

The legacy callback `pass` still exists for the [diagnostic Vitest runner](../probes/run-unified.probe.ts), including the execution-only arm. Current collectors record observations/tests through `recordExecutedProbe`; even `pass: true` with an explicit FAILURE test stays failure. Cleanup #30929 removes `pass` from every arm.

## Evidence, capture and assertion

Callbacks currently perform I/O and judge it in the same implementation. There is no general persisted callback transcript or independently replayable assertion API supplied by this package.

The five `AssertionType` values classify an actually retained deciding observation: `query_reply`, `buffer_state`, `screenshot`, `input_bytes` and `clipboard`. Pixel versus text-cells capture payloads and positive versus negative assertion polarity remain separate facts. An OSC 52 write decided by independent clipboard readback is `clipboard`; paste decided by `readInput` is `input_bytes`, including its existing control/report envelope and performed action.

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
three callbacks keep their existing query path. Other color features are
unchanged.

Cell `dim`, `italic`, `strikethrough` and `blink` readbacks are required `boolean | null`: null means the producer does not report that attribute, never a terminal-support claim. On a rendered X cell, their SGR probes retain the null or false state through `source-negative-review`, with a required review and a buffer-state assertion. A source-bound decision distinguishes an engine gap (Unsupported at that pin) from a binding gap (Untestable until repaired and recaptured). Positive booleans retain their supported observation path. A missing X retains the existing inconclusive result without an assertion or review; it is not reclassified as missing-observable coverage. Stored captures remain unchanged.

The OSC 8 library criterion requires exact per-cell URI metadata, including unlinked controls.
An absent `hyperlinks` observer with valid fixture text retains named coverage (TEST TODO) and raw cell/link state,
identifying the loaded adapter path and Termless revision when measured runtime identity is available.
Declared getters returning null report unlinked cells, so URI mismatches remain measured negatives; invalid declared getters still throw.

The eight declaration-only library checks (Kitty animation and Unicode placeholders, Sixel,
semantic prompts, OSC 7, OSC 633, notifications and iTerm2 images), the absent OSC 8 URI observer,
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

**Native evidence** comes through [probes/unified.ts](../terminfo.dev/src/probes/unified.ts). It retains writes, queries, ordered events and available capture/clipboard records separately from callback responses.

Most native raw-reply entries are serialized traces. Identity-query entries retain queried bytes and a separate `.trace`; a callback response, when supplied for a measurement, uses `.callbackResponse`.

Native execution can also change the recorded result: for example, a measured resize retains the callback observation but adds a failed geometry test. A callback conclusion is not the final run status. This migration classifies existing observations; probe writes retain their existing representation, order and bytes.

**Frames are evidence, not verdicts.** `ObservationFrame` distinguishes pixel frames from `text-cells` frames; pixel and cell rectangles/digests are not interchangeable.

`TermProbeSource.capture` supplies owned pixel capture; `cells` is a separate terminal-text route for declared cell readback. [Region readback](src/region-readback.ts) and callbacks evaluate the resulting evidence.

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

Headless DECCOLM reads ordered CSI 18t geometry before the mode change, while changed, and after restoration.
It enables the ?40 policy gate before switching 80→132→80, or reverses the order from an initial 132 columns.
It uses existing `feedCapture`; `cols` remains the initialization reading. No resize is manufactured inside the probe.
An unanswered first 18t names that missing observable; malformed or incomplete attempted geometry stays inconclusive.
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
