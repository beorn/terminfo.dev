/**
 * @failure A mutation cell is admitted under a window-scoped owner basis without declaring what it
 *   may touch, or a declaration silently widens a footprint a reviewer never saw - so an
 *   app-instance or machine mutation runs inside a throwaway window that cannot contain it.
 * @level l2
 * @consumer 34148 Terminal.app throwaway-window authority (@cto a4fc490d condition 1)
 * @reach none
 * @testonly none
 */
import { describe, expect, test } from "vitest"
import { ALL_PROBES } from "./index.ts"
import {
  basisScopeAdmits,
  basisScopeRefusal,
  footprintRefusal,
  TERM_FOOTPRINTS,
  windowBasisAdmits,
} from "./term-footprints.ts"

const WINDOW = [
  "modes.alt-screen.enter",
  "modes.application-cursor",
  "modes.auto-wrap",
  "modes.deccolm",
  "modes.decsclm",
  "modes.reverse-video",
  "modes.synchronized-output",
  "reset.soft",
  "extensions.reflow",
  "text.wrap",
  "scrollback.viewport-hold-output",
  "modes.color-scheme-reporting",
  "modes.focus-tracking",
  "modes.mouse-tracking",
  "modes.mouse-sgr",
  "modes.mouse-all",
  "modes.utf8-mouse-1005",
  "extensions.osc22-pointer",
] as const

const APP_INSTANCE = [
  "extensions.osc104-reset-palette",
  "extensions.osc110-reset-fg",
  "extensions.osc111-reset-bg",
  "extensions.osc112-reset-cursor",
  "extensions.osc113-reset-pointer-fg",
  "extensions.osc114-reset-pointer-bg",
  "extensions.osc117-reset-highlight-bg",
  "extensions.osc119-reset-highlight-fg",
] as const

const MACHINE = ["modes.bracketed-paste"] as const

describe("term footprints (#34148)", () => {
  test("every probe that needs a disposal grant declares a footprint", () => {
    const undeclared = ALL_PROBES.filter(
      (probe) => probe.termNeedsDisposable === true && probe.termFootprint === undefined,
    ).map((probe) => probe.id)
    expect(
      undeclared,
      "a disposal-grant probe with no declared footprint refuses at admission; none may ship that way",
    ).toEqual([])
  })

  test("the declaration reaches the catalogue, not just the table", () => {
    for (const id of [...WINDOW, ...APP_INSTANCE, ...MACHINE]) {
      const probe = ALL_PROBES.find((entry) => entry.id === id)
      expect(probe, `${id} is in the catalogue`).toBeDefined()
      expect(probe?.termFootprint, `${id} carries its declared footprint`).toBe(TERM_FOOTPRINTS[id])
    }
  })

  test("the split is 18 window / 8 app-instance / 1 machine = 27", () => {
    expect(WINDOW.length).toBe(18)
    expect(APP_INSTANCE.length).toBe(8)
    expect(MACHINE.length).toBe(1)
    expect(WINDOW.length + APP_INSTANCE.length + MACHINE.length).toBe(27)
  })

  test("a window basis admits the 18 and refuses the 8 + 1 by name", () => {
    for (const id of WINDOW) expect(windowBasisAdmits(id), `${id} is admitted`).toBe(true)
    for (const id of [...APP_INSTANCE, ...MACHINE]) {
      expect(windowBasisAdmits(id), `${id} is refused`).toBe(false)
      expect(footprintRefusal(id), `${id}'s refusal names its footprint`).toContain(TERM_FOOTPRINTS[id])
    }
  })

  test("an undeclared id refuses as undeclared, never as a default", () => {
    expect(windowBasisAdmits("modes.not-a-real-cell")).toBe(false)
    expect(footprintRefusal("modes.not-a-real-cell")).toContain("undeclared")
  })
  // @cto a4fc490d (revised): the question is not "is this a window cell" but "does this basis scope
  // cover this cell footprint". A process-owned run must admit exactly what it admits today.
  test("regression: a process-scoped basis still admits a colour-reset cell", () => {
    for (const id of APP_INSTANCE) {
      expect(basisScopeAdmits("process", id), id + " stays admitted under the existing process arm").toBe(true)
    }
    expect(basisScopeAdmits("process", "modes.bracketed-paste"), "the pasteboard cell is admitted today").toBe(true)
  })

  test("a window-scoped basis admits window cells and refuses the rest by name", () => {
    for (const id of WINDOW) expect(basisScopeAdmits("window", id), id + " is admitted").toBe(true)
    for (const id of [...APP_INSTANCE, ...MACHINE]) {
      expect(basisScopeAdmits("window", id), id + " is refused").toBe(false)
      const refusal = basisScopeRefusal("window", id)
      expect(refusal, id + " refusal names its footprint").toContain(TERM_FOOTPRINTS[id])
      expect(refusal).toContain("window-scoped")
    }
  })

  test("a basis that declares no scope covers nothing, and an undeclared cell refuses", () => {
    expect(basisScopeAdmits(undefined, "modes.auto-wrap")).toBe(false)
    expect(basisScopeRefusal(undefined, "modes.auto-wrap")).toContain("declares no scope")
    expect(basisScopeAdmits("window", "modes.not-a-real-cell")).toBe(false)
    expect(basisScopeRefusal("process", "modes.not-a-real-cell")).toContain("undeclared")
  })
})
