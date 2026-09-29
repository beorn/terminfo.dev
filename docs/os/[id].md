---
outline: [2, 3]
prev: false
next: false
---

<script setup>
import { useData } from 'vitepress'
const { params } = useData()
const p = params.value

const appRows = p.appRows ? JSON.parse(p.appRows) : []
const parserRows = p.parserRows ? JSON.parse(p.parserRows) : []
const muxRows = p.muxRows ? JSON.parse(p.muxRows) : []
const gapRows = p.gapRows ? JSON.parse(p.gapRows) : []
const notes = p.notes ? JSON.parse(p.notes) : []
const sources = p.sources ? JSON.parse(p.sources) : []

function evidenceClass(row) {
  return 'evidence-' + (row.evidenceKind || 'unprobed')
}
</script>

<div class="os-page">

<nav class="breadcrumb">
  <a href="/os">Operating Systems</a>
  <span class="sep">›</span>
  <span>{{ p.label }}</span>
</nav>

<h1 class="platform-title">{{ p.label }} Terminal Support</h1>

<p class="page-tagline">{{ p.tagline }}</p>

<p class="platform-desc">{{ p.description }}</p>

<div class="stats-grid">
  <div class="stat">
    <span class="stat-number">{{ p.appCount }}</span>
    <span class="stat-label">app terminals</span>
  </div>
  <div class="stat">
    <span class="stat-number">{{ p.measuredAppCount }}</span>
    <span class="stat-label">app-probed here</span>
  </div>
  <div class="stat">
    <span class="stat-number">{{ p.parserCount }}</span>
    <span class="stat-label">parser backends</span>
  </div>
  <div class="stat">
    <span class="stat-number">{{ p.gapCount }}</span>
    <span class="stat-label">tracking gaps</span>
  </div>
</div>

<div class="evidence-note">
  Percentages show support among conclusive observations for each source run, not coverage of the full feature catalog or a platform-wide score. Open a terminal row for its selected version, OS context, and evidence; the <a href="/">feature matrix</a> shows individual results. Parser and reference rows do not establish full app behavior on this OS.
</div>

## App Terminals

<table class="platform-table">
  <thead>
    <tr>
      <th>Terminal</th>
      <th>Conclusive support</th>
      <th>Evidence</th>
      <th>Notes</th>
    </tr>
  </thead>
  <tbody>
    <tr v-for="row in appRows" :key="row.id">
      <td>
        <a :href="'/terminals/' + row.slug">{{ row.label }}</a>
        <span v-if="row.url" class="external-link"> · <a :href="row.url" target="_blank" rel="noopener">site</a></span>
      </td>
      <td class="score-cell"><span v-if="row.score">{{ row.score }}%</span><span v-else>—</span></td>
      <td><span :class="['evidence-badge', evidenceClass(row)]">{{ row.evidence }}</span></td>
      <td class="note-cell">{{ row.note }}</td>
    </tr>
  </tbody>
</table>

<template v-if="parserRows.length">

## Portable Parser Backends

<table class="platform-table">
  <thead>
    <tr>
      <th>Backend</th>
      <th>Conclusive support</th>
      <th>Evidence</th>
      <th>Notes</th>
    </tr>
  </thead>
  <tbody>
    <tr v-for="row in parserRows" :key="row.id">
      <td><a :href="'/terminals/' + row.slug">{{ row.label }}</a></td>
      <td class="score-cell"><span v-if="row.score">{{ row.score }}%</span><span v-else>—</span></td>
      <td><span :class="['evidence-badge', evidenceClass(row)]">{{ row.evidence }}</span></td>
      <td class="note-cell">{{ row.note }}</td>
    </tr>
  </tbody>
</table>

</template>

<template v-if="muxRows.length">

## Multiplexers

<table class="platform-table">
  <thead>
    <tr>
      <th>Multiplexer</th>
      <th>Conclusive support</th>
      <th>Evidence</th>
      <th>Notes</th>
    </tr>
  </thead>
  <tbody>
    <tr v-for="row in muxRows" :key="row.id">
      <td><a :href="'/terminals/' + row.slug">{{ row.label }}</a></td>
      <td class="score-cell"><span v-if="row.score">{{ row.score }}%</span><span v-else>—</span></td>
      <td><span :class="['evidence-badge', evidenceClass(row)]">{{ row.evidence }}</span></td>
      <td class="note-cell">{{ row.note }}</td>
    </tr>
  </tbody>
</table>

</template>

<template v-if="gapRows.length">

## Tracking Gaps

<table class="platform-table">
  <thead>
    <tr>
      <th>Surface</th>
      <th>Type</th>
      <th>Why it matters</th>
    </tr>
  </thead>
  <tbody>
    <tr v-for="row in gapRows" :key="row.label">
      <td><a :href="row.url" target="_blank" rel="noopener">{{ row.label }}</a></td>
      <td class="note-cell">{{ row.type }}</td>
      <td class="note-cell">{{ row.note }}</td>
    </tr>
  </tbody>
</table>

</template>

<template v-if="notes.length">

## Notes

<ul class="notes-list">
  <li v-for="note in notes" :key="note">{{ note }}</li>
</ul>

</template>

<template v-if="sources.length">

## Sources

<ul class="source-list">
  <li v-for="source in sources" :key="source.url"><a :href="source.url" target="_blank" rel="noopener">{{ source.label }}</a></li>
</ul>

</template>

<p class="back-link">
  <a href="/os">&#8592; Back to operating systems</a>
</p>

</div>

<style>
.os-page {
  max-width: 960px;
}

.page-tagline {
  font-size: 1.15em;
  color: var(--vp-c-text-2);
  margin-top: -0.5em;
  margin-bottom: 1em;
}

.platform-title {
  font-size: 2.25rem;
  font-weight: 700;
  letter-spacing: 0;
  line-height: 1.2;
  margin: 0.35em 0 0.5em;
}

.platform-desc {
  color: var(--vp-c-text-2);
  line-height: 1.6;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin: 1.5em 0;
}

.stat {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  padding: 14px 16px;
}

.stat-number {
  display: block;
  font-size: 1.8em;
  font-weight: 700;
  line-height: 1;
}

.stat-label {
  display: block;
  color: var(--vp-c-text-3);
  font-size: 0.85em;
  margin-top: 4px;
}

.evidence-note {
  background: var(--vp-c-brand-soft);
  border-left: 3px solid var(--vp-c-brand-1);
  border-radius: 6px;
  color: var(--vp-c-text-2);
  font-size: 0.95em;
  line-height: 1.55;
  margin: 1.5em 0;
  padding: 12px 14px;
}

.platform-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9em;
  margin: 1em 0 2em;
}

.platform-table th,
.platform-table td {
  border: 1px solid var(--vp-c-divider);
  padding: 8px 10px;
  text-align: left;
  vertical-align: top;
}

.platform-table th {
  background: var(--vp-c-bg-soft);
  font-weight: 600;
}

.platform-table a {
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.platform-table a:hover {
  text-decoration: underline;
}

.score-cell {
  font-weight: 700;
  white-space: nowrap;
}

.note-cell {
  color: var(--vp-c-text-2);
  font-size: 0.95em;
}

.external-link {
  color: var(--vp-c-text-3);
  font-size: 0.9em;
}

.evidence-badge {
  border-radius: 999px;
  display: inline-block;
  font-size: 0.78em;
  font-weight: 700;
  line-height: 1.5;
  padding: 2px 9px;
  white-space: nowrap;
}

.evidence-measured {
  background: var(--vp-c-green-soft);
  color: var(--vp-c-green-1);
}

.evidence-parser {
  background: var(--vp-c-indigo-soft);
  color: var(--vp-c-indigo-1);
}

.evidence-inherited {
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
}

.evidence-reference {
  background: var(--vp-c-yellow-soft);
  color: var(--vp-c-yellow-1);
}

.evidence-unprobed {
  background: var(--vp-c-default-soft);
  color: var(--vp-c-text-2);
}

.notes-list,
.source-list {
  color: var(--vp-c-text-2);
  line-height: 1.7;
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

@media (max-width: 760px) {
  .stats-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .platform-table {
    display: block;
    overflow-x: auto;
  }
}

@media (max-width: 480px) {
  .stats-grid {
    grid-template-columns: 1fr;
  }
}
</style>
