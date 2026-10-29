/**
 * @failure Source admin probe commands accept conflicting suite metadata before launching a collector.
 * @level l2
 * @consumer Admin CLI app, mux, and server probe actions.
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { beforeAll, describe, expect, test, vi } from "vitest"
import { Command } from "@silvery/commander"
import { collectHeadlessRuns } from "../../probes/collect-headless.ts"
import { ensureSourceSuiteEnvironment, sourceSuiteEnvironment } from "../versions.ts"

vi.mock("../../probes/collect-headless.ts", () => ({ collectHeadlessRuns: vi.fn() }))

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

// AC1/AC5: source metadata tests cannot catch a parsed filter dropped before the headless collector.
describe("headless CLI exact probe selection", () => {
  let program: Command
  beforeAll(async () => {
    const parse = vi.spyOn(Command.prototype, "parseAsync").mockImplementation(function(this: Command) { return this })
    try {
      await import("./index.ts")
      program = parse.mock.contexts[0]!
      for (const command of [program, ...program.commands, ...program.commands.flatMap(command => command.commands)]) {
        command.exitOverride().configureOutput({ writeErr: () => {} })
      }
    } finally { parse.mockRestore() }
  })
  test.each([{ ids: undefined }, { ids: [] }, { ids: ["device.primary-da"] }])("forwards exact probe IDs $ids without inferring a full selection", async ({ ids }) => {
    vi.mocked(collectHeadlessRuns).mockReset().mockResolvedValue({
      directory: "/fixture/headless", requested: ["xtermjs"], runs: [], failures: [],
    })
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      await program.parseAsync(["probe", "termless", "xtermjs", ...(ids === undefined ? [] : ["--probe-ids", JSON.stringify(ids)])], { from: "user" })
      expect(collectHeadlessRuns).toHaveBeenCalledTimes(1)
      expect(vi.mocked(collectHeadlessRuns).mock.calls[0]?.[0]).toEqual(["xtermjs"])
      expect(vi.mocked(collectHeadlessRuns).mock.calls[0]?.[3]).toEqual(ids)
    } finally { log.mockRestore() }
  })
  test.each(["{", "{}", '["device.primary-da",3]'])("refuses malformed probe IDs %s before dispatch", async value => {
    vi.mocked(collectHeadlessRuns).mockClear()
    await expect(program.parseAsync(["probe", "termless", "xtermjs", "--probe-ids", value], { from: "user" })).rejects.toThrow()
    expect(collectHeadlessRuns).not.toHaveBeenCalled()
  })
})
