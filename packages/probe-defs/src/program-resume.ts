/**
 * OSC 7577 program resume, spec revision 0.5 (2026-11-25), #38699 and #38754. A terminal advertises support only by
 * putting `OSC7577_TOKEN` in each pane's first process; there is no query and no reply. The row reads that export
 * through the verified terminal child's environment, the same reader and binding as TERM_FEATURES (@cto ee6b7fd9,
 * @cto 953d6a6c).
 */
import { createHmac } from "node:crypto"
import type { AssertionType, LibProbeSource, ProbeCallbackResult, ProbeDefinition, TermProbeSource } from "./types.ts"
import { declaredUntestableResult, notTestedResult, probe, replyFailure } from "./helpers.ts"

export const PROGRAM_RESUME_SPEC = "OSC 7577 spec revision 0.5 (2026-11-25)"

/** Fixed 22-character test-only sentinel planted in a multiplexer's launch environment (#38754, @cto 953d6a6c). */
export const OSC7577_MUX_SENTINEL_TOKEN = "S".repeat(22)

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
  // When a multiplexer run has a planted sentinel in its launch environment (#38754, @cto 953d6a6c), grade the two
  // requirements separately:
  // - R7577-059 (don't pass the outer token on): equal fails; different or absent passes.
  // - R7577-060 (mint your own token): only a well-formed different passes.
  if (reading.mux && reading.sentinel !== undefined) {
    const pass059 = reading.sentinel !== "equal"
    const pass060 = reading.sentinel === "different" && reading.malformed === undefined
    const supported = pass059 && pass060
    const reason059 = pass059
      ? `R7577-059: ${reading.mux} did not pass the outer sentinel OSC7577_TOKEN on to the pane (${PROGRAM_RESUME_SPEC})`
      : `R7577-059: ${reading.mux} passed the outer sentinel OSC7577_TOKEN on to the pane (${PROGRAM_RESUME_SPEC})`
    const reason060 =
      reading.sentinel !== "different"
        ? `R7577-060: ${reading.mux} did not mint its own OSC7577_TOKEN for the pane (${reading.sentinel}; ${PROGRAM_RESUME_SPEC})`
        : reading.malformed
          ? `R7577-060: ${reading.mux} minted a malformed OSC7577_TOKEN: ${MALFORMED_RULE[reading.malformed]} (${PROGRAM_RESUME_SPEC})`
          : `R7577-060: ${reading.mux} minted its own well-formed OSC7577_TOKEN for the pane (${PROGRAM_RESUME_SPEC})`
    const note = supported
      ? `${reading.mux} replaced the outer sentinel and minted its own well-formed OSC7577_TOKEN (${PROGRAM_RESUME_SPEC})`
      : !pass059
        ? `${reading.mux} passed the outer sentinel OSC7577_TOKEN on to the pane instead of replacing it (${PROGRAM_RESUME_SPEC})`
        : reading.malformed
          ? `${reading.mux} minted a malformed OSC7577_TOKEN: ${MALFORMED_RULE[reading.malformed]} (${PROGRAM_RESUME_SPEC})`
          : `OSC7577_TOKEN absent inside ${reading.mux}; outer sentinel was not passed on, and ${reading.mux} did not mint its own (${PROGRAM_RESUME_SPEC})`
    const observed =
      reading.sentinel === "absent"
        ? "absent (sentinel not passed on)"
        : reading.sentinel === "equal"
          ? `present, ${reading.length} characters, equal to planted outer sentinel`
          : `present, ${reading.length} characters, different from outer sentinel${reading.malformed ? `, breaks: ${MALFORMED_RULE[reading.malformed]}` : ", well formed"}`
    const { runId, launchMarker, pid, tty, present, length, malformed, mux, sentinel } = reading
    return {
      pass: supported,
      note,
      response: JSON.stringify({
        status: reading.status,
        present,
        length,
        ...(malformed && { malformed }),
        mux,
        sentinel,
        runId,
        launchMarker,
        pid,
        tty,
      }),
      observation: { outcome: supported ? "supported" : "unsupported", assertionType: "process_environment", note },
      assertions: [
        {
          assertionType: "process_environment",
          kind: supported ? "positive" : "negative",
          expected:
            "multiplexer does not pass the outer sentinel OSC7577_TOKEN on (R7577-059) and mints its own well-formed OSC7577_TOKEN (R7577-060)",
          observed,
        },
      ],
      tests: [
        { id: "R7577-059", status: pass059 ? "supported" : "unsupported", reason: reason059 },
        { id: "R7577-060", status: pass060 ? "supported" : "unsupported", reason: reason060 },
      ],
    }
  }
  // As TERM_FEATURES under #32569: without a planted sentinel, a present token inside a mux may be the outer
  // terminal's, which the spec forbids passing on but which this row cannot tell apart; absence is Unsupported.
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

export interface Report {
  readonly label: string
  readonly bytes: string
}

/** Reserved `?` body (`R7577-046`): terminals must ignore `OSC 7577 ; ? ST`. */
export const OSC7577_RESERVED_QUERY_REPORT = "\x1b]7577;?\x1b\\"

/**
 * Well-formed report padded to exactly 2048 bytes with 64 `argv` elements, the spec's minimums (`R7577-137`, `R7577-138`).
 * First 63 elements are `YQ==` ("a"); the 64th is 1588 base64 bytes (1191 bytes of "x"), so the whole sequence from
 * `\x1b]7577;` through `\x1b\\` is 2048 bytes (`7 + 30 + 315 + 1588 + 42 + 64 + 2 = 2048`). Signed with the spec's
 * dummy token `"dummy-token-replace-me"`.
 */
const ARGV_64_ELEMENTS = `${"YQ==,".repeat(63)}${Buffer.alloc(1191, 0x78).toString("base64")}`
const BODY_2048 = `pid=7487:time=1795543200:argv=${ARGV_64_ELEMENTS}:cwd=L2hvbWUvdXNlci9zcmMvcHJvamVjdA==`
const MAC_2048 = createHmac("sha256", "dummy-token-replace-me").update(BODY_2048).digest("hex")
export const OSC7577_2048_BYTE_64_ARGV_REPORT = `\x1b]7577;${BODY_2048}:mac=${MAC_2048}\x1b\\`

/** Over-long report (>8 KiB, `R7577-146`): 8510 bytes total. */
const OVER_8KIB_ARGV = Buffer.alloc(6300, 0x61).toString("base64")
export const OSC7577_OVER_8KIB_REPORT = `\x1b]7577;pid=74877:time=1795543200:argv=${OVER_8KIB_ARGV}:mac=35cb909805c380336efd3689a125acc774a9dec8422a1d21492ebec06ca758e1\x1b\\`

/** Report cut short before its `mac` finishes (`R7577-048`, `R7577-053`). */
export const OSC7577_CUT_SHORT_REPORT = "\x1b]7577;pid=74877:time=1795543200:argv=bGF6eWdpdA==:mac=35cb9098\x1b\\"

/**
 * Row 2: a report, accepted or not, prints nothing and sends no reply (#38699, #38754). Spec rev 0.5 has no query and
 * no reply and defines no display, so a report that moves the cursor, adds text, or writes bytes before a trailing DA1
 * reply fails the row.
 */
export const OSC7577_REPORTS: readonly Report[] = [
  {
    label: "well-formed report (spec example, ST)",
    bytes:
      "\x1b]7577;pid=74877:time=1795543200:argv=bGF6eWdpdA==:cwd=L2hvbWUvdXNlci9zcmMvcHJvamVjdA==:mac=35cb909805c380336efd3689a125acc774a9dec8422a1d21492ebec06ca758e1\x1b\\",
  },
  {
    label: "report with no mac (spec invalid row 2, BEL)",
    bytes: "\x1b]7577;pid=74877:time=1795543200:argv=bnZpbQ==\x07",
  },
  {
    label: "reserved ? body (ST)",
    bytes: OSC7577_RESERVED_QUERY_REPORT,
  },
  {
    label: "2048-byte report with 64 argv elements (spec minimums, ST)",
    bytes: OSC7577_2048_BYTE_64_ARGV_REPORT,
  },
  {
    label: "over-long report (>8 KiB, ST)",
    bytes: OSC7577_OVER_8KIB_REPORT,
  },
  {
    label: "cut-short report (truncated mac, ST)",
    bytes: OSC7577_CUT_SHORT_REPORT,
  },
]

/** OSC 88, the earlier Terminal Resume Protocol (github.com/otty-sh/osc-88): unauthenticated, no reply to arm or clear. */
export const OSC88_REPORTS: readonly Report[] = [
  { label: "arm with cmd=/bin/true (ST)", bytes: "\x1b]88;arm;cmd=L2Jpbi90cnVl\x1b\\" },
  { label: "clear (BEL)", bytes: "\x1b]88;clear\x07" },
]

function silentResult(
  name: string,
  assertionType: AssertionType,
  readings: readonly { label: string; shown: string }[],
  expected: string,
  control: string,
  replyBeforeDa1?: string,
): ProbeCallbackResult {
  const visible = readings.filter((reading) => reading.shown !== expected)
  const supported = visible.length === 0 && replyBeforeDa1 === undefined
  const note =
    replyBeforeDa1 !== undefined
      ? `${name}: terminal wrote bytes before the DA1 reply (${JSON.stringify(replyBeforeDa1)})`
      : supported
        ? `${name}: every report left the screen unchanged after a printed control moved it`
        : `${name}: visible output after ${visible.map((reading) => reading.label).join(" and ")}`
  // A buffer_state assertion observes a JSON state snapshot, and a library arm's must equal its retained response.
  const response = JSON.stringify({
    control,
    readings,
    ...(replyBeforeDa1 !== undefined && { replyBeforeDa1 }),
  })
  return {
    pass: supported,
    note,
    response,
    observation: { outcome: supported ? "supported" : "unsupported", assertionType, note },
    assertions: [
      {
        assertionType,
        kind: supported ? "positive" : "negative",
        expected: `every report leaves ${expected}`,
        observed: response,
      },
    ],
  }
}

const DA1_QUERY = "\x1b[c"
const DA1_REPLY = /\x1b\[\?[0-9;]*c/
const DA1_AT_START = /^\x1b\[\?[0-9;]*c/

function silentLib(name: string, reports: readonly Report[], checkNoReply = false) {
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
    let replyBeforeDa1: string | undefined
    if (checkNoReply) {
      const allReports = reports.map((report) => report.bytes).join("")
      if (ctx.queryWithSentinelOutcome) {
        const outcome = ctx.queryWithSentinelOutcome(allReports, DA1_REPLY)
        if (!DA1_AT_START.test(outcome.raw)) replyBeforeDa1 = outcome.raw
      } else if (typeof ctx.feedCapture === "function" && ctx.runtimeIdentity === undefined) {
        const raw = ctx.feedCapture(allReports + DA1_QUERY)
        read("")
        if (raw !== "" && !DA1_AT_START.test(raw)) replyBeforeDa1 = raw
      }
    }
    return silentResult(name, "buffer_state", readings, 'text "X", cursor row 0 col 1', control, replyBeforeDa1)
  }
}

function silentApp(name: string, reports: readonly Report[], checkNoReply = false) {
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
    let replyBeforeDa1: string | undefined
    if (checkNoReply && typeof ctx.queryOutcome === "function") {
      for (const report of reports) ctx.write(report.bytes)
      const da1 = await ctx.queryOutcome(DA1_QUERY, DA1_REPLY)
      if (da1.reason !== "reply" || !da1.raw) {
        return replyFailure(`${name}: no DA1 reply after reports`)
      }
      if (!DA1_AT_START.test(da1.raw)) {
        replyBeforeDa1 = da1.raw
      }
    }
    return silentResult(name, "buffer_state", readings, "cursor row 1 col 1", control, replyBeforeDa1)
  }
}

export const programResumeProbes: ProbeDefinition[] = [
  probe("extensions.osc7577-token", tokenLibraryReview, tokenAppResult, "process_environment"),
  {
    ...probe(
      "extensions.osc7577-silent",
      silentLib("OSC 7577", OSC7577_REPORTS, true),
      silentApp("OSC 7577", OSC7577_REPORTS, true),
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
