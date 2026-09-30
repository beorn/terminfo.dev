/**
 * @failure Missing or malformed required feature metadata silently removes route slugs and tags.
 * @level l0
 * @consumer Dynamic feature routes and site metadata consumers.
 * @testonly none
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, vi } from "vitest"

const fixture = vi.hoisted(() => ({ path: "", catalogs: {} as Record<string, string> }))
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>()
  return {
    ...fs,
    readFileSync(path: string, encoding?: BufferEncoding) {
      const source =
        path.endsWith("/content/features.json") && fixture.path
          ? fixture.path
          : (Object.entries(fixture.catalogs).find(([name]) => path.endsWith(`/content/${name}.json`))?.[1] ?? path)
      return encoding ? fs.readFileSync(source, encoding) : fs.readFileSync(source)
    },
  }
})

// Metadata checks do not need to parse the populated archive on every retry.
vi.mock("../docs/data/current-results.ts", () => ({
  loadCurrentResults: () => ({ projection: { current: {}, versions: {}, history: {}, exclusions: [] } }),
  compatibilityTargets: () => new Map(),
}))

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

// Required page catalogs must reject invalid roots and retain the resource path;
// the feature-only loader test cannot exercise annotations or category labels.
test.each(["annotations", "categories"] as const)("page data rejects damaged %s metadata and retries", async (name) => {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-page-meta-"))
  mkdirSync(join(directory, "content"))
  const path = join(directory, "content", `${name}.json`)
  fixture.catalogs[name] = path
  vi.resetModules()
  try {
    const { loadFullProbes } = await import("../docs/data/probes.data.ts")
    expect(() => loadFullProbes()).toThrow(`${name}.json`)
    for (const invalid of ["[]", "null", "{"]) {
      writeFileSync(path, invalid)
      expect(() => loadFullProbes(), invalid).toThrow(`/content/${name}.json`)
    }
    const valid = name === "annotations" ? { "kitty:sgr.bold": { note: "fixture" } } : { sgr: { label: "Styles" } }
    writeFileSync(path, JSON.stringify(valid))
    const data = loadFullProbes()
    if (name === "annotations") expect(data.annotations).toEqual(valid)
    else expect(data.categoryLabels).toEqual({ sgr: "Styles" })
  } finally {
    delete fixture.catalogs[name]
    vi.resetModules()
    rmSync(directory, { recursive: true, force: true })
  }
})
