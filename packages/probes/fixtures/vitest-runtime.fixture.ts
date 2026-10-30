import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, recordArtifact, test, type MatcherState, type RunnerTestCase, type TestArtifactBase } from "vitest"

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
}

interface RuntimeFinalRecord {
  taskId: string
  checks: Check[]
}

const artifactKey = Symbol("terminfo-runtime-proof")
declare module "vitest" {
  interface TestArtifactRegistry {
    [artifactKey]: RuntimeArtifact
  }
  interface TaskMeta {
    terminfoRuntimeProof?: RuntimeFinalRecord
  }
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> {
    toRecorderRuntimeEqual(expected: number): R
  }
}

const sessions = new WeakMap<Readonly<RunnerTestCase>, { label: string; checks: Check[] }>()
expect.extend({
  toRecorderRuntimeEqual(this: MatcherState & { task?: RunnerTestCase }, received: number, expected: number) {
    const task = this.task
    const session = task && sessions.get(task)
    if (!task || !session) throw new Error("The public matcher task did not identify its test session")
    const pass = received === expected
    session.checks.push({ taskId: task.id, label: session.label, received, expected, ok: pass })
    return { pass, actual: received, expected, message: () => "runtime proof deliberately includes a soft mismatch" }
  },
})

let arrivals = 0
let release: () => void
const bothRunning = new Promise<void>((resolve) => {
  release = resolve
})

// These remain real failed tasks; the outer test verifies the exact soft failure and final records.
test.concurrent.for([
  ["left", 10],
  ["right", 20],
] as const)("native soft continuation %s", async ([label, value], context) => {
  const checks: Check[] = []
  sessions.set(context.task, { label, checks })
  const directory = await mkdtemp(join(tmpdir(), "terminfo-runtime-checks-"))
  try {
    context.expect.soft(value).toRecorderRuntimeEqual(value + 1)
    if (++arrivals === 2) release()
    await bothRunning
    context.expect.soft(value).toRecorderRuntimeEqual(value)
    const path = join(directory, "checks.json")
    await writeFile(path, JSON.stringify(checks))
    const artifact: RuntimeArtifact = {
      type: "terminfo:runtime-proof",
      taskId: context.task.id,
      checks,
      attachments: [{ path, contentType: "application/json" }],
    }
    await recordArtifact(context.task, artifact)
  } finally {
    context.task.meta.terminfoRuntimeProof = { taskId: context.task.id, checks }
    await rm(directory, { recursive: true, force: true })
  }
})
