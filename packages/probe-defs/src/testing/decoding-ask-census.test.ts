/**
 * @failure A row hands a non-ASCII glyph to a run whose launch decodes bytes as ISO-8859-1, so the row grades the launch's character mode as a terminal capability instead of asking for the measured decoding.
 * @level l0
 * @consumer The terminfo probe rows that compare plainly written glyphs (@28752, #28828) and the run's decoding context they read before grading.
 * @testonly none
 */
import { expect, test } from "vitest"
import { ALL_PROBES, type ProbeResult, type TermContext } from "../index.ts"

/**
 * The census @cto asked for on 28828 (2026-10-13): a BEHAVIOURAL check, so it drives every real
 * probe rather than scanning their sources. A probe's claim about a glyph it writes or measures is
 * only meaningful in a run whose launch decodes plain UTF-8; the ask is `utf8DecodingRefusal`,
 * which returns before the row writes anything. So: whatever a probe hands the terminal in a utf8
 * run, it must hand nothing non-ASCII in a run measured 8-bit — if it does, it graded the launch.
 *
 * The eight rows the 28828 census found writing at or above 0x80 are text.wide.{emoji,cjk,
 * emoji-flags,emoji-vs16,emoji-zwj}, text.combining, unicode.grapheme-cursor and
 * unicode.wrap-boundary. A ninth row that forgets the ask fails here by name.
 */

const GEOMETRY = { rows: 24, cols: 80 } as const

/** A byte at or above 0x80 is where a Latin-1 launch and a UTF-8 launch disagree. */
const NON_ASCII = /[^\u0000-\u007f]/u

/** What one run of one probe handed the terminal, in order. */
function recordingTerm(decoding: "utf8" | "8-bit"): { ctx: TermContext; handed: string[] } {
  const handed: string[] = []
  const note = (text: string) => handed.push(text)
  const timeout = async (sequence: string) => {
    note(sequence)
    return { match: null, reason: "timeout" as const, raw: "", rawBase64: "" }
  }
  const ctx: TermContext = {
    write: note,
    queryCursorPosition: async () => null,
    measureRenderedWidth: async (text) => {
      note(text)
      return null
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

test("no probe hands a non-ASCII glyph to a run measured 8-bit without asking its decoding first", async () => {
  const appProbes = ALL_PROBES.filter((probe) => probe.term !== null)
  expect(appProbes.length).toBeGreaterThan(0)

  const census: string[] = []
  const offenders: string[] = []
  for (const probe of appProbes) {
    const utf8 = recordingTerm("utf8")
    await probe.term!(utf8.ctx)
    if (!utf8.handed.some((text) => NON_ASCII.test(text))) continue
    census.push(probe.id)

    const latin1 = recordingTerm("8-bit")
    await probe.term!(latin1.ctx)
    const received = latin1.handed.filter((text) => NON_ASCII.test(text))
    if (received.length > 0) offenders.push(`${probe.id} handed ${JSON.stringify(received)}`)
  }

  // Non-vacuity: the census is only evidence if real probes hand real non-ASCII glyphs to the
  // terminal. Eight did when this test was written, so a smaller number means the check stopped
  // seeing rows, not that the rows stopped needing it.
  expect(
    census.length,
    `the census saw only ${census.length} non-ASCII rows: ${census.join(", ")}`,
  ).toBeGreaterThanOrEqual(8)

  // The whole claim: an 8-bit run is a named cause, never a grade, so it must receive no glyph.
  expect(
    offenders,
    "these rows handed a non-ASCII glyph to a run measured 8-bit without asking its decoding first",
  ).toEqual([])
})
