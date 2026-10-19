#!/usr/bin/env node
/** 27910: the one hosted receipt producer. Runs with Node's type stripping before checkout,
 * importing only the parser and Node built-ins. Later workflows add OS sources to the same owner. */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { sampleHostedIdentity, parseDisposableReceipt } from "../packages/terminfo.dev/src/disposable-receipt.ts"
import {
  ALACRITTY_VERSION_PATTERN,
  WINDOWS_MESA_RENDERER_DLLS,
  parseAppLaunchReceipt,
} from "../packages/run-parser/src/app-launch.ts"

function required(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Hosted receipt requires environment ${key}; no value was provided`)
  return value
}

function decimal(key: string): string {
  const value = required(key)
  if (/[^0-9]/.test(value)) throw new Error(`Hosted receipt ${key} must contain decimal digits`)
  return value
}

/** Run a measuring command and return its raw stdout. A non-zero exit, a signal, or no output is
 * loud and named: the receipt never substitutes a declared, detected or assumed value (28216). */
function measured(label: string, command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" })
  const detail = result.error?.message ?? (result.stderr || "").trim()
  if (result.error || result.status !== 0) {
    throw new Error(
      `Hosted receipt appLaunch: ${label} failed (${command} exit ${String(result.status)}, signal ${String(result.signal)}): ${detail}`,
    )
  }
  if (!result.stdout.trim()) {
    throw new Error(`Hosted receipt appLaunch: ${label} produced no value (${command}); refusing to invent one`)
  }
  return result.stdout
}

/** sha256 of the exact bytes at `path`. A missing, unreadable or empty file refuses BY NAME: an
 * all-zero or absent digest is what a placeholder looks like, and 28240 refuses those downstream. */
function hashBytes(where: string, path: string): string {
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch (cause) {
    throw new Error(
      `Hosted receipt appLaunch: cannot read ${where} at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
  }
  if (bytes.length === 0) throw new Error(`Hosted receipt appLaunch: ${where} at ${path} is empty; no bytes to hash`)
  return createHash("sha256").update(bytes).digest("hex")
}

function plistValue(plistPath: string, key: string): string {
  return measured(`Info.plist ${key}`, "plutil", ["-extract", key, "raw", "-o", "-", plistPath]).trim()
}

/** The apps this apparatus installs from a Homebrew cask, and the ones it installs another way.
 * A bundle this producer has no measured installer for is refused by name rather than described. */
const CASK_APP_IDS = new Set(["ghostty", "wezterm"])

/** Terminal.app is an OS component, not something this job installed: its source artifact is the
 * sealed system volume's snapshot and code signature, measured exactly as the owned Terminal.app
 * route measured it (packages/admin/src/terminal-app-receipt.ts), never a path plus a placeholder. */
function measureSealedSystemVolume(bundlePath: string, executablePath: string): Record<string, unknown> {
  if (bundlePath !== "/System/Applications/Utilities/Terminal.app") {
    throw new Error(
      `Hosted receipt appLaunch: terminal-app resolved to ${bundlePath}, not the sealed macOS system volume; refusing by name`,
    )
  }
  const verify = spawnSync("codesign", ["--verify", "--strict", executablePath], { encoding: "utf8" })
  if (verify.error || verify.status !== 0) {
    throw new Error(
      `Hosted receipt appLaunch: codesign --verify --strict refused ${executablePath}: ${verify.error?.message ?? (verify.stderr || "").trim()}`,
    )
  }
  const signature = spawnSync("codesign", ["-dv", "--verbose=4", executablePath], { encoding: "utf8" })
  const details = `${signature.stdout}${signature.stderr}`
  const identifier = /^Identifier=(\S+)$/m.exec(details)?.[1]
  const cdHash = /^CDHash=([a-f\d]{40})$/im.exec(details)?.[1]?.toLowerCase()
  if (identifier !== "com.apple.Terminal" || !cdHash) {
    throw new Error(
      `Hosted receipt appLaunch: Terminal code signature identifier or CDHash is invalid (${JSON.stringify({ identifier, cdHash })}); refusing by name`,
    )
  }
  const macOSBuild = measured("sw_vers -buildVersion", "sw_vers", ["-buildVersion"]).trim()
  const diskutilInfo = measured("diskutil info /", "diskutil", ["info", "/"])
  const field = (name: string): string => {
    const match = new RegExp(`^\\s*${name}:\\s*(\\S+)\\s*$`, "m").exec(diskutilInfo)?.[1]
    if (!match) throw new Error(`Hosted receipt appLaunch: diskutil info / does not report ${name}; refusing by name`)
    return match
  }
  const snapshotUUID = field("APFS Snapshot UUID")
  const snapshotName = field("APFS Snapshot Name")
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(snapshotUUID)) {
    throw new Error(`Hosted receipt appLaunch: invalid APFS snapshot UUID ${JSON.stringify(snapshotUUID)}`)
  }
  if (field("Sealed") !== "Yes") throw new Error("Hosted receipt appLaunch: the Terminal system volume is not sealed")
  return {
    kind: "sealed-macos-system-volume",
    macOSBuild,
    snapshotUUID,
    snapshotName,
    sealed: true,
    codeSignature: { identifier, cdHash, strictVerified: true },
  }
}

/** The launch receipt for the app this job installed and launched. Every field is measured from the
 * bundle's own Info.plist, the executable's bytes, or the installer bytes this job installed; the
 * collector only copies the parsed block into origin.appLaunch (28216). */
function measureAppLaunch(): Record<string, unknown> {
  const appId = required("APP_ID")
  const bundlePath = realpathSync(required("APP_BUNDLE"))
  const plistPath = join(bundlePath, "Contents", "Info.plist")
  let executablePath: string
  try {
    executablePath = realpathSync(join(bundlePath, "Contents", "MacOS", plistValue(plistPath, "CFBundleExecutable")))
  } catch (cause) {
    throw new Error(
      `Hosted receipt appLaunch: cannot resolve the CFBundleExecutable of ${bundlePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
  }
  if (!executablePath.startsWith(`${bundlePath}/Contents/MacOS/`)) {
    throw new Error(
      `Hosted receipt appLaunch: executable ${executablePath} is outside its resolved bundle ${bundlePath}`,
    )
  }
  let sourceArtifact: Record<string, unknown>
  if (appId === "terminal-app") {
    sourceArtifact = measureSealedSystemVolume(bundlePath, executablePath)
  } else if (appId === "iterm2") {
    const installer = join(required("RUNNER_TEMP"), "iTerm2-3_6_11.zip")
    sourceArtifact = { path: installer, sha256: hashBytes("the installed iTerm2-3_6_11.zip", installer) }
  } else if (appId === "alacritty") {
    const installer = join(required("RUNNER_TEMP"), "Alacritty.dmg")
    sourceArtifact = { path: installer, sha256: hashBytes("the installed Alacritty.dmg", installer) }
  } else if (CASK_APP_IDS.has(appId)) {
    const installer = measured(`brew --cache --cask ${appId}`, "brew", ["--cache", "--cask", appId]).trim()
    sourceArtifact = { path: installer, sha256: hashBytes(`the cached ${appId} cask installer`, installer) }
  } else {
    throw new Error(
      `Hosted receipt appLaunch: no measured source-artifact route for APP_ID=${JSON.stringify(appId)}; name the installer it was installed from`,
    )
  }
  return {
    bundlePath,
    cfBundleShortVersionString: plistValue(plistPath, "CFBundleShortVersionString"),
    cfBundleVersion: plistValue(plistPath, "CFBundleVersion"),
    executablePath,
    executableSha256: hashBytes(`the ${appId} executable`, executablePath),
    sourceArtifact,
  }
}

/** Measure Alacritty's version on Windows from the launched executable's own `--version` output.
 * Refuses loudly on nonzero exit, signal termination, timeout, empty output, or no regex match, and logs raw stdout to stderr. */
function measureWindowsAlacrittyVersion(executablePath: string): string {
  const result = spawnSync(executablePath, ["--version"], { encoding: "utf8", timeout: 3_000, windowsHide: true })
  const rawStdout = result.stdout ?? ""
  const rawStderr = result.stderr ?? ""
  process.stderr.write(
    `alacritty --version stdout (${Buffer.byteLength(rawStdout)} bytes): ${JSON.stringify(rawStdout)}\n`,
  )
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    throw new Error(`Hosted receipt appLaunch: alacritty --version timed out at ${executablePath}`)
  }
  if (result.signal) {
    throw new Error(
      `Hosted receipt appLaunch: alacritty --version terminated by signal ${result.signal} (${executablePath})`,
    )
  }
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? rawStderr.trim()
    throw new Error(
      `Hosted receipt appLaunch: alacritty --version failed (${executablePath} exit ${String(result.status)}): ${detail}`,
    )
  }
  if (!rawStdout.trim()) {
    throw new Error(`Hosted receipt appLaunch: alacritty --version produced empty output (${executablePath})`)
  }
  const match = ALACRITTY_VERSION_PATTERN.exec(rawStdout.trim())
  if (!match?.[1]) {
    throw new Error(
      `Hosted receipt appLaunch: alacritty --version output did not match version regex (${executablePath}): ${JSON.stringify(rawStdout)}`,
    )
  }
  return match[1]
}

/** Measure the portable app process and the artifact this job retained, through the existing apparatus. */
function measureWindowsAppLaunch() {
  const appId = required("APP_ID")
  required("APP_EXECUTABLE")
  required("APP_SOURCE_ARTIFACT")
  let value: unknown
  if (appId === "windows-terminal" || appId === "wezterm") {
    const expectedExecutable = appId === "windows-terminal" ? "WindowsTerminal.exe" : "wezterm-gui.exe"
    const script = `$ErrorActionPreference = 'Stop'
$expected = Get-Item -LiteralPath $env:APP_EXECUTABLE
if ($expected.PSIsContainer -or $expected.Name -cne '${expectedExecutable}') { throw 'APP_EXECUTABLE must name ${expectedExecutable}' }
$processes = @(Get-CimInstance Win32_Process -Filter "Name='${expectedExecutable}'" | Where-Object { $_.ExecutablePath -ieq $expected.FullName })
if ($processes.Count -ne 1) { throw "Expected exactly one launched ${expectedExecutable} at $($expected.FullName); found $($processes.Count)" }
$executable = Get-Item -LiteralPath $processes[0].ExecutablePath
$zip = Get-Item -LiteralPath $env:APP_SOURCE_ARTIFACT
if ($zip.PSIsContainer -or $zip.Extension -ine '.zip' -or $zip.Length -eq 0 -or $executable.Length -eq 0) { throw 'Windows executable and retained portable ZIP must be nonempty files' }
$productVersion = $executable.VersionInfo.ProductVersion
if ([string]::IsNullOrWhiteSpace($productVersion)) { throw "No measured ProductVersion on $($executable.FullName)" }
[ordered]@{
  platform = 'win32'
  executablePath = $executable.FullName
  productVersion = $productVersion
  executableSha256 = (Get-FileHash -LiteralPath $executable.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  sourceArtifact = @{ kind = 'portable-zip'; path = $zip.FullName; sha256 = (Get-FileHash -LiteralPath $zip.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
} | ConvertTo-Json -Compress -Depth 4`
    value = JSON.parse(
      measured(`launched ${expectedExecutable} version and retained ZIP bytes`, "powershell.exe", [
        "-NoProfile",
        "-Command",
        script,
      ]),
    )
  } else if (appId === "alacritty") {
    required("MESA_UPSTREAM")
    required("MESA_VERSION")
    required("MESA_ARCHIVE_PATH")
    const script = `$ErrorActionPreference = 'Stop'
$expected = Get-Item -LiteralPath $env:APP_EXECUTABLE
if ($expected.PSIsContainer -or $expected.Name -ine 'alacritty.exe') { throw 'APP_EXECUTABLE must name alacritty.exe' }
$processes = @(Get-CimInstance Win32_Process -Filter "Name='alacritty.exe'" | Where-Object { $_.ExecutablePath -ieq $expected.FullName })
if ($processes.Count -ne 1) { throw "Expected exactly one launched alacritty.exe at $($expected.FullName); found $($processes.Count)" }
$executable = Get-Item -LiteralPath $processes[0].ExecutablePath
$sourceExe = Get-Item -LiteralPath $env:APP_SOURCE_ARTIFACT
if ($sourceExe.PSIsContainer -or $sourceExe.Extension -ine '.exe' -or $sourceExe.Length -eq 0 -or $executable.Length -eq 0) { throw 'Alacritty executable and retained portable EXE must be nonempty files' }
$mesaArchive = Get-Item -LiteralPath $env:MESA_ARCHIVE_PATH
if ($mesaArchive.PSIsContainer -or $mesaArchive.Length -eq 0) { throw 'Mesa renderer archive must be a nonempty file' }
$dllFiles = @(Get-ChildItem -LiteralPath $executable.DirectoryName -Filter '*.dll' -File | Sort-Object Name)
${WINDOWS_MESA_RENDERER_DLLS.map((dll) => `if ($dllFiles.Count -eq 0 -or -not ($dllFiles | Where-Object { $_.Name -ieq '${dll}' })) { throw "Expected ${dll} beside $($executable.FullName)" }`).join("\n")}
$dlls = @($dllFiles | ForEach-Object {
  [ordered]@{
    name = $_.Name
    path = $_.FullName
    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
})
[ordered]@{
  platform = 'win32'
  executablePath = $executable.FullName
  executableSha256 = (Get-FileHash -LiteralPath $executable.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  sourceArtifact = @{ kind = 'portable-exe'; path = $sourceExe.FullName; sha256 = (Get-FileHash -LiteralPath $sourceExe.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
  mesaRenderer = [ordered]@{
    upstream = $env:MESA_UPSTREAM
    version = $env:MESA_VERSION
    archivePath = $mesaArchive.FullName
    archiveSha256 = (Get-FileHash -LiteralPath $mesaArchive.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    dlls = $dlls
  }
} | ConvertTo-Json -Compress -Depth 6`
    const measuredLaunch = JSON.parse(
      measured("launched alacritty.exe, retained portable EXE, and Mesa3D DLL bytes", "powershell.exe", [
        "-NoProfile",
        "-Command",
        script,
      ]),
    ) as Record<string, unknown>
    if (typeof measuredLaunch.executablePath !== "string") {
      throw new Error("Hosted receipt appLaunch: powershell measurement returned no executablePath")
    }
    const productVersion = measureWindowsAlacrittyVersion(measuredLaunch.executablePath)
    value = { ...measuredLaunch, productVersion }
  } else {
    throw new Error(
      `Hosted Windows receipt requires APP_ID=windows-terminal, APP_ID=alacritty or APP_ID=wezterm; received ${JSON.stringify(appId)}`,
    )
  }
  const receipt = parseAppLaunchReceipt(value, "collector", "app", "Hosted Windows launch measurement")
  if (receipt?.platform !== "win32") throw new Error("Hosted Windows launch measurement has no win32 receipt")
  return receipt
}

async function context() {
  const repository = required("GITHUB_REPOSITORY")
  const githubRunId = decimal("GITHUB_RUN_ID")
  const githubRunAttempt = decimal("GITHUB_RUN_ATTEMPT")
  const name = required("RUNNER_NAME")
  const endpoint = `${required("GITHUB_API_URL")}/repos/${repository}/actions/runs/${githubRunId}/attempts/${githubRunAttempt}/jobs`
  const token = required("GH_TOKEN")
  const matches: number[] = []
  for (let page = 1; ; page++) {
    const url = `${endpoint}?per_page=100&page=${page}`
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      throw new Error(
        `Hosted receipt jobs API ${url} returned HTTP ${response.status}; no numeric job id can be measured`,
      )
    }
    const body = (await response.json()) as { jobs?: unknown }
    if (!Array.isArray(body.jobs)) throw new Error(`Hosted receipt jobs API ${url} returned no jobs array`)
    for (const job of body.jobs as Array<{ runner_name?: unknown; id?: unknown }>) {
      if (job.runner_name !== name) continue
      if (typeof job.id !== "number" || !Number.isSafeInteger(job.id) || job.id < 0) {
        throw new Error(
          `Hosted receipt jobs API ${url}: matching RUNNER_NAME has no safe numeric id; GITHUB_JOB is a YAML key`,
        )
      }
      matches.push(job.id)
    }
    if (body.jobs.length < 100) break
  }
  if (matches.length !== 1) {
    throw new Error(
      `Hosted receipt requires exactly one jobs-API RUNNER_NAME match for ${JSON.stringify(name)} at ${endpoint}; found ${matches.length}`,
    )
  }
  return {
    job: {
      repository,
      workflow: required("GITHUB_WORKFLOW"),
      workflowRef: required("GITHUB_WORKFLOW_REF"),
      githubRunId,
      githubRunAttempt,
      job: required("GITHUB_JOB"),
      jobId: String(matches[0]),
    },
    runner: {
      environment: required("RUNNER_ENVIRONMENT"),
      name,
      os: required("RUNNER_OS"),
      arch: required("RUNNER_ARCH"),
      imageOS: required("ImageOS"),
      imageVersion: required("ImageVersion"),
      trackingId: required("RUNNER_TRACKING_ID"),
    },
  }
}

async function main(): Promise<void> {
  const [mode, startPath, receiptPath, extra] = process.argv.slice(2)
  if ((mode !== "start" && mode !== "emit") || !startPath || (mode === "emit" ? !receiptPath : receiptPath) || extra) {
    throw new Error(
      "Usage: hosted-runner-receipt.ts start <absolute-start.json> | emit <absolute-start.json> <absolute-host-measured.json>",
    )
  }
  if (!isAbsolute(startPath) || (receiptPath && !isAbsolute(receiptPath))) {
    throw new Error("Hosted receipt output paths must be absolute")
  }
  if (required("RUNNER_ENVIRONMENT") !== "github-hosted") {
    throw new Error("Hosted receipt requires RUNNER_ENVIRONMENT=github-hosted; never assumed")
  }
  // Sampling precedes API lookup/setup. No raw source value leaves this function.
  const identity = sampleHostedIdentity(required)
  const current = await context()
  if (mode === "start") {
    mkdirSync(dirname(startPath), { recursive: true })
    writeFileSync(startPath, JSON.stringify({ phase: "job-start", ...current, identity }) + "\n", {
      flag: "wx",
      mode: 0o600,
    })
    return
  }
  let first: Awaited<ReturnType<typeof context>> & { phase: string; identity: Record<string, string> }
  try {
    first = JSON.parse(readFileSync(startPath, "utf8")) as typeof first
  } catch (cause) {
    throw new Error(
      `Hosted receipt cannot read job-start sample ${startPath}; sample in the first job step before collecting`,
      { cause },
    )
  }
  if (
    !first ||
    first.phase !== "job-start" ||
    JSON.stringify(first.job) !== JSON.stringify(current.job) ||
    JSON.stringify(first.runner) !== JSON.stringify(current.runner)
  ) {
    throw new Error(
      `Hosted receipt job-start sample ${startPath} does not describe this job/runner; refuse the handoff`,
    )
  }
  const runId = createHash("sha256")
    .update(
      [
        "github-hosted-runner",
        current.job.repository,
        current.job.githubRunId,
        current.job.githubRunAttempt,
        current.job.jobId,
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 32)
  // Both hosted app routes measure their launch; a declared installation version is never evidence.
  const os = required("RUNNER_OS")
  const appLaunch = os === "macOS" ? measureAppLaunch() : os === "Windows" ? measureWindowsAppLaunch() : undefined
  const bytes =
    JSON.stringify(
      {
        schemaVersion: 1,
        kind: "github-hosted-runner",
        runId,
        collectedAt: new Date().toISOString(),
        ...current,
        vm: { identityAtJobStart: first.identity, identityAtCollection: identity },
        ...(appLaunch && { appLaunch }),
      },
      null,
      2,
    ) + "\n"
  if (!receiptPath) throw new Error("Hosted receipt emit requires its explicit receipt path")
  mkdirSync(dirname(receiptPath), { recursive: true })
  writeFileSync(receiptPath, bytes, { flag: "wx", mode: 0o444 })
  // Write THEN parse the exact persisted bytes. Shell callers must stop on any parser failure.
  parseDisposableReceipt(readFileSync(receiptPath, "utf8"))
}

await main().catch((cause: unknown) => {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`)
  process.exitCode = 1
})
