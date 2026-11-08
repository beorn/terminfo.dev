/** The owned WezTerm pane's physical rows, through its own CLI. */
import { spawnSync } from "node:child_process"
import { mapSnapshotToCells, type TerminalTextRead } from "./darwin-terminal-text.ts"

interface WezTermTextOptions {
  readonly executable: string
  /** Read by the verified collector child, after its live owner/console check. */
  readonly pane: string | undefined
  readonly socket: string | undefined
  readonly cols: number
  readonly rows: number
  /** Negative start includes retained history; omitted reads only the visible grid. */
  readonly startLine?: number
}

export function readWindowsWezTermRows(
  options: WezTermTextOptions,
):
  | { readonly status: "read"; readonly rows: readonly string[]; readonly receipt: string }
  | { readonly status: "refused"; readonly reason: string } {
  if (!options.socket || !options.pane || !/^\d+$/.test(options.pane)) {
    return {
      status: "refused",
      reason: "WezTerm owned child has no explicit WEZTERM_UNIX_SOCKET and numeric WEZTERM_PANE",
    }
  }
  const result = spawnSync(
    options.executable,
    [
      "cli",
      "--no-auto-start",
      "get-text",
      "--pane-id",
      options.pane,
      "--start-line",
      String(options.startLine ?? 0),
      "--end-line",
      String(options.rows - 1),
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      timeout: 5000,
      env: { ...process.env, WEZTERM_UNIX_SOCKET: options.socket, WEZTERM_PANE: options.pane },
    },
  )
  const retained = JSON.stringify({
    executable: options.executable,
    pane: options.pane,
    socket: options.socket,
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdoutBase64: result.stdout == null ? null : result.stdout.toString("base64"),
    stderrBase64: result.stderr == null ? null : result.stderr.toString("base64"),
  })
  if (result.error || result.signal || result.status !== 0 || result.stdout == null || result.stderr == null) {
    return { status: "refused", reason: `WezTerm owned get-text unavailable: ${retained}` }
  }
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout)
  } catch {
    return { status: "refused", reason: `WezTerm owned get-text did not return UTF-8: ${retained}` }
  }
  // get-text prints one newline per physical row. Remove that one terminator, never trim blank
  // rows or manufacture missing rows. Native qualification decides whether this mapping is usable.
  if (!text.endsWith("\n")) {
    return { status: "refused", reason: `WezTerm get-text returned no complete row terminator: ${retained}` }
  }
  const rows = text.slice(0, text.endsWith("\r\n") ? -2 : -1).split(/\r?\n/u)
  if ((options.startLine ?? 0) < 0 ? rows.length < options.rows : rows.length !== options.rows) {
    return {
      status: "refused",
      reason: `WezTerm get-text returned ${rows.length} rows for ${options.rows}: ${retained}`,
    }
  }
  return { status: "read", rows, receipt: retained }
}

export function readWindowsWezTermText(options: WezTermTextOptions): TerminalTextRead {
  const read = readWindowsWezTermRows(options)
  if (read.status === "refused") return read
  const cells = mapSnapshotToCells(read.rows, options.cols, options.rows, 0)
  if (typeof cells === "string") {
    return { status: "refused", reason: `WezTerm owned text mapping unavailable: ${cells}; ${read.receipt}` }
  }
  return { status: "read", app: "wezterm", cells }
}
