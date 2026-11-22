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
    <li v-for="item in items" :key="item.id">
      <a
        v-if="item.href"
        class="result-row"
        :href="item.href"
        :title="item.note ? item.name + ': ' + item.note : undefined"
      >
        <span class="result-mark" aria-hidden="true">{{ item.mark ?? mark }}</span>
        <span class="result-name">{{ item.name }}</span>
        <span v-if="item.note" class="result-note">{{ item.note }}</span>
      </a>
      <span v-else class="result-row" :title="item.note ? item.name + ': ' + item.note : undefined">
        <span class="result-mark" aria-hidden="true">{{ item.mark ?? mark }}</span>
        <span class="result-name">{{ item.name }}</span>
        <span v-if="item.note" class="result-note">{{ item.note }}</span>
      </span>
    </li>
  </ul>
</template>
