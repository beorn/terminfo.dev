import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  checkPrivateLeak,
  scanDist,
  scanRendered,
  scanSitemap,
  scanSources,
  visibleText,
} from "./check-private-leak.ts"

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

// Layer 4 (#37341): the 2.7.3 publish showed internal states on public pages (rolled back Nov 20 21:53 PST).
describe("check-private-leak — rendered internal states", () => {
  let dist: string
  beforeEach(() => {
    dist = join(docs, ".vitepress", "dist")
    mkdirSync(join(dist, "assets"), { recursive: true })
    mkdirSync(join(dist, "api", "v3"), { recursive: true })
  })

  const page = (body: string) =>
    `<html><head><script>window.__DATA__={"status":"probe-todo","label":"PROBE TODO"}</script></head><body>${body}</body></html>`

  it("passes a clean page, script and JSON", () => {
    writeFileSync(join(dist, "index.html"), page('<td>Supported</td><td title="No result yet">—</td>'))
    writeFileSync(join(dist, "assets", "app.js"), 'const s="Supported";')
    writeFileSync(join(dist, "api", "v3", "data.json"), '{"r":[{"status":"supported"},{"status":"untestable"}]}')
    expect(scanRendered(dist)).toEqual([])
  })

  it.each([
    ["PROBE TODO", "<td>PROBE TODO</td>"],
    ["PROBE INVALID", "<td>PROBE INVALID</td>"],
    ["PROBE CONFLICT", "<td>PROBE CONFLICT</td>"],
    ["NOT MEASURED", "<td>NOT MEASURED</td>"],
    ["manual by design", "<p>manual-by-design</p>"],
    ["unstable version string", "<span>WezTerm 0-unstable-2026-11-08</span>"],
    ["placeholder: not stored by this run", "<p>Input bytes were not stored by this run.</p>"],
    ["placeholder: not reviewed for publication", "<p>Observed bytes not reviewed for publication.</p>"],
  ])("refuses %s in page text, naming the page and count", (name, body) => {
    writeFileSync(join(dist, "x.html"), page(body))
    const v = scanRendered(dist)
    expect(v).toHaveLength(1)
    expect(v[0]?.layer).toBe("rendered")
    expect(v[0]?.path).toBe("dist/x.html")
    expect(v[0]?.reason).toBe(`page text shows internal state: ${name} x1`)
  })

  it("does not count a state that appears only in a page's script data", () => {
    writeFileSync(join(dist, "index.html"), page("<td>Supported</td>"))
    expect(visibleText(page("<td>Supported</td>"))).not.toContain("PROBE TODO")
    expect(scanRendered(dist)).toEqual([])
  })

  it.each([
    ["title", '<td title="PROBE TODO">—</td>'],
    ["data-tooltip", '<span data-tooltip="3 PROBE INVALID">x</span>'],
    ["aria-label", "<td aria-label='kitty: PROBE CONFLICT'>—</td>"],
    ["alt", '<img alt="Observed bytes not reviewed for publication." src="a.png">'],
  ])("refuses an internal state in the %s attribute a reader meets", (_attribute, body) => {
    writeFileSync(join(dist, "x.html"), page(body))
    expect(scanRendered(dist)).toHaveLength(1)
  })

  it("does not read other attributes, which are data", () => {
    writeFileSync(join(dist, "x.html"), page('<td data-status="probe-todo" class="PROBE TODO">—</td>'))
    expect(scanRendered(dist)).toEqual([])
  })

  it("decodes entities before matching, so an escaped label is still found", () => {
    writeFileSync(join(dist, "x.html"), page("<td>PROBE&nbsp;TODO</td>"))
    expect(scanRendered(dist).map((v) => v.reason)).toEqual(["page text shows internal state: PROBE TODO x1"])
  })

  it("refuses a display label in a built script, which renders client-side text such as popovers", () => {
    writeFileSync(join(dist, "assets", "chunk.js"), 'const L={"probe-todo":{text:"PROBE TODO"}};')
    expect(scanRendered(dist).map((v) => [v.path, v.reason])).toEqual([
      ["dist/assets/chunk.js", "built script shows internal state: PROBE TODO x1"],
    ])
  })

  it("does not count a measured version string inside a built script (data, not a rendering)", () => {
    writeFileSync(join(dist, "assets", "data.js"), 'const v="0-unstable-2026-11-08";')
    expect(scanRendered(dist)).toEqual([])
  })

  it("refuses an undecided status value in public JSON", () => {
    writeFileSync(
      join(dist, "api", "v3", "data.json"),
      '{"r":[{"status":"probe-todo"},{"status":"probe-invalid"},{"status":"probe-conflict"}]}',
    )
    expect(scanRendered(dist).map((v) => [v.path, v.reason])).toEqual([
      ["dist/api/v3/data.json", "public JSON shows internal state: undecided status value x3"],
    ])
  })

  it("is part of the aggregate check", () => {
    writeFileSync(join(dist, "index.html"), page("<td>PROBE TODO</td>"))
    expect(checkPrivateLeak(docs).map((v) => v.layer)).toEqual(["rendered"])
  })
})
