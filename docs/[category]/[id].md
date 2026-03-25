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
</script>

<div class="feature-page">

# {{ p.featureName }}

<p class="feature-meta">
  Category: <a :href="'/' + p.featureCategory">{{ p.featureCategory }}</a>
  <span v-if="featureTags.length"> · Tags: <template v-for="(tag, i) in featureTags" :key="tag.id"><a :href="'/' + tag.id">{{ tag.label }}</a><template v-if="i < featureTags.length - 1">, </template></template></span>
  <span v-if="p.specUrl"> · <a :href="p.specUrl" target="_blank" rel="noopener">Specification ↗</a></span>
</p>

<div v-if="p.featureBody" class="feature-body" v-html="p.featureBody"></div>

<div v-if="p.probeMethod" class="probe-method">
  <strong>How this is tested:</strong> <span v-html="p.probeMethod"></span>
</div>

<p class="feature-score">
  Supported by <strong>{{ p.yesCount }}</strong> of <strong>{{ p.totalCount }}</strong> backends ({{ Math.round(p.yesCount / p.totalCount * 100) }}%)
</p>

## Support Matrix

<table class="support-table">
  <thead>
    <tr>
      <th>Backend</th>
      <th>Version</th>
      <th>Support</th>
      <th>Notes</th>
    </tr>
  </thead>
  <tbody>
    <tr v-for="r in backendResults" :key="r.name">
      <td><a :href="'/terminal/' + r.slug">{{ r.label }}</a></td>
      <td class="version-cell">{{ r.version }}</td>
      <td :class="cls(r.result)" class="result-cell">{{ icon(r.result) }} {{ r.result }}</td>
      <td class="note-cell">
        {{ r.note }}
        <a v-if="r.url" :href="r.url" target="_blank" rel="noopener" class="upstream-link"> ↗ upstream</a>
      </td>
    </tr>
  </tbody>
</table>

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
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.support-table a:hover {
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

.cell-yes { color: #10b981; }
.cell-partial { color: #f59e0b; }
.cell-no { color: #ef4444; }
.cell-unknown { color: #8b5cf6; }

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
