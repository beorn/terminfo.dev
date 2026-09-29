/**
 * @failure An untyped or extra-field Terminal.app assertion reaches the owned-output grant.
 * @level l1
 * @consumer Authenticated admin /probe owner assertion parser.
 * @testonly none
 */
import { expect, test } from "vitest"
import { parseTerminalAppOwner } from "./owned-terminal.ts"

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
