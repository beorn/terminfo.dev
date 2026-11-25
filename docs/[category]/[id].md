---
outline: [2, 3]
prev: false
next: false
---

<script setup>
import { ref, watch } from 'vue'
import { publicResultFor } from '../data/release-scope'
import { RESULT_CATEGORIES } from '../data/result-categories'
import { useData } from 'vitepress'
import { data } from '../data/probes.data'
import { rowFacts } from '../.vitepress/theme/row-facts.ts'
import { termAnchorId } from '../.vitepress/theme/bar-layout.ts'
import { plainExpectedSentence } from '../.vitepress/theme/evidence-status.ts'
import { vendorExtensionOrigin } from '../.vitepress/theme/card-explain.ts'
const { params } = useData()
const p = params.value
const expectedSentence = plainExpectedSentence({
  body: data.featureDescriptions[p.featureId]?.body,
  probeGuidance: data.featureDescriptions[p.featureId]?.probe,
  featureName: p.featureName,
})
const vendorOrigin = vendorExtensionOrigin(p.featureId)

const openBackendId = ref(null)
watch(() => params.value?.featureId, () => {
  openBackendId.value = null
})
function toggleBackendCard(id) {
  openBackendId.value = openBackendId.value === id ? null : id
}
function closeBackendCard() {
  openBackendId.value = null
}

const backendResults = JSON.parse(p.backendResults)
const featureTags = JSON.parse(p.featureTags || '[]')
const subFeatures = JSON.parse(p.subFeatures || '[]')
const backendNames = JSON.parse(p.backendNames || '[]')
const appResults = backendResults.filter(r => r.type === 'term')
const headlessResults = backendResults.filter(r => r.type === 'lib')
// #38266: group feature-page results by verdict (Supported / Unsupported / Differs by context / Untestable / No result yet)
// reading directly from RESULT_CATEGORIES (#37761) so marks, labels, and tones stay single-sourced.
// #37761: one result row per terminal. The mark is this terminal's category for the feature, read from its bar's own
// fold; the short name sits beside its platform icon (two Ghostty rows read apart); the row links to the terminal and
// the evidence cell stays at the row's end.
const facts = rowFacts(data)
function resultRows(rows) {
  const baseNameCounts = new Map()
  for (const r of rows) {
    const base = facts.name(r.name)
    baseNameCounts.set(base, (baseNameCounts.get(base) ?? 0) + 1)
  }
  return rows.map(r => {
    const category = facts.categoryOf(r.name, p.featureId)
    const base = facts.name(r.name)
    const platform = facts.platform(r.name)
    const shortOs = platform === 'macOS' ? 'Mac' : platform
    const displayName = shortOs && (baseNameCounts.get(base) ?? 0) > 1 ? `${base} (${shortOs})` : base
    return {
      id: r.name,
      categoryId: category.id,
      anchor: termAnchorId(r.slug),
      name: displayName,
      href: '/terminals/' + r.slug,
      mark: category.mark,
      tone: category.style,
      icon: facts.icon(r.name),
      iconTitle: platform,
      note: r.note || undefined,
    }
  })
}
function groupByVerdict(rows) {
  const formatted = resultRows(rows)
  return RESULT_CATEGORIES
    .map(group => ({
      id: group.id,
      label: group.label,
      mark: group.mark,
      tone: group.style,
      items: formatted.filter(item => item.categoryId === group.id),
    }))
    .filter(group => group.items.length > 0)
}
const appVerdictGroups = groupByVerdict(appResults)
const headlessVerdictGroups = groupByVerdict(headlessResults)
const appBackends = backendNames.filter(b => b.type === 'term')
const headlessBackends = backendNames.filter(b => b.type === 'lib')

function termTooltip(r) {
  const parts = [r.label]
  if (r.description) parts.push(r.description)
  if (r.version) parts.push('Source versions: ' + r.version)
  return parts.join('\n')
}
</script>

<div class="feature-page">

<nav class="breadcrumb">
  <a href="/features">Features</a>
  <span class="sep">›</span>
  <a :href="'/' + p.featureCategory">{{ p.categoryLabel }}</a>
  <span class="sep">›</span>
  <template v-if="p.parentFeatureId">
    <a :href="'/' + p.featureCategory + '/' + p.parentFeatureSlug">{{ p.parentFeatureName }}</a>
    <span class="sep">›</span>
  </template>
  <span>{{ p.featureName }}</span>
</nav>

# {{ p.featureName }}

<p class="feature-meta">
  Category: <a :href="'/' + p.featureCategory">{{ p.featureCategory }}</a>
  <span v-if="vendorOrigin"> · {{ vendorOrigin }}</span>
  <span v-if="p.baseline"> · Baseline: <a :href="'/baseline/' + p.baseline" class="baseline-badge" :class="'baseline-' + p.baseline">{{ p.baseline }}</a></span>
  <span v-if="featureTags.length"> · Tags: <template v-for="(tag, i) in featureTags" :key="tag.id"><a :href="'/' + tag.id">{{ tag.label }}</a><template v-if="i < featureTags.length - 1">, </template></template></span>
  <span v-if="p.specUrl"> · <a :href="p.specUrl" target="_blank" rel="noopener">Specification ↗</a></span>
</p>

<div v-if="p.sequence" class="feature-sequence">
  <code>{{ p.sequence }}</code>
</div>

<div v-if="p.featureBody" class="feature-body" v-html="p.featureBody"></div>
<p v-else class="feature-body">{{ expectedSentence }}</p>

<div v-if="p.probeMethod" class="probe-method">
  <strong>How this is tested</strong>
  <span v-if="p.probeStatus === 'automated'" class="probe-badge probe-automated" title="Automated probe definition; open a reviewed result to inspect what it recorded">automated</span>
  <span v-else-if="p.probeStatus === 'partial'" class="probe-badge probe-partial" title="Probe definition covers only part of this feature">partial</span>
  <span v-else-if="p.probeStatus === 'manual'" class="probe-badge probe-manual" title="Not automated — support data is from manual testing or documentation">manual</span>
  <span v-else-if="p.probeStatus === 'unprobed'" class="probe-badge probe-unprobed" title="Tracked but no verification yet — manual verification required">unprobed</span>
  <span v-else-if="p.probeStatus === 'undeclared'" class="probe-badge probe-undeclared" title="This probe's assertion type is not declared yet.">assertion type undeclared</span>
  <br><span v-html="p.probeMethod"></span>
  <p class="probe-note">Select any result below to see what was sent and observed.</p>
</div>

<div v-if="p.analysis" class="analysis">
  <div class="analysis-header">
    <span class="analysis-label">Analysis</span>
    <span class="analysis-date">{{ p.analysisDate }}</span>
  </div>
  <div class="analysis-body" v-html="p.analysis"></div>
  <p v-if="p.analysisChanges" class="analysis-changes">{{ p.analysisChanges }}</p>
</div>
<p v-else-if="Number(p.totalCount) > 0" class="feature-score">
  Supported by <strong>{{ p.yesCount }}</strong> of <strong>{{ p.totalCount }}</strong> with a result<span v-if="Number(p.noResultCount) > 0" class="feature-score-pending">; {{ p.noResultCount }} not run yet</span>
</p>
<p v-else class="feature-score">No results yet for this feature.</p>

<nav v-if="appVerdictGroups.length > 0" class="feature-verdict-summary" aria-label="Terminal application verdict summary">
  <a
    v-for="group in appVerdictGroups"
    :key="group.id"
    :href="'#verdict-' + group.id"
    class="feature-verdict-chip"
    :class="'feature-verdict-chip--' + group.tone"
  >
    <span class="result-mark" aria-hidden="true">{{ group.mark }}</span>
    <span class="feature-verdict-chip-label">{{ group.label }}</span>
    <span class="feature-verdict-chip-count">{{ group.items.length }}</span>
  </a>
</nav>

## Terminal Applications

<div v-if="appVerdictGroups.length > 0" class="feature-verdict-groups">
  <section v-for="group in appVerdictGroups" :key="group.id" :id="'verdict-' + group.id" class="feature-verdict-group">
    <h3 class="feature-verdict-heading" :class="'feature-verdict-heading--' + group.tone">
      <span class="result-mark" aria-hidden="true">{{ group.mark }}</span>
      <span>{{ group.label }}</span>
      <span class="feature-verdict-count">{{ group.items.length }}</span>
    </h3>
    <ResultList :items="group.items" :active-id="openBackendId" class="feature-results" technical-notes>
      <template #after="{ item }">
        <ResultEvidenceCell :feature-id="p.featureId" :probe-guidance="data.featureDescriptions[p.featureId]?.probe" :feature-name="p.featureName" :subject-name="item.name"
          :version="data.selectedByBackend[item.id]?.selected" :cell="publicResultFor(data.selectedByBackend[item.id]?.selected, p.featureId)" display="label" emit-select :active="openBackendId === item.id" @select="toggleBackendCard(item.id)" />
      </template>
      <template #detail="{ item }">
        <div class="feature-detail-card">
          <ResultEvidenceCell :feature-id="p.featureId" :probe-guidance="data.featureDescriptions[p.featureId]?.probe" :feature-name="p.featureName" :subject-name="item.name"
            :version="data.selectedByBackend[item.id]?.selected" :cell="publicResultFor(data.selectedByBackend[item.id]?.selected, p.featureId)" inline closable @close="closeBackendCard" />
        </div>
      </template>
    </ResultList>
  </section>
</div>
<p v-else class="no-data-inline">No app results yet.</p>

<div v-if="headlessVerdictGroups.length > 0">

## Headless Backends

<p class="headless-note">Parser backends tested without a GUI; select any result to see what was sent and observed.</p>

<div class="feature-verdict-groups">
  <section v-for="group in headlessVerdictGroups" :key="group.id" :id="'headless-verdict-' + group.id" class="feature-verdict-group">
    <h3 class="feature-verdict-heading" :class="'feature-verdict-heading--' + group.tone">
      <span class="result-mark" aria-hidden="true">{{ group.mark }}</span>
      <span>{{ group.label }}</span>
      <span class="feature-verdict-count">{{ group.items.length }}</span>
    </h3>
    <ResultList :items="group.items" :active-id="openBackendId" class="feature-results result-list-muted" technical-notes>
      <template #after="{ item }">
        <ResultEvidenceCell :feature-id="p.featureId" :probe-guidance="data.featureDescriptions[p.featureId]?.probe" :feature-name="p.featureName" :subject-name="item.name"
          :version="data.selectedByBackend[item.id]?.selected" :cell="publicResultFor(data.selectedByBackend[item.id]?.selected, p.featureId)" display="label" emit-select :active="openBackendId === item.id" @select="toggleBackendCard(item.id)" />
      </template>
      <template #detail="{ item }">
        <div class="feature-detail-card">
          <ResultEvidenceCell :feature-id="p.featureId" :probe-guidance="data.featureDescriptions[p.featureId]?.probe" :feature-name="p.featureName" :subject-name="item.name"
            :version="data.selectedByBackend[item.id]?.selected" :cell="publicResultFor(data.selectedByBackend[item.id]?.selected, p.featureId)" inline closable @close="closeBackendCard" />
        </div>
      </template>
    </ResultList>
  </section>
</div>

</div>

<div v-if="subFeatures.length > 0" class="sub-features-section">

## Sub-features

<p class="sub-features-note">This feature has {{ subFeatures.length }} individually testable sub-features.</p>

<div class="matrix-wrapper sub-features-wrapper" tabindex="0" role="region" aria-label="Sub-features support matrix">
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
      <td v-for="b in appBackends" :key="b.name" class="result-cell"><ResultEvidenceCell :feature-id="sf.id" :probe-guidance="data.featureDescriptions[sf.id]?.probe" :feature-name="sf.name" :subject-name="b.label"
        :version="data.selectedByBackend[b.name]?.selected" :cell="publicResultFor(data.selectedByBackend[b.name]?.selected, sf.id)" /></td>
    </tr>
  </tbody>
</table>
</div>

</div>

<p class="back-link">
  <a href="/">← Back to matrix</a> · <a :href="'/' + p.featureCategory">{{ p.featureCategory }} features</a>
</p>

</div>

<RunHistory v-if="data.hasWorkingHistory || data.workingHistory" :available="data.hasWorkingHistory" :history="data.workingHistory" :states="data.workingStates" :originals="data.workingOriginals" :feature-id="p.featureId" />

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
  display: inline-block;
  max-width: 100%;
  overflow-x: auto;
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

.probe-note {
  margin: 0.75em 0 0 0;
  font-size: 0.85em;
  line-height: 1.6;
  color: var(--vp-c-text-3);
  font-style: italic;
}

.probe-badge {
  display: inline-block;
  margin-left: 0.5em;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 0.75em;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.probe-automated {
  background: rgba(16, 185, 129, 0.15);
  color: #10b981;
}

.probe-partial {
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
}

.probe-manual {
  background: rgba(59, 130, 246, 0.15);
  color: #3b82f6;
}

.probe-unprobed {
  background: rgba(139, 92, 246, 0.15);
  color: #8b5cf6;
}

.probe-undeclared {
  background: rgba(107, 114, 128, 0.15);
  color: #6b7280;
}

.baseline-badge {
  display: inline;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 0.85em;
  font-weight: 600;
  text-decoration: none !important;
}

.baseline-core {
  background: rgba(16, 185, 129, 0.15);
  color: #10b981;
}

.baseline-modern {
  background: rgba(59, 130, 246, 0.15);
  color: #3b82f6;
}

.baseline-rich {
  background: rgba(139, 92, 246, 0.15);
  color: #8b5cf6;
}

.baseline-legacy {
  background: rgba(161, 98, 7, 0.2);
  color: #a16207;
}

.baseline-unicode {
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
}

.feature-score {
  font-size: 1.1em;
  margin: 1em 0;
}

.feature-score-pending {
  font-size: 0.88em;
  color: var(--vp-c-text-2);
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

.result-cell {
  font-weight: 600;
  white-space: nowrap;
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

.result-list-muted {
  opacity: 0.85;
}
.feature-results,
.vp-doc .feature-results {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-auto-flow: row dense;
  align-items: start;
  column-gap: 24px;
  row-gap: 2px;
  margin: 0.4em 0 1.2em;
}

.feature-results > .result-detail-row,
.vp-doc .feature-results > .result-detail-row {
  grid-column: 1 / -1;
  margin: 6px 0 10px;
}

.feature-detail-card {
  box-sizing: border-box;
  max-width: 100%;
  padding: 16px 18px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-elv);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.16);
}

.feature-verdict-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0.6em 0 1.2em;
}

.feature-verdict-chip,
.vp-doc a.feature-verdict-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font-size: 0.85em;
  font-weight: 500;
  line-height: 1.3;
  text-decoration: none;
}

.feature-verdict-chip:hover,
.feature-verdict-chip:focus-visible {
  border-color: var(--vp-c-brand-1);
  text-decoration: none;
}

.feature-verdict-chip--yes .result-mark,
.feature-verdict-heading--yes .result-mark { color: #10b981; }
.feature-verdict-chip--fail .result-mark,
.feature-verdict-heading--fail .result-mark { color: #dc2626; }
.dark .feature-verdict-chip--fail .result-mark,
.dark .feature-verdict-heading--fail .result-mark { color: #f87171; }
.feature-verdict-chip--differs .result-mark,
.feature-verdict-heading--differs .result-mark { color: #6366f1; }
.feature-verdict-chip--partial .result-mark,
.feature-verdict-heading--partial .result-mark { color: #d97706; }
.feature-verdict-chip--none .result-mark,
.feature-verdict-heading--none .result-mark { color: var(--vp-c-text-3); }

.feature-verdict-chip-count,
.feature-verdict-count {
  font-variant-numeric: tabular-nums;
  color: var(--vp-c-text-3);
  font-weight: 600;
}

.feature-verdict-groups {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0.4em 0 1.2em;
}

.feature-verdict-group {
  scroll-margin-top: 84px;
}

.feature-verdict-heading,
.vp-doc h3.feature-verdict-heading {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 4px;
  padding: 0 0 4px;
  border-bottom: 1px solid var(--vp-c-divider);
  font-size: 0.88em;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--vp-c-text-2);
}

.feature-verdict-group .feature-results,
.vp-doc .feature-verdict-group .feature-results {
  margin: 2px 0 0;
}

@media (max-width: 640px) {
  .feature-results,
  .vp-doc .feature-results {
    grid-template-columns: minmax(0, 1fr);
  }
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

.sub-features-wrapper {
  margin: 1em 0;
  max-width: 100%;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
}

.sub-features-wrapper:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

.sub-features-wrapper .sub-features-table,
.vp-doc .sub-features-wrapper .sub-features-table {
  display: table;
  width: max-content;
  min-width: 100%;
  table-layout: auto;
  margin: 0;
  border: 0;
}

.sub-features-table th:nth-child(n),
.sub-features-table td:nth-child(n) {
  width: auto;
}

.sub-features-table th:first-child,
.sub-features-table td:first-child {
  position: sticky;
  left: 0;
  z-index: 1;
  min-width: 140px;
  max-width: 220px;
  background: var(--vp-c-bg);
  box-shadow: 2px 0 6px -2px rgba(0, 0, 0, 0.14);
}

.sub-features-table tbody tr:nth-child(2n) td:first-child {
  background: var(--vp-c-bg-soft);
}

.sub-features-table th:first-child {
  z-index: 2;
  background: var(--vp-c-bg-soft);
}

@media (max-width: 640px) {
  .sub-features-table th:first-child,
  .sub-features-table td:first-child {
    min-width: 132px;
    max-width: 168px;
  }
}

.sub-features-table .backend-col {
  font-size: 0.8em;
  text-align: center;
  white-space: nowrap;
  min-width: 56px;
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sub-features-table .result-cell {
  text-align: center;
  width: 44px;
  min-width: 44px;
  padding: 4px 6px;
  font-size: 0.9em;
}
</style>
