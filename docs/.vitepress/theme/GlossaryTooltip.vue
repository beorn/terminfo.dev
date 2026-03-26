<template>
  <a
    v-if="link"
    :href="link"
    class="glossary-term glossary-term-linked"
    @mouseenter="showTooltip = true"
    @mouseleave="showTooltip = false"
  >
    <slot></slot>
    <transition name="fade">
      <div v-if="showTooltip" class="glossary-tooltip" role="tooltip">
        {{ tooltipText }}
      </div>
    </transition>
  </a>
  <span v-else class="glossary-term" @mouseenter="showTooltip = true" @mouseleave="showTooltip = false" tabindex="0">
    <slot></slot>
    <transition name="fade">
      <div v-if="showTooltip" class="glossary-tooltip" role="tooltip">
        {{ tooltipText }}
      </div>
    </transition>
  </span>
</template>

<script setup>
import { ref, computed } from "vue"

const props = defineProps({
  description: {
    type: String,
    required: true,
  },
})

const showTooltip = ref(false)

// Parse "description||/link" format
const decoded = computed(() => {
  try {
    return decodeURIComponent(props.description)
  } catch {
    return props.description
  }
})

const link = computed(() => {
  const parts = decoded.value.split("||")
  return parts.length > 1 ? parts[1] : ""
})

const tooltipText = computed(() => {
  return decoded.value.split("||")[0]
})
</script>

<style scoped>
.glossary-tooltip {
  position: absolute;
  background-color: var(--vp-c-bg-alt);
  color: var(--vp-c-text-1);
  border: 1px solid var(--vp-c-divider);
  padding: 8px 12px;
  border-radius: 6px;
  z-index: 1000;
  white-space: normal;
  word-wrap: break-word;
  max-width: 300px;
  width: max-content;
  box-shadow: var(--vp-shadow-3);
  top: auto;
  bottom: calc(100% + 10px);
  left: 50%;
  line-height: 1.4;
  transform: translateX(-50%);
  font-size: 13px;
  text-align: left;
  pointer-events: none;
}

.glossary-tooltip::after {
  content: "";
  position: absolute;
  top: 100%;
  left: 50%;
  margin-left: -6px;
  border-width: 6px;
  border-style: solid;
  border-color: var(--vp-c-divider) transparent transparent transparent;
}

.fade-enter-active,
.fade-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(5px);
}

@media (max-width: 768px) {
  .glossary-tooltip {
    max-width: 90vw;
    left: 50%;
    transform: translateX(-50%);
  }
}
</style>
