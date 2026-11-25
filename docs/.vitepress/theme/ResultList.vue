<script setup lang="ts">
// #37761: the one list of features or results. The mark is the row's only bullet, the name is ordinary text
// (no link blue, no underline), and the whole row is one link with a hover and focus background.
export interface ResultItem {
  readonly id: string
  readonly name: string
  readonly href?: string
  /** Stable DOM anchor id on the row's <li> (#37631). */
  readonly anchor?: string
  /** One short line after the name (an Untestable reason, say); the full text stays on hover. */
  readonly note?: string
  readonly mark?: string
  /** Colours this row's mark (yes, fail, differs, partial or none) in a list that mixes categories. */
  readonly tone?: string
  /** A platform icon's markup (platformIcon) beside the name, so two platforms of one app read apart. */
  readonly icon?: string
  /** The platform in words, the icon's hover. */
  readonly iconTitle?: string
}

defineProps<{
  items: readonly ResultItem[]
  /** The marker for rows that carry none of their own. */
  mark?: string
  /** Colours the marker: yes, fail, differs, partial or none. */
  tone?: string
  /** Recorded reasons may contain provenance; disclose those outside the navigation link. */
  technicalNotes?: boolean
  /** Currently active item id (for hover-card detail highlight and narrow-screen inline pane). */
  activeId?: string | null
}>()

const emit = defineEmits<{
  "hover-item": [item: ResultItem, rowEl: HTMLElement | null]
  "select-item": [item: ResultItem, event: MouseEvent]
}>()
</script>

<template>
  <ul class="result-list" :class="tone ? 'result-list-' + tone : undefined">
    <template v-for="item in items" :key="item.id">
      <li
        :id="item.anchor"
        :class="[
          item.tone && 'result-tone-' + item.tone,
          $slots.after && 'result-with-after',
          activeId === item.id && 'result-item-active',
        ]"
        @mouseenter="emit('hover-item', item, $event.currentTarget as HTMLElement)"
        @focusin="emit('hover-item', item, $event.currentTarget as HTMLElement)"
      >
        <component
          :is="item.href ? 'a' : 'span'"
          class="result-row"
          :href="item.href"
          :title="item.note && !technicalNotes ? item.name + ': ' + item.note : undefined"
          @click="emit('select-item', item, $event)"
        >
          <span class="result-mark" aria-hidden="true">{{ item.mark ?? mark }}</span>
          <span class="result-name">{{ item.name }}</span>
          <span v-if="item.icon" class="result-icon" :title="item.iconTitle" v-html="item.icon" />
          <span v-if="item.note && !technicalNotes" class="result-note">{{ item.note }}</span>
        </component>
        <span v-if="$slots.after" class="result-after"><slot name="after" :item="item" /></span>
        <details v-if="item.note && technicalNotes" class="result-note-details">
          <summary>Technical details</summary>
          <p>{{ item.note }}</p>
        </details>
      </li>
      <li v-if="activeId === item.id && $slots.detail" :key="item.id + '-detail'" class="result-detail-row">
        <slot name="detail" :item="item" />
      </li>
    </template>
  </ul>
</template>
