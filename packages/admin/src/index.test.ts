/**
 * @failure Admin commands accept conflicting suite metadata or expose retired review dispatch.
 * @level l2
 * @consumer Admin CLI app, mux, and server probe actions; `terminfo report --reassert` modes and its term/mux path
 * (#30932 S4, @cto 30932-s4-report-ruling-1818).
 * @testonly none
 */
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { beforeAll, describe, expect, test, vi } from "vitest"
import { Command } from "@silvery/commander"
import { collectHeadlessRuns } from "../../probes/collect-headless.ts"
import { startWitnessResponder } from "../../terminfo.dev/src/witness-window.ts"
import { ensureSourceSuiteEnvironment, sourceSuiteEnvironment } from "../versions.ts"

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})
vi.mock("../../probes/collect-headless.ts", () => ({ collectHeadlessRuns: vi.fn() }))
vi.mock("../../terminfo.dev/src/witness-window.ts", () => ({ startWitnessResponder: vi.fn() }))

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

test("retired review command fails loudly with usage while collection commands stay available", () => {
  const result = spawnSync(process.execPath, [entry, "review", "intake"], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    timeout: 10_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.status).not.toBe(0)
  const output = `${result.stdout}\n${result.stderr}`
  expect(output).toMatch(/unknown command.*review/i)
  expect(output).toMatch(/usage:/i)
  for (const command of ["probe", "report", "status", "detect", "submit"]) {
    expect(output).toMatch(new RegExp(`\\b${command}\\b`))
  }
})

// AC1/AC5: source metadata tests cannot catch a parsed filter dropped before the headless collector.
describe("headless CLI exact probe selection", () => {
  let program: Command
  beforeAll(async () => {
    const parse = vi.spyOn(Command.prototype, "parseAsync").mockImplementation(function (this: Command) {
      return this
    })
    try {
      await import("./index.ts")
      program = parse.mock.contexts[0]!
      for (const command of [
        program,
        ...program.commands,
        ...program.commands.flatMap((command) => command.commands),
      ]) {
        command.exitOverride().configureOutput({ writeErr: () => {} })
      }
    } finally {
      parse.mockRestore()
    }
  })
  test.each([{ ids: undefined }, { ids: [] }, { ids: ["device.primary-da"] }])(
    "forwards exact probe IDs $ids without inferring a full selection",
    async ({ ids }) => {
      vi.mocked(collectHeadlessRuns)
        .mockReset()
        .mockResolvedValue({
          directory: "/fixture/headless",
          requested: ["xtermjs"],
          runs: [],
          failures: [],
        })
      const log = vi.spyOn(console, "log").mockImplementation(() => {})
      try {
        await program.parseAsync(
          ["probe", "termless", "xtermjs", ...(ids === undefined ? [] : ["--probe-ids", JSON.stringify(ids)])],
          { from: "user" },
        )
        expect(collectHeadlessRuns).toHaveBeenCalledTimes(1)
        expect(vi.mocked(collectHeadlessRuns).mock.calls[0]?.[0]).toEqual(["xtermjs"])
        expect(vi.mocked(collectHeadlessRuns).mock.calls[0]?.[3]).toEqual(ids)
      } finally {
        log.mockRestore()
      }
    },
  )
  test.each(["{", "{}", '["device.primary-da",3]'])("refuses malformed probe IDs %s before dispatch", async (value) => {
    vi.mocked(collectHeadlessRuns).mockClear()
    await expect(
      program.parseAsync(["probe", "termless", "xtermjs", "--probe-ids", value], { from: "user" }),
    ).rejects.toThrow()
    expect(collectHeadlessRuns).not.toHaveBeenCalled()
  })

  test("probe witness reads controlling tty with inherited stdin so /usr/bin/tty sees the PTY (#34080)", async () => {
    vi.mocked(execFileSync).mockClear()
    vi.mocked(execFileSync).mockReturnValueOnce("/dev/ttys009\n")
    vi.mocked(startWitnessResponder)
      .mockReset()
      .mockResolvedValue({
        registration: {
          runId: "0123456789abcdef0123456789abcdef",
          pid: 12345,
          port: 43210,
          token: "a".repeat(64),
          tty: "/dev/ttys009",
        },
        close: async () => {},
        closed: Promise.resolve(),
      })
    await program.parseAsync(
      [
        "probe",
        "witness",
        "--run-id",
        "0123456789abcdef0123456789abcdef",
        "--registration",
        "/tmp/terminfo-witness-test.json",
      ],
      { from: "user" },
    )
    expect(execFileSync).toHaveBeenCalledWith(
      "/usr/bin/tty",
      [],
      expect.objectContaining({ encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] }),
    )
    expect(startWitnessResponder).toHaveBeenCalledWith({
      runId: "0123456789abcdef0123456789abcdef",
      registrationPath: "/tmp/terminfo-witness-test.json",
      ttyPath: "/dev/ttys009",
    })
  })
})

/** `terminfo report` through its real arguments, with the source launcher's variables absent unless given. */
function report(args: string[], env: Record<string, string> = {}) {
  const clean = { ...process.env }
  delete clean.TERMINFO_PROBE_HASH
  delete clean.TERMINFO_SOURCE_REVISION
  return spawnSync(process.execPath, [entry, "report", ...args], {
    cwd: root,
    env: { ...clean, ...env },
    encoding: "utf8",
    timeout: 60_000,
  })
}

describe("report --reassert (#30932 S4)", () => {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-reassert-"))
  const saved = (name: string, subject: Record<string, unknown>) => {
    const path = join(directory, name)
    // A stored run bound to no suite this checkout has, whose only row is outside every replayed family.
    const run = {
      runId: "0".repeat(32),
      suiteId: "000000000000",
      sourceRevision: "f".repeat(40),
      subject,
      rawReplies: {},
      results: [{ featureId: "cursor.move.home", status: "yes", tests: [], attempt: { scope: "full" } }],
    }
    writeFileSync(path, JSON.stringify(run))
    return path
  }

  test("a term run is reasserted with the source launcher's suite set up by the command, and refused with zero rows by name", () => {
    const run = saved("term.json", { kind: "term", id: "kitty", os: "linux" })
    const { TERMINFO_PROBE_HASH, TERMINFO_SOURCE_REVISION } = sourceSuiteEnvironment()
    const result = report(["--reassert", run])
    expect(result.status, result.stderr).toBe(2)
    expect(result.stdout).toContain(
      `${run}: run ${"0".repeat(32)} (term kitty), suite 000000000000, source ${"f".repeat(40)}`,
    )
    // The receipt came from this checkout's source launcher, set up by the command itself: it named what it replays with.
    expect(result.stdout).toContain(`replayed with suite ${TERMINFO_PROBE_HASH}, source ${TERMINFO_SOURCE_REVISION}`)
    expect(result.stdout).toContain("  RUN REFUSED: ")
    // A refused run with nothing in scope is still exit 2, never a vacuous agreement.
    expect(result.stdout).toContain("  0 rows in scope: nothing was compared")
    expect(result.stdout).toContain("  excluded, host-level log only (cursor.*): 1 rows (cursor.move.home)")
    // A conflicting declared suite is refused before anything is replayed.
    const conflicting = report(["--reassert", run], { TERMINFO_PROBE_HASH: "wrong-hash" })
    expect(conflicting.status).toBe(2)
    expect(conflicting.stdout).toContain(
      "NOT REASSERTED (Error): TERMINFO_PROBE_HASH differs from the current source suite",
    )
  })

  test("an unknown subject kind is refused by name, never replayed as a terminal", () => {
    const run = saved("app.json", { kind: "app", id: "kitty" })
    const result = report(["--reassert", run, "--json"])
    expect(result.status).toBe(2)
    expect(JSON.parse(result.stdout)).toMatchObject({
      exitCode: 2,
      inputs: [{ input: run, failure: { message: 'Stored run subject kind "app" is not lib, term or mux' } }],
    })
  })

  test("modes are explicit: no operand, --scoreboard with --reassert, and --json alone are refused by name", () => {
    const run = saved("none.json", { kind: "term", id: "kitty" })
    const empty = report(["--reassert"])
    expect(empty.status).not.toBe(0)
    expect(empty.stderr).toMatch(/argument missing|missing/i)
    const both = report(["--scoreboard", run, "--reassert", run])
    expect(both.status).not.toBe(0)
    expect(both.stderr).toContain("report takes --scoreboard or --reassert, not both")
    const json = report(["--json"])
    expect(json.status).not.toBe(0)
    expect(json.stderr).toContain("report --json applies only to --reassert")
    rmSync(directory, { recursive: true, force: true })
  })
})
