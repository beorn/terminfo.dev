<script setup lang="ts">
import { computed, ref } from "vue"
import type { WorkingContext } from "../../data/working-runs"
import type { ClientProbeData, ClientWorkingView } from "../../data/probes.data"
import { evidenceStatus } from "./evidence-status"

const props = defineProps<{ history: ClientWorkingView[]; states?: ClientProbeData["workingStates"]; originals?: ClientProbeData["workingOriginals"]; featureId?: string; subjects?: Array<Pick<WorkingContext, "engine" | "kind">> }>()
const matches = (row: Pick<WorkingContext, "engine" | "kind">) => !props.subjects || props.subjects.some(subject => subject.engine === row.engine && subject.kind === row.kind)
const originalEntries = computed(() => Object.entries(props.originals ?? {}).flatMap(([contextKey, originals]) => originals
  .filter(original => matches({engine: original.subject.id, kind: original.subject.kind}))
  .map(original => ({key: contextKey + "/" + original.sha256, contextKey, original})))
  .sort((left, right) => left.original.measuredAt.localeCompare(right.original.measuredAt) || left.key.localeCompare(right.key)))
const originalKey = ref(originalEntries.value.at(-1)?.key ?? "")
const originalEntry = computed(() => originalEntries.value.find(entry => entry.key === originalKey.value))
const originalCells = computed(() => Object.entries(originalEntry.value?.original.states ?? {}).filter(([id]) => !props.featureId || id === props.featureId))
const collectionId = ref([...props.history].reverse().find(view => view.contexts.some(matches) || (view.unreadable && (!props.subjects || props.subjects.some(subject => subject.kind === "lib" ? !view.run.id.startsWith("apps/") : view.run.id.startsWith(`apps/${subject.engine}/`)))))?.run.id ?? props.history.at(-1)?.run.id ?? "")
const selected = computed(() => props.history.find((view) => view.run.id === collectionId.value))
const contexts = computed(() => selected.value?.contexts.filter((row) => !props.subjects || props.subjects.some(subject => subject.engine === row.engine && subject.kind === row.kind)) ?? [])
const contextKey = ref(contexts.value[0]?.contextKey ?? "")
const context = computed(() => contexts.value.find((row) => row.contextKey === contextKey.value))
// #33037: a context names its shared status map; a name with no map is a broken payload, never "no statuses".
const contextStates = computed(() => {
  const ref = context.value?.statesRef
  if (ref === undefined) return {}
  const states = props.states?.[ref]
  if (!states) throw new Error(`Run history context ${context.value?.contextKey} names status map ${ref}, which the page data lacks`)
  return states
})
const cells = computed(() => Object.entries(contextStates.value).filter(([id]) => !props.featureId || id === props.featureId))
const kindLabel = (kind: string) => kind === "lib" ? "Library" : kind === "mux" ? "Multiplexer" : kind === "term" ? "Application" : kind
const gaps = computed(() => props.history.flatMap(view => view.unmeasured).filter(gap => !props.subjects || props.subjects.some(subject => gap.engine === subject.engine || (subject.kind !== "lib" && gap.engine.startsWith(subject.engine + "/")))))
</script>

<template>
<section id="run-history" class="run-history">
  <div v-if="originalEntries.length" id="selected-original-history">
    <h2>Stored original measurements</h2>
    <p>Each original keeps its recorded statuses and measurement time. Choosing one here does not change reviewed answers, scores or completion.</p>
    <label>Original measurement
      <select v-model="originalKey">
        <option v-for="entry in originalEntries" :key="entry.key" :value="entry.key">{{ kindLabel(entry.original.subject.kind) }}: {{ entry.original.subject.id }} {{ entry.original.subject.version }} · {{ entry.original.subject.os ?? 'OS not recorded' }} · {{ entry.original.measuredAt }} · {{ entry.original.sha256.slice(0, 8) }}</option>
      </select>
    </label>
    <template v-if="originalEntry">
      <p>Context <code>{{ originalEntry.contextKey }}</code>; <strong>{{ kindLabel(originalEntry.original.subject.kind) }}: {{ originalEntry.original.subject.id }} {{ originalEntry.original.subject.version }}</strong>; OS {{ originalEntry.original.subject.os ?? 'not recorded' }}.</p>
      <p>Original run <code>{{ originalEntry.original.runId }}</code>; measured {{ originalEntry.original.measuredAt }}; suite <code>{{ originalEntry.original.suiteId }}</code>; source <code>{{ originalEntry.original.sourceRevision }}</code>; capture SHA-256 <code>{{ originalEntry.original.sha256 }}</code>.</p>
      <p>Stored Supported / graded features: {{ originalEntry.original.score.supported }} / {{ originalEntry.original.score.all }}. Environment groups are ungraded.</p>
      <p>Comparison unavailable: the selected-original projection does not retain qualified runtime identity.</p>
      <table v-if="originalCells.length">
        <thead><tr><th>Probe</th><th>Stored status</th></tr></thead>
        <tbody><tr v-for="cell in originalCells" :key="cell[0]"><td><code>{{ cell[0] }}</code></td><td>{{ evidenceStatus(cell[0], cell[1]).text }}</td></tr></tbody>
      </table>
      <p v-else>No probe result is recorded for this feature in this original.</p>
    </template>
  </div>
  <h2>Retained run history — raw, unreviewed</h2>
  <p>Each collection keeps its original probe statuses and receipts. These results do not change accepted answers, scores or completion. Missing or untrusted inputs remain visible.</p>
  <ul v-if="gaps.length">
    <li v-for="gap in gaps" :key="gap.engine"><code>{{ gap.engine }}</code>: {{ gap.status }} — {{ gap.reason }}</li>
  </ul>
  <label>Collection
    <select v-model="collectionId">
      <option v-for="view in history" :key="view.run.id" :value="view.run.id">{{ view.run.startedAt }} · {{ view.run.id }}{{ view.unreadable ? ' · unreadable' : '' }}</option>
    </select>
  </label>
  <p>{{ history.length }} retained collection entries, including entries with unreadable inputs. Oldest {{ history[0]?.run.startedAt }}, newest {{ history.at(-1)?.run.startedAt }}. Times are UTC.</p>
  <template v-if="selected">
    <p>Collection <code>{{ selected.run.id }}</code>; started {{ selected.run.startedAt }}; newest capture {{ selected.run.newestCaptureAt }}.</p>
    <div v-if="selected.unreadable" class="danger custom-block">
      <p><strong>{{ selected.unreadable.banner }}</strong></p>
      <p>{{ selected.unreadable.reason }}</p>
    </div>
    <template v-else-if="contexts.length">
      <label>Recorded context
        <select v-model="contextKey">
          <option v-for="row in contexts" :key="row.contextKey" :value="row.contextKey">{{ kindLabel(row.kind) }}: {{ row.engine }} {{ row.version }} · {{ row.contextKey }}</option>
        </select>
      </label>
      <template v-if="context">
        <p><strong>{{ kindLabel(context.kind) }}: {{ context.engine }} {{ context.version }}</strong>; original capture <code>{{ context.runId }}</code>; measured {{ context.measuredAt }}; suite <code>{{ context.suiteId }}</code>; source <code>{{ context.sourceRevision }}</code>; capture SHA-256 <code>{{ context.sha256 }}</code>; identity {{ context.identity }}.</p>
        <p>Raw Supported / graded features: {{ context.counts.supported }} / {{ context.positions }}. Environment groups are ungraded; shown-but-not-counted and reference results retain the existing rollup treatment.</p>
        <p v-if="context.changeBaseline">Recorded comparison baseline: <code>{{ context.changeBaseline }}</code>.</p>
        <p>{{ context.changeQualification }}</p>
        <table v-if="cells.length">
          <thead><tr><th>Probe</th><th>Recorded status</th><th>Recorded change from baseline</th></tr></thead>
          <tbody><tr v-for="cell in cells" :key="cell[0]">
            <td><code>{{ cell[0] }}</code></td>
            <td>{{ evidenceStatus(cell[0], cell[1]).text }}</td>
            <td>{{ context.changes === undefined ? 'Comparison unavailable' : context.changes[cell[0]] ?? 'No recorded status change' }}</td>
          </tr></tbody>
        </table>
        <p v-else>No probe result is recorded for this feature in this context.</p>
      </template>
      <p v-else>The selected context was not recorded in this collection; choose another recorded context.</p>
    </template>
    <p v-else>No matching context was recorded in this collection.</p>
  </template>
</section>
</template>

<style scoped>
.run-history { margin: 2rem 0; padding-top: 1rem; border-top: 1px solid var(--vp-c-divider); }
label { display: block; margin: 1rem 0; }
select { display: block; max-width: 100%; padding: .35rem; border: 1px solid var(--vp-c-divider); border-radius: 4px; background: var(--vp-c-bg); }
code { overflow-wrap: anywhere; }
</style>
