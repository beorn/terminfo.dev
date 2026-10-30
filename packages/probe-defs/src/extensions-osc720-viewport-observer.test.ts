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

// The existing movement controls cannot detect loss of a declared absence before history I/O.
// Retain source-review evidence, including missing identity, without inventing a measurement.
test.each([
  { identity: false, actuator: false },
  { identity: true, actuator: false },
  { identity: false, actuator: true },
])("OSC720 declared viewport absence preserves review boundary %j", ({ identity, actuator }) => {
  const source = viewportModel({ scrollableViewport: true, honorsOsc720: true })
  const productViewport = { available: false as const, reason: "Fixture library exposes no product viewport" }
  source.capabilities.productViewport = productViewport
  if (!actuator) delete source.scrollViewport
  const runtimeIdentity: LibProbeSource["runtimeIdentity"] = {
    kind: "js",
    runtimeFormat: "js",
    resolvedPath: "/fixtures/viewport.js",
    engineVersion: "fixture",
    adapterVersion: "fixture",
    termlessRevision: "fixture",
    integrity: { kind: "registry", lockIntegrity: "sha512:fixture" },
  }
  let historyCalls = 0
  source.feed = () => {
    historyCalls++
  }
  source.getScrollback = () => {
    historyCalls++
    return { totalLines: 24, screenLines: 24, viewportOffset: 0 }
  }
  const result = osc720()({ ...source, ...(identity ? { runtimeIdentity } : {}) })
  if (actuator) {
    expect(result.observation?.outcome).toBe("inconclusive")
    expect(result.note).toMatch(/declared absent.*scroll control.*present/)
    expect(result.criterionBranch).toBeUndefined()
    expect(result.notTested).toBeUndefined()
  } else {
    expect(result).toMatchObject({
      criterionBranch: "headless-observable-review",
      notTested: { noObservable: "scrollback viewport scroll control" },
      tests: [{ id: "review", status: "test-todo", reason: productViewport.reason }],
    })
    expect(result.observation).toBeUndefined()
  }
  expect(result.assertions).toBeUndefined()
  expect(JSON.parse(result.response!)).toEqual({ productViewport, runtimeIdentity: identity ? runtimeIdentity : null })
  expect(historyCalls).toBe(0)
})

test("OSC720 missing an undeclared actuator stays coverage, without a source review", () => {
  const source = viewportModel({ scrollableViewport: true, honorsOsc720: true })
  delete source.scrollViewport
  const result = osc720()(source)
  expect(result.notTested?.noObservable).toBe("scrollback viewport scroll control")
  expect(result.criterionBranch).toBeUndefined()
  expect(result.observation?.outcome).not.toBe("unsupported")
})

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
