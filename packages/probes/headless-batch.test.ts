/**
 * @failure Headless exceptions borrow an app marker, or a mismarked returned observation enters a graded batch.
 * @level l1
 * @consumer Production headless batch collector
 * @reach imports headless-batch.ts, @terminfo/probe-defs, @termless/xtermjs, @termless/vterm
 * @testonly none
 */
/* oxlint-disable typescript/no-deprecated -- Exercise the production TerminalBackend adapter boundary. */
import { createXtermBackend } from "@termless/xtermjs"
import { createVtermBackend } from "@termless/vterm"
import { ALL_PROBES, type ProbeDefinition } from "@terminfo/probe-defs"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { collectBatch } from "./headless-batch.ts"

const backends: ReturnType<typeof createXtermBackend>[] = []
function backend() {
  const value = createXtermBackend({ cols: 80, rows: 24 })
  backends.push(value)
  return value
}

function definition(
  id: string,
  termless: ProbeDefinition["termless"],
  markers: Pick<ProbeDefinition, "termObservationEvidence" | "termlessObservationEvidence"> = {},
): ProbeDefinition {
  return { id, termless, term: null, ...markers }
}

test("real vterm grades interior-region SU without creating scrollback history", () => {
  const id = "scrollback.scroll-up"
  const probe = ALL_PROBES.find((item) => item.id === id)
  if (!probe) throw new Error(`Missing ${id} registry definition`)
  const value = createVtermBackend({ cols: 80, rows: 24 })
  try {
    const batch = collectBatch(value, "vterm", [probe])
    expect(batch.observations).toMatchObject([{ featureId: id, outcome: "supported", evidence: "parser-state" }])
    expect(batch.assertions).toMatchObject([{ featureId: id, kind: "positive" }])
    const raw = batch.rawReplies[id]
    if (!raw) throw new Error(`Missing ${id} raw measurement`)
    expect(JSON.parse(raw)).toMatchObject({
      seed: ["A", "B", "C", "D", "E"],
      beforeScroll: { totalLines: 24, screenLines: 24 },
      afterScroll: { totalLines: 24, screenLines: 24 },
    })
  } finally {
    value.destroy()
  }
})

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true)
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const value of backends.splice(0)) value.destroy()
})

test("attributes headless exceptions only to the headless marker and leaves legacy throws ungraded", () => {
  const throws = () => {
    throw new TypeError("Callback failed")
  }
  const batch = collectBatch(backend(), "xtermjs", [
    definition("marked", throws, { termObservationEvidence: "query", termlessObservationEvidence: "parser-state" }),
    definition("app-only", throws, { termObservationEvidence: "query" }),
    definition("legacy", throws),
  ])
  expect(batch.observations).toEqual([
    {
      featureId: "marked",
      outcome: "error",
      reason: "collector-error",
      evidence: "parser-state",
      note: "Callback failed",
    },
  ])
  expect(batch.ungradedDiagnostics).toEqual({
    "app-only": { kind: "collector-error", name: "TypeError", message: "Callback failed" },
    legacy: { kind: "collector-error", name: "TypeError", message: "Callback failed" },
  })
  expect(batch.rawReplies).toEqual({})
  expect(batch.assertions).toEqual([])
})

test("routes real registry constructor markers while multi-method callbacks remain ungraded", () => {
  const ids = [
    "sgr.bold",
    "cursor.move.absolute",
    "device.primary-da",
    "extensions.osc133-a",
    "sgr.reset",
    "cursor.save-restore",
    "cursor.cup-scroll-region",
    "extensions.truecolor",
    "extensions.osc30001-color-stack-push",
    "extensions.osc30101-color-stack-pop",
  ]
  const definitions = ids.map((id) => {
    const found = ALL_PROBES.find((probe) => probe.id === id)
    if (!found) throw new Error(`Missing registry definition ${id}`)
    return found
  })
  const value = backend()
  vi.spyOn(value, "reset").mockImplementation(() => {
    throw new Error("Registry setup failed")
  })
  const batch = collectBatch(value, "xtermjs", definitions)
  expect(
    batch.observations.map(({ featureId, outcome, reason, evidence }) => ({ featureId, outcome, reason, evidence })),
  ).toEqual([
    { featureId: "sgr.bold", outcome: "error", reason: "collector-error", evidence: "parser-state" },
    { featureId: "cursor.move.absolute", outcome: "error", reason: "collector-error", evidence: "parser-state" },
    { featureId: "device.primary-da", outcome: "error", reason: "collector-error", evidence: "query" },
    { featureId: "extensions.osc133-a", outcome: "error", reason: "collector-error", evidence: "consumed" },
    { featureId: "sgr.reset", outcome: "error", reason: "collector-error", evidence: "parser-state" },
    { featureId: "cursor.save-restore", outcome: "error", reason: "collector-error", evidence: "parser-state" },
    { featureId: "cursor.cup-scroll-region", outcome: "error", reason: "collector-error", evidence: "parser-state" },
    { featureId: "extensions.truecolor", outcome: "error", reason: "collector-error", evidence: "parser-state" },
  ])
  expect(Object.keys(batch.ungradedDiagnostics).sort()).toEqual(ids.slice(8).sort())
  expect(batch.assertions).toEqual([])
  expect(batch.rawReplies).toEqual({})
})

test("attributes a reset failure to the headless marker before invoking its callback", () => {
  const value = backend()
  vi.spyOn(value, "reset").mockImplementation(() => {
    throw new Error("Reset failed")
  })
  const callback = vi.fn(() => ({ pass: true }))
  const batch = collectBatch(value, "xtermjs", [
    definition("reset", callback, { termlessObservationEvidence: "parser-state" }),
  ])
  expect(callback).not.toHaveBeenCalled()
  expect(batch).toEqual({
    observations: [
      {
        featureId: "reset",
        outcome: "error",
        reason: "collector-error",
        evidence: "parser-state",
        note: "Reset failed",
      },
    ],
    assertions: [],
    rawReplies: {},
    ungradedDiagnostics: {},
  })
})

test("attributes a context operation failure and restores the backend response listener", () => {
  const value = backend()
  const previous = vi.fn()
  value.onResponse = previous
  vi.spyOn(value, "feed").mockImplementation(() => {
    throw new Error("Feed failed")
  })
  const batch = collectBatch(value, "xtermjs", [
    definition(
      "query",
      (ctx) => {
        ctx.feedCapture("\x1b[c")
        return { pass: false }
      },
      { termlessObservationEvidence: "query" },
    ),
  ])
  expect(value.onResponse).toBe(previous)
  expect(batch).toEqual({
    observations: [
      { featureId: "query", outcome: "error", reason: "collector-error", evidence: "query", note: "Feed failed" },
    ],
    assertions: [],
    rawReplies: {},
    ungradedDiagnostics: {},
  })
})

test("fails batch initialization before any per-probe reset or callback if the backend grid is unavailable", () => {
  const value = backend()
  const grid = vi.spyOn(value, "getRow").mockImplementation(() => {
    throw new Error("Grid unavailable")
  })
  const reset = vi.spyOn(value, "reset")
  const callback = vi.fn(() => ({ pass: false }))
  expect(() =>
    collectBatch(value, "xtermjs", [
      definition("first", callback, { termlessObservationEvidence: "parser-state" }),
      definition("second", callback, { termlessObservationEvidence: "query" }),
    ]),
  ).toThrow(`${value.name} has no initialized row 0 grid for headless probes`)
  expect(grid).toHaveBeenCalledTimes(1)
  expect(reset).not.toHaveBeenCalled()
  expect(callback).not.toHaveBeenCalled()
})

test("rejects a returned method that disagrees with the marker and preserves matching or unmeasured refusals", () => {
  const batch = collectBatch(backend(), "xtermjs", [
    definition(
      "wrong",
      () => ({
        pass: false,
        observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" },
      }),
      { termlessObservationEvidence: "parser-state" },
    ),
    definition(
      "matching",
      () => ({
        pass: false,
        observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "parser-state" },
      }),
      { termlessObservationEvidence: "parser-state" },
    ),
    definition(
      "refused",
      () => ({
        pass: false,
        observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none" },
      }),
      { termlessObservationEvidence: "parser-state" },
    ),
  ])
  expect(batch).toEqual({
    observations: [
      {
        featureId: "wrong",
        outcome: "error",
        reason: "collector-error",
        evidence: "query",
        note: "Termless callback wrong declares parser-state evidence but returned query",
      },
      { featureId: "matching", outcome: "inconclusive", reason: "insufficient-evidence", evidence: "parser-state" },
      { featureId: "refused", outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none" },
    ],
    assertions: [],
    rawReplies: {},
    ungradedDiagnostics: {},
  })
})

test.each(["supported", "error", "raw", "assertion"] as const)(
  "rejects a marked none result with %s instead of an unmeasured inconclusive refusal",
  (variant) => {
    const batch = collectBatch(backend(), "xtermjs", [
      definition(
        "invalid-none",
        (ctx) => {
          ctx.feed("X")
          const observed = ctx.getCell(0, 0).char
          return {
            pass: variant === "supported",
            observation: {
              outcome: variant === "supported" ? "supported" : variant === "error" ? "error" : "inconclusive",
              evidence: "none",
              ...(variant !== "supported" && { reason: "insufficient-evidence" as const }),
            },
            ...((variant === "supported" || variant === "raw") && { response: observed }),
            ...((variant === "supported" || variant === "assertion") && {
              assertions: [{ kind: "positive" as const, expected: "X", observed }],
            }),
          }
        },
        { termlessObservationEvidence: "parser-state" },
      ),
    ])
    expect(batch).toEqual({
      observations: [
        {
          featureId: "invalid-none",
          outcome: "error",
          reason: "collector-error",
          evidence: "none",
          note: "Termless callback invalid-none declares parser-state evidence but returned none without an unmeasured refusal",
        },
      ],
      assertions: [],
      rawReplies: {},
      ungradedDiagnostics: {},
    })
  },
)

test("does not promote a marked legacy callback's conclusion into an observation", () => {
  const batch = collectBatch(backend(), "xtermjs", [
    definition("legacy", () => ({ pass: true, note: "Legacy conclusion" }), {
      termlessObservationEvidence: "parser-state",
    }),
  ])
  expect(batch).toEqual({
    observations: [],
    assertions: [],
    rawReplies: {},
    ungradedDiagnostics: { legacy: { kind: "legacy-callback", pass: true, note: "Legacy conclusion" } },
  })
})
