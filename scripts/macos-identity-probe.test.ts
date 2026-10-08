/**
 * @failure The Mac workflow samples after setup, races failed self-parse, or shares one VM across apps.
 * @level l1
 * @consumer macos-measurement.yml first-step bootstrap and one-app collection handoff (27910).
 * @testonly none
 * @reach fs-walk <fixture-only: temporary bootstrap, fake commands and downloaded source files>
 */
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, test, vi } from "vitest"
import { parse } from "yaml"

test("four fresh Mac jobs bootstrap the shared producer before checkout and collect after self-parse", async () => {
  const workflow = parse(await readFile(new URL("../.github/workflows/macos-measurement.yml", import.meta.url), "utf8"))
  expect(Object.keys(workflow.jobs)).toEqual(["measure-macos"])
  const job = workflow.jobs["measure-macos"]
  expect(job.strategy.matrix.include.map((row: { id: string }) => row.id)).toEqual([
    "terminal-app",
    "iterm2",
    "ghostty",
    "alacritty",
  ])
  expect(job["runs-on"]).toBe("macos-latest")
  const first = job.steps[0]
  expect(job.steps[1].uses).toBe("actions/checkout@v4")
  const collectIndex = job.steps.findIndex((step: { id?: string }) => step.id === "collect")
  expect(job.steps[collectIndex + 1].if).toBe("failure() && steps.collect.outputs.iterm_failure == 'true'")
  expect(job.steps.at(-1).uses).toBe("actions/upload-artifact@v4")
  const collect = job.steps[collectIndex].run as string
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
    ])
    const sampled = JSON.parse(await readFile(join(dir, "measurement-artifacts", "job-start.json"), "utf8")) as {
      job: { jobId: string }
      phase: string
    }
    expect(sampled.job.jobId).toBe("1234")
    expect(sampled.phase).toBe("job-start")
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(dir, { recursive: true, force: true })
  }
})

test("iTerm startup passes one quoted command and refuses unqualified launch results", async () => {
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
    ]
    const spawnSync = vi.fn((_file, _args, _options) => ({
      stderr: "",
      ...results[spawnSync.mock.calls.length - 1],
      ...overrides[spawnSync.mock.calls.length - 1],
    }))
    const execute = () =>
      new Function("require", "process", startup)(() => ({ spawnSync }), {
        argv: ["node", "-", bundle, command],
        stdout: { write: vi.fn() },
        stderr: { write: vi.fn() },
      })
    return { execute, spawnSync }
  }
  const success = run()
  success.execute()
  expect(success.spawnSync.mock.calls.map(([file, args]) => [file, args])).toEqual([
    ["/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", `${bundle}/Contents/Info.plist`]],
    ["/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", `${bundle}/Contents/Info.plist`]],
    ["/usr/bin/pgrep", ["-x", "iTerm2"]],
    ["/usr/bin/open", ["-a", bundle, "--args", command]],
  ])
  expect(success.spawnSync.mock.calls.map(([, , options]) => options)).toEqual([
    ...Array.from({ length: 3 }, () =>
      expect.objectContaining({ timeout: 5000, killSignal: "SIGKILL", maxBuffer: 262144 }),
    ),
    expect.objectContaining({ timeout: 10000, killSignal: "SIGKILL", maxBuffer: 262144 }),
  ])
  for (const [index, result, diagnostic] of [
    [0, { stdout: "wrong.id" }, "bundle identifier"],
    [1, { stdout: "3.6.12" }, "version"],
    [2, { status: 0, stdout: "123" }, "already running"],
    [2, { status: 2 }, "pgrep"],
    [2, { status: null, signal: "SIGKILL", error: new Error("timed out") }, "pgrep"],
    [3, { status: null, signal: "SIGKILL", error: new Error("timed out") }, "open"],
  ] as const) {
    const failure = run({ [index]: result })
    expect(failure.execute).toThrow(diagnostic)
    expect(failure.spawnSync).toHaveBeenCalledTimes(index + 1)
  }
})
