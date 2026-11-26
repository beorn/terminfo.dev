/**
 * OSC 7577 program resume, spec revision 0.5 (2026-11-25), #38699. A terminal advertises support only by putting
 * `OSC7577_TOKEN` in each pane's first process; there is no query and no reply. The row reads that export through the
 * verified terminal child's environment, the same reader and binding as TERM_FEATURES (@cto ee6b7fd9).
 */
import type { AssertionType, LibProbeSource, ProbeCallbackResult, ProbeDefinition, TermProbeSource } from "./types.ts"
import { declaredUntestableResult, notTestedResult, probe, replyFailure } from "./helpers.ts"

export const PROGRAM_RESUME_SPEC = "OSC 7577 spec revision 0.5 (2026-11-25)"

const MALFORMED_RULE = {
  length: "a token must be 22-64 characters",
  charset: "a token must use only [A-Za-z0-9_-]",
} as const

function tokenLibraryReview(): ProbeCallbackResult {
  return declaredUntestableResult(
    "OSC7577_TOKEN: a library context spawns no application child to receive the environment export",
    {},
  )
}

async function tokenAppResult(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
  if (!ctx.readProgramResumeToken) return notTestedResult("terminal child environment", {})
  const reading = await ctx.readProgramResumeToken()
  if (reading.status === "unavailable") return notTestedResult(reading.reason, {})
  if (reading.status === "invalid") {
    return {
      pass: false,
      note: reading.reason,
      tests: [{ id: "terminal-child-environment", status: "probe-invalid", reason: reading.reason }],
    }
  }
  // As TERM_FEATURES under #32569: a present token inside a mux may be the outer terminal's, which the spec forbids
  // passing on but which this row cannot tell apart; absence with this run's marker seen is Unsupported.
  if (reading.present && reading.mux) {
    return notTestedResult(
      `OSC7577_TOKEN present inside ${reading.mux}; it may come from the outer terminal, and presence cannot be attributed without an authenticated source`,
      { present: true, length: reading.length, mux: reading.mux },
    )
  }
  const supported = reading.present && reading.malformed === undefined
  const note = !reading.present
    ? `OSC7577_TOKEN absent with this terminal child's same-run control (${PROGRAM_RESUME_SPEC})`
    : reading.malformed
      ? `OSC7577_TOKEN present but malformed: ${MALFORMED_RULE[reading.malformed]} (${PROGRAM_RESUME_SPEC})`
      : `OSC7577_TOKEN exported to this terminal child, well formed (${PROGRAM_RESUME_SPEC})`
  const observed = !reading.present
    ? "absent"
    : `present, ${reading.length} characters${reading.malformed ? `, breaks: ${MALFORMED_RULE[reading.malformed]}` : ", well formed"}`
  const { runId, launchMarker, pid, tty, present, length, malformed } = reading
  return {
    pass: supported,
    note,
    response: JSON.stringify({ status: reading.status, present, length, malformed, runId, launchMarker, pid, tty }),
    observation: { outcome: supported ? "supported" : "unsupported", assertionType: "process_environment", note },
    assertions: [
      {
        assertionType: "process_environment",
        kind: supported ? "positive" : "negative",
        expected: "a well-formed OSC7577_TOKEN exported by the terminal into the pane's first process",
        observed,
      },
    ],
  }
}

interface Report {
  readonly label: string
  readonly bytes: string
}

/**
 * Row 2: a report, accepted or not, prints nothing. Spec rev 0.5 has no reply and defines no display, so a report that
 * moves the cursor or adds text is the terminal showing the escape sequence to the user. The well-formed report is the
 * spec's own lazygit example, whose mac is real for the token "dummy-token-replace-me"; under any pane's real token it
 * fails verification, so no record is saved and nothing can resume.
 */
const OSC7577_REPORTS: readonly Report[] = [
  {
    label: "well-formed report (spec example, ST)",
    bytes:
      "\x1b]7577;pid=74877:time=1795543200:argv=bGF6eWdpdA==:cwd=L2hvbWUvdXNlci9zcmMvcHJvamVjdA==:mac=35cb909805c380336efd3689a125acc774a9dec8422a1d21492ebec06ca758e1\x1b\\",
  },
  {
    label: "report with no mac (spec invalid row 2, BEL)",
    bytes: "\x1b]7577;pid=74877:time=1795543200:argv=bnZpbQ==\x07",
  },
]

/** OSC 88, the earlier Terminal Resume Protocol (github.com/otty-sh/osc-88): unauthenticated, no reply to arm or clear. */
const OSC88_REPORTS: readonly Report[] = [
  { label: "arm with cmd=/bin/true (ST)", bytes: "\x1b]88;arm;cmd=L2Jpbi90cnVl\x1b\\" },
  { label: "clear (BEL)", bytes: "\x1b]88;clear\x07" },
]

function silentResult(
  name: string,
  assertionType: AssertionType,
  readings: readonly { label: string; shown: string }[],
  expected: string,
  control: string,
): ProbeCallbackResult {
  const visible = readings.filter((reading) => reading.shown !== expected)
  const supported = visible.length === 0
  const note = supported
    ? `${name}: every report left the screen unchanged after a printed control moved it`
    : `${name}: visible output after ${visible.map((reading) => reading.label).join(" and ")}`
  return {
    pass: supported,
    note,
    response: JSON.stringify({ control, readings }),
    observation: { outcome: supported ? "supported" : "unsupported", assertionType, note },
    assertions: readings.map((reading) => ({
      assertionType,
      kind: reading.shown === expected ? ("positive" as const) : ("negative" as const),
      expected: `${reading.label} leaves ${expected}`,
      observed: reading.shown,
    })),
  }
}

function silentLib(name: string, reports: readonly Report[]) {
  return (ctx: LibProbeSource): ProbeCallbackResult => {
    const read = (payload: string) => {
      ctx.feed("\x1b[2J\x1b[H" + payload)
      const cursor = ctx.getCursor()
      return `text ${JSON.stringify(ctx.getText().trim())}, cursor row ${cursor.y} col ${cursor.x}`
    }
    const control = read("AB")
    if (control !== 'text "AB", cursor row 0 col 2') {
      return notTestedResult(`${name}: the screen reader did not show a printed control (${control})`, { control })
    }
    const readings = reports.map((report) => ({ label: report.label, shown: read(report.bytes + "X") }))
    read("")
    return silentResult(name, "buffer_state", readings, 'text "X", cursor row 0 col 1', control)
  }
}

function silentApp(name: string, reports: readonly Report[]) {
  return async (ctx: TermProbeSource): Promise<ProbeCallbackResult> => {
    const read = async (payload: string) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write(payload)
      const position = await ctx.queryCursorPosition()
      return position && `cursor row ${position.row} col ${position.col}`
    }
    const control = await read("AB")
    if (control === null) return replyFailure(`${name}: no cursor position reply after a printed control`)
    if (control !== "cursor row 1 col 3") {
      ctx.write("\x1b[1;1H\x1b[2K")
      return notTestedResult(`${name}: the cursor did not follow a printed control (${control})`, { control })
    }
    const readings: { label: string; shown: string }[] = []
    for (const report of reports) {
      const shown = await read(report.bytes)
      if (shown === null) return replyFailure(`${name}: no cursor position reply after the ${report.label}`)
      readings.push({ label: report.label, shown })
    }
    ctx.write("\x1b[1;1H\x1b[2K")
    return silentResult(name, "buffer_state", readings, "cursor row 1 col 1", control)
  }
}

export const programResumeProbes: ProbeDefinition[] = [
  probe("extensions.osc7577-token", tokenLibraryReview, tokenAppResult, "process_environment"),
  {
    ...probe(
      "extensions.osc7577-silent",
      silentLib("OSC 7577", OSC7577_REPORTS),
      silentApp("OSC 7577", OSC7577_REPORTS),
      "buffer_state",
    ),
    libAssertionType: "buffer_state",
  },
  {
    ...probe(
      "extensions.osc88-silent",
      silentLib("OSC 88", OSC88_REPORTS),
      silentApp("OSC 88", OSC88_REPORTS),
      "buffer_state",
    ),
    libAssertionType: "buffer_state",
  },
]
