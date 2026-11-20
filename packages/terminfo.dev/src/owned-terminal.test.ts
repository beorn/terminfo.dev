/**
 * @failure An untyped or extra-field Terminal.app assertion reaches the owned-output grant.
 * @level l1
 * @consumer Authenticated admin /probe owner assertion parser.
 * @testonly none
 */
import { expect, test } from "vitest"
import {
  ALACRITTY_0_17_VIEWPORT_ROUTE,
  LINUX_ALACRITTY_0_17_VIEWPORT_ROUTE,
  LINUX_GHOSTTY_1_4_VIEWPORT_ROUTE,
} from "@terminfo/probe-defs"
import {
  createOwnedTerminal,
  gatedPrivateWrite,
  linuxViewportKeys,
  parseOwnedAppOwnerAssertion,
  parseTerminalAppOwner,
} from "./owned-terminal.ts"
import { withRunSignal } from "./tty.ts"

const valid = {
  asserter: "terminfo-admin",
  launchRunId: "a".repeat(32),
  workerPid: 123,
  windowId: 791,
  tabTty: "/dev/ttys004",
  intendedVersion: "2.15",
}

// 34959: on the hosted cmux route the osc633-p private write is the one writer that reached the owned pane
// without consulting the run's abort edge. It now composes with the same gated writer as the public one, so a
// run whose client has left must refuse BEFORE anything reaches the stream, and the ownership check must still
// run on both sides.
test("34959 the cmux private writer refuses past the abort edge and never records the private URI", async () => {
  const writes: string[] = []
  const out = {
    write(chunk: unknown) {
      writes.push(String(chunk))
      return true
    },
  } as unknown as NodeJS.WriteStream
  const controller = new AbortController()
  let checks = 0
  const privateWrite = gatedPrivateWrite(async () => {
    checks += 1
  }, out)
  const privateUri = "\x1b[6;1H\x1b]7;file:///Users/private-person/secret-project\x07marker"

  // Before the edge the private write reaches the stream (the row needs it to measure the App).
  await withRunSignal(controller.signal, () => privateWrite(privateUri))
  expect(writes.join("")).toContain("secret-project")

  // Past the edge it is refused before a byte lands, and the ownership check still ran once.
  writes.length = 0
  checks = 0
  controller.abort()
  await expect(withRunSignal(controller.signal, () => privateWrite(privateUri))).rejects.toMatchObject({
    name: "AbortError",
  })
  expect(writes).toEqual([])
  expect(checks).toBe(1)
})

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

test("Linux Alacritty 0.17.0 gets its own XTEST route only on its own unmultiplexed launch (34278, @cto a6ed9b08)", () => {
  const run = "d".repeat(32)
  const qualified = {
    appId: "alacritty",
    platform: "linux",
    targetVersion: "0.17.0",
    runId: run,
    expectedLaunchRunId: run,
    multiplexed: false,
  }
  expect(linuxViewportKeys(qualified)?.viewportKeys).toEqual({
    route: LINUX_ALACRITTY_0_17_VIEWPORT_ROUTE,
    keys: { pageUp: "shift+Page_Up", pageDown: "shift+Page_Down", top: "shift+Home", bottom: "shift+End" },
  })
  // Not the hosted macOS route: shared key names do not qualify Linux delivery.
  expect(linuxViewportKeys(qualified)?.viewportKeys.route).not.toBe(ALACRITTY_0_17_VIEWPORT_ROUTE)
  for (const [change, value] of [
    ["targetVersion", "0.16.0"],
    ["targetVersion", "0.17.1"],
    ["targetVersion", undefined],
    ["platform", "darwin"],
    ["runId", "e".repeat(32)],
    ["multiplexed", true],
  ] as const) {
    expect(linuxViewportKeys({ ...qualified, [change]: value }), `${change}=${String(value)}`).toBeUndefined()
  }
})

// @failure Linux Ghostty gets a viewport route at an unreviewed version, under a multiplexer or another run's launch,
//   or under Alacritty's route name, so held rows trust keys nobody bound for that app (#37249, @cto f584ccea).
// @level l1
// @consumer The Linux owner record that createOwnedTerminal hands the held-viewport reader.
test("Linux Ghostty 1.4.0 gets its own default-binding XTEST route only on its own unmultiplexed launch (#37249)", () => {
  const run = "f".repeat(32)
  const qualified = {
    appId: "ghostty",
    platform: "linux",
    targetVersion: "1.4.0",
    runId: run,
    expectedLaunchRunId: run,
    multiplexed: false,
  }
  expect(linuxViewportKeys(qualified)?.viewportKeys).toEqual({
    route: LINUX_GHOSTTY_1_4_VIEWPORT_ROUTE,
    keys: { pageUp: "shift+Page_Up", pageDown: "shift+Page_Down", top: "shift+Home", bottom: "shift+End" },
  })
  expect(LINUX_GHOSTTY_1_4_VIEWPORT_ROUTE).not.toBe(LINUX_ALACRITTY_0_17_VIEWPORT_ROUTE)
  for (const [change, value] of [
    ["targetVersion", "1.3.1"],
    ["targetVersion", undefined],
    ["platform", "darwin"],
    ["runId", "e".repeat(32)],
    ["multiplexed", true],
  ] as const) {
    expect(linuxViewportKeys({ ...qualified, [change]: value }), `${change}=${String(value)}`).toBeUndefined()
  }
})
