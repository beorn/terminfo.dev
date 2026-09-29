/**
 * @failure A foreign or incomplete receipt authorizes OSC 52, or a failed callback leaves a disposable selection mutated.
 * @level l1
 * @consumer Owned Linux clipboard adapter used by the app probe batch.
 * @testonly none
 * @reach fs-walk /tmp/terminfo-clipboard-receipts
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "vitest"
import { createClipboardTransaction, createLinuxClipboardAdapter, type ClipboardTraceEvent } from "./linux-clipboard.ts"

const originalCapture = process.env.TERMINFO_CAPTURE_DIRECTORY
const measuredExecutable = { path: process.execPath, sha256: "0".repeat(64) }
const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
  if (originalCapture === undefined) delete process.env.TERMINFO_CAPTURE_DIRECTORY
  else process.env.TERMINFO_CAPTURE_DIRECTORY = originalCapture
})

test.runIf(process.platform === "linux")(
  "missing live display and process receipt refuses before xclip access",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "terminfo-clipboard-receipts-"))
    directories.push(dir)
    process.env.TERMINFO_CAPTURE_DIRECTORY = join(dir, "artifacts")
    const receipt = join(dir, "clipboard-fixture.json")
    writeFileSync(receipt, JSON.stringify({ schemaVersion: 1, runId: "a".repeat(32), profile: "allow" }), {
      mode: 0o600,
    })
    await expect(
      createLinuxClipboardAdapter(receipt, "a".repeat(32), measuredExecutable, "c".repeat(32), process.stdout),
    ).rejects.toThrow("Invalid owned clipboard receipt")
    writeFileSync(
      receipt,
      JSON.stringify({
        schemaVersion: 1,
        runId: "a".repeat(32),
        profile: "allow",
        display: {},
        terminal: {},
        selection: {},
        config: "",
        permissions: "",
      }),
    )
    await expect(
      createLinuxClipboardAdapter(receipt, "a".repeat(32), measuredExecutable, "c".repeat(32), process.stdout),
    ).rejects.toThrow("invalid PID")
    writeFileSync(
      receipt,
      JSON.stringify({
        schemaVersion: 1,
        runId: "a".repeat(32),
        profile: "allow",
        display: { name: ":22", number: 22, displayFdPath: join(dir, "display-number"), xvfbPid: 123 },
        terminal: { pid: 456, collectorPid: process.pid, windowId: "42", windowPid: 456 },
        selection: {
          helperPid: 789,
          helperExecutable: { path: "/bin/false", sha256: "b".repeat(64) },
          baselinePath: join(dir, "baseline"),
          baselineSha256: "c".repeat(64),
          initialReadSha256: "c".repeat(64),
        },
        config: "fixture",
        permissions: "clipboard: read=allow,write=allow",
      }),
    )
    await expect(
      createLinuxClipboardAdapter(receipt, "b".repeat(32), measuredExecutable, "c".repeat(32), process.stdout),
    ).rejects.toThrow("does not match this collector run")
  },
)

/** This child checks real Linux fds; Vitest workers replace stdin even when Vitest itself has a PTY. */
test.runIf(process.platform === "linux")("owned Linux output proof uses a real controlling PTY", () => {
  const codeRoot = resolve(fileURLToPath(import.meta.url), "../../../../../..")
  const sourceRoot = join(codeRoot, "vendor/terminfo.dev/packages/terminfo.dev/src")
  const child = String.raw`
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as realChildProcess from "node:child_process"
import * as realFs from "node:fs"
import * as realOs from "node:os"
import { join } from "node:path"
import { isatty, WriteStream } from "node:tty"
import { pathToFileURL } from "node:url"
import { mock } from "bun:test"

const mode = process.env.TERMINFO_OWNED_TTY_CHILD
const foreignFd = Number(process.env.TERMINFO_FOREIGN_TTY_FD)
const root = process.env.TERMINFO_TEST_SOURCE_ROOT
assert(root && isatty(0) && isatty(1) && isatty(foreignFd))
const launch = "a".repeat(32)
const capture = "b".repeat(32)
const digest = (value) => createHash("sha256").update(value).digest("hex")
const dir = realFs.mkdtempSync(join(realOs.tmpdir(), "terminfo-owned-pty-"))
const displayFdPath = join(dir, "display-number")
const baselinePath = join(dir, "baseline")
const helperExecutable = join(dir, "xclip")
const kittyExecutable = join(dir, "kitty")
const receiptPath = join(dir, "clipboard-fixture.json")
const baseline = "terminfo-owned-clipboard-" + launch
try {
  realFs.writeFileSync(displayFdPath, "22", { mode: 0o600 })
  realFs.writeFileSync(baselinePath, baseline, { mode: 0o600 })
  realFs.writeFileSync(helperExecutable, "owned-xclip-binary", { mode: 0o600 })
  realFs.writeFileSync(kittyExecutable, "owned-kitty-binary", { mode: 0o600 })
  realFs.writeFileSync(receiptPath, JSON.stringify({
    schemaVersion: 1, runId: launch, profile: "default",
    display: { name: ":22", number: 22, displayFdPath, xvfbPid: 419422 },
    terminal: { pid: process.pid, collectorPid: process.pid, windowId: "42", windowPid: process.pid },
    selection: { helperPid: 419423, helperExecutable: { path: helperExecutable, sha256: digest("owned-xclip-binary") },
      baselinePath, baselineSha256: digest(baseline), initialReadSha256: digest(baseline) },
    config: "--config NONE", permissions: "clipboard: read=ask,write=allow; OSC52=not-run",
  }), { mode: 0o600 })
  process.env.TERMINFO_CAPTURE_DIRECTORY = join(dir, "artifacts")
  process.env.DISPLAY = ":22"
  process.env.TERMINFO_CLIPBOARD_PROFILE = "default"
  const actualReadFileSync = realFs.readFileSync
  const actualRealpathSync = realFs.realpathSync
  mock.module("node:os", () => ({ ...realOs, homedir: () => dir }))
  mock.module("node:fs", () => ({ ...realFs,
    readFileSync(path, ...args) {
      if (/^\/proc\/\d+\/status$/.test(path)) return "Uid:\t" + process.getuid() + "\t" + process.getuid() + "\n"
      if (path === "/proc/419422/cmdline") return "Xvfb\0-displayfd\0"
      if (path === "/proc/" + process.pid + "/cmdline") return "kitty\0--config\0NONE\0bun\0"
      if (path === "/proc/" + process.pid + "/exe") return Buffer.from("owned-kitty-binary")
      return actualReadFileSync(path, ...args)
    },
    realpathSync(path, ...args) {
      if (path === "/proc/419422/exe") return "/usr/bin/Xvfb"
      if (path === "/proc/419423/exe") return helperExecutable
      if (path === "/proc/" + process.pid + "/exe") return kittyExecutable
      return actualRealpathSync(path, ...args)
    },
  }))
  mock.module("node:child_process", () => ({ ...realChildProcess,
    execFile(_file, args, _options, callback) {
      callback(null, args[0] === "getwindowpid" ? String(process.pid) : baseline)
      return {}
    },
  }))
  const base = pathToFileURL(root + "/").href
  const verifier = await import(base + "linux-clipboard.ts")
  const { runProbeBatch } = await import(base + "probes/unified.ts")
  const { openControllingTTY } = await import(base + "tty.ts")
  const executable = { path: kittyExecutable, sha256: digest("owned-kitty-binary") }
  const factory = (out, run = capture, live = executable) =>
    verifier.createLinuxClipboardAdapter(receiptPath, launch, live, run, out)
  if (mode === "no-ctty") {
    await assert.rejects(factory(process.stdout), /controlling tty_nr 0/)
  } else {
    await assert.rejects(factory(process.stdout, capture, { ...executable, sha256: "0".repeat(64) }),
      /Live executable digest mismatch/)
    const fake = { fd: 1, columns: 80, write() { throw new Error("fake output was written") } }
    await assert.rejects(factory(fake), /not a real TTY stream/)
    await assert.rejects(factory(process.stderr), /not a TTY/)
    const foreign = new WriteStream(foreignFd)
    await assert.rejects(factory(foreign), /Owned output device/)
    const adapter = await factory(process.stdout)
    const stdoutBinding = JSON.parse(adapter.summary).outputBinding
    assert.equal(stdoutBinding.matched, "pty")
    assert.equal(stdoutBinding.controllingTtyNr, stdoutBinding.inputRdev)
    assert.equal(stdoutBinding.controllingTtyNr, stdoutBinding.outputRdev)
    assert.equal(verifier.ownedTerminalVerifiedFor(adapter, capture, process.stdout), true)
    assert.equal(verifier.ownedTerminalVerifiedFor(adapter, "c".repeat(32), process.stdout), false)
    assert.equal(verifier.ownedTerminalVerifiedFor(adapter, capture, foreign), false)
    assert.equal(verifier.ownedTerminalVerifiedFor({ ...adapter }, capture, process.stdout), false)
    const owned = await runProbeBatch({ ids: ["reset.ris", "extensions.osc52-write"], captureRunId: capture,
      clipboard: adapter, out: process.stdout })
    assert.match(owned.rawReplies["reset.ris"], /\\u001bc/)
    assert.equal(owned.ungradedDiagnostics["reset.ris"].kind, "legacy-callback")
    assert.equal(owned.observations.find((item) => item.featureId === "extensions.osc52-write").reason, "policy-refused")
    assert.deepEqual(JSON.parse(owned.rawReplies["extensions.osc52-write"]).writes, [])
    for (const [run, out] of [["c".repeat(32), process.stdout], [capture, foreign], [capture, fake]]) {
      const refused = await runProbeBatch({ ids: ["reset.ris"], captureRunId: run, clipboard: adapter, out })
      assert.equal(refused.observations[0].reason, "policy-refused")
      assert.deepEqual(JSON.parse(refused.rawReplies["reset.ris"]).writes, [])
    }
    const alias = openControllingTTY()
    const aliasAdapter = await factory(alias, "d".repeat(32))
    const aliasBinding = JSON.parse(aliasAdapter.summary).outputBinding
    assert.equal(aliasBinding.matched, "dev-tty")
    assert.equal(aliasBinding.outputRdev, 1280)
    assert.equal(aliasBinding.controllingTtyNr, aliasBinding.inputRdev)
    assert.equal(verifier.ownedTerminalVerifiedFor(aliasAdapter, "d".repeat(32), alias), true)
    const aliasBatch = await runProbeBatch({ ids: ["reset.ris"], captureRunId: "d".repeat(32),
      clipboard: aliasAdapter, out: alias })
    assert.match(aliasBatch.rawReplies["reset.ris"], /\\u001bc/)
    await aliasAdapter.dispose()
    await new Promise((resolve) => alias.end(resolve))
    await adapter.dispose()
    assert.equal(verifier.ownedTerminalVerifiedFor(adapter, capture, process.stdout), false)
    const disposed = await runProbeBatch({ ids: ["reset.ris"], captureRunId: capture,
      clipboard: adapter, out: process.stdout })
    assert.equal(disposed.observations[0].reason, "policy-refused")
    assert.deepEqual(JSON.parse(disposed.rawReplies["reset.ris"]).writes, [])
    await new Promise((resolve) => foreign.end(resolve))
  }
} finally {
  process.stdin.pause()
  mock.restore()
  realFs.rmSync(dir, { recursive: true, force: true })
}
`
  const python = String.raw`
import fcntl, os, pty, subprocess, sys, termios, threading
mode = sys.argv[1]
primary_master, primary_slave = pty.openpty()
foreign_master, foreign_slave = pty.openpty()
def session():
    os.setsid()
    if mode == 'owned': fcntl.ioctl(primary_slave, termios.TIOCSCTTY, 0)
env = dict(os.environ, TERMINFO_OWNED_TTY_CHILD=mode, TERMINFO_FOREIGN_TTY_FD=str(foreign_slave))
child = subprocess.Popen(sys.argv[2:], stdin=primary_slave, stdout=primary_slave,
                         stderr=subprocess.PIPE, pass_fds=(foreign_slave,), preexec_fn=session, env=env)
os.close(primary_slave)
os.close(foreign_slave)
primary = bytearray()
foreign = bytearray()
def drain(fd, output):
    while True:
        try: chunk = os.read(fd, 65536)
        except OSError: return
        if not chunk: return
        output.extend(chunk)
readers = [threading.Thread(target=drain, args=(primary_master, primary), daemon=True),
           threading.Thread(target=drain, args=(foreign_master, foreign), daemon=True)]
for reader in readers: reader.start()
try:
    _, errors = child.communicate(timeout=10)
except subprocess.TimeoutExpired:
    child.kill()
    _, errors = child.communicate()
    sys.stderr.write('direct Bun PTY child timed out\n')
    sys.stderr.buffer.write(errors)
    sys.exit(2)
for reader in readers: reader.join(timeout=2)
if child.returncode:
    sys.stderr.buffer.write(errors)
    sys.stderr.buffer.write(primary)
    sys.exit(child.returncode)
if mode == 'owned' and (primary.count(b'\x1bc') != 2 or foreign):
    sys.stderr.write('wrong owned PTY byte count or foreign PTY received bytes\n')
    sys.exit(3)
`
  for (const mode of ["owned", "no-ctty"]) {
    const result = spawnSync("python3", ["-c", python, mode, process.execPath, "-e", child], {
      cwd: codeRoot,
      encoding: "utf8",
      timeout: 40000,
      env: { ...process.env, TERMINFO_TEST_SOURCE_ROOT: sourceRoot },
    })
    expect(result.error, `${mode}: ${result.stderr}`).toBeUndefined()
    expect(result.status, `${mode}: ${result.stderr}`).toBe(0)
  }
})

test("a nested transaction refuses and callback failure restores and verifies the generated baseline", async () => {
  let text = "baseline-nonce"
  const events: ClipboardTraceEvent[] = []
  const transaction = createClipboardTransaction("baseline-nonce", {
    assertOwned: async () => {},
    readText: async (trace, kind = "clipboard-read") => {
      trace({ kind, at: new Date().toISOString(), sha256: "a".repeat(64), length: text.length })
      return text
    },
    writeText: async (value, trace, kind = "clipboard-write") => {
      text = value
      trace({ kind, at: new Date().toISOString(), sha256: "a".repeat(64), length: text.length })
    },
  })
  await expect(
    transaction(
      async (fixture) => {
        await fixture.writeText("callback-nonce")
        await expect(
          transaction(
            async () => ({ pass: true }),
            (event) => events.push(event),
          ),
        ).rejects.toThrow("cannot nest")
        throw new Error("query failed")
      },
      (event) => events.push(event),
    ),
  ).rejects.toThrow("query failed")
  expect(text).toBe("baseline-nonce")
  expect(events.map((event) => event.kind)).toEqual([
    "clipboard-read",
    "clipboard-write",
    "clipboard-restore",
    "clipboard-verify",
  ])
  expect(events.every((event) => !Number.isNaN(Date.parse(event.at)))).toBe(true)
})

test("restoration failure overrides a supported callback result", async () => {
  const transaction = createClipboardTransaction("baseline-nonce", {
    assertOwned: async () => {},
    readText: async () => "baseline-nonce",
    writeText: async () => {
      throw new Error("xclip exited")
    },
  })
  await expect(
    transaction(
      async () => ({ pass: true, observation: { outcome: "supported", evidence: "behavior" } }),
      () => {},
    ),
  ).rejects.toThrow("Owned clipboard restoration failed: xclip exited")
})
