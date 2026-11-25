/**
 * @failure Legacy summary-bars.css or unscoped 70px widths return to break bar density, hover consistency, or
 *   single-line result rows across pages (#37631).
 * @level l2
 * @consumer terminfo.dev bar rows, SupportBar hover system, and result lists
 * @testonly none
 * @reach fs-walk vendor/terminfo.dev/docs/**
 * @source-grep the layout contract is carried by CSS text (bar density, unscoped widths), so the
 *   stylesheets themselves are the evidence; rendering a page cannot show a rule that is absent.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const root = join(import.meta.dirname, "..")

function walk(dir: string, suffix: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) walk(path, suffix, out)
    else if (name.endsWith(suffix)) out.push(path)
  }
  return out
}

function styleBlocks(source: string): string[] {
  const blocks: string[] = []
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi
  for (const match of source.matchAll(re)) {
    const body = match[1]
    if (body) blocks.push(body)
  }
  return blocks
}

describe("bar row layout and single hover system (#37631)", () => {
  it("retires legacy summary-bars.css so every bar uses SupportBar and bar-rows.css", () => {
    expect(existsSync(join(root, "docs/.vitepress/theme/summary-bars.css"))).toBe(false)
    const themeIndex = readFileSync(join(root, "docs/.vitepress/theme/index.ts"), "utf8")
    expect(themeIndex).not.toContain("summary-bars.css")
  })

  it("does not leak a 70px unscoped .summary-counts width or legacy .summary-bar tooltips in any page style", () => {
    const leaks: string[] = []
    for (const path of walk(join(root, "docs"), ".md")) {
      for (const css of styleBlocks(readFileSync(path, "utf8"))) {
        if (/\.summary-counts\s*\{[^}]*width:\s*70px/s.test(css)) leaks.push(`${path}: .summary-counts width: 70px`)
      }
    }
    expect(leaks).toEqual([])
  })

  it("wires bar-rows.css with compact row heights, hover bridge, cascading pane, and one-line result rows", () => {
    const barCss = readFileSync(join(root, "docs/.vitepress/theme/bar-rows.css"), "utf8")
    expect(barCss).toMatch(/\.support-bar-track\s*\{[^}]*height:\s*1[0-6]px/s)
    expect(barCss).toMatch(/\.support-pop::before\s*\{[^}]*height:\s*\d+px/s)
    expect(barCss).toMatch(/\.result-with-after\s*>\s*\.result-row[\s\S]*?width:\s*auto/s)
    expect(barCss).toContain(".support-pop-detail")
  })
})
