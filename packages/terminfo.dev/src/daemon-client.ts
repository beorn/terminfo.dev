/** Shared request boundary for the CLI and admin daemon collectors. */
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProbeRun as CollectedProbeRun, ProbeTarget } from "@terminfo/probe-defs"

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

export async function requestDaemonProbe(daemon: DaemonRegistration): Promise<Response> {
  if (!Number.isInteger(daemon.port) || daemon.port < 1 || daemon.port > 65535) {
    throw new Error(`Invalid daemon port: ${daemon.port}`)
  }
  if (!daemon.token) {
    throw new Error(`Daemon on port ${daemon.port} has no authorization token; restart it with the current CLI`)
  }
  await verifyDaemonInfo(daemon)
  const response = await fetch(`http://127.0.0.1:${daemon.port}/probe`, {
    headers: { Authorization: `Bearer ${daemon.token}` },
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) {
    throw new Error(`Daemon on port ${daemon.port}: HTTP ${response.status}`)
  }
  return response
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Reject legacy boolean envelopes; only explicit v2 observations cross this boundary. */
export async function readDaemonProbeResponse(response: Response): Promise<CollectedProbeRun> {
  const data: unknown = await response.json()
  if (
    !isRecord(data) ||
    data.schemaVersion !== 2 ||
    typeof data.runId !== "string" ||
    !isRecord(data.target) ||
    typeof data.target.id !== "string" ||
    typeof data.target.version !== "string" ||
    !["app", "mux"].includes(String(data.target.kind)) ||
    data.identity !== "unverified" ||
    typeof data.probeHash !== "string" ||
    typeof data.sourceRevision !== "string" ||
    typeof data.measuredAt !== "string" ||
    !isRecord(data.rawReplies) ||
    !Object.values(data.rawReplies).every((value) => typeof value === "string") ||
    !Array.isArray(data.observations) ||
    !Array.isArray(data.assertions) ||
    !Array.isArray(data.screenshotRefs) ||
    !isRecord(data.ungradedDiagnostics) ||
    typeof data.suiteComplete !== "boolean" ||
    Object.hasOwn(data, "results")
  ) {
    throw new Error("Invalid /probe response: expected explicit v2 observation schema, not boolean results")
  }
  return data as unknown as CollectedProbeRun
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
