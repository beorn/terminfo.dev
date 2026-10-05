/**
 * @failure Observable extension rendering is graded from consumption, or a capture attempt is silently credited as support.
 * @level l1
 * @consumer App extension callbacks for truecolor, Sixel and iTerm2 images on an owned capture terminal.
 * @testonly none
 */
import { expect, test } from "vitest"
import { extensionsProbes } from "./extensions.ts"
import type { ObservationFrame, TermContext } from "./types.ts"

function captureApp(rows: number, cols: number) {
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
  const definition = extensionsProbes.find((probe) => probe.id === id)
  if (!definition?.term) throw new Error(`missing app extension callback for ${id}`)
  return definition
}

const capturedIds = ["extensions.truecolor", "extensions.sixel", "extensions.iterm2-images"] as const

test.each(capturedIds)("%s records control+target pixels as honest, unasserted inconclusive evidence", async (id) => {
  const { context, writes, frames } = captureApp(24, 80)
  const result = await find(id).term!(context)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "pixels",
  })
  expect(result.assertions).toBeUndefined()
  expect(frames.map(({ role }) => role)).toEqual(["control", "target"])
  expect(result.observation?.frames).toHaveLength(2)
  expect(writes.length).toBeGreaterThan(0)
})

test.each(capturedIds)("%s refuses an undersized capture terminal before any bytes", async (id) => {
  const { context, writes, frames } = captureApp(2, 8)
  const result = await find(id).term!(context)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "none",
  })
  expect(result.assertions).toBeUndefined()
  expect(frames).toEqual([])
  expect(writes).toEqual([])
})

test("each image target writes its own payload rather than a generic consumption check", async () => {
  const sixel = captureApp(24, 80)
  await find("extensions.sixel").term!(sixel.context)
  expect(sixel.writes.some((write) => write.includes("\x1bP0;1;0q"))).toBe(true)
  const iterm = captureApp(24, 80)
  await find("extensions.iterm2-images").term!(iterm.context)
  expect(iterm.writes.some((write) => write.includes("\x1b]1337;File=inline=1"))).toBe(true)
  const truecolor = captureApp(24, 80)
  await find("extensions.truecolor").term!(truecolor.context)
  expect(truecolor.writes.some((write) => write.includes("\x1b[38;2;255;128;0m"))).toBe(true)
  expect(truecolor.writes.some((write) => write.includes("\x1b[38;2;17;97;201m"))).toBe(true)
})
