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
  KITTY_BLOCK_COLS,
  KITTY_BLOCK_LEFT,
  KITTY_BLOCK_TOP,
  KITTY_CLEAR,
  KITTY_DIACRITIC_0,
  KITTY_DIACRITIC_1,
  KITTY_GAP_MS,
  KITTY_GUARD_REGION,
  KITTY_GUARD_TEXT,
  KITTY_LOOP_FOREVER,
  KITTY_PLACEHOLDER,
  KITTY_PLACEHOLDER_BOUNDS,
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
  kittyRootGap,
  kittySelectFrame,
  kittyStartPlayback,
  kittyStopPlayback,
  kittyVirtualPlacement,
  type KittyAnimationEvidence,
  type KittyPlaceholderEvidence,
} from "./kitty-capture.ts"

// Retained Kitty geometry: two cells at 13x29 pixels, exceeding one protocol payload chunk.
const frame = { width: 26, height: 58, rgb: [255, 0, 0] as const }

test("every animation frame carries an explicit gap and the loop count is explicit", () => {
  const root = kittyFrameTransfer(7, frame, { root: true })
  const later = kittyFrameTransfer(7, frame)
  expect(root).toContain("a=t,")
  expect(later).toContain("a=f,")
  // The root is sized and carries NO gap: the protocol gives it none at transfer time, so its gap
  // comes from the control code, which is the one place a default could otherwise take over.
  expect(root).toContain(",s=26,v=58")
  expect(root).not.toContain(",z=")
  expect(kittyRootGap(7)).toContain("a=a,i=7,r=1")
  expect(kittyRootGap(7)).toContain(`z=${String(KITTY_GAP_MS)}`)
  expect(later).toContain(`,z=${String(KITTY_GAP_MS)}`)
  expect(later).not.toContain(",s=26")
  const start = kittyStartPlayback(7)
  expect(start).toContain("s=3")
  expect(start).toContain(`v=${String(KITTY_LOOP_FOREVER)}`)
  // v=0 is ignored by the protocol and a default gap is what a negative must never inherit.
  expect(start).not.toContain("v=0")
  expect(later).not.toContain("z=0")
})

test("image, animation and virtual-placement payloads obey the same bounded transfer contract", () => {
  for (const [wire, continuationKeys, quiet] of [
    [kittyFrameTransfer(7, frame, { root: true }), ["m", "q"], "1"],
    [kittyFrameTransfer(7, frame), ["a", "m", "q"], "1"],
    [kittyVirtualPlacement(7, frame), ["m", "q"], "0"],
  ] as const) {
    const chunks = [...wire.matchAll(/\x1b_G([^;]+);([A-Za-z0-9+/=]*)\x1b\\/gu)]
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((chunk) => chunk[0]).join("")).toBe(wire)
    for (const [index, chunk] of chunks.entries()) {
      const control = Object.fromEntries(chunk[1]!.split(",").map((part) => part.split("=")))
      expect(chunk[2]!.length).toBeLessThanOrEqual(4096)
      expect(chunk[2]!.length % 4).toBe(0)
      expect(control.m).toBe(index === chunks.length - 1 ? "0" : "1")
      // Animation errors survive; virtual placement must answer both success and failure.
      expect(control.q).toBe(quiet)
      if (index > 0) {
        expect(Object.keys(control).sort()).toEqual(continuationKeys)
        if (control.a !== undefined) expect(control.a).toBe("f")
      }
    }
    const pixels = Buffer.from(chunks.map((chunk) => chunk[2]).join(""), "base64")
    expect(pixels).toEqual(Buffer.alloc(26 * 58 * 3).fill(Buffer.from([255, 0, 0])))
  }
})

test("frame selection is a control command, never the playback start", () => {
  expect(kittySelectFrame(7, 2)).toContain("c=2")
  expect(kittySelectFrame(7, 2)).not.toContain("s=3")
  expect(kittyStopPlayback(7)).toContain("s=1")
  expect(kittyStartPlayback(7)).not.toContain(",c=")
  for (const command of [kittyRootGap(7), kittySelectFrame(7, 2), kittyStopPlayback(7), kittyStartPlayback(7)]) {
    expect(command).toContain(",q=1\x1b\\")
  }
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

test("virtual placement requests replies and declares its cell grid", () => {
  const wire = kittyVirtualPlacement(9, frame)
  expect(wire).toContain("a=T,U=1,i=9")
  expect(wire).toContain(",c=2,r=2")
  expect(wire).toContain("q=0")
  // A success reply still cannot establish rendered pixels.
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

test("the layout guard sits right of the grid, covers the row below it, and is identical in both states", () => {
  // The guard's own columns start where the placeholder grid ends, so the image never covers it.
  expect(KITTY_GUARD_REGION.left).toBe(KITTY_BLOCK_LEFT + KITTY_BLOCK_COLS)
  expect(KITTY_GUARD_REGION.right - KITTY_GUARD_REGION.left + 1).toBe(KITTY_GUARD_TEXT.length)
  expect(KITTY_GUARD_REGION.top).toBe(KITTY_BLOCK_TOP)
  // One row MORE than the grid: the row below the grid is captured too, so vertical reflow is caught.
  expect(KITTY_GUARD_REGION.bottom).toBe(KITTY_GUARD_REGION.top + 2)
  expect(KITTY_PLACEHOLDER_BOUNDS.minCols).toBe(KITTY_GUARD_REGION.right)
  const one = kittyPlaceholderText(7)
  const two = kittyPlaceholderText(7)
  // Byte-identical in both states: the guard is a control, not a difference the row could read.
  expect(one).toBe(two)
  expect(one.split(KITTY_GUARD_TEXT).length - 1).toBe(3)
  // The row BELOW the grid is the only guard the row writes with a CUP of its own.
  expect(one).toContain(
    `\u{1b}[${String(KITTY_GUARD_REGION.bottom)};${String(KITTY_GUARD_REGION.left)}H\u{1b}[0m${KITTY_GUARD_TEXT}`,
  )
  // Beside each placeholder row the guard follows the second cell directly, with NO cursor move: a CUP
  // to the guard column would repaint it in place even when the terminal widened or swallowed the
  // placeholder cells, which is the reflow this control has to see.
  for (const row of [KITTY_GUARD_REGION.top, KITTY_GUARD_REGION.top + 1]) {
    expect(one).not.toContain(`\u{1b}[${String(row)};${String(KITTY_GUARD_REGION.left)}H${KITTY_GUARD_TEXT}`)
  }
  // Each row's last placeholder cell is immediately followed by the reset and the guard bytes.
  for (const rowDiacritic of [KITTY_DIACRITIC_0, KITTY_DIACRITIC_1]) {
    expect(one).toContain(`${rowDiacritic}${KITTY_DIACRITIC_1}\u{1b}[0m${KITTY_GUARD_TEXT}`)
  }
})

function evidence(overrides: Partial<KittyAnimationEvidence> = {}): KittyAnimationEvidence {
  return {
    playback: ["a", "b"],
    retry: null,
    clientFrame: ["c", "d"],
    still: ["a", "a"],
    blank: "blank",
    reference: "a",
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

test("an equal playback pair needs live controls, a retry and an animation refusal for a negative", () => {
  // Equal playback with no retry recorded can never decide.
  expect(decideKittyAnimation(evidence({ playback: ["a", "a"] })).outcome).toBe("inconclusive")
  // Qualified negative pixels still need the terminal's own animation refusal.
  const equal = { playback: ["a", "a"], retry: ["a", "a"] } as const
  expect(decideKittyAnimation(evidence(equal)).outcome).toBe("inconclusive")
  expect(
    decideKittyAnimation(evidence({ ...equal, refusal: "start playback: ERROR: unimplemented action" })).outcome,
  ).toBe("unsupported")
  // The same equal playback pair that DOES advance on the retry is support, not a negative.
  expect(decideKittyAnimation(evidence({ playback: ["a", "a"], retry: ["a", "b"] })).outcome).toBe("supported")
  // Static setup can qualify a refusal even when frame selection is also rejected.
  const staticOnly = decideKittyAnimation(
    evidence({ ...equal, clientFrame: ["a", "a"], refusal: "second frame: ERROR: unimplemented action" }),
  )
  expect(staticOnly.outcome).toBe("unsupported")
  expect(staticOnly.note).toContain("hand selection did not change")
  // Failed a=f setup cannot masquerade as a terminal that simply ignores animation.
  expect(decideKittyAnimation(evidence({ playback: ["blank", "blank"], retry: ["blank", "blank"] })).outcome).toBe(
    "inconclusive",
  )
  expect(decideKittyAnimation(evidence({ playback: ["a", "a"], retry: ["a", undefined] })).outcome).toBe("inconclusive")
})

test("each failed control names itself instead of becoming a negative", () => {
  expect(decideKittyAnimation(evidence({ clientFrame: ["c", "c"] })).decidedBy).toBe("the client-driven update control")
  expect(decideKittyAnimation(evidence({ still: ["e", "z"] })).decidedBy).toBe("the still control")
  expect(decideKittyAnimation(evidence({ cursorOnly: ["f", "z"] })).decidedBy).toBe("the cursor-only control")
  expect(decideKittyAnimation(evidence({ redraw: ["g", "g"] })).decidedBy).toBe("the redraw control")
  expect(decideKittyAnimation(evidence({ playback: [undefined, "b"] })).decidedBy).toBe("a missing region digest")
  expect(decideKittyAnimation(evidence({ reference: "blank" })).decidedBy).toBe("the still control")
  expect(decideKittyAnimation(evidence({ reference: "other" })).decidedBy).toBe("the still control")
  for (const overrides of [
    { clientFrame: ["c", "c"] as const },
    { still: ["e", "z"] as const },
    { cursorOnly: ["f", "z"] as const },
    { redraw: ["g", "g"] as const },
  ]) {
    expect(decideKittyAnimation(evidence(overrides)).outcome).toBe("inconclusive")
  }
})

function placeholders(overrides: Partial<KittyPlaceholderEvidence> = {}): KittyPlaceholderEvidence {
  return {
    withImage: ["image", "image"],
    withoutImage: "text-only",
    guard: ["guard", "guard"],
    blank: "blank",
    ordinary: "image",
    reference: "image",
    cellReadback: null,
    ...overrides,
  }
}

test("placeholders are supported by pixels alone: differs from text, equals the ordinary placement, guard still", () => {
  // No cells adapter: the pixels decide, because the guard and the same-image control carry the
  // separation a cell readback used to provide.
  const supported = decideKittyPlaceholders(placeholders())
  expect(supported.outcome).toBe("supported")
  expect(supported.decidedBy).toContain("layout guard equal")
  // A cells adapter that agrees changes nothing.
  expect(decideKittyPlaceholders(placeholders({ cellReadback: ["cells", "cells"] })).outcome).toBe("supported")
})

test("each veto names itself instead of becoming a verdict", () => {
  // Cells that read back differently compared two different screens.
  const cells = decideKittyPlaceholders(placeholders({ cellReadback: ["one", "two"] }))
  expect(cells.outcome).toBe("inconclusive")
  expect(cells.decidedBy).toBe("the cell readback veto")
  // A moved guard means the layout changed between the states, so the rectangles are not comparable.
  const moved = decideKittyPlaceholders(placeholders({ guard: ["guard", "shifted"] }))
  expect(moved.outcome).toBe("inconclusive")
  expect(moved.decidedBy).toBe("the layout guard control")
  expect(moved.note).toContain("layout changed between states")
  // Something painted that is not the image: rendered, but not the ordinary placement.
  const notOrdinary = decideKittyPlaceholders(placeholders({ ordinary: "other-pixels", reference: "other-pixels" }))
  expect(notOrdinary.outcome).toBe("inconclusive")
  expect(notOrdinary.decidedBy).toBe("the same-image control")
  expect(notOrdinary.note).toContain("not pixel-identical to ordinary placement")
  // A rectangle that changes under a delayed re-capture is noise, not a state.
  expect(decideKittyPlaceholders(placeholders({ withImage: ["first", "second"] })).outcome).toBe("inconclusive")
  // A missing guard digest is a missing measurement, never a pass.
  expect(decideKittyPlaceholders(placeholders({ guard: [undefined, "guard"] })).decidedBy).toBe(
    "a missing region digest",
  )
})

test("identical pixels need a virtual-placement refusal, and an unmeasured path implicates nothing", () => {
  const equal = { withImage: ["same", "same"], withoutImage: "same" } as const
  expect(decideKittyPlaceholders(placeholders(equal)).outcome).toBe("inconclusive")
  const same = decideKittyPlaceholders(placeholders({ ...equal, refusal: "ERROR: unimplemented virtual placement" }))
  expect(same.outcome).toBe("unsupported")
  expect(same.decidedBy).toContain("layout guard equal")
  // The ordinary placement never painted, so the graphics path is unmeasured.
  expect(decideKittyPlaceholders(placeholders({ blank: "blank", ordinary: "blank" })).outcome).toBe("inconclusive")
  // Screen painted base64 text in its ordinary-control crop. A changed crop is not an image witness.
  for (const control of [
    { reference: "image", ordinary: "base64-text" },
    { reference: "blank", ordinary: "base64-text" },
  ]) {
    const unqualified = decideKittyPlaceholders(
      placeholders({ withImage: ["same", "same"], withoutImage: "same", ...control }),
    )
    expect(unqualified.outcome).toBe("inconclusive")
    expect(unqualified.decidedBy).toBe("the ordinary-placement control")
    expect(unqualified.note).toContain("reference")
  }
})
