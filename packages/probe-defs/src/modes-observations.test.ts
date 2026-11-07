/**
 * @failure Mode probes mutate unsnapshotted state, fail restoration, or discard a library mode-state reply as an unmeasured presentation effect.
 * @level l1
 * @consumer Owned app mode observations and reviewed support cells.
 * @testonly none
 */
import { expect, test, vi } from "vitest"
import { parseRun } from "@terminfo/run-parser"
import { isDeclaredUntestable, NO_SAME_PATH_CONTROL, recordExecutedProbe } from "./helpers.ts"
import { modesProbes } from "./modes.ts"
import { libProbeSource, replayTermProbeSource, type StoredQuery } from "./testing/group-harness.ts"
import { createSemanticSurface } from "./testing/semantic-surface.ts"
import type {
  CaptureCells,
  CaptureRectangle,
  CaptureRequest,
  ObservationFrame,
  ProbeCallbackResult,
  TermProbeSource,
  LibProbeSource,
  ProbeSuiteManifest,
} from "./types.ts"

// A DECRPM reply does not witness focus delivery. Both set/reset arms must run,
// including when the enabled arm has no reports (the reviewed Screen reading).
test("App focus tracking grades delivered set/reset input rather than DECRPM", async () => {
  const definition = modesProbes.find((entry) => entry.id === "modes.focus-tracking")!
  for (const [enableTime, enabled, reset, outcome] of [
    ["", "\x1b[O\x1b[Ia", "a", "supported"],
    ["\x1b[I", "\x1b[O\x1b[Ia", "a", "supported"],
    ["\x1b[O", "\x1b[O\x1b[Ia", "a", "supported"],
    ["", "a", "a", "unsupported"],
    ["\x1b[I", "a", "a", "unsupported"],
    ["\x1b[O", "a", "a", "unsupported"],
    ["", "\x1b[Oa", "a", "invalid"],
    ["\x1b[O", "\x1b[Ia", "a", "invalid"],
    ["\x1b[I\x1b[I", "\x1b[O\x1b[Ia", "a", "invalid"],
    ["", "\x1b[I\x1b[Oa", "a", "invalid"],
    ["", "\x1b[O\x1b[I", "a", "invalid"],
    ["", "\x1b[O\x1b[Ia", "\x1b[O\x1b[Ia", "invalid"],
  ] as const) {
    let arm = 0
    let bytes = ""
    const input = {
      injectClick: async () => {
        throw new Error("Focus fixture received a click")
      },
      focusRoundTrip: async () => {
        bytes += arm++ === 0 ? enabled.replace(/a$/, "") : reset.replace(/a$/, "")
        return {
          ownedWindowId: "42",
          rootWindowId: "543",
          focusedWindowIds: ["42", "543", "42"] as [string, string, string],
        }
      },
      injectKey: async () => {
        if (arm === 0 || (arm === 1 ? enabled : reset).endsWith("a")) bytes += "a"
      },
    }
    const source = replayTermProbeSource(new Map(), {
      input,
      write: (sequence) => {
        if (sequence === "\x1b[?1004h") bytes += enableTime
      },
      readInput: async (pattern, _timeout, inject) => {
        bytes = ""
        await inject?.()
        return pattern.exec(bytes)
      },
    })
    const result = await definition.term!(source)
    expect(arm, `${outcome}: both focus arms`).toBe(2)
    if (outcome === "invalid") {
      expect(result.tests).toEqual(expect.arrayContaining([expect.objectContaining({ status: "probe-invalid" })]))
    } else {
      expect(result.observation?.outcome).toBe(outcome)
    }
  }
})

// Constructed pixel-equivalence planes are derived from the semantic parser's
// cells and global reverse flag. They test callback wiring, not native App rendering.
test.each([null, 0] as const)("App reverse video reads controlled pixels after DECRPM %s", async (ps) => {
  const definition = modesProbes.find((entry) => entry.id === "modes.reverse-video")
  if (!definition?.term) throw new Error("Missing App reverse-video callback")
  const stored = new Map<string, StoredQuery>()
  if (ps === 0) stored.set("\x1b[?5$p", { sequence: "\x1b[?5$p", match: null, reason: "reply", raw: "\x1b[?5;0$y" })
  for (const mutation of [undefined, "decscnm-noop", "inverse-noop", "stale-pixels"] as const) {
    const cols = 20
    const rows = 5
    const surface = createSemanticSurface({
      cols,
      rows,
      mutations: mutation && mutation !== "stale-pixels" ? [mutation] : [],
    })
    let sequence = 0
    const plane = (rectangle: CaptureCells) => {
      const cells: unknown[] = []
      for (let row = rectangle.top; row <= rectangle.bottom; row++) {
        for (let col = rectangle.left; col <= rectangle.right; col++) {
          const cell = surface.getCell(row - 1, col - 1)
          cells.push([cell.char, cell.inverse !== (surface.getMode("reverseVideo") === true)])
        }
      }
      return mutation === "stale-pixels" ? "unchanged pixels" : JSON.stringify(cells)
    }
    const source = replayTermProbeSource(stored, {
      cols,
      rows,
      captureKind: "pixels",
      write: (text) => surface.feed(text),
      queryCursorPosition: async () => {
        const cursor = surface.getCursor()
        return { row: cursor.y + 1, col: cursor.x + 1 }
      },
      captureGeometry: {
        geometry: { cellWidth: 10, cellHeight: 20, textWidth: cols * 10, textHeight: rows * 20 },
        source: "measured by complete raster calibration",
      },
      capture: async ({ role, label, cells, pixelGeometry }) => {
        if (!cells || !pixelGeometry) throw new Error("Reverse pixel fixture needs its measured crop")
        return {
          kind: "pixels",
          role,
          label,
          capturedAt: ++sequence,
          ref: `sha256:${sequence.toString(16).padStart(64, "0")}`,
          regionDigest: plane(cells),
          pixelsDigest: plane({ top: 1, left: 1, bottom: rows, right: cols }),
          regionRectangle: {
            x: (cells.left - 1) * pixelGeometry.cellWidth,
            y: (cells.top - 1) * pixelGeometry.cellHeight,
            width: (cells.right - cells.left + 1) * pixelGeometry.cellWidth,
            height: (cells.bottom - cells.top + 1) * pixelGeometry.cellHeight,
          },
        }
      },
    })
    vi.useFakeTimers()
    let result: ProbeCallbackResult
    try {
      const pending = definition.term(source)
      await vi.runAllTimersAsync()
      result = await pending
    } finally {
      vi.useRealTimers()
    }
    const recorded = recordExecutedProbe({
      featureId: definition.id,
      attempt: { scope: "probe", startedAt: new Date().toISOString() },
      tests: result.tests,
      observation: result.observation ? { featureId: definition.id, ...result.observation } : undefined,
      assertions: (result.assertions ?? []).map((assertion) => ({ featureId: definition.id, ...assertion })),
    })
    if (mutation === "inverse-noop" || mutation === "stale-pixels") {
      expect(["probe-todo", "probe-invalid"]).toContain(recorded.status)
    } else expect(recorded.status, mutation ?? "working reverse video").toBe(mutation ? "unsupported" : "supported")
    if (ps === 0 && !mutation) expect(result.note).toContain("Ps 0")
    expect(surface.getMode("reverseVideo")).toBe(false)
  }
  const missing = await definition.term(replayTermProbeSource(stored))
  expect(missing.tests).toEqual(expect.arrayContaining([expect.objectContaining({ status: "probe-invalid" })]))
})

// Ask 3 permits a same-run mode effect when DECRPM is silent or Ps 0. The reply
// contract does not exercise that path. Reuse the semantic terminal so removing
// DECAWM alone loses the positive without breaking the cursor-delivery control.
test.each([null, 0] as const)("App auto-wrap uses controlled effects after DECRPM %s", async (ps) => {
  const definition = modesProbes.find((entry) => entry.id === "modes.auto-wrap")
  if (!definition?.term) throw new Error("Missing App auto-wrap callback")
  const stored = new Map<string, StoredQuery>()
  if (ps !== null) {
    stored.set("\x1b[?7$p", { sequence: "\x1b[?7$p", match: null, reason: "reply", raw: `\x1b[?7;${ps}$y` })
  }

  for (const mutation of [undefined, "decawm-noop", "wrap-noop"] as const) {
    const surface = createSemanticSurface({ cols: 8, rows: 4, mutations: mutation ? [mutation] : [] })
    const source = replayTermProbeSource(stored, {
      cols: 8,
      rows: 4,
      write: (bytes) => surface.feed(bytes),
      queryCursorPosition: async () => {
        const cursor = surface.getCursor()
        return { row: cursor.y + 1, col: cursor.x + 1 }
      },
    })
    const result = await definition.term(source)
    expect(result.observation?.outcome, mutation ?? "working auto-wrap").toBe(mutation ? "unsupported" : "supported")
    expect(result.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ assertionType: "query_reply", kind: mutation ? "negative" : "positive" }),
      ]),
    )
  }

  const inert = await definition.term(replayTermProbeSource(stored))
  expect(inert.observation?.outcome).not.toBe("supported")
  expect(inert.observation?.outcome).not.toBe("unsupported")
  expect(inert.tests).toEqual(expect.arrayContaining([expect.objectContaining({ status: "probe-invalid" })]))
  expect(definition.termNeedsDisposable).toBe(true)
  expect(definition.termWrites).toBeUndefined()
})

// Ask 3 permits a same-run alternate-buffer marker read after absent/Ps0 DECRPM.
// Read actual semantic cells, so ignoring 1049 alone loses the positive while
// ordinary paint/witness controls still work; no label-selected frame verdict.
test.each([null, 0] as const)("App alternate-screen entry uses controlled effects after DECRPM %s", async (ps) => {
  const definition = modesProbes.find((entry) => entry.id === "modes.alt-screen.enter")
  if (!definition?.term) throw new Error("Missing App alternate-screen entry callback")
  const stored = new Map<string, StoredQuery>()
  if (ps !== null) {
    stored.set("\x1b[?1049$p", { sequence: "\x1b[?1049$p", match: null, reason: "reply", raw: "\x1b[?1049;0$y" })
  }
  for (const mutation of [undefined, "altscreen-noop"] as const) {
    const cols = 20
    const rows = 5
    const surface = createSemanticSurface({ cols, rows, mutations: mutation ? [mutation] : [] })
    let sequence = 0
    const source = replayTermProbeSource(stored, {
      cols,
      rows,
      write: (bytes) => surface.feed(bytes),
      captureKind: "text-cells",
      cells: async (request) => {
        if (!request.cells) throw new Error("Semantic marker read needs its named cells")
        const text = (rectangle: CaptureCells) =>
          Array.from({ length: rectangle.bottom - rectangle.top + 1 }, (_, row) =>
            Array.from(
              { length: rectangle.right - rectangle.left + 1 },
              (_, col) => surface.getCell(rectangle.top - 1 + row, rectangle.left - 1 + col).char,
            ).join(""),
          ).join("\n")
        return {
          kind: "text-cells",
          role: request.role,
          label: request.label,
          capturedAt: ++sequence,
          ref: `semantic-marker:${sequence}`,
          cellRectangle: request.cells,
          cellDigest: text(request.cells),
          frameDigest: text({ top: 1, left: 1, bottom: rows, right: cols }),
        }
      },
    })
    const result = await definition.term(source)
    const recorded = recordExecutedProbe({
      featureId: definition.id,
      attempt: { scope: "probe", startedAt: new Date().toISOString() },
      observation: result.observation ? { featureId: definition.id, ...result.observation } : undefined,
      assertions: (result.assertions ?? []).map((assertion) => ({ featureId: definition.id, ...assertion })),
      tests: result.tests,
    })
    expect(recorded.status, mutation ?? "working 1049").toBe(mutation ? "unsupported" : "supported")
    if (ps === 0) expect(result.note).toContain("Ps 0")
    expect(surface.getMode("altScreen")).toBe(false)
  }
  const missing = await definition.term(replayTermProbeSource(stored))
  expect(missing.tests).toEqual(expect.arrayContaining([expect.objectContaining({ status: "probe-invalid" })]))
  expect(definition.termNeedsDisposable).toBe(true)
  expect(definition.termNeedsGeometry).toBe(true)
  expect(definition.termWrites).toBeUndefined()
})

// The reply-only contract misses an absent-query App that really switches Up
// encodings. Ask 3 requires set/reset effects, a live delivery control and an
// invalid result when no target bytes were read. Reuse the semantic mode parser.
test.each([null, 0] as const)("App cursor keys use controlled effects after DECRPM %s", async (ps) => {
  const definition = modesProbes.find((entry) => entry.id === "modes.application-cursor")
  if (!definition?.term) throw new Error("Missing App application-cursor callback")
  const stored = new Map<string, StoredQuery>()
  if (ps !== null) {
    stored.set("\x1b[?1$p", { sequence: "\x1b[?1$p", match: null, reason: "reply", raw: `\x1b[?1;${ps}$y` })
  }
  for (const mutation of [undefined, "decckm-noop", "missing-up"] as const) {
    const surface = createSemanticSurface({ mutations: mutation === "decckm-noop" ? [mutation] : [] })
    let bytes = ""
    const source = replayTermProbeSource(stored, {
      write: (text) => surface.feed(text),
      input: {
        injectClick: async () => {
          throw new Error("Cursor-key fixture received a click")
        },
        injectKey: async (key) => {
          if (key === "a") bytes += "a"
          else if (key === "Up") {
            if (mutation !== "missing-up") bytes += surface.getMode("applicationCursor") === true ? "\x1bOA" : "\x1b[A"
          } else throw new Error(`Cursor-key fixture received ${key}`)
        },
      },
      readInput: async (pattern, _timeout, inject) => {
        bytes = ""
        await inject?.()
        return pattern.exec(bytes)
      },
    })
    const result = await definition.term(source)
    if (mutation === "missing-up") {
      expect(result.observation?.outcome).not.toBe("supported")
      expect(result.observation?.outcome).not.toBe("unsupported")
      expect(result.tests).toEqual(expect.arrayContaining([expect.objectContaining({ status: "probe-invalid" })]))
    } else {
      expect(result.observation?.outcome, mutation ?? "working DECCKM").toBe(mutation ? "unsupported" : "supported")
      expect(result.assertions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ assertionType: "input_bytes", kind: mutation ? "negative" : "positive" }),
        ]),
      )
      // The native collector seals these assertions, then run-parser reads every
      // input_bytes snapshot. Callback-only checks missed a bare "a" assertion.
      const feature = definition.id
      const suite = "452ac343b55d"
      const assertions = (result.assertions ?? []).map((entry) => ({
        ...entry,
        featureId: feature,
        rawReplyRef: feature,
      }))
      const recorded = recordExecutedProbe({
        featureId: feature,
        attempt: { scope: "probe", startedAt: "2026-11-07T10:51:00.000Z" },
        rawReplyRef: feature,
        observation: { ...result.observation!, featureId: feature, rawReplyRef: feature },
        assertions,
        tests: result.tests,
      })
      const manifest: ProbeSuiteManifest = {
        schemaVersion: 4,
        probeHash: suite,
        adapterVersion: "3.3.1",
        generatedAt: "2026-11-07T10:50:00.000Z",
        catalogIds: [feature],
        probes: { term: [feature], lib: [], mux: [] },
      }
      const run = {
        schemaVersion: 4,
        source: { kind: "live" },
        runId: `cursor-effect-${String(ps)}-${mutation ?? "working"}`,
        suiteId: suite,
        probeHash: suite,
        sourceRevision: "4".repeat(40),
        intendedSubject: { kind: "term", id: "kitty" },
        subject: {
          kind: "term",
          id: "kitty",
          version: "0.49.2",
          os: "linux",
          osVersion: null,
          outerTerminal: null,
          mux: null,
          config: null,
          permissions: null,
        },
        identity: "unverified",
        measuredAt: "2026-11-07T10:51:00.000Z",
        origin: { kind: "collector" },
        sealedAt: "2026-11-07T10:52:00.000Z",
        rawReplies: { [feature]: result.response },
        assertions,
        screenshotRefs: [],
        results: [recorded],
      }
      expect(() =>
        parseRun("cursor-effect.json", JSON.stringify(run), [feature], new Map([[suite, manifest]])),
      ).not.toThrow()
    }
    expect(surface.getMode("applicationCursor")).toBe(false)
  }
  const inert = await definition.term(replayTermProbeSource(stored))
  expect(inert.tests).toEqual(expect.arrayContaining([expect.objectContaining({ status: "probe-invalid" })]))
  expect(definition.termNeedsDisposable).toBe(true)
  expect(definition.termWrites).toBeUndefined()
})

// CTO's 1003 amendment requires buttonless motion only while set, no reports in
// either reset arm, and same-run click/key controls. The reply contract misses it.
test.each([null, 0] as const)("App all-motion mouse uses controlled effects after DECRPM %s", async (ps) => {
  const definition = modesProbes.find((entry) => entry.id === "modes.mouse-all")
  if (!definition?.term) throw new Error("Missing App all-motion callback")
  const stored = new Map<string, StoredQuery>()
  if (ps !== null) {
    stored.set("\x1b[?1003$p", { sequence: "\x1b[?1003$p", match: null, reason: "reply", raw: "\x1b[?1003;0$y" })
  }
  for (const mutation of [undefined, "mouse-1003-noop", "reset-reports", "missing-a"] as const) {
    const surface = createSemanticSurface({ mutations: mutation === "mouse-1003-noop" ? [mutation] : [] })
    let bytes = ""
    const source = replayTermProbeSource(stored, {
      write: (text) => surface.feed(text),
      captureGeometry: {
        geometry: { cellWidth: 8, cellHeight: 16, textWidth: 640, textHeight: 384 },
        source: "measured by complete raster calibration",
      },
      input: {
        injectKey: async (key) => {
          if (key !== "a") throw new Error(`Motion fixture received ${key}`)
          if (mutation !== "missing-a") bytes += "a"
        },
        injectClick: async () => {
          if (surface.getMode("mouseTracking") === true) bytes += "\x1b[<0;4;2M\x1b[<0;4;2m"
        },
        injectMove: async () => {
          if (surface.getMode("mouseTracking") === true || mutation === "reset-reports") bytes += "\x1b[<35;4;2M"
        },
      },
      readInput: async (pattern, _timeout, inject) => {
        bytes = ""
        await inject?.()
        return pattern.exec(bytes)
      },
    })
    const result = await definition.term(source)
    if (mutation === "reset-reports" || mutation === "missing-a") {
      expect(result.observation?.outcome).not.toBe("supported")
      expect(result.observation?.outcome).not.toBe("unsupported")
      expect(result.tests).toEqual(expect.arrayContaining([expect.objectContaining({ status: "probe-invalid" })]))
    } else {
      expect(result.observation?.outcome, mutation ?? "working 1003").toBe(mutation ? "unsupported" : "supported")
    }
    expect(surface.getMode("mouseTracking")).toBe(false)
    expect(surface.getMode("sgrMouse")).toBe(false)
  }
})

// The query-only path cannot observe 1000 clicks when DECRPM is silent. An
// ignored 1000 switch is negative only with an independent same-path click;
// removing both mouse modes, the injected click or the plain key is invalid.
test.each([null, 0] as const)("App mouse tracking uses controlled effects after DECRPM %s", async (ps) => {
  const definition = modesProbes.find((entry) => entry.id === "modes.mouse-tracking")
  if (!definition?.term) throw new Error("Missing App mouse tracking callback")
  const stored = new Map<string, StoredQuery>()
  if (ps !== null) {
    stored.set("\x1b[?1000$p", { sequence: "\x1b[?1000$p", match: null, reason: "reply", raw: "\x1b[?1000;0$y" })
  }
  for (const mutation of [
    undefined,
    "mouse-1006-noop",
    "mouse-1000-noop",
    "legacy-control",
    "no-mouse-control",
    "missing-click",
    "missing-a",
    "reset-reports",
  ] as const) {
    const surface = createSemanticSurface({
      mutations:
        mutation === "mouse-1000-noop"
          ? [mutation]
          : mutation === "mouse-1006-noop"
            ? [mutation]
            : mutation === "legacy-control"
              ? ["mouse-1000-noop", "mouse-1006-noop"]
              : mutation === "no-mouse-control"
                ? ["mouse-1000-noop", "mouse-1003-noop"]
                : [],
    })
    let bytes = ""
    const source = replayTermProbeSource(stored, {
      write: (text) => surface.feed(text),
      input: {
        injectKey: async (key) => {
          if (key !== "a") throw new Error(`Mouse tracking fixture received ${key}`)
          if (mutation !== "missing-a") bytes += "a"
        },
        injectClick: async () => {
          if (
            mutation !== "missing-click" &&
            (surface.getMode("mouseTracking") === true || mutation === "reset-reports")
          ) {
            bytes += surface.getMode("sgrMouse") === true ? "\x1b[<0;4;2M\x1b[<0;4;2m" : '\x1b[M $"\x1b[M#$"'
          }
        },
      },
      readInput: async (pattern, _timeout, inject) => {
        bytes = ""
        await inject?.()
        return pattern.exec(bytes)
      },
    })
    const result = await definition.term(source)
    if (
      mutation === undefined ||
      mutation === "mouse-1006-noop" ||
      mutation === "mouse-1000-noop" ||
      mutation === "legacy-control"
    ) {
      const disabled = mutation === "mouse-1000-noop" || mutation === "legacy-control"
      expect(result.observation?.outcome, mutation ?? "working 1000").toBe(disabled ? "unsupported" : "supported")
      expect(result.assertions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ assertionType: "input_bytes", kind: disabled ? "negative" : "positive" }),
        ]),
      )
    } else {
      expect(result.observation?.outcome).not.toBe("supported")
      expect(result.observation?.outcome).not.toBe("unsupported")
      expect(result.tests).toEqual(expect.arrayContaining([expect.objectContaining({ status: "probe-invalid" })]))
    }
    expect(surface.getMode("mouseTracking")).toBe(false)
    expect(surface.getMode("sgrMouse")).toBe(false)
  }
})

// Ask 3 needs actual click encodings when DECRPM cannot decide. The reply-only
// tests miss an ignored 1006 switch with otherwise working click/key delivery.
test.each([null, 0] as const)("App SGR mouse uses controlled effects after DECRPM %s", async (ps) => {
  const definition = modesProbes.find((entry) => entry.id === "modes.mouse-sgr")
  if (!definition?.term) throw new Error("Missing App SGR mouse callback")
  const stored = new Map<string, StoredQuery>()
  if (ps !== null) {
    stored.set("\x1b[?1006$p", { sequence: "\x1b[?1006$p", match: null, reason: "reply", raw: "\x1b[?1006;0$y" })
  }
  for (const mutation of [undefined, "mouse-1006-noop", "missing-click", "missing-a", "reset-sgr"] as const) {
    const surface = createSemanticSurface({ mutations: mutation === "mouse-1006-noop" ? [mutation] : [] })
    let bytes = ""
    const source = replayTermProbeSource(stored, {
      write: (text) => surface.feed(text),
      input: {
        injectKey: async (key) => {
          if (key !== "a") throw new Error(`SGR mouse fixture received ${key}`)
          if (mutation !== "missing-a") bytes += "a"
        },
        injectClick: async () => {
          if (mutation === "missing-click" || surface.getMode("mouseTracking") !== true) return
          bytes +=
            surface.getMode("sgrMouse") === true || mutation === "reset-sgr"
              ? "\x1b[<0;4;2M\x1b[<0;4;2m"
              : '\x1b[M $"\x1b[M#$"'
        },
      },
      readInput: async (pattern, _timeout, inject) => {
        bytes = ""
        await inject?.()
        return pattern.exec(bytes)
      },
    })
    const result = await definition.term(source)
    if (mutation === "missing-click" || mutation === "missing-a" || mutation === "reset-sgr") {
      expect(result.observation?.outcome).not.toBe("supported")
      expect(result.observation?.outcome).not.toBe("unsupported")
      expect(result.tests).toEqual(expect.arrayContaining([expect.objectContaining({ status: "probe-invalid" })]))
    } else {
      expect(result.observation?.outcome, mutation ?? "working 1006").toBe(mutation ? "unsupported" : "supported")
      expect(result.assertions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ assertionType: "input_bytes", kind: mutation ? "negative" : "positive" }),
        ]),
      )
    }
    expect(surface.getMode("mouseTracking")).toBe(false)
    expect(surface.getMode("sgrMouse")).toBe(false)
  }
})

// The existing mode contract exercises app replies; it misses these library
// callbacks retaining presentation reviews even when the engine answers DECRPM.
// S8 requires the mutable reply pair and independent mode reads; presentation stays unmeasured.
test.each([
  ["modes.reverse-video", 5, "presentation (inverted frame) unmeasured; protocol measured"],
  ["modes.synchronized-output", 2026, "presentation (tearing, scroll cadence) unmeasured; protocol measured"],
  [
    "modes.color-scheme-reporting",
    2031,
    "scheme-change report (CSI ? 997 ; Ps n, unsolicited) unmeasured; recognition measured",
  ],
] as const)("%s library criterion retains its strict roundtrip and unmeasured facet", (id, mode, facet) => {
  const definition = modesProbes.find((entry) => entry.id === id)
  if (!definition?.lib) throw new Error(`Missing library callback for ${id}`)
  for (const ps of [1, 2, 3, 4, 0, null] as const) {
    const queries: string[] = []
    let enabled = false
    const reply = ps === null ? "" : `\x1b[?${mode};${ps}$y`
    const resetReply = ps === null ? "" : `\x1b[?${mode};2$y`
    const source = libProbeSource({
      cols: 80,
      feed(sequence) {
        if (sequence === `\x1b[?${mode}h`) enabled = true
        if (sequence === `\x1b[?${mode}l`) enabled = false
      },
      feedCapture(sequence) {
        queries.push(sequence)
        return sequence === `\x1b[?${mode}$p` ? (enabled ? reply : resetReply) : ""
      },
      getMode: () => enabled,
      getText: () => "",
      getCell() {
        throw new Error("Mode-state criterion must use the engine reply")
      },
      getCursor() {
        throw new Error("Mode-state criterion must use the engine reply")
      },
    })
    const result = definition.lib(source)
    if (ps === null && mode === 5) {
      // This fake aliases every mode to enabled, so DEC1's other-flag control fails.
      expect(result.observation?.outcome).toBe("inconclusive")
      expect(result.note).toContain("the second mode changed")
      expect(result.assertions ?? []).toEqual([])
      const unread = definition.lib({
        ...source,
        getMode: (name) => (name === "applicationCursor" ? null : enabled),
      })
      expect(unread.tests).toContainEqual({
        id: "criterion",
        status: "probe-todo",
        reason:
          "Open: reverse-video mode set and reset as expected, but the second mode we use to show they are independent cannot be read here.",
      })
    } else if (ps === null) {
      expect(result.criterionBranch, `${id}: silence`).toBe("os-input-review")
      expect(result.tests, `${id}: silence`).toEqual([
        {
          id: "review",
          status: "probe-todo",
          reason:
            "Open: our test received no usable reply to the mode query (DECRPM), and this run has no qualified control for that reply, so it cannot tell whether the mode works.",
        },
      ])
      expect(result.assertions ?? []).toEqual([])
    } else if (ps === 3) {
      expect(result.observation?.outcome).toBe("inconclusive")
      expect(result.tests).toEqual(expect.arrayContaining([expect.objectContaining({ status: "probe-todo" })]))
      expect(result.assertions ?? []).toEqual([])
      expect(result.note).toContain(facet)
    } else {
      expect(result.observation, `${id}: Ps ${ps}`).toMatchObject({
        outcome: ps === 1 ? "supported" : "unsupported",
        assertionType: "query_reply",
        note: expect.stringContaining(facet),
      })
      expect(result.note).toContain(facet)
      expect(result.assertions).toMatchObject([
        { assertionType: "query_reply", kind: ps === 1 ? "positive" : "negative" },
      ])
      expect(JSON.parse(result.response!)).toMatchObject({ setReply: reply, resetReply })
    }
    expect(queries).toEqual(Array.from({ length: ps === null && mode === 5 ? 4 : 2 }, () => `\x1b[?${mode}$p`))
    // Exact source reviews use buffer_state; real replies above retain their
    // query_reply observation and assertions through the dynamic declaration.
    expect(definition.libAssertionType).toBeUndefined()
  }
})

function captureSource(
  rows: number,
  cols: number,
  writes: string[],
  frames: ObservationFrame[],
  fresh = true,
  kind: "pixels" | "text-cells" = "pixels",
  restoresPrimary = true,
): TermProbeSource {
  const source: TermProbeSource = {
    kind: "live",
    rows,
    cols,
    write: (bytes: string) => writes.push(bytes),
    queryCursorPosition: async () => ({ row: 1, col: 1 }),
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
    captureGeometry: {
      geometry: { cellWidth: 10, cellHeight: 20, textWidth: cols * 10, textHeight: rows * 20 },
      source: "measured by complete raster calibration",
    },
    capture: async ({ role, label, cells, pixelGeometry }) => {
      // Constructed pixel-equivalence planes exercise callback wiring, not font or terminal support.
      // Witness values come from the glyph actually written outside each deciding crop.
      const witness = fresh ? (writes.filter((entry) => /^\x1b\[\d+;\d+H.$/.test(entry)).at(-1) ?? "blank") : "stale"
      const palette = label.includes("colors")
      const sgr = /xt(push|pop)sgr/.test(label)
      const restoration = /alt-screen\.exit|altscreen-47|altscreen-1047/.test(label)
      let plane = "stable"
      if (/paint witness|— baseline/.test(label)) plane = witness
      else if (label.includes("post-sequence target") || label.endsWith("expected frame")) {
        plane =
          restoration && !restoresPrimary && label.includes("post-sequence target")
            ? "seed"
            : palette
              ? "blue"
              : "expected"
      } else if (label.endsWith("setup reference frame")) plane = "blue"
      else if (label.endsWith("ignored-attribute frame")) plane = palette ? "green" : sgr ? "italic" : "seed"
      else if (label.endsWith("pre-edit seed")) {
        plane = palette
          ? "blue"
          : restoration && label.includes("altscreen-47")
            ? "expected"
            : sgr && writes.some((entry) => entry.includes("\x1b[1;3m"))
              ? "bold-italic"
              : "seed"
      }
      const frame = {
        role,
        label,
        capturedAt: frames.length + 1,
        ref: `sha256:${(frames.length + 1).toString(16).padStart(64, "0")}`,
        ...(cells &&
          pixelGeometry && {
            kind: "pixels" as const,
            regionDigest: plane,
            pixelsDigest: `whole:${plane}`,
            regionRectangle: {
              x: (cells.left - 1) * pixelGeometry.cellWidth,
              y: (cells.top - 1) * pixelGeometry.cellHeight,
              width: (cells.right - cells.left + 1) * pixelGeometry.cellWidth,
              height: (cells.bottom - cells.top + 1) * pixelGeometry.cellHeight,
            },
          }),
      }
      frames.push(frame)
      return frame
    },
  }
  if (kind === "text-cells") {
    const capture = source.capture!
    source.cells = async (request) => {
      const frame = await capture({
        ...request,
        pixelGeometry: { cellWidth: 10, cellHeight: 20, textWidth: cols * 10, textHeight: rows * 20 },
      })
      if (!request.cells || !frame.regionDigest || !frame.pixelsDigest) throw new Error("Missing fixture cell read")
      return {
        kind: "text-cells",
        role: frame.role,
        label: frame.label,
        capturedAt: frame.capturedAt,
        ref: frame.ref,
        cellDigest: frame.regionDigest,
        frameDigest: frame.pixelsDigest,
        cellRectangle: request.cells,
      }
    }
    source.capture = undefined
    source.captureGeometry = undefined
    source.captureKind = "text-cells"
  }
  return source
}

// Raw 0x85 must not be confused with a replacement character after UTF-8 decoding.
// The reply-only mode suite cannot witness same-position clicks or restoration.
test(
  "App UTF8 mouse uses sensitive raw coordinates, reset controls and restored size",
  { timeout: 15_000 },
  async () => {
    const definition = modesProbes.find((entry) => entry.id === "modes.utf8-mouse-1005")!
    for (const mutation of [
      "working",
      "intermediate",
      "legacy",
      "utf8-both",
      "wrong-position",
      "ordinary-sensitive",
      "ordinary-zero",
      "reset-report",
      "restore-failed",
      "missing-key",
      "unchanged",
      "missing-size",
    ] as const) {
      const modes = new Set<number>()
      let cols = 61
      let pending = Buffer.alloc(0)
      let finish: (() => void) | undefined
      let responsePattern: RegExp | undefined
      const actions: string[] = []
      const source = replayTermProbeSource(new Map(), {
        write: (bytes) => {
          for (const match of bytes.matchAll(/\x1b\[\?(\d+)([hl])/g)) {
            if (match[2] === "h") modes.add(Number(match[1]))
            else modes.delete(Number(match[1]))
          }
        },
        query: async (_sequence, pattern) => {
          const measured = cols
          if (mutation === "intermediate" && cols === 80) cols = 107
          return mutation === "missing-size" && cols === 107 ? null : pattern.exec(`\x1b[8;24;${measured}t`)
        },
        queryOutcome: async (_sequence, pattern) => {
          pending = Buffer.alloc(0)
          responsePattern = pattern
          await new Promise<void>((resolve) => {
            finish = resolve
          })
          const raw = pending.toString()
          return { raw, rawBase64: pending.toString("base64"), match: pattern.exec(raw), reason: "reply" }
        },
        input: {
          resizeWindow: async (width: number, _height: number) => {
            cols = mutation === "unchanged" || (width === 800 && mutation !== "restore-failed") ? 61 : 107
            if (mutation === "intermediate" && width !== 800) cols = 80
            return { width: 800, height: 600 }
          },
          injectClick: async (_button, position) => {
            actions.push(`click:${position?.x},${position?.y}`)
            if (!modes.has(1000) && mutation !== "reset-report") return
            if (modes.has(1006)) {
              const x =
                position?.x === 400
                  ? mutation === "ordinary-sensitive"
                    ? 101
                    : mutation === "ordinary-zero"
                      ? 0
                      : 32
                  : 101
              pending = Buffer.from(`\x1b[<0;${mutation === "wrong-position" ? 50 : x};10M\x1b[<0;${x};10m`)
            } else {
              const utf8 = mutation === "utf8-both" || (modes.has(1005) && mutation !== "legacy")
              const coordinate = utf8 ? [0xc2, 0x85] : [0x85]
              pending = Buffer.from([27, 91, 77, 32, ...coordinate, 42, 27, 91, 77, 35, ...coordinate, 42])
            }
            if (responsePattern?.test(pending.toString())) finish?.()
          },
          injectKey: async () => {
            actions.push("key")
            if (mutation !== "missing-key") pending = Buffer.concat([pending, Buffer.from("a")])
            finish?.()
          },
        },
      })
      const result = await definition.term!(source)
      if (mutation === "working" || mutation === "intermediate" || mutation === "legacy") {
        expect(result.observation?.outcome, mutation).toBe(mutation === "legacy" ? "unsupported" : "supported")
        expect(actions.slice(0, 2), mutation).toEqual(["click:400,300", "click:1300,120"])
      } else {
        expect(result.tests, mutation).toEqual(
          expect.arrayContaining([expect.objectContaining({ status: "probe-invalid" })]),
        )
      }
      expect(modes.has(1000)).toBe(false)
      expect(modes.has(1005)).toBe(false)
      expect(modes.has(1006)).toBe(false)
      expect(cols, mutation).toBe(mutation === "restore-failed" ? 107 : 61)
      if (mutation === "unchanged") {
        expect(result.note).toContain("this window is 61 columns wide, so no click here can separate them")
      }
    }
    expect(definition.termNeedsDisposable).toBe(true)
  },
)

const modes = [{ id: "modes.deccolm", number: 3 }] as const

// These four claims require settable protocol state, not the old recognition-only Ps 2.
// Existing query-only cases never checked the snapshot, DECSET result or restoration.
// The old shared-tail assertion also accepted other modes' unmeasured facets.
// Keep the DECSCLM wording while checking each of the three corrected app tails.
test.each([
  [
    "modes.reverse-video",
    5,
    "presentation (inverted frame) unmeasured; protocol measured",
    ["tearing", "scroll cadence", "scheme-change"],
  ],
  [
    "modes.synchronized-output",
    2026,
    "presentation (tearing, scroll cadence) unmeasured; protocol measured",
    ["inverted frame", "scheme-change"],
  ],
  ["modes.decsclm", 4, "presentation (tearing, scroll cadence, inverted frame) unmeasured; protocol measured", []],
  [
    "modes.color-scheme-reporting",
    2031,
    "scheme-change report (CSI ? 997 ; Ps n, unsolicited) unmeasured; recognition measured; the separate CSI ? 996 n query is unmeasured here",
    ["presentation", "inverted frame", "tearing"],
  ],
] as const)("%s grades protocol state and restores only a reset snapshot", async (id, mode, facet, irrelevant) => {
  const definition = modesProbes.find((entry) => entry.id === id)!
  for (const [snapshot, enabled, outcome] of [
    [2, 2, "unsupported"],
    [1, null, "supported"],
    [3, null, "supported"],
    [0, null, "unsupported"],
    [4, null, "unsupported"],
    [2, 1, "supported"],
    [2, 3, "supported"],
    [null, null, null],
    [2, null, null],
  ] as const) {
    const events: string[] = []
    const replies = [snapshot, enabled]
    const context = captureSource(24, 80, [], [])
    context.write = (bytes) => {
      events.push(bytes)
    }
    context.queryWithSentinel = async (sequence, pattern) => {
      events.push(sequence)
      const ps = replies.shift()
      return ps == null ? null : pattern.exec(`\x1b[?${mode};${ps}$y`)
    }
    const missingReverseReader = id === "modes.reverse-video" && (snapshot === null || snapshot === 0)
    // This protocol-only context has no effect pixels; the state-derived App
    // regression above owns the newly authorized null/Ps0 capture path.
    if (missingReverseReader) context.capture = undefined
    const result = await definition.term!(context)
    expect(events).toEqual(
      snapshot === 2 ? [`\x1b[?${mode}$p`, `\x1b[?${mode}h`, `\x1b[?${mode}$p`, `\x1b[?${mode}l`] : [`\x1b[?${mode}$p`],
    )
    if (missingReverseReader) {
      expect(result.observation).toBeUndefined()
      expect(result.tests).toEqual([
        expect.objectContaining({ status: "probe-invalid", reason: expect.stringContaining("owned pixel readback") }),
      ])
    } else if (mode === 2026 && snapshot === 2 && enabled === 2) {
      // The retained Alacritty after-set Ps 2 reply took 140 ms; it cannot witness the enabled update.
      expect(result.observation).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      expect(result.response).toBe('{"snapshot":2,"afterSet":2}')
      expect(result.tests).toEqual([
        { id: "criterion", status: "probe-invalid", reason: expect.stringContaining("set-state control unobservable") },
      ])
    } else if (outcome === null) {
      expect(result.observation).toBeUndefined()
      expect(result.tests).toEqual([{ id: "criterion", status: "probe-todo", reason: "no DECRPM reply" }])
    } else {
      expect(result.observation).toMatchObject({ outcome, assertionType: "query_reply" })
      expect(result.note).toContain(facet)
      for (const other of irrelevant) expect(result.note).not.toContain(other)
      if (snapshot === 2 && enabled === 2) {
        expect(result.note).toContain("recognized but DECSET refused (mode kept reset)")
      }
    }
  }
  expect(definition.termWrites).toBeUndefined()
  expect(definition.termNeedsDisposable).toBe(true)
})

// Ask 3: size replies or an owned width frame decide silent/Ps0 DECCOLM.
// The protocol matrix never exercised either effect or its controls.
test.each([null, 0] as const)("App DECCOLM reads controlled size replies after DECRPM %s", async (ps) => {
  const definition = modesProbes.find((entry) => entry.id === "modes.deccolm")
  if (!definition?.term) throw new Error("Missing App DECCOLM callback")
  for (const mutation of [undefined, "ignored", "reset-noop", "missing-size"] as const) {
    const { context, state } = cellWidthContext({
      width: 80,
      answers18t: true,
      ignoresMode: mutation === "ignored",
      ignoresReset: mutation === "reset-noop",
    })
    let reads = 0
    const result = await definition.term(
      replayTermProbeSource(new Map(), {
        cols: 80,
        rows: 24,
        write: (bytes) => context.feed(bytes),
        queryCursorPosition: async () => {
          throw new Error("A cursor reply is not a width reader")
        },
        queryWithSentinel: async (query, pattern) => {
          if (query === "\x1b[?3$p") return ps === null ? null : pattern.exec("\x1b[?3;0$y")
          expect(query).toBe("\x1b[18t")
          if (mutation === "missing-size" && ++reads === 2) return null
          return pattern.exec(context.feedCapture(query))
        },
      }),
    )
    if (mutation === "reset-noop" || mutation === "missing-size") {
      expect(result.observation?.outcome).not.toBe("supported")
      expect(result.observation?.outcome).not.toBe("unsupported")
      expect(result.tests).toEqual(expect.arrayContaining([expect.objectContaining({ status: "probe-invalid" })]))
    } else {
      expect(result.observation?.outcome, mutation ?? "working width change").toBe(
        mutation ? "unsupported" : "supported",
      )
      if (ps === 0) expect(result.note).toContain("Ps 0")
      expect(state.width).toBe(80)
    }
  }
  expect(definition.termNeedsDisposable).toBe(true)
  expect(definition.termWrites).toBeUndefined()
})

test.each([null, 0] as const)("App DECCOLM reads controlled width frames after DECRPM %s", async (ps) => {
  const definition = modesProbes.find((entry) => entry.id === "modes.deccolm")
  if (!definition?.term) throw new Error("Missing App DECCOLM callback")
  const stored = new Map<string, StoredQuery>()
  if (ps === 0) stored.set("\x1b[?3$p", { sequence: "\x1b[?3$p", match: null, reason: "reply", raw: "\x1b[?3;0$y" })
  for (const mutation of [undefined, "deccolm-noop", "wrap-noop"] as const) {
    const surface = createSemanticSurface({ cols: 80, rows: 5, mutations: mutation ? [mutation] : [] })
    let sequence = 0
    const source = replayTermProbeSource(stored, {
      cols: 80,
      rows: 5,
      write: (bytes) => surface.feed(bytes),
      captureKind: "pixels",
      captureGeometry: {
        geometry: { cellWidth: 10, cellHeight: 20, textWidth: 800, textHeight: 100 },
        source: "measured by complete raster calibration",
      },
      queryCursorPosition: async () => {
        const p = surface.getCursor()
        return { row: p.y + 1, col: p.x + 1 }
      },
      capture: async (request) => {
        if (!request.cells || !request.pixelGeometry) throw new Error("Width frame needs its measured crop")
        const text = (rectangle: CaptureCells) =>
          Array.from({ length: rectangle.bottom - rectangle.top + 1 }, (_, row) =>
            Array.from(
              { length: rectangle.right - rectangle.left + 1 },
              (_, col) => surface.getCell(rectangle.top - 1 + row, rectangle.left - 1 + col).char,
            ).join(""),
          ).join("\n")
        return {
          kind: "pixels",
          role: request.role,
          label: request.label,
          capturedAt: ++sequence,
          ref: `sha256:${sequence.toString(16).padStart(64, "0")}`,
          regionDigest: text(request.cells),
          pixelsDigest: text({ top: 1, left: 1, bottom: 5, right: 80 }),
          regionRectangle: {
            x: (request.cells.left - 1) * 10,
            y: (request.cells.top - 1) * 20,
            width: (request.cells.right - request.cells.left + 1) * 10,
            height: (request.cells.bottom - request.cells.top + 1) * 20,
          },
        }
      },
    })
    const result = await definition.term(source)
    const recorded = recordExecutedProbe({
      featureId: definition.id,
      attempt: { scope: "probe", startedAt: new Date().toISOString() },
      tests: result.tests,
      observation: result.observation ? { featureId: definition.id, ...result.observation } : undefined,
      assertions: (result.assertions ?? []).map((a) => ({ featureId: definition.id, ...a })),
    })
    if (mutation === "wrap-noop") expect(["probe-invalid", "probe-todo"]).toContain(recorded.status)
    else {
      expect(
        recorded.status,
        JSON.stringify({ mutation, reason: recorded.reason, tests: result.tests, notTested: result.notTested }),
      ).toBe(mutation ? "unsupported" : "supported")
    }
    if (ps === 0 && !mutation) expect(result.note).toContain("Ps 0")
  }
  const missing = await definition.term(replayTermProbeSource(stored))
  expect(missing.tests).toEqual(expect.arrayContaining([expect.objectContaining({ status: "probe-invalid" })]))
  expect(definition.termNeedsGeometry).toBe(true)
})

function headlessDeccolm(): (ctx: LibProbeSource) => ProbeCallbackResult {
  const definition = modesProbes.find((entry) => entry.id === "modes.deccolm")
  if (!definition?.lib) throw new Error("Missing headless DECCOLM callback")
  return definition.lib
}

/**
 * A four-state cell model. Width moves only when ?40 is open, unless `honoursModeWithoutGate`
 * says the engine ignores the gate; `ignoresMode` is an engine that accepts the mode and does not
 * move; `replyWidth` makes a silent `18 t` answer with a width of its own, and `replies` scripts each
 * `18 t` answer in call order. `stickyGate` ignores ?40l once ?40 was opened; `wideWidth` is the
 * width ?3h sets.
 */
function cellWidthContext(options: {
  width: 80 | 132
  wrap?: boolean
  ignoresMode?: boolean
  ignoresReset?: boolean
  honoursModeWithoutGate?: boolean
  decrpm?: string
  replyWidth?: number
  answers18t?: boolean
  replies?: Array<number | null>
  stickyGate?: boolean
  wideWidth?: number
}) {
  const state = { width: options.width as number, gate: false, cursor: { x: 0, y: 0 }, writes: [] as string[] }
  let replyCall = 0
  const context = {
    cols: options.width,
    getCursor: () => ({ ...state.cursor, visible: true, style: null }),
    feed(text: string) {
      state.writes.push(text)
      for (const match of text.matchAll(/\x1b\[\?(\d+)([hl])/g)) {
        const on = match[2] === "h"
        if (match[1] === "40") state.gate = on || (options.stickyGate === true && state.gate)
        if (
          match[1] === "3" &&
          !options.ignoresMode &&
          !(options.ignoresReset && !on) &&
          (state.gate || options.honoursModeWithoutGate)
        ) {
          state.width = on ? (options.wideWidth ?? 132) : 80
        }
      }
      if (text.includes("\x1b[2J")) state.cursor = { x: 0, y: 0 }
      for (const _char of text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")) {
        if (state.cursor.x >= state.width - 1) {
          if (options.wrap ?? true) state.cursor = { x: 0, y: state.cursor.y + 1 }
          else state.cursor.x = state.width - 1
        } else {
          state.cursor.x += 1
        }
      }
    },
    feedCapture(sequence: string) {
      state.writes.push(sequence)
      if (sequence !== "\x1b[18t") return options.decrpm ?? ""
      if (options.replies) {
        const width = options.replies[replyCall++]
        return width === null || width === undefined ? "" : `\x1b[8;24;${width}t`
      }
      if (options.answers18t) return `\x1b[8;24;${state.width}t`
      return options.replyWidth === undefined ? "" : `\x1b[8;24;${options.replyWidth}t`
    },
  } as unknown as LibProbeSource
  return { context, state }
}

test("DECCOLM cell width moves 80 -> 132 -> 80 with ?40 honoured", () => {
  const { context, state } = cellWidthContext({ width: 80 })
  const result = headlessDeccolm()(context)
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  expect(result.assertions).toEqual(
    expect.arrayContaining([expect.objectContaining({ assertionType: "buffer_state", kind: "positive" })]),
  )
  const wire = state.writes.join("")
  // The enabling change follows ?40h; the first ?3h is gate control A, sent with ?40 closed.
  expect(wire).toContain("\x1b[?40h\x1b[?3h")
  expect(state.width).toBe(80)
})

// Successful cleanup cannot catch a throw after a mode set, especially the final closed-gate sweep.
test.each([
  { width: 80, failure: "gateAfter" },
  { width: 132, failure: "gateAfter" },
  { width: 80, failure: "enabled18t" },
  { width: 132, failure: "enabled18t" },
] as const)("DECCOLM restores initial $width after $failure throws", ({ width, failure }) => {
  const { context, state } = cellWidthContext({ width })
  let reads = 0
  const cursor = context.getCursor.bind(context)
  const capture = context.feedCapture.bind(context)
  context.getCursor = () => {
    if (failure === "gateAfter" && ++reads === 5) throw new Error("width readback failed")
    return cursor()
  }
  context.feedCapture = (query) => {
    if (failure === "enabled18t" && query === "\x1b[18t" && ++reads === 2) throw new Error("width readback failed")
    return capture(query)
  }
  expect(() => headlessDeccolm()(context)).toThrow("width readback failed")
  expect(state.width).toBe(width)
  expect(state.gate).toBe(true)
  expect(state.writes.at(-1)).toBe(`${width === 132 ? "\x1b[?3h" : "\x1b[?3l"}\x1b[?40h`)
})

// cee6d003: re-seed before every sweep, and only the 133rd X proves W=132.
test("DECCOLM re-seeds before each of its five 133-X sweeps and runs gate control A before ?40 opens", () => {
  const { context, state } = cellWidthContext({ width: 80 })
  const result = headlessDeccolm()(context)
  expect(result.observation).toMatchObject({ outcome: "supported" })
  const sweeps = state.writes.flatMap((write, index) => (/^X+$/.test(write) ? [index] : []))
  expect(sweeps).toHaveLength(5)
  for (const index of sweeps) {
    expect(state.writes[index]).toBe("X".repeat(133))
    expect(state.writes[index - 1]).toContain("\x1b[2J\x1b[H")
  }
  const wire = state.writes.join("")
  const closed = wire.indexOf("\x1b[?40l")
  const firstChange = wire.indexOf("\x1b[?3h")
  const opened = wire.indexOf("\x1b[?40h")
  expect(closed).toBeLessThan(firstChange)
  expect(firstChange).toBeLessThan(opened)
  expect(wire.slice(firstChange, opened)).toContain("X".repeat(133))
  expect(result.assertions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "positive",
        expected: expect.stringContaining("before and after the transition"),
        observed: result.response,
      }),
    ]),
  )
})

test("DECCOLM names a no-wrap reading after the change as the 133rd X not wrapping, never 132", () => {
  const { context } = cellWidthContext({ width: 80, wideWidth: 140 })
  const result = headlessDeccolm()(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", note: "133rd X did not wrap" })
  expect(result.tests).toMatchObject([
    expect.objectContaining({ status: "probe-invalid", reason: expect.stringContaining('"x":133,"y":0') }),
  ])
})

test("DECCOLM cell width moves 132 -> 80 -> 132 with ?40 honoured", () => {
  const { context, state } = cellWidthContext({ width: 132 })
  const result = headlessDeccolm()(context)
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  expect(state.width).toBe(132)
})

test("DECCOLM grades a no-change by an engine that accepted the mode as unsupported", () => {
  const { context } = cellWidthContext({ width: 80, ignoresMode: true, decrpm: "\x1b[?3;2$y" })
  const result = headlessDeccolm()(context)
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
  expect(result.tests).toBeUndefined()
})

test("DECCOLM names a set that moved width but a reset that did not restore it", () => {
  const { context } = cellWidthContext({ width: 80, ignoresReset: true })
  const result = headlessDeccolm()(context)
  expect(result.observation).toMatchObject({
    outcome: "unsupported",
    note: expect.stringContaining("set moved width to 132, reset did not restore 80"),
  })
})

test.each([0, 4] as const)("DECCOLM grades unchanged measured width unsupported at DECRPM Ps %i", (ps) => {
  const { context } = cellWidthContext({ width: 80, ignoresMode: true, decrpm: `\x1b[?3;${ps}$y` })
  const result = headlessDeccolm()(context)
  expect(result.observation).toMatchObject({
    outcome: "unsupported",
    assertionType: "buffer_state",
    note: expect.stringContaining(
      `DECRPM mode 3 reads ${ps === 0 ? "not recognized" : "permanently reset"} (Ps ${ps})`,
    ),
  })
  expect(result.tests).toBeUndefined()
  expect(result.assertions).toMatchObject([
    expect.objectContaining({
      kind: "negative",
      expected: expect.stringContaining("with ?40 honoured"),
      observed: result.response,
    }),
  ])
})

test("DECCOLM grades a measured move supported and names a refusing DECRPM reading beside it", () => {
  const { context } = cellWidthContext({ width: 80, decrpm: "\x1b[?3;0$y" })
  const result = headlessDeccolm()(context)
  expect(result.observation).toMatchObject({
    outcome: "supported",
    note: expect.stringContaining("DECRPM mode 3 reads not recognized (Ps 0) while the sweep measured 80 -> 132 -> 80"),
  })
})

test("DECCOLM names autowrap off rather than claiming a width", () => {
  const { context } = cellWidthContext({ width: 80, wrap: false })
  const result = headlessDeccolm()(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", note: "autowrap off" })
  expect(result.tests).toMatchObject([
    expect.objectContaining({ status: "probe-invalid", reason: expect.stringContaining("autowrap off") }),
  ])
})

test("DECCOLM refuses an initial width outside 80/132 instead of rounding it", () => {
  const { context } = cellWidthContext({ width: 100 as 80, ignoresMode: true })
  const result = headlessDeccolm()(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", note: "initial width outside 80/132" })
  expect(result.tests).toMatchObject([
    expect.objectContaining({
      status: "probe-invalid",
      reason: expect.stringContaining('initial width outside 80/132: {"kind":"unmeasured"'),
    }),
  ])
})

test.each([
  ["before the transition", { honoursModeWithoutGate: true }, "gateBefore"],
  ["after the transition", { stickyGate: true }, "gateAfter"],
] as const)(
  "DECCOLM records a mode that moves the width with ?40 closed %s as the gate not holding",
  (_when, gate, phase) => {
    const { context } = cellWidthContext({ width: 80, ...gate })
    const result = headlessDeccolm()(context)
    expect(result.observation).toMatchObject({ outcome: "inconclusive", note: "gate not honoured" })
    expect(result.assertions).toEqual([
      expect.objectContaining({ assertionType: "buffer_state", kind: "negative", observed: result.response }),
    ])
    expect(JSON.parse(result.response!)).toMatchObject({ [phase]: { width: 132 } })
    expect(result.tests).toMatchObject([
      expect.objectContaining({ status: "probe-invalid", reason: expect.stringContaining(`"${phase}"`) }),
    ])
  },
)

test("DECCOLM treats an answering 18t that disagrees with the sweep as a failure", () => {
  const { context } = cellWidthContext({ width: 80, ignoresMode: true, replyWidth: 100 })
  const result = headlessDeccolm()(context)
  expect(result.observation).toBeUndefined()
  expect(result.tests).toMatchObject([
    expect.objectContaining({ status: "probe-invalid", reason: "18t/sweep disagreement W=80 vs 100 (initial)" }),
  ])
})

test("DECCOLM compares the restored 18t with the restored sweep too", () => {
  const { context } = cellWidthContext({ width: 80, replies: [80, 132, 132] })
  const result = headlessDeccolm()(context)
  expect(result.observation).toBeUndefined()
  expect(result.tests).toMatchObject([
    expect.objectContaining({ status: "probe-invalid", reason: "18t/sweep disagreement W=80 vs 132 (restored)" }),
  ])
})

test("DECCOLM lets an answering 18t that agrees corroborate the sweep", () => {
  const { context } = cellWidthContext({ width: 80, answers18t: true })
  const result = headlessDeccolm()(context)
  expect(result.observation).toMatchObject({ outcome: "supported" })
})

test("DECCOLM keeps an adapter with no cell-width readback as a test todo", () => {
  const context = { cols: 80, feed() {}, feedCapture: () => "" } as unknown as LibProbeSource
  const result = headlessDeccolm()(context)
  expect(result.notTested).toMatchObject({ noObservable: "no cell-width readback" })
  expect(result.tests).toMatchObject([
    expect.objectContaining({ status: "probe-todo", reason: expect.stringContaining("no cell-width readback") }),
  ])
})

test.each(["bad-start", "ignored-move", "ignored-restore", "restored"] as const)(
  "1048 qualifies cursor setup before grading %s",
  (scenario) => {
    const definition = modesProbes.find((item) => item.id === "modes.altscreen-1048")
    if (!definition?.lib) throw new Error("Missing headless cursor-save callback")
    const writes: string[] = []
    let cursor = { x: 0, y: 0 }
    const context = {
      cols: 20,
      getScrollback: () => ({ viewportOffset: 0, totalLines: 15, screenLines: 15 }),
      feed(sequence: string) {
        writes.push(sequence)
        if (sequence === "\x1b[5;10H" && scenario !== "bad-start") cursor = { x: 9, y: 4 }
        if (sequence === "\x1b[15;20H" && scenario !== "ignored-move") cursor = { x: 19, y: 14 }
        if (sequence === "\x1b[?1048l" && scenario === "restored") cursor = { x: 9, y: 4 }
      },
      getCursor: () => ({ ...cursor, visible: true, style: null }),
    } as unknown as LibProbeSource
    const result = definition.lib(context)
    const outcome =
      scenario === "restored" ? "supported" : scenario === "ignored-restore" ? "unsupported" : "inconclusive"
    expect(result.observation, scenario).toMatchObject({ outcome, assertionType: "buffer_state" })
    if (outcome === "inconclusive") expect(result.assertions, scenario).toBeUndefined()
    else {
      expect(result.assertions, scenario).toMatchObject([{ kind: outcome === "supported" ? "positive" : "negative" }])
      expect(JSON.parse(result.response!), scenario).toMatchObject({
        before: { x: 9, y: 4 },
        displaced: { x: 19, y: 14 },
      })
    }
    if (scenario === "bad-start") expect(writes).toEqual(["\x1b[5;10H"])
    else expect(writes.at(-1)).toBe("\x1b[?1048l")
  },
)

test("1048 refuses undersized geometry and restores after failed displacement readback", () => {
  const definition = modesProbes.find((item) => item.id === "modes.altscreen-1048")
  if (!definition?.lib) throw new Error("Missing headless cursor-save callback")
  const writes: string[] = []
  let rows = 14
  const context = {
    cols: 20,
    getScrollback: () => ({ viewportOffset: 0, totalLines: rows, screenLines: rows }),
    feed: (sequence: string) => writes.push(sequence),
    getCursor: () => {
      if (writes.includes("\x1b[15;20H")) throw new Error("readback failed")
      return { x: 9, y: 4, visible: true, style: null }
    },
  } as unknown as LibProbeSource
  expect(definition.lib(context).observation).toMatchObject({ outcome: "inconclusive" })
  expect(writes).toEqual([])
  rows = 15
  expect(() => definition.lib!(context)).toThrow("readback failed")
  expect(writes.at(-1)).toBe("\x1b[?1048l")
})

test("IRM grades measured insertion despite false mode metadata and distinguishes replacement from bad setup", () => {
  const definition = modesProbes.find((item) => item.id === "modes.insert-replace")
  if (!definition?.lib) throw new Error("Missing headless IRM callback")
  for (const [target, outcome] of [
    ["XABC", "supported"],
    ["XBC ", "unsupported"],
    ["XAB ", "inconclusive"],
  ] as const) {
    const feeds: string[] = []
    let phase = "empty"
    const context = {
      cols: 4,
      getScrollback: () => ({ viewportOffset: 0, totalLines: 1, screenLines: 1 }),
      getMode: () => false,
      getCursor: () => ({ x: phase === "seed" ? 3 : 0, y: 0, visible: true, style: null }),
      feed: (sequence: string) => {
        feeds.push(sequence)
        if (sequence.includes("ABC")) phase = "seed"
        else if (sequence === "\x1b[1;1H") phase = "origin"
        else if (sequence === "X") phase = "target"
      },
      getCell: (_row: number, col: number) => ({ char: (phase === "target" ? target : "ABC ")[col] ?? "" }),
    } as unknown as LibProbeSource
    const result = definition.lib(context)
    expect(result.observation, target).toMatchObject({ outcome, assertionType: "buffer_state" })
    expect(feeds.at(-1), target).toBe("\x1b[4l")
    if (outcome === "inconclusive") expect(result.assertions, target).toBeUndefined()
    else expect(result.assertions, target).toMatchObject([{ kind: outcome === "supported" ? "positive" : "negative" }])
  }
})

test("IRM does not grade output when the seed was not measured", () => {
  const definition = modesProbes.find((item) => item.id === "modes.insert-replace")
  if (!definition?.lib) throw new Error("Missing headless IRM callback")
  const feeds: string[] = []
  const context = {
    cols: 4,
    getScrollback: () => ({ viewportOffset: 0, totalLines: 1, screenLines: 1 }),
    getCursor: () => ({ x: 0, y: 0, visible: true, style: null }),
    feed: (sequence: string) => feeds.push(sequence),
    getCell: () => ({ char: " " }),
  } as unknown as LibProbeSource
  const result = definition.lib(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(result.assertions).toBeUndefined()
  expect(feeds).not.toContain("\x1b[4h")
  expect(feeds).not.toContain("X")
})

test("unmeasured app modes leave prior state untouched instead of toggling it for CPR", async () => {
  for (const id of ["modes.left-right-margin", "modes.altscreen-47", "modes.altscreen-1047"]) {
    const definition = modesProbes.find((item) => item.id === id)
    if (!definition?.term) throw new Error(`Missing ${id} app callback`)
    if (id === "modes.altscreen-1047") expect(definition.termAssertionType).toBe("query_reply")
    for (const ps of [null, 0, 1, 2, 3, 4] as const) {
      const queried: string[] = []
      const unexpected = (): never => {
        throw new Error(`${id}: no state write or CPR is a feature measurement`)
      }
      const context = {
        write: unexpected,
        queryCursorPosition: unexpected,
        queryMode: unexpected,
        queryWithSentinel: async (sequence: string, pattern: RegExp) => {
          queried.push(sequence)
          return ps === null ? null : pattern.exec(`\x1b[?1047;${ps}$y`)
        },
      } as unknown as TermProbeSource
      const result = await definition.term(context)
      // The app arms without a behavior oracle are execution-only TODOs. The 1047 DECRPM
      // fallback still grades its retained protocol reply.
      const permanent = id === "modes.altscreen-1047" && ps === 4
      if (id !== "modes.altscreen-1047") {
        expect(result.observation, `${id}:${ps}`).toBeUndefined()
        expect(result.assertions, `${id}:${ps}`).toBeUndefined()
        expect(result.tests, `${id}:${ps}`).toMatchObject([
          expect.objectContaining({ status: "probe-todo", reason: expect.any(String) }),
        ])
      } else if (ps === null) {
        expect(result.observation, `${id}:${ps}`).toBeUndefined()
        expect(result.tests, `${id}:${ps}`).toMatchObject([
          expect.objectContaining({ status: "probe-invalid", reason: expect.stringContaining("DECRPM") }),
        ])
      } else if (ps === 0) {
        expect(result.observation, `${id}:${ps}`).toMatchObject({
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          assertionType: "query_reply",
        })
        expect(result.assertions ?? [], `${id}:${ps}`).toEqual([])
      } else if (permanent) {
        expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "query_reply" })
        expect(result.response).toBe("permanently reset (Ps 4)")
        expect(result.assertions, id).toMatchObject([{ kind: "negative", observed: "permanently reset (Ps 4)" }])
      } else {
        expect(result.assertions ?? [], id).toEqual([])
      }
      expect(queried, id).toEqual(id === "modes.altscreen-1047" ? ["\x1b[?1047$p"] : [])
    }
  }
})

test("app cursor replies and mode recognition do not prove alternate-buffer behavior", async () => {
  for (const id of ["modes.alt-screen.exit", "modes.insert-replace", "modes.altscreen-1047"]) {
    const definition = modesProbes.find((entry) => entry.id === id)
    if (!definition?.term) throw new Error(`Missing ${id} app callback`)
    const context: TermProbeSource = {
      kind: "live",
      cols: 80,
      rows: 24,
      write() {},
      queryCursorPosition: async () => ({ row: 3, col: 3 }),
      measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
      query: async () => null,
      // Private DECRQM answers "set" (Ps 1); the ANSI IRM query stays unanswered, so IRM keeps its cell fixture.
      queryWithSentinel: async (sequence, pattern) => {
        const mode = /^\x1b\[\?(\d+)\$p$/.exec(sequence)?.[1]
        return mode === undefined ? null : pattern.exec(`\x1b[?${mode};1$y`)
      },
      queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
      queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
      queryMode: async () => "set",
    }
    const result = await definition.term(context)
    expect(result.observation, id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      assertionType: "query_reply",
    })
    expect(result.assertions ?? [], id).toEqual([])
  }
})

test.each(modes)("$id preserves known DECRPM replies and rejects a missing effect reader", async ({ id, number }) => {
  const definition = modesProbes.find((probe) => probe.id === id)
  if (!definition?.term) throw new Error(`Missing app callback for ${id}`)

  // The app arm reads the DECRPM reply itself (queryWithSentinel plus the shared parser), never the folded
  // queryMode word, so Ps 4 cannot hide behind "reset" (#30557).
  for (const ps of [0, null, 1, 2, 3, 4] as const) {
    const queried: string[] = []
    const unexpected = (operation: string): never => {
      throw new Error(`${id}: unexpected ${operation} for Ps ${ps}`)
    }
    const context: TermProbeSource = {
      kind: "live",
      cols: 80,
      rows: 24,
      write: () => unexpected("write"),
      queryCursorPosition: async () => unexpected("CPR"),
      measureRenderedWidth: async () => unexpected("width query"),
      query: async () => unexpected("raw query"),
      queryWithSentinel: async (sequence, pattern) => {
        queried.push(sequence)
        return ps === null ? null : pattern.exec(`\x1b[?${number};${ps}$y`)
      },
      queryOutcome: async () => unexpected("query outcome"),
      queryWithSentinelOutcome: async () => unexpected("sentinel outcome"),
      queryMode: async () => unexpected("folded mode query"),
    }

    const result = await definition.term(context)
    expect(queried, `${id}: Ps ${ps}`).toEqual(
      ps === null || ps === 0 ? [`\x1b[?${number}$p`, "\x1b[18t"] : [`\x1b[?${number}$p`],
    )
    if (ps === null || ps === 0) {
      expect(result.pass).toBe(false)
      expect(result.observation).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      expect(result.tests).toMatchObject([
        expect.objectContaining({ status: "probe-invalid", reason: expect.stringContaining("owned width frame") }),
      ])
      if (ps === 0) expect(result.tests?.[0]?.reason).toContain("Ps 0")
    } else if (ps === 4) {
      expect(result.pass).toBe(false)
      expect(result.response).toBe("permanently reset (Ps 4)")
      expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "query_reply" })
      expect(result.observation?.note, `${id}: note must survive projection`).toMatch(/permanently reset \(Ps 4\)/)
      expect(result.assertions).toMatchObject([
        { kind: "negative", expected: `DECRPM mode ${number} can be set`, observed: "permanently reset (Ps 4)" },
      ])
    } else {
      const reading = ps === 1 ? "set (Ps 1)" : ps === 2 ? "reset (Ps 2)" : "permanently set (Ps 3)"
      expect(result.pass).toBe(true)
      expect(result.response).toBe(reading)
      expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
      expect(result.assertions).toMatchObject([{ kind: "positive", observed: reading }])
    }
  }
  expect(definition.termWrites).toBeUndefined()
  expect(definition.termNeedsDisposable).toBe(true)
  expect(definition.termAssertionType).toBe("query_reply")
})

test("DECAWM with null metadata rejects an ignored wrap", () => {
  const probe = modesProbes.find((item) => item.id === "modes.auto-wrap")
  if (!probe?.lib) throw new Error("missing auto-wrap callback")
  const writes: string[] = []
  const context = {
    cols: 4,
    getScrollback: () => ({ viewportOffset: 0, totalLines: 2, screenLines: 2 }),
    feed: (sequence: string) => writes.push(sequence),
    getMode: () => null,
    getCell: (row: number, col: number) => ({ char: row === 1 && col === 0 ? " " : "X" }),
  } as unknown as LibProbeSource
  const result = probe.lib(context)
  expect(result.observation).toMatchObject({
    outcome: "unsupported",
    assertionType: "buffer_state",
  })
  expect(writes).toContain("XXXXY")
  expect(writes).not.toContain("\x1b[?7l")
})

test("DECAWM refuses one-row geometry before a second-row read and enables its own fixture", () => {
  const probe = modesProbes.find((item) => item.id === "modes.auto-wrap")
  if (!probe?.lib) throw new Error("missing auto-wrap callback")
  const writes: string[] = []
  let rows = 1
  let enabled = false
  const context = {
    cols: 4,
    getScrollback: () => ({ viewportOffset: 0, totalLines: rows, screenLines: rows }),
    feed: (sequence: string) => {
      writes.push(sequence)
      if (sequence === "\x1b[?7h") enabled = true
      if (sequence === "\x1b[?7l") enabled = false
    },
    getMode: () => enabled,
    getCell: (row: number) => {
      throw new Error(`out-of-grid read ${row}`)
    },
  } as unknown as LibProbeSource
  const small = probe.lib(context)
  expect(small.observation).toMatchObject({ outcome: "inconclusive", assertionType: "buffer_state" })
  expect(writes).toEqual([])

  rows = 2
  context.getCell = (row: number, col: number) =>
    ({ char: row === 1 && col === 0 ? "Y" : "X" }) as ReturnType<LibProbeSource["getCell"]>
  const measured = probe.lib(context)
  expect(measured.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  expect(writes).toContain("\x1b[?7h")
  expect(writes.at(-1)).toBe("\x1b[?7l")
})

type Alt1049Scenario =
  | "roundtrip"
  | "ignored-entry"
  | "uncleared-entry"
  | "uncleared-exit"
  | "stale-exit"
  | "erasure-mimic"
  | "marker-leak"
  | "broken-exit"
  | "broken-cursor"
  | "readback-failure"
  | "cleanup-failure"
  | "constant-cursor"

/**
 * Minimal primary/alternate model: only the two seeded spans, the ALT marker and the cursor. `mode`
 * selects the private mode whose CSI ? h/l the model answers (1049 by default; ?47 and ?1047 share
 * the roundtrip, #30702). The model restores the parked cursor on every exit, so a ?47/?1047 grade
 * that changes under "broken-cursor" or "constant-cursor" would be grading a cursor it never saved.
 */
function alt1049Source(scenario: Alt1049Scenario, cols = 20, rows = 5, mode: 47 | 1047 | 1049 = 1049) {
  const enter = `\x1b[?${mode}h`
  const leave = `\x1b[?${mode}l`
  const writes: string[] = []
  const pad = (text: string) => (text + " ".repeat(cols)).slice(0, cols)
  const blank = " ".repeat(cols)
  const saved = { x: 6, y: 4 }
  let primaryA = blank
  let primaryB = blank
  let altA = blank
  let altB = blank
  let onAlt = false
  let entries = 0
  let cursor = { x: 0, y: 0 }
  const line = (row: number) =>
    onAlt ? (row === 0 ? altA : row === 2 ? altB : blank) : row === 0 ? primaryA : row === 2 ? primaryB : blank
  const context = {
    cols,
    getScrollback: () => ({ viewportOffset: 0, totalLines: rows, screenLines: rows }),
    feed(sequence: string) {
      writes.push(sequence)
      if (sequence === "\x1b[2J\x1b[1;1HPRIMARY-A") primaryA = pad("PRIMARY-A")
      else if (sequence === "\x1b[3;1HPRIMARY-B") primaryB = pad("PRIMARY-B")
      else if (sequence === "\x1b[5;7H") cursor = { ...saved }
      else if (sequence === enter) {
        if (scenario !== "ignored-entry") {
          onAlt = true
          cursor = { x: 0, y: 0 }
          entries += 1
          // An alternate buffer that keeps earlier content at the first entry: neither blank nor the
          // primary seed (a ?1047 exit clear leaves the second entry blank). An exit that did not clear
          // leaves the marker in place for the second entry to find; a partial clear leaves other content.
          if (scenario === "stale-exit" && entries > 1) {
            altA = pad("STALE-ALT")
            altB = pad("STALE-ALT")
          } else if (scenario !== "uncleared-exit" || entries === 1) {
            const stale = scenario === "uncleared-entry" && entries === 1
            altA = stale ? pad("STALE-ALT") : blank
            altB = stale ? pad("STALE-ALT") : blank
          }
        }
      } else if (sequence === "\x1b[1;1HALT-MARK") altA = pad("ALT-MARK")
      else if (sequence === leave) {
        if (scenario !== "broken-exit") {
          onAlt = false
          if (scenario === "erasure-mimic") {
            primaryA = blank
            primaryB = blank
          }
          if (scenario === "marker-leak") primaryA = pad("ALT-MARK")
          if (scenario !== "broken-cursor") cursor = { ...saved }
        }
      } else if (sequence === leave + "\x1b[0m") {
        if (scenario === "cleanup-failure") throw new Error("cleanup failed")
        onAlt = false
      }
    },
    getCell(row: number, col: number) {
      if (scenario === "readback-failure" && writes.length > 3) throw new Error("readback failed")
      const text = line(row)
      return { char: col < text.length ? text[col] : " " } as ReturnType<LibProbeSource["getCell"]>
    },
    getCursor: () =>
      scenario === "constant-cursor"
        ? { x: 0, y: 0, visible: true, style: null }
        : { ...cursor, visible: true, style: null },
  }
  return { context: context as unknown as LibProbeSource, writes }
}

function alt1049Probe(id: "enter" | "exit") {
  const definition = modesProbes.find((item) => item.id === `modes.alt-screen.${id}`)
  if (!definition?.lib) throw new Error(`Missing 1049 ${id} headless callback`)
  return definition
}

test("1049 enter grades only on the full roundtrip, with enter-specific defect controls", () => {
  const definition = alt1049Probe("enter")
  const ok = alt1049Source("roundtrip")
  expect(definition.lib!(ok.context).observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  const ignored = alt1049Source("ignored-entry")
  const ignoredResult = definition.lib!(ignored.context)
  expect(ignoredResult.observation).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
  expect(ignoredResult.assertions).toMatchObject([{ kind: "negative" }])
  for (const scenario of ["erasure-mimic", "broken-exit", "marker-leak", "broken-cursor"] as const) {
    const { context } = alt1049Source(scenario)
    const result = definition.lib!(context)
    expect(result.observation, scenario).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(result.assertions, scenario).toBeUndefined()
  }
  const clipped = alt1049Source("roundtrip", 6)
  const clippedResult = definition.lib!(clipped.context)
  expect(clippedResult.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(clipped.writes).toEqual([])
  expect(clippedResult.assertions).toBeUndefined()
  // Four rows cover the two seeds but not the row-4 saved pre-cursor; must refuse before feeding.
  const clippedRows = alt1049Source("roundtrip", 20, 4)
  const clippedRowsResult = definition.lib!(clippedRows.context)
  expect(clippedRowsResult.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(clippedRows.writes).toEqual([])
  expect(clippedRowsResult.assertions).toBeUndefined()
})

test("1049 exit concludes only the full roundtrip and keeps restoration defects inconclusive", () => {
  const definition = alt1049Probe("exit")
  const ok = alt1049Source("roundtrip")
  expect(definition.lib!(ok.context).observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  expect(ok.writes.at(-1)).toBe("\x1b[?1049l\x1b[0m")
  for (const scenario of ["erasure-mimic", "marker-leak", "broken-exit", "broken-cursor"] as const) {
    const { context } = alt1049Source(scenario)
    const result = definition.lib!(context)
    expect(result.observation, scenario).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(result.assertions, scenario).toBeUndefined()
  }
})

test("1049 exit after an unqualified entry is PROBE TODO: the entry is a missing prerequisite (@cto 84e7b78b)", () => {
  const definition = alt1049Probe("exit")
  const { context } = alt1049Source("ignored-entry")
  const result = definition.lib!(context)
  expect(result.notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable:
      "Open: switching to the alternate screen did not show, so we cannot tell whether switching back worked.",
  })
  expect(result.observation).toBeUndefined()
  expect(result.assertions).toBeUndefined()
})

// A vt100 source identity, kept to prove that no loaded source (pinned, moved, dirty or different) decides the
// ?1049 exit after an unqualified entry: source never grades (#32246, @cto batch7 A-F1 and 84e7b78b).
const VT100_SOURCE_IDENTITY = {
  kind: "js",
  adapterVersion: "0.10.2",
  termlessRevision: "d5e6248bfb080c3065f81b78c45bdfe1b37c06d6",
  resolvedPath: "vendor/vterm/packages/vt100/src/index.ts",
  integrity: {
    kind: "source",
    repository: "git@github.com:beorn/vterm.git",
    revision: "9e99e4d23cdc606fca258b1863aa2be7ae79eed3",
    treeOid: "b941dae48b25ae8825c394750bda5245c9d93dfa",
    cleanTree: true,
  },
  runtimeFormat: "js",
  engineVersion: "0.10.1",
} as const

const withRuntimeIdentity = (context: LibProbeSource, runtimeIdentity: unknown): LibProbeSource =>
  Object.assign(context, { runtimeIdentity }) as LibProbeSource

// An unqualified entry is a missing prerequisite for the exit: PROBE TODO, never PROBE INVALID (@cto 84e7b78b, #32246).
test("1049 exit after an unqualified entry is PROBE TODO, and source never decides it (#32246)", () => {
  const definition = alt1049Probe("exit")
  const audited = alt1049Source("ignored-entry")
  const result = definition.lib!(withRuntimeIdentity(audited.context, VT100_SOURCE_IDENTITY))
  expect(result.notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable:
      "Open: switching to the alternate screen did not show, so we cannot tell whether switching back worked.",
  })
  expect(result.observation).toBeUndefined()
  expect(result.assertions).toBeUndefined()
  expect(JSON.parse(result.response!)).not.toHaveProperty("sourceCitation")
})

test("the same entry failure is PROBE TODO on a moved, dirty or different source", () => {
  const definition = alt1049Probe("exit")
  const unauditedIdentities = [
    { ...VT100_SOURCE_IDENTITY.integrity, revision: "0".repeat(40) },
    { ...VT100_SOURCE_IDENTITY.integrity, treeOid: "0".repeat(40) },
    { ...VT100_SOURCE_IDENTITY.integrity, cleanTree: false },
  ]
  for (const integrity of unauditedIdentities) {
    const { context } = alt1049Source("ignored-entry")
    const result = definition.lib!(withRuntimeIdentity(context, { ...VT100_SOURCE_IDENTITY, integrity }))
    expect(result.notTested?.noObservable, JSON.stringify(integrity)).toBe(
      "Open: switching to the alternate screen did not show, so we cannot tell whether switching back worked.",
    )
    expect(result.assertions, JSON.stringify(integrity)).toBeUndefined()
  }
})

test("1049 constant-cursor context cannot pass as a saved-cursor restoration", () => {
  for (const id of ["enter", "exit"] as const) {
    const definition = alt1049Probe(id)
    const { context, writes } = alt1049Source("constant-cursor")
    const result = definition.lib!(context)
    expect(result.observation, id).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(result.assertions, id).toBeUndefined()
    expect(writes, id).not.toContain("\x1b[?1049h")
  }
})

test("1049 readback failure is inconclusive while a cleanup failure stays loud", () => {
  const definition = alt1049Probe("exit")
  const { context, writes } = alt1049Source("readback-failure")
  const result = definition.lib!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(result.assertions).toBeUndefined()
  expect(writes.at(-1)).toBe("\x1b[?1049l\x1b[0m")
  const cleanup = alt1049Source("cleanup-failure")
  expect(() => definition.lib!(cleanup.context)).toThrow("cleanup failed")
})

const ALT_SWAP = [
  ["modes.altscreen-47", 47],
  ["modes.altscreen-1047", 1047],
] as const

function altSwapHeadless(id: (typeof ALT_SWAP)[number][0]) {
  const definition = modesProbes.find((item) => item.id === id)
  if (!definition?.lib) throw new Error(`Missing ${id} headless callback`)
  return definition.lib
}

test.each(ALT_SWAP)("%s grades the full seeded roundtrip supported from cells and saves no cursor", (id, mode) => {
  for (const scenario of ["roundtrip", "broken-cursor", "constant-cursor"] as const) {
    const { context, writes } = alt1049Source(scenario, 20, 5, mode)
    const result = altSwapHeadless(id)(context)
    expect(result.observation, scenario).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
    expect(result.assertions, scenario).toMatchObject([{ kind: "positive" }])
    expect(writes, scenario).toContain(`\x1b[?${mode}h`)
    expect(writes, scenario).not.toContain("\x1b[?1049h")
    expect(writes.at(-1), scenario).toBe(`\x1b[?${mode}l\x1b[0m`)
  }
  // Without a saved-cursor claim the fixture needs only the two seeded rows.
  const threeRows = alt1049Source("roundtrip", 20, 3, mode)
  expect(altSwapHeadless(id)(threeRows.context).observation).toMatchObject({ outcome: "supported" })
})

test.each(ALT_SWAP)(
  "%s grades an ignored entry, an erasure, a leaked marker and a lost exit unsupported",
  (id, mode) => {
    for (const scenario of ["ignored-entry", "erasure-mimic", "marker-leak", "broken-exit"] as const) {
      const { context, writes } = alt1049Source(scenario, 20, 5, mode)
      const result = altSwapHeadless(id)(context)
      expect(result.observation, scenario).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
      expect(result.assertions, scenario).toMatchObject([{ kind: "negative" }])
      expect(writes.at(-1), scenario).toBe(`\x1b[?${mode}l\x1b[0m`)
    }
  },
)

test.each(ALT_SWAP)(
  "%s leaves alternate clearing on entry implementation-defined (xterm clears ?1047 on exit, #30702)",
  (id, mode) => {
    const stale = altSwapHeadless(id)(alt1049Source("uncleared-entry", 20, 5, mode).context)
    expect(stale.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
    expect(stale.assertions).toMatchObject([{ kind: "positive" }])
  },
)

test("?1049 must clear the alternate buffer on entry: a stale alternate buffer fails it", () => {
  const result = alt1049Probe("enter").lib!(alt1049Source("uncleared-entry").context)
  expect(result.observation).toMatchObject({
    outcome: "unsupported",
    assertionType: "buffer_state",
    note: "CSI ? 1049 h did not clear the seeded primary spans",
  })
  expect(result.assertions).toMatchObject([{ kind: "negative" }])
})

test("?1047 must clear the alternate buffer on exit: a marker that survives re-entry fails it (DECRST 1047)", () => {
  const { context, writes } = alt1049Source("uncleared-exit", 20, 5, 1047)
  const result = altSwapHeadless("modes.altscreen-1047")(context)
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
  expect(String(result.observation?.note)).toContain("did not clear the alternate buffer on exit")
  expect(result.assertions).toMatchObject([{ kind: "negative" }])
  expect(JSON.parse(result.response ?? "{}")).toMatchObject({ reentered: "ALT-MARK" })
  expect(writes.filter((write) => write === "\x1b[?1047h")).toHaveLength(2)
  expect(writes.at(-1)).toBe("\x1b[?1047l\x1b[0m")
  // A clean roundtrip re-enters once and reads the marker gone.
  const clean = alt1049Source("roundtrip", 20, 5, 1047)
  const graded = altSwapHeadless("modes.altscreen-1047")(clean.context)
  expect(graded.observation).toMatchObject({ outcome: "supported" })
  expect(JSON.parse(graded.response ?? "{}")).toMatchObject({ reentered: " ".repeat("ALT-MARK".length) })
  expect(clean.writes.filter((write) => write === "\x1b[?1047h")).toHaveLength(2)
  // ?47 promises no exit clear: the same surviving marker passes, and it enters only once.
  const legacy = alt1049Source("uncleared-exit", 20, 5, 47)
  expect(altSwapHeadless("modes.altscreen-47")(legacy.context).observation).toMatchObject({ outcome: "supported" })
  expect(legacy.writes.filter((write) => write === "\x1b[?47h")).toHaveLength(1)
})

test("?1047 re-entry that shows other content, neither blank nor ALT-MARK, is inconclusive by name", () => {
  const { context, writes } = alt1049Source("stale-exit", 20, 5, 1047)
  const result = altSwapHeadless("modes.altscreen-1047")(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(String(result.observation?.note)).toContain("neither blank nor ALT-MARK")
  expect(result.assertions).toBeUndefined()
  expect(JSON.parse(result.response ?? "{}")).toMatchObject({ reentered: "STALE-AL" })
  expect(writes.at(-1)).toBe("\x1b[?1047l\x1b[0m")
})

test.each(ALT_SWAP)("%s stays inconclusive on an undersized grid or an unavailable readback", (id, mode) => {
  for (const [cols, rows] of [
    [6, 5],
    [20, 2],
  ] as const) {
    const { context, writes } = alt1049Source("roundtrip", cols, rows, mode)
    const result = altSwapHeadless(id)(context)
    expect(result.observation, `${cols}x${rows}`).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
    })
    expect(result.assertions, `${cols}x${rows}`).toBeUndefined()
    expect(writes, `${cols}x${rows}`).toEqual([])
  }
  const { context, writes } = alt1049Source("readback-failure", 20, 5, mode)
  const failed = altSwapHeadless(id)(context)
  expect(failed.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(failed.assertions).toBeUndefined()
  expect(writes.at(-1)).toBe(`\x1b[?${mode}l\x1b[0m`)
})

// A painted alternate marker distinguishes frames, but it does not qualify buffer entry.
// Exit-only 1049 stays pending; a failed whole-mode 47/1047 roundtrip cannot be
// rescued by its unmeasured secondary facet (#31743, CTO ccfc864a).
test.each([
  ["modes.alt-screen.exit", "pixels", 1049],
  ["modes.alt-screen.exit", "text-cells", 1049],
  ["modes.altscreen-47", "pixels", 47],
  ["modes.altscreen-1047", "pixels", 1047],
  ["modes.altscreen-1047", "text-cells", 1047],
] as const)("%s negative roundtrip on %s keeps mode %d's criterion", async (id, kind, mode) => {
  const definition = modesProbes.find((entry) => entry.id === id)
  if (!definition?.term) throw new Error(`Missing app callback for ${id}`)
  const result = await definition.term(captureSource(24, 80, [], [], true, kind, false))
  const recorded = recordExecutedProbe({
    featureId: id,
    attempt: { scope: "probe", startedAt: new Date().toISOString() },
    observation: result.observation ? { featureId: id, ...result.observation } : undefined,
    assertions: (result.assertions ?? []).map((assertion) => ({ featureId: id, ...assertion })),
    tests: result.tests,
  })
  expect(recorded.status).toBe(mode === 1049 ? "probe-todo" : "unsupported")
  if (mode !== 1049) {
    const reason = `After a ?${mode} round trip the primary marker was not restored`
    expect(recorded.reason).toBe(reason)
    expect(result.tests).toEqual([
      { id: "primary-marker-restored", status: "unsupported", assertionRefs: [0], reason },
      { id: "alternate-marker-control", status: "supported", assertionRefs: [1] },
    ])
    expect(result.assertions).toMatchObject([{ kind: "negative" }, { kind: "positive" }])
    return
  }
  expect(result.observation?.outcome).not.toBe("unsupported")
  expect(result.tests?.some((row) => row.status === "unsupported")).not.toBe(true)
  expect(result.tests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "entry-qualified",
        status: "probe-todo",
        reason:
          "Open: switching to the alternate screen did not show, so we cannot tell whether switching back worked.",
      }),
    ]),
  )
  expect(result.observation?.note).toBe(
    "Open: switching to the alternate screen did not show, so we cannot tell whether switching back worked.",
  )
})

test("alt-screen exit capture frames the primary, alternate and restored buffers", async () => {
  const definition = modesProbes.find((item) => item.id === "modes.alt-screen.exit")
  if (!definition?.term) throw new Error("Missing app alt-screen exit callback")
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const result = await definition.term(captureSource(24, 80, writes, frames))
  expect(writes.some((entry) => entry.includes("\x1b[?1049h"))).toBe(true)
  expect(writes).toContain("\x1b[?1049l")
  expect(result.tests).toMatchObject([
    { id: "primary-marker-restored", status: "supported", assertionRefs: [0] },
    { id: "alternate-marker-control", status: "supported", assertionRefs: [1] },
    { id: "remaining-facets", status: "probe-todo", reason: expect.stringMatching(/saved cursor.*scrollback/) },
  ])
  expect(result.assertions).toHaveLength(2)
  expect(result.observation?.frames?.filter((frame) => frame.role === "target")).toHaveLength(1)
})

// The old positive pinned only primary restoration. Exercise actual semantic buffer writes:
// a clear-on-entry 1047 must not hide its broken exit, and 47 must qualify that independent access.
test.each([
  ["modes.altscreen-47", "working", "pixels", "supported"],
  ["modes.altscreen-47", "47-clears", "pixels", "unsupported"],
  ["modes.altscreen-1047", "working", "pixels", "supported"],
  ["modes.altscreen-1047", "1047-no-clear", "pixels", "unsupported"],
  ["modes.altscreen-1047", "1047-entry-masks", "pixels", "unsupported"],
  ["modes.altscreen-1047", "47-clears", "pixels", "untestable"],
  ["modes.altscreen-1047", "working", "text-cells", "supported"],
] as const)(
  "%s measures coupled re-entry witnesses with %s on %s as %s",
  async (id, fault, kind, expected) => {
    const definition = modesProbes.find((item) => item.id === id)
    if (!definition?.term) throw new Error(`Missing app callback for ${id}`)
    const cols = 80
    const rows = 24
    const surface = createSemanticSurface({ cols, rows })
    const writes: string[] = []
    let sequence = 0
    const plane = (cells: CaptureCells) => {
      const chars: string[] = []
      for (let row = cells.top; row <= cells.bottom; row++) {
        for (let col = cells.left; col <= cells.right; col++) chars.push(surface.getCell(row - 1, col - 1).char)
      }
      return JSON.stringify(chars)
    }
    const source = replayTermProbeSource(new Map(), {
      cols,
      rows,
      captureKind: kind,
      write(bytes) {
        writes.push(bytes)
        let actual = bytes
        if (fault === "1047-no-clear" || fault === "1047-entry-masks") {
          actual = actual.replaceAll("\x1b[?1047l", "\x1b[?47l")
        }
        if (fault === "1047-entry-masks") actual = actual.replaceAll("\x1b[?1047h", "\x1b[?1047h\x1b[2J")
        if (fault === "47-clears") actual = actual.replaceAll("\x1b[?47h", "\x1b[?47h\x1b[2J")
        surface.feed(actual)
      },
      captureGeometry: {
        geometry: { cellWidth: 10, cellHeight: 20, textWidth: cols * 10, textHeight: rows * 20 },
        source: "measured by complete raster calibration",
      },
      capture: async ({ role, label, cells, pixelGeometry }) => {
        if (!cells || !pixelGeometry) throw new Error("Alternate-buffer fixture requires its measured crop")
        return {
          kind: "pixels",
          role,
          label,
          capturedAt: ++sequence,
          ref: `sha256:${sequence.toString(16).padStart(64, "0")}`,
          regionDigest: plane(cells),
          pixelsDigest: plane({ top: 1, left: 1, bottom: rows, right: cols }),
          regionRectangle: {
            x: (cells.left - 1) * pixelGeometry.cellWidth,
            y: (cells.top - 1) * pixelGeometry.cellHeight,
            width: (cells.right - cells.left + 1) * pixelGeometry.cellWidth,
            height: (cells.bottom - cells.top + 1) * pixelGeometry.cellHeight,
          },
        }
      },
      cells: async ({ role, label, cells }) => {
        if (!cells) throw new Error("Alternate-buffer fixture requires its cell region")
        return {
          kind: "text-cells",
          role,
          label,
          capturedAt: ++sequence,
          ref: `sha256:${sequence.toString(16).padStart(64, "0")}`,
          cellDigest: plane(cells),
          frameDigest: plane({ top: 1, left: 1, bottom: rows, right: cols }),
          cellRectangle: cells,
        }
      },
    })
    if (kind === "pixels") source.cells = undefined
    else {
      source.capture = undefined
      source.captureGeometry = undefined
    }
    const result = await definition.term(source)
    const recorded = recordExecutedProbe({
      featureId: id,
      attempt: { scope: "probe", startedAt: new Date().toISOString() },
      criterionBranch: result.criterionBranch,
      ...(result.notTested ? { coverage: { featureId: id, rawReplyRef: id, ...result.notTested } } : {}),
      tests: result.tests,
      observation: result.observation ? { featureId: id, ...result.observation } : undefined,
      assertions: (result.assertions ?? []).map((assertion) => ({ featureId: id, ...assertion })),
    })
    expect(recorded.status).toBe(expected)
    expect(surface.getMode("altScreen")).toBe(false)
    expect(writes.at(-1)).toBe("\x1b[0m\x1b[2J\x1b[H")
  },
)

test("insert-replace capture contrasts replacement with IRM insertion", async () => {
  const definition = modesProbes.find((item) => item.id === "modes.insert-replace")
  if (!definition?.term) throw new Error("Missing app IRM callback")
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const result = await definition.term(captureSource(24, 80, writes, frames))
  expect(writes.some((entry) => entry.includes("\x1b[4h"))).toBe(true)
  expect(result.tests).toEqual([{ id: "inserted-cells", status: "supported", assertionRefs: [0] }])
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "screenshot" })
  expect(result.observation?.frames?.filter((frame) => frame.role === "target")).toHaveLength(1)
  expect(frames.find((frame) => frame.label.endsWith("expected frame"))?.regionRectangle).toEqual({
    x: 0,
    y: 0,
    width: 50,
    height: 20,
  })
})

// Permanent-state replies are well formed but cannot prove the claimed set/reset toggle.
test.each([
  [1, 2, "supported"],
  [3, 2, "unsupported"],
  [1, 4, "unsupported"],
  [3, 4, "unsupported"],
] as const)("insert-replace measures toggle states %i then %i", async (on, off, outcome) => {
  const definition = modesProbes.find((item) => item.id === "modes.insert-replace")
  if (!definition?.term) throw new Error("Missing app IRM callback")
  const writes: string[] = []
  const ctx = captureSource(24, 80, writes, [])
  const states = [on, off]
  ctx.queryWithSentinel = async (_sequence, pattern) => pattern.exec(`\x1b[4;${states.shift()}$y`)
  const result = await definition.term(ctx)
  expect(result.observation).toMatchObject({ outcome, assertionType: "query_reply" })
  expect(result.assertions?.[0]?.kind).toBe(outcome === "supported" ? "positive" : "negative")
  expect(result.response).toContain(`Ps ${on}`)
  expect(result.response).toContain(`Ps ${off}`)
  expect(writes.at(-1)).toBe("\x1b[4l")
})

test("left/right margin capture contrasts an unconstrained write with a margin-confined wrap", async () => {
  const definition = modesProbes.find((item) => item.id === "modes.left-right-margin")
  if (!definition?.term) throw new Error("Missing app margin callback")
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const result = await definition.term(captureSource(24, 80, writes, frames))
  expect(writes.some((entry) => entry.includes("\x1b[?69h"))).toBe(true)
  expect(writes.some((entry) => entry.includes("\x1b[3;6s"))).toBe(true)
  expect(result.tests).toEqual([{ id: "margin-wrap", status: "supported", assertionRefs: [0] }])
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "screenshot" })
  expect(frames.find((frame) => frame.label.endsWith("expected frame"))?.regionRectangle).toEqual({
    x: 20,
    y: 20,
    width: 10,
    height: 20,
  })
})

test("modes capture refuses undersized geometry before any bytes or frames", async () => {
  for (const [id, rows, cols, need] of [
    ["modes.left-right-margin", 1, 7, "2x8"],
    ["modes.alt-screen.exit", 3, 5, "3x8"],
    ["modes.insert-replace", 1, 5, "1x6"],
  ] as const) {
    const definition = modesProbes.find((item) => item.id === id)
    if (!definition?.term) throw new Error(`Missing app callback for ${id}`)
    const writes: string[] = []
    const frames: ObservationFrame[] = []
    const result = await definition.term(captureSource(rows, cols, writes, frames))
    expect(writes, id).toEqual([])
    expect(frames, id).toEqual([])
    expect(result.observation, id).toBeUndefined()
    expect(result.assertions, id).toBeUndefined()
    expect(result.tests, id).toMatchObject([
      expect.objectContaining({ status: "probe-todo", reason: expect.stringContaining(need) }),
    ])
  }
})

/**
 * A capture adapter that paints each stack fixture as the visual STATE its target leaves (#31904):
 * the reference frames carry the state they were authored to show, and the target carries the
 * state the scripted terminal leaves, so equal digests mean equal states. A frame whose label names
 * no fixture is the joint arm's single fixture, the POP fixture's shape (the on-control for
 * save/restore). Witness frames come from the ordinary adapter.
 */
function stackStateSource(
  writes: string[],
  frames: ObservationFrame[],
  target: Record<string, string>,
  identicalReferences = false,
  fresh = true,
) {
  const source = captureSource(24, 80, writes, frames, fresh)
  const witness = source.capture!
  source.capture = async (request) => {
    const { label } = request
    if (/paint witness|— baseline/.test(label)) return witness(request)
    const mode = /xtsave|xtrestore/.test(label)
    const fixture =
      ["restore control", "on-control", "overwrite test", "PUSH fixture", "POP fixture"].find((name) =>
        label.includes(name),
      ) ?? (mode ? "on-control" : "POP fixture")
    const joint = !/fixture|control|overwrite/.test(label)
    const contrast = /\((earlier|persisted) contrast\)/.exec(label)?.[1] ?? "persisted"
    const restores = mode ? (fixture === "on-control" ? "on" : "off") : "restored"
    const ignored = mode ? (restores === "on" ? "off" : "on") : contrast
    let plane = "blank"
    if (label.endsWith("post-sequence target")) plane = target[fixture] ?? "unscripted"
    else if (label.endsWith("expected frame") || label.endsWith("setup reference frame")) plane = restores
    else if (label.endsWith("ignored-attribute frame")) plane = identicalReferences ? restores : ignored
    else if (label.endsWith("pre-edit seed")) plane = mode ? "off" : joint && /colors/.test(label) ? restores : "blank"
    const { role, cells, pixelGeometry } = request
    const frame = {
      role,
      label,
      capturedAt: frames.length + 1,
      ref: `sha256:${(frames.length + 1).toString(16).padStart(64, "0")}`,
      ...(cells &&
        pixelGeometry && {
          kind: "pixels" as const,
          regionDigest: plane,
          pixelsDigest: `whole:${plane}`,
          regionRectangle: {
            x: (cells.left - 1) * pixelGeometry.cellWidth,
            y: (cells.top - 1) * pixelGeometry.cellHeight,
            width: (cells.right - cells.left + 1) * pixelGeometry.cellWidth,
            height: (cells.bottom - cells.top + 1) * pixelGeometry.cellHeight,
          },
        }),
    }
    frames.push(frame)
    return frame
  }
  return source
}

const STACK_CAPTURE_IDS = {
  sgr: ["modes.xtpushsgr", "modes.xtpopsgr", "\x1b[#{"],
  colors: ["modes.xtpushcolors", "modes.xtpopcolors", "\x1b[#P"],
} as const

// #31904 (@chief e23ee4d7): each app capture row grades its own operation from the same fixtures
// as its headless arm. Synthetic frames prove the grading only; real app outcomes stay NOT MEASURED
// without an eligible native capture. The joint arm graded a stale stack's push row supported.
test.each(
  (["sgr", "colors"] as const).flatMap((family) =>
    (
      [
        ["working", { "POP fixture": "restored", "PUSH fixture": "restored" }, "supported", "supported", undefined],
        [
          "stale",
          { "POP fixture": "restored", "PUSH fixture": "earlier" },
          "unsupported",
          "supported",
          "push saved no current snapshot",
        ],
        [
          "no-op",
          { "POP fixture": "persisted", "PUSH fixture": "persisted" },
          "unsupported",
          "unsupported",
          "push then pop restored no earlier state",
        ],
        [
          "reset-to-default",
          { "POP fixture": "default", "PUSH fixture": "default" },
          "inconclusive",
          "inconclusive",
          "no-only observation",
        ],
      ] as const
    ).map(([name, target, push, pop, note]) => [family, name, target, push, pop, note] as const),
  ),
)(
  "a %s capture of a %s stack grades push and pop on their own fixtures",
  async (family, _name, target, push, pop, note) => {
    const [pushId, popId, marker] = STACK_CAPTURE_IDS[family]
    for (const [id, outcome] of [
      [pushId, push],
      [popId, pop],
    ] as const) {
      const definition = modesProbes.find((item) => item.id === id)
      if (!definition?.term) throw new Error(`Missing app callback for ${id}`)
      const writes: string[] = []
      const frames: ObservationFrame[] = []
      const result = await definition.term(stackStateSource(writes, frames, target))
      expect(
        writes.some((entry) => entry.includes(marker)),
        id,
      ).toBe(true)
      expect(result.observation?.outcome, id).toBe(outcome)
      expect(result.pass, id).toBe(outcome === "supported")
      if (outcome === "inconclusive") {
        expect(result.assertions, id).toBeUndefined()
        expect(result.observation?.note, id).toMatch(/no (push|pop)-only observation/)
        // A null grade is a required review (PROBE TODO), never a PROBE INVALID (@cto 19664c4c).
        expect(result.tests, id).toEqual([{ id: "review", status: "probe-todo", reason: result.observation?.note }])
      } else {
        expect(result.assertions, id).toMatchObject([
          { kind: outcome === "supported" ? "positive" : "negative", assertionType: "screenshot" },
        ])
        expect(result.tests, id).toEqual([
          { id: `${id === pushId ? "push" : "pop"}-observed`, status: outcome, assertionRefs: [0] },
        ])
        if (note && outcome === "unsupported") expect(result.observation?.note, id).toContain(note)
      }
    }
  },
)

// #31742: only a painted, unchanged palette has no setup; failed paint and SGR stay Open.
test.each(
  ["modes.xtpushcolors", "modes.xtpopcolors", "modes.xtpushsgr", "modes.xtpopsgr"].flatMap((id) =>
    [
      ["equal references with paint", true, true] as const,
      ["equal references without paint", true, false] as const,
      ["different references", false, true] as const,
    ].map(([name, equal, fresh]) => [id, name, equal, fresh] as const),
  ),
)("%s with %s keeps the observed applicability boundary", async (id, _name, equal, fresh) => {
  const definition = modesProbes.find((item) => item.id === id)
  if (!definition?.term) throw new Error(`Missing app callback for ${id}`)
  const frames: ObservationFrame[] = []
  let now = 0
  const clock = fresh ? undefined : vi.spyOn(Date, "now").mockImplementation(() => (now += 10_000))
  let result: ProbeCallbackResult
  try {
    result = await definition.term(
      stackStateSource([], frames, { "POP fixture": "restored", "PUSH fixture": "restored" }, equal, fresh),
    )
  } finally {
    clock?.mockRestore()
  }
  const noSetup = id.includes("colors") && equal && fresh
  expect(isDeclaredUntestable(result)).toBe(noSetup)
  if (noSetup) {
    expect(result.tests).toMatchObject([{ status: "untestable", reason: expect.stringContaining("OSC 4") }])
    expect(result.observation?.note).toContain("blue and green")
  } else if (equal || !fresh) {
    expect(result.tests).toMatchObject([{ status: "probe-todo" }])
  } else {
    expect(result.observation?.outcome).toBe("supported")
  }
  if (fresh) expect(result.observation?.frames).toEqual(frames)
})

// Test-broken-first: equal references do not establish no setup when the compared crop moved.
test.each(["modes.xtpushcolors", "modes.xtpopcolors"])("%s keeps differing crops Open before no setup", async (id) => {
  const definition = modesProbes.find((item) => item.id === id)
  if (!definition?.term) throw new Error(`Missing app callback for ${id}`)
  const source = stackStateSource([], [], {}, true)
  const capture = source.capture!
  source.capture = async (request) => {
    const frame = await capture(request)
    if (request.label.endsWith("expected frame") && frame.regionRectangle) {
      frame.regionRectangle = { ...frame.regionRectangle, x: frame.regionRectangle.x + 1 }
    }
    return frame
  }
  const result = await definition.term(source)
  expect(isDeclaredUntestable(result)).toBe(false)
  expect(result.tests).toMatchObject([
    { status: "probe-todo", reason: expect.stringContaining("different screen positions") },
  ])
  expect(result.observation?.note).toContain("different screen positions")
})

test.each(["modes.xtpushcolors", "modes.xtpopcolors", "modes.xtpushsgr", "modes.xtpopsgr"])(
  "%s paints X at least two empty cells away from the compared Y",
  async (id) => {
    const definition = modesProbes.find((item) => item.id === id)
    if (!definition?.term) throw new Error(`Missing app callback for ${id}`)
    const surface = createSemanticSurface({ cols: 80, rows: 24 })
    const source = stackStateSource([], [], { "POP fixture": "restored", "PUSH fixture": "restored" })
    const write = source.write.bind(source)
    source.write = (bytes) => {
      write(bytes)
      surface.feed(bytes)
    }
    const capture = source.capture!
    let targets = 0
    source.capture = async (request) => {
      if (request.label.endsWith("post-sequence target")) {
        if (!request.cells) throw new Error("Target crop missing")
        const row = request.cells.top - 1
        const y = request.cells.left - 1
        expect(surface.getCell(row, y).char).toBe("Y")
        const xs = Array.from({ length: 80 }, (_, col) => col).filter((col) => surface.getCell(row, col).char === "X")
        expect(xs).toHaveLength(1)
        expect(Math.abs(xs[0]! - y)).toBeGreaterThanOrEqual(3)
        targets++
      }
      return capture(request)
    }
    await definition.term(source)
    expect(targets).toBeGreaterThanOrEqual(2)
  },
)

// #31904 R3f capture arm: the headless arm's three fixtures (@cto 009e40cd, 4e804806).
test.each([
  ["working", { "restore control": "off", "on-control": "on", "overwrite test": "off" }, "supported", "supported"],
  ["stale save", { "restore control": "off", "on-control": "on", "overwrite test": "on" }, "unsupported", "supported"],
  [
    "reset to default",
    { "restore control": "on", "on-control": "on", "overwrite test": "on" },
    "unsupported",
    "unsupported",
  ],
  [
    "always-off restore",
    { "restore control": "off", "on-control": "off", "overwrite test": "off" },
    "inconclusive",
    "unsupported",
  ],
] as const)(
  "a %s DECAWM save/restore capture grades each row on its own operation",
  async (_name, target, save, restore) => {
    for (const [id, outcome] of [
      ["modes.xtsave", save],
      ["modes.xtrestore", restore],
    ] as const) {
      const definition = modesProbes.find((item) => item.id === id)
      if (!definition?.term) throw new Error(`Missing app callback for ${id}`)
      const writes: string[] = []
      const frames: ObservationFrame[] = []
      const result = await definition.term(stackStateSource(writes, frames, target))
      expect(
        writes.some((entry) => entry.includes("X".repeat(80) + "!")),
        id,
      ).toBe(true)
      expect(writes, id).toContain("\x1b[?7h")
      expect(result.observation?.outcome, id).toBe(outcome)
      expect(result.pass, id).toBe(outcome === "supported")
    }
  },
)

test("xt stack capture refuses undersized geometry before any bytes or frames", async () => {
  for (const [id, rows, cols, need] of [
    ["modes.xtpushsgr", 2, 80, "5x6"],
    // XT-save/restore derives its wrap boundary from the measured width, so an undersized
    // fixture is under two rows or two columns, not an absolute column count.
    ["modes.xtsave", 1, 80, "4x2"],
    ["modes.xtpushcolors", 2, 80, "4x8"],
  ] as const) {
    const definition = modesProbes.find((item) => item.id === id)
    if (!definition?.term) throw new Error(`Missing app callback for ${id}`)
    const writes: string[] = []
    const frames: ObservationFrame[] = []
    const result = await definition.term(captureSource(rows, cols, writes, frames))
    expect(writes, id).toEqual([])
    expect(frames, id).toEqual([])
    expect(result.observation, id).toBeUndefined()
    expect(result.assertions, id).toBeUndefined()
    expect(result.tests, id).toMatchObject([
      expect.objectContaining({ status: "probe-todo", reason: expect.stringContaining(need) }),
    ])
  }
})

// Q2: the old presentation-only tests never exercised the library's consumed/leaked controls.
// #32246: a consumed control with no visible effect has no same-path control in this run, so it is PROBE TODO.
test.each([
  ["Q", 1, 0, "todo"],
  ["9 pQ", 4, 0, "unsupported"],
  ["[9 pQ", 5, 0, "unsupported"],
  ["Q", 1, 1, "inconclusive"],
  ["Qchanged", 1, 0, "inconclusive"],
] as const)("DECSSCLS library retains text %j at %i,%i", (text, x, y, outcome) => {
  const writes: string[] = []
  let measured = false
  const source = libProbeSource({
    cols: 80,
    feed(sequence) {
      writes.push(sequence)
      measured = sequence.includes("\x1b[9 p")
    },
    getText: () => (measured ? `${text}\n\n` : "\n\n"),
    getCursor: () => ({ x: measured ? x : 0, y: measured ? y : 0, visible: true, style: "block" }),
    getCell() {
      throw new Error("DECSSCLS must use the existing text/cursor readers")
    },
  })
  const result = modesProbes.find((entry) => entry.id === "modes.decsscls")!.lib!(source)
  expect(writes.join("")).toContain("\x1b[9 pQ")
  expect(result.criterionBranch).toBeUndefined()
  expect(result.tests).toBeUndefined()
  expect(JSON.parse(result.response!)).toMatchObject({ text: `${text}\n\n`, cursor: { x, y } })
  if (outcome === "todo") {
    expect(result.notTested).toEqual({ reason: "no-semantic-observable", noObservable: NO_SAME_PATH_CONTROL })
    expect(result.observation).toBeUndefined()
    expect(result.assertions ?? []).toEqual([])
  } else {
    expect(result.observation).toMatchObject({ outcome, assertionType: "buffer_state" })
    expect(result.assertions?.length ?? 0).toBe(outcome === "unsupported" ? 1 : 0)
  }
})

const DECSSCLS_GEOMETRY = { cellWidth: 10, cellHeight: 20, textWidth: 800, textHeight: 480 } as const
const DECSSCLS_RECTANGLE = { x: 0, y: 0, width: 800, height: 440 } as const
const DECSSCLS_WITNESS = { top: 1, left: 1, bottom: 23, right: 80 } as const
const DECSSCLS_MARKER_REF = "marker-ref"
const DECSSCLS_BAND_RECTANGLE = { x: 0, y: 0, width: 800, height: 20 } as const

interface DecssclsFixture {
  /** Raw region digest per capture, in capture order; defaults to the frame ref. */
  cells?: readonly (string | undefined)[]
  /** Marker-band presence per band capture AFTER the clean-screen reference, in capture order. */
  band?: readonly ("present" | "absent")[]
  /** The screen rectangle each capture was cropped from; defaults to one shared rectangle. */
  rectangles?: readonly CaptureRectangle[]
  /** Capture index that answers with a text-cells frame, as a text arm does. */
  textCellsAt?: number
  /** Capture index that answers with no digests at all, as a broken collector does. */
  missingDigestAt?: number
  /** The requests the probe handed the capture adapter, in capture order. */
  requests?: CaptureRequest[]
  /** What DECRQM 4 answers before the probe: the DECSCLM state it must put back. */
  decsclm?: "set" | "reset" | "unknown" | null
}

function decssclsSource(
  refs: readonly string[],
  writes: string[],
  frames: ObservationFrame[],
  rows = 24,
  fixture: DecssclsFixture = {},
): TermProbeSource {
  const context = captureSource(rows, 80, writes, frames)
  context.captureGeometry = {
    geometry: { ...DECSSCLS_GEOMETRY },
    source: "measured by complete raster calibration",
  }
  context.queryMode = async () => fixture.decsclm ?? null
  let index = 0
  let bandIndex = 0
  context.capture = async (request) => {
    fixture.requests?.push(request)
    // A one-row request is the marker band; the whole-witness request keeps the old path. The
    // clean-screen reference is the first band capture and always shows the band.
    if (request.cells !== undefined && request.cells.top === request.cells.bottom) {
      const present = bandIndex === 0 || (fixture.band?.[bandIndex - 1] ?? "present") === "present"
      bandIndex += 1
      const ref = present ? DECSSCLS_MARKER_REF : "no-band"
      const bandFrame: ObservationFrame = {
        role: request.role,
        label: request.label,
        capturedAt: frames.length + 1,
        ref,
        regionDigest: ref,
        pixelsDigest: `whole:${ref}`,
        regionRectangle: DECSSCLS_BAND_RECTANGLE,
      }
      frames.push(bandFrame)
      return bandFrame
    }
    const position = index
    index += 1
    const ref = refs[position] ?? "sha256:missing"
    const base = { role: request.role, label: request.label, capturedAt: frames.length + 1, ref }
    const frame: ObservationFrame =
      position === fixture.textCellsAt
        ? {
            ...base,
            kind: "text-cells",
            cellDigest: ref,
            frameDigest: ref,
            cellRectangle: { top: 1, left: 1, bottom: Math.max(1, rows - 2), right: 80 },
          }
        : position === fixture.missingDigestAt
          ? base
          : {
              ...base,
              regionDigest: fixture.cells?.[position] ?? ref,
              pixelsDigest: `whole:${ref}`,
              regionRectangle: fixture.rectangles?.[position] ?? DECSSCLS_RECTANGLE,
            }
    frames.push(frame)
    return frame
  }
  return context
}

function decsscls() {
  const definition = modesProbes.find((entry) => entry.id === "modes.decsscls")
  if (!definition?.term) throw new Error("Missing modes.decsscls term callback")
  return definition
}

/** Answer the six `performance.now()` reads of the two phases, so each capture's timing is exact. */
async function withDecssclsClock(
  controlFirstMs: number,
  targetFirstMs: number,
  work: () => Promise<void>,
  targetBandMs = targetFirstMs,
): Promise<void> {
  const now = vi.spyOn(performance, "now")
  const ticks = [0, controlFirstMs, controlFirstMs, 100_000, 100_000 + targetFirstMs, 100_000 + targetBandMs]
  now.mockImplementation(() => ticks.shift() ?? 0)
  try {
    await work()
  } finally {
    now.mockRestore()
  }
}

test("modes.decsscls grades text moving through the witness region inside the window as supported", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const requests: CaptureRequest[] = []
  const result = await decsscls().term!(
    decssclsSource(["jump-t0", "jump-t1", "slow-t0", "slow-t1"], writes, frames, 24, {
      cells: ["jump", "jump", "slow-t0", "slow-t1"],
      band: ["present", "present", "absent", "present"],
      requests,
    }),
  )
  expect(result.observation).toMatchObject({
    outcome: "supported",
    assertionType: "screenshot",
    screenshotRef: "slow-t1",
  })
  expect(result.observation?.note).toContain("marker band reached its settled row")
  // The decided verdict cites the four region digests, so the run parser can recompute it.
  expect(result.response).toContain(JSON.stringify({ control: ["jump", "jump"], target: ["slow-t0", "slow-t1"] }))
  expect(result.assertions).toMatchObject([{ kind: "positive" }])
  expect(frames).toHaveLength(9)
  // Every capture names the measured geometry: pixels only, never ctx.cells. The first is the
  // clean-screen marker reference; then each frame is a witness capture plus a 1-row band capture.
  for (const request of requests) expect(request.pixelGeometry).toEqual(DECSSCLS_GEOMETRY)
  expect(requests[0]?.cells).toEqual({ top: 16, left: 1, bottom: 16, right: 80 })
  expect(requests.slice(1).filter((request) => request.cells?.top === request.cells?.bottom)).toHaveLength(4)
  expect(requests.slice(1).filter((request) => request.cells?.top !== request.cells?.bottom)).toHaveLength(4)
  expect(writes.some((write) => write.includes("\x1b[?4h"))).toBe(true)
  // DECSCLM is restored to what DECRQM 4 reported; this fixture answers nothing, so it restores reset.
  const exit = writes.find((write) => write.includes("\x1b[?1049l"))
  expect(exit).toContain("\x1b[0 p")
  expect(exit).toContain("\x1b[?4l")
  expect(result.response).toContain("prior DECSCLM unknown, restored reset")
  expect(writes.some((write) => write.includes("\x1b[9 p"))).toBe(true)
  expect(writes.some((write) => write.includes("\x1b[0 p"))).toBe(true)
  expect(writes.some((write) => write.includes("line 40"))).toBe(true)
  expect(writes.some((write) => write.includes("\x1b[?1049l"))).toBe(true)
})

test("modes.decsscls places the authored marker band on the row its reference sample reads", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const requests: CaptureRequest[] = []
  const rows = 24
  const result = await decsscls().term!(
    decssclsSource(["jump-t0", "jump-t1", "slow-t0", "slow-t1"], writes, frames, rows, {
      cells: ["jump", "jump", "slow-t0", "slow-t1"],
      band: ["present", "present", "absent", "present"],
      requests,
    }),
  )
  expect(result.observation).toMatchObject({ outcome: "supported" })

  const targetBurst = writes.find((write) => write.includes("\x1b[?1049h\x1b[2J\x1b[H\x1b[9 p"))
  expect(targetBurst).toBeDefined()
  const setting = "\x1b[9 p"
  const authored = targetBurst!.slice(targetBurst!.indexOf(setting) + setting.length).split("\r\n")
  expect(authored[authored.length - 1]).toBe("")
  const lines = authored.slice(0, -1)
  const markerIndex = lines.findIndex((line) => line.includes("\x1b[48;5;196m"))
  expect(markerIndex).toBeGreaterThanOrEqual(0)
  const markerLine = markerIndex + 1
  const settledRow = markerLine - (lines.length - rows + 1)
  // The ruled placement: authored seven lines before the burst's end, settled eight rows up.
  expect(settledRow).toBe(rows - 8)

  const reference = writes.find(
    (write) => write.includes("\x1b[?1049h\x1b[2J\x1b[H\r\n") && write.includes("\x1b[48;5;196m"),
  )
  expect(reference).toBeDefined()
  const beforeBand = reference!.slice(0, reference!.indexOf("\x1b[48;5;196m"))
  const referenceRow = (beforeBand.match(/\r\n/g) ?? []).length + 1
  expect(referenceRow).toBe(settledRow)

  const bandRequest = requests.find(
    (request) => request.cells !== undefined && request.cells.top === request.cells.bottom,
  )
  expect(bandRequest?.cells?.top).toBe(settledRow)
})

test("modes.decsscls grades an instant repaint with the marker band in place as unsupported", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const result = await decsscls().term!(
    decssclsSource(["jump", "jump", "slow-before", "slow-after"], writes, frames, 24, {
      cells: ["jump", "jump", "slow-before", "slow-after"],
      band: ["present", "present", "present", "present"],
    }),
  )
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "screenshot" })
  expect(result.observation?.note).toContain("marker band")
})

test("modes.decsscls overruns whatever height the context measured", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const result = await decsscls().term!(
    decssclsSource(["jump-t0", "jump-t1", "slow-t0", "slow-t1"], writes, frames, 50, {
      cells: ["jump", "jump", "slow-t0", "slow-t1"],
      band: ["present", "present", "absent", "present"],
    }),
  )
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "screenshot" })
  expect(writes.some((write) => write.includes("line 66"))).toBe(true)
})

test("modes.decsscls refuses a one-row screen, where its witness would be the cursor row", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const result = await decsscls().term!(decssclsSource(["a", "b", "c", "d"], writes, frames, 1))
  expect(result.notTested).toMatchObject({ reason: "no-semantic-observable" })
  expect(result.note).toContain("no row above it")
  expect(writes).toEqual([])
  expect(frames).toEqual([])
})

test("modes.decsscls puts back the DECSCLM state it read before the probe", async () => {
  for (const [prior, expected] of [
    ["set", "\x1b[?4h"],
    ["reset", "\x1b[?4l"],
  ] as const) {
    const writes: string[] = []
    const frames: ObservationFrame[] = []
    const result = await decsscls().term!(
      decssclsSource(["jump-t0", "jump-t1", "slow-t0", "slow-t1"], writes, frames, 24, {
        cells: ["jump", "jump", "slow-t0", "slow-t1"],
        band: ["present", "present", "absent", "present"],
        decsclm: prior,
      }),
    )
    expect(result.observation?.outcome, prior).toBe("supported")
    const exit = writes.find((write) => write.includes("\x1b[?1049l"))
    expect(exit, prior).toContain(expected)
    expect(result.response, prior).toContain(`"prior":"${prior}"`)
  }
}, 20_000)

test("modes.decsscls names a refused capture geometry instead of claiming the run had none", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const context = captureSource(24, 80, writes, frames)
  context.captureGeometryRefusal = "cell-to-pixel calibration answered no DA1 reply"
  context.captureGeometry = undefined
  const result = await decsscls().term!(context)
  expect(result.notTested).toMatchObject({ reason: "no-semantic-observable" })
  expect(result.note).toContain("this run refused capture geometry: cell-to-pixel calibration answered no DA1 reply")
  expect(writes).toEqual([])
})

test("modes.decsscls does not grade unsupported when an honoring first frame lands at 1.5 s", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  await withDecssclsClock(40, 1500, async () => {
    const result = await decsscls().term!(
      decssclsSource(["jump-t0", "jump-t1", "slow-t0", "slow-t1"], writes, frames, 24, {
        cells: ["jump", "jump", "slow-t0", "slow-t1"],
        band: ["present", "present", "absent", "present"],
      }),
    )
    expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "screenshot" })
    // 24 rows leave 17 scrolled lines: ceil(17 / 9 * 1000) = 1889 ms, so 1.5 s is inside it.
    expect(result.response).toContain('"timingBoundMs":1739')
  })
})

test("modes.decsscls stays inconclusive when only the target band capture lands outside the throttled window", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  await withDecssclsClock(
    40,
    40,
    async () => {
      const result = await decsscls().term!(
        decssclsSource(["jump-t0", "jump-t1", "slow-t0", "slow-t1"], writes, frames, 24, {
          cells: ["jump", "jump", "slow-t0", "slow-t1"],
          band: ["present", "present", "present", "present"],
        }),
      )
      expect(result.observation).toMatchObject({
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        assertionType: "screenshot",
      })
      expect(result.observation?.note).toContain("outside the 1889 ms throttled window")
      // The witness frame landed early; only the band capture is late, so a band present there
      // cannot be placed inside the window and must not grade unsupported on the earlier time.
      expect(result.response).toContain('"targetFirstElapsedMs":40')
      expect(result.response).toContain('"targetFirstBandElapsedMs":2400')
      expect(result.assertions).toBeUndefined()
    },
    2400,
  )
})

test("modes.decsscls grades an identical target pair inside the window as unsupported", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const result = await decsscls().term!(
    decssclsSource(["jump-t0", "jump-t1", "slow", "slow"], writes, frames, 24, {
      cells: ["jump", "jump", "slow", "slow"],
      band: ["present", "present", "present", "present"],
    }),
  )
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "screenshot" })
  expect(result.observation?.note).toContain("already at its settled row in the target's first band capture")
  expect(result.assertions).toMatchObject([{ kind: "negative" }])
})

test("modes.decsscls stays inconclusive when the marker band never arrives", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const result = await decsscls().term!(
    decssclsSource(["jump", "jump", "slow-before", "slow-after"], writes, frames, 24, {
      cells: ["jump", "jump", "slow-before", "slow-after"],
      band: ["present", "present", "absent", "absent"],
    }),
  )
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    assertionType: "screenshot",
  })
  expect(result.observation?.note).toContain("had not reached its settled row")
  expect(result.assertions).toBeUndefined()
})

test("modes.decsscls refuses a screen too short to place the marker band", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const result = await decsscls().term!(decssclsSource(["a", "b", "c", "d"], writes, frames, 8))
  expect(result.notTested).toMatchObject({ reason: "no-semantic-observable" })
  expect(result.note).toContain("at least 10 rows")
  expect(writes).toEqual([])
  expect(frames).toEqual([])
})

test("modes.decsscls stays inconclusive when the jump control is still painting", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const result = await decsscls().term!(
    decssclsSource(["jump-t0", "jump-t1", "slow-t0", "slow-t1"], writes, frames, 24, {
      cells: ["jump-t0", "jump-t1", "slow-t0", "slow-t1"],
    }),
  )
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    assertionType: "screenshot",
  })
  expect(result.observation?.note).toContain("jump control moved between two frames")
  expect(result.assertions).toBeUndefined()
})

test("modes.decsscls stays inconclusive when the pair was cropped from different rectangles", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const shifted = { ...DECSSCLS_RECTANGLE, y: DECSSCLS_RECTANGLE.y + 26 }
  const result = await decsscls().term!(
    decssclsSource(["jump-t0", "jump-t1", "slow-t0", "slow-t1"], writes, frames, 24, {
      cells: ["jump", "jump", "slow-t0", "slow-t1"],
      rectangles: [DECSSCLS_RECTANGLE, DECSSCLS_RECTANGLE, DECSSCLS_RECTANGLE, shifted],
    }),
  )
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    assertionType: "screenshot",
  })
  expect(result.observation?.note).toContain("cropped from different rectangles")
  expect(result.assertions).toBeUndefined()
})

test("modes.decsscls refuses a text-cells frame instead of grading a buffer", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  await expect(
    decsscls().term!(
      decssclsSource(["jump-t0", "jump-t1", "slow-t0", "slow-t1"], writes, frames, 24, { textCellsAt: 2 }),
    ),
  ).rejects.toThrow(/returned a text-cells frame/)
  expect(writes.some((write) => write.includes("\x1b[?1049l"))).toBe(true)
})

test("modes.decsscls raises on a pixel frame with no digest for the requested cells", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  await expect(
    decsscls().term!(
      decssclsSource(["jump-t0", "jump-t1", "slow-t0", "slow-t1"], writes, frames, 24, { missingDigestAt: 0 }),
    ),
  ).rejects.toThrow(/no digest for the requested cells/)
})

test("modes.decsscls names the missing pixel capture on a text-only context", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const context = captureSource(24, 80, writes, frames)
  // A text arm installs the cells adapter and no pixel capture at all.
  context.capture = undefined
  context.cells = async ({ role, label }) => {
    const frame: ObservationFrame = {
      kind: "text-cells",
      role,
      label,
      capturedAt: 1,
      ref: "sha256:text",
      cellDigest: "cells",
      frameDigest: "frame",
      cellRectangle: { top: 1, left: 1, bottom: 22, right: 80 },
    }
    frames.push(frame)
    return frame
  }
  const result = await decsscls().term!(context)
  expect(result.notTested).toMatchObject({ reason: "no-semantic-observable" })
  expect(result.note).toContain("no pixel capture callback")
  expect(frames).toEqual([])
})

test("modes.decsscls names the missing capture instead of claiming presentation timing", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const context = captureSource(24, 80, writes, frames)
  context.capture = undefined
  const result = await decsscls().term!(context)
  expect(result.notTested).toMatchObject({ reason: "no-semantic-observable" })
  expect(result.observation).toBeUndefined()
})

// #32182: alacritty_terminal scrolls cleared primary-screen lines into scrollback on ED 2 (\x1b[2J),
// so totalLines > screenLines on the primary screen while alternate screen has totalLines === screenLines.
test("alt-screen, left-right-margin, and decsscls headless probes offset primary reads by retained scrollback", () => {
  for (const [id, mode] of [
    ["modes.alt-screen.enter", 1049],
    ["modes.alt-screen.exit", 1049],
    ["modes.altscreen-47", 47],
    ["modes.altscreen-1047", 1047],
  ] as const) {
    const { context } = alt1049Source("roundtrip", 20, 5, mode)
    const feed = context.feed.bind(context)
    const getCell = context.getCell.bind(context)
    let onAlt = false
    let scrolled = 0
    context.feed = (sequence: string) => {
      if (sequence === `\x1b[?${mode}h`) onAlt = true
      if (sequence.startsWith(`\x1b[?${mode}l`)) onAlt = false
      if (!onAlt && sequence.includes("\x1b[2J")) scrolled += 1
      feed(sequence)
    }
    context.getScrollback = () => ({
      viewportOffset: 0,
      totalLines: onAlt ? 5 : 5 + scrolled,
      screenLines: 5,
    })
    context.getCell = (row: number, col: number) => {
      const offset = onAlt ? 0 : scrolled
      if (row < offset) return { char: " " } as ReturnType<LibProbeSource["getCell"]>
      return getCell(row - offset, col)
    }
    const probe = modesProbes.find((entry) => entry.id === id)!
    const result = probe.lib!(context)
    expect(result.observation, id).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  }

  // left-right-margin with 1 scrolled line from \x1b[2J (libProbeSource offsets model.getCell by totalLines - screenLines):
  const marginSurface = createSemanticSurface({ cols: 8 })
  let marginScrolled = 0
  const marginSource = libProbeSource({
    ...marginSurface,
    cols: 8,
    getScrollback: () => ({ viewportOffset: 0, totalLines: 24 + marginScrolled, screenLines: 24 }),
    feed(sequence) {
      if (sequence.includes("\x1b[2J")) marginScrolled += 1
      marginSurface.feed(sequence)
    },
  })
  const marginResult = modesProbes.find((entry) => entry.id === "modes.left-right-margin")!.lib!(marginSource)
  expect(marginResult.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })

  // decsscls with 1 blank scrollback line retained above the 24-line active screen:
  let decssclsMeasured = false
  const decssclsLibSource = libProbeSource({
    cols: 80,
    getScrollback: () => ({ viewportOffset: 0, totalLines: 25, screenLines: 24 }),
    feed(sequence) {
      decssclsMeasured = sequence.includes("\x1b[9 p")
    },
    getText: () => (decssclsMeasured ? "\nQ\n\n" : "\n\n\n"),
    getCursor: () => ({ x: decssclsMeasured ? 1 : 0, y: 0, visible: true, style: "block" }),
    getCell() {
      throw new Error("DECSSCLS must use the existing text/cursor readers")
    },
  })
  const decssclsResult = modesProbes.find((entry) => entry.id === "modes.decsscls")!.lib!(decssclsLibSource)
  expect(decssclsResult.notTested).toEqual({ reason: "no-semantic-observable", noObservable: NO_SAME_PATH_CONTROL })
  expect(JSON.parse(decssclsResult.response!)).toMatchObject({ cursor: { x: 1, y: 0 } })
})
