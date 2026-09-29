/**
 * @failure Source admin probe commands accept conflicting suite metadata before launching a collector.
 * @level l2
 * @consumer Admin CLI app, mux, and server probe actions.
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { ensureSourceSuiteEnvironment, sourceSuiteEnvironment } from "../versions.ts"

const sourceDirectory = dirname(fileURLToPath(import.meta.url))
const root = join(sourceDirectory, "..", "..", "..")
const entry = join(sourceDirectory, "index.ts")

// An unknown target lets the real CLI action run without launching a terminal or daemon.
test.each(["app", "mux", "server"])("%s refuses conflicting source suite metadata before dispatch", (method) => {
  const result = spawnSync(process.execPath, [entry, "probe", method, "terminfo-unknown-target"], {
    cwd: root,
    env: {
      ...process.env,
      TERMINFO_PROBE_HASH: "wrong-hash",
      TERMINFO_SOURCE_REVISION: "wrong-revision",
    },
    encoding: "utf8",
    timeout: 10_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.status).not.toBe(0)
  expect(`${result.stdout}\n${result.stderr}`).toMatch(/TERMINFO_PROBE_HASH differs from the current source suite/)
})

test("source suite setup fills absent values but never partially overwrites conflicting declarations", () => {
  const before = {
    TERMINFO_PROBE_HASH: process.env.TERMINFO_PROBE_HASH,
    TERMINFO_SOURCE_REVISION: process.env.TERMINFO_SOURCE_REVISION,
  }
  try {
    delete process.env.TERMINFO_PROBE_HASH
    delete process.env.TERMINFO_SOURCE_REVISION
    const expected = sourceSuiteEnvironment()
    expect(ensureSourceSuiteEnvironment()).toEqual(expected)
    expect(process.env.TERMINFO_PROBE_HASH).toBe(expected.TERMINFO_PROBE_HASH)
    expect(process.env.TERMINFO_SOURCE_REVISION).toBe(expected.TERMINFO_SOURCE_REVISION)
    expect(ensureSourceSuiteEnvironment()).toEqual(expected)

    process.env.TERMINFO_PROBE_HASH = "wrong-hash"
    delete process.env.TERMINFO_SOURCE_REVISION
    expect(() => ensureSourceSuiteEnvironment()).toThrow(/TERMINFO_PROBE_HASH differs/)
    expect(process.env.TERMINFO_PROBE_HASH).toBe("wrong-hash")
    expect(process.env.TERMINFO_SOURCE_REVISION).toBeUndefined()

    delete process.env.TERMINFO_PROBE_HASH
    process.env.TERMINFO_SOURCE_REVISION = "wrong-revision"
    expect(() => ensureSourceSuiteEnvironment()).toThrow(/TERMINFO_SOURCE_REVISION differs/)
    expect(process.env.TERMINFO_PROBE_HASH).toBeUndefined()
    expect(process.env.TERMINFO_SOURCE_REVISION).toBe("wrong-revision")
  } finally {
    for (const key of ["TERMINFO_PROBE_HASH", "TERMINFO_SOURCE_REVISION"] as const) {
      if (before[key] === undefined) delete process.env[key]
      else process.env[key] = before[key]
    }
  }
})

test("CLI help is independent of source suite metadata", () => {
  const result = spawnSync(process.execPath, [entry, "--help"], {
    cwd: root,
    env: { ...process.env, TERMINFO_PROBE_HASH: "wrong-hash", TERMINFO_SOURCE_REVISION: "wrong-revision" },
    encoding: "utf8",
    timeout: 10_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  expect(result.stdout).toContain("probe")
})
