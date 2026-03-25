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
  cli/                            census CLI — headless + app probes (run, apps, report, status)
  api/                            API + badge generation (future)

cli/                            ← npm-publishable CLI (npx terminfo.dev)
  src/
    index.ts                      entry point: serve, test-all, detect, submit
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

`content/probes-apps/` — real terminal app results (from `bun census:apps`)
`content/probes-libs/` — headless backend results (from `bun census:run`)
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

### Probe Methods (4 ways to gather terminal data)

```bash
# 1. Headless library probes (Vitest + Termless backends, in-process)
bun census:run              # Run all, cached
bun census:run --force      # Re-run all
bun census:run xtermjs/*    # Specific backend, all versions

# 2. App launch probes (AppleScript opens macOS terminal apps)
bun census:apps             # Test all installed terminals
bun census:apps ghostty     # Specific terminal
bun census:apps --list      # Show available

# 3. Serve daemon (run inside ANY terminal — most flexible)
npx terminfo.dev serve      # Start daemon in current terminal
npx terminfo.dev serve -p 3456  # Specific port

# 4. Test all running daemons (probes every terminal running 'serve')
npx terminfo.dev test-all   # Discover + probe all daemons
```

### Reporting & Utilities

```bash
bun census:report           # Show saved results
bun census:status           # Config, backends, cache info
npx terminfo.dev detect     # Detect current terminal capabilities
npx terminfo.dev submit     # Submit results to terminfo.dev
```

### When to use which probe method

- **Headless** (`census:run`): Testing library parsers. Fast, automated, CI-friendly.
- **App launch** (`census:apps`): Testing real macOS terminals. Requires Accessibility permission for AppleScript. Doesn't work for all terminals (Warp, some Electron apps).
- **Serve** (`serve` + `test-all`): Testing ANY terminal. User runs `serve` in the target terminal, then `test-all` from another session probes it. Works for Warp, SSH sessions, Linux, anything with a TTY. **Most flexible method.**
- **Manual**: For terminals where none of the above work, run `npx terminfo.dev detect` and submit results.

## Data Flow

```
4 probe methods:
  packages/probes/*.probe.ts    ← headless: bun census:run (Vitest + Termless)
  packages/cli/app-runner.ts    ← app launch: bun census:apps (AppleScript)
  cli/src/serve.ts              ← daemon: npx terminfo.dev serve (HTTP in terminal)
  cli/src/detect.ts             ← manual: npx terminfo.dev detect (standalone)

  ↓ results saved to

content/probes-apps/*.json      ← real terminal results
content/probes-libs/*.json      ← headless backend results
  +
content/*.json                  ← editorial metadata (features, terminals, standards...)

  ↓ VitePress build

docs/data/probes.data.ts        ← merges all data into CensusData
  ↓
[id].paths.ts                   ← route generators (feature, terminal, compare...)
  ↓
[id].md                         ← Vue templates
  ↓
docs/.vitepress/dist/           ← 250+ static HTML pages + sitemap.xml
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

1. Run census: `bun census:apps <terminal-name>` (or add headless backend to Termless)
2. Add metadata to `content/terminals.json` (label, slug, description, body, url)
3. Add annotations to `content/annotations.json` for any failures that need explanation
4. Rebuild: `bun run build`

## Adding a New Feature

1. Add probe to `packages/probes/<category>.probe.ts`
2. Add metadata to `content/features.json` (name, slug, url, tags, body, probe, baseline)
3. Run census: `bun census:run --force`
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
