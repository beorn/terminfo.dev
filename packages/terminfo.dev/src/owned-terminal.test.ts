/**
 * @failure An untyped or extra-field Terminal.app assertion reaches the owned-output grant.
 * @level l1
 * @consumer Authenticated admin /probe owner assertion parser.
 * @testonly none
 */
import { expect, test } from "vitest"
import { parseOwnedAppOwnerAssertion, parseTerminalAppOwner } from "./owned-terminal.ts"

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
