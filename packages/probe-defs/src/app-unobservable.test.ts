/**
 * @failure A row is scored as an app-side inconclusive when no app run can ever decide it, so a probe
 *   gap or a missing reset method reads as terminal undecidability and silently depresses the share.
 * @level l2
 * @consumer scripts/decisive-share.ts and docs/data/load-release-scope.ts take their denominator from
 *   splitAppObservable; a row here must really have a probe, or it belongs in no-semantic-observable.
 * @testonly none
 */
import { expect, test } from "vitest"
import { ALL_PROBES } from "./index.ts"
import { APP_UNOBSERVABLE_ROWS, appUnobservableIds, splitAppObservable } from "./app-unobservable.ts"

test("every app-unobservable row is declared once, decides on the termless path, and really has a probe", () => {
  const ids = appUnobservableIds()
  expect(new Set(ids).size, `duplicate declaration in ${JSON.stringify(ids)}`).toBe(ids.length)
  const probeIds = new Set(ALL_PROBES.map((probe) => probe.id))
  for (const row of APP_UNOBSERVABLE_ROWS) {
    expect(probeIds.has(row.id), `${row.id} has no probe, so it is no-semantic-observable, not app-unobservable`).toBe(
      true,
    )
    expect(row.surface, row.id).toBe("termless")
    expect(row.appLimit.trim(), `${row.id} needs an appLimit clause`).not.toBe("")
  }
})

test("splitAppObservable names the moved rows and keeps the caller order on both sides", () => {
  const ids = ["sgr.bold", "reset.method", "scrollback.total-lines", "unicode.tab-stops"]
  const { scoredIds, libraryOnlyIds } = splitAppObservable(ids)
  expect(scoredIds).toEqual(["sgr.bold", "unicode.tab-stops"])
  expect(libraryOnlyIds).toEqual(["reset.method", "scrollback.total-lines"])
})

test("splitAppObservable leaves a list with no declared row untouched", () => {
  expect(splitAppObservable(["sgr.bold"])).toEqual({ scoredIds: ["sgr.bold"], libraryOnlyIds: [] })
  expect(splitAppObservable([])).toEqual({ scoredIds: [], libraryOnlyIds: [] })
})
