---
outline: [2, 3]
prev: false
next: false
---

<script setup>
import { useData } from 'vitepress'
import { data } from '../data/probes.data'
const { params } = useData()
const p = params.value

const categories = JSON.parse(p.categories)

function diffClass(f) {
  return f.comparable && ((f.resultA === 'yes' && f.resultB === 'no') || (f.resultA === 'no' && f.resultB === 'yes')) ? 'diff-row' : ''
}

function featureTooltip(f) {
  const parts = [f.name]
  if (f.tags?.length) parts.push('Tags: ' + f.tags.join(', '))
  if (f.url) parts.push('Spec: ' + f.url.replace(/^https?:\/\//, ''))
  return parts.join('\n')
}

function termTooltip(label, description, type, url) {
  const parts = []
  if (description) parts.push(description)
  if (type) parts.push('Type: ' + type)
  if (url) parts.push(url)
  return parts.join('\n') || label
}

// Only opposing results in the jointly conclusive, same-method cohort establish a difference.
const onlyAFeatures = []
const onlyBFeatures = []
for (const cat of categories) {
  for (const f of cat.features) {
    if (f.comparable && f.resultA === 'yes' && f.resultB === 'no') onlyAFeatures.push({ ...f, categoryLabel: cat.label })
    if (f.comparable && f.resultB === 'yes' && f.resultA === 'no') onlyBFeatures.push({ ...f, categoryLabel: cat.label })
  }
}
</script>

<div class="compare-page">

<nav class="breadcrumb">
  <span>Compare</span>
  <span class="sep">›</span>
  <span>{{ p.termALabel }} vs {{ p.termBLabel }}</span>
</nav>

# {{ p.termALabel }} vs {{ p.termBLabel }}

<p class="compare-subtitle">Side-by-side selected terminal observations</p>

<p v-if="p.comparableScope === 'true'" class="compare-scope">
  Counts use jointly conclusive results from matching recorded contexts, suites and methods. Other environment differences may remain.
</p>
<p v-else class="compare-scope compare-scope--limited">
  Recorded contexts or suites differ or are incomplete. Inspect each result below; no pairwise support difference is claimed.
</p>

## Summary

<div class="compare-summary">
  <div class="compare-card">
    <a :href="'/terminals/' + p.termASlug" class="compare-card-link">
      <h3>{{ p.termALabel }}</h3>
    </a>
    <p class="compare-context"><strong>{{ p.termAVersion }}</strong> · {{ p.termAKind }} · {{ p.termAOs }} {{ p.termAOsVersion }}</p>
    <div v-if="p.comparableScope === 'true' && p.jointConclusive !== '0'" class="compare-score">{{ p.supportedA }}/{{ p.jointConclusive }}</div>
    <div v-if="p.comparableScope === 'true'" class="compare-detail">{{ p.jointConclusive === '0' ? 'No shared features measured conclusively by the same method' : 'supported on shared features measured by the same method' }}</div>
    <div v-else class="compare-detail">This run: {{ p.termAPass }} supported of {{ p.termATotal }} conclusive observations</div>
    <details class="compare-run-details"><summary>Run details</summary><dl class="compare-context-details">
      <dt>Configuration</dt><dd>{{ p.termAConfig }}</dd>
      <dt>Permissions</dt><dd>{{ p.termAPermissions }}</dd>
      <dt>Outer terminal</dt><dd>{{ p.termAOuter }}</dd>
      <dt>Multiplexer</dt><dd>{{ p.termAMux }}</dd>
      <dt>Suite</dt><dd>{{ p.termASuite }} · {{ p.termASuiteComplete === 'true' ? 'complete' : 'incomplete' }}</dd>
    </dl></details>
  </div>
  <div class="compare-vs">vs</div>
  <div class="compare-card">
    <a :href="'/terminals/' + p.termBSlug" class="compare-card-link">
      <h3>{{ p.termBLabel }}</h3>
    </a>
    <p class="compare-context"><strong>{{ p.termBVersion }}</strong> · {{ p.termBKind }} · {{ p.termBOs }} {{ p.termBOsVersion }}</p>
    <div v-if="p.comparableScope === 'true' && p.jointConclusive !== '0'" class="compare-score">{{ p.supportedB }}/{{ p.jointConclusive }}</div>
    <div v-if="p.comparableScope === 'true'" class="compare-detail">{{ p.jointConclusive === '0' ? 'No shared features measured conclusively by the same method' : 'supported on shared features measured by the same method' }}</div>
    <div v-else class="compare-detail">This run: {{ p.termBPass }} supported of {{ p.termBTotal }} conclusive observations</div>
    <details class="compare-run-details"><summary>Run details</summary><dl class="compare-context-details">
      <dt>Configuration</dt><dd>{{ p.termBConfig }}</dd>
      <dt>Permissions</dt><dd>{{ p.termBPermissions }}</dd>
      <dt>Outer terminal</dt><dd>{{ p.termBOuter }}</dd>
      <dt>Multiplexer</dt><dd>{{ p.termBMux }}</dd>
      <dt>Suite</dt><dd>{{ p.termBSuite }} · {{ p.termBSuiteComplete === 'true' ? 'complete' : 'incomplete' }}</dd>
    </dl></details>
  </div>
</div>

<p v-if="p.comparableScope === 'true' && p.jointConclusive !== '0'" class="compare-diff-summary">{{ p.differ }} differences among {{ p.jointConclusive }} shared features measured conclusively by the same method</p>

## Feature Comparison

<div v-for="cat in categories" :key="cat.name" class="compare-category">

### {{ cat.label }}

<div class="compare-table-scroll">
<table class="compare-table">
  <thead>
    <tr>
      <th class="feature-col">Feature</th>
      <th :data-tooltip="termTooltip(p.termALabel, p.termADescription, p.termAType, p.termAUrl)">
        <a :href="'/terminals/' + p.termASlug">{{ p.termALabel }}</a>
      </th>
      <th :data-tooltip="termTooltip(p.termBLabel, p.termBDescription, p.termBType, p.termBUrl)">
        <a :href="'/terminals/' + p.termBSlug">{{ p.termBLabel }}</a>
      </th>
    </tr>
  </thead>
  <tbody>
    <tr v-for="f in cat.features" :key="f.id" :class="diffClass(f)">
      <td class="feature-name" :data-tooltip="featureTooltip(f)"><a :href="'/' + f.category + '/' + f.slug">{{ f.name }}</a></td>
      <td><ResultEvidenceCell :feature-id="f.id" :feature-name="f.name" :target-name="p.termALabel"
        :version="data.selectedByBackend[p.termAId]?.selected" :cell="data.selectedByBackend[p.termAId]?.selected.cells[f.id]" /></td>
      <td><ResultEvidenceCell :feature-id="f.id" :feature-name="f.name" :target-name="p.termBLabel"
        :version="data.selectedByBackend[p.termBId]?.selected" :cell="data.selectedByBackend[p.termBId]?.selected.cells[f.id]" /></td>
    </tr>
  </tbody>
</table>
</div>

</div>

<div v-if="onlyAFeatures.length > 0">

## Supported in {{ p.termALabel }}, unsupported in {{ p.termBLabel }}

<p class="only-in-desc">{{ onlyAFeatures.length }} comparable observations support this difference:</p>

<ul class="only-list">
  <li v-for="f in onlyAFeatures" :key="f.id">
    <a :href="'/' + f.category + '/' + f.slug">{{ f.name }}</a>
    <span class="only-cat">{{ f.categoryLabel }}</span>
  </li>
</ul>

</div>

<div v-if="onlyBFeatures.length > 0">

## Supported in {{ p.termBLabel }}, unsupported in {{ p.termALabel }}

<p class="only-in-desc">{{ onlyBFeatures.length }} comparable observations support this difference:</p>

<ul class="only-list">
  <li v-for="f in onlyBFeatures" :key="f.id">
    <a :href="'/' + f.category + '/' + f.slug">{{ f.name }}</a>
    <span class="only-cat">{{ f.categoryLabel }}</span>
  </li>
</ul>

</div>

<p class="back-link">
  <a href="/">← Back to matrix</a>
</p>

</div>

<style>
.compare-page {
  max-width: 900px;
}

.compare-subtitle {
  font-size: 1.05em;
  color: var(--vp-c-text-2);
  margin-top: -0.5em;
}

.compare-scope {
  padding: 0.75em 1em;
  border-left: 3px solid var(--vp-c-brand-1);
  background: var(--vp-c-bg-soft);
}

.compare-scope--limited {
  border-left-color: var(--vp-c-warning-1);
}

.compare-summary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2em;
  margin: 2em 0;
}

.compare-card {
  box-sizing: border-box;
  text-align: center;
  padding: 1.5em 2em;
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  min-width: 200px;
}

.compare-context {
  overflow-wrap: anywhere;
}

.compare-run-details {
  margin-top: 0.75em;
  text-align: left;
  font-size: 0.9em;
}

.compare-run-details summary {
  cursor: pointer;
}

.compare-context-details {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.25em 0.5em;
  text-align: left;
  font-size: 0.8em;
}

.compare-context-details dt {
  color: var(--vp-c-text-2);
}

.compare-context-details dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.compare-card h3 {
  margin: 0 0 0.5em;
  font-size: 1.2em;
}

.compare-card-link {
  color: inherit;
  text-decoration: none;
}

.compare-card-link:hover h3 {
  color: var(--vp-c-brand-1);
}

.compare-score {
  font-size: 2.5em;
  font-weight: 700;
  color: var(--vp-c-brand-1);
  line-height: 1;
}

.compare-pct {
  font-size: 0.4em;
  color: var(--vp-c-text-3);
}

.compare-detail {
  margin-top: 0.3em;
  font-size: 0.9em;
  color: var(--vp-c-text-2);
}

.compare-partial {
  font-size: 0.85em;
  color: #f59e0b;
}

.compare-vs {
  font-size: 1.2em;
  color: var(--vp-c-text-3);
  font-weight: 600;
}

.compare-diff-summary {
  text-align: center;
  color: var(--vp-c-text-3);
  font-size: 0.95em;
}

.compare-category {
  margin-top: 2em;
}

.compare-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9em;
  margin: 1em 0;
}

.compare-table-scroll {
  max-width: 100%;
  overflow-x: auto;
}

@media (max-width: 640px) {
  .compare-summary {
    flex-direction: column;
    gap: 0.75em;
  }

  .compare-card {
    width: 100%;
    min-width: 0;
  }
}

.compare-table th,
.compare-table td {
  padding: 6px 12px;
  border: 1px solid var(--vp-c-divider);
}

.compare-table th {
  background: var(--vp-c-bg-soft);
  font-weight: 600;
  text-align: center;
  font-size: 0.95em;
}

.compare-table th a {
  color: inherit;
  text-decoration: none;
}

.compare-table th a:hover {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
}

.feature-col {
  text-align: left !important;
}

.feature-name {
  text-align: left !important;
  white-space: nowrap;
}

.feature-name a {
  color: inherit;
  text-decoration: none;
}

.feature-name a:hover {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
}

.compare-table td {
  text-align: center;
}

/* cell-yes, cell-no, cell-partial, cell-unknown, cell-link, diff-row
   are in shared theme/result-cells.css */

.only-in-desc {
  color: var(--vp-c-text-2);
  font-size: 0.95em;
}

.only-list {
  list-style: none;
  padding: 0;
}

.only-list li {
  padding: 4px 0;
  display: flex;
  align-items: center;
  gap: 0.75em;
}

.only-list a {
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.only-list a:hover {
  text-decoration: underline;
}

.only-cat {
  font-size: 0.8em;
  color: var(--vp-c-text-3);
  background: var(--vp-c-bg-soft);
  padding: 1px 6px;
  border-radius: 4px;
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
