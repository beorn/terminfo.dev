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
    // The site projection carries no frame trace, so the cell says where the host IS recorded
    // rather than leaving a reader to think nothing named it (@cto, ruling f1f3c64b addition).
    expect(text).toContain("recorded in the run artifact")
  })

  // 30055 AC4: when the run records the host, the site names it — image, executable path and the
  // FULL digest — so a reader can check the host rather than being told it exists somewhere
  // (@cto ruling 6255e75d condition 3).
  it("names the recorded console host, with its full digest, when the run carries one", () => {
    const host = {
      image: "OpenConsole.exe",
      executablePath: "C:\\Windows\\System32\\OpenConsole.exe",
      executableSha256: `sha256:${"b".repeat(64)}`,
    }
    const text = textEvidenceExplanation({ evidence: "text", conclusive: false, os: "windows", host })
    expect(text).toContain("OpenConsole.exe")
    expect(text).toContain(host.executablePath)
    expect(text).toContain(host.executableSha256)
    expect(text).toContain("not counted")
    // The digest is checkable on the page: no abbreviating ellipsis, and no deferral to the artifact.
    expect(text).not.toContain("…")
    expect(text).not.toContain("recorded in the run artifact")
  })

  it("names the app's own text snapshot and the five readback shapes on macOS", () => {
    const text = textEvidenceExplanation({ evidence: "text", conclusive: false, os: "macos" })
    expect(text).toContain("text snapshot")
    expect(text).toContain("five readback shapes")
  })

  // The generic macOS sentence cannot distinguish a carried qualification's actual missing or
  // failed shape. CTO condition4 requires the reader's named cause to reach the page unchanged.
  it.each([
    "Run sample: missing text qualification shape empty-last-row",
    "Run sample: text qualification shape soft-wrap target does not match the expected character grid",
  ])("names the carried qualification cause: %s", (textQualificationReason) => {
    const text = textEvidenceExplanation({ evidence: "text", conclusive: false, os: "macos", textQualificationReason })
    expect(text).toContain(textQualificationReason)
    expect(text).toContain("not counted")
  })

  it("stays silent for a conclusive row, and for a read that is not text", () => {
    expect(textEvidenceExplanation({ evidence: "text", conclusive: true, os: "windows" })).toBeUndefined()
    expect(textEvidenceExplanation({ evidence: "pixels", conclusive: false, os: "windows" })).toBeUndefined()
    expect(textEvidenceExplanation(undefined)).toBeUndefined()
  })
})
