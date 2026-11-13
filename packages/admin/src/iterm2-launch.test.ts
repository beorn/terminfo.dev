/**
 * @failure An owned iTerm2 run adopts an iTerm2 that predates it, a second instance, a restored or
 * borrowed window, or a session whose TTY is not the one the run script recorded, and reports it as owned.
 * @level l1
 * @consumer The admin's owned iTerm2 launch (runApp) and the window record its assert and close act on.
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { prepareIterm2Launch, resolveIterm2Window, type Iterm2Launch } from "./iterm2-launch.ts"

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }))
vi.mock("node:fs", () => ({ realpathSync: vi.fn() }))

const executablePath = "/Applications/iTerm.app/Contents/MacOS/iTerm2"
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
  processes: Array<{ pid: number; second: number; comm?: string }>
  windows: unknown[]
}

function fakeHost(host: Host): string[][] {
  const appleEvents: string[][] = []
  vi.mocked(spawnSync).mockImplementation(((command: string, args: readonly string[]) => {
    const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" })
    if (command === "/bin/ps" && args.includes("-U")) {
      expect(args).toEqual(["-ww", "-U", String(process.getuid?.()), "-o", "pid=,lstart=,comm="])
      return ok(
        [
          `  1 ${lstart(0)} /sbin/launchd`,
          ...host.processes.map((row) => `${row.pid} ${lstart(row.second)} ${row.comm ?? executablePath}`),
        ].join("\n") + "\n",
      )
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
  preflightAtEpochSeconds: preflightAt,
  beforeWindowIds: [10, 11],
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(realpathSync).mockImplementation((path) => String(path))
})

describe("the iTerm2 preflight before the shared CLI launch", () => {
  test("refuses an iTerm2 that already runs for this account and sends it no Apple event", () => {
    const appleEvents = fakeHost({ processes: [{ pid: 812, second: 0 }], windows: [] })
    expect(() => prepareIterm2Launch("/private/run/serve.sh", executablePath)).toThrow(
      /iTerm2 is already running for this account \(pids 812\)/,
    )
    expect(appleEvents).toEqual([])
  })

  test("a clean preflight records the before census and waits past its second without an Apple event", () => {
    const appleEvents = fakeHost({
      processes: [],
      windows: [window(10, 50), window(11, 51)],
    })
    const launch = prepareIterm2Launch("/private/run/serve.sh", executablePath)
    expect(appleEvents).toEqual([])
    expect(launch).toMatchObject({ beforeWindowIds: [10, 11] })
    // The launch waits out the preflight's second, so the started process's lstart is strictly later.
    expect(Date.now()).toBeGreaterThanOrEqual((launch.preflightAtEpochSeconds + 1) * 1000)
  })
})

describe("resolving the owned window after the daemon registers", () => {
  test("adopts the one post-preflight process and its one new layer-0 window", () => {
    fakeHost({ processes: [{ pid: 900, second: 1 }], windows: [window(10, 50), window(41, 900)] })
    expect(resolveIterm2Window(launched, "/dev/ttys007\n")).toEqual({
      provider: "iterm2",
      windowId: 41,
      tty: "/dev/ttys007",
      ownerPid: 900,
      executablePath,
      startedAtEpochSeconds: preflightAt + 1,
    })
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
      "two (session restore)",
      [window(41, 900), window(42, 900, { bounds: { x: 0, y: 0, width: 400, height: 300 } })],
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
