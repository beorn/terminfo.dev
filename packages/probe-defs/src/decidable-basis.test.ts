/**
 * @failure The one decidable-basis predicate could drift back into two formulas: an id absent from the
 *   required schedule would be counted as a failed capability by the decisive-share reader while the
 *   group harness excludes it, so the same rows read two different denominators (the 28018 one-basis
 *   ruling, @dev/3 2026-10-10, @cto PROCEED 2026-10-10T15:49Z).
 * @level l2
 * @consumer the `splitDecidableBasis` export of @terminfo/probe-defs and its two callers
 *   (scripts/decisive-share.ts, packages/probe-defs/src/testing/group-harness.ts)
 * @testonly none
 */
import { expect, test } from "vitest"
import { splitDecidableBasis } from "./decidable-basis.ts"

test("splits a cohort into the ids the schedule covers and the ids it does not, in cohort order", () => {
  const cohort = ["a.1", "b.1", "a.2", "c.1", "b.2"]
  const scheduled = ["b.2", "a.1", "b.1"] // order and completeness of the schedule do not matter
  const { decidableIds, unavailableIds } = splitDecidableBasis(cohort, scheduled)
  expect(decidableIds).toEqual(["a.1", "b.1", "b.2"])
  expect(unavailableIds).toEqual(["a.2", "c.1"])
  // total: the two halves are disjoint and re-join to the cohort, in cohort order
  expect([...decidableIds, ...unavailableIds].sort()).toEqual([...cohort].sort())
})

test("is pure and total: an empty schedule makes every cohort id unavailable, an empty cohort yields two empties", () => {
  expect(splitDecidableBasis(["only.id"], [])).toEqual({ decidableIds: [], unavailableIds: ["only.id"] })
  expect(splitDecidableBasis([], ["unused.id"])).toEqual({ decidableIds: [], unavailableIds: [] })
})

test("does not mutate its inputs and ignores a scheduled id outside the cohort", () => {
  const cohort = ["a.1", "a.2"]
  const scheduled = ["a.1", "not.in.cohort"]
  const before = [...cohort]
  const { decidableIds, unavailableIds } = splitDecidableBasis(cohort, scheduled)
  expect(cohort).toEqual(before)
  expect(decidableIds).toEqual(["a.1"])
  expect(unavailableIds).toEqual(["a.2"])
})
