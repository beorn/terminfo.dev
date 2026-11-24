/**
 * #37761 (operator, via @cpo/term): what the shared bar rows read, over the real published data.
 * - "(term)" is the default kind and is never printed; a non-default kind is named only beside an app of the same id.
 * - Beside its platform icon a name never repeats the platform in words (shortLabel); plain text still tells two
 *   platforms of one app apart (label).
 * - An app row never carries the facts of the headless library that shares its id (Ghostty's is ghostty-web wasm).
 * - The popover's tab counts are the bar's own fold, so a tab and its segment can never disagree.
 */
import { describe, expect, it } from "vitest"
import { loadFullProbes } from "../docs/data/probes.data.ts"
import { RESULT_CATEGORIES, categoryIds, categoryIdsWithin } from "../docs/data/result-categories.ts"

const data = loadFullProbes()
const subject = (key: string) => data.selectedByBackend[key]!.selected.subject!

describe("bar row names (#37761 items 2-4)", () => {
  it("never prints the default kind", () => {
    const named = Object.entries(data.meta).flatMap(([key, meta]) =>
      [meta.label, meta.shortLabel].filter((name) => name?.includes("(term)")).map((name) => `${key}: ${name}`),
    )
    expect(named).toEqual([])
  })

  it("keeps the platform out of the short name and in the plain-text name when two platforms share a page", () => {
    const byRoute = new Map<string, string[]>()
    for (const key of Object.keys(data.selectedByBackend)) {
      const slug = data.meta[key]?.slug ?? key
      byRoute.set(slug, [...(byRoute.get(slug) ?? []), key])
    }
    const shared = [...byRoute.values()].filter((keys) => keys.length > 1)
    expect(shared.length, "the published data has an app measured on two platforms (Ghostty)").toBeGreaterThan(0)
    for (const keys of shared) {
      const short = new Set(keys.map((key) => data.meta[key]!.shortLabel))
      const labels = new Set(keys.map((key) => data.meta[key]!.label))
      expect(short.size, `${keys.join(", ")} share one short name`).toBe(1)
      expect(labels.size, `${keys.join(", ")} differ in plain text`).toBe(keys.length)
      for (const key of keys) expect(data.meta[key]!.shortLabel).not.toMatch(/\((macOS|Linux|Windows)\)/u)
    }
  })

  it("names a library kind only where an app shares its id", () => {
    const appIds = new Set(
      Object.keys(data.selectedByBackend).flatMap((key) => (subject(key).kind === "term" ? [subject(key).id] : [])),
    )
    for (const key of Object.keys(data.selectedByBackend)) {
      const { id, kind } = subject(key)
      if (kind !== "term" && appIds.has(id)) {
        const meta = data.meta[key]!
        const apps = Object.keys(data.selectedByBackend).filter(
          (k) => subject(k).id === id && subject(k).kind === "term",
        )
        for (const app of apps) expect(meta.label, `${key} vs ${app}`).not.toBe(data.meta[app]!.label)
      }
    }
  })

  it("gives an app row the app's facts, not the headless library's of the same id (item 10)", () => {
    const leaked = Object.keys(data.selectedByBackend).flatMap((key) => {
      if (subject(key).kind === "lib") return []
      const meta = data.meta[key]!
      return [meta.upstream, meta.type].some((value) => value !== undefined)
        ? [`${key}: ${meta.upstream} ${meta.type}`]
        : []
    })
    expect(leaked).toEqual([])
  })
})

describe("bar categories (#37761 items 6-7)", () => {
  it("counts every tab from the bar's own fold", () => {
    for (const [key, bar] of Object.entries(data.releaseBars)) {
      const ids = categoryIds(bar)
      expect(ids.supported.length, key).toBe(bar.counts.supported)
      expect(ids.unsupported.length, key).toBe(bar.counts.unsupported)
      expect(ids.untestable.length, key).toBe(bar.counts.untestable)
      const total = RESULT_CATEGORIES.reduce((sum, category) => sum + ids[category.id].length, 0)
      expect(total, `${key}: the tabs cover every graded position`).toBe(bar.denominator)
    }
  })

  it("limits a Baseline card to its own features, an unmeasured one reading No result yet", () => {
    const noResult = RESULT_CATEGORIES.find((category) => category.id === "no-result")
    expect(noResult?.meaning).toBe("Our test could not read a result here yet.")
    expect(noResult?.meaning).not.toMatch(/probe-todo|probe-invalid|haven't run/i)
    for (const [baseline, features] of Object.entries(data.baselines)) {
      for (const [key, bar] of Object.entries(data.releaseBars)) {
        const ids = categoryIdsWithin(bar, features)
        const total = RESULT_CATEGORIES.reduce((sum, category) => sum + ids[category.id].length, 0)
        expect(total, `${key} ${baseline}`).toBe(features.length)
        for (const category of RESULT_CATEGORIES) for (const id of ids[category.id]) expect(features).toContain(id)
      }
    }
  })
})
