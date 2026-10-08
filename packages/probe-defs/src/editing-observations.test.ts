/**
 * @failure A sparse or uncalibrated cell readback reports a line edit as support even when the seed, cursor setup, or unchanged control is wrong.
 * @level l0
 * @consumer Headless editing observations in the selected terminal results.
 * @testonly none
 */
import { expect, test } from "vitest"
import { editingProbes } from "./editing.ts"
import type { TermContext, TermlessContext } from "./types.ts"

const cases = [
  {
    id: "editing.insert-chars",
    feature: "\x1b[1@",
    cols: 8,
    screenLines: 1,
    before: ["ABCDEZQH"],
    after: ["AB CDEZQ"],
  },
  {
    id: "editing.delete-chars",
    feature: "\x1b[1P",
    cols: 8,
    screenLines: 1,
    before: ["ABCDEZQH"],
    after: ["ABDEZQH"],
  },
  {
    id: "editing.repeat-char",
    feature: "\x1b[3b",
    cols: 6,
    screenLines: 1,
    before: ["AX   Z"],
    after: ["AXXXXZ"],
  },
  {
    id: "editing.insert-lines",
    feature: "\x1b[1L",
    cols: 6,
    screenLines: 4,
    before: ["AAAAA", "BBBBB", "CCCCC", "DDDDD"],
    after: ["AAAAA", "     ", "BBBBB", "CCCCC"],
  },
  {
    id: "editing.delete-lines",
    feature: "\x1b[1M",
    cols: 6,
    screenLines: 4,
    before: ["AAAAA", "BBBBB", "CCCCC", "DDDDD"],
    after: ["AAAAA", "CCCCC", "DDDDD", "UNMEASURED"],
  },
] as const

function staged(
  item: (typeof cases)[number],
  options: {
    before?: readonly string[]
    after?: readonly string[]
    cols?: number
    screenLines?: number
    cursor?: { x: number; y: number }
  } = {},
) {
  const feeds: string[] = []
  const afterReadRows: number[] = []
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
      if (edited) afterReadRows.push(row)
      return {
        char: (edited ? after : before)[row]?.[col] ?? "",
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
      ...(options.cursor ??
        (item.id === "editing.insert-lines" || item.id === "editing.delete-lines"
          ? { x: 0, y: 1 }
          : { x: item.id === "editing.repeat-char" && !printedX ? 1 : 2, y: 0 })),
      visible: true,
      style: null,
    }),
    getMode: () => false,
    getText: () => "",
    getScrollback: () => ({
      viewportOffset: 0,
      totalLines: options.screenLines ?? item.screenLines,
      screenLines: options.screenLines ?? item.screenLines,
    }),
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
  return { context, feeds, afterReadRows }
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

  const badSeed = staged(item, { before: [`?${(item.before[0] ?? "").slice(1)}`, ...item.before.slice(1)] })
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

  const badControl = staged(item, { after: [`?${(item.after[0] ?? "").slice(1)}`, ...item.after.slice(1)] })
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
  if (item.id === "editing.insert-lines" || item.id === "editing.delete-lines") {
    for (const screenLines of [3, NaN, Infinity, 1.5]) {
      const noRows = staged(item, { screenLines })
      expect(definition.termless(noRows.context).observation).toMatchObject({
        outcome: "inconclusive",
        reason: "insufficient-evidence",
      })
      expect(noRows.feeds, `${item.id} with ${screenLines} screen lines`).toEqual([])
    }
  }
  if (item.id === "editing.delete-lines") expect(correct.afterReadRows).not.toContain(3)
})

// Each case has a measured target and an unchanged flank. The synthetic backend
// exposes cells only; the probe must establish its own setup before classifying.
const remainingCases = [
  {
    id: "editing.decfra",
    feature: "\x1b[88;1;1;3;5$x",
    cols: 6,
    rows: 3,
    before: ["aaaaaZ", "bbbbbY", "cccccW"],
    after: ["XXXXXZ", "XXXXXY", "XXXXXW"],
    inverseBefore: false,
    inverseAfter: false,
  },
  {
    id: "editing.decera",
    feature: "\x1b[1;1;3;5$z",
    cols: 6,
    rows: 3,
    before: ["aaaaaZ", "bbbbbY", "cccccX"],
    after: ["     Z", "     Y", "     X"],
    inverseBefore: false,
    inverseAfter: false,
  },
  {
    id: "editing.deccra",
    feature: "\x1b[1;1;2;5;1;5;10$v",
    cols: 14,
    rows: 6,
    before: [
      "ABCDE.........",
      "FGHIJ.........",
      "..............",
      "..............",
      ".........12345",
      ".........67890",
    ],
    after: ["ABCDE.........", "FGHIJ.........", "..............", "..............", ".........ABCDE", ".........FGHIJ"],
    inverseBefore: false,
    inverseAfter: false,
  },
  {
    id: "editing.deccara",
    feature: "\x1b[1;1;3;5;7$r",
    cols: 6,
    rows: 3,
    before: ["aaaaaZ", "bbbbbY", "cccccX"],
    after: ["aaaaaZ", "bbbbbY", "cccccX"],
    inverseBefore: false,
    inverseAfter: true,
  },
  {
    id: "editing.decrara",
    feature: "\x1b[1;1;3;5;7$t",
    cols: 6,
    rows: 3,
    before: ["aaaaaZ", "bbbbbY", "cccccX"],
    after: ["aaaaaZ", "bbbbbY", "cccccX"],
    inverseBefore: true,
    inverseAfter: false,
  },
  {
    id: "editing.sl",
    feature: "\x1b[2 @",
    cols: 9,
    rows: 2,
    before: ["ABCDEFGHI", "JKLMNOPQR"],
    after: ["CDEFGHI  ", "LMNOPQR  "],
    inverseBefore: false,
    inverseAfter: false,
  },
  {
    id: "editing.sr",
    feature: "\x1b[2 A",
    cols: 9,
    rows: 2,
    before: ["ABCDEFGHI", "JKLMNOPQR"],
    after: ["  ABCDEFG", "  JKLMNOP"],
    inverseBefore: false,
    inverseAfter: false,
  },
  {
    id: "editing.decic",
    feature: "\x1b[2'}",
    cols: 8,
    rows: 3,
    before: ["ABCDEFGH", "IJKLMNOP", "QRSTUVWX"],
    after: ["AB  CDEF", "IJ  KLMN", "QR  STUV"],
    inverseBefore: false,
    inverseAfter: false,
  },
  {
    id: "editing.decdc",
    feature: "\x1b[2'~",
    cols: 8,
    rows: 3,
    before: ["ABCDEFGH", "IJKLMNOP", "QRSTUVWX"],
    after: ["ABEFGH  ", "IJMNOP  ", "QRUVWX  "],
    inverseBefore: false,
    inverseAfter: false,
  },
] as const

type RemainingCase = (typeof remainingCases)[number]

function stagedRemaining(
  item: RemainingCase,
  options: {
    before?: readonly string[]
    after?: readonly string[]
    cursor?: { x: number; y: number }
    cols?: number
    rows?: number
    wrongControl?: boolean
    ignored?: boolean
    thirdRowOverfill?: boolean
    emptyBlanks?: boolean
    afterCells?: readonly (readonly string[])[]
  } = {},
) {
  const feeds: string[] = []
  let edited = false
  let measuredThirdFlank = ""
  const before = options.before ?? item.before
  const after = options.after ?? item.after
  const context: TermlessContext = {
    cols: options.cols ?? item.cols,
    feed(bytes) {
      feeds.push(bytes)
      if (options.thirdRowOverfill) measuredThirdFlank = /\x1b\[3;1Hccccc(.)/.exec(bytes)?.[1] ?? measuredThirdFlank
      if (bytes.includes(item.feature)) edited = true
    },
    feedCapture: () => "",
    getCell(row, col) {
      const char =
        options.thirdRowOverfill && row === 2 && col === 5
          ? edited
            ? "X"
            : measuredThirdFlank
          : edited && options.afterCells
            ? (options.afterCells[row]?.[col] ?? "")
            : ((edited ? after : before)[row]?.[col] ?? "")
      const observedChar = options.emptyBlanks && char === " " ? "" : char
      const inverse = col < 5 && row < 3 && (edited && !options.ignored ? item.inverseAfter : item.inverseBefore)
      const controlCol = item.id === "editing.decic" || item.id === "editing.decdc" ? 0 : item.cols - 1
      return {
        char: options.wrongControl && edited && row === 0 && col === controlCol ? "?" : observedChar,
        bold: false,
        dim: false,
        italic: false,
        underline: false,
        strikethrough: false,
        inverse,
        hidden: false,
        blink: false,
        fg: null,
        bg: null,
        wide: false,
      }
    },
    getCursor: () => ({
      ...(options.cursor ??
        (item.id === "editing.decic" || item.id === "editing.decdc" ? { x: 2, y: 1 } : { x: 0, y: 0 })),
      visible: true,
      style: null,
    }),
    getMode: () => false,
    getText: () => "",
    getScrollback: () => ({
      viewportOffset: 0,
      totalLines: options.rows ?? item.rows,
      screenLines: options.rows ?? item.rows,
    }),
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

test.each(remainingCases)("$id classifies measured cells only after calibrated setup", (item) => {
  const definition = editingProbes.find((probe) => probe.id === item.id)
  if (!definition?.termless) throw new Error(`Missing headless ${item.id}`)
  const correct = stagedRemaining(item)
  const supported = definition.termless(correct.context)
  expect(supported.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(supported.assertions?.[0]).toMatchObject({ kind: "positive", observed: supported.response })
  expect(correct.feeds.some((bytes) => bytes.includes(item.feature))).toBe(true)

  const ignored = definition.termless(stagedRemaining(item, { after: item.before, ignored: true }).context)
  expect(ignored.observation).toMatchObject({ outcome: "unsupported", evidence: "parser-state" })
  expect(ignored.assertions?.[0]).toMatchObject({ kind: "negative", observed: ignored.response })

  const badSeed = stagedRemaining(item, { before: [`?${item.before[0].slice(1)}`, ...item.before.slice(1)] })
  expect(definition.termless(badSeed.context).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
  })
  expect(badSeed.feeds.some((bytes) => bytes.includes(item.feature))).toBe(false)

  const badCursor = stagedRemaining(item, { cursor: { x: 5, y: 5 } })
  expect(definition.termless(badCursor.context).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
  })
  expect(badCursor.feeds.some((bytes) => bytes.includes(item.feature))).toBe(false)

  if (item.id !== "editing.sl" && item.id !== "editing.sr") {
    const badControl = stagedRemaining(item, { wrongControl: true })
    expect(definition.termless(badControl.context).observation).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
    })
  }

  for (const cols of [item.cols - 1, NaN]) {
    const invalid = stagedRemaining(item, { cols })
    expect(definition.termless(invalid.context).observation).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
    })
    expect(invalid.feeds).toEqual([])
  }
  for (const rows of [item.rows - 1, NaN]) {
    const invalid = stagedRemaining(item, { rows })
    expect(definition.termless(invalid.context).observation).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
    })
    expect(invalid.feeds).toEqual([])
  }
})

// The fill character cannot also be the outside sentinel: a one-cell spill
// would otherwise look identical to a correct DECFRA observation.
test("DECFRA third-row overfill invalidates its measured flank", () => {
  const item = remainingCases.find((entry) => entry.id === "editing.decfra")
  if (!item) throw new Error("Missing DECFRA fixture")
  const definition = editingProbes.find((probe) => probe.id === item.id)
  if (!definition?.termless) throw new Error("Missing DECFRA headless callback")
  const spill = stagedRemaining(item, { thirdRowOverfill: true })
  const result = definition.termless(spill.context)
  expect(spill.feeds.some((bytes) => bytes.includes(item.feature))).toBe(true)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
})

test.each(["editing.decera", "editing.sl", "editing.sr", "editing.decic", "editing.decdc"])(
  "%s accepts empty cells as positional blanks",
  (id) => {
    const item = remainingCases.find((entry) => entry.id === id)
    if (!item) throw new Error(`Missing ${id} fixture`)
    const definition = editingProbes.find((probe) => probe.id === id)
    if (!definition?.termless) throw new Error(`Missing ${id} headless callback`)
    const result = definition.termless(stagedRemaining(item, { emptyBlanks: true }).context)
    expect(result.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  },
)

test("SL refuses a misplaced empty cell that collapses to the expected joined text", () => {
  const item = remainingCases.find((entry) => entry.id === "editing.sl")
  if (!item) throw new Error("Missing SL fixture")
  const definition = editingProbes.find((probe) => probe.id === item.id)
  if (!definition?.termless) throw new Error("Missing SL headless callback")
  const misplaced = stagedRemaining(item, {
    afterCells: [
      ["C", "D", "E", "F", "G", "H", "", "I", ""],
      ["L", "M", "N", "O", "P", "Q", "R", "", ""],
    ],
  })
  expect(definition.termless(misplaced.context).observation).toMatchObject({ outcome: "unsupported" })
})

test("SL accounts for measured incoming columns 10 and 11 on a wider screen", () => {
  const item = remainingCases.find((entry) => entry.id === "editing.sl")
  if (!item) throw new Error("Missing SL fixture")
  const definition = editingProbes.find((probe) => probe.id === item.id)
  if (!definition?.termless) throw new Error("Missing SL headless callback")
  const wide = stagedRemaining(item, {
    cols: 11,
    before: ["ABCDEFGHIJK", "JKLMNOPQRST"],
    after: ["CDEFGHIJK", "LMNOPQRST"],
  })
  expect(definition.termless(wide.context).observation).toMatchObject({ outcome: "supported" })
})

test("DECDC accounts for measured incoming columns 9 and 10 on a wider screen", () => {
  const item = remainingCases.find((entry) => entry.id === "editing.decdc")
  if (!item) throw new Error("Missing DECDC fixture")
  const definition = editingProbes.find((probe) => probe.id === item.id)
  if (!definition?.termless) throw new Error("Missing DECDC headless callback")
  const wide = stagedRemaining(item, {
    cols: 10,
    before: ["ABCDEFGHIJ", "IJKLMNOPQR", "QRSTUVWXab"],
    after: ["ABEFGHIJ  ", "IJMNOPQR  ", "QRUVWXab  "],
  })
  expect(definition.termless(wide.context).observation).toMatchObject({ outcome: "supported" })
})

// The old checksum probe accepted another request's response and emitted a
// five-parameter rectangle request. Bind all six parameters and the reply id.
test("checksum observations require a complete reply for the issued request", () => {
  const definition = editingProbes.find((probe) => probe.id === "editing.decrqcra")
  if (!definition?.termless) throw new Error("Missing checksum probe")
  for (const raw of ["\x1bP1!~012F\x1b\\", "\x1bP2!~012F\x1b\\", "\x1bP1!~012F", ""]) {
    const context = staged(cases[0]).context
    const requests: string[] = []
    context.feedCapture = (bytes) => {
      requests.push(bytes)
      return raw
    }
    const result = definition.termless(context)
    expect(requests).toEqual(["\x1b[1;1;1;1;1;5*y"])
    expect(result.response).toBe(raw)
    expect(result.observation).toMatchObject({
      outcome: raw === "\x1bP1!~012F\x1b\\" ? "supported" : "inconclusive",
      evidence: "query",
    })
    if (result.pass) expect(result.assertions?.[0]).toMatchObject({ kind: "positive", observed: raw })
  }
})

// The app path used a bare 2000 ms timeout, so a terminal that never answers was
// graded inconclusive after two seconds instead of disproved by the DA1 sentinel.
test("checksum app path is bound to the issued request and ends on the DA1 sentinel", async () => {
  const definition = editingProbes.find((probe) => probe.id === "editing.decrqcra")
  if (!definition?.term) throw new Error("Missing checksum app callback")
  const context = (outcome: {
    match: string[] | null
    reason: "reply" | "sentinel" | "timeout"
    raw: string
    sentinel?: { atMs: number; graceMs: number }
  }) => {
    const queries: string[] = []
    return {
      queries,
      value: {
        write: () => undefined,
        queryWithSentinelOutcome: async (sequence: string) => {
          queries.push(sequence)
          return { ...outcome, rawBase64: "" }
        },
        queryOutcome: async () => {
          throw new Error("the checksum app path must use the DA1 sentinel, not a bare timeout")
        },
      } as unknown as TermContext,
    }
  }
  const answered = context({ match: ["\x1bP1!~012F\x1b\\"], reason: "reply", raw: "\x1bP1!~012F\x1b\\\x1b[?62;c" })
  const supported = await definition.term(answered.value)
  expect(answered.queries).toEqual(["\x1b[1;1;1;1;1;1*y"])
  expect(supported.observation).toMatchObject({ outcome: "supported", evidence: "query" })
  expect(supported.assertions).toMatchObject([{ kind: "positive" }])

  // F1: a complete checksum reply that lands after the DA1 answer is a late reply, graded by its
  // own bytes and recorded with the ordering note (device.ts:25-30's rule).
  const lateReply = context({
    match: ["\x1bP1!~012F\x1b\\"],
    reason: "reply",
    raw: "\x1b[?62;c\x1bP1!~012F\x1b\\",
    sentinel: { atMs: 9, graceMs: 250 },
  })
  const late = await definition.term(lateReply.value)
  expect(lateReply.queries).toEqual(["\x1b[1;1;1;1;1;1*y"])
  expect(late.observation).toMatchObject({
    outcome: "supported",
    evidence: "query",
    note: "Checks framed reply and request id; checksum arithmetic is not verified; reply after sentinel",
  })
  expect(late.assertions).toMatchObject([{ kind: "positive" }])

  // A frame after DA1 with no measured ordering keeps its null: it is not graded supported.
  const unorderedLateReply = context({
    match: ["\x1bP1!~012F\x1b\\"],
    reason: "reply",
    raw: "\x1b[?62;c\x1bP1!~012F\x1b\\",
  })
  const unordered = await definition.term(unorderedLateReply.value)
  expect(unordered.observation).toMatchObject({ outcome: "inconclusive", evidence: "query" })
  expect(unordered.assertions).toBeUndefined()

  // F1: DA1 answered alone through the grace window is a measured negative, not an unknown.
  const silent = context({
    match: null,
    reason: "sentinel",
    raw: "\x1b[?62;c",
    sentinel: { atMs: 9, graceMs: 250 },
  })
  const unanswered = await definition.term(silent.value)
  expect(silent.queries).toEqual(["\x1b[1;1;1;1;1;1*y"])
  expect(unanswered.observation).toMatchObject({
    outcome: "unsupported",
    evidence: "query",
    note: "negative by sentinel",
  })
  expect(unanswered.assertions).toMatchObject([
    { kind: "negative", observed: "DA1 answered at +9ms; no reply through the 250 ms window" },
  ])

  // F1: a read with no DA1 at all stays unknown, and its reason keeps the timeout marker.
  const timedOut = context({ match: null, reason: "timeout", raw: "" })
  const notAnswered = await definition.term(timedOut.value)
  expect(notAnswered.observation).toMatchObject({ outcome: "inconclusive", evidence: "query", reason: "timeout" })
  expect(notAnswered.assertions).toBeUndefined()

  // A raw that carries more than DA1 is a partial frame, not silence: the inconclusive grade stays.
  const partial = context({ match: null, reason: "sentinel", raw: "\x1bP1!~012\x1b[?62;c" })
  const partialResult = await definition.term(partial.value)
  expect(partialResult.observation).toMatchObject({ outcome: "inconclusive", evidence: "query" })
  expect(partialResult.assertions).toBeUndefined()
})

test("DECSACE app leaves the mode unchanged when extent is not measured", async () => {
  const definition = editingProbes.find((probe) => probe.id === "editing.decsace")
  if (!definition?.term || !definition.termless) throw new Error("Missing DECSACE callbacks")
  const writes: string[] = []
  const app = await definition.term({
    write: (bytes: string) => {
      writes.push(bytes)
    },
    queryCursorPosition: async () => {
      throw new Error("CPR cannot measure DECSACE extent")
    },
  } as unknown as TermContext)
  expect(writes).toEqual([])
  expect(app.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none" })
  expect(app.assertions).toBeUndefined()

  const feeds: string[] = []
  const headless = definition.termless({
    feed: (bytes: string) => {
      feeds.push(bytes)
    },
    getText: () => "sample",
  } as unknown as TermlessContext)
  expect(feeds).toEqual(["\x1b[1;1H\x1b[2*x"])
  expect(headless.observation).toMatchObject({ outcome: "inconclusive", evidence: "consumed" })
})
