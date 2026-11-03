/**
 * @failure Source grading quietly treats a broken checkout as missing evidence, or production skips Git facts.
 * @level l1
 * @consumer Canonical parser, collection finalizer and build-time site loader
 * @testonly none
 */
import { afterEach, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { SOURCE_ANSWERS } from "@terminfo/probe-defs"

const control = vi.hoisted(() => ({ mode: "normal" }))
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>()
  return {
    ...actual,
    spawnSync: vi.fn(
      (command: string, args: string[], options: import("node:child_process").SpawnSyncOptionsWithStringEncoding) => {
        const values = args as string[]
        if (command === "git" && values.includes("-C")) {
          const response = (stdout: string, status = 0) => ({ stdout, stderr: "", status, error: undefined })
          if (control.mode === "remote" && values.includes("get-url")) {
            return response("https://example.test/another.git\n")
          }
          if (control.mode === "shallow" && values.includes("--is-shallow-repository")) return response("true\n")
          if (values.includes("--get-regexp") && control.mode === "absent") return response("", 1)
          if (values.includes("--get-regexp") && control.mode === "promisor") {
            return response("remote.origin.promisor true\n")
          }
          if (values.some((arg) => arg.startsWith("--batch-check"))) {
            if (control.mode === "absent" || control.mode === "promisor") {
              return response(`${String(options.input).trim()} missing\n`)
            }
            if (control.mode === "broken") return { ...response("", 128), stderr: "cannot read object store" }
          }
        }
        return actual.spawnSync(command, args, options)
      },
    ),
  }
})
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>()
  return {
    ...actual,
    existsSync: vi.fn((path: import("node:fs").PathLike) =>
      control.mode === "checkout" &&
      (String(path).endsWith("/termless") || /[\\/]\.ci-siblings[\\/]\d+$/.test(String(path)))
        ? false
        : actual.existsSync(path),
    ),
  }
})
afterEach(() => {
  control.mode = "normal"
  vi.restoreAllMocks()
  vi.resetModules()
})

// Pure qualification tests cannot distinguish an absent object from a broken environment.
it.each(["checkout", "remote", "shallow", "broken", "promisor", "absent"])(
  "reports source environment %s without inventing an answer",
  async (mode) => {
    const { resolveMeasuredSourceAnswer } = await import("./source-answers.ts")
    const row = SOURCE_ANSWERS.find((row) =>
      row.answers.some((answer) =>
        answer.citedBlobs.some((blob) => blob.repository === "git@github.com:beorn/termless.git"),
      ),
    )!
    control.mode = mode
    const resolve = () =>
      resolveMeasuredSourceAnswer({
        subject: { ...row.subject, version: "unreviewed-version" },
        featureId: row.featureId,
        runtimeIdentity: {
          kind: "js",
          runtimeFormat: "js",
          resolvedPath: "/engine/index.js",
          engineVersion: "unreviewed-version",
          adapterVersion: "1",
          termlessRevision: "0".repeat(40),
          integrity: { kind: "registry", lockIntegrity: "sha512-package" },
        },
      })
    if (mode === "absent") {
      expect(resolve()).toMatchObject({
        kind: "pending",
        reason: "cited source not resolvable at git@github.com:beorn/termless.git@000000000000",
      })
    } else expect(resolve).toThrow(/(?:repository|history|source).*termless.*0000000000000000000000000000000000000000/i)
  },
)

// The writer qualifies source answers; decoding retained results must not require source checkouts.
it("qualifies at the writer and preserves stored answers when decoding", async () => {
  const io = await import("./source-answers.ts")
  const { parseRun, parseSuiteManifest } = await import("./index.ts")
  const { finalizeCollectedDraft } = await import("../../terminfo.dev/src/capture-writer.ts")
  const path = new URL(
    "../../../content/probes-apps/alacritty-0.17.0-linux-f504922f67f074794c588cf3a14e2114.json",
    import.meta.url,
  )
  const bytes = readFileSync(path, "utf8")
  const manifestPath = new URL("../../../content/suites/4b01b0117e18.json", import.meta.url)
  const manifest = parseSuiteManifest(manifestPath.pathname, readFileSync(manifestPath, "utf8"))
  const parse = () => parseRun(path.pathname, bytes, manifest.catalogIds!, new Map([[manifest.probeHash, manifest]]))
  const loaded = parse()
  const raw = JSON.parse(bytes) as Parameters<typeof finalizeCollectedDraft>[0] & { sealedAt?: string }
  delete raw.sealedAt
  const result = raw.results.find((result) => result.reviewRef?.startsWith("["))!
  result.tests = result.tests.map((test) => (test.id === "review" ? { ...test, status: "test-todo" } : test))
  vi.spyOn(io, "resolveMeasuredSourceAnswer").mockImplementation(() => {
    throw new Error("source I/O reached")
  })
  expect(parse()).toEqual(loaded)
  expect(() => finalizeCollectedDraft(raw)).toThrow("source I/O reached")
})

// The retained C1 fixtures already had references from the old review applier. Fresh OSC176
// captures leave the review pending with [], even though their real negative assertion exists.
it.each(["measured", "missing", "positive", "other-feature", "empty-expected", "empty-observed"])(
  "source finalization binds only the current deciding assertion (%s)",
  async (mode) => {
    const { finalizeCollectedDraft } = await import("../../terminfo.dev/src/capture-writer.ts")
    const featureId = "extensions.osc176-app-id"
    const path = new URL(
      "../../../content/probes-libs/vterm-0.10.1-linux-a22f06ca-2505-4c0d-a518-b0b01f8bbe76.json",
      import.meta.url,
    )
    const capture = JSON.parse(readFileSync(path, "utf8")) as Parameters<typeof finalizeCollectedDraft>[0] & {
      sealedAt?: string
    }
    delete capture.sealedAt
    const row = capture.results.find((result) => result.featureId === featureId)!
    row.status = "test-todo"
    row.tests = row.tests.map((test) =>
      test.id === "review" ? { ...test, status: "test-todo", assertionRefs: [] } : test,
    )
    const measured = capture.assertions.flatMap((assertion, index) =>
      assertion.featureId === featureId && assertion.kind === "negative" ? [index] : [],
    )
    expect(measured.length).toBeGreaterThan(0)
    for (const index of measured) {
      const assertion = capture.assertions[index]!
      if (mode === "other-feature") assertion.featureId = "other-feature"
      if (mode === "positive") assertion.kind = "positive"
      if (mode === "empty-expected") assertion.expected = ""
      if (mode === "empty-observed") assertion.observed = ""
    }
    if (mode === "missing") {
      capture.assertions = capture.assertions.filter((assertion) => assertion.featureId !== featureId)
    }
    const assertions = structuredClone(capture.assertions)
    const finalized = finalizeCollectedDraft(capture)
    const result = finalized.results.find((entry) => entry.featureId === featureId)!
    expect(finalized.assertions).toEqual(assertions)
    expect(capture.results.find((entry) => entry.featureId === featureId)?.status).toBe("test-todo")
    if (mode === "measured") {
      expect(result.status).toBe("unsupported")
      expect(result.tests.find((test) => test.id === "review")?.assertionRefs).toEqual(measured)
    } else {
      expect(result.status).toBe("test-todo")
      expect(result.reason).toContain("current deciding negative assertion")
      expect(result.tests.find((test) => test.id === "review")?.assertionRefs).toEqual([])
    }
  },
)

// Requirement: kept answer references identify their own feature and measured subject. The
// existing positive read does not detect a borrowed row or a missing subject context.
it("rejects a kept answer borrowed by another feature or measured subject", async () => {
  const { parseProbeResults, parseRun, parseSuiteManifest } = await import("./index.ts")
  const path = new URL(
    "../../../content/probes-apps/alacritty-0.17.0-linux-f504922f67f074794c588cf3a14e2114.json",
    import.meta.url,
  )
  const raw = JSON.parse(readFileSync(path, "utf8"))
  const manifestPath = new URL(`../../../content/suites/${raw.probeHash}.json`, import.meta.url)
  const manifest = parseSuiteManifest(manifestPath.pathname, readFileSync(manifestPath, "utf8"))
  const read = (value: unknown) =>
    parseRun(path.pathname, JSON.stringify(value), manifest.catalogIds ?? [], new Map([[raw.probeHash, manifest]]))
  const original = read(raw)
  const sourceResult = raw.results.find(
    (result: { featureId: string }) => result.featureId === "extensions.iterm2-images",
  )
  expect(original.results?.find((result) => result.featureId === sourceResult.featureId)?.status).toBe(
    sourceResult.status,
  )
  const otherSubject = structuredClone(raw)
  otherSubject.subject.id = "other-measured-terminal"
  expect(() => read(otherSubject)).toThrow("source answer does not apply to measured identity")
  const otherFeature = structuredClone(raw)
  const target = otherFeature.results.find((result: { featureId: string }) => result.featureId === "sgr.bold")
  target.reviewRef = sourceResult.reviewRef
  target.tests = target.tests.map((test: { id: string }) =>
    test.id === "review" ? { ...test, reviewRef: sourceResult.reviewRef } : test,
  )
  expect(() => read(otherFeature)).toThrow("source answer feature mismatch")
  expect(() =>
    parseProbeResults([sourceResult], "source.json", new Set([sourceResult.featureId]), raw.rawReplies, raw.assertions),
  ).toThrow("source answer requires measured subject context")
})
