/** The existing App bootstrap observes one export before the collector runtime starts. */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { TermFeaturesReading } from "@terminfo/probe-defs"
import { shellQuote } from "./daemon-client.ts"

/** Shell builtins retain presence separately from value; never serialize the environment. */
export function termFeaturesBootstrap(recordPath: string): string {
  return `umask 077\nprintf '%s\\0' "\${TERMINFO_RUN_ID:0:64}" "$$" "$(tty)" "\${TERM_FEATURES+x}" "\${TERM_FEATURES:0:4097}" > ${shellQuote(recordPath)}\n`
}

/** Called with the exact environment and handle used by the real CLI spawn. */
export function retainTermFeaturesLaunch(
  recordPath: string,
  env: NodeJS.ProcessEnv,
  spawnPid: number | undefined,
): void {
  writeFileSync(
    join(dirname(recordPath), "term-features-launch.json"),
    JSON.stringify({
      runId: env.TERMINFO_RUN_ID ?? null,
      upstreamAbsent: !Object.hasOwn(env, "TERM_FEATURES"),
      spawnPid: spawnPid ?? null,
    }),
    { flag: "wx", mode: 0o600 },
  )
}

/** The caller supplies the existing verified process/output ownership, not another ancestry reader. */
export function readTermFeaturesRecord(input: {
  recordPath: string
  runId: string
  workerPid: number
  ownerPid: number
  tty: string
}): TermFeaturesReading {
  const unavailable = (reason: string): TermFeaturesReading => ({ status: "unavailable", reason })
  const invalid = (reason: string): TermFeaturesReading => ({ status: "invalid", reason })
  let raw: Buffer
  let launchRaw: string
  try {
    raw = readFileSync(input.recordPath)
    launchRaw = readFileSync(join(dirname(input.recordPath), "term-features-launch.json"), "utf8")
  } catch (cause) {
    const reason = `TERM_FEATURES child/launch records at ${input.recordPath}: ${cause instanceof Error ? cause.message : String(cause)}`
    return cause instanceof Error && "code" in cause && cause.code === "ENOENT" ? unavailable(reason) : invalid(reason)
  }
  if (raw.length > 4608) {
    return invalid(`TERM_FEATURES child record at ${input.recordPath} exceeds its allowlisted bound`)
  }
  let text: string
  let launch: unknown
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw)
    launch = JSON.parse(launchRaw)
  } catch (cause) {
    return invalid(`TERM_FEATURES child/launch records at ${input.recordPath} are malformed: ${String(cause)}`)
  }
  const fields = text.split("\0")
  if (fields.length !== 6 || fields[5] !== "") return invalid("TERM_FEATURES child record has malformed fields")
  const [runId, pidText, tty, presence, value] = fields as [string, string, string, string, string, string]
  if (
    !/^[0-9a-f]{32}$/.test(runId) ||
    !/^[1-9][0-9]*$/.test(pidText) ||
    !tty.startsWith("/dev/") ||
    !["", "x"].includes(presence)
  ) {
    return invalid("TERM_FEATURES child record has malformed run/PID/TTY/presence")
  }
  if (value.length > 4096 || /[^\x20-\x7e]/.test(value)) {
    return invalid("TERM_FEATURES value is too long or non-printable")
  }
  if (presence === "" && value !== "") return invalid("TERM_FEATURES absent export carries a value")
  if (typeof launch !== "object" || launch === null || Array.isArray(launch)) {
    return invalid("TERM_FEATURES launch record is malformed")
  }
  const witness = launch as Record<string, unknown>
  if (
    witness.upstreamAbsent !== true ||
    witness.runId !== input.runId ||
    witness.spawnPid !== input.ownerPid ||
    runId !== input.runId ||
    Number(pidText) !== input.workerPid ||
    tty !== input.tty
  ) {
    return unavailable(
      "TERM_FEATURES child observation lacks this run's clean fresh launch and matching control/PID/TTY",
    )
  }
  return { status: "measured", present: presence === "x", value, runId, pid: Number(pidText), tty }
}
