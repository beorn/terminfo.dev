/**
 * @failure A cwd-pinning row contaminates later cwd/prompt observations, or clipboard/consent disturbs later probes.
 * @level l0
 * @consumer The owned app batch schedule
 * @testonly none
 */
import { expect, it } from "vitest"
import { scheduleAppProbes } from "./unified.ts"

// The cwd/state tests never exercise caller ordering. Keep this policy at the batch scheduler.
it("runs cwd-pinning OSC633 P after state probes, then clipboard and consent after pixel probes", () => {
  expect(
    scheduleAppProbes([
      { id: "extensions.osc633-p" },
      { id: "editing.decrqcra" },
      { id: "modes.altscreen-47" },
      { id: "extensions.osc52-write" },
      { id: "sgr.bold" },
      { id: "extensions.osc7-cwd" },
      { id: "extensions.osc133-a" },
      { id: "extensions.osc633-e" },
    ]).map((probe) => probe.id),
  ).toEqual([
    "modes.altscreen-47",
    "sgr.bold",
    "extensions.osc7-cwd",
    "extensions.osc133-a",
    "extensions.osc633-e",
    "extensions.osc633-p",
    "extensions.osc52-write",
    "editing.decrqcra",
  ])
})
