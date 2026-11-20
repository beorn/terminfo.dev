/**
 * @failure The screen ED3 seed repeats one glyph, so a one-line scroll is pixel-identical.
 * @level l1
 * @consumer #34476 screen ED3 corroboration
 * @reach unit
 * @testonly none
 */
import { expect, test } from "vitest"
import { screenEd3Seed } from "./erase.ts"

test("screen ED3 seed lines differ by row index", () => {
  const { history, bottom } = screenEd3Seed(8, 40)
  const lines = history.split("\r\n").filter((line) => line.length > 0)
  expect(lines).toHaveLength(10)
  expect(new Set(lines).size).toBe(lines.length)
  expect(lines[0]?.startsWith("1")).toBe(true)
  expect(lines[1]?.startsWith("2")).toBe(true)
  expect(bottom).toBe("B".repeat(40))
})
