<script setup lang="ts">
// #37761 + #38757: a terminal's platform as every list, panel and result card shows it — the greyscale icon, with
// the platform in words as its hover and screen-reader name. One element, so the home list, the terminal page's
// Feature support panel and the result card header cannot drift apart. An unknown platform draws the default slot.
import { computed } from "vue"
import { platformIcon } from "./platform-icons.ts"

const props = defineProps<{
  os?: string | null
  /** The platform in words: the icon's hover and accessible name. */
  platform?: string
}>()

const icon = computed(() => platformIcon(props.os))
</script>

<template>
  <span v-if="icon" class="term-platform" :title="platform" role="img" :aria-label="platform" v-html="icon" />
  <slot v-else />
</template>
