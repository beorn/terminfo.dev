import { describe, expect, it } from "vitest"
import {
  OWNED_APP_PROOF_TABLE,
  launchCensusWindows,
  newWindowsForLaunch,
  oneNewWindowForLaunch,
  ownedAppProofSpec,
  proveTtyByTitleEcho,
} from "./darwin-owned-app.ts"

const row = (id: number, ownerPid: number, extra: Record<string, unknown> = {}) => ({
  id,
  ownerPid,
  layer: 0,
  onscreen: true,
  namePresent: true,
  name: `window ${String(id)}`,
  ...extra,
})

describe("the owned-Mac app arm refuses what it has not measured", () => {
  it("ships an empty table, so no app is gradable on an assumed proof", () => {
    expect(Object.keys(OWNED_APP_PROOF_TABLE)).toEqual([])
  })

  it("refuses by name when the run names no app", () => {
    expect(() => ownedAppProofSpec(undefined)).toThrow(/needs the app it must launch/)
    expect(() => ownedAppProofSpec("")).toThrow(/needs the app it must launch/)
    expect(() => ownedAppProofSpec(7)).toThrow(/needs the app it must launch/)
  })

  it("refuses by name an app with no required-proof entry, and says what that means", () => {
    expect(() => ownedAppProofSpec("ghostty")).toThrow(/no required-proof entry for the owned-Mac app "ghostty"/)
    expect(() => ownedAppProofSpec("ghostty")).toThrow(/refused by name rather than graded on an assumed proof/)
  })
})

describe("the launched window is the one the census did not have before", () => {
  it("reads only layer-0 onscreen windows, in the shape the census script emits", () => {
    const rows = [
      row(1, 111),
      row(2, 111, { layer: 1 }),
      row(3, 111, { onscreen: false }),
      row(4, 111, { namePresent: false, name: undefined }),
    ]
    expect(launchCensusWindows(rows)).toEqual([
      { id: 1, ownerPid: 111, name: "window 1" },
      { id: 4, ownerPid: 111, name: null },
    ])
  })

  it("refuses a census that is not a window list", () => {
    expect(() => launchCensusWindows({})).toThrow(/must be a window list/)
    expect(() => launchCensusWindows([42])).toThrow(/non-object row/)
    // The census script always emits id, ownerPid and layer, so a row without them is not its output.
    expect(() => launchCensusWindows([{ id: 1 }])).toThrow(/lacks id, owner or layer/)
  })

  it("never claims a window that was there before the launch", () => {
    const before = [row(40, 111, { name: "hh-run-1 old window" })]
    expect(newWindowsForLaunch(before, before)).toEqual([])
  })

  it("claims a new window owned by a process that was not there either", () => {
    const before = [row(40, 111)]
    const after = [row(40, 111), row(41, 4242)]
    expect(newWindowsForLaunch(before, after).map((window) => window.id)).toEqual([41])
    // A new window on a pid that already existed is not this launch's process, so it is not claimed.
    expect(newWindowsForLaunch(before, [row(40, 111), row(42, 111)])).toEqual([])
  })

  it("refuses zero new windows and refuses several, instead of picking the larger", () => {
    const before = [row(1, 111)]
    expect(() => oneNewWindowForLaunch(before, before, { value: "hh-run-1", required: false })).toThrow(
      /opened no new window for launch marker hh-run-1/,
    )
    const two = [row(1, 111), row(2, 4242), row(3, 4242)]
    expect(() => oneNewWindowForLaunch(before, two, { value: "hh-run-1", required: false })).toThrow(
      /opened 2 windows for one launch/,
    )
  })

  it("requires the run marker in the title when the app's entry says so", () => {
    const before = [row(1, 111)]
    const after = [row(1, 111), row(2, 4242, { name: "some other title" })]
    expect(() => oneNewWindowForLaunch(before, after, { value: "hh-run-1", required: true })).toThrow(
      /opened no new window/,
    )
    const marked = [row(1, 111), row(2, 4242, { name: "hh-run-1 terminal" })]
    expect(oneNewWindowForLaunch(before, marked, { value: "hh-run-1", required: true }).id).toBe(2)
  })

  it("refuses a launch with no run marker, because no window could be claimed as ours", () => {
    expect(() => oneNewWindowForLaunch([], [row(1, 111)], { value: "  ", required: false })).toThrow(
      /needs a run marker/,
    )
  })
})

describe("the title echo proves the run's own tty is drawn in the claimed window", () => {
  const base = {
    windowId: 33,
    writeTitle: () => {},
    restoreTitle: () => {},
    nonce: "abcdefgh1234",
  }

  it("refuses a nonce too short to be unique to this attempt", () => {
    expect(() => proveTtyByTitleEcho({ ...base, nonce: "short", readTitle: () => null })).toThrow(
      /needs a fresh nonce of at least 8 characters/,
    )
  })

  it("proves the tty when the claimed window shows the nonce, and restores the title", () => {
    let restored = 0
    const proof = proveTtyByTitleEcho({
      ...base,
      writeTitle: () => {},
      readTitle: () => "hh-tty-echo-abcdefgh1234 — done",
      restoreTitle: () => {
        restored++
      },
    })
    expect(proof).toBe("tty=title-echo window=33 nonce=abcdefgh1234")
    expect(restored).toBe(1)
  })

  it("refuses a window whose title is not this run's echo, and still restores", () => {
    let restored = 0
    expect(() =>
      proveTtyByTitleEcho({
        ...base,
        readTitle: () => "somebody else's title",
        restoreTitle: () => {
          restored++
        },
      }),
    ).toThrow(/shows a title that is not this run's echo/)
    expect(restored).toBe(1)
  })

  it("refuses when the census withheld the title for every attempt, and still restores", () => {
    let restored = 0
    let waits = 0
    expect(() =>
      proveTtyByTitleEcho({
        ...base,
        readTitle: () => null,
        restoreTitle: () => {
          restored++
        },
        wait: () => {
          waits++
        },
        attempts: 3,
      }),
    ).toThrow(/reported no title through the census in 3 attempts/)
    expect(waits).toBe(3)
    expect(restored).toBe(1)
  })
})
