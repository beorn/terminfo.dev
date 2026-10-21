import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { checkPrivateLeak, scanContent, scanDist, scanSitemap, scanSources } from "./check-private-leak.ts"

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

  it("aggregate checkPrivateLeak covers all four layers", () => {
    write("reviews/x.md", "# x\n")
    const dist = join(docs, ".vitepress", "dist")
    mkdirSync(join(dist, "reviews"), { recursive: true })
    writeFileSync(join(dist, "reviews", "index.html"), "<html></html>")
    writeFileSync(
      join(dist, "sitemap.xml"),
      `<?xml version="1.0"?><urlset><url><loc>https://terminfo.dev/reviews/x</loc></url></urlset>`,
    )
    write("content/receipts/r.json", JSON.stringify({ runnerArtifact: { url: "file:///hh/var/seat/prep/x.tar" } }))
    const layers = new Set(checkPrivateLeak(docs, join(docs, "content")).map((v) => v.layer))
    expect(layers).toEqual(new Set(["source", "build", "sitemap", "content"]))
  })
})

describe("check-private-leak — content scan", () => {
  const content = () => join(docs, "content")

  it("flags an estate path in a run file, also inside a stored reply", () => {
    write(
      "content/probes-libs/run.json",
      JSON.stringify({ runtimeIdentity: { resolvedPath: "/hh/var/wt/seat/node_modules/a/index.js" } }, null, 2),
    )
    const reply = JSON.stringify({ receipt: { url: "file:///hh/var/seat/prep/runner-bundle.tar" } })
    write("content/probes-apps/run.json", JSON.stringify({ rawReplies: { "collector.disposableOwnership": reply } }))
    const v = scanContent(content())
    expect(v.map((x) => x.path).sort()).toEqual(["content/probes-apps/run.json", "content/probes-libs/run.json"])
    expect(v.every((x) => x.layer === "content" && x.reason.includes("under /hh"))).toBe(true)
    expect(v.find((x) => x.path.includes("probes-libs"))?.reason).toContain("at 3:")
  })

  it("flags the home folder of every account but the runner's", () => {
    write("content/probes-apps/a.json", JSON.stringify({ config: "--config-file /home/alice/term.conf" }))
    write("content/probes-apps/b.json", JSON.stringify({ path: "/Users/alice/Library/Caches/x.dmg" }))
    write("content/probes-apps/c.json", JSON.stringify({ path: "C:/x /home/runneradmin/x" }))
    const v = scanContent(content())
    expect(v.map((x) => x.path).sort()).toEqual([
      "content/probes-apps/a.json",
      "content/probes-apps/b.json",
      "content/probes-apps/c.json",
    ])
    // The finding names where the path starts, never the account it would republish in CI logs.
    expect(v.some((x) => x.reason.includes("alice") || x.reason.includes("runneradmin"))).toBe(false)
  })

  it("allows the runner account, Nix store paths and workspace-relative paths", () => {
    write(
      "content/probes-apps/run.json",
      JSON.stringify({
        config: "wezterm --config-file /home/runner/wezterm-config.lua",
        sourceArtifact: { path: "/Users/runner/Library/Caches/Homebrew/downloads/x--Ghostty.dmg" },
        loadedBinary: { path: "/nix/store/0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-kitty-0.49.2/bin/kitty" },
        resolvedPath: "node_modules/.bun/ghostty-web@0.4.0/node_modules/ghostty-web/dist/ghostty-web.js",
        osc7: "\u001b]7;file:///tmp\u0007",
      }),
    )
    expect(scanContent(content())).toEqual([])
  })

  it("reads the text captures in artifacts/ and skips images", () => {
    write("content/artifacts/a.txt", "prompt in /hh/var/seat $ ")
    write("content/artifacts/b.png", "\u0089PNG /hh/var/seat")
    expect(scanContent(content()).map((x) => x.path)).toEqual(["content/artifacts/a.txt"])
  })

  it("the committed content/ tree records no host path", () => {
    expect(scanContent(fileURLToPath(new URL("../content", import.meta.url)))).toEqual([])
  })
})
