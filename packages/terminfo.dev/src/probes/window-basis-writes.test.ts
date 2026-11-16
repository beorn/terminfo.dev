/**
 * @failure A write that is not on @cto's closed lists is classified as if it were, or a truncated
 *   escape stops the tokenizer mid-sequence and the cell is admitted on a guess — either way a cell
 *   reaches the terminal with a state change nobody named.
 * @level l1
 * @consumer 34148 folds 2 and 3: the closed-list classifier the window-basis table is derived from.
 * @reach none
 * @testonly none
 */
import { describe, expect, test } from "vitest"
import { classifyWindowWrite } from "./window-basis-writes.ts"

describe("classifyWindowWrite", () => {
  test("names every sequence on @cto's closed lists", () => {
    const write = "ab\r\n\u001b[2J\u001b[3J\u001b[H\u001b[1;1H\u001b[8;24;80t\u001b[18t"
    const classification = classifyWindowWrite(write)
    if ("unclassified" in classification) throw new Error(classification.unclassified)
    expect(classification.kinds).toEqual(["screen-text", "erase", "cursor-move", "window-size"])
    expect(classification.attributes).toEqual([])
  })

  test("a mode write names every mode it changes, not just the first", () => {
    const classification = classifyWindowWrite("\u001b[?1000;1006h")
    if ("unclassified" in classification) throw new Error(classification.unclassified)
    expect(classification.attributes).toEqual([
      { kind: "dec-mode", mode: 1000 },
      { kind: "dec-mode", mode: 1006 },
    ])
    expect(classification.attributeSequences).toEqual(["\u001b[?1000;1006h"])
  })

  test("a truncated CSI never classifies", () => {
    const classification = classifyWindowWrite("\u001b[12")
    expect("unclassified" in classification).toBe(true)
    if ("unclassified" in classification) expect(classification.unclassified).toContain("CSI is on no closed list")
  })

  test("a truncated OSC never classifies", () => {
    const classification = classifyWindowWrite("\u001b]8;;")
    expect("unclassified" in classification).toBe(true)
    if ("unclassified" in classification) expect(classification.unclassified).toContain("OSC is on no closed list")
  })

  test("a bare ESC ( B charset designation never classifies", () => {
    const classification = classifyWindowWrite("\u001b(B")
    expect("unclassified" in classification).toBe(true)
    if ("unclassified" in classification) expect(classification.unclassified).toContain("ESC is on no closed list")
  })

  test("ESC 7 and ESC 8 stay unclassified because no closed list names save-restore", () => {
    for (const write of ["\u001b7", "\u001b8"]) {
      const classification = classifyWindowWrite(write)
      expect("unclassified" in classification).toBe(true)
      if ("unclassified" in classification) expect(classification.unclassified).toContain("ESC 7/ESC 8")
    }
  })

  test("text carrying a control byte outside CR, LF and printable ASCII does not classify as screen text", () => {
    const classification = classifyWindowWrite("ab\u0007cd")
    expect("unclassified" in classification).toBe(true)
  })
})
