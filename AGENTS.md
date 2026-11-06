# terminfo.dev

**"caniuse.com for terminal emulators"** — feature support tables powered by automated testing.

Live at [terminfo.dev](https://terminfo.dev). Deployed to Cloudflare Pages.

## Stack

TypeScript, Bun, VitePress, Termless (headless terminal testing), Vitest.

## Before working on probes

Read the [current probe-system model](packages/probe-defs/README.md) before changing definitions, collectors, evidence or status mapping.
Update it in the same change when those contracts change.
Its [vocabulary and current code](packages/probe-defs/README.md#vocabulary-and-current-code) section maps the approved probe terms to existing identifiers and distinguishes future refactoring.

## Author loop

Work on one probe. Use the five result labels and terminal progress tiers defined in the probe-system model; catalog coverage and color depth are separate concepts.
Put new slice tests in `packages/probes/headless-batch-<slice>.test.ts`; edit `headless-batch.test.ts` only to change an existing assertion.
For authorized headless work, run the changed probe IDs across the eleven configured library backends and the owning two-sided checks.
Before Yrd submission, record expected result moves for each of the eleven configured library backends.
A change gated to one backend and an exact identity needs no collector: the next hourly run proves it. Any other change runs the full collector from the owned dev-repo worktree root with `@in -- bun run --cwd vendor/terminfo.dev probe termless --all`, records the actual per-library diff, and reconciles mismatches before submitting.
After merge, verify that the next hourly run's per-library diff matches the submitted expectation.
A do-nothing fake never reads Supported; a working fake reads Supported and loses it when only that feature is disabled.
Read the changed results and retained reasons, obtain one peer review, then deliver through the configured Yrd queue.
Collection writes and publication are separate; a Git push or site build is not deployment authority.
Existing run, custody and END holds remain in force.

Before a headless run, prepare the selected Termless native runtimes using the [headless runtime prerequisites](docs/capture-routes.private.md#headless-runtime-prerequisites).
Missing native modules or an unqualified Kitty binary are collection failures, not feature results.

## Directory Structure

```
content/                        ← ALL input data
  features.json                   feature metadata (name, slug, tags, body, probe)
  terminals.json                  terminal app metadata (label, description, body)
  standards.json                  standard/tag metadata (label, url, description)
  categories.json                 category metadata (label, order, description)
  annotations.json                plain backend:feature notes
  probes-apps/                    measured: real terminal results
  probes-libs/                    measured: headless backend results
  probes-mux/                     measured: multiplexer pass-through results

packages/                       ← source code (internal tools)
  probe-defs/                      @terminfo/probe-defs: pure probe definitions + shared types
  probes/                         @terminfo/probes: private headless collector + diagnostic Vitest runner
  admin/                          @terminfo/admin: author/orchestration CLI (bun admin)
    src/                          author CLI (bun admin) — five probe mechanisms
      index.ts                    entry point: probe {termless,server,app,here}, report, status, submit, detect
      termless.ts                 headless collection via packages/probes/collect-headless.ts
      server.ts                   daemon probe mechanism (start/list/probe daemons)
      app.ts                      macOS app probes (AppleScript)
      mux.ts                      multiplexer pass-through probes (tmux, screen)
      here.ts                     inline TTY probes
      detect.ts                   terminal detection
      submit.ts                   result submission
      report.ts                   report rendering
      status.ts                   config/cache status
    app-harness.ts                runs INSIDE launched terminals (not from CLI)
    index.ts                      legacy probes CLI (superceded by src/index.ts)
    parse.ts                      Vitest JSON result parsing
    versions.ts                   versioned backend probing
    report.tsx                    silvery-based report rendering
    reporter.ts                   custom Vitest reporter
    types.ts                      shared types
  api/                            API + badge generation (future)

packages/terminfo.dev/              ← npm-publishable CLI (npx terminfo.dev)
  src/
    index.ts                      entry point: probe {here,server}, submit, detect
    serve.ts                      daemon: HTTP server for in-terminal probing
    probes/                       probe implementations (run against real terminal apps)
    detect.ts                     terminal detection (TERM, DA1, etc.)
    submit.ts                     submit results to terminfo.dev
    tty.ts                        raw TTY I/O helpers

docs/                           ← VitePress site (built → deployed)
  .vitepress/
    config.ts                     nav, sidebar, SEO meta
    theme/                        shared CSS (tooltips, result cells)
  data/
    probes.data.ts                build-time loader (reads content/, computes CensusData)
    load-probes.ts                shared helpers (slugs, labels, tag resolution)
  index.md                        home matrix page
  terminals/[id].md               terminal detail pages
  [category]/[id].md              feature detail pages
  [id].md                         category + standard pages
  compare/[id].md                 comparison pages

versions.json                   backend version catalog (which versions to probe)
package.json                    private workspace root; packages/* are Bun workspaces
```

`packages/*/package.json` manifests are load-bearing. Sibling packages are
imported by package name (`@terminfo/probe-defs`); imports into the CLI's own
source are repo-relative filesystem paths like
`../../terminfo.dev/src/identity-guard.ts`. The bare subpath
`terminfo.dev/src/...` no longer resolves: `terminfo.dev` publishes only its
`./package.json` entry in `exports`.

## Data Architecture

Three data layers with clean separation:

```
MEASURED    content/probes-apps/  ← app probe results (don't edit by hand)
            content/probes-libs/  ← headless probe results (don't edit by hand)
CURATED     content/*.json        ← editorial JSON (AI + human editable)
DERIVED     docs/data/*.ts        ← computed at build time from above two
```

### Measured: Probe Results

`content/probes-apps/` — collected real terminal app results
`content/probes-libs/` — collected headless backend results
`content/probes-mux/` — collected multiplexer pass-through results

See the [record and persistence contracts](packages/probe-defs/README.md#collector-routes-and-persistence). Default app, mux and server collection writes normalized runs and cited data through the corpus placement owner; explicit `--output` retains private diagnostics. Release collection remains private.

External release, publication and pending answers remain held until the actual full Phase 1.4 merge and their existing authorization.

### Curated: Editorial Content

`content/` — JSON files that humans and AI edit:

| File               | What                                                        | Entries |
| ------------------ | ----------------------------------------------------------- | ------- |
| `features.json`    | Feature metadata: name, slug, tags, body, probe, baseline   | ~133    |
| `terminals.json`   | Terminal app metadata: label, slug, description, body, url  | ~11     |
| `standards.json`   | Standard/tag metadata: label, url, description              | ~10     |
| `categories.json`  | Category metadata: label, order, description                | ~13     |
| `annotations.json` | Plain backend:feature notes explaining failures            | 333     |
| `baselines.json`   | Baseline tier metadata: label, emoji, color, description    | 4       |

### Derived: Build-Time Computation

`docs/data/probes.data.ts` — reads measured + curated data, computes:

- Per-backend stats (total, yes, no, partial, %)
- Baseline compliance (core/modern/rich/unicode)
- Feature groupings by category and tag
- Backend metadata (merged from content/terminals.json + @termless/core manifest)

`docs/data/load-probes.ts` — shared helpers: slugs, labels, tag resolution. `content/analysis.json` is derived at `bun run build` (and `bun analysis`); it is not tracked.

## Commands

```bash
bun install                 # Install dependencies
bun run dev                 # Local dev server (VitePress)
bun run build               # Build static site (250+ pages) + emits API/badges into docs/.vitepress/dist/
bun run preview             # Preview built site
bun run landed-serve        # Build only if the output is not this checkout's revision, then serve it read-only

# Existing release-maintenance scripts, not the default author loop
bun run update --full       # Full refresh: discover → probe → validate → build
bun run update --status     # Check what's stale
bun run update --discover   # Run explore + show radar
bun run update --probe      # Re-probe headless backends
bun run update --validate   # Validate + build + check 404s
bun run watch-releases      # Check tracked terminals for new versions

# Individual tools
bun run validate            # Check tag consistency, duplicates, missing fields
bun run explore             # Run discovery queries (GPT-5.4 + web search → radar.jsonl)
bun run radar stats         # Triage discovery findings
bun run candidates list     # Review promoted candidates
```

### Author entry (`bun admin`)

From the component root, use `bun admin` for author collection and reporting.
`bun terminfo` invokes the separate user CLI; admin help displays the program name `terminfo`.

Start with explicit help, then select existing probe IDs for a separately authorized run:

```bash
bun admin --help
bun admin probe termless --help
bun admin probe termless --all --probe-ids '["cursor.move.absolute"]'
```

For the SGR family's existing two-sided contract checks, from the component root:

```bash
bun node_modules/.bin/vitest run packages/probe-defs/src/sgr-contract.test.ts
```

Other families use their owning checks; this is not a generic admin flag or a native collection command.

The collection example selects one existing probe across the configured headless backends; it is not a prerequisite for prose edits.
Bare `probe termless` selects every headless backend; omitted `--probe-ids` selects the full library suite.
`--probe-ids '[]'` executes no probes and is neither measurement nor a passing check.
Use exact backend keys, not version wildcards. The registered `--force` flag does not establish a cache behavior for this route.

Other registered routes are `probe server`, `probe app`, `probe mux` and `probe here`.
Read their explicit `--help` and the [route guide](docs/capture-routes.private.md) before an authorized run.
Registration does not establish platform availability, permission or a measured result.

#### Analysis

```bash
bun analysis                              # Write derived content/analysis.json (also the first step of bun run build)
bun analysis:validate                     # Compare a local analysis.json against regenerated canonical values
bun analysis --dry-run                    # Preview without writing
```

#### Reporting & Utilities

```bash
bun admin report                         # Show saved results
bun admin status                         # Config, cache, backends
bun admin detect                         # Detect current terminal
bun admin detect --json                   # Machine output
```

#### npm CLI (`npx terminfo.dev`)

```bash
npx terminfo.dev                          # Show help
npx terminfo.dev test                     # Test this terminal
npx terminfo.dev test --json              # Machine output
npx terminfo.dev test --serve             # Start daemon for remote testing
npx terminfo.dev test --all              # Unavailable: refuses multi-daemon collection
npx terminfo.dev submit --help            # Read the user CLI's submission options
npx terminfo.dev detect                   # Detect terminal
```

#### All-context convenience scripts

```bash
bun probe:termless            # = bun admin probe termless --all
bun probe:apps                # = bun admin probe app --all
bun probe:server              # = bun admin probe server --all
bun probe:mux                 # = bun admin probe mux --all
```

### Route selection

Use the [collector routes and persistence](packages/probe-defs/README.md#collector-routes-and-persistence) contract and the route guide above.
Keep native identity, ownership, observer prerequisites, and private evidence distinct; a route name alone proves none of them.

### Collection and release maintenance

A changed probe uses explicit contexts and probe IDs; it does not require unrelated terminal runs.
Follow the author loop and selected-collection guidance, not the all-context convenience scripts, as the default entry.
The update scripts remain release-maintenance entry points, not additional author loops. A build, private output or Git push does not authorize publication.

`bun run build` regenerates `content/analysis.json` from probe data and fails if generation fails.
Do not commit that file.

`TERMINFO_SITE_OUT_DIR` roots every write of a build — the VitePress output, its cache and `content/analysis.json`
— under that one directory instead of the source tree, so `bun scripts/landed-serve.ts` (the `terminfo-site`
resident's command) can build from a read-only hab landing. Unset, every path is exactly as before.

Private headless collection reports its retained results and collector failures, not an editorial annotation check.
Private collection does not waive metadata validation.

## Data Flow

Collectors retain private evidence; default app, mux and server routes also place collected runs. See [collector routes and persistence](packages/probe-defs/README.md#collector-routes-and-persistence) for each route's behavior.

```
5 probe methods:
  packages/probes/collect-headless.ts ← termless: bun admin probe termless (Termless workers)
  packages/admin/src/app.ts          ← app:      bun admin probe app (owned terminal launch)
  packages/terminfo.dev/src/serve.ts                 ← server:   bun admin probe server (HTTP daemon)
  packages/admin/src/mux.ts          ← mux:      bun admin probe mux (multiplexer pass-through)
  packages/terminfo.dev/src/serve.ts                 ← here:     bun admin probe here (shared native collector)

  ↓ default app/mux/server collection places normalized runs; explicit output stays private

content/probes-apps/*.json         ← collected real terminal results
content/probes-mux/*.json          ← multiplexer pass-through results (mux)
content/probes-libs/*.json         ← headless backend results (termless)
  +
content/*.json                     ← editorial metadata (features, terminals, standards...)

  ↓ VitePress build

docs/data/probes.data.ts           ← merges all data into CensusData
  ↓
[id].paths.ts                      ← route generators (feature, terminal, compare...)
  ↓
[id].md                            ← Vue templates
  ↓
docs/.vitepress/dist/              ← 250+ static HTML pages + sitemap.xml
```

## Page Types (all generated at build time)

| Type            | URL Pattern           | Count | Generator                  |
| --------------- | --------------------- | ----- | -------------------------- |
| Home matrix     | `/`                   | 1     | `index.md`                 |
| Feature detail  | `/{category}/{slug}`  | ~133  | `[category]/[id].paths.ts` |
| Terminal detail | `/terminals/{slug}`   | ~19   | `terminals/[id].paths.ts`  |
| Category        | `/{category}`         | ~13   | `[id].paths.ts`            |
| Standard/tag    | `/{tag}`              | ~10   | `[id].paths.ts`            |
| Comparison      | `/compare/{a}-vs-{b}` | ~66   | `compare/[id].paths.ts`    |
| API             | `/api`                | 1     | `api.md`                   |
| About           | `/about`              | 1     | `about.md`                 |

## Collecting changed probes

Use explicit context and probe IDs for the intended measurement; a probe change does not require unrelated terminal runs.
Keep the full catalogue and suite unchanged, and retain each attempt's selection before execution.
See [selected collection](docs/collect-selected-probes.md) for command inputs, empty outcomes and retained draft paths.
Collection and publication remain separate operations.

## Adding a New Terminal

1. Run authorized probes: `bun admin probe app <terminal-name>` (or add headless backend to Termless)
2. Add metadata to `content/terminals.json` (label, slug, description, body, url)
3. Add annotations to `content/annotations.json` for any failures that need explanation
4. Rebuild: `bun run build`

## Adding a New Feature

1. Add probe to `packages/probe-defs/src/<category>.ts` (unified — covers both lib and term)
2. Add metadata to `content/features.json` (name, slug, url, tags, body, probe, baseline)
3. Collect the intended contexts and probes (see "Collecting changed probes" above)
4. Add annotations for any unexpected failures
5. Rebuild: `bun run build` — the build validates tags against `standards.json`

### Catalog coverage

Coverage is derived by [derivedProbeStatus](docs/data/probe-status.ts), with reviewed catalog overrides.
See the [canonical declaration contract](packages/probe-defs/README.md#from-definition-to-recorded-result)
and [nullable declaration comments](packages/probe-defs/src/types.ts) for the distinction between measured, partial and undeclared coverage.

The catalog may declare a reviewed override for exactly two coverage values, each with a
`probeStatusReason`:

- `"partial"` — an automated path leaves part of the effect or another route unmeasured.
  Viewport hold measures the library arm while retaining the manual app UI recipe.
- `"manual"` — support data comes from docs or manual testing and no automated measurement exists
  (the nine `device.env-*` rows).

An `"automated"` or `"unprobed"` override is not honoured; those derive from the definitions, so
they cannot drift. `bun run validate` refuses any other override value, or an override with no
reason.

For `"manual"` and `"unprobed"` features, set the `probe` field to
`"Manual verification required — no automated probe available."`
Viewport hold's library arm measures ordinary and synchronized output with qualified viewport controls.
Its app arm names the missing actuator/readback and stays PROBE TODO; registration supplies no app support measurement.
See the canonical declaration contract above.

For UI-owned viewport behavior, prefer `"manual"` plus an exact reproduction
recipe over a fake automated probe. Examples: whether output while the user is
scrolled up yanks the viewport to the live bottom, whether a scrollbar appears,
or whether a copy/search UI opens. App-side PTY probes can observe parser output,
cursor position, cell state, and query responses; they cannot observe the user's
scrollback viewport unless a terminal exposes a separate automation API.

### Valid Tags

Tags in `features.json` **must** match keys in `standards.json` or `categories.json`. Using an
unknown tag silently creates a broken page. The build warns on unknown tags.

**Standards (from `standards.json`):** `ecma-48`, `vt100`, `vt220`, `vt510`, `dec-private-modes`,
`xterm-extensions`, `kitty-extensions`, `osc`, `sixel`, `unicode`, `iterm2`, `conemu`,
`vscode-extensions`

**Categories (from `categories.json`):** `sgr`, `cursor`, `text`, `erase`, `editing`, `modes`,
`scrollback`, `reset`, `extensions`, `charsets`, `device`, `input`, `unicode`

A feature can have multiple tags (e.g. `["osc", "xterm-extensions"]`). OSC features **must**
include the `"osc"` tag in addition to any vendor tag.

### Probe Quality Rules

[The canonical callback contract](packages/probe-defs/README.md#from-definition-to-recorded-result) permits measured, coverage and execution-only results.
Support claims require retained observations and deciding assertions; legacy `pass` is diagnostic only. Useful lib observation strategies:

| Strategy             | When to use                 | Example                                       |
| -------------------- | --------------------------- | --------------------------------------------- |
| `ctx.getCell()`      | SGR attributes, text output | Check cell has `bold === true`                |
| `ctx.getCursor()`    | Cursor movement, position   | Check cursor at expected row/col              |
| `ctx.getMode()`      | DEC private modes           | Check `getMode("mouseTracking")` after enable |
| `ctx.feedCapture()`  | Query-response protocols    | Check response matches expected pattern       |
| `ctx.capabilities.*` | Declared term features      | Check `capabilities.kittyKeyboard`            |
| `ctx.getTitle()`     | OSC title sequences         | Check title changed                           |

Execution-only refusals retain PROBE TODO or PROBE INVALID tests with reasons, without inventing a measured observation.

## Content Enrichment

Content files support optional enrichment fields (pages render them when present):

- **features.json**: `history`, `pitfalls[]`, `relatedFeatures[]`, `examples[]`, `aliases[]`
- **terminals.json**: `history`, `founded`, `language`, `license`, `renderer`, `pitfalls[]`
- **standards.json**: `history`, `yearPublished`, `organization`, `parent`, `children[]`
- **categories.json**: `history`, `seeAlso[]`

## SEO

- Sitemap auto-generated by VitePress at `/sitemap.xml`
- Dynamic meta tags per page via `config.ts` `transformPageData()`
- CSS tooltips on all result cells via shared `theme/tooltip.css`
- Comparison pages use alphabetical slug ordering for deterministic URLs
- All 250+ pages are statically rendered (no client-side data fetching)
