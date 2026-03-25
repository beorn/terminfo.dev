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
</script>

<div class="category-page">

# {{ p.categoryName }}

<p v-if="p.categoryDescription" class="category-desc">{{ p.categoryDescription }}</p>

<p class="category-meta">
  {{ p.featureCount }} features in this {{ p.pageType === 'tag' ? 'standard' : 'category' }}
  <span v-if="p.specUrl"> · <a :href="p.specUrl" target="_blank" rel="noopener">Specification ↗</a></span>
</p>

## Support Matrix

<div class="matrix-wrapper">
<table class="matrix">
  <thead>
    <tr>
      <th class="feature-col">Feature</th>
      <th v-for="b in backends" :key="b.name" :data-tooltip="termTooltip(b)">
        <a :href="'/terminal/' + b.slug">{{ b.label }}</a>
      </th>
    </tr>
  </thead>
  <tbody>
    <tr v-for="f in features" :key="f.id">
      <td class="feature-name" :data-tooltip="featureTooltip(f)">
        <a :href="'/' + f.category + '/' + f.slug">{{ f.name }}</a>
      </td>
      <td v-for="b in backends" :key="b.name"
          :class="cls(f.results[b.name]?.result)"
          :data-tooltip="tooltip(f.results[b.name]?.result, f.results[b.name]?.note)">
        <a class="cell-link" :href="'/' + f.category + '/' + f.slug">{{ icon(f.results[b.name]?.result) }}</a>
      </td>
    </tr>
  </tbody>
</table>
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
