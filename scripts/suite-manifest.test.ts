/**
 * @failure A suite declaration can be overwritten with new metadata or a wrong applicable probe set.
 * @level l1
 * @consumer Current probe suite manifest producer and deploy validation
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/ vendor/terminfo.dev/packages/probes/ vendor/terminfo.dev/packages/terminfo.dev/src/
 * @testonly none
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { probeSuiteSnapshot } from "../packages/admin/versions.ts"
import { persistSuiteManifest, verifySuiteManifest } from "./suite-manifest.ts"

const temporaryPaths: string[] = []
afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true })
})

test("a same-hash declaration stays immutable and mismatched membership fails loudly", () => {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-suite-manifest-"))
  temporaryPaths.push(directory)
  const snapshot = probeSuiteSnapshot()
  const path = join(directory, `${snapshot.probeHash}.json`)
  const first = {
    probeHash: snapshot.probeHash,
    sourceRevision: "a".repeat(40),
    generatedAt: "2026-09-28T00:00:00.000Z",
    adapterVersion: snapshot.adapterVersion,
    probes: snapshot.probes,
  }
  expect(persistSuiteManifest(path, first, snapshot)).toBe("created")
  const originalBytes = readFileSync(path, "utf8")
  const later = { ...first, sourceRevision: "b".repeat(40), generatedAt: "2026-09-29T00:00:00.000Z" }
  expect(persistSuiteManifest(path, later, snapshot)).toBe("existing")
  expect(readFileSync(path, "utf8")).toBe(originalBytes)
  expect(verifySuiteManifest(path, snapshot)).toEqual(first)

  writeFileSync(
    path,
    JSON.stringify({ ...first, probes: { ...first.probes, headless: first.probes.headless.slice(1) } }),
  )
  expect(() => persistSuiteManifest(path, later, snapshot)).toThrow(/headless|membership/)
})
