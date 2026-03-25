---
outline: [2, 3]
prev: false
next: false
---

<script setup>
import { useData } from 'vitepress'
const { params } = useData()
const p = params.value

const features = JSON.parse(p.features)
const backends = JSON.parse(p.backends)
const appBackends = backends.filter(b => b.type === 'app')
const headlessBackends = backends.filter(b => b.type === 'headless')

function icon(result) {
  if (result === 'yes') return '✓'
  if (result === 'partial') return '~'
  if (result === 'no') return '✗'
  return '?'
}

function cls(result) {
  if (result === 'yes') return 'cell-yes'
  if (result === 'partial') return 'cell-partial'
  if (result === 'no') return 'cell-no'
  return 'cell-unknown'
}

function tooltip(result, note) {
  if (note) return note
  if (result === 'yes') return 'supported'
  if (result === 'partial') return 'partial support'
  if (result === 'no') return 'not supported'
  return 'Not tested — no probe data for this terminal'
}

function featureTooltip(f) {
  const parts = [f.name]
  if (f.tags?.length) parts.push('Tags: ' + f.tags.join(', '))
  if (f.url) parts.push('Spec: ' + f.url.replace(/^https?:\/\//, ''))
  return parts.join('\n')
}

function termTooltip(b) {
  const parts = [b.label]
  if (b.version) parts.push('Version: ' + b.version)
  return parts.join('\n')
}

function platformIcon(os) {
  if (os === 'macos') return '<svg viewBox="0 0 16 16" width="14" height="14" style="vertical-align:-2px"><path d="M12.2 5.5c-.1 0-1.6.9-1.6 2.8 0 2.2 1.9 3 2 3-.1.1-.3 1.1-1 2.2-.6 1-1.3 1.9-2.3 1.9s-1.3-.6-2.4-.6c-1.2 0-1.6.6-2.5.6-.9 0-1.6-.9-2.3-2C1.3 12 .8 10.2.8 8.6c0-2.6 1.7-4 3.3-4 .9 0 1.6.6 2.2.6.5 0 1.4-.6 2.4-.6.4 0 1.8.1 2.6 1.3-.1 0-1.5.9-1.5 2.6h.4z" fill="#888"/><path d="M10 1c.5.6.9 1.5.8 2.4-.8.1-1.7-.4-2.2-1.1-.5-.6-.9-1.5-.8-2.3.9 0 1.7.4 2.2 1z" fill="#888"/></svg>'
  if (os === 'linux') return '<svg viewBox="0 0 16 16" width="14" height="14" style="vertical-align:-2px"><path d="M8 1C5.8 1 4 3.4 4 6.4c0 1.5.4 2.8 1.1 3.8-.5.3-1.5 1-1.5 2.1 0 .4.1.8.4 1.1.5.5 1.4.6 2.2.6h3.6c.8 0 1.7-.1 2.2-.6.3-.3.4-.7.4-1.1 0-1.1-1-1.8-1.5-2.1.7-1 1.1-2.3 1.1-3.8C12 3.4 10.2 1 8 1zm-1.5 5c-.4 0-.8-.4-.8-.8s.4-.8.8-.8.8.4.8.8-.4.8-.8.8zm3 0c-.4 0-.8-.4-.8-.8s.4-.8.8-.8.8.4.8.8-.4.8-.8.8z" fill="#888"/></svg>'
  if (os === 'windows') return '<svg viewBox="0 0 16 16" width="14" height="14" style="vertical-align:-2px"><path d="M1 3.5l5.5-.8v5.3H1V3.5zm6.3-.9L15 1.5v6.5H7.3V2.6zM15 8.5v6.3l-7.7-1.1V8.5H15zM6.5 13.5L1 12.8V8.5h5.5v5z" fill="#888"/></svg>'
  return ''
}

function platformIcons(b) {
  if (!b.platforms?.length) return ''
  return b.platforms.map(p => platformIcon(p)).filter(Boolean).join(' ')
}
</script>

<div class="category-page">

# {{ p.categoryName }}

<p v-if="p.categoryDescription" class="category-desc">{{ p.categoryDescription }}</p>

<p class="category-meta">
  {{ p.featureCount }} features in this {{ p.pageType === 'tag' ? 'standard' : 'category' }}
  <span v-if="p.specUrl"> · <a :href="p.specUrl" target="_blank" rel="noopener">Specification ↗</a></span>
</p>

<div v-if="p.analysis" class="analysis">
  <div class="analysis-header">
    <span class="analysis-label">Analysis</span>
    <span class="analysis-date">{{ p.analysisDate }}</span>
  </div>
  <div class="analysis-body" v-html="p.analysis"></div>
  <p v-if="p.analysisChanges" class="analysis-changes">{{ p.analysisChanges }}</p>
</div>

## Terminal Applications

<div v-if="appBackends.length > 0" class="matrix-wrapper">
<table class="matrix">
  <thead>
    <tr>
      <th class="feature-col">Feature</th>
      <th v-for="b in appBackends" :key="b.name" :data-tooltip="termTooltip(b)">
        <a :href="'/terminal/' + b.slug">{{ b.label }}</a>
        <span class="th-platforms" v-html="platformIcons(b)"></span>
      </th>
    </tr>
  </thead>
  <tbody>
    <tr v-for="f in features" :key="f.id">
      <td class="feature-name" :data-tooltip="featureTooltip(f)">
        <a :href="'/' + f.category + '/' + f.slug">{{ f.name }}</a>
      </td>
      <td v-for="b in appBackends" :key="b.name"
          :class="cls(f.results[b.name]?.result)"
          :data-tooltip="tooltip(f.results[b.name]?.result, f.results[b.name]?.note)">
        <a class="cell-link" :href="'/' + f.category + '/' + f.slug">{{ icon(f.results[b.name]?.result) }}</a>
      </td>
    </tr>
  </tbody>
</table>
</div>
<p v-else class="no-data-inline">No app results yet. Run <code>npx terminfo.dev submit</code> to contribute.</p>

<div v-if="headlessBackends.length > 0">

## Headless Backends

<p class="headless-note">Parser correctness tested via <a href="https://termless.dev">Termless</a>. A <span class="cell-yes-inline">✓</span> means the parser accepts the sequence, not that it renders correctly.</p>

<div class="matrix-wrapper">
<table class="matrix matrix-muted">
  <thead>
    <tr>
      <th class="feature-col">Feature</th>
      <th v-for="b in headlessBackends" :key="b.name" :data-tooltip="termTooltip(b)">
        <a :href="'/terminal/' + b.slug">{{ b.label }}</a>
      </th>
    </tr>
  </thead>
  <tbody>
    <tr v-for="f in features" :key="f.id">
      <td class="feature-name" :data-tooltip="featureTooltip(f)">
        <a :href="'/' + f.category + '/' + f.slug">{{ f.name }}</a>
      </td>
      <td v-for="b in headlessBackends" :key="b.name"
          :class="cls(f.results[b.name]?.result)"
          :data-tooltip="tooltip(f.results[b.name]?.result, f.results[b.name]?.note)">
        <a class="cell-link" :href="'/' + f.category + '/' + f.slug">{{ icon(f.results[b.name]?.result) }}</a>
      </td>
    </tr>
  </tbody>
</table>
</div>

</div>

<p class="back-link">
  <a href="/">← Back to matrix</a>
</p>

</div>

<style>
.category-page {
  max-width: 100%;
}

.category-desc {
  font-size: 1.05em;
  color: var(--vp-c-text-2);
  margin-top: -0.5em;
}

.category-meta {
  color: var(--vp-c-text-3);
  font-size: 0.9em;
}

.category-meta a {
  color: var(--vp-c-brand-1);
}

.matrix-wrapper {
  margin: 1em 0;
}

/* Override VitePress default table overflow-x:auto which clips tooltips */
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
}

.matrix th a {
  color: inherit;
  text-decoration: none;
}

.matrix th a:hover {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
}

.th-platforms {
  display: flex;
  gap: 2px;
  justify-content: center;
  margin-top: 2px;
}

.feature-col {
  text-align: left !important;
}

.feature-name {
  text-align: left !important;
  white-space: nowrap;
  font-size: 0.95em;
}

.feature-name a {
  color: inherit;
  text-decoration: none;
}

.feature-name a:hover {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
}

/* Cell links — inherit cell color, fill the entire cell */
.cell-link,
.cell-link:link,
.cell-link:visited {
  color: inherit !important;
  text-decoration: none !important;
  display: block;
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

/* Tooltips */
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
  white-space: pre-line;
  text-align: left;
  max-width: 80vw;
  z-index: 100;
  pointer-events: none;
  box-shadow: 0 2px 8px rgba(0,0,0,0.15);
}

[data-tooltip=""]:hover::after {
  display: none;
}

.no-data-inline {
  color: var(--vp-c-text-3);
  font-size: 0.9em;
  font-style: italic;
}

.headless-note {
  padding: 0.75em 1em;
  background: var(--vp-c-bg-soft);
  border-left: 3px solid var(--vp-c-text-3);
  border-radius: 4px;
  font-size: 0.85em;
  color: var(--vp-c-text-2);
  margin-bottom: 1em;
}

.headless-note a {
  color: var(--vp-c-brand-1);
}

.cell-yes-inline {
  color: #10b981;
  font-weight: 700;
}

.matrix-muted {
  opacity: 0.85;
}

.back-link {
  margin-top: 2em;
  font-size: 0.9em;
}

.back-link a {
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.back-link a:hover {
  text-decoration: underline;
}
</style>
