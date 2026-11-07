/**
 * @failure Inherited parent TERM_FEATURES can masquerade as a terminal export, or an unrelated run can supply its control.
 * @level l2
 * @consumer Direct CLI App launch and device.term-features observation.
 * @testonly none
 */
import { afterEach, expect, test, vi } from "vitest"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareCliLaunch, launchPreparedCli } from "../admin/src/app.ts"
import { termFeaturesBootstrap, readTermFeaturesRecord } from "../terminfo.dev/src/terminal-child-environment.ts"
import { deviceProbes } from "../probe-defs/src/device.ts"
import { replayTermProbeSource } from "../probe-defs/src/testing/group-harness.ts"
import { shellQuote as quote } from "../terminfo.dev/src/daemon-client.ts"
import { runProbeBatch } from "../terminfo.dev/src/probes/unified.ts"
import * as ownership from "../terminfo.dev/src/owned-terminal.ts"
import { parseProbeResults } from "../run-parser/src/index.ts"
import { classifyResultMethod } from "../../docs/data/release-scope.ts"

const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true })
})

test.runIf(process.platform === "linux" || process.platform === "darwin").each([true, false])(
  "a real bootstrap observes the fixture export=%s; inherited startup hooks cannot decide",
  async (exported) => {
    const directory = mkdtempSync(join(tmpdir(), "terminfo-child-process-"))
    directories.push(directory)
    const run = { id: "b".repeat(32), directory, scriptPath: join(directory, "serve.sh") }
    vi.stubEnv("TERM_FEATURES", "hostile-parent-only")
    const launch = prepareCliLaunch("wezterm", run)
    const recordPath = launch.termFeaturesRecordPath!
    const daemonPath = join(directory, "daemon.json")
    const hookPath = join(directory, "startup-hook.sh")
    writeFileSync(hookPath, "export TERM_FEATURES=hostile-startup-hook\nexport TERMINFO_RUN_ID=wrong-hook-run\n")
    // This is the production prefix, followed by an actual exec into the collector runtime.
    const collector = `const {execFileSync}=require('node:child_process');require('node:fs').writeFileSync(${JSON.stringify(daemonPath)},JSON.stringify({pid:process.pid,tty:execFileSync('tty',{encoding:'utf8',stdio:['inherit','pipe','pipe']}).trim()}));`
    writeFileSync(
      run.scriptPath,
      termFeaturesBootstrap(recordPath) + `exec ${quote(process.execPath)} -e ${quote(collector)}\n`,
      { mode: 0o700 },
    )
    const command = `unset TERM_FEATURES; ${exported ? "export TERM_FEATURES=fixture-terminal-export; " : ""}export BASH_ENV=${quote(hookPath)}; exec /bin/bash -p ${quote(run.scriptPath)}`
    // script supplies a real PTY, acting as this fixture's terminal process; no GUI or capture is claimed.
    launch.spawnPath = "/usr/bin/script"
    launch.args =
      process.platform === "darwin"
        ? ["-q", "/dev/null", "/bin/bash", "-p", "-c", command]
        : ["-q", "-e", "-c", `/bin/bash -p -c ${quote(command)}`, "/dev/null"]
    launch.env.SHELL = "/bin/bash"
    delete launch.env.BASH_ENV // The PTY utility is not the terminal-child shell; the fixture installs the hostile hook above.
    const actual = launchPreparedCli(launch, directory)
    if (!actual.proc) throw Error("Fixture terminal did not spawn")
    const code = await new Promise<number | null>((resolve, reject) => {
      actual.proc!.once("error", reject)
      actual.proc!.once("exit", resolve)
    })
    if (code !== 0) {
      throw Error(
        `Fixture terminal exit ${code}: ${readFileSync(join(directory, "app.stdout.log"), "utf8")} ${readFileSync(join(directory, "app.stderr.log"), "utf8")}`,
      )
    }
    const daemon = JSON.parse(readFileSync(daemonPath, "utf8")) as { pid: number; tty: string }
    const binding = { recordPath, runId: run.id, workerPid: daemon.pid, ownerPid: actual.proc.pid!, tty: daemon.tty }
    const reading = readTermFeaturesRecord(binding)
    expect(reading.status).toBe("measured")
    if (reading.status !== "measured") throw Error(reading.reason)
    expect(reading.present).toBe(exported)
    expect(reading.value).toBe(exported ? "fixture-terminal-export" : "")
    const callback = deviceProbes.find((x) => x.id === "device.term-features")!.term!
    const source = replayTermProbeSource(new Map())
    source.readTermFeatures = async () => reading
    const result = await callback(source)
    expect(result.observation?.outcome).toBe(exported ? "supported" : "unsupported")
    expect(result.observation?.assertionType).toBe("process_environment")
    expect(JSON.stringify(result)).not.toContain("hostile-")
    // The process fixture above owns exporter truth; this seam checks that the native collector
    // keeps the reading, its raw reference and its class through finalization and the reader.
    vi.spyOn(ownership,"ownedTerminalVerifiedFor").mockReturnValue(true)
    const noGeometry = {status:"unavailable" as const,at:new Date().toISOString(),source:"unavailable: no verified output device" as const,diagnostic:"Fixture has no measured grid",stdout:"",stderr:""}
    const owner: ownership.OwnedTerminal = {geometryAtGrant:noGeometry,geometrySource:noGeometry.source,summary:"fixture",readGeometry:async()=>noGeometry,dispose:async()=>{},readTermFeatures:async()=>readTermFeaturesRecord(binding)}
    const batch=await runProbeBatch({ids:["device.term-features"],subject:{kind:"term",id:"fixture-terminal",os:process.platform},ownedTerminal:owner,captureRunId:"d".repeat(32)})
    const recorded=batch.results.filter(x=>x.featureId==="device.term-features")
    expect(recorded[0]?.status).toBe(exported?"supported":"unsupported")
    expect(batch.observations[0]?.rawReplyRef).toBe("device.term-features.callbackResponse")
    const parsed=parseProbeResults(recorded,"fixture.json",new Set(["device.term-features"]),batch.rawReplies,batch.assertions)
    expect(parsed[0]?.status).toBe(exported?"supported":"unsupported")
    expect(classifyResultMethod(parsed[0]!,{kind:"term",version:"fixture"},batch.assertions)).toMatchObject({kind:"method",method:"end-to-end",assertionType:"process_environment"})
    expect(classifyResultMethod(parsed[0]!,{kind:"lib",version:"fixture"},batch.assertions).kind).toBe("unmapped")
    vi.mocked(ownership.ownedTerminalVerifiedFor).mockReturnValue(false)
    const unowned=await runProbeBatch({ids:["device.term-features"],subject:{kind:"term",id:"fixture-terminal",os:process.platform},ownedTerminal:owner})
    expect(unowned.results.find(x=>x.featureId==="device.term-features")?.status).toBe("probe-todo")
    expect(unowned.observations).toEqual([])
    for (const changed of [
      { ownerPid: binding.ownerPid + 1 },
      { workerPid: binding.workerPid + 1 },
      { runId: "c".repeat(32) },
      { tty: "/dev/foreign" },
      { recordPath: join(directory, "missing.bin") },
    ]) {
      const unqualified = readTermFeaturesRecord({ ...binding, ...changed })
      expect(unqualified.status).toBe("unavailable")
      source.readTermFeatures = async () => unqualified
      expect((await callback(source)).observation).toBeUndefined()
    }
    if (exported) {
      // Malformed payloads and a dirty upstream witness cannot borrow the valid process controls.
      const original = readFileSync(recordPath)
      const fields = original.toString("utf8").split("\0")
      for (const value of ["x".repeat(4097), "not\nprintable"]) {
        const malformed = [...fields]
        malformed[4] = value
        writeFileSync(recordPath, malformed.join("\0"))
        const invalid = readTermFeaturesRecord(binding)
        expect(invalid.status).toBe("invalid")
        source.readTermFeatures = async () => invalid
        expect((await callback(source)).tests?.[0]?.status).toBe("probe-invalid")
      }
      const wrongControl = [...fields]
      wrongControl[0] = "e".repeat(32)
      writeFileSync(recordPath, wrongControl.join("\0"))
      expect(readTermFeaturesRecord(binding).status).toBe("unavailable")
      writeFileSync(recordPath, original)
      const launchPath = join(directory, "term-features-launch.json")
      const witness = JSON.parse(readFileSync(launchPath,"utf8"))
      writeFileSync(launchPath,JSON.stringify({...witness,upstreamAbsent:false}))
      expect(readTermFeaturesRecord(binding).status).toBe("unavailable")
    }
  },
  15000,
)

test("the actual CLI spawn input excludes a hostile parent advertisement and binds this run", () => {
  vi.stubEnv("TERM_FEATURES", "hostile-parent-only")
  vi.stubEnv("TERMINFO_RUN_ID", "unrelated-parent-run")
  const directory = mkdtempSync(join(tmpdir(), "terminfo-child-env-"))
  directories.push(directory)
  const run = { id: "a".repeat(32), directory, scriptPath: join(directory, "serve.sh") }
  const launch = prepareCliLaunch("wezterm", run)
  expect(Object.hasOwn(launch.env, "TERM_FEATURES")).toBe(false)
  expect(launch.env.TERMINFO_RUN_ID).toBe(run.id)
})
