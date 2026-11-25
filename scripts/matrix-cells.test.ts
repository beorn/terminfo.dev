/**
 * @failure Delegated matrix rendering regresses to hydrating thousands of ResultEvidenceCell instances,
 *   mis-escapes HTML in tooltips/names, drifts from evidenceStatus/displayVersion accessibility labels,
 *   or drops stable feature row anchors (#38451).
 * @level l1
 * @consumer terminfo.dev Home, Baseline, and Category/Standard feature matrices
 * @testonly none
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { DIFFERS_BY_CONTEXT } from "../docs/data/app-cells.ts"
import type { PublicRunMetadata } from "../docs/data/public-results.ts"
import {
  describeMatrixCell,
  escapeHtml,
  renderFlatMatrixBodyHtml,
  renderGroupedMatrixBodyHtml,
  renderMatrixCellHtml,
} from "../docs/.vitepress/theme/matrix-cells.ts"

const root = join(import.meta.dirname, "..")

const sampleRun = {
  runId: "run-1",
  sha256: "a".repeat(64),
  schemaVersion: 4,
  measuredAt: "2026-11-24T00:00:00Z",
  suiteRelation: "tree",
  subject: {
    kind: "term",
    id: "wezterm",
    version: "0-unstable-2026-11-08",
    os: "linux",
    osVersion: null,
    outerTerminal: null,
    mux: null,
    config: null,
    permissions: null,
  },
} as unknown as PublicRunMetadata

describe("matrix-cells — pure delegated cell rendering (#38451)", () => {
  it("escapes HTML metacharacters cleanly", () => {
    expect(escapeHtml(`<script>"&'</script>`)).toBe("&lt;script&gt;&quot;&amp;&#39;&lt;/script&gt;")
  })

  it("matches ResultEvidenceCell status icons, tones, displayVersion snapshots, and blank undecided handling", () => {
    const supported = describeMatrixCell({
      featureId: "sgr.bold",
      featureName: "Bold (SGR 1)",
      subjectName: "WezTerm",
      version: sampleRun,
      cell: { featureId: "sgr.bold", status: "supported" } as never,
    })
    expect(supported.blank).toBe(false)
    expect(supported.tone).toBe("yes")
    expect(supported.icon).toBe("✓")
    expect(supported.accessibleName).toBe(
      "Bold (SGR 1) in WezTerm dev snapshot 2026-11-08: Supported. Opens how this was tested",
    )

    const todo = describeMatrixCell({
      featureId: "sgr.bold",
      featureName: "Bold (SGR 1)",
      subjectName: "WezTerm",
      version: sampleRun,
      cell: { featureId: "sgr.bold", status: "probe-todo" } as never,
    })
    expect(todo.blank).toBe(true)
    expect(todo.icon).toBe("—")
    expect(todo.accessibleName).toBe("Bold (SGR 1) in WezTerm dev snapshot 2026-11-08: No result yet.")

    const differs = describeMatrixCell({
      featureId: "sgr.bold",
      featureName: "Bold (SGR 1)",
      subjectName: "WezTerm",
      version: sampleRun,
      cell: {
        featureId: "sgr.bold",
        status: DIFFERS_BY_CONTEXT,
        joined: { status: DIFFERS_BY_CONTEXT, from: [] },
      } as never,
    })
    expect(differs.blank).toBe(false)
    expect(differs.tone).toBe("differs")
    expect(differs.icon).toBe("≠")
  })

  it("renders lightweight button triggers with data-mc-f/data-mc-b and plain blank spans without wrapper bloat", () => {
    const btnHtml = renderMatrixCellHtml({
      featureId: "sgr.bold",
      featureName: "Bold",
      backendName: "kitty",
      subjectName: "Kitty",
      version: sampleRun,
      cell: { featureId: "sgr.bold", status: "unsupported" } as never,
    })
    expect(btnHtml).toContain('class="result-evidence__trigger result-evidence__trigger--no"')
    expect(btnHtml).toContain('data-mc-f="sgr.bold"')
    expect(btnHtml).toContain('data-mc-b="kitty"')
    expect(btnHtml).not.toContain('class="result-evidence ')

    const blankHtml = renderMatrixCellHtml({
      featureId: "sgr.bold",
      featureName: "Bold",
      backendName: "kitty",
      subjectName: "Kitty",
      version: sampleRun,
      cell: undefined,
    })
    expect(blankHtml).toContain('class="result-evidence__blank"')
    expect(blankHtml).not.toContain("<button")
  })

  it("renders grouped and flat matrix bodies with anchors, escaped tooltips, and links", () => {
    const flat = renderFlatMatrixBodyHtml({
      features: [
        {
          id: "sgr.fg.truecolor",
          name: "Truecolor <24-bit>",
          category: "sgr",
          slug: "38-2-truecolor",
          tooltip: 'Line "1"',
        },
      ],
      backends: [{ name: "kitty", label: "Kitty" }],
      selectionFor: () => undefined,
      includeAnchors: true,
      tooltipAttr: "data-tooltip",
    })
    expect(flat).toContain('id="feature-sgr-fg-truecolor"')
    expect(flat).toContain('data-tooltip="Line &quot;1&quot;"')
    expect(flat).toContain('href="/sgr/38-2-truecolor"')
    expect(flat).toContain("Truecolor &lt;24-bit&gt;")

    const grouped = renderGroupedMatrixBodyHtml({
      groups: [
        {
          id: "sgr",
          label: "SGR & Style",
          features: [{ id: "sgr.bold", name: "Bold", category: "sgr", slug: "1-bold" }],
        },
      ],
      backends: [{ name: "kitty", label: "Kitty" }],
      selectionFor: () => undefined,
      linkClass: "hover-link",
    })
    expect(grouped).toContain('colspan="2"')
    expect(grouped).toContain('class="hover-link" href="/sgr">SGR &amp; Style</a>')
  })

  it("wires Home, Baseline, and Category/Standard matrices to DelegatedMatrix + MatrixBody instead of per-cell ResultEvidenceCell", () => {
    for (const rel of ["docs/index.md", "docs/baseline/[id].md", "docs/[id].md"]) {
      const content = readFileSync(join(root, rel), "utf8")
      expect(content).toContain("<DelegatedMatrix")
      expect(content).toContain("<MatrixBody")
      expect(content).not.toContain("<ResultEvidenceCell")
      expect(content).not.toContain("<tbody v-html=")
    }
  })
})
