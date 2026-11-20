/**
 * @failure The handed run identity loses to a fresh random mint, so a complete run names a run nobody asked for and the composer refuses it one stage later.
 * @level l1
 * @consumer Daemon /probe drafts and every collectProbeRun caller.
 * @testonly none
 */
import { expect, it } from "vitest"
import { resolveCaptureRunId } from "./run-identity.ts"

const handed = "a".repeat(32)
const deliberate = "b".repeat(32)

it("names the draft by the launch identity already handed to it", () => {
  expect(resolveCaptureRunId({ expectedLaunchRunId: handed, environment: {} })).toBe(handed)
})

it("keeps an explicit capture id above every fallback", () => {
  expect(
    resolveCaptureRunId({
      captureRunId: deliberate,
      expectedLaunchRunId: handed,
      environment: { TERMINFO_CAPTURE_RUN_ID: "c".repeat(32) },
    }),
  ).toBe(deliberate)
})

it("keeps a deliberate capture environment above the launch identity", () => {
  expect(
    resolveCaptureRunId({ expectedLaunchRunId: handed, environment: { TERMINFO_CAPTURE_RUN_ID: deliberate } }),
  ).toBe(deliberate)
})

it("mints a fresh identity only when nothing named the run, and never the same one twice", () => {
  const first = resolveCaptureRunId({ environment: {} })
  expect(first).toMatch(/^[0-9a-f]{32}$/)
  expect(first).not.toBe(resolveCaptureRunId({ environment: {} }))
})
