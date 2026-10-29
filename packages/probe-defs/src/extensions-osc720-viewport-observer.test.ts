/**
 * @failure A derived scrollback row is read as a viewport observer, so an engine whose backend has no
 * viewport scroll state is graded Unsupported instead of recorded as a coverage gap.
 * @level l1
 * @consumer Headless extensions.osc720-scroll-up observation.
 * @reach Drives the real osc720 lib callback with the WezTerm shape measured on termless 06340a5c:
 * positive derived history, a native offset pinned at 0, and a scroll control that changes nothing.
 * @testonly none
 */
import { expect, test } from "vitest"
import { extensionsProbes } from "./extensions.ts"
import type { LibProbeSource } from "./types.ts"

type Scroll = ReturnType<LibProbeSource["getScrollback"]>

/**
 * A headless engine model with `screenRows` visible rows and a viewport whose reported position is
 * derived as `totalRows - screenRows - nativeOffset`. `scrollableViewport: false` is the WezTerm
 * shape measured on termless 06340a5c: the native offset is hardcoded 0 and the scroll control is a
 * no-op, so the reported position can never move.
 */
function viewportModel(options: {
  scrollableViewport: boolean
  /** Which delta moves the viewport up, when it can move at all. */
  upDelta?: number
  /** Whether OSC 720 moves the viewport up. */
  honorsOsc720: boolean
  /** Whether the control leaves the baseline unrestorable. */
  resetBroken?: boolean
  /** Whether the measured OSC 720 also changes the buffer geometry. */
  osc720ChangesGeometry?: boolean
  /** Whether the control changes only the geometry, leaving the position pinned. */
  controlChangesGeometryOnly?: boolean
}): LibProbeSource {
  const screenRows = 24
  let fed = 0
  let nativeOffset = 0
  let rows = screenRows
  const historyRows = 30
  const feedHistory = (text: string) => {
    if (!text.includes("scroll-")) return
    fed += 1
    rows = screenRows + fed
  }
  const up = (delta: number) => {
    if (options.controlChangesGeometryOnly) {
      rows += 1
      return
    }
    if (!options.scrollableViewport) return
    if (delta !== (options.upDelta ?? -1)) return
    nativeOffset = Math.min(nativeOffset + 1, rows - screenRows)
  }
  const reading = (): Scroll => {
    const viewportTop = rows - screenRows - nativeOffset
    return { viewportOffset: viewportTop, totalLines: rows, screenLines: screenRows }
  }
  return {
    kind: "live",
    cols: 80,
    capabilities: {
      truecolor: false,
      kittyKeyboard: false,
      kittyGraphics: false,
      sixel: false,
      osc8Hyperlinks: false,
      semanticPrompts: false,
      reflow: false,
      unicode: "15.1",
      extensions: new Set<string>(),
    },
    feed(text: string) {
      if (text.includes("\x1b]720") && options.honorsOsc720) up(options.upDelta ?? -1)
      if (text.includes("\x1b]720") && options.osc720ChangesGeometry) rows += 1
      feedHistory(text)
    },
    feedCapture: () => "",
    getMode: () => false,
    getText: () => "",
    getTitle: () => "",
    getCell: () => ({
      char: " ",
      bold: false,
      dim: null,
      italic: null,
      underline: false,
      strikethrough: null,
      inverse: false,
      hidden: false,
      blink: null,
      overline: null,
      fg: null,
      bg: null,
      wide: false,
    }),
    getCursor: () => ({ x: 0, y: 0, visible: true, style: null }),
    getScrollback: reading,
    reset() {
      fed = 0
      nativeOffset = options.resetBroken ? 3 : 0
      rows = screenRows
    },
    scrollViewport: up,
  }
}

function osc720() {
  const definition = extensionsProbes.find((entry) => entry.id === "extensions.osc720-scroll-up")
  if (!definition?.lib) throw new Error("missing extensions.osc720-scroll-up lib callback")
  return definition.lib
}

test("a pinned viewport that never moves records coverage, not a measured Unsupported", () => {
  const result = osc720()(viewportModel({ scrollableViewport: false, honorsOsc720: false }))
  expect(result.notTested?.reason).toBe("no-semantic-observable")
  expect(result.notTested?.noObservable).toContain("viewport")
  expect(result.observation?.outcome).not.toBe("unsupported")
})

test("a viewport that the control can move still grades an ignored OSC 720 as Unsupported", () => {
  const result = osc720()(viewportModel({ scrollableViewport: true, honorsOsc720: false }))
  expect(result.notTested).toBeUndefined()
  expect(result.observation?.outcome).toBe("unsupported")
  expect(result.pass).toBe(false)
})

test("a viewport that the control can move still grades a moving OSC 720 as supported", () => {
  const result = osc720()(viewportModel({ scrollableViewport: true, honorsOsc720: true }))
  expect(result.notTested).toBeUndefined()
  expect(result.observation?.outcome).toBe("supported")
  expect(result.pass).toBe(true)
})

test("a control that leaves the baseline unrestorable is inconclusive, never a verdict", () => {
  const result = osc720()(viewportModel({ scrollableViewport: true, honorsOsc720: false, resetBroken: true }))
  expect(result.notTested).toBeUndefined()
  expect(result.observation?.outcome).toBe("inconclusive")
  expect(result.observation?.reason).toBe("insufficient-evidence")
  expect(result.assertions).toBeUndefined()
})

test("a measured sequence that changes the buffer geometry is inconclusive, never a verdict", () => {
  const result = osc720()(viewportModel({ scrollableViewport: true, honorsOsc720: true, osc720ChangesGeometry: true }))
  expect(result.notTested).toBeUndefined()
  expect(result.observation?.outcome).toBe("inconclusive")
  expect(result.assertions).toBeUndefined()
})

test("a control that changes only the geometry is inconclusive, never coverage", () => {
  const result = osc720()(
    viewportModel({ scrollableViewport: true, honorsOsc720: false, controlChangesGeometryOnly: true }),
  )
  expect(result.notTested).toBeUndefined()
  expect(result.observation?.outcome).toBe("inconclusive")
  expect(result.observation?.reason).toBe("insufficient-evidence")
  expect(result.note).toContain("geometry")
  expect(result.assertions).toBeUndefined()
})
