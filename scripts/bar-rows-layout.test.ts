/**
 * @failure Terminal Applications bars stay tall, segment hover popovers anchor to the bar's left edge instead of the hovered segment, or feature-page verdict pills wrap onto a second line.
 * @level l1
 * @consumer terminfo.dev home Terminal Applications rows, SupportBar hover popover, and feature page ResultList
 * @testonly none
 * @reach file docs/.vitepress/theme/bar-layout.ts, docs/.vitepress/theme/bar-rows.css, docs/[category]/[id].md
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { segmentPopoverShift } from "../docs/.vitepress/theme/bar-layout.ts"

const root = join(import.meta.dirname, "..")

describe("segmentPopoverShift (#37631)", () => {
  it("anchors left-edge to the hovered segment when room exists on the right", () => {
    // Bar at x=360..1200 in 1440px viewport; Unsupported segment starts at x=970 (offset 610).
    // 970 + 440 = 1410 <= 1424 -> aligns cleanly with the segment's left edge.
    expect(
      segmentPopoverShift({
        barLeft: 360,
        segmentLeft: 970,
        popWidth: 440,
        pageWidth: 1440,
      }),
    ).toBe(610)
  })

  it("clamps to the viewport right margin when a right-side segment would overflow", () => {
    // Untestable segment at x=1180; 1180 + 440 = 1620 > 1424 -> clamps so right edge is 1424 (left 984, offset 624).
    expect(
      segmentPopoverShift({
        barLeft: 360,
        segmentLeft: 1180,
        popWidth: 440,
        pageWidth: 1440,
      }),
    ).toBe(624)
  })

  it("stays at 0 for the leftmost segment when it fits inside the viewport", () => {
    expect(
      segmentPopoverShift({
        barLeft: 360,
        segmentLeft: 360,
        popWidth: 440,
        pageWidth: 1440,
      }),
    ).toBe(0)
  })

  it("clamps cleanly to both margins on a narrow phone viewport", () => {
    // 375px phone, popWidth = 343px (375 - 32), bar starts at x=160 -> popover must sit at x=16 (shift = -144).
    expect(
      segmentPopoverShift({
        barLeft: 160,
        segmentLeft: 280,
        popWidth: 343,
        pageWidth: 375,
      }),
    ).toBe(-144)
  })
})

describe("bar-rows and feature-page layout contracts (#37631)", () => {
  const barRowsCss = readFileSync(join(root, "docs/.vitepress/theme/bar-rows.css"), "utf8")
  const featurePageMd = readFileSync(join(root, "docs/[category]/[id].md"), "utf8")

  it("keeps Terminal Applications rows concise and bars thin", () => {
    const rowMinHeight = /\.term-row\s*\{[^}]*min-height:\s*(\d+)px/s.exec(barRowsCss)?.[1]
    const barHeight = /\.support-bar-track\s*\{[^}]*height:\s*(\d+)px/s.exec(barRowsCss)?.[1]
    expect(Number(rowMinHeight)).toBeLessThanOrEqual(24)
    expect(Number(barHeight)).toBeLessThanOrEqual(12)
  })

  it("bridges the vertical gap above .support-pop so moving pointer down does not close it", () => {
    expect(barRowsCss).toMatch(/\.support-pop::before\s*\{[^}]*top:\s*-\d+px/s)
  })

  it("overrides width: 100% on .result-with-after > .result-row so verdict pills stay on the same line", () => {
    expect(barRowsCss).toMatch(/\.result-with-after\s*>\s*\.result-row[\s\S]*?width:\s*auto/s)
    expect(barRowsCss).toMatch(/\.result-with-after\s*>\s*\.result-row[\s\S]*?flex:\s*1 1 0/s)
  })

  it("lays out feature-page .feature-results in two aligned columns on desktop and one on phone", () => {
    expect(featurePageMd).toMatch(
      /\.feature-results[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s,
    )
    expect(featurePageMd).toMatch(
      /@media\s*\(max-width:\s*640px\)[\s\S]*?\.feature-results[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/s,
    )
  })
})
