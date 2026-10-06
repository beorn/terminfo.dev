/**
 * @failure Home coverage counts wrap over the score because a 70px unscoped width wins the cascade.
 * @level l2
 * @consumer terminfo.dev front page Terminal Applications summary rows
 * @testonly none
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
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

function withoutAtRules(css: string): string {
  let out = ""
  let i = 0
  while (i < css.length) {
    const at = css.indexOf("@", i)
    if (at < 0) return out + css.slice(i)
    out += css.slice(i, at)
    const open = css.indexOf("{", at)
    if (open < 0) return out
    let depth = 0
    let j = open
    for (; j < css.length; j++) {
      if (css[j] === "{") depth++
      else if (css[j] === "}") {
        depth--
        if (depth === 0) {
          j++
          break
        }
      }
    }
    i = j
  }
  return out
}

/** Top-level `.summary-counts { ... }` bodies, ignoring scoped cousins and @media wrap rules. */
function unscopedSummaryCountsBodies(css: string): string[] {
  const bodies: string[] = []
  const stripped = withoutAtRules(css.replace(/\/\*[\s\S]*?\*\//g, ""))
  const re = /([^{}]+)\{([^{}]*)\}/g
  for (const match of stripped.matchAll(re)) {
    const selectors = match[1]?.split(",") ?? []
    const body = match[2] ?? ""
    for (const raw of selectors) {
      if (raw.trim() === ".summary-counts") bodies.push(body)
    }
  }
  return bodies
}

function declaration(body: string, property: string): string | undefined {
  const re = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "i")
  return re.exec(body)?.[1]?.trim()
}

describe("front-page summary coverage counts", () => {
  const cssSources = [
    join(root, "docs/.vitepress/theme/summary-bars.css"),
    ...walk(join(root, "docs"), ".md").flatMap((path) =>
      styleBlocks(readFileSync(path, "utf8")).map((css) => ({ path, css })),
    ),
  ]

  it("does not leak a 70px unscoped width onto every summary-counts row", () => {
    const leaks: string[] = []
    for (const source of cssSources) {
      const path = typeof source === "string" ? source : source.path
      const css = typeof source === "string" ? readFileSync(source, "utf8") : source.css
      for (const body of unscopedSummaryCountsBodies(css)) {
        if (declaration(body, "width") === "70px") leaks.push(path)
      }
    }
    expect(leaks, "unscoped .summary-counts { width: 70px } squeezes the coverage sentence over the score").toEqual([])
  })

  it("keeps the shared coverage sentence on one line so it cannot wrap over the score", () => {
    const theme = readFileSync(join(root, "docs/.vitepress/theme/summary-bars.css"), "utf8")
    const bodies = unscopedSummaryCountsBodies(theme)
    expect(bodies.length).toBeGreaterThan(0)
    for (const body of bodies) {
      expect(declaration(body, "white-space")).toBe("nowrap")
      const width = declaration(body, "width")
      expect(width === undefined || width === "auto").toBe(true)
    }
  })
})
