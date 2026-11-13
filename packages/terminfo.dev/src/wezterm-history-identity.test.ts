/**
 * @failure A WezTerm arm reads its history through its own CLI but records an identity check with no
 *   executable and no reason on the platform that skipped the proof, so the count's provenance is a blank
 *   (@cto REVISE at f1b0a7ffe: the proof ran on macOS only and the Linux arm kept the CLI-read flag).
 * @level l1
 * @consumer Owned WezTerm arm on every platform.
 * @testonly none
 */
import { expect, test } from "vitest"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { wezTermHistoryIdentity } from "./wezterm-owned-history.ts"

function executable(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), "wezterm-identity-"))
  const path = join(dir, "wezterm")
  writeFileSync(path, `#!/bin/sh\necho '${version}'\n`)
  chmodSync(path, 0o755)
  return path
}

test("a readable CLI names its own measured proof, with no platform condition", () => {
  const path = executable("wezterm 20240203-110809-5046fc22")
  const identity = wezTermHistoryIdentity(path)
  expect(identity?.historyReadsThroughCli).toBe(true)
  expect(identity?.historyExecutable).toMatchObject({ path, version: "wezterm 20240203-110809-5046fc22" })
  expect(identity?.historyExecutable?.sha256).toMatch(/^[a-f0-9]{64}$/u)
  expect(identity?.historyExecutableUnmeasured).toBeUndefined()
})

test("an unmeasured proof always carries its reason, never a bare unmeasured", () => {
  const identity = wezTermHistoryIdentity(join(tmpdir(), "no-such-wezterm-cli"))
  expect(identity?.historyReadsThroughCli).toBe(true)
  expect(identity?.historyExecutable).toBeUndefined()
  expect(identity?.historyExecutableUnmeasured).toMatch(/could not be hashed|reported no version/u)
})

test("no owned CLI means no identity at all, so an arm without one claims nothing", () => {
  expect(wezTermHistoryIdentity(undefined)).toBeUndefined()
})
