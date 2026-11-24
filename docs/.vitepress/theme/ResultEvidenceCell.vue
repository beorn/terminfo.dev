<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue"
import { withBase } from "vitepress"
import type { FeatureResultStatus } from "@terminfo/probe-defs"
import type {
  PublicProbeResult,
  PublicRunMetadata,
  PublicContextSummary,
  PublicFeatureResult,
} from "../../data/public-results"
import {
  describeTracePanes,
  formatControlBytes,
  readCellTrace,
  type LoadedCellTrace,
} from "../../data/evidence-reader"
import { data } from "../../data/probes.data"
import { describeReplyBytes, describeSentBytes, describeStepTable, type StepSource } from "../../data/step-table"
import { contextLine } from "./context-label"
import { DIFFERS_BY_CONTEXT, type AppCellStatus } from "../../data/app-cells"
import {
  evidenceStatus,
  evidenceSummaryLine,
  NO_RESULT_STATUS,
  plainExpectedSentence,
} from "./evidence-status"
import { displayOs, displayVersion } from "./display-version"
import ResultSteps from "./ResultSteps.vue"

const verifiedTraceDocuments = new Map<string, { parsed: unknown; actualSha256: string }>()

const props = withDefaults(
  defineProps<{
    featureId: string
    featureName: string
    probeGuidance?: string
    subjectName: string
    version?: PublicRunMetadata | PublicContextSummary
    cell?:
      | PublicProbeResult
      | (PublicFeatureResult & {
          joined?: { status: AppCellStatus; from: Array<{ context: string; status: FeatureResultStatus }> }
        })
    /** compact: the mark alone (matrices); text: mark and word; label: the word alone, for a list whose bullet is the mark (#37761). */
    display?: "compact" | "text" | "label"
    /** Render the result card directly inline (used by SupportBar's cascading detail pane, #37631). */
    inline?: boolean
  }>(),
  { display: "compact", inline: false },
)

// A composed context has no run identity: evidence belongs to this feature's original source.
const sourceRun = computed<PublicRunMetadata | undefined>(() => {
  const selection = props.version
  if (!selection || !("featureResults" in selection)) return selection
  const cell = selection.featureResults[props.featureId]
  if (!cell) return undefined
  const source = selection.sources[cell.origin.runId]
  if (!source) throw new Error(`Context feature ${props.featureId} lacks source ${cell.origin.runId}`)
  return source
})
const sourceFeatureId = computed(() =>
  props.version && "featureResults" in props.version
    ? (props.version.featureResults[props.featureId]?.origin.resultId ?? props.featureId)
    : props.featureId,
)
const currentResult = computed(() => (props.cell && "status" in props.cell ? props.cell : undefined))

const trigger = ref<HTMLButtonElement | null>(null)
const preview = ref<HTMLElement | null>(null)
let previewHideTimer: ReturnType<typeof setTimeout> | undefined
const previewVisible = ref(false)
const previewPosition = ref<Record<string, string>>({})
const cellTrace = ref<LoadedCellTrace | null>(null)
const evidenceLoading = ref(false)
const evidenceError = ref<string | null>(null)
let evidenceRequest = 0
let evidenceController: AbortController | null = null
// #30756 AC8: only one popover is open at a time. Module scope, because every cell is its own instance.
let openPreviewClose: (() => void) | undefined
const id = useId()
const tooltipId = `${id}-preview`

const derived = computed(() => currentResult.value !== undefined && "derived" in currentResult.value)
const joined = computed(() => (props.cell && "joined" in props.cell ? props.cell.joined : undefined))
const effectiveStatus = computed(() => joined.value?.status ?? currentResult.value?.status)
const status = computed(() => evidenceStatus(props.featureId, effectiveStatus.value, derived.value))
const blank = computed(() => status.value === NO_RESULT_STATUS)
const STATUS_WORD: Record<string, string> = {
  supported: "Supported",
  unsupported: "Unsupported",
  untestable: "Untestable",
  "probe-todo": "To do",
  "probe-invalid": "Invalid",
  "probe-conflict": "Conflicting",
}
const joinedGrades = computed(() =>
  contextLine(
    joined.value?.from,
    props.version && "contexts" in props.version ? (props.version.contexts ?? []).length : 0,
    joined.value?.status === DIFFERS_BY_CONTEXT,
    (grade) => STATUS_WORD[grade] ?? grade,
  ),
)
const shortLabel = computed(() => status.value.text)
const selectionExplanation = computed(() => {
  if (!props.version) return "No stored current result is available for this context."
  if (!props.cell) {
    return "This feature has no retained measurement in this selection."
  }
  return undefined
})
const reasonExplanation = computed(() => currentResult.value?.reason)
const legacyStatusWords = /\b(?:inconclusive|conclusive|conclusively|untested)\b|\bnot[ -]tested\b/i
function readerSafeExplanation(value?: string): string | undefined {
  if (!value) return undefined
  return legacyStatusWords.test(value)
    ? `The original wording is preserved in the downloadable record. Current displayed status: ${status.value.text}.`
    : value
}
const featureMeta = computed(() => data.featureDescriptions[props.featureId])
const probeGuidanceText = computed(() =>
  (props.probeGuidance ?? featureMeta.value?.probe)?.replace(/<\/?code>/g, ""),
)
/** Probe-declared test sequence (never a pattern filter over the full transcript, #37631). */
const declaredSequence = computed(() =>
  featureMeta.value?.sequence ? formatControlBytes(featureMeta.value.sequence) : undefined,
)
/** One plain sentence describing what should happen (never raw assertion JSON, #37631). */
const expectedSentence = computed(() =>
  plainExpectedSentence({
    body: featureMeta.value?.body,
    probeGuidance: probeGuidanceText.value,
    featureName: props.featureName,
  }),
)
const expectedIllustration = computed(() =>
  props.featureId === "charsets.utf8" ? withBase("/illustrations/utf8-cells.svg") : undefined,
)
const tracePaneCopy = computed(() => {
  if (!cellTrace.value) return undefined
  return describeTracePanes(cellTrace.value, {
    sequence: featureMeta.value?.sequence,
    probeGuidance: props.probeGuidance ?? featureMeta.value?.probe,
    subjectKind: sourceRun.value?.subject.kind,
    hasReferenceImage: Boolean(expectedIllustration.value),
  })
})

const stepSource = computed<StepSource | undefined>(() => {
  const screen = sourceRun.value?.screen
  const statusKeyword = currentResult.value?.status
  const cell = cellTrace.value?.cell
  if (cell && statusKeyword !== undefined) {
    return {
      status: statusKeyword,
      assertions: cell.assertions ?? [],
      ...(cell.queries && { queries: cell.queries }),
      ...(cell.events && { events: cell.events }),
      ...(cell.writes && { writes: cell.writes }),
      ...(screen && { screen }),
    }
  }
  return undefined
})
const stepTable = computed(() => (stepSource.value ? describeStepTable(stepSource.value) : undefined))
const sentBytes = computed(() => (stepSource.value ? describeSentBytes(stepSource.value) : undefined))
const replyBytes = computed(() => (stepSource.value ? describeReplyBytes(stepSource.value) : undefined))

/** One short templated sentence per evidence kind for the default card (#37631). */
const observedSummary = computed(() => {
  if (blank.value) return evidenceSummaryLine({ status: undefined })
  if (evidenceError.value) return evidenceError.value
  const table = stepTable.value
  const held = table?.rows.some((row) => row.result === "held")
  const reason = readerSafeExplanation(currentResult.value?.reason ?? currentResult.value?.hold)
  if (held && reason) return `${status.value.text}: ${reason}`
  if (table?.summary) return table.summary
  return evidenceSummaryLine({
    status: effectiveStatus.value,
    derived: derived.value,
    assertionType: currentResult.value?.assertionType,
    traceEvidence: cellTrace.value?.cell.evidence,
    reason,
  })
})

const publicContextLine = computed(() => {
  const run = sourceRun.value
  if (!run) return props.subjectName
  const parts = [props.subjectName, displayVersion(run.subject.version), displayOs(run.subject.os)].filter(Boolean)
  return parts.join(" · ")
})

const actionLabel = computed(() => (props.cell ? "Opens how this was tested" : "No evidence in current selection"))
const accessibleName = computed(
  () =>
    `${props.featureName} in ${props.subjectName}${sourceRun.value ? ` ${displayVersion(sourceRun.value.subject.version)}` : ""}: ${blank.value ? `${NO_RESULT_STATUS.title}.` : `${status.value.text}. ${actionLabel.value}`}`,
)
const evidenceIdentity = computed(() => {
  return JSON.stringify([
    props.featureId,
    sourceFeatureId.value,
    sourceRun.value?.runId,
    sourceRun.value?.sha256,
    sourceRun.value?.subject.version,
    currentResult.value?.status,
    props.cell?.reason,
    props.cell?.assertionType,
    sourceRun.value?.trace,
  ])
})

function invalidateEvidence(): void {
  evidenceRequest += 1
  evidenceController?.abort()
  evidenceController = null
  cellTrace.value = null
  evidenceLoading.value = false
  evidenceError.value = null
}

async function verifiedBytes(
  url: string,
  sha256: string,
  signal: AbortSignal,
  failureMessage = "evidence failed its receipt",
): Promise<ArrayBuffer> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(failureMessage)
  const [resourcePath] = url.split("#")
  if (!resourcePath) throw new Error("Invalid evidence URL")
  const response = await fetch(withBase(resourcePath), { signal })
  if (!response.ok) throw new Error(`Evidence request returned HTTP ${response.status}`)
  const bytes = await response.arrayBuffer()
  if (!globalThis.crypto?.subtle) throw new Error("SHA-256 verification is unavailable in this browser")
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  const actualSha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  if (actualSha256 !== sha256) throw new Error(failureMessage)
  return bytes
}

async function loadEvidence(): Promise<void> {
  if (evidenceLoading.value || cellTrace.value) return
  const version = sourceRun.value
  const cell = props.cell
  if (!version || !cell || ("declared" in cell && cell.declared)) return
  const traceReceipt = version.trace
  if (!traceReceipt) {
    if (!props.inline) repositionPreview()
    return
  }
  const identity = evidenceIdentity.value
  const request = ++evidenceRequest
  const controller = new AbortController()
  evidenceController = controller
  evidenceLoading.value = true
  evidenceError.value = null
  cellTrace.value = null
  try {
    if ("chain" in cell && (cell.chain.runId !== version.runId || cell.chain.runSha256 !== version.sha256)) {
      throw new Error("Result and run identities disagree")
    }
    const cacheKey = `${traceReceipt.url}#${traceReceipt.sha256}`
    let cached = verifiedTraceDocuments.get(cacheKey)
    if (cached === undefined) {
      const bytes = await verifiedBytes(
        traceReceipt.url,
        traceReceipt.sha256,
        controller.signal,
        "trace failed its receipt",
      )
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
      const actualSha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
      cached = { parsed, actualSha256 }
      verifiedTraceDocuments.set(cacheKey, cached)
    }
    const loaded = readCellTrace(cached.parsed, {
      schemaVersion: version.schemaVersion,
      runId: version.runId,
      runSha256: version.sha256,
      featureId: sourceFeatureId.value,
      expectedSha256: traceReceipt.sha256,
      actualSha256: cached.actualSha256,
    })
    if (request !== evidenceRequest || (!props.inline && !previewVisible.value) || identity !== evidenceIdentity.value)
      return
    cellTrace.value = loaded
    if (!props.inline) repositionPreview()
  } catch (error) {
    if (request !== evidenceRequest || (!props.inline && !previewVisible.value) || identity !== evidenceIdentity.value)
      return
    evidenceError.value = error instanceof Error ? error.message : String(error)
    if (!props.inline) repositionPreview()
  } finally {
    if (request === evidenceRequest) {
      evidenceLoading.value = false
      evidenceController = null
    }
  }
}

function keepPreview(): void {
  clearTimeout(previewHideTimer)
}

function scheduleHidePreview(event?: FocusEvent): void {
  const next = event?.relatedTarget
  if (next instanceof Node && (preview.value?.contains(next) || trigger.value?.contains(next))) return
  keepPreview()
  previewHideTimer = setTimeout(hidePreview, 200)
}

function positionPreview(): void {
  if (!previewVisible.value || !trigger.value || !preview.value) return
  const box = trigger.value.getBoundingClientRect()
  const height = preview.value.getBoundingClientRect().height
  const width = Math.min(420, window.innerWidth - 16)
  const left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8))
  const below = box.bottom + 8
  const above = box.top - height - 8
  const preferred = below + height <= window.innerHeight - 8 ? below : above
  const top = Math.max(8, Math.min(preferred, window.innerHeight - height - 8))
  previewPosition.value = { ...previewPosition.value, left: `${left}px`, top: `${top}px`, width: `${width}px` }
}

function repositionPreview(): void {
  keepPreview()
  if (!previewVisible.value || !trigger.value) return
  const box = trigger.value.getBoundingClientRect()
  const viewportSpace = window.innerHeight - 16
  const above = Math.max(0, Math.min(box.top - 16, viewportSpace))
  const below = Math.max(0, Math.min(window.innerHeight - box.bottom - 16, viewportSpace))
  previewPosition.value = {
    ...previewPosition.value,
    width: `${Math.min(420, window.innerWidth - 16)}px`,
    maxHeight: `min(88vh, 680px, ${Math.max(above, below)}px)`,
  }
  void nextTick(positionPreview)
}

function onDocKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") closePreview()
}

function showPreview(): void {
  keepPreview()
  if (!trigger.value || typeof window === "undefined") return
  if (openPreviewClose !== undefined && openPreviewClose !== hidePreview) openPreviewClose()
  openPreviewClose = hidePreview
  previewVisible.value = true
  previewPosition.value = { width: `${Math.min(420, window.innerWidth - 16)}px` }
  document.addEventListener("pointerdown", outsidePreview)
  document.addEventListener("keydown", onDocKeydown)
  document.addEventListener("terminfo:close-previews", hidePreview)
  window.addEventListener("resize", repositionPreview)
  repositionPreview()
  void loadEvidence()
}

async function focusPreview(): Promise<void> {
  showPreview()
  await nextTick()
  preview.value?.focus({ preventScroll: true })
}

function closePreview(): void {
  trigger.value?.focus({ preventScroll: true })
  hidePreview()
}

function outsidePreview(event: PointerEvent): void {
  if (event.target instanceof Node && (preview.value?.contains(event.target) || trigger.value?.contains(event.target)))
    return
  hidePreview()
}

function hidePreview(): void {
  document.removeEventListener("pointerdown", outsidePreview)
  document.removeEventListener("keydown", onDocKeydown)
  document.removeEventListener("terminfo:close-previews", hidePreview)
  window.removeEventListener("resize", repositionPreview)
  keepPreview()
  previewVisible.value = false
  if (openPreviewClose === hidePreview) openPreviewClose = undefined
}

onMounted(() => {
  if (props.inline && !blank.value) void loadEvidence()
})

watch(evidenceIdentity, () => {
  if (props.inline) {
    invalidateEvidence()
    if (!blank.value) void loadEvidence()
    return
  }
  hidePreview()
  invalidateEvidence()
})

onBeforeUnmount(() => {
  hidePreview()
  invalidateEvidence()
})
</script>

<template>
  <div v-if="inline" class="result-evidence__inline-card" role="region" :aria-label="`${featureName} result`">
    <div class="result-evidence__card-head">
      <strong
        class="result-evidence__trigger result-evidence__verdict"
        :class="`result-evidence__trigger--${status.tone}`"
      >
        <span aria-hidden="true">{{ status.icon }}</span
        >{{ status.text || status.title }}
      </strong>
    </div>
    <p v-if="joinedGrades" class="result-evidence__contexts">{{ joinedGrades }}</p>
    <strong class="result-evidence__test-title">{{ featureName }}</strong>
    <span class="result-evidence__compact-context">{{ publicContextLine }}</span>

    <div class="result-evidence__summary-block">
      <div class="result-evidence__field">
        <span class="result-evidence__field-label">Test sequence</span>
        <code v-if="declaredSequence" class="result-evidence__trace-seq">{{ declaredSequence }}</code>
        <span v-else class="result-evidence__field-muted">No test sequence declared.</span>
      </div>
      <div class="result-evidence__field">
        <span class="result-evidence__field-label">Expected</span>
        <p class="result-evidence__plain">{{ expectedSentence }}</p>
      </div>
      <div class="result-evidence__field">
        <span class="result-evidence__field-label">Observed</span>
        <p class="result-evidence__plain">{{ observedSummary }}</p>
        <span v-if="evidenceLoading" class="result-evidence__field-muted">Loading recorded evidence…</span>
      </div>
      <figure v-if="expectedIllustration" class="result-evidence__illustration">
        <img :src="expectedIllustration" alt="Illustrative expected Unicode cells; not a captured terminal result" />
        <figcaption class="result-evidence__illustrative">Illustration</figcaption>
      </figure>
    </div>

    <details v-if="!blank" class="result-evidence__compact-details">
      <summary>Technical details</summary>
      <div>
        <ResultSteps v-if="stepTable" :rows="stepTable.rows" />
        <div v-if="sentBytes" class="result-evidence__bytes">
          <span class="result-evidence__bytes-label">Full sent bytes</span>
          <pre>{{ sentBytes.full }}</pre>
        </div>
        <div v-if="replyBytes" class="result-evidence__bytes">
          <span class="result-evidence__bytes-label">Full reply bytes</span>
          <pre>{{ replyBytes.full }}</pre>
        </div>
        <div v-if="!stepTable && tracePaneCopy" class="result-evidence__trace-pane">
          <template v-for="(item, index) in tracePaneCopy.tested.items" :key="index">
            <div class="result-evidence__trace-label">{{ item.label }}</div>
            <code v-if="item.code !== undefined" class="result-evidence__trace-seq">{{ item.code }}</code>
            <p v-if="item.text" class="result-evidence__trace-p">{{ item.text }}</p>
            <pre v-if="item.pre !== undefined" class="result-evidence__trace-pre">{{ item.pre }}</pre>
          </template>
        </div>
        <span v-if="selectionExplanation">{{ selectionExplanation }}</span>
        <span v-if="reasonExplanation">{{ readerSafeExplanation(reasonExplanation) }}</span>
        <template v-if="tracePaneCopy">
          <span>{{ tracePaneCopy.tested.sourceLine }}</span>
          <span v-if="tracePaneCopy.tested.identityLine">{{ tracePaneCopy.tested.identityLine }}</span>
        </template>
        <span v-if="evidenceError" role="alert">Evidence error: {{ evidenceError }}</span>
        <code v-if="sourceRun">Run {{ sourceRun.runId }}</code>
        <details v-if="probeGuidanceText">
          <summary>Catalog test description</summary>
          {{ probeGuidanceText }}
        </details>
      </div>
    </details>
  </div>

  <span v-else class="result-evidence" :class="`result-evidence--${display}`">
    <span v-if="blank" class="result-evidence__blank" role="img" :title="status.title" :aria-label="accessibleName">{{
      status.icon
    }}</span>
    <button
      v-else
      ref="trigger"
      type="button"
      class="result-evidence__trigger"
      :class="`result-evidence__trigger--${status.tone}`"
      :aria-label="accessibleName"
      :aria-describedby="previewVisible ? tooltipId : undefined"
      @pointerenter="showPreview"
      @pointerleave="scheduleHidePreview()"
      @focus="showPreview"
      @blur="scheduleHidePreview"
      @keydown.esc.stop="closePreview"
      @click="focusPreview"
    >
      <span v-if="display !== 'label'" aria-hidden="true">{{ status.icon }}</span>
      <span v-if="display !== 'compact'" class="result-evidence__label">{{ shortLabel }}</span>
    </button>

    <Teleport v-if="!blank" to="body">
      <div
        v-if="previewVisible"
        ref="preview"
        :id="tooltipId"
        class="result-evidence__preview"
        role="region"
        tabindex="-1"
        aria-label="Result preview"
        :style="previewPosition"
        @pointerenter="keepPreview"
        @pointerleave="scheduleHidePreview()"
        @focusin="keepPreview"
        @focusout="scheduleHidePreview"
        @keydown.esc.stop="closePreview"
        @toggle.capture="repositionPreview"
      >
        <div class="result-evidence__card-head">
          <strong
            v-if="status.text"
            class="result-evidence__trigger result-evidence__verdict"
            :class="`result-evidence__trigger--${status.tone}`"
            ><span aria-hidden="true">{{ status.icon }}</span
            >{{ status.text }}</strong
          >
          <button type="button" class="result-evidence__close-mini" aria-label="Close" @click="closePreview">×</button>
        </div>
        <p v-if="joinedGrades" class="result-evidence__contexts">{{ joinedGrades }}</p>
        <strong class="result-evidence__test-title">{{ featureName }}</strong>
        <span class="result-evidence__compact-context">{{ publicContextLine }}</span>

        <div class="result-evidence__summary-block">
          <div class="result-evidence__field">
            <span class="result-evidence__field-label">Test sequence</span>
            <code v-if="declaredSequence" class="result-evidence__trace-seq">{{ declaredSequence }}</code>
            <span v-else class="result-evidence__field-muted">No test sequence declared.</span>
          </div>
          <div class="result-evidence__field">
            <span class="result-evidence__field-label">Expected</span>
            <p class="result-evidence__plain">{{ expectedSentence }}</p>
          </div>
          <div class="result-evidence__field">
            <span class="result-evidence__field-label">Observed</span>
            <p class="result-evidence__plain">{{ observedSummary }}</p>
            <span v-if="evidenceLoading" class="result-evidence__field-muted">Loading recorded evidence…</span>
          </div>
          <figure v-if="expectedIllustration" class="result-evidence__illustration">
            <img :src="expectedIllustration" alt="Illustrative expected Unicode cells; not a captured terminal result" />
            <figcaption class="result-evidence__illustrative">Illustration</figcaption>
          </figure>
        </div>

        <details class="result-evidence__compact-details">
          <summary>Technical details</summary>
          <div>
            <ResultSteps v-if="stepTable" :rows="stepTable.rows" />
            <div v-if="sentBytes" class="result-evidence__bytes">
              <span class="result-evidence__bytes-label">Full sent bytes</span>
              <pre>{{ sentBytes.full }}</pre>
            </div>
            <div v-if="replyBytes" class="result-evidence__bytes">
              <span class="result-evidence__bytes-label">Full reply bytes</span>
              <pre>{{ replyBytes.full }}</pre>
            </div>
            <div v-if="!stepTable && tracePaneCopy" class="result-evidence__trace-pane">
              <template v-for="(item, index) in tracePaneCopy.tested.items" :key="index">
                <div class="result-evidence__trace-label">{{ item.label }}</div>
                <code v-if="item.code !== undefined" class="result-evidence__trace-seq">{{ item.code }}</code>
                <p v-if="item.text" class="result-evidence__trace-p">{{ item.text }}</p>
                <pre v-if="item.pre !== undefined" class="result-evidence__trace-pre">{{ item.pre }}</pre>
              </template>
            </div>
            <span v-if="selectionExplanation">{{ selectionExplanation }}</span>
            <span v-if="reasonExplanation">{{ readerSafeExplanation(reasonExplanation) }}</span>
            <template v-if="tracePaneCopy">
              <span>{{ tracePaneCopy.tested.sourceLine }}</span>
              <span v-if="tracePaneCopy.tested.identityLine">{{ tracePaneCopy.tested.identityLine }}</span>
            </template>
            <span v-if="evidenceError" role="alert">Evidence error: {{ evidenceError }}</span>
            <code v-if="sourceRun">Run {{ sourceRun.runId }}</code>
            <details v-if="probeGuidanceText">
              <summary>Catalog test description</summary>
              {{ probeGuidanceText }}
            </details>
          </div>
        </details>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.result-evidence__card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.result-evidence__close-mini {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 5px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
.result-evidence__close-mini:hover,
.result-evidence__close-mini:focus-visible {
  color: var(--vp-c-text-1);
  background: var(--vp-c-default-soft);
}
.result-evidence__inline-card {
  display: grid;
  gap: 5px;
  font-size: 0.8rem;
  line-height: 1.35;
}
.result-evidence__summary-block {
  display: grid;
  gap: 6px;
  margin-top: 4px;
}
.result-evidence__field {
  display: grid;
  gap: 2px;
}
.result-evidence__field-label {
  font-size: 0.6rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--vp-c-text-2);
}
.result-evidence__field-muted {
  font-size: 0.68rem;
  color: var(--vp-c-text-3);
}
.result-evidence__plain,
:deep(.result-evidence__plain) {
  margin: 0 !important;
  font-size: 0.74rem;
  line-height: 1.4;
  overflow-wrap: anywhere;
  color: var(--vp-c-text-1);
}
.result-evidence__illustration {
  margin: 4px 0 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 5px;
  overflow: hidden;
}
.result-evidence__illustration img {
  display: block;
  width: 100%;
  height: 84px;
  object-fit: contain;
  background: #17191d;
}
.result-evidence__bytes {
  display: grid;
  gap: 2px;
}
.result-evidence__bytes-label {
  font-size: 0.58rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--vp-c-text-2);
}
.result-evidence__bytes pre {
  margin: 2px 0 0;
  padding: 4px 6px;
  border-radius: 4px;
  background: var(--vp-c-bg-soft);
  font-size: 0.62rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
