/**
 * @failure The colour-sibling-separation decision (#33041) is right in isolation but lost in the run:
 *   the batch tail must re-record a decided row through the one recorder, so its test names the
 *   witness assertion it appended (row-local ordinal after any assertion the row already held), and
 *   an open row must keep its own verdict while saying why no decision was made. The record reader
 *   must fail loudly on a named but absent or malformed launcher file, and treat an unnamed one as a
 *   missing control, never as "no record, so decided".
 * @level l1
 * @consumer The runProbeBatch tail pass and serve.ts outer-record reader for #33041.
 * @testonly none
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, test } from "vitest"
import { recordExecutedProbe, type Observation, type ObservationFrame, type ProbeAssertion } from "@terminfo/probe-defs"
import { readOuterColourControl } from "../serve.ts"
import { applyColourSiblingSeparation } from "./unified.ts"

const REGION = { x: 29, y: 68, width: 52, height: 29 }
const sha = (tag: string) => `sha256:${tag.padEnd(64, "0")}`
const attempt = { scope: "probe" as const, startedAt: "2026-11-10T15:39:08.736Z" }

function observation(
  id: string,
  digests: [string, string, string, string],
  outcome: Observation["outcome"],
): Observation {
  const steps = ["pre-edit seed", "post-sequence target", "expected frame", "ignored-attribute frame"]
  const frames: ObservationFrame[] = steps.map((step, index) => ({
    role: index === 1 ? "target" : "control",
    ref: sha(`${id.length}${index}r`),
    capturedAt: index,
    label: `${id}: ${step}`,
    regionDigest: digests[index] as string,
    regionRectangle: REGION,
  }))
  return {
    featureId: id,
    outcome,
    ...(outcome === "inconclusive" ? { reason: "insufficient-evidence" as const } : {}),
    assertionType: "screenshot",
    screenshotRef: frames[1]?.ref,
    frames,
    note: `${id}: the seed frame and the expected frame read the same cells, so this run cannot separate them`,
  }
}

function batch(earlier: ProbeAssertion[] = []) {
  const flat = observation("sgr.fg.truecolor", [sha("951e"), sha("951e"), sha("951e"), sha("951e")], "inconclusive")
  const sibling = observation("sgr.fg.256", [sha("951e"), sha("0a9b"), sha("0a9b"), sha("c2fd")], "supported")
  const assertions = [...earlier]
  const results = [flat, sibling].map((item) =>
    recordExecutedProbe({
      featureId: item.featureId,
      attempt,
      observation: item,
      assertions,
      rawReplyRef: item.featureId,
    }),
  )
  return { results, observations: [flat, sibling], assertions }
}

const RECORD = {
  id: "kitty",
  version: "0.49.2",
  os: "linux",
  recordPath: "content/probes-apps/kitty-0.49.2-linux-b09e6e5cab7a3a07c0754538b2d949d6.json",
  recordRunId: "b09e6e5cab7a3a07c0754538b2d949d6",
  statuses: { "sgr.fg.truecolor": "supported" },
}
const control = {
  mux: "screen" as const,
  runId: "79bbd913a6deaf27b1864ba143a17bed",
  harnessProfile: "kitty --config NONE",
  muxConfig: "/out/mux-empty.conf",
}

test("a decided row is re-recorded unsupported and its test names the appended witness after the row's earlier assertion", () => {
  const earlier: ProbeAssertion = {
    featureId: "sgr.fg.truecolor",
    kind: "positive",
    assertionType: "screenshot",
    expected: "e",
    observed: sha("951e"),
  }
  const run = batch([earlier])
  applyColourSiblingSeparation(run, {
    ...control,
    outer: { record: RECORD, outerApp: { id: "kitty", version: "0.49.2", os: "linux" } },
  })
  const row = run.results.find((result) => result.featureId === "sgr.fg.truecolor")
  expect(row).toMatchObject({ status: "unsupported", criterionBranch: "colour-sibling-separation" })
  expect(run.assertions).toHaveLength(2)
  expect(row?.tests[0]?.assertionRefs).toEqual([1])
  expect(run.assertions[1]).toMatchObject({
    featureId: "sgr.fg.truecolor",
    kind: "negative",
    witness: { kind: "colour-sibling-separation" },
  })
  expect(run.observations.find((item) => item.featureId === "sgr.fg.truecolor")?.outcome).toBe("unsupported")
  expect(run.results.find((result) => result.featureId === "sgr.fg.256")?.status).toBe("supported")
})

test("an open row keeps its verdict and its tests say why no decision was made", () => {
  const run = batch()
  const before = run.results[0]?.status
  applyColourSiblingSeparation(run, {
    ...control,
    outer: { missing: "no placed outer-terminal record matches content/probes-apps/kitty-0.49.2-linux-*.json" },
  })
  expect(run.results[0]?.status).toBe(before)
  expect(
    run.results[0]?.tests.every((test) =>
      test.reason?.includes("no colour-sibling-separation decision: no outer-terminal control"),
    ),
  ).toBe(true)
  expect(run.assertions).toHaveLength(0)
})

const directory = mkdtempSync(join(tmpdir(), "outer-colour-record-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const outerApp = { id: "kitty", version: "0.49.2", os: "linux" }

test("the record reader passes the launcher's facts or its missing reason, and fails loudly on its own defects", () => {
  expect(readOuterColourControl(undefined, outerApp)).toEqual({
    missing: expect.stringContaining("TERMINFO_OUTER_COLOUR_RECORD unset"),
  })
  expect(() => readOuterColourControl(join(directory, "absent.json"), outerApp)).toThrow(/named but absent/)
  const missing = join(directory, "missing.json")
  writeFileSync(missing, JSON.stringify({ missing: "no placed outer-terminal record matches x" }))
  expect(readOuterColourControl(missing, outerApp)).toEqual({ missing: "no placed outer-terminal record matches x" })
  const record = join(directory, "record.json")
  writeFileSync(record, JSON.stringify(RECORD))
  expect(readOuterColourControl(record, outerApp)).toEqual({ record: RECORD, outerApp })
  const malformed = join(directory, "malformed.json")
  writeFileSync(malformed, JSON.stringify({ ...RECORD, recordRunId: "" }))
  expect(() => readOuterColourControl(malformed, outerApp)).toThrow(/malformed/)
})
