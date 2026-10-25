import {
  aggregateCurrentResults,
  currentCoverageSentence,
  currentSupportedShare,
} from "../../../docs/data/release-scope.ts"
/**
 * Mux probe mechanism — test feature pass-through of terminal multiplexers.
 *
 * Launches tmux/screen in detached mode with a serve daemon inside,
 * probes via HTTP, retains raw output or admits results, then kills the session.
 *
 * This reveals how features degrade through an intermediary — the same probes
 * that run directly on a terminal now run through the multiplexer's PTY layer.
 */

import { writeFileSync } from "node:fs"
import { execSync, spawnSync } from "node:child_process"
import { join } from "node:path"
import {
  createProbeRun,
  findOwnedDaemon,
  readRetainedDaemonProbeResponse,
  removeProbeRun,
  requestDaemonProbe,
  shellQuote,
  stopOwnedDaemon,
  type DaemonRegistration,
  type OwnedDaemon,
  type ProbeRun,
} from "../../terminfo.dev/src/daemon-client.ts"
import { homedir } from "node:os"
import { admitCollectedRun, retainCollectedRun } from "./admit-collected-run.ts"
import { serveCommand } from "./serve-command.ts"

const DAEMON_DIR = join(homedir(), ".terminfo-dev", "daemons")

// ── Multiplexer definitions ──

interface MuxDef {
  name: string
  id: string
  binary: string
  start: (binary: string, sessionName: string, scriptPath: string) => void
  kill: (binary: string, sessionName: string) => void
}

const MUXES: MuxDef[] = [
  {
    name: "tmux",
    id: "tmux",
    binary: "tmux",
    start: (binary, session, scriptPath) => {
      execSync(`${shellQuote(binary)} new-session -d -s ${session} -x 120 -y 40 "${scriptPath}"`, { timeout: 10_000 })
    },
    kill: (binary, session) => {
      execSync(`${shellQuote(binary)} kill-session -t ${session}`, { timeout: 5000, stdio: "ignore" })
    },
  },
  {
    name: "GNU Screen",
    id: "screen",
    binary: "screen",
    start: (binary, session, scriptPath) => {
      execSync(`${shellQuote(binary)} -dmS ${session} ${scriptPath}`, { timeout: 10_000 })
    },
    kill: (binary, session) => {
      execSync(`${shellQuote(binary)} -S ${session} -X quit`, { timeout: 5000, stdio: "ignore" })
    },
  },
]

// ── Helpers ──

function muxVersion(mux: MuxDef, binary: string): string {
  const args = [mux.id === "screen" ? "-v" : "-V"]
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 3000 })
  const pattern =
    mux.id === "screen"
      ? /^Screen version ([0-9]+\.[0-9]+\.[0-9]+)[^\r\n]*\r?\n?$/
      : /^tmux ([0-9]+\.[0-9]+[a-z]?)[^\r\n]*\r?\n?$/
  const match = pattern.exec(result.stdout ?? "")
  const version = match?.[1]
  const acceptedStatus = result.status === 0 || (mux.id === "screen" && result.status === 1)
  if (result.error || result.signal || !acceptedStatus || result.stderr !== "" || !version) {
    throw new Error(
      `${mux.id} version preflight failed for ${binary}: ${JSON.stringify({
        status: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error?.message,
      })}`,
    )
  }
  return version
}

function whichBinary(name: string): string | null {
  if (process.platform === "darwin") {
    // Standard system paths, without reading login profiles or changing this process's PATH.
    const paths = spawnSync("/usr/libexec/path_helper", ["-s"], { encoding: "utf8", timeout: 3000 })
    if (paths.error || paths.signal || paths.status !== 0 || paths.stderr !== "" || !paths.stdout.trim()) {
      throw new Error(
        `Darwin mux path_helper failed: ${JSON.stringify({ status: paths.status, stderr: paths.stderr, error: paths.error?.message })}`,
      )
    }
    const found = spawnSync("/bin/sh", ["-c", `${paths.stdout}\ncommand -v "$1"`, "terminfo-mux", name], {
      encoding: "utf8",
      timeout: 3000,
    })
    if (!found.error && !found.signal && found.status === 1 && found.stdout === "" && found.stderr === "") return null
    const binary = found.stdout?.trim() ?? ""
    if (found.error || found.signal || found.status !== 0 || found.stderr !== "" || !/^\/[^\r\n]+$/.test(binary)) {
      throw new Error(
        `Darwin mux executable lookup failed for ${name}: ${JSON.stringify({ status: found.status, stdout: found.stdout, stderr: found.stderr, error: found.error?.message })}`,
      )
    }
    return binary
  }
  try {
    return execSync(`which ${name}`, { encoding: "utf-8", timeout: 3000 }).trim() || null
  } catch {
    return null
  }
}

/**
 * Write a wrapper script that clears outer terminal identity env vars
 * so the daemon inside the mux detects the mux as the terminal.
 */
function writeServeScript(run: ProbeRun): void {
  const serveCmd = serveCommand(run)
  writeFileSync(
    run.scriptPath,
    [
      "#!/bin/bash",
      "unset __CFBundleIdentifier TERM_PROGRAM TERM_PROGRAM_VERSION",
      "unset GHOSTTY_RESOURCES_DIR KITTY_WINDOW_ID WEZTERM_EXECUTABLE ALACRITTY_WINDOW_ID TERMINAL_EMULATOR",
      serveCmd,
    ].join("\n") + "\n",
    { flag: "wx", mode: 0o700 },
  )
}

/** Probe a daemon and save results to probes-mux/ */
async function probeDaemon(
  daemon: DaemonRegistration,
  muxId: string,
  version: string,
  outputDirectory?: string,
): Promise<{ summary: string; mode: string }> {
  try {
    const res = await requestDaemonProbe(daemon)

    const retained = await readRetainedDaemonProbeResponse(res)
    console.log(`  Retained private HTTP response ${retained.path}; SHA256 ${retained.sha256}`)
    const data = retained.run
    const intended = { kind: "mux" as const, id: muxId, version }
    const source =
      outputDirectory !== undefined
        ? retainCollectedRun(data, retained.path, intended, outputDirectory)
        : admitCollectedRun(data, retained.path, intended)
    const mode = source.endsWith(".draft.json")
      ? "pending-review"
      : outputDirectory === undefined
        ? "admitted"
        : "private, unadmitted"
    const catalogIds = data.results.map((result) => result.featureId)
    const aggregate = aggregateCurrentResults(data.results, catalogIds)
    return { summary: `${currentSupportedShare(aggregate)} · ${currentCoverageSentence(aggregate, catalogIds)}`, mode }
  } catch (err) {
    console.log(`  Probe failed: ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
}

// ── Run one multiplexer ──

async function runMux(
  mux: MuxDef,
  opts: { force?: boolean; output?: string },
): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  const binary = whichBinary(mux.binary)
  if (!binary) return { success: false, error: "not installed" }
  const version = muxVersion(mux, binary)

  const run = createProbeRun()
  const sessionName = `terminfo-${run.id.slice(0, 16)}`
  let sessionStarted = false
  let daemon: OwnedDaemon | null = null
  let outcome: { success: boolean; error?: string } = { success: false, error: "probe did not complete" }
  try {
    writeServeScript(run)
    console.log(`  Launching ${mux.name} v${version}...`)
    mux.start(binary, sessionName, run.scriptPath)
    sessionStarted = true
    console.log(`  Waiting for owned daemon inside ${mux.name}...`)
    daemon = await findOwnedDaemon(run.id, DAEMON_DIR)
    if (!daemon) throw new Error("Owned daemon did not register within 30s")
    console.log(`  Probing on port ${daemon.registration.port}...`)
    const result = await probeDaemon(daemon.registration, mux.id, version, opts.output)
    console.log(`  ${result.summary} (${result.mode})`)
    outcome = { success: true }
  } catch (err) {
    outcome = { success: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    const cleanupErrors: string[] = []
    if (daemon) {
      try {
        await stopOwnedDaemon(daemon)
      } catch (err) {
        cleanupErrors.push(`daemon: ${String(err)}`)
      }
    }
    if (sessionStarted) {
      try {
        mux.kill(binary, sessionName)
      } catch (err) {
        cleanupErrors.push(`session: ${String(err)}`)
      }
    }
    try {
      removeProbeRun(run)
    } catch (err) {
      cleanupErrors.push(`script: ${String(err)}`)
    }
    if (cleanupErrors.length > 0) {
      outcome = {
        success: false,
        error: [outcome.success ? undefined : outcome.error, ...cleanupErrors].filter(Boolean).join("; "),
      }
    }
  }
  return outcome
}

// ── Main handler ──

export async function handleMux(
  muxName: string | undefined,
  opts: { all?: boolean; force?: boolean; output?: string },
): Promise<void> {
  if (!muxName && !opts.all) {
    console.log("\nAvailable multiplexers:\n")
    for (const mux of MUXES) {
      const binary = whichBinary(mux.binary)
      const installed = !!binary
      const version = binary ? muxVersion(mux, binary) : ""
      console.log(`  ${installed ? "+" : "-"} ${mux.name.padEnd(16)} ${version}`)
    }
    console.log("\nProbe all:  terminfo probe mux --all")
    console.log("Probe one:  terminfo probe mux tmux")
    console.log(`\nApproach: launches mux → starts serve daemon inside → probes via HTTP → kills session`)
    return
  }

  let muxesToRun = MUXES
  if (muxName) {
    const name = muxName.toLowerCase()
    muxesToRun = MUXES.filter((m) => m.id === name || m.name.toLowerCase() === name)
    if (muxesToRun.length === 0) {
      throw new Error(`Unknown multiplexer. Available: ${MUXES.map((m) => m.id).join(", ")}`)
    }
  }

  muxesToRun = muxesToRun.filter((m) => !!whichBinary(m.binary))
  if (muxesToRun.length === 0) {
    throw new Error("No multiplexers available to test.")
  }

  console.log(`\nProbing through ${muxesToRun.length} multiplexer(s)\n`)

  const outcomes: Array<{ mux: MuxDef; result: Awaited<ReturnType<typeof runMux>> }> = []

  for (const mux of muxesToRun) {
    console.log(`--- ${mux.name} ---`)
    const result = await runMux(mux, { force: opts.force, output: opts.output })
    outcomes.push({ mux, result })

    if (result.skipped) {
      console.log(`  Cached (120+ probes). Use --force to re-run.`)
    } else if (!result.success) {
      console.log(`  FAILED: ${result.error}`)
    }

    // Pause between launches
    if (muxesToRun.indexOf(mux) < muxesToRun.length - 1) {
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 2000)
      })
    }
  }

  console.log("\n=== Summary ===\n")
  for (const { mux, result } of outcomes) {
    const status = result.skipped ? "cached" : result.success ? "OK" : `FAIL: ${result.error}`
    console.log(`  ${mux.name.padEnd(16)} ${status}`)
  }

  const failures = outcomes.filter(({ result }) => !result.success)
  if (failures.length > 0) {
    throw new Error(
      `Mux collection failed: ${failures.map(({ mux, result }) => `${mux.id}: ${result.error}`).join("; ")}`,
    )
  }
  console.log(
    opts.output !== undefined
      ? `\nRaw results retained privately in ${opts.output}; nothing admitted`
      : `\nResults admitted to content/probes-mux/`,
  )
}
