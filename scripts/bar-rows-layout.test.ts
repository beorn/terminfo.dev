/**
 * @failure Bar rows bloat back to ~50px height, SupportBar hover popover drifts away from the
 *   hovered segment or drops the 6px hover bridge / Esc / touch close, feature-page verdicts wrap
 *   onto a second line, the cascading detail pane fails on right/left/narrow viewports, row
 *   anchors break click-to-scroll, or the result card regresses to raw JSON / 60-write dumps (#37631).
 * @level l1
 * @consumer terminfo.dev bar rows, SupportBar popover, cascading detail pane, ResultEvidenceCell, feature pages
 * @testonly none
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  detailPaneSide,
  featureAnchorId,
  segmentPopoverShift,
  termAnchorId,
} from "../docs/.vitepress/theme/bar-layout.ts"
import { evidenceSummaryLine, plainExpectedSentence } from "../docs/.vitepress/theme/evidence-status.ts"
import { DIFFERS_BY_CONTEXT } from "../docs/data/app-cells.ts"

const root = join(import.meta.dirname, "..")

describe("segmentPopoverShift (#37631 fix 2: segment-anchored popover)", () => {
  it("aligns the popover left edge to the hovered segment when room exists on the right", () => {
    expect(
      segmentPopoverShift({
        barLeft: 320,
        segmentLeft: 620,
        popWidth: 440,
        pageWidth: 1440,
      }),
    ).toBe(300)
  })

  it("clamps to the right viewport margin when a rightmost segment's card would overflow", () => {
    expect(
      segmentPopoverShift({
        barLeft: 320,
        segmentLeft: 1120,
        popWidth: 440,
        pageWidth: 1440,
      }),
    ).toBe(664)
  })

  it("clamps to the left viewport margin on narrow mobile viewports", () => {
    expect(
      segmentPopoverShift({
        barLeft: 160,
        segmentLeft: 160,
        popWidth: 358,
        pageWidth: 390,
      }),
    ).toBe(-144)
  })
})

describe("detailPaneSide & stable anchors (#37631 fixes 7-8)", () => {
  it("opens on the right when room exists, flips left near the right edge, and opens below under 600px", () => {
    expect(detailPaneSide({ popLeft: 200, popWidth: 440, detailWidth: 360, pageWidth: 1440 })).toBe("right")
    expect(detailPaneSide({ popLeft: 980, popWidth: 440, detailWidth: 360, pageWidth: 1440 })).toBe("left")
    expect(detailPaneSide({ popLeft: 16, popWidth: 358, detailWidth: 360, pageWidth: 390 })).toBe("below")
  })

  it("produces deterministic feature and terminal row anchor ids", () => {
    expect(featureAnchorId("sgr.fg.truecolor")).toBe("feature-sgr-fg-truecolor")
    expect(featureAnchorId("extensions.iterm2-images")).toBe("feature-extensions-iterm2-images")
    expect(termAnchorId("terminal-app")).toBe("term-terminal-app")
  })
})

describe("evidenceSummaryLine & plainExpectedSentence (#37631 fixes 4 & 6)", () => {
  it("returns one short plain template per evidence kind", () => {
    expect(evidenceSummaryLine({ status: "supported", assertionType: "screenshot" })).toBe(
      "Screen matched the expected frame.",
    )
    expect(evidenceSummaryLine({ status: "unsupported", assertionType: "screenshot" })).toBe(
      "Screen did not match the expected frame.",
    )
    expect(evidenceSummaryLine({ status: "supported", assertionType: "query_reply" })).toBe(
      "Terminal returned the expected reply.",
    )
    expect(evidenceSummaryLine({ status: "unsupported", assertionType: "query_reply", reason: "no reply" })).toBe(
      "Terminal sent no reply to the query.",
    )
    expect(evidenceSummaryLine({ status: "untestable", reason: "no observer" })).toBe("Untestable: no observer")
    expect(evidenceSummaryLine({ status: DIFFERS_BY_CONTEXT })).toBe("Results differ across measured contexts.")
    expect(evidenceSummaryLine({ status: undefined })).toBe("No result yet for this release.")
  })

  it("prefers trace evidence sentences from evidence-messages.ts when loaded", () => {
    expect(
      evidenceSummaryLine({
        status: "unsupported",
        assertionType: "screenshot",
        traceEvidence: [
          "Compared row 3, columns 3–6 of the screen with the expected result.",
          "Those cells did not change.",
        ],
      }),
    ).toBe("Compared row 3, columns 3–6 of the screen with the expected result. Those cells did not change.")
  })

  it("derives one plain expected sentence from catalog copy, skipping abbreviations like i.e. and never raw JSON", () => {
    const sentence = plainExpectedSentence({
      body: "SGR 38;2;R;G;B sets the foreground to a 24-bit RGB color. The sequence is <code>ESC [ 38;2;R;G;B m</code>.",
    })
    expect(sentence).toBe("SGR 38;2;R;G;B sets the foreground to a 24-bit RGB color.")
    expect(sentence).not.toContain("{")
    const withAbbrev = plainExpectedSentence({
      body: "ANSI save cursor (<code>CSI s</code>, i.e. <code>ESC [ s</code>) saves the current cursor position. Restore with CSI u.",
    })
    expect(withAbbrev).toBe("ANSI save cursor ( CSI s , i.e. ESC [ s ) saves the current cursor position.")
  })
})

describe("layout, hover, and single-system CSS/component contracts (#37631 fixes 1-9)", () => {
  const barCss = readFileSync(join(root, "docs/.vitepress/theme/bar-rows.css"), "utf8")
  const tooltipCss = readFileSync(join(root, "docs/.vitepress/theme/tooltip.css"), "utf8")
  const supportBarVue = readFileSync(join(root, "docs/.vitepress/theme/SupportBar.vue"), "utf8")
  const resultCardVue = readFileSync(join(root, "docs/.vitepress/theme/ResultEvidenceCell.vue"), "utf8")
  const featureMd = readFileSync(join(root, "docs/[category]/[id].md"), "utf8")

  it("keeps Terminal Applications bar track <= 16px and row height <= 32px", () => {
    const trackHeight = Number(/\.support-bar-track\s*\{[^}]*height:\s*(\d+)px/s.exec(barCss)?.[1])
    const rowMinHeight = Number(/\.term-row\s*\{[^}]*min-height:\s*(\d+)px/s.exec(barCss)?.[1])
    expect(trackHeight).toBeGreaterThanOrEqual(8)
    expect(trackHeight).toBeLessThanOrEqual(16)
    expect(rowMinHeight).toBeGreaterThanOrEqual(20)
    expect(rowMinHeight).toBeLessThanOrEqual(32)
  })

  it("bridges the 6px hover gap, supports global Esc, touch close, and cascading detail pane", () => {
    expect(barCss).toMatch(/\.support-pop::before\s*\{[^}]*height:\s*\d+px/s)
    expect(barCss).toContain("touch-action: manipulation")
    expect(supportBarVue).toContain("support-pop-close")
    expect(supportBarVue).toContain("onDocKeydown")
    expect(supportBarVue).toContain("support-pop-detail")
    expect(supportBarVue).toContain("featureAnchorId")
    expect(supportBarVue).toContain("scrollIntoView")
  })

  it("keeps verdict pills on one line beside app name and aligns feature-page lists in 2 columns on desktop", () => {
    expect(barCss).toMatch(/\.result-with-after\s*>\s*\.result-row[\s\S]*?width:\s*auto/s)
    expect(featureMd).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))")
    expect(featureMd).toContain("termAnchorId")
  })

  it("keeps ResultEvidenceCell default view concise and moves full step/byte dumps into Technical details", () => {
    expect(resultCardVue).toContain("declaredSequence")
    expect(resultCardVue).toContain("expectedSentence")
    expect(resultCardVue).toContain("observedSummary")
    expect(resultCardVue).toContain("No test sequence declared.")
    expect(resultCardVue).not.toContain("tracePaneCopy.expected.behavior")
  })

  it("deletes legacy summary-bars.css and removes legacy bar tooltip rules from tooltip.css (fix 9)", () => {
    expect(existsSync(join(root, "docs/.vitepress/theme/summary-bars.css"))).toBe(false)
    expect(tooltipCss).not.toContain(".summary-bar")
    expect(tooltipCss).not.toContain(".bar-yes[data-tooltip]")
    expect(tooltipCss).not.toContain(".tooltip-content")
  })
})
