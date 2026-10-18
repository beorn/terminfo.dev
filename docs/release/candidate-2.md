---
title: terminfo v0.1 candidate 2
outline: [2, 3]
prev: false
next: false
---

<script setup>
import { data } from '../data/candidate-2.data'
import { D3_VERDICT_BAR } from '../data/release-scope.ts'

const published = data.contexts.filter((row) => row.published)
const omitted = data.contexts.filter((row) => !row.published)
const includedGroups = data.groups.filter((group) => group.included).length
const includedOnSome = data.groups.filter((group) => !group.included && group.includedOn.length > 0).length
const heldEverywhere = data.groups.length - includedGroups - includedOnSome
const measuredOn = data.measuredAt
  ? new Date(data.measuredAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
  : null

function groupShare(context, key) {
  const group = context.groups.find((entry) => entry.key === key)
  return group ? `${group.decisive}/${group.denominator} · ${group.decisivePct}% · ${group.verdictLabel}` : null
}

function groupAcceptance(context, key) {
  const group = context.groups.find((entry) => entry.key === key)
  if (!group?.acceptance) return null
  const { decisive, denominator, decisivePct, verdictLabel } = group.acceptance
  return `acceptance ${decisive}/${denominator} · ${decisivePct}% · ${verdictLabel}`
}

function unnamedRows(group) {
  return [...group.libraryOnly, ...group.unavailable]
}

const OS_LABEL = { macos: 'macOS', linux: 'Linux', windows: 'Windows' }

function contextSentence(context) {
  const [terminal, os] = context.split('/')
  return `${terminal} on ${OS_LABEL[os] ?? os}`
}

function darkRuledSentence(group) {
  const byOs = new Map()
  for (const context of group.darkRuled) {
    const [terminal, os] = context.split('/')
    const names = byOs.get(os) ?? []
    names.push(terminal)
    byOs.set(os, names)
  }
  return [...byOs].map(([os, names]) => `${names.join(' and ')} on ${OS_LABEL[os] ?? os}`).join('; ')
}

function remainderLabel(row) {
  return row.remainder.map((entry) => `${entry.featureId} (${entry.bucket})`).join(', ')
}
</script>

# terminfo v0.1 candidate 2 — the classics

<p class="c2-lede">This page is <strong>terminfo v0.1 candidate 2</strong>: the classic terminal capabilities. Per-context inclusion is ruled for <strong>Editing and Character Sets only</strong>: those two groups are <strong>ruled for six contexts</strong>, <strong>included on each one</strong> that clears their pass bar on the group's in-scope basis, and the contexts that do not clear it are named as <strong>held</strong> with their fraction; a ruled context that has gone dark is named as ruled but not measurable and is never counted as included. Every other group keeps its previous state: a group that clears the bar on every measured context stays <strong>included</strong> &mdash; unless a context that held it went dark, in which case it stays <strong>held</strong> and names that context, because a public claim must never improve because data went dark. A context with no published run is named as <strong>not measured</strong> and is never counted as a measured context, but one that held a group on the previous freeze is named as the reason the group is not claimed. It previews a release that has not been <em>ratified</em>, and it is a separate surface &mdash; the published matrix still reports Release 1.</p>

<div class="c2-basis">
  <p><strong>{{ data.ratifiedCount }} capabilities are in scope</strong> across {{ data.groups.length }} groups: <strong>{{ includedGroups }}</strong> clear the bar on every measured context, <strong>{{ includedOnSome }}</strong> are ruled for per-context inclusion and clear it on some contexts while held on the rest, and <strong>{{ heldEverywhere }}</strong> are held, with every context below the bar named in their State cell. Each context total divides over the <strong>{{ data.scoredCount }}</strong> rows a terminal application run can decide; each per-group fraction divides over the <strong>{{ data.decidableCount }}</strong> of those rows the frozen suite also carries a probe for. The rows outside each basis are named beside their group and never scored.</p>
  <p>Measured on the frozen probe suite <code>{{ data.frozenSuiteId }}</code><template v-if="measuredOn">, on {{ measuredOn }}</template>.</p>
  <p>A terminal <strong>passes</strong> at {{ D3_VERDICT_BAR.passPct }}% of a group's in-scope basis reading decisive &mdash; its app-decidable rows plus the library-only rows the group counts &mdash; <strong>with gaps</strong> from {{ D3_VERDICT_BAR.gapsPct }}%, and <strong>fails</strong> below; the fraction is always printed beside the label.</p>
</div>

## The groups {#groups}

<div class="c2-scroll">
<table class="c2-matrix">
  <thead>
    <tr>
      <th class="c2-group-col">Capability group</th>
      <th class="c2-count-col">Rows</th>
      <th class="c2-state-col">State</th>
      <th v-for="context in published" :key="context.context">{{ context.context }}</th>
      <th class="c2-named-col">Named, never scored</th>
    </tr>
  </thead>
  <tbody>
    <tr v-for="group in data.groups" :key="group.key">
      <td class="c2-group-col"><a :href="'/' + group.key">{{ group.label }}</a></td>
      <td class="c2-count-col">{{ group.capabilities.length }}</td>
      <td class="c2-state-col">
        <template v-if="group.included"><strong>Included</strong> on every measured context</template>
        <template v-else-if="group.includedOn.length > 0"><strong>ruled for {{ group.ruledTotal }}, measurable on {{ group.includedOn.length }}</strong><template v-if="group.darkRuled.length > 0">; {{ darkRuledSentence(group) }} not measured (30033)</template></template>
        <template v-else-if="group.heldBy.length > 0"><strong>HELD</strong> &mdash; below the bar on {{ group.heldBy.length }} of {{ published.length }} measured contexts</template>
        <template v-else-if="group.darkHeldBy.length > 0"><strong>HELD</strong> &mdash; held by {{ group.darkHeldBy.map((row) => contextSentence(row.context) + ' (' + row.decisive + ' of ' + row.denominator + ')').join(', ') }}; that context is not measured, so the group is not claimed (30033)</template>
        <template v-else><strong>HELD</strong> &mdash; no eligible measured context yet, so nothing is claimed</template>
        <template v-if="!group.included && group.includedOn.length > 0"> &mdash; included on {{ group.includedOn.join(', ') }}</template>
        <template v-if="group.heldBy.length > 0">; below the bar: {{ group.heldBy.map((row) => row.context + ' ' + row.decisive + '/' + row.denominator + ' (' + row.decisivePct + '%)').join(', ') }}</template>
        <template v-if="group.unmeasured.length > 0">; not measured: {{ group.unmeasured.map((row) => row.context).join(', ') }}</template>
      </td>
      <td v-for="context in published" :key="context.context" class="c2-share">
        <template v-if="groupShare(context, group.key)">{{ groupShare(context, group.key) }}</template>
        <template v-else>—</template>
        <template v-if="groupAcceptance(context, group.key)">
          <span class="c2-acceptance">{{ groupAcceptance(context, group.key) }}</span>
        </template>
      </td>
      <td class="c2-named-col">
        <template v-if="unnamedRows(group).length">{{ unnamedRows(group).map((row) => row.id).join(', ') }}</template>
        <template v-else>—</template>
      </td>
    </tr>
  </tbody>
</table>
</div>

<p class="c2-note">Per-context inclusion is ruled for Editing and Character Sets only. For those two groups, a context that clears the {{ D3_VERDICT_BAR.passPct }}% bar on the group's in-scope basis is <strong>included on</strong> and named in the State cell, and the contexts below it are <strong>held</strong> with their fraction; a ruled context with no run on the required suite is named as ruled but not measured and is never counted as included, so the count can read &ldquo;ruled for six, measurable on four&rdquo;. Every other group keeps its previous state: <strong>included</strong> where every measured context clears the bar, otherwise <strong>held</strong> with the contexts below the bar named in its State cell. A context with no published run is named <strong>not measured</strong> and is not counted as a measured context, so no group is claimed on a context that never measured it; if that context held the group on the previous freeze, the group stays <strong>held</strong> and names it, because a public claim must never improve because data went dark. A group with no eligible measured context is held without naming a context, because no measurement may be claimed as one. A &ldquo;pass&rdquo; beside a fraction says how much of the group that run could decide, not that the terminal supports every row: it is decisiveness, and the failing rows are always printed.</p>

## The contexts behind the fractions {#contexts}

<p v-if="published.length === 0"><strong>No context has a run on the frozen suite {{ data.frozenSuiteId }}, so this page publishes no row.</strong></p>

<div v-for="context in published" :key="context.context" class="c2-context">
  <h4 class="c2-context-head">{{ context.context }} <span class="c2-verdict">{{ context.verdictText }}</span></h4>
  <p class="c2-context-basis">
    decisive/{{ context.denominator }} <strong>{{ context.decisive }}/{{ context.denominator }} = {{ context.decisivePct }}%</strong>
    &middot; run <code>{{ context.runId }}</code> &middot; suite <code>{{ context.suiteId }}</code>
    <template v-if="context.selection"> &middot; selected by the {{ context.selection }}</template>
  </p>
  <p v-if="context.inconclusive.length" class="c2-gap">
    Not decided ({{ context.inconclusive.length }}): {{ context.inconclusive.map((row) => row.featureId).join(', ') }}
  </p>
  <ul v-if="context.inconclusive.some((row) => row.note)" class="c2-causes">
    <li v-for="row in context.inconclusive.filter((entry) => entry.note)" :key="row.featureId">
      <code>{{ row.featureId }}</code> &mdash; {{ row.note }}
    </li>
  </ul>
  <p v-if="context.remainder.length" class="c2-gap">No result recorded: {{ remainderLabel(context) }}</p>
</div>

<h3>Rows this page does not publish {#not-published}</h3>

<p>These contexts have no admitted run on the frozen suite, so no row of theirs appears above. A row measured on an older probe suite is never published on this page.</p>

<p v-if="omitted.some(context => context.terminalId === 'iterm2' && context.os === 'macos')"><strong>iTerm2/macOS: no admitted row on this page</strong>. A later <a href="https://github.com/beorn/terminfo.dev/actions/runs/38862142133">iTerm qualification</a> produced a complete raw run, retained in its <a href="https://github.com/beorn/terminfo.dev/actions/runs/38862142133/artifacts/12030100467">measurement archive</a> (SHA-256 <code>467cf2f9a146af1eee35494133b3c96b84b3908d864ea38ab6531d68dcb5eb73</code>). Pixel-dependent results remain undecided because the reported dimensions could not establish calibrated whole-pixel cells; that qualification is not used in the fractions above. The <a href="https://github.com/beorn/terminfo.dev/actions/runs/38858050860">previous failed collection</a> stopped at an iTerm run-confirmation dialog. The <a href="https://github.com/beorn/terminfo.dev/actions/runs/38846758821">earlier two-window diagnostic</a> did not identify the second window. These are collection limits, not findings of unsupported capabilities. Kitty/macOS remains a separate exception, listed below.</p>

<ul class="c2-omitted">
  <li v-for="context in omitted" :key="context.context">
    <strong>{{ context.context }}</strong> &mdash; {{ context.reason }}
  </li>
</ul>

## Rows in scope that are never scored in apps {#library-only}

<p><strong>{{ data.libraryOnly.length }}</strong> rows in scope are decided by the parser surface only, never by an app run. They are left out of the app-observable fractions above, and a group that counts them includes them in its ruled acceptance basis (scrollback divides over 9, reset over 5). Whether the capability is <em>included</em> is its group's state, shown in the State cell:</p>

<ul>
  <li v-for="row in data.libraryOnly" :key="row.id"><code>{{ row.id }}</code> &mdash; {{ row.name }}</li>
</ul>

<template v-if="data.unavailable.length">
<p><strong>{{ data.unavailable.length }}</strong> row in scope has no probe in the frozen suite at all, so no run can decide it:</p>
<ul>
  <li v-for="row in data.unavailable" :key="row.id"><code>{{ row.id }}</code> &mdash; {{ row.name }}</li>
</ul>
</template>

## What this page is, and is not {#scope}

- <strong>In scope</strong> means the capability is on this page; <strong>included</strong> means its group cleared the bar on every measured context, and for Editing and Character Sets the page also says <strong>included on</strong> each named context that clears it while the rest are held. Neither means the capability is <strong>ratified</strong> &mdash; candidate 2 has not been ratified, and that decision belongs to the operator.
- The published matrix and every terminal page still report <strong>Release 1</strong>. This page is a second, separate surface: nothing on it changes those numbers.
- Every fraction here comes from the same reader the command line uses (<code>bun run decisive-share --cohort candidate2</code>), and both divide over the same rows, so the page and the command cannot disagree.
- A context whose selected run is not on suite <code>{{ data.frozenSuiteId }}</code> is listed by name under &ldquo;Rows this page does not publish&rdquo;, with the reader's own reason. It is never shown as a zero.

<style scoped>
.c2-lede { font-size: 1.05rem; }
.c2-basis p { margin: 0.4em 0; }
.c2-scroll { overflow-x: auto; }
.c2-matrix { border-collapse: collapse; width: 100%; font-size: 0.86rem; }
.c2-matrix th, .c2-matrix td { padding: 0.35em 0.6em; border-bottom: 1px solid var(--vp-c-divider); text-align: left; white-space: nowrap; }
.c2-matrix thead th { font-weight: 600; }
.c2-group-col { min-width: 12em; }
.c2-count-col { text-align: right; }
.c2-named-col { white-space: normal; min-width: 12em; color: var(--vp-c-text-2); }
.c2-share { font-variant-numeric: tabular-nums; }
.c2-acceptance { display: block; font-size: 0.78rem; color: var(--vp-c-text-2); }
.c2-note, .c2-gap { color: var(--vp-c-text-2); font-size: 0.9rem; }
.c2-context { margin: 1.2em 0; }
.c2-context-head { margin: 0 0 0.2em; }
.c2-verdict { font-weight: 600; margin-left: 0.5em; }
.c2-context-basis { margin: 0.2em 0; font-size: 0.92rem; }
.c2-causes { font-size: 0.88rem; color: var(--vp-c-text-2); }
.c2-omitted { font-size: 0.92rem; }
</style>
