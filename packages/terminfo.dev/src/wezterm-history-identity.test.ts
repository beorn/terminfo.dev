/**
 * @failure A WezTerm arm reads its history through its own CLI but records an identity check with no
 *   executable and no reason on the platform that skipped the proof, so the count's provenance is a blank
 *   (@cto REVISE at f1b0a7ffe: the proof ran on macOS only and the Linux arm kept the CLI-read flag).
 * @level l1
 * @consumer Owned WezTerm arm on every platform.
 * @testonly none
 */
import { expect, test } from "vitest"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
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

/**
 * @failure The Linux owned WezTerm arm reaches createOwnedTerminal's return with no historyExecutable, so the
 *   terminal this run hands the probes names a CLI count whose producing program is unrecorded — the wiring the
 *   pre-fix producer had at f1b0a7ffe (@dev/3 REVISE, 33999: the four helper-level cases never entered the
 *   constructor, so restoring that gate left them all green).
 * @level l1
 * @consumer createOwnedTerminal's Linux arm, as the probe batch receives it.
 * @testonly none
 */
test.runIf(process.platform === "linux")(
  "the Linux arm createOwnedTerminal returns carries its own measured CLI, not a flag without one",
  () => {
    const sourceRoot = dirname(fileURLToPath(import.meta.url))
    const child = String.raw`
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { pathToFileURL } from "node:url"
import { mock } from "bun:test"
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const root = fs.mkdtempSync(join(os.tmpdir(), "terminfo-wezterm-owned-"))
const launch = "a".repeat(32), capture = "b".repeat(32)
const version = "wezterm 20240203-110809-5046fc22"
const bin = join(root, "bin")
fs.mkdirSync(bin)
const gui = join(bin, "wezterm-gui")
fs.writeFileSync(gui, "owned-wezterm-gui-bytes")
// The sibling rule the production arm resolves: the CLI beside the owned binary, and the same install's writer.
const cli = join(bin, "wezterm")
fs.writeFileSync(cli, "#!/bin/sh\necho '" + version + "'\n", { mode: 0o755 })
process.env.TERMINFO_TARGET_ID = "wezterm"
const base = pathToFileURL(process.env.TERMINFO_TEST_SOURCE_ROOT + "/").href
// Only the pasteboard adapter is replaced: this case is the constructor's identity wiring, not the X11 grant,
// and the adapter would otherwise need a display this fixture does not own.
const clipboardModule = await import(base + "linux-clipboard.ts")
mock.module(base + "linux-clipboard.ts", () => ({ ...clipboardModule,
  async createLinuxClipboardAdapter() { return { assertOwned: async () => {}, readTitle: async () => "fixture-title", dispose: async () => {} } } }))
const { createOwnedTerminal } = await import(base + "owned-terminal.ts")
let owner
try {
  owner = await createOwnedTerminal({
    captureRunId: capture,
    expectedLaunchRunId: launch,
    out: process.stdout,
    linux: { receiptPath: join(root, "receipt.json"), executable: { path: gui, sha256: hash(fs.readFileSync(gui)) } },
  })
  assert.equal(owner.historyReadsThroughCli, true, "the owned Linux WezTerm arm counts through its own CLI")
  assert.deepEqual(owner.historyExecutable, { path: cli, sha256: hash(fs.readFileSync(cli)), version },
    "the arm the probes receive names the CLI that produced its count")
  assert.equal(owner.historyExecutableUnmeasured, undefined, "a measured proof is never also unmeasured")
} finally {
  await owner?.dispose()
  fs.rmSync(root, { recursive: true, force: true })
}
`
    const python = String.raw`
import fcntl, os, pty, struct, subprocess, sys, termios, threading
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
def session():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=subprocess.PIPE, preexec_fn=session)
os.close(slave)
output = bytearray()
def drain():
    while True:
        try: chunk = os.read(master, 65536)
        except OSError: return
        if not chunk: return
        output.extend(chunk)
reader = threading.Thread(target=drain, daemon=True)
reader.start()
try:
    _, errors = child.communicate(timeout=45)
except subprocess.TimeoutExpired:
    child.kill()
    _, errors = child.communicate()
    sys.stderr.write('owned WezTerm constructor child timed out\n')
    sys.stderr.buffer.write(errors)
    sys.exit(2)
reader.join(timeout=2)
if child.returncode:
    sys.stderr.buffer.write(errors)
    sys.stderr.buffer.write(output)
    sys.exit(child.returncode)
`
    const result = spawnSync("python3", ["-c", python, process.execPath, "-e", child], {
      cwd: sourceRoot,
      encoding: "utf8",
      timeout: 70_000,
      env: { ...process.env, TERMINFO_TEST_SOURCE_ROOT: sourceRoot },
    })
    expect(result.error, `${result.stderr}`).toBeUndefined()
    expect(result.status, `${result.stderr}${result.stdout}`).toBe(0)
  },
  90_000,
)
