import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["packages/probes/**/*.probe.ts"],
  },
})
