/** One allowlisted reading from the verified terminal child's own environment. */
import type { TermFeaturesReading } from "@terminfo/probe-defs"

export function readTermFeaturesEnvironment(
  env: NodeJS.ProcessEnv,
  runId: string,
  pid: number,
  tty: string,
): TermFeaturesReading {
  const launchMarker = env.TERMINFO_TERM_FEATURES_LAUNCH
  const runControl = env.TERMINFO_RUN_ID
  if (launchMarker !== runId || runControl !== runId) {
    return {
      status: "unavailable",
      reason: "TERM_FEATURES child environment lacks this run's clean-launch marker and run control",
    }
  }
  if (!/^[0-9a-f]{32}$/.test(runId) || !Number.isSafeInteger(pid) || pid < 1 || tty.length === 0) {
    return { status: "invalid", reason: "TERM_FEATURES child environment has invalid run/PID/TTY binding" }
  }
  const value = env.TERM_FEATURES
  if (value !== undefined && (value.length > 4096 || /[^\x20-\x7e]/.test(value))) {
    return { status: "invalid", reason: "TERM_FEATURES value is too long or non-printable" }
  }
  return {
    status: "measured",
    present: value !== undefined,
    value: value ?? "",
    runId: runControl,
    launchMarker,
    pid,
    tty,
  }
}
