import type { AppSemanticReading, ProbeCallbackResult } from "./types.ts"
import { parserStateResult } from "./helpers.ts"

/** One grader for the owned reader. An App's identity selects its reader outside this package. */
export function gradeAppSemanticState(reading: AppSemanticReading): ProbeCallbackResult {
  const pending = (reason: string, invalid = false): ProbeCallbackResult => ({
    pass: false,
    response: JSON.stringify(reading),
    note: reason,
    tests: [{ id: "criterion", status: invalid ? "probe-invalid" : "probe-todo", reason }],
  })
  if (reading.status !== "measured") return pending(reading.reason, reading.status === "invalid")
  if (reading.reader === "report") {
    if (
      reading.unknown.reports.length === 0 ||
      reading.unknown.reports.some((code) => code !== reading.unknown.code) ||
      !reading.handled.applied ||
      reading.handled.reports.length !== 0
    ) {
      return pending("App exact-command log controls failed in this row", true)
    }
    if (reading.target.reports.length > 0 && reading.target.reports.every((code) => code === reading.target.code)) {
      return parserStateResult(false, "App reported this exact command as unhandled", reading)
    }
    return pending("App log has no qualified exact-command refusal; silence does not decide support")
  }
  if (
    reading.unknown.before !== reading.unknown.after ||
    reading.handled.before === reading.handled.expected ||
    reading.handled.after !== reading.handled.expected
  ) {
    return pending("App semantic-state controls failed in this row", true)
  }
  if (reading.target.before === reading.target.expected) {
    return pending("App target state was already present before this row's command")
  }
  if (reading.target.after === reading.target.expected) {
    return parserStateResult(true, "App stores this row's semantic state; unknown command leaves it unchanged", reading)
  }
  if (reading.target.after === reading.target.before) {
    return parserStateResult(
      false,
      "App semantic control changes its own state; this command leaves it unchanged",
      reading,
    )
  }
  return pending("App semantic target changed to an unexpected state")
}
