import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"
import { terminfoCheckoutAliases } from "./scripts/checkout-alias.ts"

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: { alias: terminfoCheckoutAliases(root) },
  test: {
    include: ["packages/**/*.test.ts", "scripts/**/*.test.ts"],
    // Keep @terminfo inside Vite so the alias above wins over a parent node_modules link.
    server: { deps: { inline: [/^@terminfo\//] } },
  },
})
