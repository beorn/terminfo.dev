import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { recordArtifact, test, type TestArtifactBase } from "vitest"
import { withChecks, type RetainedCheck } from "../checks.ts"

interface Check {
  taskId: string
  label: string
  received: number
  expected: number
  ok: boolean
}

export interface RuntimeArtifact extends TestArtifactBase {
  type: "terminfo:runtime-proof"
  taskId: string
  checks: Check[]
  retainedChecks: readonly RetainedCheck[]
}

interface RuntimeFinalRecord {
  taskId: string
  checks: Check[]
  retainedChecks: readonly RetainedCheck[]
}

const artifactKey = Symbol("terminfo-runtime-proof")
declare module "vitest" {
  interface TestArtifactRegistry {
    [artifactKey]: RuntimeArtifact
  }
  interface TaskMeta {
    terminfoRuntimeProof?: RuntimeFinalRecord
    terminfoMatcherEvaluations?: number
    terminfoCheckContract?: { finishThrew: boolean; prematureCount: number | null }
  }
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> {
    toRecorderRuntimeEqual(expected: number): R
  }
}

let matcherEvaluations = 0
const matchers = {
  toRecorderRuntimeEqual(received: number, expected: number) {
    matcherEvaluations++
    return {
      pass: received === expected,
      actual: received,
      expected,
      message: () => "runtime proof deliberately includes a soft mismatch",
    }
  },
}

let arrivals = 0
let release: () => void
const bothRunning = new Promise<void>((resolve) => {
  release = resolve
})

// A caught integration error must not certify an empty result while its matcher is still running.
test("a matcher cannot finish its own active check session", (context) => {
  let prematureCount: number | null = null
  const session = withChecks(context, {
    mode: "replay",
    matchers: {
      toFinishInsideMatcher(received: number) {
        prematureCount = session.finish().length
        return { pass: received === 1, actual: received, expected: 1, message: () => "premature finish" }
      },
    },
  })
  try {
    session.check("toFinishInsideMatcher", 1)
  } catch {
    // Deliberately caught: the runner-owned finish must still reject this session.
  }
  let finishThrew = false
  try {
    session.finish()
  } catch (error) {
    finishThrew = error instanceof Error && error.name === "IncompleteReplay"
  }
  context.task.meta.terminfoCheckContract = { finishThrew, prematureCount }
})

// These remain real failed tasks; the outer test verifies the exact soft failure and final records.
test.concurrent.for([
  ["left", 10],
  ["right", 20],
] as const)("native soft continuation %s", async ([label, value], context) => {
  const checks: Check[] = []
  let retainedChecks: readonly RetainedCheck[] = []
  const session = withChecks(context, { mode: "replay", matchers })
  const directory = await mkdtemp(join(tmpdir(), "terminfo-runtime-checks-"))
  try {
    session.check("toRecorderRuntimeEqual", value, value + 1)
    if (++arrivals === 2) release()
    await bothRunning
    session.precondition("toRecorderRuntimeEqual", value, value)
    retainedChecks = session.finish()
    for (const check of retainedChecks) {
      checks.push({
        taskId: context.task.id,
        label,
        received: check.actual as number,
        expected: check.expected as number,
        ok: check.ok,
      })
    }
    context.task.meta.terminfoMatcherEvaluations = matcherEvaluations
    const path = join(directory, "checks.json")
    await writeFile(path, JSON.stringify(retainedChecks))
    const artifact: RuntimeArtifact = {
      type: "terminfo:runtime-proof",
      taskId: context.task.id,
      checks,
      retainedChecks,
      attachments: [{ path, contentType: "application/json" }],
    }
    await recordArtifact(context.task, artifact)
  } finally {
    context.task.meta.terminfoRuntimeProof = { taskId: context.task.id, checks, retainedChecks }
    await rm(directory, { recursive: true, force: true })
  }
})
