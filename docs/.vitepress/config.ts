import { defineConfig } from "vitepress"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

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
  // Load backends from census results
  const resultsDir = join(docsDir, "data", "results")
  const meta = loadBackendMeta()
  const terminals: Array<{ text: string; link: string }> = []

  try {
    const files = readdirSync(resultsDir).filter((f) => f.endsWith(".json") && f !== "census.json")
    for (const file of files) {
      try {
        const raw = JSON.parse(readFileSync(join(resultsDir, file), "utf-8"))
        if (!raw.backend) continue
        const label = meta[raw.backend]?.label ?? raw.backend
        const slug = terminalSlug(raw.backend, meta)
        terminals.push({ text: label, link: `/terminal/${slug}` })
      } catch {}
    }
  } catch {}
  terminals.sort((a, b) => a.text.localeCompare(b.text))

  // Load features.json for tags
  const featuresPath = join(docsDir, "..", "features.json")
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

  const tagLabels: Record<string, string> = {
    "ecma-48": "ECMA-48",
    vt100: "VT100",
    vt220: "VT220",
    vt510: "VT510",
    "dec-private-modes": "DEC Private Modes",
    "xterm-extensions": "Xterm Extensions",
    "kitty-extensions": "Kitty Extensions",
    osc: "OSC",
    sixel: "Sixel",
    unicode: "Unicode",
  }

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

  const categoryLabels: Record<string, string> = {
    sgr: "SGR (Text Styling)",
    cursor: "Cursor",
    text: "Text",
    erase: "Erase",
    editing: "Editing",
    modes: "Modes",
    scrollback: "Scrollback",
    reset: "Reset",
    extensions: "Extensions",
    charsets: "Character Sets",
    device: "Device Status",
  }

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

  const sidebar = [
    { text: "Matrix", link: "/" },
    {
      text: "Terminals",
      items: terminals,
    },
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

    if (rel.startsWith("terminal/")) {
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
    ],

    // Sidebar on all pages except home (home uses layout: home, which hides sidebar)
    sidebar,

    footer: {
      message: 'Powered by <a href="https://termless.dev">Termless</a><br>Playwright for Terminals',
    },
  },
})
