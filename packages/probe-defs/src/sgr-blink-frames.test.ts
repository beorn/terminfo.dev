/**
 * @failure sgr.blink captures one target frame, so a blinking terminal photographed in its off phase reads the same
 *   as one that never blinks, and seven app cells cannot be decided (#31812); or a redraw that moves the screen is
 *   read as blink.
 * @level l1
 * @consumer app sgr.blink results projected into terminal support cells
 * @testonly none
 */
import { expect, test } from "vitest"
import { sgrProbes } from "./sgr.ts"
import type { CaptureCells, ObservationFrame, TermProbeSource } from "./types.ts"

function blink() {
  const probe = sgrProbes.find((value) => value.id === "sgr.blink")
  if (!probe?.term) throw new Error("missing sgr.blink term callback")
  return probe
}

const GEOMETRY = {
  geometry: { cellWidth: 8, cellHeight: 16, textWidth: 640, textHeight: 384 },
  source: "measured by complete raster calibration" as const,
}

/** An app context whose capture answers each styled sample with the next digest in `styled`, and each plain
 *  line sample with the next one in `plain`; the control frame takes the first styled value. */
function app(opts: { styled: readonly string[]; plain: readonly string[]; geometry: boolean }) {
  const writes: string[] = []
  const captures: Array<{ writes: number; at: number; label: string; cells?: CaptureCells }> = []
  let styled = 0
  let plain = 0
  const context: TermProbeSource = {
    kind: "live",
    write: (bytes) => writes.push(bytes),
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
    cols: 80,
    rows: 24,
    ...(opts.geometry ? { captureGeometry: GEOMETRY } : {}),
    capture: async ({ role, label, cells }): Promise<ObservationFrame> => {
      captures.push({ writes: writes.length, at: Date.now(), label, ...(cells ? { cells } : {}) })
      const index = captures.length
      const base = { role, label, capturedAt: index, ref: `frame-${String(index)}` }
      if (!cells) return { ...base, pixelsDigest: `whole-${String(index)}` }
      const isPlain = cells.top === 1
      const digest = isPlain ? opts.plain[plain++] : role === "control" ? "unstyled" : opts.styled[styled++]
      return {
        ...base,
        regionDigest: digest,
        pixelsDigest: `whole-${String(index)}`,
        regionRectangle: { x: 16, y: isPlain ? 64 : 32, width: 8 * (cells.right - cells.left + 1), height: 16 },
      }
    },
  }
  return { context, writes, captures }
}

test("blink samples the styled text four times over 750 ms with no write between, beside a plain line", async () => {
  const { context, writes, captures } = app({
    styled: ["on", "off", "on", "off"],
    plain: ["p", "p", "p", "p"],
    geometry: true,
  })
  const result = await blink().term!(context)
  const samples = captures.filter((entry) => entry.cells?.top === 3).slice(1)
  expect(samples).toHaveLength(4)
  expect(captures.filter((entry) => entry.cells?.top === 1)).toHaveLength(4)
  // Every sample is taken after the one fixture write and before any cleanup write.
  expect(new Set(captures.slice(1).map((entry) => entry.writes)).size).toBe(1)
  expect(samples.at(-1)!.at - samples[0]!.at).toBeGreaterThanOrEqual(740)
  expect(writes.join("")).toContain("\x1b[5m")
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "screenshot" })
  expect(result.assertions).toMatchObject([{ kind: "positive" }])
  expect(JSON.parse(result.response ?? "")).toMatchObject({ styled: ["on", "off", "on", "off"] })
})

test("four equal blink samples stay inconclusive: no blink period is recorded, so they are not Unsupported", async () => {
  const { context } = app({ styled: ["on", "on", "on", "on"], plain: ["p", "p", "p", "p"], geometry: true })
  const result = await blink().term!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", note: expect.stringContaining("blink period") })
  expect(result.observation?.outcome).not.toBe("unsupported")
})

test("a plain line that moves between samples vetoes blink: redraw, scroll or cursor motion is not blink", async () => {
  const { context } = app({ styled: ["on", "off", "on", "off"], plain: ["p", "p", "q", "p"], geometry: true })
  const result = await blink().term!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", note: expect.stringContaining("plain line") })
})

test("without a measured raster the control and four blink samples go to review together", async () => {
  const { context, captures } = app({ styled: [], plain: [], geometry: false })
  const result = await blink().term!(context)
  expect(captures).toHaveLength(5)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", assertionType: "screenshot" })
  expect(result.observation?.frames).toHaveLength(5)
  expect(result.tests).toMatchObject([
    { id: "capture", status: "supported" },
    { id: "review", status: "test-todo" },
  ])
})
