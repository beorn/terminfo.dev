/**
 * @failure A public cell prints an internal state (PROBE TODO, PROBE INVALID, PROBE CONFLICT, "manual by design")
 *   instead of a blank, or a blank cell still opens a card (#37341 Q1, @cpo/term f16a5a52 and bfbbc644 D3).
 * @level l1
 * @consumer every result cell on terminfo.dev (ResultEvidenceCell.vue) and the working-view table (RunHistory.vue)
 * @source-grep the cell and the table are Vue SFCs no unit runner imports; the status rule is evidence-status.ts,
 *   called here directly, and each SFC call site is pinned by its source text.
 * @testonly none
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as statusModule from "../docs/.vitepress/theme/evidence-status.ts"
import { evidenceStatus, NO_RESULT_STATUS } from "../docs/.vitepress/theme/evidence-status.ts"

const root = join(import.meta.dirname, "..")
const source = (path: string) => readFileSync(join(root, path), "utf8")
const LABELS = /PROBE TODO|PROBE INVALID|PROBE CONFLICT|NOT MEASURED|manual by design/i

describe("an undecided cell is published as a blank (Q1)", () => {
  it("gives the three undecided statuses and a missing result one status: an em dash with no badge", () => {
    const blank = { text: "", icon: "—", tone: "unknown", title: "No result yet" }
    for (const status of ["probe-todo", "probe-invalid", "probe-conflict", undefined] as const) {
      expect({ status, shown: evidenceStatus("sgr.bold", status) }).toEqual({ status, shown: blank })
    }
    expect(NO_RESULT_STATUS).toEqual(blank)
    for (const status of ["probe-todo", "probe-invalid", "probe-conflict", undefined] as const) {
      expect(evidenceStatus("sgr.bold", status)).toBe(NO_RESULT_STATUS)
      // An environment row is no exception: its stored PROBE TODO is undecided like any other.
      expect(evidenceStatus("device.env-term", status)).toBe(NO_RESULT_STATUS)
    }
  })

  it("keeps every decided status as stored, and no status carries an internal label", () => {
    expect(evidenceStatus("sgr.bold", "supported")).toEqual({ text: "Supported", icon: "✓", tone: "yes" })
    expect(evidenceStatus("sgr.bold", "unsupported")).toEqual({ text: "Unsupported", icon: "✗", tone: "no" })
    expect(evidenceStatus("sgr.bold", "untestable")).toEqual({ text: "Untestable", icon: "–", tone: "ungraded" })
    expect(evidenceStatus("extensions.kitty-graphics.display", "unsupported", true).text).toBe("Unsupported, derived")
    for (const value of Object.values(statusModule)) {
      if (typeof value === "object") expect(JSON.stringify(value)).not.toMatch(LABELS)
    }
    expect(source("docs/.vitepress/theme/evidence-status.ts")).not.toMatch(/MANUAL_BY_DESIGN|NOT MEASURED/)
  })
})

describe("the evidence cell reads the one status rule (Q1, D3)", () => {
  const cell = source("docs/.vitepress/theme/ResultEvidenceCell.vue")

  it("renders a blank cell as a plain em dash with its hover words, never a button", () => {
    // The blank branch comes before the button, so a cell with no result has nothing to click or focus.
    expect(cell).toMatch(/<span\s+v-if="blank"[^>]*:title="status\.title"/)
    expect(cell).toMatch(/<button\s+v-else\b/)
    expect(cell).toContain("const blank = computed(() => status.value === NO_RESULT_STATUS)")
  })

  it("grades the step table by the stored status value, never by the label text", () => {
    expect(cell).not.toContain('"PROBE TODO": "probe-todo"')
    expect(cell).not.toContain("STEP_STATUS[status.value.text]")
  })

  it("prints no reason beside a blank, and names no action for it", () => {
    // The blank returns before any reason is read, so no undecided reason reaches the line under a blank.
    expect(cell).toMatch(
      /const plainResult = computed\(\(\) => \{\s*if \(blank\.value\) return NO_RESULT_STATUS\.title\n/,
    )
    expect(cell).toContain(
      "${blank.value ? `${NO_RESULT_STATUS.title}.` : `${status.value.text}. ${actionLabel.value}`}",
    )
  })

  it("drops the earlier-result line, the reopen reason and the refusal summary from public pages (D3)", () => {
    expect(cell).not.toContain("priorDecisionSentence")
    expect(cell).not.toContain("priorDecisionLine")
    expect(source("docs/terminals/[id].md")).not.toContain("refusalSummarySentence")
  })

  it("prints the working view's undecided rows in the same words", () => {
    const history = source("docs/.vitepress/theme/RunHistory.vue")
    expect(history).not.toContain("evidenceStatus(cell[0], cell[1]).text }}")
    expect(history).toContain("statusWords(cell[0], cell[1])")
  })
})
