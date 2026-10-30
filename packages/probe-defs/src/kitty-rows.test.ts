/**
 * @failure A kitty pixel row decides from one frame, or from the terminal's acknowledgement, so the
 *   published cell for animation or unicode placeholders claims a render nobody captured.
 * @level l1
 * @consumer The application and mux callbacks for extensions.kitty-graphics.animation and
 *   extensions.kitty-graphics.unicode-placeholders.
 * @testonly none
 */
import { expect, test } from "vitest"
import { extensionsProbes } from "./extensions.ts"
import { KITTY_GUARD_REGION, KITTY_GUARD_TEXT, KITTY_REGION } from "./kitty-capture.ts"
import type { ObservationFrame, TermProbeSource, TerminalQueryOutcome } from "./types.ts"

const GEOMETRY = {
  geometry: { cellWidth: 10, cellHeight: 20, textWidth: 800, textHeight: 480 },
  source: "measured by complete raster calibration" as const,
}

interface Surface {
  /** Region digests handed out in capture order; the last one repeats. */
  readonly region: readonly (string | undefined)[]
  /** Digests for captures of the layout-guard rectangle, in capture order; the last one repeats. */
  readonly guard?: readonly string[]
  /** Whole-window digests handed out for captures that name no cells. */
  readonly whole?: readonly string[]
  /** What the terminal answers a `_G` command with. */
  readonly ack?: "ok" | "silent"
  /** Cell digests for the placeholder readback pair, when this run reads cells at all. */
  readonly cells?: readonly string[]
}

interface Capture {
  readonly role: string
  readonly label: string
  readonly cells: boolean
  /** How many writes had happened when this capture was taken. */
  readonly writesBefore: number
  readonly ref: string
}

function surface(options: Surface) {
  const writes: string[] = []
  const captures: Capture[] = []
  let regionIndex = 0
  let guardIndex = 0
  let wholeIndex = 0
  const ack = (): TerminalQueryOutcome => {
    if (options.ack === "silent") return { match: null, reason: "timeout", raw: "", rawBase64: "" }
    const raw = "\x1b_Gi=1;OK\x1b\\"
    const match = raw.match(/\x1b_Gi=(\d+);([^\x1b]+)\x1b\\/u)
    return { match, reason: "reply", raw, rawBase64: btoa(raw) }
  }
  const context: TermProbeSource = {
    kind: "live",
    rows: 24,
    cols: 80,
    captureGeometry: GEOMETRY,
    write: (bytes) => {
      writes.push(bytes)
    },
    queryCursorPosition: async () => ({ row: 1, col: 1 }),
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async (sequence) => {
      writes.push(sequence)
      return ack()
    },
    // The owned adapter writes the sequence and then reads its reply, so the command is part of the
    // write trace exactly as it is on a real run.
    queryWithSentinelOutcome: async (sequence) => {
      writes.push(sequence)
      return ack()
    },
    queryMode: async () => null,
    capture: async ({ role, label, cells }) => {
      const index = captures.length + 1
      const ref = `sha256:${String(index).padStart(64, "0")}`
      captures.push({ role, label, cells: cells !== undefined, writesBefore: writes.length, ref })
      if (cells !== undefined) {
        const isGuard =
          cells.top === KITTY_GUARD_REGION.top &&
          cells.left === KITTY_GUARD_REGION.left &&
          cells.bottom === KITTY_GUARD_REGION.bottom &&
          cells.right === KITTY_GUARD_REGION.right
        const queue = isGuard ? (options.guard ?? ["guard"]) : options.region
        const digest = isGuard
          ? queue[Math.min(guardIndex, queue.length - 1)]
          : queue[Math.min(regionIndex, queue.length - 1)]
        if (isGuard) guardIndex += 1
        else regionIndex += 1
        return {
          role,
          label,
          ref,
          capturedAt: index,
          regionDigest: digest,
          pixelsDigest: `whole-${String(digest)}`,
          regionRectangle: { x: 20, y: 40, width: 20, height: 40 },
        } satisfies ObservationFrame
      }
      const whole = options.whole?.[Math.min(wholeIndex, (options.whole?.length ?? 1) - 1)] ?? "whole-same"
      wholeIndex += 1
      return { role, label, ref, capturedAt: index, pixelsDigest: whole } satisfies ObservationFrame
    },
  }
  if (options.cells) {
    let cellIndex = 0
    context.cells = async ({ role, label, cells }) => {
      const index = captures.length + 1
      const digest = options.cells?.[Math.min(cellIndex, (options.cells?.length ?? 1) - 1)]
      cellIndex += 1
      const frame = {
        kind: "text-cells" as const,
        role,
        label,
        ref: `sha256:cells-${String(index)}`,
        capturedAt: index,
        cellDigest: String(digest),
        frameDigest: `cells-frame-${String(digest)}`,
        cellRectangle: { ...KITTY_REGION },
      }
      captures.push({ role, label, cells: cells !== undefined, writesBefore: writes.length, ref: frame.ref })
      return frame
    }
  }
  return { context, captures, writes }
}

function term(id: string) {
  const definition = extensionsProbes.find((probe) => probe.id === id)
  if (!definition?.term) throw new Error(`${id} needs an application callback`)
  return definition.term
}

for (const featureId of ["extensions.kitty-graphics.animation", "extensions.kitty-graphics.unicode-placeholders"]) {
  test(`${featureId} names missing cell-aligned region readback without dropping frames`, async () => {
    const { context } = surface({ region: [undefined] })
    const result = await term(featureId)(context)
    expect(result.tests).toEqual([
      {
        id: "review",
        status: "test-todo",
        reason: expect.stringContaining("this arm supplied no cell-aligned region, so nothing could be compared"),
      },
    ])
    expect(result.criterionBranch).toBe("headless-observable-review")
    expect(result.observation?.frames?.length).toBeGreaterThan(0)
    expect(result.observation?.outcome).toBe("inconclusive")
    expect(result.assertions).toBeUndefined()
  })

  test(`${featureId} names the text-only pixel readback gap`, async () => {
    const { context, captures } = surface({ region: ["unused"] })
    context.captureKind = "text-cells"
    const result = await term(featureId)(context)
    expect(result.tests).toEqual([{ id: "review", status: "test-todo", reason: expect.stringContaining("pixels") }])
    expect(result.criterionBranch).toBe("headless-observable-review")
    expect(captures).toHaveLength(0)
    expect(result.assertions).toBeUndefined()
  })
}

test("animation decides from two target frames with no write between them", async () => {
  const { context, captures } = surface({
    region: ["red", "blue", "frame1", "frame2", "still", "still", "cursor", "cursor"],
    whole: ["before", "after"],
  })
  const result = await term("extensions.kitty-graphics.animation")(context)
  const frames = result.observation?.frames ?? []
  const targets = frames.filter((frame) => frame.role === "target")
  // The collapse this row must prevent: one target frame, or a second target read after a write.
  expect(targets.length).toBeGreaterThanOrEqual(2)
  expect(targets[0]?.ref).not.toBe(targets[1]?.ref)
  const playbackCaptures = captures.slice(0, 2)
  expect(playbackCaptures.map((capture) => capture.cells)).toEqual([true, true])
  expect(playbackCaptures[0]?.writesBefore).toBe(playbackCaptures[1]?.writesBefore)
  expect(result.observation?.outcome).toBe("supported")
  expect(result.observation?.assertionType).toBe("screenshot")
  expect(result.assertions).toMatchObject([{ kind: "positive", assertionType: "screenshot" }])
  // Both playback frames are target frames of the SAME run, which the reader requires.
  expect(result.observation?.screenshotRef).toBe(targets[1]?.ref)
})

test("an acknowledgement with unchanging pixels is not animation support", async () => {
  const { context } = surface({ region: ["same"], whole: ["whole", "whole"], ack: "ok" })
  const result = await term("extensions.kitty-graphics.animation")(context)
  expect(result.observation?.outcome).not.toBe("supported")
  expect(result.pass).toBe(false)
  // Frame selection could not differ either, so the row names the pipeline rather than the timer.
  expect(result.observation?.note).toContain("selecting frame 2 by hand left the rectangle unchanged")
})

test("an equal playback pair on a live pipeline with a stable still image is a negative", async () => {
  const { context } = surface({
    // same, same (playback), same (retry at twice the gap), then the controls.
    region: ["same", "same", "same", "frame1", "frame2", "still", "still", "cursor", "cursor"],
    whole: ["before", "after"],
  })
  const result = await term("extensions.kitty-graphics.animation")(context)
  expect(result.observation?.outcome).toBe("unsupported")
  expect(result.assertions).toMatchObject([{ kind: "negative", assertionType: "screenshot" }])
  expect(result.observation?.note).toContain("twice the gap")
})

test("placeholders decide from pixels, with the quiet transmit and an ordinary placement alive", async () => {
  const { context, writes, captures } = surface({
    // grid with image (twice), grid with the image deleted, blank, then the ordinary placement of the
    // same pixels — which must land on the SAME digest as the with-image rectangle.
    region: ["with-image", "with-image", "text-only", "blank", "with-image"],
    guard: ["guard", "guard"],
    cells: ["placeholder-cells", "placeholder-cells"],
  })
  const result = await term("extensions.kitty-graphics.unicode-placeholders")(context)
  const joined = writes.join("")
  // Quiet virtual placement: no reply can be inherited as evidence.
  expect(joined).toContain("a=T,U=1")
  expect(joined).toContain("q=2")
  // The placeholder characters and the id in the foreground colour, in BOTH states.
  expect(joined.split("\u{10EEEE}").length - 1).toBe(8)
  expect(joined).toContain("[38;5;")
  // Control 1: the same guard bytes beside the grid and on the row below it, in BOTH states.
  expect(joined.split(KITTY_GUARD_TEXT).length - 1).toBe(6)
  // The live control is a real placement of the same pixels, not an acknowledgement.
  expect(joined).toContain("a=p,i=")
  // The guard rectangle is captured in each state, so a reflow between them is observable.
  expect(captures.filter((capture) => capture.label.includes("Layout guard")).length).toBe(2)
  expect(result.observation?.outcome).toBe("supported")
  expect(result.assertions).toMatchObject([{ kind: "positive", assertionType: "screenshot" }])
  expect(result.response).toContain('"guard"')
})

test("an accepted quiet transmit with identical pixels is not placeholder support", async () => {
  const { context } = surface({
    region: ["same", "same", "same", "blank", "ordinary"],
    guard: ["guard", "guard"],
    cells: ["placeholder-cells", "placeholder-cells"],
    ack: "ok",
  })
  const result = await term("extensions.kitty-graphics.unicode-placeholders")(context)
  expect(result.observation?.outcome).toBe("unsupported")
  expect(result.pass).toBe(false)
  expect(result.assertions).toMatchObject([{ kind: "negative" }])
})

test("a pixel arm with no cell adapter decides from pixels and records the absent adapter", async () => {
  const { context } = surface({
    region: ["with-image", "with-image", "text-only", "blank", "with-image"],
    guard: ["guard", "guard"],
  })
  const result = await term("extensions.kitty-graphics.unicode-placeholders")(context)
  expect(result.observation?.outcome).toBe("supported")
  expect(result.response).toContain("unavailable: this pixel arm exposes no cell adapter")
})

test("cells that read back differently veto before the pixel table", async () => {
  const { context } = surface({
    region: ["with-image", "with-image", "text-only", "blank", "with-image"],
    guard: ["guard", "guard"],
    cells: ["placeholder-cells", "different-cells"],
  })
  const result = await term("extensions.kitty-graphics.unicode-placeholders")(context)
  expect(result.observation?.outcome).toBe("inconclusive")
  expect(result.observation?.note).toContain("read back differently")
  expect(result.pass).toBe(false)
})

test("a guard that moves between the two states is inconclusive by name, never a verdict", async () => {
  const { context } = surface({
    region: ["with-image", "with-image", "text-only", "blank", "with-image"],
    guard: ["guard", "shifted-guard"],
    cells: ["placeholder-cells", "placeholder-cells"],
  })
  const result = await term("extensions.kitty-graphics.unicode-placeholders")(context)
  expect(result.observation?.outcome).toBe("inconclusive")
  expect(result.observation?.note).toContain("layout changed between states")
  expect(result.assertions).toBeUndefined()
})

test("a placeholder rectangle that is not pixel-identical to the ordinary placement is inconclusive", async () => {
  const { context } = surface({
    // Rendered something, but not the same pixels an a=p placement of the same image produces.
    region: ["with-image", "with-image", "text-only", "blank", "other-pixels"],
    guard: ["guard", "guard"],
    cells: ["placeholder-cells", "placeholder-cells"],
  })
  const result = await term("extensions.kitty-graphics.unicode-placeholders")(context)
  expect(result.observation?.outcome).toBe("inconclusive")
  expect(result.observation?.note).toContain("not pixel-identical to ordinary placement")
  expect(result.pass).toBe(false)
})

test("a text snapshot never decides either row", async () => {
  for (const id of ["extensions.kitty-graphics.animation", "extensions.kitty-graphics.unicode-placeholders"]) {
    const { context } = surface({ region: ["a", "b"] })
    const textOnly: TermProbeSource = { ...context, captureKind: "text-cells", capture: undefined }
    const result = await term(id)(textOnly)
    // A text-only arm is an execution limit with no observable at all, never a verdict.
    expect(result.observation, id).toBeUndefined()
    expect(result.tests, id).toMatchObject([expect.objectContaining({ status: "test-todo" })])
  }
})
