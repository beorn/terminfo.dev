/**
 * The two baseline row readouts (#30763, #33441): a row that decided nothing prints the not-measured words, and a row
 * whose only decided cell is a derived Unsupported decided nothing either (#33019) - so the derived count has to travel
 * with the counts, not be dropped on the way to the page.
 *
 * Both pages keep their own decided-row text, byte-identical to what they printed before the fix: only the
 * not-measured branch moves.
 */
import type { ProbeStatus } from "../../packages/probe-defs/src/types.ts"
import { notMeasuredReadout } from "./release-scope.ts"

/** Counts as a page holds them: the status map plus how many of its Unsupported cells are derived (#33019). */
export interface RowCounts {
  readonly counts: Readonly<Record<ProbeStatus, number> & Partial<Record<"probe-conflict", number>>>
  readonly derived: number
}

export interface RowScore {
  readonly supported: number
  readonly all: number
}

export interface RowReadout {
  readonly text: string
  readonly title: string | undefined
}

/** The Home page baseline card: `pct% · supported/all supported / all`, or the not-measured words. */
export function homeBaselineRow(stats: RowCounts & { readonly pct?: number; readonly score: RowScore }): RowReadout {
  const readout = notMeasuredReadout(stats.counts, stats.derived)
  if (readout !== undefined) return readout
  return {
    text: `${stats.pct ?? 0}% · ${stats.score.supported}/${stats.score.all} supported / all`,
    title: undefined,
  }
}

/** The /baseline/[id] coverage row: `supported/all supported (pct%)`, or the not-measured words. */
export function baselineShareRow(s: RowCounts & { readonly pct?: number; readonly score: RowScore }): RowReadout {
  const readout = notMeasuredReadout(s.counts, s.derived)
  if (readout !== undefined) return readout
  return { text: `${s.score.supported}/${s.score.all} supported (${s.pct ?? 0}%)`, title: undefined }
}
