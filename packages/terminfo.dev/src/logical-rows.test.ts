/**
 * @failure A screen the app returned as logical lines is refused as a short screen, or a wrapped
 *   line's row boundary is guessed through a character whose width the read cannot name, so the
 *   rebuilt screen is rows nobody measured.
 * @level l1
 * @consumer readTerminalTextSnapshot and readTerminalAppHistory, the macOS half of the hosted arm.
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { splitLogicalLine, splitLogicalRows } from "./logical-rows.ts"

const ascii = (length: number, character = "x"): string => character.repeat(length)

describe("logical rows: rebuild physical rows from an app's logical lines, or refuse by name (30729 AC3b)", () => {
  it("splits one 240-character line into two 120-column rows and says how many lines it split", () => {
    expect(splitLogicalRows([ascii(240)], 120, 2)).toEqual({
      rows: [ascii(120), ascii(120)],
      splitLineCount: 1,
    })
  })

  it("splits only the lines that need it, in order, and counts each one once", () => {
    expect(splitLogicalRows([ascii(120, "a"), ascii(240, "b")], 120, 3)).toEqual({
      rows: [ascii(120, "a"), ascii(120, "b"), ascii(120, "b")],
      splitLineCount: 1,
    })
  })

  it("refuses by name a two-cell character in a line that needs splitting", () => {
    const reading = splitLogicalRows([`${ascii(239)}世`], 120, 2)
    expect(reading).toHaveProperty("reason")
    if ("reason" in reading) expect(reading.reason).toMatch(/character 240 is U\+4E16.*not one cell/u)
  })

  it("refuses by name a combining mark in a line that needs splitting", () => {
    const reading = splitLogicalRows([`${ascii(119)}e\u0301`], 120, 1)
    expect(reading).toHaveProperty("reason")
    if ("reason" in reading) expect(reading.reason).toMatch(/U\+0301/u)
  })

  it("refuses a non-BMP character rather than counting a surrogate pair as two cells", () => {
    const reading = splitLogicalRows([`${ascii(119)}🧪x`], 120, 1)
    expect(reading).toHaveProperty("reason")
    if ("reason" in reading) expect(reading.reason).toMatch(/U\+1F9EA/u)
  })

  it("passes a line of exactly the column count through unchanged, whatever it contains", () => {
    const line = `世${ascii(118)}🧪`
    expect(splitLogicalLine(line, 120, 1)).toEqual([line])
    expect(splitLogicalRows([line], 120, 1)).toEqual({ rows: [line], splitLineCount: 0 })
  })

  it("refuses an empty line, because its blank row is not shown to be full", () => {
    const reading = splitLogicalRows([""], 120, 1)
    expect(reading).toHaveProperty("reason")
    if ("reason" in reading) expect(reading.reason).toMatch(/line 1 is empty/u)
  })

  it("refuses a line that is not a whole number of rows", () => {
    const reading = splitLogicalRows([ascii(121)], 120, 1)
    expect(reading).toHaveProperty("reason")
    if ("reason" in reading) expect(reading.reason).toMatch(/121 cells over 120 columns/u)
  })

  it("refuses when the pieces do not add up to the measured screen", () => {
    const reading = splitLogicalRows([ascii(240)], 120, 3)
    expect(reading).toHaveProperty("reason")
    if ("reason" in reading) expect(reading.reason).toMatch(/2 rows where the measured screen has 3/u)
  })

  it("refuses a geometry that is not a size", () => {
    const reading = splitLogicalRows([], 0, 0)
    expect(reading).toHaveProperty("reason")
    if ("reason" in reading) expect(reading.reason).toMatch(/not a size: 0x0/u)
  })
})
