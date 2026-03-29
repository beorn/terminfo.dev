---
outline: [2, 3]
prev: false
next: false
---

<script setup>
import { useData } from 'vitepress'
const { params } = useData()
const p = params.value

const backendResults = JSON.parse(p.backendResults)
const featureTags = JSON.parse(p.featureTags || '[]')
const subFeatures = JSON.parse(p.subFeatures || '[]')
const backendNames = JSON.parse(p.backendNames || '[]')
const appResults = backendResults.filter(r => r.type === 'app')
const headlessResults = backendResults.filter(r => r.type === 'headless')
const appBackends = backendNames.filter(b => b.type === 'app')
const headlessBackends = backendNames.filter(b => b.type === 'headless')

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

function termTooltip(r) {
  const parts = [r.label]
  if (r.description) parts.push(r.description)
  if (r.version) parts.push('Version: ' + r.version)
  return parts.join('\n')
}
</script>

<div class="feature-page">

<nav class="breadcrumb">
  <a href="/features">Features</a>
  <span class="sep">›</span>
  <a :href="'/' + p.featureCategory">{{ p.categoryLabel }}</a>
  <span class="sep">›</span>
  <span>{{ p.featureName }}</span>
</nav>

# {{ p.featureName }}

<p class="feature-meta">
  Category: <a :href="'/' + p.featureCategory">{{ p.featureCategory }}</a>
  <span v-if="featureTags.length"> · Tags: <template v-for="(tag, i) in featureTags" :key="tag.id"><a :href="'/' + tag.id">{{ tag.label }}</a><template v-if="i < featureTags.length - 1">, </template></template></span>
  <span v-if="p.specUrl"> · <a :href="p.specUrl" target="_blank" rel="noopener">Specification ↗</a></span>
</p>

<div v-if="p.sequence" class="feature-sequence">
  <code>{{ p.sequence }}</code>
</div>

<div v-if="p.featureBody" class="feature-body" v-html="p.featureBody"></div>

<div v-if="p.probeMethod" class="probe-method">
  <strong>How this is tested:</strong> <span v-html="p.probeMethod"></span>
</div>

<div v-if="p.analysis" class="analysis">
  <div class="analysis-header">
    <span class="analysis-label">Analysis</span>
    <span class="analysis-date">{{ p.analysisDate }}</span>
  </div>
  <div class="analysis-body" v-html="p.analysis"></div>
  <p v-if="p.analysisChanges" class="analysis-changes">{{ p.analysisChanges }}</p>
</div>

<p class="feature-score">
  Supported by <strong>{{ p.yesCount }}</strong> of <strong>{{ p.totalCount }}</strong> backends ({{ Math.round(p.yesCount / p.totalCount * 100) }}%)
</p>

## Terminal Applications

<table v-if="appResults.length > 0" class="support-table">
  <thead>
    <tr>
      <th>Terminal</th>
      <th>Version</th>
      <th>Support</th>
      <th>Notes</th>
    </tr>
  </thead>
  <tbody>
    <tr v-for="r in appResults" :key="r.name">
      <td :data-tooltip="termTooltip(r)"><a :href="'/terminals/' + r.slug">{{ r.label }}</a></td>
      <td class="version-cell">{{ r.version }}</td>
      <td :class="cls(r.result)" class="result-cell">{{ icon(r.result) }} {{ r.result }}</td>
      <td class="note-cell">
        {{ r.note }}
        <a v-if="r.url" :href="r.url" target="_blank" rel="noopener" class="upstream-link"> ↗ upstream</a>
      </td>
    </tr>
  </tbody>
</table>
<p v-else class="no-data-inline">No app results yet.</p>

<div v-if="headlessResults.length > 0">

## Headless Backends

<p class="headless-note">Parser correctness only — a <span class="cell-yes-inline">✓</span> means the parser accepts the sequence.</p>

<table class="support-table support-table-muted">
  <thead>
    <tr>
      <th>Backend</th>
      <th>Version</th>
      <th>Support</th>
      <th>Notes</th>
    </tr>
  </thead>
  <tbody>
    <tr v-for="r in headlessResults" :key="r.name">
      <td :data-tooltip="termTooltip(r)"><a :href="'/terminals/' + r.slug">{{ r.label }}</a></td>
      <td class="version-cell">{{ r.version }}</td>
      <td :class="cls(r.result)" class="result-cell">{{ icon(r.result) }} {{ r.result }}</td>
      <td class="note-cell">
        {{ r.note }}
        <a v-if="r.url" :href="r.url" target="_blank" rel="noopener" class="upstream-link"> ↗ upstream</a>
      </td>
    </tr>
  </tbody>
</table>

</div>

<div v-if="subFeatures.length > 0" class="sub-features-section">

## Sub-features

<p class="sub-features-note">This feature has {{ subFeatures.length }} individually testable sub-features.</p>

<table class="support-table sub-features-table">
  <thead>
    <tr>
      <th>Sub-feature</th>
      <th v-for="b in appBackends" :key="b.name" class="backend-col">{{ b.label }}</th>
    </tr>
  </thead>
  <tbody>
    <tr v-for="sf in subFeatures" :key="sf.id">
      <td><a :href="'/' + p.featureCategory + '/' + sf.slug">{{ sf.name }}</a></td>
      <td v-for="b in appBackends" :key="b.name" :class="cls(sf.results[b.name] || 'unknown')" class="result-cell">{{ icon(sf.results[b.name] || 'unknown') }}</td>
    </tr>
  </tbody>
</table>

</div>

<p class="back-link">
  <a href="/">← Back to matrix</a> · <a :href="'/' + p.featureCategory">{{ p.featureCategory }} features</a>
</p>

</div>

<style>
.feature-page {
  max-width: 100%;
}

.feature-meta {
  color: var(--vp-c-text-2);
  font-size: 0.95em;
  margin-top: -0.5em;
}

.feature-meta a {
  color: var(--vp-c-brand-1);
}

.feature-sequence {
  margin: 0.75em 0;
}

.feature-sequence code {
  font-family: var(--vp-font-family-mono);
  font-size: 1.1em;
  padding: 6px 12px;
  border-radius: 6px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  letter-spacing: 0.5px;
}

.feature-body {
  color: var(--vp-c-text-2);
  font-size: 0.95em;
  line-height: 1.7;
  margin: 1em 0 1.5em;
}

.feature-body code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.9em;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
}

.probe-method {
  font-size: 0.88em;
  color: var(--vp-c-text-3);
  line-height: 1.6;
  margin: 0.75em 0 1.5em;
  padding: 0.6em 0.8em;
  border-left: 3px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  border-radius: 0 4px 4px 0;
}

.probe-method strong {
  color: var(--vp-c-text-2);
}

.probe-method code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.9em;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--vp-c-bg-alt);
  color: var(--vp-c-text-1);
}

.feature-score {
  font-size: 1.1em;
  margin: 1em 0;
}

.support-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 0.9em;
  margin: 1em 0;
}

/* Column proportions: Backend 20%, Version 10%, Support 10%, Notes 60% */
.support-table th:nth-child(1),
.support-table td:nth-child(1) { width: 20%; }
.support-table th:nth-child(2),
.support-table td:nth-child(2) { width: 10%; }
.support-table th:nth-child(3),
.support-table td:nth-child(3) { width: 10%; }
.support-table th:nth-child(4),
.support-table td:nth-child(4) { width: 60%; }

.support-table th,
.support-table td {
  padding: 8px 12px;
  border: 1px solid var(--vp-c-divider);
  text-align: left;
}

.support-table th {
  background: var(--vp-c-bg-soft);
  font-weight: 600;
}

.support-table a {
  color: inherit;
  text-decoration: none;
}

.support-table a:hover {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
}

.version-cell {
  font-family: var(--vp-font-family-mono);
  font-size: 0.9em;
  color: var(--vp-c-text-3);
}

.result-cell {
  font-weight: 600;
  white-space: nowrap;
}

.note-cell {
  color: var(--vp-c-text-2);
  font-size: 0.95em;
  word-wrap: break-word;
  overflow-wrap: break-word;
}

/* cell-yes, cell-partial, cell-no, cell-unknown: use shared result-cells.css */

.cell-yes-inline {
  color: #10b981;
  font-weight: 700;
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

.support-table-muted {
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

.sub-features-note {
  color: var(--vp-c-text-2);
  font-size: 0.9em;
  margin-top: -0.5em;
}

.sub-features-table .backend-col {
  font-size: 0.8em;
  text-align: center;
  white-space: nowrap;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sub-features-table .result-cell {
  text-align: center;
  width: 40px;
  min-width: 40px;
  padding: 4px 6px;
  font-size: 0.9em;
}
</style>
