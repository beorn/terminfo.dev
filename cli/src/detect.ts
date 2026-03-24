/**
 * Terminal detection — identify the running terminal emulator.
 *
 * Uses environment variables, DA2 response parsing, and fallback heuristics.
 */

import { release } from "node:os"

export interface TerminalInfo {
  name: string
  version: string
  os: string
  osVersion: string
}

/** Known terminal detection via environment variables */
const ENV_DETECTORS: Array<{ env: string; name: string; versionEnv?: string }> = [
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

export function detectTerminal(): TerminalInfo {
  const os = detectOS()
  const osVersion = detectOSVersion()

  // Check specific env vars first
  for (const { env, name } of ENV_DETECTORS) {
    if (process.env[env]) {
      return { name, version: "", os, osVersion }
    }
  }

  // Check $TERM_PROGRAM
  const termProgram = process.env.TERM_PROGRAM
  if (termProgram) {
    const name = TERM_PROGRAM_MAP[termProgram] ?? termProgram.toLowerCase()
    const version = process.env.TERM_PROGRAM_VERSION ?? ""
    return { name, version, os, osVersion }
  }

  // Check $TERMINAL_EMULATOR (set by some Linux terminals)
  const termEmu = process.env.TERMINAL_EMULATOR
  if (termEmu) {
    return { name: termEmu.toLowerCase(), version: "", os, osVersion }
  }

  // Fallback: use $TERM
  const term = process.env.TERM ?? "unknown"
  return { name: term, version: "", os, osVersion }
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
  try {
    return release()
  } catch {
    return ""
  }
}

/**
 * Query terminal identity via DA2 (Secondary Device Attributes).
 * Sends CSI > 0 c and parses the response.
 *
 * Must be called with raw mode enabled on stdin.
 */
export async function queryDA2(
  readResponse: (pattern: RegExp, timeoutMs: number) => Promise<string[] | null>,
): Promise<{ terminalId: number; version: number } | null> {
  process.stdout.write("\x1b[>0c")
  const match = await readResponse(/\x1b\[>(\d+);(\d+);(\d+)c/, 1000)
  if (!match) return null
  return {
    terminalId: parseInt(match[1]!, 10),
    version: parseInt(match[2]!, 10),
  }
}
