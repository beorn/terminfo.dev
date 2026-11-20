import { randomBytes } from "node:crypto"

/**
 * The one identity a draft may carry: an explicit capture id, then a deliberate capture environment,
 * then the launch identity the caller already handed, then a fresh mint.
 *
 * The daemon is launched with the run's identity and hands that same identity down as
 * expectedLaunchRunId. Before this fallback existed it minted a second, unrelated id, so a draft named
 * the daemon's random id while the owner assertion and the composer named the handed one, and the
 * mismatch only surfaced a whole pass later as "Collector changed logical runId" (#34018).
 */
export function resolveCaptureRunId(
  options: { captureRunId?: string; expectedLaunchRunId?: string; environment?: NodeJS.ProcessEnv } = {},
): string {
  const environment = options.environment ?? process.env
  return (
    options.captureRunId ??
    (environment.TERMINFO_CAPTURE_RUN_ID || undefined) ??
    options.expectedLaunchRunId ??
    randomBytes(16).toString("hex")
  )
}
