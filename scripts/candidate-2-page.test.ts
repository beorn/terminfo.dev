/**
 * @failure The candidate-2 preview page could publish a fraction measured on an OLDER probe suite,
 *   claim capabilities the cohort does not include, divide over a basis no reader uses, name a row it
 *   never shows, or grow a second classifier beside the reader — each of which puts a number on a
 *   public page that `bun run decisive-share --cohort candidate2` does not print, on a surface whose
 *   whole claim is that the two agree.
 * @level l2
 * @consumer terminfo.dev /release/candidate-2 (bead 28018 AC4)
 * @source-grep the page and its loader are wired by text (the VitePress page imports its `.data`
 *   module and the nav names the route), so only a real site build exercises the render; every
 *   assertion below runs the loader itself against the real content tree.
 * @testonly none
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { loadCandidate2Data } from "../docs/data/candidate-2.data.ts"
import { inconclusiveRows } from "./decisive-share.ts"

const root = join(import.meta.dirname, "..")
const data = loadCandidate2Data()

/** The catalog of record: a page that labelled a row with its own id would disagree with this. */
function catalogNames(): Record<string, string> {
  const raw = JSON.parse(readFileSync(join(root, "content", "features.json"), "utf8")) as Record<
    string,
    string | { name?: string }
  >
  const names: Record<string, string> = {}
  for (const [id, entry] of Object.entries(raw)) {
    if (id.startsWith("$")) continue
    const name = typeof entry === "string" ? entry : entry.name
    if (name) names[id] = name
  }
  return names
}

describe("candidate-2 page: names come from the catalog, never from the id", () => {
  it("labels every rendered row with the catalog's own name", () => {
    const names = catalogNames()
    const rows = [...data.groups.flatMap((group) => group.capabilities), ...data.libraryOnly, ...data.unavailable]
    expect(rows.length).toBeGreaterThan(data.ratifiedCount)
    for (const row of rows) {
      expect(names[row.id], `${row.id} is missing from content/features.json`).toBeTruthy()
      expect(row.name, `${row.id} is labelled with something other than its catalog name`).toBe(names[row.id])
    }
  })
})

describe("candidate-2 page: publication rule (AC4)", () => {
  it("publishes a row exactly when its selected run sits on the frozen suite", () => {
    const published = data.contexts.filter((row) => row.published)
    const omitted = data.contexts.filter((row) => !row.published)
    // Both sides must be non-empty on the real tree, or the rule is never exercised either way.
    expect(published.length).toBeGreaterThan(0)
    expect(omitted.length).toBeGreaterThan(0)
    for (const row of published) {
      expect(row.suiteId, `${row.context} is published but names another suite`).toBe(data.frozenSuiteId)
      expect(row.reason, `${row.context} is published and must carry no refusal reason`).toBeNull()
      expect(row.denominator).toBe(data.scoredCount)
    }
    for (const row of omitted) {
      // The reader's own reason, never a silent zero: a stale or absent run is named, not scored.
      expect(row.reason, `${row.context} is omitted without a reason`).toBeTruthy()
      expect(row.suiteId).toBeNull()
      expect(row.groups).toEqual([])
      expect(row.decisive).toBe(0)
    }
  })

  it("never publishes the same context twice", () => {
    const keys = data.contexts.map((row) => row.context)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe("candidate-2 page: the two bases", () => {
  it("claims exactly the ratified cohort, split over the catalog's own groups", () => {
    const ids = data.groups.flatMap((group) => group.capabilities.map((row) => row.id))
    expect(ids.length).toBe(data.ratifiedCount)
    expect(new Set(ids).size).toBe(data.ratifiedCount)
    for (const group of data.groups) {
      for (const row of group.capabilities) {
        expect(row.id.split(".")[0], `${row.id} is filed under ${group.key}`).toBe(group.key)
      }
    }
  })

  it("divides every per-group fraction over the ids the suite covers, and names the rest", () => {
    const denominators = data.groups.reduce((count, group) => count + group.denominator, 0)
    expect(denominators).toBe(data.decidableCount)
    for (const group of data.groups) {
      const named = [...group.libraryOnly, ...group.unavailable].map((row) => row.id)
      const shown = group.capabilities.map((row) => row.id)
      expect(group.denominator).toBe(shown.length - named.length)
      for (const id of named) expect(shown).toContain(id)
    }
  })

  it("names every moved-out row in the page's own lists, with none left over or double-counted", () => {
    const named = new Set([...data.libraryOnly, ...data.unavailable].map((row) => row.id))
    const grouped = new Set(
      data.groups.flatMap((group) => [...group.libraryOnly, ...group.unavailable].map((row) => row.id)),
    )
    expect(grouped).toEqual(named)
    expect(named.size).toBeGreaterThan(0)
  })

  it("keeps every published row's group denominators equal to the page's own, and its buckets whole", () => {
    const expected = data.groups.map((group) => `${group.key}:${group.denominator}`)
    for (const row of data.contexts.filter((entry) => entry.published)) {
      expect(
        row.groups.map((group) => `${group.key}:${group.denominator}`),
        row.context,
      ).toEqual(expected)
      // The three buckets the row prints must partition its denominator exactly; a row that lost a
      // cell, or counted one twice, would otherwise read as a share the reader never computed.
      expect(row.decisive + row.inconclusive.length + row.remainder.length, row.context).toBe(row.denominator)
      for (const group of row.groups) {
        expect(group.decisive + group.inconclusive.length).toBeLessThanOrEqual(group.denominator)
      }
    }
  })
})

describe("candidate-2 page: the reader stays the one classifier", () => {
  it("takes its report and its rows from scripts/decisive-share.ts, never a private copy", () => {
    const loader = readFileSync(join(root, "docs", "data", "candidate-2.data.ts"), "utf8")
    expect(loader).toContain('from "../../scripts/decisive-share.ts"')
    for (const symbol of ["buildReport", "cohortCategories", "categoryShares", "inconclusiveRows"]) {
      expect(loader, `loader must reuse the reader's ${symbol}`).toContain(symbol)
    }
  })

  it("carries every inconclusive row's own words, and refuses a row with no cell", () => {
    for (const row of data.contexts.filter((entry) => entry.published)) {
      for (const entry of row.inconclusive) expect(entry.featureId).toBeTruthy()
    }
    expect(() => inconclusiveRows({}, { inconclusiveIds: ["sgr.bold"] } as never)).toThrow(/no cell/)
  })
})

describe("candidate-2 page: wiring", () => {
  it("the VitePress page reads its loader, and the nav names the route", () => {
    const page = readFileSync(join(root, "docs", "release", "candidate-2.md"), "utf8")
    expect(page).toContain("from '../data/candidate-2.data'")
    expect(page).toContain("terminfo v0.1 candidate 2")
    // The basis and the suite come from the loader: a literal hash typed into the page would be stale
    // the moment the declaration moves, which is the churn the epic already ruled against.
    expect(page).not.toMatch(/\b[0-9a-f]{12}\b/)
    const config = readFileSync(join(root, "docs", ".vitepress", "config.ts"), "utf8")
    expect(config).toContain('"/release/candidate-2"')
  })
})
