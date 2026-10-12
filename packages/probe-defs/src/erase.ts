import type { ProbeDefinition, ProbeResult, TermContext } from "./types.ts"
import { captureRegionVerdict, type RegionReadback } from "./region-readback.ts"
import { regionReadbackProbes, type RegionReadbackRow } from "./region-readback-kind.ts"
import { probe, isBlank, parserStateResult, unmeasuredCellResult, notTestedResult } from "./helpers.ts"

/**
 * The nine measured Erase rows, as one region-readback kind table (28450; @cto 218ec7fe's rule
 * applied to Erase). Each row holds its claim ONCE: the termless arm reads its seed, its steps and its
 * target cells against the parser, and the kind derives the capture-region oracle's frames from the
 * same fields, so the two arms cannot grade two fixtures.
 *
 * Two rows stay HAND-WRITTEN, each with its one-line coverage record:
 *  - erase.el-with-attrs: the claim is a BACKGROUND ATTRIBUTE on the erased cells. The kind's cell
 *    carries a character only, so before and after are identical by character; a row of it would read
 *    an ignoring surface supported on the termless arm and wrongly read a correct terminal
 *    unsupported on the pixel arm - the deccara/decrara case (@cto 218ec7fe).
 *  - erase.screen.scrollback: the claim is HISTORY (ED3 removes measured scrollback while screen
 *    geometry stays), not a cell window.
 */
/**
 * A control is a cell OUTSIDE the claim whose change means the FIXTURE failed; a cell whose
 * preservation IS the claim is a claim cell and stays in `after`. Every erase row's preserved cells
 * are part of its claim — the un-erased side of EL or ED, the neighbour row of EL 2, the cells past
 * ECH's span — so none of these rows declares a control, and an over-erase reads unsupported instead
 * of inconclusive (@cto 28450 must-fix 2, 2026-10-12). The setup's own witness is each step's CUP
 * cursor report.
 */
export const eraseReadbackRows: readonly RegionReadbackRow[] = [
  {
    id: "erase.character",
    expected: "ECH erases the requested cells from the cursor, leaving the preceding column intact",
    seed: "\x1b[1;1HABCDE",
    before: [["A", "B", "C", "D", "E"]],
    steps: [
      {
        write: "\x1b[1;2H\x1b[2X",
        cursor: { x: 1, y: 0, note: "ECH erases at the cursor; a CUP the terminal ignored erases the wrong cells" },
      },
    ],
    after: [["A", " ", " ", "D", "E"]],
    controls: [],
    seedNote: "ECH seed was not measured",
    controlNote: "ECH names no control: its preserved cells are the claim",
    reset: "",
  },
  {
    id: "erase.line.right",
    expected: "EL0 erases from the cursor to the end of the row and preserves the adjacent row",
    seed: "\x1b[1;1HABCDE\x1b[2;1HKEEP!",
    before: [
      ["A", "B", "C", "D", "E"],
      ["K", "E", "E", "P", "!"],
    ],
    steps: [
      {
        write: "\x1b[1;3H\x1b[K",
        cursor: { x: 2, y: 0, note: "EL0 erases from the cursor; a CUP the terminal ignored erases the wrong span" },
      },
    ],
    after: [
      ["A", "B", " ", " ", " "],
      ["K", "E", "E", "P", "!"],
    ],
    controls: [],
    seedNote: "EL0 seed was not measured",
    controlNote: "EL0 names no control: its preserved cells are the claim",
    reset: "",
  },
  {
    id: "erase.line.left",
    expected: "EL1 erases from the row start through the cursor",
    seed: "\x1b[1;1HABCDE\x1b[2;1HKEEP!",
    before: [
      ["A", "B", "C", "D", "E"],
      ["K", "E", "E", "P", "!"],
    ],
    steps: [
      {
        write: "\x1b[1;3H\x1b[1K",
        cursor: { x: 2, y: 0, note: "EL1 erases through the cursor; a CUP the terminal ignored erases the wrong span" },
      },
    ],
    after: [
      [" ", " ", " ", "D", "E"],
      ["K", "E", "E", "P", "!"],
    ],
    controls: [],
    seedNote: "EL1 seed was not measured",
    controlNote: "EL1 names no control: its preserved cells are the claim",
    reset: "",
  },
  {
    id: "erase.line.all",
    expected: "EL2 erases the whole row and preserves the adjacent row",
    seed: "\x1b[1;1HABCDE\x1b[2;1HKEEP!",
    before: [
      ["A", "B", "C", "D", "E"],
      ["K", "E", "E", "P", "!"],
    ],
    steps: [
      {
        write: "\x1b[1;3H\x1b[2K",
        cursor: { x: 2, y: 0, note: "EL2 erases the whole row at the cursor; an ignored CUP would still erase it" },
      },
    ],
    after: [
      [" ", " ", " ", " ", " "],
      ["K", "E", "E", "P", "!"],
    ],
    controls: [],
    seedNote: "EL2 seed was not measured",
    controlNote: "EL2 names no control: its neighbour row is the claim",
    reset: "",
  },
  {
    id: "erase.screen.below",
    expected: "ED0 erases from the cursor to the end of the screen and preserves the row above",
    seed: "\x1b[1;1HAAAAA\x1b[2;1HBBBBB\x1b[3;1HCCCCC",
    before: [
      ["A", "A", "A", "A", "A"],
      ["B", "B", "B", "B", "B"],
      ["C", "C", "C", "C", "C"],
    ],
    steps: [
      {
        write: "\x1b[2;3H\x1b[J",
        cursor: { x: 2, y: 1, note: "ED0 erases below the cursor; a CUP the terminal ignored erases the wrong side" },
      },
    ],
    after: [
      ["A", "A", "A", "A", "A"],
      ["B", "B", " ", " ", " "],
      [" ", " ", " ", " ", " "],
    ],
    controls: [],
    seedNote: "ED0 seed was not measured",
    controlNote: "ED0 names no control: its preserved row is the claim",
    reset: "",
  },
  {
    id: "erase.screen.above",
    expected: "ED1 erases from the screen start through the cursor and preserves the row below",
    seed: "\x1b[1;1HAAAAA\x1b[2;1HBBBBB\x1b[3;1HCCCCC",
    before: [
      ["A", "A", "A", "A", "A"],
      ["B", "B", "B", "B", "B"],
      ["C", "C", "C", "C", "C"],
    ],
    steps: [
      {
        write: "\x1b[2;3H\x1b[1J",
        cursor: { x: 2, y: 1, note: "ED1 erases above the cursor; a CUP the terminal ignored erases the wrong side" },
      },
    ],
    after: [
      [" ", " ", " ", " ", " "],
      [" ", " ", " ", "B", "B"],
      ["C", "C", "C", "C", "C"],
    ],
    controls: [],
    seedNote: "ED1 seed was not measured",
    controlNote: "ED1 names no control: its preserved row is the claim",
    reset: "",
  },
  {
    id: "erase.screen.all",
    expected: "ED2 erases the whole screen",
    seed: "\x1b[1;1HAAAAA\x1b[2;1HBBBBB\x1b[3;1HCCCCC",
    before: [
      ["A", "A", "A", "A", "A"],
      ["B", "B", "B", "B", "B"],
      ["C", "C", "C", "C", "C"],
    ],
    steps: [
      {
        write: "\x1b[2;3H\x1b[2J",
        cursor: { x: 2, y: 1, note: "ED2 erases the screen at the cursor; the cursor must not move" },
      },
    ],
    after: [
      [" ", " ", " ", " ", " "],
      [" ", " ", " ", " ", " "],
      [" ", " ", " ", " ", " "],
    ],
    controls: [],
    seedNote: "ED2 seed was not measured",
    controlNote: "ED2 names no control: nothing is preserved",
    reset: "",
  },
  {
    id: "erase.selective",
    expected: "Selective erase clears unprotected cells and keeps the DECSCA-protected cell",
    seed: '\x1b[1;1H\x1b[1"qP\x1b[0"qABCDE',
    before: [["P", "A", "B", "C", "D", "E"]],
    steps: [
      {
        write: "\x1b[1;1H\x1b[?2J",
        cursor: {
          x: 0,
          y: 0,
          note: "Selective erase runs from the cursor; a CUP the terminal ignored clears the wrong cells",
        },
      },
    ],
    after: [["P", " ", " ", " ", " ", " "]],
    // NO control, deliberately: the discriminator is the DECSCA-protected P. A terminal that takes it
    // also clears every other cell, so a flank control would move and the row would read inconclusive
    // where it must read unsupported (@chief 2026-10-11T22:58Z).
    controls: [],
    // A selective erase that drops the protection erases the protected P too - a measured negative.
    ignored: [[" ", " ", " ", " ", " ", " "]],
    seedNote: "Selective-erase seed was not measured",
    controlNote: "Selective erase has no preserved cell besides the protected one",
    reset: "",
  },
  {
    id: "erase.ed-scroll-region",
    expected: "ED0 erases below the cursor inside a scroll region and preserves the preceding row",
    seed: "\x1b[1;1HKEEP!\x1b[3;1HERASE",
    before: [
      ["K", "E", "E", "P", "!"],
      [" ", " ", " ", " ", " "],
      ["E", "R", "A", "S", "E"],
    ],
    steps: [
      {
        write: "\x1b[3;10r\x1b[3;1H\x1b[J",
        cursor: {
          x: 0,
          y: 2,
          note: "Scroll-region ED0 runs from the cursor; a CUP the terminal ignored erases the wrong row",
        },
      },
    ],
    after: [
      ["K", "E", "E", "P", "!"],
      [" ", " ", " ", " ", " "],
      [" ", " ", " ", " ", " "],
    ],
    controls: [],
    seedNote: "Scroll-region ED0 seed was not measured",
    controlNote: "Scroll-region ED0 names no control: its preserved row is the claim",
    reset: "\x1b[r",
    cleanup: "\x1b[r",
    // The sequence sets a scroll region whose bottom is row 10, so the fixture needs ten rows even
    // though it compares three.
    minRows: 10,
  },
]

/**
 * erase.el-with-attrs stays HAND-WRITTEN. This is its one-line coverage record (@cto 218ec7fe,
 * 2026-10-12): "not a region-readback row: the kind compares characters, and this claim is an
 * attribute rectangle; it converts when the kind's cell carries attributes". The trigger to convert is
 * a third attribute-rectangle probe, or folding the SGR family's attribute readback (sgr.ts,
 * sgrReadbackDecision) into the region kind, whichever comes first - then both arms get an
 * attribute-carrying cell once, reviewed, and this row converts with it. Its byte-frame readback below
 * still carries the background through the oracle's pixel digest, so the pixel arm keeps its evidence.
 */
const ERASE_EL_WITH_ATTRS_READBACK: Omit<RegionReadback, "pixelGeometry"> = {
  region: { top: 1, left: 1, bottom: 1, right: 5 },
  sentinel: { row: 3, col: 1 },
  cursorRow: 2,
  seed: "\x1b[0m\x1b[2J\x1b[H\x1b[1;1H\x1b[42mXXXXX\x1b[0m\x1b[2;1H",
  edit: "\x1b[1;1H\x1b[42m\x1b[0K\x1b[0m\x1b[2;1H",
  expected: "\x1b[0m\x1b[2J\x1b[H\x1b[1;1H\x1b[42m     \x1b[0m\x1b[2;1H",
  // An EL that does not carry the current background onto the erased cells drops back to the
  // default: the row's claim is the current background, so that frame is a measured negative.
  ignored: "\x1b[0m\x1b[2J\x1b[H\x1b[1;1H     \x1b[0m\x1b[2;1H",
  timeoutMs: 5000,
  pollMs: 250,
  minRows: 3,
  minCols: 6,
}

const ERASE_READBACK_SPECS: Record<string, Omit<RegionReadback, "pixelGeometry">> = {
  "erase.el-with-attrs": ERASE_EL_WITH_ATTRS_READBACK,
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
  ...regionReadbackProbes(eraseReadbackRows),

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
          // The claim is that the erased cells take the CURRENT background. A cell whose background
          // is unavailable cannot be judged; one reporting any other value — the default, or none —
          // has not carried it, and that is a measured negative (@chief 2026-10-11T22:58Z).
          const measurable = typeof after.char === "string" && after.bg !== undefined
          return parserStateResult(
            measurable
              ? isBlank(after.char) &&
                  after.bg?.r === before.bg.r &&
                  after.bg?.g === before.bg.g &&
                  after.bg?.b === before.bg.b
              : null,
            expected,
            { baseline, before, after },
            measurable ? undefined : "Erased cell background metadata unavailable",
          )
        } finally {
          ctx.feed("\x1b[0m")
        }
      },
      async (ctx) => {
        const readback = ERASE_READBACK_SPECS["erase.el-with-attrs"]
        if (readback) {
          const verdict = await captureRegionVerdict(ctx, "erase.el-with-attrs", readback)
          if (verdict) return verdict
        }
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
]
