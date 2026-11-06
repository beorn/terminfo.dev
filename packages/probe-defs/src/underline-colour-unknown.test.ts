/**
 * @failure A library that does not know SGR 58 keeps the underline-colour cells Open even though the same
 *   run shows that SGR 58 behaved exactly like a made-up number (77): the numbers after it ran as their
 *   own commands (@cto routes-32 section 1, 23:02 PST Nov 5 2026).
 * @failure The made-up control is skipped, so a library that knows 58 but hides the colour field, or one
 *   that drops the whole unknown SGR, is graded Unsupported.
 * @failure SGR 59 is left Open on a library whose own report lists it, or libvterm 0.3.3's reset cell
 *   (no working SGR 58 to reset) is declared anywhere except that exact identity.
 * @level l2
 * @consumer @si/terminfo/30211-terminfo-273/32438-u-uc-underline-colour-16
 * @testonly none
 */
import { describe, expect, test } from "vitest"

import { isDeclaredUntestable } from "./index.ts"
import { sgrProbes } from "./sgr.ts"
import { inertLibProbeSource } from "./testing/group-harness.ts"
import type { HeadlessRuntimeIdentity, LibProbeSource, UnhandledSequence } from "./types.ts"

const UNKNOWN_REASON = "SGR 58 behaved exactly like an unknown number: the numbers after it ran as their own commands"
const REPORT_REASON = "library reported this sequence as unhandled"

const sgr = (id: string) => sgrProbes.find((entry) => entry.id === id)!

type Pen = { bold: boolean; dim: boolean; italic: boolean; underline: boolean; blink: boolean }

/**
 * A small parser library. `knows58` consumes SGR 58's colour operands; otherwise 58, like 77, is an unknown
 * number whose operands run as their own commands. `dropsUnknown` ignores a whole SGR holding an unknown
 * number. The colour field is never exposed, as on the four libraries this route decides.
 */
function parserLibrary(spec: { knows58?: boolean; dropsUnknown?: boolean; reports?: boolean }): LibProbeSource {
  const base = inertLibProbeSource()
  const cells = new Map<string, Pen & { char: string }>()
  const report: UnhandledSequence[] = []
  let pen: Pen = { bold: false, dim: false, italic: false, underline: false, blink: false }
  let row = 0
  let col = 0
  const sgrApply = (params: number[]) => {
    if (spec.reports && params.some((n) => n === 59 || n === 77 || (n === 58 && !spec.knows58))) {
      report.push({ kind: "csi", code: `${params.join(";")}m` })
    }
    if (spec.dropsUnknown && params.some((n) => n === 77 || (n === 58 && !spec.knows58))) return
    for (let i = 0; i < params.length; i++) {
      const n = params[i]
      if (n === 58 && spec.knows58) {
        i += params[i + 1] === 2 ? 4 : 2
        continue
      }
      if (n === 0) pen = { bold: false, dim: false, italic: false, underline: false, blink: false }
      if (n === 1) pen = { ...pen, bold: true }
      if (n === 2) pen = { ...pen, dim: true }
      if (n === 3) pen = { ...pen, italic: true }
      if (n === 4) pen = { ...pen, underline: true }
      if (n === 5) pen = { ...pen, blink: true }
    }
  }
  return {
    ...base,
    backendName: "parser-model",
    ...(spec.reports && { getUnhandledSequences: () => report.slice() }),
    getCursor: () => ({ x: col, y: row, visible: true, style: null }),
    getCell: (r, c) => {
      const cell = cells.get(`${r},${c}`)
      return { ...base.getCell(r, c), ...(cell ?? {}), underlineColor: null }
    },
    feed: (text) => {
      const pattern = /\x1b\[([0-9;:]*)([A-Za-z])|([^\x1b])/g
      for (const match of text.matchAll(pattern)) {
        if (match[3] !== undefined) {
          cells.set(`${row},${col}`, { ...pen, char: match[3] })
          col++
          continue
        }
        const params = (match[1] ?? "").split(";").map((part) => Number(part || "0"))
        if (match[2] === "m") sgrApply(params)
        if (match[2] === "H") {
          row = (params[0] || 1) - 1
          col = (params[1] || 1) - 1
        }
      }
    },
  }
}

const identity = (engineVersion: string) =>
  ({ kind: "js", runtimeFormat: "wasm", engineVersion }) as unknown as HeadlessRuntimeIdentity

describe("SGR 58 against the made-up SGR 77 in the same run", () => {
  test.each(["sgr.underline.color", "sgr.underline-color-indexed", "sgr.underline-color-rgb"])(
    "%s is Unsupported when 58 behaves exactly like 77",
    (id) => {
      const result = sgr(id).lib!(parserLibrary({}))
      expect(result.observation?.outcome).toBe("unsupported")
      expect(result.observation?.note).toBe(UNKNOWN_REASON)
      expect(JSON.parse(result.response!)).toMatchObject({ unknownControl: { equal: true } })
    },
  )

  test.each(["sgr.underline.color", "sgr.underline-color-indexed", "sgr.underline-color-rgb"])(
    "%s stays Open when 58 is known but its colour field is hidden",
    (id) => {
      const result = sgr(id).lib!(parserLibrary({ knows58: true }))
      expect(result.observation?.outcome).not.toBe("unsupported")
      expect(JSON.stringify(result)).not.toContain(UNKNOWN_REASON)
    },
  )

  test.each(["sgr.underline.color", "sgr.underline-color-indexed", "sgr.underline-color-rgb"])(
    "%s stays Open when the library drops the whole unknown SGR, so no attribute is set",
    (id) => {
      const result = sgr(id).lib!(parserLibrary({ dropsUnknown: true }))
      expect(result.observation?.outcome).not.toBe("unsupported")
      expect(JSON.stringify(result)).not.toContain(UNKNOWN_REASON)
    },
  )
})

describe("SGR 59", () => {
  test("is Unsupported through the library's own report", () => {
    const result = sgr("sgr.underline-color-reset").lib!(parserLibrary({ reports: true }))
    expect(result.observation?.outcome).toBe("unsupported")
    expect(JSON.stringify(result)).toContain(REPORT_REASON)
  })

  test("is declared Untestable (no setup) on libvterm 0.3.3 only, where SGR 58 does not work", () => {
    const libvterm = { ...parserLibrary({}), backendName: "libvterm", runtimeIdentity: identity("0.3.3") }
    const declared = sgr("sgr.underline-color-reset").lib!(libvterm)
    expect(isDeclaredUntestable(declared)).toBe(true)
    expect(declared.tests?.[0]?.reason).toBe(
      "Untestable (no setup): SGR 58 does not work on this library, so this command has nothing to act on. Library version: 0.3.3.",
    )
    for (const source of [
      { ...libvterm, runtimeIdentity: identity("0.3.4") },
      { ...parserLibrary({}), backendName: "vt100", runtimeIdentity: identity("0.3.3") },
      { ...parserLibrary({ knows58: true }), backendName: "libvterm", runtimeIdentity: identity("0.3.3") },
    ]) {
      const result = sgr("sgr.underline-color-reset").lib!(source)
      expect(isDeclaredUntestable(result), source.backendName).toBe(false)
      expect(result.observation?.outcome).not.toBe("unsupported")
    }
  })
})
