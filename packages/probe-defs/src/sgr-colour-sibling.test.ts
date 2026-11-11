/**
 * @failure Screen's two truecolour rows stay open forever, or close on evidence that does not prove
 *   them: the row's own frames are flat (seed = target = expected), which alone cannot separate "the
 *   colour was dropped" from "the capture cannot show colour here". #33041 (@cto acd2e579, amended
 *   16:05Z) decides unsupported only when a same-channel sibling separated in the same rectangle of
 *   the same run AND the outer terminal's placed record, at the exact version and platform, reads
 *   supported for the row. The fixtures copy the 15:32Z screen run's frame layout: the real refusal
 *   (outcome inconclusive, "the seed frame and the expected frame read the same cells"), fourteen
 *   frames per row, two rectangles (region 29,68 and sentinel 3,10). A fixture with the synthetic
 *   outcome "unsupported" proved nothing before (F6), so none is used here.
 * @level l1
 * @consumer The colour-sibling-separation branch for Screen sgr.fg.truecolor and sgr.bg.truecolor (#33041).
 * @testonly none
 */
import { expect, test } from "vitest"
import { colourSiblingSeparation, type OuterColourControl } from "./sgr-colour-capture.ts"
import type { Observation, ObservationFrame } from "./types.ts"

const REGION = { x: 29, y: 68, width: 52, height: 29 }
const SENTINEL = { x: 3, y: 10, width: 13, height: 29 }
const RUN = "79bbd913a6deaf27b1864ba143a17bed"
const sha = (tag: string) => `sha256:${tag.padEnd(64, "0")}`

/** One colour row's frames in the run's order: stability, then baseline/witness/region per step. */
function rowFrames(
  id: string,
  region: { seed: string; target: string; expected: string; ignored: string },
  rectangle = REGION,
): ObservationFrame[] {
  const frames: ObservationFrame[] = []
  const push = (label: string, digest: string, rect: typeof REGION, role: "control" | "target" = "control") =>
    frames.push({
      role,
      ref: sha(`ref${frames.length}${id.length}`),
      capturedAt: frames.length,
      label: `${id}: ${label}`,
      regionDigest: digest,
      regionRectangle: rect,
    })
  push("capture stability 1", sha("c711"), REGION)
  push("capture stability 2", sha("c711"), REGION)
  for (const [step, digest, role] of [
    ["pre-edit seed", region.seed, "control"],
    ["post-sequence target", region.target, "target"],
    ["expected frame", region.expected, "control"],
    ["ignored-attribute frame", region.ignored, "control"],
  ] as const) {
    push(`${step} — baseline`, sha("df8a"), SENTINEL)
    push(`${step} — paint witness`, sha(`w${frames.length}`), SENTINEL)
    push(step, digest, rectangle, role)
  }
  return frames
}

/** The truecolour row exactly as region-readback refuses it today. */
function flatRefusal(id: string, rectangle = REGION): Observation {
  return {
    featureId: id,
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    assertionType: "screenshot",
    screenshotRef: sha("440d"),
    frames: rowFrames(
      id,
      { seed: sha("951e"), target: sha("951e"), expected: sha("951e"), ignored: sha("951e") },
      rectangle,
    ),
    note: `${id}: the seed frame and the expected frame read the same cells, so this run cannot separate them`,
  }
}

function sibling(id: string, target = sha("0a9b")): Observation {
  return {
    featureId: id,
    outcome: "supported",
    assertionType: "screenshot",
    frames: rowFrames(id, { seed: sha("951e"), target, expected: target, ignored: sha("c2fd") }),
  }
}

const RECORD = {
  id: "kitty",
  version: "0.49.2",
  os: "linux",
  recordPath: "content/probes-apps/kitty-0.49.2-linux-b09e6e5cab7a3a07c0754538b2d949d6.json",
  recordRunId: "b09e6e5cab7a3a07c0754538b2d949d6",
  statuses: { "sgr.fg.truecolor": "supported", "sgr.bg.truecolor": "supported" },
}
const KITTY: OuterColourControl = { record: RECORD, outerApp: { id: "kitty", version: "0.49.2", os: "linux" } }

function decide(
  id: string,
  observations: Observation[],
  overrides: { outer?: OuterColourControl; mux?: "tmux" | "screen" } = {},
) {
  return colourSiblingSeparation({
    featureId: id,
    mux: overrides.mux ?? "screen",
    runId: RUN,
    observations,
    outer: overrides.outer ?? KITTY,
    harnessProfile: "kitty --config NONE",
    muxConfig: "/out/mux-empty.conf",
  })
}

test("the real flat refusal with a separating sibling and a supported outer record decides unsupported with its witness", () => {
  for (const [id, siblingId, channel] of [
    ["sgr.fg.truecolor", "sgr.fg.256", "fg"],
    ["sgr.bg.truecolor", "sgr.bg.256", "bg"],
  ] as const) {
    const decision = decide(id, [flatRefusal(id), sibling(siblingId)])
    expect(decision?.kind).toBe("decided")
    if (decision?.kind !== "decided") continue
    expect(decision.criterionBranch).toBe("colour-sibling-separation")
    expect(decision.observation.outcome).toBe("unsupported")
    expect(decision.observation).not.toHaveProperty("reason")
    // #33150 (@cto 918fccd1): a bare Unsupported is wrong by omission; the reason names Screen's default-off option
    // and the harness config, on the observation, the assertion and the test alike.
    const cause =
      "GNU Screen 5.0.2 emits 24-bit colour only with its truecolor option on; default is off; corpus config is defscrollback 1000"
    expect(decision.observation.note).toContain(cause)
    expect(decision.assertion.note).toContain(cause)
    expect(decision.test.reason).toContain(cause)
    expect(decision.test).toMatchObject({ id: "criterion", status: "unsupported", assertionRefs: [0] })
    expect(decision.assertion).toMatchObject({ kind: "negative", assertionType: "screenshot", observed: sha("951e") })
    expect(decision.assertion.witness).toEqual({
      kind: "colour-sibling-separation",
      requestedRowId: id,
      requestedEncoding: id === "sgr.fg.truecolor" ? "38;2;255;128;0" : "48;2;0;255;128",
      siblingRowId: siblingId,
      siblingEncoding: id === "sgr.fg.truecolor" ? "38;5;67" : "48;5;67",
      channel,
      runId: RUN,
      rectangle: REGION,
      requested: { seed: sha("951e"), target: sha("951e"), expected: sha("951e"), ignored: sha("951e") },
      sibling: { seed: sha("951e"), target: sha("0a9b") },
      colour: expect.objectContaining({ harnessProfile: "kitty --config NONE", muxConfig: "/out/mux-empty.conf" }),
      outerTerminal: {
        id: "kitty",
        version: "0.49.2",
        rowId: id,
        status: "supported",
        recordPath: RECORD.recordPath,
        recordRunId: RECORD.recordRunId,
      },
    })
  }
})

test("the row stays open, naming why, when the outer terminal's record is missing", () => {
  const decision = decide("sgr.fg.truecolor", [flatRefusal("sgr.fg.truecolor"), sibling("sgr.fg.256")], {
    outer: { missing: "no placed outer-terminal record matches content/probes-apps/kitty-0.49.2-linux-*.json" },
  })
  expect(decision).toEqual({ kind: "open", reason: expect.stringContaining("no outer-terminal control: no placed") })
})

test("the row stays open when the sibling's seed and target hashes are equal", () => {
  const decision = decide("sgr.fg.truecolor", [flatRefusal("sgr.fg.truecolor"), sibling("sgr.fg.256", sha("951e"))])
  expect(decision).toEqual({ kind: "open", reason: expect.stringContaining("seed and target hashes are equal") })
})

test("the row stays open when the outer record is another version or does not read supported", () => {
  const observations = [flatRefusal("sgr.fg.truecolor"), sibling("sgr.fg.256")]
  const otherVersion = decide("sgr.fg.truecolor", observations, {
    outer: { record: RECORD, outerApp: { id: "kitty", version: "0.50.0", os: "linux" } },
  })
  expect(otherVersion).toEqual({
    kind: "open",
    reason: expect.stringContaining("not this run's outer terminal kitty 0.50.0"),
  })
  const unsupported = decide("sgr.fg.truecolor", observations, {
    outer: { record: { ...RECORD, statuses: { "sgr.fg.truecolor": "unsupported" } }, outerApp: KITTY.outerApp },
  })
  expect(unsupported).toEqual({ kind: "open", reason: expect.stringContaining("reads unsupported") })
})

test("the row stays open when the sibling is absent or cropped from another rectangle", () => {
  expect(decide("sgr.fg.truecolor", [flatRefusal("sgr.fg.truecolor")])).toMatchObject({ kind: "open" })
  const moved = {
    ...sibling("sgr.fg.256"),
    frames: rowFrames(
      "sgr.fg.256",
      { seed: sha("951e"), target: sha("0a9b"), expected: sha("0a9b"), ignored: sha("c2fd") },
      { ...REGION, x: 30 },
    ),
  }
  expect(decide("sgr.fg.truecolor", [flatRefusal("sgr.fg.truecolor"), moved])).toEqual({
    kind: "open",
    reason: expect.stringContaining("cropped from a different rectangle"),
  })
})

test("only the two Screen truecolour rows with flat frames are this branch's case", () => {
  const observations = [flatRefusal("sgr.fg.truecolor"), sibling("sgr.fg.256"), flatRefusal("sgr.fg.256")]
  expect(decide("sgr.fg.truecolor", observations, { mux: "tmux" })).toBeUndefined()
  expect(decide("sgr.fg.256", [flatRefusal("sgr.fg.256")])).toBeUndefined()
  const painted = {
    ...flatRefusal("sgr.fg.truecolor"),
    frames: rowFrames("sgr.fg.truecolor", {
      seed: sha("951e"),
      target: sha("aaaa"),
      expected: sha("aaaa"),
      ignored: sha("bbbb"),
    }),
  }
  expect(decide("sgr.fg.truecolor", [painted, sibling("sgr.fg.256")])).toBeUndefined()
})
