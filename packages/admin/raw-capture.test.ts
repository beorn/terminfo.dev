/**
 * @failure The preview site and the admin report each grow their own raw-capture parser, so one accepts a draft the
 *   other refuses; or a missing, malformed or unknown-suite capture is skipped silently instead of failing loudly.
 * @level l2
 * @consumer packages/admin/src/report.ts (raw scoreboard) and docs/data/working-runs.ts (hourly preview view)
 * @source-grep no earlier test named the shared reader: the report test proves the happy path through it, these prove
 *   its refusals and that both consumers call it rather than parseRun in capture mode.
 * @testonly none
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { loadRawCapture } from "./raw-capture.ts"
import { probeSuiteSnapshot } from "./versions.ts"

const REPO = join(import.meta.dirname, "..", "..")

function scratchRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "terminfo-raw-capture-"))
  mkdirSync(join(root, "content", "suites"), { recursive: true })
  return root
}

describe("loadRawCapture: the one raw-capture reader fails loudly", () => {
  it("refuses a missing capture by path", () => {
    const root = scratchRoot()
    const path = join(root, "absent.draft.json")
    expect(() => loadRawCapture(path, { root, catalogIds: [] })).toThrow(`${path}: cannot read raw capture`)
  })

  it("refuses malformed JSON by path", () => {
    const root = scratchRoot()
    const path = join(root, "broken.draft.json")
    writeFileSync(path, "{ not json")
    expect(() => loadRawCapture(path, { root, catalogIds: [] })).toThrow(path)
  })

  it("refuses a header without its run identity", () => {
    const root = scratchRoot()
    const path = join(root, "anonymous.draft.json")
    writeFileSync(path, JSON.stringify({ probeHash: "000000000000" }))
    expect(() => loadRawCapture(path, { root, catalogIds: [] })).toThrow(
      "a raw capture requires runId, probeHash and sourceRevision",
    )
  })

  it("refuses a suite with no committed manifest that is not this tree's suite", () => {
    const root = scratchRoot()
    const path = join(root, "foreign.draft.json")
    writeFileSync(
      path,
      JSON.stringify({ runId: "r", probeHash: "000000000000", suiteId: "000000000000", sourceRevision: "s" }),
    )
    expect(() => loadRawCapture(path, { root, catalogIds: [] })).toThrow("suite 000000000000 has no committed manifest")
  })

  it("refuses a capture whose suiteId disagrees with its trusted manifest", () => {
    const root = scratchRoot()
    const tree = probeSuiteSnapshot().probeHash
    const path = join(root, "mislabelled.draft.json")
    writeFileSync(path, JSON.stringify({ runId: "r", probeHash: tree, suiteId: "ffffffffffff", sourceRevision: "s" }))
    expect(() => loadRawCapture(path, { root, catalogIds: [] })).toThrow(`suiteId disagrees with manifest ${tree}`)
  })

  it("reads retained run and probe history against the producer manifest after the executable suite changes", () => {
    const root = scratchRoot()
    const path = join(root, "historical.draft.json")
    const bytes = readFileSync(
      join(REPO, "content/probes-libs/vterm-0.10.1-linux-a22f06ca-2505-4c0d-a518-b0b01f8bbe76.json"),
      "utf8",
    )
    const header = JSON.parse(bytes) as { probeHash: string }
    expect(header.probeHash).not.toBe(probeSuiteSnapshot().probeHash)
    writeFileSync(path, bytes)
    const baseline = loadRawCapture(path, { root: REPO, catalogIds: [] })
    mkdirSync(join(root, "suites"))
    const manifestPath = join(root, "suites", `${header.probeHash}.json`)
    writeFileSync(manifestPath, readFileSync(join(REPO, "content", "suites", `${header.probeHash}.json`)))
    expect(() => loadRawCapture(path, { root, catalogIds: [] })).toThrow("has no committed manifest")
    const options = { root, catalogIds: [], manifestPath }
    const historical = loadRawCapture(path, options)
    expect(historical.runId).toBe(baseline.runId)
    expect(historical.results).toEqual(baseline.results)
    expect(historical.assertions).toEqual(baseline.assertions)
    expect(historical.catalogIds).toEqual(baseline.catalogIds)
    expect(readFileSync(path, "utf8")).toBe(bytes)
    expect(() =>
      loadRawCapture(path, { ...options, bytes: JSON.stringify({ ...JSON.parse(bytes), suiteId: "ffffffffffff" }) }),
    ).toThrow(`suiteId disagrees with manifest ${header.probeHash}`)
    const retainedManifest = readFileSync(manifestPath, "utf8")
    const absentPath = join(root, "absent", `${header.probeHash}.json`)
    expect(() => loadRawCapture(path, { root: REPO, catalogIds: [], manifestPath: absentPath })).toThrow(absentPath)
    for (const invalid of [
      "{ invalid JSON",
      JSON.stringify({ ...JSON.parse(retainedManifest), probeHash: "ffffffffffff" }),
      JSON.stringify({ ...JSON.parse(retainedManifest), schemaVersion: 5 }),
    ]) {
      writeFileSync(manifestPath, invalid)
      expect(() => loadRawCapture(path, { root: REPO, catalogIds: [], manifestPath })).toThrow(manifestPath)
    }
  })

  it("is the only raw-capture parser both consumers use", () => {
    for (const consumer of ["packages/admin/src/report.ts", "docs/data/working-runs.ts"]) {
      const source = readFileSync(join(REPO, consumer), "utf8")
      expect(source, consumer).toMatch(
        /import \{[^}]*\bloadRawCapture\b[^}]*\} from "[./]*(?:packages\/admin\/)?raw-capture\.ts"/,
      )
      expect(source, consumer).not.toContain('mode: "capture"')
    }
  })
})
