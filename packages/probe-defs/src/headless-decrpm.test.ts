/**
 * @failure A DECRQM mode feature's headless arm grades without the engine's own DECRPM reply, reads that reply with a second parser, or counts the adapter's getMode value as evidence.
 * @level l2
 * @consumer Headless capture rows for the seven DECRQM mode features (#30543, @cto ruling b5987212).
 * @reach Runs each registry definition's termless callback against a scripted context, and the shared parser directly.
 * @testonly none
 */
import { expect, test } from "vitest"
import { decrpmPs, decrpmReplyPattern, decrpmStatus } from "./helpers.ts"
import { modesProbes } from "./modes.ts"
import { inputProbes } from "./input.ts"
import type { LibProbeSource } from "./types.ts"

const readbackModes = [
  { id: "modes.alt-scroll-1007", number: 1007, mode: "altScroll" },
  { id: "modes.synchronized-output", number: 2026, mode: "syncOutput" },
  { id: "modes.color-scheme-reporting", number: 2031, mode: "colorSchemeReporting" },
  { id: "modes.decsclm", number: 4, mode: "smoothScroll" },
  { id: "modes.reverse-video", number: 5, mode: "reverseVideo" },
] as const

function readbackContext(
  number: number,
  options: {
    setPs?: number
    resetPs?: number
    setMode?: boolean | null
    resetMode?: boolean | null
    conflatesInsert?: boolean
    insertBefore?: boolean | null
    insertAfter?: boolean | null
  } = {},
) {
  let enabled = false
  const queries: string[] = []
  const reads: string[] = []
  const writes: string[] = []
  const source = {
    ...context("", false, [], []),
    backendName: "scripted-engine",
    feed(text: string) {
      writes.push(text)
      if (text === `\x1b[?${number}h` || text === "\x1b=") enabled = true
      if (text === `\x1b[?${number}l` || text === "\x1b>") enabled = false
    },
    feedCapture(text: string) {
      queries.push(text)
      const ps = enabled ? (options.setPs ?? 1) : (options.resetPs ?? 2)
      return `\x1b[?${number};${ps}$y`
    },
    getMode(mode: string) {
      reads.push(mode)
      if (mode === "insertMode") {
        const value = enabled ? options.insertAfter : options.insertBefore
        return value === undefined ? options.conflatesInsert === true && enabled : value
      }
      return enabled
        ? options.setMode === undefined
          ? true
          : options.setMode
        : options.resetMode === undefined
          ? false
          : options.resetMode
    },
  } as LibProbeSource
  return { source, queries, reads, writes }
}

// @failure DECNKM mode66 produces false negatives for the catalogue's ESC=/ESC> DECKPAM feature.
test("application keypad measures DECKPAM state without a DECRQM query", () => {
  const { source, queries, writes } = readbackContext(66, { setPs: 0 })
  const result = headless("modes.application-keypad")(source) as ReturnType<
    NonNullable<(typeof modesProbes)[number]["lib"]>
  >
  expect(writes).toEqual(["\x1b=", "\x1b>"])
  expect(queries).toEqual([])
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  expect(result.assertions).toEqual([expect.objectContaining({ kind: "positive", observed: result.response })])
  expect(result.note).toContain("keypad key encoding unmeasured; mode state measured")
})

// @failure A missing DECKPAM readback is misclassified as engine absence.
test.each([
  { setMode: null, resetMode: false },
  { setMode: true, resetMode: null },
])("application keypad null reader stays named TODO: %j", (options) => {
  const { source } = readbackContext(66, options)
  const result = headless("modes.application-keypad")(source) as ReturnType<
    NonNullable<(typeof modesProbes)[number]["lib"]>
  >
  expect(result.tests).toEqual([
    { id: "criterion", status: "test-todo", reason: "adapter binding scripted-engine applicationKeypad" },
  ])
  expect(result.assertions ?? []).toEqual([])
})

// @failure A DECKPAM reader's unchanged non-null state is incorrectly graded Unsupported.
test("application keypad inconsistent non-null pair stays criterion TODO", () => {
  const { source } = readbackContext(66, { setMode: false, resetMode: true })
  const result = headless("modes.application-keypad")(source) as ReturnType<
    NonNullable<(typeof modesProbes)[number]["lib"]>
  >
  expect(result.tests).toEqual([
    { id: "criterion", status: "test-todo", reason: "DECKPAM state pair: set false, reset true" },
  ])
  expect(result.assertions ?? []).toEqual([])
})

// @failure Private4 is called Supported when the independent IRM conflation check could not run.
test.each([{ insertBefore: null }, { insertAfter: null }])("private4 requires both IRM readings: %j", (options) => {
  const { source } = readbackContext(4, options)
  const result = headless("modes.decsclm")(source) as ReturnType<NonNullable<(typeof modesProbes)[number]["lib"]>>
  expect(result.tests).toEqual([
    { id: "criterion", status: "test-todo", reason: "adapter binding scripted-engine insertMode" },
  ])
  expect(result.assertions ?? []).toEqual([])
})

// @failure An S8 library cell is supported without both reply polarities and agreeing adapter reads.
// @consumer The six registered mode library callbacks; the legacy seven-definition table below stays unchanged.
test.each(readbackModes)("$id requires the set/reset reply and reader pair", ({ id, number, mode }) => {
  const { source, queries, reads } = readbackContext(number)
  const result = headless(id)(source) as ReturnType<NonNullable<(typeof modesProbes)[number]["lib"]>>
  expect(result.observation?.outcome).toBe("supported")
  if (number === 1007) expect(result.note).toContain("wheel-to-cursor-key translation unmeasured; protocol measured")
  expect(queries).toEqual([`\x1b[?${number}$p`, `\x1b[?${number}$p`])
  expect(reads.filter((key) => key === mode)).toHaveLength(2)
})

// @failure A positive engine roundtrip hides a null or disagreeing adapter binding as support or engine absence.
test.each([
  { setMode: null, resetMode: false },
  { setMode: true, resetMode: null },
  { setMode: false, resetMode: false },
  { setMode: true, resetMode: true },
])("a missing or disagreeing reader remains the named adapter TODO: %j", (options) => {
  const { source } = readbackContext(2026, options)
  const result = headless("modes.synchronized-output")(source) as ReturnType<
    NonNullable<(typeof modesProbes)[number]["lib"]>
  >
  expect(result.tests).toMatchObject([
    { id: "criterion", status: "test-todo", reason: "adapter binding scripted-engine syncOutput" },
  ])
  expect(result.observation?.outcome).toBe("inconclusive")
  expect(result.assertions ?? []).toEqual([])
})

// @failure An engine's explicit negative after DECSET is confused with an unavailable adapter reader.
test.each([0, 2, 4])("strict mode Ps%s after set is an engine negative even without a reader", (setPs) => {
  const { source } = readbackContext(2026, { setPs, setMode: null, resetMode: null })
  const result = headless("modes.synchronized-output")(source) as ReturnType<
    NonNullable<(typeof modesProbes)[number]["lib"]>
  >
  expect(result.observation?.outcome).toBe("unsupported")
  expect(result.assertions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "negative" })]))
})

// @failure A reset that never takes effect is called supported from its earlier enabled reply.
test("strict support needs Ps2 after reset, not a permanently-set reply", () => {
  const { source } = readbackContext(2026, { resetPs: 3 })
  const result = headless("modes.synchronized-output")(source) as ReturnType<
    NonNullable<(typeof modesProbes)[number]["lib"]>
  >
  expect(result.observation?.outcome).toBe("inconclusive")
  expect(result.tests).toEqual(expect.arrayContaining([expect.objectContaining({ status: "test-todo" })]))
})

// @failure DEC-private4 mutates ANSI insertMode yet a positive DECRPM reply still establishes smooth-scroll support.
test("private4/IRM conflation is an engine negative independently of DECRPM", () => {
  const { source } = readbackContext(4, { conflatesInsert: true })
  const result = headless("modes.decsclm")(source) as ReturnType<NonNullable<(typeof modesProbes)[number]["lib"]>>
  expect(result.observation?.outcome).toBe("unsupported")
  expect(JSON.stringify(result)).toContain("insertMode")
  expect(JSON.stringify(result)).toContain("32002")
})

const features = [
  { id: "modes.bracketed-paste", number: 2004, mode: "bracketedPaste" },
  { id: "modes.application-cursor", number: 1, mode: "applicationCursor" },
  { id: "modes.mouse-tracking", number: 1000, mode: "mouseTracking" },
  { id: "modes.focus-tracking", number: 1004, mode: "focusTracking" },
  { id: "modes.mouse-sgr", number: 1006, mode: "sgrMouse" },
  { id: "modes.mouse-all", number: 1003, mode: "mouseTracking" },
  { id: "modes.utf8-mouse-1005", number: 1005, mode: null },
] as const

function headless(id: string): NonNullable<LibProbeSource extends infer _ ? (ctx: LibProbeSource) => unknown : never> {
  const definition = modesProbes.find((probe) => probe.id === id)
  if (!definition?.lib) throw new Error(`Missing headless callback for ${id}`)
  return definition.lib
}

function context(reply: string, mode: boolean, fed: string[], captured: string[]): LibProbeSource {
  return {
    cols: 80,
    rows: 24,
    capabilities: {},
    feed: (text: string) => {
      fed.push(text)
    },
    feedCapture: (text: string) => {
      captured.push(text)
      return reply
    },
    getMode: () => mode,
    getText: () => "",
    getTitle: () => "",
    getCell: () => ({ char: " " }),
    getCursor: () => ({ x: 0, y: 0, visible: true, style: null }),
    getScrollback: () => ({ viewportOffset: 0, totalLines: 24, screenLines: 24 }),
    reset: () => {},
  } as unknown as LibProbeSource
}

const expectedState = (reply: string, mode: string | null) => (mode === null ? { reply } : { reply, mode: true })

test.each(features)("$id grades the engine's DECRPM reply exactly as the app arm does", ({ id, number, mode }) => {
  const arm = headless(id)
  for (const [ps, state] of [
    ["1", "set (Ps 1)"],
    ["2", "reset (Ps 2)"],
    ["3", "permanently set (Ps 3)"],
  ] as const) {
    const fed: string[] = []
    const captured: string[] = []
    const reply = `\x1b[?${number};${ps}$y`
    const result = arm(context(reply, true, fed, captured)) as ReturnType<
      NonNullable<(typeof modesProbes)[number]["lib"]>
    >
    expect(captured, `${id}: Ps ${ps}`).toEqual([`\x1b[?${number}$p`])
    expect(fed, `${id}: Ps ${ps}`).toEqual([`\x1b[?${number}h`, `\x1b[?${number}l`])
    expect(result.pass, `${id}: Ps ${ps}`).toBe(true)
    expect(result.observation, `${id}: Ps ${ps}`).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
    expect(result.assertions, `${id}: Ps ${ps}`).toMatchObject([{ kind: "positive", observed: state }])
    expect(result.criterionBranch, `${id}: Ps ${ps}`).toBeUndefined()
    expect(result.notTested, `${id}: Ps ${ps}`).toBeUndefined()
    expect(JSON.parse(result.response!), `${id}: Ps ${ps}`).toEqual(expectedState(reply, mode))
  }
  // Ps 0 answers the query but not the mode: inconclusive, no assertion, the app arm's own reading.
  const zero = arm(context(`\x1b[?${number};0$y`, false, [], [])) as ReturnType<
    NonNullable<(typeof modesProbes)[number]["lib"]>
  >
  expect(zero.pass, id).toBe(false)
  expect(zero.observation, id).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    assertionType: "query_reply",
  })
  expect(zero.assertions, id).toBeUndefined()
  expect(zero.criterionBranch, id).toBeUndefined()
  // Ps 4: the terminal knows the mode and says it cannot be set. Unsupported, never a folded "reset" (#30557).
  const fourReply = `\x1b[?${number};4$y`
  const four = arm(context(fourReply, true, [], [])) as ReturnType<NonNullable<(typeof modesProbes)[number]["lib"]>>
  expect(four.pass, id).toBe(false)
  expect(four.observation, id).toMatchObject({ outcome: "unsupported", assertionType: "query_reply" })
  expect(four.assertions, id).toMatchObject([
    { kind: "negative", expected: `DECRPM mode ${number} can be set`, observed: "permanently reset (Ps 4)" },
  ])
  expect(four.criterionBranch, id).toBeUndefined()
  expect(four.notTested, id).toBeUndefined()
  expect(JSON.parse(four.response!), id).toEqual(expectedState(fourReply, mode))
})

test.each(features)(
  "$id routes a missing or foreign DECRPM reply to review, keeping getMode as context only",
  ({ id, number, mode }) => {
    const arm = headless(id)
    for (const reply of ["", "\x1b[?25;1$y\x1b[?6c", `\x1b[?${number === 1 ? 2004 : 1};1$y`]) {
      const result = arm(context(reply, true, [], [])) as ReturnType<NonNullable<(typeof modesProbes)[number]["lib"]>>
      const label = `${id}: ${JSON.stringify(reply)}`
      expect(result.criterionBranch, label).toBe("os-input-review")
      expect(result.notTested, label).toEqual({
        reason: "no-semantic-observable",
        noObservable: expect.stringContaining(`CSI ? ${number} $ p`),
      })
      expect(result.tests, label).toMatchObject([
        { id: "review", status: "test-todo", reason: expect.stringMatching(/no DECRPM reply/) },
      ])
      expect(result.observation, label).toBeUndefined()
      expect(result.assertions, label).toBeUndefined()
      expect(JSON.parse(result.response!), label).toEqual(expectedState(reply, mode))
    }
  },
)

test.each(features.filter((feature) => feature.mode !== null))(
  "$id reads the adapter's mode before the DECRQM query, which vt100 parses as a reset",
  ({ id, number }) => {
    const order: string[] = []
    const base = context(`\x1b[?${number};1$y`, true, [], [])
    const probe = {
      ...base,
      feedCapture: (text: string) => {
        order.push("query")
        return base.feedCapture(text)
      },
      getMode: () => {
        order.push("getMode")
        return true
      },
    } as unknown as LibProbeSource
    headless(id)(probe)
    expect(order, id).toEqual(["getMode", "query"])
  },
)

test("one DECRPM reading serves the app query, the ANSI query and the headless arm", () => {
  expect(["0", "1", "2", "3", "4"].map((ps) => decrpmPs(ps))).toEqual([0, 1, 2, 3, 4])
  expect(decrpmPs("7")).toBeNull()
  expect(decrpmPs("")).toBeNull()
  expect(decrpmPs(undefined)).toBeNull()
  // The fold for consumers that only ask whether the mode is on; no grader reads it (#30557).
  expect(decrpmStatus("1")).toBe("set")
  expect(decrpmStatus("3")).toBe("set")
  expect(decrpmStatus("2")).toBe("reset")
  expect(decrpmStatus("4")).toBe("reset")
  expect(decrpmStatus("0")).toBe("unknown")
  expect(decrpmStatus("7")).toBeNull()
  expect(decrpmStatus("")).toBeNull()
  expect(decrpmStatus(undefined)).toBeNull()
  expect(decrpmReplyPattern(2004).exec("\x1b[?2004;1$y")?.[1]).toBe("1")
  expect(decrpmReplyPattern(2004).test("\x1b[2004;1$y")).toBe(false)
  expect(decrpmReplyPattern(1).test("\x1b[?1000;1$y")).toBe(false)
  expect(decrpmReplyPattern(4, "ansi").exec("\x1b[4;2$y")?.[1]).toBe("2")
  expect(decrpmReplyPattern(4, "ansi").test("\x1b[?4;2$y")).toBe(false)
})

// #32099: existing reply cases omit runtimeIdentity and miss source-audit overrides.
// Independent source fixtures from pass-3XQsvM, rekeyed to 0.10.1 after proving both parsers unchanged,
// then rekeyed to parser repair9e99e4d2 (VT100 b941dae4 / VT2204205f893). The adapter
// blobs stay as captured: they are not consulted by the mode source key.
// These are qualifier inputs, not an attestation that the historical run loaded the newer package.
const capturedModeEngines = [
  {
    engine: "vt100",
    identity: {
      kind: "js",
      adapterVersion: "0.10.2",
      termlessRevision: "8be31bfc35c0359e39a836b1d397f49e7176c97f",
      resolvedPath: "vendor/vterm/packages/vt100/src/index.ts",
      integrity: {
        kind: "source",
        repository: "git@github.com:beorn/vterm.git",
        revision: "9e99e4d23cdc606fca258b1863aa2be7ae79eed3",
        treeOid: "b941dae48b25ae8825c394750bda5245c9d93dfa",
        cleanTree: true,
      },
      runtimeFormat: "js",
      engineVersion: "0.10.1",
      adapterSources: [
        {
          path: "packages/vt100/src/index.ts",
          blobOid: "99833d737402f9d1d8e3e257e3a255d8aa1facc3",
        },
        {
          path: "packages/vt100/src/backend.ts",
          blobOid: "cdb8be8c5ebbba68a5920cfa4df27c9deb31745a",
        },
      ],
    },
  },
  {
    engine: "vt220",
    identity: {
      kind: "js",
      adapterVersion: "0.10.2",
      termlessRevision: "8be31bfc35c0359e39a836b1d397f49e7176c97f",
      resolvedPath: "vendor/vterm/packages/vt220/src/index.ts",
      integrity: {
        kind: "source",
        repository: "git@github.com:beorn/vterm.git",
        revision: "9e99e4d23cdc606fca258b1863aa2be7ae79eed3",
        treeOid: "4205f8936ad1848d1029729f3ada888cd61759a8",
        cleanTree: true,
      },
      runtimeFormat: "js",
      engineVersion: "0.10.1",
      adapterSources: [
        {
          path: "packages/vt220/src/index.ts",
          blobOid: "601dd26eb7e753a5396ebdf72f1ef8ee2cc4355f",
        },
        {
          path: "packages/vt220/src/backend.ts",
          blobOid: "7369e3710e36aa649372fd09011ecfdd6ba47c73",
        },
      ],
    },
  },
] satisfies { engine: string; identity: NonNullable<LibProbeSource["runtimeIdentity"]> }[]

function capturedModeContext(identity: LibProbeSource["runtimeIdentity"], behavior = "consume", reply = "") {
  let x = 0
  let y = 0
  let markers = 0
  const lines: string[][] = Array.from({ length: 24 }, () => [])
  const fed: string[] = []
  const modes = new Map<string, boolean>()
  function render(char: string) {
    if (char === "X") {
      markers++
      if (behavior === "missing-first-X" && markers === 1) return
      if (behavior === "missing-last-X" && markers === 2) return
      if (behavior === "moved-line" && markers === 2) {
        y++
        x = 0
      }
    }
    lines[y]![x++] = char
  }
  function feed(text: string) {
    fed.push(text)
    for (const token of text.match(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b[=>]|[^\x1b]/g) ?? []) {
      if (token === "\x1b[2J") {
        for (const line of lines) line.length = 0
        markers = 0
      } else if (/^\x1b\[(?:1;1)?H$/.test(token)) {
        x = 0
        y = 0
      } else if (token === "\x1b[2K") lines[y]!.length = 0
      else if (token.startsWith("\x1b")) {
        const mode = /^\x1b\[\?(\d+)([hl])$/.exec(token)
        if (mode) modes.set(mode[1]!, mode[2] === "h")
        if (token === "\x1b=") modes.set("66", true)
        if (token === "\x1b>") modes.set("66", false)
        if (behavior === "leak" && markers === 1) for (const char of token.slice(1)) render(char)
      } else render(token)
    }
  }
  const source = {
    ...context(reply, false, [], []),
    runtimeIdentity: identity,
    feed,
    getMode: (name: string) =>
      modes.get(
        ({ applicationCursor: "1", reverseVideo: "5", applicationKeypad: "66" } as Record<string, string>)[name] ??
          name,
      ) ?? false,
    getCell: (row: number, col: number) => ({ char: lines[row]?.[col] ?? " " }),
    getText: () =>
      lines
        .map((line) => line.join(""))
        .join("\n")
        .trimEnd(),
    getCursor: () => ({ x, y, visible: true, style: null }),
  } as unknown as LibProbeSource
  return { source, fed, line: () => lines[0]!.join(""), position: () => ({ x, y }) }
}

// CTO45a/M5: input observer absence cannot hide these pinned engines own absent mouse modes.
// Existing mode rows never execute the six input callbacks; existing source/adapter fallback tests stay unchanged.
const mouseSourceCases = [
  ["input.pixel-mouse", 1016],
  ["input.urxvt-mouse", 1015],
  ["input.x10-mouse", 9],
  ["input.button-event-mouse", 1002],
  ["input.xtest-click", 1000],
  ["input.xtest-wheel", 1000],
] as const

test.each(
  capturedModeEngines.flatMap(({ engine, identity }) =>
    mouseSourceCases.map(([id, mode]) => ({ engine, identity, id, mode })),
  ),
)("$engine $id requires source review of its absent own mouse mode", ({ identity, id, mode }) => {
  const fixture = capturedModeContext(identity)
  const source = { ...fixture.source, capabilities: { ...fixture.source.capabilities, extensions: new Set<string>() } }
  const result = inputProbes.find((entry) => entry.id === id)!.lib!(source)
  expect(fixture.fed).toContain(`\x1b[?${mode}h`)
  expect(fixture.fed).toContain(`\x1b[?${mode}l`)
  expect(fixture.line()).toBe("XX")
  expect(result.pass).toBe(false)
  expect(result.criterionBranch).toBe("source-negative-review")
  expect(result.observation).toMatchObject({ outcome: "inconclusive", assertionType: "buffer_state" })
  expect(result.assertions).toMatchObject([{ kind: "negative", assertionType: "buffer_state" }])
  expect(result.tests).toMatchObject([{ status: "test-todo" }])
  expect(JSON.parse(result.response!)).toMatchObject({ line: "XX", control: "consumed-without-effect" })
})

test.each(capturedModeEngines)("$engine held modes retain named TODOs", ({ engine, identity }) => {
  for (const [id, held] of [
    ["modes.application-cursor", "1"],
    ...(engine === "vt100" ? [["modes.reverse-video", "5"]] : []),
  ]) {
    const result = headless(id!)(capturedModeContext(identity).source) as ModeResult
    expect.soft(result.tests, id).toEqual(expect.arrayContaining([expect.objectContaining({ status: "test-todo" })]))
    expect.soft(result.observation, id).toBeUndefined()
    expect.soft(result.assertions, id).toBeUndefined()
    expect.soft(JSON.stringify(result), id).toMatch(new RegExp(`held.*${held}|${held}.*held`, "i"))
    if (held === "1") {
      expect.soft(JSON.parse(result.response!), id).toMatchObject({ mode: true })
    }
  }
})

type ModeResult = ReturnType<NonNullable<(typeof modesProbes)[number]["lib"]>>
const absentCommands = [
  ...features
    .filter(({ number }) => number !== 1)
    .map(({ id, number }) => ({ id, commands: [`\x1b[?${number}h`, `\x1b[?${number}l`], own: String(number) })),
  { id: "modes.alt-scroll-1007", commands: ["\x1b[?1007h", "\x1b[?1007l"], own: "1007" },
  { id: "modes.synchronized-output", commands: ["\x1b[?2026h", "\x1b[?2026l"], own: "2026" },
  { id: "modes.color-scheme-reporting", commands: ["\x1b[?2031h", "\x1b[?2031l"], own: "2031" },
  ...["modes.xtpushsgr", "modes.xtpopsgr"].map((id) => ({ id, commands: ["\x1b[#{", "\x1b[#}"], own: "SGR" })),
  ...["modes.xtpushcolors", "modes.xtpopcolors"].map((id) => ({ id, commands: ["\x1b[#P", "\x1b[#Q"], own: "color" })),
]

test.each(capturedModeEngines)(
  "$engine absent commands use source review with consumed and leaked controls",
  ({ engine, identity }) => {
    for (const { id, commands, own } of absentCommands) {
      for (const behavior of ["consume", "leak"]) {
        const fixture = capturedModeContext(identity, behavior)
        const result = headless(id)(fixture.source) as ModeResult
        for (const command of commands) expect.soft(fixture.fed.join(""), id).toContain(command)
        expect.soft(fixture.fed.join(""), id).toContain("\x1b[2J\x1b[1;1H")
        if (behavior === "consume") expect.soft(fixture.line(), id).toBe("XX")
        else expect.soft(fixture.line(), id).toMatch(/^X.+X$/)
        expect.soft(result.criterionBranch, id).toBe("source-negative-review")
        expect.soft(result.observation, id).toMatchObject({ outcome: "inconclusive", assertionType: "buffer_state" })
        expect.soft(result.assertions, id).toMatchObject([{ kind: "negative", assertionType: "buffer_state" }])
        expect
          .soft(result.tests, id)
          .toEqual(expect.arrayContaining([expect.objectContaining({ status: "test-todo" })]))
        // Own DECSET/DECRST absence, not rejection of the separate query opcode.
        const state = JSON.parse(result.response!)
        expect.soft(state, id).toMatchObject({
          line: fixture.line(),
          position: fixture.position(),
          control: behavior === "consume" ? "consumed-without-effect" : "leaked-as-text",
        })
        const reason = JSON.stringify([result.observation, result.assertions, result.tests, state])
        expect.soft(reason, id).toContain(`packages/${engine}/src/screen.ts`)
        expect.soft(reason.toLowerCase(), id).toContain(own.toLowerCase())
        const definition = modesProbes.find((probe) => probe.id === id)!
        expect.soft([undefined, "buffer_state"], id).toContain(definition.libAssertionType)
      }
    }
  },
)

test.each(capturedModeEngines)(
  "$engine source-negative mode review requires X and matching source/adapter",
  ({ identity }) => {
    const altered = [
      undefined,
      { ...identity, resolvedPath: "vendor/vterm/packages/vterm/src/index.ts" },
      { ...identity, integrity: { ...identity.integrity, cleanTree: false } },
      { ...identity, integrity: { ...identity.integrity, treeOid: "0".repeat(40) } },
      { ...identity, adapterSources: [] },
      { ...identity, engineVersion: "foreign" },
    ]
    for (const { id } of absentCommands) {
      for (const behavior of ["missing-first-X", "missing-last-X", "moved-line"]) {
        const result = headless(id)(capturedModeContext(identity, behavior).source) as ModeResult
        expect.soft(result.criterionBranch, id).not.toBe("source-negative-review")
        expect.soft(result.assertions, id).toBeUndefined()
        expect
          .soft(result.tests, id)
          .toEqual(expect.arrayContaining([expect.objectContaining({ status: "test-todo" })]))
        expect
          .soft(JSON.stringify(result), id)
          .toMatch(behavior.startsWith("missing") ? /X|control|marker/i : /line|row|cursor|position/i)
      }
      for (const fixture of altered.map((changed) => capturedModeContext(changed))) {
        const result = headless(id)(fixture.source) as ReturnType<NonNullable<(typeof modesProbes)[number]["lib"]>>
        expect.soft(result.criterionBranch, id).not.toBe("source-negative-review")
        expect.soft(result.observation?.outcome, id).not.toBe("unsupported")
      }
    }
  },
)

// #32099 review: stack priors had no tests, so appending only to prior.tests lost the named cause.
test.each(capturedModeEngines)(
  "$engine names each source identity failure for mode and stack priors",
  ({ identity }) => {
    const changes = [
      { value: { ...identity, resolvedPath: "moved/index.ts" }, reason: /entry moved/i },
      { value: { ...identity, integrity: { ...identity.integrity, cleanTree: false } }, reason: /dirty/i },
      {
        value: { ...identity, integrity: { ...identity.integrity, treeOid: "0".repeat(40) } },
        reason: /foreign source/i,
      },
      { value: { ...identity, adapterSources: [] }, reason: /adapter source/i },
      { value: { ...identity, engineVersion: "foreign" }, reason: /engine version/i },
    ]
    for (const { id } of absentCommands) {
      for (const { value, reason } of changes) {
        const result = headless(id)(capturedModeContext(value).source) as ModeResult
        expect.soft(result.tests, id).toMatchObject([{ status: "test-todo", reason: expect.stringMatching(reason) }])
        expect.soft(result.assertions, id).toBeUndefined()
        expect.soft(result.criterionBranch, id).not.toBe("source-negative-review")
      }
    }
  },
)

test.each(capturedModeEngines)("$engine actual DECRPM deciding reply wins over source review", ({ identity }) => {
  for (const { id, number } of features) {
    for (const [ps, outcome, kind] of [
      ["1", "supported", "positive"],
      ["4", "unsupported", "negative"],
    ] as const) {
      const result = headless(id)(
        capturedModeContext(identity, "consume", `\x1b[?${number};${ps}$y`).source,
      ) as ModeResult
      expect.soft(result.observation, id).toMatchObject({ outcome, assertionType: "query_reply" })
      expect.soft(result.assertions, id).toMatchObject([{ kind, assertionType: "query_reply" }])
      expect.soft(result.criterionBranch, id).toBeUndefined()
    }
  }
})
