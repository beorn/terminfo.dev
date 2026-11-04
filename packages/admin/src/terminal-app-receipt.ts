import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import type { AppLaunchReceipt } from "@terminfo/probe-defs"
import {
  runningTerminal,
  assertOwnedTerminalWindow,
  type TerminalAppWindow,
  type OwnedTerminalWindow,
} from "../../terminfo.dev/src/terminal-app-window.ts"
import { transformInvocation } from "../../run-parser/src/app-launch.ts"
import { run, tty } from "../../terminfo.dev/src/owned-process.ts"

export interface TerminalAppCapture {
  receipt?: AppLaunchReceipt
  trace: Record<string, string | number>
}

/** AppleScript takes a before-ID census and returns its new window ID plus the exact tab TTY. */
export function launchTerminalWindow(scriptPath: string): TerminalAppWindow {
  const script = `tell application "Terminal"
  set AppleScript's text item delimiters to ","
  set priorList to id of every window
  set priorIds to priorList as string
  set t to do script ${JSON.stringify(scriptPath)}
  set launchedTTY to (tty of t) as string
  set inventory to priorIds & linefeed & launchedTTY
  set postIds to id of every window
  repeat with idRef in postIds
    set windowId to contents of idRef
    if priorList does not contain windowId then
      set w to window id windowId
      set tabCount to count of tabs of w
      set onlyTTY to ""
      if tabCount is 1 then set onlyTTY to (tty of tab 1 of w) as string
      set inventory to inventory & linefeed & (windowId as string) & "|" & (tabCount as string) & "|" & onlyTTY
    end if
  end repeat
  return inventory
end tell`
  const output = run("osascript", ["-e", script]).stdout.trimEnd()
  const lines = output.split(/\r?\n/)
  if (lines.length < 3) {
    throw new Error(`Terminal launch returned no new-window/TTY inventory: ${JSON.stringify(output)}`)
  }
  const [before, returnedTTY, ...windows] = lines
  const launchedTTY = tty(returnedTTY ?? "")
  const priorIds = before?.trim() ? before.split(",").map((value) => Number(value.trim())) : []
  if (priorIds.some((id) => !Number.isSafeInteger(id) || id < 1) || new Set(priorIds).size !== priorIds.length) {
    throw new Error("Terminal returned invalid pre-launch window IDs")
  }
  const seen = new Set<number>()
  const matching: number[] = []
  for (const row of windows) {
    const match = /^([1-9]\d*)\|([0-9]+)\|(.*)$/.exec(row)
    const windowId = Number(match?.[1])
    const tabCount = Number(match?.[2])
    if (!match || !Number.isSafeInteger(windowId) || !Number.isSafeInteger(tabCount) || seen.has(windowId)) {
      throw new Error(`Terminal returned invalid or duplicate post-launch window row: ${JSON.stringify(row)}`)
    }
    seen.add(windowId)
    if (priorIds.includes(windowId) || tabCount !== 1 || !match[3]) continue
    if (tty(match[3]) === launchedTTY) matching.push(windowId)
  }
  const [windowId] = matching
  if (matching.length !== 1 || windowId === undefined) {
    throw new Error(
      `Expected exactly one new single-tab Terminal window with returned TTY ${launchedTTY}; found ${matching.length}`,
    )
  }
  return { provider: "terminal-app", windowId, tty: launchedTTY }
}

function plist(bundlePath: string, key: string): string {
  const value = run("/usr/libexec/PlistBuddy", [
    "-c",
    `Print :${key}`,
    join(bundlePath, "Contents", "Info.plist"),
  ]).stdout.trim()
  if (!value) throw new Error(`Terminal Info.plist ${key} is empty`)
  return value
}

function field(raw: string, name: string): string {
  const match = new RegExp(`^\\s*${name}:\\s*(\\S+)\\s*$`, "m").exec(raw)
  if (!match?.[1]) throw new Error(`Terminal system volume missing ${name}`)
  return match[1]
}

const DEVELOPER_ID_REQUIREMENT =
  "=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"

/** The signed-bundle source strategy of this same owned-app measurer. */
function captureSignedBundle(
  window: Exclude<OwnedTerminalWindow, TerminalAppWindow>,
  daemonPid: number,
  invocation?: readonly string[],
): TerminalAppCapture {
  assertOwnedTerminalWindow(window, daemonPid)
  const executablePath = realpathSync(window.executablePath)
  const separator = executablePath.indexOf(".app/Contents/MacOS/")
  if (separator < 0) throw new Error("Owned app executable has no measured macOS bundle path")
  const bundlePath = realpathSync(executablePath.slice(0, separator + 4))
  const measure = () => ({
    cfBundleShortVersionString: plist(bundlePath, "CFBundleShortVersionString"),
    cfBundleVersion: plist(bundlePath, "CFBundleVersion"),
    executableSha256: createHash("sha256").update(readFileSync(executablePath)).digest("hex"),
  })
  const first = measure()
  // Bundle versions are distinct from the selected CLI version; WezTerm's plist is a placeholder.
  const signature = () => {
    const strict = spawnSync("codesign", ["--verify", "--strict", bundlePath], { encoding: "utf8", timeout: 15_000 })
    if (strict.error || strict.signal || strict.status === null || strict.status === 2) {
      throw new Error("Owned app codesign strict verification failed: " + (strict.error?.message ?? strict.stderr))
    }
    const requirement =
      strict.status === 0
        ? spawnSync("codesign", ["--verify", "--strict", "-R", DEVELOPER_ID_REQUIREMENT, bundlePath], {
            encoding: "utf8",
            timeout: 15_000,
          })
        : undefined
    const details = spawnSync("codesign", ["-dv", "--verbose=4", bundlePath], { encoding: "utf8", timeout: 15_000 })
    const raw = String(details.stderr ?? "") + String(details.stdout ?? "")
    if (details.error || details.signal) throw new Error("Owned app codesign display could not run")
    if (strict.status !== 0) {
      if (/code object is not signed at all|^Signature=adhoc$/m.test(raw)) return { absent: "unsigned or ad-hoc", raw }
      throw new Error("Owned app signature is invalid or modified: " + strict.stderr)
    }
    if (!requirement || requirement.error || requirement.signal || details.status !== 0) {
      throw new Error("Owned app codesign requirement or display failed")
    }
    if (requirement.status === 3) return { absent: "not Developer ID", raw }
    if (requirement.status !== 0) {
      throw new Error(
        "Owned app Developer ID requirement failed with exit " + String(requirement.status) + ": " + requirement.stderr,
      )
    }
    const identifier = /^Identifier=(.+)$/m.exec(raw)?.[1]?.trim()
    const cdHash = /^CDHash=([a-fA-F0-9]+)$/m.exec(raw)?.[1]?.toLowerCase()
    if (!identifier || !cdHash || !/^[a-f0-9]{40}$/.test(cdHash))
      throw new Error("Owned app codesign identifier or CDHash is invalid")
    return { codeSignature: { identifier, cdHash, strictVerified: true as const }, raw }
  }
  const observed = signature()
  if (observed.absent) return { trace: { argvAbsentReason: observed.absent, codesignDetailsRaw: observed.raw } }
  assertOwnedTerminalWindow(window, daemonPid)
  const last = measure()
  const checked = signature()
  if (
    realpathSync(window.executablePath) !== executablePath ||
    JSON.stringify(last) !== JSON.stringify(first) ||
    JSON.stringify(checked.codeSignature) !== JSON.stringify(observed.codeSignature)
  ) {
    throw new Error("Owned app bundle facts or signature changed during receipt capture")
  }
  const argv = invocation && transformInvocation(invocation)
  return {
    receipt: {
      bundlePath,
      ...first,
      executablePath,
      sourceArtifact: { kind: "developer-id-signed-bundle", codeSignature: observed.codeSignature! },
      ...(argv && { argv }),
    },
    trace: {
      ownerPid: window.provider === "kitty" ? window.kittyPid : window.ownerPid,
      codesignDetailsRaw: observed.raw,
      ...(argv
        ? {
            argvRedactedIndexes: JSON.stringify(
              argv.flatMap((value, index) => (value === invocation![index] ? [] : [index])),
            ),
          }
        : { argvAbsentReason: "invocation array was not supplied by the launch owner" }),
    },
  }
}

/** Run after private runId registration and /info verification, before the immutable raw write. */
export function captureTerminalAppReceipt(
  window: OwnedTerminalWindow,
  daemonPid: number,
  intendedVersion: string,
  invocation?: readonly string[],
): TerminalAppCapture {
  if (window.provider !== "terminal-app") return captureSignedBundle(window, daemonPid, invocation)
  if (!Number.isSafeInteger(daemonPid) || daemonPid < 1) throw new Error("Invalid owned daemon PID")
  const daemonTtyRaw = run("ps", ["-p", String(daemonPid), "-o", "tty="]).stdout
  const daemonTty = tty(daemonTtyRaw)
  if (daemonTty !== tty(window.tty)) {
    throw new Error(`Owned daemon TTY ${daemonTty} differs from launched tab ${window.tty}`)
  }

  const first = runningTerminal()
  const bundlePath = realpathSync(first.app.bundlePath)
  const executablePath = realpathSync(first.app.executablePath)
  if (bundlePath !== "/System/Applications/Utilities/Terminal.app") {
    throw new Error(`Running Terminal bundle ${bundlePath} is not on the sealed macOS system volume`)
  }
  if (!executablePath.startsWith(`${bundlePath}/Contents/MacOS/`)) {
    throw new Error("Running Terminal executable is outside its resolved bundle")
  }
  const processPathRaw = run("ps", ["-p", String(first.app.pid), "-o", "comm="]).stdout.trim()
  if (realpathSync(processPathRaw) !== executablePath) {
    throw new Error("Running Terminal process executable differs from NSRunningApplication")
  }
  if (plist(bundlePath, "CFBundleIdentifier") !== "com.apple.Terminal") {
    throw new Error("Running bundle is not com.apple.Terminal")
  }
  const cfBundleShortVersionString = plist(bundlePath, "CFBundleShortVersionString")
  const cfBundleVersion = plist(bundlePath, "CFBundleVersion")
  if (cfBundleShortVersionString !== intendedVersion) {
    throw new Error(
      `Measured Terminal.app version ${cfBundleShortVersionString} differs from intended ${intendedVersion}`,
    )
  }
  const executableSha256 = createHash("sha256").update(readFileSync(executablePath)).digest("hex")

  run("codesign", ["--verify", "--strict", executablePath])
  const signature = run("codesign", ["-dv", "--verbose=4", executablePath])
  const details = `${signature.stdout}\n${signature.stderr}`
  const identifier = /^Identifier=(\S+)$/m.exec(details)?.[1]
  const cdHash = /^CDHash=([a-f\d]{40})$/im.exec(details)?.[1]?.toLowerCase()
  if (identifier !== "com.apple.Terminal" || !cdHash) {
    throw new Error("Terminal code signature identifier or CDHash is invalid")
  }

  const macOSBuild = run("sw_vers", ["-buildVersion"]).stdout.trim()
  if (!macOSBuild) throw new Error("Observed macOS build is empty")
  const diskutilInfo = run("diskutil", ["info", "/"]).stdout
  const snapshotUUID = field(diskutilInfo, "APFS Snapshot UUID")
  const snapshotName = field(diskutilInfo, "APFS Snapshot Name")
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(snapshotUUID)) throw new Error("Invalid APFS snapshot UUID")
  if (field(diskutilInfo, "Sealed") !== "Yes") throw new Error("Terminal system volume is not sealed")

  const last = runningTerminal()
  if (
    last.app.pid !== first.app.pid ||
    realpathSync(last.app.bundlePath) !== bundlePath ||
    realpathSync(last.app.executablePath) !== executablePath
  ) {
    throw new Error("Running Terminal PID or executable changed during receipt capture")
  }
  const receipt: AppLaunchReceipt = {
    bundlePath,
    cfBundleShortVersionString,
    cfBundleVersion,
    executablePath,
    executableSha256,
    sourceArtifact: {
      kind: "sealed-macos-system-volume",
      macOSBuild,
      snapshotUUID,
      snapshotName,
      sealed: true,
      codeSignature: { identifier, cdHash, strictVerified: true },
    },
  }
  return {
    receipt,
    trace: {
      windowId: window.windowId,
      tabTty: window.tty,
      daemonPid,
      daemonTty,
      daemonTtyRaw,
      runningApplicationsRaw: first.raw,
      processPathRaw,
      codesignVerify: "exit 0",
      codesignDetailsRaw: details,
      diskutilInfoRaw: diskutilInfo,
      macOSBuild,
      stableRunningApplicationsRaw: last.raw,
    },
  }
}
