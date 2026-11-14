/**
 * @failure A kitty run is reported as owned when the recorded pid is stale, reused, another binary, or
 * not an ancestor of the daemon; an unknown provider falls through; or an executable lookup loses its cause.
 * @level l1
 * @consumer The one owned-window authority the admin asserts before every app probe.
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { describe, expect, test, vi } from "vitest"
import {
  assertOwnedTerminalWindow,
  assertOwnedAppOwner,
  closeOwnedTerminalWindow,
  parseKittyIdentity,
  recordedOwnerTty,
  resolveOwnedProcessByMarker,
  type OwnedTerminalWindow,
} from "./terminal-app-window.ts"
import { argvCarriesMarker, descendToOwner, runScopedMarker } from "./owned-process.ts"

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }))
vi.mock("node:fs", () => ({ realpathSync: vi.fn() }))

describe("kitty owner identity", () => {
  test("parses the four fields the serve script records", () => {
    expect(parseKittyIdentity("1\n87024\n/dev/ttys004\nxterm-kitty\n")).toEqual({
      windowId: 1,
      kittyPid: 87024,
      tty: "/dev/ttys004",
      term: "xterm-kitty",
    })
  })

  test.each([
    ["missing fields", "1\n87024\n"],
    ["empty window id", "\n87024\n/dev/ttys004\nxterm-kitty"],
    ["zero window id", "0\n87024\n/dev/ttys004\nxterm-kitty"],
    ["non-numeric pid", "1\nnot-a-pid\n/dev/ttys004\nxterm-kitty"],
    ["tty is not a device", "1\n87024\nnot-a-tty\nxterm-kitty"],
    ["another terminal", "1\n87024\n/dev/ttys004\nxterm-256color"],
  ])("refuses %s", (_name, text) => {
    expect(() => parseKittyIdentity(text)).toThrow()
  })
})

describe("descendant walk", () => {
  const parents = new Map([
    [300, 200],
    [200, 100],
    [100, 1],
  ])

  test("accepts a daemon that descends from the recorded kitty pid, including past 64 hops", () => {
    expect(() => descendToOwner(300, 100, (pid) => parents.get(pid) ?? null)).not.toThrow()
    // The removed hop ceiling accepted three hops and refused this one; a valid chain of 71 hops now
    // passes, so a returned cap fails this same accepted case instead of hiding behind a short chain.
    const long = new Map<number, number>()
    for (let pid = 1000; pid < 1070; pid += 1) long.set(pid, pid + 1)
    long.set(1070, 100)
    expect(() => descendToOwner(1000, 100, (pid) => long.get(pid) ?? null)).not.toThrow()
  })

  test("refuses a chain that ends at pid 1 and names the chain it walked", () => {
    expect(() => descendToOwner(300, 999, (pid) => parents.get(pid) ?? null)).toThrow(/300 -> 200 -> 100 -> 1/)
  })

  test("refuses a missing chain instead of passing it", () => {
    expect(() => descendToOwner(300, 100, () => null)).toThrow(/not a descendant/)
  })

  test("refuses a cyclic chain by naming the cycle", () => {
    expect(() => descendToOwner(300, 100, (pid) => (pid === 200 ? 300 : 200))).toThrow(/cycles at pid/)
  })

  test("refuses the owner pid itself as the daemon", () => {
    expect(() => descendToOwner(100, 100, () => 1)).toThrow(/same pid/)
  })
})

describe("provider dispatch", () => {
  const window: OwnedTerminalWindow = {
    provider: "kitty",
    windowId: 1,
    tty: "/dev/ttys004",
    kittyPid: 4321,
    executablePath: "/Applications/kitty.app/Contents/MacOS/kitty",
    instanceGroup: "terminfo-run",
  }

  test("refuses a kitty window whose recorded pid is the daemon itself", () => {
    expect(() => assertOwnedTerminalWindow(window, 4321)).toThrow(/same pid/)
  })

  test.each(["assert", "close"] as const)("%s retains an unreadable executable's identity and cause", (operation) => {
    const cause = new Error("executable lookup denied")
    const result = { status: 0, stdout: `${window.executablePath}\n`, stderr: "" } as ReturnType<typeof spawnSync>
    vi.mocked(spawnSync).mockReturnValue(result)
    if (operation === "assert") vi.mocked(spawnSync).mockReturnValueOnce({ ...result, stdout: "ttys004\n" })
    vi.mocked(realpathSync).mockImplementation(() => {
      throw cause
    })
    const kill = vi.spyOn(process, "kill").mockReturnValue(true)
    try {
      const act = () =>
        operation === "assert" ? assertOwnedTerminalWindow(window, 5432) : closeOwnedTerminalWindow(window)
      let failure: unknown
      try {
        act()
      } catch (error) {
        failure = error
      }
      expect(failure).toMatchObject({
        message: expect.stringContaining(`pid ${window.kittyPid}`),
        cause,
      })
      expect(failure).toHaveProperty("message", expect.stringContaining(window.executablePath))
      expect(kill).not.toHaveBeenCalledWith(window.kittyPid, "SIGTERM")
      // Darwin reports an already exited GUI owner as <defunct>, not an executable path.
      vi.mocked(realpathSync).mockClear()
      vi.mocked(spawnSync).mockReturnValue({ ...result, stdout: "<defunct>\n" })
      if (operation === "assert") {
        vi.mocked(spawnSync).mockReturnValueOnce({ ...result, stdout: "ttys004\n" })
        expect(act).toThrow(/not a running process/)
      } else {
        expect(act).not.toThrow()
      }
      expect(realpathSync).not.toHaveBeenCalled()
      expect(kill).not.toHaveBeenCalled()
      if (operation === "close") {
        vi.mocked(spawnSync).mockReturnValue({ ...result, status: 1, stdout: "" })
        kill.mockImplementation(() => {
          throw Object.assign(new Error("gone"), { code: "ESRCH" })
        })
        expect(() => closeOwnedTerminalWindow(window)).not.toThrow()
      }
    } finally {
      kill.mockRestore()
      vi.mocked(spawnSync).mockReset()
      vi.mocked(realpathSync).mockReset()
    }
  })

  test("an unknown provider fails loudly instead of falling through", () => {
    const unknown = { provider: "ghostty", windowId: 1, tty: "/dev/ttys004" } as unknown as OwnedTerminalWindow
    expect(() => assertOwnedTerminalWindow(unknown, 99)).toThrow(/no provider arm/)
  })
})

describe("cli-process ownership", () => {
  const daemonPid = 7300
  const ownerPid = 6200
  const executablePath = "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui"
  const marker = { flag: "--config-file", value: "/run/terminfo-abc9/app.toml" }
  const owner: OwnedTerminalWindow = { provider: "cli-process", tty: "/dev/ttys009", ownerPid, executablePath, marker }
  const argv = `${executablePath} start --always-new-process --config-file ${marker.value} -- /bin/bash run.sh`

  /** Every ps read the authority makes, answered from one table so a case names only what it varies. */
  function fakeProcessTable(table: {
    command?: Record<number, string>
    comm?: Record<number, string>
    ppid?: Record<number, number>
    tty?: Record<number, string>
  }) {
    vi.mocked(spawnSync).mockImplementation(((_command: string, args: readonly string[]) => {
      const field = args[args.indexOf("-o") + 1]
      const pid = Number(args[args.indexOf("-p") + 1])
      const value =
        field === "ppid="
          ? table.ppid?.[pid]
          : field === "comm="
            ? table.comm?.[pid]
            : field === "command="
              ? table.command?.[pid]
              : field === "tty="
                ? table.tty?.[pid]
                : undefined
      return (
        value === undefined ? { status: 1, stdout: "", stderr: "" } : { status: 0, stdout: `${value}\n`, stderr: "" }
      ) as ReturnType<typeof spawnSync>
    }) as unknown as typeof spawnSync)
  }

  const descending = { tty: { [daemonPid]: "ttys009" }, ppid: { [daemonPid]: 7000, 7000: ownerPid } }
  const liveOwner = { comm: { [ownerPid]: executablePath }, command: { [ownerPid]: argv } }

  test("accepts the recorded owner when binary, marker, tty and descent all hold", () => {
    vi.mocked(realpathSync).mockImplementation((path) => String(path))
    fakeProcessTable({ ...descending, ...liveOwner })
    expect(() => assertOwnedTerminalWindow(owner, daemonPid)).not.toThrow()
  })

  test("accepts a one-token --flag=value marker as an exact argv token", () => {
    vi.mocked(realpathSync).mockImplementation((path) => String(path))
    fakeProcessTable({
      ...descending,
      comm: { [ownerPid]: executablePath },
      command: { [ownerPid]: `${executablePath} ${marker.flag}=${marker.value}` },
    })
    expect(() => assertOwnedTerminalWindow(owner, daemonPid)).not.toThrow()
  })

  test("refuses a marker that only appears as a substring, never as a whole token", () => {
    vi.mocked(realpathSync).mockImplementation((path) => String(path))
    fakeProcessTable({
      ...descending,
      comm: { [ownerPid]: executablePath },
      command: { [ownerPid]: `${executablePath} --config-file=${marker.value}.bak` },
    })
    expect(() => assertOwnedTerminalWindow(owner, daemonPid)).toThrow(/does not carry the launched marker/)
  })

  test("refuses an owner whose pid is now a different binary", () => {
    vi.mocked(realpathSync).mockImplementation((path) => String(path))
    fakeProcessTable({ ...descending, comm: { [ownerPid]: "/usr/bin/other" }, command: { [ownerPid]: argv } })
    expect(() => assertOwnedTerminalWindow(owner, daemonPid)).toThrow(/runs .*not the launched/)
  })

  test("refuses a daemon that is not a descendant of the recorded owner", () => {
    vi.mocked(realpathSync).mockImplementation((path) => String(path))
    fakeProcessTable({
      ...liveOwner,
      tty: { [daemonPid]: "ttys009" },
      ppid: { [daemonPid]: 9000, 9000: 1 },
    })
    expect(() => assertOwnedTerminalWindow(owner, daemonPid)).toThrow(/not a descendant/)
  })

  test("refuses a daemon TTY that is not the owned window's TTY", () => {
    vi.mocked(realpathSync).mockImplementation((path) => String(path))
    fakeProcessTable({ ...liveOwner, ppid: descending.ppid, tty: { [daemonPid]: "ttys010" } })
    expect(() => assertOwnedTerminalWindow(owner, daemonPid)).toThrow(/TTY/)
  })

  test("close signals the recorded owner only, and never a process group", () => {
    vi.mocked(realpathSync).mockImplementation((path) => String(path))
    fakeProcessTable(liveOwner)
    // SIGTERM succeeds and the liveness probe (signal 0) then reports the pid gone, so close returns.
    const kill = vi.spyOn(process, "kill").mockImplementation(((_pid: number, signal?: string | number) => {
      if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" })
      return true
    }) as typeof process.kill)
    try {
      closeOwnedTerminalWindow(owner)
      const terminations = kill.mock.calls.filter(([, signal]) => signal === "SIGTERM")
      expect(terminations).toEqual([[ownerPid, "SIGTERM"]])
      expect(kill.mock.calls.every(([pid]) => pid > 0)).toBe(true)
    } finally {
      kill.mockRestore()
    }
  })

  test("close refuses a pid that no longer carries the marker instead of signalling it", () => {
    vi.mocked(realpathSync).mockImplementation((path) => String(path))
    fakeProcessTable({ comm: { [ownerPid]: executablePath }, command: { [ownerPid]: `${executablePath} --other` } })
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true)
    try {
      expect(() => closeOwnedTerminalWindow(owner)).toThrow(/does not carry the launched marker/)
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })

  test("close escalates to SIGKILL once the owner survives the SIGTERM window", () => {
    vi.mocked(realpathSync).mockImplementation((path) => String(path))
    fakeProcessTable(liveOwner)
    const signals: Array<string | number | undefined> = []
    let killed = false
    const kill = vi.spyOn(process, "kill").mockImplementation(((_pid: number, signal?: string | number) => {
      if (signal === 0) {
        if (killed) throw Object.assign(new Error("gone"), { code: "ESRCH" })
        return true
      }
      signals.push(signal)
      if (signal === "SIGKILL") killed = true
      return true
    }) as typeof process.kill)
    try {
      closeOwnedTerminalWindow(owner)
      expect(signals).toEqual(["SIGTERM", "SIGKILL"])
    } finally {
      kill.mockRestore()
    }
  })

  test("close does not SIGKILL a pid that lost this launch's marker during the SIGTERM window", () => {
    vi.mocked(realpathSync).mockImplementation((path) => String(path))
    const table = { comm: { [ownerPid]: executablePath }, command: { [ownerPid]: argv } }
    fakeProcessTable(table)
    const kill = vi.spyOn(process, "kill").mockImplementation(((_pid: number, signal?: string | number) => {
      if (signal === "SIGTERM") table.command[ownerPid] = `${executablePath} --config-file someone-elses-run`
      return true
    }) as typeof process.kill)
    try {
      expect(() => closeOwnedTerminalWindow(owner)).toThrow(/does not carry the launched marker/)
      expect(kill).not.toHaveBeenCalledWith(ownerPid, "SIGKILL")
    } finally {
      kill.mockRestore()
    }
  })

  test("kitty's close now re-tests its instance-group marker before signalling", () => {
    vi.mocked(realpathSync).mockImplementation((path) => String(path))
    const kitty: OwnedTerminalWindow = {
      provider: "kitty",
      windowId: 2,
      tty: "/dev/ttys011",
      kittyPid: 8100,
      executablePath: "/Applications/kitty.app/Contents/MacOS/kitty",
      instanceGroup: "terminfo-abc9",
    }
    fakeProcessTable({
      comm: { 8100: kitty.provider === "kitty" ? kitty.executablePath : "" },
      command: { 8100: "/Applications/kitty.app/Contents/MacOS/kitty --detach --instance-group someone-elses" },
    })
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true)
    try {
      expect(() => closeOwnedTerminalWindow(kitty)).toThrow(/does not carry the launched marker/)
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })
})

describe("owner resolution", () => {
  const executablePath = "/Applications/Visual Studio Code.app/Contents/MacOS/Code"
  const marker = { flag: "--user-data-dir", value: "/run/terminfo-abc9" }

  /** A `ps -A` listing whose pid, argv and executable agree, so only the count varies. */
  function fakeListing(pids: readonly number[], executable = executablePath) {
    vi.mocked(realpathSync).mockImplementation((path) => String(path))
    vi.mocked(spawnSync).mockImplementation(((_command: string, args: readonly string[]) => {
      if (args.includes("-A")) {
        const rows = pids.map((pid) => `${pid} ${executable} ${marker.flag} ${marker.value} --new-window`)
        return { status: 0, stdout: `${rows.join("\n")}\n`, stderr: "" } as ReturnType<typeof spawnSync>
      }
      return { status: 0, stdout: `${executable}\n`, stderr: "" } as ReturnType<typeof spawnSync>
    }) as unknown as typeof spawnSync)
  }

  test("records exactly one live owner carrying the marker", () => {
    fakeListing([5100])
    expect(resolveOwnedProcessByMarker({ executablePath, marker, tty: "/dev/ttys012" })).toEqual({
      provider: "cli-process",
      ownerPid: 5100,
      executablePath,
      marker,
      tty: "/dev/ttys012",
    })
  })

  test("refuses when no live process carries the marker", () => {
    fakeListing([])
    expect(() => resolveOwnedProcessByMarker({ executablePath, marker, tty: "/dev/ttys012" })).toThrow(
      /no live process runs/,
    )
  })

  test("refuses an ambiguous owner rather than picking one of several", () => {
    fakeListing([5100, 5200])
    expect(() => resolveOwnedProcessByMarker({ executablePath, marker, tty: "/dev/ttys012" })).toThrow(
      /2 live processes.*ambiguous/,
    )
  })
})

describe("marker token matching", () => {
  test.each([
    [["--flag", "value"], true],
    [["--flag=value"], true],
    [["--flag", "value2"], false],
    [["--flag=value2"], false],
    [["x--flag", "value"], false],
    [["--flag"], false],
    [[], false],
  ])("%j matches %s", (argv, expected) => {
    expect(argvCarriesMarker(argv as string[], { flag: "--flag", value: "value" })).toBe(expected)
  })
})

describe("run-scoped marker derivation", () => {
  const runId = "0f3c9a7d"

  test("accepts a path-valued marker that carries the run id", () => {
    // The measured WezTerm recipe: the marker value is a run-scoped config path, not a bare token.
    expect(
      runScopedMarker({
        appName: "WezTerm",
        runId,
        flag: "--config-file",
        value: `/tmp/terminfo-${runId}/wezterm.lua`,
      }),
    ).toEqual({ flag: "--config-file", value: `/tmp/terminfo-${runId}/wezterm.lua` })
  })

  test("accepts the one-token form a user-data-dir recipe uses", () => {
    expect(
      runScopedMarker({ appName: "VS Code", runId, flag: "--user-data-dir", value: `/tmp/terminfo-${runId}` }),
    ).toEqual({ flag: "--user-data-dir", value: `/tmp/terminfo-${runId}` })
  })

  test.each([
    ["a value without the run id", "--config-file", "/tmp/wezterm.lua"],
    ["a value containing whitespace", "--config-file", `/tmp/terminfo-${runId} dir/wezterm.lua`],
    ["an empty value", "--config-file", ""],
    ["an empty flag", "", `/tmp/terminfo-${runId}`],
    ["a flag containing whitespace", "--config file", `/tmp/terminfo-${runId}`],
  ])("refuses %s", (_name, flag, value) => {
    expect(() => runScopedMarker({ appName: "WezTerm", runId, flag, value })).toThrow(/owned-process marker/)
  })
})

describe("recorded owner TTY", () => {
  test("normalizes a device path", () => {
    expect(recordedOwnerTty("/dev/ttys005\n")).toBe("/dev/ttys005")
  })

  test("accepts the bare device name a shell prints", () => {
    expect(recordedOwnerTty("ttys005")).toBe("/dev/ttys005")
  })

  test('refuses the literal "not a tty" by name instead of fabricating /dev/not a tty', () => {
    expect(() => recordedOwnerTty("not a tty")).toThrow(/"not a tty"/)
  })

  test("refuses an empty record", () => {
    expect(() => recordedOwnerTty("  \n")).toThrow(/recorded no TTY/)
  })
})

describe("iTerm2 sole-instance ownership", () => {
  const daemonPid = 7300
  const ownerPid = 6200
  const executablePath = "/Applications/iTerm.app/Contents/MacOS/iTerm2"
  const started = Date.UTC(2026, 10, 12, 13, 22, 1) / 1000
  const owner: OwnedTerminalWindow = {
    provider: "iterm2",
    windowId: 41,
    tty: "/dev/ttys007",
    ownerPid,
    executablePath,
    startedAtEpochSeconds: started,
  }
  const cgWindow = {
    id: 41,
    ownerPid,
    layer: 0,
    bounds: { x: 0, y: 25, width: 800, height: 600 },
    alpha: 1,
    onscreen: true,
  }

  /** One host: the uid-scoped iTerm2 listing, the per-pid reads, and successive window-server censuses. */
  function fakeHost(host: { second?: number | null; censuses?: unknown[][]; tty?: string; appleEvents?: string[] }) {
    const censuses = [...(host.censuses ?? [[cgWindow]])]
    vi.mocked(spawnSync).mockImplementation(((command: string, args: readonly string[]) => {
      const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" }) as ReturnType<typeof spawnSync>
      if (command === "sleep") return ok("")
      if (command === "/usr/bin/osascript" && args.includes("JavaScript")) {
        return ok(JSON.stringify(censuses.length > 1 ? censuses.shift() : censuses[0]))
      }
      if (command === "osascript") {
        host.appleEvents?.push(args.join(" "))
        return ok("")
      }
      if (command !== "/bin/ps") throw new Error(`unexpected command ${command}`)
      if (args.includes("-U")) {
        const second = host.second === undefined ? 1 : host.second
        return ok(second === null ? "" : `${ownerPid} Thu Nov 12 13:22:0${second} 2026 ${executablePath}\n`)
      }
      const field = args[args.indexOf("-o") + 1]
      const pid = Number(args[args.indexOf("-p") + 1])
      if (field === "tty=" && pid === daemonPid) return ok(`${host.tty ?? "ttys007"}\n`)
      if (field === "comm=" && pid === ownerPid) return ok(`${executablePath}\n`)
      if (field === "ppid=" && pid === daemonPid) return ok("7000\n")
      if (field === "ppid=" && pid === 7000) return ok(`${ownerPid}\n`)
      return { status: 1, stdout: "", stderr: "" } as ReturnType<typeof spawnSync>
    }) as unknown as typeof spawnSync)
  }

  test("assert holds on the same pid, binary, start time, TTY and owned CG window, with no Apple event", () => {
    vi.mocked(realpathSync).mockImplementation((path) => String(path))
    const appleEvents: string[] = []
    fakeHost({ appleEvents })
    expect(() => assertOwnedTerminalWindow(owner, daemonPid)).not.toThrow()
    expect(appleEvents).toEqual([])
  })

  test.each([
    ["a changed start time", { second: 5 }, /started at .*, not the launched owner's/],
    ["a vanished owner", { second: null }, /no longer runs/],
    ["a daemon TTY that is not the session's", { tty: "ttys009" }, /daemon TTY \/dev\/ttys009 differs/],
    ["a CG window that is gone", { censuses: [[]] }, /names no window with that id/],
    ["a CG window another pid owns", { censuses: [[{ ...cgWindow, ownerPid: 99 }]] }, /owned by PID 99/],
  ])("assert refuses %s", (_name, host, refusal) => {
    vi.mocked(realpathSync).mockImplementation((path) => String(path))
    fakeHost(host)
    expect(() => assertOwnedTerminalWindow(owner, daemonPid)).toThrow(refusal)
  })

  test("close re-asserts the start time before the signal and signals nothing when it changed", () => {
    vi.mocked(realpathSync).mockImplementation((path) => String(path))
    fakeHost({ second: 5 })
    const kill = vi.spyOn(process, "kill").mockReturnValue(true)
    try {
      expect(() => closeOwnedTerminalWindow(owner)).toThrow(/started at .*; not signaling it/)
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })

  test("close SIGTERMs only the recorded pid, then proves the window server lists none of its windows", () => {
    vi.mocked(realpathSync).mockImplementation((path) => String(path))
    const appleEvents: string[] = []
    fakeHost({ censuses: [[cgWindow], []], appleEvents })
    const signals: Array<[number, string | number | undefined]> = []
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      signals.push([pid, signal])
      if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" })
      return true
    })
    try {
      expect(closeOwnedTerminalWindow(owner)).toBeUndefined()
      expect(signals[0]).toEqual([ownerPid, "SIGTERM"])
      expect(signals.every(([pid]) => pid === ownerPid)).toBe(true)
      expect(appleEvents).toEqual([])
    } finally {
      kill.mockRestore()
    }
  })

  test("close refuses when the window server still lists a window for the exited pid", () => {
    vi.mocked(realpathSync).mockImplementation((path) => String(path))
    fakeHost({ censuses: [[cgWindow]] })
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" })
      return true
    })
    try {
      expect(() => closeOwnedTerminalWindow(owner)).toThrow(/still lists layer-0 windows \[41\]/)
    } finally {
      kill.mockRestore()
    }
  })
})

describe("an owned-Mac app claim is re-proved live, never trusted", () => {
  const runId = "0123456789abcdef0123456789abcdef"
  const proof = {
    bundleId: "example.app",
    windowProof: "census-diff" as const,
    ttyProof: { kind: "title-echo" as const },
  }
  const claim = (over: Record<string, unknown> = {}) => ({
    asserter: "terminfo-admin" as const,
    launchRunId: runId,
    workerPid: process.pid,
    appId: "ghostty",
    ownerPid: 4242,
    windowId: 77,
    executablePath: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
    marker: { flag: "--owned-mac-run", value: runId },
    tty: "/dev/ttys004",
    intendedVersion: "1.2.3",
    ...over,
  })
  const censusRow = (id: number, ownerPid: number) => ({
    id,
    ownerPid,
    layer: 0,
    onscreen: true,
    namePresent: true,
    name: "a window",
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    alpha: 1,
  })
  const probes = (pids: readonly number[], rows: readonly unknown[]) => ({
    proofSpec: () => proof,
    findOwnerPids: () => pids,
    readWindowRows: () => rows,
    readBundleId: () => proof.bundleId,
    workerTty: () => "/dev/ttys004",
  })

  const withRunEnv = (body: () => void) => {
    const previous = process.env.TERMINFO_RUN_ID
    process.env.TERMINFO_RUN_ID = runId
    try {
      body()
    } finally {
      if (previous === undefined) delete process.env.TERMINFO_RUN_ID
      else process.env.TERMINFO_RUN_ID = previous
    }
  }

  test("passes only when exactly the recorded pid carries the marker and owns the recorded window", () => {
    withRunEnv(() => {
      assertOwnedAppOwner(claim(), runId, probes([4242], [censusRow(77, 4242)]))
    })
  })

  test("refuses an app with no required-proof entry before it reads anything live", () => {
    withRunEnv(() => {
      expect(() =>
        assertOwnedAppOwner(claim(), runId, {
          proofSpec: () => {
            throw new Error('no required-proof entry for the owned-Mac app "ghostty"')
          },
          findOwnerPids: () => {
            throw new Error("the proof must refuse before any process is read")
          },
          readWindowRows: () => {
            throw new Error("the proof must refuse before any census is read")
          },
          readBundleId: () => {
            throw new Error("the proof must refuse before any bundle is read")
          },
          workerTty: () => {
            throw new Error("the proof must refuse before any tty is read")
          },
        }),
      ).toThrow(/no required-proof entry/)
    })
  })

  test("refuses an executable whose live bundle is not the one its proof entry requires", () => {
    withRunEnv(() => {
      expect(() =>
        assertOwnedAppOwner(claim(), runId, {
          ...probes([4242], [censusRow(77, 4242)]),
          readBundleId: () => "com.example.other",
        }),
      ).toThrow(/is bundle "com.example.other", not the "example.app"/)
    })
  })

  test("refuses a record whose tty is not this worker's controlling tty", () => {
    withRunEnv(() => {
      expect(() =>
        assertOwnedAppOwner(claim(), runId, {
          ...probes([4242], [censusRow(77, 4242)]),
          workerTty: () => "/dev/ttys009",
        }),
      ).toThrow(/the record names TTY \/dev\/ttys004 but this worker's controlling TTY is \/dev\/ttys009/)
    })
  })

  test("refuses a claim from another run, from another worker pid, or with no run in the environment", () => {
    withRunEnv(() => {
      expect(() => assertOwnedAppOwner(claim({ launchRunId: "f".repeat(32) }), runId, probes([4242], []))).toThrow(
        /differs from this worker launch run or PID/,
      )
      expect(() => assertOwnedAppOwner(claim({ workerPid: process.pid + 1 }), runId, probes([4242], []))).toThrow(
        /differs from this worker launch run or PID/,
      )
      const previous = process.env.TERMINFO_RUN_ID
      delete process.env.TERMINFO_RUN_ID
      try {
        expect(() => assertOwnedAppOwner(claim(), runId, probes([4242], []))).toThrow(
          /differs from this worker launch run or PID/,
        )
      } finally {
        process.env.TERMINFO_RUN_ID = previous
      }
    })
  })

  test("refuses when the launched pid is gone, ambiguous, or replaced by a different marker holder", () => {
    withRunEnv(() => {
      expect(() => assertOwnedAppOwner(claim(), runId, probes([], [censusRow(77, 4242)]))).toThrow(
        /no live process runs .* carrying the launched marker/,
      )
      expect(() => assertOwnedAppOwner(claim(), runId, probes([4242, 4243], []))).toThrow(
        /2 live processes carry the launched marker/,
      )
      expect(() => assertOwnedAppOwner(claim(), runId, probes([9999], []))).toThrow(/belongs to pid 9999/)
    })
  })

  test("refuses when the census does not show that window owned by that pid", () => {
    withRunEnv(() => {
      expect(() => assertOwnedAppOwner(claim(), runId, probes([4242], [censusRow(77, 8888)]))).toThrow()
      expect(() => assertOwnedAppOwner(claim(), runId, probes([4242], [censusRow(78, 4242)]))).toThrow()
    })
  })
})
