import { execFileSync, spawnSync } from "node:child_process"

type ItermSurface = { surface: "local" } | { surface: "hosted"; bundle: string }

export function launchIterm(command: string, config: ItermSurface): number | undefined {
  if (config.surface === "local") {
    const output = execFileSync(
      "osascript",
      [
        "-e",
        `tell application "iTerm"
  set w to create window with default profile command ${JSON.stringify(command)}
  return id of w
end tell`,
      ],
      { encoding: "utf8", timeout: 15_000 },
    ).trim()
    const windowId = Number(output)
    if (!Number.isInteger(windowId)) throw new Error(`iTerm did not return the launched window ID: ${output}`)
    return windowId
  }
  const { bundle } = config
  // Hosted AppleEvents/TCC is unmeasured. Retire this open primitive only after a
  // Chief-granted hosted run qualifies AppleScript startup, window id/close and process state.
  const run = (name: string, file: string, args: string[], timeout = 5000) => {
    const result = spawnSync(file, args, { encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 262144 })
    process.stdout.write(
      JSON.stringify({
        name,
        file,
        args,
        status: result.status,
        signal: result.signal,
        error: result.error?.message,
        stdout: result.stdout,
        stderr: result.stderr,
        stdoutBytes: Buffer.byteLength(result.stdout || ""),
        stderrBytes: Buffer.byteLength(result.stderr || ""),
      }) + "\n",
    )
    if (result.error || result.signal) {
      throw new Error(`iTerm2 ${name} failed: ${result.error?.message || result.signal}`)
    }
    return result
  }
  const plist = `${bundle}/Contents/Info.plist`
  const id = run("bundle identifier", "/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist])
  if (id.status !== 0 || id.stdout.trim() !== "com.googlecode.iterm2") {
    throw new Error("iTerm2 bundle identifier mismatch")
  }
  const version = run("version", "/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", plist])
  if (version.status !== 0 || version.stdout.trim() !== "3.6.11") {
    throw new Error("iTerm2 version must be 3.6.11; renewed qualification required")
  }
  const existing = run("pgrep", "/usr/bin/pgrep", ["-x", "iTerm2"])
  if (existing.status === 0) throw new Error("iTerm2 already running; refusing to attach")
  if (existing.status !== 1) throw new Error(`iTerm2 pgrep failed (${existing.status})`)
  // Set the fresh runner's preference before launch: iTerm treats trailing YES as a file to run.
  const policy = run("startup policy", "/usr/bin/defaults", [
    "write",
    "com.googlecode.iterm2",
    "OpenNoWindowsAtStartup",
    "-bool",
    "true",
  ])
  if (policy.status !== 0) throw new Error(`iTerm2 startup policy failed (${policy.status})`)
  const opened = run("open", "/usr/bin/open", ["-a", bundle, "--args", command], 10000)
  if (opened.status !== 0) throw new Error(`iTerm2 open failed (${opened.status})`)
}

export function closeIterm(windowId: number): void {
  execFileSync("osascript", ["-e", `tell application "iTerm" to close (first window whose id is ${windowId})`], {
    timeout: 5000,
  })
}
