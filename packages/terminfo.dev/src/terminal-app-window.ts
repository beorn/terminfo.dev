/** Exact owned Terminal.app window checks and live GUI process identity. No process runs at module load. */
import { spawnSync } from "node:child_process"

export interface OwnedTerminalWindow {
  windowId: number
  tty: string
}

export function run(command: string, args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 15_000 })
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args[0] ?? ""} failed: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`,
    )
  }
  return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") }
}

export function tty(value: string): string {
  const normalized = value.trim().replace(/^\/dev\//, "")
  if (!/^tty[a-zA-Z0-9._-]+$/.test(normalized)) {
    throw new Error(`Invalid Terminal tab or daemon TTY: ${JSON.stringify(value)}`)
  }
  return `/dev/${normalized}`
}

function ownedWindowScript(window: OwnedTerminalWindow, close: boolean): string {
  if (!Number.isSafeInteger(window.windowId) || window.windowId < 1) throw new Error("Invalid owned Terminal window ID")
  const tabTty = tty(window.tty)
  return `tell application "Terminal"
  set matchingWindows to every window whose id is ${window.windowId}
  if (count of matchingWindows) is not 1 then error "owned Terminal window no longer exists uniquely"
  set w to item 1 of matchingWindows
  if (count of tabs of w) is not 1 then error "owned Terminal window has other tabs"
  if (tty of tab 1 of w) is not ${JSON.stringify(tabTty)} then error "owned Terminal tab TTY changed"
  ${close ? "close w" : "return true"}
end tell`
}

/** Refresh the admin's window assertion before handing the worker a claim. */
export function assertOwnedTerminalWindow(window: OwnedTerminalWindow): void {
  run("osascript", ["-e", ownedWindowScript(window, false)])
}

/** Recheck and close atomically in the same AppleScript operation. */
export function closeOwnedTerminalWindow(window: OwnedTerminalWindow): void {
  run("osascript", ["-e", ownedWindowScript(window, true)])
}

interface RunningTerminal {
  pid: number
  bundlePath: string
  executablePath: string
}

const runningTerminalScript = `ObjC.import("AppKit");
var apps=$.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.apple.Terminal");
var out=[];
for(var i=0;i<apps.count;i++){
  var a=apps.objectAtIndex(i);
  out.push({pid:Number(a.processIdentifier),bundlePath:ObjC.unwrap(a.bundleURL.path),executablePath:ObjC.unwrap(a.executableURL.path)});
}
JSON.stringify(out)`

export function runningTerminal(): { app: RunningTerminal; raw: string } {
  const raw = run("osascript", ["-l", "JavaScript", "-e", runningTerminalScript]).stdout.trim()
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Expected exactly one running com.apple.Terminal process")
  }
  const app: unknown = parsed[0]
  if (
    typeof app !== "object" ||
    app === null ||
    !("pid" in app) ||
    !Number.isSafeInteger(app.pid) ||
    Number(app.pid) < 1 ||
    !("bundlePath" in app) ||
    typeof app.bundlePath !== "string" ||
    !app.bundlePath.startsWith("/") ||
    !("executablePath" in app) ||
    typeof app.executablePath !== "string" ||
    !app.executablePath.startsWith("/")
  ) {
    throw new Error("Running Terminal process lacks PID, bundle or executable path")
  }
  return { app: app as RunningTerminal, raw }
}
