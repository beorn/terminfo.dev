---
layout: home
hero:
  name: "Terminfo.dev"
  text: "Can your terminal do that?"
  tagline: "Feature support tables for terminal emulators — powered by <a href='#how-this-works'>Termless</a>, Playwright for terminals"
  actions:
    - theme: brand
      text: View Matrix
      link: "#matrix"
---

<script setup>
import { ref, computed } from 'vue'
import { data } from './data/census.data'

const filter = ref('')
const categoryFilter = ref('all')

const categoryOrder = ['sgr', 'cursor', 'text', 'erase', 'mode', 'scrollback', 'reset', 'extension']
const categoryLabels = {
  sgr: 'SGR (Text Styling)',
  cursor: 'Cursor',
  text: 'Text',
  erase: 'Erase',
  modes: 'Modes',
  scrollback: 'Scrollback',
  reset: 'Reset',
  extensions: 'Extensions',
}

// Sort backends by score (highest first)
const sortedBackends = computed(() => {
  return [...data.backends].sort((a, b) => {
    const aPct = data.stats[a.name]?.pct ?? 0
    const bPct = data.stats[b.name]?.pct ?? 0
    return bPct - aPct
  })
})

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
  return result === 'yes' ? 'supported' : result === 'partial' ? 'partial support' : result === 'no' ? 'not supported' : ''
}

function catLabel(cat) {
  return categoryLabels[cat] ?? cat.charAt(0).toUpperCase() + cat.slice(1)
}

function barTooltip(backendName, status) {
  const r = data.results[backendName] ?? {}
  const n = data.notes[backendName] ?? {}
  const features = Object.entries(r)
    .filter(([_, v]) => {
      if (status === 'yes') return v === 'yes'
      if (status === 'partial') return v === 'partial'
      return v === 'no' || v === 'unknown'
    })
    .map(([id]) => {
      const note = n[id]
      return note ? `${id}: ${note}` : id
    })
  if (features.length === 0) return ''
  const label = status === 'yes' ? 'Passing' : status === 'partial' ? 'Partial' : 'Failing'
  return `${label} (${features.length}):\n${features.join('\n')}`
}

function failBarWidth(backendName) {
  const s = data.stats[backendName]
  if (!s) return '0%'
  const fail = s.total - s.yes - (s.partial ?? 0)
  return (fail / s.total * 100) + '%'
}

// Slug helpers for SEO page links
function backendSlug(name) {
  // Use label for URL: ghostty-native → ghostty, xtermjs → xterm-js
  const label = (data.meta[name]?.label ?? name).toLowerCase()
  return label.replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')
}

function featureSlug(id) {
  return id.replace(/\./g, '-')
}

// Backend metadata comes from @termless/core via census data loader
function backendLabel(name) {
  return data.meta[name]?.label ?? name
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

## Backend Summary {#summary}

<div class="summary">
  <div v-for="b in sortedBackends" :key="b.name" class="summary-row">
    <a class="summary-name hover-link" :href="'/terminal/' + backendSlug(b.name)" :data-tooltip="backendTooltip(b.name, b.version)">{{ backendLabel(b.name) }}</a>
    <span class="summary-version">{{ b.version }}</span>
    <div class="summary-bar" :data-tooltip="barTooltip(b.name, 'no')">
      <div class="bar-yes" :style="{ width: (data.stats[b.name]?.yes / data.stats[b.name]?.total * 100) + '%' }"></div>
      <div class="bar-partial" :style="{ width: (data.stats[b.name]?.partial / data.stats[b.name]?.total * 100) + '%' }"></div>
      <div class="bar-fail" :style="{ width: failBarWidth(b.name) }"></div>
    </div>
    <span class="summary-pct">{{ data.stats[b.name]?.pct }}%</span>
    <span class="summary-counts">
      {{ data.stats[b.name]?.yes }} / {{ data.stats[b.name]?.total }}
    </span>
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
  <label>
    Search:
    <input v-model="filter" type="text" placeholder="Filter features..." />
  </label>
</div>

<div class="matrix-wrapper">
<table class="matrix">
  <thead>
    <tr>
      <th class="feature-col"></th>
      <th v-for="b in sortedBackends" :key="b.name" :data-tooltip="backendTooltip(b.name, b.version)">
        <a class="hover-link" :href="'/terminal/' + backendSlug(b.name)">{{ backendLabel(b.name) }}</a>
      </th>
    </tr>
  </thead>
  <tbody v-for="cat in filteredCategories" :key="cat">
    <tr class="category-row">
      <td :colspan="sortedBackends.length + 1" class="category-header">
        <a class="hover-link" :href="'/' + cat">{{ catLabel(cat) }}</a>
      </td>
    </tr>
    <tr v-for="f in filteredFeatures(cat)" :key="f.id">
      <td class="feature-name">
        <a class="hover-link" :href="'/' + f.category + '/' + featureSlug(f.id)">{{ f.name }}</a>
      </td>
      <td v-for="b in sortedBackends" :key="b.name"
          :class="cellClass(getResult(b.name, f.id))"
          :data-tooltip="cellTooltip(getResult(b.name, f.id), b.name, f.id)">
        {{ cellIcon(getResult(b.name, f.id)) }}
      </td>
    </tr>
  </tbody>
</table>
</div>

<p class="footer-note">
  Hover over any cell for details.<br/>
  Data from <a href="https://termless.dev">Termless</a> census probes.
  {{ data.generated ? 'Generated: ' + data.generated : '' }}
</p>

## How This Works

Data is collected by [Termless](https://termless.dev) census probes — standardized
test sequences sent to **headless terminal emulator libraries**, not the terminal
applications themselves. Each probe writes ANSI escape sequences and reads back
the terminal state via the library's API.

::: warning Headless ≠ Real Terminal
These results test **library implementations** (e.g., `@xterm/headless`, not xterm.js
in VS Code). Some libraries don't expose all features through their headless API —
for example, `@xterm/headless` doesn't report cursor visibility or underline variants,
even though the full xterm.js renderer supports them. Scores reflect **API
completeness**, not the real terminal's capabilities.

We're working on [app-level testing](about) that probes real terminal applications
(iTerm2, Terminal.app, Kitty, Ghostty, Warp) to capture what users actually see.
:::

</div>

<style>
.no-data {
  padding: 2em;
  background: var(--vp-c-danger-soft);
  border-radius: 8px;
  margin: 2em 0;
  text-align: center;
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
  cursor: help;
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
  cursor: help;
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

/* Hover-links: look like normal text, reveal as links on hover */
.hover-link {
  color: inherit;
  text-decoration: none;
  font-weight: inherit;
}

.hover-link:hover {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
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
  white-space: pre-line;
  max-width: 80vw;
  z-index: 100;
  pointer-events: none;
  box-shadow: 0 2px 8px rgba(0,0,0,0.15);
}

/* Don't show empty tooltips */
[data-tooltip=""]:hover::after,
[data-tooltip]:not([data-tooltip]):hover::after {
  display: none;
}

/* Summary bar tooltip appears below the bar */
.summary-bar[data-tooltip]:hover::after {
  bottom: auto;
  top: 100%;
  margin-top: 4px;
  left: 0;
  transform: none;
  max-width: 80vw;
}
</style>
