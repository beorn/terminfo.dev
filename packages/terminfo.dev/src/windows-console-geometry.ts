/**
 * The console geometry read for the hosted Windows arm of the owned terminal (29558, option A).
 *
 * Why this exists: 138 of a hosted Windows run's 182 inconclusive observations carry one note —
 * "No verified owned terminal for geometry read" — and the candidate-2 classics need a geometry, so
 * the row measured 1 of 122. The route has no win32 branch in the owned-terminal arm table, and no
 * Windows member in GeometrySource, so ownership is never established there.
 *
 * The one read: GetConsoleScreenBufferInfo on this process's own CONOUT$ through
 * ./windows-console-ffi.ts. Locale-free, no child process, microseconds, and it is the same console
 * the probes write to. There is no second read (#30731): a `cmd /c mode con` child gets its own
 * console, so it measured 120×9001 while the owned window was 110×30.
 *
 * NO SILENT FALLBACK: when the ffi read fails, the result is `unavailable` and names that failure,
 * so the caller keeps the loud note rather than grading on a guessed size.
 */

/** The console's visible window. Defined here, the arm's own concept; the ffi half imports it. */
export type ConsoleGeometry = { readonly cols: number; readonly rows: number }

export type ConsoleGeometryRead =
  | { readonly status: "measured"; readonly cols: number; readonly rows: number }
  | { readonly status: "unavailable"; readonly diagnostic: string }

/** The one read the arm calls, with the ffi read injected so the contract is testable off Windows. */
export async function readConsoleGeometry(options: {
  ffi: () => Promise<ConsoleGeometry>
}): Promise<ConsoleGeometryRead> {
  try {
    const geometry = await options.ffi()
    return { status: "measured", cols: geometry.cols, rows: geometry.rows }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      status: "unavailable",
      diagnostic: `no console geometry on ${process.platform}: GetConsoleScreenBufferInfo on CONOUT$ failed (${message})`,
    }
  }
}
