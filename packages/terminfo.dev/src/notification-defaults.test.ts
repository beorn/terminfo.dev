/**
 * @failure A notification negative is published for a run whose launch turned a notification setting on, or
 *   whose multiplexer pass-through is not at its default, so the verdict describes our configuration as the
 *   terminal's.
 * @level l1
 * @consumer extensions.notifications and extensions.osc777-notify on the App route.
 * @testonly none
 */
import { expect, test } from "vitest"
import { qualifyNotificationDefaults, readMuxAllowPassthrough } from "./notification-defaults.ts"

const ACRITTY = 'nice -n 10 /nix/store/x/bin/alacritty --option font.normal.family=\\"JetBrains\\ Mono\\" -e'

test("an owned launch line with no notification setting is the default configuration", () => {
  const reading = qualifyNotificationDefaults({ launchLine: ACRITTY })
  expect(reading.state).toBe("default")
  expect(reading.reason).toContain("names no notification setting")
})

test("a launch that names a notification setting is not the default", () => {
  for (const line of [
    "nice -n 10 /usr/bin/xterm -xrm 'notifications: true'",
    "nice -n 10 /usr/bin/kitty -o allow-passthrough=yes",
    "nice -n 10 /usr/bin/alacritty --option bell.command='notify-send hi'",
  ]) {
    expect(qualifyNotificationDefaults({ launchLine: line }).state).toBe("non-default")
  }
})

test("no launch line is unknown, never default", () => {
  expect(qualifyNotificationDefaults({}).state).toBe("unknown")
  expect(qualifyNotificationDefaults({ launchLine: "   " }).state).toBe("unknown")
})

test("a multiplexer passes only at its own default allow-passthrough value", () => {
  const base = { launchLine: ACRITTY }
  expect(qualifyNotificationDefaults({ ...base, passthrough: { value: "off" } }).state).toBe("default")
  expect(qualifyNotificationDefaults({ ...base, passthrough: { value: "on" } }).state).toBe("non-default")
  expect(qualifyNotificationDefaults({ ...base, passthrough: { reason: "no such option" } }).state).toBe("unknown")
})

test("the passthrough reader tries the window form then the session form, and refuses by name", async () => {
  const seen: string[][] = []
  const windowForm = await readMuxAllowPassthrough({
    async run(args) {
      seen.push([...args])
      return "off\n"
    },
  })
  expect(windowForm).toEqual({ value: "off" })
  expect(seen[0]).toEqual(["show-options", "-g", "-w", "-v", "allow-passthrough"])

  const sessionForm = await readMuxAllowPassthrough({
    async run(args) {
      if (args.includes("-w")) throw new Error("unknown option: -w")
      return "off"
    },
  })
  expect(sessionForm).toEqual({ value: "off" })

  const refused = await readMuxAllowPassthrough({
    async run() {
      throw new Error("no server")
    },
  })
  expect("reason" in refused && refused.reason).toContain("no server")
})

test("a mux negative needs the hosting terminal's own supported measurement of that row", async () => {
  const { qualifyOuterTerminalRecord } = await import("./notification-defaults.ts")
  const supported = {
    id: "kitty",
    version: "0.49.2",
    recordRunId: "ec3c7f325b2d",
    statuses: { "extensions.notifications": "supported", "extensions.osc777-notify": "supported" },
  }
  const yes = qualifyOuterTerminalRecord({ record: supported, probeId: "extensions.notifications" })
  expect(yes.record).toContain("kitty 0.49.2 measures extensions.notifications supported")
  expect(yes.record).toContain("ec3c7f325b2d")
  expect(yes.refusal).toBeUndefined()

  const stale = { ...supported, statuses: { "extensions.notifications": "untestable" } }
  const no = qualifyOuterTerminalRecord({ record: stale, probeId: "extensions.notifications" })
  expect(no.record).toBeUndefined()
  expect(no.refusal).toContain("reads untestable")

  expect(qualifyOuterTerminalRecord({ record: undefined, probeId: "extensions.notifications" }).refusal).toContain(
    "no outer-terminal record",
  )
  expect(qualifyOuterTerminalRecord({ record: { missing: "no placed record" }, probeId: "x" }).refusal).toContain(
    "no placed record",
  )
})
