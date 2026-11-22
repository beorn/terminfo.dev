<script setup lang="ts">
// #37761: the one row for every per-terminal bar list (home lists, Baseline cards): a one-line name beside its
// platform icon, the bar, and for a card one percent. The platform is the icon, never words beside it; "(term)" is
// never printed. Hovering or focusing the name opens a small card: name, platform, one line, website.
import { computed } from "vue"
import type { CategoryId } from "../../data/result-categories.ts"
import { platformIcon } from "./platform-icons.ts"
import SupportBar from "./SupportBar.vue"
import type { ResultItem } from "./ResultList.vue"

const props = defineProps<{
  name: string
  href: string
  os?: string | null
  /** The platform in words, for the name card and screen readers. */
  platform?: string
  description?: string
  website?: string
  version?: string
  /** Undefined when the terminal has no current run: the row links to its history instead of drawing a bar. */
  ids?: Readonly<Record<CategoryId, readonly string[]>>
  describe: (featureId: string, category: CategoryId) => ResultItem
  readout?: string
  fill?: string
  /** A Baseline card row prints one percent after the bar. */
  percent?: string
  card?: boolean
}>()

const icon = computed(() => platformIcon(props.os))
const host = computed(() => {
  if (!props.website) return undefined
  try {
    return new URL(props.website).host.replace(/^www\./u, "")
  } catch {
    return props.website
  }
})
const firstLine = computed(() => props.description?.split(/(?<=[.!?])\s/u)[0])
</script>

<template>
  <div class="term-row" :class="{ 'term-row-card': card, 'term-row-historical': !ids }">
    <span class="term-name">
      <a class="term-name-link" :href="href">{{ name }}</a>
      <span v-if="icon" class="term-platform" :title="platform" v-html="icon" />
      <span v-if="!card" class="term-about" role="tooltip">
        <strong>{{ name }}</strong
        ><template v-if="platform"> · {{ platform }}</template>
        <span v-if="firstLine" class="term-about-line">{{ firstLine }}</span>
        <a v-if="website" class="term-about-site" :href="website" rel="noopener">{{ host }}</a>
      </span>
    </span>
    <span v-if="version && !card" class="term-version" :title="version">{{ version }}</span>
    <SupportBar
      v-if="ids"
      :label="platform ? `${name} (${platform})` : name"
      :ids="ids"
      :describe="describe"
      :readout="readout"
      :fill="fill"
      :href="card ? undefined : href"
    />
    <a v-else class="term-history" :href="href">Historical results →</a>
    <span v-if="card" class="term-percent">{{ ids ? percent : "" }}</span>
  </div>
</template>
