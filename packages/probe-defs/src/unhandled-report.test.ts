/**
 * @failure A state cell is graded Unsupported from the library's unhandled-sequence report without
 *   both same-run controls the ruling requires (@cto 2026-11-05 07:25 appendix, Case 1): a handled
 *   sequence must add no entry AND its own reader must show it applied, and the target must add
 *   exactly one entry carrying its code. Without both, the row keeps today's TODO naming what
 *   failed; a missing member keeps today's meaning and never becomes Supported.
 *
 * @failure The report is allowed to decide a delivery cell. OSC 7 / OSC 633 P / OSC 9 / OSC 777
 *   are Supported because their payload reaches the host, so the report must not touch them.
 */
import { describe, expect, test } from "vitest"

import { extensionsProbes } from "./extensions.ts"
import { inertLibProbeSource } from "./testing/group-harness.ts"

const REASON = "library reported this sequence as unhandled"

const probe = (id: string) => extensionsProbes.find((entry) => entry.id === id)!

/** The report a library emits for sequences it passed through without acting on them. */
const reportOf = (...codes: string[]) => () => codes.map((code) => ({ kind: "osc" as const, code }))

describe("the unhandled report decides only state cells, and only with both controls", () => {
  test("a colour-reset cell the library reports unhandled becomes Unsupported", () => {
    const source = { ...inertLibProbeSource(), getUnhandledSequences: reportOf("110") }
    const result = probe("extensions.osc110-reset-fg").lib!(source)
    expect(result.observation?.outcome).toBe("unsupported")
    expect(JSON.stringify(result)).toContain(REASON)
  })

  test("a shell-mark cell the library reports unhandled becomes Unsupported", () => {
    const source = { ...inertLibProbeSource(), getUnhandledSequences: reportOf("133") }
    const result = probe("extensions.osc133-a").lib!(source)
    expect(result.observation?.outcome).toBe("unsupported")
    expect(JSON.stringify(result)).toContain(REASON)
  })

  test("a report without the target's code leaves the cell undecided", () => {
    const source = { ...inertLibProbeSource(), getUnhandledSequences: reportOf("111") }
    const result = probe("extensions.osc110-reset-fg").lib!(source)
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  })

  test("a report that also records the handled control leaves the cell undecided", () => {
    const source = { ...inertLibProbeSource(), getUnhandledSequences: reportOf("110", "2") }
    const result = probe("extensions.osc110-reset-fg").lib!(source)
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  })

  test("a missing member keeps today's meaning", () => {
    const result = probe("extensions.osc110-reset-fg").lib!(inertLibProbeSource())
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  })

  test("a delivery cell is never decided by the report", () => {
    const source = { ...inertLibProbeSource(), getUnhandledSequences: reportOf("7", "9", "633", "777") }
    for (const id of ["extensions.osc7-cwd", "extensions.osc9-progress", "extensions.osc633-p", "extensions.osc777-notify"]) {
      const result = probe(id).lib!(source)
      expect(JSON.stringify(result)).not.toContain(REASON)
    }
  })
})
