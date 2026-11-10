/**
 * @failure A hosted Terminal.app run is placed without proof that its owned window was opened by this run and is gone.
 * @level l1
 * @consumer #33152: the hosted macOS finalise step and the release1 placement reader (@cto 56e401d9 point 3).
 * @testonly none
 */
// #33152 (@cto 56e401d9 point 3, conditions agreed with @dev/11): a hosted Terminal.app run record
// carries the launch and the disposal of its owned window, or the job refuses by name. The close step's
// side files existed before this, but nothing put them in run.json, so a placed record could not show
// that the window it measured was opened by this run and is gone.
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import {
  DISPOSAL_KEY,
  LAUNCH_PROOF_KEY,
  assertTerminalWindowRecord,
  finaliseTerminalWindowRecord,
} from "./terminal-window-record.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const TTY = "/dev/ttys003"
const launch = {
  appId: "terminal-app",
  terminalWindow: { provider: "terminal-app", windowId: 14, tty: TTY },
  beforeIds: [12, 13],
  afterIds: [12, 13, 14, 15],
  // The cold start's own startup window is a second new id; it is recorded and does not refuse.
  newIds: [
    { windowId: 14, tabCount: 1, tty: TTY },
    { windowId: 15, tabCount: 1, tty: "/dev/ttys004" },
  ],
}
const disposal = { appId: "terminal-app", windowId: 14, tty: TTY, remaining: 0 }
const RUN = { runId: "hosted-run-1", rawReplies: { "collector.collectionStatus": "collected" }, results: [] }

function artifacts(files: { launch?: unknown; disposal?: unknown; run?: unknown; launcherLog?: boolean }): string {
  const out = mkdtempSync(join(tmpdir(), "terminal-window-record-"))
  dirs.push(out)
  const put = (name: string, value: unknown) =>
    writeFileSync(join(out, name), typeof value === "string" ? value : JSON.stringify(value))
  if (files.launch !== undefined) put("terminal-launch.json", files.launch)
  if (files.disposal !== undefined) put("terminal-window-disposal.json", files.disposal)
  if (files.run !== undefined) put("run.json", files.run)
  if (files.launcherLog) put("launcher.log", "")
  return out
}

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")

describe("finaliseTerminalWindowRecord", () => {
  test("writes both entries with each side file's sha256 into run.json and leaves runId alone", () => {
    const out = artifacts({ launch, disposal, run: RUN })
    finaliseTerminalWindowRecord(out)
    const run = JSON.parse(readFileSync(join(out, "run.json"), "utf8")) as typeof RUN & {
      rawReplies: Record<string, string>
    }
    expect(run.runId).toBe("hosted-run-1")
    expect(run.rawReplies["collector.collectionStatus"]).toBe("collected")
    expect(JSON.parse(run.rawReplies[LAUNCH_PROOF_KEY] ?? "")).toEqual({
      windowId: 14,
      tty: TTY,
      beforeIds: [12, 13],
      afterIds: [12, 13, 14, 15],
      newIds: launch.newIds,
      owner: expect.stringContaining("the one new single-tab window whose tty is the launched tty"),
      source: "terminal-launch.json",
      sha256: sha256(join(out, "terminal-launch.json")),
    })
    expect(JSON.parse(run.rawReplies[DISPOSAL_KEY] ?? "")).toEqual({
      windowId: 14,
      tty: TTY,
      remaining: 0,
      source: "terminal-window-disposal.json",
      sha256: sha256(join(out, "terminal-window-disposal.json")),
    })
  })

  test("an empty before census is a cold runner, not a refusal", () => {
    const cold = { ...launch, beforeIds: [], afterIds: [14, 15] }
    expect(() => finaliseTerminalWindowRecord(artifacts({ launch: cold, disposal, run: RUN }))).not.toThrow()
  })

  // Each refusal leaves run.json exactly as the collector wrote it.
  test.each([
    {
      name: "absent launch",
      files: { disposal, run: RUN },
      error: "owned Terminal window: terminal-launch.json is absent, so this run opened no window it can name",
    },
    {
      // @chief: a launch that ran and recorded nothing is never "no launch".
      name: "absent launch after the launch arm ran",
      files: { disposal, run: RUN, launcherLog: true },
      error:
        "owned Terminal window: terminal-launch.json is absent, so this run opened no window it can name; launcher.log shows the launch arm ran",
    },
    {
      name: "unparseable launch",
      files: { launch: "{", disposal, run: RUN },
      error: "owned Terminal window: terminal-launch.json is malformed at (file) (",
    },
    {
      name: "launch without a window id",
      files: {
        launch: { ...launch, terminalWindow: { ...launch.terminalWindow, windowId: "14" } },
        disposal,
        run: RUN,
      },
      error: 'owned Terminal window: terminal-launch.json is malformed at terminalWindow.windowId ("14")',
    },
    {
      name: "launch without a census",
      files: { launch: { ...launch, afterIds: undefined }, disposal, run: RUN },
      error: "owned Terminal window: terminal-launch.json is malformed at afterIds (undefined)",
    },
    {
      name: "window already present before the launch",
      files: { launch: { ...launch, beforeIds: [12, 13, 14] }, disposal, run: RUN },
      error: "owned Terminal window 14 was already present before the launch: before census held 12,13,14",
    },
    {
      name: "window missing from the after census",
      files: { launch: { ...launch, afterIds: [12, 13, 15] }, disposal, run: RUN },
      error: "owned Terminal window: terminal-launch.json is malformed at afterIds ([12,13,15])",
    },
    {
      name: "no new single-tab window on the launched tty",
      files: { launch: { ...launch, newIds: [{ windowId: 14, tabCount: 2, tty: TTY }] }, disposal, run: RUN },
      error:
        'owned Terminal window: terminal-launch.json is malformed at newIds ([{"windowId":14,"tabCount":2,"tty":"/dev/ttys003"}])',
    },
    {
      name: "a second new window on the launched tty",
      files: {
        launch: {
          ...launch,
          afterIds: [12, 13, 14, 16],
          newIds: [launch.newIds[0], { windowId: 16, tabCount: 3, tty: TTY }],
        },
        disposal,
        run: RUN,
      },
      error: "owned Terminal window: two windows answer to the launched tty /dev/ttys003 (ids 14, 16)",
    },
    {
      name: "absent disposal",
      files: { launch, run: RUN },
      error: "owned Terminal window 14: terminal-window-disposal.json is absent, so the close is not proved",
    },
    {
      name: "surviving window",
      files: { launch, disposal: { ...disposal, remaining: 1 }, run: RUN },
      error: "owned Terminal window 14 survived its close: 1 windows still answer to that id",
    },
    {
      name: "window id mismatch",
      files: { launch, disposal: { ...disposal, windowId: 15 }, run: RUN },
      error: "owned Terminal window: launch/disposal disagree on windowId: 14 vs 15",
    },
    {
      name: "tty mismatch",
      files: { launch, disposal: { ...disposal, tty: "/dev/ttys009" }, run: RUN },
      error: "owned Terminal window: launch/disposal disagree on tty: /dev/ttys003 vs /dev/ttys009",
    },
    {
      name: "absent run record",
      files: { launch, disposal },
      error: "owned Terminal window 14: run.json is absent, so no run record can carry the launch and the close",
    },
  ])("refuses by name: $name", ({ files, error }) => {
    const out = artifacts(files)
    const before = files.run === undefined ? undefined : readFileSync(join(out, "run.json"), "utf8")
    expect(() => finaliseTerminalWindowRecord(out)).toThrow(error)
    if (before !== undefined) expect(readFileSync(join(out, "run.json"), "utf8")).toBe(before)
  })
})

describe("assertTerminalWindowRecord (placement)", () => {
  const finalised = () => {
    const out = artifacts({ launch, disposal, run: RUN })
    finaliseTerminalWindowRecord(out)
    return (JSON.parse(readFileSync(join(out, "run.json"), "utf8")) as { rawReplies: Record<string, string> })
      .rawReplies
  }

  test("admits a record that carries both entries", () => {
    expect(() => assertTerminalWindowRecord(finalised(), "run.json")).not.toThrow()
  })

  test.each([LAUNCH_PROOF_KEY, DISPOSAL_KEY])("refuses a record without %s", (key) => {
    const rawReplies = finalised()
    delete rawReplies[key]
    expect(() => assertTerminalWindowRecord(rawReplies, "run.json")).toThrow(
      `run.json: hosted Terminal.app record lacks ${key}, so it cannot claim an owned window opened and closed by this run`,
    )
  })

  // A foreign writer's launch entry with the right source and sha256 but no census cannot claim the window was new.
  test("refuses a launch entry that lacks the census", () => {
    const rawReplies = finalised()
    const { beforeIds: _before, ...noCensus } = JSON.parse(rawReplies[LAUNCH_PROOF_KEY] ?? "") as Record<
      string,
      unknown
    >
    rawReplies[LAUNCH_PROOF_KEY] = JSON.stringify(noCensus)
    expect(() => assertTerminalWindowRecord(rawReplies, "run.json")).toThrow(
      `run.json: hosted Terminal.app record lacks ${LAUNCH_PROOF_KEY}, so it cannot claim an owned window opened and closed by this run`,
    )
  })

  // The local daemon path writes a proof sentence into collector.windowDisposal; that is not this route's record.
  test("refuses a disposal entry that is a sentence, not the structured record", () => {
    const rawReplies = { ...finalised(), [DISPOSAL_KEY]: "owned-window-disposal: pending launcher daemon stop" }
    expect(() => assertTerminalWindowRecord(rawReplies, "run.json")).toThrow(
      `run.json: hosted Terminal.app record lacks ${DISPOSAL_KEY}, so it cannot claim an owned window opened and closed by this run`,
    )
  })
})
