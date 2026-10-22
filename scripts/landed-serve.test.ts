/**
 * @failure The preview 404s or 500s every clean URL the site links to (`cleanUrls: true`), so the operator's click on a baseline chip lands on a broken page (30757).
 * @level l2
 * @consumer The `terminfo-site` resident's `landed-serve`, and every preview link the operator clicks.
 * @testonly none
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPreviewHandler, resolveServedPath } from "./landed-serve.ts"

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
