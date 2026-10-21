/**
 * @failure The full-scope preview could print a context with no evidence as zero percent or as
 *   included, hide a context it cannot score, drop catalog rows from the basis, or disagree with the
 *   one arithmetic owner about S/D and D/N — each of which turns an honest incomplete development
 *   state into a claim the admitted pass has not made.
 * @level l2
 * @consumer terminfo.dev /release/full-273 (step 7 private development preview)
 * @source-grep the page is wired by text (its data import and its unadmitted warning), so only a
 *   site build exercises the render; every assertion here runs the real loader and its rows.
 * @testonly none
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { loadFullProjectData } from "../docs/data/full-project.data.ts"

const root = join(import.meta.dirname, "..")
const data = loadFullProjectData()

describe("the full-273 preview", () => {
  it("covers all 273 catalog rows over all 33 expected contexts", () => {
    expect(data.catalogRows).toBe(273)
    expect(data.contexts).toHaveLength(33)
    expect(data.collected + data.notCollected).toBe(33)
  })

  it("prints Supported over all 273 and finishes only at zero TODO/failure", () => {
    for (const row of data.contexts) {
      if (!row.collected) continue
      const { result } = row
      expect(result.catalogRows).toBe(273)
      expect(result.denominator).toBe(273)
      expect(result.fraction).toBe(`${result.supported}/273`)
      expect(result.complete).toBe(result.counts["test-todo"] === 0 && result.counts["test-failure"] === 0)
      expect(result.groups.reduce((sum, group) => sum + group.catalogRows, 0)).toBe(273)
    }
  })

  it("never scores a context it could not collect", () => {
    for (const row of data.contexts) {
      if (row.collected) continue
      expect(row.cause.trim()).not.toBe("")
      expect("result" in row).toBe(false)
    }
  })

  it("keeps an all-history corpus incomplete without inventing a current score", () => {
    expect(data.collected).toBe(0)
    expect(data.notCollected).toBe(33)
    expect(data.recordedPositions).toBe(0)
    expect(data.complete).toBe(false)
    expect(data.evidenceVersions).toEqual({})
  })

  it("lets every collected row reach its run's evidence through the established evidence cell", () => {
    for (const row of data.contexts) {
      if (!row.collected) continue
      const version = data.evidenceVersions[row.context]
      expect(version?.runId).toBe(row.run.runId)
      expect(version?.sha256).toBeTruthy()
      for (const observation of row.observations) {
        expect(
          version?.results.find((result) => result.featureId === observation.id),
          `${row.context} ${observation.id}`,
        ).toBeDefined()
      }
    }
    const page = readFileSync(join(root, "docs", "release", "full-273.md"), "utf8")
    expect(page).toContain("<ResultEvidenceCell")
    expect(page).toContain("data.evidenceVersions[row.context]")
  })

  it("renders both the observation note and its named limitation", () => {
    const page = readFileSync(join(root, "docs", "release", "full-273.md"), "utf8")
    expect(page).toContain("observation.note")
    expect(page).toContain("observation.reason")
    expect(page).toContain("limitation:")
  })

  it("keeps the whole reading labelled development and unadmitted", () => {
    expect(data.mode).toBe("development")
    const page = readFileSync(join(root, "docs", "release", "full-273.md"), "utf8")
    expect(page).toContain("import { data } from '../data/full-project.data'")
    expect(page).toContain("Development reading")
    expect(page).toContain("NOT COLLECTED")
  })
})
