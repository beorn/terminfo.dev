import { defineConfig } from "vitepress"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { generateApi } from "../../scripts/generate-api"
import { glossaryLinksPlugin } from "./plugins/glossary-links"

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

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
  const terminalsData = JSON.parse(readFileSync(join(docsDir, "..", "content", "terminals.json"), "utf-8")) as Record<
    string,
    { headlessBackends?: string[] }
  >
  const appSubsumedBackends = new Set<string>()
  for (const entry of Object.values(terminalsData)) {
    for (const hb of entry.headlessBackends ?? []) {
      appSubsumedBackends.add(hb)
    }
  }

  try {
    const files = readdirSync(probesLibsDir).filter((f) => f.endsWith(".json") && f !== "unified.json")
    for (const file of files) {
      try {
        const raw = JSON.parse(readFileSync(join(probesLibsDir, file), "utf-8"))
        if (!raw.backend) continue
        // Skip backends that are merged into an app terminal page
        if (appSubsumedBackends.has(raw.backend)) continue
        const label = meta[raw.backend]?.label ?? raw.backend
        const slug = terminalSlug(raw.backend, meta)
        terminals.push({ text: label, link: `/terminals/${slug}` })
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

  // Load historical terminals from content/terminals.json
  const historicalTerminals: Array<{ text: string; link: string; year: number }> = []
  for (const [, entry] of Object.entries(terminalsData as Record<string, any>)) {
    if (entry.historical && entry.slug && entry.label) {
      historicalTerminals.push({
        text: `${entry.label} (${entry.year})`,
        link: `/terminals/${entry.slug}`,
        year: entry.year ?? 0,
      })
    }
  }
  historicalTerminals.sort((a, b) => a.year - b.year)

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
        appTerminals.push({ text: label, link: `/terminals/${slug}` })
      } catch {}
    }
    appTerminals.sort((a, b) => a.text.localeCompare(b.text))
  } catch {}

  // Build terminal groups by type
  const termAppTerminals: Array<{ text: string; link: string }> = []
  const termLibraries: Array<{ text: string; link: string }> = []
  const termMultiplexers: Array<{ text: string; link: string }> = []

  const seenSlugs = new Set<string>()
  for (const [key, entry] of Object.entries(terminalsData as Record<string, any>)) {
    if (entry.historical || !entry.slug || !entry.label) continue
    if (seenSlugs.has(entry.slug)) continue
    seenSlugs.add(entry.slug)
    const item = { text: entry.label, link: `/terminals/${entry.slug}` }

    if (entry.intermediary) {
      termMultiplexers.push(item)
    } else if (entry.headlessBackends?.length > 0 && entry.label.endsWith(".js")) {
      // JS-package terminals (vt100.js, vterm.js, xterm.js) are embeddable libraries,
      // not standalone GUI terminals like Alacritty/WezTerm which also have headless backends
      termLibraries.push(item)
    } else {
      termAppTerminals.push(item)
    }
  }
  termAppTerminals.sort((a, b) => a.text.localeCompare(b.text))
  termLibraries.sort((a, b) => a.text.localeCompare(b.text))
  termMultiplexers.sort((a, b) => a.text.localeCompare(b.text))

  // Flat list for convenience (used in nav dropdown)
  const allTerminals = [...termAppTerminals, ...termLibraries, ...termMultiplexers]

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
  const appTerminalSlugs = new Map(appTerminals.map((t) => [t.text, t.link.replace("/terminals/", "")]))
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

  // Load baselines for sidebar
  const baselinesData = JSON.parse(readFileSync(join(docsDir, "..", "content", "baselines.json"), "utf-8")) as Record<
    string,
    { label: string; emoji: string; order: number }
  >
  const baselineItems = Object.entries(baselinesData)
    .sort(([, a], [, b]) => a.order - b.order)
    .map(([id, bl]) => ({
      text: `${bl.emoji} ${bl.label}`,
      link: `/baseline/${id}`,
    }))

  // Load frameworks for sidebar
  const frameworksData = JSON.parse(readFileSync(join(docsDir, "..", "content", "frameworks.json"), "utf-8")) as Record<
    string,
    { label: string }
  >
  const frameworkItems = Object.entries(frameworksData).map(([id, fw]) => ({
    text: fw.label,
    link: `/framework/${id}`,
  }))

  const sidebar = [
    { text: "Matrix", link: "/" },
    {
      text: "Baselines",
      items: baselineItems,
    },
    {
      text: "Categories",
      link: "/features",
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
      link: "/standards",
      items: sortedTags.map((tag) => ({
        text: tagLabels[tag] ?? tag,
        link: `/${tag}`,
      })),
    },
    {
      text: "Terminals",
      link: "/terminals",
      items: [
        { text: "App Terminals", items: termAppTerminals },
        { text: "Parser Backends", link: "/backends", items: termLibraries },
        { text: "Multiplexers", link: "/multiplexers", items: termMultiplexers },
        { text: "Historical", items: historicalTerminals.map(({ text, link }) => ({ text, link })) },
      ],
    },
    {
      text: "Compare",
      items: compareItems,
    },
    {
      text: "Frameworks",
      items: frameworkItems,
    },
    {
      text: "Fundamentals",
      link: "/fundamentals",
      items: [
        { text: "Control Characters", link: "/fundamentals/control-characters" },
        { text: "TTY Architecture", link: "/fundamentals/tty-architecture" },
        { text: "Terminal Modes & stty", link: "/fundamentals/stty" },
        { text: "Terminal Detection", link: "/fundamentals/term-detection" },
        { text: "Terminal Security", link: "/fundamentals/security" },
      ],
    },
    { text: "API", link: "/api" },
    { text: "Glossary", link: "/glossary" },
    { text: "About", link: "/about" },
  ]

  return {
    sidebar,
    terminals,
    allTerminals,
    termAppTerminals,
    termLibraries,
    termMultiplexers,
    historicalTerminals,
    sortedCategories,
    categoryLabels,
    sortedTags,
    tagLabels,
  }
}

const {
  sidebar,
  termAppTerminals,
  termLibraries,
  termMultiplexers,
  historicalTerminals,
  sortedCategories,
  categoryLabels,
  sortedTags,
  tagLabels,
} = buildSidebar()

export default defineConfig({
  title: "Terminfo.dev",
  description: "Can your terminal do that? Feature support tables for terminal emulators.",
  cleanUrls: true,
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:site", content: "@AskTerminfo" }],
    ["meta", { property: "og:image", content: "https://terminfo.dev/og-image.svg" }],
    [
      "script",
      { type: "application/ld+json" },
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: "Terminfo.dev",
        url: "https://terminfo.dev",
        description: "Can your terminal do that? Feature support tables for terminal emulators.",
      }),
    ],
    [
      "script",
      {
        defer: "",
        src: "https://static.cloudflareinsights.com/beacon.min.js",
        "data-cf-beacon": '{"token": "f0f336a13fd042c992dbd2c182759cdb"}',
      },
    ],
  ],

  markdown: {
    config: (md) => {
      const contentDir = join(docsDir, "..", "content")
      glossaryLinksPlugin(md, contentDir)
    },
  },

  sitemap: {
    hostname: "https://terminfo.dev",
  },

  transformPageData(pageData) {
    const rel = pageData.relativePath

    // Canonical URL (cleanUrls: true — no .html extension)
    const cleanPath = rel.replace(/index\.md$/, "").replace(/\.md$/, "")
    const canonicalUrl = `https://terminfo.dev/${cleanPath}`
    pageData.frontmatter.head ??= []
    pageData.frontmatter.head.push(["link", { rel: "canonical", href: canonicalUrl }])

    // JSON-LD BreadcrumbList
    const segments = cleanPath.split("/").filter(Boolean)
    if (segments.length > 0) {
      const breadcrumbItems = [{ "@type": "ListItem", position: 1, name: "Home", item: "https://terminfo.dev/" }]
      for (let i = 0; i < segments.length; i++) {
        const path = segments.slice(0, i + 1).join("/")
        const name = segments[i].replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
        breadcrumbItems.push({
          "@type": "ListItem",
          position: i + 2,
          name: pageData.title && i === segments.length - 1 ? pageData.title : name,
          item: `https://terminfo.dev/${path}`,
        })
      }
      pageData.frontmatter.head.push([
        "script",
        { type: "application/ld+json" },
        JSON.stringify({
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: breadcrumbItems,
        }),
      ])
    }

    // SEO for Fundamentals pages
    if (rel === "fundamentals.md") {
      pageData.title = "How Terminals Work: Architecture, Control Characters, Detection"
      pageData.description =
        "The architecture behind every terminal session — control characters, PTY, kernel TTY discipline, raw mode, and runtime feature detection. Foundational concepts for understanding terminal emulators."
      pageData.frontmatter.head.push(
        ["meta", { property: "og:title", content: pageData.title }],
        ["meta", { property: "og:description", content: pageData.description }],
      )
      return
    }
    if (rel === "fundamentals/control-characters.md") {
      pageData.title = "C0 Control Characters: ASCII Control Codes in Terminals"
      pageData.description =
        "All 33 ASCII control characters (0x00–0x1F, 0x7F) and their terminal behavior. ESC, BS, TAB, LF, CR, BEL — the bytes that predate escape sequences."
      pageData.frontmatter.head.push(
        ["meta", { property: "og:title", content: pageData.title }],
        ["meta", { property: "og:description", content: pageData.description }],
      )
      return
    }
    if (rel === "fundamentals/tty-architecture.md") {
      pageData.title = "TTY Architecture: PTY, Line Discipline, Shell, and Terminal"
      pageData.description =
        "How pseudo-terminals connect terminal emulators to shells. The kernel TTY line discipline, PTY master/slave pairs, and why SSH and tmux work."
      pageData.frontmatter.head.push(
        ["meta", { property: "og:title", content: pageData.title }],
        ["meta", { property: "og:description", content: pageData.description }],
      )
      return
    }
    if (rel === "fundamentals/stty.md") {
      pageData.title = "stty & Terminal Modes: Raw Mode, Canonical Mode, Signals"
      pageData.description =
        "Raw mode vs canonical mode, echo, signal characters, input/output processing flags. How stty controls the kernel TTY line discipline and why TUI apps bypass it."
      pageData.frontmatter.head.push(
        ["meta", { property: "og:title", content: pageData.title }],
        ["meta", { property: "og:description", content: pageData.description }],
      )
      return
    }
    if (rel === "fundamentals/term-detection.md") {
      pageData.title = "Terminal Detection: $TERM, DA1, DECRPM, Runtime Probing"
      pageData.description =
        "How applications discover terminal capabilities — $TERM (unreliable), $COLORTERM, DA1, DECRPM mode reports, XTVERSION, and runtime behavioral probing."
      pageData.frontmatter.head.push(
        ["meta", { property: "og:title", content: pageData.title }],
        ["meta", { property: "og:description", content: pageData.description }],
      )
      return
    }
    if (rel === "fundamentals/security.md") {
      pageData.title = "Terminal Security: Clipboard, Paste Injection, Escape Attacks"
      pageData.description =
        "Terminal attack surfaces — OSC 52 clipboard exfiltration, OSC 8 hyperlink spoofing, paste injection without bracketed paste, escape sequence injection in logs, and title bar spoofing."
      pageData.frontmatter.head.push(
        ["meta", { property: "og:title", content: pageData.title }],
        ["meta", { property: "og:description", content: pageData.description }],
      )
      return
    }

    // SEO for static index pages
    if (rel === "standards.md") {
      pageData.title = "Terminal Standards: From VT100 to Kitty"
      pageData.description =
        "50 years of terminal protocols — ECMA-48, VT100, VT220, VT510, xterm, Kitty, OSC, Sixel, and Unicode. History, specs, and feature coverage for each standard."
      pageData.frontmatter.head.push(
        ["meta", { property: "og:title", content: pageData.title }],
        ["meta", { property: "og:description", content: pageData.description }],
      )
      return
    }
    if (rel === "features.md") {
      pageData.title = "Terminal Features: How Escape Sequences Work"
      pageData.description =
        "Terminal escape sequences — SGR styling, cursor control, modes, extensions, Unicode. Every feature tested on every major terminal emulator."
      pageData.frontmatter.head.push(
        ["meta", { property: "og:title", content: pageData.title }],
        ["meta", { property: "og:description", content: pageData.description }],
      )
      return
    }
    if (rel === "multiplexers.md") {
      pageData.title = "Terminal Multiplexers: tmux, GNU Screen, and the Pass-Through Problem"
      pageData.description =
        "How tmux and GNU Screen intercept escape sequences between your terminal and shell. Which features survive, which get dropped, and how to test multiplexer compatibility."
      pageData.frontmatter.head.push(
        ["meta", { property: "og:title", content: pageData.title }],
        ["meta", { property: "og:description", content: pageData.description }],
      )
      return
    }
    if (rel === "backends.md") {
      pageData.title = "Parser Backends: Standalone Libraries and App Parser Engines"
      pageData.description =
        "Terminal parser backends tested without a GUI — standalone libraries (xterm.js, vterm.js, vt100.js) and app parser engines (Alacritty, Ghostty, Kitty, WezTerm). Escape sequence correctness, independent of rendering."
      pageData.frontmatter.head.push(
        ["meta", { property: "og:title", content: pageData.title }],
        ["meta", { property: "og:description", content: pageData.description }],
      )
      return
    }
    if (rel === "terminals.md") {
      pageData.title = "Terminal Emulators: App Terminals, Parser Backends, and Multiplexers"
      pageData.description =
        "Every terminal emulator tested by terminfo.dev — app terminals (Ghostty, Kitty, iTerm2), parser backends (xterm.js, vterm.js), multiplexers (tmux, Screen), and historical terminals (VT100, VT220, xterm)."
      pageData.frontmatter.head.push(
        ["meta", { property: "og:title", content: pageData.title }],
        ["meta", { property: "og:description", content: pageData.description }],
      )
      return
    }
    if (rel === "glossary.md") {
      pageData.title = "Terminal Glossary: Acronyms and Technical Terms"
      pageData.description =
        "Quick reference for terminal acronyms — CSI, SGR, OSC, DEC, ECMA-48, and 30+ more. Each term explained with links to detailed feature pages."
      pageData.frontmatter.head.push(
        ["meta", { property: "og:title", content: pageData.title }],
        ["meta", { property: "og:description", content: pageData.description }],
      )
      return
    }

    // Set SEO titles and descriptions for dynamic route pages
    const params = pageData.params as Record<string, string> | undefined
    if (!params) return

    if (rel.startsWith("compare/")) {
      pageData.title = `${params.termALabel} vs ${params.termBLabel} — Terminal Feature Comparison`
      pageData.description = `Compare ${params.termALabel} (${params.termAPct}%) vs ${params.termBLabel} (${params.termBPct}%) terminal feature support. ${params.differ} features differ.`
      pageData.frontmatter.head.push(
        ["meta", { property: "og:title", content: pageData.title }],
        ["meta", { property: "og:description", content: pageData.description }],
      )
    } else if (rel.startsWith("terminals/")) {
      if (params.historical === "true") {
        pageData.title = `${params.backendName} (${params.year}) — Historical Terminal`
        pageData.description = `${params.backendName}: ${params.significance ?? params.backendDescription ?? "Historical terminal"}`
      } else {
        pageData.title = `${params.backendName} — Terminal Feature Support`
        pageData.description = `${params.backendName} terminal emulator feature support: ${params.pct}% (${params.yes}/${params.total} features). ${params.backendDescription}`
      }
      pageData.frontmatter.head.push(
        ["meta", { property: "og:title", content: pageData.title }],
        ["meta", { property: "og:description", content: pageData.description }],
      )
    } else if (params.featureName) {
      // Feature pages: /sgr/sgr-bold (have featureName param)
      pageData.title = `${params.featureName} — Terminal Support`
      pageData.description = `Which terminal emulators support ${params.featureName}? Support matrix showing ${params.yesCount} of ${params.totalCount} backends.`
      pageData.frontmatter.head.push(
        ["meta", { property: "og:title", content: pageData.title }],
        ["meta", { property: "og:description", content: pageData.description }],
      )
    } else if (rel.startsWith("framework/")) {
      pageData.title = `${params.label} — TUI Framework Terminal Compatibility`
      pageData.description = `${params.label}: ${params.description} Requires the ${params.baselineLabel} baseline (${params.featureCount} features).`
      pageData.frontmatter.head.push(
        ["meta", { property: "og:title", content: pageData.title }],
        ["meta", { property: "og:description", content: pageData.description }],
      )
    } else if (rel.startsWith("baseline/")) {
      pageData.title = `${params.label} Baseline — Terminal Feature Support`
      pageData.description = `${params.label} Baseline: ${params.tagline}. ${params.featureCount} features — ${params.description?.slice(0, 120)}...`
      pageData.frontmatter.head.push(
        ["meta", { property: "og:title", content: pageData.title }],
        ["meta", { property: "og:description", content: pageData.description }],
      )
    } else if (params.categoryName) {
      // Category + tag pages: /sgr, /ecma-48 (have categoryName param)
      const type = params.pageType === "tag" ? "Standard" : "Category"
      pageData.title = `${params.categoryName} — Terminal Feature ${type}`
      pageData.description =
        stripHtml(params.categoryDescription) ||
        `${params.categoryName}: ${params.featureCount} terminal features compared across backends.`
      pageData.frontmatter.head.push(
        ["meta", { property: "og:title", content: pageData.title }],
        ["meta", { property: "og:description", content: pageData.description }],
      )
    }
  },

  themeConfig: {
    logo: "/logo.svg",
    nav: [
      { text: "Matrix", link: "/" },
      {
        text: "Features",
        items: [
          { text: "All Features", link: "/features" },
          ...sortedCategories.map((cat) => ({
            text: categoryLabels[cat] ?? cat.charAt(0).toUpperCase() + cat.slice(1),
            link: `/${cat}`,
          })),
        ],
      },
      {
        text: "Standards",
        items: [
          { text: "All Standards", link: "/standards" },
          ...sortedTags.map((tag) => ({
            text: tagLabels[tag] ?? tag,
            link: `/${tag}`,
          })),
        ],
      },
      {
        text: "Terminals",
        items: [
          { text: "All Terminals", link: "/terminals" },
          { text: "App Terminals", items: termAppTerminals },
          { text: "Parser Backends", link: "/backends", items: termLibraries },
          { text: "Multiplexers", link: "/multiplexers", items: termMultiplexers },
          { text: "Historical", items: historicalTerminals.map(({ text, link }) => ({ text, link })) },
        ],
      },
      {
        text: "Fundamentals",
        items: [
          { text: "Overview", link: "/fundamentals" },
          { text: "Control Characters", link: "/fundamentals/control-characters" },
          { text: "TTY Architecture", link: "/fundamentals/tty-architecture" },
          { text: "Terminal Modes & stty", link: "/fundamentals/stty" },
          { text: "Terminal Detection", link: "/fundamentals/term-detection" },
          { text: "Terminal Security", link: "/fundamentals/security" },
        ],
      },
      { text: "About", link: "/about" },
      { text: "API", link: "/api" },
      { text: "Glossary", link: "/glossary" },
    ],

    // Sidebar on all pages except home (home uses layout: home, which hides sidebar)
    sidebar,

    footer: {
      message: 'Powered by <a href="https://termless.dev">Termless</a> · Built with <a href="https://silvery.dev">Silvery</a> · <a href="https://beorn.codes/flexily">Flexily</a>',
      copyright: 'Built by <a href="https://beorn.codes">Bjorn Stabell</a>'
    },
  },

  async buildEnd() {
    const { dataPath, badgeCount } = generateApi()
    console.log(`[API] Generated ${dataPath} + ${badgeCount} badges`)
  },
})
