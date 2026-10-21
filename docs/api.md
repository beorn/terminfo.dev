---
outline: [2, 3]
---

# API

## Current results

**`GET /api/v3/data.json`** returns the current five-status contract. Only sealed schema-3 runs appear as current results.

[View current data](/api/v3/data.json) · [Historical v2](/api/v2/data.json) · [Historical v1](/api/v1/data.json)

| Field                    | Meaning                                                                       |
| ------------------------ | ----------------------------------------------------------------------------- |
| `version`                | Public API version, `3`                                                       |
| `generated`              | Latest selected current measurement time, or empty when no current run exists |
| `features`, `catalogIds` | Catalog metadata; each run also records its own exact frozen `catalogIds`     |
| `currentRunCount`        | Number of selected current contexts                                           |
| `current`                | Exact context keys mapped to current run references                           |
| `versions`, `history`    | Retained sealed schema-3 run references                                       |
| `methodology`            | Status, score, completion and historical endpoint explanations                |
| `message`                | Explicit no-current explanation when `currentRunCount` is zero                |

A run reference includes its target/context, source revision, suite, run ID/hash, frozen catalog IDs, `sealedAt`, counts, score, completion, and a verified run-document URL/hash.

## Five recorded statuses

| Stored value   | Display label | Meaning                                                          |
| -------------- | ------------- | ---------------------------------------------------------------- |
| `supported`    | Supported     | The recorded criterion was satisfied                             |
| `unsupported`  | Unsupported   | The functioning test obtained the defined negative result        |
| `untestable`   | Untestable    | A reviewed context impossibility prevents this criterion         |
| `test-todo`    | TEST TODO     | Required work remains; this is not a terminal capability verdict |
| `test-failure` | TEST FAILURE  | An attempted test or collection failed to obtain a valid result  |

Each sealed run has exactly one result per frozen catalog ID. Its `results` array retains the recorded status and attempts/checks; readers never turn old observations into new current statuses.

`score.supported / score.all` is Supported divided by every frozen catalog position. Untestable, TEST TODO and TEST FAILURE remain in that denominator.

A context's `complete` is true only when its TEST TODO and TEST FAILURE counts are both zero. Completion does not imply full support.

Publication still requires every required context on the approved source/suite. An absent current context cannot count as complete.

## No current schema-3 runs

An all-history corpus is a valid migration state. The v3 response contains catalog metadata, `currentRunCount: 0`, `current: {}`, and an explicit message:

> No current schema-3 runs; historical results remain available.

It does not invent a current score or a completed cohort. Historical results remain readable through the versioned endpoints and terminal history pages.

## Read a result

```javascript
const data = await fetch("https://terminfo.dev/api/v3/data.json").then((r) => r.json())
if (data.currentRunCount === 0) console.log(data.message)

for (const [context, reference] of Object.entries(data.current)) {
  const run = await fetch(new URL(reference.url, "https://terminfo.dev")).then((r) => r.json())
  const result = run.results.find((result) => result.featureId === "sgr.fg.truecolor")
  console.log(context, result?.status, run.score, run.complete)
}
```

A missing context means there is no selected current run. A feature outside a run's frozen catalog has no result in that run. Neither absence means Unsupported.

## Evidence and publication

Status recording, identity admission and evidence publication are separate decisions. A support review does not automatically authorize publishing captured bytes.

Each result's `presentation` says whether evidence is unreviewed, withdrawn or presented. Presented evidence has its own document URL and SHA-256 receipt.

Current evidence documents retain the sealed result plus original expected/observed assertions, raw reply and frame references. Text snapshots and screenshots retain their own hashes.

Free-form execution reasons and captured diagnostics pass the existing presentation review boundary. A summary without that approval does not expose the private collector note or capture.

## Historical v1 and v2

**`GET /api/v2/data.json`** preserves schema-1/2 outcomes, provenance and readable evidence. Its existing `current` keys are historical defaults, not current schema-3 measurements.

**`GET /api/v1/data.json`** preserves the released historical yes/no projection and its historical score semantics. It omits nonconclusive entries rather than treating them as false.

Both endpoints declare `methodology.historicalOnly: true` and point to v3. No new-contract status is converted into a historical boolean.

Historical v1 scores keep their original denominator: conclusive yes/no results. They must not be compared with the v3 Supported/all score as if the bases were equal.

Historical SVG badges remain at their released URLs and visibly say Historical:

```markdown
![Historical terminfo.dev result](https://terminfo.dev/api/v1/badges/ghostty.svg)
```

Use v3 run status, score and completion for current comparisons. Historical records cannot discharge the fresh current-source qualification requirement.
