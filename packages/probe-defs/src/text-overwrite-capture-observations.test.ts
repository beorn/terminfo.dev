/**
 * @failure The overwrite AB->AX capture fixture is wired to text.cr, so text.overwrite grades from cursor advance only.
 * @level l1
 * @consumer App text callbacks for the overwrite fixture on an owned capture terminal.
 * @testonly none
 */
import { expect, test } from "vitest"
import { textProbes } from "./text.ts"
import type { ObservationFrame, TermContext } from "./types.ts"

function captureApp(rows = 24, cols = 80) {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const context: TermContext = {
    rows,
    cols,
    write: (bytes) => writes.push(bytes),
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => null,
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

function find(id: string) {
  const definition = textProbes.find((probe) => probe.id === id)
  if (!definition?.term) throw new Error(`missing app text callback for ${id}`)
  return definition.term
}

test("text.overwrite captures the AB and AX fixtures as control and target frames", async () => {
  const { context, writes, frames } = captureApp()
  const result = await find("text.overwrite")(context)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "pixels",
  })
  expect(result.assertions).toBeUndefined()
  expect(frames.map(({ role }) => role)).toEqual(["control", "target"])
  expect(writes.some((write) => write.includes("AB"))).toBe(true)
  expect(writes.some((write) => write.includes("\x1b[1;2H"))).toBe(true)
  expect(writes.some((write) => write.includes("X"))).toBe(true)
})

test("text.cr never captures; it keeps the CR cursor-query decision", async () => {
  const { context, frames } = captureApp()
  const result = await find("text.cr")(context)
  expect(frames).toEqual([])
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "no-response", evidence: "query" })
})
