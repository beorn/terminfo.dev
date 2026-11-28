/**
 * @failure A re-freeze keeps a trace the probes stopped writing (the old sentinel paint's ESC 7/ESC 8),
 *   so its window cell is refused forever; or a newer run that broke mid-cell displaces the last
 *   complete trace, and the table is derived from a half-written cell (#39207, @cto 313ea37a).
 * @level l0
 * @consumer scripts/generate-window-basis-table.ts --freeze
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { selectWindowTraces, type FreezeRun } from "./window-basis-freeze.ts"

const CELL = "extensions.osc112-reset-cursor"
const alacritty = { kind: "term", id: "alacritty", version: "0.17.0", os: "linux", osVersion: "7.0.0-34" }

function run(
  path: string,
  measuredAt: string,
  result: Record<string, unknown> | null,
  subject: object = alacritty,
): FreezeRun {
  return {
    path,
    subject,
    measuredAt,
    results: result === null ? [] : [{ featureId: CELL, ...result }],
    cells: new Map([[CELL, [CELL]]]),
  }
}

const kept = (runs: FreezeRun[]) => [...selectWindowTraces(runs).keep.keys()].sort()

describe("window-basis freeze selection (#39207)", () => {
  it("keeps the newer clean run over the older one whose trace still carries ESC 7/ESC 8", () => {
    const older = run("content/probes-apps/alacritty-old.json", "2026-11-17T00:00:00Z", { status: "supported" })
    const newer = run("content/probes-apps/alacritty-new.json", "2026-11-28T18:00:00Z", { status: "supported" })
    expect(kept([older, newer])).toEqual(["content/probes-apps/alacritty-new.json"])
    expect(kept([newer, older]), "file order does not decide").toEqual(["content/probes-apps/alacritty-new.json"])
  })

  it("never lets a newer incomplete or collector-error run displace an older complete one", () => {
    const complete = run("content/probes-apps/alacritty-old.json", "2026-11-17T00:00:00Z", { status: "supported" })
    const exceeded = run("content/probes-apps/alacritty-exceeded.json", "2026-11-28T18:00:00Z", {
      status: "probe-todo",
      harnessOutcome: "probe-exceeded",
    })
    const missing = run("content/probes-apps/alacritty-missing.json", "2026-11-28T19:00:00Z", null)
    expect(kept([complete, exceeded, missing])).toEqual(["content/probes-apps/alacritty-old.json"])
  })

  it("takes the newest incomplete run only when no complete run exists", () => {
    const a = run("content/probes-apps/a.json", "2026-11-17T00:00:00Z", {
      status: "probe-todo",
      harnessOutcome: "probe-exceeded",
    })
    const b = run("content/probes-apps/b.json", "2026-11-28T00:00:00Z", null)
    expect(kept([a, b])).toEqual(["content/probes-apps/b.json"])
  })

  it("lets a newer app or OS version supersede an older one, and keeps distinct apps and launches apart", () => {
    const old = run("content/probes-apps/old.json", "2026-11-17T00:00:00Z", { status: "supported" })
    const upgraded = run(
      "content/probes-apps/upgraded.json",
      "2026-11-28T00:00:00Z",
      { status: "supported" },
      {
        ...alacritty,
        version: "0.18.0",
        osVersion: "7.0.0-43",
      },
    )
    const other = run(
      "content/probes-apps/xterm.json",
      "2026-11-01T00:00:00Z",
      { status: "supported" },
      { ...alacritty, id: "xterm" },
    )
    const tmuxConf = run(
      "content/probes-apps/conf.json",
      "2026-11-01T00:00:00Z",
      { status: "supported" },
      {
        ...alacritty,
        config: "mux-empty.conf",
      },
    )
    expect(kept([old, upgraded, other, tmuxConf])).toEqual([
      "content/probes-apps/conf.json",
      "content/probes-apps/upgraded.json",
      "content/probes-apps/xterm.json",
    ])
  })

  it("refuses a run it cannot order, by path", () => {
    expect(() =>
      selectWindowTraces([run("content/probes-apps/x.json", "not a time", { status: "supported" })]),
    ).toThrow("content/probes-apps/x.json: measuredAt")
  })
})
