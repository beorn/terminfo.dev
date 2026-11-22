---
outline: [2, 3]
prev: false
next: false
---

<script setup>
import { useData } from 'vitepress'
import { data } from '../data/probes.data'
import { publicResultFor } from '../data/release-scope'
import { baselineReadout } from '../data/baseline-readouts.ts'
import { isEnvironmentGroup } from '../../packages/probe-defs/src/environment-groups.ts'
import { platformIcon } from '../.vitepress/theme/platform-icons.ts'
import { rowFacts } from '../.vitepress/theme/row-facts.ts'
const { params } = useData()
const p = params.value

const features = JSON.parse(p.features)
// D132 B (#30917): the environment groups in this baseline are ungraded.
const backends = JSON.parse(p.backends)
const scores = JSON.parse(p.scores)
const appBackends = backends.filter(b => b.type === 'term')
const headlessBackends = backends.filter(b => b.type === 'lib')
const appScores = scores.filter(s => s.type === 'term')
const headlessScores = scores.filter(s => s.type === 'lib')
// #37761 7d: the same rows as home's Baseline cards: the bar and its popover cover this baseline's graded features,
// a feature the run never decided reads "No result yet", and the percent is Supported over those features.
const facts = rowFacts(data)
const within = features.map(f => f.id).filter(id => !isEnvironmentGroup(id))
function featureTooltip(f) {
  const parts = [f.name]
  if (f.tags?.length) parts.push('Tags: ' + f.tags.join(', '))
  if (f.url) parts.push('Spec: ' + f.url.replace(/^https?:\/\//, ''))
  return parts.join('\n')
}

// #37761 item 10: a terminal's hover is who it is (name, platform, one line, website), the same on every page.
function termTooltip(b) {
  return facts.about(b.name)
}

function shareRow(s) {
  return baselineReadout(s)
}

function platformIcons(b) {
  if (!b.platforms?.length) return ''
  return b.platforms.map(p => platformIcon(p)).filter(Boolean).join(' ')
}

</script>

<div class="baseline-page">

<nav class="breadcrumb">
  <span>Baselines</span>
  <span class="sep">›</span>
  <span>{{ p.label }}</span>
</nav>

<div class="baseline-title-row">
  <span class="baseline-title-icon">{{ p.emoji }}</span>
  <div>
    <h1 class="baseline-title">{{ p.label }} Baseline</h1>
    <p class="baseline-tagline">{{ p.tagline }}</p>
  </div>
</div>

<p class="baseline-description" v-html="p.description"></p>

<p class="baseline-meta">{{ p.featureCount }} features in this baseline</p>

<div v-if="p.analysis" class="analysis">
  <div class="analysis-header">
    <span class="analysis-label">Analysis</span>
    <span class="analysis-date">{{ p.analysisDate }}</span>
  </div>
  <div class="analysis-body" v-html="p.analysis"></div>
  <p v-if="p.analysisChanges" class="analysis-changes">{{ p.analysisChanges }}</p>
</div>

## Coverage and results

Untestable reasons name the cause: **passed to the app**, **no way**, **no setup**, or **no observer** (the effect shows outside what the run captures). A generic OSC hook handing an app-job command to the app does not establish Supported; a reading of the library's own state or typed notification store can. A result we haven't decided, such as one with a missing control or an undeclared tap identity, is left blank. [Result meanings](/how-it-works/how-to-read-a-result#untestable-probe-todo-and-probe-invalid).

### Terminal Applications

<div v-if="appScores.length > 0" class="term-rows">
  <TermRow v-for="s in appScores" :key="s.name" :name="facts.name(s.name)" :href="'/terminals/' + s.slug" :os="facts.os(s.name)" :platform="facts.platform(s.name)"
    :description="data.meta[s.name]?.description" :website="data.meta[s.name]?.url" :version="s.version"
    :ids="facts.within(s.name, within, p.id)" :describe="facts.describe(s.name)" :readout="shareRow(s).text" :percent="facts.percentWithin(s.name, within, p.id)" />
</div>
<p v-else class="no-data-inline">No app results yet.</p>

<div v-if="headlessScores.length > 0">

### Headless Backends

<div class="term-rows term-rows-muted">
  <TermRow v-for="s in headlessScores" :key="s.name" :name="facts.name(s.name)" :href="'/terminals/' + s.slug" :os="facts.os(s.name)" :platform="facts.platform(s.name)"
    :description="data.meta[s.name]?.description" :website="data.meta[s.name]?.url" :version="s.version"
    :ids="facts.within(s.name, within, p.id)" :describe="facts.describe(s.name)" :readout="shareRow(s).text" :percent="facts.percentWithin(s.name, within, p.id)" />
</div>

</div>

## Guidance

<div class="guidance-grid">
  <div class="guidance-card">
    <h3>For Developers</h3>
    <p>{{ p.forDevelopers }}</p>
  </div>
  <div class="guidance-card">
    <h3>For Terminal Authors</h3>
    <p>{{ p.forTerminalAuthors }}</p>
  </div>
</div>

## Features

### Terminal Applications

<div v-if="appBackends.length > 0" class="matrix-wrapper">
<table class="matrix">
  <thead>
    <tr>
      <th class="feature-col">Feature</th>
      <th v-for="b in appBackends" :key="b.name" :data-tooltip="termTooltip(b)">
        <a :href="'/terminals/' + b.slug">{{ b.label }}</a>
        <span class="th-platforms" v-html="platformIcons(b)"></span>
      </th>
    </tr>
  </thead>
  <tbody>
    <tr v-for="f in features" :key="f.id">
      <td class="feature-name" :data-tooltip="featureTooltip(f)">
        <a :href="'/' + f.category + '/' + f.slug">{{ f.name }}</a>
      </td>
      <td v-for="b in appBackends" :key="b.name">
        <ResultEvidenceCell :feature-id="f.id" :probe-guidance="data.featureDescriptions[f.id]?.probe" :feature-name="f.name" :subject-name="b.label"
          :version="data.selectedByBackend[b.name]?.selected" :cell="publicResultFor(data.selectedByBackend[b.name]?.selected, f.id)" />
      </td>
    </tr>
  </tbody>
</table>
</div>
<p v-else class="no-data-inline">No app results yet. Run <code>npx terminfo.dev submit</code> to contribute.</p>

<div v-if="headlessBackends.length > 0">

### Headless Backends

<p class="headless-note">Headless results describe the recorded parser observation. Open a result to see its method and scope.</p>

<div class="matrix-wrapper">
<table class="matrix matrix-muted">
  <thead>
    <tr>
      <th class="feature-col">Feature</th>
      <th v-for="b in headlessBackends" :key="b.name" :data-tooltip="termTooltip(b)">
        <a :href="'/terminals/' + b.slug">{{ b.label }}</a>
      </th>
    </tr>
  </thead>
  <tbody>
    <tr v-for="f in features" :key="f.id">
      <td class="feature-name" :data-tooltip="featureTooltip(f)">
        <a :href="'/' + f.category + '/' + f.slug">{{ f.name }}</a>
      </td>
      <td v-for="b in headlessBackends" :key="b.name">
        <ResultEvidenceCell :feature-id="f.id" :probe-guidance="data.featureDescriptions[f.id]?.probe" :feature-name="f.name" :subject-name="b.label"
          :version="data.selectedByBackend[b.name]?.selected" :cell="publicResultFor(data.selectedByBackend[b.name]?.selected, f.id)" />
      </td>
    </tr>
  </tbody>
</table>
</div>

</div>

<p class="back-link">
  <a href="/">← Back to matrix</a>
</p>

</div>

<style>
.baseline-page {
  max-width: 100%;
  overflow-x: auto;
}

.baseline-title-row {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 0.5em;
}

.baseline-title-icon {
  font-size: 2.5em;
  line-height: 1.2;
}

.baseline-title {
  margin: 0 !important;
  padding: 0 !important;
  border: none !important;
}

.baseline-tagline {
  color: var(--vp-c-text-2);
  font-size: 1.05em;
  margin: 0.2em 0 0;
}

.baseline-description {
  font-size: 1.05em;
  color: var(--vp-c-text-2);
  line-height: 1.6;
  margin-bottom: 0.5em;
}

.baseline-description a {
  color: inherit;
  text-decoration: none;
  font-weight: 600;
}

.baseline-description a:hover {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
}

.baseline-meta {
  color: var(--vp-c-text-3);
  font-size: 0.9em;
}

/* Guidance */
.guidance-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin: 1em 0 2em;
}

@media (max-width: 700px) {
  .guidance-grid {
    grid-template-columns: 1fr;
  }
}

.guidance-card {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 16px 20px;
  background: var(--vp-c-bg-soft);
}

.guidance-card h3 {
  margin: 0 0 8px;
  font-size: 1em;
}

.guidance-card p {
  margin: 0;
  font-size: 0.9em;
  color: var(--vp-c-text-2);
  line-height: 1.5;
}

/* Matrix (reuse category page patterns) */
.matrix-wrapper {
  margin: 1em 0;
}

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

.cell-link,
.cell-link:link,
.cell-link:visited {
  color: inherit !important;
  text-decoration: none !important;
  display: block;
}

.hover-link,
.hover-link:link,
.hover-link:visited {
  color: inherit !important;
  text-decoration: none !important;
  font-weight: inherit;
}

.hover-link:hover {
  color: var(--vp-c-brand-1) !important;
  text-decoration: underline !important;
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
