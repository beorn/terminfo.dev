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
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "vitest"
import { createClipboardTransaction, createLinuxClipboardAdapter, type ClipboardTraceEvent } from "./linux-clipboard.ts"

const originalCapture = process.env.TERMINFO_CAPTURE_DIRECTORY
const measuredExecutable = { path: process.execPath, sha256: "0".repeat(64) }
const directories: string[] = []

// The direct-owner tests cannot witness mux attachment: both measured process shapes need
// the same grant to reject detach, foreign sockets, changed identities and extra displays.
test.runIf(process.platform === "linux")("mux clipboard grant checks the measured attachment before every read", () => {
  const sourceRoot = dirname(fileURLToPath(import.meta.url))
  const child = String.raw`
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as cp from "node:child_process"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { mock } from "bun:test"
const root = fs.mkdtempSync(join(os.tmpdir(), "terminfo-mux-owner-"))
const hash = x => createHash("sha256").update(x).digest("hex")
const launch = "a".repeat(32), capture = "b".repeat(32)
const baseline = "terminfo-owned-clipboard-" + launch
const bootId = "730f0ec0-707d-47f4-bf82-1a1e28ec4f10"
const receiptPath = join(root, "clipboard-fixture.json")
const exe = name => join(root, name)
for (const [name, bytes] of Object.entries({kitty:"kitty-bytes",tmux:"tmux-bytes",screen:"screen-bytes",xclip:"xclip-bytes",config:"",baseline,display:"22"})) {
  fs.writeFileSync(exe(name), bytes, {mode:0o600})
}
const real = {...fs}
let mux, variant, table, socket, muxTarget, reads = 0
const statText = pid => {
  const p = table.get(pid)
  if (!p) throw Error("fixture missing process " + pid)
  const fields = ["S",p.ppid,pid,pid,p.tty,-1,0,0,0,0,0,0,0,0,0,20,0,1,0,p.start]
  return pid + " (process name) " + fields.join(" ")
}
mock.module("node:os", () => ({...os,homedir:()=>root}))
mock.module("node:fs", () => ({...fs,
  readFileSync(path,...args) {
    if (path === "/proc/sys/kernel/random/boot_id") return bootId + "\n"
    if (path === "/proc/net/unix") return "Num RefCount Protocol Flags Type St Inode Path\n0000: 2 0 10000 1 01 12345 " + (variant === "foreign-socket" ? socket + "-foreign" : socket) + "\n"
    const m = /^\/proc\/(\d+)\/(stat|status|cmdline|exe)$/.exec(path)
    if (m) {
      const pid=Number(m[1]),p=table.get(pid)
      if (!p) throw Error("fixture missing process " + pid)
      if (m[2] === "stat") return statText(pid)
      if (m[2] === "status") return "Uid:\t" + process.getuid() + "\n"
      if (m[2] === "cmdline") return pid===76 ? "kitty\0--config\0NONE\0bun\0" : pid===419422 ? "Xvfb\0-displayfd\0" : "mux\0"
      return real.readFileSync(p.exe,...args)
    }
    return real.readFileSync(path,...args)
  },
  realpathSync(path,...args) {
    const m = /^\/proc\/(\d+)\/exe$/.exec(path)
    if (m) return table.get(Number(m[1])).exe
    return real.realpathSync(path,...args)
  },
  readdirSync(path,...args) {
    if (path === "/proc/147/fd") return variant === "second-client" ? ["3","4","5","7"] : ["3","4","5"]
    return real.readdirSync(path,...args)
  },
  readlinkSync(path,...args) {
    if (path === "/proc/147/fd/3") return variant === "detached" ? "/dev/null" : "/dev/pts/0"
    if (path === "/proc/147/fd/4") return "socket:[12345]"
    if (path === "/proc/147/fd/5") return "/dev/pts/ptmx"
    if (path === "/proc/147/fd/7") return "/dev/pts/2"
    return real.readlinkSync(path,...args)
  },
  statSync(path,...args) {
    if (path === socket) return {isSocket:()=>true,uid:process.getuid(),mode:0o140700}
    if (path === "/dev/pts/0" || path === "/proc/147/fd/3") return {isCharacterDevice:()=>true,rdev:34816}
    if (path === "/dev/pts/2" || path === "/proc/147/fd/7") return {isCharacterDevice:()=>true,rdev:34818}
    return real.statSync(path,...args)
  },
}))
mock.module("node:child_process", () => ({...cp,
  execFile(file,args,options,callback) {
    if (file === "xdotool") callback(null,"76\n")
    else if (file === exe("tmux")) {
      if (variant === "detached") callback(null,"")
      else callback(null, "148\t/dev/pts/0\tterminfo-" + launch + "\t" + (variant === "foreign-socket" ? socket + "-foreign" : socket) + "\n" + (variant === "second-client" ? "150\t/dev/pts/2\tterminfo-"+launch+"\t"+socket+"\n" : ""))
    } else {reads++;callback(null,baseline)}
    return {}
  },
}))
process.env.TERMINFO_CAPTURE_DIRECTORY=join(root,"artifacts")
process.env.DISPLAY=":22"
process.env.TERMINFO_CLIPBOARD_PROFILE="default"
try {
  const {createLinuxClipboardAdapter}=await import(pathToFileURL(process.env.TERMINFO_TEST_SOURCE_ROOT+"/linux-clipboard.ts").href)
  const initialize = (kind, bad) => {
    mux=kind;variant=bad;reads=0
    const p=(ppid,start,tty,exe)=>({ppid,start,tty,exe})
    // Faithful projection of measured-relations.json: tmux server keeps outer ctty;
    // Screen server has none and is a child of its attached client.
    table=new Map([
      [76,p(1,"100",0,exe("kitty"))],[92,p(76,"110",34816,"/bin/bash")],
      [95,p(92,"115",34816,process.execPath)],
      [145,p(92,"120",34816,exe("tmux"))],[148,p(92,"121",34816,exe("tmux"))],
      [146,p(92,"120",34816,exe("screen"))],[147,p(146,"121",0,exe("screen"))],
      [process.pid,p(kind==="tmux"?145:147,"130",34817,process.execPath)],
      [419422,p(1,"80",0,"/usr/bin/Xvfb")],[419423,p(1,"90",0,exe("xclip"))]
    ])
    socket=join(root,kind==="tmux"?"terminfo-"+launch+".sock":"147.terminfo-"+launch)
    muxTarget={kind:"mux",mux:kind,bootId,
      preflightCollector:{pid:95,startTicks:"115"},outerShell:{pid:92,startTicks:"110",ttyRdev:34816},
      outerTerminal:{pid:76,startTicks:"100"},collector:{pid:process.pid,startTicks:"130"},
      executable:{path:exe(kind),sha256:hash(kind+"-bytes"),version:kind==="tmux"?"3.7c":"5.0.2"},config:{path:exe("config"),sha256:hash("")},
      socketPath:socket,session:"terminfo-"+launch}
    if (bad==="wrong-client-tty") table.get(kind==="tmux"?148:146).tty=34818
    if (bad==="outer-collector-tty") table.get(process.pid).tty=34816
    if (bad==="undeclared-executable") table.get(kind==="tmux"?145:147).exe=exe("kitty")
    if (bad==="recycled-shell") table.get(92).start="999"
    real.writeFileSync(receiptPath,JSON.stringify({schemaVersion:1,runId:launch,profile:"default",target:muxTarget,
      display:{name:":22",number:22,displayFdPath:exe("display"),xvfbPid:419422},
      terminal:{pid:76,collectorPid:process.pid,windowId:"42",windowPid:76},
      selection:{helperPid:419423,helperExecutable:{path:exe("xclip"),sha256:hash("xclip-bytes")},baselinePath:exe("baseline"),baselineSha256:hash(baseline),initialReadSha256:hash(baseline)},
      config:"--config NONE",permissions:"clipboard: read=ask,write=allow; OSC52=not-run"}),{mode:0o600})
  }
  const factory=()=>createLinuxClipboardAdapter(receiptPath,launch,{path:exe("kitty"),sha256:hash("kitty-bytes")},capture)
  for(const kind of ["tmux","screen"]) {
    initialize(kind,"valid")
    const adapter=await factory()
    assert(adapter.muxAttachmentProof,kind+" attachment snapshot missing")
    assert.equal(adapter.muxAttachmentProof.captureRunId,capture)
    assert.equal(adapter.muxAttachmentProof.collector.ttyRdev,34817)
    assert.equal(adapter.muxAttachmentProof.attachedClient.ttyRdev,34816)
    assert.equal(adapter.muxAttachmentProof.receiptSha256,hash(real.readFileSync(receiptPath)))
    // The same grant must notice detach before the next clipboard operation.
    variant="detached"
    const previousReads=reads
    await assert.rejects(adapter.withClipboardFixture(async()=>{throw Error("unowned callback ran")},()=>{}),/attached|display/i)
    assert.equal(reads,previousReads)
    await adapter.dispose()
    for(const bad of ["detached","wrong-client-tty","outer-collector-tty","undeclared-executable","foreign-socket","second-client","recycled-shell"]) {
      initialize(kind,bad)
      await assert.rejects(factory(),/mux|socket|client|collector|shell|executable|attached|display/i,kind+" "+bad)
      assert.equal(reads,0,kind+" "+bad+" accessed clipboard before rejecting")
    }
  }
} finally {mock.restore();real.rmSync(root,{recursive:true,force:true})}
`
  const result = spawnSync(process.execPath, ["-e", child], {
    encoding: "utf8",
    timeout: 20000,
    env: { ...process.env, TERMINFO_TEST_SOURCE_ROOT: sourceRoot },
  })
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
})

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
    await expect(createLinuxClipboardAdapter(receipt, "a".repeat(32), measuredExecutable)).rejects.toThrow(
      "Invalid owned clipboard receipt",
    )
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
    await expect(createLinuxClipboardAdapter(receipt, "a".repeat(32), measuredExecutable)).rejects.toThrow(
      "invalid PID",
    )
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
    await expect(createLinuxClipboardAdapter(receipt, "b".repeat(32), measuredExecutable)).rejects.toThrow(
      "does not match this collector run",
    )
  },
)

/** This child checks real Linux fds; Vitest workers replace stdin even when Vitest itself has a PTY. */
test.runIf(process.platform === "linux")("owned Linux output proof uses a real controlling PTY", () => {
  const sourceRoot = dirname(fileURLToPath(import.meta.url))
  const codeRoot = resolve(sourceRoot, "../../..")
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
  const verifier = await import(base + "owned-terminal.ts")
  const { runProbeBatch } = await import(base + "probes/unified.ts")
  const { openControllingTTY, withRawMode } = await import(base + "tty.ts")
  const executable = { path: kittyExecutable, sha256: digest("owned-kitty-binary") }
  const factory = (out, run = capture, live = executable) =>
    verifier.createOwnedTerminal({ expectedLaunchRunId: launch, captureRunId: run, out,
      linux: { receiptPath, executable: live } })
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
    assert.deepEqual([adapter.geometryAtGrant.status, adapter.geometryAtGrant.rows, adapter.geometryAtGrant.cols],
      ["measured", 24, 61])
    assert.deepEqual(JSON.parse(adapter.summary).geometryAtGrant, adapter.geometryAtGrant)
    const changedSize = realChildProcess.spawnSync("stty", ["rows", "31", "cols", "73"],
      { stdio: [0, "ignore", "pipe"] })
    assert.equal(changedSize.status, 0, changedSize.stderr?.toString())
    const resized = await adapter.readGeometry()
    assert.deepEqual([resized.status, resized.rows, resized.cols], ["measured", 31, 73])
    const originalPath = process.env.PATH
    const sttyFixture = join(dir, "stty")
    try {
      process.env.PATH = dir
      const missing = await adapter.readGeometry()
      assert.equal(missing.status, "unavailable")
      assert.match(missing.diagnostic, /stty size failed/)
      process.env.PATH = dir + ":" + originalPath
      for (const [script, expected] of [
        ["#!/bin/sh\nprintf 'bad size\\n'\n", /invalid rows and cols/],
        ["#!/bin/sh\nprintf '0 61\\n'\n", /invalid rows and cols/],
        ["#!/bin/sh\nprintf '31 73\\n'\nexit 7\n", /exited 7/],
        ["#!/bin/sh\nexec sleep 2\n", /timed out/],
      ]) {
        realFs.writeFileSync(sttyFixture, script, { mode: 0o700 })
        const unavailable = await adapter.readGeometry()
        assert.equal(unavailable.status, "unavailable")
        assert.match(unavailable.diagnostic, expected)
      }
    } finally {
      process.env.PATH = originalPath
      realFs.rmSync(sttyFixture, { force: true })
    }
    const stdoutBinding = JSON.parse(adapter.summary).outputBinding
    assert.equal(stdoutBinding.matched, "pty")
    assert.equal(stdoutBinding.controllingTtyNr, stdoutBinding.inputRdev)
    assert.equal(stdoutBinding.controllingTtyNr, stdoutBinding.outputRdev)
    const exactOutput = realFs.fstatSync(1, { bigint: true })
    assert.deepEqual(stdoutBinding.outputDevice, {
      dev: exactOutput.dev.toString(),
      rdev: exactOutput.rdev.toString(),
      ino: exactOutput.ino.toString(),
    })
    assert.equal(verifier.ownedTerminalVerifiedFor(adapter, capture, process.stdout), true)
    assert.equal(verifier.ownedTerminalVerifiedFor(adapter, "c".repeat(32), process.stdout), false)
    assert.equal(verifier.ownedTerminalVerifiedFor(adapter, capture, foreign), false)
    assert.equal(verifier.ownedTerminalVerifiedFor({ ...adapter }, capture, process.stdout), false)
    // A genuine granted owner must also remain current at each consumer boundary (CTO 7acc71d2).
    // Revoke the SAME verifier after callback start; counters detect a final-check-only placebo.
    const { ALL_PROBES: definitions } = await import("@terminfo/probe-defs")
    const definition = definitions.find(probe => probe.id === "reset.ris")
    const originalCallback = definition.term
    const originalAssert = adapter.clipboard.assertOwned
    const originalWrite = process.stdout.write
    const refusal = new Error("fixture attachment continuity lost")
    const failures = []
    let revoked = false, touched = 0
    adapter.clipboard.assertOwned = async () => { if (revoked) throw refusal; await originalAssert() }
    process.stdout.write = function (chunk, ...args) {
      if (chunk === "\x1b[6n") touched++
      return originalWrite.call(this, chunk, ...args)
    }
    try {
      for (const boundary of ["callback", "query", "capture", "input", "final"]) {
        revoked = boundary === "callback"; touched = 0
        let callbacks = 0
        definition.term = async context => {
          callbacks++
          revoked = true
          if (boundary === "query") await context.query("\x1b[6n", /\x1b\[(\d+);(\d+)R/, 100)
          if (boundary === "capture") await context.capture({role:"control",label:"custody"})
          if (boundary === "input") await context.input.injectKey("a")
          return {observation:{outcome:"supported",evidence:"query"}}
        }
        try {
          await assert.rejects(withRawMode(() => runProbeBatch({ids:["reset.ris"], captureRunId:capture,
            ownedTerminal:adapter,out:process.stdout,
            capture:async()=>{touched++;throw Error("unowned capture ran")},
            input:{injectKey:async()=>{touched++},injectClick:async()=>{touched++}},
          })), error=>error===refusal, boundary+" must name the custody failure")
          assert.equal(touched,0,boundary+" crossed the refused boundary")
          if (boundary === "callback") assert.equal(callbacks,0,"revoked callback ran")
        } catch(error) { failures.push(boundary+": "+error.message) }
      }
    } finally {
      definition.term = originalCallback
      adapter.clipboard.assertOwned = originalAssert
      process.stdout.write = originalWrite
      revoked = false
    }
    assert.deepEqual(failures,[])
    const owned = await withRawMode(() => runProbeBatch({ ids: ["reset.ris", "extensions.osc52-write"], captureRunId: capture,
      ownedTerminal: adapter, out: process.stdout }))
    assert.match(owned.rawReplies["reset.ris"], /\\u001bc/)
    assert.equal(owned.ungradedDiagnostics["reset.ris"], undefined)
    const reset = owned.observations.find((item) => item.featureId === "reset.ris")
    assert.equal(reset.outcome, "supported")
    assert.equal(reset.evidence, "query")
    assert.deepEqual(JSON.parse(owned.rawReplies["reset.ris.callbackResponse"]), {
      before: { row: 5, col: 5 }, after: { row: 1, col: 1 }
    })
    assert.deepEqual(JSON.parse(owned.rawReplies["reset.ris"]).queries.map(query => query.raw),
      ["\x1b[5;5R", "\x1b[1;1R"])
    assert.equal(owned.observations.find((item) => item.featureId === "extensions.osc52-write").reason, "policy-refused")
    assert.deepEqual(JSON.parse(owned.rawReplies["extensions.osc52-write"]).writes, [])
    for (const [run, out] of [["c".repeat(32), process.stdout], [capture, foreign], [capture, fake]]) {
      const refused = await runProbeBatch({ ids: ["reset.ris"], captureRunId: run, ownedTerminal: adapter, out })
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
    assert.deepEqual([aliasAdapter.geometryAtGrant.status, aliasAdapter.geometryAtGrant.rows, aliasAdapter.geometryAtGrant.cols],
      ["measured", 31, 73])
    const aliasSize = await aliasAdapter.readGeometry()
    assert.deepEqual([aliasSize.status, aliasSize.rows, aliasSize.cols], ["measured", 31, 73])
    const aliasBatch = await withRawMode(() => runProbeBatch({ ids: ["reset.ris"], captureRunId: "d".repeat(32),
      ownedTerminal: aliasAdapter, out: alias }), alias)
    assert.match(aliasBatch.rawReplies["reset.ris"], /\\u001bc/)
    await aliasAdapter.dispose()
    await new Promise((resolve) => alias.end(resolve))
    await adapter.dispose()
    await assert.rejects(adapter.readGeometry(), /no live bound capture/)
    assert.equal(verifier.ownedTerminalVerifiedFor(adapter, capture, process.stdout), false)
    const disposed = await runProbeBatch({ ids: ["reset.ris"], captureRunId: capture,
      ownedTerminal: adapter, out: process.stdout })
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
import fcntl, os, pty, re, struct, subprocess, sys, termios, threading
mode = sys.argv[1]
primary_master, primary_slave = pty.openpty()
foreign_master, foreign_slave = pty.openpty()
fcntl.ioctl(primary_slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 61, 0, 0))
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
def drain(fd, output, answer_cursor=False):
    # Only the existing RIS fixture protocol: CUP 5;5, RIS, and DSR 6.
    # Buffer across reads so a split control sequence receives the same answer.
    pending = b''
    cursor = (1, 1)
    while True:
        try: chunk = os.read(fd, 65536)
        except OSError: return
        if not chunk: return
        output.extend(chunk)
        if answer_cursor:
            pending += chunk
            while True:
                match = re.search(rb'\x1b(?:\[5;5H|c|\[6n)', pending)
                if not match: break
                sequence = match.group()
                pending = pending[match.end():]
                if sequence == b'\x1b[5;5H': cursor = (5, 5)
                elif sequence == b'\x1bc': cursor = (1, 1)
                else: os.write(fd, ('\x1b[%d;%dR' % cursor).encode())
readers = [threading.Thread(target=drain, args=(primary_master, primary, True), daemon=True),
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
            async () => ({
              pass: true,
              observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none" },
            }),
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
