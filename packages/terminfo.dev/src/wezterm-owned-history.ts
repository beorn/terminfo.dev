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
import { ownedHistoryReceipt, ttyName } from "./owned-history-receipt.ts"

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

/** How a command failed, in one phrase that carries no path this machine chose. */
const commandOutcome = (result: CommandOutcome): string =>
  result.error !== undefined
    ? `error ${result.error.message}`
    : result.signal !== undefined && result.signal !== null
      ? `signal ${result.signal}`
      : `exit ${result.status}`

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

/**
 * What an owned WezTerm arm records about the CLI it reads history through (31741). One decision for every
 * platform: the arm never borrows another binary's proof, so a measured proof is named, and an unmeasured one
 * always ships its reason — an `unmeasured` with no reason is not an identity check (@cto REVISE at f1b0a7ffe,
 * where a macOS-only proof left the Linux arm with neither).
 */
export type WezTermHistoryIdentity = Readonly<{
  /** This arm's count comes from the terminal's own CLI; no other binary's proof explains it. */
  readonly historyReadsThroughCli: true
  /** The measured proof, present exactly when the CLI hashed and answered its version. */
  readonly historyExecutable?: WezTermExecutableProof
  /** Why the proof could not be measured — always present when `historyExecutable` is absent. */
  readonly historyExecutableUnmeasured?: string
}>

/**
 * What the hosted Darwin arm must be handed before it may even attempt an owned WezTerm read: the pane's own
 * socket, the pane id, and a measured tty to match the listed pane against (8c084f05). Each absence is a named
 * PROBE TODO reason — the app may well expose a read; this arm has no way to reach it — never a declaration.
 * Pure, so the three names cannot drift from the arm that reports them.
 */
export function hostedWezTermPrerequisites(input: {
  readonly socketPresent: boolean
  readonly paneIdPresent: boolean
  readonly measuredTty: string | undefined
}): string | undefined {
  if (!input.socketPresent) return "hosted WezTerm pane published no socket"
  if (!input.paneIdPresent) return "hosted WezTerm pane published no pane id"
  if (input.measuredTty === undefined || input.measuredTty.trim() === "") {
    return "hosted WezTerm pane has no measured tty to match"
  }
  return undefined
}

/**
 * @cto 8c084f05's three ownership proofs, run in order before EVERY read and reported as the first named
 * refusal. Ancestry is re-read here, never handed in: a reading taken at construction would prove the
 * process that existed then. A same-name ancestor with a different pid is refused, because a pid that
 * changed is a different process however the name reads. Nothing downstream runs on a refusal.
 */
export function hostedWezTermOwnerProof(input: {
  /** Reads the app ancestry NOW; a throw from it is its own named refusal and needs no second wording. */
  readonly readAncestorPid: () => number
  /** The app pid this run measured at grant; absent means the grant measured none and nothing can match. */
  readonly measuredPid: number | undefined
  /** This run's WEZTERM_UNIX_SOCKET, read now; absent or blank means the CLI has no socket to reach. */
  readonly socket: string | undefined
  /** The measured app pid's own unix sockets, or the named reason they could not be read. */
  readonly heldSockets: (
    socketPath: string,
    pid: number,
  ) => { readonly status: "held" } | { readonly status: "refused"; readonly reason?: string }
  /** The tty this arm measured for the collector's own pane; absent means there is nothing to match. */
  readonly measuredTty: string | undefined
}): { readonly status: "proved" } | { readonly status: "refused"; readonly reason: string } {
  const ancestorPid = input.readAncestorPid()
  if (input.measuredPid === undefined || ancestorPid !== input.measuredPid) {
    return {
      status: "refused",
      reason: `Hosted WezTerm ancestor is now pid ${ancestorPid}, not pid ${input.measuredPid ?? "none"} measured at grant`,
    }
  }
  const socket = input.socket
  if (socket === undefined || socket.trim() === "") {
    return { status: "refused", reason: "hosted WezTerm pane published no socket" }
  }
  const held = input.heldSockets(socket, ancestorPid)
  if (held.status === "refused") {
    return { status: "refused", reason: held.reason ?? "WezTerm socket is not held by the measured app process" }
  }
  if (input.measuredTty === undefined || input.measuredTty.trim() === "") {
    return { status: "refused", reason: "hosted WezTerm pane has no measured tty to match" }
  }
  return { status: "proved" }
}

export function wezTermHistoryIdentity(executable: string | undefined): WezTermHistoryIdentity | undefined {
  if (executable === undefined) return undefined
  const proof = ownedWezTermExecutableProof(executable)
  return proof.status === "measured"
    ? { historyExecutable: proof.proof, historyReadsThroughCli: true }
    : { historyReadsThroughCli: true, historyExecutableUnmeasured: proof.reason }
}

/**
 * Condition 2 of @cto 8c084f05: the socket the CLI talks to must belong to the process this run measured as
 * the app's ancestor. A name match is not ownership — a second WezTerm answering on the same machine would be
 * a reading of someone else's history — so the pid's own open unix sockets are listed and the path must be in
 * that list. An unreadable list is a refusal too: no proof, no read.
 */
export function socketHeldByPid(input: {
  readonly socketPath: string
  readonly pid: number
  /** The lister this run chose; a test fixture passes its own, production takes the system lsof. */
  readonly executable?: string
}): { readonly status: "held" } | { readonly status: "refused"; readonly reason: string } {
  const executable = input.executable ?? "/usr/sbin/lsof"
  const args = ["-a", "-U", "-p", String(input.pid), "-Fn"]
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 5000,
  })
  // lsof exits 1 when it matched nothing, which is a reading ("this pid holds no unix socket"), not a failure.
  const listedNothing = result.status === 1 && (result.stdout ?? "") === "" && result.error === undefined
  if (!listedNothing && (result.error || result.signal || result.status !== 0 || typeof result.stdout !== "string")) {
    // The row's reason is published and must stay value-free: lsof's output can name every socket this
    // process holds. The command's own evidence goes to the collector's stderr log instead (@cto, a1473808).
    console.error(`WezTerm socket ownership: ${failure(executable, args, result)}`)
    return {
      status: "refused",
      reason: `WezTerm socket ownership could not be read (${commandOutcome(result)})`,
    }
  }
  const paths =
    typeof result.stdout === "string"
      ? result.stdout
          .split("\n")
          .filter((line) => line.startsWith("n"))
          .map((line) => line.slice(1))
      : []
  if (!paths.includes(input.socketPath)) {
    return {
      status: "refused",
      reason: `WezTerm socket is not held by the measured app process (${paths.length} unix sockets held)`,
    }
  }
  return { status: "held" }
}

/**
 * One pane-list parse for history and CWD. History retains its first matching row and TTY policy;
 * CWD additionally requires a unique match and validates the raw public URI in its own consumer.
 * Callers bracket the command with their live owner check; parsing alone proves no ownership.
 */
export function readOwnedWezTermPane(
  options: Pick<OwnedWezTermPaneOptions, "executable"> & { readonly socket: string; readonly pane: string },
):
  | {
      readonly status: "listed"
      readonly tty: string | undefined
      readonly cwd: unknown
      readonly matchingPanes: number
    }
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
  const matches = parsed.filter(
    (candidate): candidate is { pane_id: number; tty_name?: unknown; cwd?: unknown } =>
      typeof candidate === "object" && candidate !== null && (candidate as { pane_id?: unknown }).pane_id === wanted,
  )
  const row = matches[0]
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
    cwd: row.cwd,
    matchingPanes: matches.length,
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
  const binding = readOwnedWezTermPane({ ...options, socket: options.socket, pane: options.pane })
  if (binding.status === "refused") return binding
  const listedTty = ttyName(binding.tty)
  const measuredTty = ttyName(options.tty)
  if (measuredTty !== null && (listedTty === null || listedTty !== measuredTty)) {
    return {
      status: "refused",
      reason: `WezTerm owned pane ${options.pane} lists TTY ${JSON.stringify(binding.tty ?? null)}, not this run's measured ${JSON.stringify(options.tty)}: the owned read method is unavailable here`,
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
  // The record that travels with the count: which pane, which two ttys, and whether they are the same one.
  // The pane list and the get-text transcript stay in the refusal path, where a host path names a failed
  // command rather than publishing a run's own socket and pane contents (@cto 41fcd747).
  const identity = ownedHistoryReceipt({
    surface: "wezterm",
    pane: options.pane,
    listedTty: binding.tty,
    measuredTty: options.tty,
    socketPresent: true,
    executable: options.executable,
  })
  if (identity.status === "refused") return identity
  return {
    status: "read",
    totalLines: read.rows.length,
    screenLines: options.rows,
    receipt: identity.receipt,
  }
}
