<script setup lang="ts">
import { computed, ref } from "vue"
import { withBase } from "vitepress"
import type { WorkingContext } from "../../data/working-runs"
import type { ClientProbeData, ClientWorkingView, WorkingHistoryPayload } from "../../data/probes.data"
import { evidenceStatus, evidenceStatusWords } from "./evidence-status"
import type { FeatureResultStatus } from "@terminfo/probe-defs"
import { displayMeasuredDate, displayOs } from "./display-version"
import { contextLabel } from "./context-label"

let cachedHistoryPromise: Promise<WorkingHistoryPayload> | null = null
function fetchWorkingHistory(): Promise<WorkingHistoryPayload> {
  if (!cachedHistoryPromise) {
    cachedHistoryPromise = fetch(withBase("/assets/working-history.json")).then(async (res) => {
      if (!res.ok) throw new Error(`Failed to load /assets/working-history.json (HTTP ${res.status})`)
      return (await res.json()) as WorkingHistoryPayload
    })
  }
  return cachedHistoryPromise
}

const props = defineProps<{
  available?: boolean
  history?: ClientWorkingView[]
  states?: ClientProbeData["workingStates"]
  originals?: ClientProbeData["workingOriginals"]
  featureId?: string
  subjects?: Array<Pick<WorkingContext, "engine" | "kind">>
}>()

const loaded = ref<WorkingHistoryPayload | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)

async function onDetailsToggle(event: Event) {
  const details = event.target as HTMLDetailsElement | null
  if (!details?.open || props.history || loaded.value || loading.value || !props.available) return
  loading.value = true
  loadError.value = null
  try {
    loaded.value = await fetchWorkingHistory()
    if (!originalKey.value) originalKey.value = originalEntries.value.at(-1)?.key ?? ""
    if (!collectionId.value) collectionId.value = defaultCollectionId()
    if (!contextOptionId.value) contextOptionId.value = contexts.value[0]?.optionId ?? ""
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

const effectiveHistory = computed(() => props.history ?? loaded.value?.workingHistory ?? [])
const effectiveStates = computed(() => props.states ?? loaded.value?.workingStates)
const effectiveOriginals = computed(() => props.originals ?? loaded.value?.workingOriginals)

// #37341 Q1: the working view prints a status in the cell's own words; an undecided one reads "No result yet".
const statusWords = (featureId: string, status: FeatureResultStatus | "no-result") =>
  evidenceStatusWords(evidenceStatus(featureId, status === "no-result" ? undefined : status))
const matches = (row: Pick<WorkingContext, "engine" | "kind">) =>
  !props.subjects || props.subjects.some((subject) => subject.engine === row.engine && subject.kind === row.kind)
const originalEntries = computed(() =>
  Object.entries(effectiveOriginals.value ?? {})
    .flatMap(([contextKey, originals]) =>
      originals
        .filter((original) => matches({ engine: original.subject.id, kind: original.subject.kind }))
        .map((original) => ({
          sortKey: contextKey + "/" + original.sha256,
          contextKey,
          original,
        })),
    )
    .sort(
      (left, right) =>
        left.original.measuredAt.localeCompare(right.original.measuredAt) || left.sortKey.localeCompare(right.sortKey),
    )
    .map((entry, index) => ({
      ...entry,
      // #37631: short public option value (never embed raw contextKey with host paths/flags in HTML attributes).
      key: `${index}-${entry.original.sha256.slice(0, 12)}`,
    })),
)
const originalKey = ref(originalEntries.value.at(-1)?.key ?? "")
const originalEntry = computed(() => originalEntries.value.find((entry) => entry.key === originalKey.value))
const originalCells = computed(() =>
  Object.entries(originalEntry.value?.original.states ?? {}).filter(
    ([id]) => !props.featureId || id === props.featureId,
  ),
)
function defaultCollectionId(): string {
  return (
    [...effectiveHistory.value]
      .reverse()
      .find(
        (view) =>
          view.contexts.some(matches) ||
          (view.unreadable &&
            (!props.subjects ||
              props.subjects.some((subject) =>
                subject.kind === "lib"
                  ? !view.run.id.startsWith("apps/")
                  : view.run.id.startsWith(`apps/${subject.engine}/`),
              ))),
      )?.run.id ??
    effectiveHistory.value.at(-1)?.run.id ??
    ""
  )
}
const collectionId = ref(defaultCollectionId())
const selected = computed(() => effectiveHistory.value.find((view) => view.run.id === collectionId.value))
const contexts = computed(() =>
  (
    selected.value?.contexts.filter(
      (row) =>
        !props.subjects || props.subjects.some((subject) => subject.engine === row.engine && subject.kind === row.kind),
    ) ?? []
  ).map((row, index) => ({
    ...row,
    // #37631: short public option value (never embed raw contextKey with host paths/flags in HTML attributes).
    optionId: `${index}-${row.sha256.slice(0, 12)}`,
  })),
)
const contextOptionId = ref(contexts.value[0]?.optionId ?? "")
const context = computed(() => contexts.value.find((row) => row.optionId === contextOptionId.value))
// #33037: a context names its shared status map; a name with no map is a broken payload, never "no statuses".
const contextStates = computed(() => {
  const ref = context.value?.statesRef
  if (ref === undefined) return {}
  const states = effectiveStates.value?.[ref]
  if (!states)
    throw new Error(
      `Run history context ${context.value?.contextKey} names status map ${ref}, which the page data lacks`,
    )
  return states
})
const cells = computed(() =>
  Object.entries(contextStates.value).filter(([id]) => !props.featureId || id === props.featureId),
)
const kindLabel = (kind: string) =>
  kind === "lib" ? "Library" : kind === "mux" ? "Multiplexer" : kind === "term" ? "Application" : kind
const gaps = computed(() =>
  effectiveHistory.value
    .flatMap((view) => view.unmeasured)
    .filter(
      (gap) =>
        !props.subjects ||
        props.subjects.some(
          (subject) =>
            gap.engine === subject.engine || (subject.kind !== "lib" && gap.engine.startsWith(subject.engine + "/")),
        ),
    ),
)
</script>

<!-- oxfmt would add spaces inside this template's text nodes, which changes rendered spacing (33975). -->
<!-- prettier-ignore -->
<template>
<details id="run-history" class="run-history" @toggle="onDetailsToggle">
  <summary>Technical details</summary>
  <p v-if="loading" class="run-history-status">Loading measurement history…</p>
  <p v-else-if="loadError" class="run-history-status" role="alert">{{ loadError }}</p>
  <div v-if="originalEntries.length" id="selected-original-history">
    <h2>Measurement history</h2>
    <p>Recorded measurements and their technical provenance.</p>
    <label>Original measurement
      <select v-model="originalKey">
        <option v-for="entry in originalEntries" :key="entry.key" :value="entry.key">{{ kindLabel(entry.original.subject.kind) }}: {{ entry.original.subject.id }} {{ entry.original.subject.version }} · {{ displayOs(entry.original.subject.os) }} · {{ displayMeasuredDate(entry.original.measuredAt) }}</option>
      </select>
    </label>
    <template v-if="originalEntry">
      <p>Context <code>{{ contextLabel(originalEntry.contextKey) }}</code>; <strong>{{ kindLabel(originalEntry.original.subject.kind) }}: {{ originalEntry.original.subject.id }} {{ originalEntry.original.subject.version }}</strong>; OS {{ displayOs(originalEntry.original.subject.os) }}.</p>
      <p>Original run <code>{{ originalEntry.original.runId }}</code>; measured {{ displayMeasuredDate(originalEntry.original.measuredAt) }}; suite <code>{{ originalEntry.original.suiteId }}</code>; source <code>{{ originalEntry.original.sourceRevision }}</code>; capture SHA-256 <code>{{ originalEntry.original.sha256 }}</code>.</p>
      <p>Stored Supported / graded features: {{ originalEntry.original.score.supported }} / {{ originalEntry.original.score.all }}. Environment groups are ungraded.</p>
      <p>Comparison unavailable: the selected-original projection does not retain qualified runtime identity.</p>
      <table v-if="originalCells.length">
        <thead><tr><th>Probe</th><th>Stored status</th></tr></thead>
        <tbody><tr v-for="cell in originalCells" :key="cell[0]"><td><code>{{ cell[0] }}</code></td><td>{{ statusWords(cell[0], cell[1]) }}</td></tr></tbody>
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
      <option v-for="view in effectiveHistory" :key="view.run.id" :value="view.run.id">{{ displayMeasuredDate(view.run.startedAt) }}{{ view.unreadable ? ' · unreadable' : '' }}</option>
    </select>
  </label>
  <p>{{ effectiveHistory.length }} retained collection entries, including entries with unreadable inputs. <template v-if="effectiveHistory.length">Oldest {{ displayMeasuredDate(effectiveHistory[0].run.startedAt) }}, newest {{ displayMeasuredDate(effectiveHistory.at(-1)!.run.startedAt) }}.</template> Dates are UTC.</p>
  <template v-if="selected">
    <p>Collection <code>{{ selected.run.id }}</code>; started {{ displayMeasuredDate(selected.run.startedAt) }}; newest capture {{ selected.run.newestCaptureAt ? displayMeasuredDate(selected.run.newestCaptureAt) : 'not recorded' }}.</p>
    <p v-if="selected.unapplied" class="warning custom-block">{{ selected.unapplied }}</p>
    <div v-if="selected.unreadable" class="danger custom-block">
      <p><strong>{{ selected.unreadable.banner }}</strong></p>
      <p>{{ selected.unreadable.reason }}</p>
    </div>
    <template v-else-if="contexts.length">
      <label>Recorded context
        <select v-model="contextOptionId">
          <option v-for="row in contexts" :key="row.optionId" :value="row.optionId">{{ kindLabel(row.kind) }}: {{ row.engine }} {{ row.version }} · {{ contextLabel(row.contextKey) }}</option>
        </select>
      </label>
      <template v-if="context">
        <p><strong>{{ kindLabel(context.kind) }}: {{ context.engine }} {{ context.version }}</strong>; original capture <code>{{ context.runId }}</code>; measured {{ displayMeasuredDate(context.measuredAt) }}; suite <code>{{ context.suiteId }}</code>; source <code>{{ context.sourceRevision }}</code>; capture SHA-256 <code>{{ context.sha256 }}</code>; identity {{ context.identity }}.</p>
        <p>Raw Supported / graded features: {{ context.counts.supported }} / {{ context.positions }}. Environment groups are ungraded; shown-but-not-counted and reference results retain the existing rollup treatment.</p>
        <p v-if="context.changeBaseline">Recorded comparison baseline: <code>{{ context.changeBaseline }}</code>.</p>
        <p>{{ context.changeQualification }}</p>
        <table v-if="cells.length">
          <thead><tr><th>Probe</th><th>Recorded status</th><th>Recorded change from baseline</th></tr></thead>
          <tbody><tr v-for="cell in cells" :key="cell[0]">
            <td><code>{{ cell[0] }}</code></td>
            <td>{{ statusWords(cell[0], cell[1]) }}</td>
            <td>{{ context.changes === undefined ? 'Comparison unavailable' : context.changes[cell[0]] ?? 'No recorded status change' }}</td>
          </tr></tbody>
        </table>
        <p v-else>No probe result is recorded for this feature in this context.</p>
      </template>
      <p v-else>The selected context was not recorded in this collection; choose another recorded context.</p>
    </template>
    <p v-else>No matching context was recorded in this collection.</p>
  </template>
</details>
</template>

<style scoped>
.run-history {
  margin: 2rem 0;
  padding-top: 1rem;
  border-top: 1px solid var(--vp-c-divider);
}
label {
  display: block;
  margin: 1rem 0;
}
select {
  display: block;
  max-width: 100%;
  padding: 0.35rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 4px;
  background: var(--vp-c-bg);
}
code {
  overflow-wrap: anywhere;
}
</style>
