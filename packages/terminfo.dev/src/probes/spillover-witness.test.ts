/**
 * @failure A cell declared window-confined is graded without a witness, or a spilled cell grades.
 * @level l0
 * @consumer The window-scoped basis admission
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { SpilloverRefused, spilloverVerdict, witnessAdmission } from "./spillover-witness.ts"

const sgr = { kind: "sgr" } as const

describe("witnessAdmission", () => {
  it("admits Terminal.app when the grant covers a second window", () => {
    expect(witnessAdmission({ app: "terminal-app", witness: true })).toEqual({ admitted: true })
  })

  it("refuses every other app by name, and refuses no-witness runs", () => {
    const other = witnessAdmission({ app: "iterm2", witness: true })
    expect(other.admitted).toBe(false)
    if (other.admitted) throw new Error("unreachable")
    expect(other.refusal).toContain("spillover unmeasured for iterm2")
    const none = witnessAdmission({ app: "terminal-app", witness: false })
    expect(none.admitted).toBe(false)
    if (none.admitted) throw new Error("unreachable")
    expect(none.refusal).toContain("no second window in this grant")
  })
})

describe("spilloverVerdict", () => {
  it("grades an unchanged witness and names a changed one", () => {
    expect(spilloverVerdict({ attribute: sgr, before: "0;31", after: "0;31" })).toEqual({ status: "unchanged" })
    const spilled = spilloverVerdict({ attribute: sgr, before: "0;31", after: "0;32" })
    expect(spilled.status).toBe("spilled")
    if (spilled.status !== "spilled") throw new Error("unreachable")
    expect(spilled.reason).toContain("changed the app instance")
  })

  it("refuses a witness that never read before the cell, and a silent witness", () => {
    expect(spilloverVerdict({ attribute: sgr, before: undefined, after: "0;31" })).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("no reading of it before this cell"),
    })
    expect(spilloverVerdict({ attribute: sgr, before: "0;31", after: undefined })).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("did not answer after this cell"),
    })
  })

  it("raises a named refusal that says which of the two failures it is", () => {
    const refusal = new SpilloverRefused("modes.auto-wrap", {
      status: "refused",
      reason: "spillover unmeasured for dec:7: no reading",
    })
    expect(refusal.name).toBe("SpilloverRefused")
    expect(refusal.message).toContain("cannot be shown window-confined")
  })
})
