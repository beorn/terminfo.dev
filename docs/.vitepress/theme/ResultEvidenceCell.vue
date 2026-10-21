<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue"
import { withBase } from "vitepress"
import type { ObservationReason } from "@terminfo/probe-defs"
import type {
  PublicCapabilityResult,
  HistoricalPublicCell,
  HistoricalPublicVersion,
  PublicVersion,
  TextQualificationDocument,
} from "../../data/public-results"
import { readCellEvidence, type LoadedCellEvidence } from "../../data/evidence-reader"
import { data } from "../../data/probes.data"
import { textEvidenceExplanation } from "./ungraded-explanation"

const props = withDefaults(
  defineProps<{
    featureId: string
    featureName: string
    probeGuidance?: string
    targetName: string
    version?: PublicVersion | HistoricalPublicVersion
    cell?: PublicCapabilityResult | HistoricalPublicCell
    display?: "compact" | "text"
  }>(),
  { display: "compact" },
)

const historicalVersion = computed(() =>
  props.version && props.version.schemaVersion !== 3 ? props.version : undefined,
)
const historicalCell = computed(() => (props.cell && "outcome" in props.cell ? props.cell : undefined))
const currentResult = computed(() => (props.cell && "status" in props.cell ? props.cell : undefined))
const featureNote = computed(() => historicalCell.value?.note ?? currentResult.value?.reason)

const isDecSampleResult = computed(
  () =>
    props.featureId === "charsets.dec-special" &&
    props.version?.runId === "e81b65484899493ffb9b5eacc3a6062d" &&
    props.version.sha256 === "cab396be1c52f450e7203039119a98355392c0b2d16bffb6a488922544b3d8c2" &&
    props.version.target.kind === "app" &&
    props.version.target.id === "kitty" &&
    props.version.target.version === "0.49.2" &&
    props.version.target.os === "linux" &&
    historicalCell.value?.outcome === "supported" &&
    historicalCell.value?.conclusive === true &&
    historicalCell.value?.evidence === "pixels" &&
    historicalCell.value?.chain.correctionId === "pixels-e81b65484899493ffb9b5eacc3a6062d-charsets.dec-special" &&
    historicalCell.value?.presentation.state === "presented" &&
    historicalCell.value?.presentation.review.id === "present-e81b65484899493ffb9b5eacc3a6062d-charsets.dec-special",
)

const trigger = ref<HTMLButtonElement | null>(null)
const dialog = ref<HTMLDialogElement | null>(null)
const preview = ref<HTMLElement | null>(null)
let previewHideTimer: ReturnType<typeof setTimeout> | undefined
const previewVisible = ref(false)
const dialogVisible = ref(false)
const previewPosition = ref<Record<string, string>>({})
const evidenceDocument = ref<LoadedCellEvidence | null>(null)
const qualificationDocument = ref<TextQualificationDocument | null>(null)
const textSnapshots = ref<Record<string, string>>({})
const recordedQueries = ref<Array<{ sequence: string; raw?: string }>>([])
const evidenceLoading = ref(false)
const evidenceError = ref<string | null>(null)
let evidenceRequest = 0
let evidenceController: AbortController | null = null
const id = useId()
const tooltipId = `${id}-preview`
const dialogTitleId = `${id}-title`

const reasonExplanations: Record<ObservationReason, string> = {
  "no-response": "No terminal reply was recorded for this query.",
  timeout: "The probe did not finish before its time limit.",
  permission: "Required permission was not available for this probe.",
  "policy-refused": "The configured policy declined to run or allow this probe.",
  "collector-error": "The collector failed to complete this probe.",
  "invalid-reply": "The recorded reply did not match this probe’s expected format.",
  "insufficient-evidence": "The recorded observation does not establish support; more evidence is needed.",
}

const namedCoverage = computed(() =>
  historicalVersion.value?.notTestedCoverage.named.find((record) => record.featureId === props.featureId),
)

const status = computed(() => {
  const historicalState = historicalVersion.value
    ? (data.historicalTable[historicalVersion.value.runId]?.[props.featureId] ?? "untested")
    : undefined
  // Historical presentation reads its existing evidence-aware projection; it is never current v3 evidence.
  const state =
    currentResult.value?.status ??
    (historicalState
      ? (
          {
            supported: "supported",
            unsupported: "unsupported",
            inconclusive: "untestable",
            error: "test-failure",
            untested: "test-todo",
          } as const
        )[historicalState]
      : undefined)
  if (!state) return { text: "", icon: "–", tone: "unknown" }
  return {
    supported: { text: "Supported", icon: "✓", tone: "yes" },
    unsupported: { text: "Unsupported", icon: "✗", tone: "no" },
    untestable: { text: "Untestable", icon: "–", tone: "ungraded" },
    "test-todo": { text: "TEST TODO", icon: "–", tone: "unknown" },
    "test-failure": { text: "TEST FAILURE", icon: "!", tone: "error" },
  }[state]
})
const shortLabel = computed(() => status.value.text)
const methodLabel = computed(() =>
  props.cell?.evidence === "query"
    ? "Terminal query"
    : props.cell?.evidence === "none"
      ? "Not measured"
      : (props.cell?.evidence ?? ""),
)
const selectionExplanation = computed(() => {
  if (!props.version) return "No reviewed current result is available for this context."
  if (!props.cell) {
    return namedCoverage.value
      ? `This probe ran, but this environment has no applicable observable for ${namedCoverage.value.noObservable}.`
      : "This feature was not measured by this selected run."
  }
  return undefined
})
const reasonExplanation = computed(() =>
  historicalCell.value?.reason ? reasonExplanations[historicalCell.value.reason] : currentResult.value?.reason,
)
const legacyStatusWords = /\b(?:inconclusive|conclusive|conclusively|untested)\b|\bnot[ -]tested\b/i
function readerSafeExplanation(value?: string): string | undefined {
  if (!value) return undefined
  return legacyStatusWords.test(value)
    ? `The original wording is preserved in the downloadable record. Current displayed status: ${status.value.text}.`
    : value
}
// Why a text row is shown but not counted (30033 ruling f1f3c64b). The sentence lives in
// ungraded-explanation.ts so the two arms' reasons are pinned by their own test.
const textExplanation = computed(() =>
  textEvidenceExplanation(
    historicalCell.value && props.version
      ? {
          evidence: historicalCell.value.evidence,
          conclusive: historicalCell.value.conclusive,
          os: props.version.target.os,
          host: historicalCell.value?.host,
          textQualificationReason: historicalCell.value?.textQualificationReason,
        }
      : undefined,
  ),
)

const probeGuidanceText = computed(() => props.probeGuidance?.replace(/<\/?code>/g, ""))
const presentation = computed(() => props.cell?.presentation)
const correction = computed(() =>
  historicalVersion.value?.reviews.find((review) => review.id === historicalCell.value?.chain.correctionId),
)
const previewRecord = computed(() => (presentation.value?.state === "presented" ? props.cell?.record : undefined))
const previewScreenshot = computed(() => previewRecord.value?.screenshot)
const screenshotUrl = computed(() => (previewScreenshot.value ? withBase(previewScreenshot.value.url) : undefined))
const previewFrames = computed(() => previewRecord.value?.frames ?? [])
const previewFrame = computed(() =>
  previewFrames.value.find((frame) => frame.role === "target" && frame.kind !== "text-cells"),
)
const previewImageUrl = computed(() => (previewFrame.value ? withBase(previewFrame.value.url) : screenshotUrl.value))
// A control is not an expected result unless the retained label explicitly identifies a reference.
const referenceFrame = computed(() =>
  previewFrames.value.find((frame) => frame.kind !== "text-cells" && /\b(expected|reference)\b/i.test(frame.label)),
)
const testedText = computed(() => {
  const frame = previewFrames.value.find((frame) => frame.role === "target" && frame.kind === "text-cells")
  return frame ? textSnapshots.value[frame.sha256] : undefined
})
const referenceImageUrl = computed(() => (referenceFrame.value ? withBase(referenceFrame.value.url) : undefined))
const expectedIllustration = computed(() =>
  props.featureId === "charsets.utf8" ? withBase("/illustrations/utf8-cells.svg") : undefined,
)
const compactCause = computed(() => {
  if (evidenceError.value) return evidenceError.value
  if (currentResult.value)
    return currentResult.value.reason ?? "Recorded details have not been approved for publication."
  if (historicalCell.value?.evidence === "text") return "our test could not capture text"
  if (historicalCell.value?.evidence === "pixels") return "Reviewed capture not available."
  return historicalCell.value?.note ?? reasonExplanation.value ?? "No retained result for this selection."
})

const evidenceRecord = computed(() => evidenceDocument.value?.record)
const evidenceFrames = computed(() => evidenceRecord.value?.frames ?? [])
const evidenceScreenshot = computed(() => evidenceRecord.value?.screenshot)
const evidenceScreenshotUrl = computed(() =>
  evidenceScreenshot.value ? withBase(evidenceScreenshot.value.url) : undefined,
)
const rawReply = computed(() => evidenceRecord.value?.rawReply)
const assertions = computed(() => evidenceRecord.value?.assertions ?? [])
const hasRecordedDetail = computed(
  () =>
    rawReply.value !== undefined ||
    assertions.value.length > 0 ||
    evidenceFrames.value.length > 0 ||
    evidenceScreenshot.value !== undefined,
)
const originalObservation = computed(() =>
  evidenceDocument.value?.version === 2 ? evidenceDocument.value.observation : undefined,
)
const originalDiffers = computed(() => {
  const original = originalObservation.value
  const current = historicalCell.value
  return Boolean(
    original &&
    current &&
    (original.outcome !== current.outcome ||
      original.reason !== current.reason ||
      original.evidence !== current.evidence ||
      original.note !== current.note),
  )
})
const actionLabel = computed(() => {
  if (!props.cell) return "No evidence in current selection"
  if (presentation.value?.state === "not-reviewed") return "Original evidence not reviewed for presentation"
  if (presentation.value?.state === "withdrawn") return "Evidence presentation withdrawn"
  if (previewFrames.value.length) return "View reviewed captured frames"
  if (screenshotUrl.value) return "View screenshot"
  return "View reviewed evidence"
})
const accessibleName = computed(
  () =>
    `${props.featureName} in ${props.targetName}${props.version ? ` ${props.version.target.version}` : ""}: ${status.value.text}. ${actionLabel.value}`,
)
const rawReplyDisplay = computed(() => (rawReply.value === undefined ? "" : JSON.stringify(rawReply.value)))
const evidenceIdentity = computed(() => {
  return JSON.stringify([
    props.featureId,
    props.version?.runId,
    props.version?.sha256,
    props.version?.target.version,
    historicalCell.value?.chain,
    historicalCell.value?.outcome,
    currentResult.value?.status,
    props.cell?.reason,
    props.cell?.evidence,
    historicalCell.value?.note,
    presentation.value,
  ])
})

function invalidateEvidence(): void {
  evidenceRequest += 1
  evidenceController?.abort()
  evidenceController = null
  evidenceDocument.value = null
  qualificationDocument.value = null
  textSnapshots.value = {}
  recordedQueries.value = []
  evidenceLoading.value = false
  evidenceError.value = null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** The existing evidence receipt check also verifies TXT bytes and the run-owned witness document. */
async function verifiedBytes(url: string, sha256: string, signal: AbortSignal): Promise<ArrayBuffer> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Invalid evidence SHA-256 receipt")
  const [resourcePath] = url.split("#")
  if (!resourcePath) throw new Error("Invalid evidence URL")
  const response = await fetch(withBase(resourcePath), { signal })
  if (!response.ok) throw new Error(`Evidence request returned HTTP ${response.status}`)
  const bytes = await response.arrayBuffer()
  if (!globalThis.crypto?.subtle) throw new Error("SHA-256 verification is unavailable in this browser")
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  const actualSha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  if (actualSha256 !== sha256) throw new Error("evidence failed its receipt")
  return bytes
}

async function loadEvidence(): Promise<void> {
  if (evidenceLoading.value || evidenceDocument.value) return
  const approval = presentation.value
  const version = props.version
  const cell = props.cell
  if (approval?.state !== "presented" || !version || !cell) return
  const identity = evidenceIdentity.value
  const request = ++evidenceRequest
  const controller = new AbortController()
  evidenceController = controller
  evidenceLoading.value = true
  evidenceError.value = null
  evidenceDocument.value = null
  try {
    if (!/^[0-9a-f]{64}$/.test(approval.sha256)) throw new Error("Invalid evidence SHA-256 receipt")
    if ("chain" in cell && (cell.chain.runId !== version.runId || cell.chain.runSha256 !== version.sha256)) {
      throw new Error("Result and run identities disagree")
    }
    const bytes = await verifiedBytes(approval.url, approval.sha256, controller.signal)
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    const document = readCellEvidence(parsed, {
      schemaVersion: version.schemaVersion,
      runId: version.runId,
      runSha256: version.sha256,
      featureId: props.featureId,
      reviewId: approval.review.id,
      status: currentResult.value?.status,
    })
    let qualification: TextQualificationDocument | null = null
    if (document.textQualification) {
      const reference = document.textQualification
      const bytes = await verifiedBytes(reference.url, reference.sha256, controller.signal)
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
      if (
        !isRecord(value) ||
        value.version !== 1 ||
        value.runId !== version.runId ||
        value.runSha256 !== version.sha256 ||
        !isRecord(value.qualification) ||
        !Array.isArray(value.qualification.shapes)
      ) {
        throw new Error("Text qualification document does not match this run")
      }
      qualification = value as unknown as TextQualificationDocument
    }
    const frames = [
      ...(document.record.frames ?? []),
      ...(qualification?.qualification.shapes.flatMap((shape) => shape.frames ?? []) ?? []),
    ]
    const snapshots: Record<string, string> = {}
    const textFrames = [
      ...new Map(frames.filter((frame) => frame.kind === "text-cells").map((frame) => [frame.sha256, frame])).values(),
    ]
    await Promise.all(
      textFrames.map(async (frame) => {
        const bytes = await verifiedBytes(frame.url, frame.sha256, controller.signal)
        snapshots[frame.sha256] = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      }),
    )
    if (
      request !== evidenceRequest ||
      (!dialogVisible.value && !previewVisible.value) ||
      identity !== evidenceIdentity.value
    )
      return
    // The app collector stores the actual exchange in its approved raw trace.
    // Catalog guidance never substitutes for the question sent in a recorded run.
    const raw = document.record.rawReply
    let queries: Array<{ sequence: string; raw?: string }> = []
    if (cell.evidence === "query" && typeof raw === "string" && /^\s*\{\s*"writes"\s*:/.test(raw)) {
      const trace: unknown = JSON.parse(raw)
      if (
        !isRecord(trace) ||
        !Array.isArray(trace.queries) ||
        !trace.queries.every(
          (query) =>
            isRecord(query) &&
            typeof query.sequence === "string" &&
            (query.raw === undefined || typeof query.raw === "string"),
        )
      )
        throw new Error("Recorded terminal trace has invalid query or reply fields")
      queries = trace.queries as Array<{ sequence: string; raw?: string }>
    }
    recordedQueries.value = queries
    evidenceDocument.value = document
    qualificationDocument.value = qualification
    textSnapshots.value = snapshots
    repositionPreview()
  } catch (error) {
    if (
      request !== evidenceRequest ||
      (!dialogVisible.value && !previewVisible.value) ||
      identity !== evidenceIdentity.value
    )
      return
    evidenceError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (request === evidenceRequest) {
      evidenceLoading.value = false
      evidenceController = null
    }
  }
}

function frameTime(capturedAt: number): string {
  const date = new Date(capturedAt)
  return Number.isNaN(date.getTime()) ? `${capturedAt} ms since Unix epoch` : date.toISOString()
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
    maxHeight: `min(75vh, 520px, ${Math.max(above, below)}px)`,
  }
  void nextTick(positionPreview)
}

function showPreview(): void {
  keepPreview()
  if (dialogVisible.value || !trigger.value || typeof window === "undefined") return
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
}

async function openDialog(): Promise<void> {
  if (dialogVisible.value) return
  hidePreview()
  dialogVisible.value = true
  await nextTick()
  if (!dialogVisible.value) return
  dialog.value?.showModal()
  void loadEvidence()
}

function closeDialog(): void {
  dialog.value?.close()
}

function onDialogClose(): void {
  dialogVisible.value = false
  invalidateEvidence()
  nextTick(() => trigger.value?.focus({ preventScroll: true }))
}

watch(evidenceIdentity, () => {
  hidePreview()
  invalidateEvidence()
  if (dialog.value?.open) dialog.value.close()
})

onBeforeUnmount(() => {
  hidePreview()
  invalidateEvidence()
  if (dialog.value?.open) dialog.value.close()
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
        >{{ shortLabel }}<template v-if="previewImageUrl"> · Images</template></span
      >
    </button>

    <Teleport to="body">
      <div
        v-if="previewVisible && !dialogVisible"
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
          >{{ targetName
          }}<template v-if="version"> · {{ version.target.version }} · {{ version.target.os }}</template></span
        >
        <div class="result-evidence__comparison">
          <figure>
            <figcaption>TESTED</figcaption>
            <img v-if="previewImageUrl" :src="previewImageUrl" :alt="`Recorded ${featureName} target`" />
            <pre v-else-if="testedText" class="result-evidence__sample-text">{{ testedText }}</pre>
            <pre v-else-if="assertions[0]?.observed" class="result-evidence__sample-text">{{
              assertions[0].observed
            }}</pre>
            <div v-else class="result-evidence__missing-image">
              <span>{{ readerSafeExplanation(compactCause) }}</span>
            </div>
          </figure>
          <figure>
            <figcaption>EXPECTED</figcaption>
            <img v-if="referenceImageUrl" :src="referenceImageUrl" :alt="`Recorded reference for ${featureName}`" />
            <template v-else-if="expectedIllustration">
              <img
                :src="expectedIllustration"
                :alt="'Illustrative expected Unicode cells; not a captured terminal result'"
              />
              <span class="result-evidence__illustrative">Illustration</span>
            </template>
            <pre v-else-if="assertions[0]?.expected" class="result-evidence__sample-text">{{
              assertions[0].expected
            }}</pre>
            <div v-else class="result-evidence__missing-image" role="img" aria-label="Expected reference not recorded">
              <svg viewBox="0 0 40 28" aria-hidden="true">
                <rect x="1" y="1" width="38" height="26" rx="2" />
                <path d="M6 22l9-9 7 7 6-6 6 8" />
              </svg>
              <span>Reference not recorded</span>
            </div>
          </figure>
        </div>
        <details class="result-evidence__compact-details">
          <summary>Technical details</summary>
          <div>
            <span v-if="historicalVersion">Historical evidence; rerun required for current schema-3 coverage.</span>
            <strong>Feature test</strong>
            <span v-if="selectionExplanation">{{ selectionExplanation }}</span>
            <span v-if="reasonExplanation">{{ readerSafeExplanation(reasonExplanation) }}</span>
            <span v-if="featureNote">{{ readerSafeExplanation(featureNote) }}</span>
            <template v-if="historicalCell?.textQualificationReason">
              <strong>Capture qualification</strong>
              <span>{{ readerSafeExplanation(historicalCell?.textQualificationReason) }}</span>
            </template>
            <span v-else-if="textExplanation">{{ textExplanation }}</span>
            <span v-if="evidenceLoading">Loading recorded evidence…</span>
            <span v-if="evidenceError" role="alert">Evidence error: {{ evidenceError }}</span>
            <span v-if="presentation?.state === 'withdrawn'"
              >Presentation withdrawn: {{ readerSafeExplanation(presentation.review.reason) }}</span
            >
            <code v-if="version">Run {{ version.runId }}</code>
            <details v-if="probeGuidanceText">
              <summary>Catalog test description</summary>
              {{ probeGuidanceText }}
            </details>
            <button v-if="presentation?.state === 'presented'" type="button" @click="openDialog">
              Open recorded evidence
            </button>
          </div>
        </details>
      </div>

      <dialog
        v-if="dialogVisible"
        ref="dialog"
        class="result-evidence__dialog"
        :aria-labelledby="dialogTitleId"
        @close="onDialogClose"
      >
        <div class="result-evidence__dialog-header">
          <div>
            <p class="result-evidence__eyebrow">Result details</p>
            <h2 :id="dialogTitleId">{{ featureName }}</h2>
            <p class="result-evidence__context">
              {{ targetName
              }}<template v-if="version">
                · {{ version.target.version }} · {{ version.target.os || "OS not recorded" }}</template
              >
            </p>
          </div>
          <button type="button" class="result-evidence__close" aria-label="Close result details" @click="closeDialog">
            Close
          </button>
        </div>

        <p v-if="isDecSampleResult">
          Kitty passed this sample: <code>q</code> became a horizontal line, then ASCII text was restored. Only this
          character mapping and restoration were checked, not the full charset.
        </p>
        <p v-if="isDecSampleResult">
          DEC Special Graphics lets older terminal programs draw borders by displaying ordinary letters as line-drawing
          symbols.
          <a :href="withBase('/charsets/dec-special-graphics')">About this feature</a> ·
          <a :href="withBase('/glossary')">Terminal glossary</a>
        </p>

        <p class="result-evidence__outcome" :class="`result-evidence__outcome--${status.tone}`">
          <template v-if="isDecSampleResult">Supported: verified in screenshot</template>
          <template v-else
            >{{ status.text }}<template v-if="cell"> · {{ methodLabel }}</template></template
          >
        </p>
        <template v-if="isDecSampleResult">
          <p>
            Supported applies only to this sample. Sol, an AI reviewer, assessed the two captured images.
            <a :href="withBase('/how-it-works/how-to-read-a-result')">How does this work?</a>
          </p>
          <p>
            Tested in Kitty 0.49.2 on Linux, using Xvfb and the llvmpipe renderer, an 800×600 window, and the default
            profile with DejaVu Sans Mono at size 16. Other versions and configurations need their own results.
          </p>
          <details class="result-evidence__details">
            <summary>How to read the status</summary>
            <p>The status describes the tested claim. The evidence label describes how it was observed.</p>
            <h4>Result states</h4>
            <ul>
              <li><strong>Supported</strong>: the evidence satisfies the support criterion.</li>
              <li><strong>Unsupported</strong>: a functioning test obtained the defined negative result.</li>
              <li><strong>Untestable</strong>: a specific reviewed context limitation prevents the test.</li>
              <li><strong>TEST TODO</strong>: the required measurement has not run.</li>
              <li><strong>TEST FAILURE</strong>: the attempted test did not produce a valid result.</li>
            </ul>
            <h4>Evidence kinds</h4>
            <ul>
              <li>
                <strong>query (Terminal query)</strong>: a recorded reply from the terminal. Recognition of a query
                alone does not prove every operation of the feature.
              </li>
              <li><strong>behavior</strong>: an observed effect of a terminal operation.</li>
              <li>
                <strong>parser-state</strong>: internal state exposed by a headless terminal emulator. This does not
                establish the pixels displayed by an application.
              </li>
              <li><strong>pixels</strong>: captured images of the terminal application's display.</li>
              <li><strong>interaction</strong>: an observed result of an input action performed during the test.</li>
              <li><strong>consumed</strong>: the sequence was accepted, without proof of its intended effect.</li>
              <li>
                <strong>legacy</strong>: an older-style callback result without the current measurement record. It does
                not necessarily mean an old terminal or version.
              </li>
              <li>
                <strong>none (Not measured)</strong>: the collector did not measure a terminal effect or reply. A
                zero-byte collector trace or explanatory notes may still be retained; this does not mean the record is
                empty.
              </li>
            </ul>
            <p>Consumed, legacy and none cannot by themselves establish supported or unsupported.</p>
          </details>
          <h3>What was tested</h3>
          <ol>
            <li>
              Write ordinary ASCII <code>qqq</code> on rows 1, 3 and 4, and a Unicode <code>q─q</code> comparator on row
              2. Capture the control image.
            </li>
            <li>
              Switch to DEC Special Graphics for the middle <code>q</code> on row 3, then restore ASCII and write
              <code>qqq</code> on row 4. Capture the target image.
            </li>
            <li>
              Sol performs an AI image review of the same two images: the middle <code>q</code> on row 3 becomes a line
              matching the Unicode comparator; the restored row 4 remains ordinary text.
            </li>
          </ol>
          <p>This test recorded writes and two captures, with no terminal queries or automated assertion values.</p>
        </template>
        <details v-if="isDecSampleResult && historicalCell?.note" class="result-evidence__details">
          <summary>Detailed review note</summary>
          <p>{{ readerSafeExplanation(historicalCell?.note) }}</p>
        </details>
        <p v-else-if="historicalCell?.note">{{ readerSafeExplanation(historicalCell?.note) }}</p>
        <p
          v-if="
            cell?.evidence === 'query' &&
            (historicalCell?.conclusive ||
              currentResult?.status === 'supported' ||
              currentResult?.status === 'unsupported')
          "
        >
          This result is based on the query's recorded evidence, not every use of this feature.
        </p>
        <p v-else-if="cell?.evidence === 'query'">This query did not establish a yes-or-no result for the feature.</p>
        <p v-if="cell?.reason">Reason: {{ readerSafeExplanation(cell.reason) }}</p>
        <p v-else-if="namedCoverage">Reason: {{ readerSafeExplanation(namedCoverage.reason) }}</p>
        <p v-if="selectionExplanation">{{ selectionExplanation }}</p>
        <p v-else-if="cell?.evidence === 'none'">This probe made no terminal measurement.</p>
        <p v-if="reasonExplanation">{{ readerSafeExplanation(reasonExplanation) }}</p>

        <h3>Evidence</h3>
        <p v-if="!version">No reviewed current run is selected for this terminal context.</p>
        <p v-else-if="!cell && namedCoverage">
          TEST FAILURE: the attempt retained a trace but established neither Supported nor Unsupported.
        </p>
        <p v-else-if="!cell">TEST TODO: no reviewed current result covers this feature.</p>
        <template v-else-if="presentation?.state === 'not-reviewed'">
          <p>Original evidence has not been reviewed for presentation.</p>
        </template>
        <template v-else-if="presentation?.state === 'withdrawn'">
          <p>Evidence presentation was withdrawn: {{ readerSafeExplanation(presentation.review.reason) }}</p>
          <p>Reviewed by {{ presentation.review.reviewer }}.</p>
        </template>
        <template v-else-if="presentation?.state === 'presented'">
          <p v-if="evidenceLoading" role="status">Loading and verifying the original evidence…</p>
          <p v-else-if="evidenceError" role="alert" class="result-evidence__outcome result-evidence__outcome--error">
            Evidence could not be verified: {{ evidenceError }}
          </p>
          <template v-else-if="evidenceDocument">
            <p v-if="correction && isDecSampleResult">
              The collector captured the images but did not automatically judge their content. It left the result
              awaiting review (TEST TODO). Sol, an AI reviewer, then compared the unchanged frames against two criteria:
              the middle <code>q</code> on row 3 must look like the horizontal line in row 2, and row 4 must remain
              ordinary ASCII text. That review established support for this sample. It used no numeric confidence score,
              new frames or updated terminal. “Corrected after review” means the assessment changed; Kitty was not fixed
              and this was not a rerun. The same AI reviewer made the support assessment and the separate decision to
              display the evidence, not two independent tests or human approvals. The original result and both decisions
              are preserved in Review history.
            </p>
            <p v-else-if="correction">
              This result was corrected after review. See Review history for the original result and reason.
            </p>
            <template v-if="assertions.length">
              <h4>Expected and observed</h4>
              <p>Original assertion values, shown as recorded.</p>
              <ul class="result-evidence__assertions">
                <li v-for="(assertion, index) in assertions" :key="index">
                  <strong>{{ assertion.kind }}</strong
                  ><template v-if="assertion.action"> · {{ assertion.action }}</template>
                  <span>Expected: {{ assertion.expected }}</span>
                  <span>Observed: {{ assertion.observed }}</span>
                  <span v-if="assertion.note">{{ assertion.note }}</span>
                </li>
              </ul>
            </template>
            <template v-if="evidenceFrames.length">
              <h4>
                {{ evidenceFrames.some((frame) => frame.kind === "text-cells") ? "Captured text" : "Screenshots" }}
              </h4>
              <div class="result-evidence__frames">
                <figure v-for="(frame, index) in evidenceFrames" :key="index" class="result-evidence__image">
                  <pre v-if="frame.kind === 'text-cells'" class="result-evidence__text">{{
                    textSnapshots[frame.sha256]
                  }}</pre>
                  <img v-else :src="withBase(frame.url)" :alt="`${frame.role} frame: ${frame.label}`" />
                  <figcaption>
                    <strong>{{ frame.role === "control" ? "Control" : "Target" }}</strong> · {{ frame.label }}
                    <details>
                      <summary>{{ frame.kind === "text-cells" ? "Text details" : "Image details" }}</summary>
                      Captured {{ frameTime(frame.capturedAt) }} · SHA-256 {{ frame.sha256 }}
                    </details>
                  </figcaption>
                  <a :href="withBase(frame.url)" target="_blank" rel="noopener noreferrer"
                    >Open original {{ frame.role }} {{ frame.kind === "text-cells" ? "text" : "image" }}</a
                  >
                </figure>
              </div>
            </template>

            <details
              v-if="qualificationDocument && evidenceDocument.textQualification"
              class="result-evidence__details"
            >
              <summary>Run’s five-shape text qualification</summary>
              <p>
                <a :href="withBase(evidenceDocument.textQualification.url)" target="_blank" rel="noopener noreferrer"
                  >Open the shared run qualification record</a
                >
              </p>
              <section v-for="shape in qualificationDocument.qualification.shapes" :key="shape.shape">
                <h4>{{ shape.shape }}</h4>
                <p v-if="shape.reason">{{ shape.reason }}</p>
                <figure v-for="frame in shape.frames" :key="`${frame.role}:${frame.sha256}`">
                  <figcaption>{{ frame.role }} · {{ frame.label }}</figcaption>
                  <pre class="result-evidence__text">{{ textSnapshots[frame.sha256] }}</pre>
                  <a :href="withBase(frame.url)" target="_blank" rel="noopener noreferrer">Open original text bytes</a>
                </figure>
              </section>
            </details>
            <template v-if="!evidenceFrames.length && evidenceScreenshotUrl">
              <figure class="result-evidence__image">
                <img
                  :src="evidenceScreenshotUrl"
                  :alt="`Original recorded image for ${featureName} in ${targetName}`"
                />
                <figcaption>Original recorded image · SHA-256 {{ evidenceScreenshot?.sha256 }}</figcaption>
              </figure>
              <p>
                <a :href="evidenceScreenshotUrl" target="_blank" rel="noopener noreferrer">Open original screenshot</a>
              </p>
            </template>

            <p v-if="!hasRecordedDetail">No raw evidence was captured for this observation.</p>
            <details v-if="rawReply !== undefined" class="result-evidence__details">
              <summary>{{ isDecSampleResult ? "Recorded test trace" : "Technical details · raw trace" }}</summary>
              <template v-if="rawReply !== undefined">
                <p v-if="isDecSampleResult">Recorded evidence kind: <code>pixels</code>.</p>
                <h4>
                  {{
                    isDecSampleResult
                      ? "Recorded test trace"
                      : originalObservation?.evidence === "none"
                        ? "Collector trace"
                        : "Raw reply"
                  }}
                </h4>
                <pre class="result-evidence__raw">{{ rawReplyDisplay }}</pre>
              </template>
            </details>
            <details class="result-evidence__details">
              <summary>Review history</summary>
              <template v-if="isDecSampleResult">
                <p>
                  The original result and the review decisions are preserved below in order: collection, support review,
                  then evidence presentation approval.
                </p>
                <h4>1. Original recorded result</h4>
                <p>
                  Recorded {{ originalObservation?.evidence }} method
                  <template v-if="originalObservation?.reason">
                    · {{ readerSafeExplanation(originalObservation?.reason) }}</template
                  >
                </p>
                <p>
                  The automated check completed. The criterion requiring independent visual judgment remained TEST TODO
                  until review.
                </p>
                <p v-if="originalObservation?.note">
                  {{ readerSafeExplanation(originalObservation?.note) }}
                </p>
                <p>
                  <a :href="withBase(cell.presentation.url)" target="_blank" rel="noopener noreferrer"
                    >Open original recorded evidence</a
                  >
                </p>
                <h4>2. Support review</h4>
                <p>
                  Sol, an AI image reviewer, changed the assessment from TEST TODO to Supported for this sample using
                  the same original control and target frames. The frames were retained; Kitty was not fixed and the
                  test was not rerun.
                </p>
                <details v-if="correction">
                  <summary>Support review record</summary>
                  <p>
                    Review changed the historical displayed result to {{ status.text }}. Reviewed by
                    {{ correction.reviewer }}. The original review rationale remains in the evidence record.
                  </p>
                </details>
                <h4>3. Evidence presentation approval</h4>
                <p>
                  The same AI reviewer, Sol, separately approved displaying these frames. This was not a second
                  independent test or a human approval, and it did not change the support result, terminal identity or
                  recorded assertions.
                </p>
                <details>
                  <summary>Evidence presentation record</summary>
                  <p>{{ presentation.review.reviewer }}: {{ readerSafeExplanation(presentation.review.reason) }}</p>
                  <p>
                    <a :href="withBase(cell.presentation.url)" target="_blank" rel="noopener noreferrer"
                      >Open original recorded evidence</a
                    >
                  </p>
                </details>
              </template>
              <template v-else>
                <p v-if="correction">
                  Review changed the historical displayed result to {{ status.text }}. Reviewed by
                  {{ correction.reviewer }}. The original review rationale remains in the evidence record.
                </p>
                <details>
                  <summary>Evidence publication check</summary>
                  <p>{{ presentation.review.reviewer }}: {{ readerSafeExplanation(presentation.review.reason) }}</p>
                </details>
                <template v-if="originalDiffers">
                  <h4>Original recorded observation</h4>
                  <p>
                    Recorded {{ originalObservation?.evidence }} method
                    <template v-if="originalObservation?.reason">
                      · {{ readerSafeExplanation(originalObservation?.reason) }}</template
                    >
                  </p>
                  <p v-if="originalObservation?.note">{{ readerSafeExplanation(originalObservation?.note) }}</p>
                </template>
              </template>
            </details>

            <details v-if="cell.evidence === 'pixels' && probeGuidanceText">
              <summary>Current probe guidance</summary>
              <p>{{ probeGuidanceText }}</p>
              <p>
                <template v-if="isDecSampleResult">
                  This is the current catalog guidance, separate from this recorded run. Its headless check reads
                  emulator cells for U+2500; this app result comes from the captured images above. The guidance does not
                  say a pixel review must prove a numeric character code, and is not a recorded assertion from this run.
                </template>
                <template v-else>
                  Current catalog guidance, not a recorded assertion or proof. Parser checks do not establish visible
                  styling.
                </template>
              </p>
            </details>
          </template>
        </template>

        <details class="result-evidence__details">
          <summary>Test environment</summary>
          <dl class="result-evidence__metadata">
            <dt>Feature ID</dt>
            <dd>{{ featureId }}</dd>
            <dt>Target</dt>
            <dd>{{ version ? `${version.target.kind}:${version.target.id}` : "No reviewed current run" }}</dd>
            <dt>Version</dt>
            <dd>{{ version?.target.version ?? "Not recorded" }}</dd>
            <dt>Operating system</dt>
            <dd>
              {{ version?.target.os ?? "Not recorded"
              }}<template v-if="version?.target.osVersion"> {{ version.target.osVersion }}</template>
            </dd>
            <dt>Outer terminal</dt>
            <dd>{{ version?.target.outerTerminal ?? "Not recorded" }}</dd>
            <dt>Multiplexer</dt>
            <dd>{{ version?.target.mux ?? "Not recorded" }}</dd>
            <dt>Configuration</dt>
            <dd>{{ version?.target.config ?? "Not recorded" }}</dd>
            <dt>Permissions</dt>
            <dd>{{ version?.target.permissions ?? "Not recorded" }}</dd>
            <dt>Measured at</dt>
            <dd>{{ version?.measuredAt ?? "Not recorded" }}</dd>
            <dt>Run ID</dt>
            <dd>{{ historicalCell?.chain.runId ?? version?.runId ?? "Not recorded" }}</dd>
            <dt>Run SHA-256</dt>
            <dd>{{ historicalCell?.chain.runSha256 ?? version?.sha256 ?? "Not recorded" }}</dd>
            <dt>Recorded method</dt>
            <dd>{{ historicalCell?.chain.method ?? currentResult?.evidence ?? "Not recorded" }}</dd>
            <dt>Suite</dt>
            <dd>
              {{ version?.suiteId ?? "Not recorded"
              }}<template v-if="historicalVersion">
                · {{ historicalVersion.suite.observed }}/{{ historicalVersion.suite.expected ?? "?" }} historical
                outcomes · {{ version.suiteFreshness }}</template
              >
            </dd>
            <dt>Source revision</dt>
            <dd>{{ version?.sourceRevision ?? "Not recorded" }}</dd>
            <dt>Correction</dt>
            <dd>{{ historicalCell?.chain.correctionId ?? "None" }}</dd>
          </dl>
        </details>
      </dialog>
    </Teleport>
  </span>
</template>

<style scoped>
.result-evidence__text {
  white-space: pre;
  overflow-x: auto;
  user-select: text;
}
</style>
