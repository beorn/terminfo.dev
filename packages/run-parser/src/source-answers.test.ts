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
          if (control.mode === "remote" && values.includes("get-url"))
            return response("https://example.test/another.git\n")
          if (control.mode === "shallow" && values.includes("--is-shallow-repository")) return response("true\n")
          if (values.some((arg) => arg.startsWith("--batch-check"))) {
            if (control.mode === "absent") return response(`${String(options.input).trim()} missing\n`)
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
      control.mode === "checkout" && String(path).endsWith("/termless") ? false : actual.existsSync(path),
    ),
  }
})
afterEach(() => {
  control.mode = "normal"
  vi.restoreAllMocks()
  vi.resetModules()
})

// Pure qualification tests cannot distinguish an absent object from a broken environment.
it.each(["checkout", "remote", "shallow", "broken", "absent"])(
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
    if (mode === "absent")
      expect(resolve()).toMatchObject({
        kind: "pending",
        reason: "cited source not resolvable at git@github.com:beorn/termless.git@000000000000",
      })
    else expect(resolve).toThrow(/(?:repository|history|source).*termless.*0000000000000000000000000000000000000000/i)
  },
)

// All three production entry points must reach the same I/O owner; pure tests permit omission.
it("passes the I/O owner through parser, collection writer and site loader", async () => {
  const io = await import("./source-answers.ts")
  const { parseRun, parseSuiteManifest } = await import("./index.ts")
  const { finalizeCollectedDraft } = await import("../../terminfo.dev/src/capture-writer.ts")
  const { consoleHostHeldResults } = await import("../../../docs/data/selected-results.ts")
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
  expect(parse).toThrow("source I/O reached")
  expect(() => finalizeCollectedDraft(raw)).toThrow("source I/O reached")
  expect(() => consoleHostHeldResults(loaded, [])).toThrow("source I/O reached")
})
