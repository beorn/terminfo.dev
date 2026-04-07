---
outline: [2, 3]
prev: false
next: false
---

<script setup>
import { useData } from 'vitepress'
const { params } = useData()
const p = params.value

const categories = p.categories ? JSON.parse(p.categories) : []
const versions = p.versions ? JSON.parse(p.versions) : []

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

function featureTooltip(f) {
  const parts = [f.name]
  if (f.tags?.length) parts.push('Tags: ' + f.tags.join(', '))
  if (f.specUrl) parts.push('Spec: ' + f.specUrl.replace(/^https?:\/\//, ''))
  return parts.join('\n')
}

const testDate = p.generated ? new Date(p.generated).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : ''
const isHistorical = p.historical === 'true'

const typeBadge = (() => {
  const t = p.terminalType
  if (t === 'historical') return { label: 'Historical Terminal', cls: 'badge-historical', note: 'Reference entry \u2014 no automated probe data' }
  if (t === 'mux') return { label: 'Multiplexer', cls: 'badge-mux', note: '' }
  if (t === 'headless') return { label: 'Headless Backend', cls: 'badge-backend', note: '' }
  if (t === 'app+headless') return { label: 'App Terminal + Parser Backend', cls: 'badge-dual', note: '' }
  return { label: 'App Terminal', cls: 'badge-app', note: '' }
})()

const crossLinks = {
  'vt100-historical': [
    { text: 'VT100 standard features', link: '/vt100' },
    { text: 'vt100.js (headless backend)', link: '/terminals/vt100-js' },
  ],
  'vt100-js': [
    { text: 'VT100 standard features', link: '/vt100' },
    { text: 'DEC VT100 (historical)', link: '/terminals/vt100-historical' },
  ],
  'vt220-historical': [
    { text: 'VT220 standard features', link: '/vt220' },
  ],
  'xterm-historical': [
    { text: 'Xterm Extensions standard', link: '/xterm-extensions' },
    { text: 'xterm.js (headless backend)', link: '/terminals/xterm-js' },
  ],
  'xterm-js': [
    { text: 'Xterm Extensions standard', link: '/xterm-extensions' },
    { text: 'xterm (historical)', link: '/terminals/xterm-historical' },
  ],
  'kitty': [
    { text: 'Kitty Extensions standard', link: '/kitty-extensions' },
  ],
}
const relatedPages = crossLinks[p.id] ?? []

const breadcrumbParent = (() => {
  const t = p.terminalType
  if (t === 'headless') return { label: 'Parser Backends', link: '/backends' }
  if (t === 'mux') return { label: 'Multiplexers', link: '/multiplexers' }
  if (t === 'historical') return { label: 'Historical', link: '/terminals' }
  return { label: 'Terminals', link: '/terminals' }
})()
</script>

<div class="backend-page">

<nav class="breadcrumb">
  <a href="/terminals">Terminals</a>
  <template v-if="breadcrumbParent.label !== 'Terminals'">
    <span class="sep">›</span>
    <a :href="breadcrumbParent.link">{{ breadcrumbParent.label }}</a>
  </template>
  <span class="sep">›</span>
  <span>{{ p.terminalName }}</span>
</nav>

# {{ p.terminalName }}

<span :class="['terminal-type-badge', typeBadge.cls]">{{ typeBadge.label }}</span>

<p v-if="typeBadge.note" class="badge-note">{{ typeBadge.note }}</p>

<p v-if="p.terminalDescription" class="terminal-desc">{{ p.terminalDescription }}</p>

<div v-if="relatedPages.length" class="see-also">
  See also: <span v-for="(r, i) in relatedPages"><a :href="r.link">{{ r.text }}</a><span v-if="i < relatedPages.length - 1"> · </span></span>
</div>

<div v-if="isHistorical" class="historical-badge">
  <span class="historical-icon">&#x1F4DC;</span>
  <span>Historical Terminal · {{ p.year }} · {{ p.manufacturer }}</span>
</div>

<div class="terminal-links">
  <span v-if="p.terminalUrl"><a :href="p.terminalUrl" target="_blank" rel="noopener">{{ p.terminalUrl }}</a></span>
  <span v-if="p.terminalRepo"> · <a :href="p.terminalRepo" target="_blank" rel="noopener">Source</a></span>
  <span v-if="p.terminalAuthor"> · by {{ p.terminalAuthor }}</span>
</div>

<div v-if="p.terminalBody" class="terminal-body" v-html="p.terminalBody"></div>

<div v-if="isHistorical && p.significance" class="historical-significance">
  <strong>Significance:</strong> {{ p.significance }}
</div>

<div v-if="!isHistorical && p.backendDescription" class="backend-info">
  <strong>Backend:</strong> {{ p.backendDescription }}
  <span v-if="p.backendType"> ({{ p.backendType }})</span>
  <span v-if="p.version"> · v{{ p.version }}</span>
</div>

<p v-if="p.backendCaveat" class="backend-caveat">&#x26A0; {{ p.backendCaveat }}</p>

<p v-if="p.inheritedFrom" class="inherited-note">
  Feature results inherited from
  <a :href="'/terminals/' + p.inheritedFromSlug">{{ p.inheritedFromLabel }}</a>
  &mdash; this terminal uses the same underlying engine and is not probed separately.
</p>

<div v-if="!isHistorical && p.total" class="score-card">
  <div class="score-number">{{ p.pct }}<span class="score-pct">%</span></div>
  <div class="score-detail">
    <span class="score-yes">{{ p.yes }} passed</span> ·
    <span v-if="Number(p.partial) > 0" class="score-partial">{{ p.partial }} partial · </span>
    <span class="score-no">{{ p.total - p.yes - p.partial }} failed</span>
    <span class="score-total"> of {{ p.total }} features</span>
  </div>
  <div v-if="testDate" class="score-date">Tested: {{ testDate }}</div>
</div>

<div v-if="p.analysis" class="analysis">
  <div class="analysis-header">
    <span class="analysis-label">Analysis</span>
    <span class="analysis-date">{{ p.analysisDate }}</span>
  </div>
  <div class="analysis-body" v-html="p.analysis"></div>
  <p v-if="p.analysisChanges" class="analysis-changes">{{ p.analysisChanges }}</p>
</div>

<div v-if="versions.length > 1" class="version-history">
  <h2 id="version-history">Version History</h2>
  <table class="version-table">
    <thead>
      <tr>
        <th>Version</th>
        <th>Support</th>
        <th class="version-pct-header">Score</th>
        <th class="version-counts-header">Features</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="v in versions" :key="v.version" :class="{ 'version-current': v.version === p.version }">
        <td class="version-name">{{ v.version }}</td>
        <td class="version-bar-cell">
          <div class="version-bar">
            <div class="version-bar-fill" :style="{ width: (v.yes / v.total * 100) + '%' }"></div>
          </div>
        </td>
        <td class="version-pct">{{ v.pct }}%</td>
        <td class="version-counts">{{ v.yes }} / {{ v.total }}</td>
      </tr>
    </tbody>
  </table>
</div>

<div v-for="cat in categories" :key="cat.name" class="category-section">

<h2 :id="cat.name">{{ cat.label }}</h2>

<table class="feature-table">
  <thead>
    <tr>
      <th>Feature</th>
      <th>Support</th>
      <th>Notes</th>
    </tr>
  </thead>
  <tbody>
    <tr v-for="f in cat.features" :key="f.id">
      <td :data-tooltip="featureTooltip(f)"><a :href="'/' + f.category + '/' + f.slug">{{ f.name }}</a></td>
      <td :class="cls(f.result)" class="result-cell">{{ icon(f.result) }} {{ f.result }}</td>
      <td class="note-cell">{{ f.note }}</td>
    </tr>
  </tbody>
</table>

</div>

<p class="back-link">
  <a href="/">← Back to matrix</a>
</p>

</div>

<style>
.backend-page {
  max-width: 800px;
}

.terminal-desc {
  font-size: 1.1em;
  color: var(--vp-c-text-2);
  margin-top: -0.5em;
  line-height: 1.6;
}

.see-also {
  color: var(--vp-c-text-3);
  font-size: 0.9em;
  margin: 0.5em 0 1em;
}

.see-also a {
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.see-also a:hover {
  text-decoration: underline;
}

.terminal-links {
  color: var(--vp-c-text-3);
  font-size: 0.9em;
  margin: 0.5em 0 1em;
}

.terminal-links a {
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.terminal-links a:hover {
  text-decoration: underline;
}

.backend-desc {
  font-size: 1.1em;
  color: var(--vp-c-text-2);
  margin-top: -0.5em;
}

.backend-meta {
  color: var(--vp-c-text-3);
  font-size: 0.9em;
  margin: 0.5em 0;
}

.backend-meta a {
  color: var(--vp-c-brand-1);
}

.backend-meta code {
  font-size: 0.9em;
}

.terminal-body {
  margin: 1.5em 0;
  color: var(--vp-c-text-2);
  line-height: 1.7;
}

.terminal-body p {
  margin: 0.75em 0;
}

.backend-info {
  color: var(--vp-c-text-3);
  font-size: 0.9em;
  margin: 1em 0;
}

.backend-caveat {
  background: var(--vp-c-warning-soft);
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 0.9em;
  margin: 1em 0;
}

.inherited-note {
  background: var(--vp-c-brand-soft);
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 0.9em;
  margin: 1em 0;
  color: var(--vp-c-text-2);
  border-left: 3px solid var(--vp-c-brand-1);
}

.inherited-note a {
  color: var(--vp-c-brand-1);
  font-weight: 600;
  text-decoration: none;
}

.inherited-note a:hover {
  text-decoration: underline;
}

.score-card {
  background: var(--vp-c-bg-soft);
  border-radius: 8px;
  padding: 1.5em;
  margin: 1.5em 0;
  text-align: center;
}

.score-number {
  font-size: 3em;
  font-weight: 700;
  line-height: 1;
}

.score-pct {
  font-size: 0.5em;
  color: var(--vp-c-text-3);
}

.score-detail {
  margin-top: 0.5em;
  font-size: 0.95em;
}

.score-yes { color: #10b981; }
.score-partial { color: #f59e0b; }
.score-no { color: #ef4444; }
.score-total { color: var(--vp-c-text-3); }

.score-date {
  margin-top: 0.5em;
  font-size: 0.85em;
  color: var(--vp-c-text-3);
}

.category-section {
  margin-top: 2em;
}

.feature-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9em;
  margin: 1em 0;
}

.feature-table th,
.feature-table td {
  padding: 8px 12px;
  border: 1px solid var(--vp-c-divider);
  text-align: left;
}

.feature-table th {
  background: var(--vp-c-bg-soft);
  font-weight: 600;
}

.feature-table a {
  color: inherit;
  text-decoration: none;
}

.feature-table a:hover {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
}

.result-cell {
  font-weight: 600;
  white-space: nowrap;
}

.note-cell {
  color: var(--vp-c-text-2);
  font-size: 0.95em;
}

/* cell-yes, cell-partial, cell-no, cell-unknown: use shared result-cells.css */

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

.historical-badge {
  display: flex;
  align-items: center;
  gap: 0.5em;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 0.75em 1em;
  margin: 0.75em 0 1em;
  font-size: 0.95em;
  color: var(--vp-c-text-2);
}

.historical-icon {
  font-size: 1.3em;
}

.historical-significance {
  color: var(--vp-c-text-2);
  font-size: 0.95em;
  margin: 1em 0;
  padding: 0.75em 1em;
  background: var(--vp-c-bg-soft);
  border-radius: 6px;
  border-left: 3px solid var(--vp-c-brand-1);
}

.terminal-type-badge {
  display: inline-block;
  font-size: 0.8em;
  font-weight: 600;
  padding: 2px 10px;
  border-radius: 999px;
  margin-top: -0.5em;
  margin-bottom: 0.25em;
  line-height: 1.6;
}

.badge-app {
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
}

.badge-dual {
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
}

.badge-backend {
  background: var(--vp-c-indigo-soft);
  color: var(--vp-c-indigo-1);
}

.badge-mux {
  background: var(--vp-c-purple-soft);
  color: var(--vp-c-purple-1);
}

.badge-historical {
  background: var(--vp-c-yellow-soft);
  color: var(--vp-c-yellow-1);
}

.badge-note {
  font-size: 0.85em;
  color: var(--vp-c-text-3);
  margin-top: 0;
  margin-bottom: 0.5em;
  font-style: italic;
}

.version-history {
  margin-top: 2em;
}

.version-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9em;
  margin: 1em 0;
}

.version-table th,
.version-table td {
  padding: 8px 12px;
  border: 1px solid var(--vp-c-divider);
  text-align: left;
}

.version-table th {
  background: var(--vp-c-bg-soft);
  font-weight: 600;
}

.version-name {
  font-family: var(--vp-font-family-mono);
  font-size: 0.95em;
  white-space: nowrap;
}

.version-current .version-name {
  font-weight: 700;
}

.version-bar-cell {
  width: 40%;
}

.version-bar {
  width: 100%;
  height: 12px;
  background: var(--vp-c-bg-soft);
  border-radius: 6px;
  overflow: hidden;
}

.version-bar-fill {
  height: 100%;
  background: #10b981;
  border-radius: 6px;
  transition: width 0.3s ease;
}

.version-pct {
  font-weight: 600;
  white-space: nowrap;
  text-align: right;
}

.version-pct-header {
  text-align: right;
}

.version-counts {
  color: var(--vp-c-text-3);
  white-space: nowrap;
  text-align: right;
}

.version-counts-header {
  text-align: right;
}
</style>
