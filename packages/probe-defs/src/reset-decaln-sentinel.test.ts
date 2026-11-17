/**
 * @failure reset.decaln's frames leave no blank cell, so every pixel read refuses "No sentinel pair can
 * be anchored in this frame; no blank cell exists" and the row can never be decided (34546: Alacritty,
 * WezTerm and xterm on Linux).
 * @level l2
 * @consumer The region readback's sentinel-pair chooser, fed the frames reset.decaln paints.
 * @testonly decalnReadback: exported so its seed, edit and expected frames reach the real chooser.
 */
import { expect, test } from "vitest"
import { sentinelCellsInFrame } from "./region-readback.ts"
import { decalnReadback } from "./reset.ts"
import { createSemanticSurface } from "./testing/semantic-surface.ts"
import type { CaptureCells } from "./types.ts"

const cell = { width: 7, height: 15 }

/**
 * Paint a surface's cells as pixels: background everywhere, a glyph's worth of ink (the top half) on
 * every non-blank cell. A solid fill would make ink the frame's modal colour once most rows carry it,
 * and the chooser would then read every inked cell as blank (the trap sentinel-cells-in-frame names).
 */
function pixelsOf(rows: number, cols: number, write: string) {
  const surface = createSemanticSurface({ rows, cols })
  surface.feed(write)
  const width = cols * cell.width
  const height = rows * cell.height
  const rgba = new Uint8Array(width * height * 4)
  const put = (x: number, y: number, packed: number) => {
    const offset = (y * width + x) * 4
    rgba[offset] = (packed >> 16) & 0xff
    rgba[offset + 1] = (packed >> 8) & 0xff
    rgba[offset + 2] = packed & 0xff
    rgba[offset + 3] = 0xff
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, 0x050505)
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const char = surface.getCell(row, col).char
      if (char === "" || char === " ") continue
      for (let y = row * cell.height; y < row * cell.height + Math.floor(cell.height / 2); y++) {
        for (let x = col * cell.width; x < (col + 1) * cell.width; x++) put(x, y, 0xc1e3fe)
      }
    }
  }
  return { rgba, width, height }
}

test.each([
  { rows: 7, cols: 9 },
  { rows: 24, cols: 80 },
])("every reset.decaln frame anchors a sentinel pair on a $rows x $cols grid", ({ rows, cols }) => {
  const spec = decalnReadback(rows, cols)
  if (spec === null) throw new Error(`decalnReadback refused ${rows}x${cols}`)
  // What every read keeps the pair off: the compared region, the witness cell and the cursor row.
  const regions: CaptureCells[] = [
    spec.region,
    { top: spec.sentinel.row, left: spec.sentinel.col, bottom: spec.sentinel.row, right: spec.sentinel.col },
    { top: spec.cursorRow, left: 1, bottom: spec.cursorRow, right: cols },
  ]
  const frames = {
    seed: spec.seed,
    "after ESC # 8": spec.seed + spec.edit,
    expected: spec.expected,
  }
  for (const [name, write] of Object.entries(frames)) {
    const located = sentinelCellsInFrame({
      ...pixelsOf(rows, cols, write),
      reading: { x: 0, y: 0 },
      cell,
      grid: { rows, cols },
      regions,
    })
    expect(located.a.row, name).toBeGreaterThan(4)
    expect(located.b.row, name).toBeGreaterThan(4)
  }
  // The edit still proves DECALN: the compared rows hold E, written by ESC # 8 over an AB seed.
  const surface = createSemanticSurface({ rows, cols })
  surface.feed(spec.seed + spec.edit)
  for (let row = spec.region.top - 1; row < spec.region.bottom; row++) {
    for (let col = spec.region.left - 1; col < spec.region.right; col++) {
      expect(surface.getCell(row, col).char).toBe("E")
    }
  }
})

test("refuses a grid too short for evidence rows, a blank pair and the cursor row", () => {
  expect(decalnReadback(6, 80)).toBeNull()
  expect(decalnReadback(7, 8)).toBeNull()
})
