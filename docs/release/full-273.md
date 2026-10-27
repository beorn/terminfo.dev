---
title: All 273 features — development preview
outline: [2, 3]
prev: false
next: false
---

<script setup>
import { data } from '../data/full-project.data'
import { currentCoverageSentence } from '../data/release-scope.ts'
const collected = data.contexts.filter((row) => row.collected)
function resultFor(row, id) { return data.evidenceVersions[row.context]?.results.find((result) => result.featureId === id) }
</script>

# All 273 features across 33 contexts

::: warning Development reading — private, unadmitted, not a result
This page reads current sealed execution results on the required suite. A context without a current run is **NOT COLLECTED**, with its cause. Historical results remain available through the [historical API](/api#historical-v1-and-v2); they do not complete this cohort.
:::

## Scope

- **{{ data.catalogRows }} catalogue positions** across {{ data.contexts.length }} required contexts: **{{ data.gradedRows }} graded features** plus **{{ data.environmentGroups }} environment groups** (manual by design, ungraded).
- Required suite: <code>{{ data.suiteId }}</code>.
- **{{ data.collected }} contexts collected**, **{{ data.notCollected }} NOT COLLECTED**; {{ data.recordedPositions }} explicit feature positions.
- Score is **Supported / all {{ data.gradedRows }} graded features**; the {{ data.environmentGroups }} environment groups are ungraded and never in the denominator. Unsupported and Untestable remain in the denominator.
- Completion requires **zero TEST TODO and zero TEST FAILURE among the graded features in every required context**, on this one suite. Cohort: **{{ data.complete ? 'complete' : 'incomplete' }}**.
- No current sealed runs means no current score. [Historical results remain available](/api#historical-v1-and-v2).

## The contexts

<table>
  <thead><tr><th>Context</th><th>Kind</th><th>Supported / all</th><th>Completion</th></tr></thead>
  <tbody>
    <tr v-for="row in data.contexts" :key="row.context">
      <td><code>{{ row.context }}</code></td><td>{{ row.kind }}</td>
      <template v-if="row.collected">
        <td>{{ row.result.fraction }} &middot; {{ row.result.pct }}%</td>
        <td>{{ row.result.complete ? 'complete' : 'incomplete' }} &mdash; {{ currentCoverageSentence(row.result) }}</td>
      </template>
      <template v-else><td>&mdash;</td><td><strong>NOT COLLECTED</strong> &mdash; {{ row.cause }}</td></template>
    </tr>
  </tbody>
</table>

## Probe results

<div v-for="row in collected" :key="row.context">
  <h3>{{ row.context }} <small>{{ row.result.fraction }} Supported / all</small></h3>
  <p>Run <code>{{ row.run.runId }}</code> &middot; suite <code>{{ row.run.suiteId }}</code> &middot; {{ row.run.version }} &middot; selected by {{ row.run.selection }}.</p>
  <table>
    <thead><tr><th>Group</th><th>Supported / all</th><th>Completion</th></tr></thead>
    <tbody><tr v-for="group in row.result.groups" :key="group.key"><td>{{ group.key }}</td><td>{{ group.fraction }} &middot; {{ group.pct }}%</td><td>{{ group.complete ? 'complete' : 'incomplete' }} &mdash; {{ currentCoverageSentence(group) }}</td></tr></tbody>
  </table>
  <details>
    <summary>All {{ row.observations.length }} features and their recorded evidence</summary>
    <table>
      <thead><tr><th>Capability</th><th>Result</th><th>Method</th><th>Recorded reason</th></tr></thead>
      <tbody><tr v-for="observation in row.observations" :key="observation.id">
        <td><code>{{ observation.id }}</code></td>
        <td><ResultEvidenceCell v-if="resultFor(row, observation.id)"
          :feature-id="observation.id" :feature-name="observation.id" :subject-name="row.context"
          :version="data.evidenceVersions[row.context]" :cell="resultFor(row, observation.id)" display="text" />
          <template v-else>{{ observation.state }}</template></td>
        <td>{{ observation.method ?? '—' }}</td>
        <td><template v-if="observation.note">{{ observation.note }}</template><template v-if="observation.reason">limitation: {{ observation.reason }}</template><template v-if="!observation.note && !observation.reason">&mdash;</template></td>
      </tr></tbody>
    </table>
  </details>
</div>
