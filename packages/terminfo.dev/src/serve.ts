/**
 * Thin probe server — TTY I/O only, no bundled probe logic.
 *
 * Usage: npx terminfo.dev serve
 *
 * Starts an HTTP server that accepts probe requests. Run this in each
 * terminal you want to test, then use `terminfo.dev test-all` or
 * curl to run probes remotely.
 *
 * Probe definitions are loaded at daemon startup; restart after changing them.
 *
 * Discovery: writes terminal info + port to ~/.terminfo-dev/daemons/
 * so clients can find all running daemons automatically.
 */

import { createStyle } from "@silvery/ansi"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { mkdirSync, writeFileSync, unlinkSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { execFileSync } from "node:child_process"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import type { ProbeRun, ProbeSuiteManifest } from "@terminfo/probe-defs"
import { detectTerminal } from "./detect.ts"
import { resolveMeasuredAppVersion } from "./identity-guard.ts"
import { withRawMode, drainStdin } from "./tty.ts"
import { ALL_PROBES, runProbeBatch, type ProbeCapture } from "./probes/unified.ts"
import { createLinuxCapture, type LiveExecutable } from "./linux-capture.ts"
import { createLinuxClipboardAdapter, type LinuxClipboardAdapter } from "./linux-clipboard.ts"
import { parseRunProvenance } from "../../../docs/data/selected-results.ts"

const s = createStyle()

const DAEMON_DIR = join(homedir(), ".terminfo-dev", "daemons")
const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

/** Bun's CLI build replaces this identifier with a validated immutable receipt. */
declare const __TERMINFO_BUNDLED_SUITE__: { manifest: ProbeSuiteManifest; collectorRevision: string }
const bundledSuite = typeof __TERMINFO_BUNDLED_SUITE__ === "undefined" ? null : __TERMINFO_BUNDLED_SUITE__

function measuredExecutable(value: unknown): LiveExecutable {
  if (!value || typeof value !== "object") throw new Error("Runtime provenance has no executable")
  const executable = (value as { executable?: unknown }).executable
  if (!executable || typeof executable !== "object") throw new Error("Runtime provenance has no executable")
  const { path, sha256 } = executable as { path?: unknown; sha256?: unknown }
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    typeof sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(sha256)
  ) {
    throw new Error("Runtime provenance has invalid measured executable")
  }
  return { path, sha256 }
}

function assertLoadedAppSuite(manifest: ProbeSuiteManifest, probeHash: string, location: string): void {
  const actual = ALL_PROBES.map((probe) => probe.id).sort()
  if (manifest.probeHash !== probeHash || JSON.stringify(manifest.probes.app) !== JSON.stringify(actual)) {
    throw new Error(`Loaded app probes disagree with suite declaration ${location}`)
  }
}

function suiteMetadata(): { probeHash: string; sourceRevision: string } {
  if (bundledSuite) {
    const { manifest, collectorRevision } = bundledSuite
    if (!/^[0-9a-f]{12}$/.test(manifest.probeHash) || !/^[0-9a-f]{40}$/.test(collectorRevision)) {
      throw new Error("Compiled CLI has invalid suite or collector revision metadata")
    }
    assertLoadedAppSuite(manifest, manifest.probeHash, "compiled CLI receipt")
    if (
      (process.env.TERMINFO_PROBE_HASH && process.env.TERMINFO_PROBE_HASH !== manifest.probeHash) ||
      (process.env.TERMINFO_SOURCE_REVISION && process.env.TERMINFO_SOURCE_REVISION !== collectorRevision)
    ) {
      throw new Error("Runtime suite metadata disagrees with compiled CLI receipt")
    }
    return { probeHash: manifest.probeHash, sourceRevision: collectorRevision }
  }
  const probeHash = process.env.TERMINFO_PROBE_HASH
  const sourceRevision = process.env.TERMINFO_SOURCE_REVISION
  if (!probeHash || !/^[0-9a-f]{12}$/.test(probeHash) || !sourceRevision || !/^[0-9a-f]{40}$/.test(sourceRevision)) {
    throw new Error(
      "v2 collection requires TERMINFO_PROBE_HASH and TERMINFO_SOURCE_REVISION from a source-tree launcher",
    )
  }
  const manifestPath = join(SOURCE_ROOT, "content", "suites", `${probeHash}.json`)
  const manifest: ProbeSuiteManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ProbeSuiteManifest
  assertLoadedAppSuite(manifest, probeHash, manifestPath)
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: SOURCE_ROOT, encoding: "utf8" }).trim()
  if (revision !== sourceRevision) throw new Error(`Collector revision differs from TERMINFO_SOURCE_REVISION`)
  const dirty = execFileSync(
    "git",
    [
      "status",
      "--porcelain",
      "--",
      "packages/probe-defs/src",
      "packages/terminfo.dev/src",
      "packages/terminfo.dev/package.json",
      "docs/data/selected-results.ts",
    ],
    {
      cwd: SOURCE_ROOT,
      encoding: "utf8",
    },
  ).trim()
  if (dirty) throw new Error(`Collector source is uncommitted: ${dirty}`)
  return { probeHash, sourceRevision }
}

/** The same source-tree collector powers daemon and inline CLI entry points. */
export async function collectProbeRun(options: { ids?: string[] } = {}): Promise<ProbeRun> {
  const terminal = detectTerminal()
  const { probeHash, sourceRevision } = suiteMetadata()
  const captureDirectory = process.env.TERMINFO_CAPTURE_DIRECTORY
  const clipboardReceipt = process.env.TERMINFO_CLIPBOARD_FIXTURE_RECEIPT
  const provenancePath = process.env.TERMINFO_RUNTIME_PROVENANCE
  if ((captureDirectory || clipboardReceipt) && !provenancePath) {
    throw new Error("Controlled Linux collection requires runtime provenance")
  }
  if (provenancePath && !captureDirectory && !clipboardReceipt) {
    throw new Error("Runtime provenance requires owned capture or clipboard")
  }
  const provenanceSource: unknown = provenancePath ? JSON.parse(readFileSync(provenancePath, "utf8")) : undefined
  const executable = provenanceSource ? measuredExecutable(provenanceSource) : undefined
  if ((captureDirectory || clipboardReceipt) && !executable) {
    throw new Error("Controlled Linux collection lacks measured executable")
  }
  let capture: ProbeCapture | undefined
  if (captureDirectory) {
    if (!executable) throw new Error("Configured Linux capture lacks measured executable")
    capture = await createLinuxCapture(captureDirectory, executable)
  }
  let clipboard: LinuxClipboardAdapter | undefined
  if (clipboardReceipt) {
    if (!executable) throw new Error("Owned clipboard receipt lacks measured executable")
    clipboard = await createLinuxClipboardAdapter(clipboardReceipt, process.env.TERMINFO_RUN_ID ?? "", executable)
  }
  let batch: Awaited<ReturnType<typeof runProbeBatch>>
  try {
    batch = await withRawMode(async () => {
      const result = await runProbeBatch({
        ...options,
        ...(capture && { capture }),
        ...(clipboard && clipboard.profile !== "default" && { clipboard }),
      })
      await drainStdin(1000)
      return result
    })
  } finally {
    await clipboard?.dispose()
  }
  if (clipboard) batch.rawReplies["collector.clipboardFixture"] = clipboard.summary
  const target: ProbeRun["target"] = {
    kind: "app",
    id: terminal.name,
    version: resolveMeasuredAppVersion(terminal.name, terminal.version, batch.rawReplies),
    os: terminal.os,
    osVersion: terminal.osVersion,
    outerTerminal: null,
    mux: null,
    config: null,
    permissions: null,
  }
  const provenance = provenancePath
    ? parseRunProvenance(provenanceSource, target, { probeHash, sourceRevision }, provenancePath)
    : undefined
  if (provenancePath && !provenance) throw new Error(`Missing runtime provenance in ${provenancePath}`)
  if (provenance) target.config = provenance.fixture.config
  if (clipboard) {
    if (!provenance || provenance.fixture.config !== clipboard.config) {
      throw new Error("Owned clipboard profile config differs from runtime provenance")
    }
    if (clipboard.profile !== "default") target.permissions = clipboard.permissions
  }
  return {
    schemaVersion: 2,
    runId: randomBytes(16).toString("hex"),
    target,
    ...(provenance && { provenance }),
    identity: "unverified",
    suiteId: probeHash,
    probeHash,
    suiteComplete: batch.suiteComplete,
    sourceRevision,
    measuredAt: new Date().toISOString(),
    origin: { kind: "collector" },
    rawReplies: batch.rawReplies,
    assertions: batch.assertions,
    screenshotRefs: batch.screenshotRefs,
    observations: batch.observations,
    ungradedDiagnostics: batch.ungradedDiagnostics,
  }
}

interface DaemonInfo {
  pid: number
  port: number
  terminal: string
  terminalVersion: string
  os: string
  osVersion: string
  started: string
  token: string
  runId: string
}

function register(info: DaemonInfo): string {
  mkdirSync(DAEMON_DIR, { recursive: true, mode: 0o700 })
  const filename = `${info.terminal}-${info.pid}.json`
  const filepath = join(DAEMON_DIR, filename)
  writeFileSync(filepath, JSON.stringify(info, null, 2), { flag: "wx", mode: 0o600 })
  return filepath
}

function unregister(filepath: string) {
  try {
    unlinkSync(filepath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return
    throw new Error(
      `Could not remove daemon registration ${filepath}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export function listDaemons(): DaemonInfo[] {
  let files: string[]
  try {
    files = readdirSync(DAEMON_DIR).filter((f) => f.endsWith(".json"))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    throw new Error(
      `Could not list daemon registrations in ${DAEMON_DIR}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return files.map((file) => {
    const filepath = join(DAEMON_DIR, file)
    try {
      const data = JSON.parse(readFileSync(filepath, "utf-8")) as DaemonInfo
      if (!Number.isInteger(data.pid) || !Number.isInteger(data.port) || !/^[0-9a-f]{64}$/.test(data.token)) {
        throw new Error("missing or invalid pid, port, or token")
      }
      return data
    } catch (err) {
      throw new Error(`Invalid daemon registration ${filepath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

export function startDaemon(port = 0): void {
  const terminal = detectTerminal()
  const token = randomBytes(32).toString("hex")
  const runId =
    process.env.TERMINFO_RUN_ID && /^[0-9a-f]{32}$/.test(process.env.TERMINFO_RUN_ID)
      ? process.env.TERMINFO_RUN_ID
      : randomBytes(16).toString("hex")

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      res.setHeader("Content-Type", "application/json")

      const url = new URL(req.url ?? "/", `http://localhost`)
      const mutatesTTY = url.pathname === "/probe" || url.pathname === "/probe/single" || url.pathname === "/query"
      if (mutatesTTY) {
        const supplied = req.headers.authorization?.replace(/^Bearer /, "") ?? ""
        const expected = Buffer.from(token)
        const actual = Buffer.from(supplied)
        const authorized = actual.length === expected.length && timingSafeEqual(actual, expected)
        const origin = req.headers.origin
        const sameOrigin = !origin || origin === `http://${req.headers.host}`
        if (!authorized || !sameOrigin) {
          res.statusCode = 403
          res.end(JSON.stringify({ error: "TTY mutation requires this daemon's token and same origin" }))
          return
        }
      }

      if (url.pathname === "/info") {
        res.end(
          JSON.stringify({
            terminal: terminal.name,
            terminalVersion: terminal.version,
            pid: process.pid,
            runId,
            os: terminal.os,
            osVersion: terminal.osVersion,
            probes: "loaded-at-start",
          }),
        )
        return
      }

      if (url.pathname === "/probe") {
        console.log(s.dim(`[${new Date().toISOString()}] Running ${ALL_PROBES.length} probes...`))
        const run = await collectProbeRun()
        console.log(
          s.dim(
            `Collected ${run.observations.length}/${ALL_PROBES.length} explicit observations; partial=${!run.suiteComplete}`,
          ),
        )
        res.end(JSON.stringify(run))
        return
      }

      if (url.pathname === "/probe/single") {
        const probeId = url.searchParams.get("id")
        if (!probeId) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: "Missing ?id= parameter" }))
          return
        }
        const probes = ALL_PROBES
        const probe = probes.find((p) => p.id === probeId)
        if (!probe) {
          res.statusCode = 404
          res.end(JSON.stringify({ error: `Unknown probe: ${probeId}` }))
          return
        }

        res.end(JSON.stringify(await collectProbeRun({ ids: [probeId] })))
        return
      }

      if (url.pathname === "/query" && req.method === "POST") {
        // Execute raw escape sequence commands in this terminal
        // POST body: { commands: [{ write: "\\x1b[6n", read: "\\x1b\\[(\\d+);(\\d+)R", timeout?: 1000 }, ...] }
        try {
          const body = await readBody(req)
          const { commands } = JSON.parse(body) as {
            commands: Array<{ write?: string; read?: string; timeout?: number; measure?: string }>
          }
          if (!Array.isArray(commands)) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: "commands must be an array" }))
            return
          }
          if (
            commands.length > 64 ||
            commands.some(
              (cmd) =>
                typeof cmd !== "object" ||
                cmd === null ||
                (cmd.write !== undefined && (typeof cmd.write !== "string" || cmd.write.length > 16384)) ||
                (cmd.measure !== undefined && (typeof cmd.measure !== "string" || cmd.measure.length > 16384)) ||
                (cmd.read !== undefined && (typeof cmd.read !== "string" || cmd.read.length > 512)) ||
                (cmd.timeout !== undefined &&
                  (!Number.isInteger(cmd.timeout) || cmd.timeout < 1 || cmd.timeout > 5000)),
            )
          ) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: "commands exceed count, size, or timeout limits" }))
            return
          }

          const results: Array<{ response?: string | null; width?: number | null; error?: string }> = []

          await withRawMode(async () => {
            process.stdout.write("\x1b[0m\x1b[2J\x1b[H")
            for (const cmd of commands) {
              try {
                if (cmd.measure) {
                  // Measure rendered width of a string
                  const { measureRenderedWidth } = await import("./tty.ts")
                  const width = await measureRenderedWidth(cmd.measure)
                  results.push({ width })
                } else if (cmd.write && cmd.read) {
                  // Write sequence, read response
                  const { query } = await import("./tty.ts")
                  const match = await query(unescapeSequence(cmd.write), new RegExp(cmd.read), cmd.timeout ?? 1000)
                  results.push({ response: match ? match[0] : null })
                } else if (cmd.write) {
                  // Just write, no response expected
                  process.stdout.write(unescapeSequence(cmd.write))
                  results.push({ response: "ok" })
                } else {
                  results.push({ error: "command needs write, read, or measure" })
                }
              } catch (err) {
                results.push({ error: err instanceof Error ? err.message : String(err) })
              }
            }
            process.stdout.write("\x1b[0m\x1b[2J\x1b[H")
            await drainStdin(500)
          })
          console.log(s.dim(`[${new Date().toISOString()}] Executed ${commands.length} commands`))
          res.end(JSON.stringify({ terminal: terminal.name, results }))
        } catch (err) {
          res.statusCode = err instanceof RangeError ? 413 : 400
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
        }
        return
      }

      // Default: show help
      res.end(
        JSON.stringify({
          endpoints: {
            "/info": "Terminal info",
            "/probe": "Run all probes loaded at daemon startup",
            "/probe/single?id=sgr.bold": "Run single probe",
            "/query": "POST — execute raw escape sequence commands",
          },
          terminal: terminal.name,
          version: terminal.version,
        }),
      )
    })().catch((err) => {
      console.error("Probe daemon request failed:", err)
      if (res.headersSent) res.destroy(err instanceof Error ? err : new Error(String(err)))
      else {
        res.statusCode = 500
        res.end(JSON.stringify({ error: "Probe daemon request failed" }))
      }
    })
  })

  server.listen(port, "127.0.0.1", () => {
    const addr = server.address()
    if (!addr || typeof addr === "string") return
    const actualPort = addr.port

    const info: DaemonInfo = {
      pid: process.pid,
      port: actualPort,
      terminal: terminal.name,
      terminalVersion: terminal.version,
      os: terminal.os,
      osVersion: terminal.osVersion,
      started: new Date().toISOString(),
      token,
      runId,
    }

    const filepath = register(info)

    console.log(s.yellow(`! Probe daemon listening on localhost:${actualPort}; stop with Ctrl+C when done.\n`))
    console.log(`${s.bold("terminfo.dev")} daemon running\n`)
    console.log(`  Terminal:  ${s.bold(terminal.name)} ${terminal.version}`)
    console.log(`  Port:      ${s.bold(String(actualPort))}`)
    console.log(`  Probes:    loaded at startup (restart after definitions change)`)
    console.log(``)
    console.log(`  Test:   use the registered daemon token to authorize /probe`)
    console.log(`  Info:   curl http://localhost:${actualPort}/info`)
    console.log(`  Single: /probe/single?id=sgr.bold (token required)`)

    // Clean up on exit
    const cleanup = () => {
      let exitCode = 0
      try {
        unregister(filepath)
      } catch (err) {
        console.error(err)
        exitCode = 1
      }
      server.close()
      process.exit(exitCode)
    }
    process.on("SIGINT", cleanup)
    process.on("SIGTERM", cleanup)
  })
}

/** Read full request body */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > 65536) {
        reject(new RangeError("Query body exceeds 64 KiB"))
      } else chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString()))
    req.on("error", reject)
  })
}

/** Convert \\x1b notation to actual escape characters */
function unescapeSequence(s: string): string {
  return s
    .replace(/\\x([0-9a-fA-F]{2})/g, (_: string, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\e/g, "\x1b")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
}
