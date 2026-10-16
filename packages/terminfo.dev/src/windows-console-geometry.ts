/**
 * The console geometry read for the hosted Windows arm of the owned terminal (29558, option A).
 *
 * Why this exists: 138 of a hosted Windows run's 182 inconclusive observations carry one note —
 * "No verified owned terminal for geometry read" — and the candidate-2 classics need a geometry, so
 * the row measured 1 of 122. The route has no win32 branch in the owned-terminal arm table, and no
 * Windows member in GeometrySource, so ownership is never established there.
 *
 * The read, in the order the design fixed (@cto-approved, measured before this code):
 *  - primary: GetConsoleScreenBufferInfo on this process's own CONOUT$ through ./windows-console-ffi.ts.
 *    Locale-free, no child process, microseconds, and it is the same console the probes write to.
 *  - fallback: `cmd /c mode con`, ~27 ms per read (3 of 3 measured), used only when the ffi read
 *    cannot answer at all. It parses the device-status block, whose first two numbers are the line
 *    count then the column count in every locale (the labels are translated; that order is not).
 *
 * NO SILENT FALLBACK: with neither read answering, the result is `unavailable` and carries both
 * attempts, so the caller keeps the loud note it has today rather than grading on a guessed size.
 */
import { spawnSync } from "node:child_process"

/** The console's visible window. Defined here, the arm's own concept; the ffi half imports it. */
export type ConsoleGeometry = { readonly cols: number; readonly rows: number }

export type ModeConReply = { readonly stdout: string; readonly stderr: string; readonly status: number | null }

export type ConsoleGeometryRead =
  | { readonly status: "measured"; readonly via: "ffi" | "mode-con"; readonly cols: number; readonly rows: number }
  | { readonly status: "unavailable"; readonly diagnostic: string }

/** `mode con` prints Lines then Columns (then the keyboard rate and delay, then the code page), so
 * the first two numbers of the block are the geometry. Anything else is a refusal, never a guess. */
export function parseModeConGeometry(stdout: string): ConsoleGeometry {
  const numbers = (stdout.match(/\d+/gu) ?? []).map(Number)
  const rows = numbers[0]
  const cols = numbers[1]
  const plausible = (value: number | undefined): value is number =>
    value !== undefined && Number.isInteger(value) && value >= 1 && value <= 9999
  if (numbers.length < 2 || !plausible(rows) || !plausible(cols)) {
    throw new Error(`\`mode con\` reported no console geometry: ${JSON.stringify(stdout.slice(0, 200))}`)
  }
  return { cols, rows }
}

const defaultFfiRead = async (): Promise<ConsoleGeometry> => {
  const ffi = await import("./windows-console-ffi.ts")
  return ffi.readWindowsConsoleGeometry()
}

const defaultModeConRead = (): ModeConReply => {
  const result = spawnSync("cmd", ["/c", "mode", "con"], { encoding: "utf8", timeout: 5000, windowsHide: true })
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status }
}

/** The one read the arm calls, with both attempts injectable so the contract is testable off Windows. */
export async function readConsoleGeometry(
  options: {
    platform?: NodeJS.Platform
    ffi?: () => Promise<ConsoleGeometry>
    modeCon?: () => ModeConReply
  } = {},
): Promise<ConsoleGeometryRead> {
  const platform = options.platform ?? process.platform
  const onWindows = platform === "win32"
  const ffi = options.ffi ?? (onWindows ? defaultFfiRead : undefined)
  const modeCon = options.modeCon ?? (onWindows ? defaultModeConRead : undefined)
  if (ffi === undefined && modeCon === undefined) {
    return {
      status: "unavailable",
      diagnostic: `the console geometry read is win32-only and this platform is ${platform}`,
    }
  }
  let ffiFailure: string | undefined
  if (ffi !== undefined) {
    try {
      const geometry = await ffi()
      return { status: "measured", via: "ffi", cols: geometry.cols, rows: geometry.rows }
    } catch (error) {
      ffiFailure = error instanceof Error ? error.message : String(error)
    }
  }
  let modeConFailure: string | undefined
  if (modeCon !== undefined) {
    let reply: ModeConReply | undefined
    try {
      reply = modeCon()
      // The child's status decides whether its output is a geometry read AT ALL: `mode con` can exit
      // nonzero or without a status and still print two plausible numbers, and parsing that would
      // grade on a failed command (@dev/7 r1 finding 3). The catch below names both attempts.
      if (reply.status !== 0) {
        throw new Error(
          reply.status === null
            ? "`mode con` returned no exit status, so its output is not a console read"
            : "`mode con` exited nonzero, so its output is not a console read",
        )
      }
      const geometry = parseModeConGeometry(reply.stdout)
      return { status: "measured", via: "mode-con", cols: geometry.cols, rows: geometry.rows }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const where =
        reply === undefined
          ? ""
          : ` (exit ${String(reply.status)}, stderr ${JSON.stringify(reply.stderr.slice(0, 120))})`
      modeConFailure = `${message}${where}`
    }
  }
  return {
    status: "unavailable",
    diagnostic:
      `no console geometry on ${platform}: GetConsoleScreenBufferInfo on CONOUT$ ${ffiFailure === undefined ? "was not attempted" : `failed (${ffiFailure})`}` +
      `; \`mode con\` ${modeConFailure === undefined ? "was not attempted" : `failed (${modeConFailure})`}`,
  }
}
