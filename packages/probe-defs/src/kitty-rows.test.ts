/**
 * @failure A kitty pixel row decides from one frame, or from the terminal's acknowledgement, so the
 *   published cell for animation or unicode placeholders claims a render nobody captured.
 * @level l1
 * @consumer The application and mux callbacks for extensions.kitty-graphics.animation and
 *   extensions.kitty-graphics.unicode-placeholders.
 * @testonly none
 */
import { expect, test } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseProbeResults } from "@terminfo/run-parser"
import { extensionsProbes } from "./extensions.ts"
import { recordExecutedProbe } from "./helpers.ts"
import { KITTY_GUARD_REGION, KITTY_GUARD_TEXT, KITTY_REGION } from "./kitty-capture.ts"
import type { ObservationFrame, TermProbeSource, TerminalQueryOutcome } from "./types.ts"
import { finishCapture } from "../../terminfo.dev/src/capture-core.ts"

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
  const ack = (sequence: string): TerminalQueryOutcome => {
    if (options.ack === "silent") return { match: null, reason: "timeout", raw: "", rawBase64: "" }
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
    region: ["blank", "red", "red", "red", "cursor", "cursor", "red", "blue", "red", "blue"],
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
    region: ["blank", "red", "red", "red", "cursor", "cursor", "red", "blue", "red", "blue"],
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
    region: ["blank", "red", "red", "red", "cursor", "cursor", playback, playback, playback, playback, playback],
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
  expect(writes.slice(0, reference[0]!.writesBefore).join("")).toContain("\x1b[48;2;255;0;0m")
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
