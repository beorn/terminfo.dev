/**
 * The one cmux initial-command launcher (34302, @cto 340f4d9f R1): the only code that writes the
 * `initial-command` key cmux reads from the Ghostty config, called by the measurement workflow and
 * by the admin probe's cmux arm. Starting a process inside a cmux surface is how a probe enters
 * cmux under `automation.socketControlMode = cmuxOnly`: admission is process ancestry, so the
 * surface shell's children are admitted and an ssh-launched process is not.
 *
 * This runs only inside a booked window on that Mac (@cto a620a643): the chief's booking is the
 * exclusion, one run at a time; there is no code-level run slot and this adds none.
 *
 * The config file is the operator's own Ghostty config on the fleet Mac, so the rules are strict:
 * append exactly one line, never rewrite the file; restore by line in the finally path (C1); a key
 * this launcher wrote in an earlier, killed run is recognised by its run-scoped command file,
 * removed, and reported — only a key it cannot recognise refuses (C2); the started pid's parent
 * chain must reach the cmux process before anything is closed (C4).
 */
import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { shellQuote } from "./daemon-client.ts"

export interface CmuxLaunchDeps {
  /** Open the app bundle (`open -a`); returns nothing, throws on failure. */
  openApp: (appBundle: string) => void
  sleep: (ms: number) => Promise<void>
  /** Parent pids of `pid`, nearest first, ending at the root of the chain. */
  parentChain: (pid: number) => number[]
  /** Executable path of a live pid, or null when it is gone. */
  executableOf: (pid: number) => string | null
}

export interface CmuxInitialCommandLaunch {
  runId: string
  commandPath: string
  startedPid: number
  /** True when a stale key from an earlier run by this launcher was removed first (C2). */
  removedStaleKey: boolean
  /** Remove our line from the config: "exact" when the file was otherwise untouched. */
  restore: () => "exact" | "line-removed"
}

export interface CmuxInitialCommandOptions {
  /** The Ghostty config cmux reads (on the fleet Mac: ~/.config/ghostty/config). */
  configPath: string
  appBundle: string
  /** The cmux GUI executable a started pid's parent chain must reach. */
  cmuxExecutable: string
  /** Directory holding this run's command file and started marker (run-scoped). */
  cmuxConfigDir: string
  commandPath: string
  startedMarkerPath: string
  /** The script the surface shell ultimately runs (the probe's serve line). */
  payloadPath: string
  runId: string
  timeoutMs?: number
}

const KEY_HEADER = "# terminfo-cmux-initial-command "

/** The per-run command file: carries the literal run id (R4) and self-invalidates after one start (C2). */
export function cmuxCommandFile(opts: { runId: string; startedMarkerPath: string; payloadPath: string }): string {
  return [
    "#!/bin/bash -p",
    `${KEY_HEADER}${opts.runId}`,
    `if ! ( set -o noclobber; printf '%s %s\\n' "$$" "$PPID" > ${shellQuote(opts.startedMarkerPath)} ) 2>/dev/null; then`,
    "  echo 'cmux-initial-command-already-started' >&2",
    "  exit 1",
    "fi",
    `TERMINFO_RUN_ID=${shellQuote(opts.runId)}`,
    "export TERMINFO_RUN_ID",
    `exec /bin/bash -p ${shellQuote(opts.payloadPath)}`,
    "",
  ].join("\n")
}

function initialCommandLines(content: string): { line: string; command: string }[] {
  const found: { line: string; command: string }[] = []
  for (const line of content.split("\n")) {
    const match = /^initial-command\s*=\s*(.+)$/.exec(line.trim())
    if (match?.[1] !== undefined) found.push({ line, command: match[1].trim() })
  }
  return found
}

/** The command file path a key points at, when it is a `/bin/bash <path>` key like ours. */
function keyBashPath(command: string): string | null {
  const match = /^\/bin\/bash\s+(.+)$/.exec(command)
  if (match?.[1] === undefined) return null
  const raw = match[1].trim()
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replaceAll("'\\''", "'")
  return raw.split(/\s+/)[0] ?? null
}

/** Ours: the file the key names exists and carries this launcher's header (C2 recognition). */
function isOurKey(command: string): boolean {
  const path = keyBashPath(command)
  if (path === null || !existsSync(path)) return false
  try {
    return readFileSync(path, "utf8").includes(KEY_HEADER)
  } catch {
    return false
  }
}

function defaultDeps(): CmuxLaunchDeps {
  return {
    openApp: (appBundle) => {
      const result = spawnSync("open", ["-a", appBundle], { encoding: "utf8", timeout: 15_000 })
      if (result.error || result.status !== 0) {
        throw new Error(`cmux-open-failed: open -a ${appBundle} exited ${result.status ?? result.error?.message}`)
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    parentChain: (pid) => {
      const chain: number[] = []
      let current = pid
      for (let depth = 0; depth < 128; depth++) {
        const result = spawnSync("ps", ["-o", "ppid=", "-p", String(current)], { encoding: "utf8" })
        const parent = Number.parseInt((result.stdout ?? "").trim(), 10)
        if (!Number.isSafeInteger(parent) || parent <= 0 || parent === current) break
        chain.push(parent)
        current = parent
      }
      return chain
    },
    executableOf: (pid) => {
      const result = spawnSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" })
      const exe = (result.stdout ?? "").trim()
      return exe === "" ? null : exe
    },
  }
}

export async function launchCmuxInitialCommand(
  opts: CmuxInitialCommandOptions,
  deps: CmuxLaunchDeps = defaultDeps(),
): Promise<CmuxInitialCommandLaunch> {
  const timeoutMs = opts.timeoutMs ?? 30_000
  const prior = existsSync(opts.configPath) ? readFileSync(opts.configPath, "utf8") : null
  let content = prior ?? ""
  let removedStaleKey = false
  for (const key of initialCommandLines(content)) {
    if (!isOurKey(key.command)) {
      throw new Error(
        `cmux-initial-command-foreign: ${opts.configPath} holds an initial-command this launcher did not write (${key.command}); refusing to launch cmux`,
      )
    }
    content = content
      .split("\n")
      .filter((line) => line !== key.line)
      .join("\n")
    removedStaleKey = true
  }
  if (existsSync(opts.startedMarkerPath)) {
    throw new Error(
      `cmux-initial-command-already-started: ${opts.startedMarkerPath} already exists before launch; refusing to launch cmux`,
    )
  }
  mkdirSync(opts.cmuxConfigDir, { recursive: true })
  mkdirSync(dirname(opts.configPath), { recursive: true })
  writeFileSync(
    opts.commandPath,
    cmuxCommandFile({ runId: opts.runId, startedMarkerPath: opts.startedMarkerPath, payloadPath: opts.payloadPath }),
    { flag: "wx", mode: 0o700 },
  )
  // Append our one line; the file is never rewritten from a snapshot (C1). Only the stale-key
  // cleanup above may rewrite, and only when it actually removed a key.
  const ourLine = `initial-command = /bin/bash ${shellQuote(opts.commandPath)}`
  if (removedStaleKey) writeFileSync(opts.configPath, content, { mode: 0o600 })
  if (content !== "" && !content.endsWith("\n")) appendFileSync(opts.configPath, "\n", { mode: 0o600 })
  appendFileSync(opts.configPath, `${ourLine}\n`, { mode: 0o600 })
  const withKey = `${content}${content === "" || content.endsWith("\n") ? "" : "\n"}${ourLine}\n`

  // The bytes a clean restore returns to: the config as it stood once stale own keys were removed.
  const baseContent = content
  const restore = (): "exact" | "line-removed" => {
    const now = existsSync(opts.configPath) ? readFileSync(opts.configPath, "utf8") : ""
    if (now === withKey) {
      writeFileSync(opts.configPath, baseContent, { mode: 0o600 })
      return "exact"
    }
    const lines = now.split("\n").filter((line) => line !== ourLine)
    writeFileSync(opts.configPath, lines.join("\n"), { mode: 0o600 })
    return "line-removed"
  }

  try {
    deps.openApp(opts.appBundle)
    const deadline = Date.now() + timeoutMs
    let started: { pid: number; parent: number } | null = null
    while (Date.now() <= deadline) {
      if (existsSync(opts.startedMarkerPath)) {
        const fields = readFileSync(opts.startedMarkerPath, "utf8").trim().split(/\s+/)
        const pid = Number(fields[0])
        const parent = Number(fields[1])
        if (Number.isSafeInteger(pid) && Number.isSafeInteger(parent)) started = { pid, parent }
        break
      }
      await deps.sleep(100)
    }
    if (started === null) {
      throw new Error(
        `cmux-initial-command-not-run: no started marker at ${opts.startedMarkerPath} within ${timeoutMs}ms after open -a ${opts.appBundle} (is cmux already running without reading the key?); the window ends here`,
      )
    }
    const chain = [started.parent, ...deps.parentChain(started.parent)]
    const reachesCmux = chain.some((pid) => deps.executableOf(pid) === opts.cmuxExecutable)
    if (!reachesCmux) {
      throw new Error(
        `cmux-initial-command-parent-mismatch: started pid ${started.pid} (parent ${started.parent}) does not descend from ${opts.cmuxExecutable}; closing nothing`,
      )
    }
    return { runId: opts.runId, commandPath: opts.commandPath, startedPid: started.pid, removedStaleKey, restore }
  } catch (error) {
    restore()
    throw error
  }
}
