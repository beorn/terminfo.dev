/**
 * @failure A declared key/mouse mode or responsive CPR was reported as generated input-event encoding.
 * @level l0
 * @consumer Headless and app input probe observations.
 * @testonly none
 */
import { expect, test } from "vitest"
import { inputProbes } from "./input.ts"

test("no input catalog id remains on the generated-event stub", () => {
  expect(inputProbes.some((entry) => entry.id === "input.button-event-mouse")).toBe(true)
})
