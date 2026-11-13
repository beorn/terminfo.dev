/**
 * The pinned WezTerm's own retained history, read from the pane this run owns (31741).
 *
 * Two facts make the read ours rather than "a WezTerm on this Mac": the CLI is given this run's
 * WEZTERM_UNIX_SOCKET, so a second running WezTerm is unreachable, and the pane it names must appear in
 * that socket's own pane list. Where the arm measured the owned process's TTY, the listed pane's TTY must
 * be that TTY too, so a pane number reused by another window is a named refusal instead of a reading of
 * someone else's screen. `wezterm cli get-text --pane-id` always carries the id; there is no ambient pane.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join } from "node:path"
import { readWindowsWezTermRows } from "./windows-wezterm-text.ts"

/**
 * 31741: the WezTerm CLI that can read an OWNED pane's history, or undefined when this run owns no WezTerm pane.
 *
 * Linux takes the binary beside the owned terminal's own executable, so the writer and the reader are one install.
 * macOS takes the one the child publishes in WEZTERM_EXECUTABLE when that is an absolute path, else the app
 * bundle's CLI — a relative or empty declaration is not a program this run chose, and WezTerm.app's
 * CFBundleExecutable is wezterm-gui, the app, not this CLI. No other platform has this surface: answering there
 * would hand a binary the run never chose the run's own socket.
 */
export function ownedWezTermHistoryExecutable(input: {
  readonly platform: string
  readonly ownsWezTermPane: boolean
  readonly linuxExecutablePath?: string
  readonly environment?: Readonly<Record<string, string | undefined>>
}): string | undefined {
  if (!input.ownsWezTermPane) return undefined
  if (input.platform === "linux") {
    return input.linuxExecutablePath === undefined ? undefined : join(dirname(input.linuxExecutablePath), "wezterm")
  }
  if (input.platform === "darwin") {
    const declared = input.environment?.WEZTERM_EXECUTABLE
    return declared !== undefined && declared.trim() !== "" && isAbsolute(declared)
      ? wezTermCliBesideExecutable(declared)
      : "/Applications/WezTerm.app/Contents/MacOS/wezterm"
  }
  return undefined
}

/**
 * WezTerm sets WEZTERM_EXECUTABLE to the program it started, which on macOS is the GUI binary
 * (`…/MacOS/wezterm-gui`) — and that binary has no `cli` subcommand, so a read through it would refuse on
 * every pane. The CLI sits beside it as `wezterm`, the same sibling rule Linux already uses (31741,
 * @dev/18 peer read).
 */
function wezTermCliBesideExecutable(declared: string): string {
  return basename(declared) === "wezterm-gui" ? join(dirname(declared), "wezterm") : declared
}

/** What a finished command answers, for the evidence line of a refusal. */
interface CommandOutcome {
  readonly status: number | null
  readonly signal?: NodeJS.Signals | null
  readonly error?: Error
  readonly stdout?: Buffer | string | null
  readonly stderr?: Buffer | string | null
}

/** The executable proof the artifact carries for a scrollback read, in the mux proof's own shape. */
export type WezTermExecutableProof = Readonly<{ path: string; sha256: string; version: string }>

interface OwnedWezTermPaneOptions {
  /** This run's WezTerm CLI: the child's WEZTERM_EXECUTABLE, or the app bundle's own binary on macOS. */
  readonly executable: string
  /** This run's WEZTERM_UNIX_SOCKET; absent means the pane is unreachable and the read refuses. */
  readonly socket: string | undefined
  /** This run's WEZTERM_PANE; absent or non-numeric is a refusal, never a default pane. */
  readonly pane: string | undefined
  /** The measured TTY of the process this run owns, when this arm measured one. */
  readonly tty?: string
  /** The measured screen rows; the read ends at the top row of this grid. */
  readonly rows: number
}

export type OwnedWezTermHistoryRead =
  | { readonly status: "read"; readonly totalLines: number; readonly screenLines: number; readonly receipt: string }
  | { readonly status: "refused"; readonly reason: string }

/** The one normal form for a TTY: `ps` prints `ttys004`, WezTerm lists `/dev/ttys004`. */
const ttyName = (value: string): string => value.trim().replace(/^\/dev\//u, "")

const rendered = (value: Buffer | string | null | undefined): string | null =>
  value == null ? null : Buffer.isBuffer(value) ? value.toString("base64") : value

function failure(command: string, args: readonly string[], result: CommandOutcome): string {
  return JSON.stringify({
    command,
    args,
    status: result.status,
    signal: result.signal ?? null,
    error: result.error?.message ?? null,
    stdout: rendered(result.stdout),
    stderr: rendered(result.stderr),
  })
}

/**
 * Pin the CLI the run will read through: its path, its bytes and the version it reports. The version is
 * the app's own answer, so the artifact names which WezTerm produced a count. A failed read is never
 * silently dropped — the caller records this named reason beside the count.
 */
export function ownedWezTermExecutableProof(
  executable: string,
):
  | { readonly status: "measured"; readonly proof: WezTermExecutableProof }
  | { readonly status: "unmeasured"; readonly reason: string } {
  let sha256: string
  try {
    sha256 = createHash("sha256").update(readFileSync(executable)).digest("hex")
  } catch (error) {
    return {
      status: "unmeasured",
      reason: `WezTerm CLI ${JSON.stringify(executable)} could not be hashed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 5000 })
  const version = result.status === 0 && typeof result.stdout === "string" ? result.stdout.trim() : ""
  if (result.error || result.signal || result.status !== 0 || version === "") {
    return {
      status: "unmeasured",
      reason: `WezTerm CLI ${JSON.stringify(executable)} reported no version: ${failure(executable, ["--version"], result)}`,
    }
  }
  return { status: "measured", proof: { path: executable, sha256, version } }
}

/** The pane list this run's own socket answers, reduced to what the cross-check needs. */
function listedPane(
  options: OwnedWezTermPaneOptions & { readonly socket: string; readonly pane: string },
):
  | { readonly status: "listed"; readonly tty: string | undefined; readonly receipt: string }
  | { readonly status: "refused"; readonly reason: string } {
  const args = ["cli", "--no-auto-start", "list", "--format", "json"]
  const result = spawnSync(options.executable, args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    timeout: 5000,
    env: { ...process.env, WEZTERM_UNIX_SOCKET: options.socket, WEZTERM_PANE: options.pane },
  })
  if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== "string") {
    return {
      status: "refused",
      reason: `WezTerm owned pane list unavailable: ${failure(options.executable, args, result)}`,
    }
  }
  const refused = (why: string): { readonly status: "refused"; readonly reason: string } => ({
    status: "refused",
    reason: `${why}: ${failure(options.executable, args, result)}`,
  })
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return refused("WezTerm owned pane list is not JSON")
  }
  if (!Array.isArray(parsed)) return refused("WezTerm owned pane list is not a pane array")
  const wanted = Number(options.pane)
  const row = parsed.find(
    (candidate): candidate is { pane_id: number; tty_name?: unknown } =>
      typeof candidate === "object" && candidate !== null && (candidate as { pane_id?: unknown }).pane_id === wanted,
  )
  if (!row) {
    const panes = parsed
      .map((candidate) =>
        typeof candidate === "object" && candidate !== null ? (candidate as { pane_id?: unknown }).pane_id : undefined,
      )
      .filter((paneId) => paneId !== undefined)
    return refused(`WezTerm owned pane ${options.pane} is not in this run's socket pane list ${JSON.stringify(panes)}`)
  }
  return {
    status: "listed",
    tty: typeof row.tty_name === "string" ? row.tty_name : undefined,
    receipt: JSON.stringify({
      executable: options.executable,
      socket: options.socket,
      pane: options.pane,
      listedTty: row.tty_name ?? null,
    }),
  }
}

/**
 * Read this run's own WezTerm pane: every retained line above the measured screen, then the screen.
 * totalLines counts both, so `totalLines - screenLines` is the retained history. No viewport offset is
 * reported: WezTerm's CLI exposes no scroll position, and assuming the bottom is the very assumption a
 * scroll observation changes.
 */
export function readOwnedWezTermHistory(options: OwnedWezTermPaneOptions): OwnedWezTermHistoryRead {
  if (
    options.socket === undefined ||
    options.socket.trim() === "" ||
    options.pane === undefined ||
    // WezTerm numbers panes from 0, and 0 is the pane a single-window run owns (measured on codimac
    // 2026-11-12: `wezterm cli get-text --pane-id 0` read the run's own marker block). Refusing 0 refused
    // the ordinary case; @dev/18's peer read, 31741.
    !/^\d+$/u.test(options.pane)
  ) {
    return {
      status: "refused",
      reason: "WezTerm owned history requires this run's WEZTERM_UNIX_SOCKET and numeric WEZTERM_PANE",
    }
  }
  const binding = listedPane({ ...options, socket: options.socket, pane: options.pane })
  if (binding.status === "refused") return binding
  if (options.tty !== undefined && ttyName(options.tty) !== "") {
    const listed = binding.tty === undefined ? "" : ttyName(binding.tty)
    if (listed === "" || listed !== ttyName(options.tty)) {
      return {
        status: "refused",
        reason: `WezTerm owned pane ${options.pane} lists TTY ${JSON.stringify(binding.tty ?? null)}, not this run's measured ${JSON.stringify(options.tty)}; ${binding.receipt}`,
      }
    }
  }
  const read = readWindowsWezTermRows({
    executable: options.executable,
    pane: options.pane,
    socket: options.socket,
    rows: options.rows,
    startLine: -2147483648,
  })
  if (read.status === "refused") return read
  return {
    status: "read",
    totalLines: read.rows.length,
    screenLines: options.rows,
    receipt: JSON.stringify({
      pane: binding.receipt,
      rows: read.rows.length,
      screenLines: options.rows,
      getText: JSON.parse(read.receipt),
    }),
  }
}
