# terminfo.dev

[terminfo.dev](https://terminfo.dev) records what particular terminal implementations did under particular tests. Its feature descriptions, protocol references and measurements answer different questions. A reply to a cursor query, for example, cannot establish that truecolor text rendered correctly.

Run `npx terminfo.dev test` to inspect your terminal. The [contribution guide](docs/contribute.md) explains the methods, limits and submission flow. The published npm CLI and website may use older probe suites than this checkout; record the CLI version and suite identity with a result.

## Which things are measured?

| Kind                                       | Place and measurement rule                                                                                                                                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Terminal emulator application              | An identified app, version, OS and configuration can have an app run in [`content/probes-apps/`](content/probes-apps/). Query results, pixels and interaction observations remain distinct.                                  |
| Headless emulator engine or library        | [Termless](https://termless.dev) exposes parser state for [`content/probes-libs/`](content/probes-libs/). Name the actual engine and adapter version. This does not establish the desktop app's rendering or input behavior. |
| Multiplexer                                | A run through tmux or Screen belongs in [`content/probes-mux/`](content/probes-mux/) with its outer terminal and passthrough configuration. It measures the combined path.                                                   |
| Terminal consumer, CLI or TUI application  | It uses an outer terminal; running a terminal probe inside it ordinarily measures that outer terminal. Document relevant requirements or examples here without inventing a terminal result.                                  |
| Historical hardware terminal               | A reference entry in [`content/terminals.json`](content/terminals.json) may set `historical: true`. A manual or archival description is not a present-day automated run.                                                     |
| Specification, vendor document or proposal | A source in [`scripts/sitefile.ts`](scripts/sitefile.ts) can define a sequence or document vendor behavior. It is not a measured support result for every version or platform.                                               |
| Release feed                               | A dated candidate version can guide a refresh; it does not change an engine pin or generate a support result by itself. See [`scripts/watch-releases.ts`](scripts/watch-releases.ts).                                        |

**Non-target examples:** [Carbonyl](https://github.com/fathyb/carbonyl) and [Browsh](https://github.com/browsh-org/browsh) are browsers that render into an existing terminal. Keep future examples in this section as terminal consumers, with a source and the outer-terminal boundary. Do not add them to the terminal probe matrix or create result files for them. A consumer-specific compatibility test would need its own stated target and evidence.

## Who owns each artifact?

| Layer     | Owner and rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Measured  | [`content/probes-apps/`](content/probes-apps/), [`content/probes-libs/`](content/probes-libs/) and [`content/probes-mux/`](content/probes-mux/) hold collected history. Preserve originals. A reviewed correction changes interpretation with a reason and evidence; it does not silently rewrite the run. Missing feature IDs mean not tested.                                                                                                                                                                 |
| Curated   | [`content/features.json`](content/features.json), [`content/terminals.json`](content/terminals.json), [`content/standards.json`](content/standards.json), [`content/platforms.json`](content/platforms.json), [`content/annotations.json`](content/annotations.json) and related metadata are edited with source review. A source URL describes a claim; it does not fill a missing measurement.                                                                                                                |
| Generated | [`docs/data/`](docs/data/) projects selected results into the site. [`scripts/generate-api.ts`](scripts/generate-api.ts) emits API data and badges; the VitePress build writes fresh deploy copies into `docs/.vitepress/dist/`. [`content/analysis.json`](content/analysis.json) is a checked-in generated snapshot, not fresh evidence; regenerate and validate it when selected data changes. [`scripts/sitefile.lock.json`](scripts/sitefile.lock.json) is generated inventory, not a source-check receipt. |

The shared selection logic lives in [`docs/data/selected-results.ts`](docs/data/selected-results.ts) and [`docs/data/current-results.ts`](docs/data/current-results.ts). Site, API and analysis must select the same identified run and preserve its method, context and coverage. Historical boolean results without raw evidence remain historical; a rebuild cannot upgrade them into verified observations. The [site methodology](docs/contribute.md#reading-results) explains supported, unsupported, inconclusive, collection error and not tested.

## Content and freshness standard

- A feature needs a clear name, unique category slug, valid tags, an accurate protocol description and a probe description that says what is actually observed. Distinguish protocol definition, a vendor claim and an observed app or parser result. Do not label an ignored sequence as supported because later input still works.
- A terminal page needs an identified product or engine, version, platform, useful description and sources for material claims. Keep app, library, multiplexer and historical identities separate. Explain exclusions and unknowns rather than supplying guessed failures or a universal support score.
- Prefer primary specifications and vendor documentation for protocol behavior; identify proposal status and version cutoffs. Review third-party adoption claims separately. The source types and intended check intervals are listed in [`scripts/sitefile.ts`](scripts/sitefile.ts); release selection uses a dated stable-release cutoff. A source's age is a review prompt, not proof that its claims changed.
- Freshness belongs to the measurement and source review, not the page build time. Retain measured-at time, exact probe suite and executable identity; compare a new run with its predecessor before selecting it. An API or site rebuild is not a new test.

## Checks that exist today

[`scripts/validate.ts`](scripts/validate.ts) exits nonzero for structural errors such as unknown tags, duplicate slugs and names, missing terminal bodies, invalid platform references and malformed identity. It **warns** about missing or brief feature bodies (the current target is 260 characters), missing probe descriptions, orphaned annotations and terminals without data; warning-free content still needs factual review. [`scripts/sitefile.ts`](scripts/sitefile.ts) lists specs, vendor docs, proposals, release feeds and freshness intervals. Its `--check` currently reports stale probe files but does not fail on staleness, and running it rewrites the lockfile; it does not verify upstream source freshness.

The package scripts run the relevant local checks:

```bash
bun run validate                  # structural validation + trusted suite-manifest check
bun run build                     # trusted suite-manifest check + VitePress site/API build
bun run analysis:validate         # check generated commentary against selected data
bun scripts/check-404s.ts         # built-site internal links
bun scripts/check-private-leak.ts # built-site private-content scan
```

[`deploy.yml`](.github/workflows/deploy.yml) uses a frozen install, validation, tests, build, private-content scan and 404 check, then deploys the same hashed archive it validated. [`validate.yml`](.github/workflows/validate.yml) runs weekly and on `main`; its content warnings are reported separately from errors. [`format-check.yml`](.github/workflows/format-check.yml) checks formatter idempotence. [`links.yml`](.github/workflows/links.yml) checks Markdown links. The repository's [agent guide](CLAUDE.md) describes authoring paths, but current command behavior and these gates govern claims about enforcement. A clean build verifies the artifact's construction, not the truth of every feature description or historic measurement.
