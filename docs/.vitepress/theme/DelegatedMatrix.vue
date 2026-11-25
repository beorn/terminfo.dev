<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId } from "vue"
import type { PublicContextSummary, PublicRunMetadata } from "../../data/public-results"
import { clearActivePopover, HOVER_CLOSE_GRACE_MS, HOVER_OPEN_DELAY_MS, registerActivePopover } from "./bar-layout"
import type { MatrixCellValue } from "./matrix-cells"
import ResultEvidenceCell from "./ResultEvidenceCell.vue"

export interface DelegatedMatrixTarget {
  readonly featureId: string
  readonly featureName: string
  readonly probeGuidance?: string
  readonly subjectName: string
  readonly version?: PublicRunMetadata | PublicContextSummary
  readonly cell?: MatrixCellValue
}

const props = defineProps<{
  resolveCell: (featureId: string, backendName: string) => DelegatedMatrixTarget | undefined
}>()

const TRIGGER_SELECTOR = "button.result-evidence__trigger[data-mc-f][data-mc-b]"

const root = ref<HTMLElement | null>(null)
const preview = ref<HTMLElement | null>(null)
const active = ref<(DelegatedMatrixTarget & { readonly backendName: string }) | null>(null)
const previewPinned = ref(false)
const previewPosition = ref<Record<string, string>>({})
const popoverId = `${useId()}-matrix-preview`

let activeTrigger: HTMLButtonElement | null = null
let pendingTrigger: HTMLButtonElement | null = null
let openTimer: ReturnType<typeof setTimeout> | undefined
let hideTimer: ReturnType<typeof setTimeout> | undefined
let resizeObserver: ResizeObserver | null = null
let suppressFocusReopen = false

const activeKey = computed(() => (active.value ? `${active.value.featureId}::${active.value.backendName}` : ""))

function hasOpenFullShotDialog(): boolean {
  return typeof document !== "undefined" && Boolean(document.querySelector("dialog.rc-fullshot-dialog[open]"))
}

function findTrigger(target: EventTarget | null): HTMLButtonElement | null {
  return target instanceof Element ? target.closest<HTMLButtonElement>(TRIGGER_SELECTOR) : null
}

function cancelOpenTimer(): void {
  clearTimeout(openTimer)
  openTimer = undefined
  pendingTrigger = null
}

function keepPreview(): void {
  clearTimeout(hideTimer)
  hideTimer = undefined
}

function setTriggerExpanded(trigger: HTMLButtonElement | null, expanded: boolean): void {
  if (!trigger) return
  trigger.setAttribute("aria-expanded", expanded ? "true" : "false")
  trigger.classList.toggle("result-evidence__trigger--active", expanded)
  if (expanded) {
    trigger.setAttribute("aria-describedby", popoverId)
  } else {
    trigger.removeAttribute("aria-describedby")
  }
}

function containerBounds(trigger: HTMLButtonElement): { left: number; right: number } {
  const doc = trigger.closest(".vp-doc")
  if (doc) {
    const rect = doc.getBoundingClientRect()
    const left = Math.max(8, Math.floor(rect.left))
    const right = Math.min(window.innerWidth - 8, Math.ceil(rect.right))
    if (right - left >= 320) return { left, right }
  }
  return { left: 8, right: window.innerWidth - 8 }
}

function positionPreview(): void {
  if (!active.value || !activeTrigger || !preview.value) return
  const box = activeTrigger.getBoundingClientRect()
  const height = preview.value.getBoundingClientRect().height
  const bounds = containerBounds(activeTrigger)
  const width = Math.min(540, bounds.right - bounds.left)
  const left = Math.max(bounds.left, Math.min(box.left, bounds.right - width))
  const below = box.bottom + 8
  const above = box.top - height - 8
  const preferred = below + height <= window.innerHeight - 8 ? below : above
  const top = Math.max(8, Math.min(preferred, window.innerHeight - height - 8))
  previewPosition.value = { ...previewPosition.value, left: `${left}px`, top: `${top}px`, width: `${width}px` }
}

function repositionPreview(): void {
  keepPreview()
  if (!active.value || !activeTrigger) return
  const bounds = containerBounds(activeTrigger)
  const viewportSpace = window.innerHeight - 16
  previewPosition.value = {
    ...previewPosition.value,
    width: `${Math.min(540, bounds.right - bounds.left)}px`,
    maxHeight: `min(88vh, 680px, ${viewportSpace}px)`,
  }
  void nextTick(() => {
    positionPreview()
    attachResizeObserver()
  })
}

function detachResizeObserver(): void {
  resizeObserver?.disconnect()
  resizeObserver = null
}

function attachResizeObserver(): void {
  if (typeof ResizeObserver === "undefined" || !preview.value) return
  if (resizeObserver) return
  resizeObserver = new ResizeObserver(() => {
    positionPreview()
  })
  resizeObserver.observe(preview.value)
}

function onDocKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    if (hasOpenFullShotDialog()) return
    closePreview()
  }
}

function outsidePreview(event: PointerEvent): void {
  if (hasOpenFullShotDialog()) return
  if (
    event.target instanceof Node &&
    (preview.value?.contains(event.target) || activeTrigger?.contains(event.target))
  ) {
    return
  }
  hidePreview()
}

function showForTrigger(trigger: HTMLButtonElement, pin: boolean): void {
  const featureId = trigger.dataset.mcF
  const backendName = trigger.dataset.mcB
  if (!featureId || !backendName || typeof window === "undefined") return
  const resolved = props.resolveCell(featureId, backendName)
  if (!resolved) return

  cancelOpenTimer()
  keepPreview()

  if (activeTrigger && activeTrigger !== trigger) {
    setTriggerExpanded(activeTrigger, false)
  }

  registerActivePopover(hidePreview)
  activeTrigger = trigger
  setTriggerExpanded(trigger, true)
  if (pin) previewPinned.value = true
  active.value = { ...resolved, backendName }

  const bounds = containerBounds(trigger)
  previewPosition.value = { width: `${Math.min(540, bounds.right - bounds.left)}px` }
  document.addEventListener("pointerdown", outsidePreview)
  document.addEventListener("keydown", onDocKeydown)
  document.addEventListener("terminfo:close-previews", hidePreview)
  window.addEventListener("resize", repositionPreview)
  repositionPreview()
}

async function focusForTrigger(trigger: HTMLButtonElement): Promise<void> {
  if (activeTrigger === trigger && previewPinned.value) {
    closePreview()
    return
  }
  showForTrigger(trigger, true)
  await nextTick()
  preview.value?.focus({ preventScroll: true })
}

function scheduleHide(event?: FocusEvent): void {
  cancelOpenTimer()
  if (previewPinned.value || hasOpenFullShotDialog()) return
  const next = event?.relatedTarget
  if (next instanceof Node && (preview.value?.contains(next) || activeTrigger?.contains(next))) return
  keepPreview()
  hideTimer = setTimeout(hidePreview, HOVER_CLOSE_GRACE_MS)
}

function closePreview(): void {
  const triggerToFocus = activeTrigger
  hidePreview()
  if (triggerToFocus) {
    suppressFocusReopen = true
    triggerToFocus.focus({ preventScroll: true })
    suppressFocusReopen = false
  }
}

function hidePreview(): void {
  cancelOpenTimer()
  keepPreview()
  detachResizeObserver()
  if (typeof document !== "undefined") {
    document.removeEventListener("pointerdown", outsidePreview)
    document.removeEventListener("keydown", onDocKeydown)
    document.removeEventListener("terminfo:close-previews", hidePreview)
  }
  if (typeof window !== "undefined") {
    window.removeEventListener("resize", repositionPreview)
  }
  setTriggerExpanded(activeTrigger, false)
  activeTrigger = null
  active.value = null
  previewPinned.value = false
  clearActivePopover(hidePreview)
}

function onPointerOver(event: PointerEvent): void {
  const trigger = findTrigger(event.target)
  if (!trigger) return
  if (event.relatedTarget instanceof Node && trigger.contains(event.relatedTarget)) return
  keepPreview()
  if (activeTrigger === trigger) return
  if (previewPinned.value) return
  if (pendingTrigger === trigger && openTimer !== undefined) return
  cancelOpenTimer()
  pendingTrigger = trigger
  openTimer = setTimeout(() => {
    openTimer = undefined
    pendingTrigger = null
    showForTrigger(trigger, false)
  }, HOVER_OPEN_DELAY_MS)
}

function onPointerOut(event: PointerEvent): void {
  const trigger = findTrigger(event.target)
  if (!trigger) return
  const next = event.relatedTarget
  if (next instanceof Node && (trigger.contains(next) || preview.value?.contains(next))) return
  if (pendingTrigger === trigger) cancelOpenTimer()
  if (activeTrigger === trigger) scheduleHide()
}

function onFocusIn(event: FocusEvent): void {
  if (suppressFocusReopen) return
  const trigger = findTrigger(event.target)
  if (!trigger) return
  if (activeTrigger === trigger) {
    keepPreview()
    return
  }
  showForTrigger(trigger, false)
}

function onFocusOut(event: FocusEvent): void {
  const trigger = findTrigger(event.target)
  if (!trigger || activeTrigger !== trigger) return
  scheduleHide(event)
}

function onClick(event: MouseEvent): void {
  const trigger = findTrigger(event.target)
  if (!trigger) return
  void focusForTrigger(trigger)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && active.value && !hasOpenFullShotDialog()) {
    event.stopPropagation()
    closePreview()
  }
}

onBeforeUnmount(() => {
  hidePreview()
})
</script>

<template>
  <div
    ref="root"
    class="delegated-matrix"
    @pointerover="onPointerOver"
    @pointerout="onPointerOut"
    @focusin="onFocusIn"
    @focusout="onFocusOut"
    @click="onClick"
    @keydown="onKeydown"
  >
    <slot />
    <Teleport to="body">
      <div
        v-if="active"
        ref="preview"
        :id="popoverId"
        class="result-evidence__preview rc-card"
        role="region"
        tabindex="-1"
        aria-label="Result preview"
        :style="previewPosition"
        @pointerenter="keepPreview"
        @pointerleave="scheduleHide()"
        @focusin="keepPreview"
        @focusout="scheduleHide"
        @keydown.esc.stop="closePreview"
        @toggle.capture="repositionPreview"
      >
        <ResultEvidenceCell
          :key="activeKey"
          inline
          closable
          :feature-id="active.featureId"
          :feature-name="active.featureName"
          :probe-guidance="active.probeGuidance"
          :subject-name="active.subjectName"
          :version="active.version"
          :cell="active.cell"
          @close="closePreview"
        />
      </div>
    </Teleport>
  </div>
</template>
