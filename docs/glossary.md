---
outline: [2, 3]
prev: false
next: false
---

<script setup>
import { computed } from 'vue'
import { data as glossary } from './data/glossary.data'

// Sort entries alphabetically by acronym
const sortedEntries = computed(() => {
  return Object.entries(glossary)
    .sort(([a], [b]) => a.localeCompare(b))
})

// Group by first letter
const grouped = computed(() => {
  const groups = new Map()
  for (const [acronym, entry] of sortedEntries.value) {
    const letter = acronym[0].toUpperCase()
    if (!groups.has(letter)) groups.set(letter, [])
    groups.get(letter).push({ acronym, ...entry })
  }
  return groups
})

const letters = computed(() => [...grouped.value.keys()].sort())
</script>

# Glossary

Terminal acronyms and technical terms.

<div class="glossary-nav">
  <a v-for="letter in letters" :key="letter" :href="'#' + letter" class="glossary-letter">{{ letter }}</a>
</div>

<div class="glossary-list">
  <template v-for="letter in letters" :key="letter">
    <h2 :id="letter">{{ letter }}</h2>
    <div v-for="item in grouped.get(letter)" :key="item.acronym" class="glossary-entry">
      <div class="glossary-term">
        <strong>{{ item.acronym }}</strong>
        <span class="glossary-expansion"> &mdash; {{ item.expansion }}</span>
      </div>
      <div class="glossary-description">
        {{ item.description }}
        <a v-if="item.link" :href="item.link" class="glossary-link">&rarr; Learn more</a>
      </div>
    </div>
  </template>
</div>

<style>
.glossary-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 2rem;
  padding: 1rem;
  background: var(--vp-c-bg-soft);
  border-radius: 8px;
}

.glossary-letter {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border-radius: 4px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
  text-decoration: none;
  transition: background 0.2s;
}

.glossary-letter:hover {
  background: var(--vp-c-brand-soft);
}

.glossary-list h2 {
  border-bottom: 1px solid var(--vp-c-divider);
  padding-bottom: 0.5rem;
  margin-top: 2rem;
}

.glossary-entry {
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--vp-c-divider-light);
}

.glossary-entry:last-child {
  border-bottom: none;
}

.glossary-term {
  font-size: 1.05rem;
  margin-bottom: 0.25rem;
}

.glossary-expansion {
  color: var(--vp-c-text-2);
}

.glossary-description {
  color: var(--vp-c-text-2);
  font-size: 0.95rem;
  line-height: 1.5;
}

.glossary-link {
  margin-left: 0.5rem;
  color: var(--vp-c-brand-1);
  text-decoration: none;
  font-size: 0.9rem;
}

.glossary-link:hover {
  text-decoration: underline;
}
</style>
