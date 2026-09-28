<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId } from "vue"
import { withBase } from "vitepress"
import type { SelectedCell, SelectedVersion } from "../../data/selected-results"

const props = withDefaults(
  defineProps<{
    featureId: string
    featureName: string
    targetName: string
    version?: SelectedVersion
    cell?: SelectedCell
    display?: "compact" | "text"
  }>(),
  { display: "compact" },
)

const trigger = ref<HTMLButtonElement | null>(null)
const dialog = ref<HTMLDialogElement | null>(null)
const previewVisible = ref(false)
const dialogVisible = ref(false)
const previewPosition = ref<Record<string, string>>({})
const id = useId()
const tooltipId = `${id}-preview`
const dialogTitleId = `${id}-title`

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

const screenshot = computed(() => props.cell?.record?.screenshot)
const screenshotUrl = computed(() => (screenshot.value ? withBase(screenshot.value.url) : undefined))
const frames = computed(() => props.cell?.record?.frames ?? [])
const previewFrame = computed(() => frames.value.find((frame) => frame.role === "target"))
const previewImageUrl = computed(() => (previewFrame.value ? withBase(previewFrame.value.url) : screenshotUrl.value))
const rawReply = computed(() => props.cell?.record?.rawReply)
const assertions = computed(() => props.cell?.record?.assertions ?? [])
const hasRawResults = computed(() => rawReply.value !== undefined || assertions.value.length > 0)
const actionLabel = computed(() => {
  if (!props.cell) return "No evidence in current selection"
  if (frames.value.length) return "View captured frames"
  if (screenshotUrl.value) return "View screenshot"
  return hasRawResults.value ? "View raw results" : "No raw evidence recorded"
})
const accessibleName = computed(
  () =>
    `${props.featureName} in ${props.targetName}${props.version ? ` ${props.version.target.version}` : ""}: ${status.value.text}. ${actionLabel.value}`,
)
const rawReplyDisplay = computed(() => (rawReply.value === undefined ? "" : JSON.stringify(rawReply.value)))

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
  hidePreview()
  dialogVisible.value = true
  await nextTick()
  dialog.value?.showModal()
}

function closeDialog(): void {
  dialog.value?.close()
}

function onDialogClose(): void {
  dialogVisible.value = false
  nextTick(() => trigger.value?.focus({ preventScroll: true }))
}

onBeforeUnmount(() => {
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
      <span v-if="display === 'text'" class="result-evidence__label">{{ shortLabel }}</span>
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
          >Method: {{ cell.evidence }}<template v-if="cell.reason"> · {{ cell.reason }}</template></span
        >
        <span v-if="cell?.note">{{ cell.note }}</span>
        <img
          v-if="previewImageUrl"
          :src="previewImageUrl"
          :alt="previewFrame ? `${previewFrame.label} target frame` : `Recorded ${featureName} result`"
        />
        <span v-if="frames.length">{{ frames.length }} recorded frames · control and target</span>
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
            <h2 :id="dialogTitleId">{{ featureName }} · {{ targetName }}</h2>
          </div>
          <button type="button" class="result-evidence__close" aria-label="Close result details" @click="closeDialog">
            Close
          </button>
        </div>

        <p class="result-evidence__outcome" :class="`result-evidence__outcome--${status.tone}`">
          {{ status.text }}<template v-if="cell"> · {{ cell.evidence }} method</template>
        </p>
        <p v-if="cell?.note">{{ cell.note }}</p>
        <p v-if="cell?.reason">Reason: {{ cell.reason }}</p>

        <template v-if="frames.length">
          <h3>Captured frames</h3>
          <div class="result-evidence__frames">
            <figure v-for="(frame, index) in frames" :key="index" class="result-evidence__image">
              <img :src="withBase(frame.url)" :alt="`${frame.role} frame: ${frame.label}`" />
              <figcaption>
                <strong>{{ frame.role === "control" ? "Control" : "Target" }}</strong> · {{ frame.label }}<br />
                Captured {{ frameTime(frame.capturedAt) }} · SHA-256 {{ frame.sha256 }}
                <template v-if="frame.sourceRef"><br />Source capture {{ frame.sourceRef }}</template>
              </figcaption>
              <a :href="withBase(frame.url)" target="_blank" rel="noopener noreferrer"
                >Open original {{ frame.role }} image</a
              >
            </figure>
          </div>
        </template>
        <template v-else-if="screenshotUrl">
          <figure class="result-evidence__image">
            <img :src="screenshotUrl" :alt="`Original recorded image for ${featureName} in ${targetName}`" />
            <figcaption>Original recorded image · SHA-256 {{ screenshot?.sha256 }}</figcaption>
          </figure>
          <p><a :href="screenshotUrl" target="_blank" rel="noopener noreferrer">Open original screenshot</a></p>
        </template>

        <h3>Observation</h3>
        <p v-if="!version">No reviewed current run is selected for this terminal context.</p>
        <p v-else-if="!cell">This feature was not tested by the reviewed current run.</p>
        <p v-else-if="!previewImageUrl && !hasRawResults">No raw evidence was captured for this observation.</p>
        <template v-if="rawReply !== undefined">
          <h4>Raw reply</h4>
          <pre class="result-evidence__raw">{{ rawReplyDisplay }}</pre>
        </template>
        <template v-if="assertions.length">
          <h4>Bound assertions</h4>
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

        <h3>Run context</h3>
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
          <dd>{{ version?.runId ?? "Not recorded" }}</dd>
          <dt>Run SHA-256</dt>
          <dd>{{ version?.sha256 ?? "Not recorded" }}</dd>
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

        <template v-if="version?.reviews?.length">
          <h3>Reviews</h3>
          <ul class="result-evidence__reviews">
            <li v-for="review in version.reviews" :key="review.id">
              <strong>{{ review.reviewer }}</strong> · {{ review.reason }}
              <span v-if="review.sources.length">Sources: {{ review.sources.join(", ") }}</span>
            </li>
          </ul>
        </template>
        <p v-if="cell" class="result-evidence__repro">Full reproduction steps: not recorded for this observation.</p>
      </dialog>
    </Teleport>
  </span>
</template>
