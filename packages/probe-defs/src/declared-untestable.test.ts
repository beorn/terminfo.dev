/**
 * @failure A library result the operator declared Untestable (Nov 4 16:55) still reads PROBE TODO, or an undeclared
 *   untestable test reaches Untestable through the finalizer.
 * @level l1
 * @consumer finalizeProbeResult and the seven declared probes' library arms, read by the headless collector.
 * @reach Runs each declared probe's library callback against a minimal context and folds it.
 * @testonly none
 */
import { expect, test } from "vitest"
import {
  DECLARED_UNTESTABLE_TEST,
  HEADLESS_OBSERVABLE_REVIEW,
  declaredUntestableResult,
  isDeclaredUntestable,
  recordExecutedProbe,
} from "./helpers.ts"
import { ALL_PROBES } from "./index.ts"
import type { LibProbeSource, NotTestedCoverageResult, ProbeCallbackResult } from "./types.ts"

const attempt = { scope: "probe", startedAt: "2026-11-05T01:00:00.000Z" } as const

const fold = (featureId: string, result: ProbeCallbackResult) =>
  recordExecutedProbe({
    featureId,
    attempt,
    assertions: [],
    ...(result.notTested ? { coverage: { featureId, rawReplyRef: featureId, ...result.notTested } } : {}),
    ...(result.tests ? { tests: result.tests } : {}),
    ...(result.criterionBranch ? { criterionBranch: result.criterionBranch } : {}),
  })

const library = (backendName = "alacritty"): LibProbeSource =>
  ({
    backendName,
    cols: 80,
    rows: 24,
    capabilities: { kittyGraphics: true, sixel: true, extensions: new Set(["iterm2Images"]) },
    feed: () => {},
    getText: () => "",
    getCell: () => ({ char: "X" }),
    getCursor: () => ({ x: 0, y: 0, visible: true, style: null }),
    reset: () => {},
  }) as unknown as LibProbeSource

// The operator's Nov 4 16:55 decision, part A: each feature's reason, written once in its own probe.
const declared = [
  ["extensions.kitty-graphics.unicode-placeholders", /Unicode placeholder rendering/],
  ["extensions.kitty-graphics.animation", /timed animation playback/],
  ["extensions.iterm2-images", /rendered image pixels/],
  ["extensions.font-ligatures", /shapes no glyphs/],
  ["device.term-features", /no application child/],
  ["extensions.sixel", /rendered pixels/],
] as const

test.each(declared)("%s library arm reads Untestable with its declared reason", (id, reason) => {
  const definition = ALL_PROBES.find((probe) => probe.id === id)
  if (!definition?.lib) throw new Error(`missing library arm ${id}`)
  const result = definition.lib(library()) as ProbeCallbackResult
  expect(isDeclaredUntestable(result)).toBe(true)
  expect(result.tests).toEqual([
    { id: DECLARED_UNTESTABLE_TEST, status: "untestable", reason: expect.stringMatching(reason) },
  ])
  const folded = fold(id, result)
  expect(folded.status).toBe("untestable")
  expect(folded.reason).toMatch(reason)
})

// The exceptions named inside their probes stay as they are: vterm's stored Sixel payload keeps its review, and
// XTEST key injection is declared only for the five libraries with no public key encoder (CTO 47010d76).
test("vterm's Sixel storage arm and the encoder-exporting XTEST arms are not declared and stay PROBE TODO", () => {
  const sixel = ALL_PROBES.find((probe) => probe.id === "extensions.sixel")!.lib!
  const stored = sixel({ ...library("vterm"), getSixelImages: () => [] } as unknown as LibProbeSource)
  expect(isDeclaredUntestable(stored)).toBe(false)
  expect(fold("extensions.sixel", stored).status).toBe("probe-todo")
  const xtest = ALL_PROBES.find((probe) => probe.id === "input.xtest-key")!.lib!
  for (const backendName of ["libvterm", "vterm"]) {
    const result = xtest(library(backendName)) as ProbeCallbackResult
    expect(isDeclaredUntestable(result)).toBe(false)
    expect(fold("input.xtest-key", result).status).toBe("probe-todo")
  }
  expect(isDeclaredUntestable(xtest(library("vt100")) as ProbeCallbackResult)).toBe(true)
})

test("the declared helper needs a reason and folds only in its exact form", () => {
  expect(() => declaredUntestableResult(" ", {})).toThrow(/reason/)
  const helper = declaredUntestableResult("fixture reason", { state: 1 })
  expect(fold("alpha", helper)).toMatchObject({ status: "untestable", reason: "fixture reason" })
  const variants: NotTestedCoverageResult[] = [
    // An untestable test that is not the declared one.
    { ...helper, tests: [{ id: "review", status: "untestable", reason: "fixture reason" }] },
    // The declared test on another branch, or with no branch.
    { ...helper, criterionBranch: "os-input-review" },
    { ...helper, criterionBranch: undefined },
    // The declared test beside another test.
    { ...helper, tests: [...helper.tests!, { id: "extra", status: "untestable", reason: "x" }] },
  ]
  for (const variant of variants) {
    expect(isDeclaredUntestable(variant)).toBe(false)
    expect(fold("alpha", variant).status).toBe("probe-todo")
  }
  expect(isDeclaredUntestable({ criterionBranch: HEADLESS_OBSERVABLE_REVIEW, tests: [] })).toBe(false)
})
