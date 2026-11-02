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
