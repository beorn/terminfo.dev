/**
 * @failure A silent CSI 18 t reply invents 24 rows and scrollback measures the wrong grid.
 * @level l1
 * @consumer App scrollback callback on a measured owned terminal.
 * @testonly none
 */
import { expect, test } from "vitest"
import { createHash } from "node:crypto"
import { scrollbackProbes, scrollbackReadbackRows } from "./scrollback.ts"
import { eraseProbes } from "./erase.ts"
import type { ObservationFrame, TermProbeSource, LibProbeSource, ProbeCallbackResult } from "./types.ts"
import { libProbeSource } from "./testing/group-harness.ts"
import { createSemanticSurface } from "./testing/semantic-surface.ts"

function headless(overrides: Partial<LibProbeSource> = {}): LibProbeSource {
  return {
    backendName: "scripted-model",
    kind: "live",
    cols: 61,
    feed() {},
    feedCapture: () => "",
    getCell: () => ({
      char: " ",
      bold: false,
      dim: false,
      italic: false,
      underline: false,
      strikethrough: false,
      inverse: false,
      hidden: false,
      blink: false,
      overline: false,
      fg: null,
      bg: null,
      wide: false,
    }),
    getCursor: () => ({ x: 0, y: 0, visible: true, style: null }),
    getMode: () => false,
    getText: () => "",
    getScrollback: () => ({ viewportOffset: 0, totalLines: 24, screenLines: 24 }),
    getTitle: () => "",
    reset() {},
    capabilities: {
      truecolor: false,
      kittyKeyboard: false,
      kittyGraphics: false,
      sixel: false,
      osc8Hyperlinks: false,
      semanticPrompts: false,
      reflow: false,
      unicode: "unknown",
      extensions: new Set(),
    },
    ...overrides,
  }
}

// Existing history tests exercise real counts, not the exact libvterm adapter's absent history API.
// This table owns identity qualification across the three callbacks; no numeric stub detection.
type WasmRuntime = Extract<NonNullable<LibProbeSource["runtimeIdentity"]>, { runtimeFormat: "wasm" }>
const historyRuntime: WasmRuntime = {
  kind: "js",
  runtimeFormat: "wasm",
  engineVersion: "0.3.3",
  adapterVersion: "0.10.2",
  termlessRevision: "f8d2aeb7a7a30f0215fd628bbbb1f1e5cd0a91be",
  adapterSources: [
    { path: "packages/libvterm/src/index.ts", blobOid: "2b4708b1081e701b99893ca055ded781dc46cf25" },
    { path: "packages/libvterm/src/backend.ts", blobOid: "eb513ccd443e30c7a869a8ba41f8126e1c0ddf00" },
    { path: "packages/libvterm/src/wasm-bindings.ts", blobOid: "2bbd4d5cf59b8d53db8f5c0329d2ed7853c43e45" },
    { path: "packages/libvterm/wasm/libvterm.js", blobOid: "1e784be87614ab924b96844009919b7c21ce150e" },
  ],
  resolvedPath: "vendor/termless/packages/libvterm/src/index.ts",
  integrity: {
    kind: "source",
    repository: "git@github.com:beorn/termless.git",
    revision: "f8d2aeb7a7a30f0215fd628bbbb1f1e5cd0a91be",
    treeOid: "ae0b11bb808b8c402c168869d7caa5a5f62566c2",
    cleanTree: true,
  },
  loadedBinary: {
    path: "vendor/termless/packages/libvterm/wasm/libvterm.wasm",
    sha256: "3d67045bb43c5e4081c70dc58088af8f735416c20df2d7843d765e5aad8ef62a",
  },
}
const sourceIntegrity = historyRuntime.integrity
if (sourceIntegrity.kind !== "source") throw new Error("History fixture needs source integrity")
// Actual 03:34 retained runtime: the current adapter still reports screen extent, not history.
const currentHistoryRuntime: WasmRuntime = {
  ...historyRuntime,
  termlessRevision: "2f73fc28027b7d483e504e08edc64d1837935816",
  integrity: {
    ...sourceIntegrity,
    revision: "2f73fc28027b7d483e504e08edc64d1837935816",
    treeOid: "000404fd8b8f8f0b1b968bf7398f8afc90958618",
  },
  adapterSources: [
    { path: "packages/libvterm/src/index.ts", blobOid: "2b4708b1081e701b99893ca055ded781dc46cf25" },
    { path: "packages/libvterm/src/backend.ts", blobOid: "f0431b2b3b1824d3028e7a039d55278d2cddc0e8" },
    { path: "packages/libvterm/src/wasm-bindings.ts", blobOid: "55ddc684464e525e63cd523d2d6a638c4c6dbcd9" },
    { path: "packages/libvterm/wasm/libvterm.js", blobOid: "d28bc97333d33129c7c9764a331a3d47f088f7b3" },
  ],
  loadedBinary: {
    ...historyRuntime.loadedBinary,
    sha256: "712298aff45c7c53a22dc028b13cb58dae1e984199b520bbbc0475ae64d83159",
  },
}
const historyIdentities: [string, LibProbeSource["runtimeIdentity"], boolean | "drift"][] = [
  ["qualified", historyRuntime, true],
  ["current qualified", currentHistoryRuntime, true],
  [
    "current wrong WASM",
    { ...currentHistoryRuntime, loadedBinary: { ...currentHistoryRuntime.loadedBinary, sha256: "f".repeat(64) } },
    "drift",
  ],
  [
    "current unknown adapter and wrong WASM",
    {
      ...currentHistoryRuntime,
      adapterSources: currentHistoryRuntime.adapterSources!.map((source) => ({ ...source, blobOid: "f".repeat(40) })),
      loadedBinary: { ...currentHistoryRuntime.loadedBinary, sha256: "f".repeat(64) },
    },
    false,
  ],
  [
    "same package at another commit",
    {
      ...historyRuntime,
      termlessRevision: "e".repeat(40),
      integrity: { ...sourceIntegrity, revision: "e".repeat(40) },
    },
    true,
  ],
  ...[
    ["wrong tree", {}, true],
    ["wrong tree and adapter", { adapterVersion: "0.10.3" }, false],
    ["wrong tree and WASM", { loadedBinary: { ...historyRuntime.loadedBinary, sha256: "f".repeat(64) } }, "drift"],
  ].map(
    ([name, overrides, eligible]) =>
      [
        name,
        { ...historyRuntime, ...(overrides as object), integrity: { ...sourceIntegrity, treeOid: "f".repeat(40) } },
        eligible,
      ] as [string, LibProbeSource["runtimeIdentity"], boolean | "drift"],
  ),
  [
    "wrong tree and dirty source",
    { ...historyRuntime, integrity: { ...sourceIntegrity, cleanTree: false, treeOid: "f".repeat(40) } },
    true,
  ],
  [
    "wrong WASM",
    { ...historyRuntime, loadedBinary: { ...historyRuntime.loadedBinary, sha256: "f".repeat(64) } },
    "drift",
  ],
  [
    "foreign entry with another tree",
    { ...historyRuntime, resolvedPath: "foreign/index.ts", integrity: { ...sourceIntegrity, treeOid: "f".repeat(40) } },
    true,
  ],
  ["dirty source", { ...historyRuntime, integrity: { ...sourceIntegrity, cleanTree: false } }, true],
  ["registry source", { ...historyRuntime, integrity: { kind: "registry", lockIntegrity: "sha512:fixture" } }, true],
  [
    "wrong repository",
    { ...historyRuntime, integrity: { ...sourceIntegrity, repository: "git@github.com:fixture/other.git" } },
    true,
  ],
  ["missing adapter blobs", { ...historyRuntime, adapterSources: undefined }, false],
  [
    "changed adapter blobs",
    {
      ...historyRuntime,
      adapterSources: historyRuntime.adapterSources!.map((source) => ({ ...source, blobOid: "f".repeat(40) })),
    },
    false,
  ],
  [
    "changed adapter blobs and WASM",
    {
      ...historyRuntime,
      adapterSources: historyRuntime.adapterSources!.map((source) => ({ ...source, blobOid: "f".repeat(40) })),
      loadedBinary: { ...historyRuntime.loadedBinary, sha256: "f".repeat(64) },
    },
    false,
  ],
  ["wrong engine version", { ...historyRuntime, engineVersion: "0.3.4" }, false],
  ["wrong adapter version", { ...historyRuntime, adapterVersion: "0.10.3" }, false],
  ["JavaScript format", { ...historyRuntime, runtimeFormat: "js" }, false],
  ["missing identity", undefined, false],
]
const historyCases = ["erase.screen.scrollback", "scrollback.accumulate", "scrollback.total-lines"].flatMap((id) =>
  historyIdentities.map(([name, runtimeIdentity, eligible]) => ({ id, name, runtimeIdentity, eligible })),
)
test.each(historyCases)("history count review qualifies $id: $name", ({ id, runtimeIdentity, eligible }) => {
  const definition = [...eraseProbes, ...scrollbackProbes].find((entry) => entry.id === id)
  if (!definition?.lib) throw new Error(`Missing ${id} library callback`)
  let calls = 0
  const result = definition.lib(
    headless({
      runtimeIdentity,
      feed: () => {
        calls++
      },
      getScrollback: () => {
        calls++
        return { totalLines: 24, screenLines: 24, viewportOffset: 0 }
      },
    }),
  )
  if (!eligible) {
    expect(result.notTested?.noObservable ?? "", id).not.toContain(
      "adapter exposes no retained scrollback history count",
    )
    expect(calls, id).toBeGreaterThan(0)
    return
  }
  // No source review grades this cell (#32246): the qualified adapter has no history reader, so it stays TEST TODO.
  expect(result, id).toMatchObject({
    notTested: {
      reason: "no-semantic-observable",
      noObservable: "libvterm v0.3.3 adapter exposes no retained scrollback history count",
    },
  })
  expect(result.criterionBranch, id).toBeUndefined()
  expect(result.tests, id).toBeUndefined()
  expect(result.observation, id).toBeUndefined()
  expect(result.assertions, id).toBeUndefined()
  expect(result.response, id).not.toContain("sourceCitation")
  expect(result.response, id).not.toContain("runtimeIdentity")
  expect(calls, id).toBe(0)
})

// These controls decide whether a viewport reading can grade support. Older scrollback
// tests cover parser regions/history, but never exercise viewport motion or output anchoring.
type ViewportFault =
  | "none"
  | "noop"
  | "constant"
  | "count"
  | "geometry"
  | "mixed"
  | "invalid"
  | "ignored"
  | "history"
  | "clipped"
  | "not-bottom"
  | "no-marker"
  | "restore"
  | "evicted"
function viewportSource(
  options: { sign?: number; outcomes?: readonly string[]; faults?: readonly ViewportFault[] } = {},
) {
  let phase = -1
  let state = { viewportOffset: 0, totalLines: 5, screenLines: 5 }
  let text = ""
  let target = false
  const writes: string[] = []
  const moves: number[] = []
  const reads: { target: boolean; bottom: boolean }[] = []
  let scrollbackReads = 0
  const fault = () => options.faults?.[phase] ?? "none"
  const source = headless({
    reset() {
      phase++
      state = { viewportOffset: 0, totalLines: 5, screenLines: 5 }
      text = ""
      target = false
    },
    feed(sequence) {
      writes.push(sequence)
      if (sequence.includes("\r\n") && !sequence.startsWith("\r\n") && !sequence.startsWith("\x1b[?2026h")) {
        if (fault() === "ignored") return
        text = sequence.split("\r\n").at(-1)!
        state.totalLines = fault() === "history" ? 5 : sequence.split("\r\n").length - (fault() === "clipped" ? 1 : 0)
        state.viewportOffset = state.totalLines - 5 - (fault() === "not-bottom" ? 1 : 0)
      } else if (sequence.includes("\r\n")) {
        target = true
        if (fault() !== "evicted") state.totalLines++
        text = fault() === "no-marker" ? "" : sequence.replace(/\x1b\[\?2026[hl]/g, "").slice(2)
        const outcome = options.outcomes?.[phase] ?? "hold"
        if (outcome === "snap") state.viewportOffset = state.totalLines - state.screenLines
        if (outcome === "bottom-relative") state.viewportOffset++
        if (outcome === "drift") state.viewportOffset--
      }
    },
    scrollViewport(delta) {
      moves.push(delta)
      if (!target) {
        if (fault() === "noop") return
        if (fault() === "count" || fault() === "mixed") state.totalLines++
        if (fault() === "geometry" || fault() === "mixed") state.screenLines++
        if (fault() === "count" || fault() === "geometry") return
        if (fault() === "mixed") {
          state.viewportOffset--
          return
        }
        if (fault() === "invalid") {
          state.viewportOffset = NaN
          return
        }
      } else if (fault() === "restore") return
      state.viewportOffset = Math.max(
        0,
        Math.min(state.totalLines - state.screenLines, state.viewportOffset - delta * (options.sign ?? 1)),
      )
    },
    getScrollback: () => {
      scrollbackReads++
      return {
        ...state,
        ...(fault() === "constant" && { viewportOffset: state.totalLines - state.screenLines }),
      }
    },
    getText() {
      const bottom = state.viewportOffset === state.totalLines - state.screenLines
      reads.push({ target, bottom })
      return bottom ? text : "history has no target marker"
    },
  })
  return {
    source,
    writes,
    moves,
    reads,
    scrollbackReads: () => scrollbackReads,
    phase: () => phase,
    state: () => state,
  }
}

function viewportProbe() {
  const found = scrollbackProbes.find((row) => row.id === "scrollback.viewport-hold-output")
  if (!found?.lib) throw new Error("Viewport hold needs a library callback")
  return found.lib
}

test.each([-1, 1])("viewport hold calibrates sign %s and reads target only after returning to bottom", (sign) => {
  const fixture = viewportSource({ sign })
  const result = viewportProbe()(fixture.source)
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  const evidence = JSON.parse(result.response!) as Record<string, unknown>
  expect(Object.keys(evidence).sort()).toEqual(["anchor", "baseline", "control", "ordinary", "synchronized"])
  expect(evidence).toMatchObject({ control: { ordinary: { sign } } })
  expect(fixture.moves.slice(0, sign === -1 ? 1 : 2)).toEqual(sign === -1 ? [-1] : [-1, 1])
  expect(fixture.reads.filter((read) => read.target)).toEqual([
    { target: true, bottom: true },
    { target: true, bottom: true },
  ])
  expect(fixture.writes).toContain("\x1b[?2026h\r\nviewport-synchronized\x1b[?2026l")
  expect(fixture.phase()).toBe(2)
  expect(fixture.state()).toEqual({ viewportOffset: 0, totalLines: 5, screenLines: 5 })
})

/**
 * @failure Two qualified phases that retain their distance from bottom are left inconclusive;
 *   a mixed or non-one-row drift can instead be misgraded as that controlled negative.
 * @level l1
 * @consumer Headless viewport-hold support and negative assertions.
 * @testonly none
 */
test.each([
  ["snap", "hold", "unsupported", "ordinary"],
  ["hold", "snap", "unsupported", "synchronized"],
  ["bottom-relative", "bottom-relative", "unsupported", "viewport kept its distance from bottom instead of its anchor"],
  ["bottom-relative", "hold", "inconclusive", "viewport"],
  ["hold", "bottom-relative", "inconclusive", "viewport"],
  ["bottom-relative", "snap", "inconclusive", "viewport"],
  ["snap", "bottom-relative", "inconclusive", "viewport"],
  ["bottom-relative", "drift", "inconclusive", "viewport"],
  ["drift", "bottom-relative", "inconclusive", "viewport"],
  ["drift", "hold", "inconclusive", "ordinary"],
  ["hold", "drift", "inconclusive", "synchronized"],
  ["drift", "snap", "inconclusive", "ordinary"],
  ["snap", "drift", "inconclusive", "synchronized"],
  ["drift", "drift", "inconclusive", "ordinary"],
] as const)("viewport %s then %s gives %s", (ordinary, synchronized, outcome, phase) => {
  const fixture = viewportSource({ outcomes: [ordinary, synchronized] })
  const result = viewportProbe()(fixture.source)
  expect(result.observation?.outcome).toBe(outcome)
  expect(result.note).toContain(phase)
  expect(result.assertions?.[0]?.kind).toBe(outcome === "unsupported" ? "negative" : undefined)
  if (outcome === "unsupported") expect(result.assertions?.[0]?.observed).toBe(result.response)
  if (ordinary === "bottom-relative" && synchronized === "bottom-relative") {
    expect(result.note).toBe("viewport kept its distance from bottom instead of its anchor")
    expect(JSON.parse(result.response!)).toMatchObject({
      ordinary: { outcome: "bottom-relative", markerObserved: true },
      synchronized: { outcome: "bottom-relative", markerObserved: true },
    })
  }
})

test.each([
  ["noop", "scrollback viewport state"],
  ["constant", "scrollback viewport state"],
  ["history", "scrollback history rows"],
  ["count", null],
  ["geometry", null],
  ["mixed", null],
  ["invalid", null],
  ["ignored", null],
  ["clipped", null],
  ["not-bottom", null],
  ["no-marker", null],
  ["restore", null],
  ["evicted", null],
] as const)("viewport %s cannot manufacture a support decision", (fault, coverage) => {
  const fixture = viewportSource({ faults: [fault, fault] })
  const result = viewportProbe()(fixture.source)
  if (coverage) expect(result.notTested?.noObservable).toBe(coverage)
  else expect(result.observation?.outcome).toBe("inconclusive")
  expect(result.assertions).toBeUndefined()
  if (fault === "ignored") expect(result.note).toContain("feed not observed")
  if (fault === "restore") expect(fixture.reads.some((read) => read.target)).toBe(false)
  expect(fixture.phase()).toBe(2)
})

test.each([
  [0, "snap"],
  [1, "snap"],
  [0, "bottom-relative"],
  [1, "bottom-relative"],
] as const)("a failed phase %s control prevents a %s verdict", (failedPhase, outcome) => {
  const fixture = viewportSource({
    outcomes: [outcome, outcome],
    faults: failedPhase === 0 ? ["count", "none"] : ["none", "count"],
  })
  const result = viewportProbe()(fixture.source)
  expect(result.observation?.outcome).toBe("inconclusive")
  expect(result.assertions).toBeUndefined()
})

/**
 * @failure A declared absence of the product viewport falls into generic missing-control coverage,
 *   loses the source-review identity/reason, or runs fake viewport phases through a contradictory actuator.
 * @level l1
 * @consumer Required independent headless-observable review for viewport-hold.
 * @testonly none
 */
test.each([true, false])(
  "viewport absence retains review evidence with runtime identity present=%s",
  (withIdentity) => {
    const fixture = viewportSource()
    delete fixture.source.scrollViewport
    const productViewport = { available: false as const, reason: "Fixture library exposes no product viewport" }
    fixture.source.capabilities.productViewport = productViewport
    const runtimeIdentity: LibProbeSource["runtimeIdentity"] = {
      kind: "js",
      runtimeFormat: "js",
      resolvedPath: "/fixtures/viewport-engine.js",
      engineVersion: "fixture",
      adapterVersion: "fixture",
      termlessRevision: "fixture-revision",
      integrity: { kind: "registry", lockIntegrity: "sha512:fixture" },
    }
    const result = viewportProbe()({ ...fixture.source, ...(withIdentity ? { runtimeIdentity } : {}) })
    expect(result).toMatchObject({
      criterionBranch: "headless-observable-review",
      notTested: { noObservable: "scrollback viewport scroll control" },
      tests: [{ id: "review", status: "test-todo", reason: productViewport.reason }],
    })
    expect(result.observation).toBeUndefined()
    expect(result.assertions).toBeUndefined()
    expect(JSON.parse(result.response!)).toEqual({
      productViewport,
      baseline: {},
      anchor: {},
      control: {},
      ordinary: {},
      synchronized: {},
    })
    expect(fixture.writes).toEqual([])
    expect(fixture.moves).toEqual([])
    expect(fixture.reads).toEqual([])
    expect(fixture.scrollbackReads()).toBe(0)
    expect(fixture.phase()).toBe(-1)
  },
)

test("viewport declared absent with a present actuator is an inconclusive apparatus contradiction", () => {
  const fixture = viewportSource()
  fixture.source.capabilities.productViewport = {
    available: false,
    reason: "Fixture library exposes no product viewport",
  }
  const result = viewportProbe()(fixture.source)
  expect(result.observation?.outcome).toBe("inconclusive")
  expect(result.note).toMatch(/declared absent.*scroll control.*present/)
  expect(result.criterionBranch).toBeUndefined()
  expect(result.notTested).toBeUndefined()
  expect(result.assertions).toBeUndefined()
  expect(JSON.parse(result.response!)).toMatchObject({
    productViewport: fixture.source.capabilities.productViewport,
    ordinary: {},
    synchronized: {},
  })
  expect(fixture.writes).toEqual([])
  expect(fixture.moves).toEqual([])
  expect(fixture.reads).toEqual([])
  expect(fixture.scrollbackReads()).toBe(0)
  expect(fixture.phase()).toBe(-1)
})

test("viewport absent actuator stays named coverage; operational and cleanup errors survive", () => {
  const fixture = viewportSource()
  delete fixture.source.scrollViewport
  expect(viewportProbe()(fixture.source).notTested?.noObservable).toBe("scrollback viewport scroll control")
  expect(fixture.writes).toEqual([])
  expect(fixture.phase()).toBe(-1)
  const primary = new Error("feed adapter failed")
  const cleanup = new Error("reset adapter failed")
  for (const [failFeed, failCleanup] of [
    [true, false],
    [false, true],
    [true, true],
  ]) {
    const disposable = viewportSource()
    const reset = disposable.source.reset.bind(disposable.source)
    let resets = 0
    disposable.source.reset = () => {
      if (++resets === (failFeed ? 2 : 3) && failCleanup) throw cleanup
      reset()
    }
    if (failFeed) {
      disposable.source.feed = () => {
        throw primary
      }
    }
    let caught: unknown
    try {
      viewportProbe()(disposable.source)
    } catch (error) {
      caught = error
    }
    if (failFeed && failCleanup) {
      expect(caught).toBeInstanceOf(AggregateError)
      expect((caught as AggregateError).errors).toEqual([primary, cleanup])
    } else expect(caught).toBe(failFeed ? primary : cleanup)
  }
})

/**
 * @failure RI/SD is reported supported when a blank top row comes from losing the seeded rows.
 * @level l0
 * @consumer Headless Scrollback observations used by the support tables.
 * @testonly none
 */
/**
 * A headless surface whose screen is exactly the grid a test declares for each sequence the probe
 * feeds: a sequence the test does not name leaves the grid unchanged, which is how a test says "this
 * terminal ignored that operation". The declared grid is the terminal's own behaviour, so a row reads
 * supported only when its frame agrees with a terminal the test drove independently.
 */
function declaredScreen(screens: Record<string, readonly (readonly string[])[]>, cols = 61): LibProbeSource {
  let cells: readonly (readonly string[])[] = []
  return headless({
    cols,
    feed: (sequence) => {
      const next = screens[sequence]
      if (next !== undefined) cells = next
    },
    getCell: (row, col) => ({ char: cells[row]?.[col] ?? " " }) as ReturnType<LibProbeSource["getCell"]>,
  })
}

const readbackRow = (id: string) => {
  const row = scrollbackReadbackRows.find((entry) => entry.id === id)
  if (!row) throw new Error(`missing scrollback readback row for ${id}`)
  return row
}

test.each([
  ["scrollback.reverse-index", "\x1bM", [["A"], ["B"], ["C"]], [[""], ["A"], ["B"]]],
  [
    "scrollback.scroll-down",
    "\x1b[T",
    [
      ["L", "I", "N", "E", "1"],
      ["L", "I", "N", "E", "2"],
      ["L", "I", "N", "E", "3"],
      ["", "", "", "", ""],
    ],
    [
      ["", "", "", "", ""],
      ["L", "I", "N", "E", "1"],
      ["L", "I", "N", "E", "2"],
      ["L", "I", "N", "E", "3"],
    ],
  ],
] as const)(
  "%s inserts a blank measured row only when the operation moves every marker",
  (id, operation, before, after) => {
    const probe = scrollbackProbes.find((item) => item.id === id)
    if (!probe?.lib) throw new Error(`Missing ${id} headless callback`)
    const row = readbackRow(id)
    // The blank row the operation inserts must come from the operation, never from losing a marker: a
    // marker lost inside the compared grid is a different screen, which reads unsupported, not support.
    const lostMarker = after.map((cells, index) => (index === 1 ? cells.map(() => "?") : cells))
    const lostLastMarker = after.map((cells, index) => (index === after.length - 1 ? cells.map(() => "?") : cells))
    for (const [effect, screens, outcome] of [
      ["shift", { [row.seed]: before, [operation]: after }, "supported"],
      ["no-op", { [row.seed]: before }, "unsupported"],
      ["lost-marker", { [row.seed]: before, [operation]: lostMarker }, "unsupported"],
      ["lost-last-marker", { [row.seed]: before, [operation]: lostLastMarker }, "unsupported"],
      ["missing-seed", { [row.seed]: before.map((cells) => cells.map(() => "?")) }, "inconclusive"],
    ] as const) {
      const result = probe.lib(declaredScreen(screens, 5))
      expect(result.observation, effect).toMatchObject({ outcome, assertionType: "buffer_state" })
      if (outcome === "inconclusive") expect(result.assertions, effect).toBeUndefined()
      else {
        expect(result.assertions, effect).toMatchObject([{ kind: outcome === "supported" ? "positive" : "negative" }])
      }
    }
  },
)

test("accumulate uses measured rows and does not infer 24 after CSI silence", async () => {
  const probe = scrollbackProbes.find((entry) => entry.id === "scrollback.accumulate")
  if (!probe?.term) throw new Error("missing scrollback.accumulate app callback")
  expect(probe.termNeedsGeometry).toBe(true)
  const writes: string[] = []
  const queries: string[] = []
  const context: TermProbeSource = {
    kind: "live",
    rows: 37,
    cols: 61,
    write: (s) => writes.push(s),
    queryCursorPosition: async () => ({ row: 37, col: 1 }),
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
    query: async () => null,
    queryWithSentinel: async (s) => {
      queries.push(s)
      return null
    },
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
  }
  await probe.term(context)
  expect(queries).toEqual([])
  expect(writes.filter((s) => s.startsWith("line-"))).toHaveLength(47)
})

function silentAppSource(rows: number, cols: number): { context: TermProbeSource; writes: string[] } {
  const writes: string[] = []
  const context: TermProbeSource = {
    kind: "live",
    rows,
    cols,
    write: (sequence) => writes.push(sequence),
    queryCursorPosition: async () => ({ row: 5, col: 5 }),
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
  }
  return { context, writes }
}

test("cursor replies do not qualify app scrollback contents or region behavior", async () => {
  // The two model probes have no capture path, so a cursor reply is the only reading they reach.
  for (const id of ["scrollback.accumulate", "scrollback.total-lines"]) {
    const definition = scrollbackProbes.find((item) => item.id === id)
    if (!definition?.term) throw new Error(`Missing ${id} app callback`)
    const result = await definition.term(silentAppSource(12, 61).context)
    expect(result.observation, id).toMatchObject({
      outcome: "inconclusive",
      assertionType: "query_reply",
      reason: "insufficient-evidence",
    })
    expect(result.assertions ?? [], id).toEqual([])
    expect(result.response, id).toBeTruthy()
    expect(result.tests, id).toContainEqual(
      expect.objectContaining({
        id: "review",
        status: "test-todo",
        reason: expect.stringContaining("does not measure"),
      }),
    )
  }

  // A region row is graded from the window it cannot read, never from a cursor reply: with no owned
  // capture it refuses BY NAME and writes nothing at all.
  for (const id of [
    "scrollback.scroll-up",
    "scrollback.reverse-index",
    "scrollback.scroll-down",
    "scrollback.set-region",
    "scrollback.alt-screen",
    "scrollback.decstbm",
    "scrollback.decstbm-reset",
  ]) {
    const definition = scrollbackProbes.find((item) => item.id === id)
    if (!definition?.term) throw new Error(`Missing ${id} app callback`)
    let queried = false
    const { context, writes } = silentAppSource(12, 61)
    const result = await definition.term({
      ...context,
      queryCursorPosition: async () => {
        queried = true
        return { row: 5, col: 5 }
      },
    })
    expect(result.observation, id).toBeUndefined()
    expect(result, id).toMatchObject({
      tests: [
        expect.objectContaining({
          status: "test-todo",
          reason: `${id}: no owned capture adapter is installed in this run, so the region fixture cannot be read back`,
        }),
      ],
    })
    expect(String(result.tests?.[0]?.reason), id).toContain("no owned capture adapter")
    expect(result.assertions ?? [], id).toEqual([])
    expect(queried, id).toBe(false)
    expect(writes, id).toEqual([])
  }
})

test("DECSTBM reset declines a grid below its measured minimum before writing", async () => {
  const probe = scrollbackProbes.find((entry) => entry.id === "scrollback.decstbm-reset")
  if (!probe?.term) throw new Error("missing scrollback.decstbm-reset app callback")
  // This row's cursor sits on row 6 and its sentinel on row 8, so the derived minimum is 8 rows by 3
  // columns (the region's right edge plus the family margin). A 7-row or a 2-column grid cannot carry
  // the fixture; both refuse before a byte, which is what keeps a `none` observation zero-byte.
  for (const geometry of [
    { rows: 7, cols: 61 },
    { rows: 12, cols: 2 },
  ]) {
    const app = captureApp(geometry.rows, geometry.cols)
    const result = await probe.term(app.context)
    expect(result.observation, `${geometry.rows}x${geometry.cols}`).toBeUndefined()
    expect(result, `${geometry.rows}x${geometry.cols}`).toMatchObject({
      tests: [
        expect.objectContaining({
          status: "test-todo",
          reason: expect.stringMatching(
            /(?:capture-region readback needs a measured grid of at least|Scrollback fixture needs at least)/,
          ),
        }),
      ],
    })
    expect(app.writes, `${geometry.rows}x${geometry.cols}`).toEqual([])
  }
  // A grid taller than 999 rows is a legitimate grid: it is never refused for its size, so the row
  // reaches the pixel report instead of a geometry refusal.
  const tall = captureApp(1200, 61)
  const tallResult = await probe.term(tall.context)
  expect(tallResult.observation).toBeUndefined()
  expect(tallResult.tests).toMatchObject([
    { id: "criterion", status: "test-failure", reason: expect.stringContaining("cell size in pixels") },
  ])
  expect(String(tallResult.tests?.[0]?.reason), "1200 rows").toContain("cell size in pixels")
  expect(tall.writes, "1200 rows").toEqual([])
})

test("remaining scrollback fixtures decline too-small geometry before writing", async () => {
  for (const id of [
    "scrollback.total-lines",
    "scrollback.scroll-up",
    "scrollback.reverse-index",
    "scrollback.scroll-down",
    "scrollback.set-region",
    "scrollback.alt-screen",
    "scrollback.decstbm",
  ]) {
    const probe = scrollbackProbes.find((item) => item.id === id)
    if (!probe?.term) throw new Error(`Missing ${id} app callback`)
    const writes: string[] = []
    const context: TermProbeSource = {
      kind: "live",
      rows: 1,
      cols: 1,
      capture: async () => {
        throw new Error(`${id} captured before size guard`)
      },
      write: (sequence) => writes.push(sequence),
      queryCursorPosition: async () => {
        throw new Error(`${id} queried before size guard`)
      },
      measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
      query: async () => null,
      queryWithSentinel: async () => null,
      queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
      queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
      queryMode: async () => null,
    }
    expect(probe.termNeedsGeometry, id).toBe(true)
    const result = await probe.term(context)
    expect(result.observation, id).toBeUndefined()
    expect(result, id).toMatchObject({
      tests: [
        expect.objectContaining({
          status: "test-todo",
          reason: expect.stringMatching(
            /(?:capture-region readback needs a measured grid of at least|Scrollback fixture needs at least)/,
          ),
        }),
      ],
    })
    expect(writes, id).toEqual([])
  }
})

test.each(["scrollback.accumulate", "scrollback.total-lines"] as const)(
  "%s leaves unchanged history count untested without a same-path control",
  (id) => {
    const probe = scrollbackProbes.find((item) => item.id === id)
    if (!probe?.lib) throw new Error(`Missing ${id} headless callback`)
    const result = probe.lib(
      headless({
        getScrollback: () => ({ viewportOffset: 0, totalLines: 37, screenLines: 37 }),
      }),
    )
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(result.notTested).toEqual({
      reason: "no-semantic-observable",
      noObservable:
        "retained history count did not change after the overflow lines; no same-path control shows this reader counts history",
    })
    expect(result.assertions).toBeUndefined()
  },
)

test.each([
  ["scrollback.total-lines", 9, false],
  ["scrollback.total-lines", 10, true],
  ["scrollback.accumulate", 9, true],
] as const)("%s with %i new history lines meets its own growth claim: %s", (id, growth, expected) => {
  const probe = scrollbackProbes.find((item) => item.id === id)
  if (!probe?.lib) throw new Error(`Missing ${id} headless callback`)
  let readings = 0
  const result = probe.lib(
    headless({
      getScrollback: () => ({
        viewportOffset: 0,
        totalLines: 37 + (readings++ === 0 ? 0 : growth),
        screenLines: 37,
      }),
    }),
  )
  expect(result.pass).toBe(expected)
  expect(result.observation?.outcome).toBe(expected ? "supported" : "unsupported")
})

test("headless scrollback uses initialized screenLines rather than a 24-row assumption", () => {
  const screenLines = 37
  for (const [id, expectedFeeds] of [
    ["scrollback.accumulate", screenLines + 10],
    ["scrollback.total-lines", screenLines + 10],
  ] as const) {
    const probe = scrollbackProbes.find((item) => item.id === id)
    if (!probe?.lib) throw new Error(`Missing ${id} headless callback`)
    const feeds: string[] = []
    probe.lib(
      headless({
        feed: (sequence) => feeds.push(sequence),
        getScrollback: () => ({ viewportOffset: 0, totalLines: 47, screenLines }),
      }),
    )
    expect(
      feeds.filter((s) => s.startsWith("line ") || s.startsWith("total-")),
      id,
    ).toHaveLength(expectedFeeds)
  }
  const reset = scrollbackProbes.find((item) => item.id === "scrollback.decstbm-reset")
  if (!reset?.lib) throw new Error("Missing decstbm-reset headless callback")
  const result = reset.lib(
    headless({
      feed() {},
      getScrollback: () => ({ viewportOffset: 0, totalLines: 30, screenLines }),
    }),
  )
  expect(result.pass).toBe(false)
})

/**
 * @failure A region row that leaves its mode set on a failed capture run hands it to the next probe,
 *   which then grades a terminal it never configured.
 * @level l1
 * @consumer the capture-region readback shared by every region-readback family
 * @testonly none
 */
test.each([
  ["scrollback.scroll-up", "\x1b[r"],
  ["scrollback.set-region", "\x1b[r"],
  ["scrollback.decstbm", "\x1b[r"],
  ["scrollback.decstbm-reset", "\x1b[r"],
  ["scrollback.alt-screen", "\x1b[?1049l"],
] as const)("%s writes its own cleanup when the capture run fails mid-sequence", async (id, cleanup) => {
  const probe = scrollbackProbes.find((item) => item.id === id)
  const term = probe?.term
  if (!term) throw new Error(`Missing ${id} app callback`)
  const { context } = regionReadbackApp(14, 61)
  const capture = context.capture
  if (!capture) throw new Error(`${id}: the capture app fixture carries no adapter`)
  const writes: string[] = []
  let captures = 0
  await expect(
    term({
      ...context,
      write: (bytes) => {
        writes.push(bytes)
        context.write(bytes)
      },
      capture: async (request) => {
        captures++
        if (captures === 3) throw new Error("capture transport failed")
        return capture(request)
      },
    }),
  ).rejects.toThrow("capture transport failed")
  // The seed frame is already painted when the third capture fails, so the row's own cleanup must
  // land — exactly once — before the oracle's own DECTCEM and screen reset.
  expect(
    writes.filter((bytes) => bytes === cleanup),
    id,
  ).toHaveLength(1)
  expect(writes.indexOf(cleanup), id).toBeGreaterThan(1)
  expect(writes.at(-1), id).toBe("\x1b[0m\x1b[2J\x1b[H")
})

test("invalid headless geometry retains named coverage and cleanup", async () => {
  // The two model probes read `getScrollback().screenLines`; a count that is not a safe integer is
  // not a measured grid, so they refuse without feeding a byte.
  for (const id of ["scrollback.accumulate", "scrollback.total-lines"]) {
    const probe = scrollbackProbes.find((item) => item.id === id)
    if (!probe?.lib) throw new Error(`Missing ${id} headless callback`)
    for (const screenLines of [Number.NaN, Number.POSITIVE_INFINITY, 37.5]) {
      const feeds: string[] = []
      const result = probe.lib(
        headless({
          feed: (sequence) => feeds.push(sequence),
          getScrollback: () => ({ viewportOffset: 0, totalLines: 0, screenLines }),
        }),
      )
      expect(result.observation, `${id} rows=${screenLines}`).toBeUndefined()
      expect(result, `${id} rows=${screenLines}`).toMatchObject({
        tests: [expect.objectContaining({ status: "test-todo", reason: "insufficient-evidence" })],
      })
      expect(feeds).toEqual([])
    }
  }
  // A grid narrower than the compared region cannot carry the fixture; refuse before writes.
  for (const id of ["scrollback.scroll-up", "scrollback.scroll-down", "scrollback.decstbm-reset"]) {
    const probe = scrollbackProbes.find((item) => item.id === id)
    if (!probe?.lib) throw new Error(`Missing ${id} headless callback`)
    const columns = readbackRow(id).before[0]?.length ?? 0
    const feeds: string[] = []
    const result = probe.lib(headless({ cols: columns - 1, feed: (sequence) => feeds.push(sequence) }))
    expect(result.observation, `${id} cols=${columns - 1}`).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      // The parser arm reports the geometry it measured, so its refusal is a parser-state reading and
      // not the zero-byte `none` shape the capture arm answers with.
      assertionType: "buffer_state",
    })
    expect(feeds, `${id} cols=${columns - 1}`).toEqual([])
  }
  const reset = scrollbackProbes.find((item) => item.id === "scrollback.decstbm-reset")
  if (!reset?.lib) throw new Error("Missing DECSTBM reset library callback")
  // Bad extents cannot select an absolute row, including when the edit changes the reported geometry.
  for (const invalid of [
    { screenLines: Number.NaN, totalLines: 24 },
    { screenLines: 1, totalLines: 24 },
    { screenLines: 24, totalLines: 23 },
    { screenLines: 24, totalLines: Number.POSITIVE_INFINITY },
    { screenLines: 24, totalLines: 24.5 },
  ]) {
    for (const phase of ["seed", "after"] as const) {
      const feeds: string[] = []
      let reads = 0
      const result = reset.lib(
        headless({
          feed: (sequence) => feeds.push(sequence),
          getCell: (row) => ({ char: row === 0 ? "A" : "" }) as ReturnType<LibProbeSource["getCell"]>,
          getScrollback: () => ({
            viewportOffset: 0,
            ...(phase === "seed" || reads++ > 0 ? invalid : { screenLines: 24, totalLines: 24 }),
          }),
        }),
      )
      expect(result.observation, `${phase}: ${JSON.stringify(invalid)}`).toMatchObject({
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        note: expect.stringContaining("coherent retained-buffer extents"),
      })
      expect(result.assertions).toBeUndefined()
      expect(feeds.at(-1)).toBe("\x1b[r")
    }
  }
  const decstbm = scrollbackProbes.find((item) => item.id === "scrollback.decstbm")
  if (!decstbm?.term) throw new Error("Missing scrollback.decstbm app callback")
  const { context, writes } = silentAppSource(12, 1)
  const result = await decstbm.term({
    ...context,
    capture: async () => {
      throw new Error("DECSTBM captured before size guard")
    },
  })
  expect(result.observation).toBeUndefined()
  expect(result).toMatchObject({
    tests: [
      expect.objectContaining({
        status: "test-todo",
        reason: "scrollback.decstbm: capture-region readback needs a measured grid of at least 8x3; measured 12x1",
      }),
    ],
  })
  expect(writes).toEqual([])
})

test.each([
  ["shift", [["A"], ["C"], ["D"], [""], ["E"]], "supported"],
  // The region is set but never used: the screen the sequence leaves is the seed frame.
  ["no-op", [["A"], ["B"], ["C"], ["D"], ["E"]], "unsupported"],
  // A cell the claim does not name moved, so the frame is a different screen, not a working SU.
  ["unexpected", [["A"], ["C"], ["?"], [""], ["E"]], "unsupported"],
  // The row's own controls are the cells the scroll must leave alone. A terminal that scrolls them
  // too cannot be read as a working SU at all, so the row declines instead of grading the rest.
  ["moved-control", [["E"], ["C"], ["D"], [""], ["E"]], "inconclusive"],
  // The seed frame was not measured, so nothing about the sequence can be attributed to it.
  ["missing-seed", [["?"], ["B"], ["C"], ["D"], ["E"]], "inconclusive"],
] as const)(
  "interior-region SU grades measured movement, a no-op, and invalid controls (%s)",
  (effect, after, outcome) => {
    const probe = scrollbackProbes.find((item) => item.id === "scrollback.scroll-up")
    if (!probe?.lib) throw new Error("missing scroll-up callback")
    const row = readbackRow("scrollback.scroll-up")
    const before = [["A"], ["B"], ["C"], ["D"], ["E"]]
    const feeds: string[] = []
    const surface = declaredScreen({ [row.seed]: effect === "missing-seed" ? after : before, "\x1b[S": after }, 4)
    const result = probe.lib({
      ...surface,
      feed: (sequence) => {
        feeds.push(sequence)
        surface.feed(sequence)
      },
    })
    expect(result.observation, effect).toMatchObject({ outcome, assertionType: "buffer_state" })
    // The fixture never scrolls by writing a line feed: the screen the row compares is the sequence's own.
    expect(
      feeds.some((sequence) => sequence.includes("\n")),
      effect,
    ).toBe(false)
    expect(feeds.at(-1), effect).toBe("\x1b[r")
    if (outcome === "inconclusive") expect(result.assertions, effect).toBeUndefined()
    else expect(result.assertions, effect).toMatchObject([{ kind: outcome === "supported" ? "positive" : "negative" }])
  },
)

test("interior-region SU reads the compared cells, never the scrollback model", () => {
  const probe = scrollbackProbes.find((item) => item.id === "scrollback.scroll-up")
  if (!probe?.lib) throw new Error("missing scroll-up callback")
  const row = readbackRow("scrollback.scroll-up")
  const after = [["A"], ["C"], ["D"], [""], ["E"]]
  const surface = declaredScreen({ [row.seed]: [["A"], ["B"], ["C"], ["D"], ["E"]], "\x1b[S": after }, 4)
  const result = probe.lib({
    ...surface,
    // A surface with history already behind the viewport still scrolls the screen the row compares.
    getScrollback: () => ({ viewportOffset: 3, totalLines: 999, screenLines: 5 }),
    getCell: (absoluteRow, col) => surface.getCell(absoluteRow - 994, col),
  })
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
})

test("DECSTBM needs an inner-row movement control, not just a surviving top row", () => {
  const probe = scrollbackProbes.find((item) => item.id === "scrollback.decstbm")
  if (!probe?.lib) throw new Error("missing decstbm callback")
  const result = probe.lib(
    headless({
      getCell: (row) => ({ char: row === 0 ? "F" : "I" }) as ReturnType<LibProbeSource["getCell"]>,
    }),
  )
  expect(result.observation).toMatchObject({ outcome: "inconclusive", assertionType: "buffer_state" })
  expect(result.assertions).toBeUndefined()
})

test("DECSTBM retains support only when the region's inner rows actually move", () => {
  const probe = scrollbackProbes.find((item) => item.id === "scrollback.decstbm")
  if (!probe?.lib) throw new Error("missing decstbm callback")
  const row = readbackRow("scrollback.decstbm")
  const before = [["F"], ["S"], ["A"], ["B"], ["C"]]
  const after = [["F"], ["S"], ["B"], ["C"], [""]]
  // FIXED on row 1 is the row's control and survives either way, so a row that graded the control
  // alone would read supported on a surface that scrolled nothing. The inner rows are the claim.
  const still = probe.lib(declaredScreen({ [row.seed]: before }))
  expect(still.observation).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
  expect(still.assertions).toMatchObject([{ kind: "negative" }])
  const moved = probe.lib(declaredScreen({ [row.seed]: before, "\n": after }))
  expect(moved.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  expect(moved.assertions).toMatchObject([{ kind: "positive", observed: moved.response }])
})

test("DECSTBM reset is graded from the region readback, never from scrollback growth", () => {
  const probe = scrollbackProbes.find((item) => item.id === "scrollback.decstbm-reset")
  if (!probe?.lib) throw new Error("missing decstbm-reset callback")
  const row = readbackRow("scrollback.decstbm-reset")
  // History count is not readable from the screen, so no growth figure can decide this row: a surface
  // that leaves the compared rows where they were is a measured negative, however much history it
  // claims to have grown.
  const surface = declaredScreen({ [row.seed]: [["A"], [""]] })
  let history = 987
  let scrolls = 0
  const result = probe.lib({
    ...surface,
    feed: (sequence) => {
      surface.feed(sequence)
      if (sequence === "\x1b[S" && ++scrolls === 2) history++
    },
    getScrollback: () => ({ viewportOffset: 0, screenLines: 12, totalLines: history + 12 }),
    getCell: (absoluteRow, col) => surface.getCell(absoluteRow - history, col),
  })
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
  expect(result.assertions).toMatchObject([{ kind: "negative" }])
  expect(JSON.parse(result.response ?? "null")).toMatchObject({ before: [["A"], [""]], after: [["A"], [""]] })
})

function captureApp(rows: number, cols: number) {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const context: TermProbeSource = {
    kind: "live",
    rows,
    cols,
    write: (bytes) => writes.push(bytes),
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
    capture: async ({ role, label }) => {
      const frame = {
        role,
        label,
        capturedAt: frames.length + 1,
        ref: `sha256:${String(frames.length + 1).repeat(64)}`,
      }
      frames.push(frame)
      return frame
    },
  }
  return { context, writes, frames }
}

const findScrollback = (id: string) => {
  const definition = scrollbackProbes.find((probe) => probe.id === id)
  if (!definition?.term) throw new Error(`missing app scrollback callback for ${id}`)
  return definition
}

test("scrollback capture fixtures record control and target frames with honest, bounded claims", async () => {
  const accumulate = findScrollback("scrollback.accumulate")
  const small = captureApp(2, 61)
  const tooSmall = await accumulate.term!(small.context)
  expect(tooSmall.observation).toBeUndefined()
  expect(tooSmall).toMatchObject({
    tests: [
      expect.objectContaining({
        status: "test-todo",
        reason: expect.stringMatching(
          /(?:capture-region readback needs a measured grid of at least|Scrollback fixture needs at least)/,
        ),
      }),
    ],
  })
  expect(small.writes).toEqual([])
  const accumulated = captureApp(3, 61)
  const accumulateResult = await accumulate.term!(accumulated.context)
  expect(accumulated.frames.map(({ role }) => role)).toEqual(["control", "target"])
  expect(accumulated.writes.some((write) => write === "\x1b[2;1H")).toBe(true)
  expect(accumulated.writes.includes("\x1b[H")).toBe(false)
  expect(JSON.stringify(accumulateResult.observation?.note)).not.toContain("entered scrollback")

  const total = findScrollback("scrollback.total-lines")
  const totals = captureApp(5, 61)
  const totalResult = await total.term!(totals.context)
  expect(totals.frames).toHaveLength(2)
  expect(String(totalResult.observation?.note)).not.toContain("grew")

  const alt = findScrollback("scrollback.alt-screen")
  const alts = captureApp(4, 61)
  // alt-screen now judges through the region-readback oracle, so a surface that cannot report its own
  // pixels takes the oracle's named geometry refusal instead of ungraded control/target frames.
  const altResult = await alt.term!(alts.context)
  expect(altResult.observation).toBeUndefined()
  expect(altResult.tests).toMatchObject([
    { id: "criterion", status: "test-failure", reason: expect.stringContaining("cell size in pixels") },
  ])
  expect(String(altResult.tests?.[0]?.reason)).toContain("cell size in pixels")
  expect(alts.frames).toEqual([])

  const decstbm = findScrollback("scrollback.decstbm")
  const decstbms = captureApp(12, 61)
  // decstbm now judges through the region-readback oracle, so a surface that cannot report its own
  // pixels takes the oracle's named geometry refusal instead of ungraded control/target frames.
  const decstbmResult = await decstbm.term!(decstbms.context)
  expect(decstbmResult.observation).toBeUndefined()
  expect(decstbmResult.tests).toMatchObject([
    { id: "criterion", status: "test-failure", reason: expect.stringContaining("cell size in pixels") },
  ])
  expect(String(decstbmResult.tests?.[0]?.reason)).toContain("cell size in pixels")
  expect(decstbms.frames).toEqual([])

  const reset = findScrollback("scrollback.decstbm-reset")
  // The row's minimum now DERIVES (cursor row 6, sentinel row 8) instead of being hand-picked, so a
  // 7-row grid cannot carry the row-2 witness on row 6 and the run refuses BY NAME before a byte.
  const short = captureApp(7, 61)
  const shortResult = await reset.term!(short.context)
  expect(shortResult.observation).toBeUndefined()
  expect(shortResult).toMatchObject({
    tests: [
      expect.objectContaining({
        status: "test-todo",
        reason: expect.stringMatching(
          /(?:capture-region readback needs a measured grid of at least|Scrollback fixture needs at least)/,
        ),
      }),
    ],
  })
  expect(String(shortResult.tests?.[0]?.reason)).toContain("at least 8x3")
  expect(short.writes).toEqual([])
  const resets = captureApp(12, 61)
  // decstbm-reset likewise judges through the region-readback oracle now.
  const resetResult = await reset.term!(resets.context)
  expect(resetResult.observation).toBeUndefined()
  expect(resetResult.tests).toMatchObject([
    { id: "criterion", status: "test-failure", reason: expect.stringContaining("cell size in pixels") },
  ])
  expect(String(resetResult.tests?.[0]?.reason)).toContain("cell size in pixels")
  expect(resets.frames).toEqual([])

  const setRegion = findScrollback("scrollback.set-region")
  // The derived minimum is 12 rows (cursor row 11, sentinel row 12) by 3 columns (region right 1 plus
  // the family's two-column margin), so a 1-column grid is refused before a byte.
  const setSmall = captureApp(12, 1)
  const setSmallResult = await setRegion.term!(setSmall.context)
  expect(setSmallResult.observation).toBeUndefined()
  expect(setSmallResult).toMatchObject({
    tests: [
      expect.objectContaining({
        status: "test-todo",
        reason: expect.stringMatching(
          /(?:capture-region readback needs a measured grid of at least|Scrollback fixture needs at least)/,
        ),
      }),
    ],
  })
  expect(String(setSmallResult.tests?.[0]?.reason)).toContain("at least 12x3")
  expect(setSmall.writes).toEqual([])
})

/**
 * @failure A Scrollback row the group cannot decide reads inconclusive from a surface that really
 *   implements the operation its claim names, so a probe gap is reported as terminal undecidability.
 * @level l1
 * @consumer 28459 denominator correction (2026-10-10); the three ids @chief moved into the denominator.
 * @testonly none
 */
test.each(["scrollback.set-region", "scrollback.alt-screen", "scrollback.decstbm-reset"] as const)(
  "%s decides supported against a surface that really implements its claim",
  (id) => {
    const probe = scrollbackProbes.find((item) => item.id === id)
    if (!probe?.lib) throw new Error(`Missing ${id} headless callback`)
    const result = probe.lib(libProbeSource(createSemanticSurface()))
    expect(result.observation?.outcome, id).toBe("supported")
    // A decided row carries its assertion, never a bare outcome.
    expect(result.assertions ?? [], id).not.toEqual([])
  },
)

test.each([
  ["scrollback.set-region", "scrollregion-noop"],
  ["scrollback.decstbm-reset", "scrollregion-noop"],
  ["scrollback.alt-screen", "altscreen-noop"],
] as const)("%s reads unsupported when the surface ignores exactly that operation", (id, mutation) => {
  const probe = scrollbackProbes.find((item) => item.id === id)
  if (!probe?.lib) throw new Error(`Missing ${id} headless callback`)
  const result = probe.lib(libProbeSource(createSemanticSurface({ mutations: [mutation] })))
  expect(result.observation?.outcome, `${id} under ${mutation}`).toBe("unsupported")
})

const digest = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`

// A region beginning one or more rows too high must move a nonblank adjacent control.
// The older ignored-region controls leave that row blank and miss this narrower fault.
test.each([
  ["scrollback.set-region", "\x1b[5;10r", "\x1b[2;10r", 3],
  ["scrollback.decstbm", "\x1b[3;6r", "\x1b[2;6r", 1],
] as const)("%s witnesses the exact region top in both callback arms", async (id, requested, wrong, adjacent) => {
  const definition = findScrollback(id)
  for (const replace of [false, true]) {
    const surface = createSemanticSurface()
    const ctx = libProbeSource(surface)
    const feed = ctx.feed.bind(ctx)
    ctx.feed = (bytes) => feed(replace ? bytes.replaceAll(requested, wrong) : bytes)
    const lib = definition.lib!(ctx)
    const app = regionReadbackApp(12, 61)
    const write = app.context.write.bind(app.context)
    app.context.write = (bytes) => write(replace ? bytes.replaceAll(requested, wrong) : bytes)
    const capture = app.context.capture!.bind(app.context)
    const adjacentReadings: string[] = []
    app.context.capture = async (request) => {
      if (request.label.endsWith("pre-edit seed") || request.label.endsWith("post-sequence target")) {
        adjacentReadings.push(app.surface.getCell(adjacent, 0).char)
      }
      return capture(request)
    }
    const term = await definition.term!(app.context)
    if (!replace) {
      expect(surface.getCell(adjacent, 0).char).toBe("S")
      expect(adjacentReadings).toEqual(["S", "S"])
    }
    for (const result of [lib, term]) {
      if (replace) {
        expect(result.observation?.outcome).not.toBe("supported")
        expect(result.pass).toBe(false)
      } else {
        expect(result.observation?.outcome).toBe("supported")
      }
    }
  }
})

/**
 * A `TermProbeSource` over this repository's own semantic terminal. The app callbacks run for real, and
 * every capture is a cell-aligned crop of the grid the run actually painted, so a region digest follows
 * the terminal's behaviour instead of a boolean the fixture predicts — the mock that made an ignored
 * operation look honoured is what let the false "supported" through (#28018).
 *
 * `mutations` injects one named fault the surface knows. `strip` models an operation the surface has no
 * mutation hook for by dropping that exact sequence from every write, which is what an ignoring surface
 * would render.
 */
function regionReadbackApp(
  rows: number,
  cols: number,
  options: { mutations?: readonly string[]; strip?: string } = {},
) {
  const surface = createSemanticSurface({ rows, cols, mutations: options.mutations ?? [] })
  const writes: string[] = []
  const crop = (top: number, left: number, bottom: number, right: number): string => {
    const lines: string[] = []
    for (let y = top - 1; y < bottom; y++) {
      const line: string[] = []
      for (let x = left - 1; x < right; x++) line.push(surface.getCell(y, x).char ?? " ")
      lines.push(line.join(""))
    }
    return JSON.stringify(lines)
  }
  const context: TermProbeSource = {
    kind: "live",
    rows,
    cols,
    write: (bytes) => {
      writes.push(bytes)
      surface.feed(options.strip === undefined ? bytes : bytes.replaceAll(options.strip, ""))
    },
    queryCursorPosition: async () => ({ row: 1, col: 1 }),
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async (sequence) => {
      if (sequence === "\x1b[16t") {
        return { match: ["\x1b[6;16;8t", "16", "8"], reason: "reply" as const, raw: "", rawBase64: "" }
      }
      if (sequence === "\x1b[14t") {
        return { match: ["\x1b[4;384;640t", "384", "640"], reason: "reply" as const, raw: "", rawBase64: "" }
      }
      return { match: null, reason: "timeout" as const, raw: "", rawBase64: "" }
    },
    queryMode: async () => null,
    capture: async (request) => {
      const cells = request.cells!
      return {
        role: request.role,
        label: request.label,
        capturedAt: writes.length,
        ref: digest(`${request.label}|${writes.join("")}`),
        regionDigest: digest(crop(cells.top, cells.left, cells.bottom, cells.right)),
        pixelsDigest: digest(crop(1, 1, rows, cols)),
      }
    },
  }
  return { context, writes, surface }
}

/**
 * @failure The alt-screen app row returned control/target frames and a shrug on a surface that reports
 *   its own pixels and really implements 1049, so the capability stayed ungraded for want of a comparison
 *   the code never made. The headless callback cannot catch this: it decides either way, which is why the
 *   site table showed the gap on every terminal while the probe's own contract test passed. A spec that
 *   compared only the entry also graded a surface that dropped 1049l as supported, because nothing ever
 *   read the main grid back. The frame after the leave now carries a LIVE main marker, so a surface that
 *   never leaves has main row 1 blank: it differs from the seed, the expected frame and the one
 *   ignored-attribute frame, so it reads inconclusive BY NAME — never supported — while a surface that
 *   ignores 1049 outright lands on the ignored-attribute frame and reads unsupported.
 * @level l2
 * @consumer 28018 candidate-2 Scrollback group; the site table's scrollback rows for every terminal.
 * @testonly none
 */
test("scrollback.alt-screen reads the entry AND the restore from the region readback", async () => {
  for (const [label, options, outcome] of [
    ["the surface really swaps and restores", {}, "supported"],
    ["the surface ignores 1049h and 1049l", { mutations: ["altscreen-noop"] }, "unsupported"],
    ["the surface enters the alt grid and never leaves", { strip: "\x1b[?1049l" }, "inconclusive"],
  ] as const) {
    const { context } = regionReadbackApp(4, 61, options)
    const result = await findScrollback("scrollback.alt-screen").term!(context)
    expect(result.observation?.outcome, label).toBe(outcome)
    expect(result.pass, label).toBe(outcome === "supported")
    // A decided row carries the assertion behind its verdict; an inconclusive one names why instead,
    // so it carries none — which is what keeps "neither supported nor a named negative" from reading
    // as a verdict.
    if (outcome === "inconclusive") {
      expect(result.assertions ?? [], label).toEqual([])
    } else {
      expect(result.assertions ?? [], label).not.toEqual([])
    }
  }
})

/**
 * @failure ESC[?1049l is read as restoring the measured main grid when the surface CLEARS it instead,
 *   so a terminal that loses its main grid on exit still reads supported. That is the one shape the
 *   bare enter/leave frame could not separate (@cto 2026-10-12, must-fix 1): the frame after the leave
 *   must carry a LIVE main marker, not merely the absence of the alt grid.
 * @level l1
 * @consumer Headless Scrollback observations used by the support tables.
 * @testonly none
 */
test("scrollback.alt-screen refuses a surface that clears the main grid on 1049l", () => {
  const probe = scrollbackProbes.find((item) => item.id === "scrollback.alt-screen")
  if (!probe?.lib) throw new Error("Missing scrollback.alt-screen headless callback")
  const row = readbackRow("scrollback.alt-screen")
  const mainRow = ["M", "A", "I", "N", "_", "S", "C", "R", "E", "E", "N", "_", "M", "A", "R", "K", "E", "R"]
  const blankRow = mainRow.map(() => "")
  const okRow = ["O", "K", ...mainRow.slice(2).map(() => "")]
  const altMarked = [..."ALT_SCREEN_MARKER", ""]
  const [enterAlt, writeAlt, leaveAlt, writeOk] = row.steps.map((entry) => entry.write)
  if (!enterAlt || !writeAlt || !leaveAlt || !writeOk) throw new Error("alt-screen row is missing a step")
  // The SAME terminal is declared for both arms, keyed by the sequence each write feeds. The only
  // difference is what `1049l` restores to: the seed's main row (a real restore) or a blank screen
  // (a surface that clears main on exit). Everything downstream is identical, so the frame after the
  // leave has to carry the live main marker for either to read supported.
  const screens = (mainAfterExit: readonly string[]) => ({
    [row.seed]: [mainRow, blankRow],
    [enterAlt]: [blankRow, blankRow],
    [writeAlt]: [blankRow, altMarked],
    [leaveAlt]: [mainAfterExit, blankRow],
    [writeOk]: [mainAfterExit, okRow],
  })
  const restored = probe.lib(declaredScreen(screens(mainRow)))
  expect(restored.observation?.outcome).toBe("supported")
  const cleared = probe.lib(declaredScreen(screens(blankRow)))
  expect(cleared.observation?.outcome).toBe("unsupported")
  expect(cleared.pass).toBe(false)
})

/**
 * @failure The scroll-region rows returned control/target frames and a shrug from a surface that
 *   really implements DECSTBM (or its reset), so the capability stayed ungraded for want of a
 *   comparison the app path never made. The headless callback decides either way, which is why the
 *   site table showed the gap on every terminal while the probe's own contract test passed. A reset spec
 *   whose edit was `set; ESC[r; scroll` then had NO observable difference between "set then reset" and
 *   "neither honoured" - both left one full-screen scroll - so a surface that ignored DECSTBM entirely
 *   read supported; the edit now scrolls once INSIDE the region before the reset, which lands both
 *   ignored shapes one full-screen scroll further down, on the seed frame.
 * @level l2
 * @consumer 28018 candidate-2 Scrollback group; the site table's scrollback rows for every terminal.
 * @testonly none
 */
test("scrollback DECSTBM rows judge the app path from the region readback", async () => {
  for (const [label, id, options, outcome] of [
    ["the set confines the scroll", "scrollback.decstbm", {}, "supported"],
    ["the set is ignored", "scrollback.decstbm", { mutations: ["scrollregion-noop"] }, "unsupported"],
    ["the reset restores the full screen", "scrollback.decstbm-reset", {}, "supported"],
    ["DECSTBM is ignored entirely", "scrollback.decstbm-reset", { mutations: ["scrollregion-noop"] }, "unsupported"],
    ["the region is set but never reset", "scrollback.decstbm-reset", { strip: "\x1b[r" }, "unsupported"],
  ] as const) {
    const { context } = regionReadbackApp(12, 61, options)
    const result = await findScrollback(id).term!(context)
    expect(result.observation?.outcome, label).toBe(outcome)
    expect(result.pass, label).toBe(outcome === "supported")
    expect(result.assertions ?? [], label).not.toEqual([])
  }
})

/**
 * @failure The app viewport row leaves observable hold/snap/relative motion undecided, or grades a
 *   frame without delivery, arrival and restoration controls. Existing LIB cases cannot see UI policy.
 * @level l1
 * @consumer scrollback.viewport-hold-output application callback, through the production registry.
 * @testonly none
 */
type AppViewportPolicy = "hold" | "snap" | "relative" | "drift"
function viewportApplication(
  policies: readonly [AppViewportPolicy, AppViewportPolicy] = ["hold", "hold"],
  options: {
    delivery?: boolean
    upRows?: number
    down?: "ignored" | "early" | "second-restore"
    dropOutput?: boolean
    deferOutput?: boolean
    parseReply?: boolean
    changingChrome?: boolean
    opaqueHistory?: boolean
    digest?: "missing" | "empty"
    captureError?: boolean | "after-up"
    inputError?: boolean
    cleanupError?: boolean
  } = {},
) {
  const rows = 5
  const cols = 80
  const lines = [""]
  const writes: string[] = []
  const frames: { frame: ObservationFrame; grid: string[]; top: number; down: number }[] = []
  let row = 0
  let col = 0
  let top = 0
  let synchronized = false
  let delivered = ""
  let downs = 0
  let ups = 0
  let downsSinceUp = 0
  let targetWrites = 0
  let synchronizedWrites = 0
  let parseWitnesses = 0
  let pendingOutput: string | undefined
  let flushing = false
  const bottom = () => Math.max(0, lines.length - rows)
  const input = {
    wheelPlacement: {
      maxRowsPerNotch: 1,
      configurationHash: "a".repeat(64),
      applicationVersion: "fixture-1",
      applicationHash: "b".repeat(64),
    },
    injectKey: async (key: string) => {
      if (options.inputError) throw new Error("viewport input failed")
      if (options.delivery !== false) delivered += key
    },
    injectClick: async (button: 1 | 4 | 5) => {
      if (button === 4) {
        top = Math.max(0, top - (options.upRows ?? 1))
        ups++
        downsSinceUp = 0
      }
      if (button === 5) {
        flushOutput()
        const blocked =
          options.down === "ignored" ||
          (options.down === "early" && downsSinceUp >= 1) ||
          (options.down === "second-restore" && ups === 2)
        if (!blocked) top = Math.min(bottom(), top + 1)
        downs++
        downsSinceUp++
      }
    },
  }
  const { context } = silentAppSource(rows, cols)
  context.input = input
  context.readInput = async (pattern, _timeout, inject) => {
    delivered = ""
    await inject?.()
    return pattern.exec(delivered)
  }
  function flushOutput() {
    if (pendingOutput === undefined) return
    const bytes = pendingOutput
    pendingOutput = undefined
    flushing = true
    try {
      context.write(bytes)
    } finally {
      flushing = false
    }
  }
  context.queryWithSentinelOutcome = async (sequence, pattern) => {
    parseWitnesses++
    context.write(sequence)
    if (sequence !== "\x1b[c" || options.parseReply === false) {
      return { match: null, reason: "timeout", raw: "", rawBase64: "" }
    }
    flushOutput()
    const raw = "\x1b[?62;22c"
    return { match: pattern.exec(raw), reason: "reply", raw, rawBase64: Buffer.from(raw).toString("base64") }
  }
  context.write = (bytes) => {
    if (options.cleanupError && bytes.includes("\x1b[?25h")) throw new Error("viewport cleanup failed")
    writes.push(bytes)
    const oldBottom = bottom()
    const wasBottom = top === oldBottom
    const outputSynchronized = synchronized || bytes.includes("\x1b[?2026h")
    const text = bytes.replace(/\x1b\[([?\d;:]*)([A-Za-z])/g, (_sequence, parameters: string, command: string) => {
      if (parameters === "?2026") synchronized = command === "h"
      if (command === "J" && parameters === "2") {
        lines.splice(0, lines.length, "")
        row = col = top = 0
      }
      if (command === "H") {
        row = bottom()
        col = 0
      }
      return ""
    })
    if (text && !wasBottom && !flushing) {
      targetWrites++
      if (outputSynchronized) synchronizedWrites++
      if (options.dropOutput) return
      if (options.deferOutput) {
        pendingOutput = bytes
        return
      }
    }
    for (const char of text) {
      if (char === "\r") col = 0
      else if (char === "\n") {
        row++
        while (lines.length <= row) lines.push("")
      } else if (char >= " ") {
        const line = lines[row] ?? ""
        lines[row] = line.padEnd(col, " ").slice(0, col) + char + line.slice(col + 1)
        col++
      }
    }
    if (text) {
      if (wasBottom) top = bottom()
      else {
        const policy = policies[outputSynchronized ? 1 : 0]
        if (policy === "snap") top = bottom()
        if (policy === "relative") top += bottom() - oldBottom
        if (policy === "drift") top += 2
      }
    }
  }
  context.capture = async (request) => {
    if (options.captureError === true || (options.captureError === "after-up" && ups > 0)) {
      throw new Error("viewport capture failed")
    }
    const grid = Array.from({ length: rows }, (_, index) =>
      options.opaqueHistory && top < bottom()
        ? "Opaque history overlay".padEnd(cols, " ")
        : (lines[top + index] ?? "").padEnd(cols, " ").slice(0, cols),
    )
    // Only rendered pixels decide equality: offsets and capture labels do not enter the digest.
    const pixelsDigest = createHash("sha256")
      .update(JSON.stringify({ grid, chrome: options.changingChrome ? frames.length : 0 }))
      .digest("hex")
    const frame: ObservationFrame = {
      ...request,
      capturedAt: frames.length + 1,
      ref: `viewport-frame:${frames.length + 1}`,
      pixelsDigest,
    }
    if (options.digest === "missing") Reflect.deleteProperty(frame, "pixelsDigest")
    if (options.digest === "empty") frame.pixelsDigest = ""
    frames.push({ frame, grid, top, down: downs })
    return frame
  }
  return {
    context,
    input,
    writes,
    frames,
    activity: () => ({ targetWrites, synchronizedWrites, parseWitnesses, top, bottom: bottom(), downs }),
  }
}

// Accepted requirement: only two qualified holds pass; either qualified motion is a negative.
// Prior app coverage never exercises wheel/UI state, so its unconditional TODO misses all three.
test.each([
  ["both phases hold", ["hold", "hold"], "supported"],
  ["ordinary snap and synchronized hold", ["snap", "hold"], "unsupported"],
  ["ordinary hold and synchronized bottom-relative motion", ["hold", "relative"], "unsupported"],
] as const)("app viewport decides %s from actual rendered frames", async (_name, policies, outcome) => {
  const app = viewportApplication(policies)
  const result = await findScrollback("scrollback.viewport-hold-output").term!(app.context)
  expect(result.observation?.outcome).toBe(outcome)
  expect(result.pass).toBe(outcome === "supported")
  expect(result.assertions).toContainEqual(
    expect.objectContaining({ assertionType: "screenshot", kind: outcome === "supported" ? "positive" : "negative" }),
  )
  // Each phase confirms A with a second complete frame before any downward input.
  expect(app.frames).toHaveLength(15)
  expect(app.frames.map(({ down }) => down)).toEqual([0, 0, 0, 0, 0, 22, 22, 44, 44, 44, 44, 44, 66, 66, 88])
  const reference = app.frames[0]!.frame.pixelsDigest
  for (const index of [5, 7, 12, 14]) expect(app.frames[index]!.frame.pixelsDigest).toBe(reference)
})

function expectViewportTodo(result: ProbeCallbackResult) {
  expect(result).toMatchObject({ pass: false })
  expect(result.notTested?.reason).toBe("no-semantic-observable")
  expect(result.notTested?.noObservable).toBeTruthy()
  expect(result.assertions ?? []).toEqual([])
  expect(result.observation).toBeUndefined()
}

// Accepted ambiguity contract: neither zero nor multiple equalities decides a viewport policy.
// Existing model-region and LIB tests cannot observe a whole-window overlay or unexplained drift.
test.each([
  ["unexplained drift gives zero matching frames", ["drift", "hold"], {}],
  ["synchronized ambiguity withholds an ordinary hold", ["hold", "drift"], {}],
  ["synchronized ambiguity withholds an ordinary negative", ["snap", "drift"], {}],
  ["an opaque history overlay gives multiple matching frames", ["hold", "hold"], { opaqueHistory: true }],
] as const)("app viewport withholds ambiguous output: %s", async (_name, policies, options) => {
  const app = viewportApplication(policies, options)
  const result = await findScrollback("scrollback.viewport-hold-output").term!(app.context)
  expectViewportTodo(result)
  expect(result.notTested?.noObservable).toContain("ambiguous frame")
})

// Accepted prerequisite contract: no generic wheel emission proves the required trusted bound or delivery.
// The old zero-I/O app callback never inspected these actual caller resources or named their causes.
test.each(["no input", "no capture", "no delivery", "no bound", "empty provenance", "invalid bound"] as const)(
  "app viewport refuses %s without writing target output",
  async (cause) => {
    const app = viewportApplication(undefined, { delivery: cause !== "no delivery" })
    if (cause === "no input") app.context.input = undefined
    if (cause === "no capture") app.context.capture = undefined
    if (cause === "no bound") Reflect.deleteProperty(app.input, "wheelPlacement")
    if (cause === "empty provenance") app.input.wheelPlacement.configurationHash = ""
    if (cause === "invalid bound") app.input.wheelPlacement.maxRowsPerNotch = 0
    const result = await findScrollback("scrollback.viewport-hold-output").term!(app.context)
    expectViewportTodo(result)
    expect(app.activity().targetWrites).toBe(0)
    if (["no bound", "empty provenance", "invalid bound"].includes(cause)) {
      expect(result.notTested?.noObservable).toBe("wheel placement bound not established")
      expect(app.writes).toEqual([])
    }
  },
)

// Accepted bottom construction: ignored/short movement and absent output must never make an old tail a fresh bottom.
// Existing ED3 fixtures lack distinct anchors and cannot expose these hold-specific false-restoration paths.
test.each([
  ["wheel down ignored", { down: "ignored" }],
  ["wheel down stops early", { down: "early" }],
  ["output never arrives", { dropOutput: true }],
] as const)("app viewport does not invent a bottom when %s", async (_cause, options) => {
  const app = viewportApplication(undefined, options)
  const result = await findScrollback("scrollback.viewport-hold-output").term!(app.context)
  expectViewportTodo(result)
  expect(result.notTested?.noObservable).toContain("restoration to bottom not proven")
})

// Accepted bound limitation: this observable contradiction reaches the old T (U == Bref).
// This does not assert that whole frames detect every lying producer's unobservable bound violation.
test("app viewport refuses an advertised one-row notch that jumps back to the old tail", async () => {
  const app = viewportApplication(undefined, { upRows: 1000 })
  const result = await findScrollback("scrollback.viewport-hold-output").term!(app.context)
  expectViewportTodo(result)
  expect(app.activity().top).toBe(app.activity().bottom)
  expect(app.frames).toHaveLength(3)
  expect(app.frames[2]!.frame.pixelsDigest).toBe(app.frames[0]!.frame.pixelsDigest)
  expect(app.activity().targetWrites).toBe(0)
})

// Accepted lifecycle: R leaves the verified bottom; a failed second restore forbids phase-two setup.
// A single restoration test would pass if production reused B1 after R had scrolled away.
test("app viewport restores again after R before any synchronized setup", async () => {
  const app = viewportApplication(undefined, { down: "second-restore" })
  const result = await findScrollback("scrollback.viewport-hold-output").term!(app.context)
  expectViewportTodo(result)
  expect(result.notTested?.noObservable).toContain("restoration to bottom not proven")
  expect(app.frames).toHaveLength(8)
  expect(app.activity().synchronizedWrites).toBe(0)
  expect(app.writes.join("")).not.toContain("\x1b[?2026h")
})

// Accepted error boundary: promised malformed pixels and operational errors must propagate, never grade unsupported.
// Existing region fixtures exercise different adapters/cleanup and cannot witness this new cursor restoration.
test.each([
  ["missing pixels", { digest: "missing" }],
  ["empty pixels", { digest: "empty" }],
  ["capture failure", { captureError: true }],
  ["input failure", { inputError: true }],
  ["cleanup failure", { cleanupError: true }],
] as const)("app viewport propagates %s", async (_cause, options) => {
  const app = viewportApplication(undefined, options)
  await expect(findScrollback("scrollback.viewport-hold-output").term!(app.context)).rejects.toThrow()
})

test("app viewport restores history and preserves capture and cleanup failures together", async () => {
  const app = viewportApplication(undefined, { captureError: "after-up", cleanupError: true })
  const result = findScrollback("scrollback.viewport-hold-output").term!(app.context)
  await expect(result).rejects.toBeInstanceOf(AggregateError)
  await expect(result).rejects.toMatchObject({
    errors: [
      expect.objectContaining({ message: "viewport capture failed" }),
      expect.objectContaining({ message: "viewport cleanup failed" }),
    ],
  })
  expect(app.activity().top).toBe(app.activity().bottom)
})

// Accepted full-pixel comparison: changing window decorations withholds a verdict, without a pixel mask.
// This risk is absent from existing cell-cropped region and headless fixtures.
test("app viewport keeps changing whole-window chrome as TODO", async () => {
  const app = viewportApplication(undefined, { changingChrome: true })
  const result = await findScrollback("scrollback.viewport-hold-output").term!(app.context)
  expectViewportTodo(result)
  expect(result.notTested?.noObservable).toBe("output frame still changing")
})

// A delayed parser can leave A at the old anchor, then snap before B1. Immediate-output
// fixtures miss that false Supported; the existing DA1 round-trip must precede the pixels.
test.each([true, false])("app viewport witnesses deferred output before its pixels (reply: %s)", async (reply) => {
  const app = viewportApplication(["snap", "snap"], { deferOutput: true, parseReply: reply })
  const result = await findScrollback("scrollback.viewport-hold-output").term!(app.context)
  if (reply) {
    expect(result.observation?.outcome).toBe("unsupported")
    expect(app.activity().parseWitnesses).toBe(2)
  } else {
    expectViewportTodo(result)
    expect(result.notTested?.noObservable).toBe("output parse not witnessed before the output frame")
    expect(app.activity().parseWitnesses).toBe(1)
  }
  expect(app.activity().top).toBe(app.activity().bottom)
})
