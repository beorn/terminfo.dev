/**
 * @failure A DECRQM mode feature ignores the engine's DECRPM reply or grades silent replies from uncontrolled state.
 * @level l2
 * @consumer Headless capture rows for the seven DECRQM mode features (#30543, @cto ruling b5987212).
 * @reach Runs each registry definition's termless callback against a scripted context, and the shared parser directly.
 * @testonly none
 */
import { expect, test } from "vitest"
import { decrpmPs, decrpmReplyPattern, decrpmStatus } from "./helpers.ts"
import { modesProbes } from "./modes.ts"
import type { LibProbeSource } from "./types.ts"

// DEC1: silence permits these two public-state criteria only; constant, missing,
// conflated and unknown-mode-sensitive readers cannot qualify a state observation.
test.each([
  { id: "modes.application-cursor", number: 1, key: "applicationCursor", other: "reverseVideo", facet: "key encoding" },
  { id: "modes.reverse-video", number: 5, key: "reverseVideo", other: "applicationCursor", facet: "presentation" },
])("$id measures controlled state when DECRPM is silent", ({ id, number, key, other, facet }) => {
  for (const fault of ["none", "constant", "missing", "conflated", "unknown"] as const) {
    let enabled = false
    let disturbed = false
    const source = {
      ...context("", false, [], []),
      feed(text: string) {
        if (text === `\x1b[?${number}h`) enabled = true
        if (text === `\x1b[?${number}l`) enabled = false
        if (text === "\x1b[?9999h" && fault === "unknown") disturbed = true
      },
      getMode(name: string) {
        if (name === other) return fault === "conflated" && enabled
        if (name !== key) return null
        return fault === "missing" ? null : fault === "constant" ? false : disturbed || enabled
      },
    } as LibProbeSource
    const result = headless(id)(source) as ReturnType<NonNullable<(typeof modesProbes)[number]["lib"]>>
    if (fault === "none") {
      expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
      expect(result.note).toContain(`${facet} unmeasured`)
      expect(JSON.parse(result.response!)).toMatchObject({ initial: false, set: true, reset: false, unknown: false })
    } else {
      expect(result.observation?.outcome, fault).not.toBe("supported")
      expect(result.assertions ?? [], fault).toEqual([])
      expect(result.tests, fault).toMatchObject([{ id: "criterion", status: "probe-todo" }])
    }
  }
})

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
    {
      id: "criterion",
      status: "probe-todo",
      reason: "Open: our scripted-engine adapter cannot read the application keypad mode yet.",
    },
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
    { id: "criterion", status: "probe-todo", reason: "DECKPAM state pair: set false, reset true" },
  ])
  expect(result.assertions ?? []).toEqual([])
})

// @failure Private4 is called Supported when the independent IRM conflation check could not run.
test.each([{ insertBefore: null }, { insertAfter: null }])("private4 requires both IRM readings: %j", (options) => {
  const { source } = readbackContext(4, options)
  const result = headless("modes.decsclm")(source) as ReturnType<NonNullable<(typeof modesProbes)[number]["lib"]>>
  expect(result.tests).toEqual([
    { id: "criterion", status: "probe-todo", reason: "adapter binding scripted-engine insertMode" },
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
    { id: "criterion", status: "probe-todo", reason: "adapter binding scripted-engine syncOutput" },
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
  expect(result.tests).toEqual(expect.arrayContaining([expect.objectContaining({ status: "probe-todo" })]))
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
  { id: "modes.utf8-mouse-1005", number: 1005, mode: "utf8Mouse" },
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

test.each(features.filter(({ number }) => number !== 1))(
  "$id keeps missing or foreign DECRPM replies undecided without controlled state",
  ({ id, number, mode }) => {
    const arm = headless(id)
    for (const reply of ["", "\x1b[?25;1$y\x1b[?6c", `\x1b[?${number === 1 ? 2004 : 1};1$y`]) {
      const result = arm(context(reply, true, [], [])) as ReturnType<NonNullable<(typeof modesProbes)[number]["lib"]>>
      const label = `${id}: ${JSON.stringify(reply)}`
      if (number !== 1004) {
        expect(result.observation, label).toMatchObject({ outcome: "inconclusive", assertionType: "buffer_state" })
        expect(result.assertions ?? [], label).toEqual([])
        expect(result.tests, label).toMatchObject([{ id: "criterion", status: "probe-todo" }])
        expect(JSON.parse(result.response!), label).toMatchObject({ prior: expectedState(reply, mode) })
        continue
      }
      expect(result.criterionBranch, label).toBe("os-input-review")
      expect(result.notTested, label).toEqual({
        reason: "no-semantic-observable",
        noObservable: expect.stringContaining(`CSI ? ${number} $ p`),
      })
      expect(result.tests, label).toMatchObject([
        {
          id: "review",
          status: "probe-todo",
          reason: expect.stringContaining("no usable reply to the mode query (DECRPM)"),
        },
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
