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

Each result's `presentation` says whether evidence is unreviewed, withdrawn or presented. Presented evidence points to `/api/v3/evidence/<runSha256>.json#<featureId>` (or `/api/v2/evidence/<runSha256>.json#<featureId>` for historical v2 runs) and carries the SHA-256 receipt of that run's evidence document. Legacy `/api/v2/evidence/<runSha256>/<featureId>.json` URLs 301-redirect to `/api/v2/evidence/<runSha256>.json`; per-run evidence documents carry `version: 4` (v3 runs) and `version: 2` (historical v2 runs), bumped from per-cell `version: 3` and `version: 1` because the document shape changed to `cells[featureId]`.

Each run's evidence document keys its approved cells under `cells[featureId]` and retains the sealed result (or historical observation) plus original expected/observed assertions, raw reply and frame references. Text snapshots and screenshots retain their own hashes.

Free-form execution reasons and captured diagnostics pass the existing presentation review boundary. A summary without that approval does not expose the private collector note or capture.

A run a page displays carries `trace`: the URL and SHA-256 receipt of its trace document, `/api/v2/traces/<run sha256>.json` for a historical run or `/api/v3/traces/<run sha256>.json` for a current one. The document names the run's SHA-256, its recorded identity and admission rule, and holds every result without a presentation decision, keyed by feature ID:

- the outcome or status, the evidence method and a reason code;
- the bytes the probe wrote, and each query's sequence and reason;
- a headless engine's parser state;
- each assertion's kind and expected text.

A live terminal's reply (a query's `match`, an assertion's `observed`) appears only for features whose replies use a closed grammar, such as numeric reports. Other stored reply content, such as screen state or a clipboard, does not appear; a result whose stored reply the trace leaves out says `replyWithheld: true`. Notes, actions, diagnostics, captures, raw read windows and paths never appear in a trace.

## Historical v1 and v2

**`GET /api/v2/data.json`** preserves schema-1/2 outcomes, provenance and readable evidence. Its existing `current` keys are historical defaults, not current schema-3 measurements.

**`GET /api/v1/data.json`** preserves the released historical yes/no projection and its historical score semantics. It omits entries without a recorded Supported or Unsupported value rather than treating them as false.

Both endpoints declare `methodology.historicalOnly: true` and point to v3. No new-contract status is converted into a historical boolean.

Historical v1 scores keep their original denominator: recorded yes/no results. They must not be compared with the v3 Supported/all score as if the bases were equal.

Historical SVG badges remain at their released URLs and visibly say Historical:

```markdown
![Historical terminfo.dev result](https://terminfo.dev/api/v1/badges/ghostty.svg)
```

Use v3 run status, score and completion for current comparisons. Historical records cannot discharge the fresh current-source qualification requirement.
