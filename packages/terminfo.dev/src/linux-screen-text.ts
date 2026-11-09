/** The owned Linux screen CLI's retained scrollback, read through its own `hardcopy -h`. */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { isAbsolute } from "node:path"

interface ScreenScrollbackOptions {
  readonly executable: string
  /** The explicit owned session; absent, blank or padded never falls back to an ambient one. */
  readonly session: string | undefined
  /** This run's own screen socket directory; the ambient SCREENDIR is never used. */
  readonly socketDirectory: string
  /** Where this run's own hardcopy writes; never a shared or ambient file. */
  readonly hardcopyPath: string
  /** This run's own measured screen row count; never guessed from the hardcopy dump. */
  readonly rows?: number | undefined
  /** This run's own Screen config file (`screenrc`) declaring `defscrollback <N>`. */
  readonly configPath?: string | undefined
  /** Explicit scrollback capacity when already parsed from the owned Screen config. */
  readonly capacity?: number | undefined
}

export type ScreenScrollbackReading =
  | {
      readonly status: "read"
      readonly totalLines: number
      readonly screenLines: number
      readonly capacity: number
      readonly receipt: string
    }
  | { readonly status: "refused"; readonly reason: string }

export type ScreenScrollbackResetOptions = Omit<ScreenScrollbackOptions, "hardcopyPath" | "rows">

export type ScreenScrollbackResetResult =
  | { readonly status: "reset"; readonly capacity: number }
  | { readonly status: "refused"; readonly reason: string }

function resolveScrollbackCapacity(
  options: Pick<ScreenScrollbackOptions, "configPath" | "capacity">,
  contextTarget: string,
  subjectTarget: string,
): { readonly ok: true; readonly capacity: number } | { readonly ok: false; readonly reason: string } {
  let fromConfig: number | undefined
  if (options.configPath !== undefined) {
    const configPath = options.configPath.trim()
    if (configPath === "") {
      return {
        ok: false,
        reason: `screen reader needs a non-empty configPath for ${contextTarget}`,
      }
    }
    let configText: string
    try {
      configText = readFileSync(configPath, "utf8")
    } catch (error) {
      return {
        ok: false,
        reason: `screen reader cannot read owned config at ${configPath} for ${contextTarget}: ${String((error as Error).message)}`,
      }
    }
    for (const rawLine of configText.split(/\r?\n/u)) {
      const line = rawLine.trim()
      if (line === "" || line.startsWith("#")) continue
      const match = /^defscrollback\s+(\S+)(?:\s+#.*)?$/u.exec(line)
      if (!match) continue
      const parsed = Number(match[1])
      if (!/^\d+$/u.test(match[1] ?? "") || !Number.isSafeInteger(parsed) || parsed < 0) {
        return {
          ok: false,
          reason: `screen config at ${configPath} has invalid defscrollback ${JSON.stringify(match[1])} for ${contextTarget}`,
        }
      }
      if (fromConfig !== undefined && fromConfig !== parsed) {
        return {
          ok: false,
          reason: `screen config at ${configPath} declares conflicting defscrollback values (${fromConfig} vs ${parsed}) for ${contextTarget}`,
        }
      }
      fromConfig = parsed
    }
    if (fromConfig === undefined) {
      return {
        ok: false,
        reason: `screen config at ${configPath} does not declare defscrollback for ${contextTarget}`,
      }
    }
  }
  if (options.capacity !== undefined) {
    if (typeof options.capacity !== "number" || !Number.isSafeInteger(options.capacity) || options.capacity < 0) {
      return {
        ok: false,
        reason: `${subjectTarget} has invalid scrollback capacity (${String(options.capacity)})`,
      }
    }
    if (fromConfig !== undefined && fromConfig !== options.capacity) {
      return {
        ok: false,
        reason: `${subjectTarget} has conflicting capacity (${options.capacity}) vs config defscrollback (${fromConfig})`,
      }
    }
    return { ok: true, capacity: options.capacity }
  }
  if (fromConfig !== undefined) return { ok: true, capacity: fromConfig }
  return {
    ok: false,
    reason: `${subjectTarget} has no scrollback capacity or configPath`,
  }
}

/**
 * Empty the owned Screen window's retained history while keeping its configured `defscrollback`
 * capacity (#32801): `screen -S <session> -X scrollback 0` followed by
 * `screen -S <session> -X scrollback <N>` on the same owned `SCREENDIR`, where `N` comes from the
 * run's own `screenrc` through `resolveScrollbackCapacity`. Screen processes socket commands in
 * order, so the baseline `readScreenScrollback`'s `-Q number` query fences both commands.
 */
function formatSpawnExit(result: { status: number | null; signal: NodeJS.Signals | null; error?: Error }): string {
  if (result.status !== null) return `exited ${result.status}`
  const details = [
    result.signal ? `signal=${result.signal}` : null,
    result.error ? `error=${result.error.message || String(result.error)}` : null,
  ].filter((part): part is string => part !== null)
  return details.length > 0 ? `exited null (${details.join(", ")})` : "exited null"
}

export function resetScreenScrollback(options: ScreenScrollbackResetOptions): ScreenScrollbackResetResult {
  const session = options.session?.trim() ?? ""
  if (session === "" || /\s/u.test(session)) {
    return { status: "refused", reason: "screen reset has no explicit owned session name" }
  }
  const socketDirectory = options.socketDirectory?.trim() ?? ""
  if (socketDirectory === "" || !isAbsolute(socketDirectory)) {
    return {
      status: "refused",
      reason: `screen reset needs an absolute owned socket directory, got ${JSON.stringify(options.socketDirectory)}`,
    }
  }
  const resolvedCapacity = resolveScrollbackCapacity(
    options,
    `session ${JSON.stringify(session)}`,
    `screen scrollback reset for ${JSON.stringify(session)}`,
  )
  if (!resolvedCapacity.ok) {
    return { status: "refused", reason: resolvedCapacity.reason }
  }
  const { capacity } = resolvedCapacity
  const spawnEnv = { ...process.env, SCREENDIR: socketDirectory }
  for (const target of ["0", String(capacity)]) {
    const result = spawnSync(options.executable, ["-S", session, "-X", "scrollback", target], {
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv,
      timeout: 3000,
      killSignal: "SIGKILL",
    })
    const stdout = result.stdout?.toString() ?? ""
    const stderr = result.stderr?.toString() ?? ""
    if (result.status !== 0) {
      return {
        status: "refused",
        reason: `screen scrollback ${target} ${formatSpawnExit(result)} at SCREENDIR=${JSON.stringify(socketDirectory)}: stderr=${JSON.stringify(stderr)} stdout=${JSON.stringify(stdout)}`,
      }
    }
  }
  return { status: "reset", capacity }
}

/**
 * `hardcopy -h` writes the session's retained (used) scrollback lines followed by the `rows`
 * visible screen lines (`rows <= dumpLines <= capacity + rows`); it never pads unused capacity
 * with blank lines. Because `screen -X hardcopy -h` queues the dump on the running Screen server
 * and can exit 0 before the server finishes writing the file, follow it with synchronous
 * `screen -S <session> -Q number` on the same owned `SCREENDIR`: Screen handles commands in order
 * and writes the dump inside `hardcopy -h` before answering the query. Then read the file once and
 * count `history = dumpLines - rows`, `screenLines = rows`, `totalLines = dumpLines` (with no
 * first-non-blank rule), refusing if the query fails or `dumpLines` is outside
 * `[rows, capacity + rows]`. Screen exposes no viewport offset, so `viewportOffset` stays absent.
 */
export function readScreenScrollback(options: ScreenScrollbackOptions): ScreenScrollbackReading {
  const session = options.session?.trim() ?? ""
  if (session === "" || /\s/u.test(session)) {
    return { status: "refused", reason: "screen reader has no explicit owned session name" }
  }
  const socketDirectory = options.socketDirectory?.trim() ?? ""
  if (socketDirectory === "" || !isAbsolute(socketDirectory)) {
    return {
      status: "refused",
      reason: `screen reader needs an absolute owned socket directory, got ${JSON.stringify(options.socketDirectory)}`,
    }
  }
  const rows = options.rows
  if (typeof rows !== "number" || !Number.isSafeInteger(rows) || rows < 1) {
    return {
      status: "refused",
      reason: `screen hardcopy at ${options.hardcopyPath} has invalid run geometry rows (${String(rows)})`,
    }
  }
  const resolvedCapacity = resolveScrollbackCapacity(
    options,
    options.hardcopyPath,
    `screen hardcopy at ${options.hardcopyPath}`,
  )
  if (!resolvedCapacity.ok) {
    return { status: "refused", reason: resolvedCapacity.reason }
  }
  const { capacity } = resolvedCapacity
  const maxLines = capacity + rows
  if (existsSync(options.hardcopyPath)) {
    return {
      status: "refused",
      reason: `screen hardcopy target at ${options.hardcopyPath} already exists before dump`,
    }
  }
  const spawnEnv = { ...process.env, SCREENDIR: socketDirectory }
  const result = spawnSync(options.executable, ["-S", session, "-X", "hardcopy", "-h", options.hardcopyPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: spawnEnv,
    timeout: 3000,
    killSignal: "SIGKILL",
  })
  const stdout = result.stdout?.toString() ?? ""
  const stderr = result.stderr?.toString() ?? ""
  if (result.status !== 0) {
    return {
      status: "refused",
      reason: `screen hardcopy ${formatSpawnExit(result)} at SCREENDIR=${JSON.stringify(socketDirectory)}: stderr=${JSON.stringify(stderr)} stdout=${JSON.stringify(stdout)}`,
    }
  }
  const query = spawnSync(options.executable, ["-S", session, "-Q", "number"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: spawnEnv,
    timeout: 3000,
    killSignal: "SIGKILL",
  })
  const queryStdout = query.stdout?.toString() ?? ""
  const queryStderr = query.stderr?.toString() ?? ""
  if (query.status !== 0) {
    return {
      status: "refused",
      reason: `screen query (-Q number) ${formatSpawnExit(query)} at SCREENDIR=${JSON.stringify(socketDirectory)} for ${options.hardcopyPath}: stderr=${JSON.stringify(queryStderr)} stdout=${JSON.stringify(queryStdout)}`,
    }
  }
  let text: string
  try {
    text = readFileSync(options.hardcopyPath, "utf8")
  } catch (error) {
    return {
      status: "refused",
      reason: `screen hardcopy at ${options.hardcopyPath} could not be read after -Q number: ${String((error as Error)?.message ?? error)}`,
    }
  }
  const bytes = Buffer.byteLength(text)
  const dumpLines = text === "" ? [] : text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n")
  if (dumpLines.length < rows || dumpLines.length > maxLines) {
    const detail = bytes === 0 ? "empty file (0 bytes, 0 lines)" : `${dumpLines.length} lines (${bytes} bytes)`
    return {
      status: "refused",
      reason: `screen hardcopy at ${options.hardcopyPath} has ${detail}, expected ${rows}..${maxLines} lines (${rows} screen rows + up to ${capacity} history capacity)`,
    }
  }
  const history = dumpLines.length - rows
  const screenLines = rows
  const totalLines = dumpLines.length
  return {
    status: "read",
    totalLines,
    screenLines,
    capacity,
    receipt: `screen hardcopy -h bytes=${bytes} dumpLines=${dumpLines.length} capacity=${capacity} history=${history} screenLines=${screenLines} totalLines=${totalLines}`,
  }
}
