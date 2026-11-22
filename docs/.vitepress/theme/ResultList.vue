<script setup lang="ts">
// #37761: the one list of features or results. The mark is the row's only bullet, the name is ordinary text
// (no link blue, no underline), and the whole row is one link with a hover and focus background.
export interface ResultItem {
  readonly id: string
  readonly name: string
  readonly href?: string
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
}>()
</script>

<template>
  <ul class="result-list" :class="tone ? 'result-list-' + tone : undefined">
    <li
      v-for="item in items"
      :key="item.id"
      :class="[item.tone && 'result-tone-' + item.tone, $slots.after && 'result-with-after']"
    >
      <component
        :is="item.href ? 'a' : 'span'"
        class="result-row"
        :href="item.href"
        :title="item.note ? item.name + ': ' + item.note : undefined"
      >
        <span class="result-mark" aria-hidden="true">{{ item.mark ?? mark }}</span>
        <span class="result-name">{{ item.name }}</span>
        <span v-if="item.icon" class="result-icon" :title="item.iconTitle" v-html="item.icon" />
        <span v-if="item.note" class="result-note">{{ item.note }}</span>
      </component>
      <span v-if="$slots.after" class="result-after"><slot name="after" :item="item" /></span>
    </li>
  </ul>
</template>
