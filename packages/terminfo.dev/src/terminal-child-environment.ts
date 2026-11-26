/** The verified terminal child's own environment, read once: only the allowlisted variables below are looked at. */
import type { ProgramResumeTokenReading, TermFeaturesReading } from "@terminfo/probe-defs"

export interface TerminalChildEnvironment {
  readonly termFeatures: TermFeaturesReading
  /** OSC 7577 spec revision 0.5 (#38699); the token's bytes never leave this function (@cto ee6b7fd9). */
  readonly programResumeToken: ProgramResumeTokenReading
}

/** Both readings share one binding: this run's clean-launch marker and run control, PID and TTY. */
export function readTerminalChildEnvironment(
  env: NodeJS.ProcessEnv,
  runId: string,
  pid: number,
  tty: string,
): TerminalChildEnvironment {
  const launchMarker = env.TERMINFO_TERM_FEATURES_LAUNCH
  const runControl = env.TERMINFO_RUN_ID
  if (launchMarker !== runId || runControl !== runId) {
    const reason = (name: string) => `${name} child environment lacks this run's clean-launch marker and run control`
    return {
      termFeatures: { status: "unavailable", reason: reason("TERM_FEATURES") },
      programResumeToken: { status: "unavailable", reason: reason("OSC7577_TOKEN") },
    }
  }
  if (!/^[0-9a-f]{32}$/.test(runId) || !Number.isSafeInteger(pid) || pid < 1 || tty.length === 0) {
    const reason = (name: string) => `${name} child environment has invalid run/PID/TTY binding`
    return {
      termFeatures: { status: "invalid", reason: reason("TERM_FEATURES") },
      programResumeToken: { status: "invalid", reason: reason("OSC7577_TOKEN") },
    }
  }
  const binding = { runId: runControl, launchMarker, pid, tty }
  return {
    termFeatures: termFeatures(env.TERM_FEATURES, binding),
    programResumeToken: token(env.OSC7577_TOKEN, binding),
  }
}

interface Binding {
  runId: string
  launchMarker: string
  pid: number
  tty: string
}

function termFeatures(value: string | undefined, binding: Binding): TermFeaturesReading {
  if (value !== undefined && (value.length > 4096 || /[^\x20-\x7e]/.test(value))) {
    return { status: "invalid", reason: "TERM_FEATURES value is too long or non-printable" }
  }
  return { status: "measured", present: value !== undefined, value: value ?? "", ...binding }
}

/** Spec rev 0.5: 22-64 characters of [A-Za-z0-9_-]. Only the length and the broken rule are kept. */
function token(value: string | undefined, binding: Binding): ProgramResumeTokenReading {
  if (value === undefined) return { status: "measured", present: false, length: 0, ...binding }
  const malformed =
    value.length < 22 || value.length > 64 ? "length" : /^[A-Za-z0-9_-]+$/.test(value) ? undefined : "charset"
  return { status: "measured", present: true, length: value.length, ...(malformed && { malformed }), ...binding }
}
