/**
 * @failure The iTerm2 prompt-mark reader certifies a row from another row's read, grades a row that never
 *   reached its starting mark, reads PROMPT_UNAVAILABLE as a missing integration, or opens the API for P.
 * @level l1
 * @consumer OwnedTerminal.readAppSemanticState on the hosted iTerm2 arm, graded by gradeAppSemanticState.
 * @testonly none
 */
import { expect, test } from "vitest"
import { gradeAppSemanticState } from "../../probe-defs/src/app-semantic-state.ts"
import { readITermPromptMarks } from "./app-semantic-state.ts"
import type { ITermPromptMark, ITermPromptRead, ITermPromptSession } from "./iterm2-protocol.ts"

/**
 * A fake iTerm2 session with 3.6.11's mark rules (PTYSession getPromptResponseForMark): A adds a mark,
 * B sets its command range, C its output start (RUNNING), D;n its code (FINISHED). Each variant breaks
 * exactly one rule, so each row's verdict follows from the rule it names.
 *
 * The rules also need the text a shell prints (34570, hosted run 44146186014 read every mark EDITING).
 * VT100ScreenMutableState.m at v3.6.11: promptEndedAndCommandStartedAt drops B as a duplicate when nothing
 * moved the cursor since A; commandDidEndWithRange records C only when the command text since B is
 * non-blank; setReturnCodeOfLastCommand puts D's code on lastCommandMark, the last mark that ran a command.
 */
function fakeITerm(
  variant: {
    ignore?: string
    noMarks?: boolean
    zAddsMark?: boolean
    markAtB?: boolean
    noFence?: boolean
    failRestore?: boolean
  } = {},
) {
  const marks: { id: string; command: boolean; output: boolean; ran?: boolean; code?: number }[] = []
  let sinceA = ""
  let sinceB: string | undefined
  let fence: unknown = null
  let opened = 0
  const writes: string[] = []
  const add = (command = false) => marks.push({ id: `mark-${marks.length}`, command, output: false })
  const write = (text: string) => {
    writes.push(text)
    const tokens =
      /\x1b\](?:133;([A-Z])(?:;(\d+))?|1337;SetUserVar=terminfo_fence=([A-Za-z0-9+/=]*))\x07|\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07]*\x07)|([^\x1b]+)/g
    for (const [, letter, code, value, printed] of text.matchAll(tokens)) {
      if (printed !== undefined) {
        sinceA += printed
        if (sinceB !== undefined) sinceB += printed
        continue
      }
      if (value !== undefined) {
        const decoded = Buffer.from(value, "base64").toString()
        if (variant.failRestore && decoded.endsWith("-restored")) throw new Error("fixture session write refused")
        if (!variant.noFence) fence = decoded
        continue
      }
      const last = marks.at(-1)
      if (letter === undefined || variant.noMarks || letter === variant.ignore) continue
      if (letter === "A" && !variant.markAtB) {
        add()
        sinceA = ""
        sinceB = undefined
      } else if (letter === "B" && variant.markAtB) {
        add(true)
        sinceB = ""
      } else if (letter === "B" && last && sinceA !== "") {
        last.command = true
        sinceB = ""
      } else if (letter === "C" && last && sinceB?.trim()) {
        last.output = true
        last.ran = true
      } else if (letter === "D") {
        const ran = marks.findLast((mark) => mark.ran)
        if (ran) ran.code = Number(code ?? 0)
      } else if (letter === "Z" && variant.zAddsMark) add()
    }
  }
  const range = { start: { x: 0, y: "1" }, end: { x: 1, y: "1" } }
  const session: ITermPromptSession = {
    readUserVariable: async () => fence,
    readPrompt: async (): Promise<ITermPromptRead> => {
      const last = marks.at(-1)
      if (!last) return { status: "prompt-unavailable" }
      const mark: ITermPromptMark = {
        uniquePromptId: last.id,
        promptRange: range,
        promptState: last.code !== undefined ? "FINISHED" : last.output ? "RUNNING" : "EDITING",
        ...(last.command && { commandRange: range }),
        ...(last.output && { outputRange: range }),
        ...(last.code !== undefined && { exitStatus: last.code }),
      }
      return { status: "mark", mark }
    },
  }
  return {
    writes,
    opened: () => opened,
    read: (featureId: string) =>
      readITermPromptMarks({
        featureId,
        runId: "run-1",
        write,
        withSession: async (work) => {
          opened++
          return work(session)
        },
      }),
  }
}

/** A decided verdict: a pass value and a test status that is not one of the pending probe-* statuses. */
const decided = (reading: Awaited<ReturnType<typeof readITermPromptMarks>>) => {
  const graded = gradeAppSemanticState(reading)
  const status = graded.tests?.[0]?.status ?? "decided"
  return status.startsWith("probe-") ? `pending ${status}: ${graded.note ?? ""}` : graded.pass
}

test.each([
  "extensions.osc133-a",
  "extensions.osc133-b",
  "extensions.osc133-c",
  "extensions.osc133-d",
  "extensions.semantic-prompts",
])("%s is decided supported from its own fresh mark read", async (featureId) => {
  const iterm = fakeITerm()
  const reading = await iterm.read(featureId)
  expect(decided(reading), JSON.stringify(reading)).toBe(true)
  expect(reading.status === "measured" && reading.runId).toBe("run-1")
})

// Each letter decides only its own row: an app that drops one letter is unsupported on that row alone.
// (Dropping A leaves no mark at all, so that app reads as PROMPT_UNAVAILABLE, tested below.)
test.each([
  ["B", "extensions.osc133-b"],
  ["C", "extensions.osc133-c"],
  ["D", "extensions.osc133-d"],
])("an app ignoring %s is unsupported on %s", async (letter, featureId) => {
  const reading = await fakeITerm({ ignore: letter }).read(featureId)
  expect(decided(reading), JSON.stringify(reading)).toBe(false)
})

// Every other row's start passes through B, so an app without B leaves them unbased, never graded:
// only the B row itself is decided (unsupported, above).
test.each(["extensions.osc133-a", "extensions.osc133-c", "extensions.osc133-d", "extensions.semantic-prompts"])(
  "without B, %s is reported unbased rather than graded",
  async (featureId) => {
    expect(decided(await fakeITerm({ ignore: "B" }).read(featureId))).toMatch(
      /^pending probe-invalid: iTerm2 prompt mark did not reach this row's baseline/,
    )
  },
)

test("PROMPT_UNAVAILABLE stays the API's own status, not a missing shell integration", async () => {
  const reading = await fakeITerm({ noMarks: true }).read("extensions.osc133-a")
  expect(reading).toMatchObject({ status: "unavailable" })
  const reason = reading.status === "unavailable" ? reading.reason : ""
  expect(reason).toContain("PROMPT_UNAVAILABLE")
  expect(reason).toContain("not proof shell integration is absent")
  expect(gradeAppSemanticState(reading).tests?.[0]?.status).toBe("probe-todo")
})

test("an unknown OSC 133 letter that adds a mark fails the row's controls", async () => {
  const graded = gradeAppSemanticState(await fakeITerm({ zAddsMark: true }).read("extensions.osc133-c"))
  expect(graded.tests?.[0]?.status).toBe("probe-invalid")
  expect(graded.note).toBe("App semantic-state controls failed in this row")
})

// A mark that only appears at B means the B row never starts from "A seen, command unset": it is
// reported invalid with what was read, never graded unsupported against the wrong start.
test("a row whose baseline mark differs from its assumed start is invalid, not unsupported", async () => {
  const reading = await fakeITerm({ markAtB: true }).read("extensions.osc133-b")
  const graded = gradeAppSemanticState(reading)
  expect(graded.tests?.[0]?.status).toBe("probe-invalid")
  expect(graded.note).toContain("did not reach this row's baseline")
})

test("osc133-p stays unresolved and never opens the API", async () => {
  const iterm = fakeITerm()
  const reading = await iterm.read("extensions.osc133-p")
  expect(iterm.opened()).toBe(0)
  expect(iterm.writes).toEqual([])
  expect(reading).toMatchObject({ status: "unavailable" })
  expect(gradeAppSemanticState(reading).tests?.[0]?.status).toBe("probe-todo")
})

// @dev/review2 7551f8f9: a session that never reports its fence (SetUserVar not seen on a real 3.6.11)
// is reported by the phase that failed, with the phase log kept; the restore still runs and its own
// failure is appended, never put in place of the first.
test("a fence that never appears is reported by its own phase, not masked by the restore", async () => {
  const reading = await fakeITerm({ noFence: true }).read("extensions.osc133-b")
  expect(reading.status).toBe("invalid")
  const reason = reading.status === "invalid" ? reading.reason : ""
  expect(reason).toMatch(/^iTerm2 prompt read failed in the baseline phase: .*baseline user-variable fence/)
  expect(reason).toMatch(/; then restoring the session failed: .*restored user-variable fence/)
  expect(reading.status === "invalid" && reading.detail).toMatchObject({
    phases: [{ name: "baseline user-variable fence" }, { name: "restored user-variable fence" }],
  })
}, 20_000)

// @cto 5a892117: a RETURNED unsuccessful reading (PROMPT_UNAVAILABLE, a baseline that missed its start) keeps its
// own reason when the session cleanup also fails; the cleanup failure is appended, and the row stays invalid.
// The case above covers only a THROWN phase failure. Each primary case runs with and without the failed cleanup.
test.each([
  { variant: { noMarks: true }, primary: /PROMPT_UNAVAILABLE after the baseline OSC 133 sequence/ },
  { variant: { markAtB: true }, primary: /did not reach this row's baseline/ },
])("a returned $primary reason survives a failed session cleanup", async ({ variant, primary }) => {
  const control = await fakeITerm(variant).read("extensions.osc133-b")
  expect(control.status === "measured" ? "" : control.reason).toMatch(primary)
  expect(control.status === "measured" ? "" : control.reason).not.toContain("restoring the session failed")
  const reading = await fakeITerm({ ...variant, failRestore: true }).read("extensions.osc133-b")
  expect(reading.status).toBe("invalid")
  const reason = reading.status === "invalid" ? reading.reason : ""
  expect(reason.startsWith(control.status === "measured" ? "?" : control.reason)).toBe(true)
  expect(reason).toMatch(/; then restoring the session failed: fixture session write refused$/)
  expect(gradeAppSemanticState(reading).tests?.[0]?.status).toBe("probe-invalid")
})
