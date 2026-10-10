import type { ProbeDefinition, ProbeResult, TermContext, TermlessContext } from "./types.ts"
import {
  probe,
  isBlank,
  parserStateResult,
  unmeasuredCellResult,
  selectiveEraseResult,
  notTestedResult,
} from "./helpers.ts"

type ErasedCell = string | null

function rowCells(ctx: TermlessContext, row: number): ErasedCell[] {
  return Array.from({ length: 5 }, (_, col) => {
    const char: unknown = ctx.getCell(row, col).char
    return typeof char === "string" ? char : null
  })
}

/** Record the entire small grid fixture, including cells that must survive the erase. */
function eraseRowResult(
  ctx: TermlessContext,
  setup: string,
  sequence: string,
  expected: readonly (string | "blank")[],
  adjacentRow = false,
  expectedCursorX?: number,
): ProbeResult {
  const rows = ctx.getScrollback().screenLines
  if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 6 || !Number.isSafeInteger(rows) || rows < (adjacentRow ? 2 : 1)) {
    return parserStateResult(
      null,
      "Complete erase row fixture",
      { cols: ctx.cols, rows },
      "Measured geometry cannot fit the erase fixture",
    )
  }
  ctx.feed(setup)
  const before = rowCells(ctx, 0)
  const neighborBefore = adjacentRow ? rowCells(ctx, 1) : undefined
  const cursorBefore = expectedCursorX === undefined ? undefined : ctx.getCursor()
  ctx.feed(sequence)
  const after = rowCells(ctx, 0)
  const neighborAfter = adjacentRow ? rowCells(ctx, 1) : undefined
  const response = JSON.stringify({
    before,
    ...(cursorBefore && { cursorBefore: { x: cursorBefore.x, y: cursorBefore.y } }),
    after,
    ...(adjacentRow && { neighborBefore, neighborAfter }),
  })
  const fixtureReady =
    before.join("") === "ABCDE" &&
    (!adjacentRow || neighborBefore?.join("") === "KEEP!") &&
    (expectedCursorX === undefined || (cursorBefore?.x === expectedCursorX && cursorBefore?.y === 0))
  const measured = [...after, ...(neighborAfter ?? [])]
  if (!fixtureReady || measured.some((char) => char === null)) {
    return {
      pass: false,
      response,
      note: "Erase fixture, cursor setup, or cell metadata unavailable",
      observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "parser-state" },
    }
  }
  const exact = expected.every((char, col) => (char === "blank" ? isBlank(after[col] ?? "\0") : after[col] === char))
  const neighborPreserved = !adjacentRow || neighborAfter?.join("") === "KEEP!"
  const supported = exact && neighborPreserved
  return {
    pass: supported,
    response,
    observation: { outcome: supported ? "supported" : "unsupported", evidence: "parser-state" },
    assertions: [
      {
        kind: supported ? "positive" : "negative",
        expected: `row 0 ${expected.join(",")}${adjacentRow ? "; row 1 KEEP!" : ""}${expectedCursorX === undefined ? "" : `; cursor before ${expectedCursorX},0`}`,
        observed: response,
      },
    ],
  }
}

/** ED0/1/2 must change the requested cells while preserving the opposite side. */
function eraseScreenResult(
  ctx: TermlessContext,
  sequence: string,
  expected: readonly [string, string, string],
): ProbeResult {
  const initialScrollback = ctx.getScrollback()
  const lines = initialScrollback.screenLines
  if (!Number.isSafeInteger(lines) || lines < 3 || !Number.isSafeInteger(ctx.cols) || ctx.cols < 6) {
    return {
      pass: false,
      response: JSON.stringify({ initialScrollback }),
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "parser-state",
        note: "Screen fixture needs at least three measured rows and six columns",
      },
    }
  }
  const middle = Math.floor(lines / 2)
  const rows = [0, middle, lines - 1] as const
  ctx.feed(`\x1b[1;1HAAAAA\x1b[${middle + 1};1HBBBBB\x1b[${lines};1HCCCCC\x1b[${middle + 1};3H`)
  const before = rows.map((row) => rowCells(ctx, row))
  const cursorBefore = ctx.getCursor()
  const scrollbackBefore = ctx.getScrollback()
  ctx.feed(sequence)
  const after = rows.map((row) => rowCells(ctx, row))
  const cursorAfter = ctx.getCursor()
  const scrollbackAfter = ctx.getScrollback()
  const response = JSON.stringify({
    rows,
    before,
    cursorBefore: { x: cursorBefore.x, y: cursorBefore.y },
    scrollbackBefore,
    after,
    cursorAfter: { x: cursorAfter.x, y: cursorAfter.y },
    scrollbackAfter,
  })
  const fixtureReady =
    before.every((row, i) => row.join("") === ["AAAAA", "BBBBB", "CCCCC"][i]) &&
    cursorBefore.x === 2 &&
    cursorBefore.y === middle &&
    Number.isInteger(scrollbackBefore.totalLines) &&
    scrollbackBefore.totalLines >= lines &&
    !after.some((row) => row.some((char) => char === null))
  if (!fixtureReady) {
    return {
      pass: false,
      response,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "parser-state",
        note: "Screen fixture, cursor setup, or cell readback unavailable",
      },
    }
  }
  const cellsMatch = expected.every((expectedRow, row) =>
    [...expectedRow].every((expectedChar, col) => {
      const actual = after[row]?.[col]
      return expectedChar === " " ? isBlank(actual ?? "\0") : actual === expectedChar
    }),
  )
  const preservedCursor = cursorAfter.x === cursorBefore.x && cursorAfter.y === cursorBefore.y
  // ED0/1/2 specify visible cells; some terminals also move old rows into scrollback.
  const supported = cellsMatch && preservedCursor
  return {
    pass: supported,
    response,
    observation: { outcome: supported ? "supported" : "unsupported", evidence: "parser-state" },
    assertions: [
      {
        kind: supported ? "positive" : "negative",
        expected: `rows ${rows.join(",")}: ${expected.join("/")}; cursor preserved`,
        observed: response,
      },
    ],
  }
}

/**
 * Capture a seeded erase fixture without interpreting pixels. Returns null when no capture
 * adapter is installed so the caller can keep its legacy query path.
 */
async function eraseSequenceCapture(
  ctx: TermContext,
  minRows: number,
  minCols: number,
  feature: string,
  seed: readonly string[],
  eraseAt: string,
  sequence: string,
  expected: string,
  cleanup = "",
): Promise<ProbeResult | null> {
  if (!ctx.capture) return null
  const { rows, cols } = ctx
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < minRows || cols < minCols) {
    return {
      pass: false,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "none",
        note: `${feature} capture needs at least ${minRows}x${minCols}, measured ${rows}x${cols}`,
      },
    }
  }
  try {
    ctx.write("\x1b[0m\x1b[2J\x1b[H")
    for (const step of seed) ctx.write(step)
    ctx.write("\x1b[0m")
    const before = await ctx.capture!({
      role: "control",
      label: `${feature}: seeded cells before ${JSON.stringify(sequence)}`,
    })
    ctx.write(eraseAt)
    ctx.write(sequence)
    const target = await ctx.capture!({
      role: "target",
      label: `${feature}: after ${JSON.stringify(sequence)}`,
    })
    const observed = JSON.stringify({
      rows,
      cols,
      eraseAt: JSON.stringify(eraseAt),
      sequence: JSON.stringify(sequence),
      before: before.label,
      target: target.label,
    })
    return {
      pass: false,
      response: observed,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "pixels",
        screenshotRef: target.ref,
        frames: [before, target],
        note: `${feature} control and target pixels captured; the erase effect requires independent review. Visual expectation: ${expected}`,
      },
    }
  } finally {
    ctx.write(cleanup)
    ctx.write("\x1b[0m\x1b[2J\x1b[H")
  }
}

/** Capture an owned app's erase effect without interpreting its pixels. */
async function captureEraseFixture(
  ctx: TermContext,
  kind: "line" | "screen",
  sequence: string,
  expected: string,
): Promise<ProbeResult> {
  const rows = ctx.rows
  const cols = ctx.cols
  const minRows = kind === "line" ? 2 : 3
  const capture = ctx.capture
  if (!capture || !Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < minRows || cols < 6) {
    const note = `Erase pixel fixture needs capture and measured ${minRows}x6 geometry; measured ${rows}x${cols}`
    return {
      pass: false,
      observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none", note },
    }
  }

  const middle = Math.floor((rows + 1) / 2)
  const safeCursor = `\x1b[${kind === "line" ? 2 : rows};6H`
  const seed =
    kind === "line" ? "\x1b[1;1HABCDE\x1b[2;1HKEEP!" : `\x1b[1;1HAAAAA\x1b[${middle};1HBBBBB\x1b[${rows};1HCCCCC`
  const eraseAt = `\x1b[${kind === "line" ? 1 : middle};3H`
  try {
    ctx.write("\x1b[0m")
    const blankRow = " ".repeat(cols)
    // CUP clears pending wrap between full rows without scrolling the bottom row.
    for (let row = 1; row <= rows; row++) ctx.write(`\x1b[${row};1H${blankRow}`)
    ctx.write(safeCursor)
    const blank = await capture({ role: "control", label: "Blank erase comparator" })
    ctx.write(seed)
    ctx.write(safeCursor)
    const before = await capture({ role: "control", label: "Before erase: seeded and unaffected cells" })
    ctx.write(eraseAt)
    ctx.write(sequence)
    ctx.write(safeCursor)
    const target = await capture({ role: "target", label: "After erase: target and unaffected cells" })
    const observed = JSON.stringify({
      rows,
      cols,
      middle: kind === "screen" ? middle : undefined,
      blank,
      before,
      target,
    })
    return {
      pass: false,
      response: observed,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "pixels",
        screenshotRef: target.ref,
        frames: [blank, before, target],
        note: "Blank comparator and seeded target/control pixels captured; erase effect requires independent review",
      },
      assertions: [
        {
          kind: "positive",
          expected: `Capture blank comparator, seeded before, and post-${sequence} target at measured geometry; visual expectation ${expected}`,
          observed,
          note: "capture-only assertion; no erase support judgment",
        },
      ],
    }
  } finally {
    ctx.write("\x1b[0m\x1b[2J\x1b[H")
  }
}

const SCROLLBACK_ED3_EXPECTED =
  "ED3 removes captured history: wheel-up after ED3 no longer shows the pre-ED3 history frame"

/**
 * App ED3 cannot read history as cells. Compose existing XTEST wheel + capture:
 * prove history is observable, then grade whether ED3 removes it.
 * Never enable mouse tracking — that would steal the wheel into stdin.
 */
async function scrollbackEraseApp(ctx: TermContext): Promise<ProbeResult> {
  if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 5 || ctx.cols < 5) {
    return {
      pass: false,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "none",
        note: `Erase fixture needs at least 5x5, measured ${ctx.rows}x${ctx.cols}`,
      },
    }
  }
  const capture = ctx.capture
  const input = ctx.input
  const readInput = ctx.readInput
  if (!capture || !input || !readInput) {
    return notTestedResult("OS-level scrollback dump or XTEST wheel+capture", {
      capture: Boolean(capture),
      input: Boolean(input),
      readInput: Boolean(readInput),
    })
  }

  const control = (await readInput(/^a/, 1000, () => input.injectKey("a")))?.[0]
  if (!control) throw new Error("XTEST delivery control failed: plain a did not reach the app")

  try {
    const mark = Math.min(ctx.cols, 40)
    ctx.write("\x1b[2J\x1b[H")
    ctx.write(`${"H".repeat(mark)}\r\n`.repeat(ctx.rows + 2))
    ctx.write("B".repeat(mark))
    const bottom = await capture({ role: "control", label: "Bottom of seeded buffer" })
    await input.injectClick(4)
    const history = await capture({ role: "control", label: "After wheel-up before ED3" })
    if (history.ref === bottom.ref) {
      return notTestedResult("wheel-up did not change captured pixels; cannot observe history", {
        control,
        bottom,
        history,
      })
    }
    await input.injectClick(5)
    const restored = await capture({ role: "control", label: "After wheel-down before ED3" })
    if (restored.ref !== bottom.ref) {
      return notTestedResult("wheel-down did not restore the bottom frame; cannot return from history", {
        control,
        bottom,
        history,
        restored,
      })
    }
    ctx.write("\x1b[3J")
    const erased = await capture({ role: "control", label: "After ED3 at bottom" })
    await input.injectClick(4)
    const after = await capture({ role: "target", label: "After ED3 then wheel-up" })
    const observed = {
      control,
      bottom: bottom.ref,
      history: history.ref,
      restored: restored.ref,
      erased: erased.ref,
      after: after.ref,
    }
    const frames = [bottom, history, restored, erased, after]
    if (after.ref === history.ref) {
      return {
        pass: false,
        response: JSON.stringify(observed),
        observation: {
          outcome: "unsupported",
          evidence: "pixels",
          screenshotRef: after.ref,
          frames,
        },
        assertions: [
          {
            kind: "negative",
            expected: SCROLLBACK_ED3_EXPECTED,
            observed: JSON.stringify(observed),
            action: "erase.screen.scrollback:ed3",
          },
        ],
      }
    }
    if (after.ref === erased.ref) {
      return {
        pass: true,
        response: JSON.stringify(observed),
        observation: {
          outcome: "supported",
          evidence: "pixels",
          screenshotRef: after.ref,
          frames,
        },
        assertions: [
          {
            kind: "positive",
            expected: SCROLLBACK_ED3_EXPECTED,
            observed: JSON.stringify(observed),
            action: "erase.screen.scrollback:ed3",
          },
        ],
      }
    }
    return {
      pass: false,
      response: JSON.stringify(observed),
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "pixels",
        screenshotRef: after.ref,
        frames,
        note: "Post-ED3 wheel-up matched neither the history frame nor the post-ED3 bottom",
      },
    }
  } finally {
    await input.injectClick(5)
    ctx.write("\x1b[0m\x1b[2J\x1b[H")
  }
}

export const eraseProbes: ProbeDefinition[] = [
  {
    ...probe(
      "erase.line.right",
      (ctx) => eraseRowResult(ctx, "ABCDE\x1b[3G", "\x1b[K", ["A", "B", "blank", "blank", "blank"], false, 2),
      (ctx) => captureEraseFixture(ctx, "line", "\x1b[0K", "row 1 AB___; row 2 KEEP!"),
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "erase.line.left",
      (ctx) => eraseRowResult(ctx, "ABCDE\x1b[3G", "\x1b[1K", ["blank", "blank", "blank", "D", "E"], false, 2),
      (ctx) => captureEraseFixture(ctx, "line", "\x1b[1K", "row 1 ___DE; row 2 KEEP!"),
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "erase.line.all",
      (ctx) =>
        eraseRowResult(ctx, "ABCDE\r\nKEEP!\x1b[1;3H", "\x1b[2K", ["blank", "blank", "blank", "blank", "blank"], true),
      (ctx) => captureEraseFixture(ctx, "line", "\x1b[2K", "row 1 _____; row 2 KEEP!"),
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "erase.screen.below",
      (ctx) => eraseScreenResult(ctx, "\x1b[0J", ["AAAAA", "BB   ", "     "]),
      (ctx) => captureEraseFixture(ctx, "screen", "\x1b[0J", "top AAAAA; middle BB___; bottom _____"),
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "erase.screen.above",
      (ctx) => eraseScreenResult(ctx, "\x1b[1J", ["     ", "   BB", "CCCCC"]),
      (ctx) => captureEraseFixture(ctx, "screen", "\x1b[1J", "top _____; middle ___BB; bottom CCCCC"),
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "erase.screen.all",
      (ctx) => eraseScreenResult(ctx, "\x1b[2J", ["     ", "     ", "     "]),
      (ctx) => captureEraseFixture(ctx, "screen", "\x1b[2J", "top/middle/bottom _____"),
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "erase.screen.scrollback",
      (ctx) => {
        const expected = "ED3 removes measured scrollback while keeping screen geometry"
        const initial = ctx.getScrollback()
        const rows = initial.screenLines
        if (!Number.isSafeInteger(rows) || rows < 1 || rows > 1000) {
          return parserStateResult(null, expected, { initial }, "Need a measured screen size for history setup")
        }
        ctx.feed("\r\n".repeat(rows + 2))
        const before = ctx.getScrollback()
        if (!Number.isSafeInteger(before.totalLines) || before.totalLines <= rows || before.screenLines !== rows) {
          return parserStateResult(null, expected, { initial, before }, "No measured scrollback to erase")
        }
        ctx.feed("\x1b[3J")
        const after = ctx.getScrollback()
        const measured =
          Number.isSafeInteger(after.totalLines) && after.totalLines >= rows && after.screenLines === rows
        return parserStateResult(
          measured ? after.totalLines === rows : null,
          expected,
          { before, after },
          measured ? undefined : "Scrollback readback or geometry changed unexpectedly",
        )
      },
      scrollbackEraseApp,
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "erase.character",
      (ctx) => eraseRowResult(ctx, "ABCDE\x1b[1G", "\x1b[3X", ["blank", "blank", "blank", "D", "E"], false, 0),
      async (ctx) => {
        const viaCapture = await eraseSequenceCapture(
          ctx,
          1,
          6,
          "Erase character",
          ["\x1b[1;1HABCDE"],
          "\x1b[1;2H",
          "\x1b[2X",
          "row 1 A__DE with columns 2-3 blank",
        )
        if (viaCapture) return viaCapture
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 1 || ctx.cols < 6) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Erase fixture needs at least 1x6, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("ABCD")
        ctx.write("\x1b[1;2H") // Move to col 2
        ctx.write("\x1b[2X") // ECH 2
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "erased cells or scrollback")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "erase.selective",
      (ctx) => selectiveEraseResult(ctx, "\x1b[?2J", false),
      async (ctx) => {
        const viaCapture = await eraseSequenceCapture(
          ctx,
          1,
          6,
          "Selective erase",
          ['\x1b[1;1H\x1b[1"qP\x1b[0"qABCDE'],
          "\x1b[1;1H",
          "\x1b[?2J",
          "the DECSCA-protected P survives while ABCDE is erased",
        )
        if (viaCapture) return viaCapture
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 1 || ctx.cols < 6) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Erase fixture needs at least 1x6, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("ABCDE")
        ctx.write("\x1b[?2J") // DECSED
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "erased cells or scrollback")
      },
    ),
    termNeedsGeometry: true,
  },

  // EL with background color — erased cells should inherit current bg
  {
    ...probe(
      "erase.el-with-attrs",
      (ctx) => {
        const expected = "EL erases X while preserving its measured non-default background"
        try {
          ctx.feed("\x1b[0m\x1b[1;1HX\x1b[1;1H")
          const baseline = ctx.getCell(0, 0)
          if (baseline.char !== "X" || baseline.bg === undefined) {
            return parserStateResult(null, expected, { baseline }, "Default-background X setup was not measured")
          }
          ctx.feed("\x1b[42m\x1b[1;1HXXXXX\x1b[1;1H")
          const before = ctx.getCell(0, 0)
          if (
            before.char !== "X" ||
            before.bg == null ||
            (baseline.bg !== null &&
              before.bg.r === baseline.bg.r &&
              before.bg.g === baseline.bg.g &&
              before.bg.b === baseline.bg.b)
          ) {
            return parserStateResult(
              null,
              expected,
              { baseline, before },
              "Non-default colored X setup was not measured",
            )
          }
          ctx.feed("\x1b[K")
          const after = ctx.getCell(0, 0)
          const measured = typeof after.char === "string" && after.bg != null
          return parserStateResult(
            measured
              ? isBlank(after.char) &&
                  after.bg?.r === before.bg.r &&
                  after.bg?.g === before.bg.g &&
                  after.bg?.b === before.bg.b
              : null,
            expected,
            { baseline, before, after },
            measured ? undefined : "Erased cell background metadata unavailable",
          )
        } finally {
          ctx.feed("\x1b[0m")
        }
      },
      async (ctx) => {
        const viaCapture = await eraseSequenceCapture(
          ctx,
          1,
          6,
          "EL with background",
          ["\x1b[1;1H\x1b[42mXXXXX"],
          "\x1b[1;1H\x1b[42m",
          "\x1b[K",
          "row 1 erased to the end with the green background retained",
          "\x1b[0m",
        )
        if (viaCapture) return viaCapture
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 1 || ctx.cols < 6) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Erase fixture needs at least 1x6, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H\x1b[2K")
        try {
          ctx.write("\x1b[42m") // green bg
          ctx.write("XXXXX")
          ctx.write("\x1b[1;1H")
          ctx.write("\x1b[K") // EL 0
          const pos = await ctx.queryCursorPosition()
          return unmeasuredCellResult(pos, "erased cells or scrollback")
        } finally {
          ctx.write("\x1b[0m")
        }
      },
    ),
    termNeedsGeometry: true,
  },

  // ED0 preserves rows preceding the cursor, including above a scrolling region.
  {
    ...probe(
      "erase.ed-scroll-region",
      (ctx) => {
        const expected = "ED0 erases measured cells below the cursor and preserves the preceding row"
        const rows = ctx.getScrollback().screenLines
        if (!Number.isSafeInteger(rows) || rows < 10 || !Number.isSafeInteger(ctx.cols) || ctx.cols < 10) {
          return parserStateResult(null, expected, { rows, cols: ctx.cols }, "Need a measured 10x10 fixture")
        }
        try {
          ctx.feed("\x1b[1;1HKEEP!\x1b[3;1HERASE\x1b[3;10r\x1b[3;1H")
          const before = { control: rowCells(ctx, 0), target: rowCells(ctx, 2), cursor: ctx.getCursor() }
          if (
            before.control.join("") !== "KEEP!" ||
            before.target.join("") !== "ERASE" ||
            before.cursor.x !== 0 ||
            before.cursor.y !== 2
          ) {
            return parserStateResult(null, expected, { before }, "Erase region seed or cursor setup failed")
          }
          ctx.feed("\x1b[J")
          const after = { control: rowCells(ctx, 0), target: rowCells(ctx, 2) }
          const valid = after.control.join("") === "KEEP!" && after.target.every((char) => char !== null)
          return parserStateResult(
            valid ? after.target.every((char) => char !== null && isBlank(char)) : null,
            expected,
            { before, after },
            valid ? undefined : "Preceding row or cell metadata was not preserved",
          )
        } finally {
          ctx.feed("\x1b[r")
        }
      },
      async (ctx) => {
        const viaCapture = await eraseSequenceCapture(
          ctx,
          10,
          10,
          "ED at scroll region",
          ["\x1b[1;1HKEEP!", "\x1b[3;1HERASE", "\x1b[3;10r"],
          "\x1b[3;1H",
          "\x1b[J",
          "row 1 KEEP! is preserved while the region cells at and below the cursor are erased",
          "\x1b[r",
        )
        if (viaCapture) return viaCapture
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 10 || ctx.cols < 10) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Erase fixture needs at least 10x10, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[2J\x1b[H") // clear
        ctx.write("KEEP_THIS\r\n")
        for (let i = 1; i <= 5; i++) ctx.write(`row${i}\r\n`)
        try {
          ctx.write("\x1b[3;10r") // scroll region rows 3-10
          ctx.write("\x1b[3;1H") // inside region
          ctx.write("\x1b[J") // ED 0
          const pos = await ctx.queryCursorPosition()
          return unmeasuredCellResult(pos, "erased cells or scrollback")
        } finally {
          ctx.write("\x1b[r") // Restore the owned fixture to full-screen margins.
        }
      },
    ),
    termNeedsGeometry: true,
  },
]
