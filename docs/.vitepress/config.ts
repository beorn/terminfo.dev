import { defineConfig } from "vitepress"

export default defineConfig({
  title: "Terminfo.dev",
  description: "Can your terminal do that? Feature support tables for terminal emulators.",
  cleanUrls: true,
  head: [["link", { rel: "icon", href: "/favicon.svg" }]],

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
