---
outline: [2, 3]
---

# API

Machine-readable terminal compatibility data -- the terminal equivalent of [MDN Browser Compat Data](https://github.com/mdn/browser-compat-data).

## Data Endpoint

**`GET /api/v1/data.json`**

Returns the complete compatibility database as a single JSON file.

[View raw data](/api/v1/data.json)

## Badges

Embeddable SVG badges for terminal READMEs:

```markdown
![terminfo.dev](https://terminfo.dev/api/v1/badges/ghostty.svg)
```

**Preview:**

![Ghostty](/api/v1/badges/ghostty.svg)
![Kitty](/api/v1/badges/kitty.svg)
![iTerm2](/api/v1/badges/iterm2.svg)

### Available Badges

Badge URLs follow the pattern `/api/v1/badges/{slug}.svg` where `{slug}` matches the terminal key in `data.json`.

Color coding:

- **Green** -- 90%+ features supported
- **Yellow** -- 70-89% features supported
- **Red** -- below 70% features supported

## Schema

```json
{
  "version": 1,
  "generated": "2026-03-25T...",

  "features": {
    "sgr.bold": {
      "name": "Bold (SGR 1)",
      "category": "sgr",
      "slug": "sgr-1-bold",
      "url": "https://vt100.net/docs/vt510-rm/SGR.html",
      "tags": ["ecma-48", "vt100"]
    }
  },

  "terminals": {
    "ghostty": {
      "name": "Ghostty",
      "version": "1.3.1",
      "type": "app",
      "platforms": ["macos"],
      "url": "https://ghostty.org",
      "score": { "total": 110, "pass": 108, "pct": 98 }
    }
  },

  "results": {
    "ghostty": {
      "sgr.bold": "yes",
      "sgr.faint": "yes"
    }
  },

  "notes": {
    "ghostty": {
      "extensions.sixel": "not supported"
    }
  }
}
```

### Top-level Fields

| Field       | Type     | Description                                                                  |
| ----------- | -------- | ---------------------------------------------------------------------------- |
| `version`   | `number` | Schema version (currently `1`)                                               |
| `generated` | `string` | ISO 8601 timestamp of data generation                                        |
| `features`  | `object` | Feature definitions keyed by dot-path ID                                     |
| `terminals` | `object` | Terminal metadata keyed by slug                                              |
| `results`   | `object` | Support results: `terminal_slug -> feature_id -> "yes" \| "no" \| "partial"` |
| `notes`     | `object` | Optional notes: `terminal_slug -> feature_id -> note_text`                   |

### Feature Object

| Field      | Type        | Description                                                                                                               |
| ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `name`     | `string`    | Human-readable feature name                                                                                               |
| `category` | `string`    | Category: `sgr`, `cursor`, `text`, `erase`, `editing`, `modes`, `scrollback`, `reset`, `extensions`, `charsets`, `device` |
| `slug`     | `string`    | URL-friendly slug for the feature detail page                                                                             |
| `url`      | `string?`   | Link to the relevant specification                                                                                        |
| `tags`     | `string[]?` | Standard tags: `ecma-48`, `vt100`, `vt220`, `vt510`, `kitty-extensions`, etc.                                             |

### Terminal Object

| Field         | Type        | Description                                              |
| ------------- | ----------- | -------------------------------------------------------- |
| `name`        | `string`    | Display name                                             |
| `version`     | `string`    | Tested version                                           |
| `type`        | `string`    | `"app"` (real terminal) or `"headless"` (parser library) |
| `platforms`   | `string[]?` | Tested platforms: `macos`, `linux`, `windows`            |
| `url`         | `string?`   | Terminal homepage                                        |
| `score.total` | `number`    | Total features tested                                    |
| `score.pass`  | `number`    | Features passing                                         |
| `score.pct`   | `number`    | Pass percentage (0-100)                                  |

## Usage Examples

### Check feature support

```javascript
const data = await fetch("https://terminfo.dev/api/v1/data.json").then((r) => r.json())

// Does Ghostty support kitty keyboard protocol?
const supports = data.results["ghostty"]?.["extensions.kitty-keyboard"] === "yes"
```

### Find terminals that support a feature

```javascript
const truecolorTerminals = Object.entries(data.results)
  .filter(([_, results]) => results["sgr.truecolor-fg"] === "yes")
  .map(([slug]) => data.terminals[slug].name)
// => ["Ghostty", "Kitty", "iTerm2", ...]
```

### Get all features in a category

```javascript
const sgrFeatures = Object.entries(data.features)
  .filter(([_, f]) => f.category === "sgr")
  .map(([id, f]) => ({ id, name: f.name }))
```

### Terminal scorecard

```javascript
const { name, score } = data.terminals["ghostty"]
console.log(`${name}: ${score.pass}/${score.total} (${score.pct}%)`)
```

## Versioning

The API version is in the URL path (`/v1/`) and in the `version` field of the response. Breaking changes will use a new version number (`/v2/`). Additive changes (new features, new terminals, new fields) are backwards-compatible within a version.

## Rate Limits

The data is served as a static file from a CDN. No rate limits, no authentication required.

## License

Data is available under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Attribution: "Data from [terminfo.dev](https://terminfo.dev)".
