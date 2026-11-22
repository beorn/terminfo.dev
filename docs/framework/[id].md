---
outline: [2, 3]
prev: false
next: false
---

<script setup>
import { useData } from 'vitepress'
const { params } = useData()
const p = params.value

// #37761: this page draws no bars; its unused score helpers and its own platform icon copy are gone.
</script>

<div class="framework-page">

<nav class="breadcrumb">
  <span>Frameworks</span>
  <span class="sep">›</span>
  <span>{{ p.label }}</span>
</nav>

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

/* Inline callout for v-html content (can't use ::: tip in JSON) */
.callout-tip {
  border-left: 3px solid var(--vp-c-brand-1);
  background: var(--vp-c-bg-soft);
  border-radius: 0 8px 8px 0;
  padding: 12px 16px;
  margin: 1em 0;
}

.callout-title {
  font-weight: 700;
  font-size: 0.85em;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--vp-c-brand-1);
  margin: 0 0 6px;
}

.callout-tip p:last-child {
  margin: 0;
  font-size: 0.92em;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}

.callout-tip a {
  color: inherit;
  font-weight: 600;
  text-decoration: none;
}

.callout-tip a:hover {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
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
