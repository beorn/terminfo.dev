/** Shared request boundary for the CLI and admin daemon collectors. */
import { randomBytes } from "node:crypto"
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
import type { ProbeRun as CollectedProbeRun, ProbeSuiteManifest, ProbeTarget } from "@terminfo/probe-defs"
import { decodeCollectorRun, decodeExactUtf8 } from "@terminfo/run-parser"
import { getTrustedSuiteReceipt } from "./serve.ts"
import { parseTerminalAppOwner, type TerminalAppOwnerAssertion } from "./owned-terminal.ts"

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

export interface ProbeRun {
  id: string
  directory: string
  scriptPath: string
}

export function createProbeRun(): ProbeRun {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-run-"))
  return { id: randomBytes(16).toString("hex"), directory, scriptPath: join(directory, "serve.sh") }
}

export function removeProbeRun(run: ProbeRun): void {
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

export async function requestDaemonProbe(
  daemon: DaemonRegistration,
  terminalAppOwner?: TerminalAppOwnerAssertion,
): Promise<Response> {
  if (!Number.isInteger(daemon.port) || daemon.port < 1 || daemon.port > 65535) {
    throw new Error(`Invalid daemon port: ${daemon.port}`)
  }
  if (!daemon.token) {
    throw new Error(`Daemon on port ${daemon.port} has no authorization token; restart it with the current CLI`)
  }
  const owner = terminalAppOwner === undefined ? undefined : parseTerminalAppOwner(terminalAppOwner)
  if (
    owner &&
    (owner.launchRunId !== daemon.runId || owner.workerPid !== daemon.pid || daemon.terminal !== "terminal-app")
  ) {
    throw new Error("Terminal.app owner assertion differs from the selected daemon")
  }
  await verifyDaemonInfo(daemon)
  const response = await fetch(`http://127.0.0.1:${daemon.port}/probe`, {
    method: owner ? "POST" : "GET",
    headers: { Authorization: `Bearer ${daemon.token}`, ...(owner && { "Content-Type": "application/json" }) },
    ...(owner && { body: JSON.stringify({ terminalAppOwner: owner }) }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) {
    throw new Error(`Daemon on port ${daemon.port}: HTTP ${response.status}`)
  }
  return response
}

/** Preserve and validate the exact HTTP bytes before any public save. */
export async function readRawDaemonProbeResponse(
  response: Response,
  receipt: { manifest: ProbeSuiteManifest; collectorRevision: string } = getTrustedSuiteReceipt(),
): Promise<{
  run: CollectedProbeRun
  raw: string
  sha256: string
}> {
  const raw = decodeExactUtf8(Buffer.from(await response.arrayBuffer()), "daemon /probe")
  const decoded = decodeCollectorRun("daemon /probe", raw, receipt.manifest, receipt.collectorRevision)
  if (decoded.run.target.kind !== "app" && decoded.run.target.kind !== "mux") {
    throw new Error(`Daemon /probe target kind ${decoded.run.target.kind} is not an app or mux`)
  }
  return decoded
}

/**
 * Keep validated response bytes outside the public run tree until a person removes them.
 * POSIX 0700/0600 limits access to this OS user, not to another seat with the same UID;
 * the directory is not a secret store and its files are never removed automatically.
 */
export async function readRetainedDaemonProbeResponse(
  response: Response,
  options: {
    directory?: string
    receipt?: { manifest: ProbeSuiteManifest; collectorRevision: string }
  } = {},
): Promise<{ run: CollectedProbeRun; path: string; sha256: string }> {
  const decoded = await readRawDaemonProbeResponse(response, options.receipt)
  const directory = options.directory ?? join(homedir(), ".terminfo-dev", "http-responses")
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
  const path = join(directory, decoded.sha256)
  try {
    writeFileSync(path, decoded.raw, { flag: "wx", mode: 0o600 })
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
  if (!readFileSync(path).equals(Buffer.from(decoded.raw, "utf8"))) {
    throw new Error(`HTTP response artifact ${path} has different bytes for digest ${decoded.sha256}`)
  }
  return {
    run: {
      ...decoded.run,
      rawReplies: { ...decoded.run.rawReplies, "collector.httpResponseSha256": decoded.sha256 },
    },
    path,
    sha256: decoded.sha256,
  }
}

/** Preserve one immutable raw capture under its measured identity. */
export function saveDaemonProbeRun(
  run: CollectedProbeRun,
  directory: string,
  intended?: { kind: ProbeTarget["kind"]; id: string; version: string },
): string {
  if (intended && run.target.id !== intended.id && run.target.id !== "unknown") {
    throw new Error(
      `Measured terminal ${run.target.id} differs from intended ${intended.id}; refusing to relabel capture`,
    )
  }
  if (intended && run.target.version !== intended.version && run.target.version !== "unknown") {
    throw new Error(
      `Measured version ${run.target.version} differs from intended ${intended.version}; refusing to relabel capture`,
    )
  }
  const captured: CollectedProbeRun = intended
    ? {
        ...run,
        target: { ...run.target, kind: intended.kind },
        rawReplies: {
          ...run.rawReplies,
          "collector.intent": JSON.stringify(intended),
        },
      }
    : run
  for (const value of [captured.target.id, captured.target.version, captured.target.os ?? "unknown", captured.runId]) {
    if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error(`Unsafe capture filename component: ${value}`)
  }
  mkdirSync(directory, { recursive: true })
  const file = join(
    directory,
    `${captured.target.id}-${captured.target.version}-${captured.target.os ?? "unknown"}-${captured.runId}.json`,
  )
  writeFileSync(file, `${JSON.stringify(captured, null, 2)}\n`, { flag: "wx" })
  return file
}
