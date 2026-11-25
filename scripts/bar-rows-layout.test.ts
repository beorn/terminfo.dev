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
  clearActivePopover,
  detailPaneSide,
  featureAnchorId,
  HOVER_CLOSE_GRACE_MS,
  HOVER_OPEN_DELAY_MS,
  registerActivePopover,
  segmentPopoverShift,
  termAnchorId,
} from "../docs/.vitepress/theme/bar-layout.ts"
import {
  evidenceSummaryLine,
  plainExpectedSentence,
  technicalDetailsContent,
} from "../docs/.vitepress/theme/evidence-status.ts"
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

  it("coordinates a single active popover page-wide with 300ms hover-intent delay (#37631)", () => {
    expect(HOVER_OPEN_DELAY_MS).toBeGreaterThanOrEqual(250)
    expect(HOVER_OPEN_DELAY_MS).toBeLessThanOrEqual(400)
    expect(HOVER_CLOSE_GRACE_MS).toBeGreaterThanOrEqual(100)
    let closedA = 0
    let closedB = 0
    const closeA = () => {
      closedA += 1
    }
    const closeB = () => {
      closedB += 1
    }
    registerActivePopover(closeA)
    expect(closedA).toBe(0)
    registerActivePopover(closeB)
    expect(closedA).toBe(1)
    expect(closedB).toBe(0)
    clearActivePopover(closeB)
    registerActivePopover(closeA)
    expect(closedB).toBe(0)
    clearActivePopover(closeA)
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

  it("renders ResultEvidenceCell with Style 5 single-surface layout (top-right pill, bytes left / words right, blue ← reply, pair shots, Details disclosure) (#38269)", () => {
    expect(resultCardVue).toContain("rc-top")
    expect(resultCardVue).toContain("rc-steps")
    expect(resultCardVue).toContain("rc-pair")
    expect(resultCardVue).toContain("rc-rep")
    expect(resultCardVue).toContain("rc-mk")
    expect(resultCardVue).toContain("rc-pic")
    expect(resultCardVue).toContain("detailsSummaryLabel")
    expect(resultCardVue).not.toContain("No test sequence declared.")
    expect(resultCardVue).not.toContain("tracePaneCopy.expected.behavior")
  })

  it("groups feature-page results by verdict with a compact summary, keeps 390px sub-feature tables horizontally scrollable inside their box, and wires keyboard focus + SR labels on hover cards and result panes (#38266)", () => {
    // AC1: compact verdict summary strip + grouped verdict sections leading to inline full card drill-down.
    expect(featureMd).toContain("feature-verdict-summary")
    expect(featureMd).toContain("feature-verdict-groups")
    expect(featureMd).toContain("appVerdictGroups")
    expect(featureMd).toContain("RESULT_CATEGORIES")

    // AC2: wide sub-feature tables scroll inside their own region without page-wide overflow; touch-action on segments & triggers.
    expect(featureMd).toContain("sub-features-wrapper")
    expect(featureMd).toMatch(/\.sub-features-wrapper\s*\{[^}]*overflow-x:\s*auto/s)
    expect(featureMd).toMatch(/\.sub-features-wrapper\s+\.sub-features-table[\s\S]*?width:\s*max-content/s)
    expect(barCss).toMatch(/\.support-bar-seg\s*\{[^}]*touch-action:\s*manipulation/s)

    // AC3: keyboard focus order & screen-reader labels on SupportBar popover, cascading pane, and ResultEvidenceCell.
    expect(supportBarVue).toContain('aria-haspopup="dialog"')
    expect(supportBarVue).toContain(':aria-controls="open ? popId : undefined"')
    expect(supportBarVue).toContain(':aria-labelledby="tabId(tab)"')
    expect(supportBarVue).toContain("onTriggerKeydown")
    expect(supportBarVue).toContain("onTabKeydown")
    expect(supportBarVue).toContain("onPopKeydown")
    expect(supportBarVue).toContain("focusTriggerWithoutReopen")
    expect(supportBarVue).toContain("feature support breakdown")
    expect(supportBarVue).toContain("result categories")
    expect(resultCardVue).toContain("result for ${subjectName}")
    expect(resultCardVue).toContain("onTriggerKeydown")
    expect(resultCardVue).toContain("onPreviewKeydown")
    expect(resultCardVue).toContain("onTriggerFocus")
    expect(resultCardVue).not.toContain('aria-label="Result preview"')
  })

  it("omits Technical details when nothing adds to Test sequence + Expected + Observed, and keeps genuinely new detail (#37631)", () => {
    // WezTerm OSC 776 no-reply: Query is just Test sequence + described ESC [ c fence, Observed is already above.
    const osc776 = technicalDetailsContent({
      declaredSequence: "ESC ] 776 BEL",
      observedSummary:
        "No reply came back to the query. The terminal did answer the device check sent after it, and nothing else came within 250 ms.",
      hasStepTable: false,
      queryBytes: "ESC ]776 BEL ESC [ c",
    })
    expect(osc776.hasContent).toBe(false)

    // Single reply already quoted verbatim in Observed, no extra writes -> omit Technical details.
    const singleReply = technicalDetailsContent({
      declaredSequence: "ESC [ ?4 $ p",
      observedSummary: "The terminal sent back ESC [ ?4;0 $ y.",
      hasStepTable: false,
      fullReplyBytes: "ESC [ ?4;0 $ y",
      queryBytes: "ESC [ ?4 $ p ESC [ c",
    })
    expect(singleReply.hasContent).toBe(false)

    // Cursor save/restore: Observed summarizes positions; raw reply bytes + setup writes are genuinely new.
    const saveRestore = technicalDetailsContent({
      declaredSequence: "ESC 7 / ESC 8",
      observedSummary: "Cursor saved at 3;5, moved to 10;10, restored: back at 3;5.",
      hasStepTable: false,
      fullSentBytes: "ESC [ 3;5 H  ESC 7  ESC [ 10;10 H  ESC 8",
      fullReplyBytes: "ESC [ 3;5 R  ESC [ 10;10 R  ESC [ 3;5 R",
    })
    expect(saveRestore.hasContent).toBe(true)
    expect(saveRestore.sentBytes).toContain("ESC 7")
    expect(saveRestore.replyBytes).toContain("ESC [ 3;5 R")

    // Headless library parser state keeps Technical details.
    const headless = technicalDetailsContent({
      declaredSequence: "ESC [ 49 m",
      observedSummary: "The library's state after the test is shown below.",
      hasStepTable: false,
      parserStatePre: 'after: "R" bg null (default)',
    })
    expect(headless.hasContent).toBe(true)
    expect(headless.parserStatePre).toContain("bg null")
  })

  it("teleports SupportBar popover above sticky headers, keeps child-pane seam, and coordinates active popovers (#37631, #38269)", () => {
    expect(supportBarVue).toContain('<Teleport to="body">')
    expect(barCss).toMatch(/\.support-pop\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*9500/s)
    expect(barCss).toContain("--detail-notch-top")
    expect(barCss).toContain(".support-pop-detail::after")
    expect(barCss).toContain(".support-bar-seg.bar-none")
    expect(barCss).toMatch(/\.support-bar-seg\.bar-fail\s*\{[^}]*#dc2626/s)
    expect(supportBarVue).toContain("registerActivePopover")
    expect(resultCardVue).toContain("registerActivePopover")
    expect(resultCardVue).toContain("rc-who")
    expect(resultCardVue).not.toContain("result-evidence__breadcrumb")
  })

  it("deletes legacy summary-bars.css and removes legacy bar tooltip rules from tooltip.css (fix 9)", () => {
    expect(existsSync(join(root, "docs/.vitepress/theme/summary-bars.css"))).toBe(false)
    expect(tooltipCss).not.toContain(".summary-bar")
    expect(tooltipCss).not.toContain(".bar-yes[data-tooltip]")
    expect(tooltipCss).not.toContain(".tooltip-content")
  })
})
