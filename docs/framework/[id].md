---
outline: [2, 3]
prev: false
next: false
---

<script setup>
import { useData } from 'vitepress'
const { params } = useData()
const p = params.value

const scores = JSON.parse(p.scores)
const appScores = scores.filter(s => s.type === 'app')
const headlessScores = scores.filter(s => s.type === 'headless')

function termTooltip(s) {
  const parts = []
  if (s.description) parts.push(s.description)
  if (s.type) parts.push('Type: ' + s.type)
  if (s.version) parts.push('Version: ' + s.version)
  if (s.url) parts.push(s.url)
  return parts.join('\n') || s.label
}

function barTooltip(s, segment) {
  if (segment === 'yes') {
    return `${s.yes} of ${s.total} baseline features supported`
  }
  if (segment === 'partial') {
    return `${s.partial} features with partial support`
  }
  return ''
}

function platformIcon(os) {
  if (os === 'macos') return '<svg viewBox="0 0 16 16" width="14" height="14" style="vertical-align:-2px"><path d="M12.2 5.5c-.1 0-1.6.9-1.6 2.8 0 2.2 1.9 3 2 3-.1.1-.3 1.1-1 2.2-.6 1-1.3 1.9-2.3 1.9s-1.3-.6-2.4-.6c-1.2 0-1.6.6-2.5.6-.9 0-1.6-.9-2.3-2C1.3 12 .8 10.2.8 8.6c0-2.6 1.7-4 3.3-4 .9 0 1.6.6 2.2.6.5 0 1.4-.6 2.4-.6.4 0 1.8.1 2.6 1.3-.1 0-1.5.9-1.5 2.6h.4z" fill="#888"/><path d="M10 1c.5.6.9 1.5.8 2.4-.8.1-1.7-.4-2.2-1.1-.5-.6-.9-1.5-.8-2.3.9 0 1.7.4 2.2 1z" fill="#888"/></svg>'
  if (os === 'linux') return '<svg viewBox="0 0 16 16" width="14" height="14" style="vertical-align:-2px"><path d="M8 1C5.8 1 4 3.4 4 6.4c0 1.5.4 2.8 1.1 3.8-.5.3-1.5 1-1.5 2.1 0 .4.1.8.4 1.1.5.5 1.4.6 2.2.6h3.6c.8 0 1.7-.1 2.2-.6.3-.3.4-.7.4-1.1 0-1.1-1-1.8-1.5-2.1.7-1 1.1-2.3 1.1-3.8C12 3.4 10.2 1 8 1zm-1.5 5c-.4 0-.8-.4-.8-.8s.4-.8.8-.8.8.4.8.8-.4.8-.8.8zm3 0c-.4 0-.8-.4-.8-.8s.4-.8.8-.8.8.4.8.8-.4.8-.8.8z" fill="#888"/></svg>'
  if (os === 'windows') return '<svg viewBox="0 0 16 16" width="14" height="14" style="vertical-align:-2px"><path d="M1 3.5l5.5-.8v5.3H1V3.5zm6.3-.9L15 1.5v6.5H7.3V2.6zM15 8.5v6.3l-7.7-1.1V8.5H15zM6.5 13.5L1 12.8V8.5h5.5v5z" fill="#888"/></svg>'
  return ''
}

function platformIcons(b) {
  if (!b.platforms?.length) return ''
  return b.platforms.map(p => platformIcon(p)).filter(Boolean).join(' ')
}

</script>

<div class="framework-page">

<h1 class="framework-title"><a v-if="p.url" :href="p.url" target="_blank" rel="noopener" class="framework-title-link">{{ p.label }} <span class="framework-external">↗</span></a><template v-else>{{ p.label }}</template></h1>
<p class="framework-tagline">{{ p.description }}</p>

<div class="framework-links">
  <a v-if="p.url" :href="p.url" target="_blank" rel="noopener" class="framework-link-card">
    <span class="framework-link-icon">🌐</span>
    <span class="framework-link-text">
      <span class="framework-link-label">Website</span>
      <span class="framework-link-url">{{ p.url.replace(/^https?:\/\//, '') }}</span>
    </span>
  </a>
  <a v-if="p.repo" :href="p.repo" target="_blank" rel="noopener" class="framework-link-card">
    <span class="framework-link-icon">📦</span>
    <span class="framework-link-text">
      <span class="framework-link-label">Source</span>
      <span class="framework-link-url">{{ p.repo.replace(/^https?:\/\/github.com\//, '') }}</span>
    </span>
  </a>
  <div class="framework-link-card framework-link-meta">
    <span class="framework-link-icon">💻</span>
    <span class="framework-link-text">
      <span class="framework-link-label">{{ p.language }}</span>
      <span class="framework-link-url">{{ p.runtime }}</span>
    </span>
  </div>
</div>

<div class="framework-body" v-html="p.body"></div>

<div v-if="p.analysis" class="analysis">
  <div class="analysis-header">
    <span class="analysis-label">Analysis</span>
    <span class="analysis-date">{{ p.analysisDate }}</span>
  </div>
  <div class="analysis-body" v-html="p.analysis"></div>
  <p v-if="p.analysisChanges" class="analysis-changes">{{ p.analysisChanges }}</p>
</div>

## Recommended Baseline

<div class="baseline-badge">
  <a :href="'/baseline/' + p.baseline" class="baseline-link">
    <span class="baseline-emoji">{{ p.baselineEmoji }}</span>
    <span class="baseline-name">{{ p.baselineLabel }}</span>
  </a>
  <span class="baseline-tagline-text">{{ p.baselineTagline }}</span>
</div>

<p class="baseline-note">{{ p.label }} works best with the <a :href="'/baseline/' + p.baseline" class="hover-link">{{ p.baselineLabel }}</a> baseline ({{ p.featureCount }} features). It runs on less capable terminals but degrades gracefully — some features may be unavailable or visually reduced.</p>

<p class="back-link">
  <a href="/">&#8592; Back to matrix</a>
</p>

</div>

<style>
.framework-page {
  max-width: 100%;
}

.framework-title {
  margin: 0 !important;
  padding: 0 !important;
  border: none !important;
}

.framework-title-link {
  color: inherit !important;
  text-decoration: none !important;
}

.framework-title-link:hover {
  color: var(--vp-c-brand-1) !important;
}

.framework-external {
  font-size: 0.5em;
  vertical-align: super;
  color: var(--vp-c-text-3);
}

.framework-tagline {
  color: var(--vp-c-text-2);
  font-size: 1.05em;
  margin: 0.2em 0 0;
}

.framework-links {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 1.25em 0;
}

.framework-link-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  color: inherit !important;
  text-decoration: none !important;
  transition: border-color 0.2s, box-shadow 0.2s;
  min-width: 180px;
}

a.framework-link-card:hover {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
}

.framework-link-icon {
  font-size: 1.4em;
}

.framework-link-text {
  display: flex;
  flex-direction: column;
}

.framework-link-label {
  font-weight: 600;
  font-size: 0.9em;
}

.framework-link-url {
  font-size: 0.8em;
  color: var(--vp-c-text-3);
}

.framework-link-meta {
  cursor: default;
}

/* Legacy — can remove if no longer used */
.framework-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin: 1em 0;
  font-size: 0.9em;
  color: var(--vp-c-text-2);
}

.framework-meta-item a {
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.framework-meta-item a:hover {
  text-decoration: underline;
}

.framework-body {
  font-size: 1.05em;
  color: var(--vp-c-text-2);
  line-height: 1.6;
  margin-bottom: 1em;
}

.framework-body p {
  margin: 0.5em 0;
}

.baseline-badge {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  margin: 1em 0;
}

.baseline-link {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 1.1em;
  color: var(--vp-c-text-1) !important;
  text-decoration: none !important;
}

.baseline-link:hover {
  color: var(--vp-c-brand-1) !important;
}

.baseline-emoji {
  font-size: 1.3em;
}

.baseline-tagline-text {
  color: var(--vp-c-text-3);
  font-size: 0.9em;
}

.baseline-note {
  color: var(--vp-c-text-2);
  font-size: 0.95em;
  line-height: 1.5;
}

/* Scorecard — reuses .summary-* classes from baseline pages */
.summary {
  margin: 1em 0 2em;
}

.summary-muted {
  opacity: 0.85;
}

.summary-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}

.summary-name {
  width: 120px;
  font-weight: 600;
  font-size: 0.9em;
  flex-shrink: 0;
}

.summary-platforms {
  display: flex;
  gap: 3px;
  flex-shrink: 0;
  align-items: center;
}

.summary-bar {
  flex: 1;
  height: 22px;
  background: var(--vp-c-bg-soft);
  border-radius: 4px;
  display: flex;
}

.bar-yes {
  height: 100%;
  background: #10b981;
  transition: width 0.3s ease;
}

.bar-partial {
  height: 100%;
  background: #f59e0b;
  transition: width 0.3s ease;
}

.summary-pct {
  width: 40px;
  font-weight: 600;
  font-size: 0.9em;
  text-align: right;
  flex-shrink: 0;
}

.summary-counts {
  width: 70px;
  font-size: 0.8em;
  color: var(--vp-c-text-3);
  text-align: right;
  flex-shrink: 0;
}

/* Analysis block */
.analysis {
  margin: 1.5em 0;
  padding: 16px 20px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
}

.analysis-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.analysis-label {
  font-weight: 600;
  font-size: 0.9em;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--vp-c-text-3);
}

.analysis-date {
  font-size: 0.8em;
  color: var(--vp-c-text-3);
}

.analysis-body {
  font-size: 0.95em;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}

.analysis-body p {
  margin: 0;
}

.analysis-changes {
  margin: 8px 0 0;
  font-size: 0.85em;
  color: var(--vp-c-text-3);
  font-style: italic;
}

/* Tooltips */
[data-tooltip] {
  position: relative;
}

[data-tooltip]:hover {
  z-index: 50;
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

.no-data-inline {
  color: var(--vp-c-text-3);
  font-size: 0.9em;
  font-style: italic;
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
