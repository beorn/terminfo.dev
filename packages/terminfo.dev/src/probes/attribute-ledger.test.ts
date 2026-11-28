/**
 * @failure A cell's write is left behind, or a class with no readback is graded as restored.
 * @level l0
 * @consumer The window-scoped restore abort
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import {
  MutationRestoreRefused,
  attributeKey,
  classifyWrite,
  ledgerOmega,
  readbackFor,
  touchedAttributes,
} from "./attribute-ledger"
import { windowBasisAdmission } from "./window-basis-admission.ts"

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
    const unknown = ledgerOmega({ writes: [`${ESC}7`], reads: new Map() })
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

// #39207, @cto 5034aa6f: two closed-list entries, each with a terminal that breaks its claim and must
// fail the cell by name, or the entry could pass everything.
describe("DECSCUSR and the reset probes' made-up OSC 7110 (#39207)", () => {
  const OSC112 = "extensions.osc112-reset-cursor"
  const decscusrReply = (ps: string) => `${ESC}P1$r${ps} q${ESC}\\`

  it("names CSI Ps SP q as the cursor style, read back through DECRQSS SP q", () => {
    expect(keys(`${ESC}[2 q`)).toEqual(["decscusr"])
    expect(keys(`${ESC}[0 q`)).toEqual(["decscusr"])
    expect(keys(`${ESC}[6 q`)).toEqual(["decscusr"])
    const readback = readbackFor({ kind: "cursor-style" })
    if ("unprovable" in readback) throw new Error("DECSCUSR must be readable through DECRQSS SP q")
    expect(readback.query).toBe(`${ESC}P$q q${ESC}\\`)
    expect(readback.read(decscusrReply("2"))).toBe("2")
    expect(readback.read(`${ESC}P0$r${ESC}\\`)).toBeNull()
    expect(readback.read(`${ESC}[?1;2c`)).toBeNull()
  })

  it("admits the osc112 capture fixture's whole write, DECSCUSR included", () => {
    const write = `${ESC}[0m${ESC}[2J${ESC}[2;1HL  R${ESC}[2;3H${ESC}[2 q${ESC}[?25h`
    expect(touchedAttributes([write])).toEqual({
      attributes: [{ kind: "sgr" }, { kind: "cursor-style" }, { kind: "dec-mode", mode: 25 }],
      unclassified: [],
    })
  })

  it("fails the cell by name when the terminal does not put the cursor style back", () => {
    const omega = ledgerOmega({
      writes: [`${ESC}[2 q`, `${ESC}[0 q`],
      reads: new Map([["decscusr", { before: decscusrReply("1"), after: decscusrReply("2") }]]),
    })
    expect(omega).toEqual({
      status: "refused",
      touched: ["decscusr"],
      failures: [{ attribute: "decscusr", reason: "diverged", before: "1", after: "2" }],
    })
    if (omega.status !== "refused") throw new Error("unreachable")
    const refusal = new MutationRestoreRefused(OSC112, omega)
    expect(refusal.message).toContain(OSC112)
    expect(refusal.message).toContain("decscusr (diverged)")
  })

  it("folds OSC 7110 onto the colours the cell reads back, and refuses it with none to read", () => {
    const cursor = classified(`${ESC}]112\x07`).attributes
    expect(keys(`${ESC}]7110;rgb:12/34/56\x07`, cursor)).toEqual(["osc:12"])
    expect(keys(`${ESC}]7110;rgb:12/34/56${ESC}\\`, [{ kind: "palette", index: 0 }])).toEqual(["osc:4:0"])
    expect(classifyWrite(`${ESC}]7110;rgb:12/34/56\x07`)).toMatchObject({
      unclassified: expect.stringContaining("OSC 7110"),
    })
    expect(classifyWrite(`${ESC}]7110;rgb:12/34/56\x07`, [{ kind: "dec-mode", mode: 25 }])).toMatchObject({
      unclassified: expect.stringContaining("OSC 7110"),
    })
    // Only the probes' own control form is on the list; any other unknown OSC still refuses.
    expect(classifyWrite(`${ESC}]7111;rgb:12/34/56\x07`, cursor)).toMatchObject({
      unclassified: expect.stringContaining("no attribute class"),
    })
  })

  it("fails the cell by name when the terminal changes the seed colour on OSC 7110", () => {
    const omega = ledgerOmega({
      writes: [`${ESC}]112\x07`, `${ESC}]7110;rgb:12/34/56\x07`],
      reads: new Map([["osc:12", { before: `${ESC}]12;rgb:9282/9282/9282\x07`, after: `${ESC}]12;rgb:1212/3434/5656\x07` }]]),
    })
    expect(omega).toEqual({
      status: "refused",
      touched: ["osc:12"],
      failures: [{ attribute: "osc:12", reason: "diverged", before: "rgb:9282/9282/9282", after: "rgb:1212/3434/5656" }],
    })
    if (omega.status !== "refused") throw new Error("unreachable")
    expect(new MutationRestoreRefused(OSC112, omega).message).toContain(`${OSC112}`)
  })
})

describe("ledgerOmega over admitted mixed writes (34579)", () => {
  // The real retained Terminal.app modes.auto-wrap trace @cto's RED used: six writes, five of them
  // mixing a mode change with erase, cursor-move and screen text. Admission accepts all six through
  // the closed grammar, so the restore ledger must read the same grammar, not whole writes.
  const retained = JSON.parse(
    readFileSync(
      new URL(
        "../../../../content/probes-apps/terminal-app-2.15-macos-1991f8e4251a87f27fdc6dc085b2ab62.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { rawReplies: Record<string, string> }
  const writes = (JSON.parse(retained.rawReplies["modes.auto-wrap"] ?? "{}") as { writes: string[] }).writes
  const reads = (before: string, after: string) => new Map([["dec:7", { before, after }]])

  it("restores the admitted auto-wrap trace when dec:7 reads back equal", () => {
    expect(writes).toHaveLength(6)
    expect(windowBasisAdmission("modes.auto-wrap").admitted).toBe(true)
    expect(touchedAttributes(writes)).toEqual({ attributes: [{ kind: "dec-mode", mode: 7 }], unclassified: [] })
    expect(ledgerOmega({ writes, reads: reads(`${ESC}[?7;1$y`, `${ESC}[?7;1$y`) })).toEqual({
      status: "restored",
      touched: ["dec:7"],
    })
  })

  it("still refuses the same trace when dec:7 diverges", () => {
    const omega = ledgerOmega({ writes, reads: reads(`${ESC}[?7;1$y`, `${ESC}[?7;2$y`) })
    expect(omega).toEqual({
      status: "refused",
      touched: ["dec:7"],
      failures: [{ attribute: "dec:7", reason: "diverged", before: "1", after: "2" }],
    })
  })

  it("still refuses a mixed write carrying a token on no closed list, by name", () => {
    for (const write of [`${ESC}[?7lab${ESC}7`, `${ESC}[?7lab\tc`]) {
      const omega = ledgerOmega({ writes: [write], reads: reads(`${ESC}[?7;1$y`, `${ESC}[?7;1$y`) })
      expect(omega).toMatchObject({
        status: "refused",
        failures: [{ attribute: JSON.stringify(write), reason: "unclassified" }],
      })
      expect(touchedAttributes([write]).unclassified).toEqual([write])
    }
  })

  it("folds a union reset inside a mixed write onto what the write already touched", () => {
    const restored = ledgerOmega({ writes: [`${ESC}[?7lx${ESC}[!p`], reads: reads(`${ESC}[?7;1$y`, `${ESC}[?7;1$y`) })
    expect(restored).toEqual({ status: "restored", touched: ["dec:7"] })
    const nothingTouched = ledgerOmega({ writes: [`x${ESC}[!p`], reads: new Map() })
    expect(nothingTouched).toMatchObject({ status: "refused", failures: [{ reason: "unclassified" }] })
  })
})
