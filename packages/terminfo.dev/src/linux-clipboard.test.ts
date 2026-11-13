/**
 * @failure A foreign or incomplete receipt authorizes OSC 52, or a failed callback leaves a disposable selection mutated.
 * @level l1
 * @consumer Owned Linux clipboard adapter used by the app probe batch.
 * @testonly none
 * @reach fs-walk <fixture-only: /tmp/terminfo-clipboard-receipts>
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ProbeCallbackResult } from "@terminfo/probe-defs"
import { afterEach, expect, test } from "vitest"
import {
  createClipboardOwnership,
  createClipboardTransaction,
  createLinuxClipboardAdapter,
  pressRealKey,
  type ClipboardTraceEvent,
} from "./linux-clipboard.ts"

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
const screenSpawns = []
const hash = x => createHash("sha256").update(x).digest("hex")
const launch = "a".repeat(32), capture = "b".repeat(32)
const baseline = "terminfo-owned-clipboard-" + launch
const primaryBaseline = "terminfo-owned-primary-" + launch
const bootId = "730f0ec0-707d-47f4-bf82-1a1e28ec4f10"
const receiptPath = join(root, "clipboard-fixture.json")
const exe = name => join(root, name)
const screenConfig = "defscrollback 100\n"
for (const [name, bytes] of Object.entries({kitty:"kitty-bytes",tmux:"tmux-bytes",screen:"screen-bytes",xclip:"xclip-bytes",config:screenConfig,baseline,primary:primaryBaseline,display:"22"})) {
  fs.writeFileSync(exe(name), bytes, {mode:0o600})
}
const real = {...fs}
const fsFault = new Error("fixture filesystem link unavailable")
let spawns=0
const servers={}
let mux, variant, table, socket, muxTarget, reads = 0
let baselineValue = baseline, primaryValue = primaryBaseline, tmuxBuffers = [], tmuxSetClipboard = "external", tmuxDeleteCalls = []
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
    assert.equal(options.env.SCREENDIR,root)
    screenSpawns.push({file,session:args[1],screenDir:options.env.SCREENDIR,args:[...args]})
    if (args[2] === "-X" && args[3] === "scrollback") {
      assert.equal(args[0],"-S")
      assert.equal(args[1],muxTarget.session)
      assert(args[4] === "0" || args[4] === "100")
      if(variant==="screen-refused")return {status:2,stdout:Buffer.alloc(0),stderr:Buffer.from("screen fixture refusal")}
      if(variant==="screen-refused-restore" && args[4]==="100")return {status:2,stdout:Buffer.alloc(0),stderr:Buffer.from("screen restore refusal")}
      if(variant==="screen-owner-lost" && args[4]==="100")variant="detached"
      return {status:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}
    }
    if (args[2] === "-Q") {
      assert.deepEqual(args,["-S",muxTarget.session,"-Q","number"])
      return {status:0,stdout:Buffer.from("0 (bash)\n"),stderr:Buffer.alloc(0)}
    }
    assert.deepEqual(args.slice(0,5),["-S",muxTarget.session,"-X","hardcopy","-h"])
    const path=args[5]
    assert.equal(path.slice(0,path.lastIndexOf("/")),join(root,"artifacts"))
    assert(path.includes(muxTarget.session))
    assert(!hardcopies.includes(path),"each Screen read needs its own retained hardcopy")
    hardcopies.push(path)
    if(variant==="screen-refused")return {status:2,stdout:Buffer.alloc(0),stderr:Buffer.from("screen fixture refusal")}
    const used = variant === "screen-more" ? 21 : 20
    real.writeFileSync(path, "row\n".repeat(used + 24))
    if(variant==="screen-owner-lost")variant="detached"
    return {status:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}
  },
  spawn(file,args){
    if(file===exe("xclip") && Array.isArray(args) && args.includes("-i")){
      // Like a real foreground xclip -i (33003, measured by @dev/luna3): it serves until the next writer of its
      // selection displaces it (exit 0) or it is killed (SIGTERM).
      const exits=[]
      const primary=args.includes("primary")
      const key=primary?"primary":"clipboard"
      const child={pid:500001+spawns++,exitCode:null,signalCode:null,
        stdin:{once(){},end(text){if(primary)primaryValue=text;else baselineValue=text;const before=servers[key];servers[key]=child;if(before&&before!==child)queueMicrotask(()=>before.end(0,null))}},
        once(ev,cb){if(ev==="exit")exits.push(cb)},
        kill(){queueMicrotask(()=>child.end(null,"SIGTERM"))},
        end(code,signal){if(child.exitCode!==null||child.signalCode!==null)return;child.exitCode=code;child.signalCode=signal;for(const cb of exits.splice(0))cb(code,signal)}}
      return child
    }
    spawns++;throw new Error("unowned clipboard writer spawned")
  },
  execFile(file,args,options,callback) {
    if (file === "xdotool") callback(null,"76\n")
    else if (file === exe("tmux")) {
      if(args.includes("display-message")) {
        assert.deepEqual(args,["-S",socket,"display-message","-p","-t",muxTarget.session,"#{history_size} #{pane_height} #{scroll_position} #{pane_in_mode}"])
        if(variant==="scrollback-failed")callback(new Error("tmux history command failed"),"")
        else callback(null,variant==="scrollback-malformed"?"not counts\n":variant==="scrollback-bottom"?"20 24  0\n":variant==="scrollback-empty-mode"?"20 24  1\n":"20 24 3 1\n")
        return {}
      }
      if(args.includes("show-options")) {
        assert.deepEqual(args,["-S",socket,"show-options","-s","-v","set-clipboard"])
        callback(null,tmuxSetClipboard+"\n")
        return {}
      }
      if(args.includes("list-buffers")) {
        assert.deepEqual(args,["-S",socket,"list-buffers","-F","#{buffer_name}"])
        callback(null,tmuxBuffers.length?tmuxBuffers.join("\n")+"\n":"")
        return {}
      }
      if(args.includes("delete-buffer")) {
        assert.deepEqual(args.slice(0,4),["-S",socket,"delete-buffer","-b"])
        tmuxDeleteCalls.push(args[4])
        if(variant!=="tmux-buffer-restore-stuck") tmuxBuffers=tmuxBuffers.filter(name=>name!==args[4])
        callback(null,"")
        return {}
      }
      const server = args.at(-1).includes("#{pid}") ? (variant === "foreign-server" ? "149" : "145") + "\t" : ""
      if (variant === "detached") callback(null,"")
      else callback(null, server + (variant === "client-changed" ? "150" : "148") + "\t/dev/pts/0\tterminfo-" + launch + "\t" + (variant === "foreign-socket" ? socket + "-foreign" : socket) + "\n" + (variant === "second-client" ? server+"150\t/dev/pts/2\tterminfo-"+launch+"\t"+socket+"\n" : ""))
    } else {reads++;callback(null,args.includes("primary")?primaryValue:baselineValue)}
    return {}
  },
}))
process.env.TERMINFO_CAPTURE_DIRECTORY=join(root,"artifacts")
process.env.DISPLAY=":22"
process.env.TERMINFO_CLIPBOARD_PROFILE="default"
try {
  const {createLinuxClipboardAdapter}=await import(pathToFileURL(process.env.TERMINFO_TEST_SOURCE_ROOT+"/linux-clipboard.ts").href)
    const initialize = (kind, bad, withPrimary) => {
      mux=kind;variant=bad;reads=0;baselineValue=baseline;primaryValue=primaryBaseline;tmuxBuffers=[];tmuxSetClipboard="external";tmuxDeleteCalls=[]
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
      [419422,p(1,"80",0,"/usr/bin/Xvfb")],[419423,p(1,"90",0,exe("xclip"))],[419424,p(1,"91",0,exe("xclip"))]
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
      selection:{helperPid:419423,helperExecutable:{path:exe("xclip"),sha256:hash("xclip-bytes")},baselinePath:exe("baseline"),baselineSha256:hash(baseline),initialReadSha256:hash(baseline),
        ...(withPrimary&&{primary:{helperPid:419424,baselinePath:exe("primary"),baselineSha256:hash(primaryBaseline),initialReadSha256:hash(primaryBaseline)}})},
      config:"--config NONE",permissions:"clipboard: read=ask,write=allow; OSC52: write=run,read=not-run"}),{mode:0o600})
  }
  const factory=()=>createLinuxClipboardAdapter(receiptPath,launch,{path:exe("kitty"),sha256:hash("kitty-bytes")},capture,24)
  // #32164: an xterm paste route reads X11 PRIMARY. Its own baseline is owned, written, restored and verified on
  // PRIMARY alone, and CLIPBOARD stays untouched; a receipt without it exposes no PRIMARY transaction at all.
  initialize("tmux","valid",true)
  const primaryAdapter=await factory()
  assert.equal(typeof primaryAdapter.withPrimaryFixture,"function","a PRIMARY receipt must expose its transaction")
  let seen
  await primaryAdapter.withPrimaryFixture(async fixture=>{
    seen=await fixture.readText()
    await fixture.writeText("pasted nonce")
    assert.equal(primaryValue,"pasted nonce","the write must land on PRIMARY")
    assert.equal(baselineValue,baseline,"a PRIMARY write must leave CLIPBOARD untouched")
    return {pass:true}
  },()=>{},primaryAdapter.assertOwned)
  assert.equal(seen,primaryBaseline,"the read must come from PRIMARY")
  assert.equal(primaryValue,primaryBaseline,"PRIMARY must be restored to its own baseline")
  await primaryAdapter.dispose()
  initialize("tmux","valid",false)
  const clipboardOnly=await factory()
  assert.equal(clipboardOnly.withPrimaryFixture,undefined,"no PRIMARY receipt means no PRIMARY transaction")
  await clipboardOnly.dispose()
  for(const kind of ["tmux","screen"]) {
    initialize(kind,"valid")
    const adapter=await factory()
    assert(adapter.muxAttachmentProof,kind+" attachment snapshot missing")
    assert.equal(adapter.muxAttachmentProof.captureRunId,capture)
    assert.equal(adapter.muxAttachmentProof.collector.ttyRdev,34817)
    assert.equal(adapter.muxAttachmentProof.attachedClient.ttyRdev,34816)
    assert.equal(adapter.muxAttachmentProof.receiptSha256,hash(real.readFileSync(receiptPath)))
    if (kind === "tmux") {
      assert.equal(adapter.resetScrollback,undefined,"tmux must not expose Screen history reset")
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
      tmuxBuffers=["buffer0001"]
      tmuxSetClipboard="external"
      let observedSetClipboard
      await adapter.withClipboardFixture(async fixture=>{
        observedSetClipboard=fixture.tmuxSetClipboard
        tmuxBuffers=["buffer0002","buffer0001"]
        return {pass:true}
      },()=>{},adapter.assertOwned)
      assert.equal(observedSetClipboard,"external","tmux fixture must expose measured server set-clipboard")
      assert.deepEqual(tmuxDeleteCalls,["buffer0002"],"newly added tmux paste buffer must be deleted in finally")
      assert.deepEqual(tmuxBuffers,["buffer0001"],"pre-existing tmux paste buffers must remain intact")
      assert.equal(baselineValue,baseline,"OS clipboard baseline must be restored")
      tmuxDeleteCalls=[]
      await assert.rejects(adapter.withClipboardFixture(async ()=>{
        tmuxBuffers=["buffer0003","buffer0001"]
        throw new Error("callback boom")
      },()=>{},adapter.assertOwned),/callback boom/)
      assert.deepEqual(tmuxDeleteCalls,["buffer0003"],"tmux buffer cleanup must run even when callback throws")
      variant="tmux-buffer-restore-stuck"
      await assert.rejects(adapter.withClipboardFixture(async ()=>{
        tmuxBuffers=["buffer0004","buffer0001"]
        return {pass:true}
      },()=>{},adapter.assertOwned),/Owned clipboard restoration failed:.*tmux paste buffer/)
      variant="valid"
      tmuxBuffers=[]
      tmuxDeleteCalls=[]
    } else {
      assert.equal(typeof adapter.getScrollback,"function","owned Screen history reader must be reachable")
      assert.equal(typeof adapter.resetScrollback,"function","owned Screen history reset must be reachable")
      screenSpawns.length=0
      assert.deepEqual(await adapter.resetScrollback(),{status:"reset",capacity:100})
      assert.deepEqual(await adapter.getScrollback(),{totalLines:44,screenLines:24,capacity:100})
      assert.deepEqual(screenSpawns.slice(0,2).map(s=>s.args),[
        ["-S",muxTarget.session,"-X","scrollback","0"],
        ["-S",muxTarget.session,"-X","scrollback","100"],
      ])
      // @cto c901817a: reset and read must spawn with the exact same executable, session, and SCREENDIR.
      const [resetZero, resetRestore, readHardcopy, readQuery] = screenSpawns
      assert.deepEqual(
        [resetZero.file, resetZero.session, resetZero.screenDir],
        [readHardcopy.file, readHardcopy.session, readHardcopy.screenDir],
      )
      assert.deepEqual(
        [resetRestore.file, resetRestore.session, resetRestore.screenDir],
        [readQuery.file, readQuery.session, readQuery.screenDir],
      )
      variant="screen-more"
      assert.deepEqual(await adapter.getScrollback(),{totalLines:45,screenLines:24,capacity:100})
      for(const path of hardcopies)assert(real.existsSync(path),"hardcopy evidence must remain retained")
      variant="screen-refused"
      await assert.rejects(()=>adapter.getScrollback(),{message:'screen hardcopy exited 2 at SCREENDIR='+JSON.stringify(root)+': stderr="screen fixture refusal" stdout=""'})
      await assert.rejects(()=>adapter.resetScrollback(),{message:'screen scrollback 0 exited 2 at SCREENDIR='+JSON.stringify(root)+': stderr="screen fixture refusal" stdout=""'})
      variant="screen-refused-restore"
      await assert.rejects(()=>adapter.resetScrollback(),{message:'screen scrollback 100 exited 2 at SCREENDIR='+JSON.stringify(root)+': stderr="screen restore refusal" stdout=""'})
      variant="detached"
      const before=hardcopies.length
      const spawnsBefore=screenSpawns.length
      await assert.rejects(()=>adapter.getScrollback(),/attached|display/i)
      await assert.rejects(()=>adapter.resetScrollback(),/attached|display/i)
      assert.equal(hardcopies.length,before,"ownership refusal must precede the Screen command")
      assert.equal(screenSpawns.length,spawnsBefore,"ownership refusal must precede Screen reset")
      variant="screen-owner-lost"
      await assert.rejects(()=>adapter.getScrollback(),/attached|display/i)
      variant="screen-owner-lost"
      await assert.rejects(()=>adapter.resetScrollback(),/attached|display/i)
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
    env: { ...process.env, TERMINFO_TEST_SOURCE_ROOT: sourceRoot, TERMINFO_TARGET_ID: "kitty" },
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
test.runIf(process.platform === "linux")(
  "owned Linux output proof uses a real controlling PTY",
  () => {
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
let cwdActive = false, cwd = "file:///Users/private-person/secret-project", cwdText = ""
let cwdLost = false, loseCwdOwnerAfterWrite = false, cwdWrites = 0
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
  realFs.writeFileSync(join(dir, "wezterm"), "owned-wezterm-cli", { mode: 0o600 })
  realFs.mkdirSync(join(dir, "artifacts"))
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
        if (args[0] === "--version") return { status: 0, stdout: "wezterm 0-unstable-2026-10-10", stderr: "" }
        weztermReads++
        if (cwdActive) {
          assert.equal(options.env.WEZTERM_UNIX_SOCKET, process.env.WEZTERM_UNIX_SOCKET)
          if (args.includes("list")) return { status: 0, stdout: JSON.stringify([{ pane_id: 17, cwd }]), stderr: "" }
          assert.ok(args.includes("get-text"))
          return { status: 0, stdout: Buffer.from(cwdText + "\n".repeat(24)), stderr: Buffer.alloc(0) }
        }
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
  let screenResetCount = 0
  mock.module(base + "linux-clipboard.ts", () => ({ ...clipboardModule,
    async createLinuxClipboardAdapter(...args) {
      const adapter = await createClipboardAdapter(...args)
      if (!forwardMuxHistory) return adapter
      if (forwardMuxHistory === "screen") {
        return { ...adapter, muxAttachmentProof: { mux: "screen" },
          getScrollback: async () => ({ totalLines: 24, screenLines: 24, capacity: 1000 }),
          resetScrollback: async () => { await adapter.assertOwned(); screenResetCount++; return { status: "reset", capacity: 1000 } } }
      }
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
    nativeTitle = "baseline-title"
    let latched = false
    const wezterm = await adapter.clipboard.withIconNameFixture((bytes) => {
      const match = /^\x1b\](0|1|2);([^\x07]*)\x07$/.exec(bytes)
      assert(match, "wezterm cleanup sequence")
      const code = match[1]
      const payload = match[2] ?? ""
      if (code === "1") {
        nativeTitle = payload
        latched = true
        iconProperties._NET_WM_ICON_NAME = { type: "UTF8_STRING", bytes: [...Buffer.from(payload, "utf8")] }
        return
      }
      if (code === "0") {
        nativeTitle = payload
        latched = false
        return
      }
      if (!latched) nativeTitle = payload
    }, async () => {
      nativeTitle = "icon-name-b-latch"
      latched = true
      return { status: "unavailable", reason: "wezterm title latch" }
    })
    assert.equal(wezterm.status, "unavailable")
    assert.equal(nativeTitle, "baseline-title")
    assert.match(wezterm.detail.iconFixture.cleanup.note, /OSC 0 cleared it/)
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
    delete iconProperties.WM_ICON_NAME
    let absentRan = false
    const absent = await adapter.clipboard.withIconNameFixture(writeIcon, async (read) => {
      absentRan = true
      assert.equal(await read(), null, "a missing icon property is an observation")
      return { status: "unavailable", reason: "absent icon is observable" }
    })
    assert.equal(absentRan, true)
    assert.equal(absent.status, "unavailable")
    iconProperties.WM_ICON_NAME = { type: "COMPOUND_TEXT", bytes: [97] }
    let malformedRan = false
    const malformed = await adapter.clipboard.withIconNameFixture(
      () => {
        throw Error("missing icon wrote stimulus")
      },
      async () => {
        malformedRan = true
        return { status: "unavailable", reason: "must not run" }
      },
    )
    assert.equal(malformed.status, "unavailable")
    assert.equal(malformedRan, false)
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
    assert.equal(adapter.resetScrollback, undefined, "App target must not expose Screen history reset")
    const history = await adapter.getScrollback()
    const { receipt, ...counts } = history
    assert.deepEqual(counts, { totalLines: 44, screenLines: 24 })
    assert.equal("viewportOffset" in history, false)
    // The count's identity record names the pane and the socket's presence, and no host path (@cto 41fcd747).
    assert.deepEqual(JSON.parse(receipt ?? "null"), {
      surface: "kitty",
      pane: "42",
      listedTty: null,
      measuredTty: null,
      ttyMatch: null,
      socketPresent: true,
      executable: "kitten",
    })
    assert.equal(/[\\/]/u.test(receipt ?? ""), false)
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
    assert.equal(muxOwner.resetScrollback, undefined, "tmux OwnedTerminal must not expose resetScrollback")
    assert.deepEqual(await muxOwner.getScrollback(), { totalLines: 55, screenLines: 24, viewportOffset: 17 })
    await muxOwner.dispose()
    forwardMuxHistory = "screen"
    const screenMuxOwner = await factory(process.stdout, "2".repeat(32))
    assert.equal(typeof screenMuxOwner.resetScrollback, "function", "Screen OwnedTerminal must expose resetScrollback")
    assert.deepEqual(await screenMuxOwner.resetScrollback(), { status: "reset", capacity: 1000 })
    assert.equal(screenResetCount, 1)
    const { ALL_PROBES: probeDefsForScreen } = await import("@terminfo/probe-defs")
    const risDef = probeDefsForScreen.find(probe => probe.id === "reset.ris")
    const savedRisTerm = risDef.term
    try {
      risDef.term = async context => {
        assert.equal(typeof context.resetScrollback, "function", "runProbeBatch must wire resetScrollback onto TermProbeSource")
        assert.deepEqual(await context.resetScrollback(), { status: "reset", capacity: 1000 })
        return { observation: { outcome: "supported", assertionType: "query_reply" } }
      }
      await withRawMode(() => runProbeBatch({ ids: ["reset.ris"], captureRunId: "2".repeat(32),
        ownedTerminal: screenMuxOwner, out: process.stdout }))
      assert.equal(screenResetCount, 2)
    } finally {
      risDef.term = savedRisTerm
    }
    await screenMuxOwner.dispose()
    await assert.rejects(screenMuxOwner.resetScrollback(), /no live bound capture/)
    forwardMuxHistory = false
    process.env.TERMINFO_TARGET_ID = "xterm"
    const otherApp = await factory(process.stdout, "f".repeat(32))
    assert.equal(otherApp.getScrollback, undefined, "foreign Kitty child variables cannot select the App reader")
    assert.equal(otherApp.resetScrollback, undefined)
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
    assert.equal(weztermOwner.resetScrollback, undefined)
    const { receipt: wezTermReceipt, ...wezTermCounts } = await weztermOwner.getScrollback()
    assert.deepEqual(wezTermCounts, { totalLines: 27, screenLines: 24 })
    // Linux WezTerm lists no pane tty and measures none, so the record says so instead of claiming a match.
    assert.deepEqual(JSON.parse(wezTermReceipt ?? "null"), {
      surface: "wezterm",
      pane: "17",
      listedTty: null,
      measuredTty: null,
      ttyMatch: null,
      socketPresent: true,
      executable: "wezterm",
    })
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
    // The direct history fixture misses CWD's private writer and checks between writes and reads.
    // Keep the real Linux grant and PTY; supply only the native OSC effect and CLI directory/text.
    assert.equal(typeof weztermOwner.readAppSemanticState, "function")
    const cwdInitial = cwd
    const cwdTtyWrite = process.stdout.write
    cwdActive = true
    weztermOwner.clipboard.assertOwned = async () => {
      if (cwdLost) throw new Error("owned Linux WezTerm attachment lost after CWD write")
      await weztermAssert()
    }
    process.stdout.write = function(chunk, ...args) {
      const bytes = String(chunk)
      if (/\x1b\](?:7|77);/.test(bytes)) {
        cwdWrites++
        cwdText = bytes
        const command = /\x1b\]7;([^\x07]*)\x07/.exec(bytes)
        if (command) cwd = command[1]
        if (loseCwdOwnerAfterWrite) cwdLost = true
        return true
      }
      return cwdTtyWrite.call(this, chunk, ...args)
    }
    try {
      const reading = await weztermOwner.readAppSemanticState("extensions.osc7-cwd", () => {
        throw new Error("CWD used the publishable writer")
      })
      assert.equal(reading.status, "measured", JSON.stringify(reading))
      assert.equal(cwd, cwdInitial, "restore must keep the exact initial public URI")
      assert.equal(cwdWrites, 4)
      assert.equal(JSON.stringify(reading).includes("private-person"), false)
      loseCwdOwnerAfterWrite = true
      const before = weztermReads
      await assert.rejects(weztermOwner.readAppSemanticState("extensions.osc7-cwd", () => {
        throw new Error("CWD used the publishable writer")
      }), /restoration failed: the pane's reported directory was left changed/)
      assert.equal(weztermReads - before, 1, "after ownership loss no CLI read may follow the initial list")
      assert.equal(cwdWrites, 5, "after ownership loss no restoration write may reach the pane")
    } finally {
      cwdActive = false
      cwdLost = false
      loseCwdOwnerAfterWrite = false
      process.stdout.write = cwdTtyWrite
      weztermOwner.clipboard.assertOwned = weztermAssert
    }
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
    // #31741: an owned run now carries its own recording pasteboard, so a run that names no subject
    // is refused for the missing binding rather than for a missing fixture. The row is still not sent.
    assert.equal(owned.results.find(item => item.featureId === "extensions.osc52-write").reason, "this run records a clipboard fixture but declares no subject to bind it to")
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
    _, errors = child.communicate(timeout=45)
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
      // A probe that does not return is bounded at 30s, so this child must outlive that wall.
      const result = spawnSync("python3", ["-c", python, mode, process.execPath, "-e", child], {
        cwd: codeRoot,
        encoding: "utf8",
        timeout: 70_000,
        env: { ...process.env, TERMINFO_TEST_SOURCE_ROOT: sourceRoot },
      })
      expect(result.error, `${mode}: ${result.stderr}`).toBeUndefined()
      expect(result.status, `${mode}: ${result.stderr}`).toBe(0)
    }
  },
  90_000,
)

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

// 33003 (@cto 67370e55): the tmux pre-flight refused with "baseline changed" while our helper was gone and the read
// was empty, so the reason could not say which. A dead owner is refused as a dead owner, with its exit, and any stray
// read carries its digest and length.
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

test("the ownership record reports a dead owner once, with its exit, and never a helper we displaced ourselves", async () => {
  const events: ClipboardTraceEvent[] = []
  const trace = (event: ClipboardTraceEvent) => events.push(event)
  const external = new Set([90])
  const ownership = createClipboardOwnership<"clipboard">({ clipboard: 90 }, (pid) => external.has(pid))

  expect(await ownership.state("clipboard", trace)).toEqual({ helperPid: 90, alive: true })
  ownership.spawned(101, "clipboard")
  ownership.acquired("clipboard", 101)
  external.delete(90)
  ownership.spawned(102, "clipboard")
  ownership.acquired("clipboard", 102)
  ownership.exited(101, 0, null)
  expect(await ownership.state("clipboard", trace)).toEqual({ helperPid: 102, alive: true })
  expect(events).toEqual([])

  ownership.exited(102, 0, null)
  const dead = await ownership.state("clipboard", trace)
  expect(dead).toMatchObject({ helperPid: 102, alive: false, exit: { code: 0, signal: null } })
  expect(await ownership.state("clipboard", trace)).toEqual(dead)
  expect(events).toEqual([
    { kind: "clipboard-owner-exit", at: expect.any(String), helperPid: 102, exitCode: 0, signal: null },
  ])

  const gone = createClipboardOwnership<"clipboard">({ clipboard: 90 }, () => false)
  expect(await gone.state("clipboard", trace)).toEqual({ helperPid: 90, alive: false })
  expect(events.at(-1)).toEqual({
    kind: "clipboard-owner-exit",
    at: expect.any(String),
    helperPid: 90,
    exitObserved: false,
  })
})

test("a dead owner is refused before the callback with its exit and the stray read's digest and length", async () => {
  let text = ""
  let ran = false
  const events: ClipboardTraceEvent[] = []
  const transaction = createClipboardTransaction("baseline-nonce", {
    readText: async (trace, kind = "clipboard-read") => {
      trace({ kind, at: new Date().toISOString(), length: text.length })
      return text
    },
    writeText: async (value) => {
      text = value
    },
    owner: async (trace) => {
      trace({
        kind: "clipboard-owner-exit",
        at: "2026-11-10T08:35:00.000Z",
        helperPid: 4242,
        exitCode: 0,
        signal: null,
      })
      return { helperPid: 4242, alive: false, exit: { code: 0, signal: null, at: "2026-11-10T08:35:00.000Z" } }
    },
  })
  const refusal = transaction(
    async () => {
      ran = true
      return { pass: true, observation: { outcome: "supported", assertionType: "query_reply" } }
    },
    (event) => events.push(event),
    async () => {},
  )
  await expect(refusal).rejects.toThrow(
    `Owned clipboard helper 4242 exited at 2026-11-10T08:35:00.000Z (code 0, signal none) before callback; ` +
      `taker not read; read sha256 ${EMPTY_SHA256} length 0, empty read (no owner or empty owner)`,
  )
  expect(ran).toBe(false)
  expect(text).toBe("baseline-nonce")
  expect(events.map((event) => event.kind)).toEqual(["clipboard-owner-exit", "clipboard-read", "clipboard-verify"])
})

// 33003 (@cto 756f05d1): the record is read at the pre-flight only. A terminal that takes the selection inside the
// callback (our helper exits 0) is the measurement and the restore re-owns; a helper dead before the pre-flight is red.
test("a helper displaced inside the callback is a measurement, and only a helper dead before the pre-flight is red", async () => {
  let text = "baseline-nonce"
  let owner = 100
  let nextPid = 200
  const ownership = createClipboardOwnership<"clipboard">({ clipboard: owner }, () => false)
  ownership.spawned(owner, "clipboard")
  const events: ClipboardTraceEvent[] = []
  const trace = (event: ClipboardTraceEvent) => events.push(event)
  const transaction = createClipboardTransaction("baseline-nonce", {
    readText: async () => text,
    // Our writer: it acquires, and the helper it displaced exits 0, as xclip does.
    writeText: async (value) => {
      const pid = nextPid++
      ownership.spawned(pid, "clipboard")
      text = value
      ownership.exited(owner, 0, null)
      ownership.acquired("clipboard", pid)
      owner = pid
    },
    owner: (record) => ownership.state("clipboard", record),
  })
  const measured = { pass: true, observation: { outcome: "supported", assertionType: "query_reply" } } as const

  // The terminal takes the selection by OSC 52 inside the callback: our helper exits 0 and nobody re-owns yet.
  await expect(
    transaction(
      async () => {
        ownership.exited(owner, 0, null)
        text = "written-by-the-terminal"
        return measured
      },
      trace,
      async () => {},
    ),
  ).resolves.toEqual(measured)
  expect(text).toBe("baseline-nonce")
  expect(events).toEqual([])

  // The restore's writer owns the selection now, so the next pre-flight passes.
  await expect(
    transaction(
      async () => measured,
      trace,
      async () => {},
    ),
  ).resolves.toEqual(measured)
  expect(events).toEqual([])

  // Our helper dies between transactions: the next pre-flight is red with the dead-owner reason, before the callback.
  const dead = owner
  ownership.exited(dead, null, "SIGTERM")
  let ran = false
  await expect(
    transaction(
      async () => {
        ran = true
        return measured
      },
      trace,
      async () => {},
    ),
  ).rejects.toThrow(
    new RegExp(
      `^Owned clipboard helper ${dead} exited at \\S+ \\(code null, signal SIGTERM\\) before callback; ` +
        `taker not read; read sha256 ${createHash("sha256").update("baseline-nonce").digest("hex")} length 14$`,
    ),
  )
  expect(ran).toBe(false)
  expect(text).toBe("baseline-nonce")
  expect(events).toEqual([
    { kind: "clipboard-owner-exit", at: expect.any(String), helperPid: dead, exitCode: null, signal: "SIGTERM" },
  ])
})

test("a live owner with a stray read is refused with the read's digest and length", async () => {
  let text = "foreign"
  const transaction = createClipboardTransaction("baseline-nonce", {
    readText: async () => text,
    writeText: async (value) => {
      text = value
    },
    owner: async () => ({ helperPid: 7, alive: true }),
  })
  await expect(
    transaction(
      async () => ({ pass: true, observation: { outcome: "supported", assertionType: "query_reply" } }),
      () => {},
      async () => {},
    ),
  ).rejects.toThrow(
    `Owned clipboard baseline changed before callback: read sha256 ${createHash("sha256").update("foreign").digest("hex")} ` +
      `length 7; owner helper 7 alive`,
  )
})

// #33145 (@cto 70645b74): the press is recorded in the clipboard trace with its X time and the focused window,
// and a focus or XTEST failure is a named error that the probe turns into a probe-invalid, never a skip.
test("the real key event focuses the owned window, presses shift by XTEST and traces event, X time and window", async () => {
  const calls: string[][] = []
  const events: ClipboardTraceEvent[] = []
  const clock = [3979146100, 3979146120]
  await pressRealKey(
    "2097164",
    async (file, args) => {
      calls.push([file, ...args])
      return args[0] === "getwindowfocus" ? "2097164\n" : ""
    },
    () => clock.shift()!,
    (event) => events.push(event),
    async () => {},
  )
  expect(calls).toEqual([
    ["xdotool", "windowfocus", "2097164"],
    ["xdotool", "getwindowfocus"],
    ["xdotool", "key", "--window", "0", "--clearmodifiers", "shift"],
  ])
  // /proc/uptime counts centiseconds, so the press lies in [first read, second read + 10 ms).
  expect(events).toEqual([
    {
      kind: "clipboard-key",
      at: expect.any(String),
      key: "shift",
      windowId: "2097164",
      xTimeMs: [3979146100, 3979146130],
    },
  ])
})

test("a focus that lands on another window refuses the press by name and traces the error", async () => {
  const calls: string[][] = []
  const events: ClipboardTraceEvent[] = []
  await expect(
    pressRealKey(
      "2097164",
      async (file, args) => {
        calls.push([file, ...args])
        return args[0] === "getwindowfocus" ? "1\n" : ""
      },
      () => 0,
      (event) => events.push(event),
      async () => {},
    ),
  ).rejects.toThrow(
    "Real key event before the OSC 52 write failed: owned window 2097164 is not focused; getwindowfocus is 1",
  )
  expect(calls.some((call) => call[1] === "key")).toBe(false)
  expect(events).toEqual([{ kind: "clipboard-key", at: expect.any(String), status: "error" }])
})

test("the transaction offers the real key event only when its io has one, on the transaction's trace", async () => {
  const io = {
    readText: async () => "baseline-nonce",
    writeText: async () => {},
  }
  const result = (): ProbeCallbackResult => ({
    pass: true,
    tests: [{ id: "criterion", status: "probe-todo", reason: "insufficient-evidence" }],
  })
  const plain = createClipboardTransaction("baseline-nonce", io)
  await plain(
    async (fixture) => {
      expect(fixture.realKeyEvent).toBeUndefined()
      return result()
    },
    () => {},
    async () => {},
  )
  const events: ClipboardTraceEvent[] = []
  const keyed = createClipboardTransaction("baseline-nonce", {
    ...io,
    realKeyEvent: async (trace) => trace({ kind: "clipboard-key", at: "t", key: "shift" }),
  })
  await keyed(
    async (fixture) => {
      await fixture.realKeyEvent?.()
      return result()
    },
    (event) => events.push(event),
    async () => {},
  )
  expect(events).toEqual([{ kind: "clipboard-key", at: "t", key: "shift" }])
})

// 33693 (@cto 379b191a): the tmux run's restore writer lost CLIPBOARD between transactions to the outer terminal,
// and the pre-flight refused without naming who took it. The owner's exit now reads the taker; the pre-flight
// re-owns once only for a clean displacement by a read client that is not ours, and the result row says so.
// @failure osc52-clipboard stayed probe-invalid on kitty+tmux because a taker outside the fixture was never read.
// @level l1
// @consumer createClipboardTransaction pre-flight through the Linux adapter
// @testonly none
const KITTY_TAKER = {
  read: true,
  at: "2026-11-12T07:18:09.180Z",
  window: "0x600005",
  clientWindows: ["0x60000d"],
  takerClass: '"kitty", "kitty"',
  takerPid: 77,
} as const

test("the owner's exit reads the taker only when no writer of ours is claiming, and says whether it could be ours", async () => {
  const reads: string[] = []
  const ownership = createClipboardOwnership<"clipboard">(
    { clipboard: 90 },
    () => false,
    async (selection) => {
      reads.push(selection)
      return KITTY_TAKER
    },
  )
  ownership.spawned(101, "clipboard")
  ownership.acquired("clipboard", 101)
  // Our next writer claims first: its predecessor's exit is ours displacing ours, so nothing is read.
  ownership.spawned(102, "clipboard")
  ownership.exited(101, 0, null)
  ownership.acquired("clipboard", 102)
  expect(reads).toEqual([])
  // Nothing of ours is claiming when 102 exits: the taker is read at that instant and cannot be ours.
  ownership.exited(102, 0, null)
  expect(reads).toEqual(["clipboard"])
  const events: ClipboardTraceEvent[] = []
  expect(await ownership.state("clipboard", (event) => events.push(event))).toMatchObject({
    helperPid: 102,
    alive: false,
    taker: KITTY_TAKER,
    takerOurs: false,
  })
  expect(events).toEqual([
    expect.objectContaining({
      kind: "clipboard-owner-exit",
      helperPid: 102,
      exitCode: 0,
      taker: KITTY_TAKER,
      takerOurs: false,
    }),
  ])

  // A live writer of ours on that selection could be the taker, so the read cannot clear it.
  const busy = createClipboardOwnership<"clipboard">(
    { clipboard: 90 },
    () => false,
    async () => KITTY_TAKER,
  )
  busy.spawned(201, "clipboard")
  busy.acquired("clipboard", 201)
  busy.spawned(202, "clipboard")
  busy.acquired("clipboard", 202)
  busy.exited(202, 0, null)
  expect(await busy.state("clipboard", () => {})).toMatchObject({ helperPid: 202, alive: false, takerOurs: true })
})

function reownFixture(
  owner: Awaited<ReturnType<NonNullable<Parameters<typeof createClipboardTransaction>[1]["owner"]>>>,
) {
  const state = { text: "", writes: [] as string[], ran: false }
  const events: ClipboardTraceEvent[] = []
  const transaction = createClipboardTransaction("baseline-nonce", {
    readText: async (trace, kind = "clipboard-read") => {
      trace({ kind, at: new Date().toISOString(), length: state.text.length })
      return state.text
    },
    writeText: async (value, trace, kind) => {
      state.writes.push(kind)
      trace({ kind, at: new Date().toISOString(), length: value.length })
      state.text = value
    },
    owner: async () => owner,
  })
  const run = (observation = true) =>
    transaction(
      async (): Promise<ProbeCallbackResult> => {
        state.ran = true
        return observation
          ? { pass: true, observation: { outcome: "supported", assertionType: "query_reply", note: "measured" } }
          : { pass: true, note: "measured", tests: [{ id: "fixture", status: "probe-todo", reason: "fixture" }] }
      },
      (event) => events.push(event),
      async () => {},
    )
  return { state, events, run }
}

const displaced = {
  helperPid: 2014,
  alive: false,
  exit: { code: 0, signal: null, at: "2026-11-12T07:18:09.172Z" },
  taker: KITTY_TAKER,
  takerOurs: false,
  takerOuterTerminal: true,
} as const

test("a clean displacement by a read client that is not ours re-owns once, and the result row says it recovered", async () => {
  const fixture = reownFixture(displaced)
  const result = await fixture.run()
  expect(fixture.state.ran).toBe(true)
  expect(fixture.state.writes).toEqual(["clipboard-reown", "clipboard-restore"])
  expect(fixture.events.map((event) => event.kind)).toEqual([
    "clipboard-reown",
    "clipboard-read",
    "clipboard-restore",
    "clipboard-verify",
  ])
  const said =
    "pre-flight re-owned the clipboard baseline: helper 2014 exited at 2026-11-12T07:18:09.172Z (code 0, signal none); " +
    'taker window 0x600005 (class "kitty", "kitty", pid 77), this run\'s outer terminal'
  expect(result).toEqual({
    pass: true,
    observation: { outcome: "supported", assertionType: "query_reply", note: `measured; ${said}` },
  })
  const unobserved = reownFixture(displaced)
  expect(await unobserved.run(false)).toEqual({
    pass: true,
    note: `measured; ${said}`,
    tests: [{ id: "fixture", status: "probe-todo", reason: "fixture" }],
  })
})

test("any other exit, an unread taker or a taker that could be ours refuses before the callback, never re-owns", async () => {
  for (const [owner, said] of [
    [{ ...displaced, exit: { code: 143, signal: null, at: "2026-11-12T07:18:09.172Z" } }, "(code 143, signal none)"],
    [
      { ...displaced, taker: { read: false, at: "t", reason: "taker child signal SIGSEGV" }, takerOurs: undefined },
      "taker not read (taker child signal SIGSEGV)",
    ],
    [{ ...displaced, takerOurs: true }, "which could be a helper of ours"],
    [{ ...displaced, takerOuterTerminal: false }, "not this run's outer terminal"],
    [{ ...displaced, takerOuterTerminal: undefined }, "taker window 0x600005"],
  ] as const) {
    const fixture = reownFixture(owner)
    await expect(fixture.run()).rejects.toThrow(said)
    expect(fixture.state.ran).toBe(false)
    expect(fixture.state.writes).toEqual(["clipboard-restore"])
  }
})

test("a re-own whose re-read differs refuses, naming the one re-own", async () => {
  let text = ""
  let writes = 0
  const transaction = createClipboardTransaction("baseline-nonce", {
    readText: async () => text,
    // The re-own writes the baseline, but something takes the selection again before the re-read.
    writeText: async (value) => {
      writes++
      text = writes === 1 ? "taken-again" : value
    },
    owner: async () => displaced,
  })
  let ran = false
  await expect(
    transaction(
      async () => {
        ran = true
        return { pass: true, observation: { outcome: "supported", assertionType: "query_reply" } }
      },
      () => {},
      async () => {},
    ),
  ).rejects.toThrow(
    /^Owned clipboard baseline changed before callback after its one re-own: read sha256 \w+ length 11$/,
  )
  expect(ran).toBe(false)
})

// 33968 (@cto e387bb82): tmux 3.8's default mouse-on copy bindings send the outer terminal an OSC 52 during the
// mouse probes, so the outer terminal takes CLIPBOARD from a helper that, in a subset run, is not our child. The one
// repair widens: re-own only when the taker is proven to be this run's own outer terminal, whatever the helper was.
// @failure osc52-clipboard went probe-invalid on a kitty+tmux subset run: helper not our child, taker the outer kitty.
// @level l1
// @consumer createClipboardTransaction pre-flight through the Linux adapter
// @testonly none
test("the owner's taker is this run's outer terminal only when its pid and its client's window are the receipt's", async () => {
  const outer = { pid: 77, windowId: String(0x60000d) }
  const read = (taker: typeof KITTY_TAKER | Record<string, unknown>) => {
    const ownership = createClipboardOwnership<"clipboard">(
      { clipboard: 90 },
      () => false,
      async () => taker as never,
      outer,
    )
    return ownership.state("clipboard", () => {})
  }
  expect(await read(KITTY_TAKER)).toMatchObject({ helperPid: 90, takerOurs: false, takerOuterTerminal: true })
  expect(await read({ ...KITTY_TAKER, takerPid: 78 })).toMatchObject({ takerOuterTerminal: false })
  expect(await read({ ...KITTY_TAKER, clientWindows: ["0x700001"] })).toMatchObject({ takerOuterTerminal: false })
  const { takerPid: _pid, ...withoutPid } = KITTY_TAKER
  expect(await read(withoutPid)).toMatchObject({ takerOuterTerminal: false })
  const unproven = createClipboardOwnership<"clipboard">(
    { clipboard: 90 },
    () => false,
    async () => KITTY_TAKER,
  )
  expect(await unproven.state("clipboard", () => {})).not.toHaveProperty("takerOuterTerminal")
})

test("a helper that is not our child, taken by this run's outer terminal, is re-owned and the row says from whom", async () => {
  const { exit: _exit, ...notOurChild } = displaced
  const fixture = reownFixture(notOurChild)
  const result = await fixture.run()
  expect(fixture.state.ran).toBe(true)
  expect(fixture.state.writes).toEqual(["clipboard-reown", "clipboard-restore"])
  expect(result).toEqual({
    pass: true,
    observation: {
      outcome: "supported",
      assertionType: "query_reply",
      note:
        "measured; pre-flight re-owned the clipboard baseline: helper 2014 is gone (not our child, so its exit code " +
        'and signal are unknown); taker window 0x600005 (class "kitty", "kitty", pid 77), this run\'s outer terminal',
    },
  })
})

test("a helper that is not our child, taken by any other client, refuses before the callback by name", async () => {
  const { exit: _exit, ...notOurChild } = displaced
  const fixture = reownFixture({ ...notOurChild, takerOuterTerminal: false })
  await expect(fixture.run()).rejects.toThrow(
    /^Owned clipboard helper 2014 is gone \(not our child, so its exit code and signal are unknown\) before callback; taker window 0x600005 \(class "kitty", "kitty", pid 77\), not this run's outer terminal; read sha256 \w+ length 0/,
  )
  expect(fixture.state.ran).toBe(false)
  expect(fixture.state.writes).toEqual(["clipboard-restore"])
})
