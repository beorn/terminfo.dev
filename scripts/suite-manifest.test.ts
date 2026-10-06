/**
 * @failure A suite declaration can be overwritten with new metadata or a wrong applicable probe set, and a bare or shared-main invocation can write a manifest no commit will take.
 * @level l1
 * @consumer Current probe suite manifest producer and deploy validation
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/ vendor/terminfo.dev/packages/probes/ vendor/terminfo.dev/packages/terminfo.dev/src/
 * @reach fs-walk <fixture-only: mkdtempSync Git repos prove the declare guard>
 * @testonly none
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { probeSuiteSnapshot } from "../packages/admin/versions.ts"
import {
  assertDeclareIsAuthoring,
  persistSuiteManifest,
  suiteManifestMode,
  verifySuiteManifest,
} from "./suite-manifest.ts"

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

/** A bare invocation may not declare: the write is behind an explicit verb (27843 AC2). */
test("only the explicit --write verb declares, and a bare invocation is usage", () => {
  expect(suiteManifestMode([])).toBe("usage")
  expect(suiteManifestMode(["--typo"])).toBe("usage")
  expect(suiteManifestMode(["--write", "extra"])).toBe("usage")
  expect(suiteManifestMode(["--check"])).toBe("check")
  expect(suiteManifestMode(["--write"])).toBe("write")
})

/** The stray manifests in shared main came from a declare on a commit origin/main already held. */
test("declaring refuses a checkout whose HEAD is already on origin/main and allows one that is not", () => {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-suite-manifest-git-"))
  temporaryPaths.push(directory)
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  git("init", "-q", "-b", "main")
  git("config", "user.email", "fixture@example.invalid")
  git("config", "user.name", "fixture")
  writeFileSync(join(directory, "a.txt"), "one\n")
  git("add", "a.txt")
  git("commit", "-q", "-m", "one")
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD").trim())

  expect(() => assertDeclareIsAuthoring(directory)).toThrow(/origin\/main/)

  writeFileSync(join(directory, "b.txt"), "two\n")
  git("add", "b.txt")
  git("commit", "-q", "-m", "two")
  expect(() => assertDeclareIsAuthoring(directory)).not.toThrow()
})
