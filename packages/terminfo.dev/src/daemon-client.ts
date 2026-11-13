/** Shared request boundary for the CLI and admin daemon collectors. */
import { createHash, randomBytes } from "node:crypto"
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { type CapturedRunDraft, type ProbeSuiteManifest, type RunDraft } from "@terminfo/probe-defs"
import { decodeCollectorDraft, decodeExactUtf8 } from "@terminfo/run-parser"
import { getTrustedSuiteReceipt } from "./serve.ts"
import {
  parseProcessOwnerAssertion,
  parseTerminalAppOwner,
  type ProcessOwnerAssertion,
  type TerminalAppOwnerAssertion,
} from "./owned-terminal.ts"

/** Exactly one owner claim: Terminal.app's window assertion, or the shared process proof. */
export type DaemonOwnerRequest = { terminalApp: TerminalAppOwnerAssertion } | { process: ProcessOwnerAssertion }

export interface DaemonRegistration {
  pid: number
  port: number
  runId: string
  token: string
  terminal: string
  terminalVersion: string
}

export interface OwnedDaemon {
  filepath: string
  registration: DaemonRegistration
}

export interface Run {
  id: string
  directory: string
  scriptPath: string
}

/** The one shape an externally supplied run id may take: the same 16 random bytes this module mints,
 * spelled as lowercase hex. It is not a secret, but it is text that reaches a shell command line and a
 * file name, so the alphabet is stated once here rather than assumed at each call site (34018). */
export const RUN_ID_PATTERN = /^[0-9a-f]{32}$/

export function createProbeRun(runId?: string): Run {
  // Darwin's per-user tmpdir can exceed an editor's Unix-socket budget once its run marker is appended.
  const directory = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "terminfo-run-"))
  // #34018: an owned-app run carries the identity the composer handed it, so both sides name one run.
  // A malformed id refuses by name instead of falling back to a fresh mint, which would silently
  // reintroduce the mismatch this parameter exists to remove.
  if (runId !== undefined && !RUN_ID_PATTERN.test(runId)) {
    rmSync(directory, { recursive: true, force: true })
    throw new Error(
      `run id ${JSON.stringify(runId)} is not 32 lowercase hex characters; an owned-app run carries the ` +
        `identity it was handed and never substitutes one of its own`,
    )
  }
  const id = runId ?? randomBytes(16).toString("hex")
  // The script carries the run id: Ghostty's run file names it unquoted, scoped to this run (@cto D2).
  return { id, directory, scriptPath: join(directory, `serve-${id}.sh`) }
}

export function removeProbeRun(run: Run): void {
  rmSync(run.directory, { recursive: true })
}

/** The launch wrapper can contain paths with shell metacharacters. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

async function verifyDaemonInfo(daemon: DaemonRegistration): Promise<void> {
  if (!daemon.runId || !Number.isInteger(daemon.pid) || !daemon.terminal) {
    throw new Error(`Daemon on port ${daemon.port} lacks run identity; restart it with the current CLI`)
  }
  const response = await fetch(`http://127.0.0.1:${daemon.port}/info`, { signal: AbortSignal.timeout(2000) })
  if (!response.ok) throw new Error(`Daemon on port ${daemon.port}: /info HTTP ${response.status}`)
  const info = (await response.json()) as Partial<DaemonRegistration>
  if (
    info.runId !== daemon.runId ||
    info.pid !== daemon.pid ||
    info.terminal !== daemon.terminal ||
    info.terminalVersion !== daemon.terminalVersion
  ) {
    throw new Error(`Daemon identity mismatch on port ${daemon.port}`)
  }
}

/** A run selects only its own registration and verifies its live /info before using its token. */
export async function findOwnedDaemon(
  runId: string,
  daemonDir: string,
  expectedTerminal?: string,
  timeoutMs = 30_000,
): Promise<OwnedDaemon | null> {
  const deadline = Date.now() + timeoutMs
  do {
    let files: string[]
    try {
      files = readdirSync(daemonDir).filter((file) => file.endsWith(".json"))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") files = []
      else throw err
    }
    for (const file of files) {
      const filepath = join(daemonDir, file)
      const data = JSON.parse(readFileSync(filepath, "utf8")) as DaemonRegistration
      if (data.runId !== runId) continue
      if (!Number.isInteger(data.pid) || !Number.isInteger(data.port) || !/^[0-9a-f]{64}$/.test(data.token)) {
        throw new Error(`Invalid owned daemon registration ${filepath}`)
      }
      try {
        await verifyDaemonInfo(data)
      } catch (err) {
        throw new Error(`Cannot verify owned daemon ${filepath}: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (expectedTerminal && data.terminal !== expectedTerminal) {
        throw new Error(`Owned daemon identity mismatch at ${filepath}`)
      }
      return { filepath, registration: data }
    }
    if (Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 100)
      })
    }
  } while (Date.now() < deadline)
  return null
}

/** Verify registration ownership again immediately before signaling its PID. */
export async function stopOwnedDaemon(owned: OwnedDaemon): Promise<void> {
  let current: DaemonRegistration
  try {
    current = JSON.parse(readFileSync(owned.filepath, "utf8")) as DaemonRegistration
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return
    throw err
  }
  const expected = owned.registration
  if (current.runId !== expected.runId || current.pid !== expected.pid || current.token !== expected.token) {
    throw new Error(`Owned daemon registration changed at ${owned.filepath}; refusing to signal PID`)
  }
  await verifyDaemonInfo(current)
  try {
    process.kill(current.pid, "SIGTERM")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err
  }
  try {
    unlinkSync(owned.filepath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
}

/**
 * How long the admin waits for one whole collection. 120 s cut off a full Terminal.app suite on
 * codimac mid-run (33587 run 3: started 01:21:57Z, aborted at 01:23:57Z with 179 rows still
 * probe-todo). The slowest stored whole run, content/probes-apps/terminal-app-2.15-macos-3053c5ec940f5c18d6a4043a210e2c94.json,
 * spans 16.4 min across its 264 probe attempts, so the bound is that worst case with margin.
 */
const DAEMON_PROBE_TIMEOUT_MS = 30 * 60_000

export async function requestDaemonProbe(
  daemon: DaemonRegistration,
  request?: DaemonOwnerRequest,
  ids?: string[],
): Promise<Response> {
  if (!Number.isInteger(daemon.port) || daemon.port < 1 || daemon.port > 65535) {
    throw new Error(`Invalid daemon port: ${daemon.port}`)
  }
  if (!daemon.token) {
    throw new Error(`Daemon on port ${daemon.port} has no authorization token; restart it with the current CLI`)
  }
  let body: Record<string, unknown> | undefined
  if (request && "terminalApp" in request) {
    const owner = parseTerminalAppOwner(request.terminalApp)
    if (owner.launchRunId !== daemon.runId || owner.workerPid !== daemon.pid || daemon.terminal !== "terminal-app") {
      throw new Error("Terminal.app owner assertion differs from the selected daemon")
    }
    body = { terminalAppOwner: owner }
  } else if (request) {
    const owner = parseProcessOwnerAssertion(request.process)
    if (owner.launchRunId !== daemon.runId || owner.workerPid !== daemon.pid) {
      throw new Error(`${owner.provider} owner assertion differs from the selected daemon`)
    }
    body = { processOwner: owner }
  }
  if (ids !== undefined) body = { ...body, ids }
  await verifyDaemonInfo(daemon)
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${daemon.port}/probe`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${daemon.token}`, ...(body && { "Content-Type": "application/json" }) },
      ...(body && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(DAEMON_PROBE_TIMEOUT_MS),
    })
  } catch (error) {
    // The bare "The operation timed out." named neither the daemon nor the bound (33587 run 3).
    if (error instanceof Error && error.name === "TimeoutError") {
      throw Object.assign(
        new Error(
          `Daemon on port ${daemon.port} did not answer /probe within ${DAEMON_PROBE_TIMEOUT_MS / 60_000} min`,
          { cause: error },
        ),
        { name: "TimeoutError" },
      )
    }
    throw error
  }
  if (!response.ok) {
    const failure = `Daemon on port ${daemon.port}: HTTP ${response.status}`
    let retained: { path: string; sha256: string }
    try {
      // A failure body is evidence even when it is not valid UTF-8 or a valid collected run record.
      retained = retainDaemonResponseBytes(Buffer.from(await response.arrayBuffer()))
    } catch (cause) {
      throw Object.assign(
        new Error(
          `${failure}; cannot retain original response: ${cause instanceof Error ? cause.message : String(cause)}`,
          {
            cause,
          },
        ),
        { status: response.status },
      )
    }
    throw Object.assign(
      new Error(`${failure}; retained original response ${retained.path}; SHA256 ${retained.sha256}`),
      {
        status: response.status,
        ...retained,
      },
    )
  }
  return response
}

/** Preserve and validate the exact HTTP bytes before any public save. */
export async function readRawDaemonProbeResponse(
  response: Response,
  receipt: { manifest: ProbeSuiteManifest; collectorRevision: string } = getTrustedSuiteReceipt(),
): Promise<ReturnType<typeof decodeCollectorDraft>> {
  const raw = decodeExactUtf8(Buffer.from(await response.arrayBuffer()), "daemon /probe")
  const decoded = decodeCollectorDraft("daemon /probe", raw, receipt.manifest, receipt.collectorRevision)
  if (decoded.kind === "captured" && decoded.run.subject.kind !== "term" && decoded.run.subject.kind !== "mux") {
    throw new Error(`Daemon /probe subject kind ${decoded.run.subject.kind} is not term or mux`)
  }
  return decoded
}

/**
 * One writer for validated runs and failed-response originals, outside the public run tree.
 * POSIX 0700/0600 limits access to this OS user, not to another seat with the same UID;
 * the directory is not a secret store and its files are never removed automatically.
 */
function retainDaemonResponseBytes(
  bytes: Buffer,
  directory = join(homedir(), ".terminfo-dev", "http-responses"),
): { path: string; sha256: string } {
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const parent = dirname(directory)
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new Error(
      `Cannot prepare HTTP response parent ${parent}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const parentInfo = lstatSync(parent)
  if (parentInfo.isSymbolicLink()) throw new Error(`HTTP response parent ${parent} is a symbolic link`)
  if (!parentInfo.isDirectory()) throw new Error(`HTTP response parent ${parent} is not a directory`)
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new Error(
      `Cannot prepare private HTTP response directory ${directory}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const directoryInfo = lstatSync(directory)
  if (directoryInfo.isSymbolicLink()) throw new Error(`HTTP response directory ${directory} is a symbolic link`)
  if (!directoryInfo.isDirectory() || (directoryInfo.mode & 0o077) !== 0) {
    throw new Error(`HTTP response directory ${directory} is not a private ordinary directory (mode 0700)`)
  }
  const path = join(directory, sha256)
  try {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new Error(
        `Cannot retain HTTP response at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const info = lstatSync(path)
  if (info.isSymbolicLink()) throw new Error(`HTTP response artifact ${path} is a symbolic link`)
  if (!info.isFile() || (info.mode & 0o077) !== 0) {
    throw new Error(`HTTP response artifact ${path} is not a private ordinary file (mode 0600)`)
  }
  if (!readFileSync(path).equals(bytes)) {
    throw new Error(`HTTP response artifact ${path} has different bytes for digest ${sha256}`)
  }
  return { path, sha256 }
}

/** Preserve and validate successful response bytes before any public save. */
export async function readRetainedDaemonProbeResponse(
  response: Response,
  options: {
    directory?: string
    receipt?: { manifest: ProbeSuiteManifest; collectorRevision: string }
  } = {},
): Promise<
  | { kind: "captured"; run: CapturedRunDraft; path: string; sha256: string }
  | { kind: "empty-selection"; run: RunDraft; path: string; sha256: string }
> {
  const bytes = Buffer.from(await response.arrayBuffer())
  const retained = retainDaemonResponseBytes(bytes, options.directory)
  let decoded: Awaited<ReturnType<typeof readRawDaemonProbeResponse>>
  try {
    decoded = await readRawDaemonProbeResponse(new Response(bytes), options.receipt)
  } catch (cause) {
    throw Object.assign(
      new Error(
        `Invalid collector capture; retained original response ${retained.path}; SHA256 ${retained.sha256}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      ),
      retained,
    )
  }
  if (decoded.kind === "captured") {
    return {
      kind: decoded.kind,
      run: {
        ...decoded.run,
        rawReplies: { ...decoded.run.rawReplies, "collector.httpResponseSha256": decoded.sha256 },
      },
      ...retained,
    }
  }
  return { kind: decoded.kind, run: decoded.run, ...retained }
}

export { finalizeCollectedDraft, saveDaemonProbeRun } from "./capture-writer.ts"
