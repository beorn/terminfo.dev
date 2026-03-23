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
  mode: 'Modes',
  scrollback: 'Scrollback',
  reset: 'Reset',
  extension: 'Extensions',
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

function hasNote(backend, featureId) {
  const note = data.notes[backend]?.[featureId]
  return note && note.length > 0
}

function cellClass(result, backend, featureId) {
  const base = result === 'yes' ? 'cell-yes' : result === 'partial' ? 'cell-partial' : result === 'no' ? 'cell-no' : 'cell-unknown'
  return hasNote(backend, featureId) ? base + ' has-note' : base
}

function cellIcon(result) {
  if (result === 'yes') return '✓'
  if (result === 'partial') return '~'
  if (result === 'no') return '✗'
  return '?'
}

function catLabel(cat) {
  return categoryLabels[cat] ?? cat.charAt(0).toUpperCase() + cat.slice(1)
}

function backendLabel(name) {
  const labels = {
    xtermjs: 'xterm.js',
    vt100: 'vt100',
    'vt100-rust': 'vt100-rust',
    ghostty: 'Ghostty',
    'ghostty-native': 'Ghostty Native',
    wezterm: 'WezTerm',
    alacritty: 'Alacritty',
    kitty: 'Kitty',
  }
  return labels[name] ?? name
}
</script>

<div v-if="data.backends.length === 0" class="no-data">
  <p>No census data available yet.</p>
</div>

<div v-else>

## Backend Summary {#summary}

<div class="summary">
  <div v-for="b in sortedBackends" :key="b.name" class="summary-row">
    <span class="summary-name">{{ backendLabel(b.name) }}</span>
    <span class="summary-version">{{ b.version }}</span>
    <div class="summary-bar">
      <div class="bar-yes" :style="{ width: (data.stats[b.name]?.yes / data.stats[b.name]?.total * 100) + '%' }"></div>
      <div class="bar-partial" :style="{ width: (data.stats[b.name]?.partial / data.stats[b.name]?.total * 100) + '%' }"></div>
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
      <th class="feature-col">Feature</th>
      <th v-for="b in sortedBackends" :key="b.name">{{ backendLabel(b.name) }}</th>
    </tr>
  </thead>
  <tbody v-for="cat in filteredCategories" :key="cat">
    <tr class="category-row">
      <td :colspan="sortedBackends.length + 1" class="category-header">
        {{ catLabel(cat) }}
      </td>
    </tr>
    <tr v-for="f in filteredFeatures(cat)" :key="f.id">
      <td class="feature-name" :title="f.spec ? 'Spec: ' + f.spec : ''">{{ f.name }}</td>
      <td v-for="b in sortedBackends" :key="b.name"
          :class="cellClass(getResult(b.name, f.id), b.name, f.id)"
          :title="getNote(b.name, f.id)">
        {{ cellIcon(getResult(b.name, f.id)) }}
      </td>
    </tr>
  </tbody>
</table>
</div>

<p class="footer-note">
  Cells with a dot (•) have additional notes — hover to see details.<br/>
  Data from <a href="https://termless.dev">Termless</a> census probes.
  {{ data.generated ? 'Generated: ' + data.generated : '' }}
</p>

## How This Works

Data is collected by [Termless](https://termless.dev) census probes — standardized
test sequences sent to each terminal backend. Each probe writes ANSI escape sequences
and reads back the terminal state to verify whether the feature was correctly processed.

The census covers SGR attributes, cursor movement, text handling, erase operations,
terminal modes, scrollback behavior, and modern extensions like kitty keyboard protocol
and OSC 8 hyperlinks.

Results are fully automated and reproducible — no manual testing, no self-reported
capabilities.

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
  overflow: hidden;
  display: flex;
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

/* Matrix table */
.matrix-wrapper {
  overflow-x: auto;
  margin: 1em 0;
}

.matrix {
  border-collapse: collapse;
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
  top: 0;
  z-index: 1;
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

/* Cells with notes get a dot indicator */
.has-note {
  cursor: help;
  position: relative;
}

.has-note::after {
  content: '•';
  position: absolute;
  top: 1px;
  right: 3px;
  font-size: 0.7em;
  color: var(--vp-c-text-3);
  line-height: 1;
}

.footer-note {
  font-size: 0.8em;
  color: var(--vp-c-text-3);
  margin-top: 1.5em;
}
</style>
