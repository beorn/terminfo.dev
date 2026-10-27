import { defineConfig, type HeadConfig } from "vitepress"
import { readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { generateApi } from "../../scripts/generate-api"
import { buildStamp, createBuildMetadata } from "../../scripts/build-metadata"
import { siteCacheDir, siteDistDir } from "../../scripts/site-out"
import { NOT_MEASURED_TEXT } from "../data/release-scope"
import { glossaryLinksPlugin } from "./plugins/glossary-links"
import { loadFeatures, loadTerminals, type FeatureRecord, type TerminalRecord } from "@terminfo/catalog"
import { loadCategories, orderedCategoryIds } from "../data/categories.ts"

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const docsDir = join(__dirname, "..")
const contentDir = join(docsDir, "..", "content")
const buildMetadata = createBuildMetadata(join(docsDir, ".."))

// --- Load data for sidebar generation ---

function loadPlatformItems(): Array<{ text: string; link: string }> {
  const platformsPath = join(docsDir, "..", "content", "platforms.json")
  const platforms = JSON.parse(readFileSync(platformsPath, "utf-8")) as Record<string, { label: string; slug: string }>
  delete platforms.$comment
  return Object.values(platforms).map((p) => ({
    text: p.label,
    link: `/os/${p.slug}`,
  }))
}

function buildSidebar() {
  // Both catalogs come through their one loader (@terminfo/catalog); the per-field validation this
  // function used to repeat now lives there. `terminalsData` keeps its historical/intermediary
  // fields, and `featuresData` its tags, through the same records the rest of the site reads.
  const terminalsData: Record<string, TerminalRecord> = loadTerminals(contentDir)
  const featuresData: Record<string, FeatureRecord> = loadFeatures(contentDir)
  const tags = new Set<string>()
  for (const entry of Object.values(featuresData)) {
    for (const tag of entry.tags ?? []) tags.add(tag)
  }

  // Load tag labels from content/standards.json
  const standardsData = JSON.parse(readFileSync(join(docsDir, "..", "content", "standards.json"), "utf-8")) as Record<
    string,
    { label: string }
  >
  const tagLabels: Record<string, string> = Object.fromEntries(
    Object.entries(standardsData).map(([k, v]) => [k, v.label]),
  )

  // Order: formal standards → DEC hardware → de facto (xterm) → protocol families → vendor extensions
  const tagOrder = [
    "ecma-48",
    "vt100",
    "vt220",
    "vt510",
    "dec-private-modes",
    "xterm-extensions",
    "osc",
    "sixel",
    "unicode",
    "kitty-extensions",
    "iterm2",
    "conemu",
    "vscode-extensions",
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
  const categoriesData = loadCategories(contentDir)
  const categoryLabels: Record<string, string> = Object.fromEntries(
    Object.entries(categoriesData).map(([k, v]) => [k, v.label]),
  )

  // Determine categories and features from the same required catalog.
  const categories = new Map<string, Array<{ id: string; name: string; slug: string }>>()
  for (const [id, entry] of Object.entries(featuresData)) {
    if (id === "$comment") continue
    const cat = id.split(".")[0]
    const categoryFeatures = categories.get(cat) ?? []
    if (!categories.has(cat)) categories.set(cat, categoryFeatures)
    const slug = entry.slug ?? id.replaceAll(".", "-")
    categoryFeatures.push({ id, name: entry.name, slug })
  }

  const sortedCategories = orderedCategoryIds(categoriesData).filter((id) => categories.has(id))

  // Load historical terminals from content/terminals.json
  const historicalTerminals: Array<{ text: string; link: string; year: number }> = []
  for (const entry of Object.values(terminalsData)) {
    if (entry.historical) {
      historicalTerminals.push({
        text: `${entry.label} (${entry.year})`,
        link: `/terminals/${entry.slug}`,
        year: entry.year ?? 0,
      })
    }
  }
  historicalTerminals.sort((a, b) => a.year - b.year)

  // Build terminal groups by type
  const termAppTerminals: Array<{ text: string; link: string }> = []
  const termLibraries: Array<{ text: string; link: string }> = []
  const termMultiplexers: Array<{ text: string; link: string }> = []

  const seenSlugs = new Set<string>()
  for (const entry of Object.values(terminalsData)) {
    if (entry.historical) continue
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

  const platformItems = loadPlatformItems()

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
        items: [...(categories.get(cat) ?? [])]
          .sort((a, b) => {
            // Sort by sequence number when present (OSC N, SGR N, CSI N)
            const numA = a.name.match(/(?:^|\()(?:OSC|SGR|CSI)\s+(\d+)/)
            const numB = b.name.match(/(?:^|\()(?:OSC|SGR|CSI)\s+(\d+)/)
            if (numA && numB) return parseInt(numA[1], 10) - parseInt(numB[1], 10)
            if (numA) return -1
            if (numB) return 1
            return a.name.localeCompare(b.name)
          })
          .map((f) => ({
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
      text: "Operating Systems",
      link: "/os",
      items: platformItems,
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
        { text: "Color Fundamentals", link: "/fundamentals/color-fundamentals" },
        { text: "Color Schemes", link: "/fundamentals/color-schemes" },
        { text: "Color Detection", link: "/fundamentals/color-detection" },
        { text: "Terminal Security", link: "/fundamentals/security" },
      ],
    },
    {
      text: "How it works",
      link: "/how-it-works/",
      items: [
        { text: "How we measure", link: "/how-it-works/how-we-measure" },
        { text: "How to read a result", link: "/how-it-works/how-to-read-a-result" },
        { text: "Contribute a run", link: "/how-it-works/contribute-a-run" },
      ],
    },
    { text: "API", link: "/api" },
    { text: "Glossary", link: "/glossary" },
    { text: "Test Your Terminal", link: "/contribute" },
    { text: "About", link: "/about" },
  ]

  return {
    sidebar,
    allTerminals,
    termAppTerminals,
    termLibraries,
    termMultiplexers,
    historicalTerminals,
    sortedCategories,
    categoryLabels,
    sortedTags,
    tagLabels,
    baselineItems,
    platformItems,
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
  baselineItems,
  platformItems,
} = buildSidebar()

export default defineConfig({
  title: "Terminfo.dev",
  description:
    "Can your terminal do that? Look up 270+ features (colors, links, images, mouse, keys) and see which terminals support each, tested in the terminal itself.",
  cleanUrls: true,
  // 28268 AC4: `TERMINFO_SITE_OUT_DIR` moves the build output and the incremental cache out of the source tree so a
  // build can run from a read-only hab landing; unset, VitePress's own defaults are used unchanged.
  outDir: siteDistDir(join(docsDir, "..")),
  cacheDir: siteCacheDir(),
  vite: {
    server: {
      allowedHosts: [".ts.net"],
    },
  },
  // Privacy guard (defense-in-depth): never let internal artifacts become routes.
  // Internal AI reviews, design notes, and drafts must never publish as pages on
  // this public site. Keep this in sync with scripts/check-private-leak.ts.
  srcExclude: [
    "reviews/**",
    "**/reviews/**",
    "internal/**",
    "**/internal/**",
    "drafts/**",
    "**/drafts/**",
    "**/*.private.md",
    "**/*.draft.md",
  ],
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "Terminfo.dev" }],
    ["meta", { property: "og:image", content: "https://terminfo.dev/og-image.png" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:site", content: "@AskTerminfo" }],
    [
      "script",
      { type: "application/ld+json" },
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: "Terminfo.dev",
        url: "https://terminfo.dev",
        description:
          "Can your terminal do that? Look up 270+ features (colors, links, images, mouse, keys) and see which terminals support each, tested in the terminal itself.",
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
    const cleanPath = rel.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "")
    const canonicalUrl = `https://terminfo.dev/${cleanPath}`
    const head = (pageData.frontmatter.head ??= []) as HeadConfig[]
    head.push(["link", { rel: "canonical", href: canonicalUrl }])

    // --- Step 1: Set page title and description BEFORE breadcrumbs ---
    // (Breadcrumbs use pageData.title, so it must be resolved first)

    // Homepage
    if (rel === "index.md") {
      pageData.title = "Terminfo.dev — Can Your Terminal Do That?"
      pageData.description =
        "Terminal feature support, measured results and evidence across terminal emulators and parser backends."
    }

    // About page
    if (rel === "about.md") {
      pageData.title = "About Terminfo.dev — Terminal Feature Testing Methodology"
      pageData.description =
        "How terminfo.dev tests terminal emulators. Three data sources: real app probes, headless parser testing via Termless, and multiplexer pass-through tests. Why traditional terminfo falls short."
    }

    // API page
    if (rel === "api.md") {
      pageData.title = "API — Machine-Readable Terminal Compatibility Data"
      pageData.description =
        "JSON API and SVG badges for terminal feature support. The terminal equivalent of MDN Browser Compat Data — embeddable badges for terminal README files."
    }

    // Fundamentals pages
    if (rel === "fundamentals.md") {
      pageData.title = "How Terminals Work: Architecture, Control Characters, Detection"
      pageData.description =
        "The architecture behind every terminal session — control characters, PTY, kernel TTY discipline, raw mode, and runtime feature detection. Foundational concepts for understanding terminal emulators."
    }
    if (rel === "fundamentals/control-characters.md") {
      pageData.title = "C0 Control Characters: ASCII Control Codes in Terminals"
      pageData.description =
        "All 33 ASCII control characters (0x00\u20130x1F, 0x7F) and their terminal behavior. ESC, BS, TAB, LF, CR, BEL \u2014 the bytes that predate escape sequences."
    }
    if (rel === "fundamentals/tty-architecture.md") {
      pageData.title = "TTY Architecture: PTY, Line Discipline, Shell, and Terminal"
      pageData.description =
        "How pseudo-terminals connect terminal emulators to shells. The kernel TTY line discipline, PTY master/slave pairs, and why SSH and tmux work."
    }
    if (rel === "fundamentals/stty.md") {
      pageData.title = "stty & Terminal Modes: Raw Mode, Canonical Mode, Signals"
      pageData.description =
        "Raw mode vs canonical mode, echo, signal characters, input/output processing flags. How stty controls the kernel TTY line discipline and why TUI apps bypass it."
    }
    if (rel === "fundamentals/term-detection.md") {
      pageData.title = "Terminal Detection: $TERM, DA1, DECRPM, Runtime Probing"
      pageData.description =
        "How applications discover terminal features \u2014 $TERM (unreliable), $COLORTERM, DA1, DECRPM mode reports, XTVERSION, and runtime behavioral probing."
    }
    if (rel === "fundamentals/security.md") {
      pageData.title = "Terminal Security: Clipboard, Paste Injection, Escape Attacks"
      pageData.description =
        "Terminal attack surfaces \u2014 OSC 52 clipboard exfiltration, OSC 8 hyperlink spoofing, paste injection without bracketed paste, escape sequence injection in logs, and title bar spoofing."
    }
    if (rel === "fundamentals/color-fundamentals.md") {
      pageData.title = "Terminal Color Fundamentals: ANSI 16, 256-Color, Truecolor"
      pageData.description =
        "Three generations of terminal color \u2014 ANSI 16 named slots, 256-color indexed cube, 24-bit truecolor hex. SGR vs OSC escape families, the SGR attrs (bold, dim, italic, underline, inverse), and how modern TUIs negotiate tiers."
    }
    if (rel === "fundamentals/color-schemes.md") {
      pageData.title = "Terminal Color Schemes: The 22-Slot User-Configurable Palette"
      pageData.description =
        "The 22-slot color scheme every major terminal exposes: 16 ANSI + foreground, background, cursor (\u00d7 2), selection (\u00d7 2). How applications adopt the user's theme via OSC 10/11/4/12/17/19 queries."
    }
    if (rel === "fundamentals/color-detection.md") {
      pageData.title = "Terminal Color Detection: NO_COLOR, COLORTERM, OSC Probes"
      pageData.description =
        "The detection stack TUIs use to pick truecolor, 256-color, ANSI 16, or monochrome \u2014 NO_COLOR, COLORTERM, $TERM, OSC 10/11/4 probing, and graceful tier degradation."
    }

    // Static index pages
    if (rel === "standards.md") {
      pageData.title = "Terminal Standards: From VT100 to Kitty"
      pageData.description =
        "50 years of terminal protocols \u2014 ECMA-48, VT100, VT220, VT510, xterm, Kitty, OSC, Sixel, and Unicode. History, specs, and feature coverage for each standard."
    }
    if (rel === "features.md") {
      pageData.title = "Terminal Features: How Escape Sequences Work"
      pageData.description =
        "Terminal escape sequences \u2014 SGR styling, cursor control, modes, extensions, Unicode. Every feature tested on every major terminal emulator."
    }
    if (rel === "multiplexers.md") {
      pageData.title = "Terminal Multiplexers: tmux, GNU Screen, and the Pass-Through Problem"
      pageData.description =
        "How tmux and GNU Screen intercept escape sequences between your terminal and shell. Which features survive, which get dropped, and how to test multiplexer compatibility."
    }
    if (rel === "backends.md") {
      pageData.title = "Parser Backends: Standalone Libraries and App Parser Engines"
      pageData.description =
        "Terminal parser backends tested without a GUI \u2014 standalone libraries (xterm.js, vterm.js, vt100.js) and app parser engines (Alacritty, libghostty-vt, Kitty, WezTerm). Escape sequence correctness, independent of rendering."
    }
    if (rel === "terminals.md") {
      pageData.title = "Terminal Emulators: App Terminals, Parser Backends, and Multiplexers"
      pageData.description =
        "Every terminal emulator tested by terminfo.dev \u2014 app terminals (Ghostty, Kitty, iTerm2), parser backends (xterm.js, vterm.js), multiplexers (tmux, Screen), and historical terminals (VT100, VT220, xterm)."
    }
    if (rel === "os.md") {
      pageData.title = "Operating System Terminal Support: macOS, Linux, Windows"
      pageData.description =
        "Terminal support by operating system. See which terminals are available on macOS, Linux, and Windows, and which scores are app probes, parser probes, inherited engine scores, or reference-only evidence."
    }
    if (rel === "glossary.md") {
      pageData.title = "Terminal Glossary: Acronyms and Technical Terms"
      pageData.description =
        "Quick reference for terminal acronyms \u2014 CSI, SGR, OSC, DEC, ECMA-48, and 30+ more. Each term explained with links to detailed feature pages."
    }

    // Dynamic route pages (titles from params)
    const params = pageData.params as Record<string, string> | undefined
    if (params) {
      if (rel.startsWith("compare/")) {
        pageData.title = `${params.termALabel} ${params.termAVersion} vs ${params.termBLabel} ${params.termBVersion} \u2014 Selected Terminal Observations`
        if (params.comparableScope !== "true") {
          pageData.description = `${params.termALabel} (${params.termAKind}, ${params.termAOs}) and ${params.termBLabel} (${params.termBKind}, ${params.termBOs}) have different or incomplete recorded contexts; inspect their selected observations without a pairwise support claim.`
        } else if (params.jointConclusive === "0") {
          pageData.description = `${params.termALabel} (${params.termAKind}, ${params.termAOs}) and ${params.termBLabel} (${params.termBKind}, ${params.termBOs}): no shared features have a recorded Supported or Unsupported result from the same method.`
        } else {
          pageData.description = `${params.termALabel} (${params.termAKind}, ${params.termAOs}) and ${params.termBLabel} (${params.termBKind}, ${params.termBOs}): ${params.differ} differences among ${params.jointConclusive} shared features with results from the same method.`
        }
      } else if (rel.startsWith("terminals/")) {
        if (params.historical === "true") {
          pageData.title = `${params.backendName} (${params.year}) \u2014 Historical Terminal`
          pageData.description = `${params.backendName}: ${params.significance ?? params.backendDescription ?? "Historical terminal"}`
        } else {
          pageData.title = `${params.backendName} \u2014 Terminal Feature Support`
          // #30784 (@cto S1 on a41752fe): a run that decided nothing has no percentage and no
          // answerable fraction, so it publishes neither. A decided run keeps its exact text, a
          // genuine 0% included.
          const share = params.pct === "" ? NOT_MEASURED_TEXT.toLowerCase() : `${params.pct}%`
          const fraction = params.pct === "" ? "" : ` (${params.yes}/${params.total} features)`
          pageData.description = `${params.backendName} terminal emulator feature support: ${share}${fraction}. ${params.backendDescription}`
        }
      } else if (rel.startsWith("os/")) {
        pageData.title = `${params.label} Terminal Support \u2014 OS Compatibility Matrix`
        pageData.description = `${params.label} terminal emulator support: ${params.appCount} app terminals, ${params.measuredAppCount} platform-specific app probes, ${params.parserCount} parser backends, and ${params.gapCount} tracked gaps.`
      } else if (params.featureName) {
        pageData.title = `${params.featureName} \u2014 Terminal Support`
        pageData.description = `Which terminal emulators support ${params.featureName}? Support matrix showing ${params.yesCount} of ${params.totalCount} backends.`
      } else if (rel.startsWith("framework/")) {
        pageData.title = `${params.label} \u2014 TUI Framework Terminal Compatibility`
        pageData.description = `${params.label}: ${params.description} Requires the ${params.baselineLabel} baseline (${params.featureCount} features).`
      } else if (rel.startsWith("baseline/")) {
        pageData.title = `${params.label} Baseline \u2014 Terminal Feature Support`
        pageData.description = `${params.label} Baseline: ${params.tagline}. ${params.featureCount} features \u2014 ${params.description?.slice(0, 120)}...`
      } else if (params.categoryName) {
        const type = params.pageType === "tag" ? "Standard" : "Category"
        pageData.title = `${params.categoryName} \u2014 Terminal Feature ${type}`
        pageData.description =
          stripHtml(params.categoryDescription) ||
          `${params.categoryName}: ${params.featureCount} terminal features compared across backends.`
      }
    }

    // --- Step 2: OG meta tags (after title/description are resolved) ---
    head.push(
      ["meta", { property: "og:title", content: pageData.title || "Terminfo.dev" }],
      [
        "meta",
        {
          property: "og:description",
          content: pageData.description || "Feature support tables for terminal emulators.",
        },
      ],
      ["meta", { property: "og:url", content: canonicalUrl }],
    )

    // --- Step 3: JSON-LD BreadcrumbList (after title is resolved) ---
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
      head.push([
        "script",
        { type: "application/ld+json" },
        JSON.stringify({
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: breadcrumbItems,
        }),
      ])
    }

    // --- Step 4: TechArticle schema for content pages ---
    if (segments.length > 0) {
      const article: Record<string, unknown> = {
        "@context": "https://schema.org",
        "@type": "TechArticle",
        headline: pageData.title || "Terminfo.dev",
        description: pageData.description || "",
        url: canonicalUrl,
        author: {
          "@type": "Person",
          name: "Bj\u00f8rn Stabell",
          url: "https://beorn.codes",
        },
        publisher: {
          "@type": "Organization",
          name: "Terminfo.dev",
          url: "https://terminfo.dev",
        },
      }
      if (pageData.lastUpdated) {
        const isoDate = new Date(pageData.lastUpdated).toISOString()
        article.dateModified = isoDate
        article.datePublished = isoDate
      }
      head.push(["script", { type: "application/ld+json" }, JSON.stringify(article)])
    }

    // --- Step 5: Dataset schema on homepage ---
    if (rel === "index.md") {
      head.push([
        "script",
        { type: "application/ld+json" },
        JSON.stringify({
          "@context": "https://schema.org",
          "@type": "Dataset",
          name: "Terminal Feature Database",
          description:
            "Measured terminal feature results with evidence and method details across terminal emulators and parser backends.",
          url: "https://terminfo.dev",
          creator: {
            "@type": "Person",
            name: "Bj\u00f8rn Stabell",
            url: "https://beorn.codes",
          },
          license: "https://opensource.org/licenses/MIT",
        }),
      ])
    }
  },

  themeConfig: {
    search: {
      provider: "local",
    },
    logo: "/logo.svg",
    nav: [
      { text: "How it works", link: "/how-it-works/" },
      { text: "Matrix", link: "/" },
      {
        text: "Features",
        items: [
          { text: "All Features", link: "/features" },
          ...sortedCategories.map((cat) => ({
            text: categoryLabels[cat] ?? cat.charAt(0).toUpperCase() + cat.slice(1),
            link: `/${cat}`,
          })),
          { text: "Baselines", items: baselineItems },
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
        text: "OS",
        items: [{ text: "Overview", link: "/os" }, ...platformItems],
      },
      {
        text: "Fundamentals",
        items: [
          { text: "Overview", link: "/fundamentals" },
          { text: "Control Characters", link: "/fundamentals/control-characters" },
          { text: "TTY Architecture", link: "/fundamentals/tty-architecture" },
          { text: "Terminal Modes & stty", link: "/fundamentals/stty" },
          { text: "Terminal Detection", link: "/fundamentals/term-detection" },
          { text: "Color Fundamentals", link: "/fundamentals/color-fundamentals" },
          { text: "Color Schemes", link: "/fundamentals/color-schemes" },
          { text: "Color Detection", link: "/fundamentals/color-detection" },
          { text: "Terminal Security", link: "/fundamentals/security" },
        ],
      },
      {
        text: "About",
        items: [
          { text: "About Terminfo.dev", link: "/about" },
          { text: "Changelog", link: "/changelog" },
          { text: "API", link: "/api" },
          { text: "Glossary", link: "/glossary" },
        ],
      },
    ],

    // Sidebar on all pages except home (home uses layout: home, which hides sidebar)
    sidebar,

    footer: {
      message:
        'Powered by <a href="https://termless.dev">Termless</a> · Built with <a href="https://silvery.dev">Silvery</a> · <a href="https://beorn.codes/flexily">Flexily</a>' +
        `<br><a href="/build.json">${buildStamp(buildMetadata)}</a>`,
      copyright: 'Built by <a href="https://beorn.codes">Bjørn Stabell</a>',
    },
  },

  buildEnd(siteConfig) {
    // Build verification must not rewrite tracked docs/public artifacts.
    // Standalone `bun scripts/generate-api.ts` refreshes source-public
    // snapshots; VitePress build owns the ignored deploy artifact.
    const { dataPath } = generateApi(siteConfig.outDir)
    console.log(`[API] Generated ${dataPath}`)
    const metadataJson = JSON.stringify(buildMetadata, null, 2) + "\n"
    writeFileSync(join(siteConfig.outDir, "build.json"), metadataJson)
    console.log(`[Build] Source ${buildMetadata.sourceCommit.slice(0, 10)} · ${buildMetadata.context}`)
  },
})
