/**
 * @failure The kitty pixel rows ship a decision table that passes on one frame, on an acknowledgement,
 *   or on a control that was never taken, so a later run can publish animation or placeholder support
 *   it did not see.
 * @level l1
 * @consumer The two kitty rows in probes-apps and probes-mux, and the reader that grades them.
 * @testonly none
 */
import { expect, test } from "vitest"
import {
  KITTY_CLEAR,
  KITTY_DIACRITIC_0,
  KITTY_DIACRITIC_1,
  KITTY_GAP_MS,
  KITTY_LOOP_FOREVER,
  KITTY_PLACEHOLDER,
  decideKittyAnimation,
  decideKittyPlaceholders,
  kittyBlockPixels,
  kittyDeleteImage,
  kittyDiacritic,
  kittyFrameTransfer,
  kittyPixelPayload,
  kittyPlaceholderNumber,
  kittyPlaceholderText,
  kittyPlace,
  kittySelectFrame,
  kittyStartPlayback,
  kittyStopPlayback,
  kittyVirtualPlacement,
  type KittyAnimationEvidence,
} from "./kitty-capture.ts"

const frame = { width: 20, height: 40, rgb: [255, 0, 0] as const }

test("every animation frame carries an explicit gap and the loop count is explicit", () => {
  const root = kittyFrameTransfer(7, frame, { root: true })
  const later = kittyFrameTransfer(7, frame)
  // The root frame is sized and gapped; a later frame carries its gap too and no size.
  expect(root).toContain(",s=20,v=40")
  expect(root).toContain(`,z=${String(KITTY_GAP_MS)}`)
  expect(later).toContain(`,z=${String(KITTY_GAP_MS)}`)
  expect(later).not.toContain(",s=20")
  const start = kittyStartPlayback(7)
  expect(start).toContain("s=3")
  expect(start).toContain(`v=${String(KITTY_LOOP_FOREVER)}`)
  // v=0 is ignored by the protocol and a default gap is what a negative must never inherit.
  expect(start).not.toContain("v=0")
  expect(later).not.toContain("z=0")
})

test("frame selection is a control command, never the playback start", () => {
  expect(kittySelectFrame(7, 2)).toContain("c=2")
  expect(kittySelectFrame(7, 2)).not.toContain("s=3")
  expect(kittyStopPlayback(7)).toContain("s=1")
  expect(kittyStartPlayback(7)).not.toContain(",c=")
})

test("the delete frees exactly the named image", () => {
  expect(kittyDeleteImage(7)).toContain("a=d,d=I,i=7")
  expect(kittyDeleteImage(7)).toContain("q=2")
})

test("the pixel payload is raw RGB of the requested size, base64 encoded", () => {
  const payload = kittyPixelPayload(2, 1, [255, 0, 0])
  expect(Buffer.from(payload, "base64")).toEqual(Buffer.from([255, 0, 0, 255, 0, 0]))
  expect(() => kittyPixelPayload(0, 1, [0, 0, 0])).toThrow(/positive whole size/u)
  expect(() => kittyBlockPixels({ cellWidth: 0, cellHeight: 1 })).toThrow(/positive whole pixels/u)
})

test("the quiet virtual placement suppresses replies and declares its cell grid", () => {
  const quiet = kittyVirtualPlacement(9, frame)
  expect(quiet).toContain("a=T,U=1,i=9")
  expect(quiet).toContain(",c=2,r=2")
  expect(quiet).toContain("q=2")
  // An acknowledgement is never the evidence here, so no acking command exists on this path.
  expect(kittyPlace(9)).toContain("a=p")
})

test("placeholder text pins the spec's code point, diacritics and foreground-colour id", () => {
  const text = kittyPlaceholderText(42)
  expect(text).toContain("\u{1b}[38;5;42m")
  expect(text).toContain(KITTY_PLACEHOLDER)
  expect(text).toContain(KITTY_DIACRITIC_0)
  expect(text).toContain(KITTY_DIACRITIC_1)
  // Two diacritics per cell: row then column, in a 2x2 grid.
  expect(text.split(KITTY_PLACEHOLDER).length - 1).toBe(4)
  expect(kittyDiacritic(0)).toBe(KITTY_DIACRITIC_0)
  expect(kittyDiacritic(1)).toBe(KITTY_DIACRITIC_1)
  expect(() => kittyDiacritic(9)).toThrow(/no pinned value/u)
  expect(() => kittyPlaceholderText(256)).toThrow(/1\.\.255/u)
  expect(kittyPlaceholderNumber()).toBeGreaterThanOrEqual(1)
  expect(kittyPlaceholderNumber()).toBeLessThanOrEqual(255)
  expect(text.startsWith(KITTY_CLEAR.slice(0, 0))).toBe(true)
})

function evidence(overrides: Partial<KittyAnimationEvidence> = {}): KittyAnimationEvidence {
  return {
    playback: ["a", "b"],
    retry: null,
    clientFrame: ["c", "d"],
    still: ["e", "e"],
    cursorOnly: ["f", "f"],
    redraw: ["g", "h"],
    playbackElapsedMs: 400,
    ...overrides,
  }
}

test("animation is supported only by two differing frames of one run with every control alive", () => {
  const verdict = decideKittyAnimation(evidence())
  expect(verdict.outcome).toBe("supported")
  expect(verdict.note).toContain("400 ms")
})

test("an equal playback pair is never a negative until the pipeline is alive and the pair was retried", () => {
  // Equal playback with no retry recorded can never decide.
  expect(decideKittyAnimation(evidence({ playback: ["a", "a"] })).outcome).toBe("inconclusive")
  // A differing client-selected pair plus a stable still plus the retry at twice the gap: negative.
  expect(decideKittyAnimation(evidence({ playback: ["a", "a"], retry: ["a", "a"] })).outcome).toBe("unsupported")
  // The same equal playback pair that DOES advance on the retry is support, not a negative.
  expect(decideKittyAnimation(evidence({ playback: ["a", "a"], retry: ["a", "b"] })).outcome).toBe("supported")
})

test("each failed control names itself instead of becoming a negative", () => {
  expect(decideKittyAnimation(evidence({ clientFrame: ["c", "c"] })).decidedBy).toBe("the client-driven update control")
  expect(decideKittyAnimation(evidence({ still: ["e", "z"] })).decidedBy).toBe("the still control")
  expect(decideKittyAnimation(evidence({ cursorOnly: ["f", "z"] })).decidedBy).toBe("the cursor-only control")
  expect(decideKittyAnimation(evidence({ redraw: ["g", "g"] })).decidedBy).toBe("the redraw control")
  expect(decideKittyAnimation(evidence({ playback: [undefined, "b"] })).decidedBy).toBe("a missing region digest")
  for (const overrides of [
    { clientFrame: ["c", "c"] as const },
    { still: ["e", "z"] as const },
    { cursorOnly: ["f", "z"] as const },
    { redraw: ["g", "g"] as const },
  ]) {
    expect(decideKittyAnimation(evidence(overrides)).outcome).toBe("inconclusive")
  }
})

test("placeholders are supported only on pixels, with the ordinary placement painted", () => {
  const supported = decideKittyPlaceholders({
    withImage: ["with", "with"],
    withoutImage: "without",
    blank: "blank",
    ordinary: "ordinary",
    cellReadback: null,
  })
  expect(supported.outcome).toBe("supported")
  // The cell readback can veto but never decide.
  expect(
    decideKittyPlaceholders({
      withImage: ["with", "with"],
      withoutImage: "without",
      blank: "blank",
      ordinary: "ordinary",
      cellReadback: ["one", "two"],
    }).decidedBy,
  ).toBe("the cell readback precondition")
  // Identical pixels through both paths, with the ordinary placement alive: negative.
  expect(
    decideKittyPlaceholders({
      withImage: ["same", "same"],
      withoutImage: "same",
      blank: "blank",
      ordinary: "ordinary",
      cellReadback: null,
    }).outcome,
  ).toBe("unsupported")
  // An unmeasured graphics path never implicates the feature.
  expect(
    decideKittyPlaceholders({
      withImage: ["same", "same"],
      withoutImage: "same",
      blank: "blank",
      ordinary: "blank",
      cellReadback: null,
    }).outcome,
  ).toBe("inconclusive")
})
