import type { TerminalOptions } from "@termless/core"
import { HOST_INPUT_NAMES, type HostInputName } from "@terminfo/probe-defs"

/**
 * The one terminal this harness declares to every headless engine: 80x24 cells of 10x20 pixels, an 800x480 text area.
 * The pixel geometry is a declared host input, not a measured metric; no backend holds a default for it.
 */
export const HEADLESS_TERMINAL = {
  cols: 80,
  rows: 24,
  pixelGeometry: { cellWidth: 10, cellHeight: 20 },
} as const satisfies TerminalOptions

/**
 * The host inputs collector.collectionAttempt declares supplied, read from the same object every engine is initialized
 * with, so the record and the engine's input cannot disagree.
 */
export function declaredHostInputs(): Record<HostInputName, string> {
  return Object.fromEntries(
    HOST_INPUT_NAMES.map((name) => [
      name,
      name === "pixel-geometry" ? JSON.stringify(HEADLESS_TERMINAL.pixelGeometry) : "not-supplied",
    ]),
  ) as Record<HostInputName, string>
}
