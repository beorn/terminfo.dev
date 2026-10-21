import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { checkPrivateLeak, scanDist, scanSitemap, scanSources } from "./check-private-leak.ts"

let docs: string

function write(rel: string, content: string): void {
  const full = join(docs, rel)
  mkdirSync(join(full, ".."), { recursive: true })
  writeFileSync(full, content)
}

beforeEach(() => {
  docs = mkdtempSync(join(tmpdir(), "terminfo-leak-"))
})

afterEach(() => {
  rmSync(docs, { recursive: true, force: true })
})

describe("check-private-leak — source scan", () => {
  it("passes on a clean docs tree", () => {
    write("index.md", "# Home\n")
    write("terminals/ghostty.md", "# Ghostty\n")
    expect(scanSources(docs)).toEqual([])
  })

  it("flags a file under reviews/ (the confirmed leak shape)", () => {
    write("reviews/gpt-pro-v3-2026-03-26.md", "# review\n")
    const v = scanSources(docs)
    expect(v).toHaveLength(1)
    expect(v[0]?.layer).toBe("source")
    expect(v[0]?.reason).toContain("reviews/")
  })

  it("flags any internal path segment (internal/ drafts/ private/ ...)", () => {
    write("internal/notes.md", "# notes\n")
    write("drafts/idea.md", "# idea\n")
    write("guides/private/secret.md", "# nested\n")
    expect(scanSources(docs)).toHaveLength(3)
  })

  it("flags the llm-meta content marker even outside reviews/", () => {
    write("about.md", '<!-- llm-meta: {"model":"GPT-5.4 Pro"} -->\n# About\n')
    const v = scanSources(docs)
    expect(v).toHaveLength(1)
    expect(v[0]?.reason).toContain("llm-meta")
  })

  it("flags publication-opt-out frontmatter under docs/", () => {
    write("a.md", "---\nprivate: true\n---\n# A\n")
    write("b.md", "---\ndraft: true\n---\n# B\n")
    write("c.md", "---\npublish: false\n---\n# C\n")
    expect(scanSources(docs)).toHaveLength(3)
  })

  it("does not flag ordinary frontmatter", () => {
    write("a.md", "---\ntitle: Hello\ndraft: false\n---\n# A\n")
    expect(scanSources(docs)).toEqual([])
  })
})

describe("check-private-leak — build + sitemap scan", () => {
  it("flags a forbidden route in the built dist", () => {
    const dist = join(docs, ".vitepress", "dist")
    mkdirSync(join(dist, "reviews"), { recursive: true })
    writeFileSync(join(dist, "reviews", "index.html"), "<html></html>")
    const v = scanDist(dist)
    expect(v).toHaveLength(1)
    expect(v[0]?.layer).toBe("build")
  })

  it("flags a forbidden path in sitemap.xml", () => {
    const dist = join(docs, ".vitepress", "dist")
    mkdirSync(dist, { recursive: true })
    writeFileSync(
      join(dist, "sitemap.xml"),
      `<?xml version="1.0"?><urlset><url><loc>https://terminfo.dev/reviews/gpt-pro-v3-2026-03-26</loc></url>` +
        `<url><loc>https://terminfo.dev/terminals/ghostty</loc></url></urlset>`,
    )
    const v = scanSitemap(dist)
    expect(v).toHaveLength(1)
    expect(v[0]?.layer).toBe("sitemap")
    expect(v[0]?.path).toContain("/reviews/")
  })

  it("aggregate checkPrivateLeak covers all three layers", () => {
    write("reviews/x.md", "# x\n")
    const dist = join(docs, ".vitepress", "dist")
    mkdirSync(join(dist, "reviews"), { recursive: true })
    writeFileSync(join(dist, "reviews", "index.html"), "<html></html>")
    writeFileSync(
      join(dist, "sitemap.xml"),
      `<?xml version="1.0"?><urlset><url><loc>https://terminfo.dev/reviews/x</loc></url></urlset>`,
    )
    const layers = new Set(checkPrivateLeak(docs).map((v) => v.layer))
    expect(layers).toEqual(new Set(["source", "build", "sitemap"]))
  })
})
