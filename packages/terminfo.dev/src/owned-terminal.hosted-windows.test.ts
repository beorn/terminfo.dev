/**
 * @failure The hosted Windows arm accepts a second owner, or claims an ownership it cannot check on
 *   a platform that is not Windows, so a Windows run grades geometry on a console nobody verified
 *   (#29558, 138 inconclusive observations).
 * @level l1
 * @consumer createOwnedTerminal windowsHosted arm used by collectProbeRun on hosted Windows.
 * @testonly none
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { afterEach, expect, test } from "vitest"
import { createOwnedTerminal } from "./owned-terminal.ts"

const digest = (seed: string) => createHash("sha256").update(seed).digest("hex")
const directories: string[] = []
afterEach(() => {
  // raw-delete-allow: standalone component repository whose CI installs without hh's workspace, so removely is unavailable; each path is this test's own mkdtemp scratch root
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

const ids = {
  captureRunId: "a".repeat(32),
  expectedLaunchRunId: "b".repeat(32),
}

test("windowsHosted is a fourth XOR arm: linux plus windowsHosted is refused", async () => {
  await expect(
    createOwnedTerminal({
      ...ids,
      out: process.stdout,
      linux: { receiptPath: "/tmp/missing-linux.json", executable: { path: process.execPath, sha256: digest("x") } },
      windowsHosted: { receiptPath: "/tmp/missing-windows.json" },
    }),
  ).rejects.toThrow(/Owned terminal requires exactly one platform receipt/)
})

test("windowsHosted alone off Windows refuses by platform, before it reads any receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terminfo-hosted-windows-"))
  directories.push(dir)
  const receiptPath = join(dir, "host-measured.json")
  // A receipt file that EXISTS but is not a github-hosted-runner envelope: if the platform guard
  // came second, this test would fail on the receipt instead of the platform, and a Windows run
  // started anywhere else would read a receipt it has no business reading.
  writeFileSync(receiptPath, "{}")
  await expect(
    createOwnedTerminal({
      ...ids,
      out: process.stdout,
      windowsHosted: { receiptPath },
    }),
  ).rejects.toThrow(/Owned Windows hosted terminal requires Windows/)
})
