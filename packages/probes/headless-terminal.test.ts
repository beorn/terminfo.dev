/**
 * @failure The collector records pixel geometry as not supplied while every engine is initialized with one, so a
 * source-audited "harness supplies no pixel geometry" cause stays citable beside a geometry the engine was given.
 * @level l0
 * @consumer collect-headless collector.collectionAttempt.hostInputs and run-parser's declared-input check.
 * @testonly none
 */
import { expect, it } from "vitest"
import { HOST_INPUT_NAMES } from "@terminfo/probe-defs"
import { HEADLESS_TERMINAL, declaredHostInputs } from "./headless-terminal.ts"

// CTO e3c7ee1d: the declared-or-not fact has one home, written from the same constant the engines receive.
it("declares the pixel geometry every engine is initialized with, and no other host input", () => {
  const inputs = declaredHostInputs()
  expect(Object.keys(inputs).sort()).toEqual([...HOST_INPUT_NAMES].sort())
  expect(inputs["pixel-geometry"]).toBe(JSON.stringify(HEADLESS_TERMINAL.pixelGeometry))
  for (const name of HOST_INPUT_NAMES.filter((input) => input !== "pixel-geometry")) {
    expect(inputs[name], name).toBe("not-supplied")
  }
})
