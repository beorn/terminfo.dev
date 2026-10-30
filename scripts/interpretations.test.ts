/**
 * @failure A presentation decision without a non-author acceptance, or an acceptance outside a presentation, is admitted as reviewed.
 * @level l0
 * @consumer content/interpretations.json readers: selected-results presentations and the hourly tier table's reviewed column
 * @testonly none
 */
import { describe, expect, test } from "vitest"
import { parseInterpretations } from "./interpretations.ts"

const CATALOG = ["charsets.utf8"]
const WIRE = "91c0b861-0a43-4d6f-9c55-1f2e3d4c5b6a"

function presentation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "review-vterm-utf8",
    runId: "7e42a4eeaac25a73b40c2a4b2ad665cc",
    runSha256: "a".repeat(64),
    featureId: "charsets.utf8",
    reviewer: "@dev/1",
    reason: "Present the retained failure with its source reading",
    scope: {
      subject: { kind: "lib", id: "vterm" },
      versions: ["0.9.0", "0.9.0"],
      suites: ["ad71efdaa660", "ad71efdaa660"],
    },
    sources: ["@si/terminfo/30211-terminfo-273/31690-hourly-remeasure-at-current-main/31877-tier-table-reviewed-cells"],
    supersedes: [],
    presentsEvidence: true,
    accepted: { by: "@cto", wire: WIRE, at: "2026-10-30T07:39:00-07:00" },
    ...overrides,
  }
}

const parse = (entries: unknown[]) => parseInterpretations("interpretations.json", JSON.stringify(entries), CATALOG)

describe("a presentation decision carries its acceptance", () => {
  test("an accepted presentation parses and keeps its acceptance", () => {
    expect(parse([presentation()])).toMatchObject([
      { id: "review-vterm-utf8", accepted: { by: "@cto", wire: WIRE, at: "2026-10-30T07:39:00-07:00" } },
    ])
    expect(
      parse([presentation({ accepted: { by: "@cto", wire: WIRE, at: "2026-10-30T14:39:00.123Z" } })]),
    ).toHaveLength(1)
  })

  test.each([
    ["no acceptance", { accepted: undefined }, /presentation review-vterm-utf8 requires accepted/],
    [
      "the author accepts",
      { accepted: { by: "@dev/1", wire: WIRE, at: "2026-10-30T07:39:00-07:00" } },
      /non-author accepted\.by/,
    ],
    ["no acceptor", { accepted: { by: "", wire: WIRE, at: "2026-10-30T07:39:00-07:00" } }, /non-author accepted\.by/],
    ["a time without an offset", { accepted: { by: "@cto", wire: WIRE, at: "2026-10-30T07:39:00" } }, /accepted\.at/],
    ["a time that is no date", { accepted: { by: "@cto", wire: WIRE, at: "2026-13-40T07:39:00Z" } }, /accepted\.at/],
    [
      "a message id prefix",
      { accepted: { by: "@cto", wire: "91c0b861", at: "2026-10-30T07:39:00Z" } },
      /accepted\.wire/,
    ],
    [
      "a packet hash beside the entry",
      { accepted: { by: "@cto", wire: WIRE, at: "2026-10-30T07:39:00Z", recordSha256: "b".repeat(64) } },
      /cannot set accepted\.recordSha256/,
    ],
    // Existing refusals the tier table relies on: a presentation names its exact run.
    ["no run", { runId: undefined }, /requires exact runId/],
    ["no run hash", { runSha256: undefined }, /requires exact run SHA256/],
  ])("%s is refused", (_case, overrides, message) => {
    const entry = presentation(overrides)
    for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete entry[key]
    expect(() => parse([entry])).toThrow(message)
  })

  test("an acceptance outside a presentation decision is refused", () => {
    const { presentsEvidence: _presents, ...interpretation } = presentation()
    expect(() => parse([interpretation])).toThrow(
      /review-vterm-utf8 cannot set accepted without a presentation decision/,
    )
  })

  test("a pre-seal capture decision cannot carry an acceptance", () => {
    const capture = {
      id: "capture-vterm-utf8",
      runId: "7e42a4eeaac25a73b40c2a4b2ad665cc",
      featureId: "charsets.utf8",
      captureSha256: "c".repeat(64),
      decision: "untestable",
      reviewed: true,
      reviewer: "@dev/1",
      reason: "No observable at this runtime",
      scope: {
        subject: { kind: "lib", id: "vterm" },
        versions: ["0.9.0", "0.9.0"],
        suites: ["ad71efdaa660", "ad71efdaa660"],
      },
      sources: [
        "@si/terminfo/30211-terminfo-273/31690-hourly-remeasure-at-current-main/31877-tier-table-reviewed-cells",
      ],
      supersedes: [],
    }
    expect(parse([capture])).toHaveLength(1)
    expect(() => parse([{ ...capture, accepted: { by: "@cto", wire: WIRE, at: "2026-10-30T07:39:00Z" } }])).toThrow(
      /pre-seal capture decision cannot set accepted/,
    )
  })
})
