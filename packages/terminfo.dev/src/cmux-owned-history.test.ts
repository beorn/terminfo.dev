/**
 * @failure A cmux history read grades a surface it does not own, counts lines instead of proving the
 *   probe's own markers, or keeps a reading taken while the socket guard or the app moved under it.
 * @level l1
 * @consumer OwnedTerminal's cmux history arm on the fleet Mac (31741 follow-up, @cto af8608c3 plan GO).
 * @testonly none
 */
import { beforeEach, expect, test, vi } from "vitest"

const child = vi.hoisted(() => ({ spawnSync: vi.fn() }))
const files = vi.hoisted(() => ({ readFileSync: vi.fn(), statSync: vi.fn() }))
vi.mock("node:child_process", () => ({ spawnSync: child.spawnSync }))
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readFileSync: files.readFileSync,
  statSync: files.statSync,
}))
import {
  cmuxConfigGuard,
  cmuxHistoryIdentity,
  cmuxMarkerProof,
  cmuxNonceProof,
  ownedCmuxHistoryExecutable,
  readOwnedCmuxHistory,
} from "./cmux-owned-history.ts"

const executable = "/Applications/cmux.app/Contents/MacOS/cmux"
const configSha256 = "0337ae576a4cfb4e73eff3446a010d037614d2dc2c21b9e563ddc86cd6f172ab"
const nonce = "9f2c41"
const expected = { prefix: "INSIDE-", count: 300, nonce } as const

// The measured transcript (/hh/var/@dev/luna3/31741/cmux-probe/inside-surface-20261113.txt), reduced:
// two shell lines the fresh surface printed before the marker block, then the markers themselves.
const measuredExtra = [
  "Last login: Fri Nov 13 05:01:13 on ttys005",
  " codi@MacBookPro     ~     /tmp/luna3-cmux/cmd.sh",
] as const
const transcriptOf = (count: number, extras: readonly string[] = measuredExtra, sentinels = true): string =>
  [
    ...(sentinels ? [`CMUX-${nonce}-BEGIN`] : []),
    ...extras,
    ...Array.from({ length: count }, (_, index) => `INSIDE-${index + 1}`),
    ...(sentinels ? [`CMUX-${nonce}-END`] : []),
  ].join("\n")

beforeEach(() => {
  child.spawnSync.mockReset()
  files.readFileSync.mockReset()
  files.statSync.mockReset()
})

test("only an owned cmux surface on macOS has a history CLI", () => {
  expect(ownedCmuxHistoryExecutable({ platform: "darwin", ownsCmuxSurface: false })).toBeUndefined()
  expect(ownedCmuxHistoryExecutable({ platform: "linux", ownsCmuxSurface: true })).toBeUndefined()
  expect(ownedCmuxHistoryExecutable({ platform: "darwin", ownsCmuxSurface: true })).toBe(executable)
  // A declared path counts only when it is absolute: a relative or empty declaration is not a program
  // this run chose.
  expect(
    ownedCmuxHistoryExecutable({ platform: "darwin", ownsCmuxSurface: true, declaredExecutable: "cmux" }),
  ).toBeUndefined()
  expect(
    ownedCmuxHistoryExecutable({
      platform: "darwin",
      ownsCmuxSurface: true,
      declaredExecutable: "/opt/cmux/bin/cmux",
    }),
  ).toBe("/opt/cmux/bin/cmux")
})

test("the executable proof hashes this run's CLI and records an unreported version as unreported", () => {
  files.readFileSync.mockReturnValue(Buffer.from("cmux-binary"))
  files.statSync.mockReturnValue({ isFile: () => true, size: 11 })
  child.spawnSync.mockReturnValue({ status: 0, stdout: "cmux 0.65.2\n", stderr: "" })
  const measured = cmuxHistoryIdentity(executable)
  expect(measured?.historyReadsThroughCli).toBe(true)
  expect(measured?.historyExecutable?.path).toBe(executable)
  // The CLI's own first line, verbatim: an identity field is never a rewritten version.
  expect(measured?.historyExecutable?.version).toBe("cmux 0.65.2")

  // A CLI that answers no version still proves which binary read the pane; the version stays null rather
  // than borrowing one from a release note.
  child.spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "unknown flag" })
  expect(cmuxHistoryIdentity(executable)?.historyExecutable?.version).toBeNull()
  expect(cmuxHistoryIdentity(undefined)).toBeUndefined()
})

test("an unreadable CLI is an unmeasured identity that always ships its reason", () => {
  files.statSync.mockImplementation(() => {
    throw new Error("ENOENT: no such file or directory")
  })
  const identity = cmuxHistoryIdentity(executable)
  expect(identity?.historyReadsThroughCli).toBe(true)
  expect(identity?.historyExecutable).toBeUndefined()
  expect(identity?.historyExecutableUnmeasured).toContain("could not be read")
})

test("the measured inside-surface transcript grades, and its two extra lines are carried verbatim", () => {
  const proof = cmuxMarkerProof({ transcript: transcriptOf(300), ...expected })
  expect(proof.status).toBe("graded")
  expect(proof.status === "graded" && proof.markers).toBe(300)
  expect(proof.status === "graded" && proof.extras).toEqual([...measuredExtra])
})

test("a transcript missing one marker refuses by that marker's own name", () => {
  const lines = transcriptOf(300)
    .split("\n")
    .filter((line) => line !== "INSIDE-7")
  const proof = cmuxMarkerProof({ transcript: lines.join("\n"), ...expected })
  expect(proof.status).toBe("refused")
  expect(proof.status === "refused" && proof.refusal).toBe("cmux-marker-missing")
  expect(proof.status === "refused" && proof.reason).toContain("INSIDE-7")
})

test("a transcript whose markers arrive out of order refuses rather than sorting them", () => {
  const lines = transcriptOf(10).split("\n")
  const at = lines.indexOf("INSIDE-3")
  lines[at] = "INSIDE-4"
  lines[at + 1] = "INSIDE-3"
  const proof = cmuxMarkerProof({ transcript: lines.join("\n"), ...expected, count: 10 })
  expect(proof.status === "refused" && proof.refusal).toBe("cmux-markers-out-of-order")
})

test("an empty read is its own refusal, never a zero-line grade", () => {
  const proof = cmuxMarkerProof({ transcript: "", ...expected })
  expect(proof.status === "refused" && proof.refusal).toBe("cmux-read-empty")
})

test("a read without this run's sentinels, or with them duplicated, is not this surface's history", () => {
  const missing = cmuxMarkerProof({ transcript: transcriptOf(10, measuredExtra, false), ...expected, count: 10 })
  expect(missing.status === "refused" && missing.refusal).toBe("cmux-surface-not-owned")
  const duplicated = `${transcriptOf(10)}\nCMUX-${nonce}-BEGIN`
  const twice = cmuxMarkerProof({ transcript: duplicated, ...expected, count: 10 })
  expect(twice.status === "refused" && twice.refusal).toBe("cmux-surface-not-owned")
  // A second run's nonce in the same pane is someone else's block, not this run's history.
  const foreign = transcriptOf(10).replace(`CMUX-${nonce}-END`, "CMUX-other-END")
  const other = cmuxMarkerProof({ transcript: foreign, ...expected, count: 10 })
  expect(other.status === "refused" && other.refusal).toBe("cmux-surface-not-owned")
})

test("the ordinary arm proves its own surface by the one nonce line it wrote", () => {
  const owned = cmuxNonceProof({
    transcript: transcriptOf(3, measuredExtra, false).replace(/^/, `CMUX-${nonce}-BEGIN\n`),
    nonce,
  })
  expect(owned.status).toBe("graded")
  expect(owned.status === "graded" && owned.extras).not.toContain(`CMUX-${nonce}-BEGIN`)
  const foreign = cmuxNonceProof({ transcript: transcriptOf(3, measuredExtra, false), nonce })
  expect(foreign.status === "refused" && foreign.refusal).toBe("cmux-surface-not-owned")
  const twice = cmuxNonceProof({ transcript: `CMUX-${nonce}-BEGIN\nCMUX-${nonce}-BEGIN\nINSIDE-1`, nonce })
  expect(twice.status === "refused" && twice.refusal).toBe("cmux-surface-not-owned")
  expect(cmuxNonceProof({ transcript: "\n", nonce }).status).toBe("refused")
})

test("the reader grades the nonce arm and still reports retained lines", () => {
  const read = readOwnedCmuxHistory({
    executable,
    rows: 50,
    ownership: { kind: "nonce", nonce },
    configSha256AtLaunch: configSha256,
    readConfigSha256: () => configSha256,
    spawn: () => ({ status: 0, stdout: `CMUX-${nonce}-BEGIN\nINSIDE-1\nINSIDE-2`, stderr: "" }),
    processCount: () => 0,
  })
  expect(read.status).toBe("read")
  expect(read.status === "read" && read.reading.totalLines).toBe(3)
  expect(read.status === "read" && (JSON.parse(read.receipt) as { ownership: string }).ownership).toBe("nonce")
})

test("the socket guard is proved by the config hash the run recorded at launch", () => {
  expect(cmuxConfigGuard({ sha256AtLaunch: configSha256, sha256AfterRun: configSha256 }).status).toBe("unchanged")
  const changed = cmuxConfigGuard({ sha256AtLaunch: configSha256, sha256AfterRun: "0".repeat(64) })
  expect(changed.status === "refused" && changed.refusal).toBe("cmux-config-hash-changed")
  // An unrecorded or unreadable hash leaves cmuxOnly unproven, so it refuses instead of assuming the default.
  for (const guard of [
    cmuxConfigGuard({ sha256AtLaunch: undefined, sha256AfterRun: configSha256 }),
    cmuxConfigGuard({ sha256AtLaunch: configSha256, sha256AfterRun: undefined }),
  ]) {
    expect(guard.status === "refused" && guard.refusal).toBe("cmux-config-hash-changed")
  }
})

test("the reader names the surface it reads and returns retained lines, not the viewport", () => {
  const calls: string[][] = []
  const read = readOwnedCmuxHistory({
    executable,
    surface: "surface:1000070000",
    rows: 50,
    ownership: { kind: "markers" as const, prefix: "INSIDE-", count: 12, nonce },
    configSha256AtLaunch: configSha256,
    readConfigSha256: () => configSha256,
    spawn: (args) => {
      calls.push([...args])
      return { status: 0, stdout: transcriptOf(12), stderr: "" }
    },
    processCount: () => 0,
  })
  expect(calls).toEqual([["read-screen", "--surface", "surface:1000070000", "--scrollback"]])
  expect(read.status).toBe("read")
  expect(read.status === "read" && read.reading.totalLines).toBe(16)
  expect(read.status === "read" && read.reading.screenLines).toBe(50)
  // Unreported stays absent: cmux answers no viewport offset and no capacity, and both stay unclaimed.
  expect(read.status === "read" && read.reading.viewportOffset).toBeUndefined()
  expect(read.status === "read" && read.reading.capacity).toBeUndefined()
})

test("the reader refuses when a cmux process outlives the run or the guard moved", () => {
  const base = {
    executable,
    rows: 50,
    ownership: { kind: "markers" as const, prefix: "INSIDE-", count: 12, nonce },
    configSha256AtLaunch: configSha256,
    spawn: () => ({ status: 0, stdout: transcriptOf(12), stderr: "" }),
  }
  const left = readOwnedCmuxHistory({ ...base, readConfigSha256: () => configSha256, processCount: () => 1 })
  expect(left.status === "refused" && left.refusal).toBe("cmux-process-left")
  const moved = readOwnedCmuxHistory({ ...base, readConfigSha256: () => "f".repeat(64), processCount: () => 0 })
  expect(moved.status === "refused" && moved.refusal).toBe("cmux-config-hash-changed")
  const failed = readOwnedCmuxHistory({
    ...base,
    spawn: () => ({ status: 1, stdout: "", stderr: "Access denied - only processes started inside cmux can connect" }),
    readConfigSha256: () => configSha256,
    processCount: () => 0,
  })
  expect(failed.status === "refused" && failed.refusal).toBe("cmux-surface-not-owned")
})
