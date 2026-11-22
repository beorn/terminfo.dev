<script setup lang="ts">
// #37761: the one filter for a few options: a pill per option with its count, the selected one highlighted.
// An option nothing is listed under is left out rather than shown as "0" (unless it is the one selected).
import { computed } from "vue"

export interface PillOption {
  readonly id: string
  readonly label: string
  readonly count: number
}

const props = defineProps<{ options: readonly PillOption[]; modelValue: string; label: string }>()
const emit = defineEmits<{ "update:modelValue": [value: string] }>()
const shown = computed(() => props.options.filter((option) => option.count > 0 || option.id === props.modelValue))
</script>

<template>
  <div class="count-pills" role="group" :aria-label="label">
    <button
      v-for="option in shown"
      :key="option.id"
      type="button"
      class="count-pill"
      :class="{ 'count-pill-on': option.id === modelValue }"
      :aria-pressed="option.id === modelValue"
      @click="emit('update:modelValue', option.id)"
    >
      {{ option.label }} <span class="count-pill-n">{{ option.count }}</span>
    </button>
  </div>
</template>
