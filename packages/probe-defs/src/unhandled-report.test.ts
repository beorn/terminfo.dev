/**
 * @failure A state cell is graded Unsupported from the library's unhandled-sequence report without
 *   both same-run controls the ruling requires (@cto 2026-11-05 07:25 appendix, Case 1): a handled
 *   sequence must add no entry AND its own reader must show it applied, and the target must add
 *   exactly one entry carrying its code. Without both, the row keeps today's TODO naming what
 *   failed; a missing member keeps today's meaning and never becomes Supported.
 *
 * @failure The report is allowed to decide a delivery cell. OSC 7 / OSC 633 P / OSC 9 / OSC 777
 *   are Supported because their payload reaches the host, so the report must not touch them.
 *
 * @failure The report is allowed to decide an SGR cell outside the six the appendix names.
 * @level l2
 * @consumer 32362 unhandled-sequence consumer: Case 1 of @cto's 2026-11-05 07:25 appendix.
 * @testonly none
 */
import { describe, expect, test } from "vitest"

import { extensionsProbes } from "./extensions.ts"
import { sgrProbes } from "./sgr.ts"
import { inertLibProbeSource } from "./testing/group-harness.ts"
import type { LibProbeSource, UnhandledSequence } from "./types.ts"

const REASON = "library reported this sequence as unhandled"

const probe = (id: string) => extensionsProbes.find((entry) => entry.id === id)!
const sgr = (id: string) => sgrProbes.find((entry) => entry.id === id)!

/**
 * A library whose `feed` drives the two things the ruling's controls read: OSC 2 sets the title
 * reader, SGR 1 bolds the cell, and every sequence `records` matches is appended to the report in
 * the order it arrived. `records` is array order, so a control entry can be placed either way.
 */
function reportingSource(spec: {
  records?: readonly { readonly match: RegExp; readonly code: UnhandledSequence }[]
  titleApplies?: boolean
  boldApplies?: boolean
}): LibProbeSource {
  const report: UnhandledSequence[] = []
  let title = ""
  let bold = false
  const base = inertLibProbeSource()
  return {
    ...base,
    getUnhandledSequences: () => report.slice(),
    getTitle: () => title,
    getCell: () => ({ ...base.getCell(0, 0), bold }),
    feed: (text) => {
      const titleSet = /\x1b\]2;([^\x07]*)\x07/.exec(text)
      if (titleSet) {
        if (spec.titleApplies !== false) title = titleSet[1] ?? ""
      }
      if (text.includes("\x1b[0m")) bold = false
      if (text.includes("\x1b[1m") && spec.boldApplies !== false) bold = true
      for (const entry of spec.records ?? []) if (entry.match.test(text)) report.push(entry.code)
    },
  }
}

const recordsOsc = (code: string) => ({ match: new RegExp(`\\x1b\\]${code}`), code: { kind: "osc" as const, code } })
const recordsCsi = (code: string) => ({
  match: new RegExp(`\\x1b\\[${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  code: { kind: "csi" as const, code },
})

describe("the unhandled report decides only state cells, and only with both controls", () => {
  test.each([
    ["extensions.osc113-reset-pointer-fg", "113"],
    ["extensions.osc114-reset-pointer-bg", "114"],
    ["extensions.osc117-reset-highlight-bg", "117"],
    ["extensions.osc119-reset-highlight-fg", "119"],
  ])("a colour-reset cell the library reports unhandled becomes Unsupported: %s", (id, code) => {
    const source = reportingSource({ records: [recordsOsc(code)] })
    const result = probe(id).lib!(source)
    expect(result.observation?.outcome).toBe("unsupported")
    expect(JSON.stringify(result)).toContain(REASON)
  })

  test("a colour reset outside the four named cells keeps its own path", () => {
    // @cto names the ledger's colour-reset group (113/114/117/119); 104/110/111/112 belong to another
    // card group and must not move here even when the same report carries their number.
    for (const [id, code] of [
      ["extensions.osc104-reset-palette", "104"],
      ["extensions.osc110-reset-fg", "110"],
      ["extensions.osc111-reset-bg", "111"],
      ["extensions.osc112-reset-cursor", "112"],
    ] as const) {
      const source = reportingSource({ records: [recordsOsc(code)] })
      const result = probe(id).lib!(source)
      expect(result.observation?.outcome, id).not.toBe("unsupported")
      expect(JSON.stringify(result), id).not.toContain(REASON)
    }
  })

  test("the two umbrella shell cells reach the report arm too", () => {
    for (const [id, code] of [
      ["extensions.semantic-prompts", "133"],
      ["extensions.osc-633-vscode", "633"],
    ] as const) {
      const source = reportingSource({ records: [recordsOsc(code)] })
      const result = probe(id).lib!(source)
      expect(result.observation?.outcome, id).toBe("unsupported")
      expect(JSON.stringify(result), id).toContain(REASON)
    }
  })

  test("a shell-mark cell the library reports unhandled becomes Unsupported", () => {
    const source = reportingSource({ records: [recordsOsc("133")] })
    const result = probe("extensions.osc133-a").lib!(source)
    expect(result.observation?.outcome).toBe("unsupported")
    expect(JSON.stringify(result)).toContain(REASON)
  })

  test("a report without the target's code leaves the cell undecided", () => {
    const source = reportingSource({ records: [recordsOsc("111")] })
    const result = probe("extensions.osc113-reset-pointer-fg").lib!(source)
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  })

  test("a report that also records the handled control leaves the cell undecided", () => {
    const source = reportingSource({ records: [recordsOsc("113"), recordsOsc("2")] })
    const result = probe("extensions.osc113-reset-pointer-fg").lib!(source)
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  })

  test("a control whose own reader does not show it applied leaves the cell undecided", () => {
    const source = reportingSource({ records: [recordsOsc("113")], titleApplies: false })
    const result = probe("extensions.osc113-reset-pointer-fg").lib!(source)
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  })

  test("a missing member keeps today's meaning", () => {
    const result = probe("extensions.osc113-reset-pointer-fg").lib!(inertLibProbeSource())
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  })

  test("a delivery cell is never decided by the report", () => {
    const source = reportingSource({
      records: [recordsOsc("7"), recordsOsc("9"), recordsOsc("633"), recordsOsc("777")],
    })
    for (const id of [
      "extensions.osc7-cwd",
      "extensions.osc9-progress",
      "extensions.osc633-p",
      "extensions.osc777-notify",
    ]) {
      const result = probe(id).lib!(source)
      expect(JSON.stringify(result)).not.toContain(REASON)
    }
  })
})

describe("the SGR arm moves only the six named cells, with SGR 1 as its control", () => {
  test.each([
    ["sgr.blink", "5m"],
    ["sgr.strikethrough", "9m"],
    ["sgr.underline.double", "21m"],
    ["sgr.underline.curly", "4:3m"],
    ["sgr.underline.dotted", "4:4m"],
    ["sgr.underline.dashed", "4:5m"],
  ])("%s becomes Unsupported when the library reports %s", (id, code) => {
    const source = reportingSource({ records: [recordsCsi(code)] })
    const result = sgr(id).lib!(source)
    expect(result.observation?.outcome).toBe("unsupported")
    expect(JSON.stringify(result)).toContain(REASON)
  })

  test("a report that also records SGR 1 leaves the cell undecided", () => {
    const source = reportingSource({ records: [recordsCsi("5m"), recordsCsi("1m")] })
    const result = sgr("sgr.blink").lib!(source)
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  })

  test("a bold reader that never applies leaves the cell undecided", () => {
    const source = reportingSource({ records: [recordsCsi("5m")], boldApplies: false })
    const result = sgr("sgr.blink").lib!(source)
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  })

  test("a private intermediate never matches the plain SGR code", () => {
    const source = reportingSource({ records: [recordsCsi("?5m")] })
    const result = sgr("sgr.blink").lib!(source)
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  })

  test("an SGR cell outside the six keeps its own path", () => {
    const source = reportingSource({ records: [recordsCsi("3m"), recordsCsi("1m")] })
    const result = sgr("sgr.italic").lib!(source)
    expect(JSON.stringify(result)).not.toContain(REASON)
  })
})
