<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue"
import { withBase } from "vitepress"
import type { ObservationReason } from "@terminfo/probe-defs"
import type {
  PublicProbeResult,
  PublicRunMetadata,
  PublicContextSummary,
  PublicFeatureResult,
} from "../../data/public-results"
import {
  describeTracePanes,
  REASON_EXPLANATIONS,
  readCellTrace,
  type LoadedCellTrace,
} from "../../data/evidence-reader"
import { data } from "../../data/probes.data"
import {
  describeReplyBytes,
  describeSentBytes,
  describeStepTable,
  type StepSource,
} from "../../data/step-table"
import { textEvidenceExplanation } from "./ungraded-explanation"
import { evidenceStatus } from "./evidence-status"
import ResultSteps from "./ResultSteps.vue"

const verifiedTraceDocuments = new Map<string, { parsed: unknown; actualSha256: string }>()

const props = withDefaults(
  defineProps<{
    featureId: string
    featureName: string
    probeGuidance?: string
    subjectName: string
    version?: PublicRunMetadata | PublicContextSummary
    cell?: PublicProbeResult | PublicFeatureResult
    display?: "compact" | "text"
  }>(),
  { display: "compact" },
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

const reasonExplanations: Record<ObservationReason, string> = REASON_EXPLANATIONS

// Composed and original-run views both retain the cell's recorded status.
// The rule itself is evidence-status.ts, where it is testable; only a stored PROBE TODO on an
// environment position becomes the manual-by-design words (@cto 98cd142b D1).
const status = computed(() => evidenceStatus(props.featureId, currentResult.value?.status))
const shortLabel = computed(() => status.value.text)
const methodLabel = computed(() =>
  props.cell?.assertionType === "query_reply" ? "Terminal query" : (props.cell?.assertionType ?? ""),
)
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
const probeGuidanceText = computed(() =>
  (props.probeGuidance ?? data.featureDescriptions[props.featureId]?.probe)?.replace(/<\/?code>/g, ""),
)
const expectedIllustration = computed(() =>
  props.featureId === "charsets.utf8" ? withBase("/illustrations/utf8-cells.svg") : undefined,
)
const tracePaneCopy = computed(() => {
  if (!cellTrace.value) return undefined
  const featureMeta = data.featureDescriptions[props.featureId]
  return describeTracePanes(cellTrace.value, {
    sequence: featureMeta?.sequence,
    probeGuidance: props.probeGuidance ?? featureMeta?.probe,
    subjectKind: sourceRun.value?.subject.kind,
    hasReferenceImage: Boolean(expectedIllustration.value),
  })
})
const compactCause = computed(() => {
  if (evidenceError.value) return evidenceError.value
  if (evidenceLoading.value) return "Loading recorded evidence…"
  if (currentResult.value)
    return currentResult.value.reason ?? "Recorded details have not been approved for publication."
  return reasonExplanation.value ?? "No retained result for this selection."
})

/**
 * The stored status keyword the step table grades against.
 */
const STEP_STATUS: Record<string, string> = {
  Supported: "supported",
  Unsupported: "unsupported",
  Untestable: "untestable",
  "PROBE TODO": "probe-todo",
  "PROBE INVALID": "probe-invalid",
  "PROBE CONFLICT": "probe-conflict",
}
const stepSource = computed<StepSource | undefined>(() => {
  const screen = sourceRun.value?.screen
  const statusKeyword = currentResult.value?.status ?? STEP_STATUS[status.value.text] ?? "untestable"
  const cell = cellTrace.value?.cell
  if (cell) {
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
/** The one sentence under the badge: what happened, or the stored reason when the verdict is held or absent. */
const plainResult = computed(() => {
  const reason = readerSafeExplanation(currentResult.value?.reason ?? currentResult.value?.hold)
  const table = stepTable.value
  const held = table?.rows.some((row) => row.result === "held")
  if (held || status.value.tone === "unknown" || status.value.tone === "error") {
    return reason ? `${status.value.text}: ${reason}` : reason
  }
  return table?.summary ?? reason
})

const actionLabel = computed(() => props.cell ? "Original evidence not reviewed for presentation" : "No evidence in current selection")
const accessibleName = computed(
  () =>
    `${props.featureName} in ${props.subjectName}${sourceRun.value ? ` ${sourceRun.value.subject.version}` : ""}: ${status.value.text}. ${actionLabel.value}`,
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
  if (!version || !cell) return
  {
    const traceReceipt = version.trace
    if (!traceReceipt) {
      evidenceError.value = "no trace stored for this cell"
      repositionPreview()
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
      if (
        request !== evidenceRequest ||
        !previewVisible.value ||
        identity !== evidenceIdentity.value
      )
        return
      cellTrace.value = loaded
      repositionPreview()
    } catch (error) {
      if (
        request !== evidenceRequest ||
        !previewVisible.value ||
        identity !== evidenceIdentity.value
      )
        return
      evidenceError.value = error instanceof Error ? error.message : String(error)
      repositionPreview()
    } finally {
      if (request === evidenceRequest) {
        evidenceLoading.value = false
        evidenceController = null
      }
    }
    return
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

function showPreview(): void {
  keepPreview()
  if (!trigger.value || typeof window === "undefined") return
  if (openPreviewClose !== undefined && openPreviewClose !== hidePreview) openPreviewClose()
  openPreviewClose = hidePreview
  previewVisible.value = true
  previewPosition.value = { width: `${Math.min(420, window.innerWidth - 16)}px` }
  document.addEventListener("pointerdown", outsidePreview)
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
  window.removeEventListener("resize", repositionPreview)
  keepPreview()
  previewVisible.value = false
  if (openPreviewClose === hidePreview) openPreviewClose = undefined
}

watch(evidenceIdentity, () => {
  hidePreview()
  invalidateEvidence()
})

onBeforeUnmount(() => {
  hidePreview()
  invalidateEvidence()
})
</script>

<template>
  <span class="result-evidence" :class="`result-evidence--${display}`">
    <button
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
      <span aria-hidden="true">{{ status.icon }}</span>
      <span v-if="display === 'text'" class="result-evidence__label"
        >{{ shortLabel }}</span
      >
    </button>

    <Teleport to="body">
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
        <strong
          v-if="status.text"
          class="result-evidence__trigger result-evidence__verdict"
          :class="`result-evidence__trigger--${status.tone}`"
          ><span aria-hidden="true">{{ status.icon }}</span
          >{{ status.text }}</strong
        >
        <strong class="result-evidence__test-title">{{ featureName }}</strong>
        <span class="result-evidence__compact-context"
          >{{ subjectName
          }}<template v-if="sourceRun"> · {{ sourceRun.subject.version }} · {{ sourceRun.subject.os }}</template></span
        >
        <p v-if="plainResult" class="result-evidence__plain">{{ plainResult }}</p>
        <ResultSteps v-if="stepTable" :rows="stepTable.rows" />
        <section v-if="stepTable" class="result-evidence__evidence">
          <h4>Evidence</h4>

          <div v-if="sentBytes" class="result-evidence__bytes">
            <span class="result-evidence__bytes-label">Sent</span>
            <code>{{ sentBytes.summary }}</code>
            <details>
              <summary>Full sent bytes</summary>
              <pre>{{ sentBytes.full }}</pre>
            </details>
          </div>
          <div v-if="replyBytes" class="result-evidence__bytes">
            <span class="result-evidence__bytes-label">Observed</span>
            <code>{{ replyBytes.summary }}</code>
            <details>
              <summary>Full reply bytes</summary>
              <pre>{{ replyBytes.full }}</pre>
            </details>
          </div>
        </section>
        <div v-else class="result-evidence__comparison">
          <figure>
            <figcaption>TESTED</figcaption>
            <div v-if="tracePaneCopy" class="result-evidence__trace-pane">
              <p v-if="tracePaneCopy.tested.reasonLine" class="result-evidence__trace-p">
                {{ readerSafeExplanation(tracePaneCopy.tested.reasonLine) }}
              </p>
              <template v-for="(item, index) in tracePaneCopy.tested.items" :key="index">
                <div class="result-evidence__trace-label">{{ item.label }}</div>
                <code v-if="item.code !== undefined" class="result-evidence__trace-seq">{{ item.code }}</code>
                <pre v-if="item.pre !== undefined" class="result-evidence__trace-pre">{{ item.pre }}</pre>
                <p v-if="item.text" class="result-evidence__trace-p">{{ item.text }}</p>
              </template>
            </div>
            <div v-else class="result-evidence__missing-image">
              <span>{{ readerSafeExplanation(compactCause) }}</span>
            </div>
          </figure>
          <figure>
            <figcaption>EXPECTED</figcaption>
            <div v-if="tracePaneCopy" class="result-evidence__trace-pane">
              <template v-if="tracePaneCopy.expected.sequence">
                <div class="result-evidence__trace-label">Sequence</div>
                <code class="result-evidence__trace-seq">{{ tracePaneCopy.expected.sequence }}</code>
              </template>
              <div class="result-evidence__trace-label">Behavior</div>
              <p class="result-evidence__trace-p">{{ tracePaneCopy.expected.behavior }}</p>

              <template v-if="expectedIllustration">
                <img
                  :src="expectedIllustration"
                  :alt="'Illustrative expected Unicode cells; not a captured terminal result'"
                />
                <span class="result-evidence__illustrative">Illustration</span>
              </template>
            </div>
            <template v-else-if="expectedIllustration">
              <img
                :src="expectedIllustration"
                :alt="'Illustrative expected Unicode cells; not a captured terminal result'"
              />
              <span class="result-evidence__illustrative">Illustration</span>
            </template>
          </figure>
        </div>
        <details class="result-evidence__compact-details">
          <summary>Technical details</summary>
          <div>
            <strong>Feature test</strong>
            <span v-if="selectionExplanation">{{ selectionExplanation }}</span>
            <span v-if="reasonExplanation">{{ readerSafeExplanation(reasonExplanation) }}</span>
            <template v-if="tracePaneCopy">
              <span>{{ tracePaneCopy.tested.sourceLine }}</span>
              <span>{{ tracePaneCopy.tested.identityLine }}</span>
              <span>{{ tracePaneCopy.tested.notKeptLine }}</span>
            </template>
            <span v-if="evidenceLoading">Loading recorded evidence…</span>
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
.result-evidence__text {
  white-space: pre;
  overflow-x: auto;
  user-select: text;
}
.result-evidence__plain {
  margin: 4px 0 0;
  font-size: 0.72rem;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.result-evidence__evidence {
  display: grid;
  gap: 5px;
  margin-top: 7px;
  padding-top: 6px;
  border-top: 1px solid var(--vp-c-divider);
}
.result-evidence__evidence h4 {
  margin: 0;
  font-size: 0.58rem;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--vp-c-text-2);
}
.result-evidence__evidence img {
  width: 100%;
  max-height: 140px;
  object-fit: contain;
  border-radius: 4px;
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
.result-evidence__bytes code {
  padding: 3px 5px;
  border-radius: 4px;
  background: var(--vp-c-bg-soft);
  font-family: var(--vp-font-family-mono);
  font-size: 0.62rem;
  overflow-wrap: anywhere;
}
.result-evidence__bytes details {
  font-size: 0.62rem;
}
.result-evidence__bytes summary {
  cursor: pointer;
  color: var(--vp-c-text-2);
}
.result-evidence__bytes pre {
  margin: 4px 0 0;
  padding: 4px 6px;
  border-radius: 4px;
  background: var(--vp-c-bg-soft);
  font-size: 0.62rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
