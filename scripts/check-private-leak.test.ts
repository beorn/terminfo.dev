import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  checkPrivateLeak,
  scanDist,
  scanPublicCatalogue,
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

  // #37761: metadata visible beside Feature support must be plain dates/version/OS, not capture identifiers.
  it.each(["2026-11-18T22:50:00.000Z", "run-deadbeef", "a".repeat(64)])(
    "refuses technical measurement metadata in a feature-support summary: %s",
    (value) => {
      writeFileSync(
        join(dist, "terminal.html"),
        page(`<section class="score-card"><h2>Feature support</h2><p>${value}</p><div>bar</div></section>`),
      )
      expect(scanRendered(dist)).toEqual([
        expect.objectContaining({
          layer: "rendered",
          path: "dist/terminal.html",
          reason: expect.stringContaining("Page shows technical measurement metadata"),
        }),
      ])
    },
  )

  // #37761: the public-text rule applies to history, feature, comparison and home pages too.
  // The old score-card-only case never reached these rendered routes.
  it.each([
    "<p>Latest selected measurement: 2026-11-18T22:50:00.000Z</p>",
    "<li>Transmit was refused in run 3f767f8501c088b27a9dbb6ccdc04f42</li>",
    "<p>Original measurements · older suite bd8cfc7bcfc3</p>",
    '<p>Context ["term","wezterm","macos",null]</p>',
    "<details open><summary>Technical details</summary><p>run-deadbeef</p></details>",
    '<details title="run-deadbeef"><summary>Technical details</summary>hidden</details>',
    "<details open><summary>Technical details</summary>WezTerm 0-unstable-2026-11-08</details>",
    "<details><summary>WezTerm 0-unstable-2026-11-08</summary>hidden</details>",
    '<span aria-label="WezTerm 0-unstable-2026-11-08">WezTerm</span>',
  ])("refuses technical provenance in initially visible page text: %s", (body) => {
    writeFileSync(join(dist, "feature.html"), page(body))
    expect(scanRendered(dist)).toEqual([expect.objectContaining({ layer: "rendered", path: "dist/feature.html" })])
  })

  it("allows plain measurement dates and keeps technical provenance inside collapsed environment details", () => {
    writeFileSync(
      join(dist, "terminal.html"),
      page(
        '<section class="score-card"><h2>Feature support</h2><p>Measured Nov 8–18, 2026 · iTerm2 3.6.11 · macOS</p><div>bar</div></section><p>A run ID identifies a submission; SHA-256 describes its digest.</p><a title="Spec: gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda">OSC 8 specification</a><details><summary>Test environment</summary>run-deadbeef · ' +
          "a".repeat(64) +
          "</details>",
      ),
    )
    expect(scanRendered(dist)).toEqual([])
  })

  // Native disclosure visibility follows ancestors and the actual open attribute, not similarly named data.
  it.each([
    "<details><summary>Technical details</summary><details><summary>More</summary>hidden</details>run-deadbeef</details>",
    '<details data-open="true"><summary>Technical details</summary>run-deadbeef</details>',
    '<details class="keep open extra"><summary>Technical details</summary>run-deadbeef</details>',
    "<details open><summary>Technical details</summary><details><summary>More</summary>run-deadbeef</details></details>",
    "<details><summary>Technical details</summary><details open><summary>More</summary>run-deadbeef</details></details>",
    "<details><summary>Technical details</summary>WezTerm 0-unstable-2026-11-08</details>",
    "<details><summary>Technical details</summary><details open><summary>Original</summary>WezTerm 0-unstable-2026-11-08</details></details>",
  ])("keeps hidden disclosure provenance hidden: %s", (body) => {
    writeFileSync(join(dist, "nested.html"), page(body))
    expect(scanRendered(dist)).toEqual([])
  })

  it("still checks internal labels inside closed technical history", () => {
    writeFileSync(join(dist, "history.html"), page("<details><summary>Technical details</summary>PROBE TODO</details>"))
    expect(scanRendered(dist).map((v) => v.reason)).toEqual(["page text shows internal state: PROBE TODO x1"])
  })

  it.each([
    ["PROBE TODO", "<td>PROBE TODO</td>"],
    ["PROBE INVALID", "<td>PROBE INVALID</td>"],
    ["PROBE CONFLICT", "<td>PROBE CONFLICT</td>"],
    ["NOT MEASURED", "<td>NOT MEASURED</td>"],
    ["Not measured yet", "<p>Not measured yet</p>"],
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

  // @cto f6a09e55: a page with no selected run described itself as "not measured yet" to search results only.
  it.each([
    ["description", '<meta name="description" content="WezTerm feature support: not measured yet.">'],
    ["og:description", '<meta property="og:description" content="WezTerm feature support: not measured yet.">'],
    ["twitter:description", "<meta name='twitter:description' content='WezTerm feature support: not measured yet.'>"],
  ])("refuses an internal state in the page's %s, which search results and link previews show", (_name, meta) => {
    writeFileSync(join(dist, "x.html"), `<html><head>${meta}</head><body><p>WezTerm</p></body></html>`)
    expect(scanRendered(dist).map((v) => v.reason)).toEqual(["page text shows internal state: Not measured yet x1"])
  })

  it("does not read other meta content, which is data", () => {
    writeFileSync(
      join(dist, "x.html"),
      '<html><head><meta name="generator" content="PROBE TODO"></head><body></body></html>',
    )
    expect(scanRendered(dist)).toEqual([])
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

  // The private preview's stamp and working data must identify the same run; public artifacts remain strict.
  it.each([
    { context: "local", stampId: "working-1", dataId: "working-1", status: "probe-todo", allowed: true },
    { context: "github", stampId: "working-1", dataId: "working-1", status: "probe-todo", allowed: false },
    { context: "github", stampId: "working-1", dataId: "working-1", status: "supported", allowed: false },
    { context: "local", stampId: "working-1", dataId: "another-run", status: "probe-todo", allowed: false },
    { context: "local", stampId: "", dataId: "", status: "probe-todo", allowed: false },
    { context: "absent", stampId: "working-1", dataId: "working-1", status: "supported", allowed: false },
  ])("classifies only matched internal working data: %j", ({ context, stampId, dataId, status, allowed }) => {
    const startedAt = "2026-11-22T14:04:03.537Z"
    if (context !== "absent")
      writeFileSync(
        join(dist, "build.json"),
        JSON.stringify({
          sourceCommit: "a".repeat(40),
          context,
          githubRun: context === "github" ? "123" : null,
          workingRun: { id: stampId, startedAt },
        }),
      )
    writeFileSync(
      join(dist, "api", "v3", "data.json"),
      JSON.stringify({
        contexts: { accepted: { status: "supported" } },
        working: { run: { id: dataId, startedAt }, contexts: [{ status }] },
      }),
    )
    expect(scanRendered(dist).length > 0).toBe(!allowed)
    if (allowed) {
      writeFileSync(
        join(dist, "api", "v3", "data.json"),
        JSON.stringify({
          contexts: { accepted: { status: "probe-todo" } },
          working: { run: { id: dataId, startedAt }, contexts: [{ status }] },
        }),
      )
      expect(scanRendered(dist).map((v) => v.reason)).toEqual([
        "public JSON shows internal state: undecided status value x1",
      ])
    }
  })

  it("is part of the aggregate check", () => {
    writeFileSync(join(dist, "index.html"), page("<td>PROBE TODO</td>"))
    expect(checkPrivateLeak(docs).map((v) => v.layer)).toEqual(["rendered"])
  })
})

// Layer 5 (#37341 Q2, D6; @cto f6a09e55): the API and every readout name the public catalogue, and home prints it whole.
describe("check-private-leak — public catalogue", () => {
  const PUBLIC = ["cursor.cup", "sgr.bold", "sgr.italic"]
  let dist: string
  beforeEach(() => {
    dist = join(docs, ".vitepress", "dist")
    mkdirSync(join(dist, "api", "v3"), { recursive: true })
    mkdirSync(join(dist, "terminals"), { recursive: true })
  })
  const api = (catalogIds: string[], features: string[] = catalogIds) =>
    writeFileSync(
      join(dist, "api", "v3", "data.json"),
      JSON.stringify({ catalogIds, features: Object.fromEntries(features.map((id) => [id, { id }])) }),
    )
  const home = (readout: string) =>
    writeFileSync(join(dist, "index.html"), `<html><body><span class="readout">${readout}</span></body></html>`)

  it("passes when the API names the public ids and home reads over all of them", () => {
    api([...PUBLIC].reverse())
    home("2 supported · 3 of 3 tested")
    writeFileSync(join(dist, "terminals", "x.html"), "<html><body><td>1 supported · 2 of 2 tested</td></body></html>")
    expect(scanPublicCatalogue(dist, PUBLIC)).toEqual([])
  })

  it("refuses an environment id in the API's catalogIds or features, naming it", () => {
    api([...PUBLIC, "device.env-term"], PUBLIC)
    home("2 supported · 3 of 3 tested")
    expect(scanPublicCatalogue(dist, PUBLIC).map((v) => [v.layer, v.path, v.reason])).toEqual([
      [
        "catalogue",
        "dist/api/v3/data.json",
        "catalogIds names 4 ids, the public catalogue 3; not public: device.env-term; missing: none",
      ],
    ])
    api(PUBLIC, ["cursor.cup", "sgr.bold"])
    expect(scanPublicCatalogue(dist, PUBLIC).map((v) => v.reason)).toEqual([
      "features names 2 ids, the public catalogue 3; not public: none; missing: sgr.italic",
    ])
  })

  it("refuses an environment id in a context's catalogIds, but reads no run receipt (D132 B)", () => {
    home("2 supported · 3 of 3 tested")
    const write = (contexts: object) =>
      writeFileSync(
        join(dist, "api", "v3", "data.json"),
        JSON.stringify({ catalogIds: PUBLIC, features: Object.fromEntries(PUBLIC.map((id) => [id, {}])), contexts }),
      )
    write({
      "term:kitty": { catalogIds: ["sgr.bold"], sources: { r: { catalogIds: [...PUBLIC, "device.env-term"] } } },
    })
    expect(scanPublicCatalogue(dist, PUBLIC)).toEqual([])
    write({ "term:kitty": { catalogIds: ["sgr.bold"] }, "term:xterm": { catalogIds: [...PUBLIC, "device.env-term"] } })
    expect(scanPublicCatalogue(dist, PUBLIC).map((v) => v.reason)).toEqual([
      "contexts.*.catalogIds names ids outside the public catalogue in 1 context(s): term:xterm (device.env-term)",
    ])
  })

  it("refuses a missing API file rather than passing it unread", () => {
    home("2 supported · 3 of 3 tested")
    expect(scanPublicCatalogue(dist, PUBLIC).map((v) => v.reason)).toEqual([
      "missing, so the API's catalogue was not checked",
    ])
  })

  it("refuses a readout over more positions than the public catalogue, or with tested above positions", () => {
    api(PUBLIC)
    home("2 supported · 3 of 3 tested")
    writeFileSync(join(dist, "terminals", "x.html"), "<html><body><td>2 supported · 3 of 4 tested</td></body></html>")
    writeFileSync(
      join(dist, "terminals", "y.html"),
      '<html><body><td title="1 supported · 3 of 2 tested">-</td></body></html>',
    )
    expect(
      scanPublicCatalogue(dist, PUBLIC)
        .map((v) => v.path)
        .sort(),
    ).toEqual(["dist/terminals/x.html", "dist/terminals/y.html"])
  })

  it("refuses a home page with no readout over the whole public catalogue", () => {
    api(PUBLIC)
    home("1 supported · 2 of 2 tested")
    expect(scanPublicCatalogue(dist, PUBLIC).map((v) => [v.path, v.reason])).toEqual([
      ["dist/index.html", 'prints no readout "S supported · T of 3 tested" over the whole public catalogue'],
    ])
  })

  it("checks nothing when no build exists", () => {
    expect(scanPublicCatalogue(join(docs, "no-build"), PUBLIC)).toEqual([])
  })
})
