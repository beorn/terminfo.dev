/**
 * @failure A row hands a non-ASCII glyph to a run whose launch decodes bytes as ISO-8859-1, so the row grades the launch's character mode as a terminal capability instead of asking for the measured decoding.
 * @level l0
 * @consumer The terminfo probe rows that compare plainly written glyphs (@28752, #28828) and the run's decoding context they read before grading.
 * @testonly none
 */
import { expect, test } from "vitest"
import { ALL_PROBES, type ProbeDefinition, type TermContext } from "../index.ts"

/**
 * The census @cto asked for on 28828 (2026-10-13): a BEHAVIOURAL check, so it drives every real
 * probe rather than scanning their sources. A probe's claim about a glyph it writes or measures is
 * only meaningful in a run whose launch decodes plain UTF-8; the ask is `utf8DecodingRefusal`,
 * which returns before the row writes anything. So: whatever a probe hands the terminal in a utf8
 * run, it must hand nothing non-ASCII in a run measured 8-bit — if it does, it graded the launch.
 *
 * M1 (@cto, same day): one recording terminal is not enough. A row that writes its glyph only
 * after a successful cursor or width answer stops at its first unsupported branch and never
 * reaches the write, so the census now runs TWO utf8 passes — a quiet one that answers nothing and
 * an answering one whose cursor position advances and whose widths are plausible — and judges the
 * UNION of both, each member in both 8-bit passes. The ninth row (unicode.east-asian-ambiguous) is
 * what the quiet pass alone found; the answering pass exists for the shape that hid behind it.
 *
 * M2 (@cto, same day): the 8-bit side now drives ALL app probes in both passes, not only the rows
 * the utf8 census happened to see, so the claim is "no app probe hands a non-ASCII string to an
 * 8-bit run" and no longer depends on what the utf8 pass saw. The union stays below as the
 * non-vacuity evidence that real probes do hand real glyphs to a utf8 run.
 */

const GEOMETRY = { rows: 24, cols: 80 } as const

/** A byte at or above 0x80 is where a Latin-1 launch and a UTF-8 launch disagree. */
const NON_ASCII = /[^\u0000-\u007f]/u

const APP_PROBES: ProbeDefinition[] = ALL_PROBES.filter((probe) => probe.term !== null)

/**
 * One recording terminal. `answers` is the whole difference between the two passes: the quiet one
 * answers nothing, the answering one advances the cursor a column per read and reports a width of
 * 1 for an ASCII sample and 2 for anything else. Queries stay null or a timeout in BOTH, so neither
 * pass invents a terminal that answers a query.
 */
function recordingTerm(decoding: "utf8" | "8-bit", answers: boolean): { ctx: TermContext; handed: string[] } {
  const handed: string[] = []
  const note = (text: string) => handed.push(text)
  let column = 0
  const timeout = async (sequence: string) => {
    note(sequence)
    return { match: null, reason: "timeout" as const, raw: "", rawBase64: "" }
  }
  const ctx: TermContext = {
    write: note,
    queryCursorPosition: async () => (answers ? { row: 1, col: ++column } : null),
    measureRenderedWidth: async (text) => {
      note(text)
      return answers ? (NON_ASCII.test(text) ? 2 : 1) : null
    },
    query: async (sequence) => {
      note(sequence)
      return null
    },
    queryWithSentinel: async (sequence) => {
      note(sequence)
      return null
    },
    queryOutcome: timeout,
    queryWithSentinelOutcome: timeout,
    queryMode: async () => null,
    utf8Decoding: async () => decoding,
    cols: GEOMETRY.cols,
    rows: GEOMETRY.rows,
  }
  return { ctx, handed }
}

/** The rows that handed the terminal a non-ASCII string in one whole pass, in run order. */
async function censusPass(decoding: "utf8" | "8-bit", answers: boolean): Promise<string[]> {
  const seen: string[] = []
  for (const probe of APP_PROBES) {
    const run = recordingTerm(decoding, answers)
    await probe.term!(run.ctx)
    if (run.handed.some((text) => NON_ASCII.test(text))) seen.push(probe.id)
  }
  return seen
}

test("no probe hands a non-ASCII glyph to a run measured 8-bit without asking its decoding first", async () => {
  expect(APP_PROBES.length).toBeGreaterThan(0)

  const quiet = await censusPass("utf8", false)
  const answering = await censusPass("utf8", true)
  const union = [...new Set([...quiet, ...answering])].sort()
  const onlyAnswering = union.filter((id) => !quiet.includes(id))

  // Non-vacuity: the census is only evidence if real probes hand real non-ASCII glyphs to the
  // terminal. Nine did through the quiet pass (measured 2026-10-13 at M1), so a smaller union means
  // the check stopped seeing rows, not that the rows stopped needing it. Both counts are quoted so
  // a row that only the answering pass reaches is visible in the failure, not folded into a total.
  const censusLine =
    `the census saw ${quiet.length} row(s) quietly and ${answering.length} answering (union ${union.length}): ${union.join(", ")}` +
    (onlyAnswering.length > 0 ? ` — only the answering pass reaches: ${onlyAnswering.join(", ")}` : "")
  // Each pass is non-vacuous on its own, so neither can quietly stop seeing rows while the other
  // carries the count.
  expect(quiet.length, censusLine).toBeGreaterThanOrEqual(8)
  expect(answering.length, censusLine).toBeGreaterThanOrEqual(8)
  expect(union.length, censusLine).toBeGreaterThanOrEqual(8)

  const offenders: string[] = []
  for (const probe of APP_PROBES) {
    for (const answers of [false, true]) {
      const latin1 = recordingTerm("8-bit", answers)
      await probe.term!(latin1.ctx)
      const received = latin1.handed.filter((text) => NON_ASCII.test(text))
      // The whole claim: an 8-bit run is a named cause, never a grade, so it must receive no glyph —
      // in either pass, because a row can reach the glyph by one route and not the other.
      if (received.length > 0) {
        offenders.push(`${probe.id} (${answers ? "answering" : "quiet"} pass) handed ${JSON.stringify(received)}`)
      }
    }
  }
  expect(
    offenders,
    "these rows handed a non-ASCII glyph to a run measured 8-bit without asking its decoding first",
  ).toEqual([])
})
