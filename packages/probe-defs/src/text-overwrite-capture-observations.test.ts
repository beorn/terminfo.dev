/**
 * @failure The overwrite AB->AX capture fixture is wired to text.cr, so text.overwrite grades from cursor advance only.
 * @level l1
 * @consumer App text callbacks for the overwrite fixture on an owned capture terminal.
 * @testonly none
 */
import { expect, test } from "vitest"
import { textProbes } from "./text.ts"
import type { ObservationFrame, TermProbeSource } from "./types.ts"

function captureApp(rows = 24, cols = 80) {
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

function find(id: string) {
  const definition = textProbes.find((probe) => probe.id === id)
  if (!definition?.term) throw new Error(`missing app text callback for ${id}`)
  return definition.term
}

test("text.overwrite asks the terminal's pixel report before painting its overwrite fixture", async () => {
  const { context, writes, frames } = captureApp()
  const result = await find("text.overwrite")(context)
  // Missing pixel-geometry replies are execution failures; the fixture still proves no paint/read.
  expect(result.observation).toBeUndefined()
  expect(result.tests).toMatchObject([
    expect.objectContaining({
      status: "test-failure",
      reason: expect.stringContaining("CSI 16 t"),
    }),
  ])
  expect(result.assertions).toBeUndefined()
  expect(frames).toEqual([])
  expect(writes).toEqual([])
})

test("text.cr never captures; it keeps the CR cursor-query decision", async () => {
  const { context, frames } = captureApp()
  const result = await find("text.cr")(context)
  expect(frames).toEqual([])
  expect(result.observation).toBeUndefined()
  expect(result.tests).toMatchObject([expect.objectContaining({ status: "test-failure", reason: expect.any(String) })])
})
