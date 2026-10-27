# terminfo.dev

**"caniuse.com for terminal emulators"** — feature support tables powered by automated testing.

Live at [terminfo.dev](https://terminfo.dev). Deployed to Cloudflare Pages.

## Stack

TypeScript, Bun, VitePress, Termless (headless terminal testing), Vitest.

## Before working on probes

Read the [current probe-system model](packages/probe-defs/README.md) before changing definitions, collectors, evidence or status mapping.
Update it in the same change when those contracts change.
Its [vocabulary and current code](packages/probe-defs/README.md#vocabulary-and-current-code) section maps the approved probe terms to existing identifiers and distinguishes future refactoring.

## Directory Structure

```
content/                        ← ALL input data
  features.json                   feature metadata (name, slug, tags, body, probe)
  terminals.json                  terminal app metadata (label, description, body)
  standards.json                  standard/tag metadata (label, url, description)
  categories.json                 category metadata (label, order, description)
  annotations.json                result overrides (backend:feature notes)
  probes-apps/                    measured: real terminal results
  probes-libs/                    measured: headless backend results
  probes-mux/                     measured: multiplexer pass-through results

packages/                       ← source code (internal tools)
  probe-defs/                      @terminfo/probe-defs: pure probe definitions + shared types
  probes/                         @terminfo/probes: private headless collector + diagnostic Vitest runner
  admin/                          @terminfo/admin: dev/orchestration CLI (bun terminfo)
    src/                          unified CLI (bun terminfo) — all 4 probe mechanisms
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
`./package.json` entry in `exports`. km's root workspace also includes
`vendor/terminfo.dev/packages/*` so local repo commands resolve the same graph.

## Data Architecture

Three data layers with clean separation:

```
MEASURED    content/probes-apps/  ← app probe results (don't edit by hand)
            content/probes-libs/  ← headless probe results (don't edit by hand)
CURATED     content/*.json        ← editorial JSON (AI + human editable)
DERIVED     docs/data/*.ts        ← computed at build time from above two
```

### Measured: Probe Results

`content/probes-apps/` — real terminal app results (from `bun terminfo probe app --all`)
`content/probes-libs/` — headless backend results (from `bun terminfo probe termless --all`)
`content/probes-mux/` — multiplexer pass-through results (from `bun terminfo probe mux --all`)

Each file: `{ backend, version, results: { featureId: boolean }, notes, probeHash, generated }`

### One suite per collection (cut one commit, collect every subject configuration there)

A merge that touches the collector sources changes the probe suite id, so a run collected before that
merge cannot be admitted (30286). A collection therefore starts at ONE commit, never at whatever `main`
reads on the day:

1. **Cut.** Choose one terminfo commit and put a branch on it.
2. **Collect every subject configuration at that commit.** Local Linux runs in a worktree at it; macOS and Windows
   dispatch their workflows at the same branch —
   `gh workflow run macos-measurement.yml --ref <branch>` and
   `gh workflow run windows-measurement.yml --ref <branch>`. Both check out the dispatched ref
   (`actions/checkout@v4`, no `ref` override), so every subject configuration measures one suite.
3. **Admit on that branch and merge it through Yrd** (next section), then move the release pointer onto
   that suite: `bun scripts/suite-manifest.ts --freeze <release>` while the tree is still at the cut, or
   later from `main` naming the admitted suite,
   `bun scripts/suite-manifest.ts --move <release> --suite <id>`.
4. **Probe changes merged after the cut wait for the next cut.** They are not back-ported into a
   collection already in flight. When to cut is the release owner's call with `@chief`.

A suite named by `--suite` is read from its own registry record and never compared with the live
collector, which is what lets a pointer move onto an older admitted suite from a newer `main`; the id
must be twelve lowercase hex and an existing manifest must carry it. A pointer never claims a suite that
has no admitted run.

### Admitting a run (the one suite-manifest writer)

A schema-v2 run cites the executable suite (`probeHash`) that produced it, and the parser refuses a run
whose suite has no trusted declaration in `content/suites/<probeHash>.json`. The declaration is a
DERIVED record — `{ probeHash, adapterVersion, probes }`, a pure function of the suite sources — and it
is written at admission, never by hand and never by a standalone verb:

```bash
bun scripts/admit-run.ts --for <collected-run.json> [--into <path>]
```

- Required resources: a Git checkout on a named branch that is not the default — a fresh branch cut at
  `origin/main` authors, and so does one already ahead of it — the run file, and a tree whose live suite
  equals the run's `probeHash`. The discriminator is the branch, never commit ancestry: the commit the
  declaration lands on is the one the act itself creates.
- Refusals are loud and named: a foreign suite refuses with "Admit from a tree at the run's suite"; a
  checkout on the default branch (`main`, or whatever `refs/remotes/origin/HEAD` names) or on a detached
  HEAD refuses and names `git switch -c task/<name> origin/main`; a partial or malformed run refuses.
- Concurrent admission of the same run is success when the bytes match; different bytes at the same
  name refuse. Commit the run and its manifest together.

`bun scripts/suite-manifest.ts --check` (in `bun run validate`) is the composed-tree gate: it requires a
declaration for every run that CITES a suite, and does not require the tree's own suite to be declared,
so a non-fast-forward compose of two adapter branches is green. The declared manifest is verified
against the live snapshot when this tree's suite is declared.

### Curated: Editorial Content

`content/` — JSON files that humans and AI edit:

| File               | What                                                        | Entries |
| ------------------ | ----------------------------------------------------------- | ------- |
| `features.json`    | Feature metadata: name, slug, tags, body, probe, baseline   | ~133    |
| `terminals.json`   | Terminal app metadata: label, slug, description, body, url  | ~11     |
| `standards.json`   | Standard/tag metadata: label, url, description              | ~10     |
| `categories.json`  | Category metadata: label, order, description                | ~13     |
| `annotations.json` | Result overrides: backend:feature notes explaining failures | ~88     |
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

# Periodic refresh (see /terminfo-update skill)
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

### Unified CLI (`bun terminfo`)

Pattern: bare = list/help, `--all` = run all, `<name>` = run specific.

```bash
bun terminfo                              # Show help
bun terminfo probe                        # List 4 probe mechanisms
```

#### Probe Methods (5 mechanisms)

```bash
# 1. Headless library collection (Termless backends, isolated workers)
bun terminfo probe termless               # List available backends
bun terminfo probe termless --all         # Probe all backends
bun terminfo probe termless --force       # Re-run cached
bun terminfo probe termless xtermjs       # Probe specific backend
bun terminfo probe termless xtermjs/*     # All versions of a backend

# 2. Daemon probes (run inside ANY terminal — most flexible)
bun terminfo probe server                 # List running daemons
bun terminfo probe server --start         # Start daemon in this terminal
bun terminfo probe server --start -p 3456 # Specific port
bun terminfo probe server --all           # Probe all running daemons
bun terminfo probe server ghostty         # Probe specific daemon

# 3. App launch probes (AppleScript opens macOS terminal apps)
bun terminfo probe app                    # List installed terminals
bun terminfo probe app --all              # Probe all installed terminals
bun terminfo probe app ghostty            # Probe specific terminal

# 4. Multiplexer probes (test pass-through of tmux, screen, etc.)
bun terminfo probe mux                    # List installed multiplexers
bun terminfo probe mux --all              # Probe through all multiplexers
bun terminfo probe mux tmux              # Probe through tmux specifically

# 5. Inline probes (probe this terminal directly)
bun terminfo probe here                   # Probe this terminal
bun terminfo probe here --json            # Machine-readable output
```

#### Analysis

```bash
bun analysis                              # Write derived content/analysis.json (also the first step of bun run build)
bun analysis:validate                     # Compare a local analysis.json against regenerated canonical values
bun analysis --dry-run                    # Preview without writing
```

#### Reporting & Utilities

```bash
bun terminfo report                       # Show saved results
bun terminfo status                       # Config, cache, backends
bun terminfo detect                       # Detect current terminal
bun terminfo detect --json                # Machine output
bun terminfo submit                       # Probe + submit to terminfo.dev
```

#### npm CLI (`npx terminfo.dev`)

```bash
npx terminfo.dev                          # Show help
npx terminfo.dev test                     # Test this terminal
npx terminfo.dev test --json              # Machine output
npx terminfo.dev test --serve             # Start daemon for remote testing
npx terminfo.dev test --all              # Test all serving terminals
npx terminfo.dev submit                   # Test + submit to terminfo.dev
npx terminfo.dev detect                   # Detect terminal
```

#### Convenience scripts

```bash
bun probe:termless            # = bun terminfo probe termless --all
bun probe:apps                # = bun terminfo probe app --all
bun probe:server              # = bun terminfo probe server --all
bun probe:mux                 # = bun terminfo probe mux --all
```

### When to use which probe method

- **Headless** (`probe termless`): Testing library parsers. Fast, automated, CI-friendly.
- **App launch** (`probe app`): Testing real macOS terminals. Requires Accessibility permission for AppleScript. Doesn't work for all terminals (Warp, some Electron apps).
- **Daemon** (`probe server`): Testing ANY terminal. Run `--start` in the probe subject's terminal, then `--all` from another session.
  Works for Warp, SSH sessions, Linux, anything with a TTY. **Most flexible method.**
- **Mux** (`probe mux`): Testing multiplexer pass-through (tmux, screen). Launches the mux with a daemon inside, probes via HTTP, saves to `content/probes-mux/`. Shows which features each mux correctly relays vs. strips.
- **Inline** (`probe here`): Quick test of the current terminal. Good for one-off tests.
- **Manual**: For terminals where none of the above work, run `terminfo detect` and submit results.

### Full Update Workflow

When probe data changes (new terminals, new features, updated results):

```bash
bun terminfo probe termless --all        # 1. Run headless probes
bun terminfo probe app --all             # 2. Run app probes (or probe server --all)
bun terminfo probe mux --all             # 3. Run multiplexer probes
bun run build                            # 4. Generate analysis.json, then build site + emit API/badges into ignored docs/.vitepress/dist/
git add -A && git commit && git push     # 5. Deploy
```

`bun run build` regenerates `content/analysis.json` from probe data and fails if generation fails.
Do not commit that file.

`TERMINFO_SITE_OUT_DIR` roots every write of a build — the VitePress output, its cache and `content/analysis.json`
— under that one directory instead of the source tree, so `bun scripts/landed-serve.ts` (the `terminfo-site`
resident's command) can build from a read-only hab landing. Unset, every path is exactly as before.

**Annotations are required for failures.** If probes produce new failures, `bun terminfo probe`
will exit with an error listing unannotated failures. Add explanations to
`content/annotations.json` before the data is usable.

## Data Flow

Collectors retain private evidence first; admission is separate. See [collector routes and persistence](packages/probe-defs/README.md#collector-routes-and-persistence) for each route's behavior.

```
5 probe methods:
  packages/probes/collect-headless.ts ← termless: bun terminfo probe termless (Termless workers)
  packages/admin/src/app.ts          ← app:      bun terminfo probe app (owned terminal launch)
  packages/terminfo.dev/src/serve.ts                 ← server:   bun terminfo probe server (HTTP daemon)
  packages/admin/src/mux.ts          ← mux:      bun terminfo probe mux (multiplexer pass-through)
  packages/terminfo.dev/src/serve.ts                 ← here:     bun terminfo probe here (shared native collector)

  ↓ private collection, then separate admission where requested

content/probes-apps/*.json         ← admitted real terminal results
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

## Re-Probing All Terminals

After adding features or updating probes, re-probe everything to keep results at parity:

```bash
# 1. Headless backends (automated, fast, all backends in one run)
cd /Users/beorn/Code/pim/km/vendor/terminfo.dev
bunx --bun vitest run --config packages/probes/vitest.config.ts
# Then update result files from vitest JSON output

# 2. Real terminal apps (three categories)

# Apps that can be auto-launched via AppleScript (Ghostty, iTerm2, Kitty, Terminal.app):
bun terminfo probe app --all --force
# These launch in hidden mode — apps briefly appear then hide.
# DO NOT close terminal windows that appear — they're running the daemon.

# Apps that need manual daemon start (Warp, VS Code, Cursor):
# User must run `bun terminfo probe server --start` in each terminal,
# then from here: `bun terminfo probe server --all`

# 3. Refresh tracked public API snapshots, then build the deploy artifact
bun scripts/generate-api.ts
bun run build
```

**IMPORTANT**: Always re-probe ALL terminals when features change — partial updates leave terminals at different feature counts (e.g., 129 vs 134), which looks broken on the site.

## Adding a New Terminal

1. Run probes: `bun terminfo probe app <terminal-name>` (or add headless backend to Termless)
2. Add metadata to `content/terminals.json` (label, slug, description, body, url)
3. Add annotations to `content/annotations.json` for any failures that need explanation
4. Rebuild: `bun run build`

## Adding a New Feature

1. Add probe to `packages/probe-defs/src/<category>.ts` (unified — covers both lib and term)
2. Add metadata to `content/features.json` (name, slug, url, tags, body, probe, baseline)
3. Re-probe all terminals (see "Re-Probing All Terminals" above)
4. Add annotations for any unexpected failures
5. Rebuild: `bun run build` — the build validates tags against `standards.json`

### Probe Status

Coverage is derived by [derivedProbeStatus](docs/data/probe-status.ts), with reviewed catalog overrides.
See the [canonical declaration contract](packages/probe-defs/README.md#from-definition-to-recorded-result)
and [nullable declaration comments](packages/probe-defs/src/types.ts) for the distinction between measured, partial and undeclared coverage.

The catalog may declare a reviewed override for exactly two statuses, each with a
`probeStatusReason`:

- `"partial"` — the definition establishes acceptance only (an execution-only pending test): we can tell the
  sequence was accepted, not that its effect happened. Examples: the SGR colour resets, OSC 8 and
  the OSC 133 / OSC 633 prompt marks.
- `"manual"` — support data comes from docs or manual testing and no automatable probe exists
  (the nine `device.env-*` rows and `scrollback.viewport-hold-output`).

An `"automated"` or `"unprobed"` override is not honoured; those derive from the definitions, so
they cannot drift. `bun run validate` refuses any other override value, or an override with no
reason.

For `"manual"` and `"unprobed"` features, set the `probe` field to
`"Manual verification required — no automated probe available."` and don't add a
matching entry in `packages/probe-defs/`.

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

Execution-only refusals retain TODO or FAILURE tests with reasons, without inventing a measured observation.

## Content Enrichment

Content files support optional enrichment fields (pages render them when present):

- **features.json**: `history`, `pitfalls[]`, `relatedFeatures[]`, `examples[]`, `aliases[]`
- **terminals.json**: `history`, `founded`, `language`, `license`, `renderer`, `pitfalls[]`
- **standards.json**: `history`, `yearPublished`, `organization`, `parent`, `children[]`
- **categories.json**: `history`, `seeAlso[]`

Use `/marketing enrich` in km to AI-generate enrichment content for review.

## SEO

- Sitemap auto-generated by VitePress at `/sitemap.xml`
- Dynamic meta tags per page via `config.ts` `transformPageData()`
- CSS tooltips on all result cells via shared `theme/tooltip.css`
- Comparison pages use alphabetical slug ordering for deterministic URLs
- All 250+ pages are statically rendered (no client-side data fetching)

## Issue Tracking

Beads under `@km/13056-terminfo` epic in the km repo.
