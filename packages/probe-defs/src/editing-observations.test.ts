/**
 * @failure A sparse or uncalibrated cell readback reports a line edit as support even when the seed, cursor setup, or unchanged control is wrong.
 * @level l0
 * @consumer Headless editing observations in the selected terminal results.
 * @testonly none
 */
import { expect, test } from "vitest"
import { editingProbes } from "./editing.ts"
import type { TermlessContext } from "./types.ts"

const cases = [
  {
    id: "editing.insert-chars",
    feature: "\x1b[1@",
    cols: 8,
    before: "ABCDEZQH",
    after: "AB CDEZQ",
  },
  {
    id: "editing.delete-chars",
    feature: "\x1b[1P",
    cols: 8,
    before: "ABCDEZQH",
    after: "ABDEZQH",
  },
  {
    id: "editing.repeat-char",
    feature: "\x1b[3b",
    cols: 6,
    before: "AX   Z",
    after: "AXXXXZ",
  },
] as const

function staged(
  item: (typeof cases)[number],
  options: { before?: string; after?: string; cols?: number; cursor?: { x: number; y: number } } = {},
) {
  const feeds: string[] = []
  let edited = false
  let printedX = false
  const before = options.before ?? item.before
  const after = options.after ?? item.after
  const context: TermlessContext = {
    cols: options.cols ?? item.cols,
    feed(bytes) {
      feeds.push(bytes)
      if (bytes.includes(item.feature)) edited = true
      if (bytes === "X") printedX = true
    },
    feedCapture: () => "",
    getCell(row, col) {
      return {
        char: row === 0 ? ((edited ? after : before)[col] ?? "") : "",
        bold: false,
        dim: false,
        italic: false,
        underline: false,
        strikethrough: false,
        inverse: false,
        hidden: false,
        blink: false,
        fg: null,
        bg: null,
        wide: false,
      }
    },
    getCursor: () => ({
      ...(options.cursor ?? { x: item.id === "editing.repeat-char" && !printedX ? 1 : 2, y: 0 }),
      visible: true,
      style: null,
    }),
    getMode: () => false,
    getText: () => "",
    getScrollback: () => ({ viewportOffset: 0, totalLines: 1, screenLines: 1 }),
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
  }
  return { context, feeds }
}

test.each(cases)("$id binds a measured edit to cells and calibrated controls", (item) => {
  const definition = editingProbes.find((probe) => probe.id === item.id)
  if (!definition?.termless) throw new Error(`Missing headless ${item.id}`)

  const correct = staged(item)
  const supported = definition.termless(correct.context)
  expect(supported.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(supported.assertions?.[0]).toMatchObject({ kind: "positive", observed: supported.response })
  expect(correct.feeds.some((bytes) => bytes.includes(item.feature))).toBe(true)

  const ignored = staged(item, { after: item.before })
  const unsupported = definition.termless(ignored.context)
  expect(unsupported.observation).toMatchObject({ outcome: "unsupported", evidence: "parser-state" })
  expect(unsupported.assertions?.[0]).toMatchObject({ kind: "negative", observed: unsupported.response })

  const badSeed = staged(item, { before: `?${item.before.slice(1)}` })
  expect(definition.termless(badSeed.context).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
  })
  expect(badSeed.feeds.some((bytes) => bytes.includes(item.feature))).toBe(false)

  const badCursor = staged(item, { cursor: { x: 0, y: 0 } })
  expect(definition.termless(badCursor.context).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
  })
  expect(badCursor.feeds.some((bytes) => bytes.includes(item.feature))).toBe(false)

  const badControl = staged(item, { after: `?${item.after.slice(1)}` })
  expect(definition.termless(badControl.context).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
  })

  for (const cols of [item.cols - 1, NaN, Infinity, 1.5]) {
    const noRoom = staged(item, { cols })
    expect(definition.termless(noRoom.context).observation).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
    })
    expect(noRoom.feeds, `${item.id} at ${cols} columns`).toEqual([])
  }
})
