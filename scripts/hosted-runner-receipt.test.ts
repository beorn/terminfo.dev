/**
 * @failure Hosted receipt production invents identity/job IDs, leaks raw values, or permits collection after an invalid two-sample handoff.
 * @level l1
 * @consumer The first-step and pre-collection hosted-runner receipt apparatus (27910).
 * @testonly none
 * @reach fs-walk <fixture-only: mkdtempSync hosted receipt commands and output files>
 */
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, test } from "vitest"
import { parseDisposableReceipt } from "../packages/terminfo.dev/src/disposable-receipt.ts"

test("the actual hosted producer self-parses measured bytes and refuses incomplete or changed handoffs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hosted-receipt-"))
  const raw = { machine: "02:00:00:00:00:01", platform: "fixture-platform-uuid", boot: "fixture-boot-uuid" }
  let matches = 1
  /** A registration delay: the runner name only appears once this clock passes, so one scan can be
   * complete and still match nothing — the race the bounded re-observe exists to absorb. */
  let matchAt = 0
  let apiStatus = 200
  const queried: string[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://fixture")
    queried.push(url.pathname + url.search)
    res.statusCode = apiStatus
    res.setHeader("content-type", "application/json")
    res.end(
      JSON.stringify({
        jobs:
          url.searchParams.get("page") === "1"
            ? Array.from({ length: 100 }, (_, i) => ({
                id: 1234 + i,
                runner_name: i === 0 && matches > 0 && Date.now() >= matchAt ? "fixture-runner" : `other-${i}`,
              }))
            : matches > 1
              ? [{ id: 5678, runner_name: "fixture-runner" }]
              : [],
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const fixture = `#!${process.execPath}\nconst n=process.argv[1]; if(n.endsWith('ifconfig')) console.log('ether ${raw.machine}'); else if(n.endsWith('ioreg')) console.log('"IOPlatformUUID" = "${raw.platform}"'); else console.log('${raw.boot}');\n`
    for (const name of ["ifconfig", "ioreg", "sysctl"]) await writeFile(join(dir, name), fixture, { mode: 0o755 })
    // 28216: a hosted macOS job launches an app, so the producer must MEASURE its launch receipt from
    // the bundle and installer it installed. Plutil/brew are faked on PATH; the bytes are real.
    const bundle = join(dir, "Ghostty.app")
    await mkdir(join(bundle, "Contents", "MacOS"), { recursive: true })
    await writeFile(join(bundle, "Contents", "Info.plist"), "fixture plist; plutil is faked\n")
    const executableBytes = "fixture-ghostty-executable\n"
    await writeFile(join(bundle, "Contents", "MacOS", "ghostty"), executableBytes, { mode: 0o755 })
    const installer = join(dir, "ghostty--1.3.1.zip")
    const installerBytes = "fixture-ghostty-installer\n"
    await writeFile(installer, installerBytes)
    await writeFile(
      join(dir, "plutil"),
      `#!${process.execPath}
const values = process.env.APP_ID === "iterm2"
  ? { CFBundleShortVersionString: "3.6.11", CFBundleVersion: "3.6.11", CFBundleExecutable: "iTerm2" }
  : process.env.APP_ID === "wezterm"
  ? { CFBundleShortVersionString: "20240203", CFBundleVersion: "20240203", CFBundleExecutable: "wezterm" }
  : process.env.APP_ID === "cursor"
  ? { CFBundleShortVersionString: "3.0.8", CFBundleVersion: "30211", CFBundleExecutable: "Cursor" }
  : process.env.APP_ID === "com.microsoft.VSCode"
  ? { CFBundleShortVersionString: "1.126.0", CFBundleVersion: "30212", CFBundleExecutable: "Code" }
  : { CFBundleShortVersionString: "1.3.1", CFBundleVersion: "1", CFBundleExecutable: "ghostty" };
const value = values[process.argv[3]];
if (!value) { console.error("no fixture value for " + process.argv[3]); process.exit(1); }
console.log(value);
`,
      { mode: 0o755 },
    )
    // The cask cache path is whatever brew reports for the app this job installed; the fixture lets a
    // case name its own cached installer so two cask apps cannot silently share one artifact.
    await writeFile(
      join(dir, "brew"),
      `#!${process.execPath}\nif (["cursor", "com.microsoft.VSCode"].includes(process.env.APP_ID)) { console.error("editor IDs must not reach cask lookup"); process.exit(1); }\nconsole.log(process.env.BREW_CASK_PATH || ${JSON.stringify(installer)});\n`,
      { mode: 0o755 },
    )
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected fixture server address")
    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      APP_ID: "ghostty",
      APP_BUNDLE: bundle,
      RUNNER_TEMP: dir,
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_NAME: "fixture-runner",
      RUNNER_OS: "macOS",
      RUNNER_ARCH: "ARM64",
      RUNNER_TRACKING_ID: "fixture-tracking",
      BREW_CASK_PATH: "",
      ImageOS: "macos26",
      ImageVersion: "fixture-image",
      GITHUB_REPOSITORY: "fixture/repo",
      GITHUB_WORKFLOW: "collect",
      GITHUB_WORKFLOW_REF: "collect.yml@main",
      GITHUB_RUN_ID: "42",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_JOB: "collect",
      GH_TOKEN: "fixture-token",
      GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
    }
    const run = (...args: string[]) =>
      promisify(execFile)(
        "node",
        ["--experimental-strip-types", fileURLToPath(new URL("./hosted-runner-receipt.ts", import.meta.url)), ...args],
        { env },
      )
    const start = join(dir, "start.json")
    const receipt = join(dir, "host-measured.json")
    const first = await run("start", start)
    const emitted = await run("emit", start, receipt)
    const bytes = await readFile(receipt, "utf8")
    expect(parseDisposableReceipt(bytes).kind).toBe("github-hosted-runner")
    const decoded = JSON.parse(bytes) as {
      job: { jobId: string }
      runId: string
      vm: { identityAtJobStart: Record<string, string>; identityAtCollection: Record<string, string> }
      appLaunch: Record<string, unknown>
    }
    // Every field is measured: the bundle's own Info.plist, the executable's bytes, the installer
    // bytes this job installed. Nothing here is a declared or detected value (28216).
    const launch = {
      bundlePath: realpathSync(bundle),
      cfBundleShortVersionString: "1.3.1",
      cfBundleVersion: "1",
      executablePath: realpathSync(join(bundle, "Contents", "MacOS", "ghostty")),
      executableSha256: createHash("sha256").update(executableBytes).digest("hex"),
      sourceArtifact: { path: installer, sha256: createHash("sha256").update(installerBytes).digest("hex") },
    }
    expect(decoded.appLaunch).toEqual(launch)
    expect(parseDisposableReceipt(bytes).appLaunch).toEqual(launch)
    // The qualified iTerm archive can differ from the current Homebrew cask. Measure what launched.
    const itermBundle = join(dir, "iTerm.app")
    await mkdir(join(itermBundle, "Contents", "MacOS"), { recursive: true })
    await writeFile(join(itermBundle, "Contents", "Info.plist"), "fixture iTerm plist\n")
    const itermExecutable = join(itermBundle, "Contents", "MacOS", "iTerm2")
    const itermExecutableBytes = "fixture-qualified-iterm-executable\n"
    await writeFile(itermExecutable, itermExecutableBytes)
    const itermInstaller = join(dir, "iTerm2-3_6_11.zip")
    const itermInstallerBytes = "fixture-qualified-iterm-installer\n"
    await writeFile(itermInstaller, itermInstallerBytes)
    env.APP_ID = "iterm2"
    env.APP_BUNDLE = itermBundle
    const itermReceipt = join(dir, "iterm-host-measured.json")
    await run("emit", start, itermReceipt)
    expect(parseDisposableReceipt(await readFile(itermReceipt, "utf8")).appLaunch).toEqual({
      bundlePath: realpathSync(itermBundle),
      cfBundleShortVersionString: "3.6.11",
      cfBundleVersion: "3.6.11",
      executablePath: realpathSync(itermExecutable),
      executableSha256: createHash("sha256").update(itermExecutableBytes).digest("hex"),
      sourceArtifact: {
        path: itermInstaller,
        sha256: createHash("sha256").update(itermInstallerBytes).digest("hex"),
      },
    })
    // WezTerm is a cask install too (the mac workflow's wezterm case). Before the cask list knew this
    // app id the producer threw "no measured source-artifact route for APP_ID=\"wezterm\"" here, after
    // the workflow had already routed the job — a route that could never release a collection (30054).
    const weztermBundle = join(dir, "WezTerm.app")
    await mkdir(join(weztermBundle, "Contents", "MacOS"), { recursive: true })
    await writeFile(join(weztermBundle, "Contents", "Info.plist"), "fixture WezTerm plist\n")
    const weztermExecutable = join(weztermBundle, "Contents", "MacOS", "wezterm")
    const weztermExecutableBytes = "fixture-wezterm-executable\n"
    await writeFile(weztermExecutable, weztermExecutableBytes, { mode: 0o755 })
    const weztermInstaller = join(dir, "wezterm--20240203-110809-5046fc22.zip")
    const weztermInstallerBytes = "fixture-wezterm-installer\n"
    await writeFile(weztermInstaller, weztermInstallerBytes)
    env.APP_ID = "wezterm"
    env.APP_BUNDLE = weztermBundle
    env.BREW_CASK_PATH = weztermInstaller
    const weztermReceipt = join(dir, "wezterm-host-measured.json")
    await run("emit", start, weztermReceipt)
    expect(parseDisposableReceipt(await readFile(weztermReceipt, "utf8")).appLaunch).toEqual({
      bundlePath: realpathSync(weztermBundle),
      cfBundleShortVersionString: "20240203",
      cfBundleVersion: "20240203",
      executablePath: realpathSync(weztermExecutable),
      executableSha256: createHash("sha256").update(weztermExecutableBytes).digest("hex"),
      sourceArtifact: {
        path: weztermInstaller,
        sha256: createHash("sha256").update(weztermInstallerBytes).digest("hex"),
      },
    })
    // 30211: both canonical IDs bind the ZIP actually installed by their isolated job. Existing
    // cask/iTerm cases cannot catch an editor using a cask token or hashing another cached archive.
    for (const [appId, bundleName, executableName, version, build] of [
      ["cursor", "Cursor.app", "Cursor", "3.0.8", "30211"],
      ["com.microsoft.VSCode", "Visual Studio Code.app", "Code", "1.126.0", "30212"],
    ] as const) {
      const editorBundle = join(dir, bundleName)
      await mkdir(join(editorBundle, "Contents", "MacOS"), { recursive: true })
      await writeFile(join(editorBundle, "Contents", "Info.plist"), `fixture ${appId} plist\n`)
      const editorExecutable = join(editorBundle, "Contents", "MacOS", executableName)
      const editorExecutableBytes = `fixture ${appId} GUI executable\n`
      await writeFile(editorExecutable, editorExecutableBytes)
      const editorInstaller = join(dir, "editor-installer.zip")
      const editorInstallerBytes = `fixture ${appId} installed ZIP\n`
      await writeFile(editorInstaller, editorInstallerBytes)
      env.APP_ID = appId
      env.APP_BUNDLE = editorBundle
      // Deliberately retain another app's valid cask archive: it must not enter this receipt.
      env.BREW_CASK_PATH = weztermInstaller
      const editorReceipt = join(dir, `${executableName}-host-measured.json`)
      await run("emit", start, editorReceipt)
      expect(parseDisposableReceipt(await readFile(editorReceipt, "utf8")).appLaunch).toEqual({
        bundlePath: realpathSync(editorBundle),
        cfBundleShortVersionString: version,
        cfBundleVersion: build,
        executablePath: realpathSync(editorExecutable),
        executableSha256: createHash("sha256").update(editorExecutableBytes).digest("hex"),
        sourceArtifact: {
          path: editorInstaller,
          sha256: createHash("sha256").update(editorInstallerBytes).digest("hex"),
        },
      })
    }
    env.APP_ID = "ghostty"
    env.APP_BUNDLE = bundle
    env.BREW_CASK_PATH = ""
    expect(decoded.job.jobId).toBe("1234")
    expect(decoded.runId).toBe(
      createHash("sha256")
        .update(["github-hosted-runner", "fixture/repo", "42", "1", "1234"].join("\n"))
        .digest("hex")
        .slice(0, 32),
    )
    expect(decoded.vm.identityAtJobStart).toEqual(decoded.vm.identityAtCollection)
    for (const [field, value] of [
      ["machineIdSha256", raw.machine],
      ["productUuidSha256", raw.platform],
      ["bootIdSha256", raw.boot],
    ] as const) {
      expect(decoded.vm.identityAtJobStart[field]).toBe(createHash("sha256").update(value).digest("hex"))
    }
    for (const value of Object.values(raw)) {
      expect(
        bytes + (await readFile(start, "utf8")) + first.stdout + first.stderr + emitted.stdout + emitted.stderr,
      ).not.toContain(value)
    }
    expect(queried).toContain("/repos/fixture/repo/actions/runs/42/attempts/1/jobs?per_page=100&page=2")
    env.GITHUB_RUN_ID = "43"
    await expect(run("emit", start, join(dir, "foreign-job.json"))).rejects.toThrow(
      /does not describe this job\/runner/,
    )
    env.GITHUB_RUN_ID = "42"
    env.RUNNER_TRACKING_ID = "different-tracking"
    await expect(run("emit", start, join(dir, "foreign-runner.json"))).rejects.toThrow(
      /does not describe this job\/runner/,
    )
    env.RUNNER_TRACKING_ID = "fixture-tracking"
    apiStatus = 503
    await expect(run("start", join(dir, "api-failure.json"))).rejects.toThrow(/jobs API.*HTTP 503/)
    apiStatus = 200

    await writeFile(join(dir, "sysctl"), `#!${process.execPath}\nconsole.log('different-boot');\n`, { mode: 0o755 })
    await expect(run("emit", start, join(dir, "changed.json"))).rejects.toThrow(/one machine must serve the whole job/)
    await expect(run("emit", join(dir, "absent.json"), join(dir, "missing.json"))).rejects.toThrow(/absent.json/)
    matches = 2
    await expect(run("start", join(dir, "ambiguous.json"))).rejects.toThrow(/exactly one.*RUNNER_NAME.*found 2/)
    // AC1: the ambiguous case's two-match fixture state ends with it; the next case starts at one.
    matches = 1
    // AC2: the same registered-late case whose FIRST scan lands after the registration delay — the
    // slow-machine ordering that used to inherit the ambiguous case's two-match fixture state.
    matchAt = Date.now() - 1
    await run("start", join(dir, "registered-late-delayed.json"))
    matchAt = 0
    // A complete scan that matches nothing is re-observed inside the one budget, so a runner that
    // registers just after the job starts still resolves to exactly one job id.
    matchAt = Date.now() + 300
    await run("start", join(dir, "registered-late.json"))
    matchAt = 0
    await writeFile(join(dir, "ifconfig"), `#!${process.execPath}\nprocess.exit(7);\n`, { mode: 0o755 })
    await expect(run("start", join(dir, "failed-source.json"))).rejects.toThrow(/machineIdSha256.*ifconfig.*7/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(dir, { recursive: true, force: true })
  }
}, 60_000)

test("a transient jobs-API failure retries with a fresh window and returns the job id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hosted-receipt-retry-"))
  let requests = 0
  const server = createServer((_req, res) => {
    requests += 1
    res.setHeader("content-type", "application/json")
    if (requests === 1) {
      res.statusCode = 503
      res.end(JSON.stringify({ message: "Service Unavailable" }))
      return
    }
    res.end(JSON.stringify({ jobs: [{ id: 4242, runner_name: "retry-runner" }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const fixture = `#!${process.execPath}\nconst n=process.argv[1]; if(n.endsWith('ifconfig')) console.log('ether 02:00:00:00:00:04'); else if(n.endsWith('ioreg')) console.log('"IOPlatformUUID" = "retry-platform"'); else console.log('retry-boot');\n`
    for (const name of ["ifconfig", "ioreg", "sysctl"]) await writeFile(join(dir, name), fixture, { mode: 0o755 })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected fixture server address")
    const started = Date.now()
    const { stdout } = await promisify(execFile)(
      "node",
      [
        "--experimental-strip-types",
        fileURLToPath(new URL("./hosted-runner-receipt.ts", import.meta.url)),
        "start",
        join(dir, "retry.json"),
      ],
      {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          GITHUB_OUTPUT: join(dir, "outputs.txt"),
          RUNNER_ENVIRONMENT: "github-hosted",
          RUNNER_NAME: "retry-runner",
          RUNNER_OS: "macOS",
          RUNNER_ARCH: "ARM64",
          RUNNER_TRACKING_ID: "fixture-tracking",
          ImageOS: "macos26",
          ImageVersion: "fixture-image",
          GITHUB_REPOSITORY: "fixture/repo",
          GITHUB_WORKFLOW: "collect",
          GITHUB_WORKFLOW_REF: "collect.yml@main",
          GITHUB_RUN_ID: "44",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_JOB: "collect",
          GH_TOKEN: "fixture-token",
          GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
        },
      },
    )
    // The retry starts a FRESH window after the named interval: it can never be the old window's
    // expired remainder, and it does not wait out the full 30 s before trying again.
    expect(Date.now() - started).toBeLessThan(20_000)
    expect(requests).toBe(2)
    expect(stdout).toContain("hosted receipt jobs-API lookup: 2 attempt(s) of cap 3")
    expect(await readFile(join(dir, "outputs.txt"), "utf8")).toBe("jobs-api-attempts=2\n")
    const start = JSON.parse(await readFile(join(dir, "retry.json"), "utf8")) as { job: { jobId: string } }
    expect(start.job.jobId).toBe("4242")
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(dir, { recursive: true, force: true })
  }
}, 40_000)

test("every attempt failing refuses by name after the cap, naming the total bound and the last status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hosted-receipt-retry-exhausted-"))
  let requests = 0
  const server = createServer((_req, res) => {
    requests += 1
    res.setHeader("content-type", "application/json")
    res.statusCode = 503
    res.end(JSON.stringify({ message: "Service Unavailable" }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const fixture = `#!${process.execPath}\nconst n=process.argv[1]; if(n.endsWith('ifconfig')) console.log('ether 02:00:00:00:00:05'); else if(n.endsWith('ioreg')) console.log('"IOPlatformUUID" = "retry-exhausted-platform"'); else console.log('retry-exhausted-boot');\n`
    for (const name of ["ifconfig", "ioreg", "sysctl"]) await writeFile(join(dir, name), fixture, { mode: 0o755 })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected fixture server address")
    const started = Date.now()
    let failure: unknown
    try {
      await promisify(execFile)(
        "node",
        [
          "--experimental-strip-types",
          fileURLToPath(new URL("./hosted-runner-receipt.ts", import.meta.url)),
          "start",
          join(dir, "exhausted.json"),
        ],
        {
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            GITHUB_OUTPUT: join(dir, "outputs.txt"),
            RUNNER_ENVIRONMENT: "github-hosted",
            RUNNER_NAME: "outage-runner",
            RUNNER_OS: "macOS",
            RUNNER_ARCH: "ARM64",
            RUNNER_TRACKING_ID: "fixture-tracking",
            ImageOS: "macos26",
            ImageVersion: "fixture-image",
            GITHUB_REPOSITORY: "fixture/repo",
            GITHUB_WORKFLOW: "collect",
            GITHUB_WORKFLOW_REF: "collect.yml@main",
            GITHUB_RUN_ID: "45",
            GITHUB_RUN_ATTEMPT: "1",
            GITHUB_JOB: "collect",
            GH_TOKEN: "fixture-token",
            GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
          },
        },
      )
    } catch (error) {
      failure = error
    }
    const message = failure instanceof Error ? failure.message : String(failure)
    // A voided run must be attributable to the API: attempts, the cap, the total bound, the last
    // status, and the elapsed time all appear, so nobody blames the measurement.
    expect(message).toContain('jobs API lookup for "outage-runner"')
    expect(message).toContain("failed after 3 attempt(s) (cap 3)")
    expect(message).toContain("total bound 90000ms")
    expect(message).toContain("last HTTP status 503")
    expect(message).toMatch(/elapsed \d+ms/)
    expect(message).toContain("HTTP 503")
    // Three immediate failures and two named intervals; the window is not waited out three times.
    expect(requests).toBe(3)
    expect(Date.now() - started).toBeLessThan(20_000)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(dir, { recursive: true, force: true })
  }
}, 40_000)

test("a hosted macOS job that cannot measure its launch refuses by name, never with an invented block", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hosted-receipt-launch-"))
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ jobs: [{ id: 4242, runner_name: "fixture-runner" }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const fixture = `#!${process.execPath}\nconst n=process.argv[1]; if(n.endsWith('ifconfig')) console.log('ether 02:00:00:00:00:02'); else if(n.endsWith('ioreg')) console.log('"IOPlatformUUID" = "fixture-platform"'); else console.log('fixture-boot');\n`
    for (const name of ["ifconfig", "ioreg", "sysctl"]) await writeFile(join(dir, name), fixture, { mode: 0o755 })
    const bundle = join(dir, "Ghostty.app")
    await mkdir(join(bundle, "Contents", "MacOS"), { recursive: true })
    await writeFile(join(bundle, "Contents", "Info.plist"), "fixture plist\n")
    await writeFile(join(bundle, "Contents", "MacOS", "ghostty"), "fixture-ghostty-executable\n")
    const plutil = `#!${process.execPath}
if (process.env.PLUTIL_EXITS === "1") { console.error("fixture plutil refusal"); process.exit(1); }
const values = { CFBundleShortVersionString: "1.3.1", CFBundleVersion: "1", CFBundleExecutable: "ghostty" };
console.log(values[process.argv[3]] ?? "");
`
    await writeFile(join(dir, "plutil"), plutil, { mode: 0o755 })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected fixture server address")
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      APP_ID: "ghostty",
      APP_BUNDLE: bundle,
      RUNNER_TEMP: dir,
      PLUTIL_EXITS: "0",
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_NAME: "fixture-runner",
      RUNNER_OS: "macOS",
      RUNNER_ARCH: "ARM64",
      RUNNER_TRACKING_ID: "fixture-tracking",
      ImageOS: "macos26",
      ImageVersion: "fixture-image",
      GITHUB_REPOSITORY: "fixture/repo",
      GITHUB_WORKFLOW: "measure",
      GITHUB_WORKFLOW_REF: "measure.yml@main",
      GITHUB_RUN_ID: "42",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_JOB: "measure",
      GH_TOKEN: "fixture-token",
      GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
    }
    const run = (overrides: Record<string, string | undefined>, ...args: string[]) => {
      const merged = { ...env, ...overrides }
      for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key]
      return promisify(execFile)(
        "node",
        ["--experimental-strip-types", fileURLToPath(new URL("./hosted-runner-receipt.ts", import.meta.url)), ...args],
        { env: merged as NodeJS.ProcessEnv },
      )
    }
    const start = join(dir, "start.json")
    await run({ RUNNER_OS: "macOS" }, "start", start)
    // The launch receipt is required on macOS: no bundle, no receipt, no run.
    await expect(run({ APP_BUNDLE: undefined }, "emit", start, join(dir, "no-bundle.json"))).rejects.toThrow(
      /requires environment APP_BUNDLE/,
    )
    // A failed Info.plist read refuses by name instead of substituting a detected value.
    await expect(run({ PLUTIL_EXITS: "1" }, "emit", start, join(dir, "plutil-failed.json"))).rejects.toThrow(
      /Info.plist CFBundleExecutable failed \(plutil exit 1/,
    )
    // The installer bytes are the source artifact; a missing installer refuses by name.
    await expect(run({ APP_ID: "alacritty" }, "emit", start, join(dir, "no-installer.json"))).rejects.toThrow(
      /cannot read the installed Alacritty\.dmg/,
    )
    await expect(run({ APP_ID: "iterm2" }, "emit", start, join(dir, "no-iterm-installer.json"))).rejects.toThrow(
      /cannot read the installed iTerm2-3_6_11\.zip/,
    )
    for (const appId of ["cursor", "com.microsoft.VSCode"]) {
      await expect(run({ APP_ID: appId }, "emit", start, join(dir, `no-${appId}-installer.json`))).rejects.toThrow(
        /cannot read the installed editor-installer\.zip/,
      )
    }
    // An app with no measured installer route is refused, never described.
    await expect(run({ APP_ID: "warp" }, "emit", start, join(dir, "no-route.json"))).rejects.toThrow(
      /no measured source-artifact route for APP_ID="warp"/,
    )
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(dir, { recursive: true, force: true })
  }
})

test("the hosted producer supports Windows and refuses degenerate identities by name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hosted-receipt-win-"))
  const raw = {
    mac: "00-15-5D-12-34-56",
    uuid: "12345678-ABCD-1234-ABCD-123456789ABC",
    boot: "2026-10-07T07:57:50.5000000Z",
  }
  const executablePath = String.raw`C:\runner\windows-terminal\WindowsTerminal.exe`
  const zipPath = String.raw`C:\runner\wt.zip`
  const executableBytes = "fixture WindowsTerminal executable bytes\n"
  const zipBytes = "fixture retained portable ZIP bytes\n"
  let productVersion = "1.21.2361.0"
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ jobs: [{ id: 7777, runner_name: "win-runner", status: "in_progress" }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    await writeFile(join(dir, "WindowsTerminal.exe"), executableBytes)
    await writeFile(join(dir, "wt.zip"), zipBytes)
    const fakePs = () => `#!${process.execPath}
const {readFileSync}=require('node:fs'); const {createHash}=require('node:crypto');
const cmd = process.argv.slice(2).join(' ');
if (cmd.includes('Get-NetAdapter')) {
  console.log('${raw.mac}');
} else if (cmd.includes('Win32_ComputerSystemProduct')) {
  console.log('${raw.uuid}');
} else if (cmd.includes('Win32_OperatingSystem')) {
  console.log('${raw.boot}');
} else if (cmd.includes('ProductVersion')) {
  const hash=(file)=>createHash('sha256').update(readFileSync(file)).digest('hex');
  const exe=process.env.APP_EXECUTABLE; const zip=process.env.APP_SOURCE_ARTIFACT;
  console.log(JSON.stringify({platform:'win32',executablePath:exe,productVersion:process.env.FAKE_PRODUCT_VERSION||${JSON.stringify(productVersion)},executableSha256:hash(${JSON.stringify(dir)}+'/'+(process.env.FAKE_EXE_FILE||'WindowsTerminal.exe')),sourceArtifact:{kind:'portable-zip',path:zip,sha256:hash(${JSON.stringify(dir)}+'/'+(process.env.FAKE_ZIP_FILE||'wt.zip'))}}));
} else {
  console.log('');
}
`
    await writeFile(join(dir, "powershell.exe"), fakePs(), { mode: 0o755 })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected fixture server address")
    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      APP_ID: "windows-terminal",
      APP_EXECUTABLE: executablePath,
      APP_SOURCE_ARTIFACT: zipPath,
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_NAME: "win-runner",
      RUNNER_OS: "Windows",
      RUNNER_ARCH: "X64",
      FAKE_PRODUCT_VERSION: "",
      FAKE_EXE_FILE: "",
      FAKE_ZIP_FILE: "",
      RUNNER_TRACKING_ID: "win-tracking",
      ImageOS: "win22",
      ImageVersion: "20261001.1",
      GITHUB_REPOSITORY: "fixture/repo",
      GITHUB_WORKFLOW: "collect",
      GITHUB_WORKFLOW_REF: "collect.yml@main",
      GITHUB_RUN_ID: "88",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_JOB: "collect",
      GH_TOKEN: "fixture-token",
      GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
    }
    const run = (...args: string[]) =>
      promisify(execFile)(
        "node",
        ["--experimental-strip-types", fileURLToPath(new URL("./hosted-runner-receipt.ts", import.meta.url)), ...args],
        { env },
      )
    const start = join(dir, "start.json")
    const receipt = join(dir, "host-measured.json")
    await run("start", start)
    await run("emit", start, receipt)
    const bytes = await readFile(receipt, "utf8")
    const parsed = parseDisposableReceipt(bytes)
    expect(parsed.kind).toBe("github-hosted-runner")
    // The same producer/parser carry the measured Windows app and retained archive, never wt.exe.
    expect(parsed.appLaunch).toEqual({
      platform: "win32",
      executablePath,
      productVersion,
      executableSha256: createHash("sha256").update(executableBytes).digest("hex"),
      sourceArtifact: {
        kind: "portable-zip",
        path: zipPath,
        sha256: createHash("sha256").update(zipBytes).digest("hex"),
      },
    })
    const decoded = JSON.parse(bytes) as {
      vm: { identityAtJobStart: Record<string, string> }
    }
    expect(decoded.vm.identityAtJobStart.machineIdSha256).toBe(createHash("sha256").update(raw.mac).digest("hex"))
    expect(decoded.vm.identityAtJobStart.productUuidSha256).toBe(createHash("sha256").update(raw.uuid).digest("hex"))
    expect(decoded.vm.identityAtJobStart.bootIdSha256).toBe(createHash("sha256").update(raw.boot).digest("hex"))

    // 30197: the same portable-ZIP arm must carry WezTerm on Windows, whose owner process is
    // wezterm-gui.exe — not the `wezterm` shim, exactly as wt.exe is not WindowsTerminal.exe. Before
    // the arm knew this app id the producer refused the app by name at emit.
    const weztermExe = String.raw`C:\runner\wezterm\wezterm-gui.exe`
    const weztermZip = String.raw`C:\runner\wezterm.zip`
    const weztermExeBytes = "fixture wezterm-gui executable bytes\n"
    const weztermZipBytes = "fixture wezterm portable ZIP bytes\n"
    await writeFile(join(dir, "wezterm-gui.exe"), weztermExeBytes)
    await writeFile(join(dir, "wezterm.zip"), weztermZipBytes)
    env.APP_ID = "wezterm"
    env.APP_EXECUTABLE = weztermExe
    env.APP_SOURCE_ARTIFACT = weztermZip
    env.FAKE_PRODUCT_VERSION = "0.2026.10.14"
    env.FAKE_EXE_FILE = "wezterm-gui.exe"
    env.FAKE_ZIP_FILE = "wezterm.zip"
    await run("emit", start, join(dir, "wezterm-host-measured.json"))
    expect(parseDisposableReceipt(await readFile(join(dir, "wezterm-host-measured.json"), "utf8")).appLaunch).toEqual({
      platform: "win32",
      executablePath: weztermExe,
      productVersion: "0.2026.10.14",
      executableSha256: createHash("sha256").update(weztermExeBytes).digest("hex"),
      sourceArtifact: {
        kind: "portable-zip",
        path: weztermZip,
        sha256: createHash("sha256").update(weztermZipBytes).digest("hex"),
      },
    })
    env.APP_ID = "windows-terminal"
    env.APP_EXECUTABLE = executablePath
    env.APP_SOURCE_ARTIFACT = zipPath
    env.FAKE_PRODUCT_VERSION = ""
    env.FAKE_EXE_FILE = ""
    env.FAKE_ZIP_FILE = ""

    // Existing machine identity cases cannot catch a launch version silently omitted from emit.
    productVersion = ""
    await writeFile(join(dir, "powershell.exe"), fakePs(), { mode: 0o755 })
    await expect(run("emit", start, join(dir, "missing-product-version.json"))).rejects.toThrow(/productVersion/)
    productVersion = "1.21.2361.0"
    await writeFile(join(dir, "powershell.exe"), fakePs(), { mode: 0o755 })

    // Refusal test 1: All-zero UUID
    raw.uuid = "00000000-0000-0000-0000-000000000000"
    await writeFile(join(dir, "powershell.exe"), fakePs(), { mode: 0o755 })
    await expect(run("start", join(dir, "degenerate-zero-uuid.json"))).rejects.toThrow(/degenerate UUID/)

    // Refusal test 2: All-F UUID
    raw.uuid = "ffffffff-ffff-ffff-ffff-ffffffffffff"
    await writeFile(join(dir, "powershell.exe"), fakePs(), { mode: 0o755 })
    await expect(run("start", join(dir, "degenerate-f-uuid.json"))).rejects.toThrow(/degenerate UUID/)

    // Refusal test 3: All-zero MAC
    raw.uuid = "12345678-ABCD-1234-ABCD-123456789ABC"
    raw.mac = "00:00:00:00:00:00"
    await writeFile(join(dir, "powershell.exe"), fakePs(), { mode: 0o755 })
    await expect(run("start", join(dir, "degenerate-zero-mac.json"))).rejects.toThrow(/degenerate all-zero MAC/)

    // Refusal test 4: Untrusted RUNNER_OS prototype property
    await expect(
      promisify(execFile)(
        "node",
        [
          "--experimental-strip-types",
          fileURLToPath(new URL("./hosted-runner-receipt.ts", import.meta.url)),
          "start",
          join(dir, "untrusted-os.json"),
        ],
        { env: { ...env, RUNNER_OS: "toString" } },
      ),
    ).rejects.toThrow(/Hosted receipt has no producer for RUNNER_OS="toString"/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(dir, { recursive: true, force: true })
  }
})

test("the hosted producer supports Windows Alacritty with Mesa3D receipt and refuses --version failures by name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hosted-receipt-win-alacritty-"))
  const raw = {
    mac: "00-15-5D-12-34-56",
    uuid: "12345678-ABCD-1234-ABCD-123456789ABC",
    boot: "2026-10-18T09:20:00.0000000Z",
  }
  const winExecutablePath = String.raw`D:\a\_temp\alacritty\alacritty.exe`
  const winSourcePath = String.raw`D:\a\_temp\measurement-artifacts\Alacritty-v0.17.0-portable.exe`
  const winMesaArchivePath = String.raw`D:\a\_temp\measurement-artifacts\mesa-llvmpipe-x64-26.2.5.7z`
  const winOpenglDllPath = String.raw`D:\a\_temp\alacritty\opengl32.dll`
  const exeSha256 = "5ad70ddc5c2a2bfe84084a2c4c73558e9360914f035a902d7a69277be7249f1f"
  const mesaArchiveSha256 = "d1b713ca2a7fba47a50c058099f13c435ddb76a16a422c334e4d787f9755a31d"
  const openglDllSha256 = "8ddc061ee752fff06ae682de0ac2e010926d76a93c1aecc4c206adee771856e1"
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ jobs: [{ id: 8888, runner_name: "win-runner", status: "in_progress" }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const winNamedExecutableInDir = join(dir, winExecutablePath)
    const versionFixture = join(dir, "alacritty-version.cjs")
    await writeFile(
      versionFixture,
      `#!/usr/bin/env node
const mode = process.env.ALACRITTY_VERSION_MODE || "ok";
if (mode === "ok") {
  process.stdout.write("alacritty 0.17.0 (94e7c88)\\r\\n");
} else if (mode === "nonzero") {
  process.stderr.write("alacritty failed\\n");
  process.exit(2);
} else if (mode === "empty") {
  process.stdout.write("   \\r\\n");
} else if (mode === "bad-regex") {
  process.stdout.write("not-alacritty version output\\n");
} else if (mode === "signal") {
  process.kill(process.pid, "SIGTERM");
} else if (mode === "timeout") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
}
`,
      { mode: 0o755 },
    )
    // Keep the Windows receipt path while the POSIX launcher gives Bun a host-native script path.
    await writeFile(
      winNamedExecutableInDir,
      '#!/bin/sh\nexec "$ALACRITTY_VERSION_RUNTIME" "$ALACRITTY_VERSION_FIXTURE"\n',
      { mode: 0o755 },
    )
    const fakePs = `#!/usr/bin/env node
const cmd = process.argv.slice(2).join(' ');
if (cmd.includes('Get-NetAdapter')) {
  console.log('${raw.mac}');
} else if (cmd.includes('Win32_ComputerSystemProduct')) {
  console.log('${raw.uuid}');
} else if (cmd.includes('Win32_OperatingSystem')) {
  console.log('${raw.boot}');
} else if (cmd.includes('mesaRenderer')) {
  console.log(JSON.stringify({
    platform: 'win32',
    executablePath: ${JSON.stringify(winExecutablePath)},
    executableSha256: ${JSON.stringify(exeSha256)},
    sourceArtifact: { kind: 'portable-exe', path: ${JSON.stringify(winSourcePath)}, sha256: ${JSON.stringify(exeSha256)} },
    mesaRenderer: {
      upstream: process.env.MESA_UPSTREAM,
      version: process.env.MESA_VERSION,
      archivePath: ${JSON.stringify(winMesaArchivePath)},
      archiveSha256: ${JSON.stringify(mesaArchiveSha256)},
      dlls: [{ name: 'opengl32.dll', path: ${JSON.stringify(winOpenglDllPath)}, sha256: ${JSON.stringify(openglDllSha256)} }]
    }
  }));
} else {
  console.log('');
}
`
    await writeFile(join(dir, "powershell.exe"), fakePs, { mode: 0o755 })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected fixture server address")
    const env = {
      ...process.env,
      PATH: `.:${dir}:${process.env.PATH}`,
      APP_ID: "alacritty",
      APP_EXECUTABLE: winExecutablePath,
      APP_SOURCE_ARTIFACT: winSourcePath,
      MESA_UPSTREAM: "https://github.com/mmozeiko/build-mesa",
      MESA_VERSION: "26.2.5",
      MESA_ARCHIVE_PATH: winMesaArchivePath,
      ALACRITTY_VERSION_MODE: "ok",
      ALACRITTY_VERSION_RUNTIME: process.execPath,
      ALACRITTY_VERSION_FIXTURE: versionFixture,
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_NAME: "win-runner",
      RUNNER_OS: "Windows",
      RUNNER_ARCH: "X64",
      RUNNER_TRACKING_ID: "win-tracking",
      ImageOS: "win22",
      ImageVersion: "20261001.1",
      GITHUB_REPOSITORY: "fixture/repo",
      GITHUB_WORKFLOW: "collect",
      GITHUB_WORKFLOW_REF: "collect.yml@main",
      GITHUB_RUN_ID: "89",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_JOB: "collect",
      GH_TOKEN: "fixture-token",
      GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
    }
    const run = (modeOverride: string, ...args: string[]) =>
      promisify(execFile)(
        "node",
        ["--experimental-strip-types", fileURLToPath(new URL("./hosted-runner-receipt.ts", import.meta.url)), ...args],
        { cwd: dir, env: { ...env, ALACRITTY_VERSION_MODE: modeOverride } },
      )
    const start = join(dir, "start.json")
    const receipt = join(dir, "host-measured.json")
    await run("ok", "start", start)
    const emitted = await run("ok", "emit", start, receipt)
    expect(emitted.stderr).toContain('alacritty --version stdout (28 bytes): "alacritty 0.17.0 (94e7c88)\\r\\n"')
    const parsed = parseDisposableReceipt(await readFile(receipt, "utf8"))
    expect(parsed.appLaunch).toEqual({
      platform: "win32",
      executablePath: winExecutablePath,
      productVersion: "0.17.0",
      executableSha256: exeSha256,
      sourceArtifact: {
        kind: "portable-exe",
        path: winSourcePath,
        sha256: exeSha256,
      },
      mesaRenderer: {
        upstream: "https://github.com/mmozeiko/build-mesa",
        version: "26.2.5",
        archivePath: winMesaArchivePath,
        archiveSha256: mesaArchiveSha256,
        dlls: [{ name: "opengl32.dll", path: winOpenglDllPath, sha256: openglDllSha256 }],
      },
    })

    await expect(run("nonzero", "emit", start, join(dir, "nonzero.json"))).rejects.toThrow(
      /alacritty --version failed.*exit 2/,
    )
    await expect(run("empty", "emit", start, join(dir, "empty.json"))).rejects.toThrow(
      /alacritty --version produced empty output/,
    )
    await expect(run("bad-regex", "emit", start, join(dir, "bad-regex.json"))).rejects.toThrow(
      /alacritty --version output did not match version regex/,
    )
    await expect(run("signal", "emit", start, join(dir, "signal.json"))).rejects.toThrow(
      /alacritty --version terminated by signal SIGTERM/,
    )
    await expect(run("timeout", "emit", start, join(dir, "timeout.json"))).rejects.toThrow(
      /alacritty --version timed out/,
    )
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(dir, { recursive: true, force: true })
  }
})

test("a runner name that never appears is refused by name after one bounded budget, never awaited forever", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hosted-receipt-exhaustion-"))
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ jobs: [{ id: 1234, runner_name: "another-runner" }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const fixture = `#!${process.execPath}\nconst n=process.argv[1]; if(n.endsWith('ifconfig')) console.log('ether 02:00:00:00:00:02'); else if(n.endsWith('ioreg')) console.log('"IOPlatformUUID" = "exhaustion-platform"'); else console.log('exhaustion-boot');\n`
    for (const name of ["ifconfig", "ioreg", "sysctl"]) await writeFile(join(dir, name), fixture, { mode: 0o755 })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected fixture server address")
    const started = Date.now()
    let failure: unknown
    try {
      await promisify(execFile)(
        "node",
        [
          "--experimental-strip-types",
          fileURLToPath(new URL("./hosted-runner-receipt.ts", import.meta.url)),
          "start",
          join(dir, "exhaustion.json"),
        ],
        {
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            RUNNER_ENVIRONMENT: "github-hosted",
            RUNNER_NAME: "runner-that-never-registers",
            RUNNER_OS: "macOS",
            RUNNER_ARCH: "ARM64",
            RUNNER_TRACKING_ID: "fixture-tracking",
            ImageOS: "macos26",
            ImageVersion: "fixture-image",
            GITHUB_REPOSITORY: "fixture/repo",
            GITHUB_WORKFLOW: "collect",
            GITHUB_WORKFLOW_REF: "collect.yml@main",
            GITHUB_RUN_ID: "42",
            GITHUB_RUN_ATTEMPT: "1",
            GITHUB_JOB: "collect",
            GH_TOKEN: "fixture-token",
            GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
          },
        },
      )
    } catch (error) {
      failure = error
    }
    const message = failure instanceof Error ? failure.message : String(failure)
    // The refusal names what was looked for, that every attempt spent its full window, and the cap.
    expect(message).toContain('jobs API lookup for "runner-that-never-registers"')
    expect(message).toContain("failed after 3 attempt(s) (cap 3) of 30000ms each")
    expect(message).toContain("total bound 90000ms")
    expect(message).toContain("last HTTP status 200")
    expect(message).toContain("the runner name never appeared in the jobs API")
    expect(Date.now() - started).toBeGreaterThanOrEqual(90_000)
    expect(Date.now() - started).toBeLessThan(130_000)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(dir, { recursive: true, force: true })
  }
}, 140_000)

test("two matching job ids on the first page refuse immediately, without asking for a second page", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hosted-receipt-ambiguous-"))
  const queried: string[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://fixture")
    queried.push(url.searchParams.get("page") ?? "")
    res.setHeader("content-type", "application/json")
    res.end(
      JSON.stringify({
        // A full first page with two matches, and a short second page so the OLD walk terminates and
        // reaches its late refusal instead of burning the budget on endless full pages.
        jobs:
          url.searchParams.get("page") === "1"
            ? Array.from({ length: 100 }, (_, i) => ({
                id: 9000 + i,
                runner_name: i < 2 ? "ambiguous-runner" : `other-${i}`,
              }))
            : [],
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const fixture = `#!${process.execPath}\nconst n=process.argv[1]; if(n.endsWith('ifconfig')) console.log('ether 02:00:00:00:00:03'); else if(n.endsWith('ioreg')) console.log('"IOPlatformUUID" = "ambiguous-platform"'); else console.log('ambiguous-boot');\n`
    for (const name of ["ifconfig", "ioreg", "sysctl"]) await writeFile(join(dir, name), fixture, { mode: 0o755 })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected fixture server address")
    let failure: unknown
    try {
      await promisify(execFile)(
        "node",
        [
          "--experimental-strip-types",
          fileURLToPath(new URL("./hosted-runner-receipt.ts", import.meta.url)),
          "start",
          join(dir, "ambiguous.json"),
        ],
        {
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            RUNNER_ENVIRONMENT: "github-hosted",
            RUNNER_NAME: "ambiguous-runner",
            RUNNER_OS: "macOS",
            RUNNER_ARCH: "ARM64",
            RUNNER_TRACKING_ID: "fixture-tracking",
            ImageOS: "macos26",
            ImageVersion: "fixture-image",
            GITHUB_REPOSITORY: "fixture/repo",
            GITHUB_WORKFLOW: "collect",
            GITHUB_WORKFLOW_REF: "collect.yml@main",
            GITHUB_RUN_ID: "43",
            GITHUB_RUN_ATTEMPT: "1",
            GITHUB_JOB: "collect",
            GH_TOKEN: "fixture-token",
            GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
          },
        },
      )
    } catch (error) {
      failure = error
    }
    const message = failure instanceof Error ? failure.message : String(failure)
    expect(message).toContain("several live jobs claim this runner name")
    expect(message).toMatch(/found 2 \(/)
    expect(message).toContain("pages 1")
    // The approved rule is immediate refusal: a page whose second entry already matches must never cost
    // a second request. Before the fix this array was ["1", "2"].
    expect(queried).toEqual(["1"])
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(dir, { recursive: true, force: true })
  }
})
