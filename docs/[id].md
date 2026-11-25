---
outline: [2, 3]
prev: false
next: false
---

<script setup>
import { publicResultFor } from './data/release-scope'
import { useData } from 'vitepress'
import { data } from './data/probes.data'
import { platformIcon } from './.vitepress/theme/platform-icons.ts'
import { renderFlatMatrixBodyHtml } from './.vitepress/theme/matrix-cells.ts'
const { params } = useData()
const p = params.value

const features = JSON.parse(p.features)
const backends = JSON.parse(p.backends)
const appBackends = backends.filter(b => b.type === 'term')
const headlessBackends = backends.filter(b => b.type === 'lib')

const crossLinks = {
  'vt100': [
    { text: 'DEC VT100 (historical terminal)', link: '/terminals/vt100-historical' },
    { text: 'vt100.js (headless backend)', link: '/terminals/vt100-js' },
  ],
  'vt220': [
    { text: 'DEC VT220 (historical terminal)', link: '/terminals/vt220-historical' },
  ],
  'xterm-extensions': [
    { text: 'xterm (historical terminal)', link: '/terminals/xterm-historical' },
    { text: 'xterm.js (headless backend)', link: '/terminals/xterm-js' },
  ],
  'kitty-extensions': [
    { text: 'Kitty (terminal app)', link: '/terminals/kitty' },
  ],
}
const relatedPages = crossLinks[p.id] ?? []

function featureTooltip(f) {
  const parts = [f.name]
  if (f.tags?.length) parts.push('Tags: ' + f.tags.join(', '))
  if (f.url) parts.push('Spec: ' + f.url.replace(/^https?:\/\//, ''))
  return parts.join('\n')
}

function termTooltip(b) {
  const parts = []
  if (b.description) parts.push(b.description)
  if (b.type) parts.push('Type: ' + b.type)
  if (b.version) parts.push('Source versions: ' + b.version)
  if (b.url) parts.push(b.url)
  return parts.join('\n') || b.label
}

function platformIcons(b) {
  if (!b.platforms?.length) return ''
  return b.platforms.map(p => platformIcon(p)).filter(Boolean).join(' ')
}

const selectionFor = (name) => data.selectedByBackend[name]?.selected
const featureById = new Map(features.map((f) => [f.id, f]))
const backendLabelByName = new Map(backends.map((b) => [b.name, b.label]))
const matrixFeatureRows = features.map((f) => ({
  id: f.id,
  name: f.name,
  category: f.category,
  slug: f.slug,
  tooltip: featureTooltip(f),
}))
const renderAppMatrixBody = () =>
  renderFlatMatrixBodyHtml({
    features: matrixFeatureRows,
    backends: appBackends,
    selectionFor,
  })
const renderHeadlessMatrixBody = () =>
  renderFlatMatrixBodyHtml({
    features: matrixFeatureRows,
    backends: headlessBackends,
    selectionFor,
  })
function resolveMatrixCell(featureId, backendName) {
  const feature = featureById.get(featureId)
  if (!feature) return undefined
  const version = selectionFor(backendName)
  return {
    featureId,
    featureName: feature.name,
    probeGuidance: data.featureDescriptions[featureId]?.probe,
    subjectName: backendLabelByName.get(backendName) ?? backendName,
    version,
    cell: publicResultFor(version, featureId),
  }
}
</script>

<div class="category-page">

<nav class="breadcrumb">
  <a :href="p.pageType === 'tag' ? '/standards' : '/features'">{{ p.pageType === 'tag' ? 'Standards' : 'Features' }}</a>
  <span class="sep">›</span>
  <span>{{ p.categoryName }}</span>
</nav>

# {{ p.categoryName }}

<p v-if="p.categoryDescription" class="category-desc" v-html="p.categoryDescription"></p>

<p class="category-meta">
  {{ p.featureCount }} features in this {{ p.pageType === 'tag' ? 'standard' : 'category' }}
  <span v-if="p.specUrl"> · <a :href="p.specUrl" target="_blank" rel="noopener">Specification ↗</a></span>
</p>

<div v-if="relatedPages.length" class="see-also">
  See also: <span v-for="(r, i) in relatedPages"><a :href="r.link">{{ r.text }}</a><span v-if="i < relatedPages.length - 1"> · </span></span>
</div>

<div v-if="p.body" class="standard-body" v-html="p.body"></div>

<div v-if="p.historicalBody" class="historical-context">
  <h3>Historical Context</h3>
  <div v-html="p.historicalBody"></div>
</div>

<div v-if="p.analysis" class="analysis">
  <div class="analysis-header">
    <span class="analysis-label">Analysis</span>
    <span class="analysis-date">{{ p.analysisDate }}</span>
  </div>
  <div class="analysis-body" v-html="p.analysis"></div>
  <p v-if="p.analysisChanges" class="analysis-changes">{{ p.analysisChanges }}</p>
</div>

## Terminal Applications

<DelegatedMatrix v-if="appBackends.length > 0" :resolve-cell="resolveMatrixCell">
<div class="matrix-wrapper">
<table class="matrix">
  <thead>
    <tr>
      <th class="feature-col">Feature</th>
      <th v-for="b in appBackends" :key="b.name" :title="termTooltip(b)">
        <a :href="'/terminals/' + b.slug">{{ b.label }}</a>
        <span class="th-platforms" v-html="platformIcons(b)"></span>
      </th>
    </tr>
  </thead>
  <MatrixBody :id="'cat-' + p.id + '-app'" :render-html="renderAppMatrixBody" />
</table>
</div>
</DelegatedMatrix>
<p v-else class="no-data-inline">No app results yet. Run <code>npx terminfo.dev submit</code> to contribute.</p>

<div v-if="headlessBackends.length > 0">

## Headless Backends

<p class="headless-note">Parser backends tested without a GUI; select any result to see what was sent and observed.</p>

<DelegatedMatrix :resolve-cell="resolveMatrixCell">
<div class="matrix-wrapper">
<table class="matrix matrix-muted">
  <thead>
    <tr>
      <th class="feature-col">Feature</th>
      <th v-for="b in headlessBackends" :key="b.name" :title="termTooltip(b)">
        <a :href="'/terminals/' + b.slug">{{ b.label }}</a>
      </th>
    </tr>
  </thead>
  <MatrixBody :id="'cat-' + p.id + '-headless'" :render-html="renderHeadlessMatrixBody" />
</table>
</div>
</DelegatedMatrix>

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

.standard-body {
  margin: 1.5em 0;
  font-size: 1em;
  line-height: 1.7;
  color: var(--vp-c-text-1);
}

.standard-body :deep(p) {
  margin: 0.75em 0;
}

.standard-body :deep(code) {
  font-size: 0.9em;
  padding: 0.15em 0.35em;
  border-radius: 3px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
}

.standard-body :deep(a) {
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.standard-body :deep(a:hover) {
  text-decoration: underline;
}

.historical-context {
  margin: 1.5em 0;
  padding: 1em 1.25em;
  border-left: 3px solid var(--vp-c-brand-2);
  background: var(--vp-c-bg-soft);
  border-radius: 0 6px 6px 0;
}

.historical-context h3 {
  margin: 0 0 0.5em;
  font-size: 1.05em;
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.historical-context :deep(p) {
  margin: 0.6em 0;
  font-size: 0.95em;
  line-height: 1.65;
  color: var(--vp-c-text-2);
}

.historical-context :deep(code) {
  font-size: 0.85em;
  padding: 0.15em 0.35em;
  border-radius: 3px;
  background: var(--vp-c-bg-alt);
  color: var(--vp-c-text-1);
}

.historical-context :deep(a) {
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.historical-context :deep(a:hover) {
  text-decoration: underline;
}

.historical-context :deep(strong) {
  color: var(--vp-c-text-1);
}

.category-page .matrix-wrapper {
  margin: 1em 0;
  max-width: 100%;
  overflow-x: auto;
}

/* The outer wrapper owns horizontal scrolling; evidence dialogs teleport to body. */
.matrix-wrapper table {
  display: table;
  overflow: visible;
}

/* VitePress wraps tables in .vp-table with overflow-x:auto — override it */
.matrix-wrapper :deep(.vp-table),
.category-page :deep(.vp-table) {
  overflow: visible;
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
