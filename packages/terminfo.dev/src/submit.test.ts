/**
 * @failure Probe issues omit the submitter's CC0 dedication.
 * @level l1
 * @consumer terminfo.dev issue submission through gh or browser
 * @testonly none
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const { execFileSync, writeFileSync } = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}))

vi.mock("node:child_process", () => ({ execFileSync }))
vi.mock("node:fs", () => ({ writeFileSync, unlinkSync: vi.fn() }))

import { submitResults } from "./submit.ts"

const dedication =
  "I dedicate these results to the public domain (CC0 1.0) so terminfo.dev can publish them under any license."
const data = {
  terminal: "ExampleTerm",
  terminalVersion: "1.0",
  os: "Linux",
  osVersion: "1.0",
  results: { "device.primary-da": true },
  notes: {},
  responses: {},
  generated: "2026-09-28T00:00:00Z",
}

describe("submitResults issue terms", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("includes the CC0 dedication in both gh and browser issue bodies", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    execFileSync.mockReturnValue("https://github.com/beorn/terminfo.dev/issues/1\n")
    await submitResults(data)
    const ghBody = writeFileSync.mock.calls[0]?.[1]
    expect(ghBody).toContain(dedication)

    vi.clearAllMocks()
    execFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === "gh" && args[0] === "--version") throw new Error("gh unavailable")
      return ""
    })
    await submitResults(data)
    const browserCall = execFileSync.mock.calls.find(([, args]) =>
      args.some((arg: string) => arg.includes("/issues/new?")),
    )
    if (!browserCall) throw new Error("Browser issue URL was not opened")
    const issueUrl = new URL(browserCall[1][browserCall[1].length - 1])
    expect(issueUrl.searchParams.get("body")).toContain(dedication)
  })
})
