/**
 * The one home of the bar's categories (#37761): their order, their mark and what each means in one plain line.
 * The how-to-read page and every bar popover read these lines; no page keeps a second copy.
 */
import type { CurrentAggregate } from "./release-scope.ts"

export type CategoryId = "supported" | "unsupported" | "differs-by-context" | "untestable" | "no-result"

export interface ResultCategory {
  readonly id: CategoryId
  readonly label: string
  /** The row marker in every result list: the mark is the bullet, nothing else is. */
  readonly mark: string
  /** The bar segment's colour class suffix (`bar-<style>`). */
  readonly style: string
  readonly meaning: string
  /** Shown as a tab only when it has members (a disagreement is rare; the other four always show). */
  readonly optional?: boolean
}

export const RESULT_CATEGORIES: readonly ResultCategory[] = [
  {
    id: "supported",
    label: "Supported",
    mark: "✓",
    style: "yes",
    meaning: "The terminal did it; the result shows what we sent and what came back.",
  },
  {
    id: "unsupported",
    label: "Unsupported",
    mark: "✗",
    style: "fail",
    meaning: "We tested it and the terminal did not do it; each result shows the evidence.",
  },
  {
    id: "differs-by-context",
    label: "Differs by context",
    mark: "≠",
    style: "differs",
    meaning: "Two measured contexts of the same release decided differently; each result shows both.",
    optional: true,
  },
  {
    id: "untestable",
    label: "Untestable",
    mark: "?",
    style: "partial",
    meaning: "We can't run this test in this terminal; each result says why.",
  },
  { id: "no-result", label: "No result yet", mark: "—", style: "none", meaning: "We haven't run this test here yet." },
]

/**
 * The feature ids in each category, read from the bar's own fold (`idsByState`), so a tab's count and the bar's
 * segment can never disagree. "No result yet" is every graded position the run did not decide.
 */
export function categoryIds(bar: Pick<CurrentAggregate, "idsByState">): Record<CategoryId, readonly string[]> {
  const ids = bar.idsByState
  return {
    supported: ids.supported,
    unsupported: ids.unsupported,
    "differs-by-context": ids["differs-by-context"] ?? [],
    untestable: ids.untestable,
    "no-result": [...ids["probe-todo"], ...ids["probe-invalid"], ...(ids["probe-conflict"] ?? [])],
  }
}

/** The same categories limited to one feature set (a Baseline card): a member it never measured is "No result yet". */
export function categoryIdsWithin(
  bar: Pick<CurrentAggregate, "idsByState"> | undefined,
  within: readonly string[],
): Record<CategoryId, readonly string[]> {
  const all = bar ? categoryIds(bar) : undefined
  const keep = new Set(within)
  const decided = new Set<string>()
  const out = {} as Record<CategoryId, string[]>
  for (const { id } of RESULT_CATEGORIES) {
    if (id === "no-result") continue
    out[id] = (all?.[id] ?? []).filter((featureId) => keep.has(featureId))
    for (const featureId of out[id]) decided.add(featureId)
  }
  out["no-result"] = within.filter((featureId) => !decided.has(featureId))
  return out
}

/** A category's row mark (the evidence cell and every result list read it here). */
export function categoryMark(id: CategoryId): string {
  const category = RESULT_CATEGORIES.find((entry) => entry.id === id)
  if (!category) throw new Error(`Unknown result category ${id}`)
  return category.mark
}

/** One feature's category in a bar's own fold: the row mark and colour a result list shows for it. */
export function categoryOf(bar: Pick<CurrentAggregate, "idsByState"> | undefined, featureId: string): ResultCategory {
  const ids = bar ? categoryIds(bar) : undefined
  const found = RESULT_CATEGORIES.find((category) => ids?.[category.id].includes(featureId))
  return found ?? RESULT_CATEGORIES.find((category) => category.id === "no-result")!
}
