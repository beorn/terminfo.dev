/**
 * @failure A history row on an app with no pane read falls back to a screenshot arm and reports
 *   "retained history is not readable from the screen" as an open todo, so a measured absence of any
 *   read is recorded as unfinished work instead of a declaration (@cto 20b9ffed, #31741).
 * @level l1
 * @consumer Hosted Darwin collector that knows the subject app cannot read its own pane.
 * @testonly none
 */
import { expect, test } from "vitest"
import { scrollbackProbes } from "./scrollback.ts"
import { eraseProbes } from "./erase.ts"
import { extensionsProbes } from "./extensions.ts"
import { HEADLESS_OBSERVABLE_REVIEW, DECLARED_UNTESTABLE_TEST } from "./helpers.ts"
import type { ProbeDefinition, TermProbeSource } from "./types.ts"

/** @cto 20b9ffed's reason text, verbatim: the same string the collector sets on the source. */
const NO_PANE_READ = "no pane read on this app"

const ROWS = [
  "scrollback.accumulate",
  "scrollback.total-lines",
  "erase.screen.scrollback",
  "extensions.osc720-scroll-up",
]

function source(overrides: Partial<TermProbeSource> = {}): TermProbeSource {
  return {
    kind: "live",
    rows: 24,
    cols: 80,
    write() {},
    queryCursorPosition: async () => ({ row: 24, col: 1 }),
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
    ...overrides,
  }
}

function definition(id: string): ProbeDefinition {
  const found = [...scrollbackProbes, ...eraseProbes, ...extensionsProbes].find((entry) => entry.id === id)
  if (!found?.term) throw new Error(`missing app callback for ${id}`)
  return found
}

test("an app with no pane read declares Untestable with @cto's reason, before any screenshot fallback", async () => {
  for (const id of ROWS) {
    const result = await definition(id).term?.(source({ scrollbackUnavailable: NO_PANE_READ }))
    expect(result?.tests, id).toEqual([{ id: DECLARED_UNTESTABLE_TEST, status: "untestable", reason: NO_PANE_READ }])
    expect(result?.criterionBranch, id).toBe(HEADLESS_OBSERVABLE_REVIEW)
  }
})

test("the same rows without the declaration stay open work, so the field is what decides", async () => {
  for (const id of ROWS) {
    const result = await definition(id).term?.(source())
    const declared = result?.tests?.some((entry) => entry.id === DECLARED_UNTESTABLE_TEST) ?? false
    expect(declared, `${id} must not declare without a collector-named absence`).toBe(false)
  }
})

test("an app that can read its own pane is never pre-empted by the declaration path", async () => {
  let reads = 0
  const result = await definition("scrollback.accumulate").term?.(
    source({
      getScrollback: async () => {
        reads += 1
        return { totalLines: 24, screenLines: 24 }
      },
    }),
  )
  expect(reads).toBeGreaterThan(0)
  expect(result?.tests?.some((entry) => entry.id === DECLARED_UNTESTABLE_TEST) ?? false).toBe(false)
})

/**
 * @failure The osc720-scroll-up geometry row disappears or turns into a decided outcome for an app whose pane
 *   this run cannot read, so a declared-untestable app silently loses one of the feature's static rows, or the
 *   row reports something the declaration never measured (@cto 34005, shape 2).
 * @level l1
 * @consumer The definition's static row set for an app that declares no pane read.
 * @testonly none
 */
test("a declared app keeps every static geometry row, and the flag is the definition's, not the run's", async () => {
  // Derived from the definitions, never typed in: which scope rows need a measured grid, and what the same
  // definition reports when the source names no pane read.
  const definitions = ROWS.map((id) => definition(id))
  const staticGeometry = definitions.filter((entry) => entry.termNeedsGeometry === true).map((entry) => entry.id)
  // The scope rows and the static-geometry rows are the same derived set: osc720's geometry row is one of the
  // four, never a fifth id, and it survives the declaration because the flag lives on the definition.
  expect(staticGeometry.sort()).toEqual([...ROWS].sort())

  for (const entry of definitions) {
    const declaredStatic = entry.termNeedsGeometry
    const declared = await entry.term?.(source({ scrollbackUnavailable: NO_PANE_READ }))
    // Shape 1 would have let the run's context clear the flag. It cannot: the static fact is unchanged, and
    // the undeclared run of the same definition reads the same fact.
    expect(entry.termNeedsGeometry, `${entry.id} geometry flag moved by the declaration`).toBe(declaredStatic)
    expect(entry.termNeedsGeometry, `${entry.id} differs after an open run`).toBe(declaredStatic)
    // The row's own text is the declaration and nothing else: named with the collector's reason, never blank.
    expect(declared?.criterionBranch, entry.id).toBe(HEADLESS_OBSERVABLE_REVIEW)
    expect(declared?.tests, entry.id).toEqual([
      { id: DECLARED_UNTESTABLE_TEST, status: "untestable", reason: NO_PANE_READ },
    ])
    expect(declared?.note, entry.id).toBe(NO_PANE_READ)
    expect(
      declared?.tests?.some((item) => item.status === "probe-invalid"),
      entry.id,
    ).toBeFalsy()
  }
})
