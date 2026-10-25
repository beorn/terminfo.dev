/**
 * @failure Retained trace assertions lose individual matcher results, stop after a soft failure, or treat time/random-dependent replay as a terminal-negative result.
 * @level l1
 * @consumer The admitted private check-record experiment over immutable spike A evidence
 * @reach fs-read /hh/var/@dev10/30922/xtermjs-r1/traces/sgr.bold.json
 * @reach fs-read /hh/var/@dev10/30924/storage-r1/source-a/call-log.ts
 * @reach fs-write /hh/var/@dev10/30925/checks-<invocation>/report.json
 * @testonly none
 */
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { createCellView } from "@termless/core"
import { terminalMatchers } from "@termless/test/matchers"
import { afterAll, beforeAll, describe, expect, test, vi, type TestContext } from "vitest"

const evidence = "/hh/var/@dev10/30925"
const tracePath = "/hh/var/@dev10/30922/xtermjs-r1/traces/sgr.bold.json"
const recorderPath = "/hh/var/@dev10/30924/storage-r1/source-a/call-log.ts"
const traceHash = "d796bb3dd8f2fb9c6b40f9b52df713a2506e1823f9a5a9c6e20f31286a9e7a73"
const recorderHash = "4c8caf5c000ffffdfd267e8424a7095515e16fafcc9a29593c40571fcbde0ca0"
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")

type Matcher = "toBeBold" | "toBeItalic" | "toHaveAttrs" | "toBe" | "toEqual" | "toBranchOnTime" | "toBranchOnRandom"
type Mode = "record" | "replay"
type CheckRecord = {
  step: number
  matcher: Matcher
  arguments: unknown[]
  expected: unknown
  actual: unknown
  ok: boolean | null
  incomplete?: string
}
type Context = {
  feed(bytes: string): void
  getCell(row: number, col: number): Parameters<typeof createCellView>[0]
}
type Recorder = {
  IncompleteReplay: new (message: string) => Error
  withCallLog<Subject extends object>(
    subject: null,
    options: { mode: "replay"; log: unknown },
  ): { context: Subject; finish(): void }
}
type Journey = { rows: CheckRecord[]; errors: Array<{ name?: string; message: string }>; completed: boolean }
type TemporalResult = {
  rows: CheckRecord[]
  error: string
  sticky: boolean
  errors: Array<{ name?: string; message: string }>
}

let recorder: Recorder
let output: string
const journeys: Partial<Record<Mode, Journey>> = {}
const temporal: Partial<Record<"time" | "random", TemporalResult>> = {}

function nativeErrors(context: TestContext) {
  const errors = context.task.result?.errors
  return errors ? errors.map(({ name, message }) => ({ name, message })) : []
}

function withChecks(context: TestContext, mode: Mode) {
  const rows: CheckRecord[] = []
  let failure: Error | undefined
  const currentFailure = () => failure
  const nondeterministic = (source: string): never => {
    failure = new recorder.IncompleteReplay(`matcher depends on ${source}`)
    throw failure
  }
  return {
    rows,
    check(matcher: Matcher, received: unknown, ...arguments_: unknown[]) {
      if (failure) throw failure
      let actual = received
      let expected = arguments_[0]
      if (matcher === "toBeBold" || matcher === "toBeItalic") {
        actual = Reflect.get(Object(received), matcher === "toBeBold" ? "bold" : "italic")
        expected = true
      } else if (matcher === "toHaveAttrs") {
        actual = Object.fromEntries(
          Object.keys(Object(expected)).map((key) => [key, Reflect.get(Object(received), key)]),
        )
      }
      const assertion = context.expect.soft(received)
      const method: unknown = Reflect.get(assertion, matcher)
      if (typeof method !== "function") throw new Error(`Installed matcher missing: ${matcher}`)
      const errorsBefore = nativeErrors(context).length
      const originalNow = Date.now
      const originalRandom = Math.random
      try {
        if (mode === "replay") {
          Date.now = () => nondeterministic("Date.now")
          Math.random = () => nondeterministic("Math.random")
        }
        Reflect.apply(method, assertion, arguments_)
      } finally {
        Date.now = originalNow
        Math.random = originalRandom
      }
      const incomplete = currentFailure()
      rows.push({
        step: rows.length + 1,
        matcher,
        arguments: structuredClone(arguments_),
        expected: structuredClone(expected),
        actual: structuredClone(actual),
        ok: incomplete ? null : nativeErrors(context).length === errorsBefore,
        ...(incomplete ? { incomplete: incomplete.message } : {}),
      })
      if (failure) throw failure
    },
    finish() {
      if (failure) throw failure
    },
  }
}

beforeAll(async () => {
  expect(sha256(tracePath)).toBe(traceHash)
  expect(sha256(recorderPath)).toBe(recorderHash)
  expect(Object.keys(terminalMatchers)).toEqual(expect.arrayContaining(["toBeBold", "toBeItalic", "toHaveAttrs"]))
  recorder = await import(pathToFileURL(recorderPath).href)
  output = mkdtempSync(join(evidence, "checks-"))
  expect.extend({
    toBranchOnTime(received: number, expected: number) {
      const comparison = Date.now() % 2 === 0 ? expected : expected + 1
      return { pass: received === comparison, message: () => "time-dependent matcher" }
    },
    toBranchOnRandom(received: number, expected: number) {
      const comparison = Math.random() < 0.5 ? expected : expected + 1
      return { pass: received === comparison, message: () => "random-dependent matcher" }
    },
  })
})

describe("private check records on retained A evidence", () => {
  for (const mode of ["record", "replay"] as const) {
    test.fails(`native soft failure continues during ${mode}`, (context) => {
      const stored = JSON.parse(readFileSync(tracePath, "utf8"))
      if (typeof stored !== "object" || stored === null || !("log" in stored)) {
        throw new Error(`Retained spike A fixture missing log: ${tracePath}`)
      }
      const replay = recorder.withCallLog<Context>(null, { mode: "replay", log: stored.log })
      const checks = withChecks(context, mode)
      replay.context.feed("\u001b[1mX")
      const cell = createCellView(replay.context.getCell(0, 0), 0, 0)
      checks.check("toBeBold", cell)
      checks.check("toBeItalic", cell)
      checks.check("toHaveAttrs", cell, { bold: true })
      checks.check("toBe", cell.char, "X")
      checks.check("toEqual", [cell.row, cell.col], [0, 0])
      replay.finish()
      checks.finish()
      journeys[mode] = { rows: checks.rows, errors: nativeErrors(context), completed: true }
    })
  }

  for (const kind of ["time", "random"] as const) {
    test.fails(`nondeterministic ${kind} matcher remains Incomplete`, (context) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(0)
      const random = vi.spyOn(Math, "random").mockReturnValue(0)
      const checks = withChecks(context, "replay")
      let failure: unknown
      let finishFailure: unknown
      try {
        try {
          checks.check(kind === "time" ? "toBranchOnTime" : "toBranchOnRandom", 1, 1)
        } catch (error) {
          failure = error
        }
        try {
          checks.finish()
        } catch (error) {
          finishFailure = error
        }
        temporal[kind] = {
          rows: checks.rows,
          error: String(failure),
          sticky: failure !== undefined && failure === finishFailure,
          errors: nativeErrors(context),
        }
        context.expect(failure).toBeInstanceOf(recorder.IncompleteReplay)
      } finally {
        clock.mockRestore()
        random.mockRestore()
      }
    })
  }

  test("independent oracle checks every row, continuation, ordering and Incomplete reason", () => {
    const expected: CheckRecord[] = [
      { step: 1, matcher: "toBeBold", arguments: [], expected: true, actual: true, ok: true },
      { step: 2, matcher: "toBeItalic", arguments: [], expected: true, actual: false, ok: false },
      {
        step: 3,
        matcher: "toHaveAttrs",
        arguments: [{ bold: true }],
        expected: { bold: true },
        actual: { bold: true },
        ok: true,
      },
      { step: 4, matcher: "toBe", arguments: ["X"], expected: "X", actual: "X", ok: true },
      { step: 5, matcher: "toEqual", arguments: [[0, 0]], expected: [0, 0], actual: [0, 0], ok: true },
    ]
    for (const mode of ["record", "replay"] as const) {
      expect(journeys[mode]?.completed).toBe(true)
      expect(journeys[mode]?.rows).toEqual(expected)
      expect(journeys[mode]?.errors).toEqual([
        { name: "Error", message: "Expected cell (0,0) containing 'X' to be italic" },
      ])
    }
    for (const kind of ["time", "random"] as const) {
      const reason = `Incomplete: matcher depends on ${kind === "time" ? "Date.now" : "Math.random"}`
      expect(temporal[kind]?.sticky).toBe(true)
      expect(temporal[kind]?.error).toBe(`IncompleteReplay: ${reason}`)
      expect(temporal[kind]?.errors).toEqual([{ name: "IncompleteReplay", message: reason }])
      expect(temporal[kind]?.rows).toEqual([
        {
          step: 1,
          matcher: kind === "time" ? "toBranchOnTime" : "toBranchOnRandom",
          arguments: [1],
          expected: 1,
          actual: 1,
          ok: null,
          incomplete: reason,
        },
      ])
    }
  })
})

afterAll(() => {
  const afterHashes = { trace: sha256(tracePath), recorder: sha256(recorderPath) }
  expect(afterHashes).toEqual({ trace: traceHash, recorder: recorderHash })
  writeFileSync(
    join(output, "report.json"),
    `${JSON.stringify({ tracePath, recorderPath, afterHashes, journeys, temporal }, null, 2)}\n`,
  )
  console.info(`CHECK_RECORD_EVIDENCE ${output}`)
})
