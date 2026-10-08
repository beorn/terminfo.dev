/**
 * @failure An unrelated local process or web page can make the daemon emit terminal control bytes.
 * @level l3
 * @consumer Real-terminal daemon HTTP clients
 * @testonly none
 * @reach fs-walk /tmp/terminfo-serve-*
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

let child: ChildProcess | undefined
let home: string | undefined
const packageRoot = join(import.meta.dirname, "../../..")

async function startTestDaemon(
  source = `import { startDaemon } from "./packages/terminfo.dev/src/serve.ts"; await startDaemon()`,
  environment: Record<string, string | undefined> = {},
) {
  home = mkdtempSync(join(tmpdir(), "terminfo-serve-"))
  child = spawn(process.execPath, ["-e", source], {
    cwd: packageRoot,
    env: { ...process.env, HOME: home, TERM: "dumb", TERM_PROGRAM: "", ...environment },
    stdio: ["pipe", "ignore", "pipe"],
  })
  let filename!: string
  let registration!: { port: number; token?: string; runId: string; pid: number }
  await vi.waitFor(
    () => {
      const files = readdirSync(join(home!, ".terminfo-dev/daemons"))
      expect(files).toHaveLength(1)
      filename = join(home!, ".terminfo-dev/daemons", files[0]!)
      registration = JSON.parse(readFileSync(filename, "utf8")) as typeof registration
    },
    { timeout: 2000 },
  )
  return { filename, registration }
}

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill()
    await new Promise<void>((resolve) => child!.once("exit", () => resolve()))
  }
  if (home) rmSync(home, { recursive: true, force: true })
  child = undefined
  home = undefined
})

describe("daemon HTTP boundary", () => {
  // Carrier validation precedes source-suite loading. The old endpoint ignored
  // these bodies and tried to probe; authentication coverage did not detect that.
  it("refuses malformed or mismatched owner assertions before collection", async () => {
    const { registration } = await startTestDaemon()
    const url = `http://127.0.0.1:${registration.port}/probe`
    const owner = {
      asserter: "terminfo-admin",
      launchRunId: registration.runId,
      workerPid: registration.pid,
      windowId: 791,
      tabTty: "/dev/ttys004",
      intendedVersion: "2.15",
    }
    const headers = { Authorization: `Bearer ${registration.token}`, "Content-Type": "application/json" }
    const unauthenticated = await fetch(url, { method: "POST", body: JSON.stringify({ terminalAppOwner: owner }) })
    expect(unauthenticated.status).toBe(403)
    for (const body of [
      "{malformed",
      JSON.stringify({ terminalAppOwner: null }),
      JSON.stringify({ terminalAppOwner: { ...owner, launchRunId: "f".repeat(32) } }),
      JSON.stringify({ terminalAppOwner: { ...owner, workerPid: registration.pid + 1 } }),
      JSON.stringify({ terminalAppOwner: { ...owner, token: registration.token } }),
      JSON.stringify({ unexpectedOwner: owner }),
    ]) {
      const response = await fetch(url, { method: "POST", headers, body })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: "Invalid or mismatched Terminal.app owner assertion" })
    }
  })

  it("refuses v2 collection without a declared source suite", async () => {
    const { registration } = await startTestDaemon()
    const response = await fetch(`http://127.0.0.1:${registration.port}/probe`, {
      headers: { Authorization: `Bearer ${registration.token}` },
    })
    expect(response.status).toBe(500)
    const body: unknown = await response.json()
    expect(body).toEqual({ error: "Probe daemon request failed" })
  })

  it("requires its private token and refuses cross-origin mutation", async () => {
    const { registration } = await startTestDaemon()
    const url = `http://127.0.0.1:${registration.port}/query`
    const body = JSON.stringify({ commands: [{ write: "test" }] })
    const unauth = await fetch(url, { method: "POST", body })
    expect(unauth.status).toBe(403)
    expect(registration.token).toMatch(/^[0-9a-f]{64}$/)
    const headers = { Authorization: `Bearer ${registration.token}` }
    const crossOrigin = await fetch(url, {
      method: "POST",
      body,
      headers: { ...headers, Origin: "https://evil.example" },
    })
    expect(crossOrigin.status).toBe(403)
    const authorized = await fetch(url, { method: "POST", body, headers })
    expect(authorized.status).toBe(200)
  }, 5000)

  it("names a malformed registration instead of silently omitting it", () => {
    home = mkdtempSync(join(tmpdir(), "terminfo-serve-"))
    const dir = join(home, ".terminfo-dev/daemons")
    mkdirSync(dir, { recursive: true })
    const badFile = join(dir, "bad.json")
    writeFileSync(badFile, "{broken")
    const result = spawnSync(
      process.execPath,
      ["-e", `import { listDaemons } from "./packages/terminfo.dev/src/serve.ts"; listDaemons()`],
      {
        cwd: packageRoot,
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(badFile)
  })

  it("reports failure to remove its own registration on shutdown", async () => {
    const { filename } = await startTestDaemon()
    const stderr: Buffer[] = []
    child!.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk))
    rmSync(filename)
    mkdirSync(filename)
    child!.kill("SIGTERM")
    const exitCode = await new Promise<number | null>((resolve) => child!.once("exit", resolve))
    expect(exitCode).toBe(1)
    expect(Buffer.concat(stderr).toString()).toContain(filename)
  }, 5000)
})

describe("private finite daemon startup", () => {
  it("measures owned subset identity independently, retains feature replies and disposes on refusal", () => {
    home = mkdtempSync(join(tmpdir(), "terminfo-serve-identity-"))
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `
      import { mock } from "bun:test"
      import assert from "node:assert/strict"
      import { parseRunProvenance } from "@terminfo/run-parser"
      const unified = await import("./packages/terminfo.dev/src/probes/unified.ts")
      const tty = await import("./packages/terminfo.dev/src/tty.ts")
      const owned = await import("./packages/terminfo.dev/src/owned-terminal.ts")
      let raw = "\\x1bP>|kitty(0.49.2)\\x1b\\\\\\x1b[?62;52;c", disposed = 0, calls = []
      let launch
      globalThis.__TERMINFO_BUNDLED_SUITE__ = {
        manifest: { probeHash: "a".repeat(12), probes: { app: unified.ALL_PROBES.map(p => p.id).sort() } },
        collectorRevision: "b".repeat(40)
      }
      mock.module("./packages/terminfo.dev/src/detect.ts", () => ({ detectTerminal: () => ({name:"kitty",version:"",os:"linux",osVersion:"fixture"}) }))
      mock.module("./packages/terminfo.dev/src/owned-terminal.ts", () => ({...owned, createOwnedTerminal: async () => ({
        geometryAtGrant:{status:"measured",rows:24,cols:80},summary:"owned fixture",dispose:async()=>{disposed++}
      })}))
      mock.module("./packages/terminfo.dev/src/tty.ts", () => ({...tty,
        withRawMode:async callback=>callback(),drainStdin:async()=>{},
        queryWithSentinelOutcome:async(sequence,pattern)=>{
          calls.push(sequence)
          const reply=sequence === "\\x1b[18t" ? "\\x1b[8;24;80t" : raw
          return {raw:reply,rawBase64:Buffer.from(reply).toString("base64"),match:pattern.exec(reply),reason:pattern.test(reply)?"reply":"sentinel"}
        }
      }))
      mock.module("./packages/terminfo.dev/src/probes/unified.ts", () => ({...unified,runProbeBatch:async options=>({
        rawReplies:options.ids.includes("device.xtversion")?{"device.xtversion":"feature-owned reply"}:{},
        observations:options.ids.map(featureId=>({featureId})), assertions:[],screenshotRefs:[],ungradedDiagnostics:{},suiteComplete:false,
        ...(launch && { appLaunch: launch })
      })}))
      const {collectProbeRun}=await import("./packages/terminfo.dev/src/serve.ts")
      const ids=unified.ALL_PROBES.filter(p=>p.id!=="device.xtversion").slice(0,10).map(p=>p.id)
      // 28216: the collector COPIES the apparatus-measured launch block into origin.appLaunch, and a
      // batch that carries none leaves the origin without one.
      launch={bundlePath:"/Applications/iTerm.app",cfBundleShortVersionString:"3.6.11",cfBundleVersion:"3.6.11",
        executablePath:"/Applications/iTerm.app/Contents/MacOS/iTerm2",executableSha256:"a".repeat(64),
        sourceArtifact:{path:"/Library/Caches/Homebrew/downloads/iterm2.zip",sha256:"b".repeat(64)}}
      const run=await collectProbeRun({ids,terminalAppOwner:{}})
      assert.deepEqual(run.origin,{kind:"collector",appLaunch:launch})
      assert.equal(run.target.version,"0.49.2")
      assert.deepEqual(run.observations.map(o=>o.featureId),ids)
      assert.equal(run.suiteComplete,false)
      assert.equal(run.rawReplies["device.xtversion"],undefined)
      assert.equal(run.rawReplies["collector.xtversion"],raw)
      assert.deepEqual(calls,["\\x1b[18t","\\x1b[>0q"])
      const query=JSON.parse(run.rawReplies["collector.xtversionQuery"])
      assert.equal(query.sequence,"\\x1b[>0q")
      assert.equal(query.outbound,"\\x1b[>0q\\x1b[c")
      assert.equal(query.rawBase64,Buffer.from(raw).toString("base64"))
      const provenance={executable:{path:"/fixture/kitty",sha256:"c".repeat(64),version:"kitty 0.49.2"},
        sourceArtifact:{url:"https://example.invalid/kitty.txz",sha256:"d".repeat(64)},
        runtime:{imageId:"sha256:"+"e".repeat(64),imageTarSha256:"f".repeat(64),arch:"amd64",nixLockRevision:"1".repeat(40),sourceRevision:"b".repeat(40),cleanTree:true,suiteHash:"a".repeat(12)},
        fixture:{definition:"fixture",config:"fixture",font:"fixture",geometry:"80x24",display:"fixture",gl:"fixture"}}
      assert.equal(parseRunProvenance(provenance,run.target,{probeHash:run.probeHash,sourceRevision:run.sourceRevision},"fixture").executable.version,"kitty 0.49.2")
      const feature=await collectProbeRun({ids:["device.xtversion"],terminalAppOwner:{}})
      assert.equal(feature.rawReplies["device.xtversion"],"feature-owned reply")
      assert.equal(feature.rawReplies["collector.xtversion"],raw)
      launch=undefined
      const unlaunched=await collectProbeRun({ids:["device.xtversion"],terminalAppOwner:{}})
      assert.deepEqual(unlaunched.origin,{kind:"collector"})
      launch={bundlePath:"/Applications/iTerm.app",cfBundleShortVersionString:"3.6.11",cfBundleVersion:"3.6.11",
        executablePath:"/Applications/iTerm.app/Contents/MacOS/iTerm2",executableSha256:"a".repeat(64),
        sourceArtifact:{path:"/Library/Caches/Homebrew/downloads/iterm2.zip",sha256:"b".repeat(64)}}
      for(const invalid of ["\\x1b[?62;52;c","\\x1bP>|kitty(0.49.2)"]){
        raw=invalid
        await assert.rejects(collectProbeRun({ids,terminalAppOwner:{}}),/identity: XTVERSION preflight/)
      }
      assert.equal(disposed,5)
      calls=[]
      const nonowned=await collectProbeRun({ids})
      assert.equal(nonowned.target.version,"unknown")
      assert.equal(nonowned.rawReplies["collector.xtversion"],undefined)
      assert.deepEqual(calls,[])
    `,
      ],
      { cwd: packageRoot, env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 5000 },
    )
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
  })

  it.each([undefined, '["cursor.hide","reset.decaln"]'])(
    "forwards startup selection %s once and preserves producer completeness",
    async (selection) => {
      const { registration } = await startTestDaemon(
        `
          import { mock } from "bun:test"
          const unified = await import("./packages/terminfo.dev/src/probes/unified.ts")
          const tty = await import("./packages/terminfo.dev/src/tty.ts")
          globalThis.__TERMINFO_BUNDLED_SUITE__ = {
            manifest: { probeHash: "a".repeat(12), probes: { app: unified.ALL_PROBES.map(p => p.id).sort() } },
            collectorRevision: "b".repeat(40)
          }
          mock.module("./packages/terminfo.dev/src/tty.ts", () => ({
            ...tty, withRawMode: async callback => callback(), drainStdin: async () => {}
          }))
          mock.module("./packages/terminfo.dev/src/probes/unified.ts", () => ({
            ...unified, runProbeBatch: async options => ({
              rawReplies: { selected: options.ids ?? null }, observations: (options.ids ?? []).map(featureId => ({ featureId })),
              assertions: [], screenshotRefs: [], ungradedDiagnostics: {}, suiteComplete: false
            })
          }))
          const { startDaemon } = await import("./packages/terminfo.dev/src/serve.ts")
          await startDaemon()
          process.env.TERMINFO_PROBE_IDS = '["not-a-probe"]'
        `,
        { TERMINFO_PROBE_IDS: selection },
      )
      const response = await fetch(`http://127.0.0.1:${registration.port}/probe`, {
        headers: { Authorization: `Bearer ${registration.token}` },
      })
      expect(response.status).toBe(200)
      const run = (await response.json()) as {
        rawReplies: { selected: string[] | null }
        observations: { featureId: string }[]
        suiteComplete: boolean
      }
      expect(run.rawReplies.selected).toEqual(selection ? JSON.parse(selection) : null)
      expect(run.observations.map((observation: { featureId: string }) => observation.featureId)).toEqual(
        selection ? JSON.parse(selection) : [],
      )
      expect(run.suiteComplete).toBe(false)
    },
  )

  it.each(["", "null", "[]", '["cursor.hide","cursor.hide"]', '["not-a-probe"]', '["cursor.hide",3]'])(
    "refuses malformed or inapplicable private IDs %s before listening",
    (value) => {
      home = mkdtempSync(join(tmpdir(), "terminfo-serve-private-"))
      const result = spawnSync(
        process.execPath,
        ["-e", 'import { startDaemon } from "./packages/terminfo.dev/src/serve.ts"; startDaemon()'],
        {
          cwd: packageRoot,
          env: { ...process.env, HOME: home, TERMINFO_PROBE_IDS: value },
          encoding: "utf8",
          timeout: 1500,
        },
      )
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("TERMINFO_PROBE_IDS")
    },
  )
})
