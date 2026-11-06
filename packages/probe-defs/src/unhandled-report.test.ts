/**
 * @failure A state cell is graded Unsupported from the library's unhandled-sequence report without
 *   both same-run controls the ruling requires (@cto 2026-11-05 07:25 appendix, Case 1): a handled
 *   sequence must add no entry AND its own reader must show it applied, and the target must add
 *   exactly one entry carrying its code. Without both, the row keeps today's TODO naming what
 *   failed; a missing member keeps today's meaning and never becomes Supported.
 *
 * @failure A report replaces a real payload reader, or a number-only OSC 777 report cannot
 *   decide rejection. Existing payload-reader contracts retain their own deciding path.
 *
 * @failure The report is allowed to decide an SGR cell outside the six the appendix names.
 * @level l2
 * @consumer 32362 unhandled-sequence consumer: Case 1 of @cto's 2026-11-05 07:25 appendix.
 * @testonly none
 */
import { describe, expect, test } from "vitest"

import { extensionsProbes, withD2LibraryObservation } from "./extensions.ts"
import { sgrProbes } from "./sgr.ts"
import { ALL_PROBES, isDeclaredUntestable } from "./index.ts"
import { inertLibProbeSource } from "./testing/group-harness.ts"
import type { HeadlessRuntimeIdentity, LibProbeSource, UnhandledSequence } from "./types.ts"
import { parserStateResult, recordExecutedProbe } from "./helpers.ts"

const REASON = "library reported this sequence as unhandled"

// A report or declaration cannot replace a deciding callback supplied by the registry.
test.each([
  "sgr.fg.256",
  "extensions.osc2-title",
  "device.xtwinops-22",
  "editing.decsace",
  "extensions.osc52-clipboard",
  "extensions.osc52-write",
])("%s retains its existing measured reader outcome", (id) => {
  for (const pass of [true, false]) {
    const definition = withD2LibraryObservation({
      id,
      lib: () => parserStateResult(pass, "existing measured reader", { measured: pass }),
      term: null,
    })
    const source = reportingSource({ records: [recordsOsc("2"), recordsOsc("52"), recordsCsi("38;5;173m")] })
    Object.assign(source, { backendName: "vt100", runtimeIdentity: { kind: "js", engineVersion: "0.13.1" } })
    const result = definition.lib!(source)
    expect(result.observation?.outcome).toBe(pass ? "supported" : "unsupported")
    expect(isDeclaredUntestable(result)).toBe(false)
    expect(JSON.stringify(result)).not.toContain(REASON)
  }
})

// NR-C: existing scalar cases cannot catch partial, reordered or extra reports.
test.each([
  ["sgr.fg.256", "38;5;173m", ["38m", "173m"]],
  ["sgr.bg.truecolor", "48;2;17;97;201m", ["48m", "2m", "17m", "97m", "201m"]],
] as const)("%s requires the complete ordered report and a handled control", (id, sequence, codes) => {
  const exact: UnhandledSequence[] = codes.map((code) => ({ kind: "csi", code }))
  const variants = [
    exact.slice(0, -1),
    [...exact, { kind: "csi" as const, code: "999m" }],
    [...exact].reverse(),
    exact.map((code, index) => (index === exact.length - 1 ? { ...code, kind: "osc" as const } : code)),
    exact.map((code, index) => (index === exact.length - 1 ? { ...code, code: "999m" } : code)),
  ]
  const definition = ALL_PROBES.find((entry) => entry.id === id)!
  for (const codes of variants) {
    const source = reportingSource({ records: codes.map((code) => ({ ...recordsCsi(sequence), code })) })
    Object.assign(source, { backendName: "vt100" })
    const result = definition.lib!(source)
    expect(result.observation?.outcome, JSON.stringify(codes)).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  }
  for (const control of [{ boldApplies: false }, { rejected: true }, { missing: true }]) {
    const source = reportingSource({
      records: [
        ...exact.map((code) => ({ ...recordsCsi(sequence), code })),
        ...("rejected" in control ? [recordsCsi("1m")] : []),
      ],
      ...control,
    })
    Object.assign(source, {
      backendName: "vt100",
      ...("missing" in control ? { getUnhandledSequences: undefined } : {}),
    })
    const result = definition.lib!(source)
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  }
})

// A rejected target cannot stand in for rejection of its prerequisite.
test.each([
  ["erase.el-with-attrs", "42m", "0K"],
  ["device.xtwinops-22", "osc2", "22;0t"],
  ["device.xtwinops-23", "osc2", "23;0t"],
  ["modes.alt-screen.exit", "?1049h", "?1049l"],
  ["sgr.selective-reset.italic", "3m", "23m"],
])("%s needs its own setup rejection for Untestable", (id, setup, target) => {
  const definition = ALL_PROBES.find((entry) => entry.id === id)!
  for (const spec of [
    { records: [recordsCsi(target)] },
    { records: [setup === "osc2" ? recordsOsc("2") : recordsCsi(setup)], boldApplies: false },
    { records: [setup === "osc2" ? recordsOsc("2") : recordsCsi(setup), recordsCsi("1m")] },
    { records: [] },
  ]) {
    const source = reportingSource({ ...spec, titleApplies: false })
    Object.assign(source, { backendName: "vt100" })
    const result = definition.lib!(source)
    expect(isDeclaredUntestable(result)).toBe(false)
    expect(result.observation?.outcome).not.toBe("unsupported")
    const recorded = recordExecutedProbe({
      featureId: id,
      attempt: { scope: "probe", startedAt: "2026-11-06T06:54:00Z" },
      assertions: [],
      ...(result.notTested ? { coverage: { featureId: id, rawReplyRef: id, ...result.notTested } } : {}),
      ...(result.tests ? { tests: result.tests } : {}),
      ...(result.criterionBranch ? { criterionBranch: result.criterionBranch } : {}),
    })
    expect(recorded.status).toBe("probe-todo")
  }
})

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
  modeApplies?: boolean
}): LibProbeSource {
  const report: UnhandledSequence[] = []
  let title = ""
  let bold = false
  let autoWrap = true
  const base = inertLibProbeSource()
  return {
    ...base,
    getUnhandledSequences: () => report.slice(),
    getTitle: () => title,
    getMode: (name) => (name === "autoWrap" ? autoWrap : base.getMode(name)),
    getCell: () => ({ ...base.getCell(0, 0), bold }),
    feed: (text) => {
      if (spec.modeApplies !== false) {
        if (text === "\x1b[?7l") autoWrap = false
        if (text === "\x1b[?7h") autoWrap = true
      }
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

const recordsOsc = (code: string) => ({
  match: new RegExp(`\\x1b\\]${code}(?=;|\\x07|\\x1b)`),
  code: { kind: "osc" as const, code },
})
const recordsCsi = (code: string) => ({
  match: new RegExp(`\\x1b\\[${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  code: { kind: "csi" as const, code },
})

// Route 2: the clipboard is outside the library, but its own parser rejection
// can decide the write. Missing controls and the unqueued subjects stay on their prior path.
test.each(["extensions.osc52-clipboard", "extensions.osc52-write"])(
  "%s VT100 rejection needs its own report and the existing handled control",
  (id) => {
    const definition = ALL_PROBES.find((entry) => entry.id === id)!
    const source = reportingSource({ records: [recordsOsc("2"), recordsOsc("52")], titleApplies: false })
    Object.assign(source, { backendName: "vt100" })
    expect(definition.lib!(source).observation?.outcome).toBe("unsupported")
    for (const overrides of [
      { backendName: "vt220" },
      { getUnhandledSequences: undefined },
      { getCell: inertLibProbeSource().getCell },
    ]) {
      const control = reportingSource({ records: [recordsOsc("2"), recordsOsc("52")], titleApplies: false })
      Object.assign(control, { backendName: "vt100", ...overrides })
      expect(JSON.stringify(definition.lib!(control))).not.toContain(REASON)
    }
  },
)

// DEC-additions-five N-TITLE (@cto routes-48): vt100 and vt220 expose no title or icon reader, so the
// library's own report decides OSC 0 once its OSC 2 control is unhandled and the SGR 1 paint applies.
test.each(["vt100", "vt220"])(
  "%s extensions.osc0-icon-title decides Unsupported from its own report",
  (backendName) => {
    const definition = ALL_PROBES.find((entry) => entry.id === "extensions.osc0-icon-title")!
    const source = reportingSource({ records: [recordsOsc("2"), recordsOsc("0")], titleApplies: false })
    Object.assign(source, { backendName })
    const result = definition.lib!(source)
    expect(result.observation?.outcome).toBe("unsupported")
    expect(JSON.stringify(result)).toContain(REASON)
  },
)

// The same report cannot decide without the SGR 1 paint control applying in that run.
test.each(["vt100", "vt220"])(
  "%s extensions.osc0-icon-title keeps its TODO without an applied control",
  (backendName) => {
    const definition = ALL_PROBES.find((entry) => entry.id === "extensions.osc0-icon-title")!
    for (const [label, spec, overrides] of [
      ["no applied control", { boldApplies: false }, {}],
      ["no report reader", {}, { getUnhandledSequences: undefined }],
      ["no target entry", { records: [recordsOsc("2")] }, {}],
    ] as const) {
      const source = reportingSource({ records: [recordsOsc("2"), recordsOsc("0")], titleApplies: false, ...spec })
      Object.assign(source, { backendName, ...overrides })
      const result = definition.lib!(source)
      expect(result.observation?.outcome, label).not.toBe("unsupported")
      expect(JSON.stringify(result), label).not.toContain(REASON)
    }
  },
)

// DEC-additions-five N-5522 (@cto routes-48): both libraries report the OSC 5522 command itself and
// add nothing for the CSI ?5522$p mode query, so the command's own code is the deciding entry.
test.each(["vt100", "vt220"])(
  "%s extensions.osc5522-clipboard decides Unsupported from its own report",
  (backendName) => {
    const definition = ALL_PROBES.find((entry) => entry.id === "extensions.osc5522-clipboard")!
    const source = reportingSource({ records: [recordsOsc("5522")] })
    Object.assign(source, { backendName })
    const result = definition.lib!(source)
    expect(result.observation?.outcome).toBe("unsupported")
    expect(JSON.stringify(result)).toContain(REASON)
  },
)

// @failure H-4's numeric rejection reports remain TODO, or a failed handled control invents a negative.
// @level l2
// @consumer The registered host-effect callbacks, with the existing report/control fixture.
test.each(["vt100", "vt220", "ghostty"])("H-4 %s uses its exact report and an applied control", (backendName) => {
  for (const [id, code] of [
    ["extensions.osc176-app-id", "176"],
    ["extensions.osc3008-context", "3008"],
    ["extensions.osc440-audio", "440"],
    ["extensions.osc555-flash", "555"],
    ["extensions.osc666-termprop", "666"],
    ["extensions.osc710-font-normal", "710"],
  ] as const) {
    const definition = ALL_PROBES.find((entry) => entry.id === id)!
    const titleApplies = backendName === "ghostty"
    const records = titleApplies ? [recordsOsc(code)] : [recordsOsc("2"), recordsOsc(code)]
    const result = definition.lib!({ ...reportingSource({ records, titleApplies }), backendName })
    expect(result.observation, `${backendName}:${id}`).toMatchObject({ outcome: "unsupported" })
    expect(JSON.parse(result.response!)).toMatchObject({ unhandled: { target: { kind: "osc", code } } })
    const failedControl = definition.lib!({
      ...reportingSource({ records, titleApplies: false, boldApplies: false }),
      backendName,
    })
    expect(failedControl.observation?.outcome, `${backendName}:${id}:failed control`).not.toBe("unsupported")
  }
})

// DEC1: registered callbacks must feed one own command after the prior arm; a mouse pair
// or an ignored control cannot turn an otherwise undecided feature into a negative.
test.each([
  ["input.button-event-mouse", "?1002h"],
  ["input.pixel-mouse", "?1016h"],
  ["input.urxvt-mouse", "?1015h"],
  ["input.x10-mouse", "?9h"],
  ["input.xtest-click", "?1000h"],
  ["input.xtest-wheel", "?1000h"],
  ["modes.alt-scroll-1007", "?1007h"],
  ["modes.bracketed-paste", "?2004h"],
  ["modes.color-scheme-reporting", "?2031h"],
  ["modes.focus-tracking", "?1004h"],
  ["modes.mouse-all", "?1003h"],
  ["modes.mouse-sgr", "?1006h"],
  ["modes.mouse-tracking", "?1000h"],
  ["modes.synchronized-output", "?2026h"],
  ["modes.utf8-mouse-1005", "?1005h"],
  ["modes.xtpopcolors", "#Q"],
  ["modes.xtpushcolors", "#P"],
])("%s requires its exact report and a working mode control", (id, code) => {
  const definition = ALL_PROBES.find((entry) => entry.id === id)!
  const result = definition.lib!(reportingSource({ records: [recordsCsi(code)] }))
  expect(result.observation, id).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
  expect(JSON.parse(result.response!), id).toMatchObject({ unhandled: { target: { kind: "csi", code } } })
  for (const spec of [
    { records: [recordsCsi(code)], modeApplies: false },
    { records: [recordsCsi(code), recordsCsi("?7l")] },
    { records: [recordsCsi(code), recordsCsi(code)] },
    { records: [recordsCsi("?9998h")] },
  ]) {
    expect(definition.lib!(reportingSource(spec)).observation?.outcome, id).not.toBe("unsupported")
  }
})

describe("the unhandled report decides only state cells, and only with both controls", () => {
  test.each([
    ["extensions.osc1-icon", "1"],
    ["extensions.osc9-progress", "9"],
    ["extensions.osc22-pointer", "22"],
    ["extensions.osc777-notify", "777"],
    ["extensions.osc104-reset-palette", "104"],
    ["extensions.osc110-reset-fg", "110"],
    ["extensions.osc111-reset-bg", "111"],
    ["extensions.osc112-reset-cursor", "112"],
    ["extensions.osc113-reset-pointer-fg", "113"],
    ["extensions.osc114-reset-pointer-bg", "114"],
    ["extensions.osc117-reset-highlight-bg", "117"],
    ["extensions.osc119-reset-highlight-fg", "119"],
  ])("a state cell the library reports unhandled becomes Unsupported: %s", (id, code) => {
    const source = reportingSource({ records: [recordsOsc(code)] })
    const result = probe(id).lib!(source)
    expect(result.observation?.outcome).toBe("unsupported")
    expect(JSON.stringify(result)).toContain(REASON)
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

  test("delivery cells outside the report consumer keep their own paths", () => {
    const source = reportingSource({
      records: [recordsOsc("7"), recordsOsc("9"), recordsOsc("633"), recordsOsc("777")],
    })
    for (const id of ["extensions.osc7-cwd", "extensions.notifications", "extensions.osc633-p"]) {
      const result = probe(id).lib!(source)
      expect(JSON.stringify(result)).not.toContain(REASON)
    }
  })

  test("an existing progress reader wins over an unhandled OSC 9 report", () => {
    let progress: { state: number; value: number | null } | null = null
    const source: LibProbeSource = {
      ...reportingSource({ records: [recordsOsc("9")] }),
      getProgress: () => progress,
      feed: (text) => {
        const match = /\x1b\]9;4;(\d+)(?:;(\d+))?\x07/.exec(text)
        if (match) {
          progress = { state: Number(match[1]), value: match[2] === undefined ? null : Number(match[2]) }
        }
      },
    }
    const result = probe("extensions.osc9-progress").lib!(source)
    expect(result.observation?.outcome).toBe("supported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  })
})

describe("the SGR arm moves only the named cells, with SGR 1 as its control", () => {
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
})

/**
 * @failure Case 2 (@cto plan ruling 09:00, R1): on an engine that handles no OSC, the merged arm's OSC 2
 *   control can never qualify, so the engine's own report can never decide an OSC cell. The fallback may
 *   qualify an OSC target with SGR 1 and bold ONLY in the same run that shows the OSC 2 control added
 *   exactly one entry of kind osc code 2 while the title stayed unapplied, and it must read its own
 *   baseline. Any other shape keeps today's TODO.
 *
 * @failure Case 2 R2: sgr.italic (3m) and sgr.faint (2m) are inside the report arm's cell set, and a cell
 *   outside that set is still never decided by the report.
 *
 * @level l2
 * @consumer @si/terminfo/30211-terminfo-273/32369-dec-non-osc-control-consumer
 * @testonly none
 */
describe("an engine that handles no OSC may qualify with a handled non-OSC control", () => {
  /** An engine with no OSC handling: it reports OSC 2 and the target, never sets the title. */
  const decLike = (codes: readonly string[]) =>
    reportingSource({
      records: [recordsOsc("2"), ...codes.map((code) => recordsOsc(code))],
      titleApplies: false,
    })

  test.each([
    ["extensions.osc1-icon", "1"],
    ["extensions.osc9-progress", "9"],
    ["extensions.osc22-pointer", "22"],
    ["extensions.osc133-a", "133"],
    ["extensions.osc133-p", "133"],
    ["extensions.osc633-a", "633"],
    ["extensions.semantic-prompts", "133"],
    ["extensions.osc113-reset-pointer-fg", "113"],
    ["extensions.notifications", "9"],
    ["extensions.osc777-notify", "777"],
  ])("a cell the engine reports unhandled becomes Unsupported: %s", (id, code) => {
    const result = probe(id).lib!(decLike([code]))
    // notifications is a delivery cell and must keep its own path even under the fallback.
    if (id === "extensions.notifications") {
      expect(JSON.stringify(result)).not.toContain(REASON)
      return
    }
    expect(result.observation?.outcome).toBe("unsupported")
    expect(JSON.stringify(result)).toContain(REASON)
  })

  test("the OSC 2 control that stayed unapplied supplies the report entry the target delta rebases on", () => {
    // Without its own baseline read, the OSC 2 entry would make the target delta two and nothing would
    // fire. The positive case above is this assertion's proof; this one names the shape it depends on.
    const source = decLike(["113"])
    const result = probe("extensions.osc113-reset-pointer-fg").lib!(source)
    const parsed = JSON.parse(result.response!) as { unhandled: { control: string } }
    expect(parsed.unhandled.control).toBe("\x1b[0m\x1b[1mC")
  })

  test("an OSC 2 control that adds no entry never reaches the fallback", () => {
    // A handled silent OSC 2 (no entry) proves nothing about the OSC path, so the fallback stays closed.
    const source = reportingSource({ records: [recordsOsc("113")], titleApplies: false })
    const result = probe("extensions.osc113-reset-pointer-fg").lib!(source)
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  })

  test("an OSC 2 control that adds two entries never reaches the fallback", () => {
    const source = reportingSource({
      records: [recordsOsc("2"), recordsOsc("2"), recordsOsc("113")],
      titleApplies: false,
    })
    const result = probe("extensions.osc113-reset-pointer-fg").lib!(source)
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  })

  test("a fallback control whose bold reader never applies leaves the cell undecided", () => {
    const source = reportingSource({
      records: [recordsOsc("2"), recordsOsc("113")],
      titleApplies: false,
      boldApplies: false,
    })
    const result = probe("extensions.osc113-reset-pointer-fg").lib!(source)
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  })

  test("the fallback never qualifies on an engine whose title reader answered", () => {
    // Case 1 by construction: the OSC 2 control qualifies normally, so the fallback is not consulted
    // and an unrecorded target stays undecided.
    const source = reportingSource({ records: [recordsOsc("2")] })
    const result = probe("extensions.osc113-reset-pointer-fg").lib!(source)
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  })
})

describe("the report arm decides italic and faint as well, and nothing outside its set", () => {
  test.each([
    ["sgr.italic", "3m"],
    ["sgr.faint", "2m"],
  ])("%s becomes Unsupported when the library reports %s", (id, code) => {
    const source = reportingSource({ records: [recordsCsi(code)] })
    const result = sgr(id).lib!(source)
    expect(result.observation?.outcome).toBe("unsupported")
    expect(JSON.stringify(result)).toContain(REASON)
  })

  test("an SGR cell outside the eight keeps its own path", () => {
    const source = reportingSource({ records: [recordsCsi("53m"), recordsCsi("1m")] })
    const result = sgr("sgr.overline").lib!(source)
    expect(JSON.stringify(result)).not.toContain(REASON)
  })
})

// Accepted D2 cut plus M-1:44 audited native negatives and the generic OSC22 report.
// The released eleven-cell D2-U1 slice declares only the audited vt100 0.16.2 subject.
// Independent input/code oracles were measured from the real addon before each
// consumer extension; these cases exercise the registered callback boundary.
describe("vt100-rust controlled reports at the ALL_PROBES consumer", () => {
  const identity: HeadlessRuntimeIdentity = {
    kind: "native",
    engineVersion: "0.16.2",
    adapterVersion: "0.10.2",
    termlessRevision: "39f7cd8336b01debdbbe775d1a40900195a7f91e",
    loadedBinary: {
      path: "vendor/termless/packages/vt100-rust/termless-vt100-rust.node",
      sha256: "72855b1d5462ac4c168d6c2f4a6252ab0bbfbd8682bcd68c732521ed1f4e661c",
    },
    provenance: {
      sha256: "72855b1d5462ac4c168d6c2f4a6252ab0bbfbd8682bcd68c732521ed1f4e661c",
      sourceCommit: "3a0bcc0f615cc22d64ea6b756026521d697f0c61",
      buildHash: "1384077ee447681a93471e6ee176b8bbdc4ae172e2f94ab3d7cc1f84a1f674eb",
      toolchain:
        "rustc 1.94.0 (4a4ef493e 2026-03-02) (built from a source tarball); cargo 1.94.0 (85eff7c80 2026-01-15)",
      lockSha256: "4cf037e4efa648ca41d08b30ef5c4ce7ada29ad61fcad45a7d1aa97bf55391c6",
    },
    adapterSources: [
      {
        path: "packages/vt100-rust/src/index.ts",
        blobOid: "3ddb74f3ae1f79bb356952103853232f69211268",
      },
      {
        path: "packages/vt100-rust/src/backend.ts",
        blobOid: "ddabecd4881be4f6b63f1c35f9c2265b53d35df4",
      },
    ],
  }
  const targets = [
    ["cursor.position-report", "\u001b[6n", "csi", "6n"],
    ["device.decrpm", "\u001b[?7$p", "csi", "?$7p"],
    ["device.dsr-996-color-scheme", "\u001b[?996n", "csi", "?996n"],
    ["device.primary-da", "\u001b[c", "csi", "0c"],
    ["device.secondary-da", "\u001b[>c", "csi", ">0c"],
    ["device.status-report", "\u001b[5n", "csi", "5n"],
    ["device.tertiary-da", "\u001b[=c", "csi", "=0c"],
    ["device.xtreportcolors", "\u001b[#R", "csi", "#0R"],
    ["device.xtversion", "\u001b[>0q", "csi", ">0q"],
    ["device.xtwinops-14", "\u001b[14t", "csi", "14t"],
    ["device.xtwinops-16", "\u001b[16t", "csi", "16t"],
    ["device.xtwinops-18", "\u001b[18t", "csi", "18t"],
    ["device.xtwinops-20", "\u001b[20t", "csi", "20t"],
    ["device.xtwinops-21", "\u001b[21t", "csi", "21t"],
    ["editing.decrqcra", "\u001b[1;1;1;1;1;5*y", "csi", "*1;1;1;1;1;5y"],
    ["extensions.sixel-da1", "\u001b[c", "csi", "0c"],
    ["extensions.sixel-geometry-report", "\u001b[?2;1;0S", "csi", "?2;1;0S"],
    ["modes.decsscls", "\u001b[9 p", "csi", " 9p"],
    // M-1 inputs/codes were measured independently on the exact native addon.
    ["modes.alt-scroll-1007", "\u001b[?1007h", "csi", "?1007h"],
    ["modes.color-scheme-reporting", "\u001b[?2031h", "csi", "?2031h"],
    ["modes.decsclm", "\u001b[?4h", "csi", "?4h"],
    ["modes.reverse-video", "\u001b[?5h", "csi", "?5h"],
    ["modes.synchronized-output", "\u001b[?2026h", "csi", "?2026h"],
    ["modes.xtpushcolors", "\u001b[#P", "csi", "#0P"],
    ["modes.xtpopcolors", "\u001b[#Q", "csi", "#0Q"],
    ["modes.xtrestore", "\u001b[?7r", "csi", "?7r"],
    ["modes.xtsave", "\u001b[?7s", "csi", "?7s"],
    ["modes.focus-tracking", "\u001b[?1004h", "csi", "?1004h"],
    ["extensions.osc10-fg-color", "\u001b]10;?\u0007", "osc", "10"],
    ["extensions.osc11-bg-color", "\u001b]11;?\u0007", "osc", "11"],
    ["extensions.osc12-cursor-color", "\u001b]12;?\u0007", "osc", "12"],
    ["extensions.osc1337-capabilities", "\u001b]1337;Capabilities\u0007", "osc", "1337"],
    ["extensions.osc1337-cellsize", "\u001b]1337;ReportCellSize\u0007", "osc", "1337"],
    ["extensions.osc17-highlight-bg", "\u001b]17;?\u0007", "osc", "17"],
    ["extensions.osc19-highlight-fg", "\u001b]19;?\u0007", "osc", "19"],
    ["extensions.osc21-kitty-color", "\u001b]21;foreground=?\u001b\\", "osc", "21"],
    ["extensions.osc4-palette", "\u001b]4;0;?\u0007", "osc", "4"],
    ["extensions.osc5-special-color", "\u001b]5;0;?\u0007", "osc", "5"],
    ["extensions.osc701-locale", "\u001b]701;?\u0007", "osc", "701"],
    ["extensions.osc702-version", "\u001b]702;?\u0007", "osc", "702"],
    ["extensions.osc776-cell-size", "\u001b]776\u0007", "osc", "776"],
    ["extensions.osc7770-font-size", "\u001b]7770;?\u0007", "osc", "7770"],
    ["extensions.osc7777-font-window-size", "\u001b]7777;?\u0007", "osc", "7777"],
    ["extensions.osc99-kitty-notify", "\u001b]99;i=dev4-census:p=?;\u001b\\", "osc", "99"],
    ["extensions.osc9-progress", "\x1b]9;4;1;50\x07", "osc", "9"],
    ["extensions.osc22-pointer", "\x1b]22;pointer\x07", "osc", "22"],
    // NR-A, @cto 947dcd40 slice A.
    ["editing.decsace", "\u001b[2*x", "csi", "*2x"],
    ["extensions.osc5522-clipboard", "\u001b[?5522$p", "csi", "?$5522p"],
    ["extensions.kitty-keyboard", "\u001b[>1u", "csi", ">1u"],
    ["extensions.kitty-keyboard.disambiguate", "\u001b[>1u", "csi", ">1u"],
    ["extensions.kitty-keyboard.report-events", "\u001b[>3u", "csi", ">3u"],
    ["extensions.kitty-keyboard.report-alternate", "\u001b[>5u", "csi", ">5u"],
    ["extensions.kitty-keyboard.report-all-keys", "\u001b[>9u", "csi", ">9u"],
    ["extensions.kitty-keyboard.report-text", "\u001b[>25u", "csi", ">25u"],
    ["input.csi-u", "\u001b[>1u", "csi", ">1u"],
    ["input.pixel-mouse", "\u001b[?1016h", "csi", "?1016h"],
    ["input.kitty-click-events", "\u001b]133;A;click_events=1\u0007", "osc", "133"],
  ] as const
  const declared = [
    "device.decrqss",
    "device.xtgettcap",
    "device.xtgetxres",
    "extensions.kitty-graphics",
    "extensions.kitty-graphics.display",
    "extensions.kitty-graphics.transmit",
  ] as const
  const definition = (id: string) => ALL_PROBES.find((p) => p.id === id)!
  const source = (feed: string, kind: "osc" | "csi", code: string, overrides: Partial<LibProbeSource> = {}) => ({
    ...reportingSource({
      records: [{ match: new RegExp(feed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), code: { kind, code } }],
    }),
    backendName: "vt100-rust",
    runtimeIdentity: identity,
    ...overrides,
  })

  test.each(targets)("%s uses the measured normalized code with both handled controls", (id, feed, kind, code) => {
    const result = definition(id).lib!(source(feed, kind, code))
    expect(result.observation?.outcome).toBe("unsupported")
    expect(JSON.stringify(result)).toContain(REASON)
    if (kind === "csi") {
      expect(JSON.stringify(result)).toContain("CSI " + code)
      expect(JSON.stringify(result)).not.toContain("SGR " + code)
    }
  })

  // The five remaining D2 interface absences declare only this audited 0.16.2 subject.
  // The six app-job OSCs moved to run-derived controls in declared-untestable.test.ts.
  // Negative-only coverage could not prove the declaration or retain its versioned reason.
  test.each(declared)("%s declares Untestable only for the audited vt100 0.16.2 subject", (id) => {
    const lib = definition(id).lib!
    const result = lib({ ...inertLibProbeSource(), backendName: "vt100-rust", runtimeIdentity: identity })
    expect(isDeclaredUntestable(result)).toBe(true)
    expect(JSON.stringify(result)).toContain("vt100 0.16.2")
    expect(result.observation?.outcome).not.toBe("unsupported")
    for (const overrides of [
      { runtimeIdentity: undefined },
      { backendName: "libvterm" },
      { runtimeIdentity: { ...identity, engineVersion: "0.16.3" } },
      { runtimeIdentity: { ...identity, provenance: { ...identity.provenance, lockSha256: "0".repeat(64) } } },
    ]) {
      expect(
        isDeclaredUntestable(
          lib({ ...inertLibProbeSource(), backendName: "vt100-rust", runtimeIdentity: identity, ...overrides }),
        ),
      ).toBe(false)
    }
  })

  // The verdict records buffer_state, which an input_bytes-only declaration would refuse at collection.
  test("kitty-click declares the report's buffer_state beside its own input_bytes", () => {
    const declaration = definition("input.kitty-click-events").libAssertionType
    expect(declaration).toMatchObject({ then: ["input_bytes", "buffer_state"], otherwise: ["input_bytes"] })
  })

  test("failed controls, mismatch, extra entry, missing member and changed identity keep the old path", () => {
    const [id, feed, kind, code] = targets[0]
    const lib = definition(id).lib!
    for (const ctx of [
      source(feed, kind, "other"),
      source(feed, kind, code, { getUnhandledSequences: undefined }),
      source(feed, kind, code, { backendName: "libvterm" }),
      source(feed, kind, code, { runtimeIdentity: { ...identity, engineVersion: "0.16.3" } }),
      source(feed, kind, code, {
        runtimeIdentity: { ...identity, loadedBinary: { ...identity.loadedBinary, sha256: "0".repeat(64) } },
      }),
      source(feed, kind, code, {
        runtimeIdentity: { ...identity, provenance: { ...identity.provenance, sourceCommit: "0".repeat(40) } },
      }),
      source(feed, kind, code, {
        runtimeIdentity: { ...identity, provenance: { ...identity.provenance, lockSha256: "0".repeat(64) } },
      }),
      source(feed, kind, code, {
        runtimeIdentity: {
          ...identity,
          adapterSources: identity.adapterSources?.map((s) => ({ ...s, blobOid: "0".repeat(40) })),
        },
      }),
      {
        ...source(feed, kind, code),
        ...reportingSource({ boldApplies: false, records: [{ match: /\x1b\[6n/, code: { kind, code } }] }),
        backendName: "vt100-rust",
      },
      {
        ...source(feed, kind, code),
        ...reportingSource({
          records: [
            { match: /\x1b\[6n/, code: { kind, code } },
            { match: /\x1b\[6n/, code: { kind, code } },
          ],
        }),
        backendName: "vt100-rust",
      },
    ]) {
      const result = lib(ctx)
      expect(result.observation?.outcome).not.toBe("unsupported")
      expect(JSON.stringify(result)).not.toContain(REASON)
    }
  })

  test("a decided reply survives the report and reader-owned OSC cells stay outside declarations", () => {
    const target = source("\x1b[6n", "csi", "6n", {
      feedCapture: () => "\x1b[3;5R",
      getCursor: () => ({ x: 4, y: 2, visible: true, style: null }),
    })
    expect(definition("cursor.position-report").lib!(target).observation?.outcome).toBe("supported")
    for (const id of ["extensions.osc22-pointer", "extensions.osc52-read"]) {
      const result = definition(id).lib!(target)
      expect(isDeclaredUntestable(result)).toBe(false)
      expect(JSON.stringify(result)).not.toContain(REASON)
    }
  })
})

describe("vterm 0.13.1 D2 nine-cell interface-absence declarations", () => {
  const sourceIntegrity = {
    kind: "source" as const,
    revision: "7b39f49e8a6bc03ce695c5ab7c143c2cc7379eb0",
    treeOid: "3d58d29a8265aafd928e0736dde6723e2bac2007",
    cleanTree: true,
    repository: "git@github.com:beorn/vterm.git",
  }
  const identity: HeadlessRuntimeIdentity = {
    kind: "js",
    runtimeFormat: "js",
    adapterVersion: "0.10.2",
    termlessRevision: "ce3e783b6536df0cc4e0a11d4567f1cdd96bafee",
    engineVersion: "0.13.1",
    resolvedPath: "vendor/vterm/packages/vterm/src/index.ts",
    integrity: sourceIntegrity,
  }
  const declared = [
    "modes.decsscls",
    "extensions.osc22-pointer",
    "extensions.osc9-progress",
    "extensions.osc133-d",
    "extensions.osc633-d",
    "extensions.osc633-e",
    "extensions.semantic-prompts",
    "extensions.osc-633-vscode",
    "input.kitty-click-events",
  ] as const
  const shellDeclared = new Set([
    "extensions.osc133-d",
    "extensions.osc633-d",
    "extensions.osc633-e",
    "extensions.semantic-prompts",
    "extensions.osc-633-vscode",
  ])
  const definition = (id: string) => ALL_PROBES.find((p) => p.id === id)!
  const vtermSource = (overrides: Partial<LibProbeSource> = {}): LibProbeSource => {
    const base = inertLibProbeSource()
    return {
      ...base,
      backendName: "vterm",
      runtimeIdentity: identity,
      getSemanticMarks: () => [{ type: "prompt", startRow: 0, startCol: 0 }],
      capabilities: {
        ...base.capabilities,
        semanticPrompts: true,
        extensions: new Set(["semantic-marks"]),
      },
      ...overrides,
    }
  }

  test.each(declared)("%s declares Untestable only for the audited vterm 0.13.1 subject", (id) => {
    const lib = definition(id).lib!
    const result = lib(vtermSource())
    expect(isDeclaredUntestable(result)).toBe(true)
    expect(JSON.stringify(result)).toContain("vterm.js 0.13.1")
    if (shellDeclared.has(id)) {
      expect(JSON.stringify(result)).toContain("generic parser tap")
    }
    if (id === "extensions.osc9-progress") {
      expect(JSON.stringify(result)).toContain("tapParser")
    }
    if (id === "input.kitty-click-events") {
      expect(JSON.stringify(result)).toContain("Termless")
    }
    expect(result.observation?.outcome).not.toBe("unsupported")
    for (const overrides of [
      { runtimeIdentity: undefined },
      { backendName: "libvterm" },
      { runtimeIdentity: { ...identity, engineVersion: "0.13.0" } },
      {
        runtimeIdentity: {
          ...identity,
          integrity: { ...sourceIntegrity, treeOid: "d0e3d3fe4e893b70bd3f7d95725b4e10c1f6d99d" },
        },
      },
      {
        runtimeIdentity: {
          ...identity,
          integrity: { ...sourceIntegrity, cleanTree: false },
        },
      },
      {
        runtimeIdentity: {
          ...identity,
          integrity: { ...sourceIntegrity, repository: "https://example.invalid/vterm.git" },
        },
      },
      {
        runtimeIdentity: {
          ...identity,
          integrity: { kind: "registry" as const, lockIntegrity: "unreviewed" as const },
        },
      },
    ]) {
      expect(isDeclaredUntestable(lib(vtermSource(overrides)))).toBe(false)
    }
  })

  test("command-end capability, unhandled-sequence report and decided outcomes take precedence", () => {
    const base = vtermSource()
    for (const id of declared) {
      const lib = definition(id).lib!
      expect(
        isDeclaredUntestable(
          lib(
            vtermSource({
              capabilities: {
                ...base.capabilities,
                extensions: new Set(["semantic-marks", "semantic-command-end"]),
              },
            }),
          ),
        ),
      ).toBe(false)
      expect(isDeclaredUntestable(lib(vtermSource({ getUnhandledSequences: () => [] })))).toBe(false)
    }
    let leaked = false
    const leakedDecsscls = definition("modes.decsscls").lib!(
      vtermSource({
        feed: (input) => {
          if (input === "\x1b[9 pQ") leaked = true
        },
        getText: () => (leaked ? "9 pQ" : ""),
        getCursor: () => ({ x: leaked ? 4 : 0, y: 0, visible: true, style: null }),
      }),
    )
    expect(isDeclaredUntestable(leakedDecsscls)).toBe(false)
    expect(leakedDecsscls.observation?.outcome).toBe("unsupported")
  })

  // The six pass-through OSCs are now declared separately in declared-untestable.test.ts.
  test("OSC 133 start marks and default osc-absence probes stay outside vterm-d2", () => {
    for (const id of [
      "extensions.osc133-a",
      "extensions.osc133-b",
      "extensions.osc133-c",
      "extensions.osc133-p",
      "extensions.osc7-cwd",
      "extensions.notifications",
    ]) {
      expect(isDeclaredUntestable(definition(id).lib!(vtermSource()))).toBe(false)
    }
  })
})

// The Ghostty source census declares semantic absence, not parser recognition.
// Existing vterm/Alacritty cases do not cover its native source-and-lock cohort.
describe("Ghostty native 1.3.1 D2 six-cell interface-absence declarations", () => {
  const identity: HeadlessRuntimeIdentity = {
    kind: "native",
    engineVersion: "1.3.1",
    adapterVersion: "0.10.2",
    termlessRevision: "f540232e22ba0ccb4005dba5ba2d8de10cb129c5",
    loadedBinary: {
      path: "vendor/termless/packages/ghostty-native/termless-ghostty-native.node",
      sha256: "263e32f284d2399fda5e99df5bea125ed6248979516d309b15f3fd7dbbe836dd",
    },
    provenance: {
      sha256: "263e32f284d2399fda5e99df5bea125ed6248979516d309b15f3fd7dbbe836dd",
      sourceCommit: "332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28",
      buildHash: "a4404e07f3746b45a9a813fd0cda0aa4156e5753b75f1ecda66722abd4d68d1a",
      toolchain: "zig 0.15.2",
      lockSha256: "3ec775507556db01d08055836b26183f629a9cbb0b5802a1566661e95988d74a",
    },
  }
  const declared = [
    "extensions.osc1-icon",
    "extensions.osc113-reset-pointer-fg",
    "extensions.osc114-reset-pointer-bg",
    "extensions.osc117-reset-highlight-bg",
    "extensions.osc119-reset-highlight-fg",
    "modes.decsscls",
  ] as const
  const definition = (id: string) => ALL_PROBES.find((entry) => entry.id === id)!
  const nativeSource = (overrides: Partial<LibProbeSource> = {}): LibProbeSource => ({
    ...inertLibProbeSource(),
    backendName: "ghostty-native",
    runtimeIdentity: identity,
    ...overrides,
  })

  test.each(declared)("%s declares only at the audited native source and lock", (id) => {
    const lib = definition(id).lib!
    const result = lib(nativeSource())
    expect(isDeclaredUntestable(result)).toBe(true)
    expect(JSON.stringify(result)).toContain("Ghostty 1.3.1")
    expect(result.observation?.outcome).not.toBe("unsupported")
    for (const overrides of [
      { runtimeIdentity: undefined },
      { backendName: "ghostty" },
      { runtimeIdentity: { ...identity, engineVersion: "1.3.2" } },
      { runtimeIdentity: { ...identity, provenance: { ...identity.provenance, sourceCommit: "0".repeat(40) } } },
      { runtimeIdentity: { ...identity, provenance: { ...identity.provenance, lockSha256: "0".repeat(64) } } },
    ]) {
      expect(isDeclaredUntestable(lib(nativeSource(overrides)))).toBe(false)
    }
    // Addon builds and adapter sources do not change this audited library absence.
    expect(
      isDeclaredUntestable(
        lib(
          nativeSource({
            runtimeIdentity: {
              ...identity,
              loadedBinary: { ...identity.loadedBinary, sha256: "1".repeat(64) },
              provenance: { ...identity.provenance, sha256: "1".repeat(64), buildHash: "2".repeat(64) },
              adapterSources: [{ path: "packages/ghostty-native/src/backend.ts", blobOid: "3".repeat(40) }],
            },
          }),
        ),
      ),
    ).toBe(true)
    expect(isDeclaredUntestable(lib(nativeSource({ getUnhandledSequences: () => [] })))).toBe(false)
  })

  test("an icon reader and a decided scroll-speed parser outcome retain their measured paths", () => {
    expect(
      isDeclaredUntestable(definition("extensions.osc1-icon").lib!(nativeSource({ getIconLabel: () => "" }))),
    ).toBe(false)
    let leaked = false
    const result = definition("modes.decsscls").lib!(
      nativeSource({
        feed: (input) => {
          if (input === "\x1b[9 pQ") leaked = true
        },
        getText: () => (leaked ? "9 pQ" : ""),
        getCursor: () => ({ x: leaked ? 4 : 0, y: 0, visible: true, style: null }),
      }),
    )
    expect(isDeclaredUntestable(result)).toBe(false)
    expect(result.observation?.outcome).toBe("unsupported")
  })

  test("R3 readers and unaudited host effects remain outside native D2 declarations", () => {
    for (const id of [
      "extensions.osc22-pointer",
      "extensions.osc176-app-id",
      "extensions.osc3008-context",
      "extensions.osc440-audio",
      "extensions.osc555-flash",
      "extensions.osc666-termprop",
      "extensions.osc710-font-normal",
      "extensions.osc133-a",
      "extensions.osc133-d",
      "extensions.semantic-prompts",
    ]) {
      expect(isDeclaredUntestable(definition(id).lib!(nativeSource()))).toBe(false)
    }
  })
})
