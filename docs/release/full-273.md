---
title: All 273 features — development preview
outline: [2, 3]
prev: false
next: false
---

<script setup>
import { data } from '../data/full-project.data'
import { currentCoverageSentence, publicResultFor } from '../data/release-scope.ts'
const collected = data.contexts.filter((row) => row.collected)
function resultFor(row, id) { return publicResultFor(data.evidenceContexts[row.context], id) }
</script>

# All 273 features across 33 contexts

::: warning Development reading — private, unadmitted, not a result
This page reads composed contexts with original sealed sources on the required suite. Retained cells from other suites stay visible with a hold reason and do not count as release evidence. A context without a source on the required suite is **NOT COLLECTED**, with its cause. Historical results remain available through the [historical API](/api#historical-v1-and-v2); they do not complete this cohort.
:::

<div v-if="data.working">
  <h2 id="hourly-raw">Hourly re-measure: raw, unreviewed</h2>
  <p><strong>Hourly run <code>{{ data.working.run.id }}</code>, started {{ data.working.run.startedAt }}</strong>; newest capture {{ data.working.run.newestCaptureAt }}; suite <code v-for="suite in data.working.run.suites" :key="suite">{{ suite }} </code>. An old time here means the hourly re-measure has stalled.</p>
  <div v-if="data.working.unreadable" class="danger custom-block"><p class="custom-block-title">Hourly run not shown</p><p><strong>{{ data.working.unreadable.banner }}</strong></p><p>{{ data.working.unreadable.reason }}</p></div>
  <p>{{ data.working.rule }} Where a reviewed answer exists it is the headline; the raw cell sits beside it and says <em>differs from reviewed</em> when it disagrees on the same suite. A pending source review reads <em>pending review</em>, not failure. Nothing on this page counts raw cells.</p>
  <p v-if="data.working.unmeasured.length">Not measured in this run: <span v-for="row in data.working.unmeasured" :key="row.engine"><code>{{ row.engine }}</code> ({{ row.status }}: {{ row.reason }}) </span></p>
  <div v-for="context in data.working.contexts" :key="context.contextKey">
    <h3>{{ context.engine }} <small>raw, unreviewed &middot; {{ context.reviewedContextKey ? 'beside reviewed ' + context.reviewedContextKey : 'raw is the only answer' }}</small></h3>
    <p>Context <code>{{ context.contextKey }}</code> &middot; version {{ context.version }} &middot; raw run <code>{{ context.runId }}</code> &middot; suite <code>{{ context.suiteId }}</code> &middot; measured {{ context.measuredAt }}.</p>
    <details>
      <summary>All {{ context.cells.length }} features: reviewed headline, raw beside it</summary>
      <table>
        <thead><tr><th>Feature</th><th>Reviewed (headline)</th><th>Raw, unreviewed</th></tr></thead>
        <tbody><tr v-for="cell in context.cells" :key="cell.featureId">
          <td><code>{{ cell.featureId }}</code></td>
          <td><template v-if="cell.reviewed"><strong>{{ cell.reviewed.display }}</strong><br><small>run <code>{{ cell.reviewed.runId }}</code> &middot; {{ cell.reviewed.suiteLabel }} &middot; {{ cell.reviewed.measuredAt }}</small></template><template v-else>&mdash; no reviewed answer</template></td>
          <td><strong v-if="cell.headline === 'raw'">{{ cell.raw.display }}</strong><template v-else>{{ cell.raw.display }}</template> <em>({{ cell.raw.label }})</em><strong v-if="cell.raw.differsFromReviewed"> &mdash; differs from reviewed</strong><br><small>run <code>{{ cell.raw.runId }}</code> &middot; suite <code>{{ cell.raw.suiteId }}</code> &middot; {{ cell.raw.measuredAt }}</small></td>
        </tr></tbody>
      </table>
    </details>
  </div>
</div>

## Scope

- **{{ data.catalogRows }} catalogue positions** across {{ data.contexts.length }} required contexts: **{{ data.gradedRows }} graded features** plus **{{ data.environmentGroups }} environment groups** (manual by design, ungraded).
- Required suite: <code>{{ data.suiteId }}</code>.
- **{{ data.collected }} contexts collected**, **{{ data.notCollected }} NOT COLLECTED**; {{ data.recordedPositions }} explicit feature positions.
- Score is **Supported / all {{ data.gradedRows }} graded features**; the {{ data.environmentGroups }} environment groups are ungraded and never in the denominator. Unsupported and Untestable remain in the denominator.
- Completion requires **zero TEST TODO and zero TEST FAILURE among the graded features in every required context**, on this one suite. Cohort: **{{ data.complete ? 'complete' : 'incomplete' }}**.
- No current sealed runs means no current score. [Historical results remain available](/api#historical-v1-and-v2).

## Named tool gaps

Accepted metadata snapshot: <code>{{ data.toolGaps.authorityPath }}</code>, source SHA-256 <code>{{ data.toolGaps.authoritySha256 }}</code>.
Membership: **{{ data.toolGaps.membershipComplete ? 'complete' : 'incomplete' }}**. An accepted draft receipt cannot name a different selected sealed receipt.

<table>
  <thead><tr><th>Named gap</th><th>Accepted cells</th><th>Exact selected matches</th></tr></thead>
  <tbody><tr v-for="group in data.toolGaps.classes" :key="group.name"><td>{{ group.name }}</td><td>{{ group.accepted }}</td><td>{{ group.matched }}</td></tr></tbody>
</table>

Graded positions: **{{ data.toolGaps.namedTodo }} named TEST TODO**, **{{ data.toolGaps.unnamedTodo }} unnamed TEST TODO**, **{{ data.toolGaps.failures }} TEST FAILURE**.
Release consideration: **{{ data.toolGaps.eligibleForConsideration ? 'eligible for operator review' : 'blocked' }}**. Missing contexts, incomplete membership, unnamed TODO or any failure block consideration. Existing admission and operator batch GO remain required; this preview publishes no result.

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
  <p>Context <code>{{ row.selection.contextKey }}</code> &middot; selected by {{ row.selection.method }}.</p>
  <ul><li v-for="source in row.sources" :key="source.runId">Original run <code>{{ source.runId }}</code> &middot; version {{ data.evidenceContexts[row.context].sources[source.runId].subject.version }} &middot; suite <code>{{ source.suiteId }}</code> &middot; measured {{ source.measuredAt }}.</li></ul>
  <p v-if="row.heldIds.length">Retained cells excluded from release evidence: {{ row.heldIds.join(', ') }}.</p>
  <table>
    <thead><tr><th>Group</th><th>Supported / all</th><th>Completion</th></tr></thead>
    <tbody><tr v-for="group in row.result.groups" :key="group.key"><td>{{ group.key }}</td><td>{{ group.fraction }} &middot; {{ group.pct }}%</td><td>{{ group.complete ? 'complete' : 'incomplete' }} &mdash; {{ currentCoverageSentence(group) }}</td></tr></tbody>
  </table>
  <details>
    <summary>All {{ row.observations.length }} features and their recorded evidence</summary>
    <table>
      <thead><tr><th>Feature</th><th>Result</th><th>Assertion type</th><th>Original source</th><th>Recorded reason / release hold</th></tr></thead>
      <tbody><tr v-for="observation in row.observations" :key="observation.id">
        <td><code>{{ observation.id }}</code></td>
        <td><ResultEvidenceCell v-if="resultFor(row, observation.id)"
          :feature-id="observation.id" :feature-name="observation.id" :subject-name="row.context"
          :version="data.evidenceContexts[row.context]" :cell="resultFor(row, observation.id)" display="text" />
          <template v-else>{{ observation.state }}</template></td>
        <td>{{ observation.method ?? '—' }}</td>
        <td><code>{{ observation.origin.runId }}</code> · {{ observation.measuredAt }} · suite <code>{{ observation.suiteId }}</code></td>
        <td><p v-if="observation.hold">{{ observation.hold }}</p><template v-if="observation.note">{{ observation.note }}</template><template v-if="observation.reason">limitation: {{ observation.reason }}</template><template v-if="!observation.note && !observation.reason && !observation.hold">&mdash;</template></td>
      </tr></tbody>
    </table>
  </details>
</div>
