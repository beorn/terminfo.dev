/**
 * @failure A hand-written probe's headless arm reads a bare capture on a proven engine, so a query the
 *   terminal ignores grades as inconclusive/TEST TODO instead of the measured negative F4 asks for.
 * @level l2
 * @consumer #30699 F4 remainder: DSR 996, DECRQCRA and the OSC 104/110-114/30001/30101 reset and
 *   colour-stack queries on the five proven parser engines.
 * @reach none
 * @testonly none
 */
import { expect, test } from "vitest"
import { deviceProbes } from "./device.ts"
import { editingProbes } from "./editing.ts"
import { extensionsProbes } from "./extensions.ts"
import type { ProbeDefinition, ProbeCallbackResult, LibProbeSource, TerminalQueryOutcome } from "./types.ts"

const da1 = "\x1b[?1;2c"
const sentinelAt = { atMs: 1, graceMs: 250 }
const base = { feed: () => {}, feedCapture: () => "" }

/** The ten F4 criteria whose headless arm now asks the sentinel before it reads a bare capture. */
const F4 = [
  "device.dsr-996-color-scheme",
  "editing.decrqcra",
  "extensions.osc104-reset-palette",
  "extensions.osc110-reset-fg",
  "extensions.osc111-reset-bg",
  "extensions.osc112-reset-cursor",
  "extensions.osc113-reset-pointer-fg",
  "extensions.osc114-reset-pointer-bg",
  "extensions.osc30001-color-stack-push",
  "extensions.osc30101-color-stack-pop",
] as const

function definition(id: string): ProbeDefinition {
  const found = [...deviceProbes, ...editingProbes, ...extensionsProbes].find((entry) => entry.id === id)
  if (!found?.lib) throw new Error(`${id} has no headless callback`)
  return found
}

function run(id: string, ctx: Partial<LibProbeSource>): ProbeCallbackResult {
  const callback = definition(id).lib
  if (!callback) throw new Error(`${id} lost its headless callback`)
  return callback(ctx as LibProbeSource)
}

function silentSentinel(reason: TerminalQueryOutcome["reason"] = "sentinel"): TerminalQueryOutcome {
  return {
    match: null,
    reason,
    raw: da1,
    rawBase64: Buffer.from(da1).toString("base64"),
    ...(reason === "sentinel" && { sentinel: { ...sentinelAt } }),
  }
}

test.each(F4)("%s: an answered DA1 with no reply is the measured negative F4 asks for", (id) => {
  const result = run(id, { ...base, queryWithSentinelOutcome: () => silentSentinel() })
  expect(result.observation).toMatchObject({
    outcome: "unsupported",
    assertionType: "query_reply",
    note: "negative by sentinel",
  })
  expect(result.response).toBe(da1)
  expect(result.assertions?.map(({ kind }) => kind)).toEqual(["negative"])
})

test.each(F4)("%s: an unanswered DA1 keeps the capture reading, never a negative", (id) => {
  const result = run(id, { ...base, queryWithSentinelOutcome: () => silentSentinel("timeout") })
  expect(result.observation?.outcome).not.toBe("unsupported")
})

test.each(F4)("%s: an engine with no proven reply path keeps its pre-existing reading", (id) => {
  const withMember = run(id, { ...base, queryWithSentinelOutcome: () => silentSentinel() })
  const withoutMember = run(id, { ...base })
  const memberWithoutSentinel = run(id, { ...base, queryWithSentinelOutcome: () => silentSentinel("timeout") })
  expect(withoutMember.observation?.outcome).not.toBe("unsupported")
  expect(withoutMember.observation?.outcome).toBe(memberWithoutSentinel.observation?.outcome)
  expect(withMember.observation?.outcome).toBe("unsupported")
})
