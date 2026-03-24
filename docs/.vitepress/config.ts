import { defineConfig } from "vitepress"

export default defineConfig({
  title: "Terminfo.dev",
  description: "Can your terminal do that? Feature support tables for terminal emulators.",
  cleanUrls: true,
  head: [["link", { rel: "icon", href: "/favicon.svg" }]],

  sitemap: {
    hostname: "https://terminfo.dev",
  },

  transformPageData(pageData) {
    // Set SEO titles and descriptions for dynamic route pages
    const params = pageData.params as Record<string, string> | undefined
    if (!params) return

    const rel = pageData.relativePath

    if (rel.startsWith("terminal/")) {
      // Terminal (backend) pages: /terminal/ghostty
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
      // Category pages: /sgr, /cursor (have categoryName param)
      pageData.title = `${params.categoryName} — Terminal Feature Category`
      pageData.description = params.categoryDescription || `${params.categoryName}: ${params.featureCount} terminal features compared across backends.`
      pageData.frontmatter.head = [
        ["meta", { property: "og:title", content: pageData.title }],
        ["meta", { property: "og:description", content: pageData.description }],
      ]
    }
  },

  themeConfig: {
    nav: [
      { text: "Matrix", link: "/" },
      { text: "About", link: "/about" },
      { text: "Termless", link: "https://termless.dev" },
    ],

    footer: {
      message: 'Powered by <a href="https://termless.dev">Termless</a> — Playwright for terminals',
    },
  },
})
