/**
 * @failure A run can be admitted against a suite this tree does not run, so its manifest is computed from the wrong probe-defs; or a concurrent admission of the same run can overwrite different bytes; or the run can be misnamed.
 * @level l1
 * @consumer The one declare-and-admit entry point (27859)
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/ vendor/terminfo.dev/packages/probes/
 * @reach fs-walk <fixture-only: mkdtempSync run and destination directories>
 * @testonly none
 */
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { probeSuiteSnapshot } from "../packages/admin/versions.ts"
import { admitRun, placeRun, placeScreenshots, planAdmission } from "./admit-run.ts"

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

/**
 * 27876: admission copied the run document but silently dropped the screenshots it cites, so
 * consumer-selection failed with "missing screenshot artifact" on main. The cited PNGs live in
 * `artifacts/` beside the run file; admission must carry them, or refuse by name.
 */
test("admission carries every screenshot the run cites, and refuses a missing or mismatched one", () => {
  const source = join(temp("terminfo-admit-shots-"), "run.json")
  const content = temp("terminfo-admit-content-")
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("pixels")])
  const digest = createHash("sha256").update(png).digest("hex")
  const ref = `sha256:${digest}`
  mkdirSync(join(source, "..", "artifacts"), { recursive: true })
  writeFileSync(join(source, "..", "artifacts", `${digest}.png`), png)

  expect(placeScreenshots(source, [ref], content)).toEqual({ created: 1, existing: 0 })
  expect(readFileSync(join(content, "artifacts", `${digest}.png`))).toEqual(png)
  expect(placeScreenshots(source, [ref], content)).toEqual({ created: 0, existing: 1 })

  const absent = `sha256:${"a".repeat(64)}`
  expect(() => placeScreenshots(source, [absent], content)).toThrow(/does not exist beside the run/)
  const wrong = digest.slice(0, 63) + (digest[63] === "a" ? "b" : "a")
  writeFileSync(join(source, "..", "artifacts", `${wrong}.png`), png)
  expect(() => placeScreenshots(source, [`sha256:${wrong}`], content)).toThrow(/hashes to/)

  const notPng = Buffer.from("not a png at all")
  const notPngDigest = createHash("sha256").update(notPng).digest("hex")
  writeFileSync(join(source, "..", "artifacts", `${notPngDigest}.png`), notPng)
  expect(() => placeScreenshots(source, [`sha256:${notPngDigest}`], content)).toThrow(/is not a PNG/)
})
