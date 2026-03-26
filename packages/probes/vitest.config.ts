import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["packages/probes/run-unified.probe.ts"],
  },
})
