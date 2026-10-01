<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue"
import { withBase } from "vitepress"
import type { ObservationReason } from "@terminfo/probe-defs"
import type { EvidenceDocument, PublicCell, PublicVersion } from "../../data/public-results"

const props = withDefaults(
  defineProps<{
    featureId: string
    featureName: string
    probeGuidance?: string
    targetName: string
    version?: PublicVersion
    cell?: PublicCell
    display?: "compact" | "text"
  }>(),
  { display: "compact" },
)

const trigger = ref<HTMLButtonElement | null>(null)
const dialog = ref<HTMLDialogElement | null>(null)
const previewVisible = ref(false)
const dialogVisible = ref(false)
const previewPosition = ref<Record<string, string>>({})
const evidenceDocument = ref<EvidenceDocument | null>(null)
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

const status = computed(() => {
  if (!props.version) return { text: "No reviewed current result", icon: "?", tone: "unknown" }
  if (!props.cell) return { text: "Not tested by this run", icon: "?", tone: "unknown" }
  if (props.cell.outcome === "error") return { text: "Probe error", icon: "!", tone: "error" }
  if (props.cell.outcome === "inconclusive") return { text: "Inconclusive", icon: "~", tone: "ungraded" }
  if (!props.cell.conclusive) return { text: "Ungraded observation", icon: "~", tone: "ungraded" }
  if (props.cell.outcome === "supported") return { text: "Supported", icon: "✓", tone: "yes" }
  if (props.cell.outcome === "unsupported") return { text: "Unsupported", icon: "✗", tone: "no" }
  return { text: "Ungraded observation", icon: "~", tone: "ungraded" }
})
const shortLabel = computed(() => {
  if (status.value.text === "No reviewed current result") return "No result"
  if (status.value.text === "Not tested by this run") return "Not tested"
  if (status.value.text === "Ungraded observation") return "Ungraded"
  if (status.value.text === "Probe error") return "Error"
  return status.value.text
})
const methodLabel = computed(() =>
  props.cell?.evidence === "query"
    ? "Terminal query"
    : props.cell?.evidence === "none"
      ? "Not measured"
      : (props.cell?.evidence ?? ""),
)
const selectionExplanation = computed(() => {
  if (!props.version) return "No reviewed current result is available for this context."
  if (!props.cell) return "This feature was not measured by this selected run."
  return undefined
})
const reasonExplanation = computed(() => (props.cell?.reason ? reasonExplanations[props.cell.reason] : undefined))

const probeGuidanceText = computed(() => props.probeGuidance?.replace(/<\/?code>/g, ""))
const presentation = computed(() => props.cell?.presentation)
const correction = computed(() => props.version?.reviews.find((review) => review.id === props.cell?.chain.correctionId))
const previewRecord = computed(() => (presentation.value?.state === "presented" ? props.cell?.record : undefined))
const previewScreenshot = computed(() => previewRecord.value?.screenshot)
const screenshotUrl = computed(() => (previewScreenshot.value ? withBase(previewScreenshot.value.url) : undefined))
const previewFrames = computed(() => previewRecord.value?.frames ?? [])
const previewFrame = computed(() => previewFrames.value.find((frame) => frame.role === "target"))
const previewImageUrl = computed(() => (previewFrame.value ? withBase(previewFrame.value.url) : screenshotUrl.value))
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
const originalDiffers = computed(() => {
  const original = evidenceDocument.value?.observation
  const current = props.cell
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
    props.cell?.chain,
    props.cell?.outcome,
    props.cell?.reason,
    props.cell?.evidence,
    props.cell?.note,
    presentation.value,
  ])
})

function invalidateEvidence(): void {
  evidenceRequest += 1
  evidenceController?.abort()
  evidenceController = null
  evidenceDocument.value = null
  evidenceLoading.value = false
  evidenceError.value = null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

async function loadEvidence(): Promise<void> {
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
    if (cell.chain.runId !== version.runId || cell.chain.runSha256 !== version.sha256) {
      throw new Error("Result and run identities disagree")
    }
    const response = await fetch(withBase(approval.url), { signal: controller.signal })
    if (!response.ok) throw new Error(`Evidence request returned HTTP ${response.status}`)
    const bytes = await response.arrayBuffer()
    if (!globalThis.crypto?.subtle) throw new Error("SHA-256 verification is unavailable in this browser")
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
    const actualSha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
    if (actualSha256 !== approval.sha256) throw new Error("Evidence SHA-256 mismatch")
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      parsed.runId !== version.runId ||
      parsed.runSha256 !== version.sha256 ||
      parsed.featureId !== props.featureId ||
      !isRecord(parsed.observation) ||
      parsed.observation.featureId !== props.featureId ||
      !isRecord(parsed.record) ||
      !Array.isArray(parsed.record.assertions) ||
      !isRecord(parsed.review) ||
      parsed.review.id !== approval.review.id
    ) {
      throw new Error("Evidence document identity or structure does not match this result")
    }
    if (request !== evidenceRequest || !dialogVisible.value || identity !== evidenceIdentity.value) return
    evidenceDocument.value = parsed as unknown as EvidenceDocument
  } catch (error) {
    if (request !== evidenceRequest || !dialogVisible.value || identity !== evidenceIdentity.value) return
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

function showPreview(): void {
  if (dialogVisible.value || !trigger.value || typeof window === "undefined") return
  const box = trigger.value.getBoundingClientRect()
  const width = Math.min(320, window.innerWidth - 16)
  const left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8))
  const above = window.innerHeight - box.bottom < 230 && box.top > 230
  previewPosition.value = {
    left: `${left}px`,
    top: `${above ? box.top - 8 : box.bottom + 8}px`,
    width: `${width}px`,
    ...(above ? { transform: "translateY(-100%)" } : {}),
  }
  previewVisible.value = true
}

function hidePreview(): void {
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
      @pointerleave="hidePreview"
      @focus="showPreview"
      @blur="hidePreview"
      @keydown.esc.stop="hidePreview"
      @click="openDialog"
    >
      <span aria-hidden="true">{{ status.icon }}</span>
      <span v-if="display === 'text'" class="result-evidence__label"
        >{{ shortLabel }}<template v-if="previewImageUrl"> · Images</template></span
      >
    </button>

    <Teleport to="body">
      <div
        v-if="previewVisible && !dialogVisible"
        :id="tooltipId"
        class="result-evidence__preview"
        role="tooltip"
        :style="previewPosition"
      >
        <strong>{{ status.text }}</strong>
        <span
          >{{ targetName }}<template v-if="version"> · {{ version.target.version }}</template></span
        >
        <span v-if="cell"
          >Method: {{ methodLabel }}<template v-if="cell.reason"> · Reason: {{ cell.reason }}</template></span
        >
        <span v-if="selectionExplanation">{{ selectionExplanation }}</span>
        <span v-else-if="cell?.evidence === 'none'">This probe made no terminal measurement.</span>
        <span v-if="reasonExplanation">{{ reasonExplanation }}</span>
        <span v-if="cell?.note">{{ cell.note }}</span>
        <img
          v-if="previewImageUrl"
          :src="previewImageUrl"
          :alt="previewFrame ? `${previewFrame.label} target frame` : `Recorded ${featureName} result`"
        />
        <span v-if="previewFrames.length">{{ previewFrames.length }} screenshots · before and after</span>
        <span v-if="presentation?.state === 'withdrawn'">Presentation withdrawn: {{ presentation.review.reason }}</span>
        <span>{{ actionLabel }}<template v-if="previewImageUrl"> · open for original image</template></span>
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

        <p class="result-evidence__outcome" :class="`result-evidence__outcome--${status.tone}`">
          {{ status.text }}<template v-if="cell"> · {{ methodLabel }}</template>
        </p>
        <p v-if="cell?.note">{{ cell.note }}</p>
        <p v-if="cell?.evidence === 'query' && cell?.conclusive">
          This result is based on the query's recorded evidence, not every use of this feature.
        </p>
        <p v-else-if="cell?.evidence === 'query'">This query did not establish a yes-or-no result for the feature.</p>
        <p v-if="cell?.reason">Reason: {{ cell.reason }}</p>
        <p v-if="selectionExplanation">{{ selectionExplanation }}</p>
        <p v-else-if="cell?.evidence === 'none'">This probe made no terminal measurement.</p>
        <p v-if="reasonExplanation">{{ reasonExplanation }}</p>

        <h3>Evidence</h3>
        <p v-if="!version">No reviewed current run is selected for this terminal context.</p>
        <p v-else-if="!cell">This feature was not tested by the reviewed current run.</p>
        <template v-else-if="presentation?.state === 'not-reviewed'">
          <p>Original evidence has not been reviewed for presentation.</p>
        </template>
        <template v-else-if="presentation?.state === 'withdrawn'">
          <p>Evidence presentation was withdrawn: {{ presentation.review.reason }}</p>
          <p>Reviewed by {{ presentation.review.reviewer }}.</p>
        </template>
        <template v-else-if="presentation?.state === 'presented'">
          <p v-if="evidenceLoading" role="status">Loading and verifying the original evidence…</p>
          <p v-else-if="evidenceError" role="alert" class="result-evidence__outcome result-evidence__outcome--error">
            Evidence could not be verified: {{ evidenceError }}
          </p>
          <template v-else-if="evidenceDocument">
            <p v-if="correction">
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
              <h4>Screenshots</h4>
              <div class="result-evidence__frames">
                <figure v-for="(frame, index) in evidenceFrames" :key="index" class="result-evidence__image">
                  <img :src="withBase(frame.url)" :alt="`${frame.role} frame: ${frame.label}`" />
                  <figcaption>
                    <strong>{{ frame.role === "control" ? "Before" : "After" }}</strong> · {{ frame.label }}
                    <details>
                      <summary>Image details</summary>
                      Captured {{ frameTime(frame.capturedAt) }} · SHA-256 {{ frame.sha256 }}
                    </details>
                  </figcaption>
                  <a :href="withBase(frame.url)" target="_blank" rel="noopener noreferrer"
                    >Open original {{ frame.role }} image</a
                  >
                </figure>
              </div>
            </template>
            <template v-else-if="evidenceScreenshotUrl">
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
              <summary>Technical details · raw trace</summary>
              <template v-if="rawReply !== undefined">
                <h4>{{ evidenceDocument.observation.evidence === "none" ? "Collector trace" : "Raw reply" }}</h4>
                <pre class="result-evidence__raw">{{ rawReplyDisplay }}</pre>
              </template>
            </details>
            <details class="result-evidence__details">
              <summary>Review history</summary>
              <p v-if="correction">
                Review changed the result from {{ evidenceDocument.observation.outcome }} to {{ cell.outcome }}.
                Reviewed by {{ correction.reviewer }}: {{ correction.reason }}
              </p>
              <details>
                <summary>Evidence publication check</summary>
                <p>{{ presentation.review.reviewer }}: {{ presentation.review.reason }}</p>
              </details>
              <template v-if="originalDiffers">
                <h4>Original recorded observation</h4>
                <p>
                  {{ evidenceDocument.observation.outcome }} · {{ evidenceDocument.observation.evidence }} method
                  <template v-if="evidenceDocument.observation.reason">
                    · {{ evidenceDocument.observation.reason }}</template
                  >
                </p>
                <p v-if="evidenceDocument.observation.note">{{ evidenceDocument.observation.note }}</p>
              </template>
            </details>

            <details v-if="cell.evidence === 'pixels' && probeGuidanceText">
              <summary>Current probe guidance</summary>
              <p>{{ probeGuidanceText }}</p>
              <p>
                Current catalog guidance, not a recorded assertion or proof. Parser checks do not establish visible
                styling.
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
            <dd>{{ cell?.chain.runId ?? version?.runId ?? "Not recorded" }}</dd>
            <dt>Run SHA-256</dt>
            <dd>{{ cell?.chain.runSha256 ?? version?.sha256 ?? "Not recorded" }}</dd>
            <dt>Recorded method</dt>
            <dd>{{ cell?.chain.method ?? "Not recorded" }}</dd>
            <dt>Suite</dt>
            <dd>
              {{ version?.suiteId ?? "Not recorded"
              }}<template v-if="version">
                · {{ version.suite.observed }}/{{ version.suite.expected ?? "?" }} probes ·
                {{ version.suiteFreshness }}</template
              >
            </dd>
            <dt>Source revision</dt>
            <dd>{{ version?.sourceRevision ?? "Not recorded" }}</dd>
            <dt>Correction</dt>
            <dd>{{ cell?.chain.correctionId ?? "None" }}</dd>
          </dl>
        </details>
      </dialog>
    </Teleport>
  </span>
</template>
