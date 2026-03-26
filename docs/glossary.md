---
outline: [2, 3]
prev: false
next: false
---

<script setup>
import { computed, ref } from 'vue'
import { data as glossary } from './data/glossary.data'

const search = ref('')

// Sort entries alphabetically by acronym
const sortedEntries = computed(() => {
  return Object.entries(glossary)
    .sort(([a], [b]) => a.localeCompare(b))
})

// Filter by search query (matches acronym, expansion, or description)
const filteredEntries = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return sortedEntries.value
  return sortedEntries.value.filter(([acronym, entry]) =>
    acronym.toLowerCase().includes(q) ||
    entry.expansion.toLowerCase().includes(q) ||
    entry.description.toLowerCase().includes(q)
  )
})

// Group by first letter
const grouped = computed(() => {
  const groups = new Map()
  for (const [acronym, entry] of filteredEntries.value) {
    const letter = acronym[0].toUpperCase()
    if (!groups.has(letter)) groups.set(letter, [])
    groups.get(letter).push({ acronym, ...entry })
  }
  return groups
})

const letters = computed(() => [...grouped.value.keys()].sort())

const resultCount = computed(() => filteredEntries.value.length)
const totalCount = computed(() => sortedEntries.value.length)
</script>

# Glossary

Terminal acronyms and technical terms.

<div class="glossary-search">
  <input
    v-model="search"
    type="text"
    placeholder="Filter glossary..."
    class="glossary-search-input"
    aria-label="Filter glossary terms"
  />
  <span v-if="search.trim()" class="glossary-search-count">
    {{ resultCount }} of {{ totalCount }} terms
  </span>
</div>

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

<div v-if="search.trim() && resultCount === 0" class="glossary-no-results">
  No matching terms found.
</div>

<style>
.glossary-search {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.glossary-search-input {
  flex: 1;
  padding: 0.5rem 0.75rem;
  font-size: 0.95rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  outline: none;
  transition: border-color 0.2s;
}

.glossary-search-input::placeholder {
  color: var(--vp-c-text-3);
}

.glossary-search-input:focus {
  border-color: var(--vp-c-brand-1);
}

.glossary-search-count {
  font-size: 0.85rem;
  color: var(--vp-c-text-3);
  white-space: nowrap;
}

.glossary-no-results {
  padding: 2rem;
  text-align: center;
  color: var(--vp-c-text-3);
  font-size: 0.95rem;
}

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
