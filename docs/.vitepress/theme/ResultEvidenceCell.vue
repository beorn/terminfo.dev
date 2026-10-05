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

const isDecSampleResult = computed(
  () =>
    props.featureId === "charsets.dec-special" &&
    props.version?.runId === "e81b65484899493ffb9b5eacc3a6062d" &&
    props.version.sha256 === "cab396be1c52f450e7203039119a98355392c0b2d16bffb6a488922544b3d8c2" &&
    props.version.target.kind === "app" &&
    props.version.target.id === "kitty" &&
    props.version.target.version === "0.49.2" &&
    props.version.target.os === "linux" &&
    props.cell?.outcome === "supported" &&
    props.cell.conclusive === true &&
    props.cell.evidence === "pixels" &&
    props.cell.chain.correctionId === "pixels-e81b65484899493ffb9b5eacc3a6062d-charsets.dec-special" &&
    props.cell.presentation.state === "presented" &&
    props.cell.presentation.review.id === "present-e81b65484899493ffb9b5eacc3a6062d-charsets.dec-special",
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
              <li><strong>Supported</strong>: the evidence establishes the tested effect.</li>
              <li><strong>Unsupported</strong>: the evidence establishes that the tested effect did not occur.</li>
              <li><strong>Inconclusive</strong>: the evidence does not establish either result.</li>
              <li><strong>Probe error (Error)</strong>: the probe failed to complete its measurement.</li>
              <li>
                <strong>Ungraded observation (Ungraded)</strong>: a result was recorded, but it lacks a usable
                conclusive assessment of the tested claim. For example, a legacy callback may record a pass/fail value
                without enough measured evidence to grade it. This does not necessarily mean test criteria were absent.
              </li>
              <li>
                <strong>Not tested by this run (Not tested)</strong>: the site has selected a reviewed run for this
                context, but that run has no observation for this feature. For example, the run may predate this feature
                being added to its suite. This does not prove unsupported or a deliberate skip.
              </li>
              <li>
                <strong>No reviewed current result (No result)</strong>: the site has not selected any reviewed run for
                this terminal context. For example, it may have only an unreviewed capture for this version and
                configuration. Private or older runs may also exist. This differs from Not tested, where a run is
                selected but lacks this feature; you do not need to select a run, and this does not describe human
                consensus.
              </li>
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
        <details v-if="isDecSampleResult && cell?.note" class="result-evidence__details">
          <summary>Detailed review note</summary>
          <p>{{ cell.note }}</p>
        </details>
        <p v-else-if="cell?.note">{{ cell.note }}</p>
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
            <p v-if="correction && isDecSampleResult">
              The collector captured the images but did not automatically judge their content. It left the result
              inconclusive until image review. Sol, an AI reviewer, then compared the unchanged frames against two
              criteria: the middle <code>q</code> on row 3 must look like the horizontal line in row 2, and row 4 must
              remain ordinary ASCII text. That review established support for this sample. It used no numeric confidence
              score, new frames or updated terminal. “Corrected after review” means the assessment changed; Kitty was
              not fixed and this was not a rerun. The same AI reviewer made the support assessment and the separate
              decision to display the evidence, not two independent tests or human approvals. The original result and
              both decisions are preserved in Review history.
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
              <h4>Screenshots</h4>
              <div class="result-evidence__frames">
                <figure v-for="(frame, index) in evidenceFrames" :key="index" class="result-evidence__image">
                  <img :src="withBase(frame.url)" :alt="`${frame.role} frame: ${frame.label}`" />
                  <figcaption>
                    <strong>{{ frame.role === "control" ? "Control" : "Target" }}</strong> · {{ frame.label }}
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
              <summary>{{ isDecSampleResult ? "Recorded test trace" : "Technical details · raw trace" }}</summary>
              <template v-if="rawReply !== undefined">
                <p v-if="isDecSampleResult">Recorded evidence kind: <code>pixels</code>.</p>
                <h4>
                  {{
                    isDecSampleResult
                      ? "Recorded test trace"
                      : evidenceDocument.observation.evidence === "none"
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
                  {{ evidenceDocument.observation.outcome }} · {{ evidenceDocument.observation.evidence }} method
                  <template v-if="evidenceDocument.observation.reason">
                    · {{ evidenceDocument.observation.reason }}</template
                  >
                </p>
                <p>
                  Inconclusive meant the images still needed review. Insufficient-evidence meant the collector had not
                  yet established a supported or unsupported result.
                </p>
                <p v-if="evidenceDocument.observation.note">{{ evidenceDocument.observation.note }}</p>
                <h4>2. Support review</h4>
                <p>
                  Sol, an AI image reviewer, changed the assessment from inconclusive to supported for this sample using
                  the same original control and target frames. The frames were retained; Kitty was not fixed and the
                  test was not rerun.
                </p>
                <details v-if="correction">
                  <summary>Support review record</summary>
                  <p>
                    Review changed the result from {{ evidenceDocument.observation.outcome }} to {{ cell.outcome }}.
                    Reviewed by {{ correction.reviewer }}: {{ correction.reason }}
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
                  <p>{{ presentation.review.reviewer }}: {{ presentation.review.reason }}</p>
                </details>
              </template>
              <template v-else>
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
