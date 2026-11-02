/**
 * @failure The preview 404s or 500s every clean URL the site links to (`cleanUrls: true`), so the operator's click on a baseline chip lands on a broken page (30757).
 * @level l2
 * @consumer The `terminfo-site` resident's `landed-serve`, and every preview link the operator clicks.
 * @testonly none
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createPreviewHandler,
  createRunRebuilder,
  readServedStamp,
  rebuildForRun,
  rebuildReason,
  resolveServedPath,
} from "./landed-serve.ts"

let dist: string

function page(relativePath: string, body: string): void {
  const target = join(dist, relativePath)
  mkdirSync(join(target, ".."), { recursive: true })
  writeFileSync(target, body)
}

beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), "landed-serve-"))
  page("index.html", "home-page")
  page("404.html", "not-found-page")
  page("features.html", "features-page")
  page("baseline/core.html", "core-page")
  // A clean page and a same-named directory coexist (VitePress makes `cursor.html` beside `cursor/`).
  page("cursor.html", "cursor-page")
  page("cursor/sub.html", "cursor-sub-page")
  // A directory with no index at all is the shape that used to answer 500.
  mkdirSync(join(dist, "folderonly"), { recursive: true })
})

afterEach(() => {
  // raw-delete-allow: standalone component repository whose CI installs without hh's workspace, so removely is unavailable; dist is this test's own mkdtemp scratch root
  rmSync(dist, { recursive: true, force: true })
})

function get(path: string, init?: RequestInit): Response {
  return createPreviewHandler(dist)(new Request(`http://preview.test${path}`, init))
}

describe("landed-serve clean URLs", () => {
  it("AC1: serves <path>.html for an extensionless page", async () => {
    const response = get("/features")
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("features-page")
  })

  it("AC1: serves a nested clean URL", async () => {
    const response = get("/baseline/core")
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("core-page")
  })

  it("AC1: <path>.html wins over a same-named directory", async () => {
    const response = get("/cursor")
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("cursor-page")
  })

  it("AC2: an unknown path is 404 with the not-found page", async () => {
    const response = get("/nope")
    expect(response.status).toBe(404)
    expect(await response.text()).toBe("not-found-page")
  })

  it("AC3: a directory without index.html is 404, not 500", async () => {
    const response = get("/folderonly")
    expect(response.status).toBe(404)
    expect(await response.text()).toBe("not-found-page")
  })

  it("still serves an exact file, the root, and an explicit .html path", async () => {
    expect(await get("/").text()).toBe("home-page")
    expect(await get("/features.html").text()).toBe("features-page")
    expect(await get("/cursor/sub.html").text()).toBe("cursor-sub-page")
  })

  it("refuses a non-GET/HEAD method", () => {
    expect(get("/features", { method: "POST" }).status).toBe(405)
  })

  it("refuses to escape the dist and a malformed escape", () => {
    expect(resolveServedPath(dist, "/../package.json")).toBeNull()
    expect(resolveServedPath(dist, "/%E0%A4%A")).toBeNull()
  })
})

/**
 * Requirement 4 (@cto scope GO 2026-11-02): a new COMPLETE hourly run triggers ONE rebuild through the existing
 * rebuild check, and a failed run rebuild keeps serving the previous build and says so loudly.
 */
describe("landed-serve hourly-run rebuild", () => {
  const CODE = "a".repeat(40)
  const RUN_A = "2026-11-02T20-34-05-309Z-75c7a72a53da"
  const RUN_B = "2026-11-02T21-34-03-594Z-2d0bc819ffc1"
  // The rebuild narrates its progress on stdout for the unit log; the tests read state, not narration.
  let quiet: ReturnType<typeof vi.spyOn> | undefined
  beforeEach(() => {
    quiet = vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    quiet?.mockRestore()
  })

  function stamp(distDir: string, workingRunId: string | null, sourceCommit = CODE): void {
    mkdirSync(distDir, { recursive: true })
    writeFileSync(
      join(distDir, "build.json"),
      JSON.stringify({ sourceCommit, ...(workingRunId && { workingRun: { id: workingRunId } }) }),
    )
    writeFileSync(join(distDir, "index.html"), `built-for-${workingRunId}`)
  }

  function completeRun(runsDir: string, id: string): void {
    mkdirSync(join(runsDir, id), { recursive: true })
    writeFileSync(join(runsDir, id, "summary.json"), JSON.stringify({ complete: true }))
    writeFileSync(join(runsDir, id, "cells.json"), "{}")
  }

  it("asks for a run rebuild only when the code matches and the newest complete run differs", () => {
    expect(rebuildReason(CODE, { sourceCommit: CODE, workingRunId: RUN_A }, RUN_B)).toBe("run")
    expect(rebuildReason(CODE, { sourceCommit: CODE, workingRunId: RUN_B }, RUN_B)).toBeNull()
    expect(rebuildReason(CODE, { sourceCommit: "b".repeat(40), workingRunId: RUN_B }, RUN_B)).toBe("code")
    expect(rebuildReason(CODE, { sourceCommit: CODE, workingRunId: null }, null)).toBeNull()
  })

  it("a failed run rebuild keeps serving the previous build and reports loudly", async () => {
    const out = mkdtempSync(join(tmpdir(), "landed-serve-run-"))
    stamp(join(out, "dist"), RUN_A)
    const errors: string[] = []
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => errors.push(String(line)))
    try {
      const ok = await rebuildForRun({ outRoot: out, target: CODE, runId: RUN_B, runBuild: async () => 1 })
      expect(ok).toBe(false)
    } finally {
      spy.mockRestore()
    }
    expect(readServedStamp(join(out, "dist"))).toEqual({ sourceCommit: CODE, workingRunId: RUN_A })
    expect(readFileSync(join(out, "dist", "index.html"), "utf8")).toBe(`built-for-${RUN_A}`)
    expect(errors.join("\n")).toContain(`rebuild for hourly run ${RUN_B} failed`)
    expect(errors.join("\n")).toContain("still serving the previous build")
    // The existing rebuild marker stays behind on failure, as it does for a failed code rebuild.
    expect(existsSync(join(out, "rebuild.json"))).toBe(true)
  })

  it("a successful run rebuild swaps the staged build in and clears the marker", async () => {
    const out = mkdtempSync(join(tmpdir(), "landed-serve-run-"))
    stamp(join(out, "dist"), RUN_A)
    const ok = await rebuildForRun({
      outRoot: out,
      target: CODE,
      runId: RUN_B,
      runBuild: async (env) => {
        stamp(join(env["TERMINFO_SITE_OUT_DIR"] ?? "", "dist"), RUN_B)
        return 0
      },
    })
    expect(ok).toBe(true)
    expect(readServedStamp(join(out, "dist"))).toEqual({ sourceCommit: CODE, workingRunId: RUN_B })
    expect(existsSync(join(out, "rebuild.json"))).toBe(false)
  })

  it("rebuilds once per new complete run and never retries a run whose build failed", async () => {
    const out = mkdtempSync(join(tmpdir(), "landed-serve-run-"))
    const runs = mkdtempSync(join(tmpdir(), "landed-serve-runs-"))
    stamp(join(out, "dist"), RUN_A)
    completeRun(runs, RUN_A)
    const builds: string[] = []
    let fail = true
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const rebuilder = createRunRebuilder({
        runsDir: runs,
        outRoot: out,
        target: CODE,
        runBuild: async (env) => {
          builds.push(env["TERMINFO_SITE_OUT_DIR"] ?? "")
          if (fail) return 1
          stamp(join(env["TERMINFO_SITE_OUT_DIR"] ?? "", "dist"), RUN_B)
          return 0
        },
      })
      await rebuilder.check()
      expect(builds).toHaveLength(0)
      // A run still being written is not newest.
      mkdirSync(join(runs, RUN_B))
      await rebuilder.check()
      expect(builds).toHaveLength(0)
      completeRun(runs, RUN_B)
      await rebuilder.check()
      await rebuilder.check()
      expect(builds).toHaveLength(1)
      expect(readServedStamp(join(out, "dist")).workingRunId).toBe(RUN_A)
      fail = false
      const RUN_C = "2026-11-02T22-34-03-000Z-2d0bc819ffc1"
      completeRun(runs, RUN_C)
      await rebuilder.check()
      expect(builds).toHaveLength(2)
      expect(readServedStamp(join(out, "dist")).workingRunId).toBe(RUN_B)
    } finally {
      spy.mockRestore()
    }
  })
})
