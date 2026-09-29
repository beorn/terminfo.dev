---
outline: [2, 3]
---

# API

Machine-readable terminal compatibility data -- the terminal equivalent of [MDN Browser Compat Data](https://github.com/mdn/browser-compat-data).

## Data Endpoint

**`GET /api/v1/data.json`**

Returns the v1 compatibility projection as a single JSON file. Only reviewed, conclusive current results appear. An absent terminal or feature means this response has no qualified result for it; absence is not a negative result. [Measurement methods](/contribute#what-a-probe-can-establish) explain what each observation can establish.

[View raw data](/api/v1/data.json)

## Badges

Embeddable SVG badges are generated only for terminals with a current reviewed score:

```markdown
![terminfo.dev](https://terminfo.dev/api/v1/badges/ghostty.svg)
```

### Available Badges

Badge URLs follow the pattern `/api/v1/badges/{slug}.svg` where `{slug}` is a scored terminal key in `data.json`. Check the key before linking a badge.

Color coding:

- **Green** -- 90%+ features supported
- **Yellow** -- 70-89% features supported
- **Red** -- below 70% features supported

## Schema

```json
{
  "version": 1,
  "generated": "",
  "methodology": {
    "revision": "2026-09-28",
    "v2": "/api/v2/data.json",
    "methods": "/contribute#what-a-probe-can-establish",
    "contexts": {}
  },

  "features": {
    "sgr.bold": {
      "name": "Bold (SGR 1)",
      "category": "sgr",
      "slug": "sgr-1-bold",
      "url": "https://vt100.net/docs/vt510-rm/SGR.html",
      "tags": ["ecma-48", "vt100"]
    }
  },

  "terminals": {},
  "results": {},
  "notes": {}
}
```

This empty-results example matches a build with no selectable reviewed runs. When one is available, `terminals` and `results` gain its slug; `notes` remains optional per feature. The existing v1 score object keeps its meaning: `total` is the number of reported yes/no feature results, `pass` counts yes, and `pct` is `pass / total`. Unknown, inconclusive and error observations are omitted, so coverage belongs in v2. Collector note text appears only after an exact evidence-presentation review; a reviewed correction note remains available without that decision. The methodology record announces this note correction, and the release packet counts the removed notes per target.

### Top-level Fields

| Field         | Type     | Description                                                                  |
| ------------- | -------- | ---------------------------------------------------------------------------- |
| `version`     | `number` | Schema version (currently `1`)                                               |
| `generated`   | `string` | Latest selected measurement time, or empty when none is selected             |
| `methodology` | `object` | Revision, v2 and methods links, and each v1 row's chosen context and run SHA |
| `features`    | `object` | Feature definitions keyed by dot-path ID                                     |
| `terminals`   | `object` | Terminal metadata keyed by slug                                              |
| `results`     | `object` | Conclusive support results: `terminal_slug -> feature_id -> "yes" \| "no"`   |
| `notes`       | `object` | Optional reviewed notes: `terminal_slug -> feature_id -> note_text`          |

### Feature Object

| Field      | Type        | Description                                                                                                                                   |
| ---------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`     | `string`    | Human-readable feature name                                                                                                                   |
| `category` | `string`    | Category: `sgr`, `cursor`, `text`, `erase`, `editing`, `modes`, `scrollback`, `reset`, `extensions`, `charsets`, `device`, `input`, `unicode` |
| `slug`     | `string`    | URL-friendly slug for the feature detail page                                                                                                 |
| `url`      | `string?`   | Link to the relevant specification                                                                                                            |
| `tags`     | `string[]?` | Standard tags: `ecma-48`, `vt100`, `vt220`, `vt510`, `kitty-extensions`, etc.                                                                 |

### Terminal Object

| Field         | Type        | Description                                                                      |
| ------------- | ----------- | -------------------------------------------------------------------------------- |
| `name`        | `string`    | Display name                                                                     |
| `version`     | `string`    | Tested version                                                                   |
| `type`        | `string`    | `"app"` (real terminal) or `"headless"` (parser library); multiplexers are in v2 |
| `platforms`   | `string[]?` | Tested platforms: `macos`, `linux`, `windows`                                    |
| `url`         | `string?`   | Terminal homepage                                                                |
| `score.total` | `number`    | Conclusive yes/no feature results reported in v1                                 |
| `score.pass`  | `number`    | Features passing                                                                 |
| `score.pct`   | `number`    | Pass percentage (0-100)                                                          |

## Usage Examples

### Check feature support

```javascript
const data = await fetch("https://terminfo.dev/api/v1/data.json").then((r) => r.json())

// "yes", "no", or undefined when this context has no conclusive result.
const support = data.results["ghostty"]?.["extensions.kitty-keyboard"]
if (support === undefined) console.log("No qualified current result")
```

### Find terminals that support a feature

```javascript
const truecolorTerminals = Object.entries(data.results)
  .filter(([_, results]) => results["sgr.fg.truecolor"] === "yes")
  .map(([slug]) => data.terminals[slug]?.name)
  .filter(Boolean)
```

### Get all features in a category

```javascript
const sgrFeatures = Object.entries(data.features)
  .filter(([_, f]) => f.category === "sgr")
  .map(([id, f]) => ({ id, name: f.name }))
```

### Terminal scorecard

```javascript
const terminal = data.terminals["ghostty"]
if (terminal) {
  const { name, score } = terminal
  console.log(`${name}: ${score.pass}/${score.total} (${score.pct}%)`)
} else {
  console.log("No reviewed current score for Ghostty")
}
```

## Exact-context v2 data

**`GET /api/v2/data.json`** carries the canonical four outcomes (`supported`, `unsupported`, `inconclusive`, `error`) and each observation's method, reason when applicable, and provenance chain. `current` is keyed by exact target context, so an app, its headless parser and a multiplexer remain separate. Each selected version includes `target`, `runId`, `sha256`, `measuredAt`, `suiteId`, `probeHash`, `suiteFreshness`, `suite` (observed and expected probe counts), `cells`, and counts for catalog, tested, not tested, conclusive, supported and unsupported. `versions` keeps selectable versions; `history` keeps older and excluded runs as metadata summaries, including ungraded legacy observations; `exclusions` names why a run was not selected without publishing internal source paths.

Each v2 cell gives the public outcome, reason when recorded, method and run identity. Its `presentation.state` distinguishes `not-reviewed`, `withdrawn` (with reviewer and reason) and `presented` (with reviewer, reason, evidence URL and SHA-256 digest). A presented cell may include verified image descriptors for the hover preview. Raw replies and assertion bodies are **not** embedded in `data.json`, including its history. For a presented cell, the static document at its `presentation.url` contains the original recorded feature observation, raw reply and bound assertions when captured, approved image descriptors, exact `runId`, `runSha256` and `featureId`, and the presentation review. Clients should verify the document bytes against `presentation.sha256` and check those identities before using its details. A successful document with no raw material means none was captured; a failed fetch, digest or identity check is an evidence error, not missing evidence.

`presentsEvidence` is an editorial decision about what the site and generated API present. It is **not a privacy control**: this is a public repository, so source files and images may be accessible independently of these endpoints. A withdrawn decision removes the generated evidence link and details from the next staged output; it cannot retract copies already downloaded.

v1's `methodology.contexts[slug]` names the exact context, run SHA and target chosen for that compatibility row. If more than one context exists for a terminal ID, the site and v1 require a reviewed default-context policy row with its reviewer, reason and sources. An unresolved collision stops the build rather than merging results. Multiplexer results appear in v2 under `kind: "mux"`; v1's `type` field retains its existing app/headless meaning.

## Versioning

The API version is in the URL path (`/v1/`) and in the `version` field of the response. Breaking changes will use a new version number (`/v2/`). Additive changes (new features, new terminals, new fields) are backwards-compatible within a version.

## Rate Limits

The data is served as a static file from a CDN. No rate limits, no authentication required.

## License

Data is available under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Attribution: "Data from [terminfo.dev](https://terminfo.dev)".
