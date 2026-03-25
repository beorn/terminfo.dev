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
  probes-mux/                     measured: multiplexer results (future)

packages/                       ← source code (internal tools)
  probes/                         probe test files (*.probe.ts, setup.ts, vitest.config.ts)
  cli/
    src/                          unified CLI (bun terminfo) — all 4 probe mechanisms
      index.ts                    entry point: probe {termless,server,app,here}, report, status, submit, detect
      termless.ts                 headless library probes (Vitest + Termless)
      server.ts                   daemon probe mechanism (start/list/probe daemons)
      app.ts                      macOS app probes (AppleScript)
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

cli/                            ← npm-publishable CLI (npx terminfo.dev)
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
  terminal/[id].md                terminal detail pages
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
`content/probes-mux/` — multiplexer results (future)

Each file: `{ backend, version, results: { featureId: boolean }, notes, probeHash, generated }`

### Curated: Editorial Content

`content/` — JSON files that humans and AI edit:

| File               | What                                                        | Entries |
| ------------------ | ----------------------------------------------------------- | ------- |
| `features.json`    | Feature metadata: name, slug, tags, body, probe, baseline   | ~133    |
| `terminals.json`   | Terminal app metadata: label, slug, description, body, url  | ~11     |
| `standards.json`   | Standard/tag metadata: label, url, description              | ~10     |
| `categories.json`  | Category metadata: label, order, description                | ~13     |
| `annotations.json` | Result overrides: backend:feature notes explaining failures | ~88     |

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
bun run build               # Build static site (250+ pages)
bun run preview             # Preview built site
```

### Unified CLI (`bun terminfo`)

Pattern: bare = list/help, `--all` = run all, `<name>` = run specific.

```bash
bun terminfo                              # Show help
bun terminfo probe                        # List 4 probe mechanisms
```

#### Probe Methods (4 mechanisms)

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

# 4. Inline probes (probe this terminal directly)
bun terminfo probe here                   # Probe this terminal
bun terminfo probe here --json            # Machine-readable output
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

Same command tree but limited to inline/daemon probes:

```bash
npx terminfo.dev                          # Show help
npx terminfo.dev probe here               # Probe this terminal
npx terminfo.dev probe server --start     # Start daemon
npx terminfo.dev probe server --all       # Probe all daemons
npx terminfo.dev submit                   # Probe + submit
npx terminfo.dev detect                   # Detect terminal
```

#### Convenience scripts

```bash
bun probe:termless            # = bun terminfo probe termless --all
bun probe:apps                # = bun terminfo probe app --all
bun probe:server              # = bun terminfo probe server --all
```

### When to use which probe method

- **Headless** (`probe termless`): Testing library parsers. Fast, automated, CI-friendly.
- **App launch** (`probe app`): Testing real macOS terminals. Requires Accessibility permission for AppleScript. Doesn't work for all terminals (Warp, some Electron apps).
- **Daemon** (`probe server`): Testing ANY terminal. Run `--start` in the target terminal, then `--all` from another session. Works for Warp, SSH sessions, Linux, anything with a TTY. **Most flexible method.**
- **Inline** (`probe here`): Quick test of the current terminal. Good for one-off checks.
- **Manual**: For terminals where none of the above work, run `terminfo detect` and submit results.

## Data Flow

```
4 probe methods:
  packages/probes/*.probe.ts       ← termless: bun terminfo probe termless (Vitest + Termless)
  packages/cli/app-runner.ts       ← app:      bun terminfo probe app (AppleScript)
  cli/src/serve.ts                 ← server:   bun terminfo probe server (HTTP daemon)
  cli/src/probes/                  ← here:     bun terminfo probe here (inline TTY)

  ↓ results saved to

content/probes-apps/*.json         ← real terminal results (app + server + here)
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
| Terminal detail | `/terminal/{slug}`    | ~19   | `terminal/[id].paths.ts`   |
| Category        | `/{category}`         | ~13   | `[id].paths.ts`            |
| Standard/tag    | `/{tag}`              | ~10   | `[id].paths.ts`            |
| Comparison      | `/compare/{a}-vs-{b}` | ~66   | `compare/[id].paths.ts`    |
| API             | `/api`                | 1     | `api.md`                   |
| About           | `/about`              | 1     | `about.md`                 |

## Adding a New Terminal

1. Run probes: `bun terminfo probe app --all <terminal-name>` (or add headless backend to Termless)
2. Add metadata to `content/terminals.json` (label, slug, description, body, url)
3. Add annotations to `content/annotations.json` for any failures that need explanation
4. Rebuild: `bun run build`

## Adding a New Feature

1. Add probe to `packages/probes/<category>.probe.ts`
2. Add metadata to `content/features.json` (name, slug, url, tags, body, probe, baseline)
3. Run probes: `bun terminfo probe termless --all --force`
4. Add annotations for any unexpected failures
5. Rebuild: `bun run build`

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
