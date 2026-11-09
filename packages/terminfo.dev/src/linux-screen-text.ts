/** The owned Linux screen CLI's retained scrollback, read through its own `hardcopy -h`. */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { isAbsolute } from "node:path"

const HARDCOPY_POLL_DEADLINE_MS = 2000
const HARDCOPY_POLL_INTERVAL_MS = 10
const pollWaitBuffer = new Int32Array(new SharedArrayBuffer(4))

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

function resolveScrollbackCapacity(
  options: ScreenScrollbackOptions,
): { readonly ok: true; readonly capacity: number } | { readonly ok: false; readonly reason: string } {
  let fromConfig: number | undefined
  if (options.configPath !== undefined) {
    const configPath = options.configPath.trim()
    if (configPath === "") {
      return {
        ok: false,
        reason: `screen reader needs a non-empty configPath for ${options.hardcopyPath}`,
      }
    }
    let configText: string
    try {
      configText = readFileSync(configPath, "utf8")
    } catch (error) {
      return {
        ok: false,
        reason: `screen reader cannot read owned config at ${configPath} for ${options.hardcopyPath}: ${String((error as Error).message)}`,
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
          reason: `screen config at ${configPath} has invalid defscrollback ${JSON.stringify(match[1])} for ${options.hardcopyPath}`,
        }
      }
      if (fromConfig !== undefined && fromConfig !== parsed) {
        return {
          ok: false,
          reason: `screen config at ${configPath} declares conflicting defscrollback values (${fromConfig} vs ${parsed}) for ${options.hardcopyPath}`,
        }
      }
      fromConfig = parsed
    }
    if (fromConfig === undefined) {
      return {
        ok: false,
        reason: `screen config at ${configPath} does not declare defscrollback for ${options.hardcopyPath}`,
      }
    }
  }
  if (options.capacity !== undefined) {
    if (typeof options.capacity !== "number" || !Number.isSafeInteger(options.capacity) || options.capacity < 0) {
      return {
        ok: false,
        reason: `screen hardcopy at ${options.hardcopyPath} has invalid scrollback capacity (${String(options.capacity)})`,
      }
    }
    if (fromConfig !== undefined && fromConfig !== options.capacity) {
      return {
        ok: false,
        reason: `screen hardcopy at ${options.hardcopyPath} has conflicting capacity (${options.capacity}) vs config defscrollback (${fromConfig})`,
      }
    }
    return { ok: true, capacity: options.capacity }
  }
  if (fromConfig !== undefined) return { ok: true, capacity: fromConfig }
  return {
    ok: false,
    reason: `screen hardcopy at ${options.hardcopyPath} has no scrollback capacity or configPath`,
  }
}

/**
 * `hardcopy -h` writes the session's full scrollback capacity followed by the `rows` visible screen
 * lines, padding unused capacity at the top of the `capacity` history region with blank lines.
 * Because `screen -X hardcopy -h` only queues the dump on the running Screen server and exits 0
 * before the server finishes writing the file, poll until the file holds `capacity + rows` lines
 * (within a 2 s deadline). Count history only inside those first `capacity` lines starting from
 * that region's first non-blank line (`history = max(0, that count)`, `screenLines = rows`,
 * `totalLines = history + rows`).
 * Limit: a real blank line at the very top of retained history looks the same as capacity padding;
 * the probes seed non-blank rows. Screen exposes no viewport offset, so `viewportOffset` stays absent.
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
  const resolvedCapacity = resolveScrollbackCapacity(options)
  if (!resolvedCapacity.ok) {
    return { status: "refused", reason: resolvedCapacity.reason }
  }
  const { capacity } = resolvedCapacity
  const expectedLines = capacity + rows
  if (existsSync(options.hardcopyPath)) {
    return {
      status: "refused",
      reason: `screen hardcopy target at ${options.hardcopyPath} already exists before dump`,
    }
  }
  const result = spawnSync(options.executable, ["-S", session, "-X", "hardcopy", "-h", options.hardcopyPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, SCREENDIR: socketDirectory },
    timeout: 3000,
    killSignal: "SIGKILL",
  })
  const stdout = result.stdout?.toString() ?? ""
  const stderr = result.stderr?.toString() ?? ""
  if (result.status !== 0) {
    return {
      status: "refused",
      reason: `screen hardcopy exited ${String(result.status)} at SCREENDIR=${JSON.stringify(socketDirectory)}: stderr=${JSON.stringify(stderr)} stdout=${JSON.stringify(stdout)}`,
    }
  }
  const startedAt = Date.now()
  let hasFile = false
  let lastError: unknown
  let lastBytes = 0
  let lastLines: string[] = []
  while (true) {
    try {
      const text = readFileSync(options.hardcopyPath, "utf8")
      hasFile = true
      lastError = undefined
      lastBytes = Buffer.byteLength(text)
      lastLines = text === "" ? [] : text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n")
      if (lastLines.length === expectedLines) break
      if (lastLines.length > expectedLines) {
        return {
          status: "refused",
          reason: `screen hardcopy at ${options.hardcopyPath} has ${lastLines.length} lines (${lastBytes} bytes), expected ${expectedLines} lines (${capacity} capacity + ${rows} screen rows)`,
        }
      }
    } catch (error) {
      hasFile = false
      lastError = error
      lastBytes = 0
      lastLines = []
    }
    const elapsedMs = Date.now() - startedAt
    if (elapsedMs >= HARDCOPY_POLL_DEADLINE_MS) {
      const seen = !hasFile
        ? `no readable file (${String((lastError as Error)?.message ?? lastError)})`
        : lastBytes === 0
          ? "empty file (0 bytes, 0 lines)"
          : `${lastBytes} bytes, ${lastLines.length} lines`
      return {
        status: "refused",
        reason: `screen hardcopy at ${options.hardcopyPath} incomplete after ${elapsedMs}ms (deadline ${HARDCOPY_POLL_DEADLINE_MS}ms): saw ${seen}, expected ${expectedLines} lines (${capacity} capacity + ${rows} screen rows)`,
      }
    }
    const remainingMs = HARDCOPY_POLL_DEADLINE_MS - elapsedMs
    Atomics.wait(pollWaitBuffer, 0, 0, Math.min(HARDCOPY_POLL_INTERVAL_MS, remainingMs))
  }
  // Limit: a real blank line at the very top of retained history looks the same as capacity
  // padding; the probes seed non-blank rows.
  const historyRegion = lastLines.slice(0, capacity)
  const firstNonBlank = historyRegion.findIndex((line) => line.trim().length > 0)
  const history = firstNonBlank < 0 ? 0 : Math.max(0, historyRegion.length - firstNonBlank)
  const screenLines = rows
  const totalLines = history + rows
  return {
    status: "read",
    totalLines,
    screenLines,
    capacity,
    receipt: `screen hardcopy -h bytes=${lastBytes} dumpLines=${lastLines.length} capacity=${capacity} history=${history} screenLines=${screenLines} totalLines=${totalLines}`,
  }
}
