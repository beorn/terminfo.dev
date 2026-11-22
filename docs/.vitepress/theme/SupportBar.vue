<script setup lang="ts">
// #37761: the one per-terminal bar. The bar alone is the summary; its detail opens in one popover, with a tab per
// category (counts on the tabs), on hover, tap or keyboard focus of a segment, on that segment's tab. Each tab
// starts with the category's one-line meaning (data/result-categories.ts, the one home) and lists the features.
import { computed, onBeforeUnmount, ref } from "vue"
import { RESULT_CATEGORIES, type CategoryId } from "../../data/result-categories.ts"
import ResultList, { type ResultItem } from "./ResultList.vue"

const props = defineProps<{
  /** Whose bar: the terminal's name as its row shows it. */
  label: string
  /** Feature ids per category, from the bar's own fold (categoryIds / categoryIdsWithin). */
  ids: Readonly<Record<CategoryId, readonly string[]>>
  /** One feature id as a list row (name, link to its result, short note). */
  describe: (featureId: string, category: CategoryId) => ResultItem
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
const open = ref(false)
const pinned = ref(false)
const engaged = ref(false)
/** Pixels the popover moves left of the bar's start so it stays 16px inside the page. */
const shift = ref(0)
const tab = ref<CategoryId>("supported")
const current = computed(() => RESULT_CATEGORIES.find((category) => category.id === tab.value) ?? RESULT_CATEGORIES[0]!)
const items = computed(() =>
  open.value
    ? props.ids[tab.value]
        .map((featureId) => props.describe(featureId, tab.value))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [],
)
let hideTimer: ReturnType<typeof setTimeout> | undefined

function place() {
  const box = root.value?.getBoundingClientRect()
  if (!box) return
  // The layout width, not innerWidth: on a phone innerWidth grows to take in whatever overflows, the popover too.
  const page = document.documentElement.clientWidth
  const popWidth = Math.min(440, page - 32)
  shift.value = Math.max(16 - box.left, Math.min(0, page - 16 - (box.left + popWidth)))
}
function onOutside(event: PointerEvent) {
  if (root.value && !root.value.contains(event.target as Node)) close()
}
function show(id: CategoryId, from: "hover" | "focus" | "tap") {
  clearTimeout(hideTimer)
  if (from === "hover" && open.value && engaged.value) return
  tab.value = id
  if (from === "tap") pinned.value = true
  if (open.value) return
  place()
  open.value = true
  document.addEventListener("pointerdown", onOutside, true)
}
function close() {
  clearTimeout(hideTimer)
  open.value = false
  pinned.value = false
  engaged.value = false
  document.removeEventListener("pointerdown", onOutside, true)
}
function stay() {
  clearTimeout(hideTimer)
}
function leave() {
  if (pinned.value) return
  hideTimer = setTimeout(close, 250)
}
function onFocusOut(event: FocusEvent) {
  const next = event.relatedTarget as Node | null
  if (next && root.value && !root.value.contains(next)) close()
}
function onEscape() {
  if (!open.value) return
  const back = root.value?.querySelector<HTMLElement>(`.support-bar-seg[data-category="${tab.value}"]`)
  close()
  back?.focus()
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
    <div class="support-bar-track">
      <button
        v-for="segment in segments"
        :key="segment.id"
        type="button"
        class="support-bar-seg"
        :class="'bar-' + segment.style"
        :data-category="segment.id"
        :style="{ width: width(segment.count), ...(fill && segment.id === 'supported' ? { background: fill } : {}) }"
        :aria-label="`${label}: ${segment.label} ${segment.count}`"
        :aria-expanded="open && tab === segment.id"
        @mouseenter="show(segment.id, 'hover')"
        @focus="show(segment.id, 'focus')"
        @click="show(segment.id, 'tap')"
      />
    </div>
    <div
      v-if="open"
      class="support-pop"
      :style="{ left: `${shift}px` }"
      role="dialog"
      :aria-label="label"
      @mouseenter="engaged = true"
    >
      <div class="support-pop-head">
        <strong class="support-pop-name">{{ label }}</strong>
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
          @click="tab = category.id"
        >
          {{ category.label }} <span class="support-pop-n">{{ category.count }}</span>
        </button>
      </div>
      <div class="support-pop-panel" role="tabpanel">
        <p class="support-pop-meaning">{{ current.meaning }}</p>
        <ResultList v-if="items.length" :items="items" :mark="current.mark" :tone="current.style" />
      </div>
      <a v-if="href" class="support-pop-all" :href="href">All results for {{ label }} →</a>
    </div>
  </div>
</template>
