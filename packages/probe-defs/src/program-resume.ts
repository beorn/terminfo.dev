/**
 * OSC 7577 program resume, spec revision 0.5 (2026-11-25), #38699. A terminal advertises support only by putting
 * `OSC7577_TOKEN` in each pane's first process; there is no query and no reply. The row reads that export through the
 * verified terminal child's environment, the same reader and binding as TERM_FEATURES (@cto ee6b7fd9).
 */
import type { ProbeCallbackResult, ProbeDefinition, TermProbeSource } from "./types.ts"
import { declaredUntestableResult, notTestedResult, probe } from "./helpers.ts"

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

export const programResumeProbes: ProbeDefinition[] = [
  probe("extensions.osc7577-token", tokenLibraryReview, tokenAppResult, "process_environment"),
]
