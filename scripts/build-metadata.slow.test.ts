/**
 * @failure The home and features pages stop following the catalog's order, so a catalog edit reaches the sidebar but not the pages.
 * @level l3 — needs the whole probe corpus; split from build-metadata.test.ts by #34112 (measured 75 s there, 60 s of it loadFullProbes)
 * @consumer docs/index.md sortedCategories and docs/features.md activeCategories.
 * @reach fs-walk vendor/terminfo.dev/content/probes-apps/** vendor/terminfo.dev/content/probes-libs/** vendor/terminfo.dev/content/probes-mux/**
 * @testonly none
 */

import { execFileSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const siteRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

describe("website catalog order in page computations", () => {
  it("follows catalog order on the home and features pages", () => {
    // Changing the real catalog's order must reach the consumers, rather than matching a copied list.
    // Both page setups read the whole probe corpus, so this is the slow-tier half of the sidebar check
    // (#34112): build-metadata.test.ts keeps the config-only navigation and sidebar assertion.
    const script = `
      import * as fs from "node:fs";
      import { mock } from "bun:test";
      import { ref, computed, watch } from "vue";
      import { isEnvironmentGroup } from "./packages/probe-defs/src/environment-groups.ts";
      const read = fs.readFileSync;
      const catalog = JSON.parse(read("./content/categories.json", "utf8"));
      const expected = Object.keys(catalog).filter(id => !id.startsWith("$")).reverse();
      expected.forEach((id, order) => { catalog[id].order = order; });
      mock.module("node:fs", () => ({
        ...fs,
        readFileSync: (path, ...args) => String(path).endsWith("/content/categories.json")
          ? JSON.stringify(catalog) : read(path, ...args),
      }));
      const { loadFullProbes } = await import("./docs/data/probes.data.ts");
      const presentation = await import("./docs/data/release-scope.ts");
      // The home page builds its row helpers at setup (#37761), so they run here with the real data too.
      const { rowFacts } = await import("./docs/.vitepress/theme/row-facts.ts");
      const data = loadFullProbes();
      function pageCategories(path, binding) {
        const source = read(path, "utf8");
        const setup = source.slice(source.indexOf("<script setup>") + 14, source.indexOf("</script>"))
          .replace(/^import[^\\n]*\\n/gm, "");
        // Execute the complete page computation with its real Vue primitives, data and page imports.
        return new Function("ref", "computed", "watch", "data", "isEnvironmentGroup", "rowFacts", ...Object.keys(presentation),
          setup + "\\nreturn " + binding + ".value;")
          (ref, computed, watch, data, isEnvironmentGroup, rowFacts, ...Object.values(presentation));
      }
      console.log(JSON.stringify({ expected,
        home: pageCategories("./docs/index.md", "sortedCategories"),
        features: pageCategories("./docs/features.md", "activeCategories") }));
    `
    // #34112: the whole-corpus child measured 75 s on 2026-11-23 (60 s of it loadFullProbes); the
    // 300 s bound is hang protection for a loaded shared host, never the expected runtime.
    const observed = JSON.parse(
      execFileSync(process.execPath, ["-e", script], {
        cwd: siteRoot,
        encoding: "utf8",
        timeout: 300_000,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as { expected: string[]; home: string[]; features: string[] }
    expect(observed).toEqual({
      expected: observed.expected,
      home: observed.expected,
      features: observed.expected,
    })
  }, 305_000)
})
