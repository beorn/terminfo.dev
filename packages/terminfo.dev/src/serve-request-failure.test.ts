/**
 * @failure A failed probe-daemon request points an operator at a draft record that was never reserved.
 * @level l1
 * @consumer probe daemon operators reading the request failure line
 * @testonly none
 */
import { expect, test } from "vitest"
import { probeDraftPath, requestFailurePrefix } from "./serve.ts"

// 34959: the failure line named `draft <path>` whenever a run id was known, but a request refused before
// admission reserved no draft, so that path could not exist. A reader following it looks for a file that
// was never written; the line must say where the run actually stopped.
test("34959 a pre-admission failure does not name a draft that was never reserved", () => {
  const runId = "a".repeat(32)
  const beforeAdmission = requestFailurePrefix(runId, false)
  expect(beforeAdmission).toContain(runId)
  expect(beforeAdmission).not.toContain(probeDraftPath(runId))
  expect(beforeAdmission).toContain("before its draft was reserved")
})

test("34959 a post-admission failure still names the draft holding custody", () => {
  const runId = "b".repeat(32)
  expect(requestFailurePrefix(runId, true)).toBe(
    `Probe daemon request failed for run ${runId}, draft ${probeDraftPath(runId)}:`,
  )
})

test("34959 a failure with no run id names neither a run nor a draft", () => {
  expect(requestFailurePrefix(undefined, false)).toBe("Probe daemon request failed:")
})
