/**
 * @failure An owned iTerm2 run adopts an iTerm2 that predates it, a second instance, a restored or
 * borrowed window, or a session whose TTY is not the one the run script recorded, and reports it as owned.
 * @level l1
 * @consumer The admin's owned iTerm2 launch (runApp) and the window record its assert and close act on.
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { beforeEach, describe, expect, test, vi } from "vitest"
import {
  assertIterm2SuiteLive,
  prepareIterm2Launch,
  resolveIterm2Window,
  teardownIterm2Suite,
  verifyIterm2IsolationAfterClose,
  type Iterm2Launch,
} from "./iterm2-launch.ts"

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }))
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  lstatSync: vi.fn(() => ({ isSymbolicLink: () => false })),
  readFileSync: vi.fn(),
  realpathSync: vi.fn(),
  rmSync: vi.fn(),
}))

const executablePath = "/Applications/iTerm.app/Contents/MacOS/iTerm2"
const homeDir = "/Users/codi"
const suiteDomain = "dev.terminfo.iterm2.0123456789abcdef0123456789abcdef"
const marker = { flag: "-suite", value: suiteDomain }
const targets = {
  suiteDomain,
  operatorPrefsPath: `${homeDir}/Library/Preferences/com.googlecode.iterm2.plist`,
  suitePrefsPath: `${homeDir}/Library/Preferences/${suiteDomain}.plist`,
  appSupportDir: `${homeDir}/Library/Application Support/${suiteDomain}`,
  dotSuiteDir: `${homeDir}/.${suiteDomain}`,
}
const operatorPrefsBytes = Buffer.from("operator-iterm2-plist-bytes")
const operatorPrefsSha = createHash("sha256").update(operatorPrefsBytes).digest("hex")
const preflightAt = Date.UTC(2026, 10, 12, 13, 22, 0) / 1000
const lstart = (second: number) => `Thu Nov 12 13:22:${String(second).padStart(2, "0")} 2026`
const window = (id: number, ownerPid: number, extra: Record<string, unknown> = {}) => ({
  id,
  ownerPid,
  layer: 0,
  bounds: { x: 0, y: 25, width: 800, height: 600 },
  alpha: 1,
  onscreen: true,
  ...extra,
})

interface Host {
  processes: Array<{ pid: number; second: number; comm?: string; command?: string }>
  windows: unknown[]
  defaultsRead?: Record<string, { status: number; stdout?: string; stderr?: string }>
  defaultsDelete?: { status: number; stderr?: string }
}

function fakeHost(host: Host): string[][] {
  const appleEvents: string[][] = []
  vi.mocked(spawnSync).mockImplementation(((command: string, args: readonly string[]) => {
    const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" })
    if (command === "sleep") return ok("")
    if (command === "/bin/ps" && args.includes("-U")) {
      return ok(
        [
          `  1 ${lstart(0)} /sbin/launchd`,
          ...host.processes.map((row) => `${row.pid} ${lstart(row.second)} ${row.comm ?? executablePath}`),
        ].join("\n") + "\n",
      )
    }
    if (command === "/bin/ps" && args.includes("-p") && args.includes("command=")) {
      const pid = Number(args[args.indexOf("-p") + 1])
      const found = host.processes.find((row) => row.pid === pid)
      if (!found) return { status: 1, stdout: "", stderr: "" }
      const cmd =
        found.command ??
        `${found.comm ?? executablePath} ${marker.flag} ${marker.value} --command=/private/run/serve.sh`
      return ok(`${cmd}\n`)
    }
    if (command === "/bin/ps" && args.includes("-p") && args.includes("comm=")) {
      const pid = Number(args[args.indexOf("-p") + 1])
      const found = host.processes.find((row) => row.pid === pid)
      if (!found) return { status: 1, stdout: "", stderr: "" }
      return ok(`${found.comm ?? executablePath}\n`)
    }
    if (command === "/usr/bin/defaults" && args[0] === "read") {
      const domain = String(args[1] ?? "")
      const reply = host.defaultsRead?.[domain]
      if (reply) return { status: reply.status, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" }
      return { status: 1, stdout: "", stderr: `Domain ${domain} does not exist\n` }
    }
    if (command === "/usr/bin/defaults" && args[0] === "delete") {
      const domain = String(args[1] ?? "")
      if (host.defaultsDelete && host.defaultsDelete.status !== 0) {
        return { status: host.defaultsDelete.status, stdout: "", stderr: host.defaultsDelete.stderr ?? "" }
      }
      if (host.defaultsRead) {
        host.defaultsRead[domain] = { status: 1, stderr: `Domain ${domain} does not exist\n` }
      }
      return ok("")
    }
    if (command === "/usr/bin/osascript" && args.includes("JavaScript")) return ok(JSON.stringify(host.windows))
    if (command === "osascript") {
      appleEvents.push([...args])
      return ok("")
    }
    throw new Error(`unexpected command ${command} ${args.join(" ")}`)
  }) as unknown as typeof spawnSync)
  return appleEvents
}

const launched: Iterm2Launch = {
  executablePath,
  marker,
  targets,
  operatorPrefsBefore: { path: targets.operatorPrefsPath, present: true, sha256: operatorPrefsSha },
  preflightAtEpochSeconds: preflightAt,
  beforeWindowIds: [10, 11],
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(realpathSync).mockImplementation((path) => String(path))
  vi.mocked(existsSync).mockImplementation((path) => String(path) === targets.operatorPrefsPath)
  vi.mocked(lstatSync).mockImplementation(() => ({ isSymbolicLink: () => false }) as ReturnType<typeof lstatSync>)
  vi.mocked(readFileSync).mockImplementation((path) => {
    if (String(path) === targets.operatorPrefsPath) return operatorPrefsBytes
    throw Object.assign(new Error(`ENOENT ${String(path)}`), { code: "ENOENT" })
  })
})

describe("the iTerm2 preflight before the shared CLI launch", () => {
  test("refuses an iTerm2 that already runs for this account and sends it no Apple event", () => {
    const appleEvents = fakeHost({ processes: [{ pid: 812, second: 0 }], windows: [] })
    expect(() => prepareIterm2Launch("/private/run/serve.sh", executablePath, marker, homeDir)).toThrow(
      /iTerm2 is already running for this account \(pids 812\)/,
    )
    expect(appleEvents).toEqual([])
  })

  test("refuses pre-existing suite defaults domain, directories, or iTermServer without modifying them", () => {
    fakeHost({
      processes: [],
      windows: [],
      defaultsRead: { [suiteDomain]: { status: 0, stdout: "{\n    OpenNoWindowsAtStartup = 1;\n}\n" } },
    })
    expect(() => prepareIterm2Launch("/private/run/serve.sh", executablePath, marker, homeDir)).toThrow(
      /suite domain .* already exists before launch/,
    )

    fakeHost({ processes: [], windows: [] })
    vi.mocked(existsSync).mockImplementation(
      (path) => String(path) === targets.operatorPrefsPath || String(path) === targets.appSupportDir,
    )
    expect(() => prepareIterm2Launch("/private/run/serve.sh", executablePath, marker, homeDir)).toThrow(
      /already exists before launch/,
    )

    vi.mocked(existsSync).mockImplementation((path) => String(path) === targets.operatorPrefsPath)
    fakeHost({
      processes: [
        {
          pid: 910,
          second: 0,
          comm: `${targets.appSupportDir}/iTermServer-3.7.9`,
          command: `${targets.appSupportDir}/iTermServer-3.7.9 ${targets.dotSuiteDir}/1.socket`,
        },
      ],
      windows: [],
    })
    expect(() => prepareIterm2Launch("/private/run/serve.sh", executablePath, marker, homeDir)).toThrow(
      /iTermServer.*already running before launch/,
    )
    expect(rmSync).not.toHaveBeenCalled()
  })

  test("a clean preflight snapshots operator prefs sha256, records before census and waits past its second", () => {
    const appleEvents = fakeHost({
      processes: [],
      windows: [window(10, 50), window(11, 51)],
    })
    const launch = prepareIterm2Launch("/private/run/serve.sh", executablePath, marker, homeDir)
    expect(appleEvents).toEqual([])
    expect(launch).toMatchObject({
      marker,
      targets,
      operatorPrefsBefore: { path: targets.operatorPrefsPath, present: true, sha256: operatorPrefsSha },
      beforeWindowIds: [10, 11],
    })
    expect(Date.now()).toBeGreaterThanOrEqual((launch.preflightAtEpochSeconds + 1) * 1000)
  })
})

describe("resolving the owned window after the daemon registers", () => {
  test("adopts the one new onscreen window carrying the exact -suite marker despite offscreen auxiliaries", () => {
    const auxiliaries = [
      ...[804, 805, 806, 807].map((id) =>
        window(id, 900, { onscreen: false, bounds: { x: 0, y: 0, width: 1920, height: 30 } }),
      ),
      window(809, 900, { onscreen: false, bounds: { x: 0, y: 580, width: 500, height: 500 } }),
    ]
    fakeHost({ processes: [{ pid: 900, second: 1 }], windows: [window(10, 50), window(41, 900), ...auxiliaries] })
    expect(resolveIterm2Window(launched, "/dev/ttys007\n")).toEqual({
      provider: "iterm2",
      windowId: 41,
      tty: "/dev/ttys007",
      ownerPid: 900,
      executablePath,
      startedAtEpochSeconds: preflightAt + 1,
      marker,
    })
  })

  test("refuses an iTerm2 owner whose live argv lacks the exact -suite marker", () => {
    fakeHost({
      processes: [{ pid: 900, second: 1, command: `${executablePath} -suite ${suiteDomain}2` }],
      windows: [window(41, 900)],
    })
    expect(() => resolveIterm2Window(launched, "/dev/ttys007")).toThrow(
      /does not carry the launched marker -suite dev\.terminfo\.iterm2\./,
    )
  })

  test("refuses a recorded TTY that is not a terminal device", () => {
    fakeHost({ processes: [{ pid: 900, second: 1 }], windows: [window(41, 900)] })
    expect(() => resolveIterm2Window(launched, "not a tty\n")).toThrow(/Invalid Terminal tab or daemon TTY/)
  })

  test("refuses two iTerm2 processes", () => {
    fakeHost({
      processes: [
        { pid: 900, second: 1 },
        { pid: 901, second: 2 },
      ],
      windows: [window(41, 900)],
    })
    expect(() => resolveIterm2Window(launched, "/dev/ttys007")).toThrow(/exactly one .* found 2 \(pids 900, 901\)/)
  })

  test("refuses one iTerm2 that predates the preflight read", () => {
    fakeHost({ processes: [{ pid: 900, second: 0 }], windows: [window(41, 900)] })
    const late = { ...launched, preflightAtEpochSeconds: preflightAt + 1 }
    expect(() => resolveIterm2Window(late, "/dev/ttys007")).toThrow(/not after the preflight read's second/)
  })

  test("refuses one iTerm2 whose start second equals the preflight read's second", () => {
    fakeHost({ processes: [{ pid: 900, second: 0 }], windows: [window(41, 900)] })
    expect(() => resolveIterm2Window(launched, "/dev/ttys007")).toThrow(/not after the preflight read's second/)
  })

  test.each([
    ["zero", [window(10, 50)], /found 0/],
    [
      "two (extra terminal window)",
      [window(41, 900), window(42, 900, { bounds: { x: 0, y: 0, width: 400, height: 300 } })],
      /found 2/,
    ],
    [
      "two (terminal window and warning sheet)",
      [window(41, 900), window(814, 900, { bounds: { x: 805, y: 448, width: 260, height: 202 } })],
      /found 2/,
    ],
  ])("refuses %s new windows for the owner pid", (_name, windows, refusal) => {
    fakeHost({ processes: [{ pid: 900, second: 1 }], windows })
    expect(() => resolveIterm2Window(launched, "/dev/ttys007")).toThrow(refusal)
  })

  test("a pre-existing window id is not new, and another app's window is not the owner's", () => {
    fakeHost({ processes: [{ pid: 900, second: 1 }], windows: [window(10, 900), window(41, 77), window(42, 900)] })
    expect(resolveIterm2Window(launched, "/dev/ttys007").windowId).toBe(42)
  })
})

describe("per-run isolation proof and exact-token teardown (@cto d43c34cc)", () => {
  test("assertIterm2SuiteLive proves the suite domain is present while live and refuses when absent", () => {
    fakeHost({
      processes: [],
      windows: [],
      defaultsRead: { [suiteDomain]: { status: 0, stdout: "{\n    OpenNoWindowsAtStartup = 1;\n}\n" } },
    })
    expect(assertIterm2SuiteLive(launched)).toBeGreaterThan(0)

    fakeHost({ processes: [], windows: [] })
    expect(() => assertIterm2SuiteLive(launched)).toThrow(/suite domain .* is not present while live/)
  })

  test("verifyIterm2IsolationAfterClose passes when operator prefs sha256 is unchanged and refuses any mutation", () => {
    const receipt = verifyIterm2IsolationAfterClose(launched, 35)
    expect(receipt).toEqual({
      suiteDomain,
      suiteDomainPresentWhileLive: true,
      suiteDomainLiveReadBytes: 35,
      operatorPrefsBefore: { path: targets.operatorPrefsPath, present: true, sha256: operatorPrefsSha },
      operatorPrefsAfter: { path: targets.operatorPrefsPath, present: true, sha256: operatorPrefsSha },
    })

    vi.mocked(readFileSync).mockReturnValueOnce(Buffer.from("mutated-operator-plist"))
    expect(() => verifyIterm2IsolationAfterClose(launched, 35)).toThrow(
      /com\.googlecode\.iterm2\.plist changed during run/,
    )
  })

  test("teardownIterm2Suite stops only run-created exact-token iTermServer, deletes exact domain and two dirs with absence proofs", () => {
    let serverAlive = true
    const serverPath = `${targets.appSupportDir}/iTermServer-3.7.9`
    const serverCmd = `${serverPath} ${targets.dotSuiteDir}/1.socket`
    const existingDirs = new Set<string>([targets.appSupportDir, targets.dotSuiteDir])
    vi.mocked(existsSync).mockImplementation((p) => existingDirs.has(String(p)))
    vi.mocked(rmSync).mockImplementation((p) => {
      existingDirs.delete(String(p))
    })
    const host: Host = {
      processes: [{ pid: 950, second: 2, comm: serverPath, command: serverCmd }],
      windows: [],
      defaultsRead: { [suiteDomain]: { status: 0, stdout: "{\n    OpenNoWindowsAtStartup = 1;\n}\n" } },
    }
    fakeHost(host)
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
      if (pid === 950 && sig === "SIGTERM") {
        serverAlive = false
        host.processes = []
        return true
      }
      if (pid === 950 && sig === 0 && !serverAlive) {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" })
      }
      return true
    })
    try {
      const receipt = teardownIterm2Suite(launched)
      expect(receipt).toEqual({
        suiteDomain,
        defaultsDeleted: true,
        defaultsAbsentVerified: true,
        stoppedServers: [{ pid: 950, startedAtEpochSeconds: preflightAt + 2, command: serverCmd }],
        remainingServers: 0,
        removedDirs: [
          { path: targets.appSupportDir, existedBeforeRemoval: true, absentVerified: true },
          { path: targets.dotSuiteDir, existedBeforeRemoval: true, absentVerified: true },
        ],
      })
      expect(rmSync).toHaveBeenCalledTimes(2)
      expect(rmSync).toHaveBeenNthCalledWith(1, targets.appSupportDir, { recursive: true, force: false })
      expect(rmSync).toHaveBeenNthCalledWith(2, targets.dotSuiteDir, { recursive: true, force: false })
    } finally {
      kill.mockRestore()
    }
  })

  test("teardownIterm2Suite refuses and leaves untouched an iTermServer that predates the preflight", () => {
    const serverPath = `${targets.appSupportDir}/iTermServer-3.7.9`
    fakeHost({
      processes: [{ pid: 950, second: 0, comm: serverPath, command: `${serverPath} ${targets.dotSuiteDir}/1.socket` }],
      windows: [],
    })
    const kill = vi.spyOn(process, "kill").mockReturnValue(true)
    try {
      expect(() => teardownIterm2Suite(launched)).toThrow(/predates this run's preflight.*leaving it untouched/)
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })
})
