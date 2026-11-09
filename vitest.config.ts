import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"
import { checkoutInlineDeps, terminfoCheckoutAliases } from "./scripts/checkout-alias.ts"

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: { alias: terminfoCheckoutAliases(root) },
  test: {
    include: ["packages/**/*.test.ts", "scripts/**/*.test.ts"],
    server: { deps: { inline: checkoutInlineDeps(root) } },
  },
})
