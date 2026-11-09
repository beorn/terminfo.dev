/** The owned Linux screen CLI's retained scrollback, read through its own `hardcopy -h`. */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
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
}

export type ScreenScrollbackReading =
  | { readonly status: "read"; readonly totalLines: number; readonly screenLines: number; readonly receipt: string }
  | { readonly status: "refused"; readonly reason: string }

/**
 * `hardcopy -h` writes the session's full scrollback capacity followed by the `rows` visible screen
 * lines, padding unused capacity at the top of the `L - rows` history region with blank lines.
 * Count history only inside those first `L - rows` lines starting from that region's first
 * non-blank line (`history = max(0, that count)`, `screenLines = rows`, `totalLines = history + rows`).
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
  let text: string
  try {
    text = readFileSync(options.hardcopyPath, "utf8")
  } catch (error) {
    return {
      status: "refused",
      reason: `screen hardcopy left no readable file at ${options.hardcopyPath}: ${String((error as Error).message)}`,
    }
  }
  if (text === "") {
    return { status: "refused", reason: `screen hardcopy left an empty file at ${options.hardcopyPath}` }
  }
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n")
  const rows = options.rows
  if (typeof rows !== "number" || !Number.isSafeInteger(rows) || rows < 1) {
    return {
      status: "refused",
      reason: `screen hardcopy at ${options.hardcopyPath} has ${lines.length} lines but run geometry rows is invalid (${String(rows)})`,
    }
  }
  if (lines.length < rows) {
    return {
      status: "refused",
      reason: `screen hardcopy at ${options.hardcopyPath} has ${lines.length} lines, fewer than the ${rows} screen rows`,
    }
  }
  // Limit: a real blank line at the very top of retained history looks the same as capacity
  // padding; the probes seed non-blank rows.
  const historyRegion = lines.slice(0, lines.length - rows)
  const firstNonBlank = historyRegion.findIndex((line) => line.trim().length > 0)
  const history = firstNonBlank < 0 ? 0 : Math.max(0, historyRegion.length - firstNonBlank)
  const screenLines = rows
  const totalLines = history + rows
  return {
    status: "read",
    totalLines,
    screenLines,
    receipt: `screen hardcopy -h bytes=${Buffer.byteLength(text)} dumpLines=${lines.length} history=${history} screenLines=${screenLines} totalLines=${totalLines}`,
  }
}
