/**
 * @failure A card's evidence pane prints a placeholder ("Observed bytes not reviewed for publication.",
 *   "Not kept: ...") instead of the sentences its trace carries, or accepts a current decided cell without them
 *   (#37341). The sentences themselves are pinned on real records in evidence-messages.test.ts.
 * @level l2
 * @consumer terminfo.dev result pages (docs/.vitepress/theme/ResultEvidenceCell.vue)
 * @failure A retained source-answer cell reaches the site as a graded or source-captioned result instead of PROBE TODO
 *   (operator 2026-11-03, #32246).
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import {
  parseRun,
  parseSuiteManifest,
  SOURCE_ANSWER_RETIRED_REASON,
  STORED_VISUAL_REVIEW_RETIRED_REASON,
} from "@terminfo/run-parser"
import { projectResults } from "../docs/data/selected-results.ts"
import { publicResults } from "../docs/data/public-results.ts"
import { describeTracePanes, readCellTrace } from "../docs/data/evidence-reader.ts"

const SAMPLE_SHA256 = "a".repeat(64)

// No result is graded from source (operator 2026-11-03, #32246): a retained cell its kept source answer used to
// decide must reach the site/API readers as PROBE TODO, with no source caption, while the stored capture, its
// status in the file and its measuredAt stay byte-unchanged. Pure reader tests cannot prove this handoff.
it.each([
  {
    name: "a retained Alacritty screenshot review",
    file: "../content/probes-apps/alacritty-0.17.0-linux-f504922f67f074794c588cf3a14e2114.json",
    suite: "../content/suites/4b01b0117e18.json",
    context: "term:alacritty",
    featureId: "extensions.iterm2-images",
    reason: STORED_VISUAL_REVIEW_RETIRED_REASON,
    publicReason: "needs a same-run pixel check",
  },
  {
    name: "a real disputed Ghostty cell",
    file: "../content/probes-libs/ghostty-0.4.0-linux-3bacc3ae-a7c9-4fed-9f3f-a2c0ce01e6f5.json",
    suite: "../content/suites/5ccb68c2db36.json",
    context: "lib:ghostty",
    featureId: "extensions.kitty-graphics",
    reason: SOURCE_ANSWER_RETIRED_REASON,
    publicReason: "no qualified probe observation in this run",
  },
])(
  "reads $name as PROBE TODO and publishes no source caption or private detail",
  ({ file, suite, context, featureId, reason, publicReason }) => {
    const path = new URL(file, import.meta.url)
    const bytes = readFileSync(path, "utf8")
    const manifestPath = new URL(suite, import.meta.url)
    const manifest = parseSuiteManifest(manifestPath.pathname, readFileSync(manifestPath, "utf8"))
    const catalog = manifest.catalogIds!
    const run = parseRun(path.pathname, bytes, catalog, new Map([[manifest.probeHash, manifest]]))
    const original = structuredClone(run)
    const retained = run.results?.find((result) => result.featureId === featureId)
    expect(retained?.status).toBe("probe-todo")
    expect(retained?.reason).toBe(reason)
    expect(retained?.reviewRef).toBeUndefined()
    const projection = projectResults([run], catalog, { currentProbeHash: manifest.probeHash, workingRuns: [run] }, [])
    const selected = projection.history[context]?.[0]
    expect(selected?.measuredAt).toBe(run.measuredAt)
    const published = publicResults(projection, new Map()).projection.contexts[context]?.featureResults[featureId]
    expect(published?.status).toBe("probe-todo")
    expect(published?.reason).toBe(publicReason)
    const publicBytes = JSON.stringify(published)
    expect(publicBytes).not.toContain("not re-verified")
    expect(publicBytes).not.toContain("kept answers disagree")
    expect(publicBytes).not.toContain("kept originals")
    expect(publicBytes).not.toContain("@dev/")
    expect(publicBytes).not.toContain("reply-path-audit")
    expect(publicBytes).not.toContain("operator")
    expect(published?.reason).not.toContain("2026-11-03")
    expect(publicBytes).not.toContain("not re-admitted")
    expect(publicBytes).not.toContain("source answer")
    expect(published?.presentation.state).toBe("not-reviewed")
    expect(published?.record).toBeUndefined()
    expect(run).toEqual(original)
    expect(readFileSync(path, "utf8")).toBe(bytes)
  },
)

it("publishes short reader-safe missing-evidence reasons on probe-todo cells while stripping raw diagnostic tails and private paths", () => {
  const path = new URL(
    "../content/probes-libs/ghostty-0.4.0-linux-3bacc3ae-a7c9-4fed-9f3f-a2c0ce01e6f5.json",
    import.meta.url,
  )
  const bytes = readFileSync(path, "utf8")
  const manifestPath = new URL("../content/suites/5ccb68c2db36.json", import.meta.url)
  const manifest = parseSuiteManifest(manifestPath.pathname, readFileSync(manifestPath, "utf8"))
  const catalog = manifest.catalogIds!
  const run = parseRun(path.pathname, bytes, catalog, new Map([[manifest.probeHash, manifest]]))
  const byFeature = new Map((run.results ?? []).map((entry) => [entry.featureId, entry]))
  byFeature.get("sgr.bg.256")!.status = "probe-todo"
  byFeature.get("sgr.bg.256")!.reason =
    'Cursor advance does not verify SGR styling; Pixel capture unavailable: Capture calibration cannot restore cursor visibility: unreported mode; {"match":null,"reason":"sentinel"}'
  byFeature.get("sgr.bold")!.status = "probe-todo"
  byFeature.get("sgr.bold")!.reason = "unchecked collector note /home/fixture/private"
  const projection = projectResults([run], catalog, { currentProbeHash: manifest.probeHash, workingRuns: [run] }, [])
  const features = publicResults(projection, new Map()).projection.contexts["lib:ghostty"]?.featureResults
  expect(features?.["extensions.osc176-app-id"]?.reason).toBe(
    "OSC 176 app-id: no library target readback at this runtime",
  )
  expect(features?.["input.kitty-click-events"]?.reason).toBe("shared core encoder carries no prompt state")
  expect(features?.["sgr.bg.256"]?.reason).toBe("Cursor advance does not verify SGR styling")
  expect(features?.["sgr.bold"]?.reason).toBeUndefined()
  expect(JSON.stringify(features)).not.toContain("/home/fixture/private")
  expect(JSON.stringify(features)).not.toContain("Capture calibration")
  expect(JSON.stringify(features)).not.toContain("src/terminal/osc.zig")
})

/** The words every card used to fall back to (#37341); none may appear in a pane again. */
const PLACEHOLDERS = [
  "Input bytes were not stored by this run",
  "Observed bytes not reviewed for publication",
  "Not kept:",
  "presentation not reviewed",
  "no typed observation retained",
]

describe("popover trace panes (#30565, @cto rulings 3f4b1d98 & 2239262c; sentences #37341)", () => {
  const defaultCellSnapshot = (char: string, bg: { r: number; g: number; b: number } | null) => ({
    char,
    fg: null,
    bg,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    underlineColor: null,
    strikethrough: false,
    inverse: false,
    blink: false,
    hidden: false,
    wide: false,
    continuation: false,
  })
  const currentDocument = (featureId: string, cell: Record<string, unknown>) => ({
    version: 1 as const,
    runId: "c70e8c3c37c8a735cb5f395052698c35",
    runSha256: "f3e4844f65081832e63d138e7764c1688230a8f92854fa5899daebf9df16f537",
    measuredAt: "2026-10-19T15:16:41.358Z",
    sourceRevision: "78be23e4938f4328d5b710034cf8803a51a1af2e",
    identity: { recorded: "unverified" },
    featureResults: { [featureId]: cell },
  })
  const readCurrent = (document: ReturnType<typeof currentDocument>, featureId: string) =>
    readCellTrace(document, {
      schemaVersion: 4,
      runId: document.runId,
      runSha256: document.runSha256,
      featureId,
    })

  it("prints a live cell's sent bytes and query, then its evidence sentences, with no placeholder", () => {
    const document = currentDocument("sgr.bg.default", {
      status: "supported",
      assertionType: "query_reply",
      evidence: ["The terminal sent back ESC P 1 $ r 0 m ESC \\."],
      events: [
        { kind: "write", sequence: "\u001b[0m" },
        { kind: "write", sequence: "\u001b[42m\u001b[49m" },
        {
          kind: "query",
          sequence: "\u001bP$qm\u001b\\\u001b[c",
          reason: "reply",
          match: ["\u001bP1$r0m\u001b\\", "0"],
        },
        { kind: "write", sequence: "\u001b[0m" },
      ],
      assertions: [{ kind: "positive", expected: "sgr.bg.default: DECRQSS reports  after \u001b[42m\u001b[49m" }],
    })
    const panes = describeTracePanes(readCurrent(document, "sgr.bg.default"), {
      sequence: "ESC [ 49 m",
      subjectKind: "term",
    })
    expect(panes.tested.items).toEqual([
      { label: "Sent", code: "ESC [ 0 m  ESC [ 42 m ESC [ 49 m  ESC [ 0 m" },
      { label: "Query", code: "ESC P $ q m ESC \\ ESC [ c" },
      { label: "Observed", text: "The terminal sent back ESC P 1 $ r 0 m ESC \\." },
    ])
    expect(panes.tested.sourceLine).toBe("Current run c70e8c3c · 2026-10-19 · query_reply")
    expect(panes.tested.identityLine).toBeUndefined()
    for (const placeholder of PLACEHOLDERS) expect(panes.tested.text).not.toContain(placeholder)
    expect(panes.expected.behavior).toBe("sgr.bg.default: DECRQSS reports  after ESC [ 42 m ESC [ 49 m")
  })

  it("prints a headless library's sentence and its parser state; a live buffer_state read is not headless", () => {
    const document = currentDocument("sgr.bg.default", {
      status: "supported",
      assertionType: "buffer_state",
      evidence: ["The library's state after the test is shown below."],
      parserState: {
        baseline: defaultCellSnapshot("C", null),
        before: defaultCellSnapshot("X", { r: 0, g: 128, b: 0 }),
        after: defaultCellSnapshot("R", null),
      },
      assertions: [{ kind: "positive", expected: "sgr.bg.default: reset R restores the measured C bg" }],
    })
    const panes = describeTracePanes(readCurrent(document, "sgr.bg.default"), { subjectKind: "lib" })
    expect(panes.tested.items).toHaveLength(1)
    expect(panes.tested.items[0]?.text).toBe("The library's state after the test is shown below.")
    expect(panes.tested.text).toContain('baseline: "C" bg null (default)')
    expect(panes.tested.text).toContain('before: "X" bg rgb(0,128,0)')
    for (const placeholder of PLACEHOLDERS) expect(panes.tested.text).not.toContain(placeholder)

    const live = currentDocument("extensions.osc2-title", {
      status: "supported",
      assertionType: "buffer_state",
      evidence: ["Set the window title 4 times and read it back each time: 4 of 4 readings matched."],
      writes: ["\u001b]2;terminfo-title-target-A\u0007"],
      assertions: [{ kind: "positive", expected: "OSC 2 sets the title" }],
    })
    const livePanes = describeTracePanes(readCurrent(live, "extensions.osc2-title"), { subjectKind: "term" })
    expect(livePanes.tested.items.map((item) => item.label)).toEqual(["Sent", "Observed"])
    expect(livePanes.tested.items[1]?.pre).toBeUndefined()
  })

  it("refuses a current decided cell without evidence sentences, and an undecided cell that carries some", () => {
    const decided = currentDocument("sgr.bg.256", { status: "unsupported", assertions: [] })
    expect(() => readCurrent(decided, "sgr.bg.256")).toThrow(
      "Trace document identity or structure does not match this result",
    )
    const tooMany = currentDocument("sgr.bg.256", {
      status: "unsupported",
      evidence: ["One.", "Two.", "Three."],
      assertions: [],
    })
    expect(() => readCurrent(tooMany, "sgr.bg.256")).toThrow(
      "Trace document identity or structure does not match this result",
    )
    const undecided = currentDocument("sgr.bg.256", {
      status: "probe-todo",
      evidence: ["The terminal sent back ESC [ 0 m."],
      assertions: [],
    })
    expect(() => readCurrent(undecided, "sgr.bg.256")).toThrow(
      "Trace document identity or structure does not match this result",
    )
    const blank = currentDocument("sgr.bg.256", { status: "probe-todo", assertions: [] })
    expect(describeTracePanes(readCurrent(blank, "sgr.bg.256")).tested.items).toEqual([])
  })

  it("reads a historical trace's bytes and parser state with no placeholder and no draft identity line", () => {
    const document = {
      version: 1 as const,
      runId: "29e1f818-4988-445c-a498-ef369021bd6d",
      runSha256: "849390283359114480b610eae1f0e37d56066bea38132f86c1460a120c43a924",
      measuredAt: "2026-10-16T09:44:32.280Z",
      sourceRevision: "2cf6de203b151aed5b14d15609c1874e5bf5e5eb",
      identity: { recorded: "verified", admission: { rule: "runtime-identity", xtversion: "kitty(0.49.2)" } },
      cells: {
        "sgr.bg.default": {
          outcome: "supported",
          assertionType: "buffer_state",
          parserState: { after: defaultCellSnapshot("R", null) },
          assertions: [{ kind: "positive", expected: "sgr.bg.default: reset R restores the measured C bg" }],
        },
      },
    }
    const loaded = readCellTrace(document, {
      schemaVersion: 2,
      runId: document.runId,
      runSha256: document.runSha256,
      featureId: "sgr.bg.default",
      expectedSha256: SAMPLE_SHA256,
      actualSha256: SAMPLE_SHA256,
    })
    const panes = describeTracePanes(loaded, { subjectKind: "lib" })
    expect(panes.tested.text).toContain('after: "R" bg null (default)')
    expect(panes.tested.sourceLine).toBe("Historical run 29e1f818 · 2026-10-16 · buffer_state")
    expect(panes.tested.identityLine).toBeUndefined()
    for (const placeholder of PLACEHOLDERS) expect(panes.tested.text).not.toContain(placeholder)
    expect(panes.expected.referenceStatus).toBe("No reference image recorded")
  })

  it("refuses a digest mismatch with 'trace failed its receipt' and names the run and result a trace lacks (@cto ruling 2239262c)", () => {
    const document = {
      version: 1 as const,
      runId: "3105bbe99bf76151e86f4d90eb21c179",
      runSha256: SAMPLE_SHA256,
      measuredAt: "2026-10-18T17:30:28.939Z",
      sourceRevision: null,
      identity: { recorded: "unverified" },
      cells: {},
    }
    expect(() =>
      readCellTrace(document, {
        schemaVersion: 2,
        runId: document.runId,
        runSha256: SAMPLE_SHA256,
        featureId: "sgr.bg.256",
        expectedSha256: SAMPLE_SHA256,
        actualSha256: "b".repeat(64),
      }),
    ).toThrow("trace failed its receipt")

    expect(() =>
      readCellTrace(document, {
        schemaVersion: 2,
        runId: document.runId,
        runSha256: SAMPLE_SHA256,
        featureId: "sgr.bg.256",
        expectedSha256: SAMPLE_SHA256,
        actualSha256: SAMPLE_SHA256,
      }),
    ).toThrow("Trace document for run 3105bbe99bf76151e86f4d90eb21c179 holds no result for sgr.bg.256")
  })
})
