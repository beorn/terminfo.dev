/**
 * @failure A foreign or incomplete receipt authorizes OSC 52, or a failed callback leaves a disposable selection mutated.
 * @level l1
 * @consumer Owned Linux clipboard adapter used by the app probe batch.
 * @testonly none
 * @reach fs-walk <fixture-only: /tmp/terminfo-clipboard-receipts>
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
test.runIf(process.platform === "linux")("mux clipboard grant tests the measured attachment before every read", () => {
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
fs.mkdirSync(join(root, "artifacts"))
const hardcopies = []
const hash = x => createHash("sha256").update(x).digest("hex")
const launch = "a".repeat(32), capture = "b".repeat(32)
const baseline = "terminfo-owned-clipboard-" + launch
const bootId = "730f0ec0-707d-47f4-bf82-1a1e28ec4f10"
const receiptPath = join(root, "clipboard-fixture.json")
const exe = name => join(root, name)
const screenConfig = "defscrollback 100\n"
for (const [name, bytes] of Object.entries({kitty:"kitty-bytes",tmux:"tmux-bytes",screen:"screen-bytes",xclip:"xclip-bytes",config:screenConfig,baseline,display:"22"})) {
  fs.writeFileSync(exe(name), bytes, {mode:0o600})
}
const real = {...fs}
const fsFault = new Error("fixture filesystem link unavailable")
let spawns=0
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
    if (variant === "status-io" && path === "/proc/"+process.pid+"/status") throw fsFault
    if (variant === "config-io" && path === exe("config")) throw fsFault
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
    if (variant === "exe-io" && path === "/proc/"+process.pid+"/exe") throw fsFault
    const m = /^\/proc\/(\d+)\/exe$/.exec(path)
    if (m) return table.get(Number(m[1])).exe
    return real.realpathSync(path,...args)
  },
  readdirSync(path,...args) {
    if (variant === "fd-directory-io" && path === "/proc/147/fd") throw fsFault
    if (path === "/proc/147/fd") return variant === "second-client" ? ["3","4","5","7"] : ["3","4","5"]
    return real.readdirSync(path,...args)
  },
  readlinkSync(path,...args) {
    if (variant === "fd-link-io" && path === "/proc/147/fd/3") throw fsFault
    if (path === "/proc/147/fd/3") return variant === "detached" ? "/dev/null" : "/dev/pts/0"
    if (path === "/proc/147/fd/4") return "socket:[12345]"
    if (path === "/proc/147/fd/5") return "/dev/pts/ptmx"
    if (path === "/proc/147/fd/7") return "/dev/pts/2"
    return real.readlinkSync(path,...args)
  },
  statSync(path,...args) {
    if (variant === "socket-io" && path === socket) throw fsFault
    if (path === socket) return {isSocket:()=>true,uid:process.getuid(),mode:0o140700}
    if (path === "/dev/pts/0" || path === "/proc/147/fd/3") return {isCharacterDevice:()=>true,rdev:34816}
    if (path === "/dev/pts/2" || path === "/proc/147/fd/7") return {isCharacterDevice:()=>true,rdev:34818}
    return real.statSync(path,...args)
  },
}))
mock.module("node:child_process", () => ({...cp,
  spawnSync(file,args,options) {
    assert.equal(file,exe("screen"))
    assert.deepEqual(args.slice(0,5),["-S",muxTarget.session,"-X","hardcopy","-h"])
    assert.equal(options.env.SCREENDIR,root)
    const path=args[5]
    assert.equal(path.slice(0,path.lastIndexOf("/")),join(root,"artifacts"))
    assert(path.includes(muxTarget.session))
    assert(!hardcopies.includes(path),"each Screen read needs its own retained hardcopy")
    hardcopies.push(path)
    if(variant==="screen-refused")return {status:2,stdout:Buffer.alloc(0),stderr:Buffer.from("screen fixture refusal")}
    const used = variant === "screen-more" ? 21 : 20
    real.writeFileSync(path, "\n".repeat(100 - used) + "row\n".repeat(used + 24))
    if(variant==="screen-owner-lost")variant="detached"
    return {status:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}
  },
  spawn(){spawns++;throw new Error("unowned clipboard writer spawned")},
  execFile(file,args,options,callback) {
    if (file === "xdotool") callback(null,"76\n")
    else if (file === exe("tmux")) {
      if(args.includes("display-message")) {
        assert.deepEqual(args,["-S",socket,"display-message","-p","-t",muxTarget.session,"#{history_size} #{pane_height} #{scroll_position} #{pane_in_mode}"])
        if(variant==="scrollback-failed")callback(new Error("tmux history command failed"),"")
        else callback(null,variant==="scrollback-malformed"?"not counts\n":variant==="scrollback-bottom"?"20 24  0\n":variant==="scrollback-empty-mode"?"20 24  1\n":"20 24 3 1\n")
        return {}
      }
      const server = args.at(-1).includes("#{pid}") ? (variant === "foreign-server" ? "149" : "145") + "\t" : ""
      if (variant === "detached") callback(null,"")
      else callback(null, server + (variant === "client-changed" ? "150" : "148") + "\t/dev/pts/0\tterminfo-" + launch + "\t" + (variant === "foreign-socket" ? socket + "-foreign" : socket) + "\n" + (variant === "second-client" ? server+"150\t/dev/pts/2\tterminfo-"+launch+"\t"+socket+"\n" : ""))
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
      [149,p(92,"122",34816,exe("tmux"))],[150,p(92,"123",34816,exe("tmux"))],
      [146,p(92,"120",34816,exe("screen"))],[147,p(146,"121",0,exe("screen"))],
      [process.pid,p(kind==="tmux"?145:147,"130",34817,process.execPath)],
      [419422,p(1,"80",0,"/usr/bin/Xvfb")],[419423,p(1,"90",0,exe("xclip"))]
    ])
    socket=join(root,kind==="tmux"?"terminfo-"+launch+".sock":"147.terminfo-"+launch)
    muxTarget={kind:"mux",mux:kind,bootId,
      preflightCollector:{pid:95,startTicks:"115"},outerShell:{pid:92,startTicks:"110",ttyRdev:34816},
      outerTerminal:{pid:76,startTicks:"100"},collector:{pid:process.pid,startTicks:"130"},
      executable:{path:exe(kind),sha256:hash(kind+"-bytes"),version:kind==="tmux"?"3.7c":"5.0.2"},config:{path:exe("config"),sha256:hash(screenConfig)},
      socketPath:socket,session:"terminfo-"+launch}
    if (bad==="wrong-client-tty") table.get(kind==="tmux"?148:146).tty=34818
    if (bad==="outer-collector-tty") table.get(process.pid).tty=34816
    if (bad==="undeclared-executable") table.get(kind==="tmux"?145:147).exe=exe("kitty")
    if (bad==="recycled-shell") table.get(92).start="999"
    if (bad==="nested-server") {
      table.get(process.pid).ppid=149
      table.get(149).ppid=145
    }
    real.writeFileSync(receiptPath,JSON.stringify({schemaVersion:1,runId:launch,profile:"default",target:muxTarget,
      display:{name:":22",number:22,displayFdPath:exe("display"),xvfbPid:419422},
      terminal:{pid:76,collectorPid:process.pid,windowId:"42",windowPid:76},
      selection:{helperPid:419423,helperExecutable:{path:exe("xclip"),sha256:hash("xclip-bytes")},baselinePath:exe("baseline"),baselineSha256:hash(baseline),initialReadSha256:hash(baseline)},
      config:"--config NONE",permissions:"clipboard: read=ask,write=allow; OSC52: write=run,read=not-run"}),{mode:0o600})
  }
  const factory=()=>createLinuxClipboardAdapter(receiptPath,launch,{path:exe("kitty"),sha256:hash("kitty-bytes")},capture,24)
  for(const kind of ["tmux","screen"]) {
    initialize(kind,"valid")
    const adapter=await factory()
    assert(adapter.muxAttachmentProof,kind+" attachment snapshot missing")
    assert.equal(adapter.muxAttachmentProof.captureRunId,capture)
    assert.equal(adapter.muxAttachmentProof.collector.ttyRdev,34817)
    assert.equal(adapter.muxAttachmentProof.attachedClient.ttyRdev,34816)
    assert.equal(adapter.muxAttachmentProof.receiptSha256,hash(real.readFileSync(receiptPath)))
    if (kind === "tmux") {
      assert.deepEqual(await adapter.getScrollback(),{totalLines:44,screenLines:24,viewportOffset:17})
      variant="scrollback-bottom"
      assert.deepEqual(await adapter.getScrollback(),{totalLines:44,screenLines:24,viewportOffset:20})
      variant="scrollback-empty-mode"
      await assert.rejects(()=>adapter.getScrollback(),/copy mode reports no scroll position/)
      variant="scrollback-malformed"
      await assert.rejects(()=>adapter.getScrollback(),/scrollback.*malformed/i)
      variant="scrollback-failed"
      await assert.rejects(()=>adapter.getScrollback(),/tmux history command failed/)
      variant="valid"
    } else {
      assert.equal(typeof adapter.getScrollback,"function","owned Screen history reader must be reachable")
      assert.deepEqual(await adapter.getScrollback(),{totalLines:44,screenLines:24,capacity:100})
      variant="screen-more"
      assert.deepEqual(await adapter.getScrollback(),{totalLines:45,screenLines:24,capacity:100})
      for(const path of hardcopies)assert(real.existsSync(path),"hardcopy evidence must remain retained")
      variant="screen-refused"
      await assert.rejects(()=>adapter.getScrollback(),{message:'screen hardcopy exited 2 at SCREENDIR='+JSON.stringify(root)+': stderr="screen fixture refusal" stdout=""'})
      variant="detached"
      const before=hardcopies.length
      await assert.rejects(()=>adapter.getScrollback(),/attached|display/i)
      assert.equal(hardcopies.length,before,"ownership refusal must precede the Screen command")
      variant="screen-owner-lost"
      await assert.rejects(()=>adapter.getScrollback(),/attached|display/i)
      variant="valid"
    }
    // The batch's verifier must own every existing transaction check, not only its outer boundary.
    for (const [site, failAt] of [["start",1],["read",2],["write",3]]) {
      let tests=0, callbacks=0
      const refusal=new Error("transaction custody lost at "+site)
      const verify=async()=>{
        if (++tests >= failAt) throw refusal
        await adapter.assertOwned()
      }
      await assert.rejects(adapter.withClipboardFixture(async fixture=>{
        callbacks++
        await fixture.writeText("must remain unowned")
        return {pass:true}
      },()=>{},verify),new RegExp("transaction custody lost at "+site))
      assert.equal(callbacks,site==="write"?1:0)
      assert.equal(tests,failAt+1,"restoration must use the same refused verifier")
    }
    // The same grant must notice detach before the next clipboard operation.
    variant="detached"
    const previousReads=reads
    await assert.rejects(adapter.withClipboardFixture(async()=>{throw Error("unowned callback ran")},()=>{},adapter.assertOwned),/attached|display/i)
    assert.equal(reads,previousReads)
    await adapter.dispose()
    const refusals = {
      detached: kind === "tmux" ? /exactly one attached client; found 0/ : /exactly one attached display/,
      "wrong-client-tty": kind === "tmux" ? /attached client tty or shell parent differs/ : /attached client executable or tty differs/,
      "outer-collector-tty": /collector tty must be a distinct inner PTY/,
      "undeclared-executable": /ancestry contains an undeclared executable or no mux/,
      "foreign-socket": kind === "tmux" ? /client reports a foreign socket, session or tty/ : /socket is absent or ambiguous in kernel table/,
      "second-client": kind === "tmux" ? /exactly one attached client; found 2/ : /exactly one attached display/,
      "recycled-shell": /outer shell PID\/start ticks differ/,
      ...(kind === "tmux" ? {"nested-server": /nearest tmux ancestor/} : {}),
    }
    for(const [bad, message] of Object.entries(refusals)) {
      initialize(kind,bad)
      await assert.rejects(factory(),message,kind+" "+bad)
      assert.equal(reads,0,kind+" "+bad+" accessed clipboard before rejecting")
    }
    // Filesystem faults must name the broken custody link and retain the original error.
    for(const [bad, message] of Object.entries({
      "status-io": /process status/,
      "exe-io": /process executable/,
      "config-io": /mux config/,
      "socket-io": /mux socket/,
      ...(kind === "screen" ? {"fd-directory-io": /Screen server fd directory/, "fd-link-io": /Screen server fd link/} : {}),
    })) {
      initialize(kind,bad)
      await assert.rejects(factory(),error=>{
        assert.match(error.message,message)
        assert.equal(error.cause,fsFault)
        return true
      })
      assert.equal(reads,0)
    }
    // Loss inside the callback must refuse both a requested write and finally restoration.
    for(const operation of ["write","restore"]) {
      initialize(kind,"valid")
      const revoked=await factory(), events=[]
      const beforeSpawns=spawns
      let afterLossReads
      await assert.rejects(revoked.withClipboardFixture(async fixture=>{
        variant="detached";afterLossReads=reads
        if(operation === "write") await fixture.writeText("unowned mutation")
        return {pass:true}
      },event=>events.push(event),revoked.assertOwned),/Owned clipboard restoration failed:.*(?:attached client|attached display)/)
      assert.equal(reads,afterLossReads)
      assert.equal(spawns,beforeSpawns)
      assert(events.some(event=>event.kind === "clipboard-restore" && event.status === "error"))
      assert.equal(events.some(event=>event.kind === "clipboard-write" && event.status === "error"),operation === "write")
      await revoked.dispose()
    }
    initialize(kind,"valid")
    const changedChain=await factory()
    table.get(kind === "tmux" ? 145 : 147).start="999"
    const beforeChainRead=reads
    await assert.rejects(changedChain.assertOwned(), /process chain changed since grant/)
    assert.equal(reads,beforeChainRead)
    await changedChain.dispose()
    if (kind === "tmux") {
      // A private socket with one valid client can still belong to a second server outside this collector's chain.
      initialize(kind,"foreign-server")
      await assert.rejects(factory(), /tmux socket server differs from the collector's nearest tmux ancestor/)
      assert.equal(reads,0,"foreign server accessed clipboard before rejecting")
      initialize(kind,"valid")
      const changedClient=await factory()
      variant="client-changed"
      const beforeClientRead=reads
      await assert.rejects(changedClient.assertOwned(), /attached client PID\/start ticks differ/)
      assert.equal(reads,beforeClientRead)
      await changedClient.dispose()
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

/** This child tests real Linux fds; Vitest workers replace stdin even when Vitest itself has a PTY. */
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
// The existing PTY owner fixture exercises the collector callback, unlike the direct CLI-reader tests.
let kittyRefused = false, kittyReads = 0
let weztermRefused = false, weztermReads = 0
let xpropReads = 0, iconFault = null, failIconCleanup = false
let nativeTitle = "native original title"
let iconProperties = {
  WM_ICON_NAME: { type: "STRING", bytes: [108, 101, 103, 97, 99, 121] },
  _NET_WM_ICON_NAME: { type: "UTF8_STRING", bytes: [] },
}
const spawnSyncBeforeMock = realChildProcess.spawnSync
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
    config: "--config NONE", permissions: "clipboard: read=ask,write=allow; OSC52: write=run,read=not-run",
  }), { mode: 0o600 })
  process.env.TERMINFO_CAPTURE_DIRECTORY = join(dir, "artifacts")
  process.env.DISPLAY = ":22"
  process.env.TERMINFO_CLIPBOARD_PROFILE = "default"
  process.env.TERMINFO_TARGET_ID = "kitty"
  process.env.KITTY_LISTEN_ON = "unix:" + join(dir, "kitty.sock")
  process.env.KITTY_WINDOW_ID = "42"
  process.env.WEZTERM_UNIX_SOCKET = "/foreign/wezterm.sock"
  process.env.WEZTERM_PANE = "999"
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
    spawnSync(file, args, options) {
      if (file === join(dir, "wezterm")) {
        weztermReads++
        assert.deepEqual(args, ["cli", "--no-auto-start", "get-text", "--pane-id", "17", "--start-line", "-2147483648", "--end-line", "23"])
        assert.equal(options.env.WEZTERM_UNIX_SOCKET, process.env.WEZTERM_UNIX_SOCKET)
        assert.equal(options.env.WEZTERM_PANE, "17")
        if (weztermRefused) return { status: 2, stdout: Buffer.from("partial"), stderr: Buffer.from("owned WezTerm fixture refusal") }
        return { status: 0, stdout: Buffer.from("old\n\n" + "row\n".repeat(24) + "\n"), stderr: Buffer.alloc(0) }
      }
      if (file !== join(dir, "kitten")) return spawnSyncBeforeMock(file, args, options)
      kittyReads++
      assert.equal(args[2], process.env.KITTY_LISTEN_ON)
      assert.equal(args.at(-1), "id:42")
      if (kittyRefused) return { status: 2, stdout: Buffer.alloc(0), stderr: Buffer.from("owned Kitty fixture refusal") }
      const count = args[args.indexOf("--extent") + 1] === "all" ? 44 : 24
      return { status: 0, stdout: Buffer.from("row\r\n".repeat(count)), stderr: Buffer.alloc(0) }
    },
    execFile(_file, args, _options, callback) {
      if (_file === "xprop") {
        xpropReads++
        const name = args.at(-1)
        assert.deepEqual(args, ["-id", "42", "-f", name, "8c", name])
        const property = iconProperties[name]
        const output = name === "_NET_WM_ICON_NAME" && iconFault !== null ? iconFault :
          property ? name + "(" + property.type + ") = " + property.bytes.join(", ") + "\n" : name + ":  not found.\n"
        callback(null, output)
        return {}
      }
      if (args[0] === "getwindowname") {callback(null, nativeTitle + "\n");return {}}
      callback(null, args[0] === "getwindowpid" ? String(process.pid) : baseline)
      return {}
    },
  }))
  const base = pathToFileURL(root + "/").href
  // The real mux attachment is tested above; this adapter boundary checks owner dispatch, not mux qualification.
  const clipboardModule = await import(base + "linux-clipboard.ts")
  const createClipboardAdapter = clipboardModule.createLinuxClipboardAdapter
  let forwardMuxHistory = false
  mock.module(base + "linux-clipboard.ts", () => ({ ...clipboardModule,
    async createLinuxClipboardAdapter(...args) {
      const adapter = await createClipboardAdapter(...args)
      if (!forwardMuxHistory) return adapter
      return { ...adapter, muxAttachmentProof: { mux: "tmux" },
        getScrollback: async () => ({ totalLines: 55, screenLines: 24, viewportOffset: 17 }) }
    },
  }))
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
    const writeIcon = bytes => {
      const m = /^\x1b\](1|2);([^\x07]*)\x07$/.exec(bytes)
      assert(m, "fixture cleanup must use only recorded OSC1/OSC2")
      if (failIconCleanup) return
      if (m[1] === "2") nativeTitle = m[2]
      else iconProperties._NET_WM_ICON_NAME = {type:"UTF8_STRING",bytes:[...Buffer.from(m[2],"utf8")]}
    }
    const originalTitle = nativeTitle
    const transaction = await adapter.clipboard.withIconNameFixture(writeIcon, async read => {
      assert.equal(await read(), "", "present empty UTF8 must win over the legacy label")
      nativeTitle = "mutated title"
      iconProperties._NET_WM_ICON_NAME.bytes = [120]
      return {status:"unavailable",reason:"transaction boundary fixture"}
    })
    assert.equal(transaction.status,"unavailable")
    assert.equal(nativeTitle,originalTitle)
    assert.deepEqual(iconProperties._NET_WM_ICON_NAME.bytes,[])
    assert.equal(transaction.detail.iconFixture.cleanup.propertiesExact,true)
    for (const bad of [
      '_NET_WM_ICON_NAME(UTF8_STRING) = "quoted"\n',
      '_NET_WM_ICON_NAME(UTF8_STRING) = 256\n',
      '_NET_WM_ICON_NAME(UTF8_STRING) = 255\n',
      '_NET_WM_ICON_NAME(COMPOUND_TEXT) = 97\n',
      '_NET_WM_ICON_NAME(UTF8_STRING) = 97\nforged extra line\n',
    ]) {
      iconFault=bad
      let ran=false
      const reading=await adapter.clipboard.withIconNameFixture(()=>{throw Error("stimulus before valid setup")},async()=>{ran=true;return {status:"unavailable",reason:"must not run"}})
      assert.equal(reading.status,"unavailable")
      assert.equal(ran,false,"malformed property must stop before stimulus")
    }
    iconFault=null
    delete iconProperties._NET_WM_ICON_NAME
    iconProperties.WM_ICON_NAME={type:"STRING",bytes:[233]}
    const legacy=await adapter.clipboard.withIconNameFixture(writeIcon,async read=>{
      assert.equal(await read(),"é","legacy STRING is latin-1, not UTF8")
      return {status:"unavailable",reason:"legacy fixture"}
    })
    assert.equal(legacy.status,"unavailable")
    assert.equal(legacy.detail.iconFixture.cleanup.propertiesExact,false,"OSC can create the formerly absent modern property")
    assert.match(legacy.detail.iconFixture.cleanup.note,/OSC-only/)
    delete iconProperties._NET_WM_ICON_NAME
    for(const missing of [null,{type:"COMPOUND_TEXT",bytes:[97]}]) {
      if(missing)iconProperties.WM_ICON_NAME=missing;else delete iconProperties.WM_ICON_NAME
      let ran=false
      const reading=await adapter.clipboard.withIconNameFixture(()=>{throw Error("missing icon wrote stimulus")},async()=>{ran=true;return {status:"unavailable",reason:"must not run"}})
      assert.equal(reading.status,"unavailable");assert.equal(ran,false)
    }
    iconProperties={WM_ICON_NAME:{type:"STRING",bytes:[97]},_NET_WM_ICON_NAME:{type:"UTF8_STRING",bytes:[98]}}
    const beforeForeign=xpropReads
    const revokedIcon=await adapter.clipboard.withIconNameFixture(writeIcon,async()=>{throw Error("foreign callback")},async()=>{throw Error("fixture owner revoked")})
    assert.equal(revokedIcon.status,"unavailable")
    assert.equal(xpropReads,beforeForeign,"owner check must precede every property read")
    const brokenCleanup=await adapter.clipboard.withIconNameFixture(writeIcon,async()=>{
      iconProperties._NET_WM_ICON_NAME.bytes=[99];failIconCleanup=true
      return {status:"unavailable",reason:"cleanup fixture"}
    })
    assert.equal(brokenCleanup.status,"invalid")
    assert.match(brokenCleanup.reason,/cleanup failed/)
    failIconCleanup=false
    assert.equal(typeof adapter.getScrollback, "function", "owned Linux Kitty history callback is missing")
    const history = await adapter.getScrollback()
    assert.deepEqual(history, { totalLines: 44, screenLines: 24 })
    assert.equal("viewportOffset" in history, false)
    kittyRefused = true
    await assert.rejects(adapter.getScrollback(), /Kitty all get-text unavailable: .*"status":2/)
    kittyRefused = false
    const liveAssert = adapter.clipboard.assertOwned
    const lostOwner = new Error("owned Kitty attachment lost")
    for (const boundary of [1, 2]) {
      let checks = 0
      const readsBefore = kittyReads
      adapter.clipboard.assertOwned = async () => {
        if (++checks === boundary) throw lostOwner
        await liveAssert()
      }
      await assert.rejects(adapter.getScrollback(), error => error === lostOwner)
      assert.equal(kittyReads - readsBefore, boundary === 1 ? 0 : 2)
    }
    adapter.clipboard.assertOwned = liveAssert
    const readsBefore = kittyReads
    forwardMuxHistory = true
    const muxOwner = await factory(process.stdout, "e".repeat(32))
    assert.deepEqual(await muxOwner.getScrollback(), { totalLines: 55, screenLines: 24, viewportOffset: 17 })
    await muxOwner.dispose()
    forwardMuxHistory = false
    process.env.TERMINFO_TARGET_ID = "xterm"
    const otherApp = await factory(process.stdout, "f".repeat(32))
    assert.equal(otherApp.getScrollback, undefined, "foreign Kitty child variables cannot select the App reader")
    await otherApp.dispose()
    process.env.TERMINFO_TARGET_ID = "kitty"
    assert.equal(kittyReads, readsBefore, "a mux or other App must never query the outer Kitty")
    // Reader-only tests miss registration: this real owner fixture must reach the WezTerm callback
    // despite foreign KITTY_* variables and preserve physical blank history rows without an offset.
    process.env.TERMINFO_TARGET_ID = "wezterm"
    process.env.WEZTERM_UNIX_SOCKET = join(dir, "wezterm.sock")
    process.env.WEZTERM_PANE = "17"
    const weztermOwner = await factory(process.stdout, "1".repeat(32))
    assert.equal(typeof weztermOwner.getScrollback, "function", "owned Linux WezTerm history callback is missing")
    assert.deepEqual(await weztermOwner.getScrollback(), { totalLines: 27, screenLines: 24 })
    assert.equal(kittyReads, readsBefore, "owned WezTerm must not query foreign Kitty")
    weztermRefused = true
    await assert.rejects(weztermOwner.getScrollback(), error =>
      /WezTerm owned get-text unavailable/.test(error.message) &&
      error.message.includes(Buffer.from("partial").toString("base64")) &&
      error.message.includes(Buffer.from("owned WezTerm fixture refusal").toString("base64")))
    weztermRefused = false
    const weztermAssert = weztermOwner.clipboard.assertOwned
    for (const boundary of [1, 2]) {
      let checks = 0
      const before = weztermReads
      weztermOwner.clipboard.assertOwned = async () => {
        if (++checks === boundary) throw lostOwner
        await weztermAssert()
      }
      await assert.rejects(weztermOwner.getScrollback(), error => error === lostOwner)
      assert.equal(weztermReads - before, boundary === 1 ? 0 : 1)
    }
    weztermOwner.clipboard.assertOwned = weztermAssert
    await weztermOwner.dispose()
    process.env.TERMINFO_TARGET_ID = "kitty"
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
    // Temporary loss must also reject after recovery, including a probe that catches the error.
    // The permanent cases and counters still detect a final-check-only placebo.
    const { ALL_PROBES: definitions } = await import("@terminfo/probe-defs")
    const definition = definitions.find(probe => probe.id === "reset.ris")
    const originalCallback = definition.term
    const originalAssert = adapter.clipboard.assertOwned
    const originalWrite = process.stdout.write
    const refusal = new Error("fixture attachment continuity lost")
    const failures = []
    let revoked = false, touched = 0, restoreOnRefusal = false
    adapter.clipboard.assertOwned = async () => {
      if (revoked) {
        if (restoreOnRefusal) revoked = false
        throw refusal
      }
      await originalAssert()
    }
    process.stdout.write = function (chunk, ...args) {
      if (chunk === "\x1b[6n") touched++
      return originalWrite.call(this, chunk, ...args)
    }
    try {
      for (const temporary of [false, true]) for (const boundary of ["callback", "query", "capture", "input", "final"]) {
        if (temporary && boundary === "final") continue
        restoreOnRefusal = temporary
        revoked = boundary === "callback"; touched = 0
        let callbacks = 0
        definition.term = async context => {
          callbacks++
          revoked = true
          try {
            if (boundary === "query") await context.query("\x1b[6n", /\x1b\[(\d+);(\d+)R/, 100)
            if (boundary === "capture") await context.capture({role:"control",label:"custody"})
            if (boundary === "input") await context.input.injectKey("a")
          } catch (error) {
            if (!temporary) throw error
            assert.equal(error, refusal)
          }
          return {observation:{outcome:"supported",assertionType:"query_reply"}}
        }
        try {
          await assert.rejects(withRawMode(() => runProbeBatch({ids:["reset.ris"], captureRunId:capture,
            ownedTerminal:adapter,out:process.stdout,
            capture:async()=>{touched++;throw Error("unowned capture ran")},
            input:{injectKey:async()=>{touched++},injectClick:async()=>{touched++}},
          })), error=>error===refusal, boundary+" must name the custody failure")
          assert.equal(touched,0,boundary+" crossed the refused boundary")
          if (boundary === "callback") assert.equal(callbacks,0,"revoked callback ran")
        } catch(error) { failures.push((temporary ? "temporary " : "permanent ")+boundary+": "+error.message) }
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
    assert.equal(reset.assertionType, "query_reply")
    assert.deepEqual(JSON.parse(owned.rawReplies["reset.ris.callbackResponse"]), {
      before: { row: 5, col: 5 }, after: { row: 1, col: 1 }
    })
    assert.deepEqual(JSON.parse(owned.rawReplies["reset.ris"]).queries.map(query => query.raw),
      ["\x1b[5;5R", "\x1b[1;1R"])
    assert.equal(owned.observations.find((item) => item.featureId === "extensions.osc52-write"), undefined)
    assert.equal(owned.results.find(item => item.featureId === "extensions.osc52-write").status, "probe-todo")
    assert.equal(owned.results.find(item => item.featureId === "extensions.osc52-write").reason, "No owned clipboard fixture for this probe (under the default clipboard profile, Linux app runs attach one only to OSC 52 write because clipboard read blocks on ask-first confirmation prompts); OSC 52 was not sent")
    assert.deepEqual(JSON.parse(owned.rawReplies["extensions.osc52-write"]).writes, [])
    for (const [run, out] of [["c".repeat(32), process.stdout], [capture, foreign], [capture, fake]]) {
      const refused = await runProbeBatch({ ids: ["reset.ris"], captureRunId: run, ownedTerminal: adapter, out })
      assert.deepEqual(refused.observations, [])
      assert.equal(refused.results.find(item => item.featureId === "reset.ris").status, "probe-todo")
      assert.match(refused.results.find(item => item.featureId === "reset.ris").reason, /Required grant missing/)
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
    await assert.rejects(adapter.getScrollback(), /no live bound capture/)
    await assert.rejects(adapter.readGeometry(), /no live bound capture/)
    assert.equal(verifier.ownedTerminalVerifiedFor(adapter, capture, process.stdout), false)
    const disposed = await runProbeBatch({ ids: ["reset.ris"], captureRunId: capture,
      ownedTerminal: adapter, out: process.stdout })
    assert.deepEqual(disposed.observations, [])
    assert.equal(disposed.results.find(item => item.featureId === "reset.ris").status, "probe-todo")
    assert.match(disposed.results.find(item => item.featureId === "reset.ris").reason, /Required grant missing/)
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
              tests: [{ id: "criterion", status: "probe-todo", reason: "insufficient-evidence" }],
            }),
            (event) => events.push(event),
            async () => {},
          ),
        ).rejects.toThrow("cannot nest")
        throw new Error("query failed")
      },
      (event) => events.push(event),
      async () => {},
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
    readText: async () => "baseline-nonce",
    writeText: async () => {
      throw new Error("xclip exited")
    },
  })
  await expect(
    transaction(
      async () => ({ pass: true, observation: { outcome: "supported", assertionType: "query_reply" } }),
      () => {},
      async () => {},
    ),
  ).rejects.toThrow("Owned clipboard restoration failed: xclip exited")
})
