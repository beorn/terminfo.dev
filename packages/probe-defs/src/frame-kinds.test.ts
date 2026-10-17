/**
 * @failure A text snapshot and a pixel witness become interchangeable, so a row is decided from a
 *   surface that never saw a pixel — or a pixel frame's absent digest starts meaning two things
 *   depending on who reads it.
 * @level l1
 * @consumer frameDigests, the one accessor the three-frame comparison reads both kinds through.
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { frameDigests, type ObservationFrame } from "./types.ts"

const base = { ref: "sha256:aa", capturedAt: 1, label: "frame" } as const

describe("ObservationFrame kinds — mutually exclusive by construction", () => {
  it("reads a pixel frame's two raw-pixel digests through the accessor", () => {
    const frame: ObservationFrame = {
      ...base,
      role: "control",
      regionDigest: "sha256:cell",
      pixelsDigest: "sha256:whole",
    }
    expect(frameDigests(frame)).toEqual({ cells: "sha256:cell", whole: "sha256:whole" })
  })

  it("reads a text frame's two cell digests through the SAME accessor", () => {
    const frame: ObservationFrame = {
      ...base,
      role: "target",
      kind: "text-cells",
      cellDigest: "sha256:text-cells",
      frameDigest: "sha256:text-whole",
      cellRectangle: { top: 1, left: 1, bottom: 1, right: 3 },
    }
    expect(frameDigests(frame)).toEqual({ cells: "sha256:text-cells", whole: "sha256:text-whole" })
    // A text frame never reads a pixel field, even when a hand-built run carries one: the accessor
    // branches on the kind, so the raw JSON cannot smuggle a raster digest into a cell comparison.
    const mixed = {
      ...frame,
      regionDigest: "sha256:pixel-cells",
      pixelsDigest: "sha256:pixel-whole",
    } as unknown as ObservationFrame
    expect(frameDigests(mixed)).toEqual({ cells: "sha256:text-cells", whole: "sha256:text-whole" })
  })

  it("keeps a missing digest meaning exactly one thing per kind", () => {
    const pixel: ObservationFrame = { ...base, role: "control" }
    expect(frameDigests(pixel)).toEqual({ cells: undefined, whole: undefined })
  })
})
