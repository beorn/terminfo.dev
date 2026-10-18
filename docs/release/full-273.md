---
title: All 273 capabilities — development preview
outline: [2, 3]
prev: false
next: false
---

<script setup>
import { data } from '../data/full-project.data'
import { D3_VERDICT_BAR } from '../data/release-scope.ts'

const collected = data.contexts.filter((row) => row.collected)
const uncollected = data.contexts.filter((row) => !row.collected)
const included = collected.filter((row) => row.result.included)
const instrumentLimits = data.instrumentLimits

function label(row) {
  return row.result.included ? 'included' : 'not included'
}
</script>

# All 273 capabilities across 33 contexts

::: warning Development reading — private, unadmitted, not a result
This page scores the live tree suite against the runs that exist today. It is not an admitted pass, it selects no final suite, and nothing here is a publication claim. A context with no run on the required suite is printed as **NOT COLLECTED** with its cause — never as zero percent and never as included.
:::

## Scope

- **{{ data.catalogRows }} catalog rows** across {{ data.contexts.length }} expected contexts.
- Required suite: <code>{{ data.suiteId }}</code>.
- **{{ collected.length }} contexts collected**, **{{ uncollected.length }} NOT COLLECTED**, **{{ included.length }} contexts above the {{ D3_VERDICT_BAR.passPct }}% bar**.
- The bar is at least {{ D3_VERDICT_BAR.passPct }}% decisive. Supported and measured-unsupported outcomes are decisive; absent observations and collection failures are not.
- With N catalog rows, B design exclusions and I reviewed instrument limits, **D = N − |B ∪ I|**; every score prints **S/D**, every ceiling prints **D/N**. Overlapping exclusions are counted once.
- Every collected context lists all {{ data.catalogRows }} catalog rows under its detail block, each with its state, observation method and the run's own words.

## The contexts

<table>
  <thead>
    <tr><th>Context</th><th>Kind</th><th>Decisive</th><th>Ceiling</th><th>State</th></tr>
  </thead>
  <tbody>
    <tr v-for="row in data.contexts" :key="row.context">
      <td><code>{{ row.context }}</code></td>
      <td>{{ row.kind }}</td>
      <template v-if="row.collected">
        <td>
          {{ row.result.fraction }} &middot; {{ row.result.pct }}%
          &middot; {{ row.result.instrumentLimitCount }} applied instrument limits ({{ instrumentLimits.length }} recorded)
        </td>
        <td>{{ row.result.ceiling }}</td>
        <td>{{ label(row) }}</td>
      </template>
      <template v-else>
        <td>&mdash;</td>
        <td>&mdash;</td>
        <td><strong>NOT COLLECTED</strong> &mdash; {{ row.cause }}</td>
      </template>
    </tr>
  </tbody>
</table>

## Groups per collected context

<div v-for="row in collected" :key="row.context">
  <h3>{{ row.context }} <small>({{ row.result.fraction }} &middot; ceiling {{ row.result.ceiling }} &middot; {{ label(row) }})</small></h3>
  <p>
    Run <code>{{ row.run.runId }}</code> &middot; suite <code>{{ row.run.suiteId }}</code> &middot; {{ row.run.version }} &middot; selected by the {{ row.run.selection }}.
    {{ row.result.excluded.length }} rows are named and excluded from this denominator; their original observations are retained below.
    Not decisive: {{ row.result.counts.inconclusive }} inconclusive &middot; {{ row.result.counts.error }} error &middot; {{ row.result.counts.untested }} untested.
    Each measured row uses the existing evidence cell; reviewed evidence opens its document, while unreviewed/withdrawn evidence is labelled.
  </p>
  <table>
    <thead>
      <tr><th>Group</th><th>Rows</th><th>Decisive</th><th>Ceiling</th><th>State</th></tr>
    </thead>
    <tbody>
      <tr v-for="group in row.result.groups" :key="group.key">
        <td><code>{{ group.key }}</code></td>
        <td>{{ group.catalogRows }}</td>
        <td><template v-if="group.verdict">{{ group.fraction }} &middot; {{ group.pct }}% &middot; {{ group.instrumentLimitCount }} applied instrument limits</template><template v-else>&mdash;</template></td>
        <td>{{ group.ceiling }}</td>
        <td>
          <template v-if="group.verdict">{{ group.included ? 'included' : 'not included' }}</template><template v-else>every row excluded</template>
          <template v-if="group.verdict && !group.included"> &mdash; {{ group.counts.inconclusive }} inconclusive, {{ group.counts.error }} error, {{ group.counts.untested }} untested</template>
        </td>
      </tr>
    </tbody>
  </table>
  <details>
    <summary>All {{ row.observations.length }} catalog rows, with state, method and the run's own words</summary>
    <table>
      <thead>
        <tr><th>Row</th><th>Evidence</th><th>Method</th><th>Observation</th></tr>
      </thead>
      <tbody>
        <tr v-for="observation in row.observations" :key="observation.id">
          <td><code>{{ observation.id }}</code></td>
          <td>
            <ResultEvidenceCell
              v-if="data.evidenceVersions[row.context]?.cells[observation.id]"
              :feature-id="observation.id"
              :feature-name="observation.id"
              :target-name="row.context"
              :version="data.evidenceVersions[row.context]"
              :cell="data.evidenceVersions[row.context].cells[observation.id]"
              display="text" />
            <template v-else>{{ observation.state }}</template>
          </td>
          <td>{{ observation.method ?? '—' }}</td>
          <td>
            <template v-if="observation.note">{{ observation.note }}</template>
            <template v-if="observation.note && observation.reason"> &middot; </template>
            <template v-if="observation.reason">limitation: {{ observation.reason }}</template>
            <template v-if="!observation.note && !observation.reason">&mdash;</template>
          </td>
        </tr>
      </tbody>
    </table>
  </details>
  <details>
    <summary>Named exclusions and their retained observations</summary>
    <ul>
      <li v-for="entry in row.result.excludedObservations" :key="entry.id">
        <code>{{ entry.id }}</code> &mdash; {{ entry.cause }} exclusion &middot; observed: {{ entry.state }}
      </li>
    </ul>
  </details>
</div>

## The three named sets

### Design exclusions ({{ data.designExclusions.length }})

These rows leave every context's denominator for a stated design reason. Their observations are never erased.

<ul>
  <li v-for="id in data.designExclusions" :key="id"><code>{{ id }}</code> &mdash; {{ data.designExclusionCauses[id] }}</li>
</ul>

### Missing definitions kept IN ({{ data.missingDefinitions.length }})

These rows have no probe definition yet. They stay in the denominator as open work and are named beside every score.

<ul>
  <li v-for="id in data.missingDefinitions" :key="id"><code>{{ id }}</code></li>
</ul>

### Reviewed instrument limits ({{ instrumentLimits.length }})

A row may leave one context's denominator only for a named, reviewed local instrument limit that no planned or approved work in this release can cure. Each cause names what WOULD observe the row — a per-terminal adapter or a fixture — and says that this release does not build it. They are recorded here now; whether the release bar counts them out of the denominator is a separate scope decision, and no row is subtracted silently under either answer.

<table>
  <thead>
    <tr><th>Row</th><th>Why it is unobserved, and what would observe it</th></tr>
  </thead>
  <tbody>
    <tr v-for="limit in instrumentLimits" :key="limit.id">
      <td><code>{{ limit.id }}</code></td>
      <td>{{ limit.cause }}</td>
    </tr>
  </tbody>
</table>

## Contexts not collected

<ul>
  <li v-for="row in uncollected" :key="row.context"><code>{{ row.context }}</code> &mdash; {{ row.cause }}</li>
</ul>
