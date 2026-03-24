---
outline: [2, 3]
prev: false
next: false
---

<script setup>
import { useData } from 'vitepress'
const { params } = useData()
const p = params.value

const categories = JSON.parse(p.categories)

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

const testDate = p.generated ? new Date(p.generated).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : ''
</script>

<div class="backend-page">

# {{ p.terminalName }}

<p v-if="p.terminalDescription" class="terminal-desc">{{ p.terminalDescription }}</p>

<div class="terminal-links">
  <span v-if="p.terminalUrl"><a :href="p.terminalUrl" target="_blank" rel="noopener">{{ p.terminalUrl }}</a></span>
  <span v-if="p.terminalRepo"> · <a :href="p.terminalRepo" target="_blank" rel="noopener">Source</a></span>
  <span v-if="p.terminalAuthor"> · by {{ p.terminalAuthor }}</span>
</div>

<div class="backend-info">
  <strong>Backend:</strong> {{ p.backendDescription }}
  <span v-if="p.backendType"> ({{ p.backendType }})</span>
  <span v-if="p.version"> · v{{ p.version }}</span>
</div>

<p v-if="p.backendCaveat" class="backend-caveat">⚠ {{ p.backendCaveat }}</p>

<div class="score-card">
  <div class="score-number">{{ p.pct }}<span class="score-pct">%</span></div>
  <div class="score-detail">
    <span class="score-yes">{{ p.yes }} passed</span> ·
    <span v-if="Number(p.partial) > 0" class="score-partial">{{ p.partial }} partial · </span>
    <span class="score-no">{{ p.total - p.yes - p.partial }} failed</span>
    <span class="score-total"> of {{ p.total }} features</span>
  </div>
  <div v-if="testDate" class="score-date">Tested: {{ testDate }}</div>
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
      <td><a :href="'/' + f.category + '/' + f.slug">{{ f.name }}</a></td>
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

.backend-caveat {
  background: var(--vp-c-warning-soft);
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 0.9em;
  margin: 1em 0;
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
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.feature-table a:hover {
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
