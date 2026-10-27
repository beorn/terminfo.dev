# Probe definitions and collected evidence

`@terminfo/probe-defs` defines terminal feature probes, their evidence and the shared run model. Start at the [exports and probe registry](src/index.ts); [types.ts](src/types.ts) owns the shapes.

This describes the implemented system. A proposed redesign would separate live capture from offline assertions; that separation is not implemented here. Update this document as the system changes.

## From definition to recorded result

**A definition is executable, not a saved result.** `ProbeDefinition` identifies a feature and supplies either or both callback arms:

- `termless(ctx)` is synchronous and reads a `LibProbeSource` backed by a headless engine.
- `term(ctx)` is asynchronous and uses a `TermProbeSource` for real-terminal I/O and any available owned capture, clipboard or input facilities.
- A null arm has no implementation for that route. Ownership, geometry, text-readback and evidence declarations constrain the arms that do exist.

`ALL_PROBES` collects the category definitions. A `ProbeSuiteManifest` separates complete `catalogIds` membership from the callback schedules in `probes.app`, `probes.headless` and `probes.mux`.

The [shared execution helpers](src/helpers.ts) initialize every catalog member as `test-todo` with no attempt, then record only the work actually performed.

**Callback and stored shapes are different.** Follow these names in [types.ts](src/types.ts):

- `ProbeCallbackResult` is either a measured result with an `observation`, or `notTested` coverage naming a missing semantic observable. It can carry callback checks and a criterion branch.
- `Observation` records an outcome, evidence method and any reason or frame references. `ProbeAssertion` records a positive/negative predicate, expected state and observed evidence.
- `ProbeResult` stores the feature's execution status, attempt, required checks, selected criterion branch and evidence references. It is not the callback's `pass` boolean.
- `RunDraft` is a private schema-3 envelope: run/suite/source identity, intended context, measured identity when available, raw replies, assertions, artifact references and capability results.
- `CapturedRunDraft` requires measured target, identity, time and origin. `CurrentProbeRun` additionally has `sealedAt`; `ProbeRun` aliases this current shape. Older runs have separate historical types.

The legacy callback `pass` still exists. The [diagnostic Vitest runner](../probes/run-unified.probe.ts) checks it; current collectors record observations/checks through `recordExecutedProbe` instead.

## Evidence, capture and assertion

Callbacks currently perform I/O and judge it in the same implementation. There is no general persisted callback transcript or independently replayable assertion API supplied by this package.

**Headless evidence** comes through [headless-batch.ts](../probes/headless-batch.ts). It retains callback `response` values as raw replies, not every context call or every engine-state read.

Conclusive headless observations need nonempty raw evidence and matching positive/negative assertions. A parser-state assertion must match the retained response; invalid claims become collector errors.

**Native evidence** comes through [probes/unified.ts](../terminfo.dev/src/probes/unified.ts). It retains writes, queries, ordered events and available capture/clipboard records separately from callback responses.

Most native raw-reply entries are serialized traces. Identity-query entries retain queried bytes and a separate `.trace`; a callback response, when supplied for a measurement, uses `.callbackResponse`.

Native execution can also change the recorded result: for example, a measured resize retains the callback observation but adds a failed geometry check. A callback conclusion is not the final run status.

**Frames are evidence, not verdicts.** `ObservationFrame` distinguishes pixel frames from `text-cells` frames; pixel and cell rectangles/digests are not interchangeable.

`TermProbeSource.capture` supplies owned pixel capture; `cells` is a separate terminal-text route for declared cell readback. [Region readback](src/region-readback.ts) and callbacks evaluate the resulting evidence.

The run retains screenshot/text references and assertion references. A captured frame does not by itself establish support, and a pending required review does not become an unsupported result.

## How execution becomes status

Observation outcomes are `supported`, `unsupported`, `inconclusive` and `error`. Recorded capability statuses are `supported`, `unsupported`, `untestable`, `test-todo` and `test-failure`.

[recordExecutedProbe](src/helpers.ts) uses explicit callback checks when valid. Otherwise its default criterion preserves supported/unsupported observations and maps the other cases:

- Missing capture reported as `FrameUnavailable` becomes `test-todo`.
- Diagnostics and error observations become `test-failure`.
- Coverage or inconclusive `none`/`consumed` evidence becomes `test-todo`; remaining undecided cases become `test-failure`.

`finalizeProbeResult` folds the required checks in order: failure, pending or empty checks, reviewed impossibility, unsupported, then supported. `untestable` needs a review reference.

That order matters: a failed check wins over a pending one. Timeout or lack of an observable is not automatically evidence that a terminal lacks the feature; the probe's criterion must establish that.

These run statuses are separate from the catalog's [probe-coverage labels](../../docs/data/probe-status.ts), such as `automated`, `partial` and `manual`, which describe the available test definitions.

## Collector routes and persistence

The five admin routes share definitions, but do not all execute or persist through the same path:

- **Headless:** [admin/src/termless.ts](../admin/src/termless.ts) calls [collect-headless.ts](../probes/collect-headless.ts), which runs isolated engine workers using `headless-batch.ts` and retains private runs.
- **App:** [admin/src/app.ts](../admin/src/app.ts) launches an owned terminal/daemon, requests collection and enriches its retained response with launch and identity evidence.
- **Server:** [admin/src/server.ts](../admin/src/server.ts) starts or contacts daemons. [serve.ts](../terminfo.dev/src/serve.ts) owns `collectProbeRun`, using the native unified batch.
- **Inline:** [admin/src/here.ts](../admin/src/here.ts) calls that same `collectProbeRun`, finalizes the draft and prints it or its summary. Printing a result is not admission.
- **Mux:** [admin/src/mux.ts](../admin/src/mux.ts) runs a daemon through the multiplexer, collects its response and supplies the intended mux context to the shared writer.

The [daemon client](../terminfo.dev/src/daemon-client.ts) retains HTTP responses. The [capture writer](../terminfo.dev/src/capture-writer.ts) finalizes enriched runs and writes immutable result snapshots.

The writer checks intended id/version against known measured values without replacing them, but sets `target.kind` from the intended app/mux context and retains that intent separately.

`sealRunDraft` requires complete measured identity and no pending required review; other `test-todo` results can remain in a sealed run.

Required reviews are applied before sealing. While a review remains pending, the writer keeps an unsealed `.draft.json`; once sealed, enrichment cannot change those result bytes.

[admit-collected-run.ts](../admin/src/admit-collected-run.ts) keeps the private response/run first. App and mux output-directory mode stops there; their default mode and the server route also attempt admission.

Admission is a separate operation owned by [run-admission.ts](../admin/run-admission.ts), exposed through [scripts/admit-run.ts](../../scripts/admit-run.ts). Pending review stays private, not admitted.

That owner checks the run, suite and cited artifacts before placing admitted content. A private collection, successful test or sealed result alone does not mean site data has been published.

The [execution and seal-boundary tests](src/execution-checks.test.ts) exercise these distinctions without collecting new terminal data.
