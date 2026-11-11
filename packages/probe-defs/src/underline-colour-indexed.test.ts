/**
 * @failure Indexed underline colour reads Supported or Unsupported from frames that cannot decide it: a
 *   terminal that ignores 58:5:N while keeping the underline (xterm) stays Open forever, or a blind
 *   control (no underline, an underline that does not follow the foreground, two palette entries that
 *   render alike) is published as a verdict on 58 (@cto 075685d5, b3d7680f).
 * @failure A frame sends the semicolon form, so a terminal that splits the arguments is measured on
 *   blink, bold or a reset instead of the colour (@cto d2f24294).
 * @failure A Supported or Unsupported record omits the four digests per index that prove it.
 * @level l1
 * @consumer @si/terminfo/30211-terminfo-273/33050-xterm-indexed-underline-sibling/33146-xterm-indexed-underline-fg
 * @testonly none
 */
import { describe, expect, test } from "vitest"

import {
  UNDERLINE_INDEXED_BRANCH,
  UNDERLINE_INDEXED_PHASES,
  underlineColourIndexedDecision,
  underlineColourIndexedResult,
} from "./sgr-colour-capture.ts"
import { finalizeVisualResult } from "./sgr.ts"
import type { SameRunCapture } from "./region-readback.ts"
import type { ObservationFrame, ProbeResult } from "./types.ts"

const ID = "sgr.underline-color-indexed"
const A = "A no underline"
const B = "B plain underline"
const C = (n: number) => `C underline 58:5:${n}`
const D = (n: number) => `D' underline 38:5:${n}`

/** Distinct digests for every phase, then the overrides a case names (a phase equal to another). */
function digests(overrides: Record<string, string> = {}): (name: string) => string {
  const base: Record<string, string> = {
    [A]: "blank",
    [B]: "plain",
    [C(1)]: "red",
    [D(1)]: "red",
    [C(4)]: "blue",
    [D(4)]: "blue",
  }
  const table = { ...base, ...overrides }
  return (name) => {
    const value = table[name]
    if (value === undefined) throw new Error(`no digest for ${name}`)
    return value
  }
}

describe("indexed underline colour witness phases", () => {
  test("every colour frame sends the colon form only, on space cells, at indices 1 and 4", () => {
    expect(UNDERLINE_INDEXED_PHASES.map(({ name, sequence }) => [name, sequence])).toEqual([
      [A, ""],
      [B, "\x1b[4m"],
      [C(1), "\x1b[4m\x1b[58:5:1m"],
      [D(1), "\x1b[4m\x1b[38:5:1m"],
      [C(4), "\x1b[4m\x1b[58:5:4m"],
      [D(4), "\x1b[4m\x1b[38:5:4m"],
    ])
    for (const { sequence, sample } of UNDERLINE_INDEXED_PHASES) {
      expect(sequence).not.toMatch(/[34]8;/)
      expect(sample.trim()).toBe("")
    }
  })
})

describe("indexed underline colour decision: five outcomes in the ruled order", () => {
  test.each([
    [
      "Supported: 58:5:N equals the foreground-route underline at both indices",
      {},
      "supported",
      `${ID}: 58:5:N paints the underline as palette entry N, matched exactly against an underline coloured by the foreground route (N = 1 and 4)`,
    ],
    [
      "Unsupported: 58:5:N keeps the default underline at both indices (the xterm case)",
      { [C(1)]: "plain", [C(4)]: "plain" },
      "unsupported",
      `${ID}: 58:5:N left the underline in its default colour while the same underline took palette entry N by the foreground route (N = 1 and 4): colour ignored, decoration kept`,
    ],
    [
      "not applicable: the plain underline drew nothing",
      { [B]: "blank", [C(1)]: "blank", [C(4)]: "blank" },
      "probe-todo",
      `${ID}: the plain underline drew nothing on these cells, so this row is not applicable here; the underline itself is decided by sgr.underline.single`,
    ],
    [
      "inconclusive: the underline does not follow the foreground, never a statement about 58",
      { [D(1)]: "plain", [C(1)]: "plain", [C(4)]: "plain" },
      "probe-todo",
      `${ID}: the underline under foreground 38:5:1 painted like the default underline, so palette entry 1 cannot be told apart on the foreground route; a terminal whose underline does not follow the foreground stays undecided by this probe, and this says nothing about 58`,
    ],
    [
      "inconclusive: the two palette entries render alike",
      { [D(4)]: "red", [C(4)]: "red" },
      "probe-todo",
      `${ID}: the two palette entries render alike here: the foreground-route underlines for indices 1 and 4 are identical`,
    ],
    [
      "inconclusive: 58:5:N matches neither, with both samples named",
      { [C(4)]: "teal" },
      "probe-todo",
      `${ID}: 58:5:4 changed the underline but matched neither the default underline nor the foreground-route underline (58:5:4 sample teal, 38:5:4 sample blue)`,
    ],
    [
      "inconclusive: the indices disagree",
      { [C(4)]: "plain" },
      "probe-todo",
      `${ID}: the indices disagree: index 1 matched the foreground route, index 4 kept the default colour`,
    ],
  ] as const)("%s", (_case, overrides, status, note) => {
    const decision = underlineColourIndexedDecision(digests(overrides))
    expect(decision).toMatchObject({ status })
    expect(decision.note).toContain(note)
    expect(decision.note).toContain("58:5:1 and 58:5:4 (colon form)")
    expect(decision.note).toContain("38:5:1 and 38:5:4 (colon form)")
  })

  test("a blind control wins over every later check", () => {
    // B equals A and D' equals B: the underline row is named, never the foreground route or 58.
    const decision = underlineColourIndexedDecision(
      digests({ [B]: "blank", [D(1)]: "blank", [D(4)]: "blank", [C(1)]: "blank", [C(4)]: "blank" }),
    )
    expect(decision.note).toContain("not applicable here")
  })

  test("every outcome records all four digests per index", () => {
    for (const overrides of [{}, { [C(1)]: "plain", [C(4)]: "plain" }, { [C(4)]: "teal" }]) {
      expect(underlineColourIndexedDecision(digests(overrides)).evidence).toEqual({
        "1": { A: "blank", B: "plain", C: overrides[C(1)] ?? "red", "D'": "red" },
        "4": { A: "blank", B: "plain", C: overrides[C(4)] ?? "blue", "D'": "blue" },
      })
    }
  })
})

function frame(ref: string): ObservationFrame {
  return { kind: "pixels", ref } as ObservationFrame
}

function run(): SameRunCapture {
  return {
    region: { top: 3, left: 3, bottom: 3, right: 10 },
    pixelGeometry: undefined,
    geometrySource: "cells read from a text source, not from pixels",
    stability: { stable: true },
    frames: [frame("f-stability"), frame("f-target")],
    measured: UNDERLINE_INDEXED_PHASES.map(({ name }) => ({
      name,
      capture: {
        regionDigest: `d-${name}`,
        pixelsDigest: `p-${name}`,
        frame: frame(name === C(1) ? "f-target" : `f-${name}`),
      },
    })) as SameRunCapture["measured"],
  }
}

describe("indexed underline colour callback result", () => {
  test("a decided outcome cites the 58:5:1 frame and carries the evidence in its response", () => {
    const decision = underlineColourIndexedDecision(digests({ [C(1)]: "plain", [C(4)]: "plain" }))
    const result = underlineColourIndexedResult(run(), decision)
    expect(result).toMatchObject({
      pass: false,
      criterionBranch: UNDERLINE_INDEXED_BRANCH,
      tests: [{ id: "attribute", status: "unsupported", assertionRefs: [0] }],
      observation: { outcome: "unsupported", assertionType: "screenshot", screenshotRef: "f-target" },
    })
    expect(JSON.parse(result.response ?? "") as { evidence: unknown }).toMatchObject({ evidence: decision.evidence })
    expect(result.assertions).toHaveLength(1)
  })

  test("an inconclusive outcome asserts nothing and names its reason", () => {
    const decision = underlineColourIndexedDecision(digests({ [C(4)]: "teal" }))
    const result = underlineColourIndexedResult(run(), decision)
    expect(result.assertions).toBeUndefined()
    expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(result.tests).toEqual([{ id: "attribute", status: "probe-todo", reason: decision.note }])
  })

  test("through a multiplexer an Unsupported stays open: the frames cannot separate the mux from its outer terminal", () => {
    const attempt = { scope: "probe" as const, startedAt: "2026-11-11T18:30:00.000Z" }
    const recorded: ProbeResult = {
      featureId: ID,
      status: "unsupported",
      attempt,
      criterionBranch: UNDERLINE_INDEXED_BRANCH,
      assertionType: "screenshot",
      screenshotRef: "f-target",
      reason: "colour ignored",
      tests: [{ id: "attribute", status: "unsupported", attempt, assertionRefs: [0] }],
    }
    const finalized = finalizeVisualResult(recorded, { kind: "mux", outerTerminal: "xterm" }, [frame("f-target")])
    expect(finalized.tests[0]).toMatchObject({ id: "attribute", status: "probe-todo" })
    expect(finalized.reason).toContain("cannot separate the multiplexer from its outer terminal")
  })
})
