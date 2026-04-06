# terminfo.dev Runbook

Two workflows: **Full Rebuild** (recreate from scratch) and **Periodic Refresh** (keep up-to-date).
Both end with validation and a retrospective.

## Periodic Refresh

Run monthly, or when upstream terminal releases happen.

### 1. Check for upstream changes

For each source, check if new features/sequences have been added:

| Source           | Check             | URL                                                     |
| ---------------- | ----------------- | ------------------------------------------------------- |
| xterm ctlseqs    | New patch number? | https://invisible-island.net/xterm/ctlseqs/ctlseqs.html |
| Kitty            | New release?      | https://github.com/kovidgoyal/kitty/releases            |
| Ghostty          | New release?      | https://github.com/ghostty-org/ghostty/releases         |
| iTerm2           | New release?      | https://iterm2.com/downloads.html                       |
| WezTerm          | New release?      | https://github.com/wez/wezterm/releases                 |
| foot             | New release?      | https://codeberg.org/dnkl/foot/releases                 |
| Windows Terminal | New release?      | https://github.com/microsoft/terminal/releases          |
| Alacritty        | New release?      | https://github.com/alacritty/alacritty/releases         |

### 2. Update terminal versions

```bash
# Update terminals.json with new version numbers
# Update versions.json if headless backends changed
```

### 3. Add new features (if upstream added sequences)

```bash
# 1. Add probe definition
#    packages/probe-defs/src/<category>.ts

# 2. Add feature metadata
#    content/features.json (name, slug, url, tags, body, probe, baseline)
#    Tags MUST match standards.json keys. OSC features MUST include "osc" tag.

# 3. Validate before probing
bun scripts/validate.ts
```

### 4. Re-probe all terminals

```bash
cd /Users/beorn/Code/pim/km/vendor/terminfo.dev

# Headless backends (automated, fast)
bun terminfo probe termless --all --force

# App probes — auto-launchable (Ghostty, iTerm2, Kitty, Terminal.app)
bun terminfo probe app --all --force

# App probes — manual daemon (Warp, VS Code, Cursor)
# In each terminal: bun terminfo probe server --start
# Then from here:
bun terminfo probe server --all

# Multiplexer pass-through (tmux, screen)
bun terminfo probe mux --all
```

**IMPORTANT**: Always probe ALL terminals — partial updates leave terminals at different
feature counts, which looks broken on the site.

### 5. Annotate new failures

If probes produce new failures, add explanations to `content/annotations.json`.
The probe command will exit with an error listing unannotated failures.

### 6. Regenerate derived content

```bash
bun analysis                    # Regenerate analysis.json commentary
bun scripts/generate-api.ts     # Regenerate API data + badges
```

### 7. Validate + build

```bash
bun scripts/validate.ts         # Check tag consistency, missing fields, etc.
bun run build                   # Build static site (250+ pages)
```

### 8. Deploy

```bash
git add -A && git commit -m "chore: periodic refresh — <terminals updated>, <features added>"
git push                        # Cloudflare Pages auto-deploys from main
```

### 9. Retrospective

After each refresh cycle:

- [ ] What new features/terminals were discovered?
- [ ] What was harder than expected?
- [ ] Were there sources not in this runbook?
- [ ] What validation checks should be added?
- [ ] Update this runbook with findings
- [ ] Update the tracking bead (km-d36pn) with current state + next gaps

## Full Rebuild

Recreate all content from scratch. Use when adding a major new feature category,
or to verify the site is complete against upstream specs.

### Phase 1: Audit feature coverage

For each protocol source, compare against features.json:

**Formal standards:**

- [ ] ECMA-48 / ISO 6429 — CSI sequences, SGR parameters
- [ ] DEC VT100/VT220/VT510 — cursor, modes, charsets, device queries

**De facto standards (xterm):**

- [ ] xterm ctlseqs — CSI, OSC, DEC private modes
- [ ] Current coverage: ~74 of ~203 xterm features

**OSC sources:**

- [ ] xterm (OSC 0-62, 104-119) — [/xterm-extensions](/xterm-extensions)
- [ ] ConEmu (OSC 9 subtypes) — [/conemu](/conemu)
- [ ] iTerm2 (OSC 1337 namespace) — [/iterm2](/iterm2)
- [ ] Kitty (OSC 21, 66, 99, 5522) — [/kitty-extensions](/kitty-extensions)
- [ ] VS Code (OSC 633) — [/vscode-extensions](/vscode-extensions)
- [ ] FinalTerm (OSC 133) — [/extensions/osc-133-semantic-prompts](/extensions/osc-133-semantic-prompts)
- [ ] rxvt-unicode (OSC 701-776, 777)
- [ ] mintty (OSC 440, 7700-series)
- [ ] foot (OSC 176, 555)
- [ ] VTE/GNOME (OSC 6, 666, 3008)
- [ ] Konsole (OSC 30/31)

**Terminal-specific extensions:**

- [ ] Kitty keyboard protocol (progressive enhancement flags)
- [ ] Kitty graphics protocol (transmit, display, animation, placeholders)
- [ ] Sixel graphics
- [ ] iTerm2 inline images
- [ ] Synchronized output (mode 2026)
- [ ] Color scheme reporting (mode 2031)

**Unicode:**

- [ ] UAX #11 East Asian Width
- [ ] Grapheme cluster boundaries
- [ ] Emoji presentation (VS16, ZWJ)

### Phase 2: Add missing features

For each gap found in Phase 1:

1. Write probe definition in `packages/probe-defs/src/<category>.ts`
2. Add feature metadata to `content/features.json`
3. Validate: `bun scripts/validate.ts`

### Phase 3: Audit terminal coverage

- [ ] List all major terminal emulators (check Wikipedia, GitHub stars, Homebrew installs)
- [ ] For each: is it in terminals.json? Does it have probe data?
- [ ] Add new terminals: metadata + probe data + annotations

### Phase 4: Audit content quality

For each feature:

- [ ] Has a body description (not empty)
- [ ] Has a probe description
- [ ] Has correct tags (including "osc" for OSC features)
- [ ] Has a spec URL where applicable
- [ ] Baseline tier is appropriate

For each standard/tag page:

- [ ] Has a description in standards.json
- [ ] Has a body with substantive content
- [ ] Links to spec URL

For each terminal page:

- [ ] Has description, body, URL in terminals.json
- [ ] Has probe data at the current version
- [ ] All failures are annotated

### Phase 5: Re-probe everything

Follow steps 4-6 from Periodic Refresh above.

### Phase 6: Validate + build + deploy

```bash
bun scripts/validate.ts
bun run build
git add -A && git commit -m "chore: full rebuild — <summary>"
git push
```

### Phase 7: Retrospective

Same as Periodic Refresh step 9, plus:

- [ ] How many features were added? (before → after count)
- [ ] How many terminals were added/updated?
- [ ] Coverage % vs each major source (xterm, Kitty, iTerm2)
- [ ] What categories have the biggest remaining gaps?
- [ ] Update tracking bead with findings
- [ ] Update this runbook with new sources discovered
- [ ] Schedule next full rebuild (quarterly recommended)

## Discovery Pipeline

Before you can update the site, you need to know what's changed in the terminal
ecosystem. The discovery pipeline watches upstream sources and surfaces new
features, terminals, and protocol changes automatically.

### Two kinds of discovery

1. **Targeted scraping** (`scripts/sitefile.ts --check`) — checks known sources
   declared in `sitefile.ts` against the lockfile, reports what's stale.

2. **Open-ended exploration** (`scripts/explore.ts`) — runs deep research
   queries against GPT-5.4 to find things we don't know we don't know: new
   terminals, new protocols, new proposals, community discussions.

### Running explore

```bash
bun run explore --list              # Show the 6 query templates
bun run explore --dry-run           # Preview queries without running
bun run explore --query <id>        # Run one query (~$0.03)
bun run explore                     # Run all 6 queries (~$0.20)
```

Query templates:

- `active-terminals` — survey of emulator projects and recent releases
- `new-protocols-2026` — new OSC/CSI/DCS sequences proposed/implemented
- `xterm-recent-changes` — xterm ctlseqs changelog since patch 400
- `spec-bodies` — terminal-wg, UAPI group, ECMA, Unicode proposals
- `ecosystem-articles` — influential terminal articles and discussions
- `vendor-changelogs` — recent releases of tracked terminals

**Recommended cadence:** monthly. Quarterly at minimum.

### Findings go to radar.jsonl

Every finding has:

- `id` — hash of title + first citation URL (dedup key)
- `type` — new-terminal / new-protocol / new-version / ecosystem-signal / deprecation / spec-change
- `title`, `description`
- `citations` — array of `{url, published, accessed, snippet}` — **every finding must have at least one citation**
- `discovered` — when we found it
- `discoverer` — which script/query found it

Append-only log at `content/radar.jsonl`. Dedup via hash — re-running the same
query won't duplicate findings.

### Triaging findings

```bash
bun run radar list                  # List all findings
bun run radar list --type new-protocol
bun run radar show <id>             # Show full citations
bun run radar dismiss <id> "reason" # Dismiss a finding
bun run radar stats                 # Summary counts
```

### Promoting findings to candidates

```bash
bun run candidates promote <radar-id>    # Convert finding → candidate
bun run candidates list                  # Show pending candidates
bun run candidates approve <feature-id>  # Approve for merge
bun run candidates reject <feature-id> "reason"
bun run candidates merge                 # Copy approved candidates → features.json
```

Candidates sit in `content/candidates.json` awaiting review. Approved ones get
merged into `features.json`, then you still need to:

1. Write the probe in `packages/probe-defs/src/<category>.ts`
2. Re-probe terminals
3. Add annotations for failures
4. Rebuild

### Weekly workflow

```bash
# 1. Check known sources for staleness
bun run sitefile --check

# 2. Discover new things (monthly)
bun run explore

# 3. Triage
bun run radar stats
bun run radar list --type new-protocol

# 4. Promote interesting findings
bun run candidates promote <id>

# 5. Review and approve candidates
bun run candidates list
bun run candidates approve <feature-id>

# 6. Merge approved into features.json
bun run candidates merge

# 7. Write probes for new features (manual)
# 8. Re-probe (see Periodic Refresh)
```

### Rules

- **Every finding must have a citation URL** — no LLM hallucinations without sources.
- **Every citation should have a publication date** — so we distinguish new vs old findings.
- **Findings stay in radar.jsonl forever** — it's append-only, audit trail.
- **Candidates need human review** — never auto-merge to features.json.
- **Probes are never auto-generated** — LLM can draft, human must review and verify.

### Cost considerations

- Each `explore` query costs ~$0.03 (GPT-5.4 with web search via Responses API)
- Full run (6 queries): ~$0.20
- Weekly cadence: ~$10/year
- Monthly cadence: ~$2.40/year
- Targeted query when investigating a specific area: ~$0.03

## Content Manifest

The **content manifest** (`scripts/sitefile.ts`) is the single source of truth for what
terminfo.dev should contain: upstream sources, tracked terminals, freshness SLAs, and explicit
ignores. The **lockfile** (`scripts/sitefile.lock.json`) tracks the current state — when each
source was last checked, when each terminal was last probed, and how many features were found.

```bash
bun sitefile                    # Regenerate lockfile from current probe data
bun sitefile --check            # Check freshness against SLAs
```

The manifest declares:

- **27 sources** — formal standards, vendor docs, proposals, release feeds
- **14 terminals** — all active (non-historical) terminals with probe methods
- **Freshness SLAs** — probe data: 30 days, analysis: 30 days, metadata: 90 days
- **Explicit ignores** — items intentionally excluded (e.g., Tektronix 4014 mode)

When starting a refresh cycle, run `bun sitefile --check` to see what's stale.
When finishing a refresh cycle, run `bun sitefile` to update the lockfile.

## Quick Reference

| Task                         | Command                                    |
| ---------------------------- | ------------------------------------------ |
| Validate content             | `bun scripts/validate.ts`                  |
| Regenerate manifest lockfile | `bun sitefile`                             |
| Check freshness SLAs         | `bun sitefile --check`                     |
| Run all headless probes      | `bun terminfo probe termless --all`        |
| Run all app probes           | `bun terminfo probe app --all`             |
| Run mux probes               | `bun terminfo probe mux --all`             |
| Regenerate analysis          | `bun analysis`                             |
| Regenerate API data          | `bun scripts/generate-api.ts`              |
| Build site                   | `bun run build`                            |
| Preview locally              | `bun run dev`                              |
| Check feature count          | `grep -c '"name"' content/features.json`   |
| Check terminal count         | `grep -c '"label"' content/terminals.json` |

## Content Sources

All upstream sources are declared in `scripts/sitefile.ts` with freshness intervals and
feature family mappings. The table below is a quick reference; the manifest is authoritative.

| Source                     | Type               | URL                                                                                                              |
| -------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| ECMA-48                    | Formal standard    | https://ecma-international.org/publications-and-standards/standards/ecma-48/                                     |
| UAX #11 East Asian Width   | Formal standard    | https://unicode.org/reports/tr11/                                                                                |
| VT100 User Guide           | Hardware spec      | https://vt100.net/docs/vt100-ug/                                                                                 |
| VT220 Reference Manual     | Hardware spec      | https://vt100.net/docs/vt220-rm/contents.html                                                                    |
| VT510 Reference Manual     | Hardware spec      | https://vt100.net/docs/vt510-rm/contents.html                                                                    |
| xterm ctlseqs              | De facto standard  | https://invisible-island.net/xterm/ctlseqs/ctlseqs.html                                                          |
| Kitty protocols            | Vendor extension   | https://sw.kovidgoyal.net/kitty/protocol-extensions/                                                             |
| iTerm2 escape codes        | Vendor extension   | https://iterm2.com/documentation-escape-codes.html                                                               |
| ConEmu ANSI codes          | Vendor extension   | https://conemu.github.io/en/AnsiEscapeCodes.html                                                                 |
| mintty control sequences   | Vendor extension   | https://github.com/mintty/mintty/wiki/CtrlSeqs                                                                   |
| foot ctlseqs               | Vendor extension   | https://codeberg.org/dnkl/foot/src/branch/master/doc/foot-ctlseqs.7.scd                                          |
| VTE source (osc parser)    | Implementation ref | https://gitlab.gnome.org/GNOME/vte                                                                               |
| WezTerm docs               | Vendor extension   | https://wezfurlong.org/wezterm/                                                                                  |
| Ghostty source (osc.zig)   | Implementation ref | https://github.com/ghostty-org/ghostty                                                                           |
| VS Code shell integration  | Vendor extension   | https://learn.microsoft.com/en-us/windows/terminal/tutorials/shell-integration                                   |
| rxvt-unicode docs          | Vendor extension   | https://pod.tst.eu/http://cvs.schmorp.de/rxvt-unicode/doc/rxvt.7.pod                                             |
| FinalTerm semantic prompts | Proposal           | https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md              |
| OSC 8 hyperlinks           | Proposal           | https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda                                               |
| CSI u / fixterms           | Proposal           | http://www.leonerd.org.uk/hacks/fixterms/                                                                        |
| Mode 2026 sync output      | Proposal           | https://gist.github.com/christianparpart/d8a62cc1ab659194571ec44c5a4eba40                                        |
| Mode 2031 color scheme     | Proposal           | https://github.com/contour-terminal/contour/blob/master/docs/vt-extensions/color-palette-update-notifications.md |
| VS Code OSC 633            | Proposal           | https://learn.microsoft.com/en-us/windows/terminal/tutorials/shell-integration                                   |
