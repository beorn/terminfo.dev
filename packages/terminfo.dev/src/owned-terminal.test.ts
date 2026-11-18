/**
 * @failure An untyped or extra-field Terminal.app assertion reaches the owned-output grant.
 * @level l1
 * @consumer Authenticated admin /probe owner assertion parser.
 * @testonly none
 */
import { expect, test } from "vitest"
import {
  createOwnedTerminal,
  linuxViewportKeys,
  parseOwnedAppOwnerAssertion,
  parseTerminalAppOwner,
} from "./owned-terminal.ts"

const valid = {
  asserter: "terminfo-admin",
  launchRunId: "a".repeat(32),
  workerPid: 123,
  windowId: 791,
  tabTty: "/dev/ttys004",
  intendedVersion: "2.15",
}

test("Terminal.app owner assertion has one strict authenticated-request shape", () => {
  expect(parseTerminalAppOwner(valid)).toEqual(valid)
  for (const assertion of [
    null,
    { ...valid, asserter: "other" },
    { ...valid, launchRunId: "bad" },
    { ...valid, workerPid: 0 },
    { ...valid, windowId: 0 },
    { ...valid, tabTty: "/dev/tty" },
    { ...valid, intendedVersion: "" },
    { ...valid, extra: true },
  ]) {
    expect(() => parseTerminalAppOwner(assertion)).toThrow(/Terminal.app owner assertion/)
  }
})

const validOwnedApp = {
  asserter: "terminfo-admin",
  launchRunId: "b".repeat(32),
  workerPid: 123,
  appId: "ghostty",
  ownerPid: 4242,
  windowId: 77,
  executablePath: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
  marker: { flag: "--owned-mac-run", value: "b".repeat(32) },
  tty: "/dev/ttys004",
  intendedVersion: "1.2.3",
}

test("owned-Mac app owner assertion has one strict authenticated-request shape", () => {
  expect(parseOwnedAppOwnerAssertion(validOwnedApp)).toEqual(validOwnedApp)
  for (const assertion of [
    null,
    { ...validOwnedApp, asserter: "other" },
    { ...validOwnedApp, launchRunId: "bad" },
    { ...validOwnedApp, workerPid: 0 },
    { ...validOwnedApp, appId: "" },
    { ...validOwnedApp, appId: "Ghostty" },
    { ...validOwnedApp, appId: "ghost ty" },
    { ...validOwnedApp, ownerPid: 1 },
    { ...validOwnedApp, ownerPid: 1.5 },
    { ...validOwnedApp, windowId: 0 },
    { ...validOwnedApp, executablePath: "ghostty" },
    { ...validOwnedApp, marker: { flag: "--owned mac", value: "x" } },
    { ...validOwnedApp, marker: { flag: "--owned-mac-run", value: "has space" } },
    { ...validOwnedApp, marker: { flag: "--owned-mac-run" } },
    { ...validOwnedApp, tty: "/dev/console" },
    { ...validOwnedApp, intendedVersion: "" },
    { ...validOwnedApp, extra: 1 },
    (({ intendedVersion: _dropped, ...rest }) => rest)(validOwnedApp),
  ]) {
    expect(() => parseOwnedAppOwnerAssertion(assertion)).toThrow(/Invalid owned-Mac app owner assertion/)
  }
})

test("the owned-terminal grant refuses two owner claims, including ownedApp", async () => {
  const run = "c".repeat(32)
  await expect(
    createOwnedTerminal({
      captureRunId: run,
      out: process.stdout,
      expectedLaunchRunId: run,
      ownedApp: {
        asserter: "terminfo-admin",
        launchRunId: run,
        workerPid: process.pid,
        appId: "ghostty",
        ownerPid: 4242,
        windowId: 77,
        executablePath: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
        marker: { flag: "--owned-mac-run", value: run },
        tty: "/dev/ttys004",
        intendedVersion: "1.2.3",
      },
      process: {
        asserter: "terminfo-admin",
        launchRunId: run,
        workerPid: process.pid,
        provider: "cli-process",
        ownerPid: 4242,
        executablePath: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
        basis: { kind: "marker", marker: { flag: "--owned-mac-run", value: run } },
        tty: "/dev/ttys004",
        intendedVersion: "1.2.3",
      },
    }),
  ).rejects.toThrow(/exactly one platform receipt/)
})

// @failure The Linux viewport route is claimed for any xterm run, or for an unreviewed build, or while a multiplexer
//   sits between the run and the app: the held rows would then press keys whose bindings nobody measured - xterm
//   binds shift+Home/End to nothing but a short jump unless the container launch declares the two scroll steps
//   (#34632).
// @level l1
// @consumer The owned Linux owner record that serve.ts reads before handing the viewport route to the held rows.
test("the Linux viewport route applies only to this run's own container launch of xterm 411 with no multiplexer", () => {
  const run = "b".repeat(32)
  const qualified = {
    appId: "xterm",
    platform: "linux",
    targetVersion: "411",
    runId: run,
    expectedLaunchRunId: run,
    multiplexed: false,
  }
  for (const measured of ["411", "412"]) {
    expect(linuxViewportKeys({ ...qualified, targetVersion: measured })?.viewportKeys.keys, measured).toEqual({
      pageUp: "shift+Prior",
      pageDown: "shift+Next",
      top: "shift+Home",
      bottom: "shift+End",
    })
  }
  expect(linuxViewportKeys(qualified)?.viewportKeys.route).toContain("container launch viewport keys")
  for (const [change, value] of [
    ["appId", "ghostty"],
    ["appId", "kitty"],
    ["appId", undefined],
    ["platform", "darwin"],
    ["targetVersion", "413"],
    ["targetVersion", "410"],
    ["targetVersion", undefined],
    ["runId", "c".repeat(32)],
    ["runId", undefined],
    ["multiplexed", true],
  ] as const) {
    expect(linuxViewportKeys({ ...qualified, [change]: value }), `${change}=${String(value)}`).toBeUndefined()
  }
  expect(linuxViewportKeys({ ...qualified, runId: "", expectedLaunchRunId: "" }), "empty launch id").toBeUndefined()
})
