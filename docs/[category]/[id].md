---
outline: [2, 3]
---

<script setup>
import { useData } from 'vitepress'
const { params } = useData()
const p = params.value

const backendResults = JSON.parse(p.backendResults)

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
  <span v-if="p.specUrl"> · <a :href="p.specUrl" target="_blank" rel="noopener">Specification ↗</a></span>
</p>

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
  max-width: 800px;
}

.feature-meta {
  color: var(--vp-c-text-2);
  font-size: 0.95em;
  margin-top: -0.5em;
}

.feature-meta a {
  color: var(--vp-c-brand-1);
}

.feature-score {
  font-size: 1.1em;
  margin: 1em 0;
}

.support-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9em;
  margin: 1em 0;
}

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
