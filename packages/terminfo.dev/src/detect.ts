/**
 * Terminal detection — identify the running terminal emulator.
 *
 * Uses environment variables, macOS bundle metadata, and fallback heuristics.
 */

import { release } from "node:os"
import { execFileSync, spawnSync } from "node:child_process"
import { ALACRITTY_VERSION_PATTERN } from "@terminfo/run-parser"
import { hasWindowsKernel32Ffi } from "./windows-kernel32.ts"
import { detectHostedWindowsAncestor } from "./windows-process-ancestry.ts"

export interface TerminalInfo {
  name: string
  version: string
  os: string
  osVersion: string
}

/** Known terminal detection via environment variables */
const ENV_DETECTORS: Array<{ env: string; name: string }> = [
  { env: "GHOSTTY_RESOURCES_DIR", name: "ghostty" },
  { env: "KITTY_WINDOW_ID", name: "kitty" },
  { env: "WEZTERM_EXECUTABLE", name: "wezterm" },
  { env: "ALACRITTY_WINDOW_ID", name: "alacritty" },
]

/** Detect from $TERM_PROGRAM */
const TERM_PROGRAM_MAP: Record<string, string> = {
  iTerm: "iterm2",
  "iTerm.app": "iterm2",
  Apple_Terminal: "terminal-app",
  WezTerm: "wezterm",
  vscode: "vscode",
  Hyper: "hyper",
  tmux: "tmux",
  WarpTerminal: "warp",
}

/** Known macOS bundle IDs for version lookup */
const BUNDLE_IDS: Record<string, string> = {
  cmux: "com.cmuxterm.app",
  cursor: "com.todesktop.230313mzl4w4u92",
  ghostty: "com.mitchellh.ghostty",
  kitty: "net.kovidgoyal.kitty",
  iterm2: "com.googlecode.iterm2",
  "terminal-app": "com.apple.Terminal",
  wezterm: "org.wezfurlong.wezterm",
  alacritty: "org.alacritty",
  warp: "dev.warp.Warp-Stable",
}

export function detectTerminal(): TerminalInfo {
  const os = detectOS()
  const osVersion = detectOSVersion()

  // A mux pane inherits its outer app's bundle and environment. These are only hints:
  // the identity resolver must still match the terminal's own complete protocol replies.
  const tmux = Boolean(process.env.TMUX)
  const screen = Boolean(process.env.STY)
  if (tmux && screen) {
    throw new Error("Terminal identity: TMUX and STY are both present; nested mux identity is ambiguous")
  }
  if (tmux || screen) return { name: tmux ? "tmux" : "screen", version: "", os, osVersion }

  let name = "unknown"
  let version = ""
  let windowsAncestorExecutablePath: string | null = null

  // On macOS, __CFBundleIdentifier is the most reliable — set by the actual running app
  const bundleId = process.env.__CFBundleIdentifier
  if (bundleId && os === "macos") {
    for (const [termName, bid] of Object.entries(BUNDLE_IDS)) {
      if (bundleId === bid) {
        name = termName
        break
      }
    }
    // If bundle ID didn't match known terminals, show the full bundle ID
    if (name === "unknown" && bundleId) {
      name = bundleId
    }
  }

  // Check $TERM_PROGRAM (more reliable than env var detectors for cross-app scenarios)
  if (name === "unknown") {
    const termProgram = process.env.TERM_PROGRAM
    if (termProgram) {
      name = TERM_PROGRAM_MAP[termProgram] ?? termProgram.toLowerCase()
      version = process.env.TERM_PROGRAM_VERSION ?? ""
    }
  }

  // Check specific env vars (may be inherited from parent, so lower priority)
  if (name === "unknown") {
    for (const { env, name: n } of ENV_DETECTORS) {
      if (process.env[env]) {
        name = n
        break
      }
    }
  }

  // Check $TERMINAL_EMULATOR (Linux)
  if (name === "unknown") {
    const termEmu = process.env.TERMINAL_EMULATOR
    if (termEmu) name = termEmu.toLowerCase()
  }

  // Linux: check common env vars
  if (name === "unknown") {
    if (process.env.GNOME_TERMINAL_SCREEN) name = "gnome-terminal"
    else if (process.env.KONSOLE_VERSION) {
      name = "konsole"
      version = process.env.KONSOLE_VERSION
    } else if (process.env.TILIX_ID) name = "tilix"
  }

  // Windows: check for Windows Terminal or a proven hosted terminal ancestor
  if (name === "unknown" && os === "windows") {
    if (process.env.WT_SESSION) {
      name = "windows-terminal"
    } else if (hasWindowsKernel32Ffi()) {
      const ancestor = detectHostedWindowsAncestor()
      if (ancestor) {
        name = ancestor.app.id
        windowsAncestorExecutablePath = ancestor.executablePath
      }
    }
  }

  // Fallback: $TERM
  if (name === "unknown") {
    name = process.env.TERM ?? "unknown"
  }

  // On macOS, get version from app bundle if we don't have it yet
  if (!version && os === "macos") {
    version = getMacOSAppVersion(name)
  }

  // On Windows, get version from app/package metadata if we don't have it yet
  if (!version && os === "windows") {
    version = getWindowsAppVersion(name, windowsAncestorExecutablePath)
  }

  return { name, version, os, osVersion }
}

/**
 * Get app version on Windows.
 * For Windows Terminal, queries package version or executable ProductVersion via PowerShell.
 * For Alacritty, queries `--version` ONLY on the proven ancestor executable path (no PATH or Get-Command fallback).
 */
export function getWindowsAppVersion(terminalName: string, ancestorExecutablePath: string | null = null): string {
  try {
    if (terminalName === "windows-terminal") {
      const script = [
        "$v = (Get-AppxPackage *WindowsTerminal* -ErrorAction SilentlyContinue | Select-Object -First 1).Version",
        "if (-not $v) { $cmd = Get-Command wt.exe -ErrorAction SilentlyContinue; if ($cmd) { $v = (Get-Item $cmd.Source).VersionInfo.ProductVersion } }",
        "if (-not $v) { $item = Get-ChildItem 'C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal*\\wt.exe' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($item) { $v = (Get-Item $item.FullName).VersionInfo.ProductVersion } }",
        "if ($v) { Write-Output $v.Trim() }",
      ].join("; ")
      const version = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf-8",
        timeout: 3000,
      }).trim()
      return version
    }
    if (terminalName === "alacritty") {
      if (!ancestorExecutablePath) return ""
      const result = spawnSync(ancestorExecutablePath, ["--version"], {
        encoding: "utf8",
        timeout: 3000,
        windowsHide: true,
      })
      if (result.error || result.status !== 0) return ""
      return ALACRITTY_VERSION_PATTERN.exec((result.stdout ?? "").trim())?.[1] ?? ""
    }
    return ""
  } catch {
    return ""
  }
}

/**
 * Get app version from macOS bundle metadata.
 * Uses $__CFBundleIdentifier → mdfind → PlistBuddy.
 */
function getMacOSAppVersion(terminalName: string): string {
  try {
    // Try __CFBundleIdentifier first (set by the running app)
    let bundleId = process.env.__CFBundleIdentifier
    if (!bundleId) bundleId = BUNDLE_IDS[terminalName]
    if (!bundleId) return ""

    // Find app path from bundle ID
    const appPath = execFileSync("mdfind", [`kMDItemCFBundleIdentifier == '${bundleId}'`], {
      encoding: "utf-8",
      timeout: 3000,
    })
      .trim()
      .split("\n")[0]

    if (!appPath) return ""

    // Read version from Info.plist
    const version = execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleShortVersionString", `${appPath}/Contents/Info.plist`],
      { encoding: "utf-8", timeout: 2000 },
    ).trim()

    return version
  } catch {
    return ""
  }
}

function detectOS(): string {
  switch (process.platform) {
    case "darwin":
      return "macos"
    case "linux":
      return "linux"
    case "win32":
      return "windows"
    default:
      return process.platform
  }
}

function detectOSVersion(): string {
  if (process.platform === "darwin") {
    let version: string
    try {
      version = execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
        encoding: "utf8",
        timeout: 2000,
        maxBuffer: 128,
      }).trim()
    } catch (error) {
      throw new Error(`sw_vers -productVersion failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!/^[1-9]\d{0,2}\.(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2}))?$/.test(version)) {
      throw new Error(`sw_vers -productVersion returned invalid macOS version: ${JSON.stringify(version)}`)
    }
    return version
  }
  try {
    return release()
  } catch {
    return ""
  }
}

/**
 * Query terminal identity via DA2 (Secondary Device Attributes).
 * Must be called with raw mode enabled on stdin.
 */
export async function queryDA2(
  readResponse: (pattern: RegExp, timeoutMs: number) => Promise<string[] | null>,
): Promise<{ terminalId: number; version: number } | null> {
  process.stdout.write("\x1b[>0c")
  const match = await readResponse(/\x1b\[>(\d+);(\d+);(\d+)c/, 1000)
  if (!match) return null
  const [, terminalId, version] = match
  if (terminalId === undefined || version === undefined) {
    throw new Error("DA2 response is missing the expected terminal ID or version capture")
  }
  return {
    terminalId: parseInt(terminalId, 10),
    version: parseInt(version, 10),
  }
}
