/**
 * @failure Observable extension rendering is graded from consumption, or a capture attempt is silently credited as support.
 * @level l1
 * @consumer App extension callbacks for truecolor, Sixel and iTerm2 images on an owned capture terminal.
 * @testonly none
 */
import { expect, test } from "vitest"
import { extensionsProbes } from "./extensions.ts"
import type { ObservationFrame, TermProbeSource } from "./types.ts"

function captureApp(rows: number, cols: number) {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const context: TermProbeSource = {
    kind: "live",
    rows,
    cols,
    write: (bytes) => writes.push(bytes),
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    // A real context writes the query bytes before waiting; record them so a probe's query is
    // observable here instead of vanishing into the fake.
    queryWithSentinelOutcome: async (sequence: string) => {
      writes.push(sequence)
      return { match: null, reason: "timeout", raw: "", rawBase64: "" }
    },
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

// extensions.truecolor is NOT here: its claim is cell storage, decided by the DECRQSS SGR oracle
// (extensions-qualification covers it), and a pixel comparison was never able to decide it.
// extensions.sixel is NOT here: it decides through the region oracle against an independent
// SGR-background reference (sixel-capture.test.ts), so it no longer records unasserted frames.
const capturedIds = ["extensions.iterm2-images"] as const

test.each(capturedIds)("%s binds control+target pixels while visual review remains pending", async (id) => {
  const { context, writes, frames } = captureApp(24, 80)
  const result = await find(id).term!(context)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    assertionType: "screenshot",
  })
  expect(result.pass).toBe(false)
  expect(result.criterionBranch).toBe("visual-review")
  expect(result.tests).toEqual([
    { id: "capture", status: "supported", assertionRefs: [0] },
    { id: "review", status: "test-todo", reason: expect.any(String) },
  ])
  expect(result.assertions).toEqual([
    {
      assertionType: "screenshot",
      kind: "positive",
      expected: expect.any(String),
      observed: JSON.stringify({ control: frames[0], target: frames[1] }),
    },
  ])
  expect(frames.map(({ role }) => role)).toEqual(["control", "target"])
  expect(result.observation?.frames).toHaveLength(2)
  expect(writes.length).toBeGreaterThan(0)
})

test.each(capturedIds)("%s refuses an undersized capture terminal before any bytes", async (id) => {
  const { context, writes, frames } = captureApp(2, 8)
  const result = await find(id).term!(context)
  expect(result.observation).toBeUndefined()
  expect(result.tests).toMatchObject([expect.objectContaining({ status: "test-todo", reason: expect.any(String) })])
  expect(result.assertions).toBeUndefined()
  expect(frames).toEqual([])
  expect(writes).toEqual([])
})

test("each image target writes its own payload rather than a generic consumption check", async () => {
  const sixel = captureApp(24, 80)
  // With no measured pixel report the sixel row refuses by name before painting: a tile that
  // cannot be sized from the run is not a measurement, and a guessed size would be.
  const refused = await find("extensions.sixel").term!(sixel.context)
  expect(refused.observation).toBeUndefined()
  expect(refused.tests).toMatchObject([expect.objectContaining({ status: "test-failure", reason: expect.any(String) })])
  expect(sixel.writes.some((write) => write.includes("\x1bP0;1;0q"))).toBe(false)
  const iterm = captureApp(24, 80)
  await find("extensions.iterm2-images").term!(iterm.context)
  expect(iterm.writes.some((write) => write.includes("\x1b]1337;File=inline=1"))).toBe(true)
  // Truecolor asks the terminal for its own SGR state instead of painting two RGB runs.
  const truecolor = captureApp(24, 80)
  await find("extensions.truecolor").term!(truecolor.context)
  expect(truecolor.writes.some((write) => write.includes("\x1b[38;2;255;128;0m"))).toBe(true)
  expect(truecolor.writes.some((write) => write.includes("\x1bP$qm"))).toBe(true)
})

test("extensions.font-ligatures captures a spaced control and a contiguous operator sample", async () => {
  const { context, writes, frames } = captureApp(24, 80)
  const result = await find("extensions.font-ligatures").term!(context)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    assertionType: "screenshot",
  })
  expect(result.pass).toBe(false)
  expect(result.criterionBranch).toBe("visual-review")
  expect(result.tests).toEqual([
    { id: "capture", status: "supported", assertionRefs: [0] },
    { id: "review", status: "test-todo", reason: expect.any(String) },
  ])
  expect(result.assertions).toEqual([
    {
      assertionType: "screenshot",
      kind: "positive",
      expected: expect.any(String),
      observed: JSON.stringify({ control: frames[0], target: frames[1] }),
    },
  ])
  expect(frames.map(({ role }) => role)).toEqual(["control", "target"])
  expect(result.observation?.frames).toHaveLength(2)
  expect(writes.some((write) => write.includes("! = - > = > < = = ="))).toBe(true)
  expect(writes.some((write) => write.includes("!= -> => <= =="))).toBe(true)
})

test("extensions.font-ligatures fits the minimum admitted three-row capture geometry", async () => {
  const { context, writes, frames } = captureApp(3, 80)
  const result = await find("extensions.font-ligatures").term!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", assertionType: "screenshot" })
  expect(frames.map(({ role }) => role)).toEqual(["control", "target"])
  expect(writes.some((write) => write.includes("!= -> => <= =="))).toBe(true)
})

test("extensions.font-ligatures names a missing capture instead of claiming a measurement", async () => {
  const { context, frames } = captureApp(24, 80)
  const noCapture = { ...context, capture: undefined }
  const result = await find("extensions.font-ligatures").term!(noCapture)
  expect(result.notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable: expect.stringContaining("capture"),
  })
  expect(result.observation).toBeUndefined()
  expect(result.assertions).toBeUndefined()
  expect(frames).toEqual([])
})

test("extensions.font-ligatures refuses an undersized capture terminal before any bytes", async () => {
  const { context, writes, frames } = captureApp(2, 8)
  const result = await find("extensions.font-ligatures").term!(context)
  expect(result.observation).toBeUndefined()
  expect(result.tests).toMatchObject([expect.objectContaining({ status: "test-todo", reason: expect.any(String) })])
  expect(result.assertions).toBeUndefined()
  expect(frames).toEqual([])
  expect(writes).toEqual([])
})
