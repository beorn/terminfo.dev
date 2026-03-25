import { defineConfig } from "vitepress"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { generateApi } from "../../scripts/generate-api"

const __dirname = dirname(fileURLToPath(import.meta.url))
const docsDir = join(__dirname, "..")

// --- Load data for sidebar generation ---

function loadBackendMeta() {
  // Read backends.json — VitePress config can't import @termless/core
  // (it runs in Vite's ESM bundler context, not Bun)
  const candidates = [
    join(docsDir, "..", "node_modules", "@termless", "core", "backends.json"), // npm installed
    join(docsDir, "..", "..", "termless", "backends.json"), // sibling submodule (local dev)
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, "utf-8")).backends
    }
  }
  throw new Error(`backends.json not found. Tried:\n${candidates.join("\n")}`)
}

function terminalSlug(name: string, meta: Record<string, any>): string {
  const label = (meta[name]?.label ?? name).toLowerCase()
  return label.replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "")
}

function buildSidebar() {
  // Load backends from probe results
  const probesLibsDir = join(docsDir, "..", "content", "probes-libs")
  const meta = loadBackendMeta()
  const terminals: Array<{ text: string; link: string }> = []

  // Build set of headless backends that are subsumed by app terminals
  // (e.g. xtermjs -> VS Code) — these don't get their own page
  const terminalsData = JSON.parse(
    readFileSync(join(docsDir, "..", "content", "terminals.json"), "utf-8"),
  ) as Record<string, { headlessBackends?: string[] }>
  const appSubsumedBackends = new Set<string>()
  for (const entry of Object.values(terminalsData)) {
    for (const hb of entry.headlessBackends ?? []) {
      appSubsumedBackends.add(hb)
    }
  }

  try {
    const files = readdirSync(probesLibsDir).filter((f) => f.endsWith(".json") && f !== "census.json")
    for (const file of files) {
      try {
        const raw = JSON.parse(readFileSync(join(probesLibsDir, file), "utf-8"))
        if (!raw.backend) continue
        // Skip backends that are merged into an app terminal page
        if (appSubsumedBackends.has(raw.backend)) continue
        const label = meta[raw.backend]?.label ?? raw.backend
        const slug = terminalSlug(raw.backend, meta)
        terminals.push({ text: label, link: `/terminal/${slug}` })
      } catch {}
    }
  } catch {}
  terminals.sort((a, b) => a.text.localeCompare(b.text))

  // Load features.json for tags
  const featuresPath = join(docsDir, "..", "content", "features.json")
  const tags = new Set<string>()
  try {
    const raw = JSON.parse(readFileSync(featuresPath, "utf-8"))
    delete raw.$comment
    for (const entry of Object.values(raw) as any[]) {
      for (const tag of entry.tags ?? []) {
        tags.add(tag)
      }
    }
  } catch {}

  // Load tag labels from content/standards.json
  const standardsData = JSON.parse(readFileSync(join(docsDir, "..", "content", "standards.json"), "utf-8")) as Record<
    string,
    { label: string }
  >
  const tagLabels: Record<string, string> = Object.fromEntries(
    Object.entries(standardsData).map(([k, v]) => [k, v.label]),
  )

  const tagOrder = [
    "ecma-48",
    "vt100",
    "vt220",
    "vt510",
    "dec-private-modes",
    "xterm-extensions",
    "kitty-extensions",
    "osc",
    "sixel",
    "unicode",
  ]
  const sortedTags = [...tags].sort((a, b) => {
    const ai = tagOrder.indexOf(a)
    const bi = tagOrder.indexOf(b)
    if (ai >= 0 && bi >= 0) return ai - bi
    if (ai >= 0) return -1
    if (bi >= 0) return 1
    return a.localeCompare(b)
  })

  // Load category labels from content/categories.json
  const categoriesData = JSON.parse(readFileSync(join(docsDir, "..", "content", "categories.json"), "utf-8")) as Record<
    string,
    { label: string; order: number }
  >
  const categoryLabels: Record<string, string> = Object.fromEntries(
    Object.entries(categoriesData).map(([k, v]) => [k, v.label]),
  )

  const categoryOrder = [
    "sgr",
    "cursor",
    "text",
    "erase",
    "editing",
    "modes",
    "scrollback",
    "reset",
    "extensions",
    "charsets",
    "device",
  ]

  // Determine categories and features from features.json
  const categories = new Map<string, Array<{ id: string; name: string; slug: string }>>()
  try {
    const raw = JSON.parse(readFileSync(featuresPath, "utf-8"))
    delete raw.$comment
    for (const [id, entry] of Object.entries(raw) as [string, any][]) {
      const cat = id.split(".")[0]
      if (!categories.has(cat)) categories.set(cat, [])
      const slug = entry.slug ?? id.replaceAll(".", "-")
      categories.get(cat)!.push({ id, name: entry.name, slug })
    }
  } catch {}

  const sortedCategories = [...categories.keys()].sort((a, b) => {
    const ai = categoryOrder.indexOf(a)
    const bi = categoryOrder.indexOf(b)
    if (ai >= 0 && bi >= 0) return ai - bi
    if (ai >= 0) return -1
    if (bi >= 0) return 1
    return a.localeCompare(b)
  })

  // Load app terminals from content/probes-apps/ directory
  const appTerminals: Array<{ text: string; link: string }> = []
  try {
    const probesAppsDir = join(docsDir, "..", "content", "probes-apps")
    const appFiles = readdirSync(probesAppsDir).filter((f: string) => f.endsWith(".json"))
    const seen = new Set<string>()
    for (const file of appFiles) {
      try {
        const raw = JSON.parse(readFileSync(join(probesAppsDir, file), "utf-8"))
        if (!raw.terminal || seen.has(raw.terminal)) continue
        seen.add(raw.terminal)
        const terminalsData = JSON.parse(
          readFileSync(join(docsDir, "..", "content", "terminals.json"), "utf-8"),
        ) as Record<string, { label?: string }>
        const label = terminalsData[raw.terminal]?.label ?? raw.terminal
        const slug = label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/-+$/, "")
        appTerminals.push({ text: label, link: `/terminal/${slug}` })
      } catch {}
    }
    appTerminals.sort((a, b) => a.text.localeCompare(b.text))
  } catch {}

  // Build popular comparisons from available app terminals
  const compareItems: Array<{ text: string; link: string }> = []
  const popularPairs = [
    ["Ghostty", "Kitty"],
    ["Ghostty", "iTerm2"],
    ["Kitty", "WezTerm"],
    ["VS Code", "Terminal.app"],
    ["Ghostty", "WezTerm"],
    ["iTerm2", "Kitty"],
    ["Ghostty", "Terminal.app"],
    ["Kitty", "Terminal.app"],
  ]
  const appTerminalSlugs = new Map(appTerminals.map((t) => [t.text, t.link.replace("/terminal/", "")]))
  for (const [a, b] of popularPairs) {
    const slugA = appTerminalSlugs.get(a)
    const slugB = appTerminalSlugs.get(b)
    if (slugA && slugB) {
      // Sort slugs alphabetically to match paths.ts URL generation
      const [sortedSlugA, sortedSlugB, labelA, labelB] =
        slugA.localeCompare(slugB) <= 0 ? [slugA, slugB, a, b] : [slugB, slugA, b, a]
      compareItems.push({
        text: `${labelA} vs ${labelB}`,
        link: `/compare/${sortedSlugA}-vs-${sortedSlugB}`,
      })
    }
  }

  const sidebar = [
    { text: "Matrix", link: "/" },
    {
      text: "Categories",
      items: sortedCategories.map((cat) => ({
        text: categoryLabels[cat] ?? cat.charAt(0).toUpperCase() + cat.slice(1),
        link: `/${cat}`,
        collapsed: true,
        items: (categories.get(cat) ?? []).map((f) => ({
          text: f.name,
          link: `/${cat}/${f.slug}`,
        })),
      })),
    },
    {
      text: "Standards",
      items: sortedTags.map((tag) => ({
        text: tagLabels[tag] ?? tag,
        link: `/${tag}`,
      })),
    },
    {
      text: "Terminals",
      items: appTerminals,
    },
    {
      text: "Compare",
      items: compareItems,
    },
    {
      text: "Backends",
      items: terminals,
    },
    { text: "API", link: "/api" },
    { text: "About", link: "/about" },
  ]

  return { sidebar, terminals, sortedCategories, categoryLabels, sortedTags, tagLabels }
}

const { sidebar, terminals, sortedCategories, categoryLabels, sortedTags, tagLabels } = buildSidebar()

export default defineConfig({
  title: "Terminfo.dev",
  description: "Can your terminal do that? Feature support tables for terminal emulators.",
  cleanUrls: true,
  head: [["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }]],

  sitemap: {
    hostname: "https://terminfo.dev",
  },

  transformPageData(pageData) {
    // Set SEO titles and descriptions for dynamic route pages
    const params = pageData.params as Record<string, string> | undefined
    if (!params) return

    const rel = pageData.relativePath

    if (rel.startsWith("compare/")) {
      pageData.title = `${params.termALabel} vs ${params.termBLabel} — Terminal Feature Comparison`
      pageData.description = `Compare ${params.termALabel} (${params.termAPct}%) vs ${params.termBLabel} (${params.termBPct}%) terminal feature support. ${params.differ} features differ.`
      pageData.frontmatter.head = [
        ["meta", { property: "og:title", content: pageData.title }],
        ["meta", { property: "og:description", content: pageData.description }],
      ]
    } else if (rel.startsWith("terminal/")) {
      pageData.title = `${params.backendName} — Terminal Feature Support`
      pageData.description = `${params.backendName} terminal emulator feature support: ${params.pct}% (${params.yes}/${params.total} features). ${params.backendDescription}`
      pageData.frontmatter.head = [
        ["meta", { property: "og:title", content: pageData.title }],
        ["meta", { property: "og:description", content: pageData.description }],
      ]
    } else if (params.featureName) {
      // Feature pages: /sgr/sgr-bold (have featureName param)
      pageData.title = `${params.featureName} — Terminal Support`
      pageData.description = `Which terminal emulators support ${params.featureName}? Support matrix showing ${params.yesCount} of ${params.totalCount} backends.`
      pageData.frontmatter.head = [
        ["meta", { property: "og:title", content: pageData.title }],
        ["meta", { property: "og:description", content: pageData.description }],
      ]
    } else if (params.categoryName) {
      // Category + tag pages: /sgr, /ecma-48 (have categoryName param)
      const type = params.pageType === "tag" ? "Standard" : "Category"
      pageData.title = `${params.categoryName} — Terminal Feature ${type}`
      pageData.description =
        params.categoryDescription ||
        `${params.categoryName}: ${params.featureCount} terminal features compared across backends.`
      pageData.frontmatter.head = [
        ["meta", { property: "og:title", content: pageData.title }],
        ["meta", { property: "og:description", content: pageData.description }],
      ]
    }
  },

  themeConfig: {
    logo: "/logo.svg",
    nav: [
      { text: "Matrix", link: "/" },
      {
        text: "Features",
        items: sortedCategories.map((cat) => ({
          text: categoryLabels[cat] ?? cat.charAt(0).toUpperCase() + cat.slice(1),
          link: `/${cat}`,
        })),
      },
      {
        text: "Standards",
        items: sortedTags.map((tag) => ({
          text: tagLabels[tag] ?? tag,
          link: `/${tag}`,
        })),
      },
      {
        text: "Terminals",
        items: terminals,
      },
      { text: "About", link: "/about" },
      { text: "API", link: "/api" },
    ],

    // Sidebar on all pages except home (home uses layout: home, which hides sidebar)
    sidebar,

    footer: {
      message: 'Powered by <a href="https://termless.dev">Termless</a><br>Playwright for Terminals',
    },
  },

  async buildEnd() {
    const { dataPath, badgeCount } = generateApi()
    console.log(`[API] Generated ${dataPath} + ${badgeCount} badges`)
  },
})
