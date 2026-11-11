/**
 * @failure An alternate-screen exit that the run never reached reads Probe to-do "switching did not show", although
 *   the same run read the entry Unsupported (#32785; operator yes on card terminfo-untestable-1110, Nov 10 2026).
 *   The batch tail must make that step Untestable through the one declared form the run reader admits, naming the
 *   entry and its result, when and only when the step is still Probe to-do and the entry is Unsupported; any other
 *   entry result, an absent entry, or a decided step stays exactly as it reads.
 * @level l1
 * @consumer The runProbeBatch tail pass applyUnreachedSteps.
 * @testonly none
 */
import { expect, test } from "vitest"
import { isDeclaredUntestable, type ProbeResult } from "@terminfo/probe-defs"
import { applyUnreachedSteps, UNREACHED_STEPS } from "./unified.ts"

const attempt = { scope: "probe" as const, startedAt: "2026-11-10T19:30:00.000Z" }
const OPEN = "Open: switching to the alternate screen did not show, so we cannot tell whether switching back worked."

const exit = (status: ProbeResult["status"]): ProbeResult =>
  ({
    featureId: "modes.alt-screen.exit",
    status,
    attempt,
    ...(status === "probe-todo" ? { reason: OPEN } : {}),
    tests: [{ id: status === "probe-todo" ? "entry-qualified" : "criterion", status, attempt, reason: OPEN }],
  }) as unknown as ProbeResult

const enter = (status: ProbeResult["status"]): ProbeResult =>
  ({ featureId: "modes.alt-screen.enter", status, attempt, tests: [] }) as unknown as ProbeResult

const UNREACHED =
  "Untestable (no setup): this run reads switching to the alternate screen (modes.alt-screen.enter) Unsupported, so this step was never reached and was not measured."

test("the pair is data and names no terminal", () => {
  expect(UNREACHED_STEPS).toEqual([
    expect.objectContaining({ step: "modes.alt-screen.exit", entry: "modes.alt-screen.enter" }),
  ])
})

test("an open exit beside an Unsupported entry reads Untestable, naming the entry, and the entry keeps its result", () => {
  const batch = { results: [enter("unsupported"), exit("probe-todo")] }
  applyUnreachedSteps(batch)
  const step = batch.results[1]!
  expect(step).toMatchObject({ status: "untestable", reason: UNREACHED, attempt })
  expect(step.tests).toMatchObject([{ id: "declared-untestable", status: "untestable", reason: UNREACHED, attempt }])
  expect(isDeclaredUntestable(step)).toBe(true)
  expect(batch.results[0]!.status).toBe("unsupported")
})

test.each([
  ["entry Probe to-do", [enter("probe-todo"), exit("probe-todo")]],
  ["entry Probe invalid", [enter("probe-invalid"), exit("probe-todo")]],
  ["entry Supported", [enter("supported"), exit("probe-todo")]],
  ["entry absent from the run", [exit("probe-todo")]],
  ["exit already decided", [enter("unsupported"), exit("supported")]],
  ["exit not attempted in this run", [enter("unsupported"), { ...exit("probe-todo"), attempt: { scope: "none" } }]],
] as const)("%s leaves the exit exactly as it reads", (_name, results) => {
  const batch = { results: results.map((result) => structuredClone(result)) }
  applyUnreachedSteps(batch)
  expect(batch.results).toEqual(results)
})
