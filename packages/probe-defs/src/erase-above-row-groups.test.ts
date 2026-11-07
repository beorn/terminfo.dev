/**
 * @failure erase.screen.above's pixel arm reads a terminal that left the row above the cursor
 *   unchanged as "a third distinct frame", or a row-group compare grades Unsupported when row 1 did
 *   erase, when the expected frame cannot show a change above the cursor, or when the rows at and
 *   below the cursor missed the expected frame.
 * @level l1
 * @consumer App erase observations projected into terminal support cells.
 * @testonly none
 */
import { createHash } from "node:crypto"
import { expect, test } from "vitest"
import { ALL_PROBES } from "./index.ts"
import type { CaptureRequest, ObservationFrame, TermProbeSource } from "./types.ts"

const ID = "erase.screen.above"
const REASON =
  "ED1 left the row above the cursor unchanged, with the cursor on row 2; the rows at and below the cursor match the expected frame. A lower cursor is not run."
const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`

/** One frame's three digests: the whole region, the rows above the cursor, the rows at and below it. */
interface FrameDigests {
  region: string
  above: string
  below: string
}

/**
 * The real digests of Alacritty 0.17.0's retained frames, run
 * apps/alacritty/linux/runs/2026-11-07T02-02-11-982Z-97d4e2c2cccb: the region digests are the run's
 * stored ones, and the row-group digests crop the same retained PNGs at {0,0 50x18} and {0,18 50x36}
 * (5 columns of 10 px, rows of 18 px), the way capture-core.ts digests a crop. The crop reproduces
 * all three stored region digests first (#32581, /hh/var/@dev/18/erase-above/crop-proof.txt).
 */
const ALACRITTY_0_17_0: Record<"seed" | "target" | "expected", FrameDigests> = {
  seed: {
    region: "sha256:480cf7fb70ee5efd0ee857afd507e5e44362806f3223e9425af3302c383d9e7c",
    above: "sha256:e0cf0c0dcc2529b7b77d7bb88470bcc781cb6d1fd94e2e935052719ef10f1c22",
    below: "sha256:73587b473e5e903f5e508068f868eac031b28a43dbe823820c9ff997daf0edcc",
  },
  target: {
    region: "sha256:0ca24628857a1891742873a2ad78252c26eb4367c42f8bb7cfb6c70ae782a2ac",
    above: "sha256:e0cf0c0dcc2529b7b77d7bb88470bcc781cb6d1fd94e2e935052719ef10f1c22",
    below: "sha256:eda80df4d941cda9b485673b961b9f2d4345b0e165f6df6b691947a4fbc05c07",
  },
  expected: {
    region: "sha256:e917234eb4e0728b1c187437ad55aaf6fb37e5586ddfb4c54fbe1e5db9590ad5",
    above: "sha256:d23d860da2f2d571ffe7ebaf6695267f283fd48b659cdaf69892f3d71df66c7a",
    below: "sha256:eda80df4d941cda9b485673b961b9f2d4345b0e165f6df6b691947a4fbc05c07",
  },
}

/** A live-shaped frame set: the seed, a correct expected frame, and the given target. */
function shaped(
  target: FrameDigests,
  expected: FrameDigests = { region: digest("expected"), above: digest("blank row"), below: digest("expected below") },
) {
  return {
    seed: { region: digest("seed"), above: digest("AAAAA"), below: digest("seed below") },
    target,
    expected,
  }
}

/**
 * A terminal with Alacritty's window (800x600, 10x18 cells) whose capture adapter answers each read
 * by its label: the stability pair holds still, the paint witness repaints on every witness glyph,
 * and each frame's region and row-group reads return the digests the case names. Every rectangle is
 * derived from the requested cells, so two reads of the same cells share one rectangle.
 */
function terminal(frames: Record<"seed" | "target" | "expected", FrameDigests>) {
  const captured: ObservationFrame[] = []
  let witness = 0
  const byLabel = (label: string): string | undefined => {
    for (const [name, step] of [
      ["seed", "pre-edit seed"],
      ["target", "post-sequence target"],
      ["expected", "expected frame"],
    ] as const) {
      const frame = frames[name]
      if (label === `${ID}: ${step}`) return frame.region
      if (label === `${ID}: ${step} — rows above the cursor`) return frame.above
      if (label === `${ID}: ${step} — rows at and below the cursor`) return frame.below
    }
    return undefined
  }
  const capture = async (request: CaptureRequest): Promise<ObservationFrame> => {
    const cells = request.cells!
    const single = cells.top === cells.bottom && cells.left === cells.right
    const regionDigest = request.label.includes("capture stability")
      ? digest("stability")
      : single
        ? digest(`witness ${witness}`)
        : byLabel(request.label)
    if (regionDigest === undefined) throw new Error(`unexpected capture request: ${request.label}`)
    const frame: ObservationFrame = {
      role: request.role,
      label: request.label,
      capturedAt: captured.length + 1,
      ref: digest(`${request.label}#${captured.length}`),
      regionDigest,
      pixelsDigest: digest(`window ${captured.length}`),
      regionRectangle: {
        x: (cells.left - 1) * 10,
        y: (cells.top - 1) * 18,
        width: (cells.right - cells.left + 1) * 10,
        height: (cells.bottom - cells.top + 1) * 18,
      },
    }
    captured.push(frame)
    return frame
  }
  const reply = (sequence: string) =>
    sequence === "\u001b[16t"
      ? { match: ["6;18;10", "18", "10"], reason: "reply", raw: sequence, rawBase64: "" }
      : sequence === "\u001b[14t"
        ? { match: ["4;600;800", "600", "800"], reason: "reply", raw: sequence, rawBase64: "" }
        : { match: null, reason: "sentinel", raw: "\u001b[?6c", rawBase64: "G1s/NmM=" }
  const ctx: TermProbeSource = {
    kind: "live",
    cols: 80,
    rows: 24,
    write(text) {
      if (/^\u001b\[\d+;\d+H[0-9]$/.test(text)) witness += 1
    },
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async (sequence) =>
      reply(sequence) as unknown as Awaited<ReturnType<TermProbeSource["queryWithSentinelOutcome"]>>,
    queryMode: async () => null,
    capture,
  }
  return { ctx, captured }
}

async function decide(frames: Record<"seed" | "target" | "expected", FrameDigests>) {
  const probe = ALL_PROBES.find((candidate) => candidate.id === ID)
  expect(probe?.term, `${ID} has a pixel arm`).toBeDefined()
  const { ctx, captured } = terminal(frames)
  return { result: await probe!.term!(ctx), captured }
}

test("Alacritty 0.17.0's retained frames read Unsupported from the row groups, with the ruled reason (#32581)", async () => {
  const { result, captured } = await decide(ALACRITTY_0_17_0)
  expect(result.observation?.outcome).toBe("unsupported")
  expect(result.observation?.note).toBe(REASON)
  expect(result.assertions?.[0]?.kind).toBe("negative")
  // Six extra reads, two per compared frame, each over its own row group of the 5x3 region.
  const groups = captured.filter((frame) => frame.label.includes(" — rows "))
  expect(groups.map((frame) => [frame.label.replace(`${ID}: `, ""), frame.regionRectangle])).toEqual([
    ["pre-edit seed — rows above the cursor", { x: 0, y: 0, width: 50, height: 18 }],
    ["pre-edit seed — rows at and below the cursor", { x: 0, y: 18, width: 50, height: 36 }],
    ["post-sequence target — rows above the cursor", { x: 0, y: 0, width: 50, height: 18 }],
    ["post-sequence target — rows at and below the cursor", { x: 0, y: 18, width: 50, height: 36 }],
    ["expected frame — rows above the cursor", { x: 0, y: 0, width: 50, height: 18 }],
    ["expected frame — rows at and below the cursor", { x: 0, y: 18, width: 50, height: 36 }],
  ])
})

// Each case misses one of the three conditions, so the region's own third-frame verdict stands.
test.each([
  [
    "row 1 did erase, but the rows at and below the cursor missed the expected frame",
    shaped({ region: digest("target"), above: digest("blank row"), below: digest("target below") }),
  ],
  [
    "row 1 kept the seed, but the rows at and below the cursor missed the expected frame",
    shaped({ region: digest("target"), above: digest("AAAAA"), below: digest("target below") }),
  ],
  [
    "the expected frame leaves row 1 as the seed, so an unchanged row 1 shows nothing",
    shaped(
      { region: digest("target"), above: digest("AAAAA"), below: digest("expected below") },
      { region: digest("expected"), above: digest("AAAAA"), below: digest("expected below") },
    ),
  ],
])("%s: today's third-frame result, never Unsupported", async (_name, frames) => {
  const { result } = await decide(frames)
  expect(result.observation?.outcome).toBe("inconclusive")
  expect(result.observation?.note).toContain(`${ID}: a third distinct frame`)
})
