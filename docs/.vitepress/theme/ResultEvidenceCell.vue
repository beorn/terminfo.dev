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
import { describeTracePanes, readCellTrace, type LoadedCellTrace } from "../../data/evidence-reader"
import { data } from "../../data/probes.data"
import { describeReplyBytes, describeSentBytes, describeStepTable, type StepSource } from "../../data/step-table"
import { contextLine } from "./context-label"
import { DIFFERS_BY_CONTEXT, type AppCellStatus } from "../../data/app-cells"
import { evidenceStatus, NO_RESULT_STATUS, plainExpectedSentence } from "./evidence-status"
import { displayMeasuredDate, displayOs, displayVersion } from "./display-version"
import {
  buildCardModel,
  expectedVisualSpecimen,
  formatWhoLine,
  shortTerminalName,
  vendorExtensionOrigin,
} from "./card-explain"
import { clearActivePopover, HOVER_CLOSE_GRACE_MS, HOVER_OPEN_DELAY_MS, registerActivePopover } from "./bar-layout"
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
          derived?: { parent: string; parentRunId: string; reason: string }
        })
    /** compact: the mark alone (matrices); text: mark and word; label: the word alone, for a list whose bullet is the mark (#37761). */
    display?: "compact" | "text" | "label"
    /** Render the result card directly inline (used by SupportBar's cascading detail pane, #37631). */
    inline?: boolean
  }>(),
  { display: "compact", inline: false },
)

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
const fullShotDialog = ref<HTMLDialogElement | null>(null)
let previewOpenTimer: ReturnType<typeof setTimeout> | undefined
let previewHideTimer: ReturnType<typeof setTimeout> | undefined
const previewVisible = ref(false)
const previewPinned = ref(false)
const previewPosition = ref<Record<string, string>>({})
const cellTrace = ref<LoadedCellTrace | null>(null)
const evidenceLoading = ref(false)
const evidenceError = ref<string | null>(null)
let evidenceRequest = 0
let evidenceController: AbortController | null = null
const id = useId()
const tooltipId = `${id}-preview`

const derivedInfo = computed(() =>
  props.cell && "derived" in props.cell && props.cell.derived ? props.cell.derived : undefined,
)
const derived = computed(() => Boolean(derivedInfo.value))
const derivedParentName = computed(() => {
  const parentId = derivedInfo.value?.parent
  if (!parentId) return undefined
  return data.featureDescriptions[parentId]?.name ?? parentId
})
const derivedParentHref = computed(() => {
  const parentId = derivedInfo.value?.parent
  if (!parentId) return undefined
  const cat = parentId.split(".")[0]
  const slug = data.featureDescriptions[parentId]?.slug ?? parentId.replaceAll(".", "-")
  return cat ? withBase(`/${cat}/${slug}`) : undefined
})

const joined = computed(() => (props.cell && "joined" in props.cell ? props.cell.joined : undefined))
const effectiveStatus = computed(() => joined.value?.status ?? currentResult.value?.status)
const status = computed(() => evidenceStatus(props.featureId, effectiveStatus.value, derived.value))
const blank = computed(() => status.value === NO_RESULT_STATUS)
const isUntestable = computed(() => effectiveStatus.value === "untestable")
const isDiffers = computed(() => effectiveStatus.value === DIFFERS_BY_CONTEXT)

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
const showJoinedGrades = computed(
  () =>
    Boolean(joinedGrades.value) &&
    (joined.value?.status === DIFFERS_BY_CONTEXT || (joined.value?.from.length ?? 0) > 1),
)
const shortLabel = computed(() => status.value.text)

const legacyStatusWords = /\b(?:inconclusive|conclusive|conclusively|untested)\b|\bnot[ -]tested\b/i
function readerSafeExplanation(value?: string): string | undefined {
  if (!value) return undefined
  return legacyStatusWords.test(value) ? "The original wording is preserved in the downloadable record." : value
}

const featureMeta = computed(() => data.featureDescriptions[props.featureId])
const vendorTag = computed(() => vendorExtensionOrigin(props.featureId))
const shortName = computed(() => shortTerminalName(props.subjectName, sourceRun.value?.subject.kind))

const whoLine = computed(() => {
  const run = sourceRun.value
  const osName = run?.subject.os ? displayOs(run.subject.os) : undefined
  const version = run ? displayVersion(run.subject.version) : undefined
  const measuredDate = !blank.value && run?.measuredAt ? displayMeasuredDate(run.measuredAt) : undefined
  return formatWhoLine({
    subjectName: props.subjectName,
    version,
    subjectKind: run?.subject.kind,
    osName,
    measuredDate,
  })
})

const detailsEnvironment = computed(() => {
  const run = sourceRun.value
  if (!run) return undefined
  const osName = run.subject.os ? displayOs(run.subject.os) : ""
  const osWithKernel = osName ? (run.subject.osVersion ? `${osName} ${run.subject.osVersion}` : osName) : ""
  const date = run.measuredAt ? displayMeasuredDate(run.measuredAt) : ""
  const shortRun = run.runId ? `run ${run.runId.slice(0, 8)}` : ""
  return [osWithKernel, date, shortRun].filter(Boolean).join(" · ") || undefined
})

const captures = computed(() => cellTrace.value?.cell.captures)
const expectedVisual = computed(() => expectedVisualSpecimen(props.featureId))
const expectedIllustration = computed(() =>
  props.featureId === "charsets.utf8" ? withBase("/illustrations/utf8-cells.svg") : undefined,
)
const hasExpectedPicture = computed(() =>
  Boolean(captures.value?.expected || expectedVisual.value || expectedIllustration.value),
)
const hasObservedPicture = computed(() => Boolean(captures.value?.observed || captures.value?.textCells))
const showShots = computed(
  () =>
    !blank.value &&
    !isUntestable.value &&
    !derived.value &&
    (hasObservedPicture.value || Boolean(expectedIllustration.value)),
)

const expectedSentence = computed(() =>
  plainExpectedSentence({
    body: featureMeta.value?.body,
    probeGuidance: (props.probeGuidance ?? featureMeta.value?.probe)?.replace(/<\/?code>/g, ""),
    featureName: props.featureName,
  }),
)

const cardModel = computed(() => {
  const reason = readerSafeExplanation(currentResult.value?.reason ?? currentResult.value?.hold)
  return buildCardModel({
    status: effectiveStatus.value,
    featureId: props.featureId,
    featureName: props.featureName,
    subjectKind: sourceRun.value?.subject.kind,
    assertionType: currentResult.value?.assertionType,
    declaredSequence: featureMeta.value?.sequence,
    expectedSentence: expectedSentence.value,
    derived: derived.value,
    reason,
    traceEvidence: cellTrace.value?.cell.evidence,
    exchange: cellTrace.value?.cell,
    parserState: cellTrace.value?.cell.parserState,
    captures: captures.value,
    hasExpectedPicture: hasExpectedPicture.value,
    joinedFrom: joined.value?.from,
  })
})

const tracePaneCopy = computed(() => {
  if (!cellTrace.value) return undefined
  return describeTracePanes(cellTrace.value, {
    sequence: featureMeta.value?.sequence,
    probeGuidance: props.probeGuidance ?? featureMeta.value?.probe,
    subjectKind: sourceRun.value?.subject.kind,
    hasReferenceImage: hasExpectedPicture.value,
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
const parserStatePre = computed(() => tracePaneCopy.value?.tested.items.find((item) => item.label === "Observed")?.pre)
const sentFromTrace = computed(
  () => sentBytes.value?.full ?? tracePaneCopy.value?.tested.items.find((item) => item.label === "Sent")?.code,
)

const hasDetails = computed(() =>
  Boolean(
    captures.value?.full ||
    stepTable.value ||
    sentFromTrace.value ||
    replyBytes.value?.full ||
    parserStatePre.value ||
    showJoinedGrades.value ||
    detailsEnvironment.value ||
    evidenceError.value,
  ),
)

const pillClass = computed(() => {
  if (blank.value) return "rc-pill--none"
  if (status.value.tone === "yes") return "rc-pill--ok"
  if (status.value.tone === "no" || status.value.tone === "error") return "rc-pill--no"
  if (status.value.tone === "ungraded") return "rc-pill--unt"
  if (status.value.tone === "differs") return "rc-pill--diff"
  return "rc-pill--none"
})

const pillLabel = computed(() => {
  if (blank.value) return NO_RESULT_STATUS.title ?? "No result yet"
  if (isDiffers.value) return "Differs"
  if (derived.value) return "Unsupported"
  return status.value.text
})

const pillIcon = computed(() => {
  if (blank.value) return "◌"
  if (status.value.tone === "no") return "✕"
  if (status.value.tone === "ungraded") return "!"
  return status.value.icon
})

const verdictMark = computed(() => {
  if (status.value.tone === "yes") return "✓"
  if (status.value.tone === "no" || status.value.tone === "error") return "✕"
  if (status.value.tone === "differs") return "≠"
  return ""
})

const verdictMarkClass = computed(() => {
  if (status.value.tone === "yes") return "rc-mk--ok"
  if (status.value.tone === "no" || status.value.tone === "error") return "rc-mk--no"
  if (status.value.tone === "differs") return "rc-mk--diff"
  return ""
})

const detailsSummaryLabel = computed(() => "Details ›")

const actionLabel = computed(() => (props.cell ? "Opens how this was tested" : "No evidence in current selection"))
const accessibleName = computed(
  () =>
    `${props.featureName} in ${props.subjectName}${sourceRun.value ? ` ${displayVersion(sourceRun.value.subject.version)}` : ""}: ${blank.value ? `${NO_RESULT_STATUS.title}.` : `${status.value.text}. ${actionLabel.value}`}`,
)
const evidenceIdentity = computed(() =>
  JSON.stringify([
    props.featureId,
    sourceFeatureId.value,
    sourceRun.value?.runId,
    sourceRun.value?.sha256,
    sourceRun.value?.subject.version,
    currentResult.value?.status,
    props.cell?.reason,
    props.cell?.assertionType,
    sourceRun.value?.trace,
  ]),
)

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

function openFullShot(): void {
  fullShotDialog.value?.showModal()
}

function closeFullShot(): void {
  fullShotDialog.value?.close()
}

function cancelOpenTimer(): void {
  clearTimeout(previewOpenTimer)
  previewOpenTimer = undefined
}

function keepPreview(): void {
  clearTimeout(previewHideTimer)
  previewHideTimer = undefined
}

function scheduleOpenPreview(): void {
  keepPreview()
  if (previewVisible.value) return
  cancelOpenTimer()
  previewOpenTimer = setTimeout(() => {
    previewOpenTimer = undefined
    showPreview(false)
  }, HOVER_OPEN_DELAY_MS)
}

function scheduleHidePreview(event?: FocusEvent): void {
  cancelOpenTimer()
  if (previewPinned.value || fullShotDialog.value?.open) return
  const next = event?.relatedTarget
  if (next instanceof Node && (preview.value?.contains(next) || trigger.value?.contains(next))) return
  keepPreview()
  previewHideTimer = setTimeout(hidePreview, HOVER_CLOSE_GRACE_MS)
}

function positionPreview(): void {
  if (!previewVisible.value || !trigger.value || !preview.value) return
  const box = trigger.value.getBoundingClientRect()
  const height = preview.value.getBoundingClientRect().height
  const width = Math.min(480, window.innerWidth - 16)
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
    width: `${Math.min(480, window.innerWidth - 16)}px`,
    maxHeight: `min(88vh, 680px, ${Math.max(above, below)}px)`,
  }
  void nextTick(positionPreview)
}

function onDocKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    if (fullShotDialog.value?.open) {
      closeFullShot()
      return
    }
    closePreview()
  }
}

function showPreview(pin = false): void {
  cancelOpenTimer()
  keepPreview()
  if (!trigger.value || typeof window === "undefined") return
  registerActivePopover(hidePreview)
  if (pin) previewPinned.value = true
  previewVisible.value = true
  previewPosition.value = { width: `${Math.min(480, window.innerWidth - 16)}px` }
  document.addEventListener("pointerdown", outsidePreview)
  document.addEventListener("keydown", onDocKeydown)
  document.addEventListener("terminfo:close-previews", hidePreview)
  window.addEventListener("resize", repositionPreview)
  repositionPreview()
  void loadEvidence()
}

async function focusPreview(): Promise<void> {
  showPreview(true)
  await nextTick()
  preview.value?.focus({ preventScroll: true })
}

function closePreview(): void {
  trigger.value?.focus({ preventScroll: true })
  hidePreview()
}

function outsidePreview(event: PointerEvent): void {
  if (fullShotDialog.value?.open) return
  if (event.target instanceof Node && (preview.value?.contains(event.target) || trigger.value?.contains(event.target)))
    return
  hidePreview()
}

function hidePreview(): void {
  cancelOpenTimer()
  document.removeEventListener("pointerdown", outsidePreview)
  document.removeEventListener("keydown", onDocKeydown)
  document.removeEventListener("terminfo:close-previews", hidePreview)
  window.removeEventListener("resize", repositionPreview)
  keepPreview()
  previewVisible.value = false
  previewPinned.value = false
  clearActivePopover(hidePreview)
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
  <div v-if="inline" class="rc-card rc-card--inline" role="region" :aria-label="`${featureName} result`">
    <div class="rc-top">
      <p class="rc-title">
        {{ featureName }}<span v-if="vendorTag" class="rc-vendor">{{ vendorTag }}</span>
      </p>
      <span class="rc-pill" :class="pillClass">
        <svg v-if="isUntestable" class="rc-ico" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c7 0 10 8 10 8a13.2 13.2 0 0 1-1.67 2.68" />
          <path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3 8 10 8a9.7 9.7 0 0 0 5.39-1.61" />
          <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
          <path d="M2 2l20 20" />
        </svg>
        <span v-else aria-hidden="true">{{ pillIcon }}</span> {{ pillLabel }}
      </span>
    </div>

    <div class="rc-who">
      <span>{{ whoLine }}</span>
    </div>

    <p v-if="blank || isUntestable" class="rc-answer">{{ evidenceError || cardModel.closing }}</p>
    <p v-else-if="derived" class="rc-answer">
      Unsupported because
      <a v-if="derivedParentHref" :href="derivedParentHref" class="rc-parent-link">{{ derivedParentName }}</a>
      <span v-else>{{ derivedParentName || "its required parent feature" }}</span>
      is unsupported here.
    </p>

    <template v-else>
      <span v-if="evidenceLoading" class="rc-muted">Loading recorded evidence…</span>

      <div v-if="cardModel.steps.length > 0 || cardModel.readouts.length > 0" class="rc-steps">
        <div v-for="step in cardModel.steps" :key="step.num" class="rc-st">
          <span class="rc-n">{{ step.num }}</span>
          <code :class="{ 'rc-act': Boolean(step.codeMuted) }" :title="step.fullCode || undefined">{{
            step.codeMuted || step.code
          }}</code>
          <span class="rc-w">{{ step.words }}</span>
        </div>
        <div v-for="(ro, rIdx) in cardModel.readouts" :key="'r-' + rIdx" class="rc-st rc-rep">
          <span class="rc-n" aria-hidden="true">←</span>
          <code :class="{ 'rc-act': Boolean(ro.codeMuted) }" :title="ro.fullCode || undefined">{{
            ro.codeMuted || ro.code
          }}</code>
          <span class="rc-w"
            ><b>{{ ro.label }}:</b> {{ ro.text }}</span
          >
          <span v-if="ro.mark" class="rc-mk" :class="'rc-mk--' + ro.mark">{{ ro.mark === "ok" ? "✓" : "✕" }}</span>
        </div>
      </div>

      <div v-if="showShots" class="rc-shots" :class="{ 'rc-shots--single': !hasExpectedPicture }">
        <div v-if="hasExpectedPicture" class="rc-shot">
          <span class="rc-cap">Expected</span>
          <div class="rc-term">
            <img
              v-if="captures?.expected"
              :src="withBase(captures.expected.url)"
              :width="captures.expected.width"
              :height="captures.expected.height"
              alt="Expected terminal rendering"
            />
            <span v-else-if="expectedVisual" :style="expectedVisual.style">{{ expectedVisual.text }}</span>
            <img
              v-else-if="expectedIllustration"
              :src="expectedIllustration"
              alt="Illustrative expected Unicode cells"
            />
          </div>
        </div>
        <div v-if="hasObservedPicture" class="rc-shot" :class="{ 'rc-shot--bad': status.tone === 'no' }">
          <span class="rc-cap">
            {{ shortName }}'s screen
            <span v-if="verdictMark" class="rc-mk" :class="verdictMarkClass">{{ verdictMark }}</span>
          </span>
          <div class="rc-term">
            <img
              v-if="captures?.observed"
              :src="withBase(captures.observed.url)"
              :width="captures.observed.width"
              :height="captures.observed.height"
              :alt="`${shortName} screen crop${captures.regionText ? ` (${captures.regionText})` : ''}`"
            />
            <pre v-else-if="captures?.textCells" class="rc-textcells">{{ captures.textCells }}</pre>
          </div>
        </div>
      </div>

      <div class="rc-steps">
        <div class="rc-st rc-res">
          <span class="rc-w rc-sum">{{ evidenceError || cardModel.closing }}</span>
        </div>
      </div>

      <p v-if="cardModel.contextNote" class="rc-ctx">{{ cardModel.contextNote }}</p>
    </template>

    <details v-if="!blank && hasDetails" class="rc-details">
      <summary class="rc-foot">{{ detailsSummaryLabel }}</summary>
      <div class="rc-details-body">
        <p v-if="showJoinedGrades" class="result-evidence__contexts">{{ joinedGrades }}</p>
        <div v-if="captures?.full" class="rc-detail-sec">
          <div class="rc-detail-row">
            <span class="rc-bytes-label">Full terminal screenshot</span>
            <button type="button" class="rc-link-btn" @click="openFullShot">Enlarge ›</button>
          </div>
          <span v-if="captures.regionText" class="rc-muted">Read region: {{ captures.regionText }}</span>
          <img
            class="rc-fullshot-thumb"
            :src="withBase(captures.full.url)"
            :alt="`${shortName} full terminal grid screenshot`"
            @click="openFullShot"
          />
        </div>
        <ResultSteps v-if="stepTable" :rows="stepTable.rows" />
        <div v-if="sentFromTrace" class="rc-bytes">
          <span class="rc-bytes-label">Setup &amp; sent bytes</span>
          <pre>{{ sentFromTrace }}</pre>
        </div>
        <div v-if="replyBytes?.full" class="rc-bytes">
          <span class="rc-bytes-label">Raw reply bytes</span>
          <pre>{{ replyBytes.full }}</pre>
        </div>
        <div v-if="parserStatePre" class="rc-bytes">
          <span class="rc-bytes-label">Parser state</span>
          <pre>{{ parserStatePre }}</pre>
        </div>
        <span v-if="evidenceError" role="alert">Evidence error: {{ evidenceError }}</span>
        <span v-if="detailsEnvironment" class="rc-muted">{{ detailsEnvironment }}</span>
      </div>
    </details>

    <Teleport to="body">
      <dialog v-if="captures?.full" ref="fullShotDialog" class="rc-fullshot-dialog" @click.self="closeFullShot">
        <div class="rc-fullshot-head">
          <strong>{{ shortName }} — {{ featureName }}</strong>
          <button type="button" class="rc-close-mini" aria-label="Close screenshot" @click="closeFullShot">×</button>
        </div>
        <p v-if="captures.regionText" class="rc-muted">
          Whole terminal cell grid (window chrome excluded). Read region: {{ captures.regionText }}.
        </p>
        <img
          :src="withBase(captures.full.url)"
          :width="captures.full.width"
          :height="captures.full.height"
          :alt="`${shortName} terminal cell grid screenshot`"
        />
      </dialog>
    </Teleport>
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
      @pointerenter="scheduleOpenPreview"
      @pointerleave="scheduleHidePreview()"
      @focus="showPreview(false)"
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
        class="result-evidence__preview rc-card"
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
        <div class="rc-top">
          <p class="rc-title">
            {{ featureName }}<span v-if="vendorTag" class="rc-vendor">{{ vendorTag }}</span>
          </p>
          <div class="rc-top-right">
            <span class="rc-pill" :class="pillClass">
              <svg v-if="isUntestable" class="rc-ico" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c7 0 10 8 10 8a13.2 13.2 0 0 1-1.67 2.68" />
                <path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3 8 10 8a9.7 9.7 0 0 0 5.39-1.61" />
                <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                <path d="M2 2l20 20" />
              </svg>
              <span v-else aria-hidden="true">{{ pillIcon }}</span> {{ pillLabel }}
            </span>
            <button type="button" class="rc-close-mini" aria-label="Close" @click="closePreview">×</button>
          </div>
        </div>

        <div class="rc-who">
          <span>{{ whoLine }}</span>
        </div>

        <p v-if="isUntestable" class="rc-answer">{{ evidenceError || cardModel.closing }}</p>
        <p v-else-if="derived" class="rc-answer">
          Unsupported because
          <a v-if="derivedParentHref" :href="derivedParentHref" class="rc-parent-link">{{ derivedParentName }}</a>
          <span v-else>{{ derivedParentName || "its required parent feature" }}</span>
          is unsupported here.
        </p>

        <template v-else>
          <span v-if="evidenceLoading" class="rc-muted">Loading recorded evidence…</span>

          <div v-if="cardModel.steps.length > 0 || cardModel.readouts.length > 0" class="rc-steps">
            <div v-for="step in cardModel.steps" :key="step.num" class="rc-st">
              <span class="rc-n">{{ step.num }}</span>
              <code :class="{ 'rc-act': Boolean(step.codeMuted) }" :title="step.fullCode || undefined">{{
                step.codeMuted || step.code
              }}</code>
              <span class="rc-w">{{ step.words }}</span>
            </div>
            <div v-for="(ro, rIdx) in cardModel.readouts" :key="'r-' + rIdx" class="rc-st rc-rep">
              <span class="rc-n" aria-hidden="true">←</span>
              <code :class="{ 'rc-act': Boolean(ro.codeMuted) }" :title="ro.fullCode || undefined">{{
                ro.codeMuted || ro.code
              }}</code>
              <span class="rc-w"
                ><b>{{ ro.label }}:</b> {{ ro.text }}</span
              >
              <span v-if="ro.mark" class="rc-mk" :class="'rc-mk--' + ro.mark">{{ ro.mark === "ok" ? "✓" : "✕" }}</span>
            </div>
          </div>

          <div v-if="showShots" class="rc-shots" :class="{ 'rc-shots--single': !hasExpectedPicture }">
            <div v-if="hasExpectedPicture" class="rc-shot">
              <span class="rc-cap">Expected</span>
              <div class="rc-term">
                <img
                  v-if="captures?.expected"
                  :src="withBase(captures.expected.url)"
                  :width="captures.expected.width"
                  :height="captures.expected.height"
                  alt="Expected terminal rendering"
                />
                <span v-else-if="expectedVisual" :style="expectedVisual.style">{{ expectedVisual.text }}</span>
                <img
                  v-else-if="expectedIllustration"
                  :src="expectedIllustration"
                  alt="Illustrative expected Unicode cells"
                />
              </div>
            </div>
            <div v-if="hasObservedPicture" class="rc-shot" :class="{ 'rc-shot--bad': status.tone === 'no' }">
              <span class="rc-cap">
                {{ shortName }}'s screen
                <span v-if="verdictMark" class="rc-mk" :class="verdictMarkClass">{{ verdictMark }}</span>
              </span>
              <div class="rc-term">
                <img
                  v-if="captures?.observed"
                  :src="withBase(captures.observed.url)"
                  :width="captures.observed.width"
                  :height="captures.observed.height"
                  :alt="`${shortName} screen crop${captures.regionText ? ` (${captures.regionText})` : ''}`"
                />
                <pre v-else-if="captures?.textCells" class="rc-textcells">{{ captures.textCells }}</pre>
              </div>
            </div>
          </div>

          <div class="rc-steps">
            <div class="rc-st rc-res">
              <span class="rc-w rc-sum">{{ evidenceError || cardModel.closing }}</span>
            </div>
          </div>

          <p v-if="cardModel.contextNote" class="rc-ctx">{{ cardModel.contextNote }}</p>
        </template>

        <details v-if="hasDetails" class="rc-details">
          <summary class="rc-foot">{{ detailsSummaryLabel }}</summary>
          <div class="rc-details-body">
            <p v-if="showJoinedGrades" class="result-evidence__contexts">{{ joinedGrades }}</p>
            <div v-if="captures?.full" class="rc-detail-sec">
              <div class="rc-detail-row">
                <span class="rc-bytes-label">Full terminal screenshot</span>
                <button type="button" class="rc-link-btn" @click="openFullShot">Enlarge ›</button>
              </div>
              <span v-if="captures.regionText" class="rc-muted">Read region: {{ captures.regionText }}</span>
              <img
                class="rc-fullshot-thumb"
                :src="withBase(captures.full.url)"
                :alt="`${shortName} full terminal grid screenshot`"
                @click="openFullShot"
              />
            </div>
            <ResultSteps v-if="stepTable" :rows="stepTable.rows" />
            <div v-if="sentFromTrace" class="rc-bytes">
              <span class="rc-bytes-label">Setup &amp; sent bytes</span>
              <pre>{{ sentFromTrace }}</pre>
            </div>
            <div v-if="replyBytes?.full" class="rc-bytes">
              <span class="rc-bytes-label">Raw reply bytes</span>
              <pre>{{ replyBytes.full }}</pre>
            </div>
            <div v-if="parserStatePre" class="rc-bytes">
              <span class="rc-bytes-label">Parser state</span>
              <pre>{{ parserStatePre }}</pre>
            </div>
            <span v-if="evidenceError" role="alert">Evidence error: {{ evidenceError }}</span>
            <span v-if="detailsEnvironment" class="rc-muted">{{ detailsEnvironment }}</span>
          </div>
        </details>

        <dialog v-if="captures?.full" ref="fullShotDialog" class="rc-fullshot-dialog" @click.self="closeFullShot">
          <div class="rc-fullshot-head">
            <strong>{{ shortName }} — {{ featureName }}</strong>
            <button type="button" class="rc-close-mini" aria-label="Close screenshot" @click="closeFullShot">×</button>
          </div>
          <p v-if="captures.regionText" class="rc-muted">
            Whole terminal cell grid (window chrome excluded). Read region: {{ captures.regionText }}.
          </p>
          <img
            :src="withBase(captures.full.url)"
            :width="captures.full.width"
            :height="captures.full.height"
            :alt="`${shortName} terminal cell grid screenshot`"
          />
        </dialog>
      </div>
    </Teleport>
  </span>
</template>
