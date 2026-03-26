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
    - theme: alt
      text: Multiplexers
      link: "#multiplexers"
---

<script setup>
import { ref, computed } from 'vue'
import { data } from './data/probes.data'

const filter = ref('')
const categoryFilter = ref('all')
const baselineFilter = ref('all')
const platformFilter = ref('all')

// Baseline metadata for filter dropdown
const baselineOptions = [
  { id: 'core', label: 'Core', count: data.baselines.core?.length ?? 0 },
  { id: 'modern', label: 'Modern', count: data.baselines.modern?.length ?? 0 },
  { id: 'rich', label: 'Rich', count: data.baselines.rich?.length ?? 0 },
  { id: 'unicode', label: 'Unicode', count: data.baselines.unicode?.length ?? 0 },
]

// Set of feature IDs in selected baseline
const baselineFeatureIds = computed(() => {
  if (baselineFilter.value === 'all') return null
  return new Set(data.baselines[baselineFilter.value] ?? [])
})

const categoryOrder = ['sgr', 'cursor', 'text', 'erase', 'editing', 'modes', 'scrollback', 'reset', 'extensions', 'charsets', 'device', 'input', 'graphics', 'unicode']
const categoryLabels = data.categoryLabels ?? {}

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
const muxBackends = computed(() => sortedBackends.value.filter(b => b.type === 'mux'))

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
  <p>No probe data available yet.</p>
</div>

<div v-else>

## Terminal Applications {#terminal-applications}

<p class="section-subtitle">Tested on real terminal applications. Don't see your terminal? <a href="https://www.npmjs.com/package/terminfo.dev">Contribute results</a> with <code>npx terminfo.dev submit</code></p>

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

## Terminal Baseline 2026 {#baselines}

<p class="section-subtitle">Inspired by <a href="https://web.dev/baseline">Web Baseline</a> — minimum feature sets that terminals should support</p>

<div class="baseline-grid">
  <a v-for="bl in ['core', 'modern', 'rich', 'unicode']" :key="bl" class="baseline-card baseline-card-link" :href="'/baseline/' + bl">
    <div class="baseline-header">
      <span class="baseline-icon">{{ bl === 'core' ? '🟢' : bl === 'modern' ? '🔵' : bl === 'rich' ? '🟣' : '🌐' }}</span>
      <span class="baseline-name">{{ bl.charAt(0).toUpperCase() + bl.slice(1) }}</span>
      <span class="baseline-count">{{ data.baselines[bl]?.length ?? 0 }} features</span>
    </div>
    <div class="baseline-desc">{{ bl === 'core' ? 'Every terminal should support these — SGR basics, cursor, erase, alt screen' : bl === 'modern' ? 'Expected by modern TUIs — truecolor, bracketed paste, focus events, mouse' : bl === 'rich' ? 'Advanced features — kitty keyboard, graphics, hyperlinks, semantic prompts' : 'Unicode correctness — wide chars, combining, emoji, grapheme clusters' }}</div>
    <div class="baseline-backends">
      <div v-for="b in appBackends" :key="b.name" class="baseline-backend">
        <span class="baseline-backend-name">{{ backendLabel(b.name) }}</span>
        <span class="baseline-backend-bar">
          <span class="baseline-fill" :style="{ width: (data.baselineStats[b.name]?.[bl]?.pct ?? 0) + '%', background: bl === 'core' ? '#10b981' : bl === 'modern' ? '#3b82f6' : bl === 'rich' ? '#8b5cf6' : '#06b6d4' }"></span>
        </span>
        <span class="baseline-backend-pct">{{ data.baselineStats[b.name]?.[bl]?.pct ?? 0 }}%</span>
      </div>
    </div>
  </a>
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
    Baseline:
    <select v-model="baselineFilter">
      <option value="all">All</option>
      <option v-for="bl in baselineOptions" :key="bl.id" :value="bl.id">
        {{ bl.label }} ({{ bl.count }})
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
      <th v-for="b in appBackends" :key="b.name">
        <a class="hover-link" :href="'/terminal/' + termSlug(b.name)" :data-tooltip="backendTooltip(b.name, b.version)">{{ backendLabel(b.name) }}</a>
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

### Headless Baseline Coverage

<div class="baseline-grid">
  <a v-for="bl in ['core', 'modern', 'rich', 'unicode']" :key="bl" class="baseline-card baseline-card-link" :href="'/baseline/' + bl">
    <div class="baseline-header">
      <span class="baseline-icon">{{ bl === 'core' ? '🟢' : bl === 'modern' ? '🔵' : bl === 'rich' ? '🟣' : '🌐' }}</span>
      <span class="baseline-name">{{ bl.charAt(0).toUpperCase() + bl.slice(1) }}</span>
    </div>
    <div class="baseline-backends">
      <div v-for="b in headlessBackends" :key="b.name" class="baseline-backend">
        <span class="baseline-backend-name">{{ backendLabel(b.name) }}</span>
        <span class="baseline-backend-bar">
          <span class="baseline-fill" :style="{ width: (data.baselineStats[b.name]?.[bl]?.pct ?? 0) + '%', background: bl === 'core' ? '#10b981' : bl === 'modern' ? '#3b82f6' : bl === 'rich' ? '#8b5cf6' : '#06b6d4' }"></span>
        </span>
        <span class="baseline-backend-pct">{{ data.baselineStats[b.name]?.[bl]?.pct ?? 0 }}%</span>
      </div>
    </div>
  </a>
</div>

<div class="matrix-wrapper">
<table class="matrix matrix-muted">
  <thead>
    <tr>
      <th class="feature-col"></th>
      <th v-for="b in headlessBackends" :key="b.name">
        <a class="hover-link" :href="'/terminal/' + termSlug(b.name)" :data-tooltip="backendTooltip(b.name, b.version)">{{ backendLabel(b.name) }}</a>
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

<div v-if="muxBackends.length > 0">

## Multiplexers {#multiplexers}

<p class="section-subtitle">Which features survive tmux and screen? Pass-through testing shows what each multiplexer correctly relays.</p>

<div class="summary summary-muted">
  <div v-for="b in muxBackends" :key="b.name" class="summary-row">
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
      <th v-for="b in muxBackends" :key="b.name">
        <a class="hover-link" :href="'/terminal/' + termSlug(b.name)" :data-tooltip="backendTooltip(b.name, b.version)">{{ backendLabel(b.name) }}</a>
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
      <td class="feature-name" :data-tooltip="featureTooltip(f)">
        <a class="hover-link" :href="'/' + f.category + '/' + featureSlug(f.id)">{{ f.name }}</a>
      </td>
      <td v-for="b in muxBackends" :key="b.name"
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
  Data from <a href="https://termless.dev">Termless</a> probes and <a href="https://www.npmjs.com/package/terminfo.dev">community submissions</a>.
  {{ data.generated ? 'Generated: ' + data.generated : '' }}
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
  <a href="/terminal/vt100-historical" class="explore-card">
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
  <a href="/compare/ghostty-vs-kitty" class="explore-card">
    <h3>Compare</h3>
    <p>Side-by-side terminal feature comparison.</p>
  </a>
</div>

## How This Works

Data comes from three complementary sources:

**Terminal Applications** — tested on real terminals via the `npx terminfo.dev` community CLI.
Each test sends escape sequences to the actual terminal and verifies behavior via cursor
position reports, device attribute queries, and rendered width measurements. These results
reflect what users actually experience.

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

/* Baseline 2026 cards */
.baseline-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin: 1em 0 2em;
}

@media (max-width: 900px) {
  .baseline-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 500px) {
  .baseline-grid {
    grid-template-columns: 1fr;
  }
}

.baseline-card {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 12px;
  background: var(--vp-c-bg-soft);
}

.baseline-card-link,
.baseline-card-link:link,
.baseline-card-link:visited {
  color: inherit;
  text-decoration: none !important;
  display: block;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
  cursor: pointer;
}

.baseline-card-link:hover {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
}

/* Prevent VitePress link styling inside baseline cards */
/* Lock ALL text inside baseline cards to inherit color — prevent VitePress a:hover blue */
.baseline-card-link,
.baseline-card-link:hover,
.baseline-card-link:hover * {
  color: inherit !important;
  text-decoration: none !important;
}

/* Only the baseline tier name gets brand color on hover */
.baseline-card-link:hover .baseline-name {
  color: var(--vp-c-brand-1) !important;
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

.baseline-backends {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.baseline-backend {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.8em;
}

.baseline-backend-name {
  width: 80px;
  flex-shrink: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 0.95em;
}

.baseline-backend-bar {
  flex: 1;
  height: 10px;
  background: var(--vp-c-bg);
  border-radius: 3px;
  overflow: hidden;
}

.baseline-fill {
  display: block;
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s ease;
}

.baseline-backend-pct {
  width: 32px;
  text-align: right;
  font-weight: 600;
  flex-shrink: 0;
}

/* Matrix table — page scrolls naturally, only headers stick */
.matrix-wrapper {
  margin: 1em 0;
  overflow: visible;
}

/* Override VitePress default table overflow-x:auto which breaks sticky */
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

[data-tooltip]:hover {
  z-index: 50;
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
