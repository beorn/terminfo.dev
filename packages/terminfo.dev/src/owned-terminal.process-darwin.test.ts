/**
 * @failure A Darwin process-backed arm grants ownership without the shared process proof, or a claim
 * from another run, PID, environment or parent chain is authorized instead of refused by name.
 * @level l1
 * @consumer createOwnedTerminal process arm used by collectProbeRun for kitty and cli-process.
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import type { ProbeResult, Observation, ProbeAssertion } from "@terminfo/probe-defs"
import { createOwnedTerminal, parseProcessOwnerAssertion } from "./owned-terminal.ts"

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const launchRunId = "c".repeat(32)
const captureRunId = "d".repeat(32)

const assertionFor = (input: {
  provider: "kitty" | "cli-process"
  ownerPid: number
  executablePath: string
  marker: { flag: string; value: string }
  tty?: string
  launchRunId?: string
  workerPid?: number
}) => ({
  asserter: "terminfo-admin" as const,
  launchRunId: input.launchRunId ?? launchRunId,
  workerPid: input.workerPid ?? 4242,
  provider: input.provider,
  ownerPid: input.ownerPid,
  executablePath: input.executablePath,
  marker: input.marker,
  tty: input.tty ?? "/dev/ttys004",
  intendedVersion: "0.44.0",
})

/**
 * Runs the process arm in a child whose platform is Darwin, whose ps answers are this fixture's table,
 * and whose TTY devices are one device. The proof itself is NOT mocked: the child calls the real
 * assertOwnedProcess, so a grant here is the same code path a Mac run takes.
 */
function runDarwinArm(scenario: {
  provider: "kitty" | "cli-process"
  launchRunId?: string
  workerPid?: number | "self"
  envRunId?: string
  ownerPid: number
  marker: { flag: string; value: string }
  parent: Record<string, number | "self">
  command?: string
  tty?: string
  /** The claim's own run id, when it differs from the worker's. */
  claimRunId?: string
  batch?: "process" | "terminal-app" | "disposed"
}): { status: number | null; stdout: string; stderr: string } {
  const script = `
    import { mock } from "bun:test"
    import assert from "node:assert/strict"
    Object.defineProperty(process, "platform", { value: "darwin" })
    const scenario = ${JSON.stringify(scenario)}
    const launchRunId = scenario.launchRunId ?? ${JSON.stringify(launchRunId)}
    process.env.TERMINFO_RUN_ID = scenario.envRunId ?? launchRunId
    const self = process.pid
    const parent = Object.fromEntries(
      Object.entries(scenario.parent).map(([key, value]) => [key === "self" ? self : key, value === "self" ? self : value]),
    )
    const executablePath = process.execPath
    const device = { dev: 7n, rdev: 9n, ino: 11n }
    const realFs = await import("node:fs")
    const realCp = await import("node:child_process")
    const realTty = await import("node:tty")
    const ps = (args) => {
      const pid = Number(args[args.indexOf("-p") + 1])
      const field = args[args.indexOf("-o") + 1]
      if (field === "tty=") return "ttys004\\n"
      if (field === "comm=") return pid === scenario.ownerPid ? executablePath : ""
      if (field === "command=") {
        if (pid !== scenario.ownerPid) return ""
        return scenario.command ?? executablePath + " " + scenario.marker.flag + " " + scenario.marker.value
      }
      if (field === "ppid=") return parent[pid] === undefined ? "" : String(parent[pid])
      throw new Error("unexpected ps field " + args.join(" "))
    }
    mock.module("node:fs", () => ({ ...realFs, fstatSync: () => device, statSync: () => device }))
    mock.module("node:tty", () => ({ ...realTty, isatty: () => true }))
    mock.module("node:child_process", () => ({
      ...realCp,
      execFileSync: (command, args) => {
        if (command !== "/bin/ps") throw new Error("unexpected exec " + command)
        return ps(args)
      },
      spawnSync: (command, args) => ({
        status: 0,
        stdout: command === "/bin/ps" ? ps(args) : "",
        stderr: "",
      }),
      spawn: () => {
        throw new Error("stty is not run in this fixture")
      },
    }))
    const { createOwnedTerminal, ownedTerminalVerifiedFor } = await import("./packages/terminfo.dev/src/owned-terminal.ts")
    const assertion = {
      asserter: "terminfo-admin",
      launchRunId: scenario.claimRunId ?? launchRunId,
      workerPid: scenario.workerPid === "self" ? self : (scenario.workerPid ?? self),
      provider: scenario.provider,
      ownerPid: scenario.ownerPid,
      executablePath,
      marker: scenario.marker,
      tty: scenario.tty ?? "/dev/ttys004",
      intendedVersion: "0.44.0",
    }
    try {
      const owner = await createOwnedTerminal({
        captureRunId: ${JSON.stringify(captureRunId)},
        expectedLaunchRunId: launchRunId,
        out: process.stdout,
        ...(scenario.batch === "terminal-app"
          ? { terminalApp: { asserter: "terminfo-admin", launchRunId, workerPid: self, windowId: 791, tabTty: "/dev/ttys004", intendedVersion: "2.15" } }
          : { process: assertion }),
      })
      const summary = JSON.parse(owner.summary)
      assert.equal(summary.platform, "darwin")
      if (scenario.batch !== "terminal-app") assert.deepEqual(summary.processOwnerAssertion, assertion)
      assert.equal(summary.ownerAssertionSource, "authenticated-admin-request")
      assert.equal(summary.ownedOwnerAssertion, undefined)
      // The pid serve's Darwin capture adopts is the one this proof checked, never a second reading.
      if (scenario.batch !== "terminal-app") assert.equal(owner.appPid, assertion.ownerPid)
      if (!scenario.batch) {
        console.log("GRANTED " + summary.outputBinding.tabTty)
      } else {
        assert.equal(ownedTerminalVerifiedFor(owner, ${JSON.stringify(captureRunId)}, process.stdout), true)
        if (scenario.batch === "disposed") {
          await owner.dispose()
          assert.equal(ownedTerminalVerifiedFor(owner, ${JSON.stringify(captureRunId)}, process.stdout), false)
        }
        delete process.env.TERMINFO_DISPOSABLE_RECEIPT
        const { runProbeBatch } = await import("./packages/terminfo.dev/src/probes/unified.ts")
        const replies = ${JSON.stringify([
          "\x1b]10;rgb:0000/0000/0000\x07\x1b[?62;c",
          "\x1b]10;rgb:aa/bb/cc\x07\x1b[?62;c",
          "\x1b]10;rgb:0000/0000/0000\x07\x1b[?62;c",
        ])}
        const originalWrite = process.stdout.write
        const writes = []
        let read = 0
        process.stdout.write = (text) => {
          writes.push(text)
          if (text === "\\x1b]10;?\\x07\\x1b[c") process.stdin.emit("data", Buffer.from(replies[read++] ?? ""))
          return true
        }
        let batch
        try {
          batch = await runProbeBatch({
            ids: ["extensions.osc110-reset-fg"],
            ownedTerminal: owner,
            captureRunId: ${JSON.stringify(captureRunId)},
            out: process.stdout,
            target: { kind: "app", id: "kitty", os: "macos" },
          })
        } finally {
          process.stdout.write = originalWrite
        }
        console.log("BATCH " + JSON.stringify({
          writes,
          observation: batch.observations.find((row) => row.featureId === "extensions.osc110-reset-fg"),
          result: batch.results.find((row) => row.featureId === "extensions.osc110-reset-fg"),
          assertions: batch.assertions,
          ownership: JSON.parse(batch.rawReplies["collector.disposableOwnership"]),
        }))
      }
    } catch (error) {
      console.log("REFUSED " + error.message)
    }
  `
  return spawnSync(process.execPath, ["-e", script], { cwd: packageRoot, encoding: "utf8", timeout: 20_000 })
}

test("kitty is granted by the shared process proof: marker, executable, TTY and ancestry all checked", () => {
  const result = runDarwinArm({
    provider: "kitty",
    workerPid: "self",
    ownerPid: 4242,
    marker: { flag: "--instance-group", value: `terminfo-${launchRunId}` },
    parent: { self: 4242, "4242": 1 },
  })
  expect(result.stderr).toBe("")
  expect(result.stdout.trim()).toBe("GRANTED /dev/ttys004")
})

test("cli-process is granted by the same arm, not by a second proof", () => {
  const result = runDarwinArm({
    provider: "cli-process",
    workerPid: "self",
    ownerPid: 4343,
    marker: { flag: "--probe-run", value: `run-${launchRunId}` },
    command: `${process.execPath} --probe-run run-${launchRunId}`,
    parent: { self: 4343, "4343": 1 },
  })
  expect(result.stderr).toBe("")
  expect(result.stdout.trim()).toBe("GRANTED /dev/ttys004")
})

// Existing owner tests stop at construction; receipt-based batch tests do not carry the real
// private grant across this boundary. These cases keep both constructor and callback real.
test.each([
  { batch: "process" as const, allowed: true },
  { batch: "terminal-app" as const, allowed: false },
  { batch: "disposed" as const, allowed: false },
])("$batch ownership carries only its actual reset authority into the batch", ({ batch, allowed }) => {
  const marker = { flag: "--instance-group", value: `terminfo-${launchRunId}` }
  const result = runDarwinArm({
    provider: "kitty",
    workerPid: "self",
    ownerPid: 4242,
    marker,
    parent: { self: 4242, "4242": 1 },
    batch,
  })
  expect(result.status).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.stdout).toMatch(/^BATCH /)
  const recorded = JSON.parse(result.stdout.slice("BATCH ".length)) as {
    writes: string[]
    observation: Observation
    result: ProbeResult
    assertions: ProbeAssertion[]
    ownership: { kind: string }
  }
  expect(recorded.ownership).toEqual({ kind: "shared" })
  if (allowed) {
    expect(recorded.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
    expect(recorded.observation.note).toContain(
      `run-scoped process owner pid 4242, marker ${marker.flag} ${marker.value}`,
    )
    expect(recorded.result).toMatchObject({ status: "supported", attempt: { scope: "probe" } })
    expect(recorded.assertions).toContainEqual(expect.objectContaining({ kind: "positive" }))
    expect(recorded.writes).toEqual([
      "\x1b]10;?\x07\x1b[c",
      "\x1b]10;rgb:aa/bb/cc\x07",
      "\x1b]10;?\x07\x1b[c",
      "\x1b]110\x07",
      "\x1b]10;?\x07\x1b[c",
    ])
  } else {
    const refusal =
      batch === "terminal-app"
        ? "no verified disposable-ownership receipt was presented"
        : "neither a verified owned terminal nor a verified disposable-ownership receipt was presented"
    expect(recorded.writes).toEqual([])
    expect(recorded.observation).toMatchObject({
      outcome: "inconclusive",
      reason: "policy-refused",
      note: `Collector refused before sending bytes because ${refusal}`,
    })
    expect(recorded.result).toMatchObject({ status: "test-todo", tests: [{ id: "prerequisite" }] })
    expect(recorded.assertions).toEqual([])
  }
})

test.each([
  {
    name: "a claim from another launch run",
    scenario: { claimRunId: "e".repeat(32) },
    refusal: /kitty owner assertion differs from this worker launch run or PID/,
  },
  {
    name: "a claim naming another worker pid",
    scenario: { workerPid: 5151 },
    refusal: /kitty owner assertion differs from this worker launch run or PID/,
  },
  {
    name: "a worker whose environment names another run",
    scenario: { envRunId: "f".repeat(32) },
    refusal: /kitty owner assertion differs from this worker launch run or PID/,
  },
  {
    name: "a marker that does not carry this launch run id",
    scenario: { marker: { flag: "--instance-group", value: "terminfo-othe-run" } },
    refusal: /kitty owned-process marker value "terminfo-othe-run" does not contain the run id/,
  },
  {
    name: "a daemon that does not descend from the claimed owner",
    scenario: { parent: { self: 777, "777": 1 } },
    refusal: /daemon pid \d+ is not a descendant of kitty pid 4242; chain \d+ -> 777 -> 1/,
  },
])("refuses $name", ({ scenario, refusal }) => {
  const result = runDarwinArm({
    provider: "kitty",
    workerPid: "self",
    ownerPid: 4242,
    marker: { flag: "--instance-group", value: `terminfo-${launchRunId}` },
    parent: { self: 4242, "4242": 1 },
    ...scenario,
  })
  expect(result.stderr).toBe("")
  expect(result.stdout.trim()).toMatch(/^REFUSED /)
  expect(result.stdout).toMatch(refusal)
})

test("process alone on Linux refuses by platform, not as a missing arm", async () => {
  await expect(
    createOwnedTerminal({
      captureRunId,
      expectedLaunchRunId: launchRunId,
      out: process.stdout,
      process: assertionFor({
        provider: "kitty",
        ownerPid: 4242,
        executablePath: process.execPath,
        marker: { flag: "--instance-group", value: `terminfo-${launchRunId}` },
      }),
    }),
  ).rejects.toThrow(/Owned process owner requires Darwin/)
})

test("terminalApp plus process is two arms, refused before any proof runs", async () => {
  await expect(
    createOwnedTerminal({
      captureRunId,
      expectedLaunchRunId: launchRunId,
      out: process.stdout,
      terminalApp: {
        asserter: "terminfo-admin",
        launchRunId,
        workerPid: 123,
        windowId: 791,
        tabTty: "/dev/ttys004",
        intendedVersion: "2.15",
      },
      process: assertionFor({
        provider: "cli-process",
        ownerPid: 4343,
        executablePath: process.execPath,
        marker: { flag: "--probe-run", value: `run-${launchRunId}` },
      }),
    }),
  ).rejects.toThrow(/Owned terminal requires exactly one platform receipt/)
})

test("the process assertion has one strict shape: exact keys, known provider, absolute executable, no window id", () => {
  const valid = assertionFor({
    provider: "kitty",
    ownerPid: 4242,
    executablePath: "/Applications/kitty.app/Contents/MacOS/kitty",
    marker: { flag: "--instance-group", value: `terminfo-${launchRunId}` },
  })
  expect(parseProcessOwnerAssertion(valid)).toEqual(valid)
  for (const assertion of [
    null,
    { ...valid, asserter: "other" },
    { ...valid, launchRunId: "short" },
    { ...valid, workerPid: 0 },
    { ...valid, provider: "terminal-app" },
    { ...valid, ownerPid: 0 },
    { ...valid, executablePath: "relative/kitty" },
    { ...valid, marker: { flag: "", value: "x" } },
    { ...valid, marker: { flag: "--instance-group", value: "has space" } },
    { ...valid, marker: { flag: "--instance-group", value: "x", extra: true } },
    { ...valid, tty: "/dev/tty" },
    { ...valid, intendedVersion: "" },
    { ...valid, windowId: 14 },
    { ...valid, extra: true },
  ]) {
    expect(() => parseProcessOwnerAssertion(assertion)).toThrow(/Invalid process owner assertion/)
  }
})
