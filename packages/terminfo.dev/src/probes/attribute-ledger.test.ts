import { describe, expect, it } from "vitest"
import { MutationRestoreRefused, attributeKey, classifyWrite, ledgerOmega, readbackFor } from "./attribute-ledger"

const ESC = "\x1b"

function classified(sequence: string, touched?: Parameters<typeof classifyWrite>[1]) {
  const classification = classifyWrite(sequence, touched)
  if ("unclassified" in classification) throw new Error(classification.unclassified)
  return classification
}

function keys(sequence: string, touched?: Parameters<typeof classifyWrite>[1]): string[] {
  return classified(sequence, touched).attributes.map(attributeKey)
}

describe("classifyWrite", () => {
  it("names every DEC private mode in a multi-parameter set and reset", () => {
    expect(keys(`${ESC}[?7;25h`)).toEqual(["dec:7", "dec:25"])
    expect(keys(`${ESC}[?1004l`)).toEqual(["dec:1004"])
  })

  it("keeps an ANSI mode apart from a DEC private mode with the same number", () => {
    expect(keys(`${ESC}[4h`)).toEqual(["ansi:4"])
    expect(keys(`${ESC}[?4h`)).toEqual(["dec:4"])
  })

  it("names SGR by its normalized parameters and a bare SGR as the default reset", () => {
    expect(keys(`${ESC}[1;31m`)).toEqual(["sgr"])
    expect(keys(`${ESC}[m`)).toEqual(["sgr"])
  })

  it("names palette entries, direct colours and the pointer shape", () => {
    expect(keys(`${ESC}]4;0;rgb:00/00/00\x07`)).toEqual(["osc:4:0"])
    expect(keys(`${ESC}]10;rgb:ff/ff/ff${ESC}\\`)).toEqual(["osc:10"])
    expect(keys(`${ESC}]11;?\x07`)).toEqual(["osc:11"])
    expect(keys(`${ESC}]12;#ffffff\x07`)).toEqual(["osc:12"])
    expect(keys(`${ESC}]22;crosshair\x07`)).toEqual(["osc:22"])
  })

  it("folds an OSC 104 whole-palette reset onto the palette entries the cell already touched", () => {
    const palette = classified(`${ESC}]4;0;rgb:00/00/00\x07`).attributes
    expect(keys(`${ESC}]104\x07`, palette)).toEqual(["osc:4:0"])
  })

  it("folds DECSTR onto the attributes the cell already touched", () => {
    const mode = classified(`${ESC}[?7h`).attributes
    expect(keys(`${ESC}[!p`, mode)).toEqual(["dec:7"])
  })

  it("refuses by name what it cannot classify, including a union reset with nothing to union", () => {
    expect(classifyWrite(`${ESC}[2J`)).toMatchObject({ unclassified: expect.stringContaining("no attribute class") })
    expect(classifyWrite(`${ESC}[!p`)).toMatchObject({ unclassified: expect.stringContaining("DECSTR") })
    expect(classifyWrite(`${ESC}]104\x07`)).toMatchObject({ unclassified: expect.stringContaining("OSC 104") })
  })
})

describe("readbackFor", () => {
  it("asks DECRQM for a DEC mode and reads its Ps", () => {
    const readback = readbackFor({ kind: "dec-mode", mode: 1004 })
    if ("unprovable" in readback) throw new Error("DEC modes must be readable")
    expect(readback.query).toBe(`${ESC}[?1004$p`)
    expect(readback.read(`${ESC}[?1004;1$y`)).toBe("1")
    expect(readback.read(`${ESC}[?1004;2$y`)).toBe("2")
    expect(readback.read("")).toBeNull()
  })

  it("asks OSC 4 and the direct colour codes for their value", () => {
    const palette = readbackFor({ kind: "palette", index: 3 })
    if ("unprovable" in palette) throw new Error("palette must be readable")
    expect(palette.query).toBe(`${ESC}]4;3;?\x07`)
    expect(palette.read(`${ESC}]4;3;rgb:12/34/56\x07`)).toBe("rgb:12/34/56")
    const foreground = readbackFor({ kind: "foreground" })
    if ("unprovable" in foreground) throw new Error("foreground must be readable")
    expect(foreground.read(`${ESC}]10;rgb:ff/ff/ff${ESC}\\`)).toBe("rgb:ff/ff/ff")
  })

  it("reads the SGR pen state through DECRQSS and the pointer shape through OSC 22's own query", () => {
    const sgr = readbackFor({ kind: "sgr" })
    if ("unprovable" in sgr) throw new Error("SGR must be readable through DECRQSS")
    expect(sgr.query).toBe(`${ESC}P$qm${ESC}\\`)
    expect(sgr.read(`${ESC}P1$r0;31m${ESC}\\`)).toBe("0;31")
    expect(sgr.read(`${ESC}P0$r${ESC}\\`)).toBeNull()
    const pointer = readbackFor({ kind: "pointer-shape" })
    if ("unprovable" in pointer) throw new Error("OSC 22 must be readable through its query form")
    expect(pointer.query).toBe(`${ESC}]22;?__current__\x07`)
    expect(pointer.read(`${ESC}]22;crosshair${ESC}\\`)).toBe("crosshair")
    expect(pointer.read("")).toBeNull()
  })
})

describe("ledgerOmega", () => {
  const reads = (before: string, after: string) => new Map([["dec:7", { before, after }]])

  it("grades a cell only when every touched attribute reads back equal", () => {
    const omega = ledgerOmega({ writes: [`${ESC}[?7h`, `${ESC}[?7l`], reads: reads(`${ESC}[?7;1$y`, `${ESC}[?7;1$y`) })
    expect(omega.status).toBe("restored")
    expect(omega.touched).toEqual(["dec:7"])
  })

  it("refuses a diverged attribute with both readings", () => {
    const omega = ledgerOmega({ writes: [`${ESC}[?7l`], reads: reads(`${ESC}[?7;1$y`, `${ESC}[?7;2$y`) })
    expect(omega.status).toBe("refused")
    if (omega.status !== "refused") throw new Error("unreachable")
    expect(omega.failures).toEqual([{ attribute: "dec:7", reason: "diverged", before: "1", after: "2" }])
  })

  it("refuses a missing pre-state and a missing post-state, never assuming either", () => {
    const noBefore = ledgerOmega({ writes: [`${ESC}[?7l`], reads: new Map([["dec:7", { after: `${ESC}[?7;1$y` }]]) })
    expect(noBefore).toMatchObject({ failures: [{ attribute: "dec:7", reason: "no-pre-state" }] })
    const noAfter = ledgerOmega({ writes: [`${ESC}[?7l`], reads: new Map([["dec:7", { before: `${ESC}[?7;1$y` }]]) })
    expect(noAfter).toMatchObject({ failures: [{ attribute: "dec:7", reason: "no-post-state" }] })
  })

  it("refuses a class whose query drew no reply, and an unclassified write", () => {
    const sgr = ledgerOmega({ writes: [`${ESC}[31m`], reads: new Map() })
    expect(sgr).toMatchObject({ failures: [{ attribute: "sgr", reason: "no-pre-state" }] })
    const unknown = ledgerOmega({ writes: [`${ESC}[2J`], reads: new Map() })
    expect(unknown).toMatchObject({ failures: [{ reason: "unclassified" }] })
  })

  it("raises a named refusal carrying the omega", () => {
    const refusal = new MutationRestoreRefused("modes.auto-wrap", {
      status: "refused",
      touched: ["dec:7"],
      failures: [{ attribute: "dec:7", reason: "diverged", before: "1", after: "2" }],
    })
    expect(refusal.name).toBe("MutationRestoreRefused")
    expect(refusal.message).toContain("dec:7 (diverged)")
  })
})
