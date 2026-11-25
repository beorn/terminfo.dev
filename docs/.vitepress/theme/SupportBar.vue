<script lang="ts">
// Suppress synthetic mouseenter on a bar underneath a just-dismissed popover (Esc or × close button).
let dismissedUntil = 0
</script>

<script setup lang="ts">
// #37761 + #37631: the one per-terminal bar and popover everywhere.
// Segment-anchored popover with zero pointer gap, Esc close from anywhere, visible close button for touch,
// cascading right-side result pane (inline below the item on <600px viewports) reusing ResultEvidenceCell,
// and click-to-scroll when the feature's row is present on the current page.
import { computed, onBeforeUnmount, ref } from "vue"
import { RESULT_CATEGORIES, type CategoryId } from "../../data/result-categories.ts"
import type { PublicContextSummary, PublicRunMetadata } from "../../data/public-results.ts"
import { publicResultFor } from "../../data/release-scope.ts"
import { data } from "../../data/probes.data"
import {
  clearActivePopover,
  detailPaneSide,
  featureAnchorId,
  HOVER_CLOSE_GRACE_MS,
  HOVER_OPEN_DELAY_MS,
  registerActivePopover,
  segmentPopoverShift,
  type DetailPaneSide,
} from "./bar-layout.ts"
import ResultEvidenceCell from "./ResultEvidenceCell.vue"
import ResultList, { type ResultItem } from "./ResultList.vue"

const props = defineProps<{
  /** Whose bar: the terminal's name as its row shows it. */
  label: string
  /** Feature ids per category, from the bar's own fold (categoryIds / categoryIdsWithin). */
  ids: Readonly<Record<CategoryId, readonly string[]>>
  /** One feature id as a list row (name, link to its result, short note). */
  describe: (featureId: string, category: CategoryId) => ResultItem
  /** Selected run or composed context for this terminal, powering the cascading result pane (#37631). */
  version?: PublicRunMetadata | PublicContextSummary
  /** "S supported · T of N tested": read by screen readers and the popover's first line. */
  readout?: string
  /** A one-colour bar (Baseline cards): Supported is drawn in this colour, the rest left blank. */
  fill?: string
  /** The terminal's page, linked at the foot of the popover. */
  href?: string
}>()

const total = computed(() => RESULT_CATEGORIES.reduce((sum, category) => sum + props.ids[category.id].length, 0))
const segments = computed(() =>
  RESULT_CATEGORIES.map((category) => ({ ...category, count: props.ids[category.id].length })).filter(
    (segment) => segment.count > 0,
  ),
)
const tabs = computed(() =>
  RESULT_CATEGORIES.filter((category) => !category.optional || props.ids[category.id].length > 0).map((category) => ({
    ...category,
    count: props.ids[category.id].length,
  })),
)
const width = (count: number) => (total.value ? `${(count / total.value) * 100}%` : "0%")

const root = ref<HTMLElement | null>(null)
const pop = ref<HTMLElement | null>(null)
const open = ref(false)
const pinned = ref(false)
const engaged = ref(false)
/** Pixels from the bar's start to the popover's left edge (anchored to the active segment, clamped to the page). */
const shift = ref(0)
/** Fixed viewport coordinates for the teleported popover so it always stacks above sticky table headers (#38269). */
const popCoords = ref<{ left: number; top: number; flipped: boolean }>({ left: 16, top: 0, flipped: false })
const tab = ref<CategoryId>("supported")
const activeFeatureId = ref<string | null>(null)
const paneSide = ref<DetailPaneSide>("right")
const detailTop = ref(0)
const detailNotchTop = ref(24)
const current = computed(() => RESULT_CATEGORIES.find((category) => category.id === tab.value) ?? RESULT_CATEGORIES[0]!)
const items = computed(() =>
  open.value
    ? props.ids[tab.value]
        .map((featureId) => {
          const item = props.describe(featureId, tab.value)
          const anchor = featureAnchorId(item.id)
          const onPage = typeof document !== "undefined" && Boolean(document.getElementById(anchor))
          return onPage ? { ...item, href: `#${anchor}` } : item
        })
        .sort((a, b) => a.name.localeCompare(b.name))
    : [],
)
const activeItem = computed(() =>
  activeFeatureId.value ? items.value.find((item) => item.id === activeFeatureId.value) : undefined,
)
const activeCell = computed(() =>
  props.version && activeItem.value ? publicResultFor(props.version, activeItem.value.id) : undefined,
)
let openTimer: ReturnType<typeof setTimeout> | undefined
let hideTimer: ReturnType<typeof setTimeout> | undefined
let suppressFocusReopen = false
let lastAnchor: HTMLElement | null = null

function place(anchor?: HTMLElement | null) {
  const box = root.value?.getBoundingClientRect()
  if (!box) return
  if (anchor !== undefined) lastAnchor = anchor
  const page = document.documentElement.clientWidth
  const viewH = window.innerHeight
  const popWidth = Math.min(440, page - 32)
  const segLeft = lastAnchor ? lastAnchor.getBoundingClientRect().left : box.left
  shift.value = segmentPopoverShift({
    barLeft: box.left,
    segmentLeft: segLeft,
    popWidth,
    pageWidth: page,
  })
  const left = Math.max(16, Math.min(Math.round(box.left + shift.value), Math.max(16, page - popWidth - 16)))
  const popHeight = pop.value?.getBoundingClientRect().height || Math.min(Math.round(viewH * 0.6), 420)
  const belowTop = Math.round(box.bottom + 6)
  const roomBelow = viewH - belowTop - 12
  const roomAbove = box.top - 18
  const flipped = roomBelow < Math.min(popHeight, 260) && roomAbove > roomBelow
  const top = flipped
    ? Math.max(12, Math.round(box.top - 6 - Math.min(popHeight, roomAbove)))
    : Math.max(12, Math.min(belowTop, Math.max(12, viewH - 120)))
  popCoords.value = { left, top, flipped }
}

function onViewportChange() {
  if (!open.value) return
  const box = root.value?.getBoundingClientRect()
  if (!box || box.bottom < 0 || box.top > window.innerHeight) {
    close(false)
    return
  }
  place()
}

function updateDetailPlacement(rowEl?: HTMLElement | null) {
  const page = document.documentElement.clientWidth
  const box = pop.value?.getBoundingClientRect()
  const popLeft = box?.left ?? popCoords.value.left
  const popWidth = box?.width ?? Math.min(440, page - 32)
  paneSide.value = detailPaneSide({
    popLeft,
    popWidth,
    detailWidth: 420,
    pageWidth: page,
  })
  if (box && rowEl) {
    const rowBox = rowEl.getBoundingClientRect()
    const rowCenter = rowBox.top - box.top + rowBox.height / 2
    // Align the child pane's top near the hovered row while keeping it within the popover's vertical span.
    const desiredTop = Math.max(0, Math.min(rowBox.top - box.top - 10, Math.max(0, box.height - 160)))
    detailTop.value = Math.round(desiredTop)
    detailNotchTop.value = Math.round(Math.max(16, Math.min(rowCenter - desiredTop, 240)))
  } else {
    detailTop.value = 0
    detailNotchTop.value = 24
  }
}

function onOutside(event: PointerEvent) {
  const target = event.target as Node | null
  if (!target) return
  if (root.value?.contains(target) || pop.value?.contains(target)) return
  close()
}

function onDocKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") onEscape()
}

function show(id: CategoryId, from: "hover" | "focus" | "tap", anchor?: HTMLElement | null) {
  if (from === "hover" && typeof performance !== "undefined" && performance.now() < dismissedUntil) return
  if (from === "focus" && suppressFocusReopen) return
  clearTimeout(hideTimer)
  if (from === "hover" && open.value && engaged.value) return
  if (from === "hover" && !open.value) {
    clearTimeout(openTimer)
    openTimer = setTimeout(() => {
      openTimer = undefined
      openPopover(id, false, anchor)
    }, HOVER_OPEN_DELAY_MS)
    return
  }
  clearTimeout(openTimer)
  openPopover(id, from === "tap", anchor)
}

function openPopover(id: CategoryId, pin: boolean, anchor?: HTMLElement | null) {
  if (tab.value !== id) activeFeatureId.value = null
  tab.value = id
  if (pin) pinned.value = true
  const seg = anchor ?? root.value?.querySelector<HTMLElement>(`.support-bar-seg[data-category="${id}"]`)
  place(seg)
  if (open.value) return
  registerActivePopover(closeFromCoordinator)
  open.value = true
  document.dispatchEvent(new CustomEvent("terminfo:close-previews"))
  document.addEventListener("pointerdown", onOutside, true)
  document.addEventListener("keydown", onDocKeydown, true)
  window.addEventListener("scroll", onViewportChange, { passive: true, capture: true })
  window.addEventListener("resize", onViewportChange, { passive: true })
}

function closeFromCoordinator() {
  close(false)
}

function close(explicitDismiss = false) {
  clearTimeout(openTimer)
  clearTimeout(hideTimer)
  if (explicitDismiss && typeof performance !== "undefined") {
    dismissedUntil = performance.now() + 350
  }
  open.value = false
  pinned.value = false
  engaged.value = false
  activeFeatureId.value = null
  lastAnchor = null
  document.removeEventListener("pointerdown", onOutside, true)
  document.removeEventListener("keydown", onDocKeydown, true)
  window.removeEventListener("scroll", onViewportChange, true)
  window.removeEventListener("resize", onViewportChange)
  clearActivePopover(closeFromCoordinator)
}

function stay() {
  clearTimeout(hideTimer)
}

function onPopEnter() {
  stay()
  engaged.value = true
}

function leave() {
  clearTimeout(openTimer)
  if (pinned.value) return
  hideTimer = setTimeout(close, HOVER_CLOSE_GRACE_MS)
}

function onFocusOut(event: FocusEvent) {
  const next = event.relatedTarget as Node | null
  if (next && (root.value?.contains(next) || pop.value?.contains(next))) return
  if (next) close()
}

function onEscape() {
  if (!open.value) return
  const hadFocusInside = Boolean(
    root.value?.contains(document.activeElement) || pop.value?.contains(document.activeElement),
  )
  const back = root.value?.querySelector<HTMLElement>(`.support-bar-seg[data-category="${tab.value}"]`)
  close(true)
  if (hadFocusInside && back) {
    suppressFocusReopen = true
    back.focus()
    setTimeout(() => {
      suppressFocusReopen = false
    }, 0)
  }
}

function onSwitchTab(categoryId: CategoryId) {
  tab.value = categoryId
  activeFeatureId.value = null
}

function onHoverItem(item: ResultItem, rowEl: HTMLElement | null) {
  if (!props.version) return
  activeFeatureId.value = item.id
  updateDetailPlacement(rowEl)
}

function onSelectItem(item: ResultItem, event: MouseEvent) {
  const anchor = featureAnchorId(item.id)
  const target = document.getElementById(anchor)
  if (!target) return
  event.preventDefault()
  close()
  target.scrollIntoView({ behavior: "smooth", block: "center" })
  if (typeof history !== "undefined" && history.replaceState) {
    history.replaceState(null, "", `#${anchor}`)
  }
  target.classList.remove("row-scroll-target")
  void target.offsetWidth
  target.classList.add("row-scroll-target")
  setTimeout(() => target.classList.remove("row-scroll-target"), 2000)
}

onBeforeUnmount(close)
</script>

<template>
  <div
    ref="root"
    class="support-bar"
    :class="{ 'support-bar-fill': fill, 'support-bar-open': open }"
    @mouseenter="stay"
    @mouseleave="leave"
    @focusout="onFocusOut"
    @keydown.esc="onEscape"
  >
    <span v-if="readout" class="sr-only">{{ label }}: {{ readout }}</span>
    <button
      type="button"
      class="support-bar-trigger"
      :aria-label="readout ? `${label}: ${readout}` : `${label}: view support breakdown`"
      :aria-expanded="open"
      @focus="show(segments[0]?.id ?? 'supported', 'focus', $event.currentTarget as HTMLElement)"
      @click="show(segments[0]?.id ?? 'supported', 'tap', $event.currentTarget as HTMLElement)"
    >
      <span class="support-bar-track">
        <span
          v-for="segment in segments"
          :key="segment.id"
          class="support-bar-seg"
          :class="'bar-' + segment.style"
          :data-category="segment.id"
          :style="{ width: width(segment.count), ...(fill && segment.id === 'supported' ? { background: fill } : {}) }"
          :title="`${segment.label}: ${segment.count}`"
          @mouseenter="show(segment.id, 'hover', $event.currentTarget as HTMLElement)"
          @click.stop="show(segment.id, 'tap', $event.currentTarget as HTMLElement)"
        />
      </span>
    </button>
    <Teleport to="body">
      <div
        v-if="open"
        ref="pop"
        class="support-pop"
        :class="{ 'support-pop--flipped': popCoords.flipped }"
        :style="{ left: `${popCoords.left}px`, top: `${popCoords.top}px` }"
        role="dialog"
        :aria-label="label"
        @mouseenter="onPopEnter"
        @mouseleave="leave"
        @focusout="onFocusOut"
        @keydown.esc="onEscape"
      >
        <div class="support-pop-head">
          <strong class="support-pop-name">{{ label }}</strong>
          <button type="button" class="support-pop-close" aria-label="Close" @click="close(true)">×</button>
        </div>
        <div class="support-pop-tabs" role="tablist">
          <button
            v-for="category in tabs"
            :key="category.id"
            type="button"
            role="tab"
            class="support-pop-tab"
            :class="'support-pop-tab-' + category.style"
            :aria-selected="tab === category.id"
            @click="onSwitchTab(category.id)"
          >
            {{ category.label }} <span class="support-pop-n">{{ category.count }}</span>
          </button>
        </div>
        <div class="support-pop-panel" role="tabpanel">
          <p class="support-pop-meaning">{{ current.meaning }}</p>
          <ResultList
            v-if="items.length"
            :items="items"
            :mark="current.mark"
            :tone="current.style"
            :active-id="activeFeatureId"
            technical-notes
            @hover-item="onHoverItem"
            @select-item="onSelectItem"
          >
            <template v-if="version && paneSide === 'below'" #detail="{ item }">
              <div class="support-pop-detail-inline">
                <ResultEvidenceCell
                  inline
                  :feature-id="item.id"
                  :feature-name="item.name"
                  :probe-guidance="data.featureDescriptions[item.id]?.probe"
                  :subject-name="label"
                  :version="version"
                  :cell="publicResultFor(version, item.id)"
                />
              </div>
            </template>
          </ResultList>
        </div>
        <a v-if="href" class="support-pop-all" :href="href">All results for {{ label }} →</a>

        <div
          v-if="version && activeItem && paneSide !== 'below'"
          class="support-pop-detail"
          :class="'support-pop-detail--' + paneSide"
          :style="{ top: `${detailTop}px`, '--detail-notch-top': `${detailNotchTop}px` }"
          @mouseenter="stay"
        >
          <ResultEvidenceCell
            inline
            :feature-id="activeItem.id"
            :feature-name="activeItem.name"
            :probe-guidance="data.featureDescriptions[activeItem.id]?.probe"
            :subject-name="label"
            :version="version"
            :cell="activeCell"
          />
        </div>
      </div>
    </Teleport>
  </div>
</template>
