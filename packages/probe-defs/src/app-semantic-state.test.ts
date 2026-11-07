/**
 * @failure App state or stderr grades a feature without this row's controls, or silence
 *   becomes Supported. Existing library report tests never exercise the owned App reader.
 * @level l2
 * @consumer The registered native OSC callbacks and their App semantic-state grader.
 * @testonly none
 */
import { expect, test } from "vitest"
import { gradeAppSemanticState, withAppSemanticObservation } from "./app-semantic-state.ts"
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
      return report()
    }
    const definition = extensionsProbes.find((probe) => probe.id === id)!
    expect(await definition.term!(ctx), id).toMatchObject({ observation: { outcome: "unsupported" } })
    expect(seen).toEqual([id])
  }
})

test("the six added log rows preserve decided measurements and override only unresolved or no-setup results", async () => {
  for (const id of [
    "extensions.osc176-app-id",
    "extensions.osc440-audio",
    "extensions.osc666-termprop",
    "extensions.osc555-flash",
    "extensions.osc113-reset-pointer-fg",
    "extensions.osc114-reset-pointer-bg",
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
