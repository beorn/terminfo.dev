/**
 * @failure A region row inherits a screen a previous probe left undecodable, the text read refuses
 *   the whole window at that cell, and the row lands as a collector error instead of a measurement.
 * @level l1
 * @consumer captureRegionVerdict, the one region decision every cell-readback row runs.
 * @testonly none
 *
 * Measured 2026-10-18 on the hosted Windows arm (28638): `text.wide.emoji-zwj` left a non-BMP glyph
 * at row 1, column 1, and the next 25 region rows each failed with "capture stability 1: the terminal
 * refused the text snapshot — row 1, column 1 holds U+FFFD". The lifecycle clears before the pair
 * reads, so a row never measures a screen another row polluted.
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { captureRegionVerdict, type RegionReadback } from "./region-readback.ts"
import type { ObservationFrame, TermContext } from "./types.ts"

const digest = (seed: string) => `sha256:${createHash("sha256").update(seed).digest("hex")}`

const spec: Omit<RegionReadback, "pixelGeometry"> = {
  region: { top: 1, left: 1, bottom: 1, right: 8 },
  sentinel: { row: 3, col: 1 },
  cursorRow: 4,
  seed: "\u001b[1;1Hseed",
  edit: "\u001b[1;3H\u001b[1P",
  expected: "\u001b[1;1Hexpected",
  timeoutMs: 100,
  pollMs: 1,
  minRows: 2,
  minCols: 9,
}

function textFrame(label: string, role: ObservationFrame["role"]): ObservationFrame {
  const phase = label.endsWith("— baseline") ? "base" : label.includes("paint witness") ? "witness" : "measured"
  return {
    kind: "text-cells",
    role,
    label,
    capturedAt: Date.now(),
    ref: digest(`${phase}:whole`),
    cellDigest: digest(phase),
    frameDigest: digest(`${phase}:whole`),
    cellRectangle: { top: 1, left: 1, bottom: 1, right: 8 },
  }
}

/** A text arm whose screen still holds the previous probe's non-BMP glyph until something clears it. */
function poisonedContext(): { ctx: TermContext; writes: string[]; readsAt: () => number[] } {
  const writes: string[] = []
  const readsAt: number[] = []
  let undecodable = true
  const ctx: TermContext = {
    rows: 24,
    cols: 80,
    captureKind: "text-cells",
    capture: async (request) => {
      readsAt.push(writes.length)
      if (undecodable) {
        throw new Error(
          `${request.label}: the terminal refused the text snapshot — row 1, column 1 holds U+FFFD, ` +
            "the host's stand-in for a glyph longer than one UTF-16 unit, so this region cannot be read as characters",
        )
      }
      return textFrame(request.label, request.role)
    },
    write(sequence) {
      writes.push(sequence)
      if (sequence.includes("\u001b[2J")) undecodable = false
    },
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
    readInput: async () => null,
  }
  return { ctx, writes, readsAt: () => readsAt }
}

describe("a region row reads a screen the lifecycle cleared, never a previous probe's leftover", () => {
  it("measures its own region instead of failing on the glyph the previous row left at 1,1", async () => {
    const { ctx, writes, readsAt } = poisonedContext()
    const result = await captureRegionVerdict(ctx, "erase.character", spec)
    expect(result).not.toBeNull()
    expect(result?.observation?.note ?? "").not.toContain("refused the text snapshot")
    expect(result?.observation?.outcome).not.toBe("error")
    // The clear lands before the first read: that is the whole contract this test pins.
    const clear = writes.indexOf("\u001b[2J\u001b[H")
    expect(clear).toBeGreaterThanOrEqual(0)
    expect(readsAt()[0]).toBeGreaterThan(clear)
  })
})
