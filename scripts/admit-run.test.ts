/**
 * @failure A run can be admitted against a suite this tree does not run, so its manifest is computed from the wrong probe-defs; or a concurrent admission of the same run can overwrite different bytes; or the run can be misnamed.
 * @level l1
 * @consumer The one declare-and-admit entry point (27859)
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/ vendor/terminfo.dev/packages/probes/
 * @reach fs-walk <fixture-only: mkdtempSync run and destination directories>
 * @testonly none
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { probeSuiteSnapshot } from "../packages/admin/versions.ts"
import { admitRun, placeRun, planAdmission } from "./admit-run.ts"

const temporaryPaths: string[] = []
afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true })
})
const temp = (prefix: string): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryPaths.push(directory)
  return directory
}

function runFixture(overrides: Record<string, unknown> = {}): string {
  const directory = temp("terminfo-admit-")
  const path = join(directory, "run.json")
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 2,
      probeHash: probeSuiteSnapshot().probeHash,
      runId: "run1",
      target: { kind: "app", id: "kitty", version: "0.49.2", os: "linux" },
      ...overrides,
    }),
  )
  return path
}

test("a run is named from its own target and run id", () => {
  const into = join(temp("terminfo-admit-dest-"), "out.json")
  const plan = planAdmission(runFixture(), into)
  expect(plan.destination).toBe(into)
  expect(plan.target).toEqual({ kind: "app", id: "kitty", version: "0.49.2", os: "linux" })
  const defaultPlan = planAdmission(runFixture())
  expect(defaultPlan.destination.endsWith("content/probes-apps/kitty-0.49.2-linux-run1.json")).toBe(true)
})

test("a run with an unsafe filename component refuses", () => {
  expect(() => planAdmission(runFixture({ target: { kind: "app", id: "kit/ty", version: "1", os: "linux" } }))).toThrow(
    /unsafe target.id/,
  )
})

test("a run that is not schema v2 refuses", () => {
  expect(() => planAdmission(runFixture({ schemaVersion: 1 }))).toThrow(/not schema v2/)
})

/**
 * Condition 1: a manifest is computed only from the run's OWN suite. A run from another suite must
 * refuse by name, before any write, rather than compute `probes` from this tree's probe-defs.
 */
test("admission refuses a run whose suite this tree does not run", () => {
  const plan = planAdmission(runFixture())
  const foreign = { ...plan, probeHash: "f".repeat(12) }
  expect(() => admitRun(foreign)).toThrow(/Admit from a tree at the run's suite/)
})

/** Concurrent admission of the same run is success; different bytes at the same name are loud. */
test("placing a run is exclusive and idempotent, and never overwrites different bytes", () => {
  const destination = join(temp("terminfo-admit-place-"), "kitty.json")
  expect(placeRun(destination, "one\n")).toBe("created")
  expect(readFileSync(destination, "utf8")).toBe("one\n")
  expect(placeRun(destination, "one\n")).toBe("existing")
  expect(() => placeRun(destination, "two\n")).toThrow(/Refusing to overwrite/)
})
