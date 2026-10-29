/**
 * @failure A kitty animation row graded from a single frame, or from the terminal's acknowledgement,
 *   claims timed playback it never saw. The observation here is TWO target frames of one cell-aligned
 *   rectangle with no write between them, taken only after the surrounding path is proven alive by
 *   independent controls in the same run: a client-driven frame selection that must differ, a
 *   one-frame image that must hold still, a cursor-only capture that must leave the rectangle alone,
 *   and a redraw that must change the screen outside it. Every verdict names the control that failed.
 *
 * @failure A kitty placeholder row graded from `U=1` being accepted, or from the placeholder cells
 *   reading back, inherits the acknowledgement instead of the pixels. Quiet transmission removes the
 *   reply path on purpose, so the deciding pair is the placeholder rectangle with the image composited
 *   over it against the SAME characters on the same foreground colour with the image deleted, and the
 *   live control is an ordinary `a=p` placement of the same pixels in the same rectangle, measured
 *   against a captured blank.
 */

import { randomUUID } from "node:crypto"

/** The image block: two cells square, placed away from the cursor column. */
export const KITTY_BLOCK_ROWS = 2
export const KITTY_BLOCK_COLS = 2
export const KITTY_BLOCK_TOP = 3
export const KITTY_BLOCK_LEFT = 3

/** The cursor parks below the block, outside every compared region. */
export const KITTY_CURSOR_ROW = KITTY_BLOCK_TOP + KITTY_BLOCK_ROWS + 1

/** The compared rectangle: the block itself, cell-aligned in the run's own grid. */
export const KITTY_REGION = {
  top: KITTY_BLOCK_TOP,
  left: KITTY_BLOCK_LEFT,
  bottom: KITTY_BLOCK_TOP + KITTY_BLOCK_ROWS - 1,
  right: KITTY_BLOCK_LEFT + KITTY_BLOCK_COLS - 1,
} as const

/** The grid this block needs, stated once so the geometry query and the paint cannot drift. */
export const KITTY_BOUNDS = { minRows: KITTY_CURSOR_ROW, minCols: KITTY_BLOCK_LEFT + KITTY_BLOCK_COLS } as const

/** The gap the probe sets itself, in milliseconds. The protocol's default is not used anywhere. */
export const KITTY_GAP_MS = 250

/** Playback is read after at least this multiple of the gap (the spec's own settle advice). */
export const KITTY_WAIT_FACTOR = 1.5

/** A first equal pair is retried at this multiple of the gap before any negative. */
export const KITTY_RETRY_FACTOR = 2

/**
 * Loop count, always explicit: `v=1` loops forever, `v=0` is ignored by the protocol, and the table's
 * default conflicts with its prose, so the probe never relies on either.
 */
export const KITTY_LOOP_FOREVER = 1

export const KITTY_CLEAR = "\x1b[0m\x1b[2J\x1b[H"

/** Frame colours: one solid red frame and one solid blue frame, so the pair cannot be confused. */
export const KITTY_FRAME_RED = [255, 0, 0] as const
export const KITTY_FRAME_BLUE = [0, 0, 255] as const

/** A fresh image number for the animation arms: any value the terminal will allocate. */
export function kittyImageNumber(): number {
  return (Number.parseInt(randomUUID().slice(0, 8), 16) % 0xfffffffe) + 1
}

/** A fresh placeholder id pinned to 1..255, so the foreground colour carries it with no third diacritic. */
export function kittyPlaceholderNumber(): number {
  return (Number.parseInt(randomUUID().slice(0, 6), 16) % 255) + 1
}

/** One wait, in milliseconds: the interval both rows measure and report. */
export function kittyWait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** The cursor park every capture in these rows shares: a row outside the compared rectangle. */
export function kittyPark(): string {
  return `\x1b[${KITTY_CURSOR_ROW};1H`
}

/**
 * The block's top-left cell. A placement without a cursor move lands AT the cursor, so every `a=p`
 * is preceded by this CUP and followed by the park: the image paints inside the compared rectangle
 * and the cursor never rests inside it.
 */
export function kittyBlockOrigin(): string {
  return `\x1b[${KITTY_BLOCK_TOP};${KITTY_BLOCK_LEFT}H`
}

/** Raw RGB bytes as the base64 payload the protocol carries with `f=24`. */
export function kittyPixelPayload(width: number, height: number, rgb: readonly [number, number, number]): string {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`kitty pixel payload needs a positive whole size; got ${String(width)}x${String(height)}`)
  }
  const bytes = Buffer.alloc(width * height * 3)
  for (let index = 0; index < width * height; index++) {
    bytes[index * 3] = rgb[0]
    bytes[index * 3 + 1] = rgb[1]
    bytes[index * 3 + 2] = rgb[2]
  }
  return bytes.toString("base64")
}

/** The pixel size of the block from THIS run's report: whole pixels per cell, or a thrown refusal. */
export function kittyBlockPixels(geometry: { readonly cellWidth: number; readonly cellHeight: number }): {
  width: number
  height: number
} {
  const { cellWidth, cellHeight } = geometry
  if (!Number.isSafeInteger(cellWidth) || !Number.isSafeInteger(cellHeight) || cellWidth <= 0 || cellHeight <= 0) {
    throw new Error(
      `kitty block size needs positive whole pixels per cell; this run reported ${String(cellWidth)}x${String(cellHeight)}`,
    )
  }
  return { width: KITTY_BLOCK_COLS * cellWidth, height: KITTY_BLOCK_ROWS * cellHeight }
}

/**
 * One animation frame. A NON-root frame carries its own `z` here: `z=0` is ignored by the protocol and
 * an unset gap falls back to a default, which is exactly the value this row must not inherit.
 *
 * The ROOT frame is different and is NOT given a gap here: the spec states the first frame is created
 * with the base image data and "has no gap, so its gap must be set using this control code" — that is
 * `kittyRootGap` below. Quiet transmission keeps the reply stream free of acks that the trace could
 * later mistake for evidence.
 */
export function kittyFrameTransfer(
  imageId: number,
  frame: { readonly width: number; readonly height: number; readonly rgb: readonly [number, number, number] },
  options: { readonly root?: boolean; readonly gapMs?: number } = {},
): string {
  const size = options.root ? `,s=${frame.width},v=${frame.height}` : ""
  const gap = options.root ? "" : `,z=${String(options.gapMs ?? KITTY_GAP_MS)}`
  return `\x1b_Ga=f,i=${imageId},f=24${size}${gap},q=2;${kittyPixelPayload(frame.width, frame.height, frame.rgb)}\x1b\\`
}

/**
 * The root frame's own gap, set through the animation control code because the root carries no gap at
 * transfer time (kitty graphics protocol, "Controlling animations": "the first frame or root frame is
 * created with the base image data and has no gap, so its gap must be set using this control code").
 * Without it the root would run on the zero default and two equal captures would mean nothing.
 */
export function kittyRootGap(imageId: number, gapMs: number = KITTY_GAP_MS): string {
  return `\x1b_Ga=a,i=${imageId},r=1,z=${String(gapMs)},q=2\x1b\\`
}

/** Place the image. The ack is read as the live placement path, never as pixels. */
export function kittyPlace(imageId: number): string {
  return `\x1b_Ga=p,i=${imageId},c=${KITTY_BLOCK_COLS},r=${KITTY_BLOCK_ROWS},C=1\x1b\\`
}

/** Start terminal-driven playback: `s=3` with the explicit loop count. */
export function kittyStartPlayback(imageId: number): string {
  return `\x1b_Ga=a,i=${imageId},s=3,v=${KITTY_LOOP_FOREVER},q=2\x1b\\`
}

/** Stop playback, so the client-driven control can select a frame itself. */
export function kittyStopPlayback(imageId: number): string {
  return `\x1b_Ga=a,i=${imageId},s=1,q=2\x1b\\`
}

/** Client-driven frame selection. This is the update CONTROL, never the animation observation. */
export function kittySelectFrame(imageId: number, frame: number): string {
  return `\x1b_Ga=a,i=${imageId},c=${frame},q=2\x1b\\`
}

/** Free one image, and only the image this row allocated. */
export function kittyDeleteImage(imageId: number): string {
  return `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`
}

/**
 * The placeholder code point and the diacritics the protocol's own example pins: U+0305 is 0,
 * U+030D is 1 and U+030E is 2. A 2x2 grid needs only 0 and 1.
 */
export const KITTY_PLACEHOLDER = "\u{10EEEE}"
export const KITTY_DIACRITIC_0 = "\u{0305}"
export const KITTY_DIACRITIC_1 = "\u{030D}"
export const KITTY_DIACRITIC_2 = "\u{030E}"

/** Diacritic for a row or column index, with the third value kept for a high byte we never need. */
export function kittyDiacritic(index: number): string {
  if (index === 0) return KITTY_DIACRITIC_0
  if (index === 1) return KITTY_DIACRITIC_1
  if (index === 2) return KITTY_DIACRITIC_2
  throw new Error(`kitty placeholder diacritic has no pinned value for index ${String(index)}`)
}

/**
 * Quiet virtual placement: `a=T,U=1` stores the image without displaying it, `c`/`r` declare the
 * cell grid it will be tiled across, and `q=2` suppresses every reply. Nothing here is evidence.
 */
export function kittyVirtualPlacement(
  imageId: number,
  frame: { readonly width: number; readonly height: number; readonly rgb: readonly [number, number, number] },
): string {
  return `\x1b_Ga=T,U=1,i=${imageId},f=24,s=${frame.width},v=${frame.height},c=${KITTY_BLOCK_COLS},r=${KITTY_BLOCK_ROWS},q=2;${kittyPixelPayload(frame.width, frame.height, frame.rgb)}\x1b\\`
}

/**
 * The placeholder text for the 2x2 grid, with the image id carried in the foreground colour exactly
 * as the protocol's own example does. The same string is printed in BOTH states, so the two screens
 * differ only by the composited image.
 */
export function kittyPlaceholderText(imageId: number): string {
  if (!Number.isSafeInteger(imageId) || imageId < 1 || imageId > 255) {
    throw new Error(
      `kitty placeholder ids are pinned to 1..255 so no third diacritic is needed; got ${String(imageId)}`,
    )
  }
  const rows: string[] = []
  for (let row = 0; row < KITTY_BLOCK_ROWS; row++) {
    let line = ""
    for (let col = 0; col < KITTY_BLOCK_COLS; col++) {
      line += `${KITTY_PLACEHOLDER}${kittyDiacritic(row)}${kittyDiacritic(col)}`
    }
    rows.push(`\x1b[${KITTY_BLOCK_TOP + row};${KITTY_BLOCK_LEFT}H${line}`)
  }
  return `\x1b[38;5;${imageId}m${rows.join("")}\x1b[0m${kittyPark()}`
}

/** The same-comparison rule both rows share: byte inequality of the region digest, never a tolerance. */
export type KittyDigestPair = readonly [string | undefined, string | undefined]

/** What the animation run saw, arm by arm. Every digest is the region digest of one target frame. */
export interface KittyAnimationEvidence {
  /** Arm 1, terminal-driven playback: the two frames with no write between them. */
  readonly playback: KittyDigestPair
  /** Arm 1's retry at twice the gap, only taken when the first pair was equal. */
  readonly retry: KittyDigestPair | null
  /** Arm 2, client-driven frame selection: must differ, proving the image pipeline paints. */
  readonly clientFrame: KittyDigestPair
  /** Arm 3, one-frame image over the same intervals: must be equal. */
  readonly still: KittyDigestPair
  /** Arm 4, cursor-only control inside the compared rectangle: must be equal. */
  readonly cursorOnly: KittyDigestPair
  /** Arm 5, whole-window capture across one ordinary glyph outside the rectangle: must differ. */
  readonly redraw: KittyDigestPair
  /** Milliseconds actually elapsed between the playback pair, measured from the first capture. */
  readonly playbackElapsedMs: number
}

export interface KittyVerdict {
  readonly outcome: "supported" | "unsupported" | "inconclusive"
  readonly note: string
  /** The control or measurement that decided it, in the row's own words. */
  readonly decidedBy: string
}

function pairNames(pair: KittyDigestPair): string {
  return `${pair[0] ?? "none"}/${pair[1] ?? "none"}`
}

/**
 * The animation decision table, one branch per control so a failed control names itself. Two frames
 * that agree are never a negative until the pipeline and the surface are both shown alive and the
 * pair is retried at twice the gap.
 */
export function decideKittyAnimation(evidence: KittyAnimationEvidence): KittyVerdict {
  const missing = (
    [
      ["playback", evidence.playback],
      ["client-frame", evidence.clientFrame],
      ["still", evidence.still],
      ["cursor-only", evidence.cursorOnly],
      ["redraw", evidence.redraw],
    ] as const
  ).find(([, pair]) => pair[0] === undefined || pair[1] === undefined)
  if (missing) {
    return {
      outcome: "inconclusive",
      note: `Kitty animation: the ${missing[0]} arm reported a frame with no region digest, so the pair cannot be compared`,
      decidedBy: "a missing region digest",
    }
  }
  if (evidence.clientFrame[0] === evidence.clientFrame[1]) {
    return {
      outcome: "inconclusive",
      note: `Kitty animation: selecting frame 2 by hand left the rectangle unchanged (${pairNames(evidence.clientFrame)}), so the image pipeline is unproven and an equal playback pair proves nothing`,
      decidedBy: "the client-driven update control",
    }
  }
  if (evidence.still[0] !== evidence.still[1]) {
    return {
      outcome: "inconclusive",
      note: `Kitty animation: a one-frame image did not hold still across the same intervals (${pairNames(evidence.still)}), so a moving playback pair cannot be told apart from capture noise`,
      decidedBy: "the still control",
    }
  }
  if (evidence.cursorOnly[0] !== evidence.cursorOnly[1]) {
    return {
      outcome: "inconclusive",
      note: `Kitty animation: parking the cursor changed the compared rectangle (${pairNames(evidence.cursorOnly)}), so the cursor sits inside it and the comparison is contaminated`,
      decidedBy: "the cursor-only control",
    }
  }
  if (evidence.redraw[0] === evidence.redraw[1]) {
    return {
      outcome: "inconclusive",
      note: `Kitty animation: one ordinary glyph outside the rectangle did not change the captured screen (${pairNames(evidence.redraw)}), so a repaint witness is missing`,
      decidedBy: "the redraw control",
    }
  }
  if (evidence.playback[0] !== evidence.playback[1]) {
    return {
      outcome: "supported",
      note: `Kitty animation: terminal-driven playback changed the rectangle between two captures with no write between them (${pairNames(evidence.playback)}), ${String(evidence.playbackElapsedMs)} ms after the first capture, while frame selection, a one-frame image, the cursor and a redraw behaved as controls require`,
      decidedBy: "two target frames of one run with no write between them",
    }
  }
  if (evidence.retry === null) {
    return {
      outcome: "inconclusive",
      note: `Kitty animation: the playback pair was equal (${pairNames(evidence.playback)}) and the retry at twice the gap was not performed`,
      decidedBy: "a missing retry",
    }
  }
  if (evidence.retry[0] !== evidence.retry[1]) {
    return {
      outcome: "supported",
      note: `Kitty animation: terminal-driven playback advanced on the retry at twice the gap (${pairNames(evidence.retry)}), so the first pair was timing, not absence`,
      decidedBy: "two target frames of one run on the retried interval",
    }
  }
  return {
    outcome: "unsupported",
    note: `Kitty animation: two captures at twice the gap were equal (${pairNames(evidence.retry)}) while frame selection still changed the rectangle, so the image paints and the terminal did not advance it on its own timer`,
    decidedBy: "the retried playback pair, with the update control alive",
  }
}

/** What the placeholder run saw. */
export interface KittyPlaceholderEvidence {
  /** The placeholder rectangle with the image composited over it. */
  readonly withImage: KittyDigestPair
  /** The same characters and foreground colour with the image deleted. */
  readonly withoutImage: string | undefined
  /** A captured blank rectangle, before the ordinary placement paints it. */
  readonly blank: string | undefined
  /** The ordinary `a=p` placement of the same pixels in the same rectangle. */
  readonly ordinary: string | undefined
  /**
   * Cell readbacks of the placeholder rectangle in both states. REQUIRED for a verdict: without them
   * a pixel difference cannot separate the composited image from a change in the placeholder
   * characters themselves, so `null` refuses by name instead of deciding permissively.
   */
  readonly cellReadback: KittyDigestPair | null
}

/**
 * The placeholder decision table. The cell readback is a PRECONDITION, not a discriminator: matching
 * readbacks prove both states contain the same text, and a missing readback is inconclusive by name
 * rather than a permissive pass. Quiet mode means no acknowledgement exists to inherit.
 */
export function decideKittyPlaceholders(evidence: KittyPlaceholderEvidence): KittyVerdict {
  if (evidence.withImage[0] === undefined || evidence.withImage[1] === undefined) {
    return {
      outcome: "inconclusive",
      note: "Kitty unicode placeholders: a placeholder frame reported no region digest, so nothing was compared",
      decidedBy: "a missing region digest",
    }
  }
  if (evidence.withoutImage === undefined) {
    return {
      outcome: "inconclusive",
      note: "Kitty unicode placeholders: the without-image control reported no region digest",
      decidedBy: "a missing region digest",
    }
  }
  if (!evidence.cellReadback) {
    return {
      outcome: "inconclusive",
      note: "Kitty unicode placeholders: this run read no cells, so the two states' text was never compared and a pixel difference alone cannot separate the image from a change in the placeholder characters; the cell readback is the precondition the contract requires",
      decidedBy: "a missing cell readback",
    }
  }
  if (evidence.cellReadback[0] !== evidence.cellReadback[1]) {
    return {
      outcome: "inconclusive",
      note: `Kitty unicode placeholders: the placeholder cells read back differently in the two states (${pairNames(evidence.cellReadback)}), so the run compared two different screens`,
      decidedBy: "the cell readback precondition",
    }
  }
  if (evidence.blank === undefined || evidence.ordinary === undefined) {
    return {
      outcome: "inconclusive",
      note: "Kitty unicode placeholders: the ordinary-placement control reported no region digest",
      decidedBy: "a missing region digest",
    }
  }
  if (evidence.blank === evidence.ordinary) {
    return {
      outcome: "inconclusive",
      note: "Kitty unicode placeholders: the ordinary placement did not paint the rectangle it was given, so the graphics path is unmeasured and the feature is not implicated",
      decidedBy: "the ordinary-placement control",
    }
  }
  if (evidence.withImage[1] !== evidence.withoutImage) {
    return {
      outcome: "supported",
      note: `Kitty unicode placeholders: the placeholder rectangle painted with the image composited over it (${pairNames(evidence.withImage)} against ${evidence.withoutImage}) while the same characters on the same foreground colour did not, and an ordinary placement of the same pixels did`,
      decidedBy: "the with-image and without-image pair, with the ordinary placement alive",
    }
  }
  return {
    outcome: "unsupported",
    note: `Kitty unicode placeholders: the placeholder rectangle is pixel-identical with and without the image (${pairNames(evidence.withImage)} against ${evidence.withoutImage}) while the ordinary placement of the same pixels painted, so the same pixels render through a=p and not through placeholders`,
    decidedBy: "the with-image and without-image pair, after the delayed re-capture",
  }
}
