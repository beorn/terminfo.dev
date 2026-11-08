/** The owned Linux screen CLI's retained scrollback, read through its own `hardcopy -h`. */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

interface ScreenScrollbackOptions {
  readonly executable: string
  /** The explicit owned session; absent, blank or padded never falls back to an ambient one. */
  readonly session: string | undefined
  /** Where this run's own hardcopy writes; never a shared or ambient file. */
  readonly hardcopyPath: string
}

export type ScreenScrollbackReading =
  | { readonly status: "read"; readonly totalLines: number; readonly receipt: string }
  | { readonly status: "refused"; readonly reason: string }

/**
 * `hardcopy -h` writes the whole retained buffer of the named session, one line per row, so its
 * line count is the terminal's totalLines. Screen exposes no viewport offset, so the offset and the
 * screen-row readings stay unavailable here rather than being inferred from this count.
 */
export function readScreenScrollback(options: ScreenScrollbackOptions): ScreenScrollbackReading {
  const session = options.session?.trim() ?? ""
  if (session === "" || /\s/u.test(session)) {
    return { status: "refused", reason: "screen reader has no explicit owned session name" }
  }
  const result = spawnSync(options.executable, ["-S", session, "-X", "hardcopy", "-h", options.hardcopyPath], {
    stdio: ["pipe", "pipe", "pipe"],
  })
  const stdout = result.stdout?.toString() ?? ""
  const stderr = result.stderr?.toString() ?? ""
  if (result.status !== 0) {
    return {
      status: "refused",
      reason: `screen hardcopy exited ${String(result.status)}: stderr=${JSON.stringify(stderr)} stdout=${JSON.stringify(stdout)}`,
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
  const lines = text === "" ? [] : text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n")
  return {
    status: "read",
    totalLines: lines.length,
    receipt: `screen hardcopy -h bytes=${Buffer.byteLength(text)} totalLines=${lines.length}`,
  }
}
