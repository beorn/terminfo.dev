/**
 * @failure A kitty pixel row decides from one frame, or from the terminal's acknowledgement, so the
 *   published cell for animation or unicode placeholders claims a render nobody captured.
 * @level l1
 * @consumer The application and mux callbacks for extensions.kitty-graphics.animation and
 *   extensions.kitty-graphics.unicode-placeholders, and the display row's App pixel arm (#34932).
 * @testonly none
 */
import { expect, test } from "vitest"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseProbeResults } from "@terminfo/run-parser"
import { extensionsProbes } from "./extensions.ts"
import { recordExecutedProbe } from "./helpers.ts"
import { KITTY_GUARD_REGION, KITTY_GUARD_TEXT, KITTY_REGION, KITTY_ROW_IMAGES } from "./kitty-capture.ts"
import type {
  CaptureLayoutGuard,
  CaptureLayoutGuardRequest,
  ObservationFrame,
  TermProbeSource,
  TerminalQueryOutcome,
} from "./types.ts"
import { finishCapture } from "../../terminfo.dev/src/capture-core.ts"

const sha = (seed: string) => `sha256:${createHash("sha256").update(seed).digest("hex")}`

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
  /** An `a=p` placement answered by DA1 only, as WezTerm does (27915), while transfers still answer. */
  readonly placement?: "silent"
  /** Cell digests for the placeholder readback pair, when this run reads cells at all. */
  readonly cells?: readonly string[]
  /** The collector's answer to a guard capture that names `layoutGuard.against` (#34932). */
  readonly guardComparison?: Omit<CaptureLayoutGuard, "against">
}

interface Capture {
  readonly role: string
  readonly label: string
  readonly cells: boolean
  /** How many writes had happened when this capture was taken. */
  readonly writesBefore: number
  readonly ref: string
  readonly layoutGuard?: CaptureLayoutGuardRequest
}

function surface(options: Surface) {
  const writes: string[] = []
  const captures: Capture[] = []
  let regionIndex = 0
  let guardIndex = 0
  let wholeIndex = 0
  const ack = (sequence: string): TerminalQueryOutcome => {
    if (options.ack === "silent") return { match: null, reason: "timeout", raw: "", rawBase64: "" }
    if (options.placement === "silent" && sequence.startsWith("\x1b_Ga=p,")) {
      const raw = "\x1b[?62;22c"
      return { match: null, reason: "sentinel", raw, rawBase64: btoa(raw), sentinel: { atMs: 3, graceMs: 250 } }
    }
    const imageNumber = /(?:,|_)I=(\d+)/.exec(sequence)?.[1]
    const raw = imageNumber ? `\x1b_Gi=1,I=${imageNumber};OK\x1b\\` : "\x1b_Gi=1;OK\x1b\\"
    if (imageNumber) {
      return { match: raw.match(/\x1b_G([^;]+);([^\x1b]+)\x1b\\/u), reason: "reply", raw, rawBase64: btoa(raw) }
    }
    const match = raw.match(/\x1b_Gi=(\d+);([^\x1b]+)\x1b\\/u)
    return { match, reason: "reply", raw, rawBase64: btoa(raw) }
  }
  const context: TermProbeSource = {
    kind: "live",
    now: () => Date.now(),
    randomUUID: () => globalThis.crypto.randomUUID(),
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
      return ack(sequence)
    },
    // The owned adapter writes the sequence and then reads its reply, so the command is part of the
    // write trace exactly as it is on a real run.
    queryWithSentinelOutcome: async (sequence) => {
      writes.push(sequence)
      return ack(sequence)
    },
    queryMode: async () => null,
    capture: async ({ role, label, cells, layoutGuard }) => {
      const index = captures.length + 1
      const ref = `sha256:${String(index).padStart(64, "0")}`
      captures.push({
        role,
        label,
        cells: cells !== undefined,
        writesBefore: writes.length,
        ref,
        ...(layoutGuard === undefined ? {} : { layoutGuard }),
      })
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
          ...(layoutGuard?.against !== undefined && options.guardComparison !== undefined
            ? { layoutGuardComparison: { against: layoutGuard.against, ...options.guardComparison } }
            : {}),
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
        status: "probe-todo",
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
    expect(result.tests).toEqual([{ id: "review", status: "probe-todo", reason: expect.stringContaining("pixels") }])
    expect(result.criterionBranch).toBe("headless-observable-review")
    expect(captures).toHaveLength(0)
    expect(result.assertions).toBeUndefined()
  })
}

test("animation decides from two target frames with no write between them", async () => {
  const { context, captures } = surface({
    region: ["blank", "red", "blue", "red", "red", "cursor", "cursor", "red", "blue", "red", "blue"],
    whole: ["before", "after"],
  })
  const result = await term("extensions.kitty-graphics.animation")(context)
  const frames = result.observation?.frames ?? []
  const targets = frames.filter((frame) => frame.role === "target")
  // The collapse this row must prevent: one target frame, or a second target read after a write.
  expect(targets.length).toBeGreaterThanOrEqual(2)
  expect(targets[0]?.ref).not.toBe(targets[1]?.ref)
  const playbackCaptures = captures.filter((capture) => capture.role === "target").slice(0, 2)
  expect(playbackCaptures.map((capture) => capture.cells)).toEqual([true, true])
  expect(playbackCaptures[0]?.writesBefore).toBe(playbackCaptures[1]?.writesBefore)
  expect(result.observation?.outcome).toBe("supported")
  expect(result.observation?.assertionType).toBe("screenshot")
  expect(result.assertions).toMatchObject([{ kind: "positive", assertionType: "screenshot" }])
  // Both playback frames are target frames of the SAME run, which the reader requires.
  expect(result.observation?.screenshotRef).toBe(targets[1]?.ref)
})

// The feature model above deliberately supplies digests, but does not finalize checkpoints.
// Seven retained App runs fail at the real finalizer before their redraw control can decide.
// Exercise that boundary here; keep the existing playback-on/off cases as the feature's owner.
test("animation whole-window redraw checkpoints satisfy the production capture finalizer", async () => {
  const { context } = surface({
    region: ["blank", "red", "blue", "red", "red", "cursor", "cursor", "red", "blue", "red", "blue"],
    whole: ["before", "after"],
  })
  const capture = context.capture!
  const directory = mkdtempSync(join(tmpdir(), "terminfo-animation-finalizer-"))
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
  try {
    context.capture = async (checkpoint) => {
      if (!checkpoint.cells) {
        await finishCapture({
          directory,
          onRetained: () => {},
          checkpoint: { featureId: "extensions.kitty-graphics.animation", ...checkpoint },
          source: { bytes: png, format: "png", width: 1, height: 1, capturedAt: 1 },
          png,
          decoded: { width: 1, height: 1, rgba: Uint8Array.from([0, 0, 0, 255]) },
          origin: { origin: { x: 0, y: 0 }, basis: "predecoded whole-window fixture" },
          trace: {},
        })
      }
      return capture(checkpoint)
    }
    const result = await term("extensions.kitty-graphics.animation")(context)
    expect(result.observation?.outcome).toBe("supported")
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test("an acknowledgement with unchanging pixels is not animation support", async () => {
  const { context } = surface({ region: ["same"], whole: ["whole", "whole"], ack: "ok" })
  const result = await term("extensions.kitty-graphics.animation")(context)
  expect(result.observation?.outcome).not.toBe("supported")
  expect(result.pass).toBe(false)
  // Blank, reference and static image are identical, so the image control cannot qualify.
  expect(result.observation?.note).toContain("static image control failed")
})

// Retained Kitty 03:36 PST run: static red and all playback/selection crops equal, only DA1 replies.
// Exercise the final recorded status: the previous pixel-only test accepted that probe defect.
test.each([
  ["red", "refused", "unsupported"],
  ["blank", "refused", "probe-invalid"],
  ["red", "silent", "probe-invalid"],
  ["red", "ok", "probe-invalid"],
  ["red", "base-error", "probe-invalid"],
  ["red", "foreign-error", "probe-invalid"],
  ["red", "stop-only-error", "probe-invalid"],
  ["red", "selection-only-error", "probe-invalid"],
] as const)("equal animation pixels %s with %s replies record %s", async (playback, reply, status) => {
  const { context, writes, captures } = surface({
    region: [
      "blank",
      "red",
      "blue",
      "red",
      "red",
      "cursor",
      "cursor",
      playback,
      playback,
      playback,
      playback,
      playback,
    ],
    whole: ["before", "after"],
  })
  const query = context.queryWithSentinelOutcome
  context.queryWithSentinelOutcome = async (...args) => {
    const [sequence, pattern] = args
    const target = sequence.startsWith("\x1b_Ga=f,") || sequence.startsWith("\x1b_Ga=a,")
    if (target || (reply === "base-error" && sequence.startsWith("\x1b_Ga=t,i="))) {
      writes.push(sequence)
      const imageId = /,i=(\d+)/u.exec(sequence)![1]
      const raw =
        reply === "refused" ||
        (reply === "base-error" && !target) ||
        (reply === "stop-only-error" && sequence.includes(",s=1,")) ||
        (reply === "selection-only-error" && sequence.includes(",c=2,"))
          ? `\x1b_Gi=${imageId};ERROR: unimplemented action\x1b\\`
          : reply === "ok"
            ? `\x1b_Gi=${imageId};OK\x1b\\`
            : reply === "foreign-error"
              ? `\x1b_Gi=${Number(imageId) + 1};ERROR: unimplemented action\x1b\\\x1b[?62;52;c`
              : "\x1b[?62;52;c"
      const match = pattern.exec(raw)
      return { match, reason: match ? "reply" : "sentinel", raw, rawBase64: btoa(raw) }
    }
    return query(...args)
  }
  const featureId = "extensions.kitty-graphics.animation"
  const result = await term(featureId)(context)
  const recorded = recordExecutedProbe({
    featureId,
    attempt: { scope: "probe", startedAt: new Date(0).toISOString() },
    ...result,
    observation: result.observation && { ...result.observation, featureId, rawReplyRef: featureId },
    assertions: (result.assertions ?? []).map((assertion) => ({ ...assertion, featureId, rawReplyRef: featureId })),
  })
  expect(recorded.status).toBe(status)
  const retained = JSON.parse(result.response!) as { replies: Array<{ label: string; readback: { raw: string } }> }
  expect(retained.replies.find((entry) => entry.label === "second frame")?.readback.raw).not.toBe("")
  if (reply === "refused") {
    expect(result.observation?.note).toContain("second frame: ERROR: unimplemented action")
    expect(result.observation?.note).toContain("start playback: ERROR: unimplemented action")
  } else {
    expect(result.observation?.note).toContain("observed replies")
    expect(result.observation?.note).toContain(reply === "ok" ? "OK" : "62;52;c")
  }
  if (status === "unsupported") {
    expect(result.assertions).toMatchObject([{ kind: "negative", assertionType: "query_reply" }])
    expect(result.observation?.note).toContain("hand selection did not change")
    const [parsed] = parseProbeResults(
      [recorded],
      "animation callback",
      new Set([featureId]),
      { [featureId]: result.response! },
      (result.assertions ?? []).map((assertion) => ({ ...assertion, featureId, rawReplyRef: featureId })),
      captures.map(({ ref }) => ref),
    )
    expect(parsed).toMatchObject({ status: "unsupported", assertionType: "query_reply" })
    expect(parsed?.frames).toBeUndefined()
    expect(JSON.parse(result.response!)).toHaveProperty(
      "frames",
      captures.map(({ role, ref, label }) => ({ role, ref, label })),
    )
  } else {
    expect(result.assertions).toBeUndefined()
    if (playback === "blank") expect(result.observation?.note).toContain("playback image did not paint")
  }
})

// @cto edab7573, WezTerm's retained shape: every reply OK, frame 2 painted the moment it was added,
// and neither playback nor selecting frame 1 brought the first picture back. A pixel negative.
test("a frame 2 that never gives way to frame 1 records unsupported from pixels", async () => {
  const { context, captures } = surface({
    // The parser reads these frames, so the digests take its sha256 shape.
    region: ["blank", "red", "blue", "red", "red", "cursor", "cursor", "blue", "blue", "blue", "blue", "blue"].map(sha),
    whole: ["before", "after"].map(sha),
    ack: "ok",
  })
  const capture = context.capture!
  context.capture = async (checkpoint) => {
    const frame = await capture(checkpoint)
    if (frame.pixelsDigest?.startsWith("sha256:")) return frame
    return { ...frame, pixelsDigest: sha(String(frame.pixelsDigest)) } as ObservationFrame
  }
  const featureId = "extensions.kitty-graphics.animation"
  const result = await term(featureId)(context)
  const assertions = (result.assertions ?? []).map((assertion) => ({ ...assertion, featureId, rawReplyRef: featureId }))
  const recorded = recordExecutedProbe({
    featureId,
    attempt: { scope: "probe", startedAt: new Date(0).toISOString() },
    ...result,
    observation: result.observation && { ...result.observation, featureId, rawReplyRef: featureId },
    assertions,
  })
  expect(recorded.status).toBe("unsupported")
  expect(result.observation?.note).toContain(
    "Unsupported: the terminal accepted a second frame and showed it, but neither timed playback nor selecting the first frame brought the first picture back.",
  )
  expect(result.assertions).toMatchObject([{ kind: "negative", assertionType: "screenshot" }])
  const [parsed] = parseProbeResults(
    [recorded],
    "animation callback",
    new Set([featureId]),
    { [featureId]: result.response! },
    assertions,
    captures.map(({ ref }) => ref),
  )
  expect(parsed).toMatchObject({ status: "unsupported", assertionType: "screenshot" })
  expect(JSON.parse(result.response!)).toMatchObject({
    digests: { reference: sha("red"), secondReference: sha("blue") },
  })
})

// #34932 (@cto 34932-five-criteria-ruling-2216 item 5): the arm asks the collector to keep the with-image guard
// crop and compare the image-deleted guard to it, and its verdict follows that comparison when the raw digests
// differ. The test above uses equal guard digests, so it never reaches the bounded comparison.
test("placeholders compare the two guard crops under the bounded rule and keep both raw digests", async () => {
  const held = {
    holds: true,
    width: 39,
    height: 87,
    changedPixels: 18,
    maxChannelDelta: 1,
    alphaExact: true,
    maskChangedPixels: 0,
    backgroundMembers: 1,
  }
  const { context, captures } = surface({
    region: ["with-image", "with-image", "text-only", "blank", "with-image"],
    guard: ["guard", "shaded"],
    guardComparison: held,
  })
  const result = await term("extensions.kitty-graphics.unicode-placeholders")(context)
  const guards = captures.filter((capture) => capture.label.includes("Layout guard"))
  expect(guards.map((capture) => capture.layoutGuard)).toEqual([{}, { against: guards[0]!.ref }])
  expect(result.observation?.outcome).toBe("supported")
  const evidence = JSON.parse(result.response!) as { guard: Record<string, unknown> }
  expect(evidence.guard).toEqual({
    withImage: "guard",
    withoutImage: "shaded",
    comparison: { against: guards[0]!.ref, ...held },
  })

  const failing = surface({
    region: ["with-image", "with-image", "text-only", "blank", "with-image"],
    guard: ["guard", "moved"],
    guardComparison: {
      ...held,
      holds: false,
      maskChangedPixels: 3,
      reason: "3 coordinate(s) changed between background and ink",
    },
  })
  const refused = await term("extensions.kitty-graphics.unicode-placeholders")(failing.context)
  expect(refused.observation?.outcome).toBe("inconclusive")
  expect(JSON.stringify(refused)).toContain("3 coordinate(s) changed between background and ink")
})

// #34932 (@cto 34932-five-criteria-ruling-2216 item 2): a controlled-silent display placement reads pixels.
// Before this arm the same placement returned "not tested" with no capture at all, so no existing test
// reaches a capture from the display row.
const DISPLAY = "extensions.kitty-graphics.display"

test("a silent display placement is Supported only by a stable block equal to the SGR reference", async () => {
  const { context, writes, captures } = surface({
    placement: "silent",
    region: ["blank", "cyan", "cyan", "cyan"],
  })
  const result = await term(DISPLAY)(context)
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "screenshot" })
  expect(result.assertions).toMatchObject([{ kind: "positive", assertionType: "screenshot" }])
  expect(captures.map((capture) => capture.role)).toEqual(["control", "target", "target", "control"])
  // The placement goes to the block origin with the image this row allocated (i=1), and the cursor is
  // parked before the first target capture.
  const blockPlace = writes.findIndex((bytes) => bytes.startsWith("\x1b_Ga=p,i=1,c=") && !bytes.includes("c=2,r=1"))
  expect(blockPlace).toBeGreaterThan(-1)
  expect(captures[0]!.writesBefore).toBeLessThanOrEqual(blockPlace)
  expect(captures[1]!.writesBefore).toBeGreaterThan(blockPlace + 1)
  // The target is captured BEFORE the reference paint, and the reference is painted in the row's own colour.
  const paint = writes.findIndex((bytes) => bytes === `\x1b[48;2;${KITTY_ROW_IMAGES[DISPLAY].image.join(";")}m`)
  expect(paint).toBeGreaterThan(-1)
  expect(captures[2]!.writesBefore).toBeLessThanOrEqual(paint)
  expect(captures[3]!.writesBefore).toBeGreaterThan(paint)
  // Placements are removed while the allocation is kept, and only the allocated image is freed.
  expect(writes.filter((bytes) => bytes.includes("a=d,d=I,"))).toEqual(["\x1b_Ga=d,d=I,i=1,q=2\x1b\\"])
  expect(writes.filter((bytes) => bytes.includes("a=d,d=i,i=1"))).toHaveLength(2)
  const evidence = JSON.parse(result.response!) as Record<string, unknown>
  expect(evidence).toMatchObject({ blank: "blank", target: ["cyan", "cyan"], reference: "cyan" })
  expect(evidence.frames).toEqual(captures.map((capture) => capture.ref))
})

test.each([
  ["a target that does not match the reference", ["blank", "cyan", "cyan", "teal"]],
  ["an unstable target pair", ["blank", "cyan", "cyan-later", "cyan"]],
  ["an unqualified SGR reference", ["blank", "blank", "blank", "blank"]],
  ["a missing region digest", ["blank", undefined, undefined, "cyan"]],
] as const)("a silent display placement with %s stays open, never Unsupported", async (decidedBy, region) => {
  const { context } = surface({ placement: "silent", region })
  const result = await term(DISPLAY)(context)
  expect(result.observation?.outcome).toBe("inconclusive")
  expect(result.assertions).toBeUndefined()
  expect(result.observation?.note).toContain("Kitty image display:")
  expect(JSON.stringify(result)).not.toContain('"unsupported"')
  if (decidedBy === "a missing region digest") expect(result.tests).toMatchObject([{ status: "probe-todo" }])
})

test("an acknowledged display placement keeps its query-reply verdict and takes no capture", async () => {
  const { context, captures } = surface({ region: ["unused"] })
  const result = await term(DISPLAY)(context)
  expect(captures).toHaveLength(0)
  expect(result.observation?.assertionType).toBe("query_reply")
})

// @dev/6 peer F1 on #34932 (6b7e48cb): the display row declares no terminal geometry, so a source whose grid
// accessors throw (as unified's source does for an undeclared row) still decides the protocol answer, and the
// pixel branch sizes its block from the row's capture calibration alone.
function withoutDeclaredGrid(context: TermProbeSource): TermProbeSource {
  const undeclared = () => {
    throw Object.assign(new Error("undeclared terminal geometry"), { name: "UndeclaredTerminalGeometry" })
  }
  return Object.defineProperties({ ...context }, { rows: { get: undeclared }, cols: { get: undeclared } })
}

test("the display row declares no geometry, and its acknowledgement decides without a grid", async () => {
  expect(extensionsProbes.find((definition) => definition.id === DISPLAY)?.termNeedsGeometry).toBeUndefined()
  const { context, captures } = surface({ region: ["unused"] })
  const result = await term(DISPLAY)(withoutDeclaredGrid(context))
  expect(captures).toHaveLength(0)
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
})

test("a silent display placement reads pixels from the calibrated grid when the row has no declared grid", async () => {
  const { context, captures } = surface({ placement: "silent", region: ["blank", "cyan", "cyan", "cyan"] })
  const result = await term(DISPLAY)(withoutDeclaredGrid(context))
  expect(captures).toHaveLength(4)
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "screenshot" })
})

test("a silent display placement with no capture calibration keeps the protocol result and takes no capture", async () => {
  const { context, captures } = surface({ placement: "silent", region: ["unused"] })
  const result = await term(DISPLAY)(withoutDeclaredGrid({ ...context, captureGeometry: undefined }))
  expect(captures).toHaveLength(0)
  expect(result.observation?.outcome).not.toBe("supported")
  expect(result.notTested?.reason).toBe("no-semantic-observable")
})

test("a silent display placement on a text-cells run takes no pixel capture", async () => {
  const { context, captures } = surface({ placement: "silent", region: ["unused"] })
  const cellsRun = { ...context, captureKind: "text-cells" as const }
  const result = await term(DISPLAY)(cellsRun)
  expect(captures).toHaveLength(0)
  expect(result.observation?.outcome).not.toBe("supported")
  expect(result.assertions).toBeUndefined()
})

test("placeholders decide from pixels, with a queried virtual transfer and an ordinary placement alive", async () => {
  const { context, writes, captures } = surface({
    // grid with image (twice), grid with the image deleted, blank, then the ordinary placement of the
    // same pixels — which must land on the SAME digest as the with-image rectangle.
    region: ["with-image", "with-image", "text-only", "blank", "with-image"],
    guard: ["guard", "guard"],
    cells: ["placeholder-cells", "placeholder-cells"],
  })
  const result = await term("extensions.kitty-graphics.unicode-placeholders")(context)
  const joined = writes.join("")
  // The virtual-placement reply distinguishes a refused command from a broken measurement.
  expect(joined).toContain("a=T,U=1")
  expect(writes.find((bytes) => bytes.startsWith("\x1b_Ga=T,U=1"))).toContain("q=0")
  // #33033 (@cto fd7747d9): the with-image state writes its placeholder text BEFORE the virtual placement,
  // because placement-first is a paint race in Kitty 0.49.2; the first capture follows both.
  const placementWrite = writes.findIndex((bytes) => bytes.startsWith("\x1b_Ga=T,U=1"))
  expect(placementWrite).toBeGreaterThan(-1)
  expect(writes.findIndex((bytes) => bytes.includes("\u{10EEEE}"))).toBeLessThan(placementWrite)
  const withImage = captures.find((capture) => capture.label.startsWith("Placeholder grid with image"))
  expect(withImage!.writesBefore).toBeGreaterThan(placementWrite)
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
  const reference = captures.filter((capture) => capture.label.includes("SGR"))
  expect(reference).toMatchObject([{ role: "control", cells: true }])
  const placeholderRgb = KITTY_ROW_IMAGES["extensions.kitty-graphics.unicode-placeholders"].image
  expect(writes.slice(0, reference[0]!.writesBefore).join("")).toContain(`\x1b[48;2;${placeholderRgb.join(";")}m`)
  expect(JSON.parse(result.response!)).toMatchObject({ digests: { reference: "with-image" } })
})

// AC6: prerequisite silence is a declared absence only when BOTH owned query windows qualify.
// Pixel-only tests cannot detect an unqualified early return or lost query evidence.
test.each([
  ["silent", "silent", "untestable"],
  ["silent", "reply", "probe-todo"],
  ["timeout", "silent", "probe-invalid"],
  ["silent", "unmatched", "probe-todo"],
] as const)("pixel setup transfer=%s/query=%s retains both windows as %s", async (transfer, query, status) => {
  for (const featureId of ["extensions.kitty-graphics.animation", "extensions.kitty-graphics.unicode-placeholders"]) {
    const { context, captures, writes } = surface({ region: ["unused"] })
    const outcomes: TerminalQueryOutcome[] = []
    context.queryWithSentinelOutcome = async (sequence, pattern) => {
      writes.push(sequence)
      const mode = outcomes.length === 0 ? transfer : query
      const raw =
        mode === "reply"
          ? "\x1b_Gi=31;OK\x1b\\"
          : mode === "timeout"
            ? ""
            : `${mode === "unmatched" ? "unexpected" : ""}\x1b[?1;2c`
      const outcome: TerminalQueryOutcome = {
        match: raw.match(pattern),
        reason: mode === "reply" ? "reply" : mode === "timeout" ? "timeout" : "sentinel",
        raw,
        rawBase64: btoa(raw),
        ...(mode !== "timeout" && mode !== "reply" ? { sentinel: { atMs: 10, graceMs: 250 } } : {}),
      }
      outcomes.push(outcome)
      return outcome
    }
    const result = await term(featureId)(context)
    const recorded = recordExecutedProbe({
      featureId,
      attempt: { scope: "probe", startedAt: new Date(0).toISOString() },
      ...result,
      observation: result.observation && { ...result.observation, featureId, rawReplyRef: featureId },
      coverage: result.notTested && { ...result.notTested, featureId, rawReplyRef: featureId },
      assertions: (result.assertions ?? []).map((assertion) => ({ ...assertion, featureId, rawReplyRef: featureId })),
    })
    expect(recorded.status).toBe(status)
    expect(captures).toHaveLength(0)
    expect(writes.filter((bytes) => bytes.startsWith("\x1b_G"))).toHaveLength(2)
    expect(writes[0]).toContain("a=t,")
    expect(writes[1]).toContain("a=q,")
    expect(JSON.parse(result.response!)).toMatchObject({
      transfer: { raw: outcomes[0]!.raw, reason: outcomes[0]!.reason },
      query: { raw: outcomes[1]!.raw, reason: outcomes[1]!.reason },
    })
    if (status === "untestable") {
      expect(JSON.parse(result.response!)).toMatchObject({
        transfer: { sentinel: { atMs: 10, graceMs: 250 } },
        query: { sentinel: { atMs: 10, graceMs: 250 } },
      })
    }
  }
})

test.each(["silent", "ok", "refused", "foreign-error"] as const)(
  "blank placeholders with %s reply need an exact refusal",
  async (reply) => {
    const { context, writes, captures } = surface({
      region: ["same", "same", "same", "blank", "ordinary"],
      guard: ["guard", "guard"],
      cells: ["placeholder-cells", "placeholder-cells"],
    })
    const query = context.queryWithSentinelOutcome
    let virtualRaw = ""
    context.queryWithSentinelOutcome = async (sequence, pattern) => {
      if (!sequence.startsWith("\x1b_Ga=T,U=1")) return query(sequence, pattern)
      writes.push(sequence)
      const imageId = /,i=(\d+)/u.exec(sequence)![1]
      virtualRaw =
        reply === "silent"
          ? "\x1b[?62;52;c"
          : `\x1b_Gi=${reply === "foreign-error" ? Number(imageId) + 1 : imageId};${reply === "ok" ? "OK" : "ERROR: unimplemented virtual placement"}\x1b\\`
      const match = pattern.exec(virtualRaw)
      return { match, reason: match ? "reply" : "sentinel", raw: virtualRaw, rawBase64: btoa(virtualRaw) }
    }
    const featureId = "extensions.kitty-graphics.unicode-placeholders"
    const result = await term(featureId)(context)
    const recorded = recordExecutedProbe({
      featureId,
      attempt: { scope: "probe", startedAt: new Date(0).toISOString() },
      ...result,
      observation: result.observation && { ...result.observation, featureId, rawReplyRef: featureId },
      assertions: (result.assertions ?? []).map((assertion) => ({ ...assertion, featureId, rawReplyRef: featureId })),
    })
    expect(recorded.status).toBe(reply === "refused" ? "unsupported" : "probe-invalid")
    expect(JSON.parse(result.response!)).toMatchObject({ virtualPlacement: { raw: virtualRaw } })
    expect(virtualRaw).not.toBe("")
    expect(result.pass).toBe(false)
    if (reply === "refused") {
      expect(result.assertions).toMatchObject([{ kind: "negative", assertionType: "query_reply" }])
      expect(result.observation?.note).toContain("ERROR: unimplemented virtual placement")
      const [parsed] = parseProbeResults(
        [recorded],
        "placeholder callback",
        new Set([featureId]),
        { [featureId]: result.response! },
        (result.assertions ?? []).map((assertion) => ({ ...assertion, featureId, rawReplyRef: featureId })),
        captures.map(({ ref }) => ref),
      )
      expect(parsed).toMatchObject({ status: "unsupported", assertionType: "query_reply" })
      expect(parsed?.frames).toBeUndefined()
      expect(JSON.parse(result.response!)).toHaveProperty(
        "frames",
        captures.map(({ role, ref, label }) => ({ role, ref, label })),
      )
    } else {
      expect(result.assertions).toBeUndefined()
      expect(result.observation?.note).toContain("observed replies")
    }
  },
)

test("text painted by an ordinary placement fails image qualification and records the placement reply", async () => {
  const { context } = surface({
    region: ["same", "same", "same", "blank", "base64-text", "red-reference"],
  })
  const query = context.queryWithSentinelOutcome
  context.queryWithSentinelOutcome = async (sequence, pattern) => {
    if (sequence.includes("a=p,")) {
      const raw = "\x1b_Gi=40;ENOENT:No such image\x1b\\"
      return { match: raw.match(pattern), reason: "reply", raw, rawBase64: btoa(raw) }
    }
    return query(sequence, pattern)
  }
  const featureId = "extensions.kitty-graphics.unicode-placeholders"
  const result = await term(featureId)(context)
  const recorded = recordExecutedProbe({
    featureId,
    attempt: { scope: "probe", startedAt: new Date(0).toISOString() },
    observation: result.observation && { ...result.observation, featureId, rawReplyRef: featureId },
    tests: result.tests,
    assertions: [],
  })
  expect(recorded.status).toBe("probe-invalid")
  expect(result.assertions).toBeUndefined()
  expect(result.observation?.note).toContain("reference")
  expect(JSON.parse(result.response!)).toMatchObject({ placementAck: expect.stringContaining("ENOENT:No such image") })
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
    expect(result.tests, id).toMatchObject([expect.objectContaining({ status: "probe-todo" })])
  }
})
