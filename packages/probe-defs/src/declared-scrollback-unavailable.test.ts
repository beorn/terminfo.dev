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
import { recordExecutedProbe } from "./helpers.ts"
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
 * @failure A definition the collector's no-pane-read declaration must cover loses its static geometry row, so a
 *   declared-untestable app would drop one of the feature's rows. The runner side — that the row still reads the
 *   declaration when geometry is measured, and the geometry refusal when it is not — is covered by
 *   `packages/terminfo.dev/src/probes/unified.test.ts` through the real batch handoff (@dev/18 peer read, 34005).
 * @level l1
 * @consumer The definition-level row set behind a declared-untestable app.
 * @testonly none
 */
test("the declaration covers exactly the approved rows, and each keeps its static geometry row", async () => {
  // Derived, not typed in: every scrollback, erase and extensions definition runs against the declared source, and
  // the set that declares must be the approved scope. A definition that starts or stops declaring changes this set.
  const defs = [...scrollbackProbes, ...eraseProbes, ...extensionsProbes].filter((entry) => entry.term !== undefined)
  const declared: string[] = []
  for (const entry of defs) {
    const result = await entry.term?.(source({ scrollbackUnavailable: NO_PANE_READ }))
    const named = result?.tests?.some((item) => item.id === DECLARED_UNTESTABLE_TEST && item.reason === NO_PANE_READ)
    if (named) declared.push(entry.id)
  }
  expect(declared.sort()).toEqual([...ROWS].sort())

  // Each covered definition still carries the static geometry fact (@cto 34005 shape 2), and its own text is the
  // named declaration and nothing else: named with the collector's reason, never blank.
  for (const id of ROWS) {
    const entry = definition(id)
    expect(entry.termNeedsGeometry, `${id} lost its static geometry row`).toBe(true)
    const result = await entry.term?.(source({ scrollbackUnavailable: NO_PANE_READ }))
    expect(result?.criterionBranch, id).toBe(HEADLESS_OBSERVABLE_REVIEW)
    expect(result?.tests, id).toEqual([{ id: DECLARED_UNTESTABLE_TEST, status: "untestable", reason: NO_PANE_READ }])
    expect(result?.note, id).toBe(NO_PANE_READ)
  }
})

/**
 * @failure An arm that cannot reach an owned read reports the generic "not readable from the screen" todo, so a
 *   missing socket or pane id on this run is indistinguishable from the app exposing no read — and a reader that
 *   was never built looks like a screenshot that failed (8c084f05, A0).
 * @level l1
 * @consumer The four history rows on the hosted Darwin arm, when the pane published no socket or pane id.
 * @testonly none
 */
test("an arm-side missing prerequisite is the row's own PROBE TODO reason, never a declaration", async () => {
  const reason = "hosted WezTerm pane published no socket"
  for (const id of ROWS) {
    const result = await definition(id).term?.(source({ scrollbackProbeTodo: reason }))
    const folded = recordExecutedProbe({
      featureId: id,
      attempt: { scope: "probe", startedAt: "2026-11-13T10:38:00.000Z" },
      assertions: [],
      ...(result?.notTested ? { coverage: { featureId: id, rawReplyRef: id, ...result.notTested } } : {}),
    })
    expect(folded.status, id).toBe("probe-todo")
    expect(folded.reason, id).toContain(reason)
    const declared = result?.tests?.some((entry) => entry.id === DECLARED_UNTESTABLE_TEST) ?? false
    expect(declared, `${id} must not declare the app unreadable when only this arm is blind`).toBe(false)
  }
})
