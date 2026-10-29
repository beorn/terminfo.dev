---
outline: [2, 3]
prev: false
next: false
---

<script setup>
import { useData } from 'vitepress'
import { computed, ref } from 'vue'
import { data } from '../data/probes.data'
import { aggregateCurrentResults, currentCoverageSentence, isStaleRelation, staleCaption, currentSupportedShare, publicResultFor } from '../data/release-scope.ts'
import { hasCurrentSource } from '../data/run-selection.ts'
const { params } = useData()
const p = params.value

const categories = p.categories ? JSON.parse(p.categories) : []
const defaultRun = data.selectedByBackend[p.backendId]?.selected
const recordedRuns = JSON.parse(p.otherRuns || '[]')
// Empty selection explicitly means composed context; run hashes select original documents only.
const runSha = ref('')
const selectedRun = computed(() => runSha.value ? recordedRuns.find(run => run.sha256 === runSha.value) : defaultRun)
const sourceRuns = computed(() => !selectedRun.value ? [] : 'sources' in selectedRun.value ? Object.values(selectedRun.value.sources) : [selectedRun.value])
const sourceVersions = computed(() => [...new Set(sourceRuns.value.map(run => run.subject.version))].join(', '))
const measuredBar = computed(() => {
  const selection = selectedRun.value
  if (!selection) return undefined
  return aggregateCurrentResults('cells' in selection ? Object.values(selection.cells) : selection.results, selection.catalogIds)
})
const measuredShare = computed(() => measuredBar.value ? currentSupportedShare(measuredBar.value) : '')
function featureNote(id) {
  const result = publicResultFor(selectedRun.value, id)
  return result?.reason || ''
}
const stale = computed(() => !hasCurrentSource(sourceRuns.value))
const staleText = computed(() => stale.value ? sourceRuns.value.map(run => `${run.runId}: ${staleCaption(run.measuredAt)}`).join('; ') : '')
function runLabel(run) {
  return `${run.subject.version} · ${run.subject.os || 'OS not recorded'} · ${run.subject.permissions || 'No permission override recorded'} · ${run.sha256.slice(0, 8)}`
}

function featureTooltip(f) {
  const parts = [f.name]
  if (f.tags?.length) parts.push('Tags: ' + f.tags.join(', '))
  if (f.specUrl) parts.push('Spec: ' + f.specUrl.replace(/^https?:\/\//, ''))
  return parts.join('\n')
}

const testDate = computed(() => sourceRuns.value.map(run => `${run.runId}: ${run.measuredAt}`).join('; '))
const isHistorical = p.historical === 'true'
const isCurrentApp = !isHistorical && (p.terminalType === 'term' || p.terminalType === 'term+lib')

const typeBadge = (() => {
  const t = p.terminalType
  if (t === 'historical') return { label: 'Historical Terminal', cls: 'badge-historical', note: 'Reference entry \u2014 no automated probe data' }
  if (t === 'mux') return { label: 'Multiplexer', cls: 'badge-mux', note: '' }
  if (t === 'lib') return { label: 'Headless Backend', cls: 'badge-backend', note: '' }
  if (t === 'term+lib') return { label: 'App Terminal + Parser Backend', cls: 'badge-dual', note: '' }
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
  'headless-kitty': [
    { text: 'Kitty application results', link: '/terminals/kitty' },
  ],
}
const relatedPages = crossLinks[p.id] ?? []

const breadcrumbParent = (() => {
  const t = p.terminalType
  if (t === 'lib') return { label: 'Parser Backends', link: '/backends' }
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
  <span v-if="p.terminalUrl"><a :href="p.terminalUrl" target="_blank" rel="noopener">Website</a></span>
  <span v-if="p.terminalRepo"> · <a :href="p.terminalRepo" target="_blank" rel="noopener">Source</a></span>
  <span v-if="p.terminalAuthor"> · by {{ p.terminalAuthor }}</span>
</div>

<details v-if="p.terminalBody && isCurrentApp" class="terminal-about">
  <summary>About {{ p.terminalName }}</summary>
  <div class="terminal-body" v-html="p.terminalBody"></div>
</details>
<div v-else-if="p.terminalBody" class="terminal-body" v-html="p.terminalBody"></div>

<div v-if="isHistorical && p.significance" class="historical-significance">
  <strong>Significance:</strong> {{ p.significance }}
</div>

<div v-if="!isHistorical && !isCurrentApp && p.backendDescription" class="backend-info">
  <strong>Backend:</strong> {{ p.backendDescription }}
  <span v-if="p.backendType"> ({{ p.backendType }})</span>
  <span v-if="selectedRun || p.version"> · v{{ sourceVersions || p.version }}</span>
</div>

<p v-if="p.backendCaveat" class="backend-caveat">&#x26A0; {{ p.backendCaveat }}</p>

<p v-if="p.inheritedFrom" class="inherited-note">
  Feature results inherited from
  <a :href="'/terminals/' + p.inheritedFromSlug">{{ p.inheritedFromLabel }}</a>
  &mdash; this terminal uses the same underlying engine and is not probed separately.
</p>

<p v-if="!defaultRun && !isHistorical">No composed context is available.</p>

<div v-if="measuredBar" class="score-card">
  <h2 class="results-heading">Feature support</h2>
  <p v-if="stale" class="stale-line">{{ staleText }}</p>
  <p class="selected-run">{{ p.terminalName }} · Source versions: {{ sourceVersions }} · {{ selectedRun.subject?.os || 'OS not recorded' }} · Original measurements: {{ testDate }}</p>
  <p class="result-share-label" :title="currentCoverageSentence(measuredBar, selectedRun.catalogIds)">{{ measuredShare }}</p>
  <p>{{ currentCoverageSentence(measuredBar, selectedRun.catalogIds) }}</p>
  <div v-if="measuredBar.denominator > 0" class="result-share" aria-hidden="true">
    <span v-if="measuredBar.counts.supported" class="result-share-supported" :style="{ width: `${measuredBar.counts.supported / measuredBar.denominator * 100}%` }"></span>
    <span v-if="measuredBar.counts.unsupported" class="result-share-unsupported" :style="{ width: `${measuredBar.counts.unsupported / measuredBar.denominator * 100}%` }"></span>
    <span v-if="measuredBar.counts.untestable" class="result-share-inconclusive" :style="{ width: `${measuredBar.counts.untestable / measuredBar.denominator * 100}%` }"></span>
    <span v-if="measuredBar.counts['test-todo']" class="result-share-not-tested" :style="{ width: `${measuredBar.counts['test-todo'] / measuredBar.denominator * 100}%` }"></span>
    <span v-if="measuredBar.counts['test-failure']" class="result-share-error" :style="{ width: `${measuredBar.counts['test-failure'] / measuredBar.denominator * 100}%` }"></span>
  </div>
  <p>Selection {{ selectedRun.complete ? 'complete' : 'incomplete' }}. Completion and feature support are separate.</p>
</div>

<details v-if="selectedRun" class="run-context">
  <summary>Test environment and recorded versions</summary>

  <p>Each feature retains its original run, version, suite and measurement date. Results from different suites are not directly comparable.</p>
  <div v-if="recordedRuns.length" class="run-picker">
    <label for="reviewed-run">Composed context or original run</label>
    <select id="reviewed-run" v-model="runSha">
      <option v-if="defaultRun" value="">Composed context (default)</option>
      <option v-for="run in recordedRuns" :key="run.sha256" :value="run.sha256">Original run · {{ runLabel(run) }}</option>
    </select>
    <p>Choosing another record replaces the counts and evidence below. Choices include current configurations and older measurements; the matrix uses the default context.</p>
  </div>

  <ul>
    <li v-for="run in sourceRuns" :key="run.runId">Original run <code>{{ run.runId }}</code> · {{ run.subject.version }} · measured {{ run.measuredAt }} · suite <code>{{ run.suiteId }}</code> · {{ run.suiteFreshness }} · SHA-256 <code>{{ run.sha256 }}</code></li>
  </ul>
  <dl>
    <dt>Subject</dt><dd>{{ selectedRun.subject?.kind }} · {{ selectedRun.subject?.id }}</dd>
    <dt>OS</dt><dd>{{ selectedRun.subject?.os || 'Not recorded' }} {{ selectedRun.subject?.osVersion || '' }}</dd>
    <dt>Permissions</dt><dd>{{ selectedRun.subject?.permissions || 'No explicit override recorded' }}</dd>
    <dt>Configuration</dt><dd><code>{{ selectedRun.subject?.config || 'Not recorded' }}</code></dd>
    <dt>Outer terminal / multiplexer</dt><dd>{{ selectedRun.subject?.outerTerminal || 'None recorded' }} / {{ selectedRun.subject?.mux || 'None recorded' }}</dd>
  </dl>
</details>

<details v-if="p.analysis && !runSha" class="analysis">
  <summary>Analysis · {{ p.analysisDate }}</summary>
  <div class="analysis-body" v-html="p.analysis"></div>
  <p v-if="p.analysisChanges" class="analysis-changes">{{ p.analysisChanges }}</p>
</details>

<p v-if="selectedRun">Select a result to see its notes and evidence. Results marked “Images” include screenshots.</p>

<div v-for="cat in selectedRun ? categories : []" :key="cat.name" class="category-section">

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
      <td class="result-cell"><ResultEvidenceCell :feature-id="f.id" :probe-guidance="data.featureDescriptions[f.id]?.probe" :feature-name="f.name" :subject-name="p.backendName"
        :version="selectedRun" :cell="publicResultFor(selectedRun, f.id)" display="text" /></td>
      <td class="note-cell">{{ featureNote(f.id) }}</td>
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

.run-picker { margin: 1.5rem 0; }
.run-picker label { display: block; font-weight: 600; margin-bottom: 0.5rem; }
.run-picker select { width: 100%; padding: 0.6rem; border: 1px solid var(--vp-c-divider); border-radius: 6px; background: var(--vp-c-bg); }
.run-picker p { font-size: 0.85rem; color: var(--vp-c-text-2); }
.run-context { margin: 1rem 0; }
.run-context summary { cursor: pointer; font-weight: 600; }
.run-context dt { font-weight: 600; margin-top: 0.6rem; }
.run-context dd { margin: 0; overflow-wrap: anywhere; }

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
}

.score-card .results-heading {
  margin: 0;
  padding: 0;
  border: 0;
  font-size: 1.25em;
  font-weight: 600;
}

.tier-line { margin: 0.75em 0 0.25em; font-weight: 600; }
.stale-line { margin: 0 0 0.5em; color: var(--vp-c-text-2); }
.unmeasured { margin: 1em 0; }
.selected-run { margin: 0.5em 0 1em; color: var(--vp-c-text-2); }
.terminal-about summary, .analysis summary { cursor: pointer; font-weight: 600; }

.score-card .run-picker { margin: 1em 0; }
.result-verdict { margin: 1em 0 0.35em; font-weight: 600; }
.result-verdict-detail { font-weight: 400; color: var(--vp-c-text-2); }
.result-share-label { margin: 0 0 0.35em; font-weight: 400; color: var(--vp-c-text-2); }
.result-share { display: flex; height: 12px; overflow: hidden; border-radius: 6px; background: var(--vp-c-divider); }
.result-share span { display: block; height: 100%; }
.result-share-supported { background: #10b981; }
.result-share-unsupported { background: #ef4444; }
.result-share-inconclusive { background: #8b5cf6; }
.result-share-not-tested { background: var(--vp-c-text-3); }
.result-share-error { background: #a34620; }

.score-card .result-counts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(95px, 1fr));
  gap: 0.5em 1em;
  padding: 0;
  list-style: none;
}

.score-card .result-counts li {
  margin: 0;
  padding-top: 0.35em;
  border-top: 3px solid;
}
.score-card .result-counts li:nth-child(1) { border-color: #10b981; }
.score-card .result-counts li:nth-child(2) { border-color: #ef4444; }
.score-card .result-counts li:nth-child(3) { border-color: #8b5cf6; }
.score-card .result-counts li:nth-child(4) { border-color: var(--vp-c-text-3); }
.score-card .result-counts li:nth-child(5) { border-color: #a34620; }
.score-card .result-counts strong { display: block; font-size: 1.35em; }
.score-card .result-counts small { display: block; color: var(--vp-c-text-2); font-size: 0.8em; }

.result-counting summary {
  cursor: pointer;
}

.score-detail,
.result-counting {
  margin-top: 0.5em;
  font-size: 0.95em;
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

@media (max-width: 640px) {
  .backend-page .feature-table td:first-child {
    overflow-wrap: anywhere;
  }

  .backend-page .feature-table th:last-child,
  .backend-page .feature-table .note-cell {
    display: none;
  }
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
