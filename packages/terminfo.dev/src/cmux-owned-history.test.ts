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
  CMUX_0_65_2_NO_EVENT_COMPLETION_QUALIFIER,
  cmuxConfigGuard,
  cmuxHistoryIdentity,
  cmuxMarkerProof,
  cmuxNonceProof,
  createOwnedCmuxWorkspaceCwdReader,
  observeCmuxConfig,
  ownedCmuxHistoryExecutable,
  parseCmuxCliShortVersion,
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

// #34271, CTO ae9e3795: reproducible projections of the recorded 34263 reads, with prompt
// text omitted. Counts/tail order and the lone post-clear newline are the determining bytes.
// Existing reader cases asserted the superseded unconditional screen-text refusal.
const recordedHistory = ["prompt", ...Array.from({ length: 100 }, (_, i) => `MK-${i + 1}`)]
const clearedHistory = ["prompt-1", "prompt-2", ...Array.from({ length: 19 }, (_, i) => `MK-${i + 1}`)]
test.each([
  {
    name: "full screen",
    history: recordedHistory.join("\n") + "\n",
    screen: recordedHistory.slice(-81).join("\n") + "\n",
    total: 101,
    visible: 81,
    agrees: true,
  },
  { name: "post ESC[2J", history: clearedHistory.join("\n") + "\n", screen: "\n", total: 21, visible: 0, agrees: true },
  { name: "disagreeing reads", history: "retained\nkeep \n", screen: "keep\n", total: 2, visible: 1, agrees: false },
])("recorded cmux paired reading: $name", ({ history, screen, total, visible, agrees }) => {
  const read = readOwnedCmuxHistory({
    executable,
    ownership: { kind: "surface" },
    configAtLaunch: { read: "present", sha256: configSha256 },
    observeConfig: () => ({ read: "present", sha256: configSha256 }),
    spawn: (args) => ({ status: 0, stdout: args.includes("--scrollback") ? history : screen, stderr: "" }),
  })
  expect(read).toMatchObject(
    agrees
      ? { status: "read", reading: { totalLines: total, screenLines: visible } }
      : {
          status: "owned-unreadable",
          refusal: "cmux-reads-disagree",
          facts: { totalLines: total, screenLines: visible },
        },
  )
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

test("the executable proof invokes the `version` subcommand (never `--version`) and parses real versionSummary shapes", () => {
  files.readFileSync.mockReturnValue(Buffer.from("cmux-binary"))
  files.statSync.mockReturnValue({ isFile: () => true, size: 11 })
  // MacOS/cmux treats `--version` as a GUI launch flag (CLIForwardingDecision.swift:38-47) and exits 0 with empty stdout
  // when an instance is already running (hosted run 44396537489); only subcommand `version` forwards to Resources/bin/cmux.
  child.spawnSync.mockImplementation((_file, args: readonly string[]) =>
    args[0] === "version"
      ? { status: 0, stdout: "cmux 0.65.2 (111)\n", stderr: "" }
      : { status: 0, stdout: "", stderr: "" },
  )
  const measured = cmuxHistoryIdentity(executable)
  expect(child.spawnSync).toHaveBeenCalledWith(executable, ["version"], { encoding: "utf8", timeout: 5000 })
  expect(measured?.historyReadsThroughCli).toBe(true)
  expect(measured?.historyExecutable?.path).toBe(executable)
  // The CLI's own first line, verbatim: an identity field is never a rewritten version.
  expect(measured?.historyExecutable?.version).toBe("cmux 0.65.2 (111)")

  expect(parseCmuxCliShortVersion("cmux 0.65.2")).toBe("0.65.2")
  expect(parseCmuxCliShortVersion("cmux 0.65.2 (111)")).toBe("0.65.2")
  expect(parseCmuxCliShortVersion("cmux 0.65.2 (111) [9d01f956c51c]")).toBe("0.65.2")
  expect(parseCmuxCliShortVersion("cmux 0.65.2 (111) [9d01f956c51cd895e10e7d56b6dd7b5f6fcce625]")).toBe("0.65.2")
  expect(parseCmuxCliShortVersion("cmux 0.65.2 [9d01f956c51c]")).toBe("0.65.2")
  expect(parseCmuxCliShortVersion("cmux 0.65.1 (110)")).toBe("0.65.1")
  for (const malformed of [
    undefined,
    "",
    "cmux build 111",
    "cmux version unknown",
    "cmux 0.65.2 ()",
    "cmux 0.65.2 []",
    "cmux 0.65.2 (111) trailing",
    "0.65.2",
  ]) {
    expect(parseCmuxCliShortVersion(malformed), String(malformed)).toBeUndefined()
  }

  // A CLI that answers no version leaves the identity unmeasured with its own reason: the WezTerm contract,
  // never a version borrowed from a release note and never a null passed off as one.
  child.spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "unknown flag" })
  const unmeasured = cmuxHistoryIdentity(executable)
  expect(unmeasured?.historyExecutable).toBeUndefined()
  expect(unmeasured?.historyExecutableUnmeasured).toContain("reported no version")
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

test("the reader proves the nonce arm and counts the paired screen response", () => {
  const read = readOwnedCmuxHistory({
    executable,
    ownership: { kind: "nonce", nonce },
    configAtLaunch: { read: "present" as const, sha256: configSha256 },
    observeConfig: () => ({ read: "present" as const, sha256: configSha256 }),
    spawn: () => ({ status: 0, stdout: `CMUX-${nonce}-BEGIN\nINSIDE-1\nINSIDE-2`, stderr: "" }),
  })
  expect(read).toMatchObject({ status: "read", reading: { totalLines: 3, screenLines: 3 } })

  // The proof this read made survives the refusal (@dev/brain 46a8e182): a caller must be able to record the
  // surface as OWNED and the count as unreadable, instead of reporting an ownership failure for a count it
  // could not read. These are the receipt and the facts the grant record is built from.
  expect(read.status === "read" && read.receipt).toContain('"ownership":"nonce"')
  expect(read.status === "read" && read.facts).toMatchObject({
    ownership: "nonce",
    markers: null,
    extras: 2,
    totalLines: 3,
    screenLines: 3,
  })
})

test("the socket guard is proved by what the run observed at launch and after", () => {
  const present = { read: "present" as const, sha256: configSha256 }
  expect(cmuxConfigGuard({ atLaunch: present, afterRun: present })).toEqual({
    status: "unchanged",
    observed: "present",
  })
  // A fresh runner may have no file at all: absent on both sides is an honest "nothing changed", and the
  // receipt says absent rather than claiming cmuxOnly was verified.
  const absent = { read: "absent" as const }
  expect(cmuxConfigGuard({ atLaunch: absent, afterRun: absent })).toEqual({ status: "unchanged", observed: "absent" })
  const changed = cmuxConfigGuard({ atLaunch: present, afterRun: { read: "present", sha256: "0".repeat(64) } })
  expect(changed.status === "refused" && changed.refusal).toBe("cmux-config-hash-changed")
  const appeared = cmuxConfigGuard({ atLaunch: absent, afterRun: present })
  expect(appeared.status === "refused" && appeared.refusal).toBe("cmux-config-hash-changed")
  // Unrecorded or unreadable leaves the guard unproven, never assumed.
  for (const guard of [
    cmuxConfigGuard({ atLaunch: undefined, afterRun: present }),
    cmuxConfigGuard({ atLaunch: present, afterRun: undefined }),
    cmuxConfigGuard({ atLaunch: { read: "unreadable", reason: "EACCES" }, afterRun: present }),
  ]) {
    expect(guard.status === "refused" && guard.refusal).toBe("cmux-config-hash-changed")
  }
})

test("the config observation separates absent from unreadable", () => {
  const missing = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
  files.readFileSync.mockImplementation(() => {
    throw missing
  })
  expect(observeCmuxConfig("/Users/runner/.config/cmux/cmux.json")).toEqual({ read: "absent" })
  files.readFileSync.mockImplementation(() => {
    throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
  })
  expect(observeCmuxConfig("/Users/runner/.config/cmux/cmux.json").read).toBe("unreadable")
  files.readFileSync.mockReturnValue(Buffer.from("{}"))
  const present = observeCmuxConfig("/Users/runner/.config/cmux/cmux.json")
  expect(present.read).toBe("present")
  expect(present.read === "present" && present.sha256).toHaveLength(64)
})

test("the reader names the surface it reads and returns retained lines, not the viewport", () => {
  const calls: string[][] = []
  const transcripts: string[] = []
  const read = readOwnedCmuxHistory({
    executable,
    surface: "surface:1000070000",
    ownership: { kind: "markers" as const, prefix: "INSIDE-", count: 12, nonce },
    configAtLaunch: { read: "present" as const, sha256: configSha256 },
    observeConfig: () => ({ read: "present" as const, sha256: configSha256 }),
    retainTranscript: (stdout) => {
      transcripts.push(stdout)
      return `sha256:${configSha256}`
    },
    spawn: (args) => {
      calls.push([...args])
      return { status: 0, stdout: transcriptOf(12), stderr: "" }
    },
  })
  expect(calls).toEqual([
    ["read-screen", "--surface", "surface:1000070000", "--scrollback"],
    ["read-screen", "--surface", "surface:1000070000"],
  ])
  expect(read).toMatchObject({ status: "read", reading: { totalLines: 16, screenLines: 16 } })
  expect(read.status === "read" && read.receipt).toContain('"surface:1000070000"')
  expect(transcripts).toEqual([transcriptOf(12), transcriptOf(12)])
})

test("an empty read names what it read, so a blank screen is not called no output", () => {
  const base = {
    executable,
    ownership: { kind: "surface" as const },
    configAtLaunch: { read: "present" as const, sha256: configSha256 },
    observeConfig: () => ({ read: "present" as const, sha256: configSha256 }),
  }
  // A cleared screen still returns rows; cmux prints them blank and the reader normalizes them away.
  const blankRows = readOwnedCmuxHistory({
    ...base,
    spawn: () => ({ status: 0, stdout: `${"\n".repeat(35)}\n`, stderr: "" }),
  })
  expect(blankRows).toMatchObject({ status: "refused", refusal: "cmux-read-empty" })
  expect(blankRows.status === "refused" && blankRows.reason).toBe(
    "cmux read-screen returned no lines (stdout 36 bytes, 36 rows, 36 blank)",
  )
  // A CLI that answered nothing says so, with zero bytes.
  const nothing = readOwnedCmuxHistory({ ...base, spawn: () => ({ status: 0, stdout: "", stderr: "" }) })
  expect(nothing.status === "refused" && nothing.reason).toBe(
    "cmux read-screen returned no lines (stdout 0 bytes, 0 rows, 0 blank)",
  )
})

test("a surface read refuses empty history, failed reads or a moved guard", () => {
  const retained: string[] = []
  const base = {
    executable,
    ownership: { kind: "surface" as const },
    configAtLaunch: { read: "present" as const, sha256: configSha256 },
    spawn: () => ({ status: 0, stdout: transcriptOf(12, measuredExtra, false), stderr: "" }),
    observeConfig: () => ({ read: "present" as const, sha256: configSha256 }),
    retainTranscript: (stdout: string) => {
      retained.push(stdout)
      return `sha256:${configSha256}`
    },
  }
  const read = readOwnedCmuxHistory(base)
  expect(read).toMatchObject({ status: "read", reading: { totalLines: 14, screenLines: 14 } })
  const empty = readOwnedCmuxHistory({ ...base, spawn: () => ({ status: 0, stdout: "", stderr: "" }) })
  expect(empty).toMatchObject({ status: "refused", refusal: "cmux-read-empty" })
  const moved = readOwnedCmuxHistory({
    ...base,
    observeConfig: () => ({ read: "present" as const, sha256: "f".repeat(64) }),
  })
  expect(moved.status === "refused" && moved.refusal).toBe("cmux-config-hash-changed")
  expect(retained).toEqual([
    transcriptOf(12, measuredExtra, false),
    transcriptOf(12, measuredExtra, false),
    "",
    transcriptOf(12, measuredExtra, false),
  ])
  const failedScreen = readOwnedCmuxHistory({
    ...base,
    spawn: (args) => ({
      status: args.includes("--scrollback") ? 0 : 1,
      stdout: args.includes("--scrollback") ? "history\n" : "",
      stderr: "",
    }),
  })
  expect(failedScreen).toMatchObject({
    status: "owned-unreadable",
    refusal: "cmux-read-failed",
    facts: { totalLines: 1, screenLines: null },
  })
  expect(() =>
    readOwnedCmuxHistory({
      ...base,
      retainTranscript: () => {
        throw new Error("private artifact write failed")
      },
    }),
  ).toThrow("private artifact write failed")
  // cmux's own denial phrase goes to the collector's stderr log, never into the published reason
  // (the sibling WezTerm arm proves the same split), so the read is taken with the log captured.
  const stderrLog: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    stderrLog.push(args.map(String).join(" "))
  }
  let denied: ReturnType<typeof readOwnedCmuxHistory>
  try {
    denied = readOwnedCmuxHistory({
      ...base,
      spawn: () => ({
        status: 1,
        stdout: "",
        stderr: "Access denied - only processes started inside cmux can connect",
      }),
    })
  } finally {
    console.error = originalError
  }
  expect(denied.status === "refused" && denied.refusal).toBe("cmux-surface-not-owned")
  expect(stderrLog.join("\n")).toContain("Access denied")
})

test("a surface read obtains its screen count without a measured grid", () => {
  const read = readOwnedCmuxHistory({
    executable,
    ownership: { kind: "surface" as const },
    configAtLaunch: { read: "present" as const, sha256: configSha256 },
    spawn: () => ({ status: 0, stdout: transcriptOf(3, measuredExtra, false), stderr: "" }),
    observeConfig: () => ({ read: "present" as const, sha256: configSha256 }),
  })
  expect(read).toMatchObject({ status: "read", reading: { totalLines: 5, screenLines: 5 } })
})

test("bound cmux workspace cwd reader pins workspace lifetime, enforces nullable selection schema, and qualifies exact-pin no-event completion", async () => {
  let workspaceId = "ws-owned-1"
  let currentDirectory = "/Users/runner/project"
  let focused = true
  let selectedInPane: boolean | null = true
  let resumeBinding: object | null = null
  let tmuxStartCommand: string | null = null
  let dockScope: string | undefined
  let initialCommand: string | null = null
  let remoteEnabled = false
  let configHash = configSha256
  const screenRows = ["", "", "", ""]
  const retained: string[] = []
  let ownerChecks = 0

  const makeReader = (overrides?: Partial<Parameters<typeof createOwnedCmuxWorkspaceCwdReader>[0]>) =>
    createOwnedCmuxWorkspaceCwdReader({
      executable,
      surface: "surface-owned-1",
      configAtLaunch: { read: "present", sha256: configSha256 },
      observeConfig: () => ({ read: "present", sha256: configHash }),
      retainTranscript: (stdout) => {
        retained.push(stdout)
        return `sha256:${configSha256}`
      },
      checkOwner: () => {
        ownerChecks += 1
      },
      noEventCompletionQualified: true,
      pollIntervalMs: 5,
      deadlineMs: 250,
      spawn: (args) => {
        if (args[0] === "read-screen") {
          return { status: 0, stdout: `${screenRows.join("\n")}\n`, stderr: "" }
        }
        if (args[0] === "rpc" && args[1] === "surface.list") {
          return {
            status: 0,
            stdout: JSON.stringify({
              workspace_id: workspaceId,
              surfaces: [
                {
                  id: "surface-owned-1",
                  type: "terminal",
                  focused,
                  selected_in_pane: selectedInPane,
                  resume_binding: resumeBinding,
                  tmux_start_command: tmuxStartCommand,
                  initial_command: initialCommand,
                  ...(dockScope === undefined ? {} : { dock_scope: dockScope }),
                },
              ],
            }),
            stderr: "",
          }
        }
        if (args[0] === "rpc" && args[1] === "workspace.current") {
          return {
            status: 0,
            stdout: JSON.stringify({
              workspace_id: workspaceId,
              workspace: {
                id: workspaceId,
                selected: true,
                current_directory: currentDirectory,
                remote: { enabled: remoteEnabled, connected: remoteEnabled },
              },
            }),
            stderr: "",
          }
        }
        return { status: 1, stdout: "", stderr: "unexpected command" }
      },
      ...overrides,
    })

  const readCwd = makeReader()
  const initial = await readCwd()
  expect(initial.path).toBe("/Users/runner/project")
  expect(initial.detail).toMatchObject({
    workspaceId: "ws-owned-1",
    surfaceId: "surface-owned-1",
    focused: true,
    selectedInPane: true,
  })
  expect(ownerChecks).toBeGreaterThanOrEqual(4)

  // Sample 1 (unknown OSC 133;Z): requires the row-1 screen marker and attaches the exact-pin no-event qualifier.
  screenRows[0] = "Q-nonce-0"
  const unknown = await readCwd({
    row: 1,
    marker: "Q-nonce-0",
    phase: "unknown",
    expectedPath: "/Users/runner/project",
  })
  expect(unknown.path).toBe("/Users/runner/project")
  expect(unknown.detail).toMatchObject({
    completionQualifier: CMUX_0_65_2_NO_EVENT_COMPLETION_QUALIFIER,
  })

  // Sample 2 (handled OSC 7): waits for delayed async delivery beyond 50 ms after the row-2 screen marker.
  screenRows[1] = "Q-nonce-1"
  setTimeout(() => {
    currentDirectory = "/terminfo-control-nonce"
  }, 80)
  const handled = await readCwd({
    row: 2,
    marker: "Q-nonce-1",
    phase: "handled",
    expectedPath: "/terminfo-control-nonce",
  })
  expect(handled.path).toBe("/terminfo-control-nonce")

  // Sample 3 (target OSC 633;P;Cwd=...): at the exact qualified pin, unchanged after the row-3 marker is completion-qualified.
  screenRows[2] = "Q-nonce-2"
  const target = await readCwd({
    row: 3,
    marker: "Q-nonce-2",
    phase: "target",
    expectedPath: "/terminfo-target-nonce",
  })
  expect(target.path).toBe("/terminfo-control-nonce")
  expect(target.detail).toMatchObject({
    completionQualifier: CMUX_0_65_2_NO_EVENT_COMPLETION_QUALIFIER,
  })

  // A moved workspace id mid-run must fail closed even when CMUX_WORKSPACE_ID was not supplied.
  workspaceId = "ws-other-2"
  await expect(readCwd()).rejects.toThrow(/workspace_id changed/)
  workspaceId = "ws-owned-1"

  // Nullable selected_in_pane: null must fail closed rather than silently claim selection.
  selectedInPane = null
  await expect(readCwd()).rejects.toThrow(/selected in its pane/)
  selectedInPane = true

  // Lost focus between phase reads must fail closed.
  focused = false
  await expect(readCwd()).rejects.toThrow(/no longer focused/)
  focused = true

  // Non-fresh or remote provenance must fail closed.
  resumeBinding = { name: "agent" }
  await expect(readCwd()).rejects.toThrow(/resume_binding/)
  resumeBinding = null

  tmuxStartCommand = "tmux attach"
  await expect(readCwd()).rejects.toThrow(/tmux_start_command/)
  tmuxStartCommand = null

  dockScope = "workspace"
  await expect(readCwd()).rejects.toThrow(/dock panel/)
  dockScope = undefined

  remoteEnabled = true
  await expect(readCwd()).rejects.toThrow(/remote provenance/)
  remoteEnabled = false

  initialCommand = "cd /tmp && zsh"
  await expect(makeReader()()).rejects.toThrow(/concurrent directory writer/)
  initialCommand = null

  configHash = "f".repeat(64)
  await expect(readCwd()).rejects.toThrow(/cmux-config-hash-changed/)
})

// @cto R2 item 5 decisive regression: control delivery 60 ms followed by delayed target 900 ms.
// Without the exact no-event completion qualifier, the reader must never yield Unsupported at 250 ms;
// it must observe the 900 ms target as Supported, and an unchanged target without the qualifier must fail closed.
test("without the exact no-event completion qualifier, a 60 ms control followed by a 900 ms delayed target never yields false Unsupported at 250 ms", async () => {
  let currentDirectory = "/Users/runner/project"
  const screenRows = ["Q-r2-0", "Q-r2-1", "Q-r2-2", "Q-r2-3"]
  const spawn = (args: readonly string[]) => {
    if (args[0] === "read-screen") {
      return { status: 0, stdout: `${screenRows.join("\n")}\n`, stderr: "" }
    }
    if (args[0] === "rpc" && args[1] === "surface.list") {
      return {
        status: 0,
        stdout: JSON.stringify({
          workspace_id: "ws-r2",
          surfaces: [
            {
              id: "surface-r2",
              type: "terminal",
              focused: true,
              selected_in_pane: true,
              resume_binding: null,
              tmux_start_command: null,
              initial_command: null,
            },
          ],
        }),
        stderr: "",
      }
    }
    return {
      status: 0,
      stdout: JSON.stringify({
        workspace_id: "ws-r2",
        workspace: {
          id: "ws-r2",
          selected: true,
          current_directory: currentDirectory,
          remote: { enabled: false, connected: false },
        },
      }),
      stderr: "",
    }
  }

  const unqualifiedReader = createOwnedCmuxWorkspaceCwdReader({
    executable,
    surface: "surface-r2",
    configAtLaunch: { read: "present", sha256: configSha256 },
    observeConfig: () => ({ read: "present", sha256: configSha256 }),
    noEventCompletionQualified: false,
    pollIntervalMs: 20,
    deadlineMs: 1500,
    spawn,
  })

  expect((await unqualifiedReader()).path).toBe("/Users/runner/project")

  // Control delivers in 60 ms.
  setTimeout(() => {
    currentDirectory = "/terminfo-control-r2"
  }, 60)
  const control = await unqualifiedReader({
    row: 2,
    marker: "Q-r2-1",
    phase: "handled",
    expectedPath: "/terminfo-control-r2",
  })
  expect(control.path).toBe("/terminfo-control-r2")

  // Target delivers in 900 ms (well past 4 * 60 ms = 240 ms / 250 ms clamp).
  const startedAt = Date.now()
  setTimeout(() => {
    currentDirectory = "/terminfo-target-r2"
  }, 900)
  const delayedTarget = await unqualifiedReader({
    row: 3,
    marker: "Q-r2-2",
    phase: "target",
    expectedPath: "/terminfo-target-r2",
  })
  expect(delayedTarget.path).toBe("/terminfo-target-r2")
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(850)

  // And if a target remains unchanged when noEventCompletionQualified is false, it is unresolved (throws), never Unsupported.
  currentDirectory = "/terminfo-control-r2"
  const fastUnqualified = createOwnedCmuxWorkspaceCwdReader({
    executable,
    surface: "surface-r2",
    configAtLaunch: { read: "present", sha256: configSha256 },
    observeConfig: () => ({ read: "present", sha256: configSha256 }),
    noEventCompletionQualified: false,
    pollIntervalMs: 10,
    deadlineMs: 120,
    spawn,
  })
  await expect(
    fastUnqualified({
      row: 3,
      marker: "Q-r2-2",
      phase: "target",
      expectedPath: "/terminfo-target-r2",
    }),
  ).rejects.toThrow(/without exact-pin no-event completion qualification/)
})
