/**
 * @failure Parent/runtime environment pollution or an unbound child can decide TERM_FEATURES.
 * @level l2
 * @consumer App launch, controlled child reader, native finalization and canonical run reader.
 * @testonly none
 * @reach fs-walk <fixture-only: private PTY child files>
 */
import { afterEach, expect, test, vi } from "vitest"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareCliLaunch, launchPreparedCli } from "../admin/src/app.ts"
import { readTermFeaturesEnvironment } from "../terminfo.dev/src/terminal-child-environment.ts"
import { deviceProbes } from "../probe-defs/src/device.ts"
import { replayTermProbeSource } from "../probe-defs/src/testing/group-harness.ts"
import { shellQuote as quote } from "../terminfo.dev/src/daemon-client.ts"
import { runProbeBatch } from "../terminfo.dev/src/probes/unified.ts"
import * as ownership from "../terminfo.dev/src/owned-terminal.ts"
import { parseProbeResults } from "../run-parser/src/index.ts"
import { classifyResultMethod } from "../../docs/data/release-scope.ts"
import { serveCommand } from "../admin/src/serve-command.ts"
import * as versions from "../admin/versions.ts"
import type { TermFeaturesReading } from "@terminfo/probe-defs"

const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true })
})

// Both real launchers must suppress Bun's dotenv load. The preload only observes startup and
// exits before daemon work; it preserves the App builder's executable, flags, entry and arguments.
test.each(["app", "linux"] as const)(
  "%s builder excludes fake dotenv; removing the flag reproduces the pollution",
  (route) => {
    const directory = mkdtempSync(join(tmpdir(), "terminfo-builder-env-"))
    directories.push(directory)
    writeFileSync(join(directory, ".env"), "TERM_FEATURES=FAKE_DOTENV_ONLY\n")
    const observer = join(directory, "observe.ts")
    writeFileSync(
      observer,
      'console.log(JSON.stringify({present:Object.hasOwn(process.env,"TERM_FEATURES"),fake:process.env.TERM_FEATURES==="FAKE_DOTENV_ONLY"}));process.exit(0)',
    )
    vi.spyOn(versions, "sourceSuiteEnvironment").mockReturnValue({
      TERMINFO_PROBE_HASH: "f".repeat(12),
      TERMINFO_SOURCE_REVISION: "1".repeat(40),
    })
    let command: string
    if (route === "app") {
      command = serveCommand({ id: "a".repeat(32), directory, scriptPath: join(directory, "serve.sh") })
      const executable = "exec " + quote(process.execPath)
      if (!command.includes(executable)) throw Error("App builder executable was not found")
      command = command.replace(executable, executable + " --preload " + quote(observer))
    } else {
      // Execute the real Bash assignment, not a separately reconstructed argv. Its runner path is
      // already a launcher parameter; a full container run separately proves the actual collector.
      const script = readFileSync(new URL("../../scripts/linux-container-run.sh", import.meta.url), "utf8")
      const assignment = script.split("\n").find((line) => /^\s*collector_command=\(bun\b/.test(line))
      if (!assignment) throw Error("Linux collector command assignment was not found")
      command = "TERMINFO_RUNNER=" + quote(observer) + "\n" + assignment + '\nexec "${collector_command[@]}"'
    }
    for (const removed of [false, true]) {
      const actual = removed ? command.replace("--no-env-file ", "") : command
      const child = Bun.spawnSync(["/bin/bash", "-p", "-c", actual], {
        cwd: directory,
        env: { PATH: process.env.PATH },
        stdout: "pipe",
        stderr: "pipe",
      })
      if (child.exitCode !== 0) throw Error("Builder " + route + " failed: " + child.stderr.toString())
      expect(JSON.parse(child.stdout.toString())).toEqual({ present: removed, fake: removed })
    }
  },
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
  expect(launch.env.TERMINFO_TERM_FEATURES_LAUNCH).toBe(run.id)
})

test.runIf(process.platform === "linux" || process.platform === "darwin").each([true, false])(
  "real terminal-child fixture export=%s survives native finalization; startup hooks cannot decide",
  async (exported) => {
    const directory = mkdtempSync(join(tmpdir(), "terminfo-child-process-"))
    directories.push(directory)
    const run = { id: "b".repeat(32), directory, scriptPath: join(directory, "serve.sh") }
    vi.stubEnv("TERM_FEATURES", "hostile-parent-only")
    const launch = prepareCliLaunch("wezterm", run)
    const output = join(directory, "child.json"),
      hook = join(directory, "hook.sh")
    writeFileSync(hook, "export TERM_FEATURES=hostile-startup-hook\nexport TERMINFO_RUN_ID=wrong-hook-run\n")
    const modulePath = new URL("../terminfo.dev/src/terminal-child-environment.ts", import.meta.url).href
    const collector =
      "import{readTermFeaturesEnvironment}from " +
      JSON.stringify(modulePath) +
      ";import{execFileSync}from'node:child_process';import{writeFileSync}from'node:fs';const tty=execFileSync('tty',{encoding:'utf8',stdio:['inherit','pipe','pipe']}).trim();writeFileSync(" +
      JSON.stringify(output) +
      ",JSON.stringify(readTermFeaturesEnvironment(process.env," +
      JSON.stringify(run.id) +
      ",process.pid,tty)));"
    const command =
      "unset TERM_FEATURES; " +
      (exported ? "export TERM_FEATURES=fixture-terminal-export; " : "") +
      "export BASH_ENV=" +
      quote(hook) +
      "; exec /bin/bash -p -c " +
      quote("exec " + quote(process.execPath) + " -e " + quote(collector))
    launch.spawnPath = "/usr/bin/script"
    launch.args =
      process.platform === "darwin"
        ? ["-q", "/dev/null", "/bin/bash", "-p", "-c", command]
        : ["-q", "-e", "-c", "/bin/bash -p -c " + quote(command), "/dev/null"]
    launch.env.SHELL = "/bin/bash"
    delete launch.env.BASH_ENV
    const actual = launchPreparedCli(launch, directory),
      proc = actual.proc
    if (!proc) throw Error("Fixture terminal did not spawn")
    const code = await new Promise<number | null>((resolve, reject) => {
      proc.once("error", reject)
      proc.once("exit", resolve)
    })
    if (code !== 0) {
      throw Error(
        "Fixture exit " +
          code +
          ": " +
          readFileSync(join(directory, "app.stdout.log"), "utf8") +
          " " +
          readFileSync(join(directory, "app.stderr.log"), "utf8"),
      )
    }
    const reading = JSON.parse(readFileSync(output, "utf8")) as TermFeaturesReading
    expect(reading.status).toBe("measured")
    if (reading.status !== "measured") throw Error(reading.reason)
    expect(reading.present).toBe(exported)
    expect(reading.value).toBe(exported ? "fixture-terminal-export" : "")
    const source = replayTermProbeSource(new Map()),
      callback = deviceProbes.find((x) => x.id === "device.term-features")!.term!
    source.readTermFeatures = async () => reading
    expect((await callback(source)).observation?.outcome).toBe(exported ? "supported" : "unsupported")
    vi.spyOn(ownership, "ownedTerminalVerifiedFor").mockReturnValue(true)
    const geometry = {
      status: "unavailable" as const,
      at: new Date().toISOString(),
      source: "unavailable: no verified output device" as const,
      diagnostic: "Fixture has no measured grid",
      stdout: "",
      stderr: "",
    }
    const owner: ownership.OwnedTerminal = {
      geometryAtGrant: geometry,
      geometrySource: "stty size on a /proc/self/fd reopen of the verified output device",
      summary: "fixture",
      readGeometry: async () => geometry,
      dispose: async () => {},
      readTermFeatures: async () => reading,
    }
    const batch = await runProbeBatch({
      ids: ["device.term-features"],
      subject: { kind: "term", id: "fixture-terminal", os: process.platform },
      ownedTerminal: owner,
      captureRunId: "d".repeat(32),
    })
    const recorded = batch.results.filter((x) => x.featureId === "device.term-features")
    expect(recorded[0]?.status).toBe(exported ? "supported" : "unsupported")
    expect(batch.observations[0]?.rawReplyRef).toBe("device.term-features.callbackResponse")
    const parsed = parseProbeResults(
      recorded,
      "fixture.json",
      new Set(["device.term-features"]),
      batch.rawReplies,
      batch.assertions,
    )
    expect(parsed[0]?.status).toBe(exported ? "supported" : "unsupported")
    expect(classifyResultMethod(parsed[0]!, { kind: "term", version: "fixture" }, batch.assertions)).toMatchObject({
      kind: "method",
      method: "end-to-end",
      assertionType: "process_environment",
    })
    expect(classifyResultMethod(parsed[0]!, { kind: "lib", version: "fixture" }, batch.assertions).kind).toBe(
      "unmapped",
    )
    vi.mocked(ownership.ownedTerminalVerifiedFor).mockReturnValue(false)
    const unowned = await runProbeBatch({
      ids: ["device.term-features"],
      subject: { kind: "term", id: "fixture-terminal", os: process.platform },
      ownedTerminal: owner,
    })
    expect(unowned.results.find((x) => x.featureId === "device.term-features")?.status).toBe("probe-todo")
    expect(unowned.observations).toEqual([])
    if (exported) {
      const env = { TERM_FEATURES: reading.value, TERMINFO_RUN_ID: run.id, TERMINFO_TERM_FEATURES_LAUNCH: run.id }
      for (const delta of [
        { TERMINFO_RUN_ID: "e".repeat(32) },
        { TERMINFO_TERM_FEATURES_LAUNCH: "e".repeat(32) },
        { TERMINFO_TERM_FEATURES_LAUNCH: undefined },
      ]) {
        const missing = readTermFeaturesEnvironment({ ...env, ...delta }, run.id, reading.pid, reading.tty)
        expect(missing.status).toBe("unavailable")
        source.readTermFeatures = async () => missing
        expect((await callback(source)).observation).toBeUndefined()
      }
      for (const value of ["x".repeat(4097), "not\nprintable"]) {
        const invalid = readTermFeaturesEnvironment({ ...env, TERM_FEATURES: value }, run.id, reading.pid, reading.tty)
        expect(invalid.status).toBe("invalid")
        source.readTermFeatures = async () => invalid
        expect((await callback(source)).tests?.[0]?.status).toBe("probe-invalid")
      }
    }
  },
  15000,
)
