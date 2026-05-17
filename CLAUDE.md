# terminfo.dev

**"caniuse.com for terminal emulators"** — feature support tables powered by automated testing.

Live at [terminfo.dev](https://terminfo.dev). Deployed to Cloudflare Pages.

## Stack

TypeScript, Bun, VitePress, Termless (headless terminal testing), Vitest.

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
  probes/                         probe test files (*.probe.ts, setup.ts, vitest.config.ts)
  cli/
    src/                          unified CLI (bun terminfo) — all 4 probe mechanisms
      index.ts                    entry point: probe {termless,server,app,here}, report, status, submit, detect
      termless.ts                 headless library probes (Vitest + Termless)
      server.ts                   daemon probe mechanism (start/list/probe daemons)
      app.ts                      macOS app probes (AppleScript)
      mux.ts                      multiplexer pass-through probes (tmux, screen)
      here.ts                     inline TTY probes
      detect.ts                   terminal detection
      submit.ts                   result submission
      report.ts                   report rendering
      status.ts                   config/cache status
    app-harness.ts                runs INSIDE launched terminals (not from CLI)
    app-runner.ts                 legacy app runner (superceded by src/app.ts)
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
    probes/                       probe implementations (run in real terminal context)
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
package.json                    scripts, dependencies
```

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

### Curated: Editorial Content

`content/` — JSON files that humans and AI edit:

| File               | What                                                              | Entries |
| ------------------ | ----------------------------------------------------------------- | ------- |
| `features.json`    | Feature metadata: name, slug, tags, body, probe, baseline         | ~133    |
| `terminals.json`   | Terminal app metadata: label, slug, description, body, url        | ~11     |
| `standards.json`   | Standard/tag metadata: label, url, description                    | ~10     |
| `categories.json`  | Category metadata: label, order, description                      | ~13     |
| `annotations.json` | Result overrides: backend:feature notes explaining failures       | ~88     |
| `baselines.json`   | Baseline tier metadata: label, emoji, color, description          | 4       |
| `analysis.json`    | AI-generated commentary per page (regenerate with `bun analysis`) | ~43     |

### Derived: Build-Time Computation

`docs/data/probes.data.ts` — reads measured + curated data, computes:

- Per-backend stats (total, yes, no, partial, %)
- Baseline compliance (core/modern/rich/unicode)
- Feature groupings by category and tag
- Backend metadata (merged from content/terminals.json + @termless/core manifest)

`docs/data/load-probes.ts` — shared helpers: slugs, labels, tag resolution.

## Commands

```bash
bun install                 # Install dependencies
bun run dev                 # Local dev server (VitePress)
bun run build               # Build static site (250+ pages) + emits API/badges into docs/.vitepress/dist/
bun run preview             # Preview built site

# Periodic refresh (see /terminfo-update skill)
bun run update --full       # Full refresh: discover → probe → validate → build
bun run update --status     # Check what's stale
bun run update --discover   # Run explore + show radar
bun run update --probe      # Re-probe headless backends
bun run update --validate   # Validate + build + check 404s
bun run watch-releases      # Check tracked terminals for new versions
bun run sync-probe-status   # Derive probeStatus from probe code

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
# 1. Headless library probes (Vitest + Termless backends, in-process)
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
bun analysis                              # Regenerate content/analysis.json from current probe data
bun analysis:validate                     # Validate existing analysis against current data
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

Also available via curl: `curl -sL terminfo.dev/test | sh`

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
- **Daemon** (`probe server`): Testing ANY terminal. Run `--start` in the target terminal, then `--all` from another session. Works for Warp, SSH sessions, Linux, anything with a TTY. **Most flexible method.**
- **Mux** (`probe mux`): Testing multiplexer pass-through (tmux, screen). Launches the mux with a daemon inside, probes via HTTP, saves to `content/probes-mux/`. Shows which features each mux correctly relays vs. strips.
- **Inline** (`probe here`): Quick test of the current terminal. Good for one-off checks.
- **Manual**: For terminals where none of the above work, run `terminfo detect` and submit results.

### Full Update Workflow

When probe data changes (new terminals, new features, updated results):

```bash
bun terminfo probe termless --all        # 1. Run headless probes
bun terminfo probe app --all             # 2. Run app probes (or probe server --all)
bun terminfo probe mux --all             # 3. Run multiplexer probes
bun analysis                             # 4. Regenerate analysis commentary
bun run build                            # 5. Build site + emit API/badges into ignored docs/.vitepress/dist/
git add -A && git commit && git push     # 6. Deploy
```

**Only run `bun analysis` when probe data changed.** It reads result files and generates
template-based commentary with real numbers. The build just uses whatever `analysis.json`
exists — it doesn't regenerate automatically.

**Annotations are required for failures.** If probes produce new failures, `bun terminfo probe`
will exit with an error listing unannotated failures. Add explanations to
`content/annotations.json` before the data is usable.

## Data Flow

```
5 probe methods:
  packages/probes/*.probe.ts       ← termless: bun terminfo probe termless (Vitest + Termless)
  packages/admin/app-runner.ts       ← app:      bun terminfo probe app (AppleScript)
  packages/terminfo.dev/src/serve.ts                 ← server:   bun terminfo probe server (HTTP daemon)
  packages/admin/src/mux.ts          ← mux:      bun terminfo probe mux (multiplexer pass-through)
  packages/terminfo.dev/src/probes/                  ← here:     bun terminfo probe here (inline TTY)

  ↓ results saved to

content/probes-apps/*.json         ← real terminal results (app + server + here)
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

1. Add probe to `packages/probe-defs/src/<category>.ts` (unified — covers both termless and term)
2. Add metadata to `content/features.json` (name, slug, url, tags, body, probe, baseline)
3. Re-probe all terminals (see "Re-Probing All Terminals" above)
4. Add annotations for any unexpected failures
5. Rebuild: `bun run build` — the build validates tags against `standards.json`

### Probe Status

Features can declare a `probeStatus` field describing how thoroughly they're verified.
Omit the field for normal automated probes — it defaults to `"automated"`. Set it only
for features that aren't fully verifiable:

- `"automated"` — fully probed by termless and/or real-terminal probes (default)
- `"partial"` — probe only checks acceptance (e.g., sequence consumed, cursor didn't
  advance), not the visual or behavioral result. Examples: OSC notifications, OSC 22
  pointer shape, OSC 9;4 progress — the terminal silently consumes the sequence, so we
  can tell it didn't crash but not whether anything actually happened.
- `"manual"` — support data was gathered by reading docs or manual testing; no
  automated probe runs for this feature.
- `"unprobed"` — feature is tracked on the site but has no verification at all yet.
  Use this for features that are fundamentally unprobeable from within a terminal
  session (text reflow on resize, font ligatures, user-initiated paste).

For `"manual"` and `"unprobed"` features, set the `probe` field to
`"Manual verification required — no automated probe available."` and don't add a
matching entry in `packages/probe-defs/`.

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

**Every termless callback MUST verify actual terminal state.** Never `return { pass: true }` without checking something. Use one of these verification strategies:

| Strategy             | When to use                 | Example                                       |
| -------------------- | --------------------------- | --------------------------------------------- |
| `ctx.getCell()`      | SGR attributes, text output | Check cell has `bold === true`                |
| `ctx.getCursor()`    | Cursor movement, position   | Check cursor at expected row/col              |
| `ctx.getMode()`      | DEC private modes           | Check `getMode("mouseTracking")` after enable |
| `ctx.feedCapture()`  | Query-response protocols    | Check response matches expected pattern       |
| `ctx.capabilities.*` | Declared capabilities       | Check `capabilities.kittyKeyboard`            |
| `ctx.getTitle()`     | OSC title sequences         | Check title changed                           |
| `null`               | Last resort only            | When NO verification is possible (rare)       |

If a termless callback returns `{ pass: true }` unconditionally, it's a false positive — every backend will pass regardless of whether it implements the feature.

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

Beads under `km-terminfo` epic in the km repo.
