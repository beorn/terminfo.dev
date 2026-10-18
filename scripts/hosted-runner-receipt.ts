#!/usr/bin/env node
/** 27910: the one hosted receipt producer. Runs with Node's type stripping before checkout,
 * importing only the parser and Node built-ins. Later workflows add OS sources to the same owner. */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { HOSTED_IDENTITY_SOURCES, parseDisposableReceipt } from "../packages/terminfo.dev/src/disposable-receipt.ts"
import { parseAppLaunchReceipt } from "../packages/run-parser/src/app-launch.ts"

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

function sampleIdentity(): Record<string, string> {
  const os = required("RUNNER_OS")
  if (!Object.hasOwn(HOSTED_IDENTITY_SOURCES, os)) {
    throw new Error(
      `Hosted receipt has no producer for RUNNER_OS=${JSON.stringify(os)}; ratified entries are ${Object.keys(HOSTED_IDENTITY_SOURCES).join(", ")}`,
    )
  }
  const ratified = HOSTED_IDENTITY_SOURCES[os as keyof typeof HOSTED_IDENTITY_SOURCES]
  return Object.fromEntries(
    Object.entries(ratified.sources).map(([field, source]) => {
      if (!("command" in source && "args" in source && "pattern" in source)) {
        throw new Error(`Hosted receipt ${field}: source ${source.source} is not produced by the hosted producer`)
      }
      const result = spawnSync(source.command, source.args, { encoding: "utf8" })
      if (result.error || result.status !== 0) {
        throw new Error(
          `Hosted receipt ${field}: ${source.command} failed with exit ${result.status}, signal ${result.signal}; cannot measure ${source.source}`,
        )
      }
      const value = new RegExp(source.pattern).exec(result.stdout)?.[1]
      if (!value) {
        throw new Error(`Hosted receipt ${field}: ${source.source} returned no value; no identity is substituted`)
      }
      if (/^(0{8}-0{4}-0{4}-0{4}-0{12}|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$/.test(value)) {
        throw new Error(
          `Hosted receipt ${field}: ${source.source} returned degenerate UUID (all-zero or all-F); refusing by name`,
        )
      }
      if (/^00[:-]00[:-]00[:-]00[:-]00[:-]00$/.test(value)) {
        throw new Error(`Hosted receipt ${field}: ${source.source} returned degenerate all-zero MAC; refusing by name`)
      }
      const hash = createHash("sha256").update(value).digest("hex")
      const label =
        "command" in source && "args" in source ? `${source.command} ${source.args.join(" ")}` : source.source
      process.stderr.write(
        `${field}: ${label} · ${source.scope} · ${Buffer.byteLength(value)} bytes · sha256:${hash}\n`,
      )
      return [field, hash]
    }),
  )
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
const CASK_APP_IDS = new Set(["ghostty"])

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

function measureWindowsAlacrittyVersion(executablePath: string): string {
  const result = spawnSync(executablePath, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  })
  const rawStdout = result.stdout ?? ""
  const rawStderr = result.stderr ?? ""
  process.stderr.write(`alacritty --version raw stdout: ${JSON.stringify(rawStdout)}\n`)
  if (rawStderr.trim()) {
    process.stderr.write(`alacritty --version raw stderr: ${JSON.stringify(rawStderr)}\n`)
  }
  if (result.error) {
    throw new Error(
      `Hosted receipt appLaunch: alacritty --version failed at ${executablePath}: ${result.error.message}`,
    )
  }
  if (result.signal !== null || result.status !== 0) {
    throw new Error(
      `Hosted receipt appLaunch: alacritty --version exited ${String(result.status)} (signal ${String(result.signal)}) at ${executablePath}: ${rawStderr.trim() || rawStdout.trim()}`,
    )
  }
  const trimmed = rawStdout.trim()
  if (!trimmed) {
    throw new Error(`Hosted receipt appLaunch: alacritty --version produced empty stdout at ${executablePath}`)
  }
  const match = /^alacritty\s+([^\s]+)(?:\s+\([^\s]+\))?$/.exec(trimmed)
  if (!match?.[1]) {
    throw new Error(
      `Hosted receipt appLaunch: alacritty --version stdout ${JSON.stringify(trimmed)} did not match /^alacritty\\s+([^\\s]+)(?:\\s+\\([^\\s]+\\))?$/`,
    )
  }
  return match[1]
}

function measureWindowsAppLaunchRaw(): Record<string, unknown> {
  const appId = required("APP_ID")
  required("APP_EXECUTABLE")
  required("APP_SOURCE_ARTIFACT")
  if (appId === "windows-terminal") {
    const script = `$ErrorActionPreference = 'Stop'
$expected = Get-Item -LiteralPath $env:APP_EXECUTABLE
if ($expected.PSIsContainer -or $expected.Name -cne 'WindowsTerminal.exe') { throw 'APP_EXECUTABLE must name WindowsTerminal.exe, not its wt.exe launcher' }
$processes = @(Get-CimInstance Win32_Process -Filter "Name='WindowsTerminal.exe'" | Where-Object { $_.ExecutablePath -ieq $expected.FullName })
if ($processes.Count -ne 1) { throw "Expected exactly one launched WindowsTerminal.exe at $($expected.FullName); found $($processes.Count)" }
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
    return JSON.parse(
      measured("launched WindowsTerminal.exe version and retained ZIP bytes", "powershell.exe", [
        "-NoProfile",
        "-Command",
        script,
      ]),
    ) as Record<string, unknown>
  }
  if (appId === "alacritty") {
    const productVersion = measureWindowsAlacrittyVersion(required("APP_EXECUTABLE"))
    const script = `$ErrorActionPreference = 'Stop'
$expected = Get-Item -LiteralPath $env:APP_EXECUTABLE
if ($expected.PSIsContainer -or $expected.Name -cne 'alacritty.exe') { throw 'APP_EXECUTABLE must name alacritty.exe' }
$processes = @(Get-CimInstance Win32_Process -Filter "Name='alacritty.exe'" | Where-Object { $_.ExecutablePath -ieq $expected.FullName })
if ($processes.Count -ne 1) { throw "Expected exactly one launched alacritty.exe at $($expected.FullName); found $($processes.Count)" }
$executable = Get-Item -LiteralPath $processes[0].ExecutablePath
$exeArtifact = Get-Item -LiteralPath $env:APP_SOURCE_ARTIFACT
if ($exeArtifact.PSIsContainer -or $exeArtifact.Extension -ine '.exe' -or $exeArtifact.Length -eq 0 -or $executable.Length -eq 0) { throw 'Windows alacritty executable and retained portable EXE must be nonempty files' }
$exeHash = (Get-FileHash -LiteralPath $executable.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$artifactHash = (Get-FileHash -LiteralPath $exeArtifact.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
if ($exeHash -cne $artifactHash) { throw "Launched alacritty.exe sha256 ($exeHash) does not match retained portable EXE sha256 ($artifactHash)" }
[ordered]@{
  executablePath = $executable.FullName
  executableSha256 = $exeHash
  sourceArtifact = @{ kind = 'portable-exe'; path = $exeArtifact.FullName; sha256 = $artifactHash }
} | ConvertTo-Json -Compress -Depth 4`
    const measuredProcess = JSON.parse(
      measured("launched alacritty.exe process and retained portable EXE bytes", "powershell.exe", [
        "-NoProfile",
        "-Command",
        script,
      ]),
    ) as { executablePath: string; executableSha256: string; sourceArtifact: Record<string, unknown> }
    return {
      platform: "win32",
      executablePath: measuredProcess.executablePath,
      productVersion,
      executableSha256: measuredProcess.executableSha256,
      sourceArtifact: measuredProcess.sourceArtifact,
    }
  }
  throw new Error(`Hosted Windows receipt requires APP_ID=windows-terminal or alacritty; got ${JSON.stringify(appId)}`)
}

/** Measure the portable app process and the artifact this job retained, through the existing apparatus. */
function measureWindowsAppLaunch() {
  const value: unknown = measureWindowsAppLaunchRaw()
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
  if (mode === "c1-probe" && startPath && !receiptPath && !extra) {
    if (!isAbsolute(startPath)) throw new Error("Hosted receipt output paths must be absolute")
    const raw = measureWindowsAppLaunchRaw()
    mkdirSync(dirname(startPath), { recursive: true })
    writeFileSync(startPath, JSON.stringify(raw, null, 2) + "\n")
    return
  }
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
  const identity = sampleIdentity()
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
