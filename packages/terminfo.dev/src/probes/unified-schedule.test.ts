/**
 * @failure DECRQCRA runs before a later pixel probe, so iTerm2's consent banner covers that probe.
 * @level l1
 * @consumer The owned app batch schedule
 * @testonly none
 */
import { expect, it } from "vitest"
import { scheduleAppProbes } from "./unified.ts"

it("runs DECRQCRA after the pixel probes and after OSC 52", () => {
  expect(
    scheduleAppProbes([
      { id: "editing.decrqcra" },
      { id: "modes.altscreen-47" },
      { id: "extensions.osc52-write" },
      { id: "sgr.bold" },
    ]).map((probe) => probe.id),
  ).toEqual(["modes.altscreen-47", "sgr.bold", "extensions.osc52-write", "editing.decrqcra"])
})
