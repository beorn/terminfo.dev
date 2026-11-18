/**
 * @failure The iTerm2 prompt-mark reader certifies a row from another row's read, grades a row that never
 *   reached its starting mark, reads PROMPT_UNAVAILABLE as a missing integration, or grades OSC 133 P
 *   without two registering A controls, Supported from a line mark, or Unsupported over changed history; or grades an OSC 633 row unsupported on a control that never moved its projection, or leaks the
 *   session's own directory into a reading or the public write trace (34866).
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
    /** 34866: treat OSC 633 A-D like 133, store E's command line and P's Cwd. */
    with633?: boolean
    /** OSC 7 leaves the directory unchanged. */
    inertOsc7?: boolean
    /** Typed text after B never reaches the command field. */
    noTypedCommand?: boolean
    /** OSC 7 back to the initial directory is ignored. */
    failDirectoryRestore?: boolean
    /** The session's own directory before the row runs. */
    initialDirectory?: string
    /** 34866 osc133-p: bare OSC 133 P starts a prompt exactly as A does. */
    secondaryP?: boolean
    /** An A written straight after a cursor move registers nothing. */
    dropCursorA?: boolean
    /** Each bare P also deletes, or rewrites the exit code of, the oldest prompt mark. */
    pHistory?: "delete" | "change"
    /** ListPromptsRequest answers SESSION_NOT_FOUND. */
    noHistory?: boolean
  } = {},
) {
  const initialDirectory = variant.initialDirectory ?? "/Users/fixture-person/private-home"
  let directory = initialDirectory
  const marks: {
    id: string
    line: number
    command: boolean
    output: boolean
    ran?: boolean
    code?: number
    text?: string
    dir: string
  }[] = []
  let sinceA = ""
  let sinceB: string | undefined
  let fence: unknown = null
  let opened = 0
  const writes: string[] = []
  const privateWrites: string[] = []
  // 3.6.11 prompt marks are line marks (VT100ScreenMutableState setPromptStartLine): an A at a column past
  // 0 first writes CRLF (place prompt at first column), an A at the current prompt's own start is a redraw
  // that adds nothing (promptDidStartAt short circuit; hosted run 44354139927), and an A on a line whose mark
  // has no command reuses it.
  let top = 0
  let row = 0
  let column = 0
  let serial = 0
  let afterCursorMove = false
  let promptStart: number | undefined
  const add = (command = false) => {
    let moved = false
    if (column > 0) {
      row++
      column = 0
      moved = true
    }
    if (!command && !moved && promptStart === row) return
    promptStart = row
    const existing = marks.at(-1)
    if (existing?.line === row && !existing.command) return
    marks.push({
      id: `mark-${serial++}`,
      line: row,
      command,
      output: false,
      dir: directory,
      ...(command && { text: "" }),
    })
  }
  const write = (text: string) => {
    writes.push(text)
    feed(text)
  }
  const feed = (text: string) => {
    const tokens =
      /\x1b\](?:(133|633);([A-Z])(?:;([^\x07]*))?|7;file:\/\/localhost([^\x07]*)|1337;SetUserVar=terminfo_fence=([A-Za-z0-9+/=]*))\x07|\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07]*\x07|([^\x1b]+)/g
    for (const [, namespace, letter, argument, path, value, csi, final, printed] of text.matchAll(tokens)) {
      const moved = afterCursorMove
      afterCursorMove = false
      if (final !== undefined) {
        if (final === "J" && csi === "3") {
          top = row + 50
          row = top
          column = 0
          promptStart = undefined
        } else if (final === "H") {
          const [r = 1, c = 1] = (csi ?? "").split(";").map((n) => Number(n || 1))
          row = top + r - 1
          column = c - 1
          afterCursorMove = csi !== ""
        }
        continue
      }
      if (printed !== undefined) {
        for (const char of printed) {
          if (char === "\n") row++
          else if (char === "\r") column = 0
          else column++
        }
        sinceA += printed
        if (sinceB !== undefined) sinceB += printed
        const last = marks.at(-1)
        if (sinceB !== undefined && last?.text !== undefined && !variant.noTypedCommand) last.text = sinceB.trim()
        continue
      }
      if (path !== undefined) {
        const decoded = decodeURIComponent(path)
        if (!variant.inertOsc7 && !(variant.failDirectoryRestore && decoded === initialDirectory)) directory = decoded
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
      if (namespace === "633") {
        if (!variant.with633) continue
        if (letter === "E" && last) {
          last.text = argument ?? ""
          continue
        }
        if (letter === "P") {
          if (argument?.startsWith("Cwd=")) directory = argument.slice(4)
          continue
        }
      }
      const code = argument
      if (letter === "P" && namespace === "133") {
        if (variant.pHistory === "delete") marks.shift()
        if (variant.pHistory === "change" && marks[0]) marks[0].code = 99
        if (variant.secondaryP) add()
        continue
      }
      if (letter === "A" && variant.dropCursorA && moved) continue
      if (letter === "A" && !variant.markAtB) {
        add()
        sinceA = ""
        sinceB = undefined
      } else if (letter === "B" && variant.markAtB) {
        add(true)
        sinceB = ""
      } else if (letter === "B" && last && sinceA !== "") {
        last.command = true
        last.text = ""
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
  const lineRange = (line: number) => ({ start: { x: 0, y: String(line) }, end: { x: 0, y: String(line) } })
  const session: ITermPromptSession = {
    readUserVariable: async () => fence,
    listPrompts: async () => {
      if (variant.noHistory) throw new Error("list_prompts_response SESSION_NOT_FOUND (status 1)")
      return marks.map((mark) => mark.id)
    },
    readPrompt: async (id?: string): Promise<ITermPromptRead> => {
      const last = id === undefined ? marks.at(-1) : marks.find((mark) => mark.id === id)
      if (!last) return { status: "prompt-unavailable" }
      const mark: ITermPromptMark = {
        uniquePromptId: last.id,
        promptRange: lineRange(last.line),
        promptState: last.code !== undefined ? "FINISHED" : last.output ? "RUNNING" : "EDITING",
        ...(last.command && { commandRange: range }),
        ...(last.output && { outputRange: range }),
        ...(last.code !== undefined && { exitStatus: last.code }),
        ...(last.text !== undefined && { command: last.text }),
        workingDirectory: last.dir,
      }
      return { status: "mark", mark }
    },
  }
  return {
    writes,
    privateWrites,
    initialDirectory,
    directory: () => directory,
    opened: () => opened,
    read: (featureId: string, options: { noPrivateWriter?: boolean } = {}) =>
      readITermPromptMarks({
        featureId,
        runId: "run-1",
        write,
        ...(!options.noPrivateWriter && {
          privateWrite: (text: string) => {
            privateWrites.push(text)
            feed(text)
          },
        }),
        withSession: async (work) => {
          opened++
          return work(session)
        },
      }),
  }
}

/** The state reading's three pairs; any other reading fails the test here. */
const stateOf = (reading: Awaited<ReturnType<typeof readITermPromptMarks>>) => {
  if (reading.status !== "measured" || reading.reader !== "state") throw new Error(JSON.stringify(reading))
  return reading
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

// 34866 (@cto osc133p-r2 and its clarification): two A controls at the criterion's cells qualify the
// mark-registration read; P is graded only on its own two reads. A P adding no mark is Unsupported; a P mark
// is a line mark that cannot show the exact target column, so it stays a TODO with its history read kept.
test("osc133-p marks where each A control's mark landed stay a TODO, never Supported", async () => {
  const reading = await fakeITerm({ secondaryP: true }).read("extensions.osc133-p")
  expect(reading).toMatchObject({ status: "unavailable" })
  const reason = reading.status === "unavailable" ? reading.reason : ""
  // The A at row 1 col 2 lands on line 2 after iTerm2's first-column CRLF; the reading keeps actual lines.
  expect(reason).toContain('[{"mark":"new","line":0},{"mark":"new","line":2}]')
  // The baseline mark sits on row 3, so neither control lands on the current prompt's own start.
  expect(reason).not.toContain('"line":3')
  expect(reason).toContain("history unchanged")
  expect(reason).toContain("cannot show the target column")
  expect(gradeAppSemanticState(reading).tests?.[0]?.status).toBe("probe-todo")
  const detail = (reading as { detail?: { column?: string; history?: object } }).detail
  expect(detail?.history).toMatchObject({ added: 2, preserved: "unchanged" })
  expect(detail?.column).toContain("line marks")
})

test("osc133-p is unsupported when both A controls register and P adds no mark", async () => {
  const iterm = fakeITerm()
  const reading = await iterm.read("extensions.osc133-p")
  expect(decided(reading), JSON.stringify(reading)).toBe(false)
  expect(iterm.opened()).toBe(1)
  expect(stateOf(reading).detail).toMatchObject({ history: { added: 0, preserved: "unchanged" } })
})

test("osc133-p A controls that register nothing leave the row a TODO, never unsupported", async () => {
  const reading = await fakeITerm({ dropCursorA: true }).read("extensions.osc133-p")
  expect(reading).toMatchObject({ status: "unavailable" })
  expect(reading.status === "unavailable" && reading.reason).toContain("did not register a new prompt mark")
  expect(gradeAppSemanticState(reading).tests?.[0]?.status).toBe("probe-todo")
})

// @dev/review2 (aa31c70b): the unknown fails the row before P runs, so a P that registers cannot turn a
// corrupt control into a TODO.
test.each([false, true])(
  "osc133-p with an unknown OSC 133 letter that adds a mark is invalid (P registers: %s)",
  async (secondaryP) => {
    const reading = await fakeITerm({ zAddsMark: true, secondaryP }).read("extensions.osc133-p")
    expect(reading).toMatchObject({ status: "invalid" })
    expect(reading.status === "invalid" && reading.reason).toContain("unknown OSC 133 Z moved the prompt mark")
    expect(gradeAppSemanticState(reading).tests?.[0]?.status).toBe("probe-invalid")
  },
)

// A P that adds no mark but deletes or rewrites an earlier mark moved something: unresolved, never Unsupported.
test.each(["delete", "change"] as const)(
  "osc133-p that adds no mark but %ss an earlier prompt mark stays unresolved",
  async (pHistory) => {
    const reading = await fakeITerm({ pHistory }).read("extensions.osc133-p")
    expect(decided(reading), JSON.stringify(reading)).toBe(
      "pending probe-todo: App semantic target changed to an unexpected state",
    )
    expect(stateOf(reading).detail).toMatchObject({ history: { added: 0, preserved: "changed" } })
  },
)

test("osc133-p with unreadable history never grades a positive and names the history it lacked", async () => {
  const positive = await fakeITerm({ secondaryP: true, noHistory: true }).read("extensions.osc133-p")
  expect(positive).toMatchObject({ status: "unavailable" })
  expect(positive.status === "unavailable" && positive.reason).toContain("history not observed")
  expect(gradeAppSemanticState(positive).tests?.[0]?.status).toBe("probe-todo")
  // A P that added nothing is still Unsupported, and the reading says history was not observed.
  const negative = await fakeITerm({ noHistory: true }).read("extensions.osc133-p")
  expect(decided(negative), JSON.stringify(negative)).toBe(false)
  expect(stateOf(negative).detail).toMatchObject({ history: expect.stringContaining("not observed") })
  expect(JSON.parse(stateOf(negative).target.after)).toMatchObject({ history: "not observed" })
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

// 34866 (@cto 34866-osc633-controls-r1): each OSC 633 mark row is controlled by its 133 counterpart, which
// moves the same projection; the start is rebuilt before the 633 feed. An app that handles 133 but drops 633
// is unsupported on these rows, and one that handles 633 like 133 is supported.
test.each([
  "extensions.osc633-a",
  "extensions.osc633-b",
  "extensions.osc633-c",
  "extensions.osc633-d",
  "extensions.osc-633-vscode",
])("%s is graded against its own 133 counterpart control", async (featureId) => {
  const handles = await fakeITerm({ with633: true }).read(featureId)
  expect(decided(handles), JSON.stringify(handles)).toBe(true)
  const drops = await fakeITerm().read(featureId)
  expect(decided(drops), JSON.stringify(drops)).toBe(false)
  // The control is the 133 feed itself, never the fence, and every composite stage is its own phase.
  const phases = drops.status === "measured" ? (drops.detail as { phases: { name: string }[] }).phases : []
  const names = phases.map(({ name }) => name)
  expect(names.filter((name) => name.startsWith("control-133-")).length).toBe(featureId.endsWith("vscode") ? 4 : 1)
  expect(names.filter((name) => name.startsWith("target-633-")).length).toBe(featureId.endsWith("vscode") ? 4 : 1)
  expect(names.indexOf("rebaseline")).toBeGreaterThan(names.lastIndexOf("control-133-0"))
})

// A failed control is never Unsupported: an app dropping C in both namespaces fails the 133 C control.
test("an OSC 633 row whose 133 control fails is invalid, never unsupported", async () => {
  const graded = gradeAppSemanticState(await fakeITerm({ ignore: "C", with633: true }).read("extensions.osc633-c"))
  expect(graded.tests?.[0]?.status).toBe("probe-invalid")
})

test("osc633-e is graded on GetPrompt's command text against a typed-text control", async () => {
  const handles = fakeITerm({ with633: true })
  const reading = await handles.read("extensions.osc633-e")
  expect(decided(reading), JSON.stringify(reading)).toBe(true)
  expect(reading.status === "measured" && (reading.detail as { nonceVerification?: string }).nonceVerification).toBe(
    "not tested: OSC 633 E was sent without a nonce",
  )
  // The E payload is only ever inside its own OSC; the typed control is the only printed command text.
  const payload = (JSON.parse(stateOf(reading).target.expected) as { text: string }).text
  for (const write of handles.writes) {
    expect(write.replace(`\x1b]633;E;${payload}\x07`, "")).not.toContain(payload)
  }
  expect(decided(await fakeITerm().read("extensions.osc633-e"))).toBe(false)
})

test("osc633-e is unavailable when typed text never moves the command field", async () => {
  const reading = await fakeITerm({ with633: true, noTypedCommand: true }).read("extensions.osc633-e")
  expect(reading).toMatchObject({ status: "unavailable" })
  expect(gradeAppSemanticState(reading).tests?.[0]?.status).toBe("probe-todo")
})

// features.json osc633-p: two OSC 7 controls, two distinct Cwd targets, exact paths, initial value restored.
test("osc633-p keeps the Cwd criterion and never shows the session's own directory", async () => {
  for (const [variant, verdict] of [
    [{ with633: true }, true],
    [{}, false],
  ] as const) {
    const iterm = fakeITerm(variant)
    const reading = await iterm.read("extensions.osc633-p")
    expect(decided(reading), JSON.stringify(reading)).toBe(verdict)
    expect(JSON.parse(stateOf(reading).handled.expected)).toHaveLength(2)
    expect(JSON.parse(stateOf(reading).target.expected)).toHaveLength(2)
    // Restored through the private writer, and only there.
    expect(iterm.directory()).toBe(iterm.initialDirectory)
    expect(JSON.stringify(reading)).not.toContain(iterm.initialDirectory)
    expect(iterm.writes.join("")).not.toContain(iterm.initialDirectory)
    expect(iterm.privateWrites.join("")).toContain(iterm.initialDirectory)
  }
})

test("osc633-p is unavailable when OSC 7 never moves the directory", async () => {
  const reading = await fakeITerm({ with633: true, inertOsc7: true }).read("extensions.osc633-p")
  expect(reading).toMatchObject({ status: "unavailable" })
  expect(gradeAppSemanticState(reading).tests?.[0]?.status).toBe("probe-todo")
})

test("osc633-p is invalid when the initial directory is not restored", async () => {
  const iterm = fakeITerm({ with633: true, failDirectoryRestore: true })
  const reading = await iterm.read("extensions.osc633-p")
  expect(reading.status).toBe("invalid")
  const reason = reading.status === "invalid" ? reading.reason : ""
  expect(reason).toMatch(/^iTerm2 prompt row was read, but the directory read back as /)
  expect(reason).not.toContain(iterm.initialDirectory)
})

test("osc633-p without the owner's private writer is invalid and never opens the API", async () => {
  const iterm = fakeITerm({ with633: true })
  const reading = await iterm.read("extensions.osc633-p", { noPrivateWriter: true })
  expect(reading).toMatchObject({ status: "invalid" })
  expect(iterm.opened()).toBe(0)
  expect(iterm.writes).toEqual([])
})

// 34888 (@dev/review2 note b on 34866): only text carrying this row's nonce is the reader's own; a session
// directory that merely looks like fixture text is still the session's, so it is shown by digest only.
test("a session directory shaped like fixture text but without the row nonce is never shown", async () => {
  const iterm = fakeITerm({ with633: true, initialDirectory: "/terminfo-home" })
  const reading = await iterm.read("extensions.osc633-p")
  expect(decided(reading), JSON.stringify(reading)).toBe(true)
  expect(iterm.directory()).toBe("/terminfo-home")
  expect(JSON.stringify(reading)).not.toContain("/terminfo-home")
  expect(JSON.stringify(reading)).toContain("private-sha256:")
})
