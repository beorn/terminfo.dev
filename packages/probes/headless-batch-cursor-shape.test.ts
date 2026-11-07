/**
 * @failure Cursor shape credits blind, invalid or mux-ambiguous pixels, or loses its query fast path.
 * @level l1
 * @consumer cursor.shape App fallback
 * @testonly none
 */
import { expect, test } from "vitest"
import { cursorProbes } from "../probe-defs/src/cursor.ts"
import { recordExecutedProbe } from "../probe-defs/src/helpers.ts"
import { finalizeVisualResult } from "../probe-defs/src/sgr.ts"
import { replayTermProbeSource } from "../probe-defs/src/testing/group-harness.ts"
import type { ObservationFrame, ProbeCallbackResult, TermProbeSource } from "../probe-defs/src/types.ts"

async function captureShape(
  readings = ["block", "block", "bar", "underline", "block", "hidden"],
  overrides: Partial<TermProbeSource> = {},
) {
  const events: string[] = []
  const frames: ObservationFrame[] = []
  const context = replayTermProbeSource(new Map(), {
    write: (sequence) => events.push(sequence),
    queryCursorPosition: async () => ({ row: 2, col: 3 }),
    captureGeometry: {
      source: "measured by complete raster calibration",
      geometry: { cellWidth: 10, cellHeight: 18, textWidth: 800, textHeight: 594 },
    },
    input: {
      injectKey: async (key) => {
        events.push(`key:${key}`)
      },
      injectClick: async () => {},
    },
    readInput: async (pattern, _timeout, inject) => {
      await inject?.()
      events.push("read:a")
      return pattern.exec("a")
    },
    capture: async (request) => {
      expect(request.cells).toEqual({ top: 2, left: 3, bottom: 2, right: 3 })
      events.push("capture")
      const digest = readings[frames.length]
      if (digest === undefined) throw new Error("Cursor fixture exhausted its capture readings")
      const frame = {
        ...request,
        ref: `cursor-${events.length}.png`,
        capturedAt: events.length,
        regionDigest: digest,
        pixelsDigest: digest,
        regionRectangle: { x: 20, y: 18, width: 10, height: 18 },
      }
      frames.push(frame)
      return frame
    },
    ...overrides,
  })
  const probe = cursorProbes.find((candidate) => candidate.id === "cursor.shape")
  if (!probe?.term) throw new Error("cursor.shape App callback missing")
  const callback = await probe.term(context)
  return { callback, frames, events }
}

function recordShape(callback: ProbeCallbackResult) {
  const featureId = "cursor.shape"
  return recordExecutedProbe({
    featureId,
    attempt: { scope: "probe", startedAt: "2026-11-07T07:44:35.809Z" },
    ...(callback.observation && { observation: { ...callback.observation, featureId } }),
    ...(callback.notTested && { coverage: { ...callback.notTested, featureId } }),
    assertions: (callback.assertions ?? []).map((assertion) => ({ ...assertion, featureId })),
    tests: callback.tests,
    criterionBranch: callback.criterionBranch,
    rawReplyRef: featureId,
  })
}

test("cursor shape reads its own plain focus key before capturing steady styles", async () => {
  const { events } = await captureShape()
  expect(events.indexOf("key:a")).toBeGreaterThanOrEqual(0)
  expect(events.indexOf("read:a")).toBeGreaterThanOrEqual(0)
  expect(events.indexOf("read:a")).toBeLessThan(events.indexOf("capture"))
  expect(events.some((sequence) => sequence.includes("\x1b[2 q"))).toBe(true)
  expect(events).toContain("\x1b[6 q")
  expect(events).toContain("\x1b[4 q")
  expect(events.some((sequence) => sequence.includes("\x1b[99 q"))).toBe(true)
  expect(events.some((sequence) => sequence.includes("\x1b[?25l"))).toBe(true)
  expect(events.at(-1)).toBe("\x1b[0 q\x1b[?25h")
})

test.each([
  { name: "distinct bar", bar: "bar", madeUp: "block", hidden: "hidden", status: "supported", reason: "steady bar" },
  { name: "no bar", bar: "block", madeUp: "block", hidden: "hidden", status: "unsupported", reason: "drew no bar" },
  {
    name: "underline instead",
    bar: "underline",
    madeUp: "block",
    hidden: "hidden",
    status: "unsupported",
    reason: "drawn as underline",
  },
  {
    name: "made-up invalid before blind and target",
    bar: "block",
    madeUp: "bar",
    hidden: "block",
    status: "probe-invalid",
    reason: "made-up",
  },
  {
    name: "blind before target negative",
    bar: "block",
    madeUp: "block",
    hidden: "block",
    status: "probe-todo",
    reason: "blind",
  },
] as const)("cursor shape decides $name and restores the default", async ({ bar, madeUp, hidden, status, reason }) => {
  const { callback, events } = await captureShape(["block", "block", bar, "underline", madeUp, hidden])
  const recorded = recordShape(callback)
  expect(recorded.status).toBe(status)
  expect(recorded.reason?.toLowerCase()).toContain(reason)
  expect(callback.response).toContain(madeUp)
  expect(events.at(-1)).toBe("\x1b[0 q\x1b[?25h")
})

test("cursor pixel finalization preserves own evidence, query replies and library results", async () => {
  for (const bar of ["bar", "block", "underline"]) {
    const { callback, frames } = await captureShape(["block", "block", bar, "underline", "block", "hidden"])
    const recorded = recordShape(callback)
    expect(finalizeVisualResult(recorded, { kind: "term" }, frames)).toEqual(recorded)
    expect(finalizeVisualResult(recorded, { kind: "lib" }, [])).toEqual(recorded)
    for (const ownFrames of [[], frames.map((frame) => ({ ...frame, ref: `foreign-${frame.ref}` }))]) {
      expect(finalizeVisualResult(recorded, { kind: "term" }, ownFrames).status).toBe("probe-todo")
    }
    for (const outerTerminal of ["Kitty", null]) {
      const subject = { kind: "mux" as const, outerTerminal }
      const result = finalizeVisualResult(recorded, subject, frames)
      if (bar === "bar") {
        expect(result).toEqual(recorded)
      } else {
        expect(result.status).toBe("probe-todo")
        expect(result.reason).toContain(outerTerminal ?? "Missing outer terminal identity")
        expect(result.tests.find((entry) => entry.id === "capture")).toEqual(
          recorded.tests.find((entry) => entry.id === "capture"),
        )
        expect(result.tests.find((entry) => entry.id === "review")).toMatchObject({
          status: "probe-todo",
          assertionRefs: [],
        })
        expect(result.screenshotRef).toBe(recorded.screenshotRef)
      }
    }
  }
  for (const style of [6, 2]) {
    const { callback, frames, events } = await captureShape(undefined, {
      queryWithSentinelOutcome: async (_sequence, pattern) => {
        const raw = `\x1bP1$r${style} q\x1b\\`
        return { reason: "reply", raw, rawBase64: Buffer.from(raw).toString("base64"), match: pattern.exec(raw) }
      },
    })
    const recorded = recordShape(callback)
    expect(recorded.status).toBe(style === 6 ? "supported" : "unsupported")
    expect(recorded.assertionType).toBe("query_reply")
    expect(finalizeVisualResult(recorded, { kind: "mux" }, frames)).toEqual(recorded)
    expect(frames).toEqual([])
    expect(events.at(-1)).toBe("\x1b[0 q")
  }
})

test("cursor shape refuses unsteady or misplaced controls and still restores the default", async () => {
  const unsteady = await captureShape(["block", "bar"])
  expect(unsteady.callback.observation?.outcome).toBe("inconclusive")
  expect(unsteady.frames).toHaveLength(2)
  expect(unsteady.events.at(-1)).toBe("\x1b[0 q\x1b[?25h")
  const misplaced = await captureShape(undefined, { queryCursorPosition: async () => ({ row: 3, col: 3 }) })
  expect(misplaced.callback.tests?.[0]?.reason).toContain("CPR")
  expect(misplaced.frames).toEqual([])
  expect(misplaced.events.at(-1)).toBe("\x1b[0 q\x1b[?25h")
})
