/**
 * @failure App state or stderr grades a feature without this row's controls, or silence
 *   becomes Supported. Existing library report tests never exercise the owned App reader.
 * @level l2
 * @consumer The registered native OSC callbacks and their App semantic-state grader.
 * @testonly none
 */
import { expect, test } from "vitest"
import { gradeAppSemanticState, gradeIconNameReading, withAppSemanticObservation } from "./app-semantic-state.ts"
import type { AppSemanticReading } from "./types.ts"
import { declaredUntestableResult, parserStateResult } from "./helpers.ts"
import { extensionsProbes } from "./extensions.ts"
import { replayTermProbeSource } from "./testing/group-harness.ts"

const state = (): AppSemanticReading => ({
  status: "measured",
  reader: "state",
  runId: "a".repeat(32),
  unknown: { before: "NONE", after: "NONE" },
  handled: { before: "NONE", after: "START_PROMPT", expected: "START_PROMPT" },
  target: { before: "NONE", after: "START_COMMAND", expected: "START_COMMAND" },
  detail: { literalGrid: "retained diagnostic bytes" },
})

const report = (): AppSemanticReading => ({
  status: "measured",
  reader: "report",
  runId: "a".repeat(32),
  unknown: { code: "7654", reports: ["7654"] },
  handled: { applied: true, reports: [] },
  target: { code: "633", reports: ["633"] },
  detail: { appended: "Ignoring OSC 633", startOffset: 200, endOffset: 240 },
})

test("state decides only a fresh target transition behind both same-path controls", () => {
  const reading = state()
  expect(gradeAppSemanticState(reading)).toMatchObject({
    observation: { outcome: "supported", assertionType: "buffer_state" },
    assertions: [{ kind: "positive" }],
  })
  if (reading.status !== "measured" || reading.reader !== "state") throw Error("state fixture")
  expect(gradeAppSemanticState({ ...reading, target: { ...reading.target, after: "NONE" } })).toMatchObject({
    observation: { outcome: "unsupported" },
    assertions: [{ kind: "negative" }],
  })
  for (const changed of [
    { ...reading, unknown: { before: "NONE", after: "START_PROMPT" } },
    { ...reading, handled: { ...reading.handled, after: "NONE" } },
  ]) {
    expect(gradeAppSemanticState(changed)).toMatchObject({ tests: [{ status: "probe-invalid" }] })
  }
  expect(gradeAppSemanticState({ ...reading, target: { ...reading.target, before: "START_COMMAND" } })).toMatchObject({
    tests: [{ status: "probe-todo" }],
  })
  expect(gradeAppSemanticState({ ...reading, target: { ...reading.target, after: "unrecognized" } })).toMatchObject({
    tests: [{ status: "probe-todo" }],
  })
})

test("a fresh exact-command report gives only Unsupported; empty or unrelated logs decide nothing", () => {
  const reading = report()
  expect(gradeAppSemanticState(reading)).toMatchObject({ observation: { outcome: "unsupported" } })
  if (reading.status !== "measured" || reading.reader !== "report") throw Error("report fixture")
  for (const reports of [[], ["133"], ["633", "7654"]]) {
    expect(gradeAppSemanticState({ ...reading, target: { ...reading.target, reports } })).toMatchObject({
      tests: [{ status: "probe-todo" }],
    })
  }
  for (const changed of [
    { ...reading, unknown: { code: "7654", reports: [] } },
    { ...reading, handled: { applied: false, reports: [] } },
    { ...reading, handled: { applied: true, reports: ["2"] } },
  ]) {
    expect(gradeAppSemanticState(changed)).toMatchObject({ tests: [{ status: "probe-invalid" }] })
  }
  expect(JSON.parse(gradeAppSemanticState(reading).response!)).toEqual(reading)
})

test("missing reader stays pending and a broken owned read stays invalid", () => {
  expect(gradeAppSemanticState({ status: "unavailable", reason: "unreviewed exact App version" })).toMatchObject({
    tests: [{ status: "probe-todo", reason: "unreviewed exact App version" }],
  })
  expect(gradeAppSemanticState({ status: "invalid", reason: "owned log rotated" })).toMatchObject({
    tests: [{ status: "probe-invalid", reason: "owned log rotated" }],
  })
})

test("registered OSC callbacks forward their own feature and recorded writer to the owned reader", async () => {
  for (const id of [
    "extensions.osc7-cwd",
    "extensions.osc133-a",
    "extensions.osc133-b",
    "extensions.osc133-c",
    "extensions.osc133-d",
    "extensions.osc133-p",
    "extensions.semantic-prompts",
    "extensions.osc633-a",
    "extensions.osc633-b",
    "extensions.osc633-c",
    "extensions.osc633-d",
    "extensions.osc633-e",
    "extensions.osc633-p",
    "extensions.osc-633-vscode",
  ]) {
    const ctx = replayTermProbeSource(new Map())
    const seen: string[] = []
    ctx.readAppSemanticState = async (featureId, write) => {
      seen.push(featureId)
      expect(write).toBe(ctx.write)
      return id === "extensions.osc7-cwd" ? state() : report()
    }
    const definition = extensionsProbes.find((probe) => probe.id === id)!
    expect(await definition.term!(ctx), id).toMatchObject({
      observation: { outcome: id === "extensions.osc7-cwd" ? "supported" : "unsupported" },
    })
    expect(seen).toEqual([id])
  }
})

test("OSC7 preserves its existing App observation when the owned semantic reader is unavailable", async () => {
  const previous = parserStateResult(true, "qualified existing title observation", {})
  const source = replayTermProbeSource(new Map(), {
    readAppSemanticState: async () => ({ status: "unavailable", reason: "another exact App" }),
  })
  const wrapped = withAppSemanticObservation({ id: "extensions.osc7-cwd", lib: null, term: async () => previous })
  expect(await wrapped.term!(source)).toBe(previous)
})

// Library icon getters never exercise the native callback binding. A native pair
// must decide these effects even when both label-report queries are silent.
test.each(["extensions.osc0-icon-title", "extensions.osc1-icon"])(
  "%s uses independent native icon/title state and preserves its unavailable fallback",
  async (id) => {
    const pair = (title: string, icon: string) => JSON.stringify([title, icon])
    const before = pair("title-control", "icon-control")
    const expected = pair(id.includes("osc0") ? "target" : "title-control", "target")
    const reading: AppSemanticReading = {
      status: "measured",
      reader: "state",
      runId: "a".repeat(32),
      unknown: { before, after: before },
      handled: { before: pair("original", "original"), after: before, expected: before },
      target: { before, after: expected, expected },
      detail: { title: "independent owned title", icon: "owned native icon property" },
    }
    const source = replayTermProbeSource(new Map())
    const seen: string[] = []
    source.readAppSemanticState = async (featureId, write) => {
      seen.push(featureId)
      expect(write).toBe(source.write)
      return reading
    }
    const definition = extensionsProbes.find((probe) => probe.id === id)!
    expect(await definition.term!(source)).toMatchObject({ observation: { outcome: "supported" } })
    expect(seen).toEqual([id])
    source.readAppSemanticState = async () => ({ ...reading, target: { before, after: before, expected } })
    expect((await definition.term!(source)).observation).toMatchObject({ outcome: "unsupported" })
    const previous = parserStateResult(true, "existing qualified native observation", {})
    let termCalled = false
    source.readAppSemanticState = async () => ({ status: "unavailable", reason: "no X11 window" })
    const wrapped = withAppSemanticObservation({
      id,
      lib: null,
      term: async () => {
        termCalled = true
        return previous
      },
    })
    const gap = await wrapped.term!(source)
    expect(termCalled).toBe(false)
    expect(gap.observation).toBeUndefined()
    expect(gap.tests).toEqual([{ id: "criterion", status: "probe-todo", reason: "no X11 window" }])
    source.readAppSemanticState = async () => ({ status: "invalid", reason: "owner revoked" })
    expect(await wrapped.term!(source)).toMatchObject({ tests: [{ status: "probe-invalid" }] })
  },
)

test.each(["extensions.osc0-icon-title", "extensions.osc1-icon"])(
  "%s grades icon name B, OSC 0 C, and an OSC 1 title that became B",
  (id) => {
    const osc1 = id === "extensions.osc1-icon"
    const reading = (
      titleAfter: string,
      iconAfter: string | null,
      iconBefore: string | null = "before",
    ): AppSemanticReading => ({
      status: "measured",
      reader: "state",
      runId: "a".repeat(32),
      unknown: { before: "[]", after: "[]" },
      handled: { before: "[]", after: "[]", expected: "[]" },
      target: {
        before: JSON.stringify(["A", iconBefore]),
        after: JSON.stringify([titleAfter, iconAfter]),
        expected: JSON.stringify(["A", "B"]),
      },
      detail: {},
    })
    expect(gradeIconNameReading(id, reading("A", "B"))).toMatchObject({ observation: { outcome: "supported" } })
    expect(gradeIconNameReading(id, reading("A", null)).observation).toMatchObject({ outcome: "unsupported" })
    expect(gradeIconNameReading(id, reading("A", "A")).observation).toMatchObject({ outcome: "unsupported" })
    expect(gradeIconNameReading(id, reading("A", "before")).observation).toMatchObject({ outcome: "unsupported" })
    if (osc1) {
      const aliased = gradeIconNameReading(id, reading("B", "B"))
      expect(aliased.observation).toMatchObject({ outcome: "unsupported" })
      expect(aliased.note).toContain("Seen title")
      expect(gradeIconNameReading(id, reading("A", "C")).observation).toMatchObject({ outcome: "unsupported" })
    } else {
      expect(gradeIconNameReading(id, reading("B", "B")).observation).toMatchObject({ outcome: "supported" })
      expect(gradeIconNameReading(id, reading("B", "C")).observation).toMatchObject({ outcome: "supported" })
    }
  },
)

test("log rows preserve decided measurements and override only unresolved or no-setup results", async () => {
  for (const id of [
    "extensions.osc176-app-id",
    "extensions.osc3008-context",
    "extensions.osc440-audio",
    "extensions.osc666-termprop",
    "extensions.osc555-flash",
    "extensions.osc113-reset-pointer-fg",
    "extensions.osc114-reset-pointer-bg",
    "extensions.osc117-reset-highlight-bg",
    "extensions.osc119-reset-highlight-fg",
  ]) {
    const source = replayTermProbeSource(new Map(), { readAppSemanticState: async () => report() })
    for (const previous of [
      parserStateResult(true, "observed effect", {}),
      parserStateResult(false, "observed negative", {}),
    ]) {
      const wrapped = withAppSemanticObservation({ id, lib: null, term: async () => previous })
      expect(await wrapped.term!(source)).toBe(previous)
    }
    const noSetup = declaredUntestableResult("Untestable (no setup): initial colour query is silent", {})
    const wrapped = withAppSemanticObservation({ id, lib: null, term: async () => noSetup })
    expect(await wrapped.term!(source)).toMatchObject({ observation: { outcome: "unsupported" } })
    source.readAppSemanticState = async () => ({ status: "unavailable", reason: "unreviewed version" })
    expect(await wrapped.term!(source)).toBe(noSetup)
    source.readAppSemanticState = async () => ({ status: "invalid", reason: "handled command wrote a refusal" })
    expect(await wrapped.term!(source)).toMatchObject({ tests: [{ status: "probe-invalid" }] })
  }
})

// A reset's own report must be collected after the initial silent query; a query's
// warning alone cannot establish that the reset command was rejected.
test.each([
  ["extensions.osc117-reset-highlight-bg", "117"],
  ["extensions.osc119-reset-highlight-fg", "119"],
] as const)("%s observes its exact reset after controlled query silence", async (id, code) => {
  const writes: string[] = []
  const source = replayTermProbeSource(new Map())
  source.write = (bytes) => writes.push(bytes)
  source.queryWithSentinelOutcome = async () => ({
    reason: "sentinel",
    raw: "\x1b[?1;2c",
    rawBase64: btoa("\x1b[?1;2c"),
    match: null,
    sentinel: { atMs: 7, graceMs: 250 },
  })
  source.readAppSemanticState = async (featureId, write) => {
    expect(featureId).toBe(id)
    write(`\x1b]${code}\x07`)
    const reading = report()
    if (reading.status !== "measured" || reading.reader !== "report") throw Error("report fixture")
    return { ...reading, target: { code, reports: [code] } }
  }
  const definition = extensionsProbes.find((probe) => probe.id === id)!
  expect(await definition.term!(source)).toMatchObject({ observation: { outcome: "unsupported" } })
  expect(writes).toEqual([`\x1b]${code}\x07`])
})
