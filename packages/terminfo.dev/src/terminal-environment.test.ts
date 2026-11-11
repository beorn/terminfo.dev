/**
 * @failure The terminal's session bus is asserted from the collector's own environment, or the bus address
 *   or its digest is written into a result; either makes a notification negative unprovable or leaks the bus.
 * @level l1
 * @consumer The App notification rows: extensions.notifications and extensions.osc777-notify.
 * @testonly none
 */
import { expect, test } from "vitest"
import { createHash } from "node:crypto"
import { terminalBusState } from "./terminal-environment.ts"

const ADDRESS = "unix:path=/tmp/terminfo-session-bus,guid=9440e7cf51c4d583b288be5f6af4614c"
const OTHER = "unix:path=/run/user/1000/bus"

test("equal addresses read same, a different address reads different, absence reads unknown", () => {
  const terminal = { DBUS_SESSION_BUS_ADDRESS: ADDRESS }
  expect(terminalBusState(terminal, { DBUS_SESSION_BUS_ADDRESS: ADDRESS }).state).toBe("same")
  expect(terminalBusState(terminal, { DBUS_SESSION_BUS_ADDRESS: OTHER }).state).toBe("different")
  expect(terminalBusState({}, { DBUS_SESSION_BUS_ADDRESS: ADDRESS }).state).toBe("unknown")
  expect(terminalBusState(terminal, {}).state).toBe("unknown")
  expect(terminalBusState({ DBUS_SESSION_BUS_ADDRESS: "" }, { DBUS_SESSION_BUS_ADDRESS: "" }).state).toBe("unknown")
})

test("the reading carries neither the address nor its digest", () => {
  const digest = createHash("sha256").update(ADDRESS).digest("hex")
  for (const reading of [
    terminalBusState({ DBUS_SESSION_BUS_ADDRESS: ADDRESS }, { DBUS_SESSION_BUS_ADDRESS: ADDRESS }),
    terminalBusState({ DBUS_SESSION_BUS_ADDRESS: ADDRESS }, { DBUS_SESSION_BUS_ADDRESS: OTHER }),
    terminalBusState({}, {}),
  ]) {
    const serialized = JSON.stringify(reading)
    expect(serialized).not.toContain(ADDRESS)
    expect(serialized).not.toContain(digest)
    expect(serialized).not.toContain("guid=")
    expect(serialized).not.toContain("/tmp/terminfo-session-bus")
  }
})
