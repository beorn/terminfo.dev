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
import { DESIGN_EXCLUSION_IDS, MISSING_DEFINITION_IDS } from "../docs/data/full-scope.ts"

const root = join(import.meta.dirname, "..")
const data = loadFullProjectData()

describe("the full-273 preview", () => {
  it("covers all 273 catalog rows over all 33 expected contexts", () => {
    expect(data.catalogRows).toBe(273)
    expect(data.contexts).toHaveLength(33)
    expect(data.collected + data.notCollected).toBe(33)
  })

  it("prints S/D and D/N together for every collected context", () => {
    for (const row of data.contexts) {
      if (!row.collected) continue
      const { result } = row
      expect(result.catalogRows).toBe(273)
      expect(result.fraction).toBe(`${result.decisive}/${result.denominator}`)
      expect(result.ceiling).toBe(`${result.denominator}/273`)
      expect(result.included).toBe(result.pct >= 90)
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

  it("names the design exclusions and keeps the missing definitions in the denominator", () => {
    expect(data.designExclusions).toEqual([...DESIGN_EXCLUSION_IDS])
    expect(data.designExclusions).toHaveLength(13)
    expect(data.missingDefinitions).toEqual([...MISSING_DEFINITION_IDS])
    expect(data.missingDefinitions).toHaveLength(1)
    for (const row of data.contexts) {
      if (!row.collected) continue
      expect(row.result.denominator).toBe(data.catalogRows - row.result.excluded.length)
      for (const id of data.missingDefinitions) {
        expect(row.result.excluded.map((entry) => entry.id)).not.toContain(id)
        expect(row.result.missingDefinitions).toContain(id)
      }
    }
  })

  it("lets every collected row reach its run's evidence through the established evidence cell", () => {
    for (const row of data.contexts) {
      if (!row.collected) continue
      const version = data.evidenceVersions[row.context]
      expect(version?.runId).toBe(row.run.runId)
      expect(version?.sha256).toBeTruthy()
      for (const observation of row.observations) {
        if (observation.state === "untested") continue
        expect(version?.cells[observation.id], `${row.context} ${observation.id}`).toBeDefined()
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
