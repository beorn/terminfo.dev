/**
 * @failure A site build writes into its read-only landing, or its client loader recomputes the corpus instead of reading that build's prepared probe data.
 * @level l2
 * @consumer The terminfo-site resident's landed serve and `bun run build`.
 * @testonly none
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { describe, expect, it, vi } from "vitest"
import {
  siteAnalysisPath,
  siteCacheDir,
  siteDistDir,
  siteOutRoot,
  siteRebuildMarkerPath,
  siteTempDir,
  writeSiteRebuildMarker,
} from "./site-out.ts"

const repoRoot = join(import.meta.dirname, "..")

it("resolves the historical in-tree paths when TERMINFO_SITE_OUT_DIR is unset", () => {
  const env: NodeJS.ProcessEnv = {}
  expect(siteOutRoot(env)).toBeUndefined()
  expect(siteDistDir(repoRoot, env)).toBe(join(repoRoot, "docs", ".vitepress", "dist"))
  expect(siteCacheDir(env)).toBeUndefined()
  expect(siteTempDir(env)).toBeUndefined()
  expect(siteAnalysisPath(repoRoot, env)).toBe(join(repoRoot, "content", "analysis.json"))
})

it("roots every build write under TERMINFO_SITE_OUT_DIR when it is set", () => {
  const env: NodeJS.ProcessEnv = { TERMINFO_SITE_OUT_DIR: "/var/terminfo-site" }
  expect(siteOutRoot(env)).toBe("/var/terminfo-site")
  expect(siteDistDir(repoRoot, env)).toBe(join("/var/terminfo-site", "dist"))
  expect(siteCacheDir(env)).toBe(join("/var/terminfo-site", "cache"))
  expect(siteTempDir(env)).toBe(join("/var/terminfo-site", "temp"))
  expect(siteAnalysisPath(repoRoot, env)).toBe(join("/var/terminfo-site", "content", "analysis.json"))
})

it("the client loader reads only its own landing's prepared probe data", async () => {
  // AC1: analysis-path tests cannot detect VitePress recomputing the expensive corpus.
  const directory = mkdtempSync(join(tmpdir(), "terminfo-client-probes-"))
  const first = join(directory, "first")
  const second = join(directory, "second")
  const sourceCommit = "a".repeat(40)
  vi.doMock("../docs/data/current-results.ts", async (original) => ({
    ...(await original<typeof import("../docs/data/current-results.ts")>()),
    loadCurrentResults() {
      throw new Error("client loader requested corpus after pre-build")
    },
  }))
  vi.doMock("./build-metadata.ts", () => ({ createBuildMetadata: () => ({ sourceCommit }) }))
  vi.resetModules()
  try {
    for (const [root, generated] of [
      [first, "first landing"],
      [second, "second landing"],
    ]) {
      mkdirSync(join(root!, "content"), { recursive: true })
      writeFileSync(join(root!, "content", "probes.json"), JSON.stringify({ sourceCommit, data: { generated } }))
    }
    const loader = (await import("../docs/data/probes.data.ts")).default
    vi.stubEnv("TERMINFO_SITE_OUT_DIR", first)
    expect(loader.load()).toEqual({ generated: "first landing" })
    vi.stubEnv("TERMINFO_SITE_OUT_DIR", second)
    expect(loader.load()).toEqual({ generated: "second landing" })
    const path = join(second, "content", "probes.json")
    writeFileSync(path, JSON.stringify({ sourceCommit: "b".repeat(40), data: { generated: "stale" } }))
    expect(() => loader.load()).toThrow(/probes\.json/)
    writeFileSync(path, "{")
    expect(() => loader.load()).toThrow(/probes\.json/)
    rmSync(path)
    expect(() => loader.load()).toThrow(/probes\.json/)
  } finally {
    vi.unstubAllEnvs()
    vi.doUnmock("../docs/data/current-results.ts")
    vi.doUnmock("./build-metadata.ts")
    vi.resetModules()
    // raw-delete-allow: only this test's own mkdtemp fixture; standalone CI has no removely dependency.
    rmSync(directory, { recursive: true, force: true })
  }
})

it("analysis generation writes under the override and leaves the source tree alone", () => {
  // 28268 AC4: a landing is write-once, so the analysis step must not write content/analysis.json in its checkout.
  const out = mkdtempSync(join(tmpdir(), "terminfo-site-out-"))
  const writeRoot = join(out, "state-root")
  try {
    const sourceRoot = join(import.meta.dirname, "..")
    mkdirSync(join(out, "scripts"))
    mkdirSync(join(out, "content"))
    for (const dir of ["probes-apps", "probes-mux", "probes-libs"]) mkdirSync(join(out, "content", dir))
    for (const dir of ["docs", "node_modules"]) symlinkSync(join(sourceRoot, dir), join(out, dir), "dir")
    for (const name of [
      "features",
      "terminals",
      "categories",
      "standards",
      "baselines",
      "frameworks",
      "glossary",
      "annotations",
    ]) {
      cpSync(join(sourceRoot, "content", `${name}.json`), join(out, "content", `${name}.json`))
    }
    cpSync(join(sourceRoot, "content", "suites"), join(out, "content", "suites"), { recursive: true })
    cpSync(join(sourceRoot, "content", "archived-exclusions.json"), join(out, "content", "archived-exclusions.json"))
    for (const name of ["generate-analysis.ts", "site-out.ts"]) {
      cpSync(join(sourceRoot, "scripts", name), join(out, "scripts", name))
    }
    const result = spawnSync(process.execPath, [join(out, "scripts", "generate-analysis.ts")], {
      cwd: out,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, TERMINFO_SITE_OUT_DIR: writeRoot },
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    const redirected = join(writeRoot, "content", "analysis.json")
    expect(existsSync(redirected)).toBe(true)
    expect(existsSync(join(out, "content", "analysis.json"))).toBe(false)
    expect(JSON.parse(readFileSync(redirected, "utf8"))).toHaveProperty("terminals/kitty")
  } finally {
    // raw-delete-allow: standalone component repository whose CI installs without hh's workspace, so removely is
    // unavailable; `out` is this test's own mkdtemp scratch root
    rmSync(out, { recursive: true, force: true })
  }
})

it("the rebuild marker path is undefined with no state root and lives at the write root otherwise", () => {
  expect(siteRebuildMarkerPath({})).toBeUndefined()
  expect(siteRebuildMarkerPath({ TERMINFO_SITE_OUT_DIR: "/var/terminfo-site" })).toBe(
    join("/var/terminfo-site", "rebuild.json"),
  )
})

it("the rebuild marker names the target revision and clears only via the returned action (28268 AC4)", () => {
  const root = mkdtempSync(join(tmpdir(), "terminfo-site-marker-"))
  try {
    // No state root: nothing is written, so a bare developer checkout is unchanged.
    expect(writeSiteRebuildMarker("a".repeat(40), {})).toBeUndefined()

    const env: NodeJS.ProcessEnv = { TERMINFO_SITE_OUT_DIR: root }
    const clear = writeSiteRebuildMarker("a".repeat(40), env)
    const path = join(root, "rebuild.json")
    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      schema: "terminfo-site-rebuild/1",
      target: "a".repeat(40),
    })
    clear?.()
    expect(existsSync(path)).toBe(false)
    // Clearing twice is a no-op, never a throw: the caller may exit between the two.
    expect(() => clear?.()).not.toThrow()
  } finally {
    // raw-delete-allow: standalone component repository whose CI installs without hh's workspace, so removely is
    // unavailable; `root` is this test's own mkdtemp scratch root
    rmSync(root, { recursive: true, force: true })
  }
})

it("writes the marker into a state root that does not exist yet (first start, 28268 AC4)", () => {
  // The unit's FIRST start writes the marker before the first build, and nothing creates the state root
  // (/hh/var/terminfo-site did not exist). A missing root must not throw ENOENT here, or the unit restart-loops
  // before it ever builds (@cto 0dc097ac).
  const parent = mkdtempSync(join(tmpdir(), "terminfo-site-marker-absent-"))
  const root = join(parent, "not-yet-created")
  try {
    expect(existsSync(root)).toBe(false)
    const clear = writeSiteRebuildMarker("b".repeat(40), { TERMINFO_SITE_OUT_DIR: root })
    const path = join(root, "rebuild.json")
    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      schema: "terminfo-site-rebuild/1",
      target: "b".repeat(40),
    })
    clear?.()
    expect(existsSync(path)).toBe(false)
  } finally {
    // raw-delete-allow: standalone component repository whose CI installs without hh's workspace, so removely is
    // unavailable; `parent` is this test's own mkdtemp scratch root
    rmSync(parent, { recursive: true, force: true })
  }
})
