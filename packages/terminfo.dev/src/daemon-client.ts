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
  parseOwnedAppOwnerAssertion,
  parseTerminalAppOwner,
  type OwnedAppOwnerAssertion,
  type ProcessOwnerAssertion,
  type TerminalAppOwnerAssertion,
} from "./owned-terminal.ts"

/** Exactly one owner claim: Terminal.app's window assertion, the shared process proof, or an owned app launch. */
export type DaemonOwnerRequest =
  | { terminalApp: TerminalAppOwnerAssertion }
  | { process: ProcessOwnerAssertion }
  | { ownedApp: OwnedAppOwnerAssertion }

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
 * Default wall for an owned-app remote ssh step and for re-attaching a remote probe that outlived it
 * (#37678). Full macOS owned-app runs (Terminal.app, iTerm2) take ~35–45 min on codimac; 15m + 45m = 60m
 * keeps short ssh steps failing fast at 15m while letting full remote runs finish cleanly.
 * Both `scripts/owned-app-remote-run.ts` and `DAEMON_PROBE_TIMEOUT_MS` derive from these walls
 * (@cto 43a537ee) so raising one cannot silently undercut the other.
 */
export const DEFAULT_REMOTE_SSH_TIMEOUT_MS = 15 * 60_000
export const DEFAULT_REMOTE_REATTACH_TIMEOUT_MS = 45 * 60_000
export const DEFAULT_REMOTE_RUN_TOTAL_TIMEOUT_MS = DEFAULT_REMOTE_SSH_TIMEOUT_MS + DEFAULT_REMOTE_REATTACH_TIMEOUT_MS

/**
 * How long the admin waits for one whole collection. Derived from DEFAULT_REMOTE_RUN_TOTAL_TIMEOUT_MS
 * (60 min) so the client AbortSignal never cuts off a live owned-app run that the remote re-attach
 * wall still permits (#37678, @cto 43a537ee).
 */
export const DAEMON_PROBE_TIMEOUT_MS = DEFAULT_REMOTE_RUN_TOTAL_TIMEOUT_MS

function isProbeTimeoutError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false
  if (error.name === "TimeoutError") return true
  const cause = (error as { cause?: unknown }).cause
  return cause instanceof Error && cause.name === "TimeoutError"
}

function daemonProbeTimeoutError(port: number, startedMs: number, cause: Error): Error {
  const elapsed = Date.now() - startedMs
  const signalFired = elapsed >= DAEMON_PROBE_TIMEOUT_MS - 5_000
  const bound = signalFired
    ? `${DAEMON_PROBE_TIMEOUT_MS / 60_000} min`
    : `${elapsed} ms, not the ${DAEMON_PROBE_TIMEOUT_MS / 60_000} min signal`
  return Object.assign(new Error(`Daemon on port ${port} did not answer /probe within ${bound}`, { cause }), {
    name: "TimeoutError",
  })
}

/**
 * 34507 -> 34742 -> 34753: the documented bound is ONE signal, the 30 min AbortSignal on the request below, and a
 * client needs no timer configuration to be correct. 34742 answered 34507 by raising undici's 300 s headers and
 * body timers to 35 min on the Node path; 34753 removes that workaround because the daemon now streams real headers
 * and a keepalive byte, so stock timers never see a silent socket. Bun keeps `timeout:false` (measured 34477: its
 * own timer aborted a silent body at ~362 s and wins over AbortSignal.timeout).
 *
 * A response's socket timeout, whether Node surfaced it as a cause or undici raised it directly. Exported because
 * 34753 proves the fault mapping without waiting out undici's real 300 s window in a unit run; the real window is
 * covered by the stock-Node field run recorded on the issue.
 */
export function isHeadersTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const cause = (error as { cause?: { code?: unknown } }).cause
  const code = cause?.code ?? (error as { code?: unknown }).code
  return code === "UND_ERR_HEADERS_TIMEOUT"
}

/** 34753: the named fault for a daemon that answered no byte at all before undici's header window closed. */
export function daemonNotStreamingError(port: number, elapsedMs: number, cause?: unknown): Error {
  const message =
    `Daemon on port ${port} sent no response byte within ${elapsedMs} ms, before the ` +
    `${DAEMON_PROBE_TIMEOUT_MS / 60_000} min signal: an admitted /probe flushes headers at once, so this ` +
    `daemon is not streaming (a pre-34753 daemon, or one wedged before admission)`
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    name: "DaemonNotStreaming" as const,
  })
}

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
  } else if (request && "ownedApp" in request) {
    const owner = parseOwnedAppOwnerAssertion(request.ownedApp)
    if (owner.launchRunId !== daemon.runId || owner.workerPid !== daemon.pid) {
      throw new Error("owned-app owner assertion differs from the selected daemon")
    }
    body = { ownedAppOwner: owner }
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
  const started = Date.now()
  try {
    const url = `http://127.0.0.1:${daemon.port}/probe`
    const method = body ? "POST" : "GET"
    const headers: Record<string, string> = {
      Authorization: `Bearer ${daemon.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    }
    const signal = AbortSignal.timeout(DAEMON_PROBE_TIMEOUT_MS)
    response =
      typeof process.versions.bun === "string"
        ? // Bun's own fetch timeout aborts a silent body at ~362s and wins over AbortSignal.timeout
          // (34477 run 2328c7a7). timeout:false leaves the signal as the only bound.
          await fetch(url, {
            method,
            headers,
            ...(body && { body: JSON.stringify(body) }),
            signal,
            timeout: false,
          })
        : // 34753: stock Node/undici timers and no dispatcher. The daemon streams headers and a keepalive
          // byte while collecting, so a long run never leaves the socket silent for 300 s.
          await fetch(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal })
  } catch (error) {
    // The bare "The operation timed out." named neither the daemon nor the bound (33587 run 3).
    if (isProbeTimeoutError(error)) {
      throw daemonProbeTimeoutError(daemon.port, started, error)
    }
    // 34753: an admitted probe streams real headers, so this timer can only fire when the daemon answered
    // nothing at all for undici's 300 s header window. That is a daemon fault to name, not a run to wait out.
    if (isHeadersTimeout(error)) {
      throw daemonNotStreamingError(daemon.port, Date.now() - started, error)
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
  probeDaemonRequests.set(response, { port: daemon.port, started })
  return response
}

/**
 * 34753: the daemon streams leading JSON whitespace (space, tab, LF, CR) as its keepalive, so an
 * admitted /probe answer reaches a client with stock socket timers instead of none at all. Those
 * bytes are transport, not payload: strip ONLY that leading run, at this one boundary, and never a
 * BOM, interior whitespace, trailing bytes or anything after the first non-whitespace byte. The
 * strict reader and the retained receipt hash therefore both see the payload the daemon meant to
 * send (@cto 34753-probe-streaming-go.md condition 5).
 */
export function stripProbeKeepalivePrefix(bytes: Buffer): Buffer {
  let at = 0
  while (at < bytes.length) {
    const byte = bytes[at]
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) break
    at += 1
  }
  return at === 0 ? bytes : bytes.subarray(at)
}

/**
 * Which daemon and start time each live /probe response came from, so a body that ends after admission
 * can distinguish our own AbortSignal timeout from a daemon-ended stream (#37678, @cto 43a537ee).
 */
const probeDaemonRequests = new WeakMap<Response, { port: number; started: number }>()

/**
 * 34753 -> 34799: after admission the daemon streams, so a collection that fails afterwards ends the
 * body instead of answering HTTP 500 (@cto 34753-probe-streaming-go.md condition 2). The bare runtime
 * error ("terminated", "fetch failed") names nothing, so this one helper says which daemon ended the
 * body, that it was admitted rather than refused, and where the daemon-side record lives.
 */
export function daemonStreamEndedError(port: number, cause?: unknown): Error {
  const directory = process.env.TERMINFO_CAPTURE_DIRECTORY || join(homedir(), ".terminfo-dev", "http-responses")
  const message =
    `Daemon on port ${port} ended the /probe body after admitting the run: the collection failed or was ` +
    `cancelled before it could answer, so this response carries no run record. The reason is in that ` +
    `daemon log, and any draft it reserved is under ${directory}`
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    name: "DaemonStreamEnded" as const,
  })
}

/** Read one whole /probe body, preserving client TimeoutError and naming the daemon on stream reset. */
async function readProbeBody(response: Response): Promise<Buffer> {
  try {
    return Buffer.from(await response.arrayBuffer())
  } catch (error) {
    const meta = probeDaemonRequests.get(response)
    if (meta === undefined) throw error
    if (isProbeTimeoutError(error)) throw daemonProbeTimeoutError(meta.port, meta.started, error)
    throw daemonStreamEndedError(meta.port, error)
  }
}

function decodeProbeBytes(
  bytes: Buffer,
  receipt: { manifest: ProbeSuiteManifest; collectorRevision: string },
): ReturnType<typeof decodeCollectorDraft> {
  const raw = decodeExactUtf8(stripProbeKeepalivePrefix(bytes), "daemon /probe")
  const decoded = decodeCollectorDraft("daemon /probe", raw, receipt.manifest, receipt.collectorRevision)
  if (decoded.kind === "captured" && decoded.run.subject.kind !== "term" && decoded.run.subject.kind !== "mux") {
    throw new Error(`Daemon /probe subject kind ${decoded.run.subject.kind} is not term or mux`)
  }
  return decoded
}

/** Preserve and validate the exact HTTP bytes before any public save. */
export async function readRawDaemonProbeResponse(
  response: Response,
  receipt: { manifest: ProbeSuiteManifest; collectorRevision: string } = getTrustedSuiteReceipt(),
): Promise<ReturnType<typeof decodeCollectorDraft>> {
  return decodeProbeBytes(await readProbeBody(response), receipt)
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
  const bytes = stripProbeKeepalivePrefix(await readProbeBody(response))
  const retained = retainDaemonResponseBytes(bytes, options.directory)
  let decoded: Awaited<ReturnType<typeof readRawDaemonProbeResponse>>
  try {
    // The bytes are already the retained payload, so decode them directly instead of round-tripping
    // through a second Response and a second strip.
    decoded = decodeProbeBytes(bytes, options.receipt ?? getTrustedSuiteReceipt())
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
