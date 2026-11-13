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
import { ownedWezTermHistoryExecutable, wezTermHistoryIdentity } from "./wezterm-owned-history.ts"

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

  // A Linux arm that does not own the pane resolves no CLI, so it cannot claim CLI reads either. This is the
  // ownership-to-reader gap: the flag and the proof must resolve from the same decision (@dev/3 peer read).
  const unowned = ownedWezTermHistoryExecutable({
    platform: "linux",
    ownsWezTermPane: false,
    linuxExecutablePath: "/fixture/bin/wezterm-gui",
  })
  expect(unowned).toBeUndefined()
  expect(wezTermHistoryIdentity(unowned)).toBeUndefined()
})

/**
 * @failure A Linux owned WezTerm arm sets historyReadsThroughCli and never runs the CLI proof, so serve reports
 *   an unmeasured identity even though a measurable CLI exists on the arm (the pre-fix producer at f1b0a7ffe;
 *   @dev/3 peer proof /hh/var/@dev3/31741-linux-history-proof-0106.json).
 * @level l1
 * @consumer The Linux owned WezTerm history arm.
 * @testonly none
 */
test("the Linux ownership path resolves its own CLI and reaches a measured proof", () => {
  const dir = mkdtempSync(join(tmpdir(), "wezterm-linux-owner-"))
  const cli = join(dir, "wezterm")
  writeFileSync(cli, "#!/bin/sh\necho 'wezterm 20240203-110809-5046fc22'\n")
  chmodSync(cli, 0o755)
  const resolved = ownedWezTermHistoryExecutable({
    platform: "linux",
    ownsWezTermPane: true,
    linuxExecutablePath: join(dir, "wezterm-gui"),
  })
  expect(resolved).toBe(cli)
  const identity = wezTermHistoryIdentity(resolved)
  expect(identity?.historyReadsThroughCli).toBe(true)
  expect(identity?.historyExecutable).toMatchObject({ path: cli, version: "wezterm 20240203-110809-5046fc22" })
  expect(identity?.historyExecutableUnmeasured).toBeUndefined()
})
