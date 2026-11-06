/**
 * @failure The Mac workflow samples after setup, races failed self-parse, or shares one VM across apps.
 * @level l1
 * @consumer macos-measurement.yml first-step bootstrap and one-app collection handoff (27910).
 * @testonly none
 * @reach fs-walk <fixture-only: temporary bootstrap, fake commands and downloaded source files>
 */
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, test, vi } from "vitest"
import { parse } from "yaml"
import { CENSUS } from "../packages/terminfo.dev/src/darwin-capture.ts"

// The retained iTerm draft stops at blink entry. Existing bootstrap/startup tests do not
// exercise native-state evidence or prove that observer errors preserve the older diagnostics.
test.each(["matched", "missing-pids", "foreign-argv", "sample-exit", "sample-timeout", "missing-log"] as const)(
  "iTerm failure evidence preserves bounded measured-process observations (%s)",
  async (scenario) => {
    const workflow = parse(
      await readFile(new URL("../.github/workflows/macos-measurement.yml", import.meta.url), "utf8"),
    )
    const step = workflow.jobs["measure-macos"].steps.find(
      (row: { name?: string }) => row.name === "Preserve terminal launch failure evidence",
    )
    const source = (step.run as string).match(/bun --eval '([\s\S]*)'\s*$/)?.[1]
    if (!source) throw new Error("Mac native failure observer script missing")
    const dir = await mkdtemp(join(tmpdir(), "mac-native-state-"))
    const out = join(dir, "measurement-artifacts")
    const workspace = fileURLToPath(new URL("../", import.meta.url))
    const executable = "/Applications/iTerm.app/Contents/MacOS/iTerm2"
    type NativeObservation = {
      argv: string[]
      childPid: number
      wallMs: number
      exitCode: number
      outerTimedOut: boolean
      stderr: { text: string }
    }
    const calls: string[][] = []
    const killed: Array<{ pid: number; signal: string }> = []
    let clockAdvance: Promise<unknown> | undefined
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {})
    const stream = (value: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (value) controller.enqueue(new TextEncoder().encode(value))
          controller.close()
        },
      })
    try {
      await mkdir(out)
      // Projection of the actual retained ancestry: collector2306, app2125. No invented receipt ordering.
      if (scenario !== "missing-log") {
        await writeFile(
          join(out, "collector.log"),
          scenario === "missing-pids"
            ? "phase=collector-invoked\n"
            : `Hosted Darwin measured process ancestry: 2306:bun </Users/runner/.bun/bin/bun> <- 2125:${executable} <${executable}>\n`,
        )
      }
      await writeFile(join(out, "host-measured.json"), JSON.stringify({ appLaunch: { executablePath: executable } }))
      if (scenario === "sample-timeout") vi.useFakeTimers()
      const native = {
        spawn(argv: string[]) {
          calls.push(argv)
          const pid = 9000 + calls.length
          let stdout = "",
            stderr = "",
            code = 0
          let finish: ((value: number) => void) | undefined
          let exited: Promise<number> | undefined
          if (argv[0] === "/bin/ps") {
            const target = argv[argv.indexOf("-p") + 1]
            const collectorArgv = scenario === "foreign-argv" ? "/another-run/run.json" : join(out, "run.json")
            const collector = `2306 2149 2149 ttys000 S ttywait 00:01 bun collector test --output ${collectorArgv}\n`
            const app = `2125 1 2125 ?? S machmsg 00:02 ${executable}\n`
            stdout = argv.includes("-axo") ? collector + app : target === "2306" ? collector : app
          } else if (argv[0] === "/usr/bin/sample") {
            if (argv[1] === "2306" && scenario === "sample-timeout") {
              stderr = "sample fixture still running"
              exited = new Promise<number>((resolve) => {
                finish = resolve
              })
              clockAdvance = Promise.resolve().then(() => vi.advanceTimersByTimeAsync(10000))
            } else if (argv[1] === "2306" && scenario === "sample-exit") {
              code = 1
              stderr = "sample fixture: target access denied"
            } else {
              const path = argv[argv.indexOf("-file") + 1]
              if (!path) throw new Error("Native sample fixture lacks output path")
              writeFileSync(path, "native stack fixture\n")
              stdout = "sample fixture complete"
            }
          } else if (argv[0] === "/usr/sbin/screencapture") {
            const path = argv.at(-1)
            if (!path) throw new Error("Screen fixture lacks output path")
            writeFileSync(path, "screen fixture")
          } else if (argv[0] === "/usr/bin/osascript" || argv[0] === "/usr/bin/log") stdout = "[]"
          else throw new Error(`Unexpected native observer fixture command ${String(argv[0])}`)
          return {
            pid,
            stdout: stream(stdout),
            stderr: stream(stderr),
            exited: exited ?? Promise.resolve(code),
            kill(signal: string) {
              killed.push({ pid, signal })
              if (!finish) throw new Error("Fixture killed an already-finished observer")
              finish(137)
            },
          }
        },
      }
      const processState = {
        env: {
          RUNNER_TEMP: dir,
          GITHUB_WORKSPACE: workspace,
          APP_ID: "iterm2",
          ITERM_LAUNCH_START: "2026-11-03T01:56:26Z",
          ITERM_LAUNCH_END: "2026-11-03T01:56:28Z",
        },
        exitCode: 0,
      }
      // Vitest's VM cannot dynamically import from Function; link the actual modules
      // at the boundary, just as the startup fixture supplies its real require boundary.
      const loadModule = async (name: string) => {
        if (name === "node:fs/promises") return { readFile, writeFile, stat }
        if (name === "node:path") return { join }
        if (name === join(workspace, "packages/terminfo.dev/src/darwin-capture.ts")) return { CENSUS }
        throw new Error(`Unexpected native observer module ${name}`)
      }
      await new Function(
        "Bun",
        "process",
        "loadModule",
        `return (async () => {${source.replaceAll("await import(", "await loadModule(")}\n})()`,
      )(native, processState, loadModule)
      if (clockAdvance) await clockAdvance
      // These older observations must survive even missing logs and failed/timed-out samples.
      for (const label of ["screen", "windows", "log"]) {
        const row = JSON.parse(await readFile(join(out, `iterm-${label}.json`), "utf8")) as NativeObservation
        expect(row.exitCode).toBe(0)
      }
      const evidence = JSON.parse(await readFile(join(out, "iterm-failure-evidence.json"), "utf8")) as {
        failures: Array<{ label: string }>
      }
      if (scenario === "matched") expect(diagnostics).not.toHaveBeenCalled()
      else {
        expect(
          diagnostics.mock.calls.some(
            (args) => String(args[0]).includes("unmeasured") || String(args[0]).includes("unavailable"),
          ),
        ).toBe(true)
      }
      const samples = calls.filter((argv) => argv[0] === "/usr/bin/sample").map((argv) => argv[1])
      if (scenario === "missing-log" || scenario === "missing-pids") {
        expect(samples).toEqual([])
        expect(
          evidence.failures.some(
            (row: { label: string }) =>
              row.label === (scenario === "missing-log" ? "native-state" : "collector-sample"),
          ),
        ).toBe(true)
      } else {
        expect(samples).toEqual(scenario === "foreign-argv" ? ["2125"] : ["2306", "2125"])
        if (scenario === "foreign-argv") {
          expect(evidence.failures.some((row: { label: string }) => row.label === "collector-sample")).toBe(true)
        } else {
          const row = JSON.parse(await readFile(join(out, "iterm-collector-sample.json"), "utf8")) as NativeObservation
          expect(row.argv[1]).toBe("2306")
          expect(row.childPid).toBeGreaterThan(9000)
          expect(row.wallMs).toBe(10000)
          expect(row.exitCode).toBe(scenario === "sample-timeout" ? 137 : scenario === "sample-exit" ? 1 : 0)
          expect(row.outerTimedOut).toBe(scenario === "sample-timeout")
          expect(row.stderr.text).toBe(
            scenario === "sample-exit"
              ? "sample fixture: target access denied"
              : scenario === "sample-timeout"
                ? "sample fixture still running"
                : "",
          )
          if (scenario === "sample-timeout") {
            expect(killed).toHaveLength(1)
            expect(killed[0]?.pid).toBe(row.childPid)
            expect(killed[0]?.signal).toBe("SIGKILL")
          }
          if (scenario === "matched") expect(evidence.failures).toEqual([])
        }
      }
    } finally {
      diagnostics.mockRestore()
      vi.useRealTimers()
      await rm(dir, { recursive: true, force: true })
    }
  },
)

test("nine fresh Mac jobs bootstrap the shared producer before checkout and collect after self-parse", async () => {
  const workflow = parse(await readFile(new URL("../.github/workflows/macos-measurement.yml", import.meta.url), "utf8"))
  expect(Object.keys(workflow.jobs)).toEqual(["measure-macos"])
  const job = workflow.jobs["measure-macos"]
  const matrix = JSON.parse(workflow.on.workflow_dispatch.inputs.context_matrix.default) as {
    include: Array<{ id: string }>
  }
  expect(matrix.include.map((row: { id: string }) => row.id)).toEqual([
    "terminal-app",
    "iterm2",
    "ghostty",
    "alacritty",
    "wezterm",
    "cursor",
    "com.microsoft.VSCode",
    "warp",
    "cmux",
  ])
  expect(job["runs-on"]).toBe("macos-latest")
  const first = job.steps[0]
  expect(job.steps[1].uses).toBe("actions/checkout@v4")
  const collectIndex = job.steps.findIndex((step: { id?: string }) => step.id === "collect")
  const failureIndex = job.steps.findIndex(
    (step: { name?: string }) => step.name === "Preserve terminal launch failure evidence",
  )
  expect(failureIndex).toBeGreaterThan(collectIndex)
  expect(job.steps[failureIndex].if).toContain("failure()")
  expect(job.steps[failureIndex].if).toContain("steps.collect.outputs.iterm_failure == 'true'")
  expect(job.steps.at(-1).uses).toBe("actions/upload-artifact@v4")
  const collect = job.steps[collectIndex].run as string
  const install = job.steps.find((step: { name?: string }) => step.name === "Install this job's terminal")
  expect(install.env.ITERM_DOWNLOAD_URL).toBe("https://iterm2.com/downloads/stable/iTerm2-3_6_11.zip")
  expect(install.env.ITERM_DOWNLOAD_SHA256).toBe("36e78c5049560eaa8e122224f6652eb4b229c61cd5e7332d6d25b5c36f7398e7")
  expect(collect).toContain("version.stdout.trim() !== '3.6.11'")
  expect(collect).toContain("export TERMINFO_DISPOSABLE_RECEIPT=")
  expect(collect.indexOf(' emit "$OUT/job-start.json"')).toBeLessThan(collect.indexOf('touch "$OUT/collector-ready"'))
  expect(collect).toContain('while [ ! -f "$OUT/collector-ready" ]')
  expect(collect).not.toMatch(/killall|continue-on-error/)
  expect(job.steps.some((step: { run?: string }) => step.run?.includes("scripts/build-cli.ts"))).toBe(true)
  const dir = await mkdtemp(join(tmpdir(), "mac-bootstrap-"))
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ jobs: [{ id: 1234, runner_name: "fixture-runner" }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const root = fileURLToPath(new URL("../", import.meta.url))
    const sha = "a".repeat(40)
    const fakeCurl = `#!${process.execPath}\nconst fs=require('node:fs'); const args=process.argv.slice(2); const url=new URL(args.find(a=>a.startsWith('http'))); if(url.searchParams.get('ref')!==process.env.GITHUB_SHA) process.exit(7); const path=url.pathname.split('/contents/')[1]; fs.copyFileSync(process.env.FIXTURE_ROOT+'/'+path,args[args.indexOf('--output')+1]); fs.appendFileSync(process.env.RUNNER_TEMP+'/requests.jsonl',JSON.stringify({path,sha:url.searchParams.get('ref')})+'\\n');\n`
    await writeFile(join(dir, "curl"), fakeCurl, { mode: 0o755 })
    const sample = `#!${process.execPath}\nconst n=process.argv[1]; console.log(n.endsWith('ifconfig')?'ether 02:00:00:00:00:01':n.endsWith('ioreg')?'"IOPlatformUUID" = "fixture-platform"':'fixture-boot');\n`
    for (const name of ["ifconfig", "ioreg", "sysctl"]) await writeFile(join(dir, name), sample, { mode: 0o755 })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected fixture API address")
    await promisify(execFile)("bash", ["-e", "-o", "pipefail", "-c", first.run], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        FIXTURE_ROOT: root,
        RUNNER_TEMP: dir,
        GITHUB_SHA: sha,
        GH_TOKEN: "fixture-token",
        GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
        GITHUB_REPOSITORY: "fixture/repo",
        GITHUB_RUN_ID: "42",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_WORKFLOW: "measure",
        GITHUB_WORKFLOW_REF: "measure.yml@main",
        GITHUB_JOB: "measure",
        RUNNER_ENVIRONMENT: "github-hosted",
        RUNNER_NAME: "fixture-runner",
        RUNNER_OS: "macOS",
        RUNNER_ARCH: "ARM64",
        RUNNER_TRACKING_ID: "fixture-tracking",
        ImageOS: "macos26",
        ImageVersion: "fixture-image",
      },
    })
    const requested = (await readFile(join(dir, "requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(requested).toEqual([
      { path: "scripts/hosted-runner-receipt.ts", sha },
      { path: "packages/terminfo.dev/src/disposable-receipt.ts", sha },
      // The ONE app-launch parser rides the bootstrap too, so the producer and run-parser validate
      // the launch receipt with exactly the same code (28216).
      { path: "packages/run-parser/src/app-launch.ts", sha },
    ])
    const sampled = JSON.parse(await readFile(join(dir, "measurement-artifacts", "job-start.json"), "utf8")) as {
      job: { jobId: string }
      phase: string
    }
    expect(sampled.job.jobId).toBe("1234")
    expect(sampled.phase).toBe("job-start")
    // Execute the real install step: a bad download/hash must never reach extraction.
    const installerBytes = "qualified installer fixture\n"
    const callsPath = join(dir, "install-calls.jsonl")
    for (const [name, body] of Object.entries({
      brew: "if (args.includes('iterm2')) process.exit(8);",
      curl: `fs.writeFileSync(args[args.indexOf('--output') + 1], ${JSON.stringify(installerBytes)}); if (process.env.CURL_FAIL === '1') process.exit(22);`,
      shasum:
        "console.log(require('node:crypto').createHash('sha256').update(fs.readFileSync(args.at(-1))).digest('hex') + '  ' + args.at(-1));",
      ditto:
        "if (process.env.EXTRACT_FAIL === '1') process.exit(6); fs.mkdirSync(process.env.APP_BUNDLE, { recursive: true });",
      sudo: "",
    })) {
      await writeFile(
        join(dir, name),
        `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(process.env.INSTALL_CALLS, JSON.stringify({ command: ${JSON.stringify(name)}, args }) + '\\n'); ${body}\n`,
        { mode: 0o755 },
      )
    }
    const runInstall = async (overrides: Record<string, string> = {}) => {
      await writeFile(callsPath, "")
      return promisify(execFile)("bash", ["-e", "-o", "pipefail", "-c", install.run], {
        cwd: dir,
        env: {
          ...process.env,
          ...install.env,
          PATH: `${dir}:${process.env.PATH}`,
          APP_ID: "iterm2",
          APP_BUNDLE: join(dir, "Installed.app"),
          RUNNER_TEMP: dir,
          INSTALL_CALLS: callsPath,
          ITERM_DOWNLOAD_SHA256: createHash("sha256").update(installerBytes).digest("hex"),
          ...overrides,
        },
      })
    }
    const calls = async (): Promise<Array<{ command: string; args: string[] }>> =>
      (await readFile(callsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => {
          const value = JSON.parse(line)
          if (
            !value ||
            typeof value !== "object" ||
            !("command" in value) ||
            typeof value.command !== "string" ||
            !("args" in value) ||
            !Array.isArray(value.args) ||
            !value.args.every((arg: unknown) => typeof arg === "string")
          ) {
            throw new Error("Installer fixture recorded an invalid command")
          }
          return { command: value.command, args: value.args }
        })
    await runInstall()
    const installed = await calls()
    const download = installed.find((call) => call.command === "curl")
    expect(download?.args).toEqual(
      expect.arrayContaining(["--fail", "--retry", "2", "--retry-max-time", "120", install.env.ITERM_DOWNLOAD_URL]),
    )
    expect(installed.map((call) => call.command)).toEqual(["brew", "curl", "shasum", "ditto", "sudo"])
    for (const [overrides, message, extracted] of [
      [{ CURL_FAIL: "1" }, /iTerm download failed/, false],
      [{ ITERM_DOWNLOAD_SHA256: "0".repeat(64) }, /iTerm checksum mismatch \(actual [a-f0-9]{64}/, false],
      [{ EXTRACT_FAIL: "1" }, /iTerm extraction failed \(archive SHA-256 [a-f0-9]{64}/, true],
    ] as const) {
      await expect(runInstall(overrides)).rejects.toThrow(message)
      const failed = await calls()
      expect(failed.some((call) => call.command === "ditto")).toBe(extracted)
      expect(failed.some((call) => call.command === "sudo")).toBe(false)
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(dir, { recursive: true, force: true })
  }
})

test("iTerm startup records window and transfer consent policies before launch and refuses unqualified results", async () => {
  const workflow = parse(await readFile(new URL("../.github/workflows/macos-measurement.yml", import.meta.url), "utf8"))
  const collect = workflow.jobs["measure-macos"].steps.find((step: { id?: string }) => step.id === "collect")
    .run as string
  const source = collect.match(/<<'ITERM_STARTUP'\n([\s\S]*?)\nITERM_STARTUP/)
  const startup = source?.[1]
  if (!startup) throw new Error("iTerm startup script missing")
  const bundle = "/Applications/iTerm.app"
  const command = "--command=/bin/bash /tmp/space\\ path/collect.command"
  const run = (overrides: Record<number, object> = {}) => {
    const results = [
      { status: 0, stdout: "com.googlecode.iterm2\n" },
      { status: 0, stdout: "3.6.11\n" },
      { status: 1, stdout: "" },
      { status: 0, stdout: "" },
      { status: 0, stdout: "" },
      { status: 0, stdout: "" },
      { status: 0, stdout: "" },
    ]
    const spawnSync = vi.fn((_file, _args, _options) => ({
      stderr: "",
      ...results[spawnSync.mock.calls.length - 1],
      ...overrides[spawnSync.mock.calls.length - 1],
    }))
    const stdout = { write: vi.fn() }
    const execute = () =>
      new Function("require", "process", startup)(() => ({ spawnSync }), {
        argv: ["node", "-", bundle, command],
        stdout,
        stderr: { write: vi.fn() },
      })
    return { execute, spawnSync, stdout }
  }
  const success = run()
  success.execute()
  expect(success.spawnSync.mock.calls.map(([file, args]) => [file, args])).toEqual([
    ["/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", `${bundle}/Contents/Info.plist`]],
    ["/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", `${bundle}/Contents/Info.plist`]],
    ["/usr/bin/pgrep", ["-x", "iTerm2"]],
    ["/usr/bin/defaults", ["write", "com.googlecode.iterm2", "OpenNoWindowsAtStartup", "-bool", "true"]],
    ["/usr/bin/defaults", ["write", "com.googlecode.iterm2", "NoSyncSuppressDownloadConfirmation", "-bool", "true"]],
    [
      "/usr/bin/defaults",
      ["write", "com.googlecode.iterm2", "NoSyncSuppressDownloadConfirmation_selection", "-int", "0"],
    ],
    ["/usr/bin/open", ["-a", bundle, "--args", command]],
  ])
  // The retained launch log must disclose the configured permission state.
  const policies = success.stdout.write.mock.calls.map(([line]) => JSON.parse(line)).slice(4, 6)
  expect(policies).toMatchObject([
    {
      name: "transfer consent policy",
      args: ["write", "com.googlecode.iterm2", "NoSyncSuppressDownloadConfirmation", "-bool", "true"],
      status: 0,
    },
    {
      name: "transfer consent selection",
      args: ["write", "com.googlecode.iterm2", "NoSyncSuppressDownloadConfirmation_selection", "-int", "0"],
      status: 0,
    },
  ])
  expect(success.spawnSync.mock.calls.map(([, , options]) => options)).toEqual([
    ...Array.from({ length: 6 }, () =>
      expect.objectContaining({ timeout: 5000, killSignal: "SIGKILL", maxBuffer: 262144 }),
    ),
    expect.objectContaining({ timeout: 10000, killSignal: "SIGKILL", maxBuffer: 262144 }),
  ])
  for (const [index, result, diagnostic] of [
    [0, { stdout: "wrong.id" }, "bundle identifier"],
    [1, { stdout: "3.7.4" }, "version"],
    [2, { status: 0, stdout: "123" }, "already running"],
    [2, { status: 2 }, "pgrep"],
    [2, { status: null, signal: "SIGKILL", error: new Error("timed out") }, "pgrep"],
    [3, { status: 1 }, "startup policy"],
    [3, { status: null, signal: "SIGKILL", error: new Error("timed out") }, "startup policy"],
    [4, { status: 1 }, "transfer consent policy"],
    [4, { status: null, signal: "SIGKILL", error: new Error("timed out") }, "transfer consent policy"],
    [5, { status: 1 }, "transfer consent selection"],
    [5, { status: null, signal: "SIGKILL", error: new Error("timed out") }, "transfer consent selection"],
    [6, { status: 1 }, "open"],
    [6, { status: null, signal: "SIGKILL", error: new Error("timed out") }, "open"],
  ] as const) {
    const failure = run({ [index]: result })
    expect(failure.execute).toThrow(diagnostic)
    expect(failure.spawnSync).toHaveBeenCalledTimes(index + 1)
  }
})
