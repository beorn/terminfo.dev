/**
 * @failure A row on a text arm is decided as if the collector had pixels — or is refused for lacking
 *   a pixel geometry it can never have — so the 105 hosted-arm rows stay unreadable even with a
 *   text adapter installed.
 * @level l1
 * @consumer captureRegionVerdict, the one region decision every cell-readback row runs.
 * @testonly none
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

/** The step a checkpoint label belongs to, from the labels the decision itself writes. */
function stepContent(label: string): string {
  const step = label.split(": ").slice(1).join(": ")
  if (step.startsWith("post-sequence target")) return "edited"
  if (step.startsWith("expected frame")) return "expected"
  if (step.startsWith("ignored-attribute frame")) return "ignored"
  return "seed"
}

function textFrame(
  label: string,
  role: ObservationFrame["role"],
  applied: "expected" | "other" = "expected",
): ObservationFrame {
  const content = label.includes("capture stability") ? "stable" : stepContent(label)
  const phase = label.endsWith("— baseline") ? "base" : label.includes("paint witness") ? "witness" : "measured"
  // The sequence under test leaves the screen equal to the expected frame: the supported case.
  const screen = content === "edited" && phase === "measured" ? applied : content
  const cells = digest(`${screen}:${phase}`)
  return {
    kind: "text-cells",
    role,
    label,
    capturedAt: Date.now(),
    ref: digest(`${screen}:${phase}:whole`),
    cellDigest: cells,
    frameDigest: digest(`${screen}:${phase}:whole`),
    cellRectangle: { top: 1, left: 1, bottom: 1, right: 8 },
  }
}

const textContext = (): TermContext => ({
  rows: 24,
  cols: 80,
  captureKind: "text-cells",
  capture: async (request) => textFrame(request.label, request.role),
  write() {},
  queryCursorPosition: async () => null,
  measureRenderedWidth: async () => null,
  query: async () => null,
  queryWithSentinel: async () => null,
  queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
  queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
  queryMode: async () => null,
  readInput: async () => null,
})

describe("a text arm decides its rows from cells it read, never from pixels", () => {
  it("names outside-cell whole-window motion while deciding stable compared cells", async () => {
    const ctx = textContext()
    ctx.capture = async (request) => {
      const frame = textFrame(request.label, request.role)
      if (frame.kind !== "text-cells" || !request.label.endsWith("capture stability 2")) return frame
      const whole = digest("outside-cell motion")
      return { ...frame, ref: whole, frameDigest: whole }
    }
    const result = await captureRegionVerdict(ctx, "erase.el", spec)
    expect(result?.observation).toMatchObject({ outcome: "supported", evidence: "text" })
    expect(JSON.parse(String(result?.response)).stability).toMatchObject({
      regionDigest: [digest("stable:measured"), digest("stable:measured")],
      pixelsDigest: [digest("stable:measured:whole"), digest("outside-cell motion")],
      wholeWindowChanged: true,
    })
  })

  it("decides a supported row without ever demanding a pixel report", async () => {
    const result = await captureRegionVerdict(textContext(), "erase.el", spec)
    expect(result?.observation).toMatchObject({ outcome: "supported", evidence: "text" })
    // No image to point at, and a text digest in screenshotRef would be refused at admission.
    expect(result?.observation?.screenshotRef).toBeUndefined()
    expect(result?.observation?.frames?.every((frame) => frame.kind === "text-cells")).toBe(true)
    // The row says what was read, and it must not claim the terminal's own text: on Windows this
    // arm reads a console host's buffer. The host itself is named per read in the frame trace.
    expect(String(result?.response)).toContain("cells read from a text source, not from pixels")
  })

  it("keeps the pixel path untouched when the run's adapter reads pixels", async () => {
    const ctx: TermContext = { ...textContext(), captureKind: "pixels", captureGeometry: undefined }
    const result = await captureRegionVerdict(ctx, "erase.el", spec)
    // The same run, now declaring pixels, must refuse for the missing pixel report by name.
    expect(result?.observation).toMatchObject({ outcome: "inconclusive", evidence: "query" })
  })

  // 29577 option A: a text arm holds one exact cell digest, so it can name only the axes that
  // digest carries — the characters, and the attributes this arm reports. Naming a pixel axis here
  // would claim evidence the arm never read; and naming the axes is not naming a cause, so the
  // verdict and its reason stay exactly as they were.
  it("names the cell axis space on a third distinct frame and keeps the verdict inconclusive", async () => {
    const ctx: TermContext = {
      ...textContext(),
      capture: async (request) => textFrame(request.label, request.role, "other"),
    }
    const result = await captureRegionVerdict(ctx, "erase.el", spec)
    expect(result?.observation).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "text",
    })
    expect(result?.observation?.note).toContain("a third distinct frame")
    expect(result?.observation?.note).toContain("the characters")
    expect(result?.observation?.note).toContain("attributes")
    expect(result?.observation?.note).not.toContain("glyph edges")
    expect(result?.observation?.note).not.toContain("background attributes")
  })
})
