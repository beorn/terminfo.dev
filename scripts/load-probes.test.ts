/**
 * @failure Missing or malformed required feature metadata silently removes route slugs and tags.
 * @level l0
 * @consumer Dynamic feature routes and site metadata consumers.
 * @testonly none
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, vi } from "vitest"

const fixture = vi.hoisted(() => ({ path: "" }))
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>()
  return {
    ...fs,
    readFileSync(path: string, encoding?: BufferEncoding) {
      const source = path.endsWith("/content/features.json") ? fixture.path : path
      return encoding ? fs.readFileSync(source, encoding) : fs.readFileSync(source)
    },
  }
})

test.each(["missing", "malformed", "non-object"] as const)(
  "required features.json %s failure is loud and retryable",
  async (failure) => {
    const directory = mkdtempSync(join(tmpdir(), "terminfo-features-meta-"))
    fixture.path = join(directory, "features.json")
    if (failure === "malformed") writeFileSync(fixture.path, "{")
    if (failure === "non-object") writeFileSync(fixture.path, "[]")
    vi.resetModules()

    try {
      const { loadFeaturesMeta, featureSlug, getFeaturesForTag } = await import("../docs/data/load-probes.ts")
      expect(() => loadFeaturesMeta()).toThrow(/content\/features\.json/)

      writeFileSync(
        fixture.path,
        JSON.stringify({
          $comment: "editorial metadata",
          "sgr.bold": {
            name: "Bold",
            slug: "bold-custom",
            tags: ["ecma-48"],
            probeStatus: "partial",
            sequence: "\\x1b[1m",
          },
        }),
      )
      const metadata = loadFeaturesMeta()
      expect(metadata).not.toHaveProperty("$comment")
      expect(metadata["sgr.bold"]).toMatchObject({
        name: "Bold",
        slug: "bold-custom",
        tags: ["ecma-48"],
        probeStatus: "partial",
        sequence: "\\x1b[1m",
      })
      expect(featureSlug("sgr.bold")).toBe("bold-custom")
      expect(getFeaturesForTag("ecma-48")).toContain("sgr.bold")
    } finally {
      fixture.path = ""
      vi.resetModules()
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
