/**
 * @failure A public page lists one of the nine environment positions (`device.env-*`): its row in the matrix, its
 *   feature page and sidebar link, its line on a tag page, its baseline membership or its name as a link, though
 *   no public page may show them (@cpo/term f16a5a52 Q2), or an old link to one of their pages 404s instead of
 *   reaching the device category (D4).
 * @level l2
 * @consumer terminfo.dev matrix data (docs/data/probes.data.ts), sidebar and nav (docs/.vitepress/config.ts), tag
 *   pages (docs/data/load-probes.ts), feature-name links (docs/data/linkify-content.ts) and docs/public/_redirects
 * @reach fs-read vendor/terminfo.dev/content/*.json (the real feature, category, standard and terminal catalogues)
 * @testonly none
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { loadFeatures } from "@terminfo/catalog"
import { ENVIRONMENT_GROUP_IDS, isEnvironmentGroup } from "@terminfo/probe-defs"
import { aggregateCurrentResults, rollupInputs } from "../docs/data/release-scope.ts"
import { loadFullProbes, baselineStat } from "../docs/data/probes.data.ts"
import { publicFeatureIds } from "../docs/data/public-features.ts"
import { getAllTags, getFeaturesForTag } from "../docs/data/load-probes.ts"
import { loadTerminfoEntities } from "../docs/data/linkify-content.ts"
import { featurePageParams } from "../docs/[category]/[id].paths.ts"
// Loaded by URL, as build-metadata and run-share-readout load it, so the root type program does not take in the
// VitePress config: the site build compiles it, and on main it has never been part of the root typecheck.
const CONFIG_URL = new URL("../docs/.vitepress/config.ts", import.meta.url).href
const { default: config } = (await import(CONFIG_URL)) as {
  default: { themeConfig?: { sidebar?: unknown; nav?: unknown } }
}

// The corpus is replaced by one published subject over the REAL catalogue, so loadFullProbes runs its own code
// over every catalogue id without reading 150 s of stored runs.
const corpus = vi.hoisted(() => ({ published: undefined as unknown }))
vi.mock("../docs/data/current-results.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../docs/data/current-results.ts")>()),
  loadCurrentResults: () => ({ projection: { table: {} } }),
  compatibilitySubjects: () => new Map(),
  joinedAppCells: () => new Map(),
}))
vi.mock("../docs/data/public-results.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../docs/data/public-results.ts")>()),
  publicResults: () => {
    if (!corpus.published) throw new Error("public-feature-ids.test: no published fixture was set")
    return corpus.published
  },
}))

const root = join(import.meta.dirname, "..")
const catalog = loadFeatures(join(root, "content"))
const catalogIds = Object.keys(catalog)
// The expectation is the one environment partition, never the function under test.
const hiddenIds = catalogIds.filter((id) => isEnvironmentGroup(id))
const shownIds = catalogIds.filter((id) => !isEnvironmentGroup(id))
const hiddenPages = new Set(
  hiddenIds.map((id) => {
    const page = featurePageParams(id)
    return `/${page.category}/${page.id}`
  }),
)
const SUBJECT = "fixture-lib"
const ENV_REASON = "manual by design: no automatable probe exists for this feature"

/** One published subject as the stored corpus stores it: every graded id decided, the nine with their reason. */
function publishOne() {
  const featureResults = Object.fromEntries(
    catalogIds.map((featureId) => [
      featureId,
      isEnvironmentGroup(featureId)
        ? { featureId, status: "probe-todo", reason: ENV_REASON }
        : { featureId, status: "supported" },
    ]),
  )
  const bar = aggregateCurrentResults(rollupInputs(SUBJECT, { featureResults, catalogIds } as never), catalogIds)
  const selected = {
    subject: { id: SUBJECT, kind: "lib", os: null },
    sources: {
      "run-1": {
        runId: "run-1",
        subject: { version: "0.17.0" },
        measuredAt: "2026-11-08T00:00:00Z",
        suiteRelation: "tree",
      },
    },
    catalogIds,
    featureResults,
    counts: bar.counts,
    score: { supported: bar.supported, all: bar.denominator },
    derivedIds: [],
    complete: bar.complete,
  }
  corpus.published = {
    selectedByBackend: {
      [SUBJECT]: { contextKey: `lib:${SUBJECT}`, routeKey: SUBJECT, os: null, selected, states: {} },
    },
    projection: { contexts: {}, versions: {}, history: {}, contextCount: 1, exclusions: [] },
  }
  return selected
}

type SidebarItem = { text?: string; link?: string; items?: SidebarItem[] }
function links(items: readonly SidebarItem[]): string[] {
  return items.flatMap((item) => [...(item.link ? [item.link] : []), ...links(item.items ?? [])])
}

describe("publicFeatureIds", () => {
  it("is the real catalogue without exactly the nine environment positions, in catalogue order", () => {
    expect(hiddenIds.toSorted()).toEqual([...ENVIRONMENT_GROUP_IDS].toSorted())
    expect(publicFeatureIds(catalog)).toEqual(shownIds)
    expect(publicFeatureIds(catalog)).toHaveLength(catalogIds.length - ENVIRONMENT_GROUP_IDS.length)
  })
})

describe("every public reader of the catalogue lists the public ids only", () => {
  it("loadFullProbes: features, categories, featureDescriptions, results, notes and baselines", () => {
    const selected = publishOne()
    const data = loadFullProbes()
    expect.soft(data.features.map((feature) => feature.id)).toEqual(shownIds.toSorted((a, b) => a.localeCompare(b)))
    expect
      .soft(
        Object.values(data.categories)
          .flat()
          .filter((feature) => isEnvironmentGroup(feature.id)),
      )
      .toEqual([])
    expect.soft(Object.keys(data.featureDescriptions)).toEqual(shownIds)
    expect.soft(Object.keys(data.results[SUBJECT] ?? {}).filter(isEnvironmentGroup)).toEqual([])
    expect.soft(Object.keys(data.results[SUBJECT] ?? {})).toHaveLength(shownIds.length)
    expect.soft(Object.keys(data.notes[SUBJECT] ?? {}).filter(isEnvironmentGroup)).toEqual([])
    expect.soft(Object.values(data.baselines).flat().filter(isEnvironmentGroup)).toEqual([])
    // The positions leave the lists only: each baseline's counts are the same fold over the full recorded ids.
    for (const [baseline, stat] of Object.entries(data.baselineStats[SUBJECT] ?? {})) {
      const recorded = catalogIds.filter((id) => catalog[id]?.baseline === baseline)
      expect.soft(stat, baseline).toEqual(baselineStat(SUBJECT, selected as never, recorded))
    }
  })

  it("config.ts: no sidebar or nav link reaches an environment feature page", () => {
    const sidebar = config.themeConfig?.sidebar as SidebarItem[]
    const nav = config.themeConfig?.nav as SidebarItem[]
    expect(links(sidebar).filter((link) => hiddenPages.has(link))).toEqual([])
    expect(links(nav).filter((link) => hiddenPages.has(link))).toEqual([])
    const device = sidebar.find((item) => item.text === "Categories")?.items?.find((item) => item.link === "/device")
    expect(device?.items).toHaveLength(shownIds.filter((id) => id.startsWith("device.")).length)
  })

  it("load-probes.ts: no tag page lists an environment position, and no tag exists only for one", () => {
    for (const tag of getAllTags()) {
      const ids = getFeaturesForTag(tag)
      expect(ids.filter(isEnvironmentGroup), tag).toEqual([])
      expect(ids.length, tag).toBeGreaterThan(0)
    }
    expect(getFeaturesForTag("iterm2")).toEqual(shownIds.filter((id) => catalog[id]?.tags?.includes("iterm2")))
    expect(getFeaturesForTag("kitty-extensions")).toEqual(
      shownIds.filter((id) => catalog[id]?.tags?.includes("kitty-extensions")),
    )
  })

  it("linkify-content.ts: no feature name links to an environment feature page", () => {
    const hrefs = loadTerminfoEntities().flatMap((entity) => (entity.href ? [entity.href] : []))
    expect(hrefs.filter((href) => hiddenPages.has(href))).toEqual([])
    expect(hrefs).toContain("/device/xtversion")
  })
})

describe("docs/public/_redirects (D4)", () => {
  const lines = readFileSync(join(root, "docs", "public", "_redirects"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(/\s+/))

  it("sends each hidden feature's page to its category page with one 301 line", () => {
    for (const id of hiddenIds) {
      const page = featurePageParams(id)
      const from = `/${page.category}/${page.id}`
      expect(
        lines.filter(([source]) => source === from),
        id,
      ).toEqual([[from, `/${page.category}`, "301"]])
    }
  })

  it("redirects no page that is still built", () => {
    const built = new Set(
      shownIds.map((id) => {
        const page = featurePageParams(id)
        return `/${page.category}/${page.id}`
      }),
    )
    expect(lines.filter(([source]) => source !== undefined && built.has(source))).toEqual([])
  })
})
