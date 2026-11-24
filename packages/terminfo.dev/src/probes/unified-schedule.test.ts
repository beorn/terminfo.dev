/**
 * @failure A cwd-pinning row contaminates later cwd/prompt observations, or clipboard/consent disturbs later probes.
 * @level l0
 * @consumer The owned app batch schedule
 * @testonly none
 */
import { expect, it } from "vitest"
import { scheduleAppProbes, selectAppProbes } from "./unified.ts"

// The cwd/state tests never exercise caller ordering. Keep this policy at the batch scheduler.
it("runs cwd-pinning OSC633 P after state probes, then clipboard and consent (banner before modal) last", () => {
  expect(
    scheduleAppProbes([
      { id: "extensions.osc633-p" },
      { id: "extensions.iterm2-images" },
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
    "extensions.iterm2-images",
  ])
})

it("keeps editing.decrqcra immediately before extensions.iterm2-images regardless of input order (#37678)", () => {
  const forward = scheduleAppProbes([
    { id: "sgr.bold" },
    { id: "editing.decrqcra" },
    { id: "extensions.iterm2-images" },
  ]).map((probe) => probe.id)
  const reversed = scheduleAppProbes([
    { id: "extensions.iterm2-images" },
    { id: "editing.decrqcra" },
    { id: "sgr.bold" },
  ]).map((probe) => probe.id)
  expect(forward).toEqual(["sgr.bold", "editing.decrqcra", "extensions.iterm2-images"])
  expect(reversed).toEqual(["sgr.bold", "editing.decrqcra", "extensions.iterm2-images"])

  // Full single-session app catalogue lands decrqcra second-to-last and iterm2-images last.
  const all = selectAppProbes().selected.map((probe) => probe.id)
  expect(all.at(-1)).toBe("extensions.iterm2-images")
  expect(all.at(-2)).toBe("editing.decrqcra")
})
