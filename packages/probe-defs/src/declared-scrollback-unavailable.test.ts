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
