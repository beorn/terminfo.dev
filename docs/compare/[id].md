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

function cellClass(result) {
  if (result === 'yes') return 'cell-yes'
  if (result === 'partial') return 'cell-partial'
  if (result === 'no') return 'cell-no'
  return 'cell-unknown'
}

function diffClass(f) {
  return f.resultA !== f.resultB ? 'diff-row' : ''
}

function resultLabel(result) {
  if (result === 'yes') return 'Supported'
  if (result === 'partial') return 'Partial support'
  if (result === 'no') return 'Not supported'
  return 'Not tested'
}

function cellTooltip(result, note) {
  if (note) return note
  return resultLabel(result)
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

// Features only terminal A supports (yes/partial) that B doesn't
const onlyAFeatures = []
const onlyBFeatures = []
for (const cat of categories) {
  for (const f of cat.features) {
    const aPass = f.resultA === 'yes' || f.resultA === 'partial'
    const bPass = f.resultB === 'yes' || f.resultB === 'partial'
    if (aPass && !bPass) onlyAFeatures.push({ ...f, categoryLabel: cat.label })
    if (bPass && !aPass) onlyBFeatures.push({ ...f, categoryLabel: cat.label })
  }
}
</script>

<div class="compare-page">

# {{ p.termALabel }} vs {{ p.termBLabel }}

<p class="compare-subtitle">Side-by-side terminal feature comparison</p>

## Summary

<div class="compare-summary">
  <div class="compare-card">
    <a :href="'/terminals/' + p.termASlug" class="compare-card-link">
      <h3>{{ p.termALabel }}</h3>
    </a>
    <div class="compare-score">{{ p.termAPct }}<span class="compare-pct">%</span></div>
    <div class="compare-detail">{{ p.termAPass }}/{{ p.termATotal }} passed</div>
    <div v-if="Number(p.termAPartial) > 0" class="compare-partial">{{ p.termAPartial }} partial</div>
  </div>
  <div class="compare-vs">vs</div>
  <div class="compare-card">
    <a :href="'/terminals/' + p.termBSlug" class="compare-card-link">
      <h3>{{ p.termBLabel }}</h3>
    </a>
    <div class="compare-score">{{ p.termBPct }}<span class="compare-pct">%</span></div>
    <div class="compare-detail">{{ p.termBPass }}/{{ p.termBTotal }} passed</div>
    <div v-if="Number(p.termBPartial) > 0" class="compare-partial">{{ p.termBPartial }} partial</div>
  </div>
</div>

<p class="compare-diff-summary">{{ p.differ }} features differ between these terminals</p>

<div v-if="p.analysis" class="analysis">
  <div class="analysis-header">
    <span class="analysis-label">Analysis</span>
    <span class="analysis-date">{{ p.analysisDate }}</span>
  </div>
  <div class="analysis-body" v-html="p.analysis"></div>
  <p v-if="p.analysisChanges" class="analysis-changes">{{ p.analysisChanges }}</p>
</div>

## Feature Comparison

<div v-for="cat in categories" :key="cat.name" class="compare-category">

### {{ cat.label }}

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
      <td :class="cellClass(f.resultA)" :data-tooltip="cellTooltip(f.resultA, f.noteA)"><a class="cell-link" :href="'/' + f.category + '/' + f.slug">{{ icon(f.resultA) }}</a></td>
      <td :class="cellClass(f.resultB)" :data-tooltip="cellTooltip(f.resultB, f.noteB)"><a class="cell-link" :href="'/' + f.category + '/' + f.slug">{{ icon(f.resultB) }}</a></td>
    </tr>
  </tbody>
</table>

</div>

<div v-if="onlyAFeatures.length > 0">

## Only in {{ p.termALabel }}

<p class="only-in-desc">{{ onlyAFeatures.length }} features supported by {{ p.termALabel }} but not {{ p.termBLabel }}:</p>

<ul class="only-list">
  <li v-for="f in onlyAFeatures" :key="f.id">
    <a :href="'/' + f.category + '/' + f.slug">{{ f.name }}</a>
    <span class="only-cat">{{ f.categoryLabel }}</span>
  </li>
</ul>

</div>

<div v-if="onlyBFeatures.length > 0">

## Only in {{ p.termBLabel }}

<p class="only-in-desc">{{ onlyBFeatures.length }} features supported by {{ p.termBLabel }} but not {{ p.termALabel }}:</p>

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

.compare-summary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2em;
  margin: 2em 0;
}

.compare-card {
  text-align: center;
  padding: 1.5em 2em;
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  min-width: 200px;
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
