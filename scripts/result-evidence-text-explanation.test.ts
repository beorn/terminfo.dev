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
import { describeTracePanes, readCellTrace } from "../docs/data/evidence-reader.ts"
import { textEvidenceExplanation } from "../docs/.vitepress/theme/ungraded-explanation.ts"

const SAMPLE_SHA256 = "a".repeat(64)

describe("the site says why a text row does not count (30033 ruling f1f3c64b)", () => {
  it("names the console host on a Windows text row, and says it is not counted", () => {
    const text = textEvidenceExplanation({ assertionType: "buffer_state", conclusive: false, os: "windows" })
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
    const text = textEvidenceExplanation({ assertionType: "buffer_state", conclusive: false, os: "windows", host })
    expect(text).toContain("OpenConsole.exe")
    expect(text).toContain(host.executablePath)
    expect(text).toContain(host.executableSha256)
    expect(text).toContain("not counted")
    // The digest is checkable on the page: no abbreviating ellipsis, and no deferral to the artifact.
    expect(text).not.toContain("…")
    expect(text).not.toContain("recorded in the run artifact")
  })

  it("names the app's own text snapshot and the five readback shapes on macOS", () => {
    const text = textEvidenceExplanation({ assertionType: "buffer_state", conclusive: false, os: "macos" })
    expect(text).toContain("text snapshot")
    expect(text).toContain("five readback shapes")
  })

  // The generic macOS sentence cannot distinguish a carried qualification's actual missing or
  // failed shape. CTO condition4 requires the reader's named cause to reach the page unchanged.
  it.each([
    "Run sample: missing text qualification shape empty-last-row",
    "Run sample: text qualification shape soft-wrap target does not match the expected character grid",
  ])("names the carried qualification cause: %s", (textQualificationReason) => {
    const text = textEvidenceExplanation({ assertionType: "buffer_state", conclusive: false, os: "macos", textQualificationReason })
    expect(text).toContain(textQualificationReason)
    expect(text).toContain("not counted")
  })

  it("stays silent for a conclusive row, and for a read that is not text", () => {
    expect(textEvidenceExplanation({ assertionType: "buffer_state", conclusive: true, os: "windows" })).toBeUndefined()
    expect(textEvidenceExplanation({ assertionType: "screenshot", conclusive: false, os: "windows" })).toBeUndefined()
    expect(textEvidenceExplanation(undefined)).toBeUndefined()
  })
})

describe("popover trace panes for not-reviewed cells (#30565 AC3, AC4, @cto rulings 3f4b1d98 & 2239262c)", () => {
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

  it("renders a headless parser-state cell with 'Input bytes were not stored by this run', source revision, parser state, and identity", () => {
    const document = {
      version: 1 as const,
      runId: "29e1f818-4988-445c-a498-ef369021bd6d",
      runSha256: "849390283359114480b610eae1f0e37d56066bea38132f86c1460a120c43a924",
      measuredAt: "2026-10-16T09:44:32.280Z",
      sourceRevision: "2cf6de203b151aed5b14d15609c1874e5bf5e5eb",
      identity: {
        recorded: "verified",
        admission: {
          rule: "runtime-identity",
          xtversion: "kitty(0.49.2)",
        },
      },
      cells: {
        "sgr.bg.default": {
          outcome: "supported",
          assertionType: "buffer_state",
          parserState: {
            baseline: defaultCellSnapshot("C", null),
            before: defaultCellSnapshot("X", { r: 0, g: 128, b: 0 }),
            after: defaultCellSnapshot("R", null),
          },
          assertions: [
            {
              kind: "positive",
              expected: "sgr.bg.default: reset R restores the measured C bg after a distinct colored X",
              observed: "{}",
            },
          ],
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
    const panes = describeTracePanes(loaded, {
      sequence: "ESC [ 49 m",
      probeGuidance: "Headless: measure neutral C, SGR 42 colored X, then SGR 49 reset R.",
      subjectKind: "lib",
    })

    expect(panes.tested.text).toContain("Input bytes were not stored by this run (source revision 2cf6de20).")
    expect(panes.tested.text).not.toContain("ESC [ 42 m")
    expect(panes.tested.text).toContain('baseline: "C" bg null (default)')
    expect(panes.tested.text).toContain('before: "X" bg rgb(0,128,0)')
    expect(panes.tested.text).toContain('after: "R" bg null (default)')
    expect(panes.tested.sourceLine).toBe(
      "Historical run 29e1f818 · 2026-10-16 · parser-state · presentation not reviewed",
    )
    expect(panes.tested.identityLine).toBe(
      "Identity verified in run file; admitted by runtime-identity rule (XTVERSION kitty(0.49.2)).",
    )
    expect(panes.tested.notKeptLine).toContain("Not kept: screenshot (headless parser has none), input bytes")

    expect(panes.expected.sequence).toBe("ESC [ 49 m")
    expect(panes.expected.behavior).toBe(
      "sgr.bg.default: reset R restores the measured C bg after a distinct colored X",
    )
    expect(panes.expected.referenceStatus).toBe("No reference image recorded")
  })

  it("renders a live query-reply cell with all published writes, query + sentinel, reply, run metadata, and unverified-but-admitted identity", () => {
    const document = {
      version: 1 as const,
      runId: "c70e8c3c37c8a735cb5f395052698c35",
      runSha256: "f3e4844f65081832e63d138e7764c1688230a8f92854fa5899daebf9df16f537",
      measuredAt: "2026-10-19T15:16:41.358Z",
      sourceRevision: "78be23e4938f4328d5b710034cf8803a51a1af2e",
      identity: {
        recorded: "unverified",
        admission: {
          rule: "ghostty",
          da1: "\u001b[?62;22;52c",
          xtversion: "ghostty 1.3.1",
        },
      },
      cells: {
        "sgr.bg.default": {
          outcome: "supported",
          assertionType: "query_reply",
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
          assertions: [
            {
              kind: "positive",
              expected: "sgr.bg.default: DECRQSS reports  after \u001b[42m\u001b[49m",
              observed: "0",
            },
          ],
        },
      },
    }
    const loaded = readCellTrace(document, {
      schemaVersion: 2,
      runId: document.runId,
      runSha256: document.runSha256,
      featureId: "sgr.bg.default",
    })
    const panes = describeTracePanes(loaded, {
      sequence: "ESC [ 49 m",
      probeGuidance: "Headless: measure neutral C, SGR 42 colored X, then SGR 49 reset R.",
      subjectKind: "app",
    })

    expect(panes.tested.items).toEqual([
      { label: "Sent", code: "ESC [ 0 m  ESC [ 42 m ESC [ 49 m  ESC [ 0 m" },
      { label: "Query · reply", code: "ESC P $ q m ESC \\ ESC [ c" },
      { label: "Reply", code: "ESC P 1 $ r 0 m ESC \\", text: "Observed: 0" },
    ])
    expect(panes.tested.sourceLine).toBe("Historical run c70e8c3c · 2026-10-19 · query · presentation not reviewed")
    expect(panes.tested.identityLine).toBe(
      "Identity unverified in run file; admitted by ghostty rule (DA1 ESC [ ?62;22;52 c, XTVERSION ghostty 1.3.1).",
    )
    expect(panes.tested.notKeptLine).toBe(
      "Not kept: screenshot, raw read window (including sentinel reply), reviewed evidence file",
    )
    expect(panes.expected.sequence).toBe("ESC [ 49 m")
    expect(panes.expected.behavior).toBe("sgr.bg.default: DECRQSS reports  after ESC [ 42 m ESC [ 49 m")
  })

  it("renders an unlisted-reply cell with 'Reply not reviewed for publication.' and its identity state", () => {
    const document = {
      version: 1 as const,
      runId: "trace-run-unlisted",
      runSha256: SAMPLE_SHA256,
      measuredAt: "2026-09-28T12:00:00.000Z",
      sourceRevision: "2".repeat(40),
      identity: {
        recorded: "verified",
        admission: {
          rule: "kitty",
          da1: "\u001b[?62;52;c",
          xtversion: "kitty(0.49.2)",
        },
      },
      cells: {
        "device.xtwinops-21": {
          outcome: "unsupported",
          assertionType: "query_reply",
          replyWithheld: true as const,
          events: [
            { kind: "write", sequence: "\u001b[0m" },
            { kind: "query", sequence: "\u001b[21t\u001b[c", reason: "reply" },
          ],
          assertions: [{ kind: "negative", expected: "no window title report" }],
        },
      },
    }
    const loaded = readCellTrace(document, {
      schemaVersion: 2,
      runId: document.runId,
      runSha256: document.runSha256,
      featureId: "device.xtwinops-21",
    })
    const panes = describeTracePanes(loaded, {
      sequence: "ESC [ 21 t",
      subjectKind: "app",
    })

    expect(panes.tested.text.toLowerCase()).toContain("reply not reviewed for publication")
    expect(panes.tested.items).toEqual([
      { label: "Sent", code: "ESC [ 0 m" },
      { label: "Query · reply", code: "ESC [ 21 t ESC [ c" },
      { label: "Reply", text: "Reply not reviewed for publication." },
    ])
    expect(panes.tested.identityLine).toBe(
      "Identity verified in run file; admitted by kitty rule (DA1 ESC [ ?62;52; c, XTVERSION kitty(0.49.2)).",
    )
    expect(panes.expected.sequence).toBe("ESC [ 21 t")
    expect(panes.expected.behavior).toBe("no window title report")
  })

  it("never renders an observed or matched reply on a replyWithheld fixture even if one is present (@cto REVISE 1)", () => {
    const document = {
      version: 1 as const,
      runId: "trace-run-withheld-leak",
      runSha256: SAMPLE_SHA256,
      measuredAt: "2026-09-28T12:00:00.000Z",
      sourceRevision: "2".repeat(40),
      identity: {
        recorded: "verified",
        admission: {
          rule: "kitty",
          da1: "\u001b[?62;52;c",
          xtversion: "kitty(0.49.2)",
        },
      },
      cells: {
        "device.xtwinops-21": {
          outcome: "unsupported",
          assertionType: "query_reply",
          replyWithheld: true as const,
          events: [
            { kind: "write", sequence: "\u001b[0m" },
            { kind: "query", sequence: "\u001b[21t\u001b[c", reason: "reply", match: ["\u001b]lsecret-title\u001b\\"] },
          ],
          assertions: [{ kind: "negative", expected: "no window title report", observed: "secret-title" }],
        },
        "extensions.osc52-read": {
          outcome: "unsupported",
          assertionType: "query_reply",
          replyWithheld: true as const,
          assertions: [{ kind: "negative", expected: "no clipboard read", observed: "secret-clipboard" }],
        },
      },
    }
    const withQuery = readCellTrace(document, {
      schemaVersion: 2,
      runId: document.runId,
      runSha256: document.runSha256,
      featureId: "device.xtwinops-21",
    })
    const queryPanes = describeTracePanes(withQuery, { sequence: "ESC [ 21 t", subjectKind: "app" })
    expect(queryPanes.tested.items).toEqual([
      { label: "Sent", code: "ESC [ 0 m" },
      { label: "Query · reply", code: "ESC [ 21 t ESC [ c" },
      { label: "Reply", text: "Reply not reviewed for publication." },
    ])
    expect(queryPanes.tested.text).not.toContain("secret-title")

    const withoutQuery = readCellTrace(document, {
      schemaVersion: 2,
      runId: document.runId,
      runSha256: document.runSha256,
      featureId: "extensions.osc52-read",
    })
    const noQueryPanes = describeTracePanes(withoutQuery, { sequence: "ESC ] 52 ; c ; ? BEL", subjectKind: "app" })
    expect(noQueryPanes.tested.items).toEqual([
      { label: "Sent", text: "Input bytes were not stored by this run." },
      { label: "Reply", text: "Reply not reviewed for publication." },
    ])
    expect(noQueryPanes.tested.text).not.toContain("secret-clipboard")
  })

  it("renders an empty-trace policy-refused cell with reader-safe reason text, Sent/Observed Nothing, identity, and no private collector note", () => {
    const document = {
      version: 1 as const,
      runId: "3105bbe99bf76151e86f4d90eb21c179",
      runSha256: "594ec74912e9bfaf757edf05007e310a354536b1cbcef7de1180e831456256ac",
      measuredAt: "2026-10-18T17:30:28.939Z",
      sourceRevision: "7b74b406abe357e43a1b909f93879f5d996e7181",
      identity: {
        recorded: "unverified",
        admission: {
          rule: "kitty",
          da1: "\u001b[?62;52;c",
          xtversion: "kitty(0.48.2)",
        },
      },
      cells: {
        "sgr.bg.256": {
          outcome: "inconclusive",
          evidence: "none",
          reason: "policy-refused",
          events: [],
          assertions: [],
        },
      },
    }
    const loaded = readCellTrace(document, {
      schemaVersion: 2,
      runId: document.runId,
      runSha256: document.runSha256,
      featureId: "sgr.bg.256",
    })
    const panes = describeTracePanes(loaded, {
      sequence: "ESC [ 48;5;N m",
      probeGuidance:
        "Headless: compare background SGR 48;5;67 and 48;5;173 cells with two independently exact direct-RGB cube reference cells.",
      subjectKind: "app",
    })

    expect(panes.tested.reasonLine).toBe("policy-refused: The configured policy declined to run or allow this probe.")
    expect(panes.tested.items).toEqual([
      { label: "Sent", text: "Nothing" },
      { label: "Observed", text: "Nothing" },
    ])
    expect(panes.tested.sourceLine).toBe("Historical run 3105bbe9 · 2026-10-18 · none · presentation not reviewed")
    expect(panes.tested.identityLine).toBe(
      "Identity unverified in run file; admitted by kitty rule (DA1 ESC [ ?62;52; c, XTVERSION kitty(0.48.2)).",
    )
    expect(panes.tested.text).not.toContain("terminal-ownership receipt")
    expect(panes.tested.text).not.toContain("Attempt refused before sending probe bytes")
    expect(panes.expected.sequence).toBe("ESC [ 48;5;N m")
    expect(panes.expected.behavior).toContain("compare background SGR 48;5;67 and 48;5;173 cells")
    expect(panes.expected.referenceStatus).toBe("No reference image recorded")
  })

  it("refuses a digest mismatch with 'trace failed its receipt' and a missing cell with 'no trace stored for this cell' (@cto ruling 2239262c)", () => {
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
    ).toThrow("no trace stored for this cell")
  })
})
