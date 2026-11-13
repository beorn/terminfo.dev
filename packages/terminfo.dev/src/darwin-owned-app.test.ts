import { describe, expect, it } from "vitest"
import {
  OWNED_APP_LAUNCH_TABLE,
  ownedAppLaunchSpec,
  parseOwnedAppLaunchRecord,
  proveOwnedAppLaunch,
  proveOwnedAppWindow,
} from "./darwin-owned-app.ts"

const rows = [
  { id: 33, ownerPid: 4242, layer: 0, bounds: { x: 10, y: 20, width: 700, height: 400 } },
  { id: 34, ownerPid: 4242, layer: 0, bounds: { x: 10, y: 20, width: 300, height: 200 } },
  { id: 35, ownerPid: 9999, layer: 0, bounds: { x: 0, y: 0, width: 800, height: 600 } },
]

describe("the owned-Mac app arm refuses what it has not measured", () => {
  it("ships an empty table, so no app is gradable on an assumed proof", () => {
    expect(Object.keys(OWNED_APP_LAUNCH_TABLE)).toEqual([])
  })

  it("refuses by name when the run names no app", () => {
    expect(() => ownedAppLaunchSpec(undefined)).toThrow(/needs the app it must launch/)
    expect(() => ownedAppLaunchSpec("")).toThrow(/needs the app it must launch/)
    expect(() => ownedAppLaunchSpec(7)).toThrow(/needs the app it must launch/)
  })

  it("refuses by name an app with no required-proof entry, and says what that means", () => {
    expect(() => ownedAppLaunchSpec("ghostty")).toThrow(/no required-proof entry for the owned-Mac app "ghostty"/)
    expect(() => ownedAppLaunchSpec("ghostty")).toThrow(/refused by name rather than graded on an assumed proof/)
  })

  it("refuses a launch record that is not one app, one process and one window", () => {
    expect(() => parseOwnedAppLaunchRecord(null)).toThrow(/must be an object/)
    expect(() => parseOwnedAppLaunchRecord([{ appId: "ghostty" }])).toThrow(/must be an object/)
    // The table is empty, so even a well-shaped record is refused by the entry rule, not parsed.
    expect(() =>
      parseOwnedAppLaunchRecord({
        appId: "ghostty",
        appPid: 4242,
        windowId: 33,
        windowTty: "/dev/ttys004",
        launchRunId: "r",
      }),
    ).toThrow(/no required-proof entry/)
  })
})

describe("the owned-Mac app arm proves the launched window from one census", () => {
  it("refuses when the app does not confirm the window this run opened", async () => {
    const record = { appId: "ghostty", appPid: 4242, windowId: 33, windowTty: null, launchRunId: "run-1" }
    expect(() => proveOwnedAppWindow(rows, record, false)).toThrow(
      /did not report window 33 as the one this run opened/,
    )
  })

  it("refuses a census that cannot single out the launched window", async () => {
    const record = { appId: "ghostty", appPid: 4242, windowId: 33, windowTty: null, launchRunId: "run-1" }
    // The launched window is absent from the census, so the one reader refuses by name and nothing is graded.
    expect(() => proveOwnedAppWindow(rows, { ...record, windowId: 77 }, true)).toThrow(
      /census names no window with that id for app PID 4242/,
    )
    // A window owned by somebody else is refused by the same reader, never silently replaced.
    expect(() => proveOwnedAppWindow(rows, { ...record, windowId: 35 }, true)).toThrow(
      /is owned by PID 9999, not the launched app PID 4242/,
    )
  })

  it("proves the launched window when the available census holds exactly one window", async () => {
    const record = { appId: "ghostty", appPid: 4242, windowId: 33, windowTty: null, launchRunId: "run-1" }
    const proof = proveOwnedAppWindow([rows[2], rows[0]], record, true)
    expect(proof.window.id).toBe(33)
    expect(proof.proof).toBe("owned=true app=ghostty pid=4242 window=33 launch=run-1 marker=matched")
  })
})

describe("the owned-Mac app arm claims only the window this run opened", () => {
  const spec = { bundleId: "com.example.app", windowMarker: "window-title" as const, surfaceProof: "tty-echo" as const }
  const staged = (before: unknown[], after: unknown[]) => {
    let reads = 0
    return () => (reads++ === 0 ? before : after)
  }
  const options = (over: Record<string, unknown> = {}) => ({
    appId: "example",
    bundlePath: "/Applications/Example.app",
    runMarker: "hh-run-1",
    spawn: () => {},
    census: () => [],
    ttyOf: () => "/dev/ttys004",
    wait: () => {},
    attempts: 1,
    ...over,
  })

  it("refuses a launch with no run marker, because no window could be claimed as ours", async () => {
    await expect(proveOwnedAppLaunch(spec, options({ runMarker: "  " }))).rejects.toThrow(/needs a run marker/)
  })

  it("refuses when the app opened no new window at all", async () => {
    await expect(proveOwnedAppLaunch(spec, options())).rejects.toThrow(
      /opened no new window for launch marker hh-run-1 in 1 attempts/,
    )
  })

  it("never claims a window that existed before the launch, even with the marker in its title", async () => {
    const preExisting = [{ id: 40, ownerPid: 111, layer: 0, namePresent: true, name: "hh-run-1 old window" }]
    // The window is in BOTH reads: it was there before the launch, so the diff cannot claim it.
    await expect(proveOwnedAppLaunch(spec, options({ census: staged(preExisting, preExisting) }))).rejects.toThrow(
      /opened no new window/,
    )
  })

  it("refuses two new windows for one launch instead of picking the larger", async () => {
    const rows = [
      { id: 1, ownerPid: 111, layer: 0, namePresent: true, name: "before" },
      { id: 2, ownerPid: 4242, layer: 0, namePresent: true, name: "hh-run-1 a" },
      { id: 3, ownerPid: 4242, layer: 0, namePresent: true, name: "hh-run-1 b" },
    ]
    const before = [{ id: 1, ownerPid: 111, layer: 0, namePresent: true, name: "before" }]
    await expect(proveOwnedAppLaunch(spec, options({ census: staged(before, rows) }))).rejects.toThrow(
      /opened 2 windows for one launch/,
    )
  })

  it("ignores a launch's offscreen window instead of reading one launch as two windows", async () => {
    const after = [
      { id: 1, ownerPid: 111, layer: 0, onscreen: true, namePresent: true, name: "before" },
      { id: 2, ownerPid: 4242, layer: 0, onscreen: false, namePresent: true, name: "hh-run-1 placeholder" },
      { id: 3, ownerPid: 4242, layer: 0, onscreen: true, namePresent: true, name: "hh-run-1" },
    ]
    const record = await proveOwnedAppLaunch(spec, options({ census: staged([], after), ttyOf: () => "/dev/ttys009" }))
    expect(record.windowId).toBe(3)
  })

  it("measures the pid, window and tty of the one new window the run opened", async () => {
    const rows = [
      { id: 1, ownerPid: 111, layer: 0, namePresent: true, name: "before" },
      { id: 2, ownerPid: 4242, layer: 0, namePresent: true, name: "hh-run-1 terminal" },
    ]
    const before = [{ id: 1, ownerPid: 111, layer: 0, namePresent: true, name: "before" }]
    const record = await proveOwnedAppLaunch(
      spec,
      options({ census: staged(before, rows), ttyOf: () => "/dev/ttys009" }),
    )
    expect(record).toEqual({
      appId: "example",
      appPid: 4242,
      windowId: 2,
      windowTty: "/dev/ttys009",
      launchRunId: "hh-run-1",
    })
  })

  it("refuses a tty-echo app whose reader returned no tty, rather than installing input blind", async () => {
    const rows = [{ id: 2, ownerPid: 4242, layer: 0, namePresent: true, name: "hh-run-1 terminal" }]
    await expect(proveOwnedAppLaunch(spec, options({ census: staged([], rows), ttyOf: () => null }))).rejects.toThrow(
      /proves its surface by a tty echo, so the record must name the app's own tty/,
    )
  })
})
