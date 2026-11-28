/**
 * @failure A window-scoped owner basis admits a cell whose restore it cannot prove, or refuses one by
 *   falling through a table nobody checked — so a cell is graded on a restore that may have leaked, or
 *   an admitted cell silently disappears from the run.
 * @level l1
 * @consumer 34148 folds 2 and 3: window-basis admission before the cell's first byte.
 * @reach none
 * @testonly none
 */
import { describe, expect, test } from "vitest"
import { TERM_FOOTPRINTS } from "@terminfo/probe-defs"
import { WINDOW_BASIS_PRE_SEED, WINDOW_BASIS_UNCLASSIFIABLE } from "./window-basis-table.ts"
import { windowBasisAdmission } from "./window-basis-admission.ts"
import { WINDOW_BASIS_RULING_EXCLUSIONS } from "./window-basis-rulings.ts"
import { RESTORE_TO_PRE_READ, attributeKey, restoresToPreRead } from "./attribute-ledger.ts"

const WINDOW_CELLS = Object.entries(TERM_FOOTPRINTS)
  .filter(([, footprint]) => footprint === "window")
  .map(([id]) => id)

describe("window basis admission (#34148)", () => {
  test("every window cell lands in exactly one bucket, and the report adds up", () => {
    expect(WINDOW_CELLS.length).toBe(22)
    for (const id of WINDOW_CELLS) {
      const buckets = [
        WINDOW_BASIS_RULING_EXCLUSIONS[id] !== undefined,
        WINDOW_BASIS_UNCLASSIFIABLE[id] !== undefined,
        WINDOW_BASIS_PRE_SEED[id] !== undefined,
      ].filter(Boolean)
      expect(buckets.length, `${id} is decided in exactly one place`).toBe(1)
    }
    expect(
      Object.keys(WINDOW_BASIS_PRE_SEED).length +
        Object.keys(WINDOW_BASIS_UNCLASSIFIABLE).length +
        Object.keys(WINDOW_BASIS_RULING_EXCLUSIONS).length,
    ).toBe(22)
  })

  test("an admitted cell carries the pre-seed derived from its trace", () => {
    const admission = windowBasisAdmission("modes.decsclm")
    expect(admission.admitted).toBe(true)
    if (admission.admitted) expect(admission.preSeed.map(attributeKey)).toEqual(["dec:4"])
  })

  test("every admitted cell names the state its own cleanup leaves, for each attribute it touches", () => {
    // The pre-read and the cleanup target are different values on purpose: a probe resets to the DEFAULT,
    // so a terminal that starts non-default has to be refused by name instead of tripping the ledger.
    // A colour, the pointer shape and the cursor style restore to their own pre-read value (#39207).
    for (const id of Object.keys(WINDOW_BASIS_PRE_SEED)) {
      const admission = windowBasisAdmission(id)
      expect(admission.admitted, `${id} is admitted`).toBe(true)
      if (!admission.admitted) continue
      for (const attribute of admission.preSeed) {
        const target = admission.restoreTarget[attributeKey(attribute)]
        const name = `${id} has a target for ${attributeKey(attribute)}`
        if (restoresToPreRead(attribute)) expect(target, name).toBe(RESTORE_TO_PRE_READ)
        else expect(target, name).toMatch(/^[0-9]$/)
      }
    }
  })

  test("a ruling exclusion refuses by name, before any byte", () => {
    const admission = windowBasisAdmission("reset.soft")
    expect(admission.admitted).toBe(false)
    if (!admission.admitted) {
      expect(admission.reason).toContain("reset.soft")
      expect(admission.reason).toContain("not admitted on a window basis")
      expect(admission.reason).toContain("DECSTR")
    }
    for (const id of ["modes.application-cursor", "modes.mouse-all", "modes.mouse-sgr", "modes.mouse-tracking"]) {
      const exclusion = windowBasisAdmission(id)
      expect(exclusion.admitted, `${id} is refused`).toBe(false)
      if (!exclusion.admitted) expect(exclusion.reason).toContain("no retained trace")
    }
  })

  test("a cell whose write refuses a closed list refuses by name, not at run time", () => {
    // extensions.reflow writes whole screens and also saves and restores the cursor. The tokenizer
    // names every other sequence, so what survives is specific: ESC 7/ESC 8 is on no closed list and
    // no retained write proves its restore. A run-time unclassifiable write is run-fatal, so this is
    // decided here, before the cell writes.
    const admission = windowBasisAdmission("extensions.reflow")
    expect(admission.admitted).toBe(false)
    if (!admission.admitted) {
      expect(admission.reason).toContain("write not on a closed list")
      expect(admission.reason).toContain("ESC 7/ESC 8")
      expect(admission.reason).toContain("extensions.reflow")
    }
  })

  test("a cell the tokenizer classifies end to end now admits", () => {
    // modes.auto-wrap was excluded before the tokenizer: its writes mix text, erases and cursor moves
    // with the mode write. It is admitted only when every retained write is on a closed list.
    const admission = windowBasisAdmission("modes.auto-wrap")
    expect(admission.admitted).toBe(true)
    if (admission.admitted) {
      expect(admission.preSeed).toEqual([{ kind: "dec-mode", mode: 7 }])
      expect(admission.restoreTarget).toEqual({ "dec:7": "1" })
    }
  })

  test("the reset cells restore colours and the pointer shape to the pre-read value (#39207, @cto 5034aa6f)", () => {
    // The default pointer shape cannot be named from ESC ] 22 ; BEL, and a colour cannot be named in
    // advance; the target is the value the cell read before its first write, which the ledger compares.
    const expected: Record<string, Record<string, string>> = {
      "extensions.osc110-reset-fg": { "osc:10": RESTORE_TO_PRE_READ },
      "extensions.osc111-reset-bg": { "osc:11": RESTORE_TO_PRE_READ },
      "extensions.osc22-pointer": { "dec:25": "1", "osc:22": RESTORE_TO_PRE_READ, sgr: "0" },
    }
    for (const [id, restoreTarget] of Object.entries(expected)) {
      expect(windowBasisAdmission(id), id).toMatchObject({ admitted: true, restoreTarget })
    }
    // Until fresh traces replace the frozen ones, the only refusal left on osc104 and osc112 is the
    // ESC 7/ESC 8 their old sentinel and layout-check paint wrote.
    for (const id of ["extensions.osc104-reset-palette", "extensions.osc112-reset-cursor"]) {
      expect(WINDOW_BASIS_UNCLASSIFIABLE[id], id).toContain("ESC 7/ESC 8")
    }
  })

  test("a cell in no table refuses loudly instead of admitting", () => {
    const admission = windowBasisAdmission("modes.not-a-real-cell")
    expect(admission.admitted).toBe(false)
    if (!admission.admitted) expect(admission.reason).toContain("appears in no window-basis table entry")
  })
})
