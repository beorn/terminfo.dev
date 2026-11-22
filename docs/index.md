---
layout: home
hero:
  name: "Terminfo.dev"
  text: "Can your terminal do that?"
  tagline: "Look up 270+ features (colors, links, images, mouse, keys) and see which terminals support each, tested in the terminal itself."
  actions:
    - theme: brand
      text: Look up a feature
      link: "/features"
    - theme: alt
      text: Compare terminals
      link: "#terminal-applications"
    - theme: alt
      text: Test your terminal
      link: "/contribute"
---

<script setup>
import { ref, computed } from 'vue'
import { displayMeasuredDate } from './.vitepress/theme/display-version.ts'
import { data } from './data/probes.data'
import { currentCoverageSentence, visibleCategoryIds, publicResultFor } from './data/release-scope.ts'
import { baselineReadout } from './data/baseline-readouts.ts'
import { platformIcon } from './.vitepress/theme/platform-icons.ts'
import { rowFacts } from './.vitepress/theme/row-facts.ts'

const filter = ref('')
const categoryFilter = ref('all')
const baselineFilter = ref('all')
const platformFilter = ref('all')

// Display composed current contexts; a historical-only target has no row.
const displayedSelections = { ...data.selectedByBackend }

// D132 B (#30917): the environment groups a run records are ungraded, so no bar, tooltip or order
// counts them; the legend below names them instead of leaving the smaller denominator unexplained.

// Baseline metadata for filter dropdown
const baselineOptions = [
  { id: 'core', label: 'Core', count: data.baselines.core?.length ?? 0 },
  { id: 'modern', label: 'Modern', count: data.baselines.modern?.length ?? 0 },
  { id: 'rich', label: 'Rich', count: data.baselines.rich?.length ?? 0 },
  { id: 'unicode', label: 'Unicode', count: data.baselines.unicode?.length ?? 0 },
]

// #37761 item 9: a few-option filter is count pills; All counts every feature the matrix can list.
const baselinePills = [{ id: 'all', label: 'All', count: data.features.length }, ...baselineOptions]

// Set of feature IDs in selected baseline
const baselineFeatureIds = computed(() => {
  if (baselineFilter.value === 'all') return null
  return new Set(data.baselines[baselineFilter.value] ?? [])
})

const categoryLabels = data.categoryLabels ?? {}

// ONE basis for this page: the release bar. Its widths, its tooltips and this order all fold the same
// classified rows, so no two of them can tell a different story about a terminal (28792 item 1). The
// order reads the bar's Supported COUNT (#37341 D2): a count, never a share; a row with no bar sorts last.
function releaseSupported(backendName) {
  const bar = data.releaseBars[backendName]
  return bar ? bar.counts.supported : -1
}

// Sort backends by that one basis (most Supported first), then by name so the order is deterministic.
const sortedBackends = computed(() => {
  return [...data.backends].sort((a, b) => {
    const delta = releaseSupported(b.name) - releaseSupported(a.name)
    return delta !== 0 ? delta : a.name.localeCompare(b.name)
  })
})

// Split into app (real terminals) and headless backends
const allAppBackends = computed(() => sortedBackends.value.filter(b => b.type === 'term'))
const headlessBackends = computed(() => sortedBackends.value.filter(b => b.type === 'lib'))
const muxBackends = computed(() => sortedBackends.value.filter(b => b.type === 'mux'))

// The page names the ONE basis it counts, in a visitor's words: which rows this bar, these tooltips and
// the order below are about (28792 item 1, increment 5).

// Filter app backends by platform
const appBackends = computed(() => {
  if (platformFilter.value === 'all') return allAppBackends.value
  return allAppBackends.value.filter(b => b.platforms?.includes(platformFilter.value))
})

// #37761: the platform filter is count pills over what the list shows; a platform with no terminal is left out.
const PLATFORM_ORDER = ['macos', 'linux', 'windows']
const platformOptions = computed(() => {
  const counts = new Map()
  for (const b of allAppBackends.value) for (const os of b.platforms ?? []) counts.set(os, (counts.get(os) ?? 0) + 1)
  const order = (os) => (PLATFORM_ORDER.includes(os) ? PLATFORM_ORDER.indexOf(os) : PLATFORM_ORDER.length)
  return [
    { id: 'all', label: 'All', count: allAppBackends.value.length },
    ...[...counts.keys()].sort((a, b) => order(a) - order(b) || a.localeCompare(b)).map((os) => ({ id: os, label: data.platformLabels?.[os] ?? os, count: counts.get(os) })),
  ]
})

// #37761: one row shape for every bar list. Beside its platform icon a name never repeats the platform in words.
// #37761: the shared row facts (row-facts.ts), the same ones the Baseline and feature pages read.
const facts = rowFacts(data)
const rowName = facts.name
const rowOs = facts.os
const rowPlatform = facts.platform
const rowIds = facts.ids
const describeFor = facts.describe
const BASELINES = ['core', 'modern', 'rich', 'unicode']
const BASELINE_COLORS = { core: '#10b981', modern: '#3b82f6', rich: '#8b5cf6', unicode: '#06b6d4' }
const BASELINE_ICONS = { core: '🟢', modern: '🔵', rich: '🟣', unicode: '🌐' }
// Kept in the script: the glossary linker rewrites words in page text, which would break a template expression.
const BASELINE_DESCRIPTIONS = {
  core: 'Every terminal should support these — SGR basics, cursor, erase, alt screen',
  modern: 'Expected by modern TUIs — truecolor, bracketed paste, focus events, mouse',
  rich: 'Advanced features — kitty keyboard, graphics, hyperlinks, semantic prompts',
  unicode: 'Unicode correctness — wide chars, combining, emoji, grapheme clusters',
}
// A Baseline card row: the same categories limited to the card's features (#37761 7b, 7c).
function cardIds(name, baseline) {
  return facts.within(name, data.baselines[baseline] ?? [], baseline)
}
function cardPercent(name, baseline) {
  return facts.percentWithin(name, data.baselines[baseline] ?? [], baseline)
}

function platformIcons(backendName) {
  const os = displayedSelections[backendName]?.selected.subject?.os
  return os ? platformIcon(os) : ''
}

// #37341 D2: the one readout, "S supported · T of N tested", printed beside the bar and in its tooltip.
function releaseReadout(backendName) {
  return data.releaseBars[backendName] ? `${data.releaseShares[backendName]} · ${coverageLabel(backendName)}` : undefined
}

const sortedCategories = computed(() => visibleCategoryIds(data.categoryOrder, data.categories))

const filteredCategories = computed(() => {
  let cats = sortedCategories.value
  if (categoryFilter.value !== 'all') {
    cats = cats.filter(c => c === categoryFilter.value)
  }

  // If baseline filter is active, only keep categories that have features in the baseline
  if (baselineFeatureIds.value) {
    cats = cats.filter(cat => {
      return (data.categories[cat] ?? []).some(f => baselineFeatureIds.value.has(f.id))
    })
  }

  if (!filter.value) return cats

  const q = filter.value.toLowerCase()
  return cats.filter(cat => {
    return filteredFeatures(cat).length > 0
  })
})

function filteredFeatures(cat) {
  let features = data.categories[cat] ?? []

  // Apply baseline filter
  if (baselineFeatureIds.value) {
    features = features.filter(f => baselineFeatureIds.value.has(f.id))
  }

  if (!filter.value) return features
  const q = filter.value.toLowerCase()
  return features.filter(f =>
    f.name.toLowerCase().includes(q) || f.id.toLowerCase().includes(q)
  )
}

function catLabel(cat) {
  return categoryLabels[cat] ?? cat.charAt(0).toUpperCase() + cat.slice(1)
}

function coverageLabel(backendName) {
  const bar = data.releaseBars[backendName]
  if (!bar) return 'No selected run'
  return currentCoverageSentence(bar, displayedSelections[backendName]?.selected.catalogIds)
}

// #37341 D2: every baseline row prints the one readout, "S supported · T of N tested".
function baselineRow(backendName, baseline) {
  const stats = data.baselineStats[backendName]?.[baseline]
  if (!stats) return { text: '', title: undefined }
  return baselineReadout(stats)
}

// Slug helpers for SEO page links — use slug from features.json if available
function featureSlug(id) {
  return data.featureDescriptions[id]?.slug ?? id.replace(/\./g, '-')
}

function termSlug(name) {
  return data.meta[name]?.slug ?? name
}

// Backend metadata comes from @termless/core via probes data loader
function backendLabel(name) {
  return data.meta[name]?.label ?? name
}

function featureTooltip(f) {
  const desc = data.featureDescriptions[f.id]
  if (!desc) return f.name
  const parts = [desc.name]
  if (desc.tags?.length) parts.push('Tags: ' + desc.tags.join(', '))
  if (desc.url) parts.push('Spec: ' + desc.url.replace(/^https?:\/\//, ''))
  return parts.join('\n')
}

// #37761 item 10: a terminal's hover says who it is: name, platform, one line, website. No run ids, suite ids or times.
function backendTooltip(name) {
  const meta = data.meta[name]
  const parts = [[rowName(name), rowPlatform(name)].filter(Boolean).join(' · ')]
  const line = meta?.description?.split(/(?<=[.!?])\s/u)[0]
  if (line) parts.push(line)
  if (meta?.url) parts.push(meta.url)
  return parts.join('\n')
}
</script>

<div v-if="sortedBackends.length === 0" class="no-data">
  <p>No current or historical measurements are available yet.</p>
</div>

<div v-else>

## Terminal Applications {#terminal-applications}

<p class="section-subtitle">Real terminal measurements. Select a terminal for results and recorded evidence.</p>

<div class="support-legend" aria-label="Bar colors"><span class="legend-supported">Supported</span><span class="legend-unsupported">Unsupported</span><span class="legend-inconclusive">Untestable</span><span class="legend-no-result">No result yet</span></div>

<CountPills v-model="platformFilter" :options="platformOptions" label="Platform" />

<div v-if="appBackends.length > 0" class="term-rows">
  <TermRow v-for="b in appBackends" :key="b.name" :name="rowName(b.name)" :href="'/terminals/' + termSlug(b.name)" :os="rowOs(b.name)" :platform="rowPlatform(b.name)"
    :description="data.meta[b.name]?.description" :website="data.meta[b.name]?.url" :version="b.versions.join(', ')"
    :ids="rowIds(b.name)" :describe="describeFor(b.name)" :readout="releaseReadout(b.name)" />
</div>
<p v-else class="no-data-inline">No app results yet. See <a href="/contribute">how to record a run and prepare an offline contribution draft</a>.</p>

## Terminal Baseline 2026 {#baselines}

<p class="section-subtitle">Inspired by <a href="https://web.dev/baseline">Web Baseline</a> — minimum feature sets that terminals should support. For the weird and wonderful history of protocols that didn't make the cut, see the <a href="/baseline/legacy">Legacy baseline</a>.</p>

<div class="baseline-grid">
  <div v-for="bl in BASELINES" :key="bl" class="baseline-card">
    <div class="baseline-header">
      <span class="baseline-icon">{{ BASELINE_ICONS[bl] }}</span>
      <a class="baseline-name" :href="'/baseline/' + bl">{{ bl.charAt(0).toUpperCase() + bl.slice(1) }}</a>
      <span class="baseline-count">{{ data.baselines[bl]?.length ?? 0 }} features</span>
    </div>
    <div class="baseline-desc">{{ BASELINE_DESCRIPTIONS[bl] }}</div>
    <div class="term-rows term-rows-card">
      <TermRow v-for="b in appBackends" :key="b.name" card :name="rowName(b.name)" :href="'/terminals/' + termSlug(b.name)" :os="rowOs(b.name)" :platform="rowPlatform(b.name)"
        :ids="cardIds(b.name, bl)" :describe="describeFor(b.name)" :readout="baselineRow(b.name, bl).text || undefined" :fill="BASELINE_COLORS[bl]" :percent="cardPercent(b.name, bl)" />
    </div>
  </div>
</div>

## Feature Matrix {#matrix}

<div class="filters">
  <label>
    Category:
    <select v-model="categoryFilter">
      <option value="all">All</option>
      <option v-for="cat in sortedCategories" :key="cat" :value="cat">
        {{ catLabel(cat) }}
      </option>
    </select>
  </label>
  <CountPills v-model="baselineFilter" :options="baselinePills" label="Baseline" />
  <label>
    Search:
    <input v-model="filter" type="text" placeholder="Filter features..." />
  </label>
</div>

<p class="footer-note">Scroll to compare columns. Select a result for recorded evidence.</p>
<div v-if="appBackends.length > 0" class="matrix-wrapper" tabindex="0" role="region" aria-label="Terminal application feature matrix">
<table class="matrix">
  <thead>
    <tr>
      <th class="feature-col"></th>
      <th v-for="b in appBackends" :key="b.name">
        <a class="hover-link" :href="'/terminals/' + termSlug(b.name)" :title="backendTooltip(b.name)">{{ rowName(b.name) }}</a>
        <span class="th-platforms" v-html="platformIcons(b.name)"></span>
        <span v-if="!data.selectedByBackend[b.name]" class="historical-label">Historical</span>
      </th>
    </tr>
  </thead>
  <tbody v-for="cat in filteredCategories" :key="cat">
    <tr class="category-row">
      <td :colspan="appBackends.length + 1" class="category-header">
        <a class="hover-link" :href="'/' + cat">{{ catLabel(cat) }}</a>
      </td>
    </tr>
    <tr v-for="f in filteredFeatures(cat)" :key="f.id">
      <td class="feature-name" :title="featureTooltip(f)">
        <a class="hover-link" :href="'/' + f.category + '/' + featureSlug(f.id)">{{ f.name }}</a>
      </td>
      <td v-for="b in appBackends" :key="b.name">
        <ResultEvidenceCell :feature-id="f.id" :probe-guidance="data.featureDescriptions[f.id]?.probe" :feature-name="f.name" :subject-name="backendLabel(b.name)"
          :version="displayedSelections[b.name]?.selected" :cell="publicResultFor(displayedSelections[b.name]?.selected, f.id)" />
      </td>
    </tr>
  </tbody>
</table>
</div>

<div v-if="headlessBackends.length > 0">

## Headless Backends {#headless-backends}

<p class="section-subtitle">Parser correctness tested via <a href="https://termless.dev">Termless</a> — headless libraries may not expose all features through their API</p>

<div class="headless-note">
  Headless backends test parser correctness, not rendering. A <span class="cell-yes-inline">✓</span> means the parser accepts the sequence, not that it renders correctly.
</div>

<div class="term-rows term-rows-muted">
  <TermRow v-for="b in headlessBackends" :key="b.name" :name="rowName(b.name)" :href="'/terminals/' + termSlug(b.name)" :os="rowOs(b.name)" :platform="rowPlatform(b.name)"
    :description="data.meta[b.name]?.description" :website="data.meta[b.name]?.url" :version="b.versions.join(', ')"
    :ids="rowIds(b.name)" :describe="describeFor(b.name)" :readout="releaseReadout(b.name)" />
</div>

### Headless Baseline Coverage

<div class="baseline-grid">
  <div v-for="bl in BASELINES" :key="bl" class="baseline-card">
    <div class="baseline-header">
      <span class="baseline-icon">{{ BASELINE_ICONS[bl] }}</span>
      <a class="baseline-name" :href="'/baseline/' + bl">{{ bl.charAt(0).toUpperCase() + bl.slice(1) }}</a>
      <span class="baseline-count">{{ data.baselines[bl]?.length ?? 0 }} features</span>
    </div>
    <div class="term-rows term-rows-card">
      <TermRow v-for="b in headlessBackends" :key="b.name" card :name="rowName(b.name)" :href="'/terminals/' + termSlug(b.name)" :os="rowOs(b.name)" :platform="rowPlatform(b.name)"
        :ids="cardIds(b.name, bl)" :describe="describeFor(b.name)" :readout="baselineRow(b.name, bl).text || undefined" :fill="BASELINE_COLORS[bl]" :percent="cardPercent(b.name, bl)" />
    </div>
  </div>
</div>

<p class="footer-note">Scroll to compare columns. Select a result for recorded evidence.</p>
<div class="matrix-wrapper" tabindex="0" role="region" aria-label="Headless backend feature matrix">
<table class="matrix matrix-muted">
  <thead>
    <tr>
      <th class="feature-col"></th>
      <th v-for="b in headlessBackends" :key="b.name">
        <a class="hover-link" :href="'/terminals/' + termSlug(b.name)" :title="backendTooltip(b.name)">{{ rowName(b.name) }}</a>
        <span v-if="!data.selectedByBackend[b.name]" class="historical-label">Historical</span>
      </th>
    </tr>
  </thead>
  <tbody v-for="cat in filteredCategories" :key="cat">
    <tr class="category-row">
      <td :colspan="headlessBackends.length + 1" class="category-header">
        <a class="hover-link" :href="'/' + cat">{{ catLabel(cat) }}</a>
      </td>
    </tr>
    <tr v-for="f in filteredFeatures(cat)" :key="f.id">
      <td class="feature-name" :title="featureTooltip(f)">
        <a class="hover-link" :href="'/' + f.category + '/' + featureSlug(f.id)">{{ f.name }}</a>
      </td>
      <td v-for="b in headlessBackends" :key="b.name">
        <ResultEvidenceCell :feature-id="f.id" :probe-guidance="data.featureDescriptions[f.id]?.probe" :feature-name="f.name" :subject-name="backendLabel(b.name)"
          :version="displayedSelections[b.name]?.selected" :cell="publicResultFor(displayedSelections[b.name]?.selected, f.id)" />
      </td>
    </tr>
  </tbody>
</table>
</div>

</div>

<div v-show="muxBackends.length > 0">
<h2 id="multiplexers">Multiplexers</h2>

<p class="section-subtitle">Which features survive tmux and screen? Pass-through testing shows what each multiplexer correctly relays.</p>

<div class="term-rows term-rows-muted">
  <TermRow v-for="b in muxBackends" :key="b.name" :name="rowName(b.name)" :href="'/terminals/' + termSlug(b.name)" :os="rowOs(b.name)" :platform="rowPlatform(b.name)"
    :description="data.meta[b.name]?.description" :website="data.meta[b.name]?.url" :version="b.versions.join(', ')"
    :ids="rowIds(b.name)" :describe="describeFor(b.name)" :readout="releaseReadout(b.name)" />
</div>

<p class="footer-note">Scroll to compare columns. Select a result for recorded evidence.</p>
<div class="matrix-wrapper" tabindex="0" role="region" aria-label="Multiplexer feature matrix">
<table class="matrix matrix-muted">
  <thead>
    <tr>
      <th class="feature-col"></th>
      <th v-for="b in muxBackends" :key="b.name">
        <a class="hover-link" :href="'/terminals/' + termSlug(b.name)" :title="backendTooltip(b.name)">{{ rowName(b.name) }}</a>
        <span v-if="!data.selectedByBackend[b.name]" class="historical-label">Historical</span>
      </th>
    </tr>
  </thead>
  <tbody v-for="cat in filteredCategories" :key="cat">
    <tr class="category-row">
      <td :colspan="muxBackends.length + 1" class="category-header">
        <a class="hover-link" :href="'/' + cat">{{ catLabel(cat) }}</a>
      </td>
    </tr>
    <tr v-for="f in filteredFeatures(cat)" :key="f.id">
      <td class="feature-name" :title="featureTooltip(f)">
        <a class="hover-link" :href="'/' + f.category + '/' + featureSlug(f.id)">{{ f.name }}</a>
      </td>
      <td v-for="b in muxBackends" :key="b.name">
        <ResultEvidenceCell :feature-id="f.id" :probe-guidance="data.featureDescriptions[f.id]?.probe" :feature-name="f.name" :subject-name="backendLabel(b.name)"
          :version="displayedSelections[b.name]?.selected" :cell="publicResultFor(displayedSelections[b.name]?.selected, f.id)" />
      </td>
    </tr>
  </tbody>
</table>
</div>

</div>

<p class="footer-note">
  Select any result for recorded evidence.<br/>
  Data from <a href="https://termless.dev">Termless</a> probes and <a href="https://www.npmjs.com/package/terminfo.dev">community submissions</a>.
  {{ data.generated ? 'Latest selected measurement: ' + displayMeasuredDate(data.generated) : '' }}
</p>

## Explore

<div class="explore-grid">
  <a href="/fundamentals" class="explore-card">
    <h3>Fundamentals</h3>
    <p>How terminals work — control characters, PTY architecture, stty, and feature detection.</p>
  </a>
  <a href="/standards" class="explore-card">
    <h3>Standards</h3>
    <p>From VT100 to Kitty — 50 years of terminal protocols and escape sequence standards.</p>
  </a>
  <a href="/terminals/vt100-historical" class="explore-card">
    <h3>Historical Terminals</h3>
    <p>The terminals that shaped computing — VT52, VT100, VT220, xterm, and VT510.</p>
  </a>
  <a href="/baseline/core" class="explore-card">
    <h3>Baselines</h3>
    <p>What should your terminal support? Minimum feature sets from core to rich.</p>
  </a>
  <a href="/glossary" class="explore-card">
    <h3>Glossary</h3>
    <p>CSI, SGR, OSC, DEC... terminal terminology explained.</p>
  </a>
</div>

## How This Works

Data comes from three complementary sources:

**Terminal Applications** — measured in a particular app and environment. On an ordinary terminal,
the community CLI runs reviewed queries; tests that change terminal state are left blank
until a verified disposable test environment is available. Rendering and interaction require
their own evidence, such as screenshots and input tests; a reply alone proves neither.

**Headless Backends** — tested via [Termless](https://termless.dev) against headless terminal
emulator libraries. These test parser correctness — whether the library correctly parses and
stores the escape sequence. A headless pass means "the parser accepts this," not "this renders
correctly." Some features (like blink, cursor shape) may parse correctly but are not exposed
through the library's API.

**Multiplexers** — tested by running probes through terminal multiplexers (tmux, screen) to
measure pass-through fidelity. A multiplexer pass means the escape sequence was correctly
relayed to the underlying terminal. Failures indicate sequences that the multiplexer intercepts,
strips, or mishandles.

</div>

<style>
/* Explore card grid */
.explore-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin: 1.5em 0;
}

@media (max-width: 960px) {
  .explore-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 580px) {
  .explore-grid {
    grid-template-columns: 1fr;
  }
}

.explore-card {
  display: block;
  padding: 16px 18px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  text-decoration: none;
  color: inherit;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.explore-card:hover {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

.explore-card h3 {
  margin: 0 0 6px;
  font-size: 0.95em;
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.explore-card p {
  margin: 0;
  font-size: 0.85em;
  line-height: 1.45;
  color: var(--vp-c-text-2);
}

.no-data {
  padding: 2em;
  background: var(--vp-c-danger-soft);
  border-radius: 8px;
  margin: 2em 0;
  text-align: center;
}

.no-data-inline {
  color: var(--vp-c-text-3);
  font-size: 0.9em;
  font-style: italic;
}

.section-subtitle {
  color: var(--vp-c-text-3);
  font-size: 0.9em;
  margin-top: -0.8em;
  margin-bottom: 1em;
}

/* Platform filter */
.th-platforms {
  display: flex;
  gap: 2px;
  justify-content: center;
  margin-top: 1px;
}

/* Headless note callout */
.headless-note {
  padding: 0.75em 1em;
  background: var(--vp-c-bg-soft);
  border-left: 3px solid var(--vp-c-text-3);
  border-radius: 4px;
  font-size: 0.85em;
  color: var(--vp-c-text-2);
  margin-bottom: 1em;
}

.cell-yes-inline {
  color: #10b981;
  font-weight: 700;
}

/* Muted style for headless sections */
.term-rows-muted {
  opacity: 0.85;
}

.matrix-muted {
  opacity: 0.85;
}

/* Filters */
.filters {
  display: flex;
  gap: 16px;
  margin: 1em 0;
  flex-wrap: wrap;
}

.filters label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.9em;
}

.filters select,
.filters input {
  padding: 4px 8px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 4px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 0.9em;
}

/* Baseline 2026 cards */
.baseline-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin: 1em 0 2em;
}
@media (max-width: 960px) {
  .baseline-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 600px) {
  .baseline-grid { grid-template-columns: minmax(0, 1fr); }
}

.baseline-card {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 12px;
  background: var(--vp-c-bg-soft);
}

/* #37761: the card's tier name is its link; the rows inside are TermRows. */
.baseline-name,
.vp-doc a.baseline-name {
  color: inherit;
  text-decoration: none;
}
.vp-doc a.baseline-name:hover,
.vp-doc a.baseline-name:focus-visible {
  color: var(--vp-c-brand-1);
}

.baseline-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.baseline-icon {
  font-size: 1.1em;
}

.baseline-name {
  font-weight: 700;
  font-size: 1em;
}

.baseline-count {
  margin-left: auto;
  font-size: 0.8em;
  color: var(--vp-c-text-3);
}

.baseline-desc {
  font-size: 0.75em;
  color: var(--vp-c-text-3);
  margin-bottom: 8px;
  line-height: 1.3;
}

/* Keep growing matrices within the page, with headers in their scroll region. */
.matrix-wrapper {
  margin: 1em 0;
  overflow: auto;
  max-height: 70vh;
}

.matrix-wrapper:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

/* The wrapper owns scrolling; table headers stick within it. */
.matrix-wrapper table {
  display: table;
  overflow: visible;
}

.matrix-wrapper :deep(.vp-table) {
  overflow: visible;
}

.matrix {
  border-collapse: separate;
  border-spacing: 0;
  width: 100%;
  font-size: 0.85em;
}

.matrix th,
.matrix td {
  padding: 6px 12px;
  text-align: center;
  border: 1px solid var(--vp-c-divider);
}

.matrix th {
  background: var(--vp-c-bg-soft);
  font-weight: 600;
  font-size: 0.9em;
  padding-top: 8px !important;
  padding-bottom: 10px !important;
  line-height: 1.2;
  position: sticky;
  top: 0;
  z-index: 10;
  box-shadow: 0 1px 0 var(--vp-c-divider);
}

.feature-col {
  text-align: left !important;
}

.category-row td {
  border: none;
}

.category-header {
  text-align: left !important;
  font-weight: 700;
  font-size: 0.95em;
  padding: 14px 12px 6px !important;
  background: transparent !important;
  color: var(--vp-c-text-1);
  border-bottom: 2px solid var(--vp-c-divider) !important;
  border-top: none !important;
  border-left: none !important;
  border-right: none !important;
}

.feature-name {
  text-align: left !important;
  white-space: nowrap;
  font-size: 0.95em;
}

/* Cell links — inherit cell color, fill the entire cell */
.cell-link,
.cell-link:link,
.cell-link:visited {
  color: inherit !important;
  text-decoration: none !important;
  display: block;
}

/* Hover-links: look like normal text, reveal as links on hover */
.hover-link,
.hover-link:link,
.hover-link:visited {
  color: inherit !important;
  text-decoration: none !important;
  font-weight: inherit;
}

.hover-link:hover {
  color: var(--vp-c-brand-1) !important;
  text-decoration: underline !important;
}

.cell-yes {
  background: rgba(16, 185, 129, 0.1);
  color: #10b981;
  font-weight: 700;
}

.cell-partial {
  background: rgba(245, 158, 11, 0.1);
  color: #f59e0b;
  font-weight: 700;
}

.cell-no {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
  font-weight: 700;
}

.cell-unknown {
  background: rgba(139, 92, 246, 0.1);
  color: #8b5cf6;
  font-weight: 700;
}


.footer-note {
  font-size: 0.8em;
  color: var(--vp-c-text-3);
  margin-top: 1.5em;
}

/* Instant CSS tooltips */
[data-tooltip] {
  position: relative;
}

[data-tooltip]:hover::after {
  content: attr(data-tooltip);
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  background: var(--vp-c-bg-elv);
  color: var(--vp-c-text-1);
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 0.75em;
  font-weight: 400;
  line-height: 1.4;
  white-space: pre;
  text-align: left;
  width: max-content;
  z-index: 100;
  pointer-events: none;
  box-shadow: 0 2px 8px rgba(0,0,0,0.15);
}

/* Don't show empty tooltips */
[data-tooltip=""]:hover::after,
[data-tooltip]:not([data-tooltip]):hover::after {
  display: none;
}

.problem-summary {
  max-width: 720px;
  margin: -24px auto 32px;
  padding: 16px 20px;
  background: var(--vp-c-bg-soft);
  border-radius: 8px;
  font-size: 0.95em;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}

.problem-summary p {
  margin: 0;
}

.problem-summary .tier-line {
  margin-top: 0.75em;
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.problem-summary .unmeasured {
  margin-top: 0.5em;
}

.problem-summary .unmeasured ul {
  margin: 0.5em 0 0;
  padding-left: 1.2em;
}

/* Compact homepage comparison; terminal detail tables keep their own layout. */
.VPHome .problem-summary { max-width:none; margin:0 0 32px; padding:0; background:none; border-radius:0; font-size:16px; }
.VPHome .VPHero .main { max-width:none; }
.VPHome .VPHero .text { max-width:900px; }
.support-legend { display:flex; flex-wrap:wrap; gap:8px 20px; margin:20px 0 12px; font-size:12px; color:var(--vp-c-text-2); }
.support-legend span::before { content:""; display:inline-block; width:9px; height:9px; margin-right:6px; border-radius:2px; background:var(--vp-c-divider); }
.support-legend .legend-supported::before { background:#10b981; }
.support-legend .legend-inconclusive::before { background:#f59e0b; }
.support-legend .legend-no-result::before { background:var(--vp-c-bg-soft); border:1px solid var(--vp-c-divider); }
.historical-label { display:block; color:var(--vp-c-text-2); font-size:10px; font-weight:400; }
.release-details { margin:0 0 32px; color:var(--vp-c-text-3); font-size:13px; }
@media (max-width:600px) {
 .VPHome .matrix .feature-col,.VPHome .matrix .feature-name { position:sticky; left:0; z-index:2; box-sizing:border-box; width:180px; min-width:180px; max-width:180px; white-space:normal; background:var(--vp-c-bg); }
 .VPHome .matrix th.feature-col { z-index:11; background:var(--vp-c-bg-soft); }
 .VPHome .matrix .feature-name > a { display:block; overflow-wrap:anywhere; }
 .VPHome .matrix .category-header { display:table-cell; }
 .VPHome .matrix .category-header > a { position:sticky; left:12px; display:block; width:max-content; }
 .VPHome .problem-summary { padding:0; font-size:15px; }
}
</style>
