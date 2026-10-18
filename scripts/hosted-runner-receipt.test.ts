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
                runner_name: i === 0 && matches > 0 ? "fixture-runner" : `other-${i}`,
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
  : { CFBundleShortVersionString: "1.3.1", CFBundleVersion: "1", CFBundleExecutable: "ghostty" };
const value = values[process.argv[3]];
if (!value) { console.error("no fixture value for " + process.argv[3]); process.exit(1); }
console.log(value);
`,
      { mode: 0o755 },
    )
    await writeFile(join(dir, "brew"), `#!${process.execPath}\nconsole.log(${JSON.stringify(installer)});\n`, {
      mode: 0o755,
    })
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
    env.APP_ID = "ghostty"
    env.APP_BUNDLE = bundle
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
    matches = 0
    await expect(run("start", join(dir, "unmatched.json"))).rejects.toThrow(/exactly one.*RUNNER_NAME.*found 0/)
    matches = 1
    await writeFile(join(dir, "ifconfig"), `#!${process.execPath}\nprocess.exit(7);\n`, { mode: 0o755 })
    await expect(run("start", join(dir, "failed-source.json"))).rejects.toThrow(/machineIdSha256.*ifconfig.*7/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(dir, { recursive: true, force: true })
  }
})

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
  const hash=(name)=>createHash('sha256').update(readFileSync(${JSON.stringify(dir)}+'/'+name)).digest('hex');
  console.log(JSON.stringify({platform:'win32',executablePath:${JSON.stringify(executablePath)},productVersion:${JSON.stringify(productVersion)},executableSha256:hash('WindowsTerminal.exe'),sourceArtifact:{kind:'portable-zip',path:${JSON.stringify(zipPath)},sha256:hash('wt.zip')}}));
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

test("the hosted producer supports Windows Alacritty with Mesa3D receipt and refuses --version failures by name (C1, C5)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hosted-receipt-win-alacritty-"))
  const raw = {
    mac: "00-15-5D-12-34-56",
    uuid: "12345678-ABCD-1234-ABCD-123456789ABC",
    boot: "2026-10-18T09:20:00.0000000Z",
  }
  const alacrittyScript = join(dir, "alacritty.exe")
  const winExecutablePath = String.raw`D:\a\_temp\alacritty\alacritty.exe`
  const winSourcePath = String.raw`D:\a\_temp\measurement-artifacts\Alacritty-v0.17.0-portable.exe`
  const winMesaArchivePath = String.raw`D:\a\_temp\measurement-artifacts\mesa-llvmpipe-x64-26.2.5.7z`
  const winOpenglDllPath = String.raw`D:\a\_temp\alacritty\opengl32.dll`
  const exeSha256 = "5ad70ddc5c2a2bfe84084a2c4c73558e9360914f035a902d7a69277be7249f1f"
  const mesaArchiveSha256 = "d1b713ca2a7fba47a50c058099f13c435ddb76a16a422c334e4d787f9755a31d"
  const openglDllSha256 = "8ddc061ee752fff06ae682de0ac2e010926d76a93c1aecc4c206adee771856e1"
  const versionMode: "ok" | "nonzero" | "empty" | "bad-regex" | "timeout" = "ok"
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ jobs: [{ id: 8888, runner_name: "win-runner", status: "in_progress" }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const writeAlacritty = () =>
      writeFile(
        alacrittyScript,
        `#!${process.execPath}
const mode = ${JSON.stringify(versionMode)};
if (mode === "ok") {
  process.stdout.write("alacritty 0.17.0 (94e7c88)\\r\\n");
} else if (mode === "nonzero") {
  process.stderr.write("alacritty failed\\n");
  process.exit(2);
} else if (mode === "empty") {
  process.stdout.write("   \\r\\n");
} else if (mode === "bad-regex") {
  process.stdout.write("not-alacritty version output\\n");
} else if (mode === "timeout") {
  process.kill(process.pid, "SIGTERM");
}
`,
        { mode: 0o755 },
      )
    await writeAlacritty()
    // On POSIX test hosts, hosted-runner-receipt spawns measuredLaunch.executablePath directly for --version,
    // while parseAppLaunchReceipt requires a win32 absolute path on Windows receipts. Wait: in hosted-runner-receipt.ts,
    // measureWindowsAlacrittyVersion spawns measuredLaunch.executablePath! So on a POSIX test host, how can spawnSync(executablePath)
    // run if executablePath is `D:\a\_temp\alacritty\alacritty.exe`?
    // Look! If we create a file named `D:\a\_temp\alacritty\alacritty.exe` in `dir` and run with `cwd: dir`, on Linux `D:\a\_temp\alacritty\alacritty.exe` is a valid filename in `cwd` AND `win32.isAbsolute("D:\\a\\_temp\\alacritty\\alacritty.exe")` is true!
    const winNamedExecutableInDir = join(dir, winExecutablePath)
    await writeFile(
      winNamedExecutableInDir,
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
} else if (mode === "timeout") {
  process.kill(process.pid, "SIGTERM");
}
`,
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
    await expect(run("timeout", "emit", start, join(dir, "timeout.json"))).rejects.toThrow(
      /alacritty --version timed out/,
    )
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(dir, { recursive: true, force: true })
  }
})
