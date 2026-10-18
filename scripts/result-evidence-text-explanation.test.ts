/**
 * @failure A text-evidence row renders as "Ungraded observation" with no reason, so a reader takes
 *   a console host's buffer or an app's own text snapshot for a verdict about the terminal's drawn
 *   cells — and a silent exclusion reads as a terminal verdict, which @cto rejected as option C on
 *   30033 (verdict f1f3c64b).
 * @level l2
 * @consumer terminfo.dev result pages (docs/.vitepress/theme/ResultEvidenceCell.vue)
 * @source-grep the reason is computed by ungraded-explanation.ts and only rendered by the component,
 *   so the sentence itself is the contract and this pins it for both arms.
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { textEvidenceExplanation } from "../docs/.vitepress/theme/ungraded-explanation.ts"

describe("the site says why a text row does not count (30033 ruling f1f3c64b)", () => {
  it("names the console host on a Windows text row, and says it is not counted", () => {
    const text = textEvidenceExplanation({ evidence: "text", conclusive: false, os: "windows" })
    expect(text).toContain("console host")
    expect(text).toContain("not counted")
  })

  it("names the app's own text snapshot and the five readback shapes on macOS", () => {
    const text = textEvidenceExplanation({ evidence: "text", conclusive: false, os: "macos" })
    expect(text).toContain("text snapshot")
    expect(text).toContain("five readback shapes")
  })

  it("stays silent for a conclusive row, and for a read that is not text", () => {
    expect(textEvidenceExplanation({ evidence: "text", conclusive: true, os: "windows" })).toBeUndefined()
    expect(textEvidenceExplanation({ evidence: "pixels", conclusive: false, os: "windows" })).toBeUndefined()
    expect(textEvidenceExplanation(undefined)).toBeUndefined()
  })
})
