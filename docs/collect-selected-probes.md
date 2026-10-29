# Collect selected probes

Run these commands from the source repository root with its declared dependencies available.
Choose a private output directory outside `content/`; collection retains evidence without admitting or publishing it.

The existing dispatcher accepts canonical context IDs and exact probe IDs as JSON arrays:

```sh
bun scripts/release1-collection.ts --collect --development --output "$HOME/.terminfo-dev/selected" --contexts '["xtermjs/headless"]' --probe-ids '["sgr.bold"]'
```

Use `--plan` to inspect context names and routes. Headless contexts use `backend/headless`; native contexts use `terminal/os`.
Omit a filter to use the existing full schedule. An explicit `[]` schedules no work for that filter.
Unknown or duplicate probe IDs report an input error. Family names are not expressions: expand them to exact registry IDs before collecting.

To inspect empty-selection behavior without starting a worker:

```sh
bun scripts/release1-collection.ts --collect --development --output "$HOME/.terminfo-dev/selected-empty" --contexts '["xtermjs/headless"]' --probe-ids '[]'
```

The printed pass directory contains `pass.json`. Its `selection` names the resolved inputs and its context rows point through `rawRun` to the original run or draft.
For each selected context, the draft records `rawReplies["collector.selection"]` before dispatch.
Decode that JSON string to read `ids`; decode `rawReplies["collector.collectionAttempt"]` to read the typed outcome.

| Outcome     | Meaning                                                                          |
| ----------- | -------------------------------------------------------------------------------- |
| `empty`     | Explicit selection scheduled nothing; no start or measured identity is invented. |
| `started`   | Actual collection started; an interrupted record may retain this checkpoint.     |
| `completed` | Collection returned; required review or feature TODOs may remain.                |
| `failed`    | Original error retained; a pre-start refusal has no invented start.              |
| `cancelled` | Cancellation retained with its original diagnostic.                              |

Draft initialization retains every catalogue position as an unattempted TODO.
Only emitted results have a top-level `ProbeResult.attempt` with scope `probe` or `collection`; a selected but unreached TODO remains scope `none`.
An unsuccessful attempt does not refresh an older result's date or review.
Each capture retains its own run ID, evidence and review bindings.

The `complete` field still describes the whole required cohort; selecting a subset does not make the cohort complete.
Use the existing private report with explicit pass inputs to inspect composed results. Public projection and hosted filtering follow the separate hosted/public delivery stage.

Required resources remain the existing suite, catalogue, source and route runtime dependencies.
Missing resources and route failures keep their named diagnostics and retained private draft; they never select a fallback subset.

See the [probe-system model](../packages/probe-defs/README.md#collector-routes-and-persistence) for collector and writer ownership.
