---
outline: [2, 3]
---

# API

## Current results

**`GET /api/v3/data.json`** returns the current five-status contract. Composed contexts retain cells from original stored schema-4 runs.

[View current data](/api/v3/data.json) · [Frozen v1](/api/v1/data.json)

| Field                    | Meaning                                                                        |
| ------------------------ | ------------------------------------------------------------------------------ |
| `version`                | Public API version, `3`                                                        |
| `generated`              | Latest original source measurement time across contexts; empty with no sources |
| `features`, `catalogIds` | Catalog metadata; each run also records its own exact frozen `catalogIds`      |
| `contextCount`           | Number of composed contexts                                                    |
| `contexts`               | Exact context keys mapped to composed context summaries                        |
| `versions`, `history`    | Retained stored schema-4 run references                                        |
| `methodology`            | Status, score, completion and historical endpoint explanations                 |
| `message`                | Explicit no-current explanation when `contextCount` is zero                    |

A context includes its physical `subject` (without a version), `catalogIds`, `featureResults`, `sources`, `contributingRunIds`, `attempts`, counts, score and completion. Its subject may be absent for an unmeasured pre-start attempt. A context has no single run ID, version, suite or run hash.

Each `featureResults[featureId]` retains `origin: { runId, resultId }`, `measuredAt`, `suiteId` and `suiteRelation`. Resolve its original receipt as `context.sources[cell.origin.runId]`. Each source retains its own subject version, source revision, suite, run ID/hash, catalog IDs, counts, score, completion, trace receipt and verified run-document URL/hash. `versions` and `history` reference these original immutable run documents; they do not contain composed results.

Each public attempt is flat: `runId`, optional recorded `startedAt` and `noOutputIds`. Private selection, outcome and error objects remain in the canonical private projection. A later attempt without output does not replace an earlier measured cell.

## Five recorded statuses

| Stored value   | Display label | Meaning                                                         |
| -------------- | ------------- | --------------------------------------------------------------- |
| `supported`    | Supported     | The recorded criterion was satisfied                            |
| `unsupported`  | Unsupported   | The functioning test obtained the defined negative result       |
| `untestable`   | Untestable    | No current route; no result reaches it                          |
| `probe-todo`    | PROBE TODO     | Required work remains; feature support is not decided   |
| `probe-invalid` | PROBE INVALID  | An attempted test or collection failed to obtain a valid result |

Each stored run has exactly one result per catalog ID. Original raw run documents are immutable and served verbatim. Older stored runs retain `test-todo` and `test-failure`; current readers map those words one to one to `probe-todo` and `probe-invalid`. Supported, Unsupported and Untestable retain their meanings. This is a vocabulary rename, not a re-grade or a rewrite of stored content.

A composed `featureResults[featureId]` also carries `strength` and `conflictingProbes`. When supported and unsupported probes disagree, its feature-only status is `probe-conflict` (PROBE CONFLICT); individual probes and their tests still use only the five statuses above. Conflict prevents completion.

`score.supported / score.all` is Supported divided by the **term features** (264 for a current
273-row run). Untestable, PROBE TODO and PROBE INVALID remain in that denominator. The nine environment
groups (`device.env-*`) are recorded in `results` and in the catalogue membership check, but are
**manual by design (catalogue)** and excluded from the score. Stored results remain visible;
only a stored PROBE TODO is displayed as **NOT MEASURED**.

A context's `complete` is true only when its PROBE TODO, PROBE INVALID and PROBE CONFLICT counts among the term
features are all zero. Completion does not imply full support.

An absent current context cannot count as complete.

## No current results

An all-history corpus is a valid migration state. The v3 response contains catalog metadata, `contextCount: 0`, `contexts: {}`, and an explicit message:

> No current sealed runs; historical results remain available.

It does not invent a current score or a completed cohort. Historical results remain readable through the frozen v1 endpoint.

## Read a result

```javascript
const data = await fetch("https://terminfo.dev/api/v3/data.json").then((r) => r.json())
if (data.contextCount === 0) console.log(data.message)

for (const [contextKey, context] of Object.entries(data.contexts)) {
  const cell = context.featureResults["sgr.fg.truecolor"]
  const source = cell && context.sources[cell.origin.runId]
  console.log(contextKey, cell?.status, context.score, context.complete)
  if (source) {
    const originalRun = await fetch(new URL(source.url, "https://terminfo.dev")).then((r) => r.json())
    console.log(source.subject.version, source.measuredAt, originalRun.runId)
  }
}
```

A missing context means there is no selected composed context. A missing cell has no retained result; an original run may also lack a feature outside its frozen catalog. Neither absence means Unsupported.

## Evidence and publication

Status recording, measured identity and evidence publication are separate facts. A support review does not automatically authorize publishing captured bytes.

Each result's `presentation` says whether evidence is unreviewed, withdrawn or presented. Presented evidence points to `/api/v3/evidence/<runSha256>.json#<featureId>` and carries the SHA-256 receipt of that run's evidence document. Per-run evidence documents carry `version: 4`, bumped from per-cell `version: 3` because the document shape changed to `cells[featureId]`.

Each run's evidence document keys its approved cells under `cells[featureId]` and retains the stored result plus original expected/observed assertions, raw reply and frame references. Text snapshots and screenshots retain their own hashes.

Free-form execution reasons and captured diagnostics pass the existing presentation review boundary. A summary without that approval does not expose the private collector note or capture.

Each contributing original source carries `trace`: the URL and SHA-256 receipt of its trace document, `/api/v3/traces/<run sha256>.json`. The document names the run's SHA-256, its recorded identity, and holds every result without a presentation decision, keyed by feature ID under `featureResults[featureId]`:

- the outcome or status, the assertion type and a reason code;
- the bytes the probe wrote, and each query's sequence and reason;
- a headless engine's parser state;
- each assertion's kind and expected text.

A live terminal's reply (a query's `match`, an assertion's `observed`) appears only for features whose replies use a closed grammar, such as numeric reports. Other stored reply content, such as screen state or a clipboard, does not appear; a result whose stored reply the trace leaves out says `replyWithheld: true`. Notes, actions, diagnostics, captures, raw read windows and paths never appear in a trace.

## Frozen v1 {#historical-v1-and-v2}

**`GET /api/v1/data.json`** is frozen. Frozen 2026-10-22, not updated; current data /api/v3/data.json. The bytes stay exactly as they are and are no longer generated.

It preserves the released historical yes/no projection and its historical score semantics. It omits entries without a recorded Supported or Unsupported value rather than treating them as false. No new-contract status is converted into a historical boolean.

Historical v1 scores keep their original denominator: recorded yes/no results. They must not be compared with the v3 Supported/all score as if the bases were equal.

The frozen SVG badges remain at their released URLs, stay embeddable at `https://terminfo.dev/api/v1/badges/<slug>.svg`, and visibly say Historical:

```markdown
![Historical terminfo.dev result](https://terminfo.dev/api/v1/badges/ghostty.svg)
```

Use v3 composed context status, score and completion for current comparisons. Historical records cannot discharge the fresh current-source qualification requirement.
