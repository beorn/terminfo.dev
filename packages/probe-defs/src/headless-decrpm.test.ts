/**
 * @failure A DECRQM mode feature's headless arm grades without the engine's own DECRPM reply, reads that reply with a second parser, or counts the adapter's getMode value as evidence.
 * @level l2
 * @consumer Headless capture rows for the seven DECRQM mode features (#30543, @cto ruling b5987212).
 * @reach Runs each registry definition's termless callback against a scripted context, and the shared parser directly.
 * @testonly none
 */
import { expect, test } from "vitest"
import { decrpmReplyPattern, decrpmStatus } from "./helpers.ts"
import { modesProbes } from "./modes.ts"
import type { TermlessContext } from "./types.ts"

const features = [
  { id: "modes.bracketed-paste", number: 2004, mode: "bracketedPaste" },
  { id: "modes.application-cursor", number: 1, mode: "applicationCursor" },
  { id: "modes.mouse-tracking", number: 1000, mode: "mouseTracking" },
  { id: "modes.focus-tracking", number: 1004, mode: "focusTracking" },
  { id: "modes.mouse-sgr", number: 1006, mode: "sgrMouse" },
  { id: "modes.mouse-all", number: 1003, mode: "mouseTracking" },
  { id: "modes.utf8-mouse-1005", number: 1005, mode: null },
] as const

function headless(
  id: string,
): NonNullable<TermlessContext extends infer _ ? (ctx: TermlessContext) => unknown : never> {
  const definition = modesProbes.find((probe) => probe.id === id)
  if (!definition?.termless) throw new Error(`Missing headless callback for ${id}`)
  return definition.termless
}

function context(reply: string, mode: boolean, fed: string[], captured: string[]): TermlessContext {
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
  } as unknown as TermlessContext
}

const expectedState = (reply: string, mode: string | null) => (mode === null ? { reply } : { reply, mode: true })

test.each(features)("$id grades the engine's DECRPM reply exactly as the app arm does", ({ id, number, mode }) => {
  const arm = headless(id)
  for (const [ps, state] of [
    ["1", "set"],
    ["3", "set"],
    ["2", "reset"],
    ["4", "reset"],
  ] as const) {
    const fed: string[] = []
    const captured: string[] = []
    const reply = `\x1b[?${number};${ps}$y`
    const result = arm(context(reply, true, fed, captured)) as ReturnType<
      NonNullable<(typeof modesProbes)[number]["termless"]>
    >
    expect(captured, `${id}: Ps ${ps}`).toEqual([`\x1b[?${number}$p`])
    expect(fed, `${id}: Ps ${ps}`).toEqual([`\x1b[?${number}h`, `\x1b[?${number}l`])
    expect(result.pass, `${id}: Ps ${ps}`).toBe(true)
    expect(result.observation, `${id}: Ps ${ps}`).toMatchObject({ outcome: "supported", evidence: "query" })
    expect(result.assertions, `${id}: Ps ${ps}`).toMatchObject([{ kind: "positive", observed: state }])
    expect(result.criterionBranch, `${id}: Ps ${ps}`).toBeUndefined()
    expect(result.notTested, `${id}: Ps ${ps}`).toBeUndefined()
    expect(JSON.parse(result.response!), `${id}: Ps ${ps}`).toEqual(expectedState(reply, mode))
  }
  // Ps 0 answers the query but not the mode: inconclusive, no assertion, the app arm's own reading.
  const zero = arm(context(`\x1b[?${number};0$y`, false, [], [])) as ReturnType<
    NonNullable<(typeof modesProbes)[number]["termless"]>
  >
  expect(zero.pass, id).toBe(false)
  expect(zero.observation, id).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "query",
  })
  expect(zero.assertions, id).toBeUndefined()
  expect(zero.criterionBranch, id).toBeUndefined()
})

test.each(features)(
  "$id routes a missing or foreign DECRPM reply to review, keeping getMode as context only",
  ({ id, number, mode }) => {
    const arm = headless(id)
    for (const reply of ["", "\x1b[?25;1$y\x1b[?6c", `\x1b[?${number === 1 ? 2004 : 1};1$y`]) {
      const result = arm(context(reply, true, [], [])) as ReturnType<
        NonNullable<(typeof modesProbes)[number]["termless"]>
      >
      const label = `${id}: ${JSON.stringify(reply)}`
      expect(result.criterionBranch, label).toBe("os-input-review")
      expect(result.notTested, label).toEqual({
        reason: "no-semantic-observable",
        noObservable: expect.stringContaining(`CSI ? ${number} $ p`),
      })
      expect(result.checks, label).toMatchObject([
        { id: "review", status: "test-todo", reason: expect.stringMatching(/no DECRPM reply/) },
      ])
      expect(result.observation, label).toBeUndefined()
      expect(result.assertions, label).toBeUndefined()
      expect(JSON.parse(result.response!), label).toEqual(expectedState(reply, mode))
    }
  },
)

test("one DECRPM reading serves the app query, the ANSI query and the headless arm", () => {
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
