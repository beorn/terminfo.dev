---
layout: home
hero:
  name: "Terminfo.dev"
  text: "Can your terminal do that?"
  tagline: "Feature support tables for terminal emulators — powered by <a href='#how-this-works'>Termless</a>, Playwright for terminals"
  actions:
    - theme: brand
      text: Terminal Applications
      link: "#terminal-applications"
    - theme: alt
      text: Headless Backends
      link: "#headless-backends"
---

<script setup>
import { ref, computed } from 'vue'
import { data } from './data/census.data'

const filter = ref('')
const categoryFilter = ref('all')
const platformFilter = ref('all')

const categoryOrder = ['sgr', 'cursor', 'text', 'erase', 'editing', 'modes', 'scrollback', 'reset', 'extensions', 'charsets', 'device']
const categoryLabels = {
  sgr: 'SGR (Text Styling)',
  cursor: 'Cursor',
  text: 'Text',
  erase: 'Erase',
  editing: 'Editing',
  modes: 'Modes',
  scrollback: 'Scrollback',
  reset: 'Reset',
  extensions: 'Extensions',
  charsets: 'Character Sets',
  device: 'Device Status',
}

// Sort backends by score (highest first)
const sortedBackends = computed(() => {
  return [...data.backends].sort((a, b) => {
    const aPct = data.stats[a.name]?.pct ?? 0
    const bPct = data.stats[b.name]?.pct ?? 0
    return bPct - aPct
  })
})

// Split into app (real terminals) and headless backends
const allAppBackends = computed(() => sortedBackends.value.filter(b => b.type === 'app'))
const headlessBackends = computed(() => sortedBackends.value.filter(b => b.type === 'headless'))

// Filter app backends by platform
const appBackends = computed(() => {
  if (platformFilter.value === 'all') return allAppBackends.value
  return allAppBackends.value.filter(b => b.platforms?.includes(platformFilter.value))
})

// Platform SVG icons (greyscale, 14x14)
function platformIcon(os) {
  if (os === 'macos') return '<svg viewBox="0 0 16 16" width="14" height="14" style="vertical-align:-2px"><path d="M12.2 5.5c-.1 0-1.6.9-1.6 2.8 0 2.2 1.9 3 2 3-.1.1-.3 1.1-1 2.2-.6 1-1.3 1.9-2.3 1.9s-1.3-.6-2.4-.6c-1.2 0-1.6.6-2.5.6-.9 0-1.6-.9-2.3-2C1.3 12 .8 10.2.8 8.6c0-2.6 1.7-4 3.3-4 .9 0 1.6.6 2.2.6.5 0 1.4-.6 2.4-.6.4 0 1.8.1 2.6 1.3-.1 0-1.5.9-1.5 2.6h.4z" fill="#888"/><path d="M10 1c.5.6.9 1.5.8 2.4-.8.1-1.7-.4-2.2-1.1-.5-.6-.9-1.5-.8-2.3.9 0 1.7.4 2.2 1z" fill="#888"/></svg>'
  if (os === 'linux') return '<svg viewBox="0 0 16 16" width="14" height="14" style="vertical-align:-2px"><path d="M8 1C5.8 1 4 3.4 4 6.4c0 1.5.4 2.8 1.1 3.8-.5.3-1.5 1-1.5 2.1 0 .4.1.8.4 1.1.5.5 1.4.6 2.2.6h3.6c.8 0 1.7-.1 2.2-.6.3-.3.4-.7.4-1.1 0-1.1-1-1.8-1.5-2.1.7-1 1.1-2.3 1.1-3.8C12 3.4 10.2 1 8 1zm-1.5 5c-.4 0-.8-.4-.8-.8s.4-.8.8-.8.8.4.8.8-.4.8-.8.8zm3 0c-.4 0-.8-.4-.8-.8s.4-.8.8-.8.8.4.8.8-.4.8-.8.8z" fill="#888"/></svg>'
  if (os === 'windows') return '<svg viewBox="0 0 16 16" width="14" height="14" style="vertical-align:-2px"><path d="M1 3.5l5.5-.8v5.3H1V3.5zm6.3-.9L15 1.5v6.5H7.3V2.6zM15 8.5v6.3l-7.7-1.1V8.5H15zM6.5 13.5L1 12.8V8.5h5.5v5z" fill="#888"/></svg>'
  return ''
}

function platformIcons(backendName) {
  const info = data.backends.find(b => b.name === backendName)
  if (!info?.platforms?.length) return ''
  return info.platforms.map(p => platformIcon(p)).filter(Boolean).join(' ')
}

const sortedCategories = computed(() => {
  const keys = Object.keys(data.categories)
  return keys.sort((a, b) => {
    const ai = categoryOrder.indexOf(a)
    const bi = categoryOrder.indexOf(b)
    if (ai >= 0 && bi >= 0) return ai - bi
    if (ai >= 0) return -1
    if (bi >= 0) return 1
    return a.localeCompare(b)
  })
})

const filteredCategories = computed(() => {
  let cats = sortedCategories.value
  if (categoryFilter.value !== 'all') {
    cats = cats.filter(c => c === categoryFilter.value)
  }
  if (!filter.value) return cats

  const q = filter.value.toLowerCase()
  return cats.filter(cat => {
    return data.categories[cat].some(f =>
      f.name.toLowerCase().includes(q) || f.id.toLowerCase().includes(q)
    )
  })
})

function filteredFeatures(cat) {
  const features = data.categories[cat] ?? []
  if (!filter.value) return features
  const q = filter.value.toLowerCase()
  return features.filter(f =>
    f.name.toLowerCase().includes(q) || f.id.toLowerCase().includes(q)
  )
}

function getResult(backend, featureId) {
  return data.results[backend]?.[featureId] ?? 'unknown'
}

function getNote(backend, featureId) {
  return data.notes[backend]?.[featureId] ?? ''
}

function cellClass(result) {
  if (result === 'yes') return 'cell-yes'
  if (result === 'partial') return 'cell-partial'
  if (result === 'no') return 'cell-no'
  return 'cell-unknown'
}

function cellIcon(result) {
  if (result === 'yes') return '✓'
  if (result === 'partial') return '~'
  if (result === 'no') return '✗'
  return '?'
}

function cellTooltip(result, backend, featureId) {
  const ann = data.annotations?.[`${backend}:${featureId}`]
  const note = ann?.note ?? data.notes[backend]?.[featureId]
  // If there's a specific note, show it directly (no redundant "Not supported" prefix)
  if (note) {
    const parts = [note]
    if (ann?.url) parts.push(ann.url)
    return parts.join('\n')
  }
  // Otherwise just show status
  return result === 'yes' ? 'Supported' : result === 'partial' ? 'Partial support' : result === 'no' ? 'Not supported' : 'Not tested — no probe data for this terminal'
}

function catLabel(cat) {
  return categoryLabels[cat] ?? cat.charAt(0).toUpperCase() + cat.slice(1)
}

function barSegmentTooltip(backendName, segment) {
  const r = data.results[backendName] ?? {}
  const n = data.notes[backendName] ?? {}
  const items = []
  for (const [id, v] of Object.entries(r)) {
    const name = data.featureDescriptions[id]?.name ?? id
    if (segment === 'yes' && v === 'yes') {
      items.push(`  ✓ ${name}`)
    } else if (segment === 'partial' && v === 'partial') {
      const note = n[id]
      items.push(note ? `  ~ ${name}: ${note}` : `  ~ ${name}`)
    } else if (segment === 'fail' && v !== 'yes' && v !== 'partial') {
      const note = n[id]
      items.push(note ? `  ✗ ${name}: ${note}` : `  ✗ ${name}`)
    }
  }
  if (items.length === 0) return ''
  const label = segment === 'yes' ? 'Supported' : segment === 'partial' ? 'Partial' : 'Not supported'
  return `${label} (${items.length}):\n${items.join('\n')}`
}

function failBarWidth(backendName) {
  const s = data.stats[backendName]
  if (!s) return '0%'
  const fail = s.total - s.yes - (s.partial ?? 0)
  return (fail / s.total * 100) + '%'
}

// Slug helpers for SEO page links — use slug from features.json if available
function featureSlug(id) {
  return data.featureDescriptions[id]?.slug ?? id.replace(/\./g, '-')
}

function termSlug(name) {
  return data.meta[name]?.slug ?? name
}

// Backend metadata comes from @termless/core via census data loader
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

function backendTooltip(name, version) {
  const meta = data.meta[name]
  if (!meta) return name
  const parts = [meta.description]
  if (meta.upstream) parts.push(`Upstream: ${meta.upstream}`)
  if (meta.type) parts.push(`Type: ${meta.type}`)
  if (version) parts.push(`Version: ${version}`)
  if (data.generated) parts.push(`Tested: ${new Date(data.generated).toLocaleDateString()}`)
  if (meta.url) parts.push(meta.url)
  if (meta.caveat) parts.push(`⚠ ${meta.caveat}`)
  return parts.join('\n')
}
</script>

<div v-if="data.backends.length === 0" class="no-data">
  <p>No census data available yet.</p>
</div>

<div v-else>

## Terminal Applications {#terminal-applications}

<p class="section-subtitle">Tested on real terminal applications via the <a href="https://www.npmjs.com/package/terminfo.dev">community CLI</a></p>

<div class="platform-filter">
  <select v-model="platformFilter">
    <option value="all">All Platforms</option>
    <option value="macos">macOS</option>
    <option value="linux">Linux</option>
    <option value="windows">Windows</option>
  </select>
</div>

<div v-if="appBackends.length > 0" class="summary">
  <div v-for="b in appBackends" :key="b.name" class="summary-row">
    <a class="summary-name hover-link" :href="'/terminal/' + termSlug(b.name)" :data-tooltip="backendTooltip(b.name, b.version)">{{ backendLabel(b.name) }}</a>
    <span class="summary-platforms" v-html="platformIcons(b.name)"></span>
    <span class="summary-version">{{ b.version }}</span>
    <div class="summary-bar">
      <div class="bar-yes" :style="{ width: (data.stats[b.name]?.yes / data.stats[b.name]?.total * 100) + '%' }" :data-tooltip="barSegmentTooltip(b.name, 'yes')"></div>
      <div class="bar-partial" :style="{ width: (data.stats[b.name]?.partial / data.stats[b.name]?.total * 100) + '%' }" :data-tooltip="barSegmentTooltip(b.name, 'partial')"></div>
      <div class="bar-fail" :style="{ width: failBarWidth(b.name) }" :data-tooltip="barSegmentTooltip(b.name, 'fail')"></div>
    </div>
    <span class="summary-pct">{{ data.stats[b.name]?.pct }}%</span>
    <span class="summary-counts">
      {{ data.stats[b.name]?.yes }} / {{ data.stats[b.name]?.total }}
    </span>
  </div>
</div>
<p v-else class="no-data-inline">No app results yet. Run <code>npx terminfo.dev submit</code> to contribute.</p>

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
  <label>
    Search:
    <input v-model="filter" type="text" placeholder="Filter features..." />
  </label>
</div>

<div v-if="appBackends.length > 0" class="matrix-wrapper">
<table class="matrix">
  <thead>
    <tr>
      <th class="feature-col"></th>
      <th v-for="b in appBackends" :key="b.name" :data-tooltip="backendTooltip(b.name, b.version)">
        <a class="hover-link" :href="'/terminal/' + termSlug(b.name)">{{ backendLabel(b.name) }}</a>
        <span class="th-platforms" v-html="platformIcons(b.name)"></span>
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
      <td class="feature-name" :data-tooltip="featureTooltip(f)">
        <a class="hover-link" :href="'/' + f.category + '/' + featureSlug(f.id)">{{ f.name }}</a>
      </td>
      <td v-for="b in appBackends" :key="b.name"
          :class="cellClass(getResult(b.name, f.id))"
          :data-tooltip="cellTooltip(getResult(b.name, f.id), b.name, f.id)">
        <a class="cell-link" :href="'/' + f.category + '/' + featureSlug(f.id)">{{ cellIcon(getResult(b.name, f.id)) }}</a>
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

<div class="summary summary-muted">
  <div v-for="b in headlessBackends" :key="b.name" class="summary-row">
    <a class="summary-name hover-link" :href="'/terminal/' + termSlug(b.name)" :data-tooltip="backendTooltip(b.name, b.version)">{{ backendLabel(b.name) }}</a>
    <span class="summary-version">{{ b.version }}</span>
    <div class="summary-bar">
      <div class="bar-yes" :style="{ width: (data.stats[b.name]?.yes / data.stats[b.name]?.total * 100) + '%' }" :data-tooltip="barSegmentTooltip(b.name, 'yes')"></div>
      <div class="bar-partial" :style="{ width: (data.stats[b.name]?.partial / data.stats[b.name]?.total * 100) + '%' }" :data-tooltip="barSegmentTooltip(b.name, 'partial')"></div>
      <div class="bar-fail" :style="{ width: failBarWidth(b.name) }" :data-tooltip="barSegmentTooltip(b.name, 'fail')"></div>
    </div>
    <span class="summary-pct">{{ data.stats[b.name]?.pct }}%</span>
    <span class="summary-counts">
      {{ data.stats[b.name]?.yes }} / {{ data.stats[b.name]?.total }}
    </span>
  </div>
</div>

<div class="matrix-wrapper">
<table class="matrix matrix-muted">
  <thead>
    <tr>
      <th class="feature-col"></th>
      <th v-for="b in headlessBackends" :key="b.name" :data-tooltip="backendTooltip(b.name, b.version)">
        <a class="hover-link" :href="'/terminal/' + termSlug(b.name)">{{ backendLabel(b.name) }}</a>
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
      <td class="feature-name" :data-tooltip="featureTooltip(f)">
        <a class="hover-link" :href="'/' + f.category + '/' + featureSlug(f.id)">{{ f.name }}</a>
      </td>
      <td v-for="b in headlessBackends" :key="b.name"
          :class="cellClass(getResult(b.name, f.id))"
          :data-tooltip="cellTooltip(getResult(b.name, f.id), b.name, f.id)">
        <a class="cell-link" :href="'/' + f.category + '/' + featureSlug(f.id)">{{ cellIcon(getResult(b.name, f.id)) }}</a>
      </td>
    </tr>
  </tbody>
</table>
</div>

</div>

<p class="footer-note">
  Hover over any cell for details.<br/>
  Data from <a href="https://termless.dev">Termless</a> census probes and <a href="https://www.npmjs.com/package/terminfo.dev">community submissions</a>.
  {{ data.generated ? 'Generated: ' + data.generated : '' }}
</p>

## How This Works

Data comes from two complementary sources:

**Terminal Applications** — tested on real terminals via the `npx terminfo.dev` community CLI.
Each test sends escape sequences to the actual terminal and verifies behavior via cursor
position reports, device attribute queries, and rendered width measurements. These results
reflect what users actually experience.

**Headless Backends** — tested via [Termless](https://termless.dev) against headless terminal
emulator libraries. These test parser correctness — whether the library correctly parses and
stores the escape sequence. A headless pass means "the parser accepts this," not "this renders
correctly." Some features (like blink, cursor shape) may parse correctly but are not exposed
through the library's API.

</div>

<style>
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
.platform-filter {
  margin-bottom: 1em;
}

.platform-filter select {
  padding: 4px 8px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 4px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 0.9em;
}

/* Platform icons */
.summary-platforms {
  display: flex;
  gap: 3px;
  flex-shrink: 0;
  align-items: center;
}

.th-platforms {
  display: flex;
  gap: 2px;
  justify-content: center;
  margin-top: 2px;
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
.summary-muted {
  opacity: 0.85;
}

.matrix-muted {
  opacity: 0.85;
}

/* Summary section */
.summary {
  margin: 1em 0 2em;
}

.summary-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}

.summary-name {
  width: 120px;
  font-weight: 600;
  font-size: 0.9em;
  flex-shrink: 0;
  cursor: pointer;
}

.summary-version {
  width: 60px;
  font-family: var(--vp-font-family-mono);
  font-size: 0.8em;
  color: var(--vp-c-text-3);
  flex-shrink: 0;
}

.summary-bar {
  flex: 1;
  height: 22px;
  background: var(--vp-c-bg-soft);
  border-radius: 4px;
  display: flex;
  cursor: pointer;
}

.bar-yes {
  height: 100%;
  background: #10b981;
  transition: width 0.3s ease;
}

.bar-partial {
  height: 100%;
  background: #f59e0b;
  transition: width 0.3s ease;
}

.bar-fail {
  height: 100%;
  background: transparent;
  transition: width 0.3s ease;
}

.summary-pct {
  width: 40px;
  font-weight: 600;
  font-size: 0.9em;
  text-align: right;
  flex-shrink: 0;
}

.summary-counts {
  width: 70px;
  font-size: 0.8em;
  color: var(--vp-c-text-3);
  text-align: right;
  flex-shrink: 0;
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

/* Matrix table — page scrolls naturally, only headers stick */
.matrix-wrapper {
  margin: 1em 0;
}

/* Override VitePress default table overflow-x:auto which breaks sticky */
.matrix-wrapper table {
  display: table;
  overflow-x: visible;
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
  position: sticky;
  top: var(--vp-nav-height, 64px);
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

/* Bar segment tooltips appear below */
.bar-yes[data-tooltip]:hover::after,
.bar-partial[data-tooltip]:hover::after,
.bar-fail[data-tooltip]:hover::after {
  bottom: auto;
  top: 100%;
  margin-top: 4px;
  left: 0;
  transform: none;
  max-width: 80vw;
}
</style>
