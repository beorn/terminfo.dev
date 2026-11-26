/**
 * @failure An inherited, unbound or malformed OSC7577_TOKEN decides the program-resume row, or the secret leaks.
 * @level l1
 * @consumer The terminal-child environment reader and the extensions.osc7577-token callback (#38699, spec rev 0.5).
 * @testonly none
 */
import { afterEach, expect, test, vi } from "vitest"
import {
  readTermFeaturesEnvironment,
  readTerminalChildEnvironment,
} from "../terminfo.dev/src/terminal-child-environment.ts"
import { extensionsProbes } from "../probe-defs/src/extensions.ts"
import { recordExecutedProbe } from "../probe-defs/src/helpers.ts"
import type { LibProbeSource, ProgramResumeTokenReading, TermProbeSource } from "@terminfo/probe-defs"

const RUN = "a".repeat(32)
const TTY = "tty_nr=34816;fd=1;rdev=34816"
const bound = { TERMINFO_RUN_ID: RUN, TERMINFO_TERM_FEATURES_LAUNCH: RUN }
const WELL_FORMED = "Q2xhdWRlLXRlc3QtdG9rZW4tMDEyMzQ1Njc4OQ"

afterEach(() => vi.restoreAllMocks())

function definition() {
  const found = extensionsProbes.find((item) => item.id === "extensions.osc7577-token")
  if (!found?.term || !found.lib) throw new Error("missing extensions.osc7577-token arms")
  return found as typeof found & { term: NonNullable<typeof found.term>; lib: NonNullable<typeof found.lib> }
}

async function grade(reading: ProgramResumeTokenReading) {
  return definition().term({ readProgramResumeToken: async () => reading } as unknown as TermProbeSource)
}

function status(result: Awaited<ReturnType<typeof grade>>) {
  return recordExecutedProbe({
    featureId: "extensions.osc7577-token",
    attempt: { scope: "probe", startedAt: "2026-11-26T01:00:00.000Z" },
    assertions: result.assertions ?? [],
    tests: result.tests,
    ...(result.observation && { observation: result.observation }),
    ...(result.notTested && { coverage: result.notTested }),
  } as Parameters<typeof recordExecutedProbe>[0]).status
}

test("one reader binds both variables to the same run; TERM_FEATURES readings are unchanged", () => {
  const env = { ...bound, TERM_FEATURES: "T3", OSC7577_TOKEN: WELL_FORMED }
  const both = readTerminalChildEnvironment(env, RUN, 42, TTY)
  expect(both.termFeatures).toEqual(readTermFeaturesEnvironment(env, RUN, 42, TTY))
  expect(both.programResumeToken).toEqual({
    status: "measured",
    present: true,
    length: WELL_FORMED.length,
    runId: RUN,
    launchMarker: RUN,
    pid: 42,
    tty: TTY,
  })
  for (const delta of [{ TERMINFO_RUN_ID: "e".repeat(32) }, { TERMINFO_TERM_FEATURES_LAUNCH: undefined }]) {
    const unbound = readTerminalChildEnvironment({ ...env, ...delta }, RUN, 42, TTY)
    expect(unbound.programResumeToken.status).toBe("unavailable")
    expect(unbound.termFeatures.status).toBe("unavailable")
  }
  expect(readTerminalChildEnvironment(env, RUN, 0, TTY).programResumeToken.status).toBe("invalid")
})

// @cto ee6b7fd9: the token is a secret. A malformed one is named by the rule it broke, and its bytes appear nowhere:
// not in the reading, the graded result, the refusal text or any log line.
test.each([
  { token: "LEAKMARKER", rule: "length" },
  { token: "LEAKMARKER-" + "x".repeat(60), rule: "length" },
  { token: "LEAKMARKER.has.a.dot.in.it.000", rule: "charset" },
  { token: "LEAKMARKER\nnot printable 0000", rule: "charset" },
])("a malformed token ($rule) is named by its rule and never recorded", async ({ token, rule }) => {
  const logged: unknown[] = []
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args))
  }
  const reading = readTerminalChildEnvironment({ ...bound, OSC7577_TOKEN: token }, RUN, 42, TTY).programResumeToken
  expect(reading).toMatchObject({ status: "measured", present: true, malformed: rule })
  const result = await grade(reading)
  expect(status(result)).toBe("unsupported")
  expect(result.note).toContain(rule === "length" ? "22-64 characters" : "[A-Za-z0-9_-]")
  for (const carrier of [reading, result, logged]) expect(JSON.stringify(carrier)).not.toContain("LEAKMARKER")
})

test("a well-formed token reads Supported with no bytes retained; absence under this run's marker is Unsupported", async () => {
  const present = readTerminalChildEnvironment({ ...bound, OSC7577_TOKEN: WELL_FORMED }, RUN, 42, TTY)
  const supported = await grade(present.programResumeToken)
  expect(status(supported)).toBe("supported")
  expect(supported.observation).toMatchObject({ outcome: "supported", assertionType: "process_environment" })
  expect(JSON.stringify(supported)).not.toContain(WELL_FORMED)
  const absent = await grade(readTerminalChildEnvironment(bound, RUN, 42, TTY).programResumeToken)
  expect(status(absent)).toBe("unsupported")
  expect(absent.assertions).toMatchObject([{ kind: "negative", observed: "absent" }])
})

test("inside a mux a present token stays PROBE TODO; absence there is Unsupported", async () => {
  const base = { status: "measured", runId: RUN, launchMarker: RUN, pid: 42, tty: TTY, mux: "tmux" } as const
  const present = await grade({ ...base, present: true, length: 38 })
  expect(present.observation).toBeUndefined()
  expect(present.notTested?.noObservable).toContain("inside tmux")
  expect(status(await grade({ ...base, present: false, length: 0 }))).toBe("unsupported")
})

test("no reader, an unbound child or a library context never decides the row", async () => {
  expect((await definition().term({} as TermProbeSource)).observation).toBeUndefined()
  const unbound = await grade({ status: "unavailable", reason: "no marker" })
  expect(unbound.observation).toBeUndefined()
  const invalid = await grade({ status: "invalid", reason: "bad binding" })
  expect(invalid.tests?.[0]?.status).toBe("probe-invalid")
  const lib = definition().lib({} as LibProbeSource)
  expect(lib.observation).toBeUndefined()
  expect(JSON.stringify(lib)).toContain("spawns no application child")
})
